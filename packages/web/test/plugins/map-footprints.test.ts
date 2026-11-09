// 地图页的"我的足迹"（430）：Node 里能测的那部分，足迹都是编的——
// - 整理一天（footprints.ts）：同一处的几段停留一个点（写名字和一共待了多久）、轨迹里停留那一段收成中心、一个半小时没点断开、
//   挨着拍的照片合成一个点、常去的地方画圈（这一天没去的另写名字）、列表按时间、看全这一天要看的点；
// - 时长、概况、最近有足迹的一天、让开左边一栏挪视野；
// - 那一条和详情卡画出来的字（中英文案走 t()，没有"秘书""待我处理"）；原型的假足迹（昨天三处停留、几张照片）对得上。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { FootprintBar, FootprintPanel, type Footprints, FootprintToggle } from "../../src/plugins/map/DayFootprints.tsx";
import { daySummary, daySummaryShort, durationLabel, footprintDay, groupPhotos, latestDayBefore, shiftViewRight, shortDateLabel, trackLines, withFootprints } from "../../src/plugins/map/footprints.ts";
import { worldPoint } from "../../src/plugins/map/tiles.ts";
import { demoMapDay } from "../../src/prototype/fake-footprints.ts";
import { activeLocale, activeLocaleFrom, localDate, type MapDayStay, type MapDayView, nowIso, setActiveLocale, shiftMapDate } from "../../src/state/index.ts";
import { TEST_LOCALES } from "../setup-locales.ts";

const zh = activeLocale();

const iso = (hh: number, mm = 0) => nowIso(new Date(2026, 10, 6, hh, mm));
const HOME = { lat: 30.28, lon: 120.1 };
const LAKE = { lat: 30.259, lon: 120.13 };

function stay(spot: string, from: [number, number], to: [number, number], where: { lat: number; lon: number }, extra: Partial<MapDayStay> = {}): MapDayStay {
  return { id: `stay-${from.join("")}`, spot, from: iso(...from), to: iso(...to), minutes: to[0] * 60 + to[1] - from[0] * 60 - from[1], ...where, points: 5, ...extra };
}

/** 每隔 10 分钟一个点 */
function points(from: [number, number], to: [number, number], where: { lat: number; lon: number }) {
  const out: Array<{ at: string; lat: number; lon: number }> = [];
  for (let t = from[0] * 60 + from[1], k = 0; t <= to[0] * 60 + to[1]; t += 10, k++) out.push({ at: iso(Math.floor(t / 60), t % 60), lat: where.lat + (k % 2) * 0.0002, lon: where.lon });
  return out;
}

/** 编的一天：家 08:00–10:00、路上两个点、西湖边 11:00–15:00（拍了照片）、两个半小时没记到、家 17:30–22:00 */
function day(): MapDayView {
  return {
    date: "2026-11-06",
    points: [...points([8, 0], [10, 0], HOME), { at: iso(10, 20), lat: 30.27, lon: 120.116 }, { at: iso(10, 40), lat: 30.268, lon: 120.12 }, ...points([11, 0], [15, 0], LAKE), ...points([17, 30], [22, 0], HOME)],
    stays: [
      stay("place-home", [8, 0], [10, 0], HOME, { placeId: "place-home", name: "家" }),
      stay("spot-1", [11, 0], [15, 0], LAKE, { address: "杭州市西湖区北山街" }),
      stay("place-home", [17, 30], [22, 0], HOME, { placeId: "place-home", name: "家" }),
    ],
    photos: [
      { id: "a", at: iso(14, 5), ...LAKE },
      { id: "b", at: iso(14, 20), lat: 30.2591, lon: 120.1301 },
      { id: "c", at: iso(16, 0), lat: 30.27, lon: 120.14 },
    ],
    unlocatedPhotos: 1,
    places: [
      { id: "place-home", name: "家", ...HOME, radius: 200 },
      { id: "place-gym", name: "健身房", lat: 30.27, lon: 120.12, radius: 300 },
    ],
    days: ["2026-11-06", "2026-11-01"],
    linked: { location: true, photos: true },
  };
}

describe("整理一天", () => {
  test("同一处的几段一个点（名字、一共待了多久）；照片挨着拍的合成一个点；常去的地方画圈，这一天没去的另写名字", () => {
    const d = footprintDay(day());
    expect(d.spots.map((s) => [s.key, s.name ?? s.address, s.stays.length, s.minutes, s.photos])).toEqual([
      ["place-home", "家", 2, 390, 0],
      ["spot-1", "杭州市西湖区北山街", 1, 240, 2],
    ]);
    expect(d.scene.marks.map((m) => [m.id, m.kind, m.label])).toEqual([
      ["fp-place-place-gym", "place", "健身房"],
      ["fp-photo-a", "photo", "14:05 · 2 张"],
      ["fp-photo-c", "photo", "16:00"],
      ["fp-stay-place-home", "stay", "家 · 6 小时 30 分"],
      ["fp-stay-spot-1", "stay", "杭州市西湖区北山街 · 4 小时"],
    ]);
    expect(d.scene.circles.map((c) => [c.id, c.radius])).toEqual([
      ["fp-circle-place-home", 200],
      ["fp-circle-place-gym", 300],
    ]);
    // 编号都以 fp- 开头（地图页按它分辨点的是不是足迹）
    expect([...d.scene.marks, ...d.scene.lines, ...d.scene.circles].every((x) => x.id.startsWith("fp-"))).toBe(true);
    expect(d.empty).toBe(false);
    expect(d.bounds.length).toBe(day().points.length + 3 + 3);
  });

  test("轨迹：停留那一段收成停留的中心，一个半小时以上没有点的断开", () => {
    const lines = trackLines(day());
    expect(lines.map((l) => l.id)).toEqual(["fp-track-1"]);
    // 第一段：家（中心）→ 路上两个点 → 西湖边（中心）
    expect(lines[0]!.points).toEqual([HOME, { lat: 30.27, lon: 120.116 }, { lat: 30.268, lon: 120.12 }, LAKE]);
    // 15:00 之后两个半小时没点：断开；后一段全在家里，收成一个中心，少于两个点不画
    expect(lines.every((l) => l.kind === "track")).toBe(true);
    const moving = trackLines({ points: [{ at: iso(9, 0), ...HOME }, { at: iso(9, 5), ...LAKE }, { at: iso(12, 0), ...HOME }, { at: iso(12, 5), ...LAKE }], stays: [] });
    expect(moving.map((l) => l.points.length)).toEqual([2, 2]);
  });

  test("照片：半小时以内、百米以内的合成一个；隔久了、走远了另起一个", () => {
    const groups = groupPhotos([
      { id: "3", at: iso(9, 55), ...LAKE },
      { id: "1", at: iso(9, 0), ...LAKE },
      { id: "2", at: iso(9, 20), lat: LAKE.lat + 0.0003, lon: LAKE.lon },
      { id: "4", at: iso(10, 0), ...HOME },
    ]);
    expect(groups.map((g) => [g.markId, g.count, g.at.slice(11, 16), g.until.slice(11, 16)])).toEqual([
      ["fp-photo-1", 2, "09:00", "09:20"],
      ["fp-photo-3", 1, "09:55", "09:55"],
      ["fp-photo-4", 1, "10:00", "10:00"],
    ]);
  });

  test("列表按时间：每段停留一行；照片只列不在停留里拍的", () => {
    const d = footprintDay(day());
    expect(d.timeline.map((e) => (e.kind === "stay" ? `${e.at.slice(11, 16)} ${e.spot.key}` : `${e.at.slice(11, 16)} 照片 ${e.group.count}`))).toEqual(["08:00 place-home", "11:00 spot-1", "16:00 照片 1", "17:30 place-home"]);
  });

  test("什么都没有：空的，不画、不挪视野", () => {
    const d = footprintDay({ ...day(), points: [], stays: [], photos: [], unlocatedPhotos: 0 });
    expect(d.empty).toBe(true);
    expect(d.scene.marks.map((m) => m.kind)).toEqual(["place", "place"]);
    expect(withFootprints({ marks: [{ id: "x", lat: 1, lon: 2 }], lines: [], circles: [] }, undefined).marks).toHaveLength(1);
    expect(withFootprints({ marks: [{ id: "x", lat: 1, lon: 2 }], lines: [], circles: [] }, footprintDay(day()).scene).marks[0]!.id).toBe("x");
  });
});

describe("字和视野", () => {
  test("时长、概况、最近有足迹的一天", () => {
    expect([5, 45, 60, 125, 390].map(durationLabel)).toEqual(["5 分钟", "45 分钟", "1 小时", "2 小时 5 分", "6 小时 30 分"]);
    const v = day();
    expect(daySummary(v, footprintDay(v))).toBe("待过 2 个地方 · 4 张照片");
    const passing = { ...v, stays: [], photos: [], unlocatedPhotos: 0 };
    expect(daySummary(passing, footprintDay(passing))).toBe("只有路上的点");
    const nothing = { ...passing, points: [] };
    expect(daySummary(nothing, footprintDay(nothing))).toBeUndefined();
    expect(latestDayBefore(["2026-11-06", "2026-11-01"], "2026-11-07")).toBe("2026-11-06");
    expect(latestDayBefore(["2026-11-06", "2026-11-01"], "2026-11-06")).toBe("2026-11-01");
    expect(latestDayBefore(["2026-11-06"], "2026-11-06")).toBeUndefined();
  });

  test("让开左边一栏：中心往西挪那么多像素，看全的东西落在剩下那一块的正中", () => {
    const v = { lat: 30.27, lon: 120.13, zoom: 14 };
    const moved = shiftViewRight(v, 158);
    expect(worldPoint(v, 14).x - worldPoint(moved, 14).x).toBeCloseTo(158, 6);
    expect(shiftViewRight(v, 0)).toBe(v);
  });
});

/** 一个画出来的样子用的足迹（不连守护进程） */
function fake(view: MapDayView | undefined, extra: Partial<Footprints> = {}): Footprints {
  return {
    date: view?.date ?? "2026-11-06",
    today: "2026-11-07",
    view,
    day: view ? footprintDay(view) : undefined,
    loading: false,
    error: undefined,
    shown: true,
    selected: undefined,
    fit: undefined,
    focus: undefined,
    pick: () => {},
    toggle: () => {},
    select: () => {},
    jumpTo: () => {},
    markClick: () => false,
    ...extra,
  };
}
const navigate = () => {};

describe("画出来的", () => {
  test("那一条：前一天、日期（不超过今天）、后一天，概况；手机上概况能点开列表；开关", () => {
    const bar = renderToStaticMarkup(createElement(FootprintBar, { fp: fake(day()), wide: false, listOpen: false, onList: () => {}, navigate }));
    expect(bar).toContain('aria-label="前一天"');
    expect(bar).toContain('aria-label="后一天"');
    expect(bar).toContain('type="date"');
    expect(bar).toContain('value="2026-11-06"');
    expect(bar).toContain('max="2026-11-07"');
    expect(bar).toMatch(/<button[^>]*class="map-day-summary"[^>]*><span class="map-day-summary-text">待过 2 个地方 · 4 张照片/);
    const wide = renderToStaticMarkup(createElement(FootprintBar, { fp: fake(day()), wide: true, listOpen: false, onList: () => {}, navigate }));
    expect(wide).toMatch(/<span class="map-day-summary">待过 2 个地方/);
    const toggle = renderToStaticMarkup(createElement(FootprintToggle, { fp: fake(day()) }));
    expect(toggle).toContain('aria-pressed="true"');
    expect(toggle).toContain("足迹");
  });

  test("窄的时候（442 追加，放进标题栏）：日期写短的（11/06，系统的选日期框照样在）、概况写短的（整句在读屏和悬停提示里）、开关只剩图标", () => {
    const bar = renderToStaticMarkup(createElement(FootprintBar, { fp: fake(day()), wide: false, compact: true, listOpen: false, onList: () => {}, navigate }));
    expect(bar).toContain("data-compact");
    expect(bar).toMatch(/<span class="map-day-short" aria-hidden="true">11\/06<\/span><input class="map-day-date" type="date"[^>]*value="2026-11-06"/);
    expect(bar).toMatch(/<span class="map-day-summary-text">2 处 · 4 张<\/span>/);
    expect(bar).toContain('aria-label="待过 2 个地方 · 4 张照片 · 看这一天的列表"');
    expect(bar).toContain('title="待过 2 个地方 · 4 张照片"');
    const compactBar = (fp: Footprints) => renderToStaticMarkup(createElement(FootprintBar, { fp, wide: false, compact: true, listOpen: false, onList: () => {}, navigate }));
    expect(compactBar(fake(undefined, { loading: true }))).toContain("正在取…");
    const empty = { ...day(), date: "2026-11-05", points: [], stays: [], photos: [], unlocatedPhotos: 0 };
    expect(compactBar(fake(empty))).toMatch(/title="这一天没有足迹">没有足迹<\/span>.*>看 11-01<\/button>/);
    expect(compactBar(fake({ ...empty, days: [], linked: { location: false, photos: false } }))).toMatch(/>手机没在记位置<\/span>.*>去看看<\/button>/);
    // 别的年份带上年
    expect(shortDateLabel("2025-12-31", "2026-11-07")).toBe("2025/12/31");
    expect(shortDateLabel("2026-01-02", "2026-11-07")).toBe("01/02");
    const toggle = renderToStaticMarkup(createElement(FootprintToggle, { fp: fake(day()), compact: true }));
    expect(toggle).toContain('aria-label="足迹"');
    expect(toggle).not.toMatch(/>足迹</);
    // 英文
    setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
    try {
      const en = renderToStaticMarkup(createElement(FootprintBar, { fp: fake(day()), wide: false, compact: true, listOpen: false, onList: () => {}, navigate }));
      expect(en).toMatch(/<span class="map-day-summary-text">2 places · 4 photos<\/span>/);
      const one = { ...day(), stays: day().stays.slice(0, 1), photos: day().photos.slice(0, 1), unlocatedPhotos: 0 };
      expect(daySummaryShort(one, footprintDay(one))).toBe("1 place · 1 photo");
    } finally {
      setActiveLocale(zh);
    }
  });

  test("那一条：取的中、取不到写原因、这一天空着给最近一天、没开始记位置说怎么开", () => {
    const render = (fp: Footprints) => renderToStaticMarkup(createElement(FootprintBar, { fp, wide: false, listOpen: false, onList: () => {}, navigate }));
    expect(render(fake(undefined, { loading: true }))).toContain("正在取这一天的足迹");
    expect(render(fake(undefined, { error: "数据源-手机插件没启用" }))).toContain("数据源-手机插件没启用");
    const empty = { ...day(), date: "2026-11-05", points: [], stays: [], photos: [], unlocatedPhotos: 0 };
    expect(render(fake(empty))).toMatch(/这一天没有足迹.*看 11-01 那天/);
    expect(render(fake({ ...empty, days: [], linked: { location: false, photos: false } }))).toContain("「开始记位置」");
  });

  test("详情：宽的时候左边一栏列这一天、选中的那一处展开；手机上一张卡；没起名的能去起名", () => {
    const wide = renderToStaticMarkup(createElement(FootprintPanel, { fp: fake(day(), { selected: "spot-1" }), wide: true, listOpen: false, onCloseList: () => {}, navigate }));
    expect(wide).toContain("这一天");
    expect(wide.match(/class="map-day-entry"/g)).toHaveLength(4);
    expect(wide).toContain("08:00–10:00");
    expect(wide).toContain("另有 1 张没有地点");
    expect(wide).toContain("足迹只在这台设备上画，不发给高德、谷歌：它们只知道你在看哪一片地图");
    expect(wide).toContain('data-spot="spot-1"');
    expect(wide).toContain("待了 4 小时");
    expect(wide).toContain("这里拍了 2 张照片");
    expect(wide).toContain("去起个名字");
    const home = renderToStaticMarkup(createElement(FootprintPanel, { fp: fake(day(), { selected: "place-home" }), wide: false, listOpen: false, onCloseList: () => {}, navigate }));
    expect(home).toContain('class="map-day-card"');
    expect(home).toContain("一共待了 6 小时 30 分");
    expect(home).not.toContain("去起个名字");
    expect(renderToStaticMarkup(createElement(FootprintPanel, { fp: fake(day()), wide: false, listOpen: false, onCloseList: () => {}, navigate }))).toBe("");
    expect(renderToStaticMarkup(createElement(FootprintPanel, { fp: fake(day(), { shown: false, selected: "spot-1" }), wide: true, listOpen: false, onCloseList: () => {}, navigate }))).toBe("");
    for (const html of [wide, home]) expect(html).not.toMatch(/秘书|待我处理/);
  });
});

describe("原型的假足迹", () => {
  test("昨天：三处停留、一条轨迹、几张照片、起了名的三处；四天前两处；六天前八处挤在一起；别的日子空着、都列着有足迹的三天", () => {
    const today = localDate(new Date());
    const yesterday = demoMapDay(shiftMapDate(today, -1));
    const d = footprintDay(yesterday);
    expect(d.spots.map((s) => s.name ?? s.address)).toEqual(["家", "公司", "杭州市西湖区北山街"]);
    expect(trackLines(yesterday)).toHaveLength(1);
    expect(yesterday.photos.length).toBeGreaterThanOrEqual(4);
    expect(yesterday.places.map((p) => p.name)).toEqual(["家", "公司", "健身房"]);
    // 停留的中心、点数按自己的点算得对得上
    for (const s of yesterday.stays) expect(yesterday.points.filter((p) => p.at >= s.from && p.at <= s.to)).toHaveLength(s.points);
    expect(footprintDay(demoMapDay(shiftMapDate(today, -4))).spots).toHaveLength(2);
    // 六天前（451 补，看字不互相盖住）：绕西湖走一圈，八处停留、一条轨迹，停留的点数对得上
    const walk = demoMapDay(shiftMapDate(today, -6));
    expect(footprintDay(walk).spots.map((s) => s.address)).toEqual(["断桥", "白堤", "平湖秋月", "孤山", "楼外楼", "西泠印社", "湖边咖啡馆", "宝石山"]);
    expect(trackLines(walk)).toHaveLength(1);
    for (const s of walk.stays) expect(walk.points.filter((p) => p.at >= s.from && p.at <= s.to)).toHaveLength(s.points);
    expect(demoMapDay(today)).toMatchObject({ points: [], stays: [], days: [shiftMapDate(today, -1), shiftMapDate(today, -4), shiftMapDate(today, -6)] });
  });
});
