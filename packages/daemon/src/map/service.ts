// 地图插件的服务（429）：地图服务插槽（providers.ts）、给秘书的查地点和算路线工具（lookup-tools.ts）、查到的能画的那一份
// （lookup-results.ts，只在内存里）、"在地图上看"（447），和网关、GET /api/map/config 要的那几样。
// 455 起地图插件只管地图本身，不认识任何一家地图服务：OpenStreetMap、高德、谷歌各是一个插件，经插槽登记进来（ADR-0061）。这里的
// 每一样都从登记表现算——
// - 网关的瓦片（/tiles/<编号>/…）转给编号对得上、登记了瓦片的那一家；网关的转发口（/_AMapService/…）转给 proxy.prefix 对得上的那一家；
//   一家都没有回 404 加一句"没接上"；
// - 给秘书的工具说明里讲"数据从哪来"的那一句：按优先级把各家的 toolNote 拼起来（登记的一变就重建一份工具，工具本身不存东西）；
//   查询的先后、手动选的那一家查不了时说的那句都由插槽管（providers.ts）；
// - GET /api/map/config 只有 providers（445 起页面按它挑底图、列地图切换；455 以前另给的高德 Key 不再给）。
import { type MapConfigView, type MapFindResult, t } from "@ergo/protocol";
import type { HostTool } from "../agent-manager/host-tools.ts";
import type { MapProvider, MapReply, MapService } from "./api.ts";
import { createLookupResults, type LookupResults } from "./lookup-results.ts";
import { findPlace, lookupTools, type MyPlaces } from "./lookup-tools.ts";
import type { LookupProvider, MapLookupFailure } from "./lookup.ts";
import { byPriority, createMapProviders, type MapProviderRegistry } from "./providers.ts";

/** 一家能查的都没有时，工具说明里讲数据从哪来的那句（给模型看的） */
const NO_SOURCES = "现在没有接上能查的地图服务（用户在 设置 · 插件 里把地图服务都停了），查不了时如实告诉用户"; // @i18n-ignore model

export interface MapServiceOptions {
  /** 现在（毫秒）：查到的那一份按它过期 */
  now: () => number;
  /** 常去的地方、手机最近的位置（手机插件给的，现取；手机插件没启用是 undefined） */
  myPlaces?: () => MyPlaces | undefined;
  log: (line: string) => void;
}

/** 插件内部用的：网关、接口用的那几样，加上工具、查到的那一份、插槽的登记表 */
export interface MapPluginService extends MapService {
  /** 给秘书的查地点、算路线工具（插件自己登记；按登记了的几家挑，433、445） */
  lookupTools(): readonly HostTool[];
  /** 查到的能画的那一份（只在内存里；431 的"画在地图上"按编号取） */
  readonly lookups: LookupResults;
  /** "在地图上看"（447）：网页上选中的地址、地名直接查一处，放进 lookups，交回编号；没查到交回给人看的一句 */
  findPlace(text: string, signal?: AbortSignal): Promise<MapFindResult>;
  /** 地图服务插槽的登记表（445）：插件经 MAP_PROVIDERS 交给地图服务插件 */
  readonly providers: MapProviderRegistry;
  stop(): void;
}

/** 给浏览器的一句纯文字（没接上、没有这一家） */
function plain(status: number, body: string): MapReply {
  return { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }, body: Buffer.from(`${body}\n`, "utf8") };
}

/** 给模型看的名字：写了 modelName 用它，不然编号 */
export const modelNameOf = (p: Pick<MapProvider, "id" | "modelName">): string => p.modelName ?? p.id;

export function createMapService(options: MapServiceOptions): MapPluginService {
  const lookups = createLookupResults({ now: options.now });
  // 地图服务插槽（445）：地图服务插件经 MAP_PROVIDERS 登记，"自动"时按优先级挑
  const providers = createMapProviders({ log: options.log });
  /** 给工具的几家：此刻能查的、排好先后（map 是地图上手动选的那一家） */
  const lookupProviders = (map?: string): readonly LookupProvider[] => providers.lookups(map);
  // 工具说明里讲数据从哪来的那句、map 参数里举的编号跟着登记的几家变：登记的一变就重建一份（工具本身不存东西）
  let built: { signature: string; tools: readonly HostTool[] } | undefined;
  const currentTools = (): readonly HostTool[] => {
    const all = byPriority(providers.list());
    const signature = all.map((p) => `${p.id}:${modelNameOf(p)}:${p.toolNote ?? ""}`).join("|");
    if (built?.signature === signature) return built.tools;
    const notes = all.flatMap((p) => (p.toolNote === undefined ? [] : [p.toolNote]));
    const tools = lookupTools({
      providers: lookupProviders,
      chosenNote: (map, used) => providers.chosenNote(map, used),
      sources: notes.length === 0 ? NO_SOURCES : notes.join("；"), // @i18n-ignore model
      mapNames: all.map((p) => `${p.id} ${modelNameOf(p)}`).join("、"), // @i18n-ignore model
      myPlaces: () => options.myPlaces?.(),
      results: lookups,
      now: options.now,
    });
    built = { signature, tools };
    return tools;
  };
  return {
    config(): MapConfigView {
      return { providers: providers.views() };
    },
    providerViews: () => providers.views(),
    basemapEvent: (body) => {
      const provider = providers.list().find((p) => p.id === body.provider);
      if (provider?.basemapEvent === undefined) return { known: false };
      provider.basemapEvent(body.event);
      return { known: true };
    },
    tile: (address, signal) => {
      const tiles = providers.list().find((p) => p.id === address.source)?.tiles;
      return tiles === undefined ? Promise.resolve(plain(404, t("map.proxy.notConnected"))) : tiles.get(address, signal);
    },
    proxy: (pathname, search, signal, userAgent) => {
      const proxy = providers
        .list()
        .flatMap((p) => (p.proxy === undefined ? [] : [p.proxy]))
        .find((x) => pathname === x.prefix || pathname.startsWith(`${x.prefix}/`));
      if (proxy === undefined) return Promise.resolve(plain(404, t("map.proxy.notConnected")));
      const sub = pathname.slice(proxy.prefix.length);
      return proxy.serve(sub === "" ? "/" : sub, search, signal, userAgent);
    },
    lookupTools: currentTools,
    findPlace: async (text, signal) => {
      const outcome = await findPlace({ providers: () => lookupProviders(), myPlaces: () => options.myPlaces?.(), results: lookups, now: options.now }, text, signal);
      if (outcome.found) return { ok: true, lookup: outcome.lookup, source: outcome.source, kind: outcome.kind, title: outcome.title };
      return { ok: false, reason: mapFindProblem(outcome, text, (id) => providers.list().find((p) => p.id === id)?.title ?? id) };
    },
    lookups,
    providers,
    stop: () => {
      lookups.clear();
    },
  };
}

/** "在地图上看"没查到时给人看的一句：最该问的那家没问成（没 Key、到上限、连不上……）照它说，只是没找到的说没找到 */
export function mapFindProblem(outcome: { provider?: string; failure?: MapLookupFailure; detail?: string }, text: string, titleOf: (id: string) => string): string {
  const shown = text.replace(/\s+/g, " ").trim().slice(0, 40);
  if (outcome.provider === undefined || outcome.failure === undefined) return t("map.find.notFound", { text: shown });
  const source = titleOf(outcome.provider);
  const detail = outcome.detail ?? "";
  if (outcome.failure === "quota" || outcome.failure === "rate") return t("map.find.busy", { source });
  if (outcome.failure === "network" || outcome.failure === "server") return t("map.find.unreachable", { source });
  if (outcome.failure === "no_key" || outcome.failure === "key" || outcome.failure === "denied") return t("map.find.key", { source });
  return t("map.find.failed", { source, detail });
}
