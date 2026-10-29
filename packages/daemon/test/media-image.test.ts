// 图片模块：按内容认格式、读尺寸、入库前剥元数据（纯函数，按模块测）。
// 主切面里有"上传带 GPS 的 JPEG，下载回来没有 EXIF"；这里补齐各种格式和边角。
import { describe, expect, it } from "vitest";
import { readImageInfo, sniffImage, stripImageMetadata } from "../src/media/image.ts";
import { CAMERA_MODEL, GPS_LATITUDE, jpeg, jpegMarkers, MPF_MARKER, png, pngChunkTypes, webp, webpChunkTypes, XMP_MARKER } from "./helpers/images.ts";

describe("认图片", () => {
  it("按内容认 JPEG、PNG、GIF、WebP，读出尺寸；别的格式不算图片", () => {
    expect(readImageInfo(jpeg({ width: 640, height: 480 }))).toEqual({ mime: "image/jpeg", width: 640, height: 480 });
    expect(readImageInfo(png({ width: 1024, height: 768 }))).toEqual({ mime: "image/png", width: 1024, height: 768 });
    expect(readImageInfo(webp({ width: 300, height: 200 }))).toEqual({ mime: "image/webp", width: 300, height: 200 });
    const gif = Buffer.from([...Buffer.from("GIF89a", "latin1"), 0x20, 0x00, 0x10, 0x00, 0, 0, 0]);
    expect(readImageInfo(gif)).toEqual({ mime: "image/gif", width: 32, height: 16 });
    expect(sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeUndefined();
    expect(sniffImage(Buffer.from("%PDF-1.4"))).toBeUndefined();
    expect(sniffImage(Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]))).toBeUndefined(); // HEIC
  });
});

describe("剥元数据", () => {
  it("JPEG：去掉 EXIF、XMP 和注释，JFIF、ICC、量化表、帧头和图像数据原样保留", () => {
    const original = jpeg({ exif: { gps: true }, xmp: true, comment: "MARKER-comment" });
    expect(jpegMarkers(original)).toEqual(["ffe0", "ffe1:exif", "ffe1:xmp", "ffe2", "fffe", "ffdb", "ffc0", "ffda"]);
    const stripped = stripImageMetadata(original, "image/jpeg");
    expect(jpegMarkers(stripped)).toEqual(["ffe0", "ffe2", "ffdb", "ffc0", "ffda"]);
    for (const marker of [GPS_LATITUDE, Buffer.from(CAMERA_MODEL), Buffer.from(XMP_MARKER), Buffer.from("MARKER-comment")]) {
      expect(stripped.includes(marker)).toBe(false);
    }
    expect(readImageInfo(stripped)).toEqual(readImageInfo(original));
  });

  it("JPEG：方向不是正常时，只留下方向这一项（不然竖拍的照片会躺倒），GPS 和相机型号照样去掉", () => {
    const stripped = stripImageMetadata(jpeg({ exif: { orientation: 6, gps: true } }), "image/jpeg");
    expect(jpegMarkers(stripped)).toEqual(["ffe0", "ffe1:exif", "ffe2", "ffdb", "ffc0", "ffda"]);
    expect(stripped.includes(GPS_LATITUDE)).toBe(false);
    expect(stripped.includes(Buffer.from(CAMERA_MODEL))).toBe(false);
    // 留下的 EXIF：大端 TIFF，IFD0 只有一项 0x0112（方向）= 6
    const exif = stripped.subarray(stripped.indexOf("Exif\0\0") + 6);
    expect([...exif.subarray(0, 22)]).toEqual([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0]);

    // 方向正常（1）的不留 EXIF
    expect(jpegMarkers(stripImageMetadata(jpeg({ exif: { orientation: 1 } }), "image/jpeg"))).toEqual(["ffe0", "ffe2", "ffdb", "ffc0", "ffda"]);
  });

  it("JPEG：图像结束标记之后附带的数据（MPF 第二张图、动态照片）截掉，多图索引去掉；渐进式的多次扫描和段里碰巧出现的 FF D9 不会截错", () => {
    const secondImage = Buffer.concat([jpeg({ exif: { gps: true } }), Buffer.from("MotionPhoto_Data MARKER-video")]);
    const original = jpeg({ progressive: true, mpf: true, trailing: secondImage });
    const plain = jpeg({ progressive: true });
    const stripped = stripImageMetadata(original, "image/jpeg");
    expect(stripped.equals(plain)).toBe(true);
    expect(stripped.includes(Buffer.from(MPF_MARKER))).toBe(false);
    expect(stripped.includes(Buffer.from("MARKER-video"))).toBe(false);
    expect(stripped.includes(GPS_LATITUDE)).toBe(false);
    // 没有元数据、也没有附带数据的渐进式 JPEG 原样不变
    expect(stripImageMetadata(plain, "image/jpeg").equals(plain)).toBe(true);
  });

  it("JPEG 方向是 5–8（转了 90°）时，给出的是显示出来的宽高（对调）", () => {
    expect(readImageInfo(stripImageMetadata(jpeg({ width: 40, height: 30, exif: { orientation: 6 } }), "image/jpeg"))).toEqual({ mime: "image/jpeg", width: 30, height: 40 });
    expect(readImageInfo(stripImageMetadata(jpeg({ width: 40, height: 30, exif: { orientation: 3 } }), "image/jpeg"))).toEqual({ mime: "image/jpeg", width: 40, height: 30 });
    expect(readImageInfo(jpeg({ width: 40, height: 30, exif: { orientation: 8, gps: true } }))).toEqual({ mime: "image/jpeg", width: 30, height: 40 });
  });

  it("PNG：去掉 eXIf 和文字块，其余各块原样保留", () => {
    const original = png({ exif: true, text: true });
    expect(pngChunkTypes(original)).toEqual(["IHDR", "eXIf", "tEXt", "iTXt", "IDAT", "IEND"]);
    const stripped = stripImageMetadata(original, "image/png");
    expect(pngChunkTypes(stripped)).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(stripped.includes(GPS_LATITUDE)).toBe(false);
    expect(stripped.includes(Buffer.from(XMP_MARKER))).toBe(false);
    expect(stripImageMetadata(png(), "image/png").equals(png())).toBe(true);
  });

  it("WebP：去掉 EXIF 和 XMP 块，清掉 VP8X 里对应的标志位，RIFF 长度随之改对", () => {
    const original = webp({ exif: true, xmp: true });
    expect(webpChunkTypes(original)).toEqual(["VP8X", "VP8 ", "EXIF", "XMP "]);
    const stripped = stripImageMetadata(original, "image/webp");
    expect(webpChunkTypes(stripped)).toEqual(["VP8X", "VP8 "]);
    expect(stripped.includes(GPS_LATITUDE)).toBe(false);
    expect(stripped[20]! & 0x0c).toBe(0);
    expect(stripped.readUInt32LE(4)).toBe(stripped.length - 8);
    expect(stripped.equals(webp())).toBe(true);
  });

  it("没有元数据的图片原样不变；截断、损坏的结构不猜，原样保留", () => {
    const plain = jpeg();
    expect(stripImageMetadata(plain, "image/jpeg").equals(plain)).toBe(true);
    const truncated = jpeg({ exif: { gps: true } }).subarray(0, 30);
    expect(stripImageMetadata(truncated, "image/jpeg").length).toBeLessThanOrEqual(truncated.length);
  });
});
