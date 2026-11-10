// 地图插件（429，调研 2026-11-07-maps）：二狗里能看地图。455 起它只管地图本身，不认识任何一家地图服务（ADR-0061）：
// OpenStreetMap、高德地图、谷歌地图各是一个插件（openstreetmap、amap、google-maps），都 needs 这里的"地图服务"插槽（MAP_PROVIDERS），
// 在 setup 里登记一家；停用、移除时宿主替它撤掉，地图页、秘书的查询退回下一家，一家都没有时地图页说"没有能用的地图"。
// - 数据契约（不管插件开没开都登记，停用也认得）：聊天里的地图卡片（卡片类型 map，431）；移除时"连数据删"删地图卡片的每个版本。
//   Key、用量、瓦片缓存都在各家的插件名下（455 以前高德的 Key 和用量、OpenStreetMap 的瓦片缓存在这里）。
// - 装配：提供地图服务（service.ts）给网关和接口——/tiles/<编号>/… 转给登记了瓦片的那一家、/_AMapService/ 这类转发口转给登记了它的那一家、
//   GET /api/map/config（登记了的几家）、POST /api/map/basemap（地图页报一家底图的事，转给那一家）。
// - 网页那一半（packages/web/src/plugins/map/）：地图页（#/more/map）、地图切换、聊天里的地图卡片。
// - 停用时：页面、接口写"地图插件没启用"；登记进插槽的几家跟着停（宿主的 needs 规矩），再启用地图插件时它们要各自再启用。
// - 我的足迹（430，day.ts）：GET /api/map/day 某一天的点、停留、照片地点、常去的地方，经"手机"插件的服务现算（可选依赖 wants：
//   手机插件没启用时那一句写"手机插件没启用"，地图照样能看）；接口本身不联网。451 起底图是当前地图；453 起足迹、点和线只在
//   网页上自己画（地图页盖在底图上面的那一层、卡片预览图上面那一层），聊天卡片的静态预览图只向地图公司要光底图（ADR-0059 的 453 修订）。
//   GET /api/map/latest（442）手机最近交来的一个位置点：地图页"回到我现在的位置"在这台设备定不了位时的退路。
// - 聊天里的地图卡片（431）：给秘书的"画在地图上"（show-on-map.ts：某一天的足迹、一组点、一条路线、查地点和路线的结果），
//   画成卡片类型 map（card.ts，数据契约：停用也认得）；查地点、算路线的结果按编号经 GET /api/map/drawing 取（drawing.ts，只在内存里）。
// - 查地点、算路线（432、433）：给秘书五个工具（lookup-tools.ts：搜地点、算路线、地址 → 位置、某处 → 地址，看常去的地方），插件在运行就有；
//   哪一家查由插槽按登记了的几家挑（providers.ts：国内的点先问管国内、优先级大的那家……），一家都没有时工具如实说查不了。
//   "家""公司"取手机插件的常去的地方、"附近"取手机最近交来的一个位置点（可选依赖 wants PHONE：手机插件没启用时工具如实说用不了）；
//   只在用户问的时候把那一两个点发给地图服务，每天的轨迹、照片地点不发；结果只现查、不存、不进记忆素材；能画的那一份只在内存里留一会儿。
// - 体检：每家写了用量的（MapProvider.usage），体检的"地图"那一块多一项"<编号>-usage"（doctor.ts）；那一家撤掉时跟着撤。
// 444 地图页的二狗：地图页右边的聊天窗、右下角的悬浮按钮里发的消息带地图上下文（MessageEnvelope.map），交给秘书时后面跟一段
// 看的是哪里、哪一天的足迹、哪张卡片（chat-note.ts，经 ctx.agent.notes 的输入附注；插件停用时没有这段）。
// 447 "在地图上看"：浏览里网页上选中地址点了它，网页经 POST /api/map/find 直接查一处（MAP_FIND，lookup-tools.ts 的 findPlace：
// 和秘书查地点同一套先后），放进能画的那一份，网页去地图页看（#/more/map/lookup/<编号>）。
// 451 聊天卡片的预览图（MAP_PREVIEW，preview.ts）：GET /api/map/preview 按卡片编号（或查到的编号）取出点和线、算好视野，交给那一家的
// 静态地图（插槽的 staticMap）只要光底图，图原样转回、不缓存；地址里不放坐标。
import { t } from "@ergo/protocol";
import { PHONE } from "../phone/api.ts";
import type { PluginDefinition } from "../plugins/host.ts";
import { KERNEL } from "../plugins/kernel.ts";
import { MAP, MAP_DAY, MAP_DRAWING, MAP_FIND, MAP_PLUGIN, MAP_PREVIEW, MAP_PROVIDERS, type MapProvider } from "./api.ts";
import { mapCardType } from "./card.ts";
import { mapChatNote } from "./chat-note.ts";
import { createMapDay, createMapLatest } from "./day.ts";
import { registerUsageDoctor } from "./doctor.ts";
import { createMapDrawings } from "./drawing.ts";
import { createMapPreview } from "./preview.ts";
import { createMapService, modelNameOf } from "./service.ts";
import { type MapLookups, showOnMapTool } from "./show-on-map.ts";

export interface MapPluginOptions {
  /**
   * 只给测试：换掉"画在地图上"的 lookup、GET /api/map/drawing 取的那几份（现取）。不写就是插件自己内存里的那一份
   * （查地点、算路线时放进去的 service.lookups，432 的 lookup-results.ts）
   */
  lookups?: () => MapLookups | undefined;
}

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
    needs: [KERNEL.clock, KERNEL.cards],
    // 我的足迹（430）的数据、常去的地方、手机最近的位置（432 查"从家到公司""附近"）在手机插件那里：可选，没有它地图照样能看、工具如实说用不了
    wants: [PHONE],
    provides: [MAP, MAP_DAY, MAP_DRAWING, MAP_PROVIDERS, MAP_FIND, MAP_PREVIEW],
    contracts(ctx) {
      // 聊天里的地图卡片（431）：出来就是已处理、没有动作，停用了也照样显示
      ctx.cardTypes.register(mapCardType());
      ctx.removal.declare({
        get deletes() {
          return [t("map.plugin.purge.cards")];
        },
        get keeps() {
          return [t("map.plugin.keep.chat")];
        },
        cardTypes: ["map"],
      });
    },
    setup(ctx) {
      const clock = ctx.use(KERNEL.clock);
      const service = createMapService({
        now: () => clock.now(),
        // 手机插件的常去的地方、最近一个位置点（现取：手机插件随时可能停）；只要这两样，不要轨迹
        myPlaces: () => {
          const phone = ctx.optional(PHONE);
          return phone === undefined ? undefined : { named: () => phone.namedPlaces(), latest: () => phone.latestPoint() };
        },
        log: (line) => ctx.log(line),
      });
      ctx.provide(MAP, service);
      // 查地点、算路线的五个工具给秘书（433：插件在运行就有；哪一家能用每次查时现看）
      ctx.agent.tools.register({ to: { agents: ["secretary"] }, tools: () => service.lookupTools() });
      // 地图服务插槽（445）：地图服务插件经它登记一家（交回撤销函数，它们交给自己的 ctx.effect）
      ctx.provide(MAP_PROVIDERS, { register: (provider) => service.providers.register(provider), list: () => service.providers.list() });
      // 体检：每家的用量（409 的插件体检项；插件宿主没有 ctx.doctor 时不登记）。登记、撤掉一家时跟着登记、撤掉
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
      // 聊天里的地图卡片（431）：查地点、算路线放在内存里的那一份按编号取；秘书的"画在地图上"
      const lookups = options.lookups ?? (() => service.lookups);
      ctx.provide(MAP_DRAWING, createMapDrawings(lookups));
      // "在地图上看"（447）：浏览里网页上选中的地址、地名直接查一处，放进上面那一份（POST /api/map/find）
      ctx.provide(MAP_FIND, { find: (text, signal) => service.findPlace(text, signal) });
      // 聊天卡片的预览图（451）：卡片编号取负载，交给那一家的静态地图（GET /api/map/preview）
      ctx.provide(MAP_PREVIEW, createMapPreview({ cards: ctx.use(KERNEL.cards), day, lookups, providers: service.providers }));
      // 插件停了、秘书还没按新的贡献重新装配的那一会儿再调：插件宿主替它回"地图插件没启用"，不出卡
      const tool = showOnMapTool({ day, lookups, cards: ctx.use(KERNEL.cards) });
      ctx.agent.tools.register({ to: { agents: ["secretary"] }, tools: () => [tool] });
      // 地图页的二狗（444）：地图页右边的聊天窗、右下角的悬浮按钮里发的消息后面那段地图上下文（看的是哪里、哪一天的足迹、哪张卡片）；
      // 底图的名字由登记那一家的插件给
      const nameOf = (id: string) => {
        const provider = service.providers.list().find((p) => p.id === id);
        return provider === undefined ? undefined : modelNameOf(provider);
      };
      ctx.agent.notes.register({ to: { agents: ["secretary"] }, text: (message) => (message.speaker === "user" && message.map ? mapChatNote(message.map, nameOf) : undefined) });
      // 停用时：查到的那一份扔掉
      ctx.lifecycle({ stop: () => service.stop() });
    },
  };
}

export const mapPlugin: PluginDefinition = createMapPlugin();
