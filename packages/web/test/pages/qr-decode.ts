// 测试用的小 QR 解码器：按 ISO/IEC 18004 把方阵解回文字，只认这边生成的那种（纠错 M 档、版本 1–10、Byte 模式、不做纠错）。
// 不用生成库自己的代码：拿库算出来的东西再问库，证明不了别的相机扫得出。真的 ZXing 解一遍在 frontend/android 的 JVM 单测和联调里。

/** M 档每个版本的分块：每块纠错字节数，第一组几块、每块几个数据字节，第二组几块、每块几个数据字节 */
const M_BLOCKS: Record<number, readonly [number, number, number, number, number]> = {
  1: [10, 1, 16, 0, 0],
  2: [16, 1, 28, 0, 0],
  3: [26, 1, 44, 0, 0],
  4: [18, 2, 32, 0, 0],
  5: [24, 2, 43, 0, 0],
  6: [16, 4, 27, 0, 0],
  7: [18, 4, 31, 0, 0],
  8: [22, 2, 38, 2, 39],
  9: [22, 3, 36, 2, 37],
  10: [26, 4, 43, 1, 44],
};
const ALIGNMENT: Record<number, readonly number[]> = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };

const MASKS: ReadonlyArray<(r: number, c: number) => boolean> = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

export function decodeQrMatrix(matrix: readonly (readonly boolean[])[]): string {
  const size = matrix.length;
  const version = (size - 17) / 4;
  const blocks = M_BLOCKS[version];
  if (!blocks) throw new Error(`解不了版本 ${version}`);

  // 格式信息（左上角那一份，15 位，和 0x5412 异或）：前 2 位纠错档，接着 3 位掩码
  const formatCells: ReadonlyArray<[number, number]> = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  let format = 0;
  for (const [r, c] of formatCells) format = (format << 1) | (matrix[r]![c] ? 1 : 0);
  format ^= 0x5412;
  if (format >> 13 !== 0) throw new Error(`不是 M 档：${(format >> 13).toString(2)}`);
  const mask = MASKS[(format >> 10) & 7]!;

  // 功能区不放数据：定位、分隔、时序、校正、格式、版本
  const reserved = Array.from({ length: size }, () => Array.from({ length: size }, () => false));
  const mark = (r0: number, c0: number, h: number, w: number) => {
    for (let r = r0; r < r0 + h; r++) for (let c = c0; c < c0 + w; c++) if (r >= 0 && c >= 0 && r < size && c < size) reserved[r]![c] = true;
  };
  mark(0, 0, 9, 9);
  mark(0, size - 8, 9, 8);
  mark(size - 8, 0, 8, 9);
  mark(6, 0, 1, size);
  mark(0, 6, size, 1);
  const centers = ALIGNMENT[version]!;
  for (const r of centers) {
    for (const c of centers) {
      const onFinder = (r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6);
      if (!onFinder) mark(r - 2, c - 2, 5, 5);
    }
  }
  if (version >= 7) {
    mark(0, size - 11, 6, 3);
    mark(size - 11, 0, 3, 6);
  }

  // 从右下角按之字形读数据位（跳过第 6 列的时序），去掉掩码
  const bits: number[] = [];
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right = 5;
    for (let i = 0; i < size; i++) {
      const r = upward ? size - 1 - i : i;
      for (const c of [right, right - 1]) {
        if (reserved[r]![c]) continue;
        bits.push(matrix[r]![c] !== mask(r, c) ? 1 : 0);
      }
    }
    upward = !upward;
  }
  const codewords: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) codewords.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));

  // 解交织：只要数据字节
  const [, n1, d1, n2, d2] = blocks;
  const lengths = [...Array.from({ length: n1 }, () => d1), ...Array.from({ length: n2 }, () => d2)];
  const parts = lengths.map(() => [] as number[]);
  let at = 0;
  for (let i = 0; i < Math.max(d1, d2); i++) {
    parts.forEach((part, b) => {
      if (i < lengths[b]!) part.push(codewords[at++]!);
    });
  }
  const data = parts.flat();

  // Byte 模式：4 位模式、长度（版本 10 以下 8 位，10 起 16 位）、内容
  const stream = data.flatMap((byte) => Array.from({ length: 8 }, (_v, i) => (byte >> (7 - i)) & 1));
  const read = (from: number, count: number) => stream.slice(from, from + count).reduce((acc, bit) => (acc << 1) | bit, 0);
  if (read(0, 4) !== 0b0100) throw new Error(`不是 Byte 模式：${read(0, 4).toString(2)}`);
  const countBits = version < 10 ? 8 : 16;
  const length = read(4, countBits);
  const bytes = Array.from({ length }, (_v, i) => read(4 + countBits + i * 8, 8));
  return new TextDecoder().decode(new Uint8Array(bytes));
}
