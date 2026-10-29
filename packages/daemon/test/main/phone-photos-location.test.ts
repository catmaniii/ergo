// 主切面：手机上的二狗 App 读本机（二）——照片的时间地点、位置，按天整理成摘要进素材（300 号票）。真的守护进程走组合根和插件清单
// （"手机"插件在清单里），记忆插件开着、整理模型是假的（不联网、不调真模型），时钟手动拨；App 交来的用假的（照网页经
// POST /api/data-sources/<id>/push 交的样子），照片的时间地点、位置点都是编的（杭州的三个地方）：
// - 照片：没连上不收；点了"连上相册"交来昨天（10-25）7 张、今天 1 张 → 昨天当场整理成一条摘要素材（观察到的本人行为，时段和张数对，
//   地点只在场景里、整条不算位置），今天的等过完这一天；再交一遍同样的不重复收；
// - 位置：点了"开始记位置"交来昨天 68 个点、今天 2 个 → 昨天一条"去过哪、待了多久"的摘要素材（整条是位置）；原始坐标点在插件自己的
//   存储里，数据源页按天列出、清掉昨天的；
// - 次日 03:00 整理：位置没打开推断（默认）——照片那条读成证据、不带地点，位置那条不进推理库；
// - 关掉"位置"的导入后不再收；断开并连已导入的一起删：素材没了、原始数据没了，照片那条照旧在，再断开照片也没了。
import fs from "node:fs";
import path from "node:path";
import { type ChatRequest, FakeChatModel } from "@ergo/memory";
import { type DataSourcePushResult, type HttpErrorBody, HTTP_PATHS, nowIso, PHONE_LOCATION_SOURCE, PHONE_PHOTOS_SOURCE } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import type { Material } from "../../src/materials/types.ts";
import { MEMORY_NIGHTLY_EVENT, type MemoryNightlyRecord } from "../../src/memory/nightly-record.ts";
import { PHONE_CHANNEL } from "../../src/phone/events.ts";
import { INTERNAL_CHANNEL } from "../../src/scheduler/internal-jobs.ts";
import { openDatabase } from "../../src/storage/sqlite.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { dataSourcesApi, requestJson } from "../helpers/http.ts";

/** 本地时间 2026 年 10 月 d 日 hh:mm（10-25 是周日） */
const at = (d: number, hh: number, mm = 0) => new Date(2026, 9, d, hh, mm);
const iso = (d: number, hh: number, mm = 0) => nowIso(at(d, hh, mm));

let n = 0;
const key = () => `t300-${++n}`;
const push = (url: string, id: string, data: unknown) => requestJson<DataSourcePushResult & HttpErrorBody>(url, HTTP_PATHS.dataSourcePush(id), { method: "POST", body: { data, idempotencyKey: key() } });
const sourceOf = async (url: string, id: string) => (await dataSourcesApi.view(url)).body.sources.find((s) => s.id === id)!;

/** 编的三个地方：家、西湖边、西溪 */
const HOME = { lat: 30.28, lon: 120.1 };
const LAKE = { lat: 30.259, lon: 120.13 };
const HILL = { lat: 30.2741, lon: 120.1551 };
const XIXI = { lat: 30.2905, lon: 120.0755 };

/** 昨天 7 张：下午西湖边 3 张、下午另一处 1 张、晚上西溪 2 张和 1 张没地点的；今天早上 1 张 */
const PHOTOS = [
  { key: "file://media/Photo/1/IMG_1.jpg", takenAt: iso(25, 14, 5), ...LAKE },
  { key: "file://media/Photo/2/IMG_2.jpg", takenAt: iso(25, 14, 30), lat: 30.2592, lon: 120.1303 },
  { key: "file://media/Photo/3/IMG_3.jpg", takenAt: iso(25, 15, 10), lat: 30.2588, lon: 120.1298 },
  { key: "file://media/Photo/4/IMG_4.jpg", takenAt: iso(25, 16, 20), ...HILL },
  { key: "file://media/Photo/5/IMG_5.jpg", takenAt: iso(25, 19, 20), ...XIXI },
  { key: "file://media/Photo/6/IMG_6.jpg", takenAt: iso(25, 19, 45), lat: 30.2907, lon: 120.0757 },
  { key: "file://media/Photo/7/IMG_7.jpg", takenAt: iso(25, 19, 50) },
  { key: "file://media/Photo/8/IMG_8.jpg", takenAt: iso(26, 8, 30), ...LAKE },
];

/** 每隔 10 分钟一个点：从 from 到 to（含），在 where 附近（一点点抖动） */
function every10(day: number, from: [number, number], to: [number, number], where: { lat: number; lon: number }) {
  const out: Array<{ at: string; lat: number; lon: number; accuracy: number }> = [];
  for (let t = at(day, ...from).getTime(), k = 0; t <= at(day, ...to).getTime(); t += 10 * 60_000, k++) {
    out.push({ at: nowIso(new Date(t)), lat: where.lat + (k % 2 === 0 ? 0.0002 : -0.0002), lon: where.lon + (k % 2 === 0 ? -0.0002 : 0.0002), accuracy: 60 });
  }
  return out;
}

/** 昨天：家 08:00–10:00、路上两个点、西湖边 11:00–15:00、（15:00–17:30 没记到）、家 17:30–22:00；今天早上家里两个点 */
const POINTS = [
  ...every10(25, [8, 0], [10, 0], HOME),
  { at: iso(25, 10, 20), lat: 30.27, lon: 120.116, accuracy: 80 },
  { at: iso(25, 10, 40), lat: 30.268, lon: 120.12, accuracy: 80 },
  ...every10(25, [11, 0], [15, 0], LAKE),
  ...every10(25, [17, 30], [22, 0], HOME),
  ...every10(26, [8, 0], [8, 10], HOME),
];

const PHOTOS_TEXT = "2026-10-25（周日）拍了 7 张照片：下午 14:05–15:10 3 张，下午 16:20 1 张，晚上 19:20–19:50 3 张。其中 1 张没有地点。";
const PHOTOS_PLACE = "下午 北纬 30.26°、东经 120.13° 一带；下午 北纬 30.27°、东经 120.16° 一带；晚上 北纬 30.29°、东经 120.08° 一带";
const LOCATION_TEXT =
  "2026-10-25（周日）的位置：记到 68 个点（08:00–22:00）。待过 2 个地方：北纬 30.28°、东经 120.10° 一带，08:00–10:00、17:30–22:00，共约 6 小时 30 分；北纬 30.26°、东经 120.13° 一带，11:00–15:00，约 4 小时。另外路过 1 处。中间有 1 段一个半小时以上没记到。";

const phoneMaterials = (td: TestDaemon, source: string): Material[] => td.daemon.materials.list().filter((m) => m.ref.event.channel === PHONE_CHANNEL && m.origin?.dataSource === source);
const textOf = (td: TestDaemon, m: Material) => td.daemon.materials.readOriginal(m)?.segments.map((s) => s.text ?? "").join("") ?? "";

/** 假整理模型：抽事实那一步给每条证据一条事实，别的步骤回空 */
function memoryModel(requests: ChatRequest[]) {
  return () =>
    new FakeChatModel((request) => {
      requests.push(request);
      if (request.purpose !== "extract") return {};
      const ids = [...request.user.matchAll(/"evidence_id":"(ev-\d+)"/g)].map((m) => m[1]!);
      return { facts: ids.map((id) => ({ evidence_id: id, predicate: "participated_in", object: { name: `出门（${id}）`, type: "activity" }, negated: false, context: [], statement: `用户出门了（${id}）`, span: "拍了" })) };
    });
}

/** 推理库里的证据（出处 → 原文） */
function evidenceTexts(td: TestDaemon): Map<string, string> {
  const rg = openDatabase(td.daemon.layout.rgDb);
  try {
    return new Map(rg.all<{ source_ref: string | null; text: string }>("SELECT source_ref, text FROM evidence WHERE source_ref IS NOT NULL").map((r) => [r.source_ref!, r.text]));
  } finally {
    rg.close();
  }
}

describe("手机：照片的时间地点、位置按天整理成摘要进素材", () => {
  it("一天的照片和位置点 → 当天各一条摘要素材（时间地点对）；原始点按天清掉；位置没打开推断时不进推理库；关掉导入不再收；断开并删后素材没了", { timeout: 150_000 }, async () => {
    const requests: ChatRequest[] = [];
    const clock = new ManualClock(at(26, 9, 0));
    const td = await startTestDaemon({ clock, plugins: ["calendar", "memory", "phone"], memoryModel: memoryModel(requests) });

    // 数据源页：两个都没连、只有导入，用到"位置"这类敏感内容（默认只记录、不用于推断）
    const first = (await dataSourcesApi.view(td.url)).body.sources.filter((s) => s.id === PHONE_PHOTOS_SOURCE || s.id === PHONE_LOCATION_SOURCE);
    expect(first.map((s) => [s.id, s.title, s.connection, s.usages, s.sensitive, s.raw?.days])).toEqual([
      [PHONE_PHOTOS_SOURCE, "手机 · 照片的时间地点", "not_connected", [{ usage: "import", on: true }], [{ id: "location", title: "位置", inferable: false }], []],
      [PHONE_LOCATION_SOURCE, "手机 · 位置", "not_connected", [{ usage: "import", on: true }], [{ id: "location", title: "位置", inferable: false }], []],
    ]);

    // —— 照片 ——
    const window = { from: iso(19, 9), to: iso(27, 9) };
    const refused = await push(td.url, PHONE_PHOTOS_SOURCE, { state: "granted", location: true, ...window, photos: PHOTOS });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toContain("相册还没连上");

    const linked = await push(td.url, PHONE_PHOTOS_SOURCE, { device: "HUAWEI Pura 90", state: "granted", link: true, location: true, ...window, photos: PHOTOS });
    expect(linked.status).toBe(200);
    expect(linked.body).toMatchObject({ added: 1, summary: "读到 8 张照片的时间地点，新的 8 张；整理出 10-25 的摘要；今天的过完这一天再整理" });
    const photosSource = linked.body.view.sources.find((s) => s.id === PHONE_PHOTOS_SOURCE)!;
    expect(photosSource).toMatchObject({ connection: "connected", account: "HUAWEI Pura 90", count: 1, lastSync: { trigger: "device", added: 1 } });
    expect(photosSource.raw).toEqual({
      title: "原始的照片时间地点",
      days: [
        { date: "2026-10-26", count: 1, summarized: false },
        { date: "2026-10-25", count: 7, summarized: true },
      ],
    });

    // 昨天一条摘要素材：观察到的本人行为，时段、张数对；地点只在场景里（整条不算位置）；照片本身、相册里的地址都没进来
    await expect.poll(() => phoneMaterials(td, PHONE_PHOTOS_SOURCE).length, { timeout: 15_000 }).toBe(1);
    const [photoDay] = phoneMaterials(td, PHONE_PHOTOS_SOURCE);
    expect([photoDay!.kind, photoDay!.mode, photoDay!.source, photoDay!.time]).toEqual(["observed_behavior", "do", "self", iso(25, 14, 5)]);
    expect(photoDay!.origin).toEqual({ dataSource: PHONE_PHOTOS_SOURCE, scene: { end: iso(25, 19, 50), place: PHOTOS_PLACE }, sensitive: [] });
    expect(textOf(td, photoDay!)).toBe(PHOTOS_TEXT);
    expect(td.daemon.materials.searchKeyword("东经 120.08°").map((m) => m.id)).toEqual([photoDay!.id]);
    const everything = JSON.stringify(td.daemon.store.readGlobal(0, 1_000_000).map((e) => e.payload));
    expect(everything).not.toContain("IMG_1.jpg");
    expect(JSON.stringify(fs.readdirSync(path.join(td.dataDir, "phone", "photos")).map((f) => fs.readFileSync(path.join(td.dataDir, "phone", "photos", f), "utf8")))).not.toContain("IMG_");

    // 再交一遍同样的：不重复收、不再整理
    const again = await push(td.url, PHONE_PHOTOS_SOURCE, { device: "HUAWEI Pura 90", state: "granted", location: true, ...window, photos: PHOTOS });
    expect(again.body).toMatchObject({ added: 0, summary: "读到 8 张照片的时间地点，新的 0 张；今天的过完这一天再整理" });
    expect(phoneMaterials(td, PHONE_PHOTOS_SOURCE)).toHaveLength(1);

    // —— 位置 ——
    expect((await push(td.url, PHONE_LOCATION_SOURCE, { state: "granted", background: false, points: POINTS })).status).toBe(400);
    const located = await push(td.url, PHONE_LOCATION_SOURCE, { device: "HUAWEI Pura 90", state: "granted", link: true, background: false, points: POINTS });
    expect(located.status).toBe(200);
    expect(located.body).toMatchObject({ added: 1, summary: "收到 70 个位置点，新的 70 个；整理出 10-25 的摘要；今天的过完这一天再整理" });
    expect(located.body.view.sources.find((s) => s.id === PHONE_LOCATION_SOURCE)).toMatchObject({ connection: "connected", account: "HUAWEI Pura 90 · App 开着时记", count: 1 });
    await expect.poll(() => phoneMaterials(td, PHONE_LOCATION_SOURCE).length, { timeout: 15_000 }).toBe(1);
    const [locationDay] = phoneMaterials(td, PHONE_LOCATION_SOURCE);
    expect([locationDay!.kind, locationDay!.time]).toEqual(["observed_behavior", iso(25, 8, 0)]);
    // 整条是位置：敏感类别"位置"；地点同时放进场景（待得最久的两处）
    expect(locationDay!.origin).toEqual({ dataSource: PHONE_LOCATION_SOURCE, scene: { end: iso(25, 22, 0), place: "北纬 30.28°、东经 120.10° 一带；北纬 30.26°、东经 120.13° 一带" }, sensitive: ["location"] });
    expect(textOf(td, locationDay!)).toBe(LOCATION_TEXT);

    // 原始坐标点：按天列出，清掉昨天的（摘要素材不动）
    expect((await sourceOf(td.url, PHONE_LOCATION_SOURCE)).raw?.days).toEqual([
      { date: "2026-10-26", count: 2, summarized: false },
      { date: "2026-10-25", count: 68, summarized: true },
    ]);
    const cleared = await dataSourcesApi.act(td.url, PHONE_LOCATION_SOURCE, { action: "clear_raw", dates: ["2026-10-25"], idempotencyKey: key() });
    expect(cleared.status).toBe(200);
    expect(cleared.body.cleared).toBe(68);
    expect(cleared.body.view.sources.find((s) => s.id === PHONE_LOCATION_SOURCE)!.raw?.days).toEqual([{ date: "2026-10-26", count: 2, summarized: false }]);
    expect(fs.existsSync(path.join(td.dataDir, "phone", "locations", "2026-10-25.json"))).toBe(false);
    expect(phoneMaterials(td, PHONE_LOCATION_SOURCE)).toHaveLength(1);

    // —— 次日 03:00 整理：位置没打开推断——照片那条读成证据、不带地点；位置那条整条是位置，不进推理库 ——
    clock.advanceTo(at(27, 3, 0));
    await td.daemon.internalJobs.whenIdle();
    expect(td.daemon.store.read(INTERNAL_CHANNEL, 0, MEMORY_NIGHTLY_EVENT).map((e) => e.payload as MemoryNightlyRecord).at(-1)).toMatchObject({ state: "ran", night: "2026-10-27" });
    const evidence = evidenceTexts(td);
    expect(evidence.get(photoDay!.id)).toBe(`${PHOTOS_TEXT}\n［场景］时间 14:05–19:50`);
    expect(evidence.has(locationDay!.id)).toBe(false);
    expect(requests.every((r) => !r.user.includes("东经"))).toBe(true);

    // —— 关掉"位置"的导入：不再收 ——
    expect((await dataSourcesApi.act(td.url, PHONE_LOCATION_SOURCE, { action: "usage", usage: "import", on: false, idempotencyKey: key() })).status).toBe(200);
    const off = await push(td.url, PHONE_LOCATION_SOURCE, { state: "granted", background: false, points: every10(27, [8, 0], [9, 0], HOME) });
    expect(off.status).toBe(400);
    expect(off.body.message).toBe("手机 · 位置的导入关着");
    expect((await sourceOf(td.url, PHONE_LOCATION_SOURCE)).raw?.days.map((d) => d.date)).toEqual(["2026-10-26"]);
    expect(phoneMaterials(td, PHONE_LOCATION_SOURCE)).toHaveLength(1);

    // —— 断开"位置"并连已导入的一起删：素材、原始数据都没了；照片那条照旧 ——
    const purged = await dataSourcesApi.act(td.url, PHONE_LOCATION_SOURCE, { action: "disconnect", purge: true, idempotencyKey: key() });
    expect(purged.status).toBe(200);
    expect(purged.body.purged).toMatchObject({ materials: 1 });
    expect(purged.body.view.sources.find((s) => s.id === PHONE_LOCATION_SOURCE)).toMatchObject({ connection: "not_connected", count: 0, raw: { days: [] } });
    expect(phoneMaterials(td, PHONE_LOCATION_SOURCE)).toHaveLength(0);
    expect(fs.existsSync(path.join(td.dataDir, "phone", "locations"))).toBe(false);
    expect(phoneMaterials(td, PHONE_PHOTOS_SOURCE)).toHaveLength(1);

    // 照片也断开并删：素材和推理库里的证据都没了
    const photosPurged = await dataSourcesApi.act(td.url, PHONE_PHOTOS_SOURCE, { action: "disconnect", purge: true, idempotencyKey: key() });
    expect(photosPurged.body.purged).toMatchObject({ materials: 1 });
    expect(phoneMaterials(td, PHONE_PHOTOS_SOURCE)).toHaveLength(0);
    expect(evidenceTexts(td).has(photoDay!.id)).toBe(false);
    expect(JSON.stringify(td.daemon.store.readGlobal(0, 1_000_000).map((e) => e.payload))).not.toContain("东经 120.08°");
    expect((await push(td.url, PHONE_PHOTOS_SOURCE, { state: "granted", location: true, ...window, photos: PHOTOS })).status).toBe(400);
  });
});
