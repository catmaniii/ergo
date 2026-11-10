// OpenStreetMap 插件（455，ADR-0061；429 起在地图插件里，用户 2026-11-09 要三家各做成一个插件）：免费的开源地图。
// - 装配：要地图插件的"地图服务"插槽（needs MAP_PROVIDERS），在 setup 里经 ctx.effect 登记一家 osm（service.ts）：停用、移除时撤掉，
//   地图页、秘书的查询退回别家；三家都停了地图页说"没有能用的地图"。地图插件停了，它跟着停（宿主的 needs 规矩）。
// - 它带来：网关 /tiles/osm/… 的瓦片转发（osm-tiles.ts，带缓存，照 OSM 的瓦片使用政策）、Nominatim 查地点和 OSRM 算路线
//   （osm-lookup.ts、osm-client.ts，每秒最多 1 次、结果只在内存里缓存一天）。秘书的工具不新增：查地点、算路线还是地图插件那几个。
// - 网页那一半（packages/web/src/plugins/openstreetmap/）：瓦片底图 osm（页面自己画，点、线、字也是地图插件自己画）、署名。
// - 不填 Key、没有数据源；数据契约里只写"连数据删"：缓存在这台电脑上的瓦片（数据目录的 cache/map-tiles，455 以前是地图插件的）。
// - 隐私：浏览器不直接连 OpenStreetMap（瓦片经这台电脑转发，它看到的是电脑的 IP）；查询只发你问的那一两个点。
import path from "node:path";
import { t } from "@ergo/protocol";
import { MAP_PROVIDERS } from "../map/api.ts";
import type { PluginDefinition } from "../plugins/host.ts";
import { KERNEL } from "../plugins/kernel.ts";
import { OPENSTREETMAP_PLUGIN, OSM_PROVIDER } from "./api.ts";
import type { OsmHosts } from "./osm-lookup.ts";
import { createOsmService } from "./service.ts";

export interface OpenStreetMapPluginOptions {
  /** 瓦片的上游（测试换成本机的假瓦片服务） */
  upstream?: string;
  /** Nominatim、OSRM 的地址（测试换成本机的假服务） */
  hosts?: Partial<OsmHosts>;
  /** 去 Nominatim、OSRM 时两次之间至少隔多久（毫秒；默认每秒最多 1 次，测试可以调小） */
  intervalMs?: number;
  /** 一次请求最多等多久（毫秒） */
  timeoutMs?: number;
  /** 瓦片缓存上限（字节） */
  tileCacheBytes?: number;
}

/** 移除并连数据删时删掉的：瓦片缓存（和 data-dir.ts 的 mapTiles 一致） */
const TILE_CACHE = path.join("cache", "map-tiles");

export function createOpenStreetMapPlugin(options: OpenStreetMapPluginOptions = {}): PluginDefinition {
  return {
    name: OPENSTREETMAP_PLUGIN,
    get title() {
      return t("openstreetmap.plugin.title");
    },
    get summary() {
      return t("openstreetmap.plugin.summary");
    },
    needs: [MAP_PROVIDERS, KERNEL.clock, KERNEL.layout],
    contracts(ctx) {
      ctx.removal.declare({
        get deletes() {
          return [t("openstreetmap.plugin.purge.tiles")];
        },
        get keeps() {
          return [t("openstreetmap.plugin.keep.chat")];
        },
        files: [TILE_CACHE],
      });
    },
    setup(ctx) {
      const clock = ctx.use(KERNEL.clock);
      const layout = ctx.use(KERNEL.layout);
      const service = createOsmService({
        tileDir: path.join(layout.mapTiles, OSM_PROVIDER),
        ...(options.upstream === undefined ? {} : { upstream: options.upstream }),
        ...(options.hosts === undefined ? {} : { hosts: options.hosts }),
        ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.tileCacheBytes === undefined ? {} : { tileCacheBytes: options.tileCacheBytes }),
        now: () => clock.now(),
        log: (line) => ctx.log(line),
      });
      // 登记进地图插件的"地图服务"插槽：停用、移除时宿主替它撤掉，地图页和秘书的查询退回别家
      const slot = ctx.use(MAP_PROVIDERS);
      ctx.effect(() => slot.register(service.provider));
      // 停用时：排队等着取的瓦片不取了、查过的缓存扔掉
      ctx.lifecycle({ stop: () => service.stop() });
    },
  };
}

export const openStreetMapPlugin: PluginDefinition = createOpenStreetMapPlugin();
