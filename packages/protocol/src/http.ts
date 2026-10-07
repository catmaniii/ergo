// 前端协议里走 HTTP 的那部分（规格第 5 节）：媒体的分片续传上传、按 sha256 下载、会话历史分页。
// 只有常量和路径，不引用 TypeBox（请求和响应体的 schema 在 http-schema.ts）。
// 路径怎么拼（HTTP_PATHS）、怎么拆（parseHttpPath）、查询参数叫什么（HTTP_QUERY）都只写在这里，
// 守护进程的路由和 Web、测试的请求都从这里取。
//
// 上传是自定义的分片续传协议：
// 1. 建上传：POST /api/uploads，带文件名、类型、字节数；超过单文件上限当场拒绝；
// 2. 按偏移写分片：PUT /api/uploads/<上传 id>?offset=<偏移>，请求体是从这个偏移起的一段原始字节。
//    偏移必须等于服务端已收到的字节数，不等就回 409 和服务端的偏移；连接中途断了，已经收到的字节照样算数；
// 3. 查进度：GET /api/uploads/<上传 id>，断网恢复后从服务端已收到的偏移接着传，不重传已收到的字节；
// 4. 收尾：POST /api/uploads/<上传 id>/complete，带原始上传字节的 sha256。不符就拒绝、不入库。
//    图片入库前剥掉 EXIF，入库版本的 sha256 就是媒体 id（消息里的图片、文件 part 和素材都引用它）。
//
// 下载：GET /api/media/<媒体 id>，支持 Range（206）。

/** 单个文件的默认上限（字节）：200 MB，数据目录的配置里可以改（media.maxUploadBytes） */
export const DEFAULT_MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/** 历史分页一页最多多少条消息（也是前端第一次订阅会话频道时补发的最近消息条数） */
export const HISTORY_PAGE_SIZE = 50;

/** 媒体 id：入库版本内容的 sha256，64 位小写十六进制（收尾时带的原始字节 sha256 也是这个格式） */
export const MEDIA_ID_PATTERN = /^[0-9a-f]{64}$/;

export function isMediaId(value: string): boolean {
  return MEDIA_ID_PATTERN.test(value);
}

/** HTTP 接口都在这个前缀下 */
export const HTTP_API_PREFIX = "/api/";

/** 查询参数的名字 */
export const HTTP_QUERY = {
  /** 写分片：这个分片从第几个字节起 */
  offset: "offset",
  /** 下载：文件名 */
  name: "name",
  /** 下载：为 1 时一律作为附件下载（不在页面里打开） */
  download: "download",
  /** 历史分页：只要序号小于它的消息 */
  before: "before",
  /** 历史分页：最多几条 */
  limit: "limit",
} as const;

const UPLOADS = "uploads";
const COMPLETE = "complete";
const MEDIA = "media";
const CONVERSATIONS = "conversations";
const MESSAGES = "messages";

/** 拼查询串（不用 URLSearchParams：前端状态层既没有 DOM 也没有 Node 的类型） */
function query(params: Record<string, string | undefined>): string {
  const pairs = Object.entries(params)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return pairs.length > 0 ? `?${pairs.join("&")}` : "";
}

const api = (...segments: string[]) => `${HTTP_API_PREFIX}${segments.map(encodeURIComponent).join("/")}`;

/** HTTP 接口的路径 */
export const HTTP_PATHS = {
  uploads: api(UPLOADS),
  upload: (uploadId: string) => api(UPLOADS, uploadId),
  /** 写分片：从 offset 起 */
  uploadChunk: (uploadId: string, offset: number) => `${api(UPLOADS, uploadId)}${query({ [HTTP_QUERY.offset]: String(offset) })}`,
  uploadComplete: (uploadId: string) => api(UPLOADS, uploadId, COMPLETE),
  /** 下载媒体；name 用作下载时的文件名，download 为真时一律作为附件下载（不在页面里打开） */
  media: (mediaId: string, options: { name?: string | undefined; download?: boolean | undefined } = {}) =>
    `${api(MEDIA, mediaId)}${query({ [HTTP_QUERY.name]: options.name, [HTTP_QUERY.download]: options.download ? "1" : undefined })}`,
  /** 某个会话更早的消息：before 是前端手里最早那条消息的序号（不填取最近的一页） */
  history: (conversation: string, options: { before?: number | undefined; limit?: number | undefined } = {}) =>
    `${api(CONVERSATIONS, conversation, MESSAGES)}${query({ [HTTP_QUERY.before]: options.before?.toString(), [HTTP_QUERY.limit]: options.limit?.toString() })}`,
} as const;

/** 拆出来的 HTTP 接口路径（和 HTTP_PATHS 一一对应） */
export type HttpRoute =
  | { route: "uploads" }
  | { route: "upload"; uploadId: string }
  | { route: "upload_complete"; uploadId: string }
  | { route: "media"; mediaId: string }
  | { route: "history"; conversation: string };

/** 把请求的路径（不含查询串）拆成接口和参数；不是 HTTP 接口的路径返回 undefined */
export function parseHttpPath(pathname: string): HttpRoute | undefined {
  if (!pathname.startsWith(HTTP_API_PREFIX)) return undefined;
  let segments: string[];
  try {
    segments = pathname.slice(HTTP_API_PREFIX.length).split("/").map(decodeURIComponent);
  } catch {
    return undefined;
  }
  const [head, id, tail, ...rest] = segments;
  if (rest.length > 0 || segments.some((s) => s === "")) return undefined;
  if (head === UPLOADS) {
    if (id === undefined) return { route: "uploads" };
    if (tail === undefined) return { route: "upload", uploadId: id };
    if (tail === COMPLETE) return { route: "upload_complete", uploadId: id };
  }
  if (head === MEDIA && id !== undefined && tail === undefined) return { route: "media", mediaId: id };
  if (head === CONVERSATIONS && id !== undefined && tail === MESSAGES) return { route: "history", conversation: id };
  return undefined;
}

/** HTTP 接口错误响应里的错误码 */
export const HTTP_ERROR_CODES = [
  "bad_request",
  "not_found",
  /** 这个地址不支持这个方法 */
  "method_not_allowed",
  /** 超过单文件上限，或者请求体太大 */
  "too_large",
  /** 写分片的偏移和服务端已收到的字节数不一致（响应里带服务端的偏移） */
  "offset_mismatch",
  /** 同一个上传正有另一个分片在写 */
  "busy",
  /** 收尾的 sha256 和收到的原始字节对不上：拒绝，不入库 */
  "sha256_mismatch",
  /** 收尾时还没收全 */
  "incomplete",
  "internal",
] as const;

export type HttpErrorCode = (typeof HTTP_ERROR_CODES)[number];
