// 主切面：数据源的统一外形和共用导入文件夹（295 号票，ADR-0027 的"数据源"贡献点）。真的守护进程走组合根和插件清单；
// 测试用的假数据源插件（helpers/fake-data-source.ts，只在测试里）经 extraPlugins 接在清单后面，在数据契约里登记两个数据源：
// - GET /api/data-sources：两个数据源（连接状态、两种用法、敏感类别、认哪种文件）和导入文件夹的路径；
// - 填 Key（POST configure）：存进数据目录密钥区的 data-sources/，事件日志里没有；
// - 立即同步：记录写成插件的事件，采成素材（记忆插件开着），条数、上次同步对；
// - 往导入文件夹放一个认得的文件、POST /api/import-folder 看一遍：导入、挪进"已导入"；认不出的留着并提示；
// - 断开并连已导入的一起删：它的记录、同步记录换成"已删除"标记，由这些记录采成的素材（连原文副本）彻底删除，"已导入"里它的文件删掉；
//   别的数据源导入的不动；
// - 插件运行中停用：数据源页写明没启用、立即同步回 400；在电脑上打开导入文件夹交给打开文件夹的那一下（测试里是假的）；
// - 306 号票：按需查的工具只在连上时给秘书——没连时秘书的工具清单里没有，填好 Key 后有（秘书重新装配一次），别的插件起停不惊动秘书，
//   Key 失效（同步时远端不认）后又没有，重新填好又有；外部日历（手机日历）交来新的日程、断开时工作日历频道上推 external_calendar
//   带更大的版本，日历按月给的 asOf.external 跟着变（开着的日历页据此不用换月就重新取）。
import fs from "node:fs";
import path from "node:path";
import {
  CHANNELS,
  EVENT_TYPES,
  type ExternalCalendarEventPayload,
  HTTP_PATHS,
  type DataSourcePushResult,
  type HttpErrorBody,
  isDeletedEventPayload,
  type MemoryCommandEventPayload,
  type MessageEventPayload,
  nowIso,
  PHONE_CALENDAR_SOURCE,
  phoneCalendarWindow,
} from "@ergo/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { MATERIALS_CHANNEL } from "../../src/materials/index.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { FAKE_BILLS_ID, FAKE_CHANNEL, FAKE_KEY, FAKE_QUERY_TOOL, FAKE_RECORD, FAKE_SOURCE_ID, FAKE_SOURCE_PLUGIN, fakeDataSourcePlugin, fakeRemote, resetFakeRemote } from "../helpers/fake-data-source.ts";
import { ManualClock } from "../helpers/clock.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { calendarApi, dataSourcesApi, pluginsApi, requestJson } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";

afterEach(() => resetFakeRemote());

let n = 0;
const key = () => `ds-${++n}`;
/** 秘书最后一条消息的文字 */
const lastSecretaryText = (frontend: TestFrontend) =>
  (frontend.events({ channel: CHANNELS.secretary, type: EVENT_TYPES.message }).at(-1)!.payload as MessageEventPayload).message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
/** 假数据源采成的素材 */
const fakeMaterials = (td: TestDaemon) => td.daemon.materials.list().filter((m) => m.ref.event.channel === FAKE_CHANNEL);
/** 只看假数据源插件的（插件清单里的真数据源，比如 299 号票的手机，排在前面） */
const fakeSources = <T extends { plugin: string }>(sources: readonly T[]) => sources.filter((s) => s.plugin === FAKE_SOURCE_PLUGIN);
/** 往导入文件夹放一个文件（修改时间拨到一分钟前：刚写的文件算"还在写"，不碰） */
const drop = (td: TestDaemon, name: string, content: string) => {
  const { imports } = dataDirLayout(td.dataDir);
  fs.mkdirSync(imports, { recursive: true });
  const file = path.join(imports, name);
  fs.writeFileSync(file, content);
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(file, past, past);
};

describe("数据源：统一外形和共用导入文件夹（假数据源插件走真实装配路径）", () => {
  it("列出、填 Key、立即同步采成素材、导入文件夹、断开并连已导入的一起删（素材和原文副本跟着删）", async () => {
    const opened: string[] = [];
    const td = await startTestDaemon({ extraPlugins: [fakeDataSourcePlugin], openFolder: (dir) => (opened.push(dir), Promise.resolve()) });
    const layout = dataDirLayout(td.dataDir);

    const first = (await dataSourcesApi.view(td.url)).body;
    expect(fakeSources(first.sources).map((s) => [s.id, s.plugin, s.connection])).toEqual([
      [FAKE_SOURCE_ID, FAKE_SOURCE_PLUGIN, "not_connected"],
      [FAKE_BILLS_ID, FAKE_SOURCE_PLUGIN, "manual"],
    ]);
    expect(fakeSources(first.sources)[0]!.sensitive.map((c) => [c.title, c.inferable])).toEqual([
      ["健康", false],
      ["位置", false],
    ]);
    expect(first.folder.path).toBe(layout.imports);

    // 填 Key：进密钥区，不进事件
    const configured = await dataSourcesApi.act(td.url, FAKE_SOURCE_ID, { action: "configure", values: { key: FAKE_KEY }, idempotencyKey: key() });
    expect(configured.status).toBe(200);
    expect(fakeSources(configured.body.view.sources)[0]).toMatchObject({ connection: "connected", canSync: true });
    expect(fs.readFileSync(path.join(layout.dataSourceSecrets, `${FAKE_SOURCE_ID}.json`), "utf8")).toContain(FAKE_KEY);
    expect(td.daemon.store.readGlobal(0, 1_000_000).some((e) => JSON.stringify(e.payload).includes(FAKE_KEY))).toBe(false);

    // 立即同步：记录采成素材（本人投喂的，带原文副本）
    fakeRemote.next = ["早上跑了 5 公里", "下午在公司开会"];
    const synced = await dataSourcesApi.act(td.url, FAKE_SOURCE_ID, { action: "sync", idempotencyKey: key() });
    expect(synced.body).toMatchObject({ added: 2 });
    expect(fakeSources(synced.body.view.sources)[0]).toMatchObject({ count: 2, lastSync: { trigger: "manual", added: 2 } });
    await waitUntil(() => fakeMaterials(td).length === 2, { timeoutMs: 15_000, describe: () => `素材：${fakeMaterials(td).length}` });
    const originals = fakeMaterials(td).map((m) => path.join(layout.materials, m.original!.path));
    expect(originals.every((file) => fs.existsSync(file))).toBe(true);

    // 导入文件夹：认得的导入、挪进已导入；认不出的留着并提示；另一个数据源的账单也导进来
    drop(td, "today.fake", "FAKE\n晚上看书\n");
    drop(td, "bills.csv", "假账单\n午饭 30\n");
    drop(td, "photo.zip", "PK");
    const scanned = await dataSourcesApi.folder(td.url, { action: "scan" });
    expect(scanned.status).toBe(200);
    expect(scanned.body.view.folder.pending.map((p) => [p.name, p.problem])).toEqual([["photo.zip", "unrecognized"]]);
    expect(scanned.body.view.folder.recent.map((r) => [r.name, r.source, r.added])).toEqual([
      ["today.fake", FAKE_SOURCE_ID, 1],
      ["bills.csv", FAKE_BILLS_ID, 1],
    ]);
    expect(fs.readdirSync(layout.importedDir).toSorted()).toEqual(["bills.csv", "today.fake"]);
    await waitUntil(() => fakeMaterials(td).length === 4, { timeoutMs: 15_000, describe: () => `素材：${fakeMaterials(td).length}` });

    // 断开并连已导入的一起删
    const purged = await dataSourcesApi.act(td.url, FAKE_SOURCE_ID, { action: "disconnect", purge: true, idempotencyKey: key() });
    expect(purged.status).toBe(200);
    expect(purged.body.purged).toEqual({ events: 5, materials: 3, files: 1 });
    expect(fakeSources(purged.body.view.sources)[0]).toMatchObject({ connection: "not_connected", count: 0 });
    expect(fakeSources(purged.body.view.sources)[1]).toMatchObject({ count: 1 });
    expect(td.daemon.store.read(FAKE_CHANNEL, 0, FAKE_RECORD).every((e) => isDeletedEventPayload(e.payload))).toBe(true);
    expect(fs.existsSync(path.join(layout.dataSourceSecrets, `${FAKE_SOURCE_ID}.json`))).toBe(false);
    expect(fs.readdirSync(layout.importedDir)).toEqual(["bills.csv"]);
    await waitUntil(() => fakeMaterials(td).length === 1, { timeoutMs: 15_000, describe: () => `素材：${fakeMaterials(td).length}` });
    expect(originals.some((file) => fs.existsSync(file))).toBe(false);
    // 彻底删除的记忆命令：出处是这个数据源（不产生"显式记忆命令"素材）
    const command = td.daemon.store
      .read(MATERIALS_CHANNEL, 0, EVENT_TYPES.memoryCommand)
      .map((e) => e.payload as MemoryCommandEventPayload)
      .at(-1)!;
    expect(command).toMatchObject({ command: "purge", from: { kind: "data_source", source: FAKE_SOURCE_ID } });
    expect(td.daemon.materials.list().some((m) => m.kind === "memory_command")).toBe(false);

    // 在电脑上打开导入文件夹
    expect((await dataSourcesApi.folder(td.url, { action: "open" })).body).toMatchObject({ opened: true });
    expect(opened).toEqual([layout.imports]);
  });

  it("插件运行中停用：数据源页写明没启用、立即同步回 400；参数不对回 400、不认得的数据源回 404", async () => {
    const td = await startTestDaemon({ extraPlugins: [fakeDataSourcePlugin] });
    await dataSourcesApi.act(td.url, FAKE_SOURCE_ID, { action: "configure", values: { key: FAKE_KEY }, idempotencyKey: key() });
    expect((await pluginsApi.act(td.url, FAKE_SOURCE_PLUGIN, { action: "disable", idempotencyKey: key() })).status).toBe(200);
    expect(fakeSources((await dataSourcesApi.view(td.url)).body.sources)[0]).toMatchObject({ available: false, unavailable: "假数据源插件没启用", canSync: false });
    const refused = await dataSourcesApi.act(td.url, FAKE_SOURCE_ID, { action: "sync", idempotencyKey: key() });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toBe("假数据源插件没启用");
    expect((await dataSourcesApi.act(td.url, "nobody", { action: "sync", idempotencyKey: key() })).status).toBe(404);
    expect((await dataSourcesApi.act(td.url, FAKE_SOURCE_ID, { action: "nope" } as never)).status).toBe(400);
  });

  it("按需查的工具只在连上时给秘书：没连没有，连上后有（秘书重新装配一次），别的插件起停不惊动秘书，Key 失效后又没有；出错时每小时自动再试，远端好了就回到连着、秘书重新有工具；重新填好也行（306）", { timeout: 90_000 }, async () => {
    // 秘书每一轮只回一句：这次装配里有没有"查假数据源"（回显整个上下文会一轮比一轮长，长到触发压缩）
    const PROBE: FauxStep = { kind: "branch_on_context", contains: [`[tool] ${FAKE_QUERY_TOOL}`], matched: { kind: "reply", text: "有工具" }, otherwise: { kind: "reply", text: "没工具" } };
    const clock = new ManualClock(new Date());
    const td = await startTestDaemon({ extraPlugins: [fakeDataSourcePlugin], clock, secretary: Array.from({ length: 6 }, () => PROBE) });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [CHANNELS.secretary]: 0 });
    const talk = async () => {
      await frontend.sendText("在吗");
      await frontend.next(CHANNELS.secretary, EVENT_TYPES.turnEnd);
    };
    /** 秘书这一轮的装配里有没有"查假数据源" */
    const hasTool = async () => {
      await talk();
      return lastSecretaryText(frontend) === "有工具";
    };
    const fakeOf = async () => fakeSources((await dataSourcesApi.view(td.url)).body.sources)[0]!;

    // 没连上：按需查开着也不给
    expect(await hasTool()).toBe(false);
    const notConnected = td.daemon.secretary.pid;
    expect(notConnected).toBeDefined();

    // 填好 Key：有了，秘书重新装配了一次（新的子进程）
    await dataSourcesApi.act(td.url, FAKE_SOURCE_ID, { action: "configure", values: { key: FAKE_KEY }, idempotencyKey: key() });
    expect(await hasTool()).toBe(true);
    const connected = td.daemon.secretary.pid;
    expect(connected).not.toBe(notConnected);
    // 只装配那一次：同步一次（状态没变）、别的插件起停（日历插件不给秘书东西）都不惊动秘书（还是那个子进程）
    fakeRemote.next = ["早上跑了 5 公里"];
    expect((await dataSourcesApi.act(td.url, FAKE_SOURCE_ID, { action: "sync", idempotencyKey: key() })).body).toMatchObject({ added: 1 });
    expect((await pluginsApi.act(td.url, "calendar", { action: "disable", idempotencyKey: key() })).status).toBe(200);
    expect((await pluginsApi.act(td.url, "calendar", { action: "enable", idempotencyKey: key() })).status).toBe(200);
    await talk();
    expect(td.daemon.secretary.pid).toBe(connected);

    // Key 失效（同步时远端不认）：出错了、不给了，秘书重新装配
    fakeRemote.refuseKey = true;
    const failed = await dataSourcesApi.act(td.url, FAKE_SOURCE_ID, { action: "sync", idempotencyKey: key() });
    expect(failed.body).toMatchObject({ error: "Key 失效了" });
    expect(await fakeOf()).toMatchObject({ connection: "error", problem: "Key 失效了" });
    expect(await hasTool()).toBe(false);
    const refused = td.daemon.secretary.pid;
    expect(refused).not.toBe(connected);

    // 出错时每小时自动再试（页面写明）：半小时到不了点，不试；一小时到点试了一次，远端还不认，照旧出错
    expect(await fakeOf()).toMatchObject({ autoRetry: true });
    const failedAt = clock.now();
    clock.advanceTo(failedAt + 30 * 60_000);
    expect(fakeRemote.rechecks).toBe(0);
    clock.advanceTo(failedAt + 61 * 60_000);
    await waitUntil(() => fakeRemote.rechecks === 1, { timeoutMs: 5_000, describe: () => `再试了 ${fakeRemote.rechecks} 次` });
    await td.daemon.dataSources.whenIdle();
    expect(await fakeOf()).toMatchObject({ connection: "error", autoRetry: true });
    await talk();
    expect(td.daemon.secretary.pid).toBe(refused);

    // 远端好了，再过一小时：自己回到连着，秘书重新装配、有了工具，页面上不再写每小时再试
    fakeRemote.refuseKey = false;
    clock.advanceTo(failedAt + 122 * 60_000);
    await waitUntil(() => fakeRemote.rechecks === 2, { timeoutMs: 5_000, describe: () => `再试了 ${fakeRemote.rechecks} 次` });
    await td.daemon.dataSources.whenIdle();
    const recovered = await fakeOf();
    expect(recovered).toMatchObject({ connection: "connected" });
    expect(recovered.autoRetry).toBeUndefined();
    expect(await hasTool()).toBe(true);
    const back = td.daemon.secretary.pid;
    expect(back).not.toBe(refused);

    // 又失效了、这回重新填好：不用等，马上回到连着
    fakeRemote.refuseKey = true;
    expect((await dataSourcesApi.act(td.url, FAKE_SOURCE_ID, { action: "sync", idempotencyKey: key() })).body).toMatchObject({ error: "Key 失效了" });
    expect(await fakeOf()).toMatchObject({ connection: "error", autoRetry: true });
    fakeRemote.refuseKey = false;
    await dataSourcesApi.act(td.url, FAKE_SOURCE_ID, { action: "configure", values: { key: FAKE_KEY }, idempotencyKey: key() });
    expect(await fakeOf()).toMatchObject({ connection: "connected" });
  });

  it("外部日历变了推给网页：手机日历交来新的日程、断开时工作日历频道上推 external_calendar（版本更大），日历按月给的 asOf.external 跟着变；什么都没变的不推（306）", { timeout: 60_000 }, async () => {
    const td = await startTestDaemon({ plugins: ["calendar", "phone"] });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [CHANNELS.workdayCalendar]: 0 });
    const versions = () => frontend.events({ channel: CHANNELS.workdayCalendar, type: EVENT_TYPES.externalCalendar }).map((f) => (f.payload as ExternalCalendarEventPayload).version);
    // 订阅时补推一条现在的版本
    await waitUntil(() => versions().length === 1, { timeoutMs: 5_000, describe: () => `版本：${versions().join(",")}` });
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const before = (await calendarApi.month(td.url, month)).body;
    expect(before.asOf.external).toBe(versions()[0]);
    const external = (view: typeof before) => view.days.flatMap((d) => d.external ?? []).map((e) => e.title);
    expect(external(before)).toEqual([]);

    // App 交来（连上）：推一条更大的版本，再取这个月就有了
    const w = phoneCalendarWindow(now);
    const at = (day: number, hh: number) => nowIso(new Date(now.getFullYear(), now.getMonth(), day, hh));
    const push = (data: unknown) => requestJson<DataSourcePushResult & HttpErrorBody>(td.url, HTTP_PATHS.dataSourcePush(PHONE_CALENDAR_SOURCE), { method: "POST", body: { data, idempotencyKey: key() } });
    const events = [{ key: "11@1", title: "看牙医", start: at(10, 9), end: at(10, 10), allDay: false, calendar: "我的日历" }];
    expect((await push({ device: "Pura 90", state: "granted", link: true, from: nowIso(w.from), to: nowIso(w.to), events })).status).toBe(200);
    await waitUntil(() => versions().length >= 2, { timeoutMs: 5_000, describe: () => `版本：${versions().join(",")}` });
    const pushed = versions().at(-1)!;
    expect(pushed).toBeGreaterThan(before.asOf.external);
    const after = (await calendarApi.month(td.url, month)).body;
    expect(after.asOf.external).toBe(pushed);
    expect(external(after)).toEqual(["看牙医"]);

    // 一样的再交一次：什么都没变，不推
    const count = versions().length;
    expect((await push({ device: "Pura 90", state: "granted", from: nowIso(w.from), to: nowIso(w.to), events })).body).toMatchObject({ added: 0 });
    await new Promise((r) => setTimeout(r, 300));
    expect(versions()).toHaveLength(count);

    // 断开：日历里没了，推一条更大的版本
    await dataSourcesApi.act(td.url, PHONE_CALENDAR_SOURCE, { action: "disconnect", purge: false, idempotencyKey: key() });
    await waitUntil(() => versions().length > count, { timeoutMs: 5_000, describe: () => `版本：${versions().join(",")}` });
    expect(versions().at(-1)!).toBeGreaterThan(pushed);
    expect(external((await calendarApi.month(td.url, month)).body)).toEqual([]);
  });
});
