// Looki 官方开放接口的客户端（调研 38 的 1.3 节）：只读、全部 GET，请求头 X-API-Key；中国区 open.looki.tech、海外 open.looki.ai
// 各一套地址（用户在设置里选区域，地址写死在这里，不让填别的——Key 只发给这两个地址，官方 Skill 的要求）。
// 测试连接直接拿 Key 调所选区域的 /me 一步判断（不先去 open.looki.ai 做不带 Key 的地址检查——地址本来写死，
// 中国区也不必依赖海外那台）。
// - 出错分几种（LookiError.failure）：Key 不认（401/403）、限速（429，每个 Key 每分钟 60 次，超了等 60 秒，Retry-After 给了按它）、
//   连不上（网络、超时）、那边出错（5xx）、回的不对（别的 4xx、不是 JSON、包里写着出错）；给人看的原因走 t()。
//   回的不对里单认一种"接口停用了"（retired）：HTTP 410，或者 400 / 404 / 包里的出错写着 deprecated / retired / no longer，或者包里 code 105
//   （2026-11 起 /for_you/items 回 400、code 105、"This endpoint is deprecated. Please use GET /journals instead."——424 号票），
//   原因写"Looki 换了接口"，存一份到本地那一块照原文显示（体检读它）。
// - 官方文档没写成功时外面包不包一层（{ data: … }）、列表在哪个字段里：这里宽松地读（dataOf、listOf），等真机核对。
// 用 globalThis.fetch（调用时现取）：测试里只许连本机回环地址（vitest.setup-no-network.mjs），连真的 Looki 当场报错。
import { t } from "@ergo/protocol";
import type { LookiRegion } from "./api.ts";

/** 两个区域的接口地址（官方文档：Looki Web 的 API 文档页按域名切换） */
export const LOOKI_ENDPOINTS: Readonly<Record<LookiRegion, string>> = {
  cn: "https://open.looki.tech/api/v1",
  global: "https://open.looki.ai/api/v1",
};

/** 一次请求最多等多久 */
export const LOOKI_TIMEOUT_MS = 15_000;
/** 限速了要等多久（官方文档：超了等 60 秒） */
export const LOOKI_RATE_LIMIT_WAIT_MS = 60_000;
/** 列时刻的文件一页要几个（官方文档：最多 100） */
export const LOOKI_FILES_PAGE = 100;
/** 日记一次最多几天（官方文档：max_days 最多 31） */
export const LOOKI_JOURNAL_MAX_DAYS = 31;

/** 出错的种类：还没填 Key、Key 不认、限速、连不上、那边出错、回的不对 */
export type LookiFailure = "no_key" | "key" | "rate_limit" | "network" | "server" | "response";

/** 调 Looki 出的错：种类、给人看的原因；限速的带着要等多久；回的不对里是不是"接口停用了" */
export class LookiError extends Error {
  readonly failure: LookiFailure;
  readonly retryAfterMs: number | undefined;
  /** 接口停用了（Looki 换了接口）：failure 照样是 response（各处"回的不对"的退路不变），原因写明换了接口 */
  readonly retired: boolean;
  constructor(failure: LookiFailure, message: string, retryAfterMs?: number, retired = false) {
    super(message);
    this.name = "LookiError";
    this.failure = failure;
    this.retryAfterMs = retryAfterMs;
    this.retired = retired;
  }
}

/** 包里的 code：接口停用了（第三方 looki-mcp 实测 /for_you/items 停用后回 code 105，官方文档没列出错码） */
const RETIRED_CODE = 105;
/** 出错的原因里写着接口停用了 */
const RETIRED_TEXT = /deprecat|retired|no longer (available|supported)|has been removed/i;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** 成功的回包去掉外面那一层（{ data: … } 的取 data，没有就是它自己） */
export function dataOf(body: unknown): unknown {
  return isRecord(body) && "data" in body ? body.data : body;
}

/** 列表：本身是数组，或者对象里第一个是数组的常见字段 */
export function listOf(value: unknown, keys: readonly string[] = ["items", "moments", "journals", "list", "results", "records", "data"]): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  for (const key of keys) {
    const v = value[key];
    if (Array.isArray(v)) return v;
    if (isRecord(v)) {
      const inner = listOf(v, keys);
      if (inner.length > 0) return inner;
    }
  }
  return [];
}

/** 出错的回包里给人看的那一句（detail / message / error），截短 */
function detailOf(text: string): string {
  try {
    const body = JSON.parse(text) as unknown;
    if (isRecord(body)) {
      for (const key of ["detail", "message", "error", "msg"]) {
        const v = body[key];
        if (typeof v === "string" && v.trim().length > 0) return v.trim().slice(0, 200);
        if (isRecord(v) && typeof v.message === "string") return v.message.slice(0, 200);
      }
    }
  } catch {
    // 不是 JSON：取开头一段
  }
  return text.trim().slice(0, 200);
}

/** Retry-After（秒数或 HTTP 日期）→ 毫秒；没给是官方文档的 60 秒 */
function retryAfterOf(header: string | null): number {
  if (header !== null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 600) * 1000;
    const at = Date.parse(header);
    if (Number.isFinite(at)) return Math.max(0, Math.min(at - Date.now(), 600_000));
  }
  return LOOKI_RATE_LIMIT_WAIT_MS;
}

/** 回包里的 code（不是 JSON、没有是 undefined） */
function codeOf(text: string): number | undefined {
  try {
    const body = JSON.parse(text) as unknown;
    return isRecord(body) && typeof body.code === "number" ? body.code : undefined;
  } catch {
    return undefined;
  }
}

/** 是不是"接口停用了"：410；400 / 404 带 code 105 或者原因里写着 deprecated 这类 */
function isRetired(status: number, text: string): boolean {
  if (status === 410) return true;
  if (status !== 400 && status !== 404) return false;
  return codeOf(text) === RETIRED_CODE || RETIRED_TEXT.test(detailOf(text));
}

/** 接口停用了的错：原因写"Looki 换了接口"，带上对方的原话 */
const retiredError = (status: number, text: string) => new LookiError("response", t("looki.error.retired", { status, detail: detailOf(text) }), undefined, true);

/** fetch 抛的错说一句（Node 的 fetch 把 ECONNREFUSED、ENOTFOUND 放在 cause 里） */
function networkReason(err: unknown): string {
  const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
  if (isRecord(cause) && typeof cause.code === "string") return cause.code;
  return err instanceof Error ? err.message : String(err);
}

/** GET 一次、读成 JSON；出错按种类抛 LookiError。调用方中止（signal）原样抛中止的错 */
async function getJson(url: URL, headers: Record<string, string>, options: { signal?: AbortSignal; timeoutMs?: number }): Promise<unknown> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? LOOKI_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await globalThis.fetch(url, { headers: { accept: "application/json", ...headers }, signal });
  } catch (err) {
    if (options.signal?.aborted) throw err;
    throw new LookiError("network", t("looki.error.network", { host: url.host, reason: timeout.aborted ? t("looki.error.timeout") : networkReason(err) }));
  }
  const text = await res.text().catch(() => "");
  if (res.status === 401 || res.status === 403) throw new LookiError("key", t("looki.error.key"));
  if (res.status === 429) throw new LookiError("rate_limit", t("looki.error.rateLimit"), retryAfterOf(res.headers.get("retry-after")));
  if (res.status >= 500) throw new LookiError("server", t("looki.error.server", { status: res.status }));
  if (!res.ok && isRetired(res.status, text)) throw retiredError(res.status, text);
  if (!res.ok) throw new LookiError("response", t("looki.error.rejected", { status: res.status, detail: detailOf(text) }));
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new LookiError("response", t("looki.error.notJson"));
  }
  // 有的接口 HTTP 200、包里写着出错（success: false，或者 code 不是 0 / 200 又没有 data）
  if (isRecord(body)) {
    const code = typeof body.code === "number" ? body.code : undefined;
    const failed = body.success === false || (code !== undefined && code !== 0 && code !== 200 && (body.data === undefined || body.data === null));
    if (failed) {
      if (code === 401 || code === 403) throw new LookiError("key", t("looki.error.key"));
      if (code === 429) throw new LookiError("rate_limit", t("looki.error.rateLimit"), LOOKI_RATE_LIMIT_WAIT_MS);
      if (code === RETIRED_CODE || RETIRED_TEXT.test(detailOf(text))) throw retiredError(code ?? res.status, text);
      throw new LookiError("response", t("looki.error.rejected", { status: code ?? res.status, detail: detailOf(text) }));
    }
  }
  return dataOf(body);
}

/** 分页列表的一页：这一页的、下一页的游标（没有下一页没有） */
export interface LookiPage {
  items: unknown[];
  next?: string;
}

/**
 * 一页（时刻的文件、按天分组的日记）：列表照 listOf 找；下一页的游标认 next_cursor_id / next_cursor / cursor / next（字符串或数字），
 * has_more 是 false 的没有下一页。官方文档的回包是 { items, next_cursor_id, has_more }（日记的 next_cursor_id 是个日期，下一页当 cursor_date 送回去）
 */
export function pageOf(value: unknown): LookiPage {
  const items = listOf(value, ["items", "files", "list", "results", "records", "data"]);
  if (!isRecord(value) || value.has_more === false) return { items };
  for (const key of ["next_cursor_id", "next_cursor", "cursor", "next"]) {
    const v = value[key];
    if ((typeof v === "string" && v.trim() !== "") || (typeof v === "number" && Number.isFinite(v))) return { items, next: String(v) };
  }
  return { items };
}

/** 带着 Key 调一个地址的客户端（一次同步、一次按需查各建一个） */
export interface LookiClient {
  /** 账号资料：id、邮箱、姓名、时区…… */
  me(): Promise<unknown>;
  /** 某一天的全部时刻 */
  moments(date: string): Promise<unknown[]>;
  /** 按意思搜时刻（1–100 字），可以限定日期范围 */
  search(query: string, range?: { start?: string; end?: string }): Promise<unknown[]>;
  /** 按天分组的日记：从 cursorDate 往前 maxDays 天（≤31），新的在前 */
  journals(cursorDate: string, maxDays: number): Promise<unknown[]>;
  /** 一个时刻里的照片、视频、录音文件（存一份到本地），一页最多 100 个；文件带 1 小时失效的下载链接 */
  files(momentId: string, cursor?: string): Promise<LookiPage>;
  /**
   * 按天分组的日记的一页（带下一页的游标）：存一份到本地列 vlog 用——2026-11 起 vlog 不在 /for_you/items 了（停用，回 400），
   * 是日记里种类为 DAILY_VLOG 的条目（archive-remote.ts 的 journalVlogs 挑出来）
   */
  journalPage(cursorDate: string, maxDays: number): Promise<LookiPage>;
}

/** /journals 的参数：从 cursorDate 往前 maxDays 天（1–31），新的在前 */
const journalQuery = (cursorDate: string, maxDays: number) => ({ cursor_date: cursorDate, max_days: String(Math.max(1, Math.min(LOOKI_JOURNAL_MAX_DAYS, maxDays))), sort_order: "desc" });

export function createLookiClient(options: { base: string; key: string; signal?: AbortSignal; timeoutMs?: number }): LookiClient {
  const get = (pathname: string, query: Record<string, string> = {}) => {
    const url = new URL(`${options.base.replace(/\/+$/, "")}${pathname}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    return getJson(url, { "x-api-key": options.key }, options);
  };
  return {
    me: () => get("/me"),
    moments: async (date) => listOf(await get("/moments", { on_date: date })),
    search: async (query, range = {}) => listOf(await get("/moments/search", { query, ...(range.start ? { start_date: range.start } : {}), ...(range.end ? { end_date: range.end } : {}) })),
    journals: async (cursorDate, maxDays) => listOf(await get("/journals", journalQuery(cursorDate, maxDays))),
    files: async (momentId, cursor) => pageOf(await get(`/moments/${encodeURIComponent(momentId)}/files`, { limit: String(LOOKI_FILES_PAGE), ...(cursor === undefined ? {} : { cursor_id: cursor }) })),
    journalPage: async (cursorDate, maxDays) => pageOf(await get("/journals", journalQuery(cursorDate, maxDays))),
  };
}
