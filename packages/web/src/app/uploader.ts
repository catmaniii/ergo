// 前端的分片续传上传（规格第 5 节 HTTP，协议见共享协议包的 http.ts）：
// 建上传 → 按偏移一片一片地写 → 带原始字节的 sha256 收尾。
// - 网断了（请求抛错，或者服务端 5xx）：显示"等待网络"，隔一会儿查服务端已收到的偏移，从那里接着传，不重传已收到的字节；
// - 偏移对不上（409）：按服务端给的偏移接着传；
// - 超过上限、sha256 对不上这类服务端明确拒绝的，直接失败，不重试；
// - sha256 一片一片地算（util/sha256.ts），不把整个文件读进内存。
import { HTTP_PATHS, type HttpErrorBody, t, type UploadedMedia, type UploadStatus } from "../state/index.ts";
import { Sha256 } from "../util/sha256.ts";

/** fetch 里用到的那部分（测试换成假的） */
export type FetchLike = (
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string | ArrayBuffer; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** 上传的进度：在传、等网络恢复、校验中（算 sha256、收尾）、传完、失败 */
export interface UploadProgress {
  state: "uploading" | "waiting" | "verifying" | "done" | "failed";
  /** 服务端已收到的字节数 */
  sent: number;
  total: number;
  error?: string;
}

export interface UploadOptions {
  fetch: FetchLike;
  /** 守护进程的地址；页面由守护进程提供时留空（同源） */
  baseUrl?: string;
  /** 每片多少字节，默认 1 MB */
  chunkBytes?: number;
  /** 网断了之后隔多久再试（毫秒）：依次取，取完之后一直用最后一个 */
  retryDelaysMs?: readonly number[];
  /** 等待（测试换成不等的） */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
}

/** 服务端明确拒绝的上传（不重试） */
export class UploadError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const DEFAULT_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_RETRY_DELAYS_MS = [1000, 2000, 5000, 10_000];
/** 算 sha256 时一次读多少 */
const HASH_SLICE_BYTES = 4 * 1024 * 1024;

/** 网络层面的失败：可以等一会儿再试 */
class NetworkFailure extends Error {}

export async function uploadFile(file: Blob & { name: string }, options: UploadOptions): Promise<UploadedMedia> {
  const base = options.baseUrl ?? "";
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? defaultSleep;
  const { signal } = options;
  const total = file.size;
  const report = (state: UploadProgress["state"], sent: number, error?: string) => options.onProgress?.({ state, sent, total, ...(error === undefined ? {} : { error }) });

  const checkAborted = () => {
    if (signal?.aborted) throw new DOMException(t("app.uploader.cancelled"), "AbortError");
  };

  /** 发一个请求，读 JSON；网络失败和 5xx 抛 NetworkFailure，其他非 2xx 抛 UploadError（409 由调用方看 body） */
  const call = async <T>(method: string, path: string, body?: string | ArrayBuffer, allow409 = false): Promise<{ status: number; body: T }> => {
    checkAborted();
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await options.fetch(`${base}${path}`, {
        method,
        ...(body === undefined ? {} : { body, headers: { "Content-Type": typeof body === "string" ? "application/json" : "application/octet-stream" } }),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      checkAborted();
      throw new NetworkFailure(err instanceof Error ? err.message : String(err));
    }
    checkAborted();
    const parsed = (await res.json().catch(() => undefined)) as T & Partial<HttpErrorBody>;
    if (res.status >= 500) throw new NetworkFailure(t("app.uploader.serverError", { status: res.status }));
    if (!res.ok && !(allow409 && res.status === 409)) throw new UploadError(parsed?.code ?? `http_${res.status}`, parsed?.message ?? `HTTP ${res.status}`);
    return { status: res.status, body: parsed };
  };

  /** 反复试一件事，网络失败就等一会儿再来（期间显示"等待网络"）；之前的尝试要用的偏移由 recover 重新取 */
  let attempt = 0;
  const waitForNetwork = async (sent: number, err: NetworkFailure) => {
    report("waiting", sent, err.message);
    await sleep(delays[Math.min(attempt, delays.length - 1)] ?? 1000, signal);
    attempt += 1;
    checkAborted();
  };

  try {
    // 1. 建上传（网络失败照样重试：建出来一个没用上的上传，服务端临时区清理时会删掉）
    let created: UploadStatus | undefined;
    while (!created) {
      try {
        created = (await call<UploadStatus>("POST", HTTP_PATHS.uploads, JSON.stringify({ name: file.name, mime: file.type, size: total }))).body;
      } catch (err) {
        if (!(err instanceof NetworkFailure)) throw err;
        await waitForNetwork(0, err);
      }
    }
    const { uploadId } = created;
    let offset = created.offset;
    report("uploading", offset);

    // 2. 一片一片地写；断网后先查服务端已收到的偏移
    let needStatus = false;
    while (offset < total || needStatus) {
      try {
        if (needStatus) {
          offset = (await call<UploadStatus>("GET", HTTP_PATHS.upload(uploadId))).body.offset;
          needStatus = false;
          attempt = 0;
          report("uploading", offset);
          continue;
        }
        const chunk = await file.slice(offset, Math.min(total, offset + chunkBytes)).arrayBuffer();
        const put = await call<UploadStatus & Partial<HttpErrorBody>>("PUT", HTTP_PATHS.uploadChunk(uploadId, offset), chunk, true);
        // 409：偏移对不上，按服务端的来
        offset = put.status === 409 ? (put.body.offset ?? offset) : put.body.offset;
        attempt = 0;
        report("uploading", offset);
      } catch (err) {
        if (!(err instanceof NetworkFailure)) throw err;
        needStatus = true;
        await waitForNetwork(offset, err);
      }
    }

    // 3. 收尾：带原始字节的 sha256（收尾是幂等的，网络失败可以重来）
    report("verifying", total);
    const sha256 = await hashFile(file, checkAborted);
    for (;;) {
      try {
        const done = (await call<UploadedMedia>("POST", HTTP_PATHS.uploadComplete(uploadId), JSON.stringify({ sha256 }))).body;
        report("done", total);
        return done;
      } catch (err) {
        if (!(err instanceof NetworkFailure)) throw err;
        await waitForNetwork(total, err);
      }
    }
  } catch (err) {
    if (!(err instanceof DOMException && err.name === "AbortError")) report("failed", 0, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

async function hashFile(file: Blob, checkAborted: () => void): Promise<string> {
  const hash = new Sha256();
  for (let i = 0; i < file.size; i += HASH_SLICE_BYTES) {
    hash.update(new Uint8Array(await file.slice(i, i + HASH_SLICE_BYTES).arrayBuffer()));
    checkAborted();
  }
  return hash.digestHex();
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
