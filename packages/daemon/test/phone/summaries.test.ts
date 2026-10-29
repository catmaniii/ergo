// 一天的照片、位置整理成摘要（300 号票，phone/summaries.ts）：纯函数，时间按本地时间。
// - 地点只用坐标：两位小数、南纬西经；距离；时长取整；
// - 照片分段：隔一小时以上、都有地点而离开一公里以上另起一段，没地点的跟着前一段；
// - 停留点：一串点都在半径以内、前后超过 15 分钟才算待过；中间隔了一个半小时以上的不算一直待着；同一处的几段合起来；
// - 地名（308 号票）：起了名的 > 系统地名 > 坐标。
import { nowIso } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import type { RawPhoto, RawPoint } from "../../src/phone/raw-store.ts";
import { addressLabel, commonAddress, detectStays, distanceM, durationText, groupPhotos, namedPlaceAt, nameOf, placeLabel, summarizeLocation, summarizePhotos } from "../../src/phone/summaries.ts";

const t = (hh: number, mm = 0) => nowIso(new Date(2026, 9, 25, hh, mm));
const photo = (id: string, hh: number, mm: number, where?: { lat: number; lon: number }): RawPhoto => ({ id, at: t(hh, mm), ...where });
const point = (hh: number, mm: number, lat: number, lon: number, acc?: number): RawPoint => ({ id: `${hh}:${mm}`, at: t(hh, mm), lat, lon, ...(acc === undefined ? {} : { acc }) });

describe("地点、距离、时长", () => {
  it("经纬度两位小数写成一带，南纬西经；距离按球面算；时长按 5 分钟取整", () => {
    expect(placeLabel({ lat: 30.2741, lon: 120.1551 })).toBe("北纬 30.27°、东经 120.16° 一带");
    expect(placeLabel({ lat: -33.8688, lon: -70.6693 })).toBe("南纬 33.87°、西经 70.67° 一带");
    expect(Math.round(distanceM({ lat: 30, lon: 120 }, { lat: 30.01, lon: 120 }))).toBe(1112);
    expect([durationText(2 * 60_000), durationText(47 * 60_000), durationText(60 * 60_000), durationText(200 * 60_000)]).toEqual(["约 5 分钟", "约 45 分钟", "约 1 小时", "约 3 小时 20 分"]);
  });
});

describe("照片分段", () => {
  it("隔一小时以上另起一段；都有地点、离开一公里以上另起一段；没地点的跟着前一段", () => {
    const a = { lat: 30.259, lon: 120.13 };
    const b = { lat: 30.2741, lon: 120.1551 };
    const groups = groupPhotos([photo("3", 10, 50), photo("1", 10, 0, a), photo("2", 10, 40), photo("4", 11, 0, b), photo("5", 12, 30, b)]);
    expect(groups.map((g) => [g.count, g.located.length, g.where ? placeLabel(g.where) : undefined])).toEqual([
      [3, 1, "北纬 30.26°、东经 120.13° 一带"],
      [1, 1, "北纬 30.27°、东经 120.16° 一带"],
      [1, 1, "北纬 30.27°、东经 120.16° 一带"],
    ]);
  });
});

describe("停留点", () => {
  it("待够 15 分钟才算；中间隔了一个半小时以上的不算一直待着；精度太差的点不用；同一处的几段合起来", () => {
    const home = (hh: number, mm: number) => point(hh, mm, 30.28, 120.1, 50);
    // 08:00–08:10 只有 10 分钟：不算；09:00–09:30 算；09:30 之后 11:30 才又有点（两个小时没记到）：不连成一段
    expect(detectStays([home(8, 0), home(8, 10), point(8, 30, 30.3, 120.2), home(9, 0), home(9, 15), home(9, 30), home(11, 30), home(11, 50)]).map((s) => [s.from, s.to].map((x) => new Date(x).getHours() * 60 + new Date(x).getMinutes()))).toEqual([
      [540, 570],
      [690, 710],
    ]);
    const summary = summarizeLocation("2026-10-25", [home(9, 0), home(9, 15), home(9, 30), point(10, 0, 31, 121, 5000), home(11, 30), home(11, 50)], 1);
    expect(summary).toMatchObject({
      text: "2026-10-25（周日）的位置：记到 5 个点（09:00–11:50）。待过 1 个地方：北纬 30.28°、东经 120.10° 一带，09:00–09:30、11:30–11:50，共约 50 分钟。中间有 1 段一个半小时以上没记到。",
      place: "北纬 30.28°、东经 120.10° 一带",
      count: 6,
    });
    // 精度全都太差：没有摘要
    expect(summarizeLocation("2026-10-25", [point(9, 0, 31, 121, 5000)], 1)).toBeUndefined();
  });
});

// 308 号票：地点按"起了名的 > 系统地名 > 坐标"写
const addr = (spot: string) => ({ city: "杭州市", district: "西湖区", spot });
const at = (hh: number, mm: number, where: { lat: number; lon: number }, spot?: string): RawPoint => ({ id: `${hh}:${mm}`, at: t(hh, mm), ...where, acc: 50, ...(spot === undefined ? {} : { addr: addr(spot) }) });
describe("地名：起了名的 > 系统地名 > 坐标", () => {
  const HOME = { lat: 30.28, lon: 120.1 };
  const home = { id: "p1", name: "家", ...HOME, radius: 200 };
  const near = { id: "p2", name: "楼下咖啡", lat: 30.2812, lon: 120.1, radius: 200 };

  it("系统地名接成一段：城市、区县、街道或地标，前缀重复的、写过的不重复；一段都没有是 undefined", () => {
    expect(addressLabel({ city: "杭州市", district: "西湖区", spot: "北山街" })).toBe("杭州市西湖区北山街");
    expect(addressLabel({ city: "杭州市", district: "杭州市西湖区", spot: "西湖区" })).toBe("杭州市西湖区");
    expect(addressLabel({ spot: "断桥残雪" })).toBe("断桥残雪");
    expect(addressLabel({ city: " " })).toBeUndefined();
    expect(addressLabel(undefined)).toBeUndefined();
  });

  it("落在起了名的范围里写名字（几处都盖住取最近的）；不然取这几条里最多的系统地名；都没有写坐标", () => {
    expect(namedPlaceAt({ lat: 30.2801, lon: 120.1001 }, [home, near])?.name).toBe("家");
    expect(namedPlaceAt({ lat: 30.2811, lon: 120.1 }, [home, near])?.name).toBe("楼下咖啡");
    expect(namedPlaceAt({ lat: 30.29, lon: 120.1 }, [home, near])).toBeUndefined();
    expect(commonAddress([{ addr: addr("文三路") }, { addr: addr("北山街") }, { addr: addr("北山街") }, {}])).toBe("杭州市西湖区北山街");
    expect(commonAddress([{}, {}])).toBeUndefined();
    expect(nameOf(HOME, [{ addr: addr("文三路") }], [home])).toBe("家");
    expect(nameOf(HOME, [{ addr: addr("文三路") }], [])).toBe("杭州市西湖区文三路");
    expect(nameOf(HOME, [{}], [])).toBe("北纬 30.28°、东经 120.10° 一带");
  });

  it("位置：起了名的范围里的几段合成一处、写名字；别处有地名写地名（转不了的点不挡）；范围外的照旧按坐标合", () => {
    const lake = { lat: 30.259, lon: 120.13 };
    const points = [at(8, 0, HOME), at(8, 30, HOME), at(9, 0, HOME), at(10, 0, lake, "北山街"), at(10, 30, lake), at(11, 0, lake, "北山街"), at(12, 0, { lat: 30.2812, lon: 120.1 }), at(12, 30, { lat: 30.2812, lon: 120.1 })];
    expect(summarizeLocation("2026-10-25", points, 1, [home])).toMatchObject({
      text: "2026-10-25（周日）的位置：记到 8 个点（08:00–12:30）。待过 2 个地方：家，08:00–09:00、12:00–12:30，共约 1 小时 30 分；杭州市西湖区北山街，10:00–11:00，约 1 小时。",
      place: "家；杭州市西湖区北山街",
    });
    // 没起名：照旧按坐标合（500 米以内一处），写坐标一带
    expect(summarizeLocation("2026-10-25", points, 1)?.text).toContain("北纬 30.28°、东经 120.10° 一带，08:00–09:00、12:00–12:30");
    // 没待够的：一个点一个点写，也按名字
    expect(summarizeLocation("2026-10-25", [at(8, 0, HOME), at(8, 5, lake, "北山街")], 1, [home])?.text).toContain("没有在哪儿待够 15 分钟：家 08:00；杭州市西湖区北山街 08:05。");
  });

  it("照片：场景里每段的地点按名字、地名、坐标写", () => {
    const lake = { lat: 30.259, lon: 120.13 };
    const summary = summarizePhotos("2026-10-25", [photo("1", 9, 0, HOME), { ...photo("2", 14, 0, lake), addr: addr("北山街") }, photo("3", 19, 0, { lat: 30.2905, lon: 120.076 })], 1, [home]);
    expect(summary.text).toBe("2026-10-25（周日）拍了 3 张照片：上午 09:00 1 张，下午 14:00 1 张，晚上 19:00 1 张。");
    expect(summary.place).toBe("上午 家；下午 杭州市西湖区北山街；晚上 北纬 30.29°、东经 120.08° 一带");
  });
});
