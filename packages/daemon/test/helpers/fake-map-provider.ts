// 测试用的假"第三家"地图服务（445）：一个只给测试的插件 fake-world-map，照插件契约 needs: [MAP_PROVIDERS]，在 setup 里经 ctx.effect
// 登记一家 worldmap——大陆外、优先级 50（高于 OpenStreetMap 的 0），手动选它时大陆也能用；底图要浏览器用的 Key（写在选项里），
// 查询是内存里的假数据（不联网，记下每一次问了什么），每月用量一项（体检）。停用、移除时撤掉，地图插件退回下一家。
// 照着它写真的第三家（446 谷歌地图）：区域、优先级、底图、查询、用量都经 map/api.ts 的 MapProvider 交出去。
import type { LatLon } from "@ergo/protocol";
import { type LookupProvider, MAP_PROVIDERS, type MapLookupError, type MapProvider, type PlaceHit, type RouteAnswer } from "../../src/map/api.ts";
import type { PluginDefinition } from "../../src/plugins/host.ts";

/** 假地图服务的编号、插件名 */
export const FAKE_WORLD_MAP = "worldmap";
export const FAKE_WORLD_MAP_PLUGIN = "fake-world-map";
/** 假的浏览器用的 Key（会进页面的那一种） */
export const FAKE_WORLD_MAP_BROWSER_KEY = "fake-worldmap-browser-key";

export interface FakeWorldMapState {
  /** 底图能不能用（false：没填 Key） */
  basemap: boolean;
  /** 查询能不能用（false：没填查询用的 Key） */
  lookup: boolean;
  /** 问过的（哪一种、哪几个点） */
  readonly asked: Array<{ kind: "searchText" | "searchNear" | "geocode" | "reverse" | "route"; points: LatLon[] }>;
  /** 下一次查时抛的错 */
  fail?: MapLookupError | undefined;
}

/** 假的一个地点 */
const hit = (name: string, p: LatLon, extra: Partial<PlaceHit> = {}): PlaceHit => ({ name, lat: p.lat, lon: p.lon, area: "World", ...extra });

/** 假的查询：哪儿都答得上（管不管由插槽按登记的区域定），坐标原样进出 */
function fakeLookup(state: FakeWorldMapState): LookupProvider {
  const asked = (kind: FakeWorldMapState["asked"][number]["kind"], points: LatLon[]) => {
    state.asked.push({ kind, points });
    const err = state.fail;
    state.fail = undefined;
    if (err) throw err;
  };
  return {
    id: FAKE_WORLD_MAP,
    name: "假世界地图",
    credit: "数据来自假世界地图（测试用），现查的，没存",
    routeModes: ["driving", "transit", "walking"],
    defaultModes: ["driving", "transit"],
    liveTraffic: true,
    browsesNearby: true,
    covers: () => true,
    async searchText(q) {
      const near = q.near ?? { lat: 1.29, lon: 103.85 };
      asked("searchText", q.near ? [q.near] : []);
      return [hit(`${q.keyword}（假世界地图）`, { lat: near.lat + 0.001, lon: near.lon + 0.001 })];
    },
    async searchNear(q) {
      asked("searchNear", [q.center]);
      return [hit(`附近的${q.keyword ?? "地方"}（假世界地图）`, { lat: q.center.lat + 0.001, lon: q.center.lon }, { distanceM: 120 })];
    },
    async geocode(q) {
      asked("geocode", q.near ? [q.near] : []);
      return [hit(q.address, q.near ?? { lat: 1.3, lon: 103.8 }, { level: "门牌号" })];
    },
    async reverse(p) {
      asked("reverse", [p]);
      return hit("假世界地图上的一处地址", p);
    },
    async route(q): Promise<RouteAnswer> {
      asked("route", [q.from, q.to]);
      const line = [q.from, q.to];
      if (q.mode === "transit") return { mode: "transit", plans: [{ durationS: 1800, distanceM: 6000, walkingM: 400, legs: [{ kind: "ride", name: "假地铁 1 号线", from: "甲站", to: "乙站", stops: 5, subway: true }], line }] };
      if (q.mode === "walking") return { mode: "walking", durationS: 3600, distanceM: 4000, line };
      return { mode: "driving", durationS: 900, distanceM: 7000, traffic: [], line };
    },
  };
}

/** 假的第三家：插件（测试里 extraPlugins / plugins 放进去）和它的状态 */
export function fakeWorldMapPlugin(initial: Partial<Pick<FakeWorldMapState, "basemap" | "lookup">> = {}): { plugin: PluginDefinition; state: FakeWorldMapState; provider: MapProvider } {
  const state: FakeWorldMapState = { basemap: initial.basemap ?? true, lookup: initial.lookup ?? true, asked: [] };
  const lookup = fakeLookup(state);
  const provider: MapProvider = {
    id: FAKE_WORLD_MAP,
    title: "假世界地图",
    regions: ["abroad"],
    manualRegions: ["abroad", "mainland"],
    priority: 50,
    ownBasemapOnly: true,
    basemap: () => (state.basemap ? { ready: true, key: FAKE_WORLD_MAP_BROWSER_KEY } : { ready: false }),
    lookup: () => (state.lookup ? { ready: true, provider: lookup } : { ready: false, why: "没填查询用的 Key" }),
    toolNote: "大陆以外优先用假世界地图（测试用）",
    usage: { title: "amap.doctor.usage.title", run: () => ({ level: "ok", fact: { key: "amap.doctor.usage.ok", params: { month: "2026-11", search: 1, searchLimit: 10, lbs: 1, lbsLimit: 10 } } }) },
  };
  const plugin: PluginDefinition = {
    name: FAKE_WORLD_MAP_PLUGIN,
    title: "假世界地图",
    needs: [MAP_PROVIDERS],
    setup(ctx) {
      const slot = ctx.use(MAP_PROVIDERS);
      ctx.effect(() => slot.register(provider));
    },
  };
  return { plugin, state, provider };
}
