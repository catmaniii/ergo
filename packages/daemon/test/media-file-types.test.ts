// 报告页取文本怎么解（media/file-types.ts 的 decodePreviewText）：先 UTF-8，不合法再 GB18030（GBK 的超集）；
// 从文件开头截下来的字节按各自的编码截在字符边上，不出半个字；都不合法、含 NUL 的解不出来。
import { describe, expect, it } from "vitest";
import { decodePreviewText } from "../src/media/file-types.ts";

/** "账单" 的 GBK 编码；"€" 在 GB18030 里是双字节 A2E3，"😀" 是四字节 9439FC36 */
const ZHANG_DAN = [0xd5, 0xcb, 0xb5, 0xa5];
const EMOJI = [0x94, 0x39, 0xfc, 0x36];
const bytes = (...parts: Array<string | number[]>) => Uint8Array.from(parts.flatMap((p) => (typeof p === "string" ? [...Buffer.from(p, "utf8")] : p)));

describe("报告页取文本", () => {
  it("UTF-8 的照原样，写明是 UTF-8", () => {
    expect(decodePreviewText(bytes("# 日报\n"))).toEqual({ text: "# 日报\n", encoding: "utf-8" });
  });

  it("不是合法 UTF-8 的按 GB18030 解（GBK 的字、四字节的字都认）", () => {
    expect(decodePreviewText(bytes("a,", ZHANG_DAN))).toEqual({ text: "a,账单", encoding: "gb18030" });
    expect(decodePreviewText(bytes(ZHANG_DAN, EMOJI))).toEqual({ text: "账单😀", encoding: "gb18030" });
  });

  it("截下来的：UTF-8 截在字符边上", () => {
    const whole = bytes("ab账");
    expect(decodePreviewText(whole.subarray(0, 4), { cut: true })).toEqual({ text: "ab", encoding: "utf-8" });
  });

  it("截下来的：GB18030 从头数字符，截在双字节、四字节字符的边上（第二个字节落在首字节范围里也不认错）", () => {
    const gbk = bytes("a", ZHANG_DAN, EMOJI);
    // 截在"单"的中间
    expect(decodePreviewText(gbk.subarray(0, 4), { cut: true })).toEqual({ text: "a账", encoding: "gb18030" });
    // 截在四字节字符的中间（留了 1、2、3 个字节）
    for (const keep of [1, 2, 3]) expect(decodePreviewText(gbk.subarray(0, 5 + keep), { cut: true })).toEqual({ text: "a账单", encoding: "gb18030" });
    expect(decodePreviewText(gbk, { cut: true })).toEqual({ text: "a账单😀", encoding: "gb18030" });
  });

  it("两种都不合法、含 NUL 的解不出来", () => {
    expect(decodePreviewText(bytes([0x23, 0x80, 0xff, 0x80]))).toBeUndefined();
    expect(decodePreviewText(bytes("abc", [0], "def"))).toBeUndefined();
    expect(decodePreviewText(bytes(ZHANG_DAN, [0xff, 0x00]))).toBeUndefined();
  });
});
