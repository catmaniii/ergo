// 媒体库（规格第 5、18 节）：图片和文件附件按入库版本的 sha256 存在数据目录的素材区，同样的内容只存一份。
//
// - 分片续传上传：建上传 → 按偏移写分片 → 带原始上传字节的 sha256 收尾。还没收尾的上传放在临时区
//   （`<上传 id>.json` 记文件名、类型、总字节数，`<上传 id>.part` 是已收到的字节），所以守护进程重启后照样能接着传。
//   服务端已收到的偏移就是 .part 文件的大小：连接中途断了，已经写下的字节照样算数，前端从这里接着传。
// - 入库：图片（浏览器能直接显示的 JPEG、PNG、GIF、WebP，看内容判断）先剥掉 EXIF 这类元数据，剥过的才是入库版本；
//   媒体 id 是入库版本的 sha256。收尾时校验的是原始上传字节的 sha256。
// - 被引用的媒体永不回收；本票不做媒体回收。第一阶段不生成缩略图等派生物。
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { DEFAULT_MAX_UPLOAD_BYTES, type HttpErrorCode, isMediaId, type UploadedMedia, type UploadStatus, t } from "@ergo/protocol";
import { renameRetrying } from "../util/atomic-file.ts";
import { sizeLabel } from "./file-types.ts";
import { type AudioInfo, sniffAudio } from "./audio.ts";
import { type ImageInfo, readImageInfo, sniffImage, stripImageMetadata } from "./image.ts";

/**
 * 媒体库的错误：带协议里的错误码（不带 HTTP 状态码，状态码由网关按错误码定），
 * 偏移对不上、没收全时带服务端已收到的字节数。
 */
export class MediaError extends Error {
  readonly code: MediaErrorCode;
  readonly offset: number | undefined;
  constructor(code: MediaErrorCode, message: string, offset?: number) {
    super(message);
    this.code = code;
    this.offset = offset;
  }
}

export type MediaErrorCode = Extract<HttpErrorCode, "not_found" | "too_large" | "offset_mismatch" | "busy" | "sha256_mismatch" | "incomplete">;

/** 一份入库的媒体的情况 */
export interface MediaInfo {
  mediaId: string;
  size: number;
  /** 浏览器能直接显示的图片才有 */
  image: ImageInfo | undefined;
  /** 按内容认出来的音频才有（语音消息的录音，31 号票） */
  audio: AudioInfo | undefined;
}

export interface MediaStore {
  /** 单个文件的上限（字节） */
  readonly maxUploadBytes: number;
  createUpload(input: { name: string; mime: string; size: number }): UploadStatus;
  /** 某个上传的进度（有分片正在写时，等它写完再报） */
  uploadStatus(uploadId: string): Promise<UploadStatus>;
  /** 从 offset 起写一段字节；offset 必须等于服务端已收到的字节数。连接中途断了，已经写下的照样算数 */
  writeChunk(uploadId: string, offset: number, body: Readable): Promise<UploadStatus>;
  /** 收尾：校验原始上传字节的 sha256，入库。同一个上传重复收尾拿到同一个结果 */
  completeUpload(uploadId: string, sha256: string): Promise<UploadedMedia>;
  /** 把本机的一个文件复制进媒体库（秘书把草稿区里的文件、117 号票起维护者把工作目录里的文件作为附件发出来时用）；原文件不动 */
  ingestFile(file: string, info: { name: string; mime: string }): Promise<UploadedMedia>;
  /** 入库的媒体；没有这个媒体是 undefined */
  info(mediaId: string): MediaInfo | undefined;
  /** 入库媒体的文件路径（调用方先用 info 确认存在） */
  filePath(mediaId: string): string;
  /** 入库媒体开头最多 bytes 个字节 */
  readHead(mediaId: string, bytes: number): Buffer;
  /**
   * 删掉一份入库媒体，连同由它派生的文件（名字是"媒体 id."开头的，比如以后的缩略图）。彻底删除（21 号票）时用：
   * 调用方先确认没有别的消息、素材还引用它。没有这份媒体时什么都不做
   */
  remove(mediaId: string): void;
}

export interface MediaStoreOptions {
  /** 入库的媒体放在这里（数据目录素材区的 media/） */
  mediaDir: string;
  /** 还没收尾的上传放在这里（数据目录临时区的 uploads/） */
  uploadsDir: string;
  maxUploadBytes?: number;
}

interface UploadMeta {
  uploadId: string;
  name: string;
  mime: string;
  size: number;
  createdAt: string;
}

const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 文件名最长多少个字符（超出的截掉，保留扩展名） */
const MAX_NAME_LENGTH = 200;
/** 读图片头（尺寸）最多读这么多字节 */
const IMAGE_HEADER_BYTES = 512 * 1024;

export function openMediaStore(options: MediaStoreOptions): MediaStore {
  const { mediaDir, uploadsDir } = options;
  const maxUploadBytes = options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.mkdirSync(uploadsDir, { recursive: true });
  /** 正在写分片或收尾的上传：同一个上传同时只做一件事 */
  const busy = new Map<string, Promise<unknown>>();

  const metaFile = (id: string) => path.join(uploadsDir, `${id}.json`);
  const partFile = (id: string) => path.join(uploadsDir, `${id}.part`);
  const doneFile = (id: string) => path.join(uploadsDir, `${id}.done.json`);
  const mediaFile = (mediaId: string) => path.join(mediaDir, mediaId);

  const readMeta = (uploadId: string): UploadMeta => {
    if (!UPLOAD_ID.test(uploadId)) throw new MediaError("not_found", t("media.upload.notFound", { uploadId }));
    try {
      return JSON.parse(fs.readFileSync(metaFile(uploadId), "utf8")) as UploadMeta;
    } catch {
      throw new MediaError("not_found", t("media.upload.notFoundGone", { uploadId }));
    }
  };

  const received = (uploadId: string): number => {
    try {
      return fs.statSync(partFile(uploadId)).size;
    } catch {
      return 0;
    }
  };

  const statusOf = (meta: UploadMeta): UploadStatus => ({ uploadId: meta.uploadId, name: meta.name, mime: meta.mime, size: meta.size, offset: received(meta.uploadId) });

  /** 同一个上传上的操作排成一个一个做；有操作在做时，新来的写分片直接回 busy */
  const exclusive = async <T>(uploadId: string, work: () => Promise<T>): Promise<T> => {
    if (busy.has(uploadId)) throw new MediaError("busy", t("media.upload.busy"));
    const running = work();
    busy.set(uploadId, running);
    try {
      return await running;
    } finally {
      busy.delete(uploadId);
    }
  };

  const waitIdle = async (uploadId: string) => {
    await busy.get(uploadId)?.catch(() => {});
  };

  /** 把一份内容存进媒体库（已经存在就不再写），返回媒体 id */
  const store = async (source: { file: string; move: boolean } | { bytes: Buffer }): Promise<{ mediaId: string; size: number }> => {
    if ("bytes" in source) {
      const mediaId = createHash("sha256").update(source.bytes).digest("hex");
      const target = mediaFile(mediaId);
      if (!fs.existsSync(target)) writeAtomically(target, (tmp) => fs.writeFileSync(tmp, source.bytes));
      return { mediaId, size: source.bytes.length };
    }
    const mediaId = await hashFile(source.file);
    const target = mediaFile(mediaId);
    const size = fs.statSync(source.file).size;
    if (fs.existsSync(target)) {
      if (source.move) fs.rmSync(source.file, { force: true });
    } else if (source.move) {
      moveFile(source.file, target);
    } else {
      writeAtomically(target, (tmp) => fs.copyFileSync(source.file, tmp));
    }
    return { mediaId, size };
  };

  /** 入库一个文件：图片剥掉元数据后存，其他原样存 */
  const ingest = async (file: string, info: { name: string; mime: string }, move: boolean): Promise<UploadedMedia> => {
    const name = sanitizeName(info.name);
    const header = readHead(file, 64);
    const sniffed = sniffImage(header);
    if (sniffed) {
      const stripped = stripImageMetadata(fs.readFileSync(file), sniffed.mime);
      const { mediaId, size } = await store({ bytes: stripped });
      if (move) fs.rmSync(file, { force: true });
      const image = readImageInfo(stripped);
      return {
        mediaId,
        kind: "image",
        name,
        mime: sniffed.mime,
        size,
        ...(image?.width === undefined ? {} : { width: image.width }),
        ...(image?.height === undefined ? {} : { height: image.height }),
      };
    }
    const { mediaId, size } = await store({ file, move });
    return { mediaId, kind: "file", name, mime: normalizeMime(info.mime), size };
  };

  return {
    maxUploadBytes,
    createUpload(input) {
      if (input.size > maxUploadBytes) {
        throw new MediaError("too_large", t("media.upload.tooLarge", { size: sizeLabel(input.size), max: sizeLabel(maxUploadBytes) }));
      }
      const meta: UploadMeta = { uploadId: randomUUID(), name: sanitizeName(input.name), mime: normalizeMime(input.mime), size: input.size, createdAt: new Date().toISOString() };
      fs.writeFileSync(partFile(meta.uploadId), "");
      fs.writeFileSync(metaFile(meta.uploadId), JSON.stringify(meta));
      return statusOf(meta);
    },
    async uploadStatus(uploadId) {
      await waitIdle(uploadId);
      return statusOf(readMeta(uploadId));
    },
    writeChunk(uploadId, offset, body) {
      const meta = readMeta(uploadId);
      return exclusive(uploadId, async () => {
        const current = received(uploadId);
        if (offset !== current) throw new MediaError("offset_mismatch", t("media.upload.offsetMismatch", { received: current, offset }), current);
        const room = meta.size - current;
        const overflow = await appendBody(partFile(uploadId), body, room);
        if (overflow) {
          throw new MediaError("too_large", t("media.upload.chunkTooLarge", { size: meta.size }), received(uploadId));
        }
        return statusOf(meta);
      });
    },
    async completeUpload(uploadId, sha256) {
      await waitIdle(uploadId);
      const done = readDone(doneFile(uploadId));
      if (done) return done;
      const meta = readMeta(uploadId);
      return exclusive(uploadId, async () => {
        const got = received(uploadId);
        if (got !== meta.size) throw new MediaError("incomplete", t("media.upload.incomplete", { got, size: meta.size }), got);
        const actual = await hashFile(partFile(uploadId));
        if (actual !== sha256) {
          // 不入库；这个上传作废，前端从头再传
          fs.rmSync(partFile(uploadId), { force: true });
          fs.rmSync(metaFile(uploadId), { force: true });
          throw new MediaError("sha256_mismatch", t("media.upload.sha256Mismatch", { actual, sha256 }));
        }
        const result = await ingest(partFile(uploadId), meta, true);
        fs.writeFileSync(doneFile(uploadId), JSON.stringify(result));
        fs.rmSync(metaFile(uploadId), { force: true });
        return result;
      });
    },
    ingestFile(file, info) {
      return ingest(file, info, false);
    },
    info(mediaId) {
      if (!isMediaId(mediaId)) return undefined;
      let size: number;
      try {
        size = fs.statSync(mediaFile(mediaId)).size;
      } catch {
        return undefined;
      }
      const head = readHead(mediaFile(mediaId), IMAGE_HEADER_BYTES);
      const image = sniffImage(head) ? readImageInfo(head) : undefined;
      return { mediaId, size, image, audio: image ? undefined : sniffAudio(head) };
    },
    filePath(mediaId) {
      if (!isMediaId(mediaId)) throw new Error(`媒体 id 不对：${mediaId}`); // @i18n-ignore log：编程错误
      return mediaFile(mediaId);
    },
    readHead(mediaId, bytes) {
      return readHead(this.filePath(mediaId), bytes);
    },
    remove(mediaId) {
      if (!isMediaId(mediaId)) throw new Error(`媒体 id 不对：${mediaId}`); // @i18n-ignore log：编程错误
      for (const name of fs.readdirSync(mediaDir)) {
        if (name !== mediaId && !name.startsWith(`${mediaId}.`)) continue;
        const file = path.join(mediaDir, name);
        // 可能设了只读：先去掉
        fs.chmodSync(file, 0o644);
        fs.rmSync(file, { force: true });
      }
    },
  };
}

/**
 * 把请求体追加写到文件末尾，最多写 room 个字节。请求中途断了（断网）就把已经收到的写完收尾。
 * 返回请求体是不是超出了 room（超出的部分没写）。
 */
function appendBody(file: string, body: Readable, room: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file, { flags: "a" });
    let written = 0;
    let overflow = false;
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      out.end();
    };
    body.on("data", (chunk: Buffer) => {
      if (ended) return;
      const fit = Math.min(chunk.length, room - written);
      if (fit > 0) {
        written += fit;
        if (!out.write(fit === chunk.length ? chunk : chunk.subarray(0, fit))) body.pause();
      }
      if (fit < chunk.length) {
        overflow = true;
        end();
        body.resume();
      }
    });
    out.on("drain", () => body.resume());
    body.on("end", end);
    body.on("close", end);
    body.on("error", end);
    out.on("close", () => resolve(overflow));
    out.on("error", reject);
  });
}

function readDone(file: string): UploadedMedia | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as UploadedMedia;
  } catch {
    return undefined;
  }
}

/** 文件开头最多 bytes 个字节 */
function readHead(file: string, bytes: number): Buffer {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** 先写到旁边的临时文件再改名：媒体库里不会出现写了一半的文件；刚写完的文件被杀毒扫着时改名等一会儿重试（265 号票） */
function writeAtomically(target: string, write: (tmp: string) => void): void {
  const tmp = `${target}.${randomUUID()}.tmp`;
  try {
    write(tmp);
    renameRetrying(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    if (fs.existsSync(target)) return; // 同样的内容刚被别处存进来了
    throw err;
  }
}

/** 收完的上传挪进媒体库（被占着时等一会儿重试，265 号票）；跨盘时复制一份再删原来的 */
function moveFile(from: string, to: string): void {
  try {
    renameRetrying(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    writeAtomically(to, (tmp) => fs.copyFileSync(from, tmp));
    fs.rmSync(from, { force: true });
  }
}

/** 文件名只当显示和下载时的名字：去掉路径分隔符和控制字符，太长的截短（保留扩展名） */
export function sanitizeName(name: string): string {
  // eslint-disable-next-line no-control-regex
  let clean = name.replace(/[\u0000-\u001f\u007f]/g, "").replace(/[\\/]/g, "_").trim();
  if (!clean) clean = t("media.untitled");
  if (clean.length > MAX_NAME_LENGTH) {
    const ext = path.extname(clean).slice(0, 16);
    clean = clean.slice(0, MAX_NAME_LENGTH - ext.length) + ext;
  }
  return clean;
}

function normalizeMime(mime: string): string {
  const clean = (mime.split(";")[0] ?? "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(clean) ? clean : "application/octet-stream";
}
