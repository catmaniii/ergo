// 拉一个私密 iCal 地址（297 号票）：检查地址、拉、限大小、解析，出错的换成给人看的原因（不带地址：地址就是密钥）。
// - 只认 https（webcal:// 当 https）；http 只给本机回环地址（测试里的假服务）；
// - 404 / 410：地址失效了（多半在 Google 日历里重置过私密地址）；401 / 403：没有权限（不是私密地址，或者管理员关了）；
// - 超时、连不上、太大（20 MB）、拿到的不是日历（登录页、网页）各有一句。
// 306 号票：地址失效、没权限这两种算"一直不行"（lasting：重新填地址之前再拉也不行），日历这个数据源据此报出错、按需查的工具不给秘书；
// 超时、连不上、那边出错是一时的。
// 打码（maskAddress）：页面上只给"calendar.google.com · c***@gmail.com"这种，私密的那一段一个字都不出。
import { t } from "@ergo/protocol";
import { type IcalCalendar, NotIcalError, parseIcal } from "./ical.ts";

/** 默认多久没拉完算超时 */
export const FETCH_TIMEOUT_MS = 30_000;
/** 一份日历最大多少字节 */
export const MAX_FEED_BYTES = 20 * 1024 * 1024;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** 给人看的原因（不带地址）；lasting 是重新填地址之前再拉也不行的（地址失效、没权限，306 号票） */
export class FeedProblem extends Error {
  readonly lasting: boolean;
  constructor(message: string, options: { lasting?: boolean } = {}) {
    super(message);
    this.name = "FeedProblem";
    this.lasting = options.lasting === true;
  }
}

/** 检查用户填的地址，交回规范的写法；不对的抛 FeedProblem */
export function checkAddress(raw: string): string {
  const text = raw.trim().replace(/^webcal:\/\//i, "https://");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new FeedProblem(t("google.calendar.address.bad"));
  }
  if (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname))) return url.toString();
  throw new FeedProblem(t("google.calendar.address.notHttps"));
}

/** 打了码的日历 id："chenxiao@gmail.com" → "c***@gmail.com" */
export function maskId(id: string): string {
  const at = id.indexOf("@");
  return at > 0 ? `${id[0]}***${id.slice(at)}` : `${id.slice(0, 1)}***`;
}

/** 地址里的日历 id（Google 的 /calendar/ical/<id>/private-…/basic.ics；不是这种的没有） */
export function calendarIdOf(address: string): string | undefined {
  try {
    const m = /\/calendar\/ical\/([^/]+)\//.exec(new URL(address).pathname);
    return m ? decodeURIComponent(m[1]!) : undefined;
  } catch {
    return undefined;
  }
}

/** 给人看的打了码的地址："calendar.google.com · c***@gmail.com"（私密的那一段不出） */
export function maskAddress(address: string): string {
  try {
    const url = new URL(address);
    const id = calendarIdOf(address);
    return id === undefined ? url.host : `${url.host} · ${maskId(id)}`;
  } catch {
    return "***";
  }
}

/** 读回应，超过上限就停 */
async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > max) throw new FeedProblem(t("google.calendar.fetch.tooBig", { mb: Math.round(max / 1024 / 1024) }));
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new FeedProblem(t("google.calendar.fetch.tooBig", { mb: Math.round(max / 1024 / 1024) }));
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(all);
}

export interface FetchFeedOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  /** 断开、插件停用、守护进程停时置位：照样抛 AbortError，不换成给人看的原因 */
  signal?: AbortSignal;
}

/** 拉一个地址、解析成日历；出错抛 FeedProblem（给人看的原因）或者 AbortError（被中止） */
export async function fetchFeed(address: string, options: FetchFeedOptions = {}): Promise<IcalCalendar> {
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await (options.fetch ?? fetch)(address, { signal, redirect: "follow", headers: { accept: "text/calendar, */*;q=0.5" } });
  } catch (err) {
    throw problemOf(err, timeoutMs, options.signal);
  }
  if (res.status === 404 || res.status === 410) throw new FeedProblem(t("google.calendar.fetch.gone", { status: res.status }), { lasting: true });
  if (res.status === 401 || res.status === 403) throw new FeedProblem(t("google.calendar.fetch.denied", { status: res.status }), { lasting: true });
  if (!res.ok) throw new FeedProblem(t("google.calendar.fetch.http", { status: res.status }));
  let text: string;
  try {
    text = await readCapped(res, options.maxBytes ?? MAX_FEED_BYTES);
  } catch (err) {
    throw problemOf(err, timeoutMs, options.signal);
  }
  try {
    return parseIcal(text);
  } catch (err) {
    if (err instanceof NotIcalError) throw new FeedProblem(t("google.calendar.fetch.notCalendar"));
    throw err;
  }
}

/** 拉的时候出的错 → 给人看的原因；被中止的原样交回 */
function problemOf(err: unknown, timeoutMs: number, signal: AbortSignal | undefined): unknown {
  if (err instanceof FeedProblem) return err;
  if (signal?.aborted) return err;
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return new FeedProblem(t("google.calendar.fetch.timeout", { seconds: Math.round(timeoutMs / 1000) }));
  const cause = err instanceof Error ? (err.cause as { code?: unknown } | undefined) : undefined;
  const code = typeof cause?.code === "string" ? cause.code : err instanceof Error ? err.message : String(err);
  return new FeedProblem(t("google.calendar.fetch.unreachable", { reason: code }));
}
