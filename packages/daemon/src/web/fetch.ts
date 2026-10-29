// 读网页（70 号票）：照搬用户 web-search skill 的 fetch.mjs——先直接请求（快，不起浏览器）；被 403、429 拦、服务器出错（5xx）、
// 别的不成功的状态或者网络出错时，改用浏览器真实渲染再取（能过多数反爬墙）。JSON、纯文本、XML、CSV 原样交回，网页抽正文纯文本，
// 超过 max 个字截断。skill 的 --raw、--browser 两个选项二狗的工具不给（票面定的接口是 web_fetch(url, max?)）。
// 直接请求在守护进程里做（Node 的 fetch，可注入），浏览器经 browser.ts 的薄接口。
// 比 skill 多两条（评审后定）：直接请求有超时（DIRECT_TIMEOUT_MS，连上和读完正文一起算；超时了按网络出错算、改用浏览器），
// 正文只读前 DIRECT_MAX_BYTES 字节（读到上限就停，注明只读了前面；再大的网页抽出来也只交回 max 个字）。
// 154 号票：直接请求和浏览器中间多一条 DeepSeek 读网页（deepseek.ts，回的已经是 Markdown，照 max 截短）。162 号票起直接请求之后
// 试哪几条、按什么顺序照设置里的队列（access.ts 交进来 after：DeepSeek 停用了或没 key 时没有它，浏览器停用了时没有浏览器）。
// 前面的没读到（DeepSeek 403 被安全策略拒、404 没取到正文，浏览器打不开……）的原因写进后面读到的结果里。
// 本机、内网、没有点的主机名的网址不交给 DeepSeek（它取不到，也不该把本机的地址往外送）。
// @i18n-ignore-file model：读到的正文、出错的原因都交回模型（173 号票）
import { isIP } from "node:net";
import { type BrowserDriver, BrowserUnavailable } from "./browser.ts";
import { DeepSeekFailed, type DeepSeekTools } from "./deepseek.ts";
import { htmlToText } from "./html-text.ts";
import { SEARCH_USER_AGENT } from "./search.ts";

export interface FetchRequest {
  url: string;
  /** 交回的文字最多多少字（照 skill：超过的截掉，末尾注明原长） */
  max: number;
}

/** 读到了：交回模型的文字（已截断），走的是直接请求、DeepSeek 读网页还是浏览器 */
export interface FetchedPage {
  text: string;
  via: "direct" | "deepseek" | "browser";
}

/**
 * 直接请求和后面的几条都没读到：说法直接给模型看；agentBrowser 是设置里还启用着 agent-browser、发起调用的 agent 用得了（162 号票：
 * 工具提示用它），appBrowser 同样是鸿蒙 App 的内置浏览器（182 号票：启用着、这一轮用得了）
 */
export class FetchFailed extends Error {
  override readonly name = "FetchFailed";
  readonly agentBrowser: boolean;
  readonly appBrowser: boolean;
  constructor(message: string, options: { agentBrowser?: boolean; appBrowser?: boolean } = {}) {
    super(message);
    this.agentBrowser = options.agentBrowser === true;
    this.appBrowser = options.appBrowser === true;
  }
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

/** 本机、内网（私有、链路本地的 IP）、没有点的主机名（nas 这种局域网里的名字）：不交给 DeepSeek */
export function isPrivateUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return true;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  const ip = isIP(host);
  if (ip === 4) {
    const [a, b] = host.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (ip === 6) return host === "::1" || host === "::" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith("::ffff:");
  return !host.includes(".");
}

/**
 * 读网页：先直接请求，被拦、不成功、网络出错、超时时按 after 的顺序换：DeepSeek 读网页（给了 deepseek、不是本机内网的网址时，154 号票）、
 * 浏览器（162 号票起顺序和用不用都照设置里的队列；不给 after 是 DeepSeek → 浏览器）。前面的没读到时，后面读到的结果里多一行"说明"
 * 写明前面的原因（只是直接请求没成不写，浏览器的结果里本来就有 HTTP 状态）。都不行时抛 FetchFailed（每一条的原因都说清楚；
 * agentBrowser、appBrowser 照传进来的，工具据此提示用 agent-browser、内置浏览器）。limits 默认是 DIRECT_TIMEOUT_MS、DIRECT_MAX_BYTES（测试里换小的）
 */
export async function webFetch(
  deps: { fetch: FetchFunction; browser: BrowserDriver; deepseek?: Pick<DeepSeekTools, "fetch"> | undefined; after?: readonly ("deepseek" | "browser")[]; agentBrowser?: boolean; appBrowser?: boolean },
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
  // 被反爬拦了、不成功、网络出错或者超时：按顺序换 DeepSeek（不是本机内网的网址时）、浏览器
  const tried = [got.why];
  /** 直接请求之后又有哪一条没成：后面成了的结果里写"说明" */
  let laterFailed = false;
  const after = (deps.after ?? ["deepseek", "browser"]).filter((m) => m === "browser" || (deps.deepseek && !isPrivateUrl(url)));
  for (const method of after) {
    options.log?.(`读网页 ${url}：${tried.join("；")}，改用${method === "deepseek" ? " DeepSeek 读网页" : "浏览器"}`);
    const note = laterFailed ? `说明: ${tried.join("；")}，改用${method === "deepseek" ? " DeepSeek" : "浏览器"}\n` : "";
    if (method === "deepseek") {
      try {
        const page = await deps.deepseek!.fetch(url, options.signal);
        return { text: truncate(`URL: ${url}\n${note}标题: ${page.title}\n\n${page.content}`, max), via: "deepseek" };
      } catch (err) {
        if (!(err instanceof DeepSeekFailed)) throw err;
        options.signal?.throwIfAborted();
        tried.push(`DeepSeek 没读到（${err.message}）`);
      }
    } else {
      try {
        const r = await fetchWithBrowser(deps.browser, url, options.signal);
        return { text: truncate(`URL: ${url}\nHTTP: ${r.status}\n${note}标题: ${r.title}\n\n${r.text}`, max), via: "browser" };
      } catch (err) {
        options.signal?.throwIfAborted();
        const why = err instanceof BrowserUnavailable ? err.message : err instanceof Error ? err.message.split("\n")[0]! : String(err);
        // 浏览器排在最后时照原来的写法（找不到浏览器的整句、"浏览器也没读到：……"）；后面还有 DeepSeek 时写成"浏览器没读到（原因的第一行）"
        if (method !== after.at(-1)) tried.push(`浏览器没读到（${why.split("\n")[0]}）`);
        else tried.push(err instanceof BrowserUnavailable ? why : `浏览器也没读到：${why}`);
      }
    }
    laterFailed = true;
  }
  throw new FetchFailed(`没读到 ${url}：${tried.join("；")}`, { agentBrowser: deps.agentBrowser === true, appBrowser: deps.appBrowser === true });
}
