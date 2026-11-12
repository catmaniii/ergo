// OpenStreetMap 这一家（455 从地图插件挪出来）：把瓦片转发（osm-tiles.ts）和免费的查地点、算路线（osm-lookup.ts：Nominatim、OSRM）
// 接成插槽的一家（map/api.ts 的 MapProvider）。
// - 编号 osm；"自动"时国内国外都管，优先级 0（排在别家后面：国内高德、国外谷歌和高德都没有时才是它）；手动在哪儿都能选；
// - 查来的哪家地图上都能画（ownBasemapOnly: false：ODbL 的数据，署名写明就行）；
// - 底图一直能用（不用 Key）：页面自己画（网页那一半登记瓦片底图），瓦片经这台电脑转发、带缓存；没有静态地图（卡片的缩略图页面自己画）；
// - 不收费、不限量（照 OSM 的使用政策守着：每秒最多 1 次、带能认出二狗的 User-Agent），没有用量体检项。
import fs from "node:fs";
import { t } from "@ergo/protocol";
import type { MapProvider } from "../map/api.ts";
import { OSM_PROVIDER } from "./api.ts";
import { createOsmLookup, type OsmHosts } from "./osm-lookup.ts";
import { createOsmTiles } from "./osm-tiles.ts";

/** 二狗的版本（User-Agent 里写；跟着 packages/daemon/package.json） */
const ERGO_VERSION = (JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;

/** 去取 OpenStreetMap 瓦片、查地点算路线时的 User-Agent：写明是二狗、带能找到人的地址（OSM 瓦片政策、Nominatim 政策要的） */
export const MAP_USER_AGENT = `ergo/${ERGO_VERSION} (personal assistant; +https://github.com/catmaniii/ergo)`;

/** "自动"时同一个区域里的先后：最后（别家都没有时才用它） */
export const OSM_PRIORITY = 0;

/** 工具说明里讲它的半句（给模型看的） */
const TOOL_NOTE = "大陆以外（和国内没有别家能查时）用免费的 OpenStreetMap（没有公交、没有实时路况，国内的店名和小路可能不全；按名字和种类找，找不到时换成英文的种类说法再找：food court、cafe、supermarket）"; // @i18n-ignore model

export interface OsmServiceOptions {
  /** 瓦片缓存目录（数据目录的 cache/map-tiles/osm） */
  tileDir: string;
  /** 瓦片的上游（测试换成本机的假瓦片服务） */
  upstream?: string;
  /** Nominatim、OSRM 的地址（测试换成本机的假服务） */
  hosts?: Partial<OsmHosts>;
  /** 去 Nominatim、OSRM 时两次之间至少隔多久（毫秒；默认每秒最多 1 次，测试可以调小） */
  intervalMs?: number;
  timeoutMs?: number;
  /** 瓦片缓存上限（字节） */
  tileCacheBytes?: number;
  now: () => number;
  log: (line: string) => void;
}

export interface OsmService {
  /** 登记进地图服务插槽的那一家 */
  readonly provider: MapProvider;
  /** 停用：排队等着取的瓦片不取了、查过的缓存扔掉 */
  stop(): void;
}

export function createOsmService(options: OsmServiceOptions): OsmService {
  const tiles = createOsmTiles({
    dir: options.tileDir,
    ...(options.upstream === undefined ? {} : { upstream: options.upstream }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.tileCacheBytes === undefined ? {} : { maxBytes: options.tileCacheBytes }),
    userAgent: MAP_USER_AGENT,
    now: options.now,
    log: options.log,
  });
  const lookup = createOsmLookup({
    ...(options.hosts === undefined ? {} : { hosts: options.hosts }),
    ...(options.intervalMs === undefined ? {} : { minIntervalMs: options.intervalMs }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    userAgent: MAP_USER_AGENT,
    now: options.now,
    log: options.log,
  });
  const provider: MapProvider = {
    id: OSM_PROVIDER,
    get title() {
      return t("openstreetmap.provider");
    },
    modelName: "OpenStreetMap",
    regions: ["mainland", "abroad"],
    priority: OSM_PRIORITY,
    ownBasemapOnly: false,
    basemap: () => ({ ready: true }),
    lookup: () => ({ ready: true, provider: lookup }),
    toolNote: TOOL_NOTE,
    tiles: { get: (address, signal) => tiles.get(address, signal) },
  };
  return {
    provider,
    stop: () => {
      tiles.stop();
      lookup.clear();
    },
  };
}
