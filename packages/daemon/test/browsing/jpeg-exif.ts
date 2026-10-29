// 134 号票的测试用：手工拼一个带拍摄时间的 JPEG（SOI、APP1 的 EXIF：IFD0 里一个指向 Exif 子目录的指针、子目录里 DateTimeOriginal，
// 再加 IFD0 的 DateTime 作对照，最后 EOI）。只保证结构，不是能解码的图片。
/** EXIF 的 ASCII 值：字节加结尾的 0 */
const ascii = (text: string) => Buffer.concat([Buffer.from(text, "latin1"), Buffer.from([0])]);

export function jpegWithCaptureTime(original: string | undefined, options: { dateTime?: string; bigEndian?: boolean } = {}): Buffer {
  const le = options.bigEndian !== true;
  const u16 = (v: number) => {
    const b = Buffer.alloc(2);
    if (le) b.writeUInt16LE(v);
    else b.writeUInt16BE(v);
    return b;
  };
  const u32 = (v: number) => {
    const b = Buffer.alloc(4);
    if (le) b.writeUInt32LE(v);
    else b.writeUInt32BE(v);
    return b;
  };
  const dateTime = ascii(options.dateTime ?? "2001:01:01 00:00:00");
  const originalText = original === undefined ? undefined : ascii(original);
  // 布局：头 8 字节；IFD0（2 个条目）在 8；子目录（1 个条目）跟在后面；两段字符串放最后
  const ifd0 = 8;
  const ifd0Size = 2 + 2 * 12 + 4;
  const sub = ifd0 + ifd0Size;
  const subSize = 2 + 12 + 4;
  const dateTimeAt = sub + subSize;
  const originalAt = dateTimeAt + dateTime.length;
  const entry = (tag: number, type: number, count: number, value: Buffer) => Buffer.concat([u16(tag), u16(type), u32(count), value]);
  const tiff = Buffer.concat([
    Buffer.from(le ? "II" : "MM", "latin1"),
    u16(42),
    u32(ifd0),
    u16(2),
    entry(0x0132, 2, dateTime.length, u32(dateTimeAt)),
    entry(0x8769, 4, 1, u32(sub)),
    u32(0),
    u16(originalText ? 1 : 0),
    originalText ? entry(0x9003, 2, originalText.length, u32(originalAt)) : Buffer.alloc(12),
    u32(0),
    dateTime,
    originalText ?? Buffer.alloc(0),
  ]);
  const app1 = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(app1.length + 2, 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), head, app1, Buffer.from([0xff, 0xd9])]);
}
