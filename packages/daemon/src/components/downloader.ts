// 下载一个文件（323 号票）：几个下载地址按探速排好，从快的下起；先写 <文件>.part，断了从已经下到的地方接着下（Range），
// 一个地址出错、卡住（多久没收到字节）就换下一个、接着下；下全了核对大小和 sha256，对了才改成正式的名字（放在临时目录里，
// 整个组件都下好、校验过才换上）。内容对不上的：这一份删掉，只由一个地址下的就不再用它，换别的从头下；所有地址都不对就报"校验对不上"。
// 暂停、取消都是中止信号：下了一半的 .part 留着（取消时由上层删整个临时目录）。
// 以前的 npm run download-model（embedding/model-files.ts 的 downloadModelFiles）并进了这里。
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { renameRetryingAsync } from "../util/atomic-file.ts";
import type { Transport } from "./transport.ts";

/** 一个文件的一个下载地址 */
export interface DownloadUrl {
  /** 下载地址的 id（huggingface、hf-mirror……）：按它排先后、记哪个地址给的内容不对 */
  sourceId: string;
  /** 给人看的名字 */
  title: string;
  url: string;
}

export interface DownloadFile {
  /** 给人看的名字（文件在组件里的路径） */
  name: string;
  /** 下载地址，按先后试 */
  urls: readonly DownloadUrl[];
  size: number;
  sha256?: string | undefined;
  /** 下了一半的写在这里 */
  part: string;
  /** 下全、校验过的改成这个名字 */
  dest: string;
}

/**
 * 下载出错：checksum 内容对不上清单（所有地址都试过）；unreachable 哪个地址都下不下来（连不上、HTTP 出错、一直卡住）；
 * disk 磁盘空间不够；stopped 被中止了（暂停、取消、守护进程停下）
 */
export type DownloadErrorKind = "checksum" | "unreachable" | "disk" | "stopped";

export class DownloadError extends Error {
  readonly kind: DownloadErrorKind;
  constructor(kind: DownloadErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

/** 一个地址给的东西和清单对不上（大小不对）：不再用这个地址下这个文件 */
class WrongContent extends Error {}

export interface DownloadContext {
  transport: Transport;
  signal: AbortSignal;
  /** 这个文件已经有多少字节了（每收到一块报一次），从哪个地址 */
  onBytes(done: number, from: DownloadUrl): void;
  /** 下全了、开始核对 sha256 */
  onVerifying?(): void;
  /** 多久没收到字节算卡住（毫秒） */
  stallMs: number;
  log(line: string): void;
}

/** 文件现在多大；不在是 0 */
export function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** 整个文件的 sha256 */
export async function sha256File(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file, signal ? { signal } : {})) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Content-Range: bytes 100-199/1000 */
function contentRange(value: string | undefined): { start: number; total?: number } | undefined {
  const m = value === undefined ? null : /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value.trim());
  if (!m) return undefined;
  return { start: Number(m[1]), ...(m[3] === "*" ? {} : { total: Number(m[3]) }) };
}

const stopped = () => new DownloadError("stopped", "已中止"); // @i18n-ignore log：上层按状态换成给人看的

/** 从一个地址接着下这个文件（下全了才返回）；收到过字节的地址记进 contributors（这一份 .part 里有它给的内容） */
async function fetchInto(file: DownloadFile, from: DownloadUrl, ctx: DownloadContext, contributors: Set<string>): Promise<void> {
  let offset = sizeOf(file.part);
  if (offset > file.size) {
    fs.rmSync(file.part, { force: true });
    contributors.clear();
    offset = 0;
  }
  if (offset === file.size) return;
  fs.mkdirSync(path.dirname(file.part), { recursive: true });
  const res = await ctx.transport(from.url, { ...(offset > 0 ? { rangeStart: offset } : {}), signal: ctx.signal });
  let stallTimer: NodeJS.Timeout | undefined;
  try {
    if (res.status === 416) {
      // 服务端说这个位置要不到：下了一半的不认了，下次从头下
      fs.rmSync(file.part, { force: true });
      contributors.clear();
      throw new Error("HTTP 416");
    }
    if (res.status !== 200 && res.status !== 206) throw new Error(`HTTP ${res.status}`);
    let append = offset > 0;
    if (res.status === 206) {
      const range = contentRange(res.headers["content-range"]);
      if (!range || range.start !== offset) {
        fs.rmSync(file.part, { force: true });
        contributors.clear();
        throw new Error("续传的位置对不上"); // @i18n-ignore log：下载出错的原因，进日志
      }
      if (range.total !== undefined && range.total !== file.size) throw new WrongContent(`大小是 ${range.total}，清单里是 ${file.size}`); // @i18n-ignore log：同上
    } else {
      // 200：服务端不认 Range，从头给的
      const length = Number(res.headers["content-length"]);
      if (res.headers["content-length"] !== undefined && Number.isFinite(length) && length !== file.size) throw new WrongContent(`大小是 ${length}，清单里是 ${file.size}`); // @i18n-ignore log：同上
      if (offset > 0) contributors.clear();
      append = false;
      offset = 0;
    }
    const out = fs.createWriteStream(file.part, { flags: append ? "a" : "w" });
    let received = 0;
    const armStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => res.destroy(new Error(`${Math.round(ctx.stallMs / 1000)} 秒没收到数据`)), ctx.stallMs); // @i18n-ignore log：下载出错的原因，进日志
    };
    try {
      armStall();
      for await (const chunk of res.body) {
        armStall();
        if (offset + received + chunk.length > file.size) throw new WrongContent(`比清单里的 ${file.size} 字节大`); // @i18n-ignore log：同上
        if (!out.write(chunk)) await once(out, "drain");
        received += chunk.length;
        contributors.add(from.sourceId);
        ctx.onBytes(offset + received, from);
      }
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
      await new Promise<void>((resolve) => out.end(() => resolve()));
    }
    if (offset + received !== file.size) throw new Error(`连接断了（下到 ${offset + received} / ${file.size}）`); // @i18n-ignore log：同上
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
    res.destroy();
  }
}

/**
 * 下一个文件到 dest：已经有了（上次下好、校验过的）就不下。几个地址按 urls 的先后试，出错换下一个接着下，
 * 都试过几轮还不行抛 DownloadError
 */
export async function downloadFile(file: DownloadFile, ctx: DownloadContext): Promise<void> {
  if (sizeOf(file.dest) === file.size && fs.existsSync(file.dest)) return;
  const bad = new Set<string>();
  const contributors = new Set<string>();
  let lastError: DownloadError | undefined;
  for (let round = 0; round < 3; round++) {
    for (const from of file.urls) {
      if (bad.has(from.sourceId)) continue;
      if (ctx.signal.aborted) throw stopped();
      try {
        await fetchInto(file, from, ctx, contributors);
      } catch (err) {
        if (ctx.signal.aborted) throw stopped();
        const reason = err instanceof Error ? err.message : String(err);
        if (err instanceof WrongContent) {
          // 这个地址给的不是清单里的那个文件
          bad.add(from.sourceId);
          fs.rmSync(file.part, { force: true });
          contributors.clear();
          ctx.log(`${file.name}：${from.title} 给的内容不对（${reason}），不再用它`);
          lastError = new DownloadError("checksum", reason);
        } else {
          ctx.log(`${file.name}：从 ${from.title} 下没成（${reason}），换下一个地址接着下`);
          lastError = new DownloadError("unreachable", `${from.title}: ${reason}`);
        }
        continue;
      }
      // 下全了：核对
      ctx.onVerifying?.();
      const digest = file.sha256 === undefined ? undefined : await sha256File(file.part, ctx.signal).catch((err: unknown) => {
        if (ctx.signal.aborted) throw stopped();
        throw err;
      });
      if (file.sha256 !== undefined && digest !== file.sha256) {
        fs.rmSync(file.part, { force: true });
        // 只由一个地址下的：就是它给的不对；几个地址拼起来的说不清是谁，都留着、从头再下
        if (contributors.size === 1) bad.add([...contributors][0]!);
        ctx.log(`${file.name}：下全了但 sha256 对不上（${digest}，应为 ${file.sha256}），这一份不用`);
        contributors.clear();
        lastError = new DownloadError("checksum", `sha256 ${digest}`);
        continue;
      }
      await renameRetryingAsync(file.part, file.dest);
      return;
    }
    if (file.urls.every((u) => bad.has(u.sourceId))) break;
  }
  throw lastError ?? new DownloadError("unreachable", "没有下载地址"); // @i18n-ignore log：上层换成给人看的
}

export interface ProbeResult {
  sourceId: string;
  /** 探到的速度（字节 / 秒）；没探成是 undefined */
  speed?: number;
  error?: string;
}

/**
 * 探速：每个地址取同一个文件的开头一小段（bytes 个字节，最多等 timeoutMs），按速度从快到慢排；没探成的排在后面（照样会试）。
 * 文件小于要取的就取整个
 */
export async function probeSources(urls: readonly DownloadUrl[], options: { transport: Transport; bytes: number; size: number; timeoutMs: number; signal: AbortSignal; now?: () => number }): Promise<ProbeResult[]> {
  const now = options.now ?? (() => performance.now());
  const want = Math.max(1, Math.min(options.bytes, options.size));
  const results = await Promise.all(
    urls.map(async (u): Promise<ProbeResult> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs);
      const onAbort = () => controller.abort();
      options.signal.addEventListener("abort", onAbort, { once: true });
      const started = now();
      let received = 0;
      try {
        const res = await options.transport(u.url, { rangeStart: 0, rangeEnd: want - 1, signal: controller.signal });
        try {
          if (res.status !== 200 && res.status !== 206) return { sourceId: u.sourceId, error: `HTTP ${res.status}` };
          for await (const chunk of res.body) {
            received += chunk.length;
            if (received >= want) break;
          }
        } finally {
          res.destroy();
        }
        if (received === 0) return { sourceId: u.sourceId, error: "没有内容" }; // @i18n-ignore log：探速的结果只进日志
        return { sourceId: u.sourceId, speed: received / Math.max(0.001, (now() - started) / 1000) };
      } catch (err) {
        if (received > 0 && controller.signal.aborted && !options.signal.aborted) {
          // 到点了还没取完：按取到的算速度（慢）
          return { sourceId: u.sourceId, speed: received / Math.max(0.001, (now() - started) / 1000) };
        }
        return { sourceId: u.sourceId, error: err instanceof Error ? err.message : String(err) };
      } finally {
        clearTimeout(timer);
        options.signal.removeEventListener("abort", onAbort);
      }
    }),
  );
  if (options.signal.aborted) throw stopped();
  const order = (r: ProbeResult) => r.speed ?? -1;
  return results.toSorted((a, b) => order(b) - order(a));
}

/** dir 所在的盘还剩多少字节（dir 不在就往上找到在的那一级） */
export function freeBytesOf(dir: string): number {
  let current = path.resolve(dir);
  for (;;) {
    try {
      const stat = fs.statfsSync(current);
      return Number(stat.bavail) * Number(stat.bsize);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return Number.POSITIVE_INFINITY;
      current = parent;
    }
  }
}
