// OpenStreetMap 的瓦片：守护进程替浏览器去取、存在缓存区（429）。照 OSM 的瓦片使用政策（https://operations.osmfoundation.org/policies/tiles/）：
// - 地址就用 https://tile.openstreetmap.org/{z}/{x}/{y}.png；
// - User-Agent 写明是二狗、带能找到人的地址（仓库主页），不冒充浏览器；
// - 按上游的缓存头存（Cache-Control 的 max-age、Expires；no-store 的不存），读不到缓存头的存 7 天；过期了带
//   If-None-Match / If-Modified-Since 问一次，304 就续期；从不发 no-cache；
// - 只取有人正在看的瓦片：不预取、不批量下载、不做离线包。浏览器那边断了（划走了），还在排队的就不去取了；
// - 同时最多 4 个请求在路上（政策没写上限，和一个浏览器开的连接数差不多），同一张瓦片同时只取一次；
// - 不带 Referer：页面是 no-referrer（浏览器本来就不发），守护进程像一个本机程序那样去取（政策："Native apps usually do not
//   have a referer, this is ok"）；有人问起，User-Agent 里的地址能找到二狗。
// 缓存放在数据目录的缓存区（cache/map-tiles/osm/<z>/<x>/<y>.png，旁边 .json 记取的时间、到期、ETag），不进备份；
// 总量超过上限（默认 256 MB）时按取的时间删掉最老的，删到上限的八成。
// 上游不通、限速、出错时：有旧的给旧的（浏览器那边只缓存 1 分钟），没有回 502；上游说没有（404）照样回 404。
import fs from "node:fs";
import path from "node:path";
import type { MapTileAddress } from "@ergo/protocol";
import { writeFileAtomicAsync } from "../util/atomic-file.ts";
import type { MapReply } from "./api.ts";

/** OSM 官方瓦片服务器（地址后面接 /{z}/{x}/{y}.png） */
export const OSM_TILE_UPSTREAM = "https://tile.openstreetmap.org";
/** 读不到缓存头时存多久：政策说至少 7 天 */
export const OSM_DEFAULT_TTL_MS = 7 * 24 * 60 * 60_000;
/** 缓存区的上限（字节） */
export const OSM_CACHE_MAX_BYTES = 256 * 1024 * 1024;
/** 同时最多几个请求在路上 */
export const OSM_CONCURRENCY = 4;
/** 一次请求最多等多久 */
export const OSM_TIMEOUT_MS = 15_000;
/** 一张瓦片最大多少（OSM 的 PNG 一般几十 KB；大得离谱的当出错） */
const MAX_TILE_BYTES = 2 * 1024 * 1024;
/** 给浏览器的缓存最长多久（缓存头本身可能更长；浏览器那边短一点，过期了回来问守护进程，守护进程有缓存） */
const BROWSER_MAX_AGE_S = 24 * 60 * 60;
/** 上游不通时给的旧瓦片，浏览器缓存多久 */
const STALE_MAX_AGE_S = 60;

export interface OsmTilesOptions {
  /** 缓存目录（数据目录的 cache/map-tiles/osm） */
  dir: string;
  /** 上游地址（测试换成本机的假瓦片服务） */
  upstream?: string;
  /** User-Agent（写明是二狗、带联系地址） */
  userAgent: string;
  /** 现在（毫秒）：测试换成手动拨的时钟 */
  now: () => number;
  maxBytes?: number;
  concurrency?: number;
  timeoutMs?: number;
  log: (line: string) => void;
}

export interface OsmTiles {
  get(address: MapTileAddress, signal: AbortSignal): Promise<MapReply>;
  /** 缓存里现在有多少（字节；还没数过时先数一遍） */
  cachedBytes(): Promise<number>;
  /** 停用：排队的不再取 */
  stop(): void;
}

/** 缓存的一张瓦片旁边记的 */
interface TileMeta {
  /** 取到的时刻（毫秒） */
  fetchedAt: number;
  /** 到期的时刻（毫秒） */
  expiresAt: number;
  etag?: string;
  lastModified?: string;
  type: string;
}

/** 排队等着取的一张：浏览器断了就从队里拿掉 */
interface Waiting {
  start: () => void;
  signal: AbortSignal;
  reject: (err: unknown) => void;
}

/** 浏览器断了、插件停了：不回应 */
export class TileAborted extends Error {
  constructor() {
    super("aborted");
    this.name = "TileAborted";
  }
}

/** 按上游的缓存头算到期时刻；no-store、no-cache 不存（undefined），读不到缓存头的给默认的 7 天 */
export function expiryOf(headers: Headers, now: number): number | undefined {
  const cc = (headers.get("cache-control") ?? "").toLowerCase();
  if (/(^|[\s,])no-store\b/.test(cc)) return undefined;
  if (/(^|[\s,])no-cache\b/.test(cc)) return now; // 能存，但每次都要先问
  const maxAge = /(?:^|[\s,])max-age\s*=\s*"?(\d+)/.exec(cc);
  if (maxAge) return now + Number(maxAge[1]) * 1000;
  const expires = headers.get("expires");
  if (expires) {
    const at = Date.parse(expires);
    if (Number.isFinite(at)) return Math.max(now, at);
    return now; // 写坏了的 Expires 按"已经过期"算
  }
  return now + OSM_DEFAULT_TTL_MS;
}

export function createOsmTiles(options: OsmTilesOptions): OsmTiles {
  const upstream = (options.upstream ?? OSM_TILE_UPSTREAM).replace(/\/+$/, "");
  const maxBytes = options.maxBytes ?? OSM_CACHE_MAX_BYTES;
  const concurrency = options.concurrency ?? OSM_CONCURRENCY;
  const timeoutMs = options.timeoutMs ?? OSM_TIMEOUT_MS;
  const stopping = new AbortController();
  /** 同一张瓦片正在取的那一次 */
  const inFlight = new Map<string, Promise<MapReply>>();
  const queue: Waiting[] = [];
  let running = 0;
  /** 缓存区现在多少字节：第一次用时数一遍，之后写进、删掉时加减 */
  let total: Promise<number> | undefined;
  let pruning = false;

  const fileOf = (a: MapTileAddress) => path.join(options.dir, String(a.z), String(a.x), `${a.y}.png`);
  const metaOf = (file: string) => file.replace(/\.png$/, ".json");

  const readCached = (file: string): { body: Buffer; meta: TileMeta } | undefined => {
    try {
      const meta = JSON.parse(fs.readFileSync(metaOf(file), "utf8")) as TileMeta;
      if (typeof meta.expiresAt !== "number" || typeof meta.fetchedAt !== "number") return undefined;
      return { body: fs.readFileSync(file), meta };
    } catch {
      return undefined;
    }
  };

  const browserAge = (meta: TileMeta) => Math.max(0, Math.min(BROWSER_MAX_AGE_S, Math.floor((meta.expiresAt - options.now()) / 1000)));
  const ok = (body: Buffer, type: string, maxAge: number): MapReply => ({ status: 200, headers: { "Content-Type": type, "Cache-Control": `private, max-age=${maxAge}` }, body });
  const fail = (status: number, text: string): MapReply => ({ status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }, body: Buffer.from(`${text}\n`) });

  /** 数缓存区：所有 .png 加起来 */
  const count = async (): Promise<number> => {
    let sum = 0;
    for (const file of await listTiles(options.dir)) sum += file.size;
    return sum;
  };
  const used = () => (total ??= count());
  const adjust = (delta: number) => {
    total = used().then((n) => Math.max(0, n + delta));
    void total.then((n) => (n > maxBytes ? prune() : undefined));
  };

  /** 超了：按取的时间删掉最老的，删到上限的八成 */
  const prune = async () => {
    if (pruning) return;
    pruning = true;
    try {
      const files = (await listTiles(options.dir)).toSorted((a, b) => a.mtimeMs - b.mtimeMs);
      let sum = files.reduce((n, f) => n + f.size, 0);
      for (const f of files) {
        if (sum <= maxBytes * 0.8) break;
        fs.rmSync(f.file, { force: true });
        fs.rmSync(metaOf(f.file), { force: true });
        sum -= f.size;
      }
      total = Promise.resolve(sum);
    } catch (err) {
      options.log(`地图瓦片缓存清理出错：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      pruning = false;
    }
  };

  /** 排队：同时最多 concurrency 个在路上；浏览器断了的不再去取 */
  const slot = (signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted || stopping.signal.aborted) return reject(new TileAborted());
      if (running < concurrency) {
        running++;
        return resolve();
      }
      const waiting: Waiting = {
        start: () => {
          running++;
          resolve();
        },
        signal,
        reject,
      };
      queue.push(waiting);
      signal.addEventListener(
        "abort",
        () => {
          const i = queue.indexOf(waiting);
          if (i >= 0) {
            queue.splice(i, 1);
            reject(new TileAborted());
          }
        },
        { once: true },
      );
    });
  const release = () => {
    running--;
    while (queue.length > 0 && running < concurrency) {
      const next = queue.shift()!;
      if (next.signal.aborted) next.reject(new TileAborted());
      else next.start();
    }
  };

  const store = async (file: string, body: Buffer, meta: TileMeta, before: number) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      await writeFileAtomicAsync(file, body);
      await writeFileAtomicAsync(metaOf(file), JSON.stringify(meta));
      adjust(body.length - before);
    } catch (err) {
      options.log(`地图瓦片没存进缓存：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** 去上游取一张（带条件请求），存进缓存，交回给浏览器的 */
  const fetchTile = async (a: MapTileAddress, file: string, cached: { body: Buffer; meta: TileMeta } | undefined, signal: AbortSignal): Promise<MapReply> => {
    await slot(signal);
    const label = `${a.z}/${a.x}/${a.y}`;
    try {
      const headers: Record<string, string> = { "User-Agent": options.userAgent, Accept: "image/png,image/*;q=0.8" };
      if (cached?.meta.etag) headers["If-None-Match"] = cached.meta.etag;
      if (cached?.meta.lastModified) headers["If-Modified-Since"] = cached.meta.lastModified;
      const res = await fetch(`${upstream}/${label}.png`, { headers, redirect: "follow", signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), stopping.signal]) });
      const now = options.now();
      if (res.status === 304 && cached) {
        await res.body?.cancel();
        const expiresAt = expiryOf(res.headers, now) ?? now;
        const meta: TileMeta = { ...cached.meta, fetchedAt: now, expiresAt, ...etagOf(res.headers, cached.meta) };
        await store(file, cached.body, meta, cached.body.length);
        return ok(cached.body, cached.meta.type, browserAge(meta));
      }
      if (res.status === 200) {
        const type = res.headers.get("content-type") ?? "";
        const body = Buffer.from(await res.arrayBuffer());
        if (!type.startsWith("image/") || body.length === 0 || body.length > MAX_TILE_BYTES) throw new Error(`上游回的不是一张图（${type || "没写类型"}，${body.length} 字节）`); // @i18n-ignore log：只进日志
        const expiresAt = expiryOf(res.headers, now);
        const meta: TileMeta = { fetchedAt: now, expiresAt: expiresAt ?? now, type, ...etagOf(res.headers) };
        if (expiresAt !== undefined) await store(file, body, meta, cached?.body.length ?? 0);
        return ok(body, type, expiresAt === undefined ? 0 : browserAge(meta));
      }
      await res.body?.cancel();
      if (res.status === 404) return fail(404, "no such tile");
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (stopping.signal.aborted) throw new TileAborted();
      const reason = err instanceof Error ? (err.name === "TimeoutError" ? "timeout" : err.message) : String(err);
      options.log(`OpenStreetMap 瓦片 ${label} 没取到：${reason}${cached ? "（给了缓存里的旧瓦片）" : ""}`); // @i18n-ignore log
      if (cached) return ok(cached.body, cached.meta.type, STALE_MAX_AGE_S);
      return fail(502, "tile upstream unavailable");
    } finally {
      release();
    }
  };

  const get = async (a: MapTileAddress, signal: AbortSignal): Promise<MapReply> => {
    const file = fileOf(a);
    const cached = readCached(file);
    if (cached && cached.meta.expiresAt > options.now()) return ok(cached.body, cached.meta.type, browserAge(cached.meta));
    const key = `${a.source}/${a.z}/${a.x}/${a.y}`;
    const pending = inFlight.get(key);
    if (pending) {
      // 跟着别人正在取的那一次；那一次的浏览器断了（还在排队就作罢了）而这边还要，就自己再取
      return pending.catch((err: unknown) => (err instanceof TileAborted && !signal.aborted && !stopping.signal.aborted ? get(a, signal) : Promise.reject(err)));
    }
    const started = fetchTile(a, file, cached, signal).finally(() => inFlight.delete(key));
    inFlight.set(key, started);
    return started;
  };

  return {
    get,
    cachedBytes: () => used(),
    stop() {
      stopping.abort();
      for (const w of queue.splice(0)) w.reject(new TileAborted());
    },
  };
}

function etagOf(headers: Headers, old?: TileMeta): Pick<TileMeta, "etag" | "lastModified"> {
  const etag = headers.get("etag") ?? old?.etag;
  const lastModified = headers.get("last-modified") ?? old?.lastModified;
  return { ...(etag ? { etag } : {}), ...(lastModified ? { lastModified } : {}) };
}

/** 缓存目录里所有的瓦片（.png）：路径、大小、修改时间 */
async function listTiles(dir: string): Promise<Array<{ file: string; size: number; mtimeMs: number }>> {
  const out: Array<{ file: string; size: number; mtimeMs: number }> = [];
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true, recursive: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".png")) continue;
    const file = path.join(e.parentPath, e.name);
    try {
      const st = await fs.promises.stat(file);
      out.push({ file, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      // 刚被删掉的不算
    }
  }
  return out;
}
