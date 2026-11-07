// 地图插件（429，调研 2026-11-07-maps）：二狗里能看地图——国内用高德地图（要填 Key），国外和没填 Key 时用 OpenStreetMap。
// - 数据契约（不管插件开没开都登记，停用也认得）：
//   · 数据源 amap"高德地图"（数据源贡献点）：设置 · 数据源里填 Web 端（JS API）的 Key 和安全密钥、Web 服务的 Key（432 查地点用），
//     填完先测再存（amap.ts）；它不导入，只有按需查（432：给秘书查地点、算路线的工具）；不拥有记录；
//   · 移除时"连数据删"：密钥区里那一格、缓存的地图瓦片。
// - 装配：提供地图服务（service.ts）给网关和接口——/tiles/ 转发 OpenStreetMap 瓦片（带缓存，osm-tiles.ts）、
//   /_AMapService/ 高德安全密钥代理、GET /api/map/config。要数据目录各区（瓦片缓存在缓存区）、密钥区里自己那一格（转发时拼安全密钥）、时钟。
// - 网页那一半（packages/web/src/plugins/map/）：地图页（#/more/map）和设置 · 数据源里高德地图的填 Key 那一块。
// - 隐私：浏览器不直接连地图服务（瓦片、高德的请求都经这台电脑），地图服务看到的是电脑的 IP；这一票不往外发任何你自己的点。
// - 停用时：页面、接口写"地图插件没启用"，排队等着取的瓦片不取了；Key 留在密钥区，启用后接着用。
// 432 加了查地点、算路线（高德 Web 服务）：
// - 数据源"高德地图"有了"按需查"（默认开）：给秘书五个工具（lookup-tools.ts：搜地点、算路线、地址 → 位置、某处 → 地址，
//   看常去的地方），内核只在按需查开着、插件在运行、连着时给；"现在能查到的"（live）是设置里的"试查一下"（try-lookup.ts）；
// - "家""公司"取手机插件的常去的地方、"附近"取手机最近交来的一个位置点（可选依赖 wants PHONE：手机插件没启用时工具如实说用不了）；
//   只在用户问的时候把那一两个点发给高德，每天的轨迹、照片地点不发；
// - 结果只现查、不存、不进记忆素材；能画的那一份只在内存里留一会儿（lookup-results.ts，给 431）；
// - 每月的用量记在插件自己的存储（数据目录的 map/amap-usage.json），体检里接近个人档的免费量时提示（doctor.ts，接 409）；
// - 移除时"连数据删"多删插件自己的存储（用量）。
import path from "node:path";
import { AMAP_SOURCE_ID, t } from "@ergo/protocol";
import type { DataSource } from "../data-sources/api.ts";
import { PHONE } from "../phone/api.ts";
import { type PluginDefinition, serviceKey } from "../plugins/host.ts";
import { KERNEL } from "../plugins/kernel.ts";
import type { AmapHosts } from "./amap.ts";
import { MAP, MAP_PLUGIN } from "./api.ts";
import { registerAmapDoctor } from "./doctor.ts";
import { createMapService, type MapPluginService } from "./service.ts";

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
}

/** 移除并连数据删时删掉的：密钥区里高德那一格（和 data-dir.ts 的 dataSourceSecrets 一致）、瓦片缓存（和 mapTiles 一致）、插件自己的存储 */
const SECRET_FILE = path.join("secrets", "data-sources", `${AMAP_SOURCE_ID}.json`);
const TILE_CACHE = path.join("cache", "map-tiles");
/** 插件自己的存储在数据目录里的哪（高德的用量，432） */
export const MAP_DATA_DIR = "map";

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
      return { tools: [t("map.tool.search"), t("map.tool.route"), t("map.tool.geocode"), t("map.tool.reverse"), t("map.tool.places")], cards: [], jobs: [] };
    },
    needs: [KERNEL.clock, KERNEL.layout, KERNEL.dataSourceSecrets],
    // 常去的地方、手机最近的位置（432 查"从家到公司""附近"）：手机插件没启用时工具如实说用不了
    wants: [PHONE],
    provides: [MAP, MAP_INTERNAL],
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
        // 按需查（432）：给秘书查地点、算路线的工具；不导入
        usages: { query: { default: true } },
        status: (c) => ctx.active(MAP_INTERNAL).amapStatus(c.secrets),
        configure: (values, c) => ctx.active(MAP_INTERNAL).configureAmap(values, c.secrets),
        // Key 不认（出错）后内核每小时叫一次，拿存着的再测
        recheck: (c) => ctx.active(MAP_INTERNAL).recheckAmap(c.secrets, c.signal),
        disconnect: () => ctx.active(MAP_INTERNAL).resetAmap(),
        tools: () => ctx.active(MAP_INTERNAL).lookupTools(),
        // 试查一下（设置里那一块、数据源详情的"现在能查到的"）：搜一个固定的地点
        live: (_query, c) => ctx.active(MAP_INTERNAL).tryAmap(c.signal),
        get disconnectNote() {
          return t("map.source.disconnectNote");
        },
      };
      ctx.dataSources.register(source);
      ctx.removal.declare({
        get deletes() {
          return [t("map.plugin.purge.keys"), t("map.plugin.purge.tiles"), t("map.plugin.purge.usage")];
        },
        get keeps() {
          return [t("map.plugin.keep.chat")];
        },
        files: [SECRET_FILE, TILE_CACHE, MAP_DATA_DIR],
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
        mapDir: path.join(layout.root, MAP_DATA_DIR),
        // 手机插件的常去的地方、最近一个位置点（现取：手机插件随时可能停）；只要这两样，不要轨迹
        myPlaces: () => {
          const phone = ctx.optional(PHONE);
          return phone === undefined ? undefined : { named: () => phone.namedPlaces(), latest: () => phone.latestPoint() };
        },
        log: (line) => ctx.log(line),
      });
      ctx.provide(MAP, service);
      ctx.provide(MAP_INTERNAL, service);
      // 体检：高德的用量（409 的插件体检项；插件宿主没有 ctx.doctor 时不登记）
      registerAmapDoctor(ctx, () => service.amapUsageFinding());
      // 停用时：排队等着取的瓦片不取了
      ctx.lifecycle({ stop: () => service.stop() });
    },
  };
}

export const mapPlugin: PluginDefinition = createMapPlugin();
