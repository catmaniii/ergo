// 主切面：手机位置和照片的地点变成地名（308 号票）。真的守护进程走组合根和插件清单（"手机"插件在清单里），时钟手动拨；
// App 交来的用假的（照网页经 POST /api/data-sources/<id>/push 交的样子，App 在手机上用系统的坐标转地址转好地名一起交），点和照片都是编的：
// - 带系统地名的点 → 摘要写地名（"杭州市西湖区文三路"）；转不了的（没带地名）照旧写坐标一带；
// - "常去的地方"（"手机 · 位置"那一行的 panel）：按位置点聚出待过两次以上的几处（地名、次数）；起名"家"（从聚出来的那一处）、手动加一处
//   "公司"（电脑上填坐标，地名用附近记到过的）→ 往后整理的摘要里范围里的点写"家""公司"，以前的摘要不改；照片的场景也按名字写、正文不写地点；
// - 改名"公司"→"单位"、改范围：往后的用新名，已经写好的摘要不动；名字空着、重名的不收，原因写在那一块里；
// - 断开"手机 · 位置"并连已导入的一起删：起了名的地方一起删（断开的确认框先说一句）。
import fs from "node:fs";
import path from "node:path";
import { type DataSourcePushResult, type DataSourceView, type HttpErrorBody, HTTP_PATHS, isPhonePlacesView, nowIso, PHONE_LOCATION_SOURCE, PHONE_PHOTOS_SOURCE, type PhonePlacesView } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import type { Material } from "../../src/materials/types.ts";
import { PHONE_CHANNEL } from "../../src/phone/events.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { dataSourcesApi, requestJson } from "../helpers/http.ts";

/** 本地时间 2026 年 10 月 d 日 hh:mm（10-25 是周日） */
const at = (d: number, hh: number, mm = 0) => new Date(2026, 9, d, hh, mm);
const iso = (d: number, hh: number, mm = 0) => nowIso(at(d, hh, mm));

let n = 0;
const key = () => `t308-${++n}`;
const push = (url: string, id: string, data: unknown) => requestJson<DataSourcePushResult & HttpErrorBody>(url, HTTP_PATHS.dataSourcePush(id), { method: "POST", body: { data, idempotencyKey: key() } });
const configure = (url: string, values: Record<string, string>) => dataSourcesApi.act(url, PHONE_LOCATION_SOURCE, { action: "configure", values, idempotencyKey: key() });
const locationOf = (sources: readonly DataSourceView[]) => sources.find((s) => s.id === PHONE_LOCATION_SOURCE)!;
const panelOf = (source: DataSourceView): PhonePlacesView => {
  expect(isPhonePlacesView(source.panel)).toBe(true);
  return source.panel as PhonePlacesView;
};

/** 编的几个地方：家（文三路）、西湖边（北山街）、西溪（转不了地名）、拱墅（只有照片） */
const HOME = { lat: 30.28, lon: 120.1 };
const LAKE = { lat: 30.259, lon: 120.13 };
const XIXI = { lat: 30.2905, lon: 120.076 };
const HOME_ADDR = { city: "杭州市", district: "西湖区", spot: "文三路" };
const LAKE_ADDR = { city: "杭州市", district: "西湖区", spot: "北山街" };

type Where = { lat: number; lon: number };
/** 每隔 10 分钟一个点：从 from 到 to（含），在 where 附近（一点点抖动）；address 是 App 转好的地名（转不了的不带） */
function every10(day: number, from: [number, number], to: [number, number], where: Where, address?: Record<string, string>) {
  const out: Array<{ at: string; lat: number; lon: number; accuracy: number; address?: Record<string, string> }> = [];
  for (let t = at(day, ...from).getTime(), k = 0; t <= at(day, ...to).getTime(); t += 10 * 60_000, k++) {
    out.push({ at: nowIso(new Date(t)), lat: where.lat + (k % 2 === 0 ? 0.0002 : -0.0002), lon: where.lon + (k % 2 === 0 ? -0.0002 : 0.0002), accuracy: 60, ...(address ? { address } : {}) });
  }
  return out;
}

const phoneMaterials = (td: TestDaemon, source: string): Material[] => td.daemon.materials.list().filter((m) => m.ref.event.channel === PHONE_CHANNEL && m.origin?.dataSource === source);
const textOf = (td: TestDaemon, m: Material) => td.daemon.materials.readOriginal(m)?.segments.map((s) => s.text ?? "").join("") ?? "";
const dayMaterial = (td: TestDaemon, source: string, date: string) => phoneMaterials(td, source).find((m) => textOf(td, m).startsWith(date));

describe("手机：位置和照片的地点变成地名、常去的地方起名", () => {
  it("带系统地名的写地名、转不了的写坐标；起名后往后的摘要写名字、以前的不改；改名只影响往后；断开并删时起了名的一起删", { timeout: 120_000 }, async () => {
    const clock = new ManualClock(at(26, 9, 0));
    const td = await startTestDaemon({ clock, plugins: ["phone"] });

    // 没连着时"常去的地方"那一块也在（可以先起名）：什么都没有
    expect(panelOf(locationOf((await dataSourcesApi.view(td.url)).body.sources))).toEqual({ kind: "phone-places", places: [], suggestions: [], days: 0 });

    // —— 10-25：家（带地名）、西湖边（带地名）、西溪（转不了地名）、又回家 ——
    const day25 = [
      ...every10(25, [8, 0], [10, 0], HOME, HOME_ADDR),
      ...every10(25, [11, 0], [15, 0], LAKE, LAKE_ADDR),
      ...every10(25, [16, 0], [17, 0], XIXI),
      ...every10(25, [17, 30], [22, 0], HOME, HOME_ADDR),
    ];
    const linked = await push(td.url, PHONE_LOCATION_SOURCE, { device: "HUAWEI Pura 90", state: "granted", link: true, background: false, points: day25 });
    expect(linked.status).toBe(200);
    expect(linked.body).toMatchObject({ added: 1 });
    await expect.poll(() => phoneMaterials(td, PHONE_LOCATION_SOURCE).length, { timeout: 15_000 }).toBe(1);
    const text25 =
      "2026-10-25（周日）的位置：记到 73 个点（08:00–22:00）。待过 3 个地方：杭州市西湖区文三路，08:00–10:00、17:30–22:00，共约 6 小时 30 分；杭州市西湖区北山街，11:00–15:00，约 4 小时；北纬 30.29°、东经 120.08° 一带，16:00–17:00，约 1 小时。";
    const day25Material = dayMaterial(td, PHONE_LOCATION_SOURCE, "2026-10-25")!;
    expect(textOf(td, day25Material)).toBe(text25);
    expect(day25Material.origin).toEqual({ dataSource: PHONE_LOCATION_SOURCE, scene: { end: iso(25, 22, 0), place: "杭州市西湖区文三路；杭州市西湖区北山街；北纬 30.29°、东经 120.08° 一带" }, sensitive: ["location"] });

    // "常去的地方"：家待过两次（聚出来、带地名）；西湖边、西溪各一次，不列
    const panel = panelOf(locationOf(linked.body.view.sources));
    expect(panel).toMatchObject({ places: [], days: 1, suggestions: [{ label: "杭州市西湖区文三路", address: "杭州市西湖区文三路", visits: 2, days: 1 }] });
    const homeSuggestion = panel.suggestions[0]!;
    expect(Math.abs(homeSuggestion.lat - HOME.lat)).toBeLessThan(0.001);

    // —— 起名：从聚出来的那一处起名"家"；电脑上手动填坐标加"公司"（没给地名，用附近记到过的） ——
    const named = await configure(td.url, { places: "add", name: " 家 ", lat: String(homeSuggestion.lat), lon: String(homeSuggestion.lon), address: homeSuggestion.address! });
    expect(named.status).toBe(200);
    const added = await configure(td.url, { places: "add", name: "公司", lat: String(LAKE.lat), lon: String(LAKE.lon), radius: "300" });
    const afterAdd = panelOf(locationOf(added.body.view.sources));
    expect(afterAdd.places.map((p) => [p.name, p.radius, p.address, p.visits])).toEqual([
      ["家", 200, "杭州市西湖区文三路", 2],
      ["公司", 300, "杭州市西湖区北山街", 1],
    ]);
    expect(afterAdd.suggestions).toEqual([]);
    expect(afterAdd.refused).toBeUndefined();
    // 起名不算连接出错：那一行照旧连着、没有出错
    expect(locationOf(added.body.view.sources)).toMatchObject({ connection: "connected" });
    expect(locationOf(added.body.view.sources).problem).toBeUndefined();
    const placesFile = path.join(td.dataDir, "phone", "places.json");
    expect(JSON.parse(fs.readFileSync(placesFile, "utf8")).places).toHaveLength(2);

    // 名字空着、重名的不收：原因写在那一块里，下一次做成了就没了
    const empty = await configure(td.url, { places: "add", name: "  ", lat: "30.3", lon: "120.2" });
    expect(panelOf(locationOf(empty.body.view.sources)).refused).toBe("名字不能空着");
    const dup = await configure(td.url, { places: "add", name: "家", lat: "30.3", lon: "120.2" });
    expect(panelOf(locationOf(dup.body.view.sources)).refused).toBe("已经有一处叫「家」了");
    expect(panelOf(locationOf(dup.body.view.sources)).places).toHaveLength(2);

    // 以前的摘要不改
    expect(textOf(td, dayMaterial(td, PHONE_LOCATION_SOURCE, "2026-10-25")!)).toBe(text25);

    // —— 10-26：家、公司（范围 300 米里稍偏一点也算）、西溪（还是转不了） → 10-27 交来时整理，写"家""公司" ——
    clock.advanceTo(at(27, 9, 0));
    const day26 = [
      ...every10(26, [7, 0], [8, 30], HOME, HOME_ADDR),
      ...every10(26, [9, 30], [12, 0], { lat: 30.2605, lon: 120.1315 }, LAKE_ADDR),
      ...every10(26, [13, 0], [14, 0], XIXI),
      ...every10(26, [18, 0], [21, 0], HOME, HOME_ADDR),
    ];
    const located26 = await push(td.url, PHONE_LOCATION_SOURCE, { device: "HUAWEI Pura 90", state: "granted", background: false, points: day26 });
    expect(located26.status).toBe(200);
    await expect.poll(() => dayMaterial(td, PHONE_LOCATION_SOURCE, "2026-10-26") !== undefined, { timeout: 15_000 }).toBe(true);
    const day26Material = dayMaterial(td, PHONE_LOCATION_SOURCE, "2026-10-26")!;
    expect(textOf(td, day26Material)).toBe(
      "2026-10-26（周一）的位置：记到 52 个点（07:00–21:00）。待过 3 个地方：家，07:00–08:30、18:00–21:00，共约 4 小时 30 分；公司，09:30–12:00，约 2 小时 30 分；北纬 30.29°、东经 120.08° 一带，13:00–14:00，约 1 小时。中间有 1 段一个半小时以上没记到。",
    );
    expect(day26Material.origin?.scene?.place).toBe("家；公司；北纬 30.29°、东经 120.08° 一带");
    expect(panelOf(locationOf(located26.body.view.sources)).places.map((p) => [p.name, p.visits])).toEqual([
      ["家", 4],
      ["公司", 2],
    ]);

    // —— 照片：10-26 在公司拍的（带地名）、西溪的（没地名）、别处的（只有地名） → 场景按"起了名的 > 系统地名 > 坐标"，正文不写地点 ——
    const photos = await push(td.url, PHONE_PHOTOS_SOURCE, {
      device: "HUAWEI Pura 90",
      state: "granted",
      link: true,
      location: true,
      from: iso(20, 9),
      to: iso(28, 9),
      photos: [
        { key: "file://media/Photo/1/IMG_1.jpg", takenAt: iso(26, 10, 5), ...LAKE, address: LAKE_ADDR },
        { key: "file://media/Photo/2/IMG_2.jpg", takenAt: iso(26, 10, 30), lat: 30.2593, lon: 120.1302, address: LAKE_ADDR },
        { key: "file://media/Photo/3/IMG_3.jpg", takenAt: iso(26, 13, 20), ...XIXI },
        { key: "file://media/Photo/4/IMG_4.jpg", takenAt: iso(26, 19, 40), lat: 30.3, lon: 120.15, address: { city: "杭州市", district: "拱墅区", spot: "湖墅南路" } },
      ],
    });
    expect(photos.status).toBe(200);
    await expect.poll(() => phoneMaterials(td, PHONE_PHOTOS_SOURCE).length, { timeout: 15_000 }).toBe(1);
    const [photoDay] = phoneMaterials(td, PHONE_PHOTOS_SOURCE);
    expect(textOf(td, photoDay!)).toBe("2026-10-26（周一）拍了 4 张照片：上午 10:05–10:30 2 张，下午 13:20 1 张，晚上 19:40 1 张。");
    expect(photoDay!.origin).toEqual({ dataSource: PHONE_PHOTOS_SOURCE, scene: { end: iso(26, 19, 40), place: "上午 公司；下午 北纬 30.29°、东经 120.08° 一带；晚上 杭州市拱墅区湖墅南路" }, sensitive: [] });

    // —— 改名"公司"→"单位"（范围改 500 米）：往后的写"单位"，10-26 那条不改 ——
    const company = panelOf(locationOf((await dataSourcesApi.view(td.url)).body.sources)).places.find((p) => p.name === "公司")!;
    const renamed = await configure(td.url, { places: "rename", id: company.id, name: "单位", radius: "500" });
    expect(panelOf(locationOf(renamed.body.view.sources)).places.map((p) => [p.name, p.radius])).toEqual([
      ["家", 200],
      ["单位", 500],
    ]);
    clock.advanceTo(at(28, 9, 0));
    await push(td.url, PHONE_LOCATION_SOURCE, { device: "HUAWEI Pura 90", state: "granted", background: false, points: every10(27, [9, 0], [11, 0], { lat: 30.262, lon: 120.133 }, LAKE_ADDR) });
    await expect.poll(() => dayMaterial(td, PHONE_LOCATION_SOURCE, "2026-10-27") !== undefined, { timeout: 15_000 }).toBe(true);
    expect(textOf(td, dayMaterial(td, PHONE_LOCATION_SOURCE, "2026-10-27")!)).toBe("2026-10-27（周二）的位置：记到 13 个点（09:00–11:00）。待过 1 个地方：单位，09:00–11:00，约 2 小时。");
    expect(textOf(td, dayMaterial(td, PHONE_LOCATION_SOURCE, "2026-10-26")!)).toContain("公司，09:30–12:00");

    // —— 删一处 ——
    const removed = await configure(td.url, { places: "remove", id: company.id });
    expect(panelOf(locationOf(removed.body.view.sources)).places.map((p) => p.name)).toEqual(["家"]);

    // —— 断开"手机 · 位置"并连已导入的一起删：确认框先说一句，起了名的地方一起删 ——
    expect(locationOf(removed.body.view.sources).disconnectNote).toBe("起了名的常去的地方（家，共 1 处）：选「连已导入的一起删」时一起删，留着已导入的就也留着");
    const purged = await dataSourcesApi.act(td.url, PHONE_LOCATION_SOURCE, { action: "disconnect", purge: true, idempotencyKey: key() });
    expect(purged.status).toBe(200);
    expect(fs.existsSync(placesFile)).toBe(false);
    const after = locationOf(purged.body.view.sources);
    expect(after).toMatchObject({ connection: "not_connected", count: 0 });
    expect(panelOf(after)).toEqual({ kind: "phone-places", places: [], suggestions: [], days: 0 });
    expect(after.disconnectNote).toBeUndefined();
    // 照片那条照旧
    expect(phoneMaterials(td, PHONE_PHOTOS_SOURCE)).toHaveLength(1);
  });
});
