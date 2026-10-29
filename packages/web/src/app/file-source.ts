// 内置浏览器渲染文件时取内容（160 号票）。哪些渲染、怎么画在状态层（state/file-view.ts），这里是要用到浏览器 API 的那一半：
// - fetchFileText：网页的内置浏览器（132 号票，/apps/… 和二狗同源，带着凭证）直接请求文件——只读开头 MEDIA_TEXT_MAX_BYTES（1 MB），
//   截在字符边上；响应不是能渲染的文本（网页、图片……）就不读正文，回 page，调用方照旧在框里当网页开；
// - nativeFileText：鸿蒙 App 的原生浏览器交来的（134 号票）——页面上显示的字（浏览器已经解好了），或者拦下的下载的字节（base64）；
// - decodeFileBytes：按 Content-Type 写的字符集解；没写先按 UTF-8，不行再按 GB18030（国内常见的 GBK 文本；报告页只按 UTF-8，
//   这里是别人网站上的文件，多认一种）；解出来含 NUL 的是二进制，不当文本。
// 不碰页面的全局变量（fetch 由调用方给），测试在 Node 里跑（test/app/file-source.test.ts）。
import { charsetOf, fileRenderOf, type FileTextResult, MEDIA_TEXT_MAX_BYTES, t } from "../state/index.ts";

/** 解出来的字；二进制、解不了是 ok: false */
export type DecodedText = { ok: true; text: string } | { ok: false };

/** 按字符集解（truncated：只取了开头，最后半个字不算错、丢掉）；解出来含 NUL 的当二进制 */
export function decodeFileBytes(bytes: Uint8Array, charset: string | undefined, truncated: boolean): DecodedText {
  const attempt = (label: string, fatal: boolean): string | undefined => {
    let decode: () => string;
    try {
      const decoder = new TextDecoder(label, { fatal });
      decode = () => decoder.decode(bytes, { stream: truncated });
    } catch {
      // 不认得的字符集
      return undefined;
    }
    try {
      return decode();
    } catch {
      return undefined;
    }
  };
  const text = (charset ? attempt(charset, false) : undefined) ?? attempt("utf-8", true) ?? attempt("gb18030", true);
  return text === undefined || text.includes("\u0000") ? { ok: false } : { ok: true, text };
}

/** 不是文本文件（169 号票起按当前语言，取的时候现拼） */
const notText = (): FileTextResult => ({ status: "error", title: t("app.fileSource.notText"), detail: t("app.fileSource.notTextDetail") });

/** 取文件失败（title 是"取文件失败"） */
const fetchFailed = (detail: string): FileTextResult => ({ status: "error", title: t("app.fileSource.failed"), detail });

function httpError(status: number): FileTextResult {
  if (status === 404 || status === 410) return { status: "error", title: t("app.fileSource.gone"), detail: t("app.fileSource.goneDetail", { status }) };
  if (status === 401 || status === 403) return { status: "error", title: t("app.fileSource.forbidden"), detail: t("app.fileSource.forbiddenDetail", { status }) };
  return fetchFailed(t("app.fileSource.httpDetail", { status }));
}

/** 读响应正文，最多 limit 个字节（多读到一点就知道截断了），读够了就不再往下读 */
async function readHead(res: Response, limit: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) {
    const all = new Uint8Array(await res.arrayBuffer());
    return { bytes: all.subarray(0, limit), truncated: all.length > limit };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size <= limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } finally {
    if (size > limit) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return { bytes: bytes.subarray(0, limit), truncated: size > limit };
}

/**
 * 请求一个文件的内容（网页的内置浏览器：/apps/… 同源，带着凭证）：
 * 能渲染的文本回 text（一共多少字节按 Content-Length，没写又截断了是 undefined）；不是能渲染的（网页、图片……）回 page，不读正文；
 * 取不到回 error（不在了、没权限、服务器出错、连不上、二进制）
 */
export async function fetchFileText(fetchFn: typeof fetch, url: string, signal?: AbortSignal, limit = MEDIA_TEXT_MAX_BYTES): Promise<FileTextResult> {
  let res: Response;
  try {
    res = await fetchFn(url, { credentials: "same-origin", ...(signal ? { signal } : {}) });
  } catch (e) {
    return fetchFailed(t("app.fileSource.unreachable", { error: e instanceof Error ? e.message : String(e) }));
  }
  if (!res.ok) {
    void res.body?.cancel().catch(() => {});
    return httpError(res.status);
  }
  const contentType = res.headers.get("content-type") ?? "";
  const mime = contentType.split(";")[0]!.trim().toLowerCase();
  if (!fileRenderOf({ url, mime })) {
    void res.body?.cancel().catch(() => {});
    return { status: "page", mime };
  }
  let head: { bytes: Uint8Array; truncated: boolean };
  try {
    head = await readHead(res, limit);
  } catch (e) {
    return fetchFailed(t("app.fileSource.cutOff", { error: e instanceof Error ? e.message : String(e) }));
  }
  const decoded = decodeFileBytes(head.bytes, charsetOf(contentType), head.truncated);
  if (!decoded.ok) return notText();
  const length = Number(res.headers.get("content-length"));
  const bytes = Number.isFinite(length) && length > 0 ? length : head.truncated ? undefined : head.bytes.length;
  return { status: "text", mime, text: decoded.text, bytes, truncated: head.truncated };
}

type Json = Record<string, unknown>;

/** base64 → 字节 */
function bytesOf(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * 鸿蒙 App 交来的文件内容（原生桥 browserDoc("source", 编号) 回的 JSON）换成同一种结果：
 * - { ok, kind: "text", text, total, truncated }：浏览器里显示的字（浏览器已经解好了），大小按 UTF-8 算，截断了的不知道一共多大；
 * - { ok, kind: "bytes", base64, total, truncated }：拦下的下载存在 App 缓存里的字节，total 是文件一共多少字节，按 contentType 的字符集解；
 * - { ok: false, reason }、回的不对：取不到
 */
export function nativeFileText(json: string, contentType: string): FileTextResult {
  let reply: Json | undefined;
  try {
    const value: unknown = JSON.parse(json);
    reply = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
  } catch {
    reply = undefined;
  }
  const mime = contentType.split(";")[0]!.trim().toLowerCase();
  if (!reply) return fetchFailed(t("app.fileSource.appNoContent"));
  if (reply.ok !== true) return fetchFailed(t("app.fileSource.appReason", { reason: typeof reply.reason === "string" && reply.reason ? reply.reason : t("app.fileSource.appCantRead") }));
  const truncated = reply.truncated === true;
  const total = typeof reply.total === "number" && Number.isFinite(reply.total) && reply.total >= 0 ? Math.round(reply.total) : undefined;
  if (reply.kind === "text" && typeof reply.text === "string") {
    if (reply.text.includes("\u0000")) return notText();
    return { status: "text", mime, text: reply.text, bytes: truncated ? undefined : new TextEncoder().encode(reply.text).length, truncated };
  }
  if (reply.kind === "bytes" && typeof reply.base64 === "string") {
    let bytes: Uint8Array;
    try {
      bytes = bytesOf(reply.base64);
    } catch {
      return fetchFailed(t("app.fileSource.appBadContent"));
    }
    const decoded = decodeFileBytes(bytes, charsetOf(contentType), truncated);
    if (!decoded.ok) return notText();
    return { status: "text", mime, text: decoded.text, bytes: total ?? (truncated ? undefined : bytes.length), truncated };
  }
  return fetchFailed(t("app.fileSource.appNoContent"));
}
