// 地图服务插槽的网页一半（445）：Node 里能测的那部分——
// - 几家从哪来：守护进程报的 providers；旧的守护进程只给 amapKey 时当只有高德、OpenStreetMap 两家（挑法和 429 一样）；
// - "自动"：管这个区域、用得了的里优先级最大的（接进来一个测试用的假"第三家"worldmap：大陆外 50，手动时大陆也能用）；
// - 手动（这台设备按区域记的）：能选就用、选不了照自动、记着的那家用不了要退回；看足迹一律 OpenStreetMap；
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
import { amapOnlyShow, ownBasemapShow, ownMapOnly } from "../../src/plugins/map/amap-results.ts";
import { drawingContent } from "../../src/plugins/map/card-scene.ts";
import { MapSwitch, type BasemapSwitch } from "../../src/plugins/map/MapSwitch.tsx";
import {
  autoBasemap,
  type BasemapPage,
  choiceBroken,
  EVERY_BASEMAP,
  ownBasemapOf,
  parseMapChoice,
  pickBasemap,
  providersOf,
  selectable,
  switchEntries,
  withChoice,
} from "../../src/plugins/map/providers.ts";
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
  status: { region: "abroad", rendered: "worldmap", autoTitle: "假世界地图", options: [{ id: "worldmap", title: "假世界地图" }, { id: "osm", title: "OpenStreetMap" }] },
});

describe("几家从哪来", () => {
  test("守护进程报了 providers 就用它；旧的守护进程只给 amapKey：当只有高德、OpenStreetMap 两家（没取到是空的）", () => {
    expect(providersOf({ providers: THREE })).toBe(THREE);
    expect(providersOf(undefined)).toEqual([]);
    const legacy = providersOf({ amapKey: "k", amapProblem: "Key 不对" });
    expect(legacy.map((p) => [p.id, p.regions, p.priority, p.ready, p.key, p.problem])).toEqual([
      ["amap", ["mainland"], 100, true, "k", "Key 不对"],
      ["osm", ["mainland", "abroad"], 0, true, undefined, undefined],
    ]);
    expect(providersOf({})[0]!.ready).toBe(false);
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
    expect(autoBasemap("abroad", [], EVERY_BASEMAP)).toBe("osm");
  });

  test("手动：能选就用（假第三家在大陆也能手动选），选不了照自动；看足迹时一律 OpenStreetMap", () => {
    expect(pickBasemap({ region: "mainland", choice: "worldmap", providers: THREE, page: EVERY_BASEMAP })).toEqual({ wanted: "worldmap", auto: "amap", manual: true });
    expect(pickBasemap({ region: "mainland", choice: "osm", providers: THREE, page: EVERY_BASEMAP })).toEqual({ wanted: "osm", auto: "amap", manual: true });
    expect(pickBasemap({ region: "abroad", choice: "osm", providers: THREE, page: EVERY_BASEMAP }).wanted).toBe("osm");
    // 高德在大陆外不能选（世界地图要提工单）：照自动
    expect(pickBasemap({ region: "abroad", choice: "amap", providers: THREE, page: EVERY_BASEMAP })).toEqual({ wanted: "worldmap", auto: "worldmap", manual: false });
    expect(pickBasemap({ region: "abroad", choice: "worldmap", providers: THREE, page: EVERY_BASEMAP, footprints: true }).wanted).toBe("osm");
    expect(pickBasemap({ region: "mainland", providers: THREE, page: EVERY_BASEMAP, footprints: true }).wanted).toBe("osm");
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

describe("地图切换列哪几家", () => {
  test("这个区域手动能用的、按优先级：国内 高德、假第三家、OpenStreetMap；国外 假第三家、OpenStreetMap（高德不列）；Key 没填、网页一半不在的不列；加载失败的列、带原因", () => {
    expect(switchEntries("mainland", THREE, EVERY_BASEMAP)).toEqual([{ id: "amap" }, { id: "worldmap" }, { id: "osm" }]);
    expect(switchEntries("abroad", THREE, EVERY_BASEMAP)).toEqual([{ id: "worldmap" }, { id: "osm" }]);
    expect(switchEntries("mainland", [{ ...AMAP, ready: false }, OSM], EVERY_BASEMAP)).toEqual([{ id: "osm" }]);
    expect(switchEntries("abroad", THREE, pageWith({ missing: ["worldmap"] }))).toEqual([{ id: "osm" }]);
    expect(switchEntries("mainland", THREE, pageWith({ failed: { worldmap: "script failed" } }))).toEqual([{ id: "amap" }, { id: "worldmap", failed: "script failed" }, { id: "osm" }]);
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
  test("OpenStreetMap 的哪儿都能画；高德、别家（假第三家）的只画在它自己的上——卡片不画缩略图，地图页按 ownBasemap 交过去", () => {
    expect(ownBasemapOf("osm")).toBeUndefined();
    expect(ownBasemapOf("amap")).toBe("amap");
    expect(ownBasemapOf("worldmap")).toBe("worldmap");
    expect([ownMapOnly("osm"), ownMapOnly("amap"), ownMapOnly("worldmap")]).toEqual([false, true, true]);
    expect([ownBasemapShow(show("worldmap")), amapOnlyShow(show("worldmap")), ownBasemapShow(show("osm"))]).toEqual(["worldmap", true, undefined]);
    const content = drawingContent({ id: "worldmap-p1", kind: "places", source: "worldmap", title: "附近", at: "2026-11-08T09:00:00+08:00", marks: [{ id: "hit-1", lat: 1.29, lon: 103.85, label: "甲", kind: "search" }], lines: [] });
    expect([content.ownBasemap, content.amapOnly]).toEqual(["worldmap", true]);
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

  test("地图插件自带高德、OpenStreetMap；别的插件登记的接在后面；它停用了那一条撤掉，地图插件的照旧", () => {
    const host = createWebPluginHost({ plugins: [...WEB_PLUGIN_MANIFEST, fakeWorld], log: () => {} });
    host.apply(undefined);
    expect(host.list("mapBasemaps").map((b) => b.id)).toEqual(["amap", "osm", "worldmap"]);
    expect(host.ownerOf("mapBasemaps", "worldmap")?.name).toBe("fake-world-map");
    host.disable("fake-world-map");
    expect(host.list("mapBasemaps").map((b) => b.id)).toEqual(["amap", "osm"]);
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
