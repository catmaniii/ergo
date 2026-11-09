// 地图服务插槽（445）的登记表和挑法：地图插件建一份，自己登记高德、OpenStreetMap 两家，再经 MAP_PROVIDERS 交给别的插件登记。
// - 登记（register）：编号写法对（MAP_PROVIDER_ID）、不和已有的重；交回撤销函数（别的插件交给 ctx.effect：停用、移除时撤掉）；
//   登记、撤掉时叫 onChange（地图插件据此登记、撤掉那一家的用量体检项）；
// - 给页面的（views）：GET /api/map/config 的 providers——管哪儿、优先级、底图现在能不能用、浏览器用的 Key、能不能查；
// - 给查询工具的（lookups）：此刻能查的几家，"自动"时优先级大的在前（同样大的按登记的先后）；每家的 covers 按它登记的区域收窄
//   （高德本来就只管大陆，OpenStreetMap 哪儿都管）。地图上手动选了某一家（工具的 map 参数）时它排最前、多管它手动能用的区域；
//   它查不了、管不了这几处时照"自动"挑，工具在回答里说一句（chosenNote）；
// - 包出来的 LookupProvider 按（哪一家、哪几个区域、里面那一份）记着，同一个组合每次交回同一个对象（工具里按对象认是不是同一家）。
// 451：查询管的区域可以和底图不一样（lookupRegions：高德的底图国外也能用，查询只管大陆）；给页面的多了按区域的优先级（regionPriority）
// 和能不能出静态地图（preview：聊天卡片的预览图）。
import { MAP_PROVIDER_ID, type MapProviderView, type MapRegion, mapRegionOf } from "@ergo/protocol";
import type { MapProvider, MapProviders } from "./api.ts";
import type { LookupProvider } from "./lookup.ts";

/** 登记表：插槽那两样，加上地图插件自己用的 */
export interface MapProviderRegistry extends MapProviders {
  /** 给页面的那一份（GET /api/map/config 的 providers），按登记的先后 */
  views(): MapProviderView[];
  /** 给查询工具的：此刻能查的几家排好先后（map 是地图上手动选的那一家，不写按"自动"） */
  lookups(map?: string): LookupProvider[];
  /** 地图上选的是 map、这几处实际用了 used 查：要在回答里说的那一句（给模型的）；用的就是它、或者不用说时 undefined */
  chosenNote(map: string, used: LookupProvider): string | undefined;
  /** 登记、撤掉一家时叫（交回取消订阅） */
  onChange(listener: (provider: MapProvider, change: "added" | "removed") => void): () => void;
}

/** 手动选它时能用的区域（不写同 regions） */
export const manualRegionsOf = (p: Pick<MapProvider, "regions" | "manualRegions">): readonly MapRegion[] => p.manualRegions ?? p.regions;

/** "自动"时查询管哪几个区域（451：不写 lookupRegions 同 regions） */
const autoLookupRegionsOf = (p: Pick<MapProvider, "regions" | "lookupRegions">): readonly MapRegion[] => p.lookupRegions ?? p.regions;

/** 地图上手动选了它时查询管哪几个区域：写了 lookupRegions 只管那些，不写是 regions 加上 manualRegions */
const chosenLookupRegionsOf = (p: Pick<MapProvider, "regions" | "manualRegions" | "lookupRegions">): readonly MapRegion[] => p.lookupRegions ?? [...new Set([...manualRegionsOf(p), ...p.regions])];

/** "自动"时的先后：优先级大的在前，一样大的按登记的先后（toSorted 是稳定的） */
export const byPriority = <T extends Pick<MapProvider, "priority">>(list: readonly T[]): T[] => list.toSorted((a, b) => b.priority - a.priority);

/** 此刻能查的那一份（查不了是 undefined） */
function lookupOf(p: MapProvider): LookupProvider | undefined {
  const state = p.lookup?.();
  return state?.ready ? state.provider : undefined;
}

/** 区域的中文（给模型看的） */
const REGION_WORD: Readonly<Record<MapRegion, string>> = { mainland: "中国大陆", abroad: "大陆以外" }; // @i18n-ignore model

export function createMapProviders(options: { log?: (line: string) => void } = {}): MapProviderRegistry {
  const list: MapProvider[] = [];
  const listeners = new Set<(provider: MapProvider, change: "added" | "removed") => void>();
  const notify = (provider: MapProvider, change: "added" | "removed") => {
    for (const fn of listeners) {
      try {
        fn(provider, change);
      } catch (err) {
        options.log?.(`地图服务插槽：通知出错：${err instanceof Error ? err.message : String(err)}`); // @i18n-ignore log
      }
    }
  };
  /** 包好的查询那一半：键是 编号|区域|，值记着里面那一份（换了就重包） */
  const wrapped = new Map<string, { inner: LookupProvider; outer: LookupProvider }>();
  const wrap = (provider: MapProvider, inner: LookupProvider, regions: readonly MapRegion[]): LookupProvider => {
    const key = `${provider.id}|${regions.join(",")}`;
    const kept = wrapped.get(key);
    if (kept?.inner === inner) return kept.outer;
    // 一样一样转过去（不展开对象：里面那一份可能是类，方法靠 this）
    const outer: LookupProvider = {
      id: provider.id,
      regions,
      get name() {
        return inner.name;
      },
      get credit() {
        return inner.credit;
      },
      routeModes: inner.routeModes,
      defaultModes: inner.defaultModes,
      liveTraffic: inner.liveTraffic,
      browsesNearby: inner.browsesNearby,
      covers: (p) => regions.includes(mapRegionOf(p)) && inner.covers(p),
      ...(inner.coverageNote === undefined ? {} : { coverageNote: (p) => inner.coverageNote?.(p) }),
      ...(inner.explain === undefined ? {} : { explain: (err) => inner.explain?.(err) }),
      searchText: (q, signal) => inner.searchText(q, signal),
      searchNear: (q, signal) => inner.searchNear(q, signal),
      geocode: (q, signal) => inner.geocode(q, signal),
      reverse: (p, signal) => inner.reverse(p, signal),
      route: (q, signal) => inner.route(q, signal),
    };
    wrapped.set(key, { inner, outer });
    return outer;
  };
  const find = (id: string) => list.find((p) => p.id === id);
  return {
    register(provider) {
      if (!MAP_PROVIDER_ID.test(provider.id)) throw new Error(`地图服务的编号写法不对：${provider.id}`); // @i18n-ignore log：编程错误
      if (find(provider.id)) throw new Error(`地图服务 ${provider.id} 已经登记过了`); // @i18n-ignore log：编程错误
      if (provider.regions.length === 0 && manualRegionsOf(provider).length === 0) throw new Error(`地图服务 ${provider.id} 一个区域都不管`); // @i18n-ignore log：编程错误
      list.push(provider);
      notify(provider, "added");
      return () => {
        const at = list.indexOf(provider);
        if (at < 0) return;
        list.splice(at, 1);
        for (const key of wrapped.keys()) if (key.startsWith(`${provider.id}|`)) wrapped.delete(key);
        notify(provider, "removed");
      };
    },
    list: () => [...list],
    views: () =>
      list.map((p) => {
        const basemap = p.basemap?.();
        return {
          id: p.id,
          title: p.title,
          regions: [...p.regions],
          manualRegions: [...manualRegionsOf(p)],
          priority: p.priority,
          ownBasemapOnly: p.ownBasemapOnly,
          basemap: basemap !== undefined,
          ready: basemap?.ready === true,
          ...(basemap?.ready && basemap.key !== undefined ? { key: basemap.key } : {}),
          ...(basemap !== undefined && !basemap.ready && basemap.problem !== undefined ? { problem: basemap.problem } : {}),
          lookup: lookupOf(p) !== undefined,
          ...(p.regionPriority === undefined ? {} : { regionPriority: { ...p.regionPriority } }),
          preview: p.staticMap !== undefined,
        };
      }),
    lookups(map) {
      const auto = byPriority(list).flatMap((p) => {
        const inner = lookupOf(p);
        const regions = autoLookupRegionsOf(p);
        return inner === undefined || regions.length === 0 ? [] : [wrap(p, inner, regions)];
      });
      const chosen = map === undefined ? undefined : find(map);
      const inner = chosen === undefined ? undefined : lookupOf(chosen);
      if (chosen === undefined || inner === undefined) return auto;
      // 手动选的那一家排最前、多管它手动能用的区域（写了 lookupRegions 的只管那些）；它照常还在后面按"自动"的先后（管不到的地方轮不到它，不碍事）
      const first = wrap(chosen, inner, chosenLookupRegionsOf(chosen));
      return [first, ...auto.filter((p) => p !== first)];
    },
    chosenNote(map, used) {
      if (used.id === map) return undefined;
      const chosen = find(map);
      if (chosen === undefined) return `（地图上选的「${map}」现在没接上，按自动挑的：用${used.name}查的。）`; // @i18n-ignore model
      const state = chosen.lookup?.();
      if (state === undefined) return `（地图上用的是${chosen.title}，它只有底图、不查地点，这里用${used.name}查的。）`; // @i18n-ignore model
      if (!state.ready) return `（地图上用的是${chosen.title}，它现在查不了（${state.why}），这里用${used.name}查的。）`; // @i18n-ignore model
      const regions = chosenLookupRegionsOf(chosen);
      const outside = (["mainland", "abroad"] as const).filter((r) => !regions.includes(r)).map((r) => REGION_WORD[r]);
      return `（地图上用的是${chosen.title}，它不管${outside.join("、") || "这里"}，这里用${used.name}查的。）`; // @i18n-ignore model
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
