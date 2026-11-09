// 去 OpenStreetMap 的免费服务（Nominatim、OSRM 演示服务）取东西的规矩（433）：一家服务一个，守住它们的使用政策——
// - 每秒最多 1 次（两家的政策都这么写：Nominatim "an absolute maximum of 1 request per second"，OSRM 演示服务 "Do not exceed
//   1 request per second"）：一家只排一队、一次只有一个在路上（前一个回来了才发下一个），两次开始之间至少隔
//   OSM_MIN_INTERVAL_MS（多留 0.1 秒余量）；
//   排队的太多（秘书一轮里连着查了很多）不再往里加，直接说"查得太频繁"。
// - 带能认出二狗的 User-Agent（"stock User-Agents as set by http libraries will not do"），和瓦片转发同一个（service.ts 的
//   MAP_USER_AGENT）；不带 Referer。
// - 结果缓存（Nominatim 政策："Results must be cached on your side"，同样的查询反复发会被当成坏客户端封掉）：只在内存里，
//   按完整的请求地址记，留 OSM_CACHE_TTL_MS（一天），最多 OSM_CACHE_MAX 份（满了扔最久没用的）；守护进程重启、插件停用就没了，
//   不落盘、不进记忆素材。同一个地址同时只发一次（后来的等前一个）。出错的不缓存。
// - 不做输入联想、不批量：只在秘书调工具（用户问）时发，每次只发这一问要的那一两个请求（lookup-tools.ts）。
// 出错一律抛 lookup.ts 的 MapLookupError：连不上、等太久（network）、429（rate）、403（denied：多半是被封了）、5xx（server）；
// 4xx 带 JSON 的交给调用的一方按服务自己的错误码分（OSRM 回 400 加 { code, message }）。
import { MapLookupError } from "../map/api.ts";

/** 两次请求开始之间至少隔多久（毫秒）：政策是每秒最多 1 次，多留 0.1 秒 */
export const OSM_MIN_INTERVAL_MS = 1_100;
/** 结果在内存里留多久（毫秒） */
export const OSM_CACHE_TTL_MS = 24 * 60 * 60_000;
/** 最多留几份 */
export const OSM_CACHE_MAX = 200;
/** 最多排几个（再多直接说查得太频繁） */
export const OSM_QUEUE_MAX = 8;
/** 一次请求最多等多久（毫秒，不算排队） */
export const OSM_TIMEOUT_MS = 15_000;

/** 服务回的：HTTP 状态和读出来的 JSON（不是 JSON 是 undefined） */
export interface OsmReply {
  readonly status: number;
  readonly body: unknown;
}

export interface PoliteClientOptions {
  /** 给日志看的名字（"Nominatim""OSRM"） */
  name: string;
  userAgent: string;
  now: () => number;
  /** 两次开始之间至少隔多久；测试可以调小 */
  minIntervalMs?: number;
  cacheTtlMs?: number;
  cacheMax?: number;
  queueMax?: number;
  timeoutMs?: number;
  /** 等一会儿（测试换成假的，看排队排了多久）；signal 置位时抛出 */
  wait?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
  log: (line: string) => void;
}

export interface PoliteClient {
  /**
   * GET 一个地址：缓存里有就用缓存的（不发请求），没有就排队、按间隔发。回 200 或 4xx（交给调用的一方读）；
   * 连不上、429、403、5xx、不是 JSON 抛 MapLookupError。只缓存 200 的
   */
  get(url: string, signal?: AbortSignal): Promise<OsmReply>;
  /** 一共真发出去了几次（测试、日志用） */
  sent(): number;
  /** 扔掉缓存（插件停用时） */
  clear(): void;
}

/** 照真的时间等 ms 毫秒；signal 置位时抛出 */
function realWait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason as Error);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason as Error);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** fetch 出错时真正的原因（undici 把它放在 cause 里，外面只有 "fetch failed"） */
function causeOf(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) return (cause as { code?: string }).code ?? cause.message;
  return err.message;
}

/** 日志里只写服务和路径，不写查了什么（查询串里是地名、坐标） */
const pathOf = (url: string) => {
  try {
    return new URL(url).pathname.split("/").slice(0, 4).join("/");
  } catch {
    return "?";
  }
};

export function createPoliteClient(options: PoliteClientOptions): PoliteClient {
  const interval = options.minIntervalMs ?? OSM_MIN_INTERVAL_MS;
  const ttl = options.cacheTtlMs ?? OSM_CACHE_TTL_MS;
  const max = options.cacheMax ?? OSM_CACHE_MAX;
  const queueMax = options.queueMax ?? OSM_QUEUE_MAX;
  const timeoutMs = options.timeoutMs ?? OSM_TIMEOUT_MS;
  const wait = options.wait ?? realWait;
  /** 地址 → 回的和留到什么时候（Map 按放进去的先后：用到一次挪到最后，满了删最前面的） */
  const cache = new Map<string, { reply: OsmReply; until: number }>();
  /** 正在取的（同一个地址同时只发一次） */
  const inflight = new Map<string, Promise<OsmReply>>();
  /** 下一个请求最早什么时候能开始 */
  let nextAt = 0;
  /** 排队：一次只放一个出去 */
  let tail: Promise<void> = Promise.resolve();
  let queued = 0;
  let sent = 0;

  /** 排队发：等前面的都做完、离上一次开始够了间隔，才发这一个（一次只有一个在路上） */
  const queue = (url: string, signal: AbortSignal | undefined): Promise<OsmReply> => {
    if (queued >= queueMax) return Promise.reject(new MapLookupError("rate", "too many queued requests"));
    queued += 1;
    const mine = tail.then(async () => {
      const delay = nextAt - options.now();
      if (delay > 0) await wait(delay, signal);
      if (signal?.aborted) throw signal.reason as Error;
      nextAt = options.now() + interval;
      return fetchOnce(url, signal);
    });
    tail = mine.then(
      () => {},
      () => {},
    );
    return mine.finally(() => {
      queued -= 1;
    });
  };

  const fetchOnce = async (url: string, signal: AbortSignal | undefined): Promise<OsmReply> => {
    sent += 1;
    const timeout = AbortSignal.timeout(timeoutMs);
    let res: Response;
    let text: string;
    try {
      res = await fetch(url, {
        headers: { "User-Agent": options.userAgent, Accept: "application/json" },
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
      text = await res.text();
    } catch (err) {
      if (signal?.aborted) throw err;
      const reason = timeout.aborted ? "timeout" : causeOf(err);
      options.log(`${options.name}：${pathOf(url)} 没连上：${reason}`); // @i18n-ignore log
      throw new MapLookupError("network", reason);
    }
    if (res.status === 429) {
      options.log(`${options.name}：${pathOf(url)} 说查得太频繁（429）`); // @i18n-ignore log
      throw new MapLookupError("rate", "HTTP 429");
    }
    if (res.status === 403) {
      options.log(`${options.name}：${pathOf(url)} 拒绝了（403）`); // @i18n-ignore log
      throw new MapLookupError("denied", "HTTP 403");
    }
    if (res.status >= 500) {
      options.log(`${options.name}：${pathOf(url)} 那边出错（HTTP ${res.status}）`); // @i18n-ignore log
      throw new MapLookupError("server", `HTTP ${res.status}`);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      options.log(`${options.name}：${pathOf(url)} 回的不是 JSON（HTTP ${res.status}）`); // @i18n-ignore log
      throw new MapLookupError(res.status === 200 ? "server" : "other", `HTTP ${res.status}`);
    }
    return { status: res.status, body };
  };

  return {
    async get(url, signal) {
      const hit = cache.get(url);
      if (hit && hit.until > options.now()) {
        cache.delete(url);
        cache.set(url, hit);
        return hit.reply;
      }
      if (hit) cache.delete(url);
      let pending = inflight.get(url);
      if (!pending) {
        pending = queue(url, signal).finally(() => inflight.delete(url));
        inflight.set(url, pending);
      }
      const reply = await pending;
      if (reply.status === 200) {
        cache.set(url, { reply, until: options.now() + ttl });
        while (cache.size > max) cache.delete(cache.keys().next().value!);
      }
      return reply;
    },
    sent: () => sent,
    clear: () => cache.clear(),
  };
}
