// 手机位置和照片的地点变成地名（308 号票）在网页这一侧：
// - 原生桥：照片、位置点带的系统地名（每段截到上限、空的去掉；照片没地点就不带地名）、定位状态里系统能不能转地名；
//   "常去的地方"那一组（phonePlaceHere、phonePlaceFind）两个都在才有，回的定位一次、按地名找的结果一律核对；
// - "常去的地方"那一块（纯渲染）：起了名的几处（地名、范围、次数，改名、点两下删）、常待还没起名的（起名）、没有的时候写明、
//   加一处（在 App 里用现在的位置、按地名找；不在 App 里填经纬度）、手机转不了地名时写一句；界面上没有"秘书""待我处理"；
// - 表单交给守护进程的值：名字、范围、在哪（聚出来的那一处带地名；填的经纬度要核对）；定位一次、按地名找的结果怎么说。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { detectNativeApp } from "../../src/app/native-app.ts";
import { parseAddress, parseLocationRead, parseLocationState, parsePhotosRead, parsePlaceFix } from "../../src/app/native-phone.ts";
import { coordsText, fixOutcome, formValues, type PlaceForm, PlacesBlockView, type PlacesBlockViewProps, parseCoords } from "../../src/plugins/phone/PhonePlaces.tsx";
import { nowIso, type PhonePlacesView } from "../../src/state/index.ts";

vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

const BASE = { appVersion: () => "0.2.1", phoneContactsPick: () => Promise.resolve(""), phoneCalendarState: () => "", phoneCalendarPrepare: () => Promise.resolve(""), phoneCalendarRead: () => Promise.resolve("") };
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const noop = () => {};
const at = (hh: number) => new Date(2026, 9, 25, hh).getTime();
const ADDR = { city: "杭州市", district: "西湖区", spot: "北山街" };

describe("原生桥：系统地名、常去的地方那一组", () => {
  test("照片、位置点带的地名：每段截到上限、空的去掉、一段都没有不带；照片没读照片位置的授权（没地点）就不带地名；状态里的 geocoder 原样认", () => {
    expect(parseAddress({ city: " 杭州市 ", district: "", spot: "北".repeat(40), other: "x" })).toEqual({ city: "杭州市", spot: "北".repeat(30) });
    expect(parseAddress({ city: 1 })).toBeUndefined();
    expect(parseAddress("杭州")).toBeUndefined();
    const photos = { ok: true, location: true, photos: [{ key: "u1", takenAt: at(14), lat: 30.259, lon: 120.13, address: ADDR }, { key: "u2", takenAt: at(15), address: ADDR }] };
    expect(parsePhotosRead(JSON.stringify(photos))).toEqual({
      ok: true,
      location: true,
      photos: [
        { key: "u1", takenAt: nowIso(new Date(at(14))), lat: 30.259, lon: 120.13, address: ADDR },
        { key: "u2", takenAt: nowIso(new Date(at(15))) },
      ],
    });
    expect(parsePhotosRead(JSON.stringify({ ...photos, location: false }))).toMatchObject({ photos: [{ key: "u1" }, { key: "u2" }] });
    expect(JSON.stringify(parsePhotosRead(JSON.stringify({ ...photos, location: false })))).not.toContain("北山街");
    expect(parseLocationRead(JSON.stringify({ ok: true, points: [{ at: at(9), lat: 30.28, lon: 120.1, address: { spot: "文三路" } }, { at: at(10), lat: 30.28, lon: 120.1, address: {} }] }))).toEqual({
      ok: true,
      points: [
        { at: nowIso(new Date(at(9))), lat: 30.28, lon: 120.1, address: { spot: "文三路" } },
        { at: nowIso(new Date(at(10))), lat: 30.28, lon: 120.1 },
      ],
    });
    expect(parseLocationState(JSON.stringify({ granted: true, asked: true, geocoder: false }))).toMatchObject({ geocoder: false });
    expect(parseLocationState(JSON.stringify({ granted: true, asked: true }))).not.toHaveProperty("geocoder");
  });

  test("常去的地方那一组两个都在才有；定位一次、按地名找的结果核对：没授权、没找到、读不了，经纬度不对当读不了", async () => {
    const PLACES = { phonePlaceHere: () => Promise.resolve(JSON.stringify({ ok: true, lat: 30.28, lon: 120.1, address: ADDR })), phonePlaceFind: (q: string) => Promise.resolve(JSON.stringify(q === "西湖" ? { ok: true, lat: 30.25, lon: 120.14 } : { ok: false, state: "not_found" })) };
    expect(detectNativeApp({ ergoNative: BASE })?.phone?.places).toBeUndefined();
    expect(detectNativeApp({ ergoNative: { ...BASE, phonePlaceHere: PLACES.phonePlaceHere } })?.phone?.places).toBeUndefined();
    const places = detectNativeApp({ ergoNative: { ...BASE, ...PLACES } })?.phone?.places;
    expect(await places?.here()).toEqual({ ok: true, lat: 30.28, lon: 120.1, address: ADDR });
    expect(await places?.find("西湖")).toEqual({ ok: true, lat: 30.25, lon: 120.14 });
    expect(await places?.find("火星")).toEqual({ ok: false, reason: "not_found" });
    expect(parsePlaceFix(JSON.stringify({ ok: false, state: "denied" }))).toEqual({ ok: false, reason: "denied" });
    expect(parsePlaceFix(JSON.stringify({ ok: false, state: "unavailable", message: "3301000" }))).toEqual({ ok: false, reason: "unavailable", message: "3301000" });
    expect(parsePlaceFix(JSON.stringify({ ok: true, lat: 200, lon: 1 }))).toEqual({ ok: false, reason: "unavailable" });
    expect(parsePlaceFix("")).toEqual({ ok: false, reason: "unavailable" });
  });
});

const VIEW: PhonePlacesView = {
  kind: "phone-places",
  places: [
    { id: "place-home", name: "家", lat: 30.28, lon: 120.1, radius: 200, address: "杭州市西湖区文三路", visits: 14 },
    { id: "place-gym", name: "健身房", lat: 30.3, lon: 120.2, radius: 100, visits: 0 },
  ],
  suggestions: [
    { key: "30.25900,120.13000", lat: 30.259, lon: 120.13, label: "杭州市西湖区北山街", address: "杭州市西湖区北山街", visits: 4, days: 3 },
    { key: "30.29050,120.07600", lat: 30.2905, lon: 120.076, label: "北纬 30.29°、东经 120.08° 一带", visits: 2, days: 2 },
  ],
  days: 14,
};

const props = (over: Partial<PlacesBlockViewProps> = {}): PlacesBlockViewProps => ({
  view: VIEW,
  inApp: false,
  geocoderOff: false,
  busy: false,
  form: undefined,
  removing: undefined,
  note: undefined,
  onForm: noop,
  onSave: noop,
  onRemove: noop,
  onHere: noop,
  onFind: noop,
  ...over,
});

describe("常去的地方那一块", () => {
  test("起了名的：地名（没有的写经纬度）、范围、次数，改名、删；常待还没起名的：地名或坐标、次数，起名；写明起名只影响以后", () => {
    const out = html(createElement(PlacesBlockView, props()));
    expect(out).toContain(">常去的地方<");
    expect(out).toContain("起名、改名不改以前的摘要");
    expect(out).toContain("<b>家</b>");
    expect(out).toContain("杭州市西湖区文三路 · 范围 200 米 · 最近待过 14 次");
    expect(out).toContain("30.3000, 120.2000 · 范围 100 米 · 最近待过 0 次");
    expect(out).toContain(">改名<");
    expect(out).toContain(">删<");
    expect(out).toContain(">最近常待的（还没起名）<");
    expect(out).toContain("杭州市西湖区北山街");
    expect(out).toContain("待过 4 次（3 天里）");
    expect(out).toContain("北纬 30.29°、东经 120.08° 一带");
    expect(out).toContain(">起名<");
    expect(out).toContain(">加一处<");
    expect(out).not.toMatch(/秘书|待我处理/);
  });

  test("没有记到点、没有常待的：各写一句；点了一下删变成「确定删？」；手机转不了地名时（只在 App 里）写一句", () => {
    expect(html(createElement(PlacesBlockView, props({ view: { kind: "phone-places", places: [], suggestions: [], days: 0 } })))).toContain("还没有记到位置点");
    expect(html(createElement(PlacesBlockView, props({ view: { ...VIEW, suggestions: [] } })))).toContain("最近 14 天里还没有待过两次以上、又没起名的地方。");
    expect(html(createElement(PlacesBlockView, props({ removing: "place-home" })))).toContain(">确定删？<");
    expect(html(createElement(PlacesBlockView, props({ inApp: true, geocoderOff: true })))).toContain("这台手机现在转不了地名");
    expect(html(createElement(PlacesBlockView, props({ inApp: false, geocoderOff: true })))).not.toContain("转不了地名（");
  });

  test("起名、改名的表单：名字、范围（100–1000 米，默认 200）；加一处：在 App 里用现在的位置、按地名找，不在 App 里填经纬度；定好了写在哪、能换", () => {
    const naming = html(createElement(PlacesBlockView, props({ form: { mode: "suggestion", key: "30.25900,120.13000", where: { lat: 30.259, lon: 120.13 }, name: "公司", radius: 200 } })));
    expect(naming).toContain('data-phone="place-name"');
    expect(naming).toContain('value="公司"');
    for (const m of [100, 200, 300, 500, 1000]) expect(naming).toContain(`>${m} 米以内<`);
    expect(naming).toContain(">保存<");
    const rename = html(createElement(PlacesBlockView, props({ form: { mode: "rename", id: "place-home", name: "家", radius: 200 } })));
    expect(rename.match(/class="phone-place-form"/g)).toHaveLength(1);
    const addForm: PlaceForm = { mode: "add", name: "", radius: 200, query: "", coords: "" };
    const inApp = html(createElement(PlacesBlockView, props({ inApp: true, form: addForm })));
    expect(inApp).toContain(">用现在的位置<");
    expect(inApp).toContain('data-phone="place-query"');
    expect(inApp).not.toContain('data-phone="place-coords"');
    const outside = html(createElement(PlacesBlockView, props({ form: addForm })));
    expect(outside).toContain('data-phone="place-coords"');
    expect(outside).toContain("不在手机上的二狗 App 里时填经纬度");
    expect(outside).not.toContain(">用现在的位置<");
    const found = html(createElement(PlacesBlockView, props({ inApp: true, form: { ...addForm, where: { lat: 30.28, lon: 120.1, address: "杭州市西湖区文三路" } } })));
    expect(found).toContain("定在：杭州市西湖区文三路");
    expect(found).toContain(">换一处<");
    expect(html(createElement(PlacesBlockView, props({ note: { ok: false, text: "已经有一处叫「家」了" } })))).toContain("已经有一处叫「家」了");
  });
});

describe("交给守护进程的值", () => {
  test("名字去掉空白、不能空、不能太长；起名带聚出来的那一处和地名；改名带编号和范围；加一处要定好在哪，填的经纬度要对", () => {
    expect(formValues({ mode: "suggestion", key: "k", where: { lat: 30.259, lon: 120.13, address: "杭州市西湖区北山街" }, name: "  公 司 ", radius: 300 })).toEqual({
      values: { places: "add", name: "公 司", lat: "30.259", lon: "120.13", radius: "300", address: "杭州市西湖区北山街" },
    });
    expect(formValues({ mode: "rename", id: "place-home", name: "老家", radius: 500 })).toEqual({ values: { places: "rename", id: "place-home", name: "老家", radius: "500" } });
    expect(formValues({ mode: "rename", id: "x", name: " ", radius: 200 })).toEqual({ note: { ok: false, text: "先填个名字" } });
    expect(formValues({ mode: "rename", id: "x", name: "长".repeat(21), radius: 200 })).toEqual({ note: { ok: false, text: "名字最多 20 个字" } });
    const add: PlaceForm = { mode: "add", name: "家", radius: 200, query: "", coords: "" };
    expect(formValues(add)).toEqual({ note: { ok: false, text: "先定好在哪" } });
    expect(formValues({ ...add, coords: "30.27，120.15" })).toEqual({ values: { places: "add", name: "家", lat: "30.27", lon: "120.15", radius: "200" } });
    expect(formValues({ ...add, coords: "120.15" })).toMatchObject({ note: { ok: false } });
    expect(formValues({ ...add, where: { lat: 30.28, lon: 120.1 } })).toEqual({ values: { places: "add", name: "家", lat: "30.28", lon: "120.1", radius: "200" } });
  });

  test("经纬度的写法；定位一次、按地名找的结果怎么说", () => {
    expect(parseCoords("30.27, 120.15")).toEqual({ lat: 30.27, lon: 120.15 });
    expect(parseCoords(" 30.27 120.15 ")).toEqual({ lat: 30.27, lon: 120.15 });
    expect(parseCoords("91, 120")).toBeUndefined();
    expect(parseCoords("0, 0")).toBeUndefined();
    expect(parseCoords("abc")).toBeUndefined();
    expect(coordsText({ lat: 30.28, lon: 120.1 })).toBe("30.2800, 120.1000");
    expect(fixOutcome({ ok: true, lat: 30.28, lon: 120.1, address: { city: "杭州市", spot: "文三路" } }, "here")).toEqual({ where: { lat: 30.28, lon: 120.1, address: "杭州市文三路" } });
    expect(fixOutcome({ ok: true, lat: 30.28, lon: 120.1 }, "find")).toEqual({ where: { lat: 30.28, lon: 120.1 } });
    expect(fixOutcome({ ok: false, reason: "denied" }, "here")).toEqual({ note: { ok: false, text: "没有定位的授权：在上面点「开始记位置」允许一次" } });
    expect(fixOutcome({ ok: false, reason: "not_found" }, "find")).toEqual({ note: { ok: false, text: "没找到这个地方，换个说法试试" } });
    expect(fixOutcome({ ok: false, reason: "unavailable", message: "没联网" }, "find")).toEqual({ note: { ok: false, text: "找不了：没联网" } });
  });
});
