// 网关的 HTTP 接口（规格第 5 节）：媒体的分片续传上传、按媒体 id 下载（支持 Range）、会话历史分页。
// 路径怎么拆、查询参数叫什么都从共享协议包取（http.ts 的 parseHttpPath、HTTP_QUERY），请求体和响应体见 http-schema.ts。
// 来源校验（Host、Origin）在网关入口已经做过。
// 错误一律按协议的错误码回；错误码到 HTTP 状态码的对应只有下面 STATUS_OF 这一张表。
import fs from "node:fs";
import type http from "node:http";
import { checkHttpBody, CompleteUploadBody, CreateUploadBody, type HttpErrorBody, type HttpErrorCode, type HttpRoute, HTTP_QUERY, isMediaId, parseHttpPath } from "@ergou/protocol";
import { historyPage, isConversationChannel } from "../conversation/history.ts";
import type { EventStore } from "../events/event-store.ts";
import { MediaError, type MediaStore } from "../media/media-store.ts";

/** 错误码 → HTTP 状态码 */
const STATUS_OF: Readonly<Record<HttpErrorCode, number>> = {
  bad_request: 400,
  not_found: 404,
  method_not_allowed: 405,
  too_large: 413,
  offset_mismatch: 409,
  busy: 409,
  sha256_mismatch: 422,
  incomplete: 409,
  internal: 500,
};

/** 网关自己判出来的错误（参数不对、地址不对……）；媒体库的错误是 MediaError，两者都按错误码回 */
export class HttpError extends Error {
  readonly code: HttpErrorCode;
  constructor(code: HttpErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface HttpApiOptions {
  media: MediaStore;
  /** 事件存储：历史分页从这里读 */
  store: EventStore;
  log: (line: string) => void;
}

/** JSON 请求体的上限 */
const MAX_JSON_BODY = 64 * 1024;

/** 处理 /api/ 下的请求 */
export type HttpApi = (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => void;

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => Promise<void> | void;

export function createHttpApi(options: HttpApiOptions): HttpApi {
  const { media, store, log } = options;

  /** 每个接口支持的方法和处理函数（HEAD 按 GET 处理） */
  const handlersOf = (route: HttpRoute): Partial<Record<string, Handler>> => {
    switch (route.route) {
      case "uploads":
        return {
          async POST(req, res) {
            const body = checkHttpBody(CreateUploadBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", `建上传的参数不对：${body.message}`);
            sendJson(res, 201, media.createUpload(body.value));
          },
        };
      case "upload":
        return {
          async GET(_req, res) {
            sendJson(res, 200, await media.uploadStatus(route.uploadId));
          },
          async PUT(req, res, url) {
            const offset = Number(url.searchParams.get(HTTP_QUERY.offset));
            if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError("bad_request", `写分片要带偏移：?${HTTP_QUERY.offset}=<非负整数>`);
            sendJson(res, 200, await media.writeChunk(route.uploadId, offset, req));
          },
        };
      case "upload_complete":
        return {
          async POST(req, res) {
            const body = checkHttpBody(CompleteUploadBody, await readJson(req));
            if (!body.ok) throw new HttpError("bad_request", `收尾的参数不对：${body.message}`);
            sendJson(res, 200, await media.completeUpload(route.uploadId, body.value.sha256));
          },
        };
      case "media":
        return { GET: (req, res, url) => serveMedia(req, res, route.mediaId, url) };
      case "history":
        return {
          GET(_req, res, url) {
            if (!isConversationChannel(route.conversation)) throw new HttpError("not_found", `没有这个会话：${route.conversation}`);
            const before = optionalInt(url, HTTP_QUERY.before, 1);
            const limit = optionalInt(url, HTTP_QUERY.limit, 1);
            sendJson(res, 200, historyPage(store, route.conversation, { ...(before === undefined ? {} : { before }), ...(limit === undefined ? {} : { limit }) }));
          },
        };
    }
  };

  const serveMedia = (req: http.IncomingMessage, res: http.ServerResponse, mediaId: string, url: URL) => {
    const info = isMediaId(mediaId) ? media.info(mediaId) : undefined;
    if (!info) throw new HttpError("not_found", `没有这个媒体：${mediaId}`);
    const name = url.searchParams.get(HTTP_QUERY.name) ?? mediaId;
    // 只有认得的图片在页面里直接显示；其他一律作为附件下载，不按前端声明的类型发出（免得 HTML、SVG 在本机源下跑脚本）
    const inline = info.image !== undefined && url.searchParams.get(HTTP_QUERY.download) !== "1";
    const range = parseRange(req.headers.range, info.size);
    if (range === "unsatisfiable") {
      res.writeHead(416, { ...SECURITY_HEADERS, "Content-Range": `bytes */${info.size}` });
      return void res.end();
    }
    const [start, end] = range ?? [0, info.size - 1];
    const length = info.size === 0 ? 0 : end - start + 1;
    res.writeHead(range ? 206 : 200, {
      ...SECURITY_HEADERS,
      // 媒体按内容寻址，内容永远不变
      "Cache-Control": "private, max-age=31536000, immutable",
      ETag: `"${mediaId}"`,
      "Accept-Ranges": "bytes",
      "Content-Type": inline ? info.image!.mime : "application/octet-stream",
      "Content-Disposition": contentDisposition(inline ? "inline" : "attachment", name),
      "Content-Length": String(length),
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${info.size}` } : {}),
    });
    if (req.method === "HEAD" || length === 0) return void res.end();
    const stream = fs.createReadStream(media.filePath(mediaId), { start, end });
    stream.on("error", (err) => {
      log(`读媒体 ${mediaId} 出错：${err.message}`);
      res.destroy();
    });
    stream.pipe(res);
  };

  return (req, res, url) => {
    const route = parseHttpPath(url.pathname);
    const handlers = route ? handlersOf(route) : undefined;
    const method = req.method === "HEAD" ? "GET" : (req.method ?? "GET");
    const handler = handlers?.[method];
    const run = (): Promise<void> | void => {
      if (!handlers) throw new HttpError("not_found", "没有这个地址");
      if (!handler) throw new HttpError("method_not_allowed", `这个地址不支持 ${req.method}`);
      return handler(req, res, url);
    };
    Promise.resolve()
      .then(run)
      .catch((err: unknown) => {
        // 没读的请求体扔掉，连接才能接着用
        req.resume();
        if (err instanceof MediaError || err instanceof HttpError) return sendError(res, err.code, err.message, err instanceof MediaError ? err.offset : undefined);
        log(`处理 ${req.method} ${url.pathname} 出错：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        sendError(res, "internal", "守护进程内部出错");
      });
  };
}

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  // 下载的内容即使被当成页面打开，也不能跑脚本、不能发请求
  "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
} as const;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return void res.end();
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function sendError(res: http.ServerResponse, code: HttpErrorCode, message: string, offset?: number): void {
  const body: HttpErrorBody = { code, message, ...(offset === undefined ? {} : { offset }) };
  sendJson(res, STATUS_OF[code], body);
}

/** 查询参数里可选的整数（不小于 min）；格式不对回 400 */
function optionalInt(url: URL, name: string, min: number): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min) throw new HttpError("bad_request", `${name} 必须是不小于 ${min} 的整数`);
  return value;
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_JSON_BODY) {
        reject(new HttpError("too_large", "请求体太大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(text ? JSON.parse(text) : undefined);
      } catch {
        reject(new HttpError("bad_request", "请求体不是合法的 JSON"));
      }
    });
    req.on("error", reject);
  });
}

/** 解析 Range 头：只支持单个字节区间；多个区间时整个发（200），不能满足时 416 */
function parseRange(header: string | undefined, size: number): [number, number] | "unsatisfiable" | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return undefined;
  const [, a, b] = m;
  if (a === "" && b === "") return undefined;
  let start: number;
  let end: number;
  if (a === "") {
    // 最后 n 个字节
    const n = Number(b);
    if (n === 0) return "unsatisfiable";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start >= size || start > end) return "unsatisfiable";
  return [start, end];
}

/** Content-Disposition：ASCII 的退路名加 UTF-8 的真名（RFC 6266 / 5987） */
function contentDisposition(kind: "inline" | "attachment", name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
