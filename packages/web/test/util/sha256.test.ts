// 浏览器里分段算 sha256（上传收尾要带原始字节的 sha256；WebCrypto 只能一次喂完整个文件）。
// 和 Node 的 crypto 对照：独立的真值来源。
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, test } from "vitest";
import { Sha256 } from "../../src/util/sha256.ts";

describe("分段 sha256", () => {
  test("标准测试向量：空串和 abc", () => {
    expect(new Sha256().digestHex()).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    const abc = new Sha256();
    abc.update(new TextEncoder().encode("abc"));
    expect(abc.digestHex()).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test("任意长度、任意切法喂进去，结果都和一次算的一样", () => {
    for (const size of [1, 55, 56, 63, 64, 65, 127, 128, 1000, 70_000, 1_048_577]) {
      const bytes = randomBytes(size);
      const hash = new Sha256();
      for (let i = 0; i < size; ) {
        const step = Math.min(size - i, 1 + Math.floor(Math.random() * 9000));
        hash.update(bytes.subarray(i, i + step));
        i += step;
      }
      expect(hash.digestHex(), `长度 ${size}`).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
  });
});
