// 照片的拍摄时间（134 号票：替网页的上传框找"周末在杭州拍的照片"）：读 JPEG 开头的 EXIF，取拍摄时间（Exif 子目录的
// DateTimeOriginal 0x9003，没有就用 IFD0 的 DateTime 0x0132）。EXIF 里的时间不带时区，按拍的时候的本地时间原样给（"YYYY-MM-DD HH:mm"）。
// 只认 JPEG（手机照片、相机照片绝大多数是它）；HEIC、PNG 这些没有就退回文件的修改时间（find-files.ts）。读 GPS 反查城市以后再做。
import fs from "node:fs";
import { jpegSegments } from "../media/image.ts";

/** 读文件开头多少字节找 EXIF（APP1 段在图像数据前面，一般几十 KB 以内） */
const EXIF_HEAD_BYTES = 192 * 1024;

const EXIF_HEADER = "Exif\0\0";
const TAG_DATETIME = 0x0132;
const TAG_EXIF_IFD = 0x8769;
const TAG_DATETIME_ORIGINAL = 0x9003;

/** EXIF 的时间写法 "YYYY:MM:DD HH:MM:SS" → "YYYY-MM-DD HH:mm"；写法不对（全是 0、空的）是 undefined */
export function exifTimeOf(text: string): string | undefined {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})/.exec(text.trim());
  if (!m || m[1] === "0000" || m[2] === "00" || m[3] === "00") return undefined;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
}

/** TIFF 结构里读拍摄时间（tiff 从字节序标记 II / MM 开始） */
export function tiffCaptureTime(tiff: Uint8Array): string | undefined {
  if (tiff.length < 8) return undefined;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const order = String.fromCharCode(tiff[0]!, tiff[1]!);
  if (order !== "II" && order !== "MM") return undefined;
  const le = order === "II";
  const u16 = (at: number) => (at + 2 <= tiff.length ? view.getUint16(at, le) : undefined);
  const u32 = (at: number) => (at + 4 <= tiff.length ? view.getUint32(at, le) : undefined);
  /** 一个目录里某个 ASCII 标签的值，或某个 LONG 标签（子目录指针）的值 */
  const entries = (ifd: number): Array<{ tag: number; type: number; count: number; at: number }> => {
    const count = u16(ifd);
    if (count === undefined || count > 512) return [];
    const list = [];
    for (let i = 0; i < count; i++) {
      const at = ifd + 2 + i * 12;
      const tag = u16(at);
      const type = u16(at + 2);
      const n = u32(at + 4);
      if (tag === undefined || type === undefined || n === undefined) break;
      list.push({ tag, type, count: n, at });
    }
    return list;
  };
  const ascii = (entry: { type: number; count: number; at: number }): string | undefined => {
    if (entry.type !== 2 || entry.count < 19) return undefined;
    const offset = entry.count <= 4 ? entry.at + 8 : u32(entry.at + 8);
    if (offset === undefined || offset + entry.count > tiff.length) return undefined;
    return String.fromCharCode(...tiff.subarray(offset, offset + Math.min(entry.count, 32)));
  };
  const ifd0 = u32(4);
  if (ifd0 === undefined) return undefined;
  const first = entries(ifd0);
  const sub = first.find((e) => e.tag === TAG_EXIF_IFD);
  const subOffset = sub ? u32(sub.at + 8) : undefined;
  if (subOffset !== undefined) {
    const original = entries(subOffset).find((e) => e.tag === TAG_DATETIME_ORIGINAL);
    const text = original && ascii(original);
    const time = text && exifTimeOf(text);
    if (time) return time;
  }
  const plain = first.find((e) => e.tag === TAG_DATETIME);
  const text = plain && ascii(plain);
  return text ? exifTimeOf(text) : undefined;
}

/** JPEG 的拍摄时间（"YYYY-MM-DD HH:mm"，拍的时候的本地时间）；不是 JPEG、没有 EXIF、读不出来是 undefined */
export function jpegCaptureTime(head: Uint8Array): string | undefined {
  if (head.length < 4 || head[0] !== 0xff || head[1] !== 0xd8) return undefined;
  for (const seg of jpegSegments(head)) {
    if (seg.marker !== 0xe1) continue;
    const data = head.subarray(seg.dataStart, Math.min(seg.end, head.length));
    if (String.fromCharCode(...data.subarray(0, 6)) !== EXIF_HEADER) continue;
    return tiffCaptureTime(data.subarray(6));
  }
  return undefined;
}

/** 读一个文件开头找拍摄时间；读不了是 undefined */
export function readCaptureTime(file: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(EXIF_HEAD_BYTES);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    return jpegCaptureTime(head.subarray(0, n));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
