// 常去的地方（308 号票，phone/places.ts）：
// - 起了名的存在 phone/places.json：没有文件、读不了当没有（读不了记日志）；存了再读得回来；整个删掉；
// - 按几天的位置点聚常待的几处：每天找停留点，几天的离得近的合成一处，数次数、天数，地名取最多的；起了名的算它的次数、不再列；
//   没起名的只列待过两次以上的（多的在前，最多几处）；
// - 收过的照片这次带来了原来没有的地名时补上（raw-store.ts）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nowIso } from "@ergo/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { addressNear, frequentPlaces, openPlacesStore } from "../../src/phone/places.ts";
import { openRawStore, type RawPhoto, type RawPoint } from "../../src/phone/raw-store.ts";

const dirs: string[] = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ergo-places-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const HOME = { lat: 30.28, lon: 120.1 };
const LAKE = { lat: 30.259, lon: 120.13 };
const XIXI = { lat: 30.2905, lon: 120.076 };
const addr = (spot: string) => ({ city: "杭州市", district: "西湖区", spot });

/** d 日 hh:mm 起每 10 分钟一个点，共 count 个 */
function stay(d: number, hh: number, count: number, where: { lat: number; lon: number }, spot?: string): RawPoint[] {
  return Array.from({ length: count }, (_, k) => {
    const at = new Date(2026, 9, d, hh, k * 10);
    return { id: String(at.getTime()), at: nowIso(at), lat: where.lat + (k % 2 ? 0.0001 : -0.0001), lon: where.lon, acc: 40, ...(spot === undefined ? {} : { addr: addr(spot) }) };
  });
}

describe("起了名的地方存在 places.json", () => {
  it("没有文件当没有；存了读得回来；读不了当没有、记日志；整个删掉", () => {
    const dir = tmp();
    const file = path.join(dir, "phone", "places.json");
    const lines: string[] = [];
    const store = openPlacesStore(file, (l) => lines.push(l));
    expect(store.list()).toEqual([]);
    const home = { id: "place-1", name: "家", ...HOME, radius: 200, address: "杭州市西湖区文三路", addedAt: "2026-10-26T09:00:00.000+08:00" };
    store.save([home]);
    expect(openPlacesStore(file, () => {}).list()).toEqual([home]);
    fs.writeFileSync(file, "{坏的");
    expect(openPlacesStore(file, (l) => lines.push(l)).list()).toEqual([]);
    expect(lines.join("\n")).toContain("读不了");
    store.clearAll();
    expect(fs.existsSync(file)).toBe(false);
    expect(store.list()).toEqual([]);
  });
});

describe("按位置点聚常待的几处", () => {
  const days = [
    { date: "2026-10-24", points: [...stay(24, 8, 7, HOME, "文三路"), ...stay(24, 12, 4, XIXI), ...stay(24, 18, 13, HOME)] },
    { date: "2026-10-25", points: [...stay(25, 9, 13, LAKE, "北山街"), ...stay(25, 19, 7, HOME, "文三路")] },
    { date: "2026-10-26", points: [...stay(26, 10, 4, LAKE), ...stay(26, 15, 3, XIXI)] },
  ];

  it("几天的停留点合成一处：次数、天数、地名（最多的，转不了的点不挡）；只列待过两次以上的，多的在前", () => {
    const found = frequentPlaces(days, []);
    expect(found.named).toEqual([]);
    expect(found.suggestions.map((s) => [s.label, s.address, s.visits, s.days])).toEqual([
      ["杭州市西湖区文三路", "杭州市西湖区文三路", 3, 2],
      ["杭州市西湖区北山街", "杭州市西湖区北山街", 2, 2],
      ["北纬 30.29°、东经 120.08° 一带", undefined, 2, 2],
    ]);
    const [homeSpot] = found.suggestions;
    expect(homeSpot!.key).toBe(`${homeSpot!.lat.toFixed(5)},${homeSpot!.lon.toFixed(5)}`);
    expect(Math.abs(homeSpot!.lat - HOME.lat)).toBeLessThan(0.0005);
    // 最多几处
    expect(frequentPlaces(days, [], 1).suggestions.map((s) => s.label)).toEqual(["杭州市西湖区文三路"]);
  });

  it("起了名的：范围里的停留点算它的次数、不再列；精度太差的点不用", () => {
    const named = [{ id: "place-1", name: "家", ...HOME, radius: 200 }];
    const found = frequentPlaces(days, named);
    expect(found.named).toEqual([{ id: "place-1", visits: 3 }]);
    expect(found.suggestions.map((s) => s.label)).toEqual(["杭州市西湖区北山街", "北纬 30.29°、东经 120.08° 一带"]);
    const blurry = [{ date: "2026-10-24", points: stay(24, 8, 7, HOME).map((p) => ({ ...p, acc: 5000 })) }];
    expect(frequentPlaces(blurry, named).named).toEqual([{ id: "place-1", visits: 0 }]);
  });

  it("附近记到过的点的地名（手动加一处、没给地名时补上）：范围以内的才算", () => {
    expect(addressNear(LAKE, 200, days)).toBe("杭州市西湖区北山街");
    expect(addressNear({ lat: 30.5, lon: 120.5 }, 200, days)).toBeUndefined();
  });
});

const dateOf = () => "2026-10-25";
describe("收过的照片补上地名", () => {
  it("同一张这次带来了地名、原来没有：补上（不算新收的）；原来有的不换", () => {
    const store = openRawStore<RawPhoto>(path.join(tmp(), "photos"), () => {});
    const at = nowIso(new Date(2026, 9, 25, 14, 0));
    expect(store.add([{ id: "a", at, ...LAKE }], dateOf)).toEqual({ added: 1, dates: ["2026-10-25"] });
    store.markSummarized("2026-10-25", ["a"]);
    expect(store.add([{ id: "a", at, ...LAKE, addr: addr("北山街") }], dateOf)).toEqual({ added: 0, dates: [] });
    expect(store.itemsOf("2026-10-25")).toEqual([{ id: "a", at, ...LAKE, s: 1, addr: addr("北山街") }]);
    store.add([{ id: "a", at, ...LAKE, addr: addr("别处") }], dateOf);
    expect(store.itemsOf("2026-10-25")[0]!.addr).toEqual(addr("北山街"));
    // 整理过的那天补了地名照样算整理过（不另出一份补记）
    expect(store.pending("2026-10-26")).toEqual([]);
  });
});
