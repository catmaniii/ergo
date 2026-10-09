// 读网页（70 号票）：照搬用户 web-search skill 的 fetch.mjs——先直接请求（快，不起浏览器）；被 403、429 拦、服务器出错（5xx）、
// 别的不成功的状态或者网络出错时，改用浏览器真实渲染再取（能过多数反爬墙）。JSON、纯文本、XML、CSV 原样交回，网页抽正文纯文本，
// 超过 max 个字截断。skill 的 --raw、--browser 两个选项二狗的工具不给（票面定的接口是 web_fetch(url, max?)）。
// 直接请求在守护进程里做（Node 的 fetch，可注入），浏览器经 browser.ts 的薄接口。
// 比 skill 多两条（评审后定）：直接请求有超时（DIRECT_TIMEOUT_MS，连上和读完正文一起算；超时了按网络出错算、改用浏览器），
// 正文只读前 DIRECT_MAX_BYTES 字节（读到上限就停，注明只读了前面；再大的网页抽出来也只交回 max 个字）。
import { type BrowserDriver, BrowserUnavailable } from "./browser.ts";
import { htmlToText } from "./html-text.ts";
import { SEARCH_USER_AGENT } from "./search.ts";

export interface FetchRequest {
  url: string;
  /** 交回的文字最多多少字（照 skill：超过的截掉，末尾注明原长） */
  max: number;
}

/** 读到了：交回模型的文字（已截断），走的是直接请求还是浏览器 */
export interface FetchedPage {
  text: string;
  via: "direct" | "browser";
}

/** 直接请求和浏览器都没读到：说法直接给模型看 */
export class FetchFailed extends Error {
  override readonly name = "FetchFailed";
}

/** 直接请求用的函数（Node 的 fetch；测试换成假的） */
export type FetchFunction = (url: string, init: { headers: Record<string, string>; redirect: "follow"; signal?: AbortSignal }) => Promise<FetchResponse>;

/** 直接请求的响应里用到的那几样：有 body 流时按流读（读到上限就停），没有时用 text() */
export interface FetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body?: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}

/** 直接请求（连上、读完正文）最多等多久；超时了按网络出错算，改用浏览器 */
export const DIRECT_TIMEOUT_MS = 20_000;

/** 直接请求的正文最多读多少字节（5 MB）：读到就停，抽正文只用这一段 */
export const DIRECT_MAX_BYTES = 5 * 1024 * 1024;

/** 直接请求的超时、正文上限（测试里换小的） */
export interface DirectLimits {
  timeoutMs: number;
  maxBytes: number;
}

/** 浏览器打开网页最多等多久（照 skill 的 30 秒；超时了页面可能已经渲染了一部分，照样取） */
const BROWSER_GOTO_TIMEOUT_MS = 30_000;

/** 原样交回的内容类型（不抽正文） */
const RAW_TYPES = /json|text\/plain|xml|csv/;

/** 截到 max 个字，末尾注明原长（照 skill） */
export function truncate(out: string, max: number): string {
  return out.length > max ? `${out.slice(0, max)}\n\n…[已截断，共 ${out.length} 字，要看更多把 max 调大]` : out;
}

/** 正文按流读，读到 maxBytes 就停（UTF-8 解码，停下时把流关掉）；没有流的按 text() 读了再截 */
export async function readCapped(res: Pick<FetchResponse, "body" | "text">, maxBytes: number): Promise<{ body: string; capped: boolean }> {
  if (!res.body) {
    const text = await res.text();
    const bytes = Buffer.from(text, "utf8");
    return bytes.length > maxBytes ? { body: new TextDecoder().decode(bytes.subarray(0, maxBytes)), capped: true } : { body: text, capped: false };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let capped = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.length > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - size));
        capped = true;
        break;
      }
      chunks.push(value);
      size += value.length;
    }
  } finally {
    if (capped) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return { body: new TextDecoder().decode(Buffer.concat(chunks)), capped };
}

/** 只读了前面一段时，正文后面注明 */
function cappedNote(capped: boolean, maxBytes: number): string {
  return capped ? `\n\n…[网页超过 ${maxBytes >= 1024 * 1024 ? `${maxBytes / 1024 / 1024} MB` : `${maxBytes} 字节`}，只读了前面这些]` : "";
}

type DirectResult = { kind: "ok"; ctype: string; body: string; capped: boolean } | { kind: "failed"; why: string };

/** 直接请求：连上、读完正文（读到上限就停）；被拦、不成功、网络出错、超时都算没读到（说明原因） */
async function fetchDirect(fetchFn: FetchFunction, url: string, signal: AbortSignal | undefined, limits: DirectLimits): Promise<DirectResult> {
  const timeout = AbortSignal.timeout(limits.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const res = await fetchFn(url, { headers: { "User-Agent": SEARCH_USER_AGENT, Accept: "text/html,application/json,*/*" }, redirect: "follow", signal: combined });
    const blocked = res.status === 403 || res.status === 429 || res.status >= 500;
    if (!res.ok || blocked) return { kind: "failed", why: `直接请求回了 HTTP ${res.status}` };
    const { body, capped } = await readCapped(res, limits.maxBytes);
    return { kind: "ok", ctype: res.headers.get("content-type") ?? "", body, capped };
  } catch {
    signal?.throwIfAborted();
    return { kind: "failed", why: timeout.aborted ? `直接请求超时（${Math.round(limits.timeoutMs / 1000)} 秒）` : "直接请求出错（网络不通或者连不上）" };
  }
}

/** 用浏览器打开网页取正文（照 skill 的 fetchWithBrowser，不带 --raw）：打开出错不算失败，照样取页面现在的内容 */
async function fetchWithBrowser(browser: BrowserDriver, url: string, signal: AbortSignal | undefined): Promise<{ status: number; title: string; text: string }> {
  return browser.withPage(
    { userAgent: SEARCH_USER_AGENT, locale: "zh-CN" },
    async (page) => {
      let status = 0;
      try {
        status = await page.goto(url, BROWSER_GOTO_TIMEOUT_MS);
      } catch {
        // 页面可能已经渲染了一部分，只是 goto 超时或报错：照样取内容
      }
      const title = await page.title().catch(() => "");
      const t = htmlToText(await page.html());
      return { status, title, text: `标题: ${t.title}\n\n${t.text}` };
    },
    signal,
  );
}

/**
 * 读网页：先直接请求，被拦、不成功、网络出错、超时时改用浏览器。都不行时抛 FetchFailed（浏览器用不了的说清楚）。
 * limits 默认是 DIRECT_TIMEOUT_MS、DIRECT_MAX_BYTES（测试里换小的）
 */
export async function webFetch(
  deps: { fetch: FetchFunction; browser: BrowserDriver },
  req: FetchRequest,
  options: { signal?: AbortSignal | undefined; log?: (line: string) => void; limits?: DirectLimits } = {},
): Promise<FetchedPage> {
  const { url, max } = req;
  const limits = options.limits ?? { timeoutMs: DIRECT_TIMEOUT_MS, maxBytes: DIRECT_MAX_BYTES };
  const got = await fetchDirect(deps.fetch, url, options.signal, limits);
  if (got.kind === "ok") {
    const note = cappedNote(got.capped, limits.maxBytes);
    if (RAW_TYPES.test(got.ctype)) return { text: truncate(`URL: ${url}\nContent-Type: ${got.ctype}\n\n${got.body}${note}`, max), via: "direct" };
    const { title, text } = htmlToText(got.body);
    return { text: truncate(`URL: ${url}\n标题: ${title}\n\n${text}${note}`, max), via: "direct" };
  }
  // 被反爬拦了、不成功、网络出错或者超时：浏览器兜底
  options.log?.(`读网页 ${url}：${got.why}，改用浏览器`);
  try {
    const r = await fetchWithBrowser(deps.browser, url, options.signal);
    return { text: truncate(`URL: ${url}\nHTTP: ${r.status}\n标题: ${r.title}\n\n${r.text}`, max), via: "browser" };
  } catch (err) {
    options.signal?.throwIfAborted();
    const why = err instanceof BrowserUnavailable ? err.message : `浏览器也没读到：${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
    throw new FetchFailed(`没读到 ${url}：${got.why}；${why}`);
  }
}
