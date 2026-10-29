// 读 tar 包（323 号票）：组件里的压缩包（npm 的 .tgz）要解开，离线导入也认 .tar / .tgz 的包。Node 自带 gzip（zlib）、没有 tar，
// 这里按 ustar 的格式自己读：512 字节一个头（名字、大小、类型、校验和），后面是内容、补齐到 512 的整数倍。认 pax 头（path=）和
// GNU 的长名字（L）；只解普通文件和目录，链接这类跳过（组件里用不着，也免得指到别处去）。路径去掉前几段（npm 包里的 package/）后
// 必须是安全的相对路径（不带 ..、不是绝对路径），不然整个包不用。边读边写，不把整个包读进内存。
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream";
import zlib from "node:zlib";
import { safeRelPath } from "./manifest.ts";

export interface TarEntry {
  /** 包里的路径（/ 分隔，去掉开头的 ./） */
  path: string;
  type: "file" | "dir" | "other";
  size: number;
  mode: number;
}

/** 一项内容往哪写；不要这一项回 undefined */
export interface TarSink {
  write(chunk: Buffer): Promise<void> | void;
  end(): Promise<void> | void;
}

export class TarError extends Error {}

function cString(buf: Buffer, start: number, length: number): string {
  const slice = buf.subarray(start, start + length);
  const zero = slice.indexOf(0);
  return slice.subarray(0, zero === -1 ? slice.length : zero).toString("utf8");
}

function octal(buf: Buffer, start: number, length: number): number {
  // 大文件的 base-256 写法：第一个字节最高位是 1
  if ((buf[start]! & 0x80) !== 0) {
    let value = 0;
    for (let i = start + 1; i < start + length; i++) value = value * 256 + buf[i]!;
    return value;
  }
  const text = cString(buf, start, length).trim();
  return text === "" ? 0 : Number.parseInt(text, 8);
}

function checksumOk(header: Buffer): boolean {
  const stored = octal(header, 148, 8);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i]!;
  return sum === stored;
}

/** pax 头的内容："长度 键=值\n" 一条一条 */
function paxPath(data: Buffer): string | undefined {
  let offset = 0;
  let found: string | undefined;
  while (offset < data.length) {
    const space = data.indexOf(32, offset);
    if (space === -1) break;
    const length = Number.parseInt(data.subarray(offset, space).toString("utf8"), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq > 0 && record.slice(0, eq) === "path") found = record.slice(eq + 1);
    offset += length;
  }
  return found;
}

/** 一项项读出来，交给 open 决定往哪写 */
export async function walkTar(file: string, options: { gzip: boolean; signal?: AbortSignal }, open: (entry: TarEntry) => Promise<TarSink | undefined> | TarSink | undefined): Promise<number> {
  const raw = fs.createReadStream(file, options.signal ? { signal: options.signal } : {});
  let input: AsyncIterable<Buffer> = raw;
  if (options.gzip) {
    // 读文件出的错（文件不在、被中止）也要交给解压那一头，不然 for await 会一直等
    const gunzip = zlib.createGunzip();
    pipeline(raw, gunzip, (err) => {
      if (err) gunzip.destroy(err);
    });
    input = gunzip;
  }
  let buf: Buffer = Buffer.alloc(0);
  let remaining = 0;
  let padding = 0;
  let sink: TarSink | undefined;
  let meta: Buffer[] | undefined;
  let metaKind: "pax" | "long" | undefined;
  let nextPath: string | undefined;
  let entries = 0;
  let sawHeader = false;
  const finish = async () => {
    if (meta) {
      // 元数据（pax 头、GNU 长名字）：记下给下一项用；全局的 pax 头（metaKind 是 undefined）不用
      if (metaKind) {
        const data = Buffer.concat(meta);
        nextPath = metaKind === "pax" ? (paxPath(data) ?? nextPath) : cString(data, 0, data.length);
      }
      meta = undefined;
      metaKind = undefined;
    } else if (sink) {
      await sink.end();
      sink = undefined;
    }
  };
  try {
    for await (const chunk of input) {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      for (;;) {
        if (remaining > 0) {
          if (buf.length === 0) break;
          const take = Math.min(remaining, buf.length);
          const piece = buf.subarray(0, take);
          if (meta) meta.push(Buffer.from(piece));
          else if (sink) await sink.write(piece);
          buf = buf.subarray(take);
          remaining -= take;
          if (remaining === 0) await finish();
          continue;
        }
        if (padding > 0) {
          const take = Math.min(padding, buf.length);
          buf = buf.subarray(take);
          padding -= take;
          if (padding > 0) break;
          continue;
        }
        if (buf.length < 512) break;
        const header = buf.subarray(0, 512);
        buf = buf.subarray(512);
        // 全是 0 的块：包的结尾
        if (header.every((b) => b === 0)) continue;
        if (!checksumOk(header)) throw new TarError("不是 tar 包，或者包坏了（头的校验和对不上）"); // @i18n-ignore log：由上层换成给人看的
        sawHeader = true;
        const size = octal(header, 124, 12);
        const typeflag = String.fromCharCode(header[156]!);
        remaining = size;
        padding = (512 - (size % 512)) % 512;
        if (typeflag === "x" || typeflag === "L") {
          meta = [];
          metaKind = typeflag === "x" ? "pax" : "long";
          if (size === 0) await finish();
          continue;
        }
        if (typeflag === "g") {
          // 全局的 pax 头：不用，内容跳过
          meta = [];
          metaKind = undefined;
          if (size === 0) await finish();
          continue;
        }
        const magic = cString(header, 257, 6);
        const prefix = magic.startsWith("ustar") ? cString(header, 345, 155) : "";
        const name = cString(header, 0, 100);
        const full = (nextPath ?? (prefix ? `${prefix}/${name}` : name)).replace(/^\.\//, "");
        nextPath = undefined;
        const type: TarEntry["type"] = typeflag === "0" || typeflag === "\0" || typeflag === "7" ? "file" : typeflag === "5" ? "dir" : "other";
        entries++;
        sink = (await open({ path: full.replace(/\/+$/, ""), type, size, mode: octal(header, 100, 8) })) ?? undefined;
        if (size === 0) await finish();
      }
    }
    if (remaining > 0) throw new TarError("tar 包不完整（最后一项少了内容）"); // @i18n-ignore log：由上层换成给人看的
    if (!sawHeader) throw new TarError("不是 tar 包（一项都没有）"); // @i18n-ignore log：由上层换成给人看的
    return entries;
  } finally {
    if (sink) {
      try {
        await sink.end();
      } catch {
        // 出错时收尾：开着的文件关上
      }
    }
    raw.destroy();
  }
}

/** 往一个文件里写的 TarSink（等着写完再收尾） */
export function fileSink(file: string, mode?: number): TarSink {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const out = fs.createWriteStream(file);
  return {
    async write(chunk) {
      if (!out.write(chunk)) await once(out, "drain");
    },
    async end() {
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
      if (mode !== undefined && process.platform !== "win32" && (mode & 0o111) !== 0) fs.chmodSync(file, 0o755);
    },
  };
}

/**
 * 把一个 tar 包（gzip 的也行）解到 dest：每一项去掉前 strip 段，剩下的必须是安全的相对路径；只解文件和目录。
 * 解出来几个文件就回几
 */
export async function extractTar(file: string, dest: string, options: { gzip: boolean; strip?: number; signal?: AbortSignal }): Promise<number> {
  const strip = options.strip ?? 0;
  let files = 0;
  await walkTar(file, options, (entry) => {
    const rel = entry.path.split("/").slice(strip).join("/");
    if (rel === "") return undefined;
    if (!safeRelPath(rel)) throw new TarError(`包里有不安全的路径：${entry.path}`); // @i18n-ignore log：由上层换成给人看的
    const target = path.join(dest, ...rel.split("/"));
    if (entry.type === "dir") {
      fs.mkdirSync(target, { recursive: true });
      return undefined;
    }
    if (entry.type !== "file") return undefined;
    files++;
    return fileSink(target, entry.mode);
  });
  return files;
}
