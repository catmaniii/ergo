// 地图服务插槽的网页一半（445）：Node 里能测的那部分——
// - 几家从哪来：守护进程报的 providers；旧的守护进程只给 amapKey 时当只有高德、OpenStreetMap 两家（挑法和 429 一样）；
// - "自动"：管这个区域、用得了的里优先级最大的（接进来一个测试用的假"第三家"worldmap：大陆外 50，手动时大陆也能用）；
// - 手动（这台设备按区域记的）：能选就用、选不了照自动、记着的那家用不了要退回；451 起看足迹也用当前地图；
// - 451：按区域的优先级（高德国外 30）、切换里"自动"会挑的排前面、点开别家查到的这一屏临时用那家、卡片挑哪家（cardBasemap）；
// - 地图切换列哪几家：手动能用在这个区域、有底图、Key 没坏、网页那一半在的，按优先级；加载失败的标出来；
// - 存着的手动切换坏了当"自动"；某一家查来的只画在它自己的底图上（OpenStreetMap 的哪儿都能画）；
// - 网页插件登记一种底图（mapBasemaps）：插件停用时那一条撤掉；地图插件自带的两种；
// - 地图切换的按钮：宽的写"地图：自动"，窄的是 ⋮；英文。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { WebPluginDefinition } from "../../src/plugins/api.ts";
import { createWebPluginHost } from "../../src/plugins/host.ts";
import { WEB_PLUGIN_MANIFEST } from "../../src/plugins/manifest.ts";
import { ownBasemapShow, ownMapOnly } from "../../src/plugins/map/own-results.ts";
import { drawingContent } from "../../src/plugins/map/card-scene.ts";
import { MapSwitch, MapSwitchItems, type BasemapSwitch } from "../../src/plugins/map/MapSwitch.tsx";
import {
  autoBasemap,
  type BasemapPage,
  cardBasemap,
  choiceBroken,
  EVERY_BASEMAP,
  lookupBasemap,
  noMapReason,
  ownBasemapOf,
  parseMapChoice,
  pickBasemap,
  previewable,
  priorityIn,
  providersOf,
  selectable,
  switchEntries,
  withChoice,
} from "../../src/plugins/map/providers.ts";
import { demoMapProviders } from "../../src/prototype/fake-map.ts";
import { activeLocale, activeLocaleFrom, type MapProviderView, setActiveLocale } from "../../src/state/index.ts";
import { TEST_LOCALES } from "../setup-locales.ts";

vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

const zh = activeLocale();
afterEach(() => setActiveLocale(zh));

const provider = (id: string, over: Partial<MapProviderView> = {}): MapProviderView => ({
  id,
  title: id,
  regions: ["abroad"],
  manualRegions: ["abroad"],
  priority: 0,
  ownBasemapOnly: true,
  basemap: true,
  ready: true,
  lookup: true,
  ...over,
});
/** 守护进程报的三家：自带两家加上测试用的假"第三家" */
const AMAP = provider("amap", { regions: ["mainland"], manualRegions: ["mainland"], priority: 100, key: "k" });
const OSM = provider("osm", { regions: ["mainland", "abroad"], manualRegions: ["mainland", "abroad"], ownBasemapOnly: false });
const WORLD = provider("worldmap", { manualRegions: ["abroad", "mainland"], priority: 50, key: "w" });
const THREE = [AMAP, OSM, WORLD];
/** 这一页上：worldmap 的网页那一半在不在、加载失败了没有 */
const pageWith = (opts: { missing?: string[]; failed?: Record<string, string> } = {}): BasemapPage => ({ has: (id) => !(opts.missing ?? []).includes(id), failed: (id) => opts.failed?.[id] });

/** 卡片负载里查到的那一份（哪一家查的） */
const show = (source: string) => ({ kind: "lookup" as const, lookup: `${source}-p1`, what: "places" as const, source });

/** 地图切换要的（地图那块报上来的：国外，假第三家和 OpenStreetMap 能选） */
const sw = (choice: BasemapSwitch["choice"]): BasemapSwitch => ({
  choice,
  setChoice: () => {},
  report: () => {},
  status: { region: "abroad", rendered: "worldmap", auto: "worldmap", autoTitle: "假世界地图", options: [{ id: "worldmap", title: "假世界地图" }, { id: "osm", title: "OpenStreetMap" }] },
});

describe("几家从哪来", () => {
  test("守护进程报了 providers 就用它；没取到、没报是空的（455：去掉了旧守护进程只给 amapKey 时当两家的退路，地图插件不认得哪一家）", () => {
    expect(providersOf({ providers: THREE })).toBe(THREE);
    expect(providersOf(undefined)).toEqual([]);
    expect(providersOf({ amapKey: "k", amapProblem: "Key 不对" })).toEqual([]);
    expect(providersOf({})).toEqual([]);
  });
});

describe("用哪一家", () => {
  test("自动：大陆高德（用不了就 OpenStreetMap），大陆外按优先级——假第三家 50 高于 OpenStreetMap；它的网页一半不在、加载失败了就轮到下一家", () => {
    expect(autoBasemap("mainland", THREE, EVERY_BASEMAP)).toBe("amap");
    expect(autoBasemap("abroad", THREE, EVERY_BASEMAP)).toBe("worldmap");
    expect(autoBasemap("mainland", [{ ...AMAP, ready: false }, OSM, WORLD], EVERY_BASEMAP)).toBe("osm");
    expect(autoBasemap("mainland", THREE, pageWith({ failed: { amap: "timeout" } }))).toBe("osm");
    expect(autoBasemap("abroad", THREE, pageWith({ missing: ["worldmap"] }))).toBe("osm");
    expect(autoBasemap("abroad", THREE, pageWith({ failed: { worldmap: "script failed" } }))).toBe("osm");
    // 455：一家都没有（三家都停了）、都用不了：没有（地图页说没有能用的地图，卡片只有字）
    expect(autoBasemap("abroad", [], EVERY_BASEMAP)).toBeUndefined();
    expect(autoBasemap("mainland", [{ ...AMAP, ready: false }], EVERY_BASEMAP)).toBeUndefined();
    // 管这个区域的都用不了：退到在这个区域能手动选的（假第三家在大陆能手动选）
    expect(autoBasemap("mainland", [{ ...AMAP, ready: false }, WORLD], EVERY_BASEMAP)).toBe("worldmap");
    expect(pickBasemap({ region: "mainland", choice: "osm", providers: [], page: EVERY_BASEMAP })).toEqual({ wanted: undefined, auto: undefined, manual: false, current: undefined, temporary: false });
  });

  test("手动：能选就用（假第三家在大陆也能手动选），选不了照自动；451 起看足迹也用当前地图（手动选的或自动）", () => {
    expect(pickBasemap({ region: "mainland", choice: "worldmap", providers: THREE, page: EVERY_BASEMAP })).toEqual({ wanted: "worldmap", auto: "amap", manual: true, current: "worldmap", temporary: false });
    expect(pickBasemap({ region: "mainland", choice: "osm", providers: THREE, page: EVERY_BASEMAP })).toEqual({ wanted: "osm", auto: "amap", manual: true, current: "osm", temporary: false });
    expect(pickBasemap({ region: "abroad", choice: "osm", providers: THREE, page: EVERY_BASEMAP }).wanted).toBe("osm");
    // 这里的高德只管大陆（守护进程报的 manualRegions）：大陆外选不了，照自动
    expect(pickBasemap({ region: "abroad", choice: "amap", providers: THREE, page: EVERY_BASEMAP })).toEqual({ wanted: "worldmap", auto: "worldmap", manual: false, current: "worldmap", temporary: false });
    expect(pickBasemap({ region: "abroad", choice: "worldmap", providers: THREE, page: EVERY_BASEMAP, footprints: true }).wanted).toBe("worldmap");
    expect(pickBasemap({ region: "mainland", providers: THREE, page: EVERY_BASEMAP, footprints: true }).wanted).toBe("amap");
    expect(pickBasemap({ region: "mainland", choice: "osm", providers: THREE, page: EVERY_BASEMAP, footprints: true }).wanted).toBe("osm");
  });

  test("451 按区域的优先级：高德国外 30——国外 谷歌（50）> 高德 > OpenStreetMap；国内照旧高德；都没填 OpenStreetMap", () => {
    const amap = { ...AMAP, regions: ["mainland", "abroad"] as MapProviderView["regions"], manualRegions: ["mainland", "abroad"] as MapProviderView["manualRegions"], regionPriority: { abroad: 30 } };
    expect([priorityIn(amap, "mainland"), priorityIn(amap, "abroad"), priorityIn(WORLD, "abroad")]).toEqual([100, 30, 50]);
    expect(autoBasemap("abroad", [amap, OSM, WORLD], EVERY_BASEMAP)).toBe("worldmap");
    expect(autoBasemap("abroad", [amap, OSM], EVERY_BASEMAP)).toBe("amap");
    expect(autoBasemap("abroad", [amap, OSM, { ...WORLD, ready: false }], EVERY_BASEMAP)).toBe("amap");
    expect(autoBasemap("mainland", [amap, OSM, WORLD], EVERY_BASEMAP)).toBe("amap");
    expect(autoBasemap("abroad", [{ ...amap, ready: false }, OSM], EVERY_BASEMAP)).toBe("osm");
    expect(autoBasemap("mainland", [{ ...amap, ready: false }, OSM], EVERY_BASEMAP)).toBe("osm");
    // 高德这一页加载失败：国外退到 OpenStreetMap
    expect(autoBasemap("abroad", [amap, OSM], pageWith({ failed: { amap: "timeout" } }))).toBe("osm");
  });

  test("451 点开别家查到的：这一屏临时用查它的那家（不改记着的选择）；那家这里用不了照常挑", () => {
    expect(pickBasemap({ region: "mainland", choice: "osm", providers: THREE, page: EVERY_BASEMAP, temporary: "amap" })).toEqual({ wanted: "amap", auto: "amap", manual: false, current: "osm", temporary: true });
    // 本来就是它：不算临时
    expect(pickBasemap({ region: "mainland", providers: THREE, page: EVERY_BASEMAP, temporary: "amap" })).toEqual({ wanted: "amap", auto: "amap", manual: false, current: "amap", temporary: false });
    // 这里用不了它（不管这个区域、加载失败、Key 没填）：照常
    expect(pickBasemap({ region: "abroad", providers: THREE, page: EVERY_BASEMAP, temporary: "amap" }).wanted).toBe("worldmap");
    expect(pickBasemap({ region: "abroad", choice: "osm", providers: THREE, page: pageWith({ failed: { worldmap: "连不上" } }), temporary: "worldmap" })).toMatchObject({ wanted: "osm", temporary: false });
    expect(pickBasemap({ region: "mainland", providers: [{ ...AMAP, ready: false }, OSM, WORLD], page: EVERY_BASEMAP, temporary: "amap" }).wanted).toBe("osm");
  });

  test("记着的那一家用不了（Key 坏了、网页一半没了、加载失败、不管这个区域、没登记）要退回自动；自动、能用的不用退", () => {
    expect(choiceBroken("abroad", undefined, THREE, EVERY_BASEMAP)).toBe(false);
    expect(choiceBroken("abroad", "worldmap", THREE, EVERY_BASEMAP)).toBe(false);
    expect(choiceBroken("abroad", "worldmap", [AMAP, OSM, { ...WORLD, ready: false }], EVERY_BASEMAP)).toBe(true);
    expect(choiceBroken("abroad", "worldmap", THREE, pageWith({ missing: ["worldmap"] }))).toBe(true);
    expect(choiceBroken("mainland", "worldmap", THREE, pageWith({ failed: { worldmap: "script failed" } }))).toBe(true);
    expect(choiceBroken("abroad", "amap", THREE, EVERY_BASEMAP)).toBe(true);
    expect(choiceBroken("abroad", "nobody", THREE, EVERY_BASEMAP)).toBe(true);
    expect(selectable(OSM, "mainland", EVERY_BASEMAP)).toBe(true);
    expect(selectable({ ...OSM, basemap: false }, "mainland", EVERY_BASEMAP)).toBe(false);
  });
});

describe("交给秘书的地图编号（查询跟着它走）", () => {
  // 地图那块报上来的：国内开着足迹，底图一律 OpenStreetMap；"自动"会挑高德；能手动选的高德、假第三家、OpenStreetMap
  const mainland = { region: "mainland" as const, rendered: "osm", auto: "amap", options: [{ id: "amap" }, { id: "worldmap" }, { id: "osm" }] };
  test("没开足迹：就是真画着的那一家", () => {
    expect(lookupBasemap({ ...mainland, rendered: "amap" }, {}, false)).toBe("amap");
    expect(lookupBasemap({ ...mainland, rendered: "osm" }, { mainland: "osm" }, false)).toBe("osm");
  });

  test("开着足迹（451 起底图就是当前地图）：也写真画着的那一家", () => {
    expect(lookupBasemap({ ...mainland, rendered: "amap" }, {}, true)).toBe("amap");
    expect(lookupBasemap({ ...mainland, rendered: "worldmap" }, { mainland: "worldmap" }, true)).toBe("worldmap");
    expect(lookupBasemap({ ...mainland, rendered: "osm" }, { mainland: "osm" }, true)).toBe("osm");
  });

  test("合了 446：国外填了谷歌的 Key，画着谷歌就写 google（开不开足迹一样），选了 OpenStreetMap 写 osm", () => {
    const abroad = { region: "abroad" as const, rendered: "google", auto: "google", options: [{ id: "google" }, { id: "osm" }] };
    expect(lookupBasemap(abroad, {}, false)).toBe("google");
    expect(lookupBasemap(abroad, {}, true)).toBe("google");
    expect(lookupBasemap({ ...abroad, rendered: "osm" }, { abroad: "osm" }, true)).toBe("osm");
  });
});

describe("地图切换列哪几家", () => {
  test("这个区域手动能用的：\"自动\"会挑的（管这个区域的）按优先级排前面，只能手动选的排后面（451）——国内 高德、OpenStreetMap、假第三家；国外 假第三家、OpenStreetMap（这里的高德不管国外）；Key 没填、网页一半不在的不列；加载失败的列、带原因", () => {
    expect(switchEntries("mainland", THREE, EVERY_BASEMAP)).toEqual([{ id: "amap" }, { id: "osm" }, { id: "worldmap" }]);
    expect(switchEntries("abroad", THREE, EVERY_BASEMAP)).toEqual([{ id: "worldmap" }, { id: "osm" }]);
    expect(switchEntries("mainland", [{ ...AMAP, ready: false }, OSM], EVERY_BASEMAP)).toEqual([{ id: "osm" }]);
    expect(switchEntries("abroad", THREE, pageWith({ missing: ["worldmap"] }))).toEqual([{ id: "osm" }]);
    expect(switchEntries("mainland", THREE, pageWith({ failed: { worldmap: "script failed" } }))).toEqual([{ id: "amap" }, { id: "osm" }, { id: "worldmap", failed: "script failed" }]);
  });

  test("菜单最后那一句照新规矩写（地图页、足迹、聊天卡片都用这一家当底图，453：点和线只在这台设备上画），不再有\"看足迹一律 OpenStreetMap\"", () => {
    const status = sw({}).status!;
    const html = renderToStaticMarkup(createElement(MapSwitchItems, { status, current: undefined, onPick: () => {} }));
    expect(html).toContain("地图页、足迹、聊天里的地图卡片都用这一家当底图");
    expect(html).toContain("足迹和二狗画的点、线只在这台设备上画");
    expect(html).not.toContain("一律用 OpenStreetMap");
    expect(html).toContain("现在是假世界地图");
  });
});

describe("聊天卡片挑哪家（451 cardBasemap）", () => {
  const HZ = { lat: 30.25, lon: 120.14 };
  const SG = { lat: 1.28, lon: 103.85 };
  const amap = { ...AMAP, regions: ["mainland", "abroad"] as MapProviderView["regions"], manualRegions: ["mainland", "abroad"] as MapProviderView["manualRegions"], regionPriority: { abroad: 30 }, preview: true };
  const google = { ...WORLD, id: "google", preview: true };
  const osm = { ...OSM, preview: false };
  const all = [amap, osm, google];

  test("查到的用查它的那家（不管这台设备选了什么）；它报了不出静态图的只写字", () => {
    expect(cardBasemap({ own: "google", center: HZ, providers: all, choice: { mainland: "osm" }, page: EVERY_BASEMAP })).toEqual({ provider: "google", own: true, image: true });
    expect(cardBasemap({ own: "worldmap", center: SG, providers: [amap, osm, WORLD], choice: {}, page: EVERY_BASEMAP })).toEqual({ provider: "worldmap", own: true, image: true });
    expect(cardBasemap({ own: "worldmap", center: SG, providers: [amap, osm, { ...WORLD, preview: false }], choice: {}, page: EVERY_BASEMAP })).toEqual({ provider: "worldmap", own: true, image: false });
  });

  test("足迹、点、路线（OpenStreetMap 查的也是）：内容中心那个区域的当前地图——国内高德、国外谷歌、国外没填谷歌高德；手动选了 OpenStreetMap 自己画；那家插件停了照自动", () => {
    expect(cardBasemap({ center: HZ, providers: all, choice: {}, page: EVERY_BASEMAP })).toEqual({ provider: "amap", own: false, image: true });
    expect(cardBasemap({ center: SG, providers: all, choice: {}, page: EVERY_BASEMAP })).toEqual({ provider: "google", own: false, image: true });
    expect(cardBasemap({ center: SG, providers: [amap, osm], choice: {}, page: EVERY_BASEMAP })).toEqual({ provider: "amap", own: false, image: true });
    expect(cardBasemap({ center: HZ, providers: all, choice: { mainland: "osm" }, page: EVERY_BASEMAP })).toEqual({ provider: "osm", own: false, image: false });
    expect(cardBasemap({ center: SG, providers: all, choice: { mainland: "osm" }, page: EVERY_BASEMAP }).provider).toBe("google");
    expect(cardBasemap({ center: SG, providers: all, choice: {}, page: pageWith({ missing: ["google"] }) }).provider).toBe("amap");
    expect(cardBasemap({ center: HZ, footprints: true, providers: all, choice: {}, page: EVERY_BASEMAP }).provider).toBe("amap");
    // 都没填：OpenStreetMap 自己画；旧守护进程没报 preview 的当不出图
    expect(cardBasemap({ center: HZ, providers: [{ ...amap, ready: false }, osm], choice: {}, page: EVERY_BASEMAP })).toEqual({ provider: "osm", own: false, image: false });
    expect(previewable("amap", [{ ...amap, preview: undefined } as MapProviderView])).toBe(false);
    // 455 起只看那家报的 preview（OpenStreetMap 不报，页面自己画）
    expect(previewable("osm", [osm])).toBe(false);
    // 一家都用不了：卡片只有字
    expect(cardBasemap({ center: HZ, providers: [{ ...amap, ready: false }], choice: {}, page: EVERY_BASEMAP })).toEqual({ provider: undefined, own: false, image: false });
  });

  test("存着的手动切换：坏的、不认得的当自动；换一个区域的不碰另一个", () => {
    expect(parseMapChoice(null)).toEqual({});
    expect(parseMapChoice("{oops")).toEqual({});
    expect(parseMapChoice("[]")).toEqual({});
    expect(parseMapChoice(JSON.stringify({ mainland: "amap", abroad: "Bad Id", other: "osm" }))).toEqual({ mainland: "amap" });
    const both = withChoice(withChoice({}, "mainland", "osm"), "abroad", "worldmap");
    expect(both).toEqual({ mainland: "osm", abroad: "worldmap" });
    expect(withChoice(both, "mainland", undefined)).toEqual({ abroad: "worldmap" });
  });
});

describe("某一家查来的只画在它自己的底图上", () => {
  test("OpenStreetMap 的哪儿都能画；高德、别家（假第三家）的只画在它自己的上——卡片不画缩略图，地图页按 ownBasemap 交过去（455：看那家报的 ownBasemapOnly）", () => {
    expect(ownBasemapOf("osm", THREE)).toBeUndefined();
    expect(ownBasemapOf("amap", THREE)).toBe("amap");
    expect(ownBasemapOf("worldmap", THREE)).toBe("worldmap");
    expect([ownMapOnly("osm", THREE), ownMapOnly("amap", THREE), ownMapOnly("worldmap", THREE)]).toEqual([false, true, true]);
    expect([ownBasemapShow(show("worldmap"), THREE), ownBasemapShow(show("osm"), THREE)]).toEqual(["worldmap", undefined]);
    // 不认得的（那一家的插件停了）、几家报的还没取到：宁严勿松，一律只画在它自己的上
    expect(ownBasemapOf("osm", [AMAP, WORLD])).toBe("osm");
    expect(ownBasemapOf("osm", undefined)).toBe("osm");
    const content = drawingContent({ id: "worldmap-p1", kind: "places", source: "worldmap", title: "附近", at: "2026-11-08T09:00:00+08:00", marks: [{ id: "hit-1", lat: 1.29, lon: 103.85, label: "甲", kind: "search" }], lines: [] }, { providers: THREE });
    expect(content.ownBasemap).toBe("worldmap");
  });
});

describe("网页插件登记一种底图（mapBasemaps）", () => {
  /** 测试用的假"第三家"的网页一半 */
  const fakeWorld: WebPluginDefinition = {
    name: "fake-world-map",
    title: "假世界地图",
    owns: { mapBasemaps: ["worldmap"] },
    setup(ctx) {
      ctx.register("mapBasemaps", {
        id: "worldmap",
        title: "假世界地图",
        prepare: () => () => {
          throw new Error("不在 Node 里画");
        },
      });
    },
  };

  test("455 起三家各一个插件登记（OpenStreetMap、高德、谷歌，按清单的先后）；别的插件登记的接在后面；它停用了那一条撤掉，别家的照旧", () => {
    const host = createWebPluginHost({ plugins: [...WEB_PLUGIN_MANIFEST, fakeWorld], log: () => {} });
    host.apply(undefined);
    expect(host.list("mapBasemaps").map((b) => b.id)).toEqual(["osm", "amap", "google", "worldmap"]);
    expect(["osm", "amap", "google"].map((id) => host.ownerOf("mapBasemaps", id)?.name)).toEqual(["openstreetmap", "amap", "google-maps"]);
    expect(host.ownerOf("mapBasemaps", "worldmap")?.name).toBe("fake-world-map");
    host.disable("fake-world-map");
    expect(host.list("mapBasemaps").map((b) => b.id)).toEqual(["osm", "amap", "google"]);
    // 停用高德：只撤它那一条
    host.disable("amap");
    expect(host.list("mapBasemaps").map((b) => b.id)).toEqual(["osm", "google"]);
    expect(host.unavailable("mapBasemaps", "amap")).toBe("高德地图");
    host.enable("amap");
    expect(host.unavailable("mapBasemaps", "worldmap")).toBe("假世界地图");
    host.enable("fake-world-map");
    expect(host.get("mapBasemaps", "worldmap")?.title).toBe("假世界地图");
  });
});

describe("地图切换的按钮", () => {
  test("宽的时候写\"地图：自动\"（选了某家写它的名字），窄的时候是 ⋮、名字在读屏和悬停提示里；地图那块还没报上来时不画", () => {
    const wide = renderToStaticMarkup(createElement(MapSwitch, { sw: sw({}) }));
    expect(wide).toContain("地图：自动");
    expect(wide).toContain('data-choice="auto"');
    expect(wide).toContain('aria-haspopup="menu"');
    expect(renderToStaticMarkup(createElement(MapSwitch, { sw: sw({ abroad: "osm" }) }))).toContain("地图：OpenStreetMap");
    // 国内选的不影响国外
    expect(renderToStaticMarkup(createElement(MapSwitch, { sw: sw({ mainland: "osm" }) }))).toContain("地图：自动");
    const compact = renderToStaticMarkup(createElement(MapSwitch, { sw: sw({}), compact: true }));
    expect(compact).toContain('aria-label="地图：自动"');
    expect(compact).toContain('data-icon="kebab"');
    expect(renderToStaticMarkup(createElement(MapSwitch, { sw: { ...sw({}), status: undefined } }))).toBe("");
    for (const html of [wide, compact]) expect(html).not.toMatch(/秘书|待我处理/);
  });

  test("英文", () => {
    setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
    expect(renderToStaticMarkup(createElement(MapSwitch, { sw: sw({}) }))).toContain("Map: Automatic");
  });
});

describe("455：OpenStreetMap、高德地图、谷歌地图各是一个插件（开着哪几家就用哪几家）", () => {
  const HZ = { lat: 30.25, lon: 120.14 };
  const SG = { lat: 1.28, lon: 103.85 };
  const PLUGIN_OF: Readonly<Record<string, string>> = { osm: "openstreetmap", amap: "amap", google: "google-maps" };

  /** 只开地图和这几家：守护进程报的（演示页那三家的样子，开着的才报）、网页插件照着装（停用的那几家网页一半也停） */
  function only(ids: readonly string[]) {
    const providers = demoMapProviders({ osm: ids.includes("osm"), amap: ids.includes("amap"), google: ids.includes("google") });
    const host = createWebPluginHost({ plugins: WEB_PLUGIN_MANIFEST, log: () => {} });
    host.apply(undefined);
    for (const [id, plugin] of Object.entries(PLUGIN_OF)) if (!ids.includes(id)) host.disable(plugin);
    const page: BasemapPage = { has: (id) => host.get("mapBasemaps", id) !== undefined, failed: () => undefined };
    const menu = (region: "mainland" | "abroad") => switchEntries(region, providers, page).map((e) => e.id);
    return {
      providers,
      page,
      basemaps: host.list("mapBasemaps").map((b) => b.id),
      mainland: { auto: autoBasemap("mainland", providers, page), menu: menu("mainland") },
      abroad: { auto: autoBasemap("abroad", providers, page), menu: menu("abroad") },
      // 聊天里的卡片：杭州的点用哪家、出不出静态图
      card: cardBasemap({ center: HZ, providers, choice: {}, page }),
      cardAbroad: cardBasemap({ center: SG, providers, choice: {}, page }),
    };
  }

  test("三家都开：国内自动高德，国外谷歌；切换菜单国内 高德 / OpenStreetMap / 谷歌，国外 谷歌 / 高德 / OpenStreetMap；卡片放静态图", () => {
    const all = only(["osm", "amap", "google"]);
    expect(all.basemaps).toEqual(["osm", "amap", "google"]);
    expect(all.mainland).toEqual({ auto: "amap", menu: ["amap", "osm", "google"] });
    expect(all.abroad).toEqual({ auto: "google", menu: ["google", "amap", "osm"] });
    expect(all.card).toEqual({ provider: "amap", own: false, image: true });
    expect(all.cardAbroad).toEqual({ provider: "google", own: false, image: true });
  });

  test("停用高德：国内自动 OpenStreetMap，切换里没有高德；国外照旧谷歌；国内的卡片自己画 OpenStreetMap", () => {
    const noAmap = only(["osm", "google"]);
    expect(noAmap.basemaps).toEqual(["osm", "google"]);
    expect(noAmap.mainland).toEqual({ auto: "osm", menu: ["osm", "google"] });
    expect(noAmap.abroad).toEqual({ auto: "google", menu: ["google", "osm"] });
    expect(noAmap.card).toEqual({ provider: "osm", own: false, image: false });
  });

  test("任意一家、两家：自动只在开着的里挑；只开谷歌时国内退到能手动选的谷歌", () => {
    expect(only(["osm"]).mainland).toEqual({ auto: "osm", menu: ["osm"] });
    expect(only(["osm"]).abroad).toEqual({ auto: "osm", menu: ["osm"] });
    expect(only(["amap"]).mainland).toEqual({ auto: "amap", menu: ["amap"] });
    expect(only(["amap"]).abroad).toEqual({ auto: "amap", menu: ["amap"] });
    expect(only(["google"]).mainland).toEqual({ auto: "google", menu: ["google"] });
    expect(only(["google"]).abroad).toEqual({ auto: "google", menu: ["google"] });
    expect(only(["amap", "google"]).mainland).toEqual({ auto: "amap", menu: ["amap", "google"] });
    expect(only(["amap", "google"]).abroad).toEqual({ auto: "google", menu: ["google", "amap"] });
    expect(only(["osm", "amap"]).abroad).toEqual({ auto: "amap", menu: ["amap", "osm"] });
    // 只开 OpenStreetMap：卡片自己画；只开高德：放静态图
    expect(only(["osm"]).card).toEqual({ provider: "osm", own: false, image: false });
    expect(only(["amap"]).card).toEqual({ provider: "amap", own: false, image: true });
  });

  test("三家都停：没有底图，自动、切换都是空的，卡片只有字；地图页说去设置 · 插件启用一家（off）", () => {
    const none = only([]);
    expect(none.basemaps).toEqual([]);
    expect(none.mainland).toEqual({ auto: undefined, menu: [] });
    expect(none.abroad).toEqual({ auto: undefined, menu: [] });
    expect(none.card).toEqual({ provider: undefined, own: false, image: false });
    expect(noMapReason(none.providers, none.page)).toEqual({ kind: "off" });
  });

  test("停用 OpenStreetMap、开着的都没填 Key（或加载不上）：没有兜底，地图页说它们都用不了（unusable），不是去启用", () => {
    const unset = demoMapProviders({ osm: false, amap: true, google: true }).map((p) => ({ ...p, ready: false }));
    expect(autoBasemap("mainland", unset, EVERY_BASEMAP)).toBeUndefined();
    expect(noMapReason(unset, EVERY_BASEMAP)).toEqual({ kind: "unusable", ids: ["amap", "google"] });
    const failed: BasemapPage = { has: () => true, failed: (id) => (id === "amap" ? "timeout" : undefined) };
    expect(autoBasemap("mainland", demoMapProviders({ amap: true }), failed)).toBeUndefined();
    expect(noMapReason(demoMapProviders({ amap: true }), failed)).toEqual({ kind: "unusable", ids: ["amap"] });
  });

  test("这台设备记着的手动选择（ergo-map-choice）原样认：编号没变（osm、amap、google），各家插件开着就照它用，停了退回自动", () => {
    const stored = JSON.stringify({ mainland: "osm", abroad: "amap" });
    const choice = parseMapChoice(stored);
    expect(choice).toEqual({ mainland: "osm", abroad: "amap" });
    const all = only(["osm", "amap", "google"]);
    expect(pickBasemap({ region: "mainland", choice: choice.mainland, providers: all.providers, page: all.page })).toMatchObject({ wanted: "osm", manual: true });
    expect(pickBasemap({ region: "abroad", choice: choice.abroad, providers: all.providers, page: all.page })).toMatchObject({ wanted: "amap", manual: true });
    // 高德停了：记着的用不了（地图页把这个区域退回自动、说一句）
    const noAmap = only(["osm", "google"]);
    expect(choiceBroken("abroad", "amap", noAmap.providers, noAmap.page)).toBe(true);
    expect(pickBasemap({ region: "abroad", choice: choice.abroad, providers: noAmap.providers, page: noAmap.page })).toMatchObject({ wanted: "google", manual: false });
  });
});
