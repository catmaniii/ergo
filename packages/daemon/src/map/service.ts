// 地图插件的服务（429）：把瓦片转发（osm-tiles.ts）和高德（amap.ts）接成一处，交给网关和 GET /api/map/config。
import fs from "node:fs";
import type { MapConfigView } from "@ergo/protocol";
import type { DataSourceSecrets, DataSourceStatus } from "../data-sources/api.ts";
import type { MapService } from "./api.ts";
import { type AmapHosts, createAmap } from "./amap.ts";
import { createOsmTiles } from "./osm-tiles.ts";

/** 二狗的版本（User-Agent 里写；跟着 packages/daemon/package.json） */
const ERGO_VERSION = (JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;

/** 去取 OpenStreetMap 瓦片时的 User-Agent：写明是二狗、带能找到人的地址（OSM 瓦片政策要的） */
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
  log: (line: string) => void;
}

/** 插件内部用的：网关、接口用的那几样，加上数据源"高德地图"的几个函数 */
export interface MapPluginService extends MapService {
  amapStatus(secrets: DataSourceSecrets): DataSourceStatus;
  configureAmap(values: Readonly<Record<string, string>>, secrets: DataSourceSecrets): Promise<DataSourceStatus>;
  recheckAmap(secrets: DataSourceSecrets, signal: AbortSignal): Promise<void>;
  resetAmap(): void;
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
  return {
    config(): MapConfigView {
      const key = amap.mapKey();
      const problem = amap.mapProblem();
      return { ...(key === undefined ? {} : { amapKey: key }), ...(problem === undefined ? {} : { amapProblem: problem }) };
    },
    tile: (address, signal) => tiles.get(address, signal),
    amapService: (path, search, signal, userAgent?: string) => amap.proxy(path, search, signal, userAgent),
    amapStatus: (secrets) => amap.status(secrets),
    configureAmap: (values, secrets) => amap.configure(values, secrets),
    recheckAmap: (secrets, signal) => amap.recheck(secrets, signal),
    resetAmap: () => amap.reset(),
    stop: () => tiles.stop(),
  };
}
