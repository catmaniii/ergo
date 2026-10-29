// minisign 格式的签名（318 号票）：发版时用发布钥匙给校验值清单（SHA256SUMS）和组件清单签名，安装脚本、ergo update、守护进程读组件清单时验。
// 不加依赖：Ed25519 用 Node 自带的 crypto；"ED"（预哈希）签名的 BLAKE2b-512 也是 Node 自带的；私钥文件的校验和（BLAKE2b-256）用 blake2b.ts，
// 加了口令的私钥用 Node 自带的 scrypt 解（和 libsodium 的 crypto_pwhash_scryptsalsa208sha256 一样的参数换算）。
// 安装脚本（installer/install.ps1）在 PowerShell 里另有一份只验不签的实现（C#），两份按同一个格式写、测试互相验。
//
// 格式（https://jedisct1.github.io/minisign/ 的"Signature format""Public key format"）：
//   公钥文件   untrusted comment: <说明>
//              base64( "Ed" ‖ key_id[8] ‖ 公钥[32] )
//   签名文件   untrusted comment: <说明>
//              base64( "ED" 或 "Ed" ‖ key_id[8] ‖ 签名[64] )        "ED"：签的是 BLAKE2b-512(内容)；"Ed"：签的是内容本身（旧的）
//              trusted comment: <可信的说明>
//              base64( 全局签名[64] )                              签的是 签名[64] ‖ 可信的说明
//   私钥文件   untrusted comment: <说明>
//              base64( "Ed" ‖ kdf("Sc" 或 \0\0) ‖ "B2" ‖ 盐[32] ‖ opslimit[8] ‖ memlimit[8] ‖ (key_id[8] ‖ 私钥[64] ‖ 校验和[32]) )
//              私钥[64] = 种子[32] ‖ 公钥[32]；校验和 = BLAKE2b-256("Ed" ‖ key_id ‖ 私钥)；kdf 是 "Sc" 时括号里那段和 scrypt 出的字节异或过。
// @i18n-ignore-file log：签名格式、验不过的原因是给开发者看的（命令行另有给人看的一句，原因附在后面）
import crypto from "node:crypto";
import fs from "node:fs";
import { blake2b } from "./blake2b.ts";

const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

export interface MinisignPublicKey {
  /** 8 字节的钥匙编号（签名里带着，对不上就是别的钥匙签的） */
  keyId: Buffer;
  /** Ed25519 公钥（32 字节） */
  key: Buffer;
}

export interface MinisignSecretKey extends MinisignPublicKey {
  /** Ed25519 的种子（32 字节） */
  seed: Buffer;
}

export class MinisignError extends Error {}

/** 钥匙编号给人看的写法（和 minisign 一样：按小端的 64 位数写成 16 位大写十六进制） */
export function keyIdHex(keyId: Buffer): string {
  return Buffer.from(keyId).reverse().toString("hex").toUpperCase();
}

/** 文件内容拆成行（认 CRLF，去掉末尾的空行） */
function lines(text: string): string[] {
  const out = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  while (out.length > 0 && out[out.length - 1]!.trim() === "") out.pop();
  return out;
}

function base64Line(line: string | undefined, what: string): Buffer {
  const trimmed = (line ?? "").trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) throw new MinisignError(`${what}不是 base64`);
  return Buffer.from(trimmed, "base64");
}

/** 读公钥：整个公钥文件（两行）或者只有 base64 那一行 */
export function parsePublicKey(text: string): MinisignPublicKey {
  const all = lines(text);
  const line = all.length >= 2 && all[0]!.startsWith("untrusted comment:") ? all[1] : all[0];
  const raw = base64Line(line, "公钥");
  if (raw.length !== 42 || raw.toString("latin1", 0, 2) !== "Ed") throw new MinisignError("公钥的格式不对（要 Ed25519 的 minisign 公钥）");
  return { keyId: Buffer.from(raw.subarray(2, 10)), key: Buffer.from(raw.subarray(10, 42)) };
}

/** 公钥的 base64 那一行 */
export function publicKeyLine(key: MinisignPublicKey): string {
  return Buffer.concat([Buffer.from("Ed", "latin1"), key.keyId, key.key]).toString("base64");
}

/** 公钥文件的内容 */
export function formatPublicKey(key: MinisignPublicKey): string {
  return `untrusted comment: minisign public key ${keyIdHex(key.keyId)}\n${publicKeyLine(key)}\n`;
}

function privateKeyObject(seed: Buffer): crypto.KeyObject {
  return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" });
}

function publicKeyObject(key: Buffer): crypto.KeyObject {
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519, key]), format: "der", type: "spki" });
}

/** 新的一对钥匙 */
export function generateKeyPair(): MinisignSecretKey {
  const seed = crypto.randomBytes(32);
  const key = crypto.createPublicKey(privateKeyObject(seed)).export({ format: "der", type: "spki" }).subarray(-32);
  return { keyId: crypto.randomBytes(8), seed, key: Buffer.from(key) };
}

/** 种子对应的公钥（读私钥文件时核对） */
function publicFromSeed(seed: Buffer): Buffer {
  return Buffer.from(crypto.createPublicKey(privateKeyObject(seed)).export({ format: "der", type: "spki" }).subarray(-32));
}

/** scrypt 的参数：和 libsodium 的 pickparams 一样从 opslimit、memlimit 换算 */
export function scryptParams(opslimit: number, memlimit: number): { N: number; r: number; p: number } {
  const ops = Math.max(opslimit, 32768);
  const r = 8;
  let nLog2 = 1;
  let p: number;
  if (ops < memlimit / 32) {
    p = 1;
    const maxN = ops / (r * 4);
    for (nLog2 = 1; nLog2 < 63; nLog2++) if (2 ** nLog2 > maxN / 2) break;
  } else {
    const maxN = memlimit / (r * 128);
    for (nLog2 = 1; nLog2 < 63; nLog2++) if (2 ** nLog2 > maxN / 2) break;
    const maxrp = Math.min(Math.floor(ops / 4 / 2 ** nLog2), 0x3fffffff);
    p = Math.floor(maxrp / r);
  }
  return { N: 2 ** nLog2, r, p };
}

function scryptStream(password: string, salt: Buffer, opslimit: number, memlimit: number, length: number): Buffer {
  const { N, r, p } = scryptParams(opslimit, memlimit);
  return crypto.scryptSync(Buffer.from(password, "utf8"), salt, length, { N, r, p, maxmem: 256 * N * r * Math.max(p, 1) + 64 * 1024 * 1024 });
}

/** minisign 自己生成钥匙时的默认（libsodium 的 *_SENSITIVE：约 1 GB 内存、几秒） */
export const DEFAULT_KDF = { opslimit: 33554432, memlimit: 1073741824 } as const;

/** 读私钥文件；加了口令的要给 password（不对抛错） */
export function parseSecretKey(text: string, password?: string): MinisignSecretKey {
  const all = lines(text);
  const line = all.length >= 2 && all[0]!.startsWith("untrusted comment:") ? all[1] : all[0];
  const raw = base64Line(line, "私钥");
  if (raw.length !== 158 || raw.toString("latin1", 0, 2) !== "Ed" || raw.toString("latin1", 4, 6) !== "B2") throw new MinisignError("私钥的格式不对（要 Ed25519 的 minisign 私钥）");
  const kdf = raw.subarray(2, 4);
  const salt = raw.subarray(6, 38);
  const opslimit = Number(raw.readBigUInt64LE(38));
  const memlimit = Number(raw.readBigUInt64LE(46));
  const sealed = Buffer.from(raw.subarray(54, 158));
  if (kdf.toString("latin1") === "Sc") {
    if (password === undefined) throw new MinisignError("这把私钥加了口令，要给口令");
    const stream = scryptStream(password, salt, opslimit, memlimit, sealed.length);
    for (let i = 0; i < sealed.length; i++) sealed[i] = sealed[i]! ^ stream[i]!;
  } else if (kdf.readUInt16LE(0) !== 0) {
    throw new MinisignError("私钥的口令算法认不出");
  }
  const keyId = sealed.subarray(0, 8);
  const secret = sealed.subarray(8, 72);
  const checksum = sealed.subarray(72, 104);
  const expected = blake2b(Buffer.concat([Buffer.from("Ed", "latin1"), keyId, secret]), 32);
  if (!crypto.timingSafeEqual(checksum, expected)) throw new MinisignError(kdf.toString("latin1") === "Sc" ? "私钥的口令不对（或者文件坏了）" : "私钥文件坏了（校验和对不上）");
  const seed = Buffer.from(secret.subarray(0, 32));
  const key = Buffer.from(secret.subarray(32, 64));
  if (!publicFromSeed(seed).equals(key)) throw new MinisignError("私钥文件坏了（公钥和种子对不上）");
  return { keyId: Buffer.from(keyId), seed, key };
}

/** 私钥文件的内容；给 password 就按 scrypt 加口令（kdf 给参数，默认和 minisign 一样） */
export function formatSecretKey(secret: MinisignSecretKey, password?: string, kdf: { opslimit: number; memlimit: number } = DEFAULT_KDF): string {
  const sk = Buffer.concat([secret.seed, secret.key]);
  const checksum = blake2b(Buffer.concat([Buffer.from("Ed", "latin1"), secret.keyId, sk]), 32);
  const sealed = Buffer.concat([secret.keyId, sk, checksum]);
  const salt = password === undefined ? Buffer.alloc(32) : crypto.randomBytes(32);
  const ops = Buffer.alloc(8);
  const mem = Buffer.alloc(8);
  if (password !== undefined) {
    ops.writeBigUInt64LE(BigInt(kdf.opslimit));
    mem.writeBigUInt64LE(BigInt(kdf.memlimit));
    const stream = scryptStream(password, salt, kdf.opslimit, kdf.memlimit, sealed.length);
    for (let i = 0; i < sealed.length; i++) sealed[i] = sealed[i]! ^ stream[i]!;
  }
  const raw = Buffer.concat([Buffer.from("Ed", "latin1"), password === undefined ? Buffer.alloc(2) : Buffer.from("Sc", "latin1"), Buffer.from("B2", "latin1"), salt, ops, mem, sealed]);
  const note = password === undefined ? "minisign secret key (unencrypted)" : "minisign encrypted secret key";
  return `untrusted comment: ${note}\n${raw.toString("base64")}\n`;
}

/** 预哈希：BLAKE2b-512（Node 自带的，和 blake2b.ts 的 64 字节输出一样） */
function prehash(message: Buffer): Buffer {
  return crypto.createHash("blake2b512").update(message).digest();
}

export interface SignOptions {
  /** 可信的说明（签进去的）；不给是 minisign 的默认写法 timestamp:<秒>\tfile:<文件名>\thashed */
  trustedComment?: string;
  /** 文件名（只用在默认的可信说明里） */
  fileName?: string;
  untrustedComment?: string;
  /** false 是旧的 "Ed"（签内容本身）；默认 "ED"（签 BLAKE2b-512，minisign 0.8 起的默认） */
  prehashed?: boolean;
  /** 测试用：时间（秒） */
  now?: number;
}

/** 给一段内容签名：签名文件的内容 */
export function sign(message: Buffer, secret: MinisignSecretKey, options: SignOptions = {}): string {
  const prehashed = options.prehashed ?? true;
  const key = privateKeyObject(secret.seed);
  const signature = crypto.sign(null, prehashed ? prehash(message) : message, key);
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const trusted = options.trustedComment ?? `timestamp:${now}\tfile:${options.fileName ?? "-"}${prehashed ? "\thashed" : ""}`;
  if (/[\r\n]/.test(trusted)) throw new MinisignError("可信的说明不能换行");
  const global = crypto.sign(null, Buffer.concat([signature, Buffer.from(trusted, "utf8")]), key);
  const alg = Buffer.from(prehashed ? "ED" : "Ed", "latin1");
  return [
    `untrusted comment: ${options.untrustedComment ?? `signature from minisign secret key ${keyIdHex(secret.keyId)}`}`,
    Buffer.concat([alg, secret.keyId, signature]).toString("base64"),
    `trusted comment: ${trusted}`,
    global.toString("base64"),
    "",
  ].join("\n");
}

export interface ParsedSignature {
  prehashed: boolean;
  keyId: Buffer;
  signature: Buffer;
  trustedComment: string;
  globalSignature: Buffer;
}

/** 读签名文件 */
export function parseSignature(text: string): ParsedSignature {
  const all = lines(text);
  if (all.length < 4 || !all[0]!.startsWith("untrusted comment:") || !all[2]!.startsWith("trusted comment: ")) throw new MinisignError("签名文件的格式不对");
  const raw = base64Line(all[1], "签名");
  if (raw.length !== 74) throw new MinisignError("签名的长度不对");
  const alg = raw.toString("latin1", 0, 2);
  if (alg !== "ED" && alg !== "Ed") throw new MinisignError(`签名算法认不出：${alg}`);
  const globalSignature = base64Line(all[3], "全局签名");
  if (globalSignature.length !== 64) throw new MinisignError("全局签名的长度不对");
  return {
    prehashed: alg === "ED",
    keyId: Buffer.from(raw.subarray(2, 10)),
    signature: Buffer.from(raw.subarray(10, 74)),
    trustedComment: all[2]!.slice("trusted comment: ".length),
    globalSignature,
  };
}

export type VerifyResult = { ok: true; trustedComment: string } | { ok: false; reason: string };

/** 验签名：内容（或已经算好的 BLAKE2b-512）、签名文件的内容、公钥 */
function verifyWith(digestOrMessage: (prehashed: boolean) => Buffer, signatureText: string, publicKey: MinisignPublicKey): VerifyResult {
  let parsed: ParsedSignature;
  try {
    parsed = parseSignature(signatureText);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  if (!parsed.keyId.equals(publicKey.keyId)) return { ok: false, reason: `签名是别的钥匙签的（${keyIdHex(parsed.keyId)}，应为 ${keyIdHex(publicKey.keyId)}）` };
  const key = publicKeyObject(publicKey.key);
  if (!crypto.verify(null, digestOrMessage(parsed.prehashed), key, parsed.signature)) return { ok: false, reason: "签名对不上内容" };
  if (!crypto.verify(null, Buffer.concat([parsed.signature, Buffer.from(parsed.trustedComment, "utf8")]), key, parsed.globalSignature)) {
    return { ok: false, reason: "可信的说明被改过" };
  }
  return { ok: true, trustedComment: parsed.trustedComment };
}

export function verify(message: Buffer, signatureText: string, publicKey: MinisignPublicKey): VerifyResult {
  return verifyWith((prehashed) => (prehashed ? prehash(message) : message), signatureText, publicKey);
}

/** 验一个文件（大文件按块算 BLAKE2b-512，不整个读进内存；旧的 "Ed" 签名只能整个读） */
export async function verifyFile(file: string, signatureText: string, publicKey: MinisignPublicKey): Promise<VerifyResult> {
  const hash = crypto.createHash("blake2b512");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  const digest = hash.digest();
  return verifyWith((prehashed) => (prehashed ? digest : fs.readFileSync(file)), signatureText, publicKey);
}
