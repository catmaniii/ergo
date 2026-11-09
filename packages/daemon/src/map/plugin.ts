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
// - 我的足迹（430，day.ts）：GET /api/map/day 某一天的点、停留、照片地点、常去的地方，经"手机"插件的服务现算（可选依赖 wants：
//   手机插件没启用时那一句写"手机插件没启用"，地图照样能看）；只在二狗里画，不发给任何地图服务。
//   GET /api/map/latest（442）手机最近交来的一个位置点：地图页"回到我现在的位置"在这台设备定不了位时的退路。
// - 聊天里的地图卡片（431）：给秘书的"画在地图上"（show-on-map.ts：某一天的足迹、一组点、一条路线、查地点和路线的结果），
//   画成卡片类型 map（card.ts，数据契约：停用也认得）；查地点、算路线的结果按编号经 GET /api/map/drawing 取（drawing.ts，只在内存里）。
//   移除并连数据删时地图卡片的每个版本也删掉。
// 432 加了查地点、算路线（高德 Web 服务）：
// - 数据源"高德地图"有了"按需查"（默认开）：给秘书五个工具（lookup-tools.ts：搜地点、算路线、地址 → 位置、某处 → 地址，
//   看常去的地方），内核只在按需查开着、插件在运行、连着时给；"现在能查到的"（live）是设置里的"试查一下"（try-lookup.ts）；
// - "家""公司"取手机插件的常去的地方、"附近"取手机最近交来的一个位置点（可选依赖 wants PHONE：手机插件没启用时工具如实说用不了）；
//   只在用户问的时候把那一两个点发给高德，每天的轨迹、照片地点不发；
// - 结果只现查、不存、不进记忆素材；能画的那一份只在内存里留一会儿（lookup-results.ts，给 431）；
// - 每月的用量记在插件自己的存储（数据目录的 map/amap-usage.json），体检里接近个人档的免费量时提示（doctor.ts，接 409）；
// - 移除时"连数据删"多删插件自己的存储（用量）。
// 433 加了国外的查地点、算路线（OpenStreetMap 的免费服务：Nominatim、OSRM，不用 Key，osm-lookup.ts）：
// - 工具改成插件自己经 ctx.agent.tools.register 给秘书（插件在运行就有）：国内的点用高德、国外的用 OpenStreetMap，按点自动挑；
//   没填高德的 Key、关了它的按需查、Key 不认时国外照样能查，国内也改用 OpenStreetMap（结果里提一句店名和小路可能不全）；
// - 高德的"按需查"开关照样在数据源页上（usages.query.ownTools：内核不替它给工具），查国内的点之前经 KERNEL.dataSourceUsage 看它开没开；
// - OpenStreetMap 的规矩：每秒最多 1 次、带能认出二狗的 User-Agent、结果只在内存里缓存一天（停用时扔掉）、不做输入联想。
// 445 开了"地图服务"插槽（MAP_PROVIDERS，providers.ts）：高德、OpenStreetMap 改成按插槽登记的两家；别的插件 needs: [MAP_PROVIDERS]、
// 在 setup 里 ctx.effect(() => ctx.use(MAP_PROVIDERS).register(…)) 登记一家（管哪个区域、优先级、底图、查询、用量），停用、移除时撤掉，
// 退回下一家。每家写了用量的，体检的"地图"那一块多一项"<编号>-usage"（高德的照旧是 amap-usage）。地图插件停了，登记了的插件跟着停。
// 444 地图页的二狗：地图页右边的聊天窗、右下角的悬浮按钮里发的消息带地图上下文（MessageEnvelope.map），交给秘书时后面跟一段
// 看的是哪里、哪一天的足迹、哪张卡片（chat-note.ts，经 ctx.agent.notes 的输入附注；插件停用时没有这段）。
// 447 "在地图上看"：浏览里网页上选中地址点了它，网页经 POST /api/map/find 直接查一处（MAP_FIND，lookup-tools.ts 的 findPlace：
// 和秘书查地点同一套先后），放进能画的那一份，网页去地图页看（#/more/map/lookup/<编号>）。
// 451 聊天卡片的预览图（MAP_PREVIEW，preview.ts）：GET /api/map/preview 按卡片编号（或查到的编号）取出点和线，交给那一家的静态地图
// （插槽的 staticMap：高德、谷歌拿各自的 Key 去取），图原样转回、不缓存；地址里不放坐标。足迹也会画进地图公司的静态图（用户 11-09 定）。
import path from "node:path";
import { AMAP_SOURCE_ID, t } from "@ergo/protocol";
import type { DataSource } from "../data-sources/api.ts";
import { PHONE } from "../phone/api.ts";
import { type PluginDefinition, serviceKey } from "../plugins/host.ts";
import { KERNEL } from "../plugins/kernel.ts";
import type { AmapHosts } from "./amap.ts";
import { MAP, MAP_DAY, MAP_DRAWING, MAP_FIND, MAP_PLUGIN, MAP_PREVIEW, MAP_PROVIDERS, type MapProvider } from "./api.ts";
import { mapCardType } from "./card.ts";
import { mapChatNote } from "./chat-note.ts";
import { createMapDay, createMapLatest } from "./day.ts";
import { registerUsageDoctor } from "./doctor.ts";
import { createMapDrawings } from "./drawing.ts";
import type { OsmHosts } from "./osm-lookup.ts";
import { createMapPreview } from "./preview.ts";
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
   * 只给测试：换掉"画在地图上"的 lookup、GET /api/map/drawing 取的那几份（现取）。不写就是插件自己内存里的那一份
   * （查地点、算路线时放进去的 service.lookups，432 的 lookup-results.ts）
   */
  lookups?: () => MapLookups | undefined;
  /** OpenStreetMap 的 Nominatim、OSRM 的地址（测试换成本机的假服务） */
  osmHosts?: Partial<OsmHosts>;
  /** 去 Nominatim、OSRM 时两次之间至少隔多久（毫秒；默认每秒最多 1 次，测试可以调小） */
  osmIntervalMs?: number;
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
      return { tools: [t("map.tool.search"), t("map.tool.route"), t("map.tool.geocode"), t("map.tool.reverse"), t("map.tool.places"), t("map.tool.show")], cards: [t("map.plugin.card")], jobs: [] };
    },
    needs: [KERNEL.clock, KERNEL.layout, KERNEL.dataSourceSecrets, KERNEL.cards],
    // 我的足迹（430）的数据、常去的地方、手机最近的位置（432 查"从家到公司""附近"）在手机插件那里：可选，没有它地图照样能看、工具如实说用不了。
    // 数据源的用法开关（433）：查国内的点之前看高德的按需查开没开（没有这项服务时当开着）
    wants: [PHONE, KERNEL.dataSourceUsage],
    provides: [MAP, MAP_INTERNAL, MAP_DAY, MAP_DRAWING, MAP_PROVIDERS, MAP_FIND, MAP_PREVIEW],
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
        // 按需查（432）：让秘书用高德查国内的地点、路线；不导入。工具由插件自己给（433：国外不用高德也能查），这里只是开关
        usages: { query: { default: true, ownTools: true } },
        status: (c) => ctx.active(MAP_INTERNAL).amapStatus(c.secrets),
        configure: (values, c) => ctx.active(MAP_INTERNAL).configureAmap(values, c.secrets),
        // Key 不认（出错）后内核每小时叫一次，拿存着的再测
        recheck: (c) => ctx.active(MAP_INTERNAL).recheckAmap(c.secrets, c.signal),
        disconnect: () => ctx.active(MAP_INTERNAL).resetAmap(),
        // 试查一下（设置里那一块、数据源详情的"现在能查到的"）：搜一个固定的地点
        live: (_query, c) => ctx.active(MAP_INTERNAL).tryAmap(c.signal),
        get disconnectNote() {
          return t("map.source.disconnectNote");
        },
      };
      ctx.dataSources.register(source);
      // 聊天里的地图卡片（431）：出来就是已处理、没有动作，停用了也照样显示
      ctx.cardTypes.register(mapCardType());
      ctx.removal.declare({
        get deletes() {
          return [t("map.plugin.purge.keys"), t("map.plugin.purge.tiles"), t("map.plugin.purge.usage"), t("map.plugin.purge.cards")];
        },
        get keeps() {
          return [t("map.plugin.keep.chat")];
        },
        files: [SECRET_FILE, TILE_CACHE, MAP_DATA_DIR],
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
        ...(options.osmHosts === undefined ? {} : { osmHosts: options.osmHosts }),
        ...(options.osmIntervalMs === undefined ? {} : { osmIntervalMs: options.osmIntervalMs }),
        now: () => clock.now(),
        secrets: () => secrets.forSource(AMAP_SOURCE_ID),
        mapDir: path.join(layout.root, MAP_DATA_DIR),
        // 手机插件的常去的地方、最近一个位置点（现取：手机插件随时可能停）；只要这两样，不要轨迹
        myPlaces: () => {
          const phone = ctx.optional(PHONE);
          return phone === undefined ? undefined : { named: () => phone.namedPlaces(), latest: () => phone.latestPoint() };
        },
        // 高德的按需查开没开（现取：用户随时在数据源页上开关）
        amapQueryOn: () => ctx.optional(KERNEL.dataSourceUsage)?.on(AMAP_SOURCE_ID, "query") ?? true,
        log: (line) => ctx.log(line),
      });
      ctx.provide(MAP, service);
      ctx.provide(MAP_INTERNAL, service);
      // 查地点、算路线的五个工具给秘书（433：插件在运行就有；高德能不能用每次查时现看，不能用时国内也走 OpenStreetMap）
      ctx.agent.tools.register({ to: { agents: ["secretary"] }, tools: () => service.lookupTools() });
      // 地图服务插槽（445）：别的插件经它登记一家（交回撤销函数，它们交给自己的 ctx.effect）
      ctx.provide(MAP_PROVIDERS, { register: (provider) => service.providers.register(provider), list: () => service.providers.list() });
      // 体检：每家的用量（409 的插件体检项；插件宿主没有 ctx.doctor 时不登记）。高德的照旧是 amap-usage；别的插件登记、撤掉时跟着登记、撤掉
      const usageChecks = new Map<MapProvider, () => void>();
      const addUsage = (provider: MapProvider) => {
        if (provider.usage === undefined || usageChecks.has(provider)) return;
        const undo = registerUsageDoctor(ctx, provider.id, provider.usage);
        if (undo !== undefined) usageChecks.set(provider, undo);
      };
      for (const provider of service.providers.list()) addUsage(provider);
      ctx.effect(() =>
        service.providers.onChange((provider, change) => {
          if (change === "added") return addUsage(provider);
          usageChecks.get(provider)?.();
          usageChecks.delete(provider);
        }),
      );
      const day = createMapDay(() => ctx.optional(PHONE));
      // 地图页"回到我现在的位置"的退路（442）：手机最近交来的一个位置点，同样现取手机插件
      ctx.provide(MAP_DAY, { day, latest: createMapLatest(() => ctx.optional(PHONE)) });
      // 聊天里的地图卡片（431）：查地点、算路线（432 高德、433 OpenStreetMap）放在内存里的那一份按编号取；秘书的"画在地图上"
      const lookups = options.lookups ?? (() => service.lookups);
      ctx.provide(MAP_DRAWING, createMapDrawings(lookups));
      // "在地图上看"（447）：浏览里网页上选中的地址、地名直接查一处，放进上面那一份（POST /api/map/find）
      ctx.provide(MAP_FIND, { find: (text, signal) => service.findPlace(text, signal) });
      // 聊天卡片的预览图（451）：卡片编号取负载，交给那一家的静态地图（GET /api/map/preview）
      ctx.provide(MAP_PREVIEW, createMapPreview({ cards: ctx.use(KERNEL.cards), day, lookups, providers: service.providers }));
      // 插件停了、秘书还没按新的贡献重新装配的那一会儿再调：插件宿主替它回"地图插件没启用"，不出卡
      const tool = showOnMapTool({ day, lookups, cards: ctx.use(KERNEL.cards) });
      ctx.agent.tools.register({ to: { agents: ["secretary"] }, tools: () => [tool] });
      // 地图页的二狗（444）：地图页右边的聊天窗、右下角的悬浮按钮里发的消息后面那段地图上下文（看的是哪里、哪一天的足迹、哪张卡片）
      ctx.agent.notes.register({ to: { agents: ["secretary"] }, text: (message) => (message.speaker === "user" && message.map ? mapChatNote(message.map) : undefined) });
      // 停用时：排队等着取的瓦片不取了
      ctx.lifecycle({ stop: () => service.stop() });
    },
  };
}

export const mapPlugin: PluginDefinition = createMapPlugin();
