// 图片：按内容（不看文件名和前端声明的类型）认出浏览器能直接显示的几种格式，读尺寸，入库前剥掉元数据。
// 只认 JPEG、PNG、GIF、WebP；其他（HEIC、SVG、BMP、TIFF……）当普通文件存，不在聊天里直接显示，也**不剥元数据**
// （第一阶段的取舍：HEIC、TIFF 里同样可能有 GPS，原样存进媒体库）。

export type ImageMime = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export interface ImageInfo {
  mime: ImageMime;
  width: number | undefined;
  height: number | undefined;
}

/** 看开头的字节认图片格式；不是认得的图片返回 undefined */
export function sniffImage(head: Uint8Array): { mime: ImageMime } | undefined {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { mime: "image/jpeg" };
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: "image/png" };
  if (ascii(head, 0, 6) === "GIF87a" || ascii(head, 0, 6) === "GIF89a") return { mime: "image/gif" };
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WEBP") return { mime: "image/webp" };
  return undefined;
}

/**
 * 图片的格式和显示出来的尺寸（读不出来时为 undefined）；不是认得的图片返回 undefined。
 * JPEG 的 EXIF 方向是 5–8（转了 90°）时，显示出来宽高对调，这里给的是对调后的。
 */
export function readImageInfo(bytes: Uint8Array): ImageInfo | undefined {
  const sniffed = sniffImage(bytes);
  if (!sniffed) return undefined;
  const size = dimensions(bytes, sniffed.mime);
  const rotated = sniffed.mime === "image/jpeg" && (jpegOrientation(bytes) ?? 1) >= 5;
  return { mime: sniffed.mime, width: rotated ? size?.height : size?.width, height: rotated ? size?.width : size?.height };
}

/**
 * 入库前剥掉图片里的元数据，返回入库版本：
 * - JPEG：去掉 GPS、相机等全部 EXIF，只留方向——原图的 EXIF 里方向不是"正常"时，补一个只含方向这一项的最小 EXIF，
 *   不然手机竖着拍的照片在浏览器里会躺倒。XMP（APP1）、Photoshop / IPTC（APP13）、注释（COM）、多图索引（APP2 的 MPF）
 *   也去掉；图像结束标记之后附带的数据（MPF 的第二张图、动态照片的视频等）截掉。JFIF、ICC 色彩配置、量化表等原样保留；
 * - PNG：去掉 eXIf 和文字块（tEXt、zTXt、iTXt，XMP 就放在 iTXt 里）、时间（tIME）；
 * - WebP：去掉 EXIF 和 XMP 块，清掉 VP8X 里对应的标志位；
 * - GIF：没有 EXIF，原样。
 * 结构不认得（截断、损坏）的部分原样保留，不猜。
 */
export function stripImageMetadata(bytes: Buffer, mime: ImageMime): Buffer {
  switch (mime) {
    case "image/jpeg":
      return stripJpeg(bytes);
    case "image/png":
      return stripPng(bytes);
    case "image/webp":
      return stripWebp(bytes);
    case "image/gif":
      return bytes;
  }
}

const JPEG_APP1 = 0xe1;
const JPEG_APP2 = 0xe2;
const JPEG_APP13 = 0xed;
const JPEG_COM = 0xfe;
const JPEG_SOS = 0xda;
const JPEG_EOI = 0xd9;
const EXIF_HEADER = Buffer.from("Exif\0\0", "latin1");
const MPF_HEADER = Buffer.from("MPF\0", "latin1");

/**
 * 一段一段地走完整个 JPEG（含渐进式的多次扫描）：元数据段去掉，其余原样保留；
 * 图像结束标记（EOI）之后的数据一律截掉——手机照片常在那里附带第二张图（MPF）、动态照片的视频等。
 * 走到认不出的结构（损坏、截断）就停下：剩下的部分原样保留，但截断在元数据段里的那一截不留。
 */
function stripJpeg(b: Buffer): Buffer {
  const kept: Buffer[] = [];
  let orientation: number | undefined;
  /** 方向 EXIF 插在哪：JFIF（APP0）之后，没有 APP0 就紧跟 SOI */
  let insertAt = 0;
  let i = 2;
  let ended = false;
  while (i + 1 < b.length && b[i] === 0xff) {
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      // 填充字节
      i += 1;
      continue;
    }
    if (marker === JPEG_EOI) {
      kept.push(b.subarray(i, i + 2));
      i += 2;
      ended = true;
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      kept.push(b.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (i + 4 > b.length) break;
    const end = i + 2 + ((b[i + 2]! << 8) | b[i + 3]!);
    const data = b.subarray(i + 4, Math.min(end, b.length));
    const metadata = isMetadataSegment(marker, data);
    if (end > b.length) {
      // 截断在这一段里：是元数据段就整截不要
      if (metadata) i = b.length;
      break;
    }
    if (marker === JPEG_APP1 && data.subarray(0, 6).equals(EXIF_HEADER)) orientation ??= readOrientation(data.subarray(6));
    if (!metadata) kept.push(b.subarray(i, end));
    if (marker === 0xe0 && kept.length === 1) insertAt = 1;
    i = end;
    if (marker === JPEG_SOS) {
      // 扫描数据：到下一个标记为止（0xFF 后跟 0x00 是数据里的 0xFF，跟 RST 是复位标记，都还在扫描数据里）
      let j = i;
      while (j + 1 < b.length && !(b[j] === 0xff && b[j + 1] !== 0x00 && !(b[j + 1]! >= 0xd0 && b[j + 1]! <= 0xd7))) j += 1;
      if (j + 1 >= b.length) j = b.length;
      kept.push(b.subarray(i, j));
      i = j;
    }
  }
  if (orientation !== undefined && orientation !== 1) kept.splice(insertAt, 0, orientationExifSegment(orientation));
  return Buffer.concat([b.subarray(0, 2), ...kept, ended ? Buffer.alloc(0) : b.subarray(i)]);
}

/** 要去掉的元数据段：EXIF 和 XMP（APP1）、Photoshop / IPTC（APP13）、注释（COM）、多图索引（APP2 里的 MPF） */
function isMetadataSegment(marker: number, data: Buffer): boolean {
  if (marker === JPEG_APP1 || marker === JPEG_APP13 || marker === JPEG_COM) return true;
  return marker === JPEG_APP2 && data.subarray(0, 4).equals(MPF_HEADER);
}

/** JPEG 的 EXIF 里记的方向（1–8）；没有是 undefined */
function jpegOrientation(b: Uint8Array): number | undefined {
  for (const seg of jpegSegments(b)) {
    if (seg.marker !== JPEG_APP1) continue;
    const data = Buffer.from(b.buffer, b.byteOffset + seg.dataStart, Math.max(0, Math.min(seg.end, b.length) - seg.dataStart));
    if (data.subarray(0, 6).equals(EXIF_HEADER)) return readOrientation(data.subarray(6));
  }
  return undefined;
}

/** 只含方向这一项的 EXIF（APP1 段） */
function orientationExifSegment(orientation: number): Buffer {
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff.write("MM\0*", 0, "latin1");
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x0112, 10);
  tiff.writeUInt16BE(3, 12);
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(orientation, 18);
  const data = Buffer.concat([EXIF_HEADER, tiff]);
  const head = Buffer.from([0xff, JPEG_APP1, 0, 0]);
  head.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([head, data]);
}

/** 从 EXIF 的 TIFF 结构里读 IFD0 的方向（0x0112）；读不出来是 undefined */
function readOrientation(tiff: Buffer): number | undefined {
  if (tiff.length < 8) return undefined;
  const order = tiff.toString("latin1", 0, 2);
  if (order !== "II" && order !== "MM") return undefined;
  const le = order === "II";
  const u16 = (at: number) => (le ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const u32 = (at: number) => (le ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return undefined;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const at = ifd + 2 + i * 12;
    if (at + 12 > tiff.length) return undefined;
    if (u16(at) === 0x0112 && u16(at + 2) === 3) {
      const value = u16(at + 8);
      return value >= 1 && value <= 8 ? value : undefined;
    }
  }
  return undefined;
}

const PNG_METADATA_CHUNKS = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME"]);

function stripPng(b: Buffer): Buffer {
  const kept: Buffer[] = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const length = b.readUInt32BE(i);
    const end = i + 12 + length;
    if (end > b.length) break;
    const type = b.toString("latin1", i + 4, i + 8);
    if (!PNG_METADATA_CHUNKS.has(type)) kept.push(b.subarray(i, end));
    i = end;
  }
  kept.push(b.subarray(i));
  return Buffer.concat(kept);
}

const WEBP_EXIF_FLAG = 0x08;
const WEBP_XMP_FLAG = 0x04;

function stripWebp(b: Buffer): Buffer {
  if (b.length < 21 || b.toString("latin1", 12, 16) !== "VP8X") return b;
  const kept: Buffer[] = [];
  let i = 12;
  while (i + 8 <= b.length) {
    const type = b.toString("latin1", i, i + 4);
    const length = b.readUInt32LE(i + 4);
    const end = i + 8 + length + (length % 2);
    if (end > b.length) break;
    if (type === "VP8X") {
      const chunk = Buffer.from(b.subarray(i, end));
      chunk[8] = chunk[8]! & ~(WEBP_EXIF_FLAG | WEBP_XMP_FLAG);
      kept.push(chunk);
    } else if (type !== "EXIF" && type !== "XMP ") {
      kept.push(b.subarray(i, end));
    }
    i = end;
  }
  kept.push(b.subarray(i));
  const body = Buffer.concat([Buffer.from("WEBP", "latin1"), ...kept]);
  const head = Buffer.alloc(8);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

function dimensions(b: Uint8Array, mime: ImageMime): { width: number; height: number } | undefined {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  switch (mime) {
    case "image/png":
      // IHDR 是第一个块：签名 8 字节 + 长度 4 + 类型 4，之后是宽、高（大端）
      return b.length >= 24 ? { width: view.getUint32(16), height: view.getUint32(20) } : undefined;
    case "image/gif":
      return b.length >= 10 ? { width: view.getUint16(6, true), height: view.getUint16(8, true) } : undefined;
    case "image/webp":
      return webpDimensions(b, view);
    case "image/jpeg":
      return jpegDimensions(b, view);
  }
}

function webpDimensions(b: Uint8Array, view: DataView): { width: number; height: number } | undefined {
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8X" && b.length >= 30) {
    return { width: (view.getUint32(24, true) & 0xffffff) + 1, height: (view.getUint32(27, true) & 0xffffff) + 1 };
  }
  if (chunk === "VP8 " && b.length >= 30) return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  if (chunk === "VP8L" && b.length >= 25) {
    const bits = view.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return undefined;
}

/** JPEG 的帧头（SOFn）里有尺寸 */
function jpegDimensions(b: Uint8Array, view: DataView): { width: number; height: number } | undefined {
  for (const seg of jpegSegments(b)) {
    const m = seg.marker;
    const isSof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
    if (isSof && seg.dataStart + 5 <= b.length) return { height: view.getUint16(seg.dataStart + 1), width: view.getUint16(seg.dataStart + 3) };
  }
  return undefined;
}

export interface JpegSegment {
  marker: number;
  /** 段的起点（0xFF 所在位置） */
  start: number;
  /** 段数据的起点（长度字段之后） */
  dataStart: number;
  /** 段的终点（不含） */
  end: number;
}

/** 依次列出 JPEG 开头到图像数据（SOS）之前的各个段 */
export function* jpegSegments(b: Uint8Array): Generator<JpegSegment> {
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1]!;
    // 填充字节
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    // 没有长度字段的独立标记
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const length = (b[i + 2]! << 8) | b[i + 3]!;
    const end = i + 2 + length;
    yield { marker, start: i, dataStart: i + 4, end };
    if (marker === 0xda) return; // SOS：后面是图像数据
    i = end;
  }
}

function startsWith(b: Uint8Array, prefix: number[]): boolean {
  return b.length >= prefix.length && prefix.every((v, i) => b[i] === v);
}

function ascii(b: Uint8Array, start: number, length: number): string {
  if (b.length < start + length) return "";
  return String.fromCharCode(...b.subarray(start, start + length));
}
