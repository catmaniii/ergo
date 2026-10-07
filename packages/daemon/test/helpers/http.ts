// 主切面的 HTTP 那一半：模拟前端经本机端口上传媒体（分片续传）、下载媒体、翻历史。
// 只用 node:http，能精确控制每个请求发出去多少字节，也能在请求体发到一半时掐断连接（模拟断网）。
import { createHash } from "node:crypto";
import http from "node:http";
import {
  type DeleteMaterialsBody,
  type DeleteMaterialsResult,
  HTTP_PATHS,
  type HistoryPage,
  type HttpErrorBody,
  type MaterialScope,
  type MaterialScopeSummary,
  type UploadedMedia,
  type UploadStatus,
  type WorkdayChange,
  type WorkdayChangeResult,
  type WorkdayMonthView,
} from "@ergou/protocol";

export interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer | Uint8Array;
}

/** 发一个请求，读完整个响应 */
export function request(baseUrl: string, path: string, options: RequestOptions = {}): Promise<HttpResult> {
  const url = new URL(path, baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: options.method ?? "GET", headers: options.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(options.body === undefined ? undefined : Buffer.from(options.body));
  });
}

/** JSON 请求：带 JSON 请求体，按 JSON 解析响应 */
export async function requestJson<T = unknown>(baseUrl: string, path: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; body: T; headers: http.IncomingHttpHeaders }> {
  const res = await request(baseUrl, path, {
    method: options.method ?? "GET",
    headers: { ...(options.body === undefined ? {} : { "content-type": "application/json" }), ...options.headers },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = res.body.toString("utf8");
  return { status: res.status, headers: res.headers, body: (text ? JSON.parse(text) : undefined) as T };
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type UploadReply<T> = { status: number; body: T };

async function reply<T>(pending: Promise<{ status: number; body: T }>): Promise<UploadReply<T>> {
  const { status, body } = await pending;
  return { status, body };
}

/** 媒体接口：建上传、写分片、查进度、收尾、下载 */
export const media = {
  create(baseUrl: string, file: { name: string; mime: string; size: number }): Promise<UploadReply<UploadStatus & HttpErrorBody>> {
    return reply(requestJson(baseUrl, HTTP_PATHS.uploads, { method: "POST", body: file }));
  },
  status(baseUrl: string, uploadId: string): Promise<UploadReply<UploadStatus & HttpErrorBody>> {
    return reply(requestJson(baseUrl, HTTP_PATHS.upload(uploadId)));
  },
  async put(baseUrl: string, uploadId: string, offset: number, bytes: Uint8Array): Promise<UploadReply<UploadStatus & HttpErrorBody>> {
    const res = await request(baseUrl, HTTP_PATHS.uploadChunk(uploadId, offset), {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: bytes,
    });
    return { status: res.status, body: JSON.parse(res.body.toString("utf8")) as UploadStatus & HttpErrorBody };
  },
  complete(baseUrl: string, uploadId: string, sha256: string): Promise<UploadReply<UploadedMedia & HttpErrorBody>> {
    return reply(requestJson(baseUrl, HTTP_PATHS.uploadComplete(uploadId), { method: "POST", body: { sha256 } }));
  },
  /** 整个文件按 chunkSize 分片传完并收尾（收尾带原始字节的 sha256）；任何一步不对就抛错 */
  async upload(baseUrl: string, bytes: Uint8Array, file: { name: string; mime: string }, chunkSize = 64 * 1024): Promise<UploadedMedia> {
    const created = await media.create(baseUrl, { ...file, size: bytes.length });
    if (created.status !== 201) throw new Error(`建上传失败：${created.status} ${JSON.stringify(created.body)}`);
    const { uploadId } = created.body;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const put = await media.put(baseUrl, uploadId, offset, bytes.subarray(offset, offset + chunkSize));
      if (put.status !== 200) throw new Error(`写分片失败：${put.status} ${JSON.stringify(put.body)}`);
    }
    const done = await media.complete(baseUrl, uploadId, sha256Hex(bytes));
    if (done.status !== 200) throw new Error(`收尾失败：${done.status} ${JSON.stringify(done.body)}`);
    return done.body;
  },
  download(baseUrl: string, mediaId: string, options: { range?: string; method?: string; name?: string; download?: boolean } = {}): Promise<HttpResult> {
    const { range, method, ...query } = options;
    return request(baseUrl, HTTP_PATHS.media(mediaId, query), { method: method ?? "GET", ...(range === undefined ? {} : { headers: { range } }) });
  },
};

/**
 * 写一个分片，只发出请求体的前 sent 个字节（请求头里声明的是整段的长度），等 settleMs 让服务端收下，
 * 然后掐断连接：模拟"传到一半网断了"。
 */
export async function putThenDrop(baseUrl: string, uploadId: string, offset: number, chunk: Uint8Array, sent: number, settleMs = 300): Promise<void> {
  const url = new URL(HTTP_PATHS.uploadChunk(uploadId, offset), baseUrl);
  const req = http.request(url, { method: "PUT", headers: { "content-type": "application/octet-stream", "content-length": String(chunk.length) } });
  req.on("error", () => {});
  req.flushHeaders();
  await new Promise<void>((resolve) => req.write(chunk.subarray(0, sent), () => resolve()));
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  req.destroy();
}

/** 历史分页 */
export function history(baseUrl: string, conversation: string, options: { before?: number; limit?: number } = {}): Promise<UploadReply<HistoryPage & HttpErrorBody>> {
  return reply(requestJson(baseUrl, HTTP_PATHS.history(conversation, options)));
}

/** 设置里按会话、按时间段删除素材（21 号票） */
export const materialsApi = {
  /** 范围里有几条素材、有素材的会话 */
  scope: (baseUrl: string, scope?: MaterialScope) =>
    requestJson<MaterialScopeSummary | HttpErrorBody>(baseUrl, HTTP_PATHS.materialsScope, { method: "POST", body: scope === undefined ? {} : { scope } }),
  /** 对范围内的全部素材执行一种删法 */
  delete: (baseUrl: string, body: DeleteMaterialsBody) => requestJson<DeleteMaterialsResult | HttpErrorBody>(baseUrl, HTTP_PATHS.materialsDelete, { method: "POST", body }),
};

/** 设置里的工作日历（29 号票） */
export const workdayApi = {
  /** 某个月（YYYY-MM）每天上班或休息及原因 */
  month: (baseUrl: string, month: string) => requestJson<WorkdayMonthView & HttpErrorBody>(baseUrl, HTTP_PATHS.workdayMonth(month)),
  /** 改个人设置 */
  change: (baseUrl: string, change: WorkdayChange) => requestJson<WorkdayChangeResult & HttpErrorBody>(baseUrl, HTTP_PATHS.workdayCalendar, { method: "POST", body: { change } }),
};
