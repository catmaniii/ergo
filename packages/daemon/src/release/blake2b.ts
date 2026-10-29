// BLAKE2b（RFC 7693），输出长度可选（1–64 字节）：minisign 的私钥文件里那 32 字节校验和是 BLAKE2b-256，
// Node 自带的只有 blake2b512（输出长度是算法参数的一部分，截短 512 的不等于 256 的），所以这里自己写一份。
// 只用在小东西上（私钥校验和、测试）；大文件的预哈希（minisign 的 "ED" 签名）用 Node 自带的 blake2b512，两者对得上（测试比对）。
// 64 位的字用两个 32 位的数拼（高、低），不用 BigInt：快一个数量级。
// @i18n-ignore-file log：只有编程错误

const IV = new Uint32Array([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a, 0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c, 0xfb41bd6b, 0x1f83d9ab, 0x137e2179,
  0x5be0cd19,
]);

const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
] as const;

// v 里第 i 个 64 位字：v[2i] 是低 32 位，v[2i+1] 是高 32 位
function add64(v: Uint32Array, a: number, b: number): void {
  const lo = v[a]! + v[b]!;
  let hi = v[a + 1]! + v[b + 1]!;
  if (lo >= 0x100000000) hi++;
  v[a] = lo;
  v[a + 1] = hi;
}

function addWord(v: Uint32Array, a: number, lo: number, hi: number): void {
  const l = v[a]! + lo;
  let h = v[a + 1]! + hi;
  if (l >= 0x100000000) h++;
  v[a] = l;
  v[a + 1] = h;
}

/** v[a] = (v[a] ^ v[b]) 循环右移 n 位 */
function xorRot(v: Uint32Array, a: number, b: number, n: number): void {
  const lo = v[a]! ^ v[b]!;
  const hi = v[a + 1]! ^ v[b + 1]!;
  if (n === 32) {
    v[a] = hi;
    v[a + 1] = lo;
  } else if (n < 32) {
    v[a] = (lo >>> n) | (hi << (32 - n));
    v[a + 1] = (hi >>> n) | (lo << (32 - n));
  } else {
    const m = n - 32;
    v[a] = (hi >>> m) | (lo << (32 - m));
    v[a + 1] = (lo >>> m) | (hi << (32 - m));
  }
}

function mix(v: Uint32Array, m: Uint32Array, a: number, b: number, c: number, d: number, x: number, y: number): void {
  add64(v, a, b);
  addWord(v, a, m[x]!, m[x + 1]!);
  xorRot(v, d, a, 32);
  add64(v, c, d);
  xorRot(v, b, c, 24);
  add64(v, a, b);
  addWord(v, a, m[y]!, m[y + 1]!);
  xorRot(v, d, a, 16);
  add64(v, c, d);
  xorRot(v, b, c, 63);
}

function compress(h: Uint32Array, block: Uint8Array, counter: number, last: boolean): void {
  const v = new Uint32Array(32);
  v.set(h, 0);
  v.set(IV, 16);
  // 计数器（只用低 53 位够了）
  v[24] = v[24]! ^ (counter >>> 0);
  v[25] = v[25]! ^ Math.floor(counter / 0x100000000);
  if (last) {
    v[28] = ~v[28]!;
    v[29] = ~v[29]!;
  }
  const m = new Uint32Array(32);
  for (let i = 0; i < 32; i++) m[i] = block[i * 4]! | (block[i * 4 + 1]! << 8) | (block[i * 4 + 2]! << 16) | (block[i * 4 + 3]! << 24);
  for (const s of SIGMA) {
    mix(v, m, 0, 8, 16, 24, s[0] * 2, s[1] * 2);
    mix(v, m, 2, 10, 18, 26, s[2] * 2, s[3] * 2);
    mix(v, m, 4, 12, 20, 28, s[4] * 2, s[5] * 2);
    mix(v, m, 6, 14, 22, 30, s[6] * 2, s[7] * 2);
    mix(v, m, 0, 10, 20, 30, s[8] * 2, s[9] * 2);
    mix(v, m, 2, 12, 22, 24, s[10] * 2, s[11] * 2);
    mix(v, m, 4, 14, 16, 26, s[12] * 2, s[13] * 2);
    mix(v, m, 6, 8, 18, 28, s[14] * 2, s[15] * 2);
  }
  for (let i = 0; i < 16; i++) h[i] = h[i]! ^ v[i]! ^ v[i + 16]!;
}

/** BLAKE2b（不带钥匙），outLength 字节（1–64） */
export function blake2b(data: Uint8Array, outLength = 64): Buffer {
  if (!Number.isInteger(outLength) || outLength < 1 || outLength > 64) throw new RangeError(`BLAKE2b 的输出长度要在 1–64：${outLength}`);
  const h = new Uint32Array(IV);
  h[0] = h[0]! ^ (0x01010000 ^ outLength);
  const blocks = Math.max(1, Math.ceil(data.length / 128));
  const block = new Uint8Array(128);
  for (let i = 0; i < blocks; i++) {
    const start = i * 128;
    const last = i === blocks - 1;
    block.fill(0);
    block.set(data.subarray(start, Math.min(start + 128, data.length)));
    compress(h, block, last ? data.length : start + 128, last);
  }
  const out = Buffer.alloc(64);
  for (let i = 0; i < 16; i++) out.writeUInt32LE(h[i]!, i * 4);
  return out.subarray(0, outLength);
}
