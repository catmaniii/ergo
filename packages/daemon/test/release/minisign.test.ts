// minisign 格式的签名（318 号票）：BLAKE2b 对上 Python hashlib 算的值和 Node 自带的 blake2b512；Ed25519 对上 RFC 8032 的例子；
// 签名、验签、改了内容 / 可信说明 / 换了钥匙都验不过；私钥文件（不加口令、加口令）读写一圈。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { blake2b } from "../../src/release/blake2b.ts";
import {
  formatPublicKey,
  formatSecretKey,
  generateKeyPair,
  keyIdHex,
  parsePublicKey,
  parseSecretKey,
  parseSignature,
  scryptParams,
  sign,
  verify,
  verifyFile,
} from "../../src/release/minisign.ts";

describe("BLAKE2b", () => {
  it("对上 Python hashlib 算的值（256、512 位）", () => {
    // python: hashlib.blake2b(b'', digest_size=32) 等
    expect(blake2b(Buffer.alloc(0), 32).toString("hex")).toBe("0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8");
    expect(blake2b(Buffer.from("abc"), 32).toString("hex")).toBe("bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319");
    expect(blake2b(Buffer.from("abc")).toString("hex")).toBe(
      "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923",
    );
    expect(blake2b(Buffer.from(Array.from({ length: 200 }, (_, i) => i)), 32).toString("hex")).toBe("63c3d97a9f8894d5e043a707b0fee7f7ec4c049a23bbf1079df20b4165f9e22d");
  });

  it("512 位的和 Node 自带的 blake2b512 一样（各种长度，跨块边界）", () => {
    for (const n of [0, 1, 127, 128, 129, 255, 256, 257, 1000, 4096]) {
      const data = crypto.randomBytes(n);
      expect(blake2b(data).toString("hex")).toBe(crypto.createHash("blake2b512").update(data).digest("hex"));
    }
  });
});

describe("minisign 签名", () => {
  it("Ed25519 对上 RFC 8032 的例子（经 minisign 的旧格式 Ed：签内容本身）", () => {
    // RFC 8032 7.1 TEST 1：种子、公钥、空内容的签名
    const seed = Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex");
    const key = Buffer.from("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "hex");
    const keyId = Buffer.from("0102030405060708", "hex");
    const text = sign(Buffer.alloc(0), { seed, key, keyId }, { prehashed: false, trustedComment: "t" });
    expect(parseSignature(text).signature.toString("hex")).toBe(
      "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
    );
    expect(verify(Buffer.alloc(0), text, { keyId, key })).toEqual({ ok: true, trustedComment: "t" });
  });

  it("默认签 BLAKE2b-512（ED），可信说明照 minisign 的写法；验得过", () => {
    const secret = generateKeyPair();
    const message = Buffer.from("ergo-0.3.0-win-x64.zip 的校验值清单\n");
    const text = sign(message, secret, { fileName: "SHA256SUMS", now: 1_800_000_000 });
    const lines = text.split("\n");
    expect(lines[0]).toBe(`untrusted comment: signature from minisign secret key ${keyIdHex(secret.keyId)}`);
    expect(Buffer.from(lines[1]!, "base64").toString("latin1", 0, 2)).toBe("ED");
    expect(lines[2]).toBe("trusted comment: timestamp:1800000000\tfile:SHA256SUMS\thashed");
    // 预哈希：签的是 BLAKE2b-512
    const parsed = parseSignature(text);
    const pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), secret.key]), format: "der", type: "spki" });
    expect(crypto.verify(null, crypto.createHash("blake2b512").update(message).digest(), pub, parsed.signature)).toBe(true);
    expect(verify(message, text, secret)).toEqual({ ok: true, trustedComment: "timestamp:1800000000\tfile:SHA256SUMS\thashed" });
    // CRLF 的签名文件也认
    expect(verify(message, text.replace(/\n/g, "\r\n"), secret).ok).toBe(true);
  });

  it("改了内容、改了可信说明、换了钥匙、签名坏了：都验不过，原因写清", () => {
    const secret = generateKeyPair();
    const message = Buffer.from("hello");
    const text = sign(message, secret, { trustedComment: "release 0.3.0" });
    expect(verify(Buffer.from("hellO"), text, secret)).toEqual({ ok: false, reason: "签名对不上内容" });
    expect(verify(message, text.replace("release 0.3.0", "release 9.9.9"), secret)).toEqual({ ok: false, reason: "可信的说明被改过" });
    const other = generateKeyPair();
    const result = verify(message, text, other);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("别的钥匙");
    // 钥匙编号一样、公钥不一样（有人照抄编号）
    expect(verify(message, text, { keyId: secret.keyId, key: other.key })).toEqual({ ok: false, reason: "签名对不上内容" });
    expect(verify(message, "not a signature", secret).ok).toBe(false);
  });

  it("公钥文件、只给 base64 那一行都认；格式不对抛错", () => {
    const secret = generateKeyPair();
    const file = formatPublicKey(secret);
    expect(file.split("\n")[0]).toBe(`untrusted comment: minisign public key ${keyIdHex(secret.keyId)}`);
    const parsed = parsePublicKey(file);
    expect(parsed.keyId.equals(secret.keyId) && parsed.key.equals(secret.key)).toBe(true);
    expect(parsePublicKey(file.split("\n")[1]!).key.equals(secret.key)).toBe(true);
    expect(() => parsePublicKey("untrusted comment: x\nAAAA\n")).toThrow(/格式不对/);
  });

  it("大文件按块验（verifyFile）和整个读进来验一样", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ergo-minisign-"));
    try {
      const file = path.join(dir, "big.bin");
      fs.writeFileSync(file, crypto.randomBytes(3 * 1024 * 1024 + 17));
      const secret = generateKeyPair();
      const text = sign(fs.readFileSync(file), secret);
      expect((await verifyFile(file, text, secret)).ok).toBe(true);
      fs.appendFileSync(file, "x");
      expect(await verifyFile(file, text, secret)).toEqual({ ok: false, reason: "签名对不上内容" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("minisign 私钥文件", () => {
  it("不加口令：读写一圈，签出来的用公钥验得过", () => {
    const secret = generateKeyPair();
    const text = formatSecretKey(secret);
    const raw = Buffer.from(text.split("\n")[1]!, "base64");
    expect(raw.length).toBe(158);
    expect(raw.toString("latin1", 0, 2)).toBe("Ed");
    expect(raw.readUInt16LE(2)).toBe(0);
    expect(raw.toString("latin1", 4, 6)).toBe("B2");
    const back = parseSecretKey(text);
    expect(back.seed.equals(secret.seed) && back.key.equals(secret.key) && back.keyId.equals(secret.keyId)).toBe(true);
    expect(verify(Buffer.from("x"), sign(Buffer.from("x"), back), secret).ok).toBe(true);
  });

  it("加口令（scrypt）：口令对才读得出，不对说口令不对", () => {
    const secret = generateKeyPair();
    // 测试用小参数（minisign 默认约 1 GB 内存）
    const kdf = { opslimit: 1048576, memlimit: 16777216 };
    const text = formatSecretKey(secret, "口令 password", kdf);
    expect(Buffer.from(text.split("\n")[1]!, "base64").toString("latin1", 2, 4)).toBe("Sc");
    expect(parseSecretKey(text, "口令 password").seed.equals(secret.seed)).toBe(true);
    expect(() => parseSecretKey(text, "wrong")).toThrow(/口令不对/);
    expect(() => parseSecretKey(text)).toThrow(/要给口令/);
  });

  it("scrypt 参数和 libsodium 的 pickparams 一样（minisign 默认的那组是 N=2^20, r=8, p=1）", () => {
    expect(scryptParams(33554432, 1073741824)).toEqual({ N: 2 ** 20, r: 8, p: 1 });
    expect(scryptParams(1048576, 16777216)).toEqual({ N: 2 ** 14, r: 8, p: 2 });
    // opslimit 比 memlimit/32 小：p=1，N 按 opslimit 定
    expect(scryptParams(524288, 1073741824)).toEqual({ N: 2 ** 14, r: 8, p: 1 });
  });

  it("文件坏了（校验和对不上）抛错", () => {
    const text = formatSecretKey(generateKeyPair());
    const raw = Buffer.from(text.split("\n")[1]!, "base64");
    raw[100] = raw[100]! ^ 1;
    expect(() => parseSecretKey(`untrusted comment: x\n${raw.toString("base64")}\n`)).toThrow(/坏了/);
  });
});
