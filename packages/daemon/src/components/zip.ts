// 读 zip 包（345 号票）：audio.cpp 的 Windows 发布包是 .zip。Node 自带 inflate、没有 zip，这里按格式自己读：先从文件末尾找目录
// （End of Central Directory，大于 4 GB 的是 ZIP64 那一种），目录里每一项写着名字、大小、方法、内容在哪；再按项解开。
// 只认存储（0）和 deflate（8）；只解普通文件和目录，符号链接这类跳过（和 tar.ts 一样：组件里用不着，也免得指到别处去）。
// 路径去掉前几段后必须是安全的相对路径（不带 ..、不是绝对路径）：有一项不安全，整个包不用，一个文件都不写。
// 边读边写，不把整个包读进内存；写出来的大小和目录里写的对不上也算坏（校验值在下载时按整个包核对过，这里防的是目录写错）。
// @i18n-ignore-file log：解不开的原因，和 tar.ts 的一样由上层包进"解不开（原因）"
// @i18n-ignore-file log：解不开的原因，和 tar.ts 的一样由上层包进"解不开（原因）"
import fs from "node:fs";
import path from "node:path";
import { PassThrough, type Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { safeRelPath } from "./manifest.ts";

export class ZipError extends Error {}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  /** 这一项的本地头在文件里的位置（内容在本地头后面） */
  headerOffset: number;
  directory: boolean;
  symlink: boolean;
}

const EOCD_SIGNATURE = 0x06054b50;
const EOCD64_LOCATOR_SIGNATURE = 0x07064b50;
const EOCD64_SIGNATURE = 0x06064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_SIZE = 22;
const MAX_COMMENT = 0xffff;
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;
/** 字段写满了（0xFFFFFFFF）的，真值在这一项的 ZIP64 扩展字段里 */
const ZIP64_EXTRA = 0x0001;
/** Unix 的文件类型在外部属性的高 16 位：符号链接是 0o120000 */
const UNIX_TYPE_MASK = 0o170000;
const UNIX_SYMLINK = 0o120000;
/** 目录最多信这么多项（防坏包把内存撑爆；audio.cpp 的包只有几百项） */
const MAX_ENTRIES = 200_000;

function readBig(buf: Buffer, offset: number): number {
  const value = buf.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError("这个包太大了，读不了");
  return Number(value);
}

async function readAt(handle: fs.promises.FileHandle, start: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buf, 0, length, start);
  if (bytesRead !== length) throw new ZipError("这个包不完整");
  return buf;
}

/** 目录在哪、多大、几项 */
async function locateDirectory(handle: fs.promises.FileHandle, fileSize: number): Promise<{ offset: number; size: number; count: number }> {
  const tailLength = Math.min(fileSize, EOCD_SIZE + MAX_COMMENT);
  if (tailLength < EOCD_SIZE) throw new ZipError("这不是 zip 包");
  const tailStart = fileSize - tailLength;
  const tail = await readAt(handle, tailStart, tailLength);
  let at = -1;
  for (let i = tail.length - EOCD_SIZE; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
      at = i;
      break;
    }
  }
  if (at === -1) throw new ZipError("这不是 zip 包");
  let count = tail.readUInt16LE(at + 10);
  let size = tail.readUInt32LE(at + 12);
  let offset = tail.readUInt32LE(at + 16);
  // ZIP64：普通的那条写满了，真值在它前面那条定位记录指的地方
  if (count === U16_MAX || size === U32_MAX || offset === U32_MAX) {
    if (at < 20 || tail.readUInt32LE(at - 20) !== EOCD64_LOCATOR_SIGNATURE) throw new ZipError("这个包的 ZIP64 目录找不到");
    const record = await readAt(handle, readBig(tail, at - 20 + 8), 56);
    if (record.readUInt32LE(0) !== EOCD64_SIGNATURE) throw new ZipError("这个包的 ZIP64 目录坏了");
    count = readBig(record, 32);
    size = readBig(record, 40);
    offset = readBig(record, 48);
  }
  if (count > MAX_ENTRIES) throw new ZipError(`这个包有 ${count} 项，太多了`);
  return { offset, size, count };
}

/** 读目录：一项项列出来 */
async function readEntries(handle: fs.promises.FileHandle, fileSize: number): Promise<ZipEntry[]> {
  const { offset, size, count } = await locateDirectory(handle, fileSize);
  if (offset + size > fileSize) throw new ZipError("这个包不完整");
  const dir = await readAt(handle, offset, size);
  const entries: ZipEntry[] = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > dir.length || dir.readUInt32LE(at) !== CENTRAL_SIGNATURE) throw new ZipError("这个包的目录坏了");
    const method = dir.readUInt16LE(at + 10);
    let compressedSize = dir.readUInt32LE(at + 20);
    let entrySize = dir.readUInt32LE(at + 24);
    const nameLength = dir.readUInt16LE(at + 28);
    const extraLength = dir.readUInt16LE(at + 30);
    const commentLength = dir.readUInt16LE(at + 32);
    const creatorSystem = dir.readUInt8(at + 5);
    const external = dir.readUInt32LE(at + 38);
    let headerOffset = dir.readUInt32LE(at + 42);
    const name = dir
      .subarray(at + 46, at + 46 + nameLength)
      .toString("utf8")
      // 老的 Compress-Archive 打出来的包用反斜杠（格式要求是 /）
      .replace(/\\/g, "/");
    // ZIP64 扩展字段：只放写满了的那几个，按原始大小、压缩后大小、本地头位置的先后
    const extra = dir.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength);
    for (let p = 0; p + 4 <= extra.length; ) {
      const id = extra.readUInt16LE(p);
      const length = extra.readUInt16LE(p + 2);
      if (id === ZIP64_EXTRA) {
        let q = p + 4;
        if (entrySize === U32_MAX) {
          entrySize = readBig(extra, q);
          q += 8;
        }
        if (compressedSize === U32_MAX) {
          compressedSize = readBig(extra, q);
          q += 8;
        }
        if (headerOffset === U32_MAX) headerOffset = readBig(extra, q);
      }
      p += 4 + length;
    }
    const symlink = creatorSystem === 3 && ((external >>> 16) & UNIX_TYPE_MASK) === UNIX_SYMLINK;
    entries.push({ name, method, compressedSize, size: entrySize, headerOffset, directory: name.endsWith("/"), symlink });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** 去掉前几段；去完没有了回 undefined（那几层目录自己）；不安全的抛错 */
function destinationOf(name: string, strip: number): string | undefined {
  const trimmed = name.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
  if (trimmed === "") return undefined;
  const parts = trimmed.split("/");
  // 先按完整路径查：去掉前几段不能把 a/../../b 洗成安全的
  if (!safeRelPath(trimmed)) throw new ZipError(`包里有不安全的路径：${name}`);
  const rest = parts.slice(strip);
  if (rest.length === 0) return undefined;
  return rest.join("/");
}

/** 在解开的目录里按文件名找（发布包解开后东西在哪一层由包决定，不写死）：先看这一层，再往下；没有是 undefined */
export function findInTree(dir: string, name: string, depth = 4): string | undefined {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const here = entries.find((e) => e.isFile() && e.name.toLowerCase() === name.toLowerCase());
  if (here) return path.join(dir, here.name);
  if (depth <= 0) return undefined;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findInTree(path.join(dir, entry.name), name, depth - 1);
    if (found) return found;
  }
  return undefined;
}

/**
 * 把 zip 包解到 dest（目录不在就建）。一项路径不安全、内容坏了都抛错；中止抛 signal 的原因。
 * flatten：不分目录，文件都放在 dest 这一层（运行库的 DLL 要放在程序旁边，包里套了几层都一样）
 */
export async function extractZip(file: string, dest: string, options: { strip?: number; flatten?: boolean; signal?: AbortSignal } = {}): Promise<void> {
  const strip = options.strip ?? 0;
  const handle = await fs.promises.open(file, "r");
  try {
    const { size: fileSize } = await handle.stat();
    const entries = await readEntries(handle, fileSize);
    // 先全部查一遍：有不安全的路径、不认识的方法，一个文件都不写
    const plan = entries.flatMap((entry) => {
      if (entry.symlink) return [];
      const stripped = destinationOf(entry.name, strip);
      if (stripped === undefined) return [];
      if (options.flatten && entry.directory) return [];
      const relative = options.flatten ? path.posix.basename(stripped) : stripped;
      if (!entry.directory && entry.method !== 0 && entry.method !== 8) throw new ZipError(`${entry.name} 的压缩方法（${entry.method}）不认识`);
      return [{ entry, relative }];
    });
    fs.mkdirSync(dest, { recursive: true });
    for (const { entry, relative } of plan) {
      options.signal?.throwIfAborted();
      const out = path.join(dest, ...relative.split("/"));
      if (entry.directory) {
        fs.mkdirSync(out, { recursive: true });
        continue;
      }
      fs.mkdirSync(path.dirname(out), { recursive: true });
      await writeEntry(handle, file, fileSize, entry, out, options.signal);
    }
  } finally {
    await handle.close();
  }
}

async function writeEntry(handle: fs.promises.FileHandle, file: string, fileSize: number, entry: ZipEntry, out: string, signal: AbortSignal | undefined): Promise<void> {
  if (entry.compressedSize === 0) {
    if (entry.size !== 0) throw new ZipError(`${entry.name} 的内容坏了`);
    fs.writeFileSync(out, "");
    return;
  }
  // 内容在本地头后面；本地头的名字、扩展字段的长度可以和目录里的不一样，要现读
  const local = await readAt(handle, entry.headerOffset, 30);
  if (local.readUInt32LE(0) !== LOCAL_SIGNATURE) throw new ZipError(`${entry.name} 的位置不对`);
  const start = entry.headerOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  if (start + entry.compressedSize > fileSize) throw new ZipError("这个包不完整");
  const decode: Transform = entry.method === 8 ? zlib.createInflateRaw() : new PassThrough();
  let written = 0;
  await pipeline(
    fs.createReadStream(file, { start, end: start + entry.compressedSize - 1 }),
    decode,
    async function* count(source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        written += chunk.length;
        // 比目录里写的还多：不再往下写（防解开了比说的大得多的包）
        if (written > entry.size) throw new ZipError(`${entry.name} 的内容坏了`);
        yield chunk;
      }
    },
    fs.createWriteStream(out),
    signal ? { signal } : {},
  );
  if (written !== entry.size) throw new ZipError(`${entry.name} 的内容坏了`);
}
