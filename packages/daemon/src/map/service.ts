// 地图插件的服务（429）：把瓦片转发（osm-tiles.ts）和高德（amap.ts）接成一处，交给网关和 GET /api/map/config。
// 432 加了查地点、算路线：高德 Web 服务（amap-lookup.ts）、每月的用量（amap-usage.ts）、给秘书的工具（lookup-tools.ts）、
// 查到的能画的那一份（lookup-results.ts，只在内存里），设置 · 数据源 · 高德地图的"试查一下"（数据源的 live）。
// 433 加了 OpenStreetMap 的免费服务（osm-lookup.ts：Nominatim 查地点、OSRM 算路线，不用 Key，哪儿都管）。工具两家一套，由插件
// 自己登记给秘书（不再是高德数据源的按需查）。给工具的 providers 每次现算：高德能用（填了 Web 服务 Key、按需查开着、高德没说 Key 不对）
// 才排在前面（国内的点走它），不然只有 OpenStreetMap（退路：国内也走它，结果里提一句国内的店名和小路可能不全）。
import fs from "node:fs";
import type { AmapSourcePanel, AmapUsageView, MapConfigView } from "@ergo/protocol";
import type { HostTool } from "../agent-manager/host-tools.ts";
import type { DataSourceLiveAnswer, DataSourceSecrets, DataSourceStatus } from "../data-sources/api.ts";
import type { MapService } from "./api.ts";
import { AMAP_SECRET, type AmapHosts, createAmap } from "./amap.ts";
import { createAmapLookup } from "./amap-lookup.ts";
import { amapUsageFile, type AmapUsageFinding, openAmapUsage, usageFinding } from "./amap-usage.ts";
import { createLookupResults, type LookupResults } from "./lookup-results.ts";
import { lookupTools, type MyPlaces } from "./lookup-tools.ts";
import type { LookupProvider } from "./lookup.ts";
import { createOsmLookup, type OsmHosts } from "./osm-lookup.ts";
import { createOsmTiles } from "./osm-tiles.ts";
import { tryLookup } from "./try-lookup.ts";

/** 二狗的版本（User-Agent 里写；跟着 packages/daemon/package.json） */
const ERGO_VERSION = (JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;

/** 工具说明里讲数据从哪来的那句（给模型看的） */
const LOOKUP_SOURCES = "中国大陆里的用高德（开车带实时路况，有公交；要用户填了高德的 Web 服务 Key，没填时国内也用 OpenStreetMap，店名和小路可能不全），大陆以外用免费的 OpenStreetMap（没有公交、没有实时路况）"; // @i18n-ignore model

/** 去取 OpenStreetMap 瓦片、查地点算路线时的 User-Agent：写明是二狗、带能找到人的地址（OSM 瓦片政策、Nominatim 政策要的） */
export const MAP_USER_AGENT = `ergo/${ERGO_VERSION} (personal assistant; +https://github.com/catmaniii/ergo)`;

export interface MapServiceOptions {
  /** 瓦片缓存目录（数据目录的 cache/map-tiles/osm） */
  tileDir: string;
  /** OpenStreetMap 瓦片的上游（测试换成本机的假瓦片服务） */
  osmUpstream?: string;
  /** 高德的地址（测试换成本机的假高德） */
  amapHosts?: Partial<AmapHosts>;
  timeoutMs?: number;
  /** 瓦片缓存上限（字节） */
  tileCacheBytes?: number;
  /** 现在（毫秒），瓦片的到期按它算 */
  now: () => number;
  /** 密钥区里高德那一格（现取） */
  secrets: () => DataSourceSecrets;
  /** 插件自己的存储（数据目录的 map/：高德的用量） */
  mapDir: string;
  /** 常去的地方、手机最近的位置（手机插件给的，现取；手机插件没启用是 undefined） */
  myPlaces?: () => MyPlaces | undefined;
  /** 高德的按需查开没开（设置 · 数据源 · 高德地图里的开关，现取；不给当开着） */
  amapQueryOn?: () => boolean;
  /** OpenStreetMap 的 Nominatim、OSRM 的地址（测试换成本机的假服务） */
  osmHosts?: Partial<OsmHosts>;
  /** 去 Nominatim、OSRM 时两次之间至少隔多久（毫秒；默认每秒最多 1 次，测试可以调小） */
  osmIntervalMs?: number;
  log: (line: string) => void;
}

/** 插件内部用的：网关、接口用的那几样，加上数据源"高德地图"的几个函数 */
export interface MapPluginService extends MapService {
  amapStatus(secrets: DataSourceSecrets): DataSourceStatus;
  configureAmap(values: Readonly<Record<string, string>>, secrets: DataSourceSecrets): Promise<DataSourceStatus>;
  recheckAmap(secrets: DataSourceSecrets, signal: AbortSignal): Promise<void>;
  resetAmap(): void;
  /** 给秘书的查地点、算路线工具（插件自己登记；国内高德、国外 OpenStreetMap，433） */
  lookupTools(): readonly HostTool[];
  /** 设置 · 数据源 · 高德地图的"试查一下"（数据源的 live）：拿 Web 服务 Key 搜一个固定的地点 */
  tryAmap(signal: AbortSignal): Promise<DataSourceLiveAnswer>;
  /** 查到的能画的那一份（只在内存里；431 的"画在地图上"按编号取） */
  readonly lookups: LookupResults;
  /** 这个月查了几次 */
  amapUsage(): AmapUsageView;
  /** 体检里"高德的用量"那一项（409 的插件体检项） */
  amapUsageFinding(): AmapUsageFinding;
  stop(): void;
}

export function createMapService(options: MapServiceOptions): MapPluginService {
  const tiles = createOsmTiles({
    dir: options.tileDir,
    ...(options.osmUpstream === undefined ? {} : { upstream: options.osmUpstream }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.tileCacheBytes === undefined ? {} : { maxBytes: options.tileCacheBytes }),
    userAgent: MAP_USER_AGENT,
    now: options.now,
    log: options.log,
  });
  const amap = createAmap({
    ...(options.amapHosts === undefined ? {} : { hosts: options.amapHosts }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    secrets: options.secrets,
    log: options.log,
  });
  const usage = openAmapUsage({ file: amapUsageFile(options.mapDir), now: options.now, log: options.log });
  const lookup = createAmapLookup({
    ...(options.amapHosts === undefined ? {} : { hosts: options.amapHosts }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    secrets: options.secrets,
    usage,
    onReply: (body, status) => amap.serviceReply(body, status),
    log: options.log,
  });
  // 高德：能用时（填了 Web 服务 Key、按需查开着、高德没说 Key 不对）才给工具，国内的点走它；不能用时国内也走 OpenStreetMap
  const amapUsable = () => options.amapQueryOn?.() !== false && lookup.hasKey() && amap.serviceProblem() === undefined;
  const osm = createOsmLookup({
    ...(options.osmHosts === undefined ? {} : { hosts: options.osmHosts }),
    ...(options.osmIntervalMs === undefined ? {} : { minIntervalMs: options.osmIntervalMs }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    userAgent: MAP_USER_AGENT,
    now: options.now,
    log: options.log,
  });
  const lookups = createLookupResults({ now: options.now });
  const providers = (): readonly LookupProvider[] => (amapUsable() ? [lookup, osm] : [osm]);
  const tools = lookupTools({ providers, sources: LOOKUP_SOURCES, myPlaces: () => options.myPlaces?.(), results: lookups, now: options.now });
  /** 设置 · 数据源 · 高德地图那一块要的：Web 服务 Key 填了没有、这个月的用量 */
  const panel = (secrets: DataSourceSecrets): AmapSourcePanel => ({ kind: "amap", lookup: secrets.has(AMAP_SECRET.serviceKey), usage: usage.view() });
  return {
    config(): MapConfigView {
      const key = amap.mapKey();
      const problem = amap.mapProblem();
      return { ...(key === undefined ? {} : { amapKey: key }), ...(problem === undefined ? {} : { amapProblem: problem }) };
    },
    tile: (address, signal) => tiles.get(address, signal),
    amapService: (path, search, signal, userAgent?: string) => amap.proxy(path, search, signal, userAgent),
    amapStatus: (secrets) => {
      const status = amap.status(secrets);
      return status.connection === "not_connected" ? status : { ...status, panel: panel(secrets) };
    },
    configureAmap: (values, secrets) => amap.configure(values, secrets),
    recheckAmap: (secrets, signal) => amap.recheck(secrets, signal),
    resetAmap: () => amap.reset(),
    lookupTools: () => tools,
    tryAmap: (signal) => tryLookup(lookup, usage, signal),
    lookups,
    amapUsage: () => usage.view(),
    amapUsageFinding: () => usageFinding(usage.view(), lookup.hasKey()),
    stop: () => {
      tiles.stop();
      lookups.clear();
      osm.clear();
    },
  };
}
