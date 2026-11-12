// 测试里装地图要的几个插件（455 起地图插件只管地图本身，OpenStreetMap、高德各是一个插件）：照 455 以前 createMapPlugin 的那几个选项
// 建地图、OpenStreetMap、高德三个，地址都指向本机的假服务（不给的照插件的默认：真的地址，但测试里不填 Key、不去查就不会连）。
// 主切面用 extraPlugins 换掉清单里的同名插件，假内核直接放进 plugins；谷歌地图另外加（createGoogleMapsPlugin）。
import type { AmapHosts } from "../../src/amap/amap.ts";
import { createAmapPlugin } from "../../src/amap/plugin.ts";
import { createMapPlugin, type MapPluginOptions } from "../../src/map/plugin.ts";
import type { OsmHosts } from "../../src/openstreetmap/osm-lookup.ts";
import { createOpenStreetMapPlugin } from "../../src/openstreetmap/plugin.ts";
import type { PluginDefinition } from "../../src/plugins/host.ts";

export interface MapPluginsOptions {
  /** OpenStreetMap 瓦片的上游（本机的假瓦片服务） */
  osmUpstream?: string;
  /** Nominatim、OSRM 的地址（本机的假服务） */
  osmHosts?: Partial<OsmHosts>;
  /** 去 Nominatim、OSRM 时两次之间至少隔多久（毫秒） */
  osmIntervalMs?: number;
  /** 高德的地址（本机的假高德） */
  amapHosts?: Partial<AmapHosts>;
  /** 一次请求最多等多久（毫秒） */
  timeoutMs?: number;
  /** 瓦片缓存上限（字节） */
  tileCacheBytes?: number;
  /** 换掉"画在地图上"取的那几份（地图插件只给测试的选项） */
  lookups?: MapPluginOptions["lookups"];
  /** 只装哪几家（不写三个都装：地图、OpenStreetMap、高德） */
  only?: readonly ("osm" | "amap")[];
}

/** 地图、OpenStreetMap、高德三个插件（按选项接本机的假服务） */
export function mapPlugins(options: MapPluginsOptions = {}): PluginDefinition[] {
  const has = (id: "osm" | "amap") => options.only === undefined || options.only.includes(id);
  const timeout = options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs };
  return [
    createMapPlugin(options.lookups === undefined ? {} : { lookups: options.lookups }),
    ...(has("osm")
      ? [
          createOpenStreetMapPlugin({
            ...(options.osmUpstream === undefined ? {} : { upstream: options.osmUpstream }),
            ...(options.osmHosts === undefined ? {} : { hosts: options.osmHosts }),
            ...(options.osmIntervalMs === undefined ? {} : { intervalMs: options.osmIntervalMs }),
            ...(options.tileCacheBytes === undefined ? {} : { tileCacheBytes: options.tileCacheBytes }),
            ...timeout,
          }),
        ]
      : []),
    ...(has("amap") ? [createAmapPlugin({ ...(options.amapHosts === undefined ? {} : { hosts: options.amapHosts }), ...timeout })] : []),
  ];
}
