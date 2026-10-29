// @i18n-ignore-file model：缩不成的原因写进 view_files 的结果（给秘书看）
// 子进程里的"缩小成小图"（145 号票的 view_files，149 号票起是秘书在用）：用 pi 自带的图片缩放（pi 的 read 工具读图时用的那个，
// Rust/WASM 的 Photon，解码、按 EXIF 摆正、缩小、编码），长边缩到上限以内、编码后不超过 MAX_BYTES：缩小后先试 PNG、再试 JPEG，
// 哪个先够小用哪个——像照片的多半是 JPEG，大片纯色的（截图、全黑）PNG 就够小；本来就够小的原样给。
// 守护进程只认得 JPEG、PNG、GIF、WebP 交给模型；别的格式（BMP 这类原样回来的）当看不了。
import fs from "node:fs";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import type { ThumbnailOutcome, ThumbnailRequest, ThumbnailResult } from "../thumbnails.ts";

/** 小图编码后（base64）最多多大 */
const MAX_BYTES = 64 * 1024;
/** JPEG 的质量（够看清是不是人脸、什么东西） */
const JPEG_QUALITY = 70;
/** 同时解几张（每张 pi 起一个 worker 线程） */
const PARALLEL = 3;

const MODEL_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

async function one(file: { path: string; mime: string }, maxEdge: number): Promise<ThumbnailOutcome> {
  let bytes: Buffer;
  try {
    bytes = await fs.promises.readFile(file.path);
  } catch (err) {
    return { ok: false, reason: `读不了（${(err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err))}）` };
  }
  const resized = await resizeImage(bytes, file.mime, { maxWidth: maxEdge, maxHeight: maxEdge, maxBytes: MAX_BYTES, jpegQuality: JPEG_QUALITY }).catch(() => null);
  if (!resized) return { ok: false, reason: "解不开（格式不认得或文件坏了）" };
  if (!MODEL_IMAGE_TYPES.has(resized.mimeType)) return { ok: false, reason: `解不开（${resized.mimeType} 这种格式看不了）` };
  return { ok: true, data: resized.data, mime: resized.mimeType, width: resized.width, height: resized.height };
}

export async function makeThumbnails(request: ThumbnailRequest): Promise<ThumbnailResult> {
  const thumbs: ThumbnailOutcome[] = Array.from({ length: request.files.length });
  let next = 0;
  const worker = async () => {
    while (next < request.files.length) {
      const i = next++;
      thumbs[i] = await one(request.files[i]!, request.maxEdge);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, request.files.length) }, worker));
  return { thumbs };
}
