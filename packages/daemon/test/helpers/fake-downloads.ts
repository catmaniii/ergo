// 组件下载的测试底座：本机起的假下载服务（几个"镜像"，各自可以好、坏、慢、卡住、给错内容、中途断、不认 Range），
// 一个假代理（CONNECT 隧道和完整地址两种），编一份小清单、打 tar 包。测试一律不连外网、不下真模型（560 MB 的向量模型只手动核）。
import { createHash } from "node:crypto";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";
import { onTestFinished } from "vitest";
import type { ComponentProbes } from "../../src/components/index.ts";
import type { Transport } from "../../src/components/transport.ts";

export const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

/** 一个镜像怎么回 */
export type MirrorBehavior =
  | { kind: "ok" }
  /** 回 500 */
  | { kind: "broken" }
  /** 每 tickMs 只给 bytesPerTick 个字节 */
  | { kind: "slow"; bytesPerTick: number; tickMs: number }
  /** 给 bytes 个字节以后就不动了（连接开着） */
  | { kind: "stall"; bytes: number }
  /** 内容改了几个字节（大小不变） */
  | { kind: "corrupt" }
  /** 给的大小不对 */
  | { kind: "wrongSize" }
  /** 前 times 次请求给 bytes 个字节以后断开连接，之后正常 */
  | { kind: "cut"; bytes: number; times: number }
  /** 不认 Range：总是从头给整个（200） */
  | { kind: "noRange" }
  /** 不给长度（分块传输，没有 Content-Length）：也不认 Range */
  | { kind: "noLength" };

export interface FakeRequest {
  mirror: string;
  path: string;
  range?: string;
  userAgent?: string;
}

export interface FakeDownloads {
  /** http://127.0.0.1:<端口> */
  url: string;
  /** 一个镜像的地址模板（清单里 sources 的 url）：<url>/<镜像>/{path} */
  source(mirror: string): string;
  /** 放一个文件（所有镜像都有） */
  put(path: string, body: Buffer | string): void;
  /** 改一个镜像的行为 */
  behave(mirror: string, behavior: MirrorBehavior): void;
  /** 收到的请求（按先后） */
  requests: FakeRequest[];
  /** 放行所有卡住的、慢的连接（关掉它们） */
  releaseAll(): void;
}

/** 起一个假下载服务；测试结束时关掉 */
export async function startFakeDownloads(): Promise<FakeDownloads> {
  const files = new Map<string, Buffer>();
  const behaviors = new Map<string, MirrorBehavior>();
  const cuts = new Map<string, number>();
  const requests: FakeRequest[] = [];
  const open = new Set<http.ServerResponse>();
  const timers = new Set<NodeJS.Timeout>();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const [, mirror = "", ...rest] = url.pathname.split("/");
    const filePath = rest.map(decodeURIComponent).join("/");
    requests.push({ mirror, path: filePath, ...(req.headers.range ? { range: req.headers.range } : {}), ...(req.headers["user-agent"] ? { userAgent: req.headers["user-agent"] } : {}) });
    const behavior = behaviors.get(mirror) ?? { kind: "ok" };
    let body = files.get(filePath);
    if (!body) {
      res.writeHead(404).end("not found");
      return;
    }
    if (behavior.kind === "broken") {
      res.writeHead(500).end("broken");
      return;
    }
    if (behavior.kind === "corrupt") {
      body = Buffer.from(body);
      body[body.length - 1] = (body[body.length - 1]! + 1) % 256;
    }
    if (behavior.kind === "wrongSize") body = Buffer.concat([body, Buffer.from("extra")]);
    const total = body.length;
    if (behavior.kind === "noLength") {
      res.writeHead(200, { "transfer-encoding": "chunked" });
      res.end(body);
      return;
    }
    const m = behavior.kind === "noRange" ? null : /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
    let start = 0;
    let end = total - 1;
    if (m) {
      start = Number(m[1]);
      if (m[2]) end = Math.min(Number(m[2]), total - 1);
      if (start >= total) {
        res.writeHead(416, { "content-range": `bytes */${total}` }).end();
        return;
      }
      res.writeHead(206, { "content-range": `bytes ${start}-${end}/${total}`, "content-length": String(end - start + 1), "accept-ranges": "bytes" });
    } else {
      res.writeHead(200, { "content-length": String(total), "accept-ranges": "bytes" });
    }
    const slice = body.subarray(start, end + 1);
    open.add(res);
    res.once("close", () => open.delete(res));
    if (behavior.kind === "stall") {
      res.write(slice.subarray(0, Math.max(0, behavior.bytes - start)));
      return;
    }
    if (behavior.kind === "cut") {
      const done = cuts.get(mirror) ?? 0;
      if (done < behavior.times) {
        cuts.set(mirror, done + 1);
        res.write(slice.subarray(0, behavior.bytes), () => {
          const timer = setTimeout(() => {
            timers.delete(timer);
            res.destroy();
          }, 20);
          timers.add(timer);
        });
        return;
      }
    }
    if (behavior.kind === "slow") {
      let offset = 0;
      const tick = () => {
        if (res.destroyed) return;
        const piece = slice.subarray(offset, offset + behavior.bytesPerTick);
        offset += piece.length;
        if (offset >= slice.length) {
          res.end(piece);
          return;
        }
        res.write(piece);
        const timer = setTimeout(() => {
          timers.delete(timer);
          tick();
        }, behavior.tickMs);
        timers.add(timer);
      };
      tick();
      return;
    }
    res.end(slice);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const releaseAll = () => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const res of open) res.destroy();
  };
  onTestFinished(async () => {
    releaseAll();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    url,
    source: (mirror) => `${url}/${mirror}/{path}`,
    put: (path, body) => files.set(path, Buffer.isBuffer(body) ? body : Buffer.from(body)),
    behave: (mirror, behavior) => behaviors.set(mirror, behavior),
    requests,
    releaseAll,
  };
}

/** 一段内容：size 个字节，每个位置都不一样（截断、错位看得出来） */
export function blob(size: number, seed = 1): Buffer {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = (i * 31 + seed * 17 + (i >> 8)) % 256;
  return buf;
}

export interface FakeProxy {
  /** http://127.0.0.1:<端口> */
  url: string;
  /** 经它的请求：CONNECT 的目标（host:port），或者完整地址 */
  seen: string[];
}

/** 假代理：CONNECT 打隧道（转给目标），完整地址的 GET 照转 */
export async function startFakeProxy(): Promise<FakeProxy> {
  const seen: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    seen.push(req.url ?? "");
    const target = new URL(req.url ?? "");
    const upstream = http.request({ host: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method: req.method, headers: req.headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on("error", () => res.destroy());
    req.pipe(upstream);
  });
  server.on("connect", (req, client, head) => {
    seen.push(`CONNECT ${req.url ?? ""}`);
    const [host = "", port = "80"] = (req.url ?? "").split(":");
    const upstream = net.connect(Number(port), host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    sockets.add(upstream);
    sockets.add(client as net.Socket);
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(async () => {
    for (const s of sockets) s.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

/** 检测：固定的（没有 N 卡、什么都没检测到、别处都没有），可以覆盖几项 */
export function fakeProbes(over: { gpu?: "nvidia" | "none"; detect?: Record<string, string>; provided?: Record<string, string> } = {}): ComponentProbes {
  return {
    gpu: () => over.gpu ?? "none",
    detect: (id) => over.detect?.[id],
    provided: (id) => over.provided?.[id],
  };
}

/** 测试守护进程默认的下载那一层：什么都不下（免得哪个测试不小心连真的下载地址） */
export const NO_DOWNLOADS: Transport = () => Promise.reject(new Error("测试里不下载组件"));

/** 一个 tar 项 */
/** zip 里的一项：名字、内容；directory 是目录项；stored 不压缩；symlink 标成符号链接（Unix 的外部属性） */
export interface ZipItem {
  name: string;
  body?: Buffer | string;
  directory?: boolean;
  stored?: boolean;
  symlink?: boolean;
}

/** 打一个 zip 包（没有依赖、够测试用）；zip64 时大小和位置都写进 ZIP64 字段，和真的大包读法一样 */
export function makeZip(items: readonly ZipItem[], options: { zip64?: boolean } = {}): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const zip64 = options.zip64 === true;
  for (const item of items) {
    const name = Buffer.from(item.name, "utf8");
    const raw = Buffer.isBuffer(item.body) ? item.body : Buffer.from(item.body ?? "");
    const method = item.directory || item.stored || raw.length === 0 ? 0 : 8;
    const data = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const crc = zlib.crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, data);
    const extra = zip64 ? Buffer.alloc(4 + 24) : Buffer.alloc(0);
    if (zip64) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(raw.length), 4);
      extra.writeBigUInt64LE(BigInt(data.length), 12);
      extra.writeBigUInt64LE(BigInt(offset), 20);
    }
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt8(20, 4);
    head.writeUInt8(item.symlink ? 3 : 0, 5);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt16LE(method, 10);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(zip64 ? 0xffffffff : data.length, 20);
    head.writeUInt32LE(zip64 ? 0xffffffff : raw.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt16LE(extra.length, 30);
    head.writeUInt32LE(item.symlink ? 0o120777 * 0x10000 : 0, 38);
    head.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
    central.push(head, name, extra);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(zip64 ? 0xffff : items.length, 8);
  end.writeUInt16LE(zip64 ? 0xffff : items.length, 10);
  end.writeUInt32LE(zip64 ? 0xffffffff : directory.length, 12);
  end.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  if (!zip64) return Buffer.concat([...chunks, directory, end]);
  const record = Buffer.alloc(56);
  record.writeUInt32LE(0x06064b50, 0);
  record.writeBigUInt64LE(44n, 4);
  record.writeBigUInt64LE(BigInt(items.length), 24);
  record.writeBigUInt64LE(BigInt(items.length), 32);
  record.writeBigUInt64LE(BigInt(directory.length), 40);
  record.writeBigUInt64LE(BigInt(offset), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(offset + directory.length), 8);
  locator.writeUInt32LE(1, 16);
  return Buffer.concat([...chunks, directory, record, locator, end]);
}

export interface TarItem {
  path: string;
  body?: Buffer | string;
  type?: "file" | "dir" | "symlink";
  /** 用 pax 头写长名字 */
  pax?: boolean;
}

function header(name: string, size: number, typeflag: string, linkname = ""): Buffer {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, "utf8");
  h.write("0000644\0", 100, "ascii");
  h.write("0000000\0", 108, "ascii");
  h.write("0000000\0", 116, "ascii");
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "ascii");
  h.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, "0")}\0`, 136, "ascii");
  h.write("        ", 148, "ascii");
  h.write(typeflag, 156, "ascii");
  h.write(linkname, 157, "utf8");
  h.write("ustar\0", 257, "ascii");
  h.write("00", 263, "ascii");
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i]!;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return h;
}

const pad = (size: number) => Buffer.alloc((512 - (size % 512)) % 512);

/** 打一个 tar 包（gzip 为真时压一下） */
export function makeTar(items: readonly TarItem[], gzip = false): Buffer {
  const blocks: Buffer[] = [];
  for (const item of items) {
    const body = Buffer.isBuffer(item.body) ? item.body : Buffer.from(item.body ?? "");
    if (item.pax) {
      const record = `path=${item.path}\n`;
      // 长度按字节算、连它自己在内
      let length = Buffer.byteLength(record) + 3;
      while (Buffer.byteLength(`${length} ${record}`) !== length) length = Buffer.byteLength(`${length} ${record}`);
      const data = Buffer.from(`${length} ${record}`);
      blocks.push(header("PaxHeader", data.length, "x"), data, pad(data.length));
    }
    const name = item.pax ? "placeholder" : item.path;
    if (item.type === "dir") blocks.push(header(name, 0, "5"));
    else if (item.type === "symlink") blocks.push(header(name, 0, "2", "../../etc/passwd"));
    else blocks.push(header(name, body.length, "0"), body, pad(body.length));
  }
  blocks.push(Buffer.alloc(1024));
  const tar = Buffer.concat(blocks);
  return gzip ? zlib.gzipSync(tar) : tar;
}
