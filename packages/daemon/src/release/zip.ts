// zip 读写（318 号票）：发布包是一个 zip（构建脚本写，安装脚本用 .NET 自带的 ZipFile 解，ergo update 用这里的读）。
// 不加依赖：deflate、crc32 都是 Node 自带的 zlib。只写普通文件（目录跟着路径走），文件名 UTF-8（通用标志第 11 位），
// 条目多于 65535 个、或者偏移超过 4 GB 时用 zip64。读的时候只认"存储"和"deflate"两种，路径不安全的（绝对路径、..、盘符）整包不用。
// @i18n-ignore-file log：包坏了的原因给开发者看（命令行另有给人看的一句）
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
const ZIP64_END = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;
const UTF8_FLAG = 0x0800;
const MAX32 = 0xffffffff;
const MAX16 = 0xffff;

export class ZipError extends Error {}

/** 1980-01-01 之前的时间 zip 写不了；不给时间用固定的（同样的输入打出同样的包） */
const FIXED_TIME = new Date(2026, 0, 1, 0, 0, 0);

function dosDateTime(date: Date): { time: number; date: number } {
  const d = date.getFullYear() < 1980 ? FIXED_TIME : date;
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

interface WrittenEntry {
  name: Buffer;
  crc: number;
  compressedSize: number;
  size: number;
  method: number;
  offset: number;
  time: number;
  date: number;
}

/** 一条一条往文件里写的 zip */
export class ZipWriter {
  readonly #fd: number;
  #offset = 0;
  readonly #entries: WrittenEntry[] = [];
  readonly #names = new Set<string>();
  readonly #time: { time: number; date: number };
  #closed = false;

  constructor(file: string, options: { time?: Date } = {}) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.#fd = fs.openSync(file, "w");
    this.#time = dosDateTime(options.time ?? FIXED_TIME);
  }

  #write(buf: Buffer): void {
    let done = 0;
    while (done < buf.length) done += fs.writeSync(this.#fd, buf, done, buf.length - done, this.#offset + done);
    this.#offset += buf.length;
  }

  /** 加一个文件：name 是包里的路径（用 /），data 是内容 */
  add(name: string, data: Buffer): void {
    if (this.#closed) throw new ZipError("zip 已经写完了");
    const clean = name.replace(/\\/g, "/");
    if (!safeEntryName(clean)) throw new ZipError(`包里的路径不安全：${name}`);
    if (this.#names.has(clean.toLowerCase())) throw new ZipError(`包里有两个 ${clean}`);
    this.#names.add(clean.toLowerCase());
    const crc = zlib.crc32(data);
    const deflated = data.length > 0 ? zlib.deflateRawSync(data, { level: 9 }) : Buffer.alloc(0);
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const nameBuf = Buffer.from(clean, "utf8");
    const offset = this.#offset;
    const big = data.length >= MAX32 || body.length >= MAX32 || offset >= MAX32;
    const extra = big ? zip64Extra(data.length, body.length, undefined) : Buffer.alloc(0);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL_HEADER, 0);
    header.writeUInt16LE(big ? 45 : 20, 4);
    header.writeUInt16LE(UTF8_FLAG, 6);
    header.writeUInt16LE(useDeflate ? 8 : 0, 8);
    header.writeUInt16LE(this.#time.time, 10);
    header.writeUInt16LE(this.#time.date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(big ? MAX32 : body.length, 18);
    header.writeUInt32LE(big ? MAX32 : data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(extra.length, 28);
    this.#write(Buffer.concat([header, nameBuf, extra]));
    this.#write(body);
    this.#entries.push({ name: nameBuf, crc, compressedSize: body.length, size: data.length, method: useDeflate ? 8 : 0, offset, ...this.#time });
  }

  /** 加一个磁盘上的文件 */
  addFile(name: string, file: string): void {
    this.add(name, fs.readFileSync(file));
  }

  get count(): number {
    return this.#entries.length;
  }

  /** 写目录、结尾，关文件 */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const cdStart = this.#offset;
    for (const e of this.#entries) {
      const big = e.size >= MAX32 || e.compressedSize >= MAX32 || e.offset >= MAX32;
      const extra = big ? zip64Extra(e.size, e.compressedSize, e.offset) : Buffer.alloc(0);
      const h = Buffer.alloc(46);
      h.writeUInt32LE(CENTRAL_HEADER, 0);
      h.writeUInt16LE(big ? 45 : 20, 4);
      h.writeUInt16LE(big ? 45 : 20, 6);
      h.writeUInt16LE(UTF8_FLAG, 8);
      h.writeUInt16LE(e.method, 10);
      h.writeUInt16LE(e.time, 12);
      h.writeUInt16LE(e.date, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(big ? MAX32 : e.compressedSize, 20);
      h.writeUInt32LE(big ? MAX32 : e.size, 24);
      h.writeUInt16LE(e.name.length, 28);
      h.writeUInt16LE(extra.length, 30);
      h.writeUInt32LE(big ? MAX32 : e.offset, 42);
      this.#write(Buffer.concat([h, e.name, extra]));
    }
    const cdSize = this.#offset - cdStart;
    const count = this.#entries.length;
    const needs64 = count >= MAX16 || cdStart >= MAX32 || cdSize >= MAX32;
    if (needs64) {
      const z = Buffer.alloc(56);
      z.writeUInt32LE(ZIP64_END, 0);
      z.writeBigUInt64LE(44n, 4);
      z.writeUInt16LE(45, 12);
      z.writeUInt16LE(45, 14);
      z.writeBigUInt64LE(BigInt(count), 24);
      z.writeBigUInt64LE(BigInt(count), 32);
      z.writeBigUInt64LE(BigInt(cdSize), 40);
      z.writeBigUInt64LE(BigInt(cdStart), 48);
      const z64At = this.#offset;
      this.#write(z);
      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(ZIP64_LOCATOR, 0);
      loc.writeBigUInt64LE(BigInt(z64At), 8);
      loc.writeUInt32LE(1, 16);
      this.#write(loc);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(END_OF_CENTRAL, 0);
    end.writeUInt16LE(needs64 ? MAX16 : count, 8);
    end.writeUInt16LE(needs64 ? MAX16 : count, 10);
    end.writeUInt32LE(needs64 ? MAX32 : cdSize, 12);
    end.writeUInt32LE(needs64 ? MAX32 : cdStart, 16);
    this.#write(end);
    fs.closeSync(this.#fd);
  }
}

function zip64Extra(size: number, compressed: number, offset: number | undefined): Buffer {
  const b = Buffer.alloc(offset === undefined ? 20 : 28);
  b.writeUInt16LE(0x0001, 0);
  b.writeUInt16LE(b.length - 4, 2);
  b.writeBigUInt64LE(BigInt(size), 4);
  b.writeBigUInt64LE(BigInt(compressed), 12);
  if (offset !== undefined) b.writeBigUInt64LE(BigInt(offset), 20);
  return b;
}

/** 包里的路径安不安全：相对、不含 ..、不含盘符和冒号、不以 / 开头 */
export function safeEntryName(name: string): boolean {
  if (name.length === 0 || name.startsWith("/") || name.includes("\\") || name.includes(":") || name.includes("\0")) return false;
  return name.split("/").every((part, i, all) => part !== ".." && part !== "." && (part !== "" || i === all.length - 1));
}

export interface ZipEntry {
  name: string;
  size: number;
  compressedSize: number;
  method: number;
  crc: number;
  /** 本地头的位置 */
  offset: number;
  directory: boolean;
}

function readAt(fd: number, position: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = fs.readSync(fd, buf, done, length - done, position + done);
    if (n === 0) throw new ZipError("zip 比目录里写的短（文件不完整）");
    done += n;
  }
  return buf;
}

/** 读 zip 的目录 */
export function listZip(file: string): ZipEntry[] {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const tailLength = Math.min(size, 22 + 65535);
    const tail = readAt(fd, size - tailLength, tailLength);
    let endAt = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === END_OF_CENTRAL) {
        endAt = i;
        break;
      }
    }
    if (endAt < 0) throw new ZipError("不是 zip（找不到目录的结尾）");
    let count = tail.readUInt16LE(endAt + 10);
    let cdSize = tail.readUInt32LE(endAt + 12);
    let cdStart = tail.readUInt32LE(endAt + 16);
    if (count === MAX16 || cdSize === MAX32 || cdStart === MAX32) {
      const locAt = endAt - 20;
      if (locAt < 0 || tail.readUInt32LE(locAt) !== ZIP64_LOCATOR) throw new ZipError("zip64 的目录找不到");
      const z64At = Number(tail.readBigUInt64LE(locAt + 8));
      const z = readAt(fd, z64At, 56);
      if (z.readUInt32LE(0) !== ZIP64_END) throw new ZipError("zip64 的目录结尾不对");
      count = Number(z.readBigUInt64LE(32));
      cdSize = Number(z.readBigUInt64LE(40));
      cdStart = Number(z.readBigUInt64LE(48));
    }
    const cd = readAt(fd, cdStart, cdSize);
    const entries: ZipEntry[] = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== CENTRAL_HEADER) throw new ZipError("zip 的目录坏了");
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      let compressedSize = cd.readUInt32LE(p + 20);
      let entrySize = cd.readUInt32LE(p + 24);
      const nameLength = cd.readUInt16LE(p + 28);
      const extraLength = cd.readUInt16LE(p + 30);
      const commentLength = cd.readUInt16LE(p + 32);
      let offset = cd.readUInt32LE(p + 42);
      const nameBuf = cd.subarray(p + 46, p + 46 + nameLength);
      const name = (flags & UTF8_FLAG ? nameBuf.toString("utf8") : nameBuf.toString("latin1")).replace(/\\/g, "/");
      const extra = cd.subarray(p + 46 + nameLength, p + 46 + nameLength + extraLength);
      for (let e = 0; e + 4 <= extra.length; ) {
        const id = extra.readUInt16LE(e);
        const len = extra.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (entrySize === MAX32) {
            entrySize = Number(extra.readBigUInt64LE(q));
            q += 8;
          }
          if (compressedSize === MAX32) {
            compressedSize = Number(extra.readBigUInt64LE(q));
            q += 8;
          }
          if (offset === MAX32) offset = Number(extra.readBigUInt64LE(q));
        }
        e += 4 + len;
      }
      entries.push({ name, size: entrySize, compressedSize, method, crc, offset, directory: name.endsWith("/") });
      p += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

/** 解开整个 zip 到 dest（dest 要不存在或是空的）；路径不安全、算法不认、crc 对不上抛 ZipError。回解出的文件数 */
export async function extractZip(file: string, dest: string, options: { signal?: AbortSignal } = {}): Promise<number> {
  const entries = listZip(file);
  for (const e of entries) {
    if (!safeEntryName(e.name)) throw new ZipError(`包里的路径不安全：${e.name}`);
    if (!e.directory && e.method !== 0 && e.method !== 8) throw new ZipError(`包里的 ${e.name} 用的压缩算法认不出（${e.method}）`);
  }
  fs.mkdirSync(dest, { recursive: true });
  const fd = fs.openSync(file, "r");
  let files = 0;
  try {
    for (const e of entries) {
      options.signal?.throwIfAborted();
      const target = path.join(dest, ...e.name.split("/").filter(Boolean));
      if (e.directory) {
        fs.mkdirSync(target, { recursive: true });
        continue;
      }
      const local = readAt(fd, e.offset, 30);
      if (local.readUInt32LE(0) !== LOCAL_HEADER) throw new ZipError(`包里的 ${e.name} 的本地头不对`);
      const dataStart = e.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      let crc = 0;
      let written = 0;
      const out = fs.createWriteStream(target);
      if (e.compressedSize === 0) {
        out.end();
        await once(out, "close");
      } else {
        const source = fs.createReadStream(file, { start: dataStart, end: dataStart + e.compressedSize - 1, ...(options.signal ? { signal: options.signal } : {}) });
        const counter = async function* (input: AsyncIterable<Buffer>) {
          for await (const chunk of input) {
            crc = zlib.crc32(chunk, crc);
            written += chunk.length;
            yield chunk;
          }
        };
        if (e.method === 8) await pipeline(source, zlib.createInflateRaw(), counter, out);
        else await pipeline(source, counter, out);
      }
      if (written !== e.size || crc !== e.crc) throw new ZipError(`包里的 ${e.name} 坏了（大小或 crc 对不上）`);
      files++;
    }
  } finally {
    fs.closeSync(fd);
  }
  return files;
}
