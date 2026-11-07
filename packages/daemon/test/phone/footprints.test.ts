// 某一天的足迹（phone/footprints.ts，430）：纯函数，点、照片、起了名的地方都是编的（杭州的几处），时间按本地时间。
// - 停留：按时间和距离（400 米以内、中间没有一个半小时以上的空档、够 15 分钟）聚成一段，时长是头尾之差；精度太差的点不用；
// - 同一处的几段归成一处：落在同一处起了名的地方的范围里的（写名字），或者离第一次待的中心 500 米以内的；离得远的另算一处；
// - 地名：起了名的写名字，系统地名取这一段的点里最多的那个；
// - 照片只给有地点的（时间和坐标，不给地名、不给照片），没地点的只数个数；有足迹的日子去重、新的在前、有上限。
import { MAP_DAY_DAYS_MAX, nowIso, shiftMapDate } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { dayFootprints } from "../../src/phone/footprints.ts";
import type { RawPhoto, RawPoint } from "../../src/phone/raw-store.ts";
import { MAX_GAP_MS, SAME_PLACE_M, STAY_MIN_MS, STAY_RADIUS_M } from "../../src/phone/summaries.ts";

const iso = (hh: number, mm = 0) => nowIso(new Date(2026, 10, 6, hh, mm));
const HOME = { lat: 30.28, lon: 120.1 };
const LAKE = { lat: 30.259, lon: 120.13 };
const FAR = { lat: 30.3, lon: 120.2 };

/** 每隔 10 分钟一个点：从 from 到 to（含），在 where 附近（一点点抖动，几十米） */
function every10(from: [number, number], to: [number, number], where: { lat: number; lon: number }, extra: Partial<RawPoint> = {}): RawPoint[] {
  const out: RawPoint[] = [];
  const end = new Date(2026, 10, 6, ...to).getTime();
  for (let t = new Date(2026, 10, 6, ...from).getTime(), k = 0; t <= end; t += 10 * 60_000, k++) {
    out.push({ id: String(t), at: nowIso(new Date(t)), lat: where.lat + (k % 2 === 0 ? 0.0002 : -0.0002), lon: where.lon + (k % 2 === 0 ? -0.0002 : 0.0002), acc: 40, ...extra });
  }
  return out;
}

const point = (hh: number, mm: number, where: { lat: number; lon: number }, acc = 60): RawPoint => ({ id: `${hh}:${mm}`, at: iso(hh, mm), ...where, acc });
const named = [{ id: "place-home", name: "家", lat: HOME.lat, lon: HOME.lon, radius: 200 }];
const base = { date: "2026-11-06", photos: [] as RawPhoto[], places: named, days: ["2026-11-06"], linked: { location: true, photos: true } };

describe("停留怎么聚", () => {
  it("参数和记忆里的位置摘要同一套：400 米、15 分钟、一个半小时的空档、同一处 500 米", () => {
    expect([STAY_RADIUS_M, STAY_MIN_MS / 60_000, MAX_GAP_MS / 60_000, SAME_PLACE_M]).toEqual([400, 15, 90, 500]);
  });

  it("一天三段停留：家（起了名的）→ 路上 → 西湖边 → 没记到的两个半小时 → 回家；时长、中心、点数、同一处归在一起", () => {
    const lakeAddr = { spot: "北山街", district: "西湖区", city: "杭州市" };
    const points = [
      ...every10([17, 30], [22, 0], HOME),
      ...every10([8, 0], [10, 0], HOME),
      point(10, 20, { lat: 30.27, lon: 120.116 }),
      point(10, 40, { lat: 30.268, lon: 120.12 }),
      ...every10([11, 0], [15, 0], LAKE, { addr: lakeAddr }),
      // 精度太差（基站定位，几公里）：不用，也不进轨迹
      point(12, 5, FAR, 5000),
    ];
    const day = dayFootprints({ ...base, points });
    expect(day.stays.map((s) => [s.from.slice(11, 16), s.to.slice(11, 16), s.minutes, s.points, s.spot, s.name, s.address])).toEqual([
      ["08:00", "10:00", 120, 13, "place-home", "家", undefined],
      ["11:00", "15:00", 240, 25, "spot-1", undefined, "杭州市西湖区北山街"],
      ["17:30", "22:00", 270, 28, "place-home", "家", undefined],
    ]);
    expect(day.stays[0]).toMatchObject({ id: `stay-${new Date(2026, 10, 6, 8).getTime()}`, placeId: "place-home" });
    // 中心是这一段点的平均，留 5 位小数
    expect(Math.abs(day.stays[1]!.lat - LAKE.lat)).toBeLessThan(0.0001);
    expect(String(day.stays[1]!.lon).split(".")[1]!.length).toBeLessThanOrEqual(5);
    // 轨迹：按时间排，精度太差的去掉，只有时间和坐标
    expect(day.points).toHaveLength(points.length - 1);
    expect(day.points.map((p) => p.at)).toEqual(day.points.map((p) => p.at).toSorted());
    expect(day.points.every((p) => Object.keys(p).toSorted().join() === "at,lat,lon")).toBe(true);
    expect(day.points.some((p) => p.lat === FAR.lat)).toBe(false);
  });

  it("不够 15 分钟的不算；没起名的两段离得 500 米以内算一处，远的另算一处；落在起了名的范围外的不写名字", () => {
    const near = { lat: LAKE.lat + 0.003, lon: LAKE.lon }; // 约 330 米
    const points = [
      ...every10([8, 0], [8, 10], FAR), // 只有 10 分钟
      ...every10([9, 0], [9, 30], LAKE),
      ...every10([10, 30], [11, 0], FAR),
      ...every10([12, 0], [12, 40], near),
    ];
    const day = dayFootprints({ ...base, points });
    expect(day.stays.map((s) => [s.from.slice(11, 16), s.spot, s.name])).toEqual([
      ["09:00", "spot-1", undefined],
      ["10:30", "spot-2", undefined],
      ["12:00", "spot-1", undefined],
    ]);
  });

  it("中间一个半小时以上没有点：不连成一段", () => {
    const day = dayFootprints({ ...base, points: [point(9, 0, LAKE), point(9, 20, LAKE), point(11, 0, LAKE), point(11, 20, LAKE)] });
    expect(day.stays.map((s) => [s.from.slice(11, 16), s.to.slice(11, 16), s.minutes])).toEqual([
      ["09:00", "09:20", 20],
      ["11:00", "11:20", 20],
    ]);
  });
});

describe("照片、常去的地方、有足迹的日子", () => {
  it("照片只给有地点的：编号、时间、坐标（不带地名）；没地点的只数个数；常去的地方全给；日子去重、新的在前、有上限", () => {
    const photos: RawPhoto[] = [
      { id: "b", at: iso(14, 30), lat: 30.2592, lon: 120.1303, addr: { spot: "北山街" } },
      { id: "a", at: iso(14, 5), ...LAKE },
      { id: "c", at: iso(19, 50) },
    ];
    const days = [...Array.from({ length: MAP_DAY_DAYS_MAX + 20 }, (_, i) => shiftMapDate("2024-01-01", i)), "2026-11-06", "2026-11-06", "2026-11-01"];
    const day = dayFootprints({ ...base, points: [], photos, days, linked: { location: false, photos: true } });
    expect(day.photos).toEqual([
      { id: "a", at: iso(14, 5), lat: LAKE.lat, lon: LAKE.lon },
      { id: "b", at: iso(14, 30), lat: 30.2592, lon: 120.1303 },
    ]);
    expect(day.unlocatedPhotos).toBe(1);
    expect(day.places).toEqual(named);
    expect(day.days.slice(0, 2)).toEqual(["2026-11-06", "2026-11-01"]);
    expect(day.days).toHaveLength(MAP_DAY_DAYS_MAX);
    expect(new Set(day.days).size).toBe(MAP_DAY_DAYS_MAX);
    expect(day).toMatchObject({ date: "2026-11-06", stays: [], points: [], linked: { location: false, photos: true } });
  });
});
