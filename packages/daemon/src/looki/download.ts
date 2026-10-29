// 下载 Looki 给的文件链接（307 号票，存一份到本地）：照片、视频原样写进文件——不解码、不改一个字节，拍摄时间、地点这些元数据都在原文件里。
// - 链接是 Looki 给的预签名地址（1 小时失效），请求不带 Key（Key 只发给开放接口那两个地址，官方 Skill 的要求）；
// - 先写到同一个文件夹里的"文件名.part"，写完再改名：中途断了、停了不留半个文件；
// - 出错分几种（DownloadError.failure）：链接过期（401 / 403 / 410，或者 400 里写着 expired——S3 的预签名过期是 403）、没了（404）、
//   那边出错（5xx）、连不上（网络、超时）、别的（不是 http(s) 的地址、别的 4xx）；写不进去（磁盘满、没权限）是 Node 的错误原样抛（带 code），
//   调用方按 code 认。
// 用 globalThis.fetch（调用时现取）：测试里只许连本机回环地址，假 Looki 的文件也在本机。
import fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

/** 一个文件最多下多久（vlog 可能上百 MB） */
export const LOOKI_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

/** 写文件时的错（原样抛给调用方按 code 认） */
const FILE_ERRORS: ReadonlySet<string> = new Set(["ENOSPC", "EDQUOT", "EACCES", "EPERM", "EROFS", "ENOENT", "ENOTDIR", "EISDIR", "EEXIST", "EBUSY", "EMFILE", "ENAMETOOLONG", "EIO"]);

/** 下载出错的种类：链接过期、文件没了、那边出错、连不上、别的 */
export type DownloadFailure = "expired" | "missing" | "server" | "network" | "rejected";

export class DownloadError extends Error {
  readonly failure: DownloadFailure;
  constructor(failure: DownloadFailure, message: string) {
    super(message);
    this.name = "DownloadError";
    this.failure = failure;
  }
}

/** 下好了：多大、对方说是什么类型（image/jpeg……） */
export interface Downloaded {
  size: number;
  contentType?: string;
}

/** 把一个链接下载到 file（先写 .part、写完改名）；出错按种类抛，中止原样抛中止的错 */
export async function downloadTo(url: string, file: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Downloaded> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DownloadError("rejected", "bad url");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new DownloadError("rejected", `unsupported ${parsed.protocol}`);
  const timeout = AbortSignal.timeout(options.timeoutMs ?? LOOKI_DOWNLOAD_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await globalThis.fetch(parsed, { signal });
  } catch (err) {
    if (options.signal?.aborted) throw err;
    throw new DownloadError("network", timeout.aborted ? "timeout" : err instanceof Error ? err.message : String(err));
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403 || res.status === 410 || (res.status === 400 && /expired/i.test(text))) throw new DownloadError("expired", `HTTP ${res.status}`);
    if (res.status === 404) throw new DownloadError("missing", "HTTP 404");
    if (res.status >= 500) throw new DownloadError("server", `HTTP ${res.status}`);
    throw new DownloadError("rejected", `HTTP ${res.status}`);
  }
  const part = `${file}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>), fs.createWriteStream(part), { signal });
    fs.renameSync(part, file);
  } catch (err) {
    fs.rmSync(part, { force: true });
    if (options.signal?.aborted) throw err;
    // 写不进去的（磁盘满、没权限、路径不对）原样抛，调用方按 code 认；读到一半断了的算连不上
    if (FILE_ERRORS.has((err as NodeJS.ErrnoException).code ?? "")) throw err;
    throw new DownloadError("network", timeout.aborted ? "timeout" : err instanceof Error ? err.message : String(err));
  }
  const contentType = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  return { size: fs.statSync(file).size, ...(contentType ? { contentType } : {}) };
}
