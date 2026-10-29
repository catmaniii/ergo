// 测试用的小图片：按格式的结构手工拼出来（不依赖图片库），可以带上 EXIF（含 GPS）、XMP 这类元数据。
// 图像数据本身是占位的，只保证各段、各块的结构正确：剥元数据和读尺寸只看结构。
import { deflateSync } from "node:zlib";

/** GPS 纬度 0°0'0"（一眼看得出是假的；三个有理数 0/1）：剥过元数据后，这串字节不应再出现 */
export const GPS_LATITUDE = Buffer.from([0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1]);
export const CAMERA_MODEL = "MARKER-Camera-Model";

/** TIFF 结构的 EXIF（大端）：IFD0 里有相机型号、可选的方向，以及指向 GPS IFD 的指针 */
export function exifTiff(options: { orientation?: number; gps?: boolean } = {}): Buffer {
  const model = Buffer.from(`${CAMERA_MODEL}\0`, "latin1");
  const entries: Array<{ tag: number; type: number; count: number; value: Buffer | number }> = [];
  entries.push({ tag: 0x0110, type: 2, count: model.length, value: model });
  if (options.orientation !== undefined) entries.push({ tag: 0x0112, type: 3, count: 1, value: options.orientation });
  if (options.gps) entries.push({ tag: 0x8825, type: 4, count: 1, value: -1 }); // 偏移稍后填
  const ifd0Size = 2 + entries.length * 12 + 4;
  const header = Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8]);
  let dataOffset = 8 + ifd0Size;
  const ifd0 = Buffer.alloc(ifd0Size);
  const extra: Buffer[] = [];
  ifd0.writeUInt16BE(entries.length, 0);
  let gpsPointerAt = -1;
  entries.forEach((e, i) => {
    const at = 2 + i * 12;
    ifd0.writeUInt16BE(e.tag, at);
    ifd0.writeUInt16BE(e.type, at + 2);
    ifd0.writeUInt32BE(e.count, at + 4);
    if (Buffer.isBuffer(e.value)) {
      ifd0.writeUInt32BE(dataOffset, at + 8);
      extra.push(e.value);
      dataOffset += e.value.length;
    } else if (e.type === 3) {
      ifd0.writeUInt16BE(e.value, at + 8);
    } else {
      gpsPointerAt = at + 8;
    }
  });
  let gps = Buffer.alloc(0);
  if (options.gps) {
    ifd0.writeUInt32BE(dataOffset, gpsPointerAt);
    // GPS IFD：纬度参考 "N"、纬度
    const gpsIfd = Buffer.alloc(2 + 2 * 12 + 4);
    gpsIfd.writeUInt16BE(2, 0);
    gpsIfd.writeUInt16BE(0x0001, 2);
    gpsIfd.writeUInt16BE(2, 4);
    gpsIfd.writeUInt32BE(2, 6);
    gpsIfd.write("N\0", 10, "latin1");
    gpsIfd.writeUInt16BE(0x0002, 14);
    gpsIfd.writeUInt16BE(5, 16);
    gpsIfd.writeUInt32BE(3, 18);
    gpsIfd.writeUInt32BE(dataOffset + gpsIfd.length, 22);
    gps = Buffer.concat([gpsIfd, GPS_LATITUDE]);
  }
  return Buffer.concat([header, ifd0, ...extra, gps]);
}

function segment(marker: number, data: Buffer): Buffer {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([head, data]);
}

export const XMP_MARKER = "MARKER-xmp-gps-31.2292";

export const MPF_MARKER = "MARKER-mpf-second-image";

/**
 * 一张 JPEG：JFIF、可选的 EXIF（APP1）、可选的 XMP（APP1）、ICC（APP2）、可选的多图索引（APP2 的 MPF）、注释、量化表、帧头、扫描。
 * progressive 时有两次扫描，中间夹一个霍夫曼表段；扫描数据里有 0xFF 0x00 和复位标记。
 * trailing 接在图像结束标记之后（手机照片在那里附带 MPF 的第二张图、动态照片的视频等）。
 */
export function jpeg(
  options: { width?: number; height?: number; exif?: { orientation?: number; gps?: boolean }; xmp?: boolean; comment?: string; mpf?: boolean; progressive?: boolean; trailing?: Buffer } = {},
): Buffer {
  const { width = 4, height = 3 } = options;
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  parts.push(segment(0xe0, Buffer.from([0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00])));
  if (options.exif) parts.push(segment(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), exifTiff(options.exif)])));
  if (options.xmp) parts.push(segment(0xe1, Buffer.from(`http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>${XMP_MARKER}</x:xmpmeta>`, "latin1")));
  parts.push(segment(0xe2, Buffer.concat([Buffer.from("ICC_PROFILE\0", "latin1"), Buffer.from([1, 1]), Buffer.alloc(16, 7)])));
  if (options.mpf) parts.push(segment(0xe2, Buffer.concat([Buffer.from("MPF\0", "latin1"), Buffer.from(MPF_MARKER, "latin1")])));
  if (options.comment !== undefined) parts.push(segment(0xfe, Buffer.from(options.comment, "latin1")));
  parts.push(segment(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)])));
  const sof = Buffer.from([8, 0, 0, 0, 0, 1, 1, 0x11, 0]);
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  parts.push(segment(options.progressive ? 0xc2 : 0xc0, sof));
  parts.push(segment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])));
  parts.push(Buffer.from([0x12, 0x34, 0x56, 0xff, 0x00, 0x78]));
  if (options.progressive) {
    parts.push(segment(0xc4, Buffer.concat([Buffer.from([0x10]), Buffer.alloc(16, 0), Buffer.from([0xff, 0xd9])])));
    parts.push(segment(0xda, Buffer.from([1, 1, 0, 1, 0x3f, 0])));
    parts.push(Buffer.from([0x9a, 0xff, 0x00, 0xbc, 0xff, 0xd0, 0xde]));
  }
  parts.push(Buffer.from([0xff, 0xd9]));
  if (options.trailing) parts.push(options.trailing);
  return Buffer.concat(parts);
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** 一张 PNG：IHDR、可选的 eXIf 和文字块（tEXt、iTXt 里的 XMP）、IDAT、IEND */
export function png(options: { width?: number; height?: number; exif?: boolean; text?: boolean } = {}): Buffer {
  const { width = 5, height = 2 } = options;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const chunks = [pngChunk("IHDR", ihdr)];
  if (options.exif) chunks.push(pngChunk("eXIf", exifTiff({ gps: true })));
  if (options.text) {
    chunks.push(pngChunk("tEXt", Buffer.from(`Comment\0${XMP_MARKER}`, "latin1")));
    chunks.push(pngChunk("iTXt", Buffer.from(`XML:com.adobe.xmp\0\0\0\0\0${XMP_MARKER}`, "latin1")));
  }
  chunks.push(pngChunk("IDAT", deflateSync(Buffer.alloc(height * (1 + width * 3)))));
  chunks.push(pngChunk("IEND", Buffer.alloc(0)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks]);
}

function riffChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(type, 0, "latin1");
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

/**
 * 一张真能解码、像照片一样有渐变的 PNG（145 号票：秘书看图时缩小的那一步要真的解开、缩小、编码；全黑的图缩小后
 * 存成 PNG 就够小，这种渐变的缩小后是 JPEG）
 */
export function gradientPng(width: number, height: number): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = y * (width * 3 + 1) + 1 + x * 3;
      raw[o] = Math.floor((x * 255) / width);
      raw[o + 1] = Math.floor((y * 255) / height);
      raw[o + 2] = Math.floor(128 + 60 * Math.sin(x / 20) * Math.cos(y / 20));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

/** 一张扩展格式（VP8X）的 WebP，可带 EXIF 和 XMP 块 */
export function webp(options: { width?: number; height?: number; exif?: boolean; xmp?: boolean } = {}): Buffer {
  const { width = 6, height = 7 } = options;
  const vp8x = Buffer.alloc(10);
  vp8x[0] = (options.exif ? 0x08 : 0) | (options.xmp ? 0x04 : 0);
  vp8x.writeUIntLE(width - 1, 4, 3);
  vp8x.writeUIntLE(height - 1, 7, 3);
  const chunks = [riffChunk("VP8X", vp8x), riffChunk("VP8 ", Buffer.alloc(12, 3))];
  if (options.exif) chunks.push(riffChunk("EXIF", exifTiff({ gps: true })));
  if (options.xmp) chunks.push(riffChunk("XMP ", Buffer.from(XMP_MARKER, "latin1")));
  const body = Buffer.concat([Buffer.from("WEBP", "latin1"), ...chunks]);
  const head = Buffer.alloc(8);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

/** JPEG 各段的标记（到 SOS 为止），APP1 标出是 EXIF 还是 XMP */
export function jpegMarkers(b: Buffer): string[] {
  const out: string[] = [];
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1]!;
    const length = b.readUInt16BE(i + 2);
    const data = b.subarray(i + 4, i + 2 + length);
    let name = `ff${marker.toString(16)}`;
    if (marker === 0xe1) name += data.subarray(0, 6).toString("latin1") === "Exif\0\0" ? ":exif" : ":xmp";
    out.push(name);
    if (marker === 0xda) break;
    i += 2 + length;
  }
  return out;
}

/** PNG 各块的类型 */
export function pngChunkTypes(b: Buffer): string[] {
  const out: string[] = [];
  for (let i = 8; i + 8 <= b.length; ) {
    const len = b.readUInt32BE(i);
    out.push(b.subarray(i + 4, i + 8).toString("latin1"));
    i += 12 + len;
  }
  return out;
}

/** WebP 各块的类型 */
export function webpChunkTypes(b: Buffer): string[] {
  const out: string[] = [];
  for (let i = 12; i + 8 <= b.length; ) {
    const len = b.readUInt32LE(i + 4);
    out.push(b.subarray(i, i + 4).toString("latin1"));
    i += 8 + len + (len % 2);
  }
  return out;
}
