// 地图插件（429，调研 2026-11-07-maps）：二狗里能看地图——国内用高德地图（要填 Key），国外和没填 Key 时用 OpenStreetMap。
// - 数据契约（不管插件开没开都登记，停用也认得）：
//   · 数据源 amap"高德地图"（数据源贡献点）：设置 · 数据源里填 Web 端（JS API）的 Key 和安全密钥、Web 服务的 Key（432 查地点用），
//     填完先测再存（amap.ts）；它不导入、现在也不给秘书工具（usages 空着，432 加按需查）；不拥有记录；
//   · 移除时"连数据删"：密钥区里那一格、缓存的地图瓦片。
// - 装配：提供地图服务（service.ts）给网关和接口——/tiles/ 转发 OpenStreetMap 瓦片（带缓存，osm-tiles.ts）、
//   /_AMapService/ 高德安全密钥代理、GET /api/map/config。要数据目录各区（瓦片缓存在缓存区）、密钥区里自己那一格（转发时拼安全密钥）、时钟。
// - 网页那一半（packages/web/src/plugins/map/）：地图页（#/more/map）和设置 · 数据源里高德地图的填 Key 那一块。
// - 隐私：浏览器不直接连地图服务（瓦片、高德的请求都经这台电脑），地图服务看到的是电脑的 IP；这一票不往外发任何你自己的点。
// - 停用时：页面、接口写"地图插件没启用"，排队等着取的瓦片不取了；Key 留在密钥区，启用后接着用。
// - 我的足迹（430，day.ts）：GET /api/map/day 某一天的点、停留、照片地点、常去的地方，经"手机"插件的服务现算（可选依赖 wants：
//   手机插件没启用时那一句写"手机插件没启用"，地图照样能看）；只在二狗里画，不发给任何地图服务。
// - 聊天里的地图卡片（431）：给秘书的"画在地图上"（show-on-map.ts：某一天的足迹、一组点、一条路线、查地点和路线的结果），
//   画成卡片类型 map（card.ts，数据契约：停用也认得）；查地点、算路线的结果按编号经 GET /api/map/drawing 取（drawing.ts，只在内存里）。
//   移除并连数据删时地图卡片的每个版本也删掉。
import path from "node:path";
import { AMAP_SOURCE_ID, t } from "@ergo/protocol";
import type { DataSource } from "../data-sources/api.ts";
import { PHONE } from "../phone/api.ts";
import { type PluginDefinition, serviceKey } from "../plugins/host.ts";
import { KERNEL } from "../plugins/kernel.ts";
import type { AmapHosts } from "./amap.ts";
import { MAP, MAP_DAY, MAP_DRAWING, MAP_PLUGIN } from "./api.ts";
import { mapCardType } from "./card.ts";
import { createMapDay } from "./day.ts";
import { createMapDrawings } from "./drawing.ts";
import { createMapService, type MapPluginService } from "./service.ts";
import { type MapLookups, showOnMapTool } from "./show-on-map.ts";

/** 插件内部的服务（数据源的函数经它现取） */
const MAP_INTERNAL = serviceKey<MapPluginService>("map-internal");

export interface MapPluginOptions {
  /** OpenStreetMap 瓦片的上游（测试换成本机的假瓦片服务） */
  osmUpstream?: string;
  /** 高德的地址（测试换成本机的假高德） */
  amapHosts?: Partial<AmapHosts>;
  /** 一次请求最多等多久（毫秒） */
  timeoutMs?: number;
  /** 瓦片缓存上限（字节） */
  tileCacheBytes?: number;
  /**
   * 查地点、算路线查到的能画的那几份（现取）：432 合进来以后换成它的 service.lookups（内存里那一份）；
   * 在那之前只有测试经它给（"画在地图上"的 lookup、GET /api/map/drawing）
   */
  lookups?: () => MapLookups | undefined;
}

/** 移除并连数据删时删掉的：密钥区里高德那一格（和 data-dir.ts 的 dataSourceSecrets 一致）、瓦片缓存（和 mapTiles 一致） */
const SECRET_FILE = path.join("secrets", "data-sources", `${AMAP_SOURCE_ID}.json`);
const TILE_CACHE = path.join("cache", "map-tiles");

export function createMapPlugin(options: MapPluginOptions = {}): PluginDefinition {
  return {
    name: MAP_PLUGIN,
    get title() {
      return t("map.plugin.title");
    },
    get summary() {
      return t("map.plugin.summary");
    },
    get brings() {
      return { tools: [t("map.tool.show")], cards: [t("map.plugin.card")], jobs: [] };
    },
    needs: [KERNEL.clock, KERNEL.layout, KERNEL.dataSourceSecrets, KERNEL.cards],
    // 我的足迹的数据在手机插件那里（可选：没有它地图照样能看）
    wants: [PHONE],
    provides: [MAP, MAP_INTERNAL, MAP_DAY, MAP_DRAWING],
    contracts(ctx) {
      const source: DataSource = {
        id: AMAP_SOURCE_ID,
        get title() {
          return t("map.source.title");
        },
        get summary() {
          return t("map.source.summary");
        },
        sensitive: [],
        usages: {},
        status: (c) => ctx.active(MAP_INTERNAL).amapStatus(c.secrets),
        configure: (values, c) => ctx.active(MAP_INTERNAL).configureAmap(values, c.secrets),
        // Key 不认（出错）后内核每小时叫一次，拿存着的再测
        recheck: (c) => ctx.active(MAP_INTERNAL).recheckAmap(c.secrets, c.signal),
        disconnect: () => ctx.active(MAP_INTERNAL).resetAmap(),
        get disconnectNote() {
          return t("map.source.disconnectNote");
        },
      };
      ctx.dataSources.register(source);
      // 聊天里的地图卡片（431）：出来就是已处理、没有动作，停用了也照样显示
      ctx.cardTypes.register(mapCardType());
      ctx.removal.declare({
        get deletes() {
          return [t("map.plugin.purge.keys"), t("map.plugin.purge.tiles"), t("map.plugin.purge.cards")];
        },
        get keeps() {
          return [t("map.plugin.keep.chat")];
        },
        files: [SECRET_FILE, TILE_CACHE],
        cardTypes: ["map"],
      });
    },
    setup(ctx) {
      const clock = ctx.use(KERNEL.clock);
      const layout = ctx.use(KERNEL.layout);
      const secrets = ctx.use(KERNEL.dataSourceSecrets);
      const service = createMapService({
        tileDir: path.join(layout.mapTiles, "osm"),
        ...(options.osmUpstream === undefined ? {} : { osmUpstream: options.osmUpstream }),
        ...(options.amapHosts === undefined ? {} : { amapHosts: options.amapHosts }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.tileCacheBytes === undefined ? {} : { tileCacheBytes: options.tileCacheBytes }),
        now: () => clock.now(),
        secrets: () => secrets.forSource(AMAP_SOURCE_ID),
        log: (line) => ctx.log(line),
      });
      ctx.provide(MAP, service);
      ctx.provide(MAP_INTERNAL, service);
      const day = createMapDay(() => ctx.optional(PHONE));
      ctx.provide(MAP_DAY, { day });
      // 聊天里的地图卡片（431）：查地点、算路线查到的那一份按编号取；秘书的"画在地图上"
      const lookups = () => options.lookups?.();
      ctx.provide(MAP_DRAWING, createMapDrawings(lookups));
      // 插件停了、秘书还没按新的贡献重新装配的那一会儿再调：插件宿主替它回"地图插件没启用"，不出卡
      const tool = showOnMapTool({ day, lookups, cards: ctx.use(KERNEL.cards) });
      ctx.agent.tools.register({ to: { agents: ["secretary"] }, tools: () => [tool] });
      // 停用时：排队等着取的瓦片不取了
      ctx.lifecycle({ stop: () => service.stop() });
    },
  };
}

export const mapPlugin: PluginDefinition = createMapPlugin();
