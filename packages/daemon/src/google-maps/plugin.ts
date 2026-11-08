// 谷歌地图插件（446，ADR-0057；用户 2026-11-08："海外能集成谷歌地图吗？如果可以的话，做成插件"）：
// 大陆以外的底图、查地点、算路线用 Google Maps Platform；国内国外都能在地图页的地图切换里手动选它。
// - 数据契约（不管插件开没开都登记）：数据源 google-maps"谷歌地图"——填两个 Key（浏览器用的、服务端用的，keys.ts），先测再存；
//   不导入，只有按需查（开关在数据源页上；工具由地图插件给，ownTools）；不拥有记录。移除时"连数据删"：密钥区那一格、插件自己的存储（用量）。
// - 装配：要地图插件的"地图服务"插槽（needs MAP_PROVIDERS），在 setup 里经 ctx.effect 登记一家 google（service.ts）：停用、移除时撤掉，
//   地图页、秘书的查询自动退回下一家（大陆外是 OpenStreetMap）；地图插件停了，它跟着停（宿主的 needs 规矩）。
// - 秘书的工具不新增：沿用地图插件的查地点、算路线那几个，按区域自动用谷歌（地图上选了谷歌时大陆里也用它）。
// - 网页那一半（packages/web/src/plugins/google-maps/）：地图服务插槽的底图 google（官方加载器、固定版本），设置 · 数据源 · 谷歌地图
//   填 Key 的那一块。
// - 隐私：查询时只把要查的那一两个点（起终点、"附近"的中心）发给谷歌，结果不存；浏览器用的 Key 本来就在页面上（谷歌的设计），
//   服务端用的不进页面；谷歌底图是设备直接连谷歌（看足迹时一律 OpenStreetMap，不加载谷歌的脚本，地图插件管）。
import path from "node:path";
import { GOOGLE_MAPS_SOURCE_ID, t } from "@ergo/protocol";
import type { DataSource } from "../data-sources/api.ts";
import { MAP_PROVIDERS } from "../map/api.ts";
import type { PluginDefinition } from "../plugins/host.ts";
import { KERNEL } from "../plugins/kernel.ts";
import { GOOGLE_MAPS, GOOGLE_MAPS_PLUGIN } from "./api.ts";
import type { GoogleHosts } from "./client.ts";
import { createGoogleMapsService } from "./service.ts";

export interface GoogleMapsPluginOptions {
  /** 谷歌三种 Web 服务的地址（测试换成本机的假谷歌） */
  hosts?: Partial<GoogleHosts>;
  /** 一次请求最多等多久（毫秒） */
  timeoutMs?: number;
}

/** 移除并连数据删时删掉的：密钥区里那一格（和 data-dir.ts 的 dataSourceSecrets 一致）、插件自己的存储 */
const SECRET_FILE = path.join("secrets", "data-sources", `${GOOGLE_MAPS_SOURCE_ID}.json`);
/** 插件自己的存储在数据目录里的哪（用量、放没放开） */
export const GOOGLE_MAPS_DATA_DIR = "google-maps";

export function createGoogleMapsPlugin(options: GoogleMapsPluginOptions = {}): PluginDefinition {
  return {
    name: GOOGLE_MAPS_PLUGIN,
    get title() {
      return t("googleMaps.plugin.title");
    },
    get summary() {
      return t("googleMaps.plugin.summary");
    },
    needs: [MAP_PROVIDERS, KERNEL.clock, KERNEL.layout, KERNEL.dataSourceSecrets],
    // 数据源的用法开关：查之前看谷歌的按需查开没开（没有这项服务时当开着）
    wants: [KERNEL.dataSourceUsage],
    provides: [GOOGLE_MAPS],
    contracts(ctx) {
      const source: DataSource = {
        id: GOOGLE_MAPS_SOURCE_ID,
        get title() {
          return t("googleMaps.source.title");
        },
        get summary() {
          return t("googleMaps.source.summary");
        },
        sensitive: [],
        // 按需查：让秘书用谷歌查大陆以外的地点、路线；不导入。工具由地图插件给（几家共用一套），这里只是开关
        usages: { query: { default: true, ownTools: true } },
        status: (c) => ctx.active(GOOGLE_MAPS).status(c.secrets),
        configure: (values, c) => ctx.active(GOOGLE_MAPS).configure(values, c.secrets),
        // 服务端 Key 不认（出错）后内核每小时叫一次，拿存着的再测
        recheck: (c) => ctx.active(GOOGLE_MAPS).recheck(c.secrets, c.signal),
        disconnect: () => ctx.active(GOOGLE_MAPS).reset(),
        get disconnectNote() {
          return t("googleMaps.source.disconnectNote");
        },
      };
      ctx.dataSources.register(source);
      ctx.removal.declare({
        get deletes() {
          return [t("googleMaps.plugin.purge.keys"), t("googleMaps.plugin.purge.usage")];
        },
        get keeps() {
          return [t("googleMaps.plugin.keep.chat")];
        },
        files: [SECRET_FILE, GOOGLE_MAPS_DATA_DIR],
      });
    },
    setup(ctx) {
      const clock = ctx.use(KERNEL.clock);
      const layout = ctx.use(KERNEL.layout);
      const secrets = ctx.use(KERNEL.dataSourceSecrets);
      const service = createGoogleMapsService({
        ...(options.hosts === undefined ? {} : { hosts: options.hosts }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        now: () => clock.now(),
        secrets: () => secrets.forSource(GOOGLE_MAPS_SOURCE_ID),
        dir: path.join(layout.root, GOOGLE_MAPS_DATA_DIR),
        // 谷歌的按需查开没开（现取：用户随时在数据源页上开关）
        queryOn: () => ctx.optional(KERNEL.dataSourceUsage)?.on(GOOGLE_MAPS_SOURCE_ID, "query") ?? true,
        log: (line) => ctx.log(line),
      });
      ctx.provide(GOOGLE_MAPS, service);
      // 登记进地图插件的"地图服务"插槽：停用、移除时宿主替它撤掉，地图页和秘书的查询退回下一家
      const slot = ctx.use(MAP_PROVIDERS);
      ctx.effect(() => slot.register(service.provider));
    },
  };
}

export const googleMapsPlugin: PluginDefinition = createGoogleMapsPlugin();
