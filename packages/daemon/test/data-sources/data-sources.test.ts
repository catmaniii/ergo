// 数据源的统一外形和共用导入文件夹（295 号票）：在假内核里（startPluginKernel：真的插件宿主、登记表、设置 · 插件那一层）装上
// 测试用的假数据源插件（helpers/fake-data-source.ts），查：
// - 登记后在设置 · 数据源里出现：名字、插件、连接状态、两种用法和默认、敏感类别、认哪种文件、定期导入的时间；手动导入的数据源没有连接；
// - 填设置（Key 进密钥区，不进事件、日志）、立即同步（条数、上次同步）、同步出错（原因里的 Key 换成 ***）；
// - 两种用法的开关：导入关了不能同步、不定期；按需查关了秘书没有那个工具，正在跑的一轮里再调回"关着"；开关写进配置区；
// - 断开：留着已导入的（记录还在、密钥没了）、连已导入的一起删（记录整条换成"已删除"标记、上次同步清掉、同一个键重发只删一次）；
// - 插件停用：写明"X插件没启用"、不能同步，断开并删照样能做；
// - 定期导入：连着、导入开着时每天 04:00 同步一次；
// - 导入文件夹：认得的导入、挪进"已导入"；认不出的、几个数据源都认的、导入关着的、出错的留在原地并提示，出错的手动再看一遍时重试；
// - 306 号票：按需查的工具只在连上时给（给出去的变了才通知秘书，Key 失效后不给、正在跑的一轮里再调回出错了）；外部日历的版本
//   （交给日历的数据源写进了新记录、断开、插件起停时往上加）；断开确认框要的 hasSecrets / toMaterials / 数据源登记的那一句。
import fs from "node:fs";
import path from "node:path";
import { isDeletedEventPayload } from "@ergo/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { DataSource } from "../../src/data-sources/api.ts";
import type { EventStore } from "../../src/events/event-store.ts";
import type { PluginDefinition } from "../../src/plugins/host.ts";
import { KERNEL } from "../../src/plugins/kernel.ts";
import { SECRETARY_TARGET } from "../../src/secretary/secretary.ts";
import {
  FAKE_BILL,
  FAKE_BILLS_ID,
  FAKE_CHANNEL,
  FAKE_KEY,
  FAKE_QUERY_TOOL,
  FAKE_RECORD,
  FAKE_SOURCE_ID,
  FAKE_SOURCE_PLUGIN,
  fakeDataSourcePlugin,
  fakeRemote,
  resetFakeRemote,
} from "../helpers/fake-data-source.ts";
import { type PluginKernel, startPluginKernel } from "../helpers/plugin-kernel.ts";

afterEach(() => resetFakeRemote());

let keySeq = 0;
const key = () => `k-${++keySeq}`;
const sourceOf = (k: PluginKernel, id: string) => k.dataSources.view().sources.find((s) => s.id === id)!;
const liveRecords = (k: PluginKernel, type: string) => k.store.read(FAKE_CHANNEL, 0, type).filter((e) => !isDeletedEventPayload(e.payload));
const secretaryTools = (k: PluginKernel) => k.agent.toolsFor(SECRETARY_TARGET).map((t) => t.spec.name);
const connect = (k: PluginKernel) => k.dataSources.act(FAKE_SOURCE_ID, { action: "configure", values: { key: FAKE_KEY }, idempotencyKey: key() });
/** 密钥区里这个数据源那一格的文件 */
const secretFile = (k: PluginKernel, id: string) => path.join(k.layout.dataSourceSecrets, `${id}.json`);
/** 往导入文件夹放一个文件 */
const drop = (k: PluginKernel, name: string, content: string) => {
  fs.mkdirSync(k.layout.imports, { recursive: true });
  fs.writeFileSync(path.join(k.layout.imports, name), content);
};
const inFolder = (k: PluginKernel) => fs.readdirSync(k.layout.imports).filter((n) => n !== path.basename(k.layout.importedDir));
/** 登记一个写错了的数据源的插件 */
const bad = (source: Partial<DataSource>): PluginDefinition => ({
  name: "bad",
  title: "坏的",
  contracts: (ctx) => ctx.dataSources.register({ id: "x", title: "x", usages: {}, ...source } as DataSource),
  setup() {},
});
const imported = (k: PluginKernel) => (fs.existsSync(k.layout.importedDir) ? fs.readdirSync(k.layout.importedDir) : []);
/** 什么都不给秘书的插件（306：它起停不该惊动秘书） */
const other: PluginDefinition = { name: "other", title: "别的", setup() {} };

/** 306：交给日历的假数据源（没有密钥区以外的东西、不进素材）：填了 key 算连着，同步把 calRemote.next 写成记录，登记了断开时说的一句 */
const CAL_PLUGIN = "cal-source";
const CAL_ID = "cal";
const CAL_CHANNEL = "cal-source";
const CAL_EVENT = "cal_event";
const calRemote = { next: [] as string[], note: undefined as string | undefined };
let calStore: Pick<EventStore, "appendBatch"> | undefined;
const calendarSourcePlugin: PluginDefinition = {
  name: CAL_PLUGIN,
  title: "假日历",
  needs: [KERNEL.store],
  contracts(ctx) {
    ctx.dataSources.register({
      id: CAL_ID,
      title: "假日历",
      usages: { import: { default: true } },
      records: [{ channel: CAL_CHANNEL, type: CAL_EVENT }],
      disconnectNote: "同步来的日程从日历里拿掉",
      status: (c) => ({ connection: c.secrets.has("key") ? "connected" : "not_connected", ...(calRemote.note === undefined ? {} : { disconnectNote: calRemote.note }) }),
      configure(values, c) {
        c.secrets.set("key", values.key ?? "");
        return Promise.resolve({ connection: "connected" });
      },
      sync() {
        const titles = calRemote.next.splice(0);
        if (titles.length > 0) calStore!.appendBatch(titles.map((title) => ({ channel: CAL_CHANNEL, type: CAL_EVENT, payload: { title } })));
        return Promise.resolve({ added: titles.length });
      },
      calendar: () => [],
    });
  },
  setup(ctx) {
    calStore = ctx.use(KERNEL.store);
  },
};
/** 306：没有 recheck 的数据源（出错后内核照同步那样同步一次）：同步出错记在内存里，状态报出错；同步成了清掉 */
const FLAKY_ID = "flaky";
const flaky = { down: false, failed: false, syncs: 0 };
const flakyPlugin: PluginDefinition = {
  name: "flaky",
  title: "时好时坏",
  contracts(ctx) {
    ctx.dataSources.register({
      id: FLAKY_ID,
      title: "时好时坏",
      usages: { import: { default: true } },
      status: (c) => (!c.secrets.has("key") ? { connection: "not_connected" } : flaky.failed ? { connection: "error", problem: "那边出错了" } : { connection: "connected" }),
      configure(values, c) {
        c.secrets.set("key", values.key ?? "");
        return Promise.resolve({ connection: "connected" });
      },
      sync() {
        flaky.syncs += 1;
        flaky.failed = flaky.down;
        return flaky.down ? Promise.reject(new Error("那边出错了")) : Promise.resolve({ added: 1 });
      },
    });
  },
  setup() {},
};
afterEach(() => {
  calRemote.next = [];
  flaky.down = false;
  flaky.failed = false;
  flaky.syncs = 0;
  calRemote.note = undefined;
});

describe("登记后在设置 · 数据源里一处列出", () => {
  it("名字、插件、没连、两种用法和默认、敏感类别（默认不用于推断）、认哪种文件、定期导入的时间；手动导入的数据源是 manual", async () => {
    const k = await startPluginKernel({ plugins: [fakeDataSourcePlugin] });
    const view = k.dataSources.view();
    expect(view.sources.map((s) => s.id)).toEqual([FAKE_SOURCE_ID, FAKE_BILLS_ID]);
    expect(view.sources[0]).toEqual({
      id: FAKE_SOURCE_ID,
      title: "假数据源",
      summary: "测试用：每次同步拉回几条假记录",
      plugin: FAKE_SOURCE_PLUGIN,
      pluginTitle: "假数据源",
      available: true,
      connection: "not_connected",
      usages: [
        { usage: "query", on: true },
        { usage: "import", on: true },
      ],
      sensitive: [
        { id: "health", title: "健康", inferable: false },
        { id: "location", title: "位置", inferable: false },
      ],
      count: 0,
      syncing: false,
      canSync: false,
      schedule: expect.stringContaining("04:00"),
      files: ["假记录文件（.fake）"],
      configurable: true,
      // 306：导入的记录登记了素材来源（断开的确认框说"素材"）；还没填 Key，没有 hasSecrets
      toMaterials: true,
    });
    expect(view.sources[1]).toMatchObject({ id: FAKE_BILLS_ID, connection: "manual", usages: [{ usage: "import", on: true }], canSync: false, configurable: false, files: ["假账单（.csv）"] });
    expect(view.folder).toMatchObject({ path: k.layout.imports, importedPath: k.layout.importedDir, pending: [], recent: [] });
  });

  it("数据源的 id 不合规矩、重名都是写错了代码：插件装不上契约就报错", async () => {
    await expect(startPluginKernel({ plugins: [bad({ id: "Bad Id" })] })).rejects.toThrow(/数据源的 id/);
    await expect(startPluginKernel({ plugins: [fakeDataSourcePlugin, bad({ id: FAKE_SOURCE_ID })] })).rejects.toThrow(/已经登记过了/);
  });
});

describe("填设置、立即同步", () => {
  it("填 Key：存进密钥区那一格（不进事件、日志），连着了、能同步；Key 不对的写明原因、不存", async () => {
    const k = await startPluginKernel({ plugins: [fakeDataSourcePlugin] });
    const wrong = await k.dataSources.act(FAKE_SOURCE_ID, { action: "configure", values: { key: "bad" }, idempotencyKey: key() });
    expect(wrong.view.sources[0]).toMatchObject({ connection: "error", problem: "Key 不对", canSync: false });
    expect(fs.existsSync(secretFile(k, FAKE_SOURCE_ID))).toBe(false);

    expect(wrong.view.sources[0]!.hasSecrets).toBeUndefined();

    const ok = await connect(k);
    expect(ok.view.sources[0]).toMatchObject({ connection: "connected", account: "fake-user", canSync: true, hasSecrets: true });
    expect(fs.readFileSync(secretFile(k, FAKE_SOURCE_ID), "utf8")).toContain(FAKE_KEY);
    // Key 只在密钥区：事件日志、日志里都没有
    const everything = k.store.readGlobal(0, 100_000).map((e) => JSON.stringify(e.payload)).join("\n");
    expect(everything).not.toContain(FAKE_KEY);
    expect(k.logs.join("\n")).not.toContain(FAKE_KEY);
  });

  it("立即同步：拉回的记录写成插件的事件，共几条、上次同步（时间、新进来几条、立即同步）对；再同步一次接着数", async () => {
    const k = await startPluginKernel({ plugins: [fakeDataSourcePlugin] });
    await connect(k);
    fakeRemote.next = ["早上跑了 5 公里", "下午在公司开会"];
    const first = await k.dataSources.act(FAKE_SOURCE_ID, { action: "sync", idempotencyKey: key() });
    expect(first.added).toBe(2);
    expect(first.view.sources[0]).toMatchObject({ count: 2, syncing: false, lastSync: { at: "2026-10-24T09:00:00.000+08:00", trigger: "manual", added: 2 } });
    expect(liveRecords(k, FAKE_RECORD).map((e) => (e.payload as { text: string }).text)).toEqual(["早上跑了 5 公里", "下午在公司开会"]);
    fakeRemote.next = ["晚上看书"];
    k.clock.advanceTo(new Date("2026-10-24T10:00:00+08:00"));
    const second = await k.dataSources.act(FAKE_SOURCE_ID, { action: "sync", idempotencyKey: key() });
    expect(second.view.sources[0]).toMatchObject({ count: 3, lastSync: { at: "2026-10-24T10:00:00.000+08:00", added: 1 } });
    expect(fakeRemote.syncs).toEqual(["manual", "manual"]);
  });

  it("同步出错：记下原因（原因里带着 Key 的换成 ***），下次照常；没连的、导入关着的不能同步", async () => {
    const k = await startPluginKernel({ plugins: [fakeDataSourcePlugin] });
    await expect(k.dataSources.act(FAKE_SOURCE_ID, { action: "sync", idempotencyKey: key() })).rejects.toThrow("假数据源还没连上");
    await connect(k);
    fakeRemote.fail = `401：Key ${FAKE_KEY} 已经失效`;
    const failed = await k.dataSources.act(FAKE_SOURCE_ID, { action: "sync", idempotencyKey: key() });
    expect(failed.error).toBe("401：Key *** 已经失效");
    expect(failed.view.sources[0]!.lastSync).toMatchObject({ trigger: "manual", error: "401：Key *** 已经失效" });
    expect(k.store.readGlobal(0, 100_000).map((e) => JSON.stringify(e.payload)).join("\n")).not.toContain(FAKE_KEY);
    fakeRemote.fail = undefined;
    fakeRemote.next = ["好了"];
    expect((await k.dataSources.act(FAKE_SOURCE_ID, { action: "sync", idempotencyKey: key() })).view.sources[0]!.lastSync).toEqual({ at: expect.any(String), trigger: "manual", added: 1 });
  });

  it("正在同步时再点一次：不再起一次，等同一次的结果", async () => {
    const k = await startPluginKernel({ plugins: [fakeDataSourcePlugin] });
    await connect(k);
    let release!: () => void;
    fakeRemote.gate = new Promise((resolve) => (release = resolve));
    fakeRemote.next = ["一条"];
    const a = k.dataSources.sync(FAKE_SOURCE_ID, "manual");
    expect(sourceOf(k, FAKE_SOURCE_ID).syncing).toBe(true);
    const b = k.dataSources.sync(FAKE_SOURCE_ID, "manual");
    release();
    expect(await a).toEqual({ added: 1 });
    expect(await b).toEqual({ added: 1 });
    expect(fakeRemote.syncs).toEqual(["manual"]);
  });
});

describe("两种用法的开关", () => {
  it("导入关了：不能立即同步、不定期；开关写进配置区的 data-sources.json，重启照旧", async () => {
    const k = await startPluginKernel({ plugins: [fakeDataSourcePlugin] });
    await connect(k);
    const off = await k.dataSources.act(FAKE_SOURCE_ID, { action: "usage", usage: "import", on: false, idempotencyKey: key() });
    expect(off.view.sources[0]).toMatchObject({ usages: [{ usage: "query", on: true }, { usage: "import", on: false }], canSync: false });
    await expect(k.dataSources.act(FAKE_SOURCE_ID, { action: "sync", idempotencyKey: key() })).rejects.toThrow("假数据源的导入关着");
    expect(JSON.parse(fs.readFileSync(k.layout.dataSourcesFile, "utf8"))).toEqual({ format: 1, usages: { [FAKE_SOURCE_ID]: { import: false } } });
    // 定期导入摘下了：到点不同步
    k.clock.advanceTo(new Date("2026-10-25T04:00:00+08:00"));
    await k.internalJobs.whenIdle();
    await k.dataSources.whenIdle();
    expect(fakeRemote.syncs).toEqual([]);
    // 没提供的用法开不了
    await expect(k.dataSources.act(FAKE_BILLS_ID, { action: "usage", usage: "query", on: true, idempotencyKey: key() })).rejects.toThrow("假账单没有按需查");
  });

  it("按需查：开着、连着时秘书有那个工具，关了马上没有（通知秘书重新装配），正在跑的一轮里再调回关着", async () => {
    const k = await startPluginKernel({ plugins: [fakeDataSourcePlugin] });
    await connect(k);
    expect(secretaryTools(k)).toContain(FAKE_QUERY_TOOL);
    const [tool] = k.agent.toolsFor(SECRETARY_TARGET).filter((t) => t.spec.name === FAKE_QUERY_TOOL);
    let changes = 0;
    k.agent.onChange(() => (changes += 1));
    await k.dataSources.act(FAKE_SOURCE_ID, { action: "usage", usage: "query", on: false, idempotencyKey: key() });
    expect(changes).toBeGreaterThan(0);
    expect(secretaryTools(k)).not.toContain(FAKE_QUERY_TOOL);
    expect(await tool!.run({}, { toolCallId: "c-1" })).toMatchObject({ isError: true, text: expect.stringContaining("假数据源的按需查关着") });
  });
});

describe("按需查的工具只在连上时给（306 号票）", () => {
  it("没连不给；填好 Key 才给（通知一次）；同步了、别的插件起停、和它无关的开关都不通知；Key 失效（同步时碰到）又不给（通知一次），正在跑的一轮里再调回出错了", async () => {
    const k = await startPluginKernel({ plugins: [fakeDataSourcePlugin, other] });
    expect(secretaryTools(k)).not.toContain(FAKE_QUERY_TOOL);
    let changes = 0;
    k.agent.onChange(() => (changes += 1));
    // 没连上时开关按需查：给出去的没变（都是没有），不通知
    await k.dataSources.act(FAKE_SOURCE_ID, { action: "usage", usage: "query", on: false, idempotencyKey: key() });
    await k.dataSources.act(FAKE_SOURCE_ID, { action: "usage", usage: "query", on: true, idempotencyKey: key() });
    expect(changes).toBe(0);
    await connect(k);
    expect(changes).toBe(1);
    expect(secretaryTools(k)).toContain(FAKE_QUERY_TOOL);
    const [tool] = k.agent.toolsFor(SECRETARY_TARGET).filter((t) => t.spec.name === FAKE_QUERY_TOOL);
    // 状态没变的同步、别的插件起停、导入的开关：不通知
    fakeRemote.next = ["一"];
    await k.dataSources.act(FAKE_SOURCE_ID, { action: "sync", idempotencyKey: key() });
    await k.settings.act("other", { action: "disable", idempotencyKey: key() });
    await k.settings.act("other", { action: "enable", idempotencyKey: key() });
    await k.dataSources.act(FAKE_SOURCE_ID, { action: "usage", usage: "import", on: false, idempotencyKey: key() });
    await k.dataSources.act(FAKE_SOURCE_ID, { action: "usage", usage: "import", on: true, idempotencyKey: key() });
    expect(changes).toBe(1);
    // Key 失效：同步时远端不认，出错了、不给了，通知一次
    fakeRemote.refuseKey = true;
    expect((await k.dataSources.act(FAKE_SOURCE_ID, { action: "sync", idempotencyKey: key() })).error).toBe("Key 失效了");
    expect(sourceOf(k, FAKE_SOURCE_ID)).toMatchObject({ connection: "error", problem: "Key 失效了" });
    expect(changes).toBe(2);
    expect(secretaryTools(k)).not.toContain(FAKE_QUERY_TOOL);
    // 正在跑的一轮里再调：回出错了和原因（不叫插件）
    expect(await tool!.run({}, { toolCallId: "c-1" })).toMatchObject({ isError: true, text: expect.stringContaining("假数据源出错了（Key 失效了）") });
    // 重新填好：又给了
    fakeRemote.refuseKey = false;
    await connect(k);
    expect(changes).toBe(3);
    expect(secretaryTools(k)).toContain(FAKE_QUERY_TOOL);
  });

  it("按需查时插件发现 Key 失效：这一次照样回插件的结果，查完通知秘书重新装配（之后不给）；断开了再调回没连上", async () => {
    const k = await startPluginKernel({ plugins: [fakeDataSourcePlugin] });
    await connect(k);
    const [tool] = k.agent.toolsFor(SECRETARY_TARGET).filter((t) => t.spec.name === FAKE_QUERY_TOOL);
    let changes = 0;
    k.agent.onChange(() => (changes += 1));
    fakeRemote.refuseKey = true;
    expect(await tool!.run({}, { toolCallId: "c-1" })).toEqual({ text: "Key 失效了", isError: true });
    expect(changes).toBe(1);
    expect(secretaryTools(k)).not.toContain(FAKE_QUERY_TOOL);
    // 断开：没连上
    fakeRemote.refuseKey = false;
    await k.dataSources.act(FAKE_SOURCE_ID, { action: "disconnect", purge: false, idempotencyKey: key() });
    expect(await tool!.run({}, { toolCallId: "c-2" })).toMatchObject({ isError: true, text: expect.stringContaining("假数据源没连上") });
  });
});

describe("出错的自己回来：每小时替它再试一次（306 号票）", () => {
  it("有 recheck 的：到点才叫；远端还不认照旧出错、再挂一小时；好了回到连着、秘书重新拿到工具（通知一次）；页面写明每小时再试", async () => {
    const k = await startPluginKernel({ plugins: [fakeDataSourcePlugin] });
    await connect(k);
    // 秘书装配过（拿过一次工具）才有"变了要通知"；每次通知后秘书重新装配一次
    expect(secretaryTools(k)).toContain(FAKE_QUERY_TOOL);
    let changes = 0;
    k.agent.onChange(() => (changes += 1));
    fakeRemote.refuseKey = true;
    await k.dataSources.act(FAKE_SOURCE_ID, { action: "sync", idempotencyKey: key() });
    expect(sourceOf(k, FAKE_SOURCE_ID)).toMatchObject({ connection: "error", autoRetry: true });
    expect(changes).toBe(1);
    expect(secretaryTools(k)).not.toContain(FAKE_QUERY_TOOL);
    const failedAt = k.clock.now();
    k.clock.advanceTo(failedAt + 59 * 60_000);
    await k.dataSources.whenIdle();
    expect(fakeRemote.rechecks).toBe(0);
    // 一小时到点：试了，远端还不认
    k.clock.advanceTo(failedAt + 60 * 60_000);
    await k.dataSources.whenIdle();
    expect(fakeRemote.rechecks).toBe(1);
    expect(sourceOf(k, FAKE_SOURCE_ID)).toMatchObject({ connection: "error", autoRetry: true });
    expect(changes).toBe(1);
    // 远端好了，又过一小时：回到连着，工具回来
    fakeRemote.refuseKey = false;
    k.clock.advanceTo(failedAt + 120 * 60_000);
    await k.dataSources.whenIdle();
    expect(fakeRemote.rechecks).toBe(2);
    expect(sourceOf(k, FAKE_SOURCE_ID).connection).toBe("connected");
    expect(sourceOf(k, FAKE_SOURCE_ID).autoRetry).toBeUndefined();
    expect(changes).toBe(2);
    expect(secretaryTools(k)).toContain(FAKE_QUERY_TOOL);
    // 好了以后不再试
    k.clock.advanceTo(failedAt + 240 * 60_000);
    await k.dataSources.whenIdle();
    expect(fakeRemote.rechecks).toBe(2);
  });

  it("只是填设置没过、什么都没存的不试；插件停用、断开了的不试", async () => {
    const k = await startPluginKernel({ plugins: [fakeDataSourcePlugin] });
    await k.dataSources.act(FAKE_SOURCE_ID, { action: "configure", values: { key: "bad" }, idempotencyKey: key() });
    expect(sourceOf(k, FAKE_SOURCE_ID)).toMatchObject({ connection: "error" });
    expect(sourceOf(k, FAKE_SOURCE_ID).autoRetry).toBeUndefined();
    await connect(k);
    fakeRemote.refuseKey = true;
    await k.dataSources.act(FAKE_SOURCE_ID, { action: "sync", idempotencyKey: key() });
    expect(sourceOf(k, FAKE_SOURCE_ID).autoRetry).toBe(true);
    await k.dataSources.act(FAKE_SOURCE_ID, { action: "disconnect", purge: false, idempotencyKey: key() });
    k.clock.advanceTo(k.clock.now() + 61 * 60_000);
    await k.dataSources.whenIdle();
    expect(fakeRemote.rechecks).toBe(0);
  });

  it("没有 recheck 的：导入开着就照同步那样同步一次（不看连没连着），成了回到连着；导入关着的不试", async () => {
    const k = await startPluginKernel({ plugins: [flakyPlugin] });
    await k.dataSources.act(FLAKY_ID, { action: "configure", values: { key: "k" }, idempotencyKey: key() });
    flaky.down = true;
    expect((await k.dataSources.act(FLAKY_ID, { action: "sync", idempotencyKey: key() })).error).toBe("那边出错了");
    expect(sourceOf(k, FLAKY_ID)).toMatchObject({ connection: "error", autoRetry: true });
    flaky.down = false;
    k.clock.advanceTo(k.clock.now() + 60 * 60_000);
    await k.dataSources.whenIdle();
    expect(flaky.syncs).toBe(2);
    expect(sourceOf(k, FLAKY_ID)).toMatchObject({ connection: "connected", lastSync: { trigger: "scheduled", added: 1 } });
    // 导入关着：出错了也不试
    flaky.down = true;
    await k.dataSources.act(FLAKY_ID, { action: "sync", idempotencyKey: key() });
    await k.dataSources.act(FLAKY_ID, { action: "usage", usage: "import", on: false, idempotencyKey: key() });
    expect(sourceOf(k, FLAKY_ID).autoRetry).toBeUndefined();
    k.clock.advanceTo(k.clock.now() + 61 * 60_000);
    await k.dataSources.whenIdle();
    expect(flaky.syncs).toBe(3);
  });
});

describe("外部日历的版本（306 号票）", () => {
  it("交给日历的数据源写进了新记录（同一批只加一次）、断开、插件起停时版本往上加并通知；别的记录、什么都没变的同步不加", async () => {
    const k = await startPluginKernel({ plugins: [calendarSourcePlugin, fakeDataSourcePlugin] });
    const seen: number[] = [];
    k.dataSources.onCalendarChange((v) => seen.push(v));
    const v0 = k.dataSources.calendarVersion();
    expect(v0).toBeGreaterThan(0);
    // 连上（连接状态变了）：加一次
    await k.dataSources.act(CAL_ID, { action: "configure", values: { key: "k" }, idempotencyKey: key() });
    expect(seen).toHaveLength(1);
    // 同步写进两条（一批）：加一次
    calRemote.next = ["开会", "看牙医"];
    await k.dataSources.act(CAL_ID, { action: "sync", idempotencyKey: key() });
    await Promise.resolve();
    expect(seen).toHaveLength(2);
    // 什么都没变的同步、别的数据源的记录：不加
    await k.dataSources.act(CAL_ID, { action: "sync", idempotencyKey: key() });
    await connect(k);
    fakeRemote.next = ["一"];
    await k.dataSources.act(FAKE_SOURCE_ID, { action: "sync", idempotencyKey: key() });
    await Promise.resolve();
    expect(seen).toHaveLength(2);
    // 插件停用、启用：各加一次
    await k.settings.act(CAL_PLUGIN, { action: "disable", idempotencyKey: key() });
    await k.settings.act(CAL_PLUGIN, { action: "enable", idempotencyKey: key() });
    expect(seen).toHaveLength(4);
    // 断开：加一次
    await k.dataSources.act(CAL_ID, { action: "disconnect", purge: false, idempotencyKey: key() });
    expect(seen).toHaveLength(5);
    // 只增不减，最后一次就是现在的版本
    expect(seen.every((v, i) => v > (i === 0 ? v0 : seen[i - 1]!))).toBe(true);
    expect(k.dataSources.calendarVersion()).toBe(seen.at(-1));
  });
});

describe("断开的确认框按数据源说话（306 号票）", () => {
  it("没有密钥、不进素材的不写 hasSecrets / toMaterials；数据源登记的那一句插件停用时照样给，插件报的优先", async () => {
    const k = await startPluginKernel({ plugins: [calendarSourcePlugin] });
    expect(sourceOf(k, CAL_ID)).toMatchObject({ disconnectNote: "同步来的日程从日历里拿掉" });
    expect(sourceOf(k, CAL_ID).hasSecrets).toBeUndefined();
    expect(sourceOf(k, CAL_ID).toMaterials).toBeUndefined();
    calRemote.note = "插件报的一句";
    expect(sourceOf(k, CAL_ID).disconnectNote).toBe("插件报的一句");
    await k.settings.act(CAL_PLUGIN, { action: "disable", idempotencyKey: key() });
    expect(sourceOf(k, CAL_ID).disconnectNote).toBe("同步来的日程从日历里拿掉");
  });
});

describe("断开", () => {
  it("留着已导入的：记录还在、条数照旧；密钥区那一格删掉、没连了；插件自己的清理收到 purge=false", async () => {
    const k = await startPluginKernel({ plugins: [fakeDataSourcePlugin] });
    await connect(k);
    fakeRemote.next = ["一", "二"];
    await k.dataSources.act(FAKE_SOURCE_ID, { action: "sync", idempotencyKey: key() });
    const result = await k.dataSources.act(FAKE_SOURCE_ID, { action: "disconnect", purge: false, idempotencyKey: key() });
    expect(result.purged).toBeUndefined();
    expect(result.view.sources[0]).toMatchObject({ connection: "not_connected", count: 2, canSync: false });
    expect(result.view.sources[0]!.lastSync).toBeUndefined();
    expect(fs.existsSync(secretFile(k, FAKE_SOURCE_ID))).toBe(false);
    expect(liveRecords(k, FAKE_RECORD)).toHaveLength(2);
    expect(fakeRemote.disconnects).toEqual([false]);
  });

  it("连已导入的一起删：它的记录整条换成已删除标记、条数归零、同步记录跟着删；同一个键重发只删一次", async () => {
    const k = await startPluginKernel({ plugins: [fakeDataSourcePlugin] });
    await connect(k);
    fakeRemote.next = ["一", "二", "三"];
    await k.dataSources.act(FAKE_SOURCE_ID, { action: "sync", idempotencyKey: key() });
    const purgeKey = key();
    const result = await k.dataSources.act(FAKE_SOURCE_ID, { action: "disconnect", purge: true, idempotencyKey: purgeKey });
    expect(result.purged).toEqual({ events: 4, materials: 0, files: 0 });
    expect(result.view.sources[0]).toMatchObject({ connection: "not_connected", count: 0 });
    expect(k.store.read(FAKE_CHANNEL, 0, FAKE_RECORD).every((e) => isDeletedEventPayload(e.payload))).toBe(true);
    expect(fakeRemote.disconnects).toEqual([true]);
    const again = await k.dataSources.act(FAKE_SOURCE_ID, { action: "disconnect", purge: true, idempotencyKey: purgeKey });
    expect(again.purged).toEqual({ events: 4, materials: 0, files: 0 });
    expect(fakeRemote.disconnects).toEqual([true]);
    // 别的数据源的记录不动
    drop(k, "bills.csv", "假账单\n午饭 30\n");
    await k.dataSources.scan();
    await k.dataSources.act(FAKE_SOURCE_ID, { action: "disconnect", purge: true, idempotencyKey: key() });
    expect(liveRecords(k, FAKE_BILL)).toHaveLength(1);
  });

  it("插件停用着：写明插件没启用、不能同步和按需查；断开并删照样能做（密钥区那一格、记录都删得掉）", async () => {
    const k = await startPluginKernel({ plugins: [fakeDataSourcePlugin] });
    await connect(k);
    fakeRemote.next = ["一"];
    await k.dataSources.act(FAKE_SOURCE_ID, { action: "sync", idempotencyKey: key() });
    await k.settings.act(FAKE_SOURCE_PLUGIN, { action: "disable", idempotencyKey: key() });
    expect(sourceOf(k, FAKE_SOURCE_ID)).toMatchObject({ available: false, unavailable: "假数据源插件没启用", canSync: false, count: 1 });
    expect(secretaryTools(k)).not.toContain(FAKE_QUERY_TOOL);
    await expect(k.dataSources.act(FAKE_SOURCE_ID, { action: "sync", idempotencyKey: key() })).rejects.toThrow("假数据源插件没启用");
    const result = await k.dataSources.act(FAKE_SOURCE_ID, { action: "disconnect", purge: true, idempotencyKey: key() });
    expect(result.purged).toMatchObject({ events: 2 });
    expect(fs.existsSync(secretFile(k, FAKE_SOURCE_ID))).toBe(false);
    expect(fakeRemote.disconnects).toEqual([]);
    expect(sourceOf(k, FAKE_SOURCE_ID).count).toBe(0);
  });
});

describe("定期导入", () => {
  it("连着、导入开着：每天 04:00 同步一次（定期导入）；没连的时候到点什么都不做", async () => {
    const k = await startPluginKernel({ plugins: [fakeDataSourcePlugin] });
    // 没连：到点不同步
    k.clock.advanceTo(new Date("2026-10-25T04:00:00+08:00"));
    await k.dataSources.whenIdle();
    expect(fakeRemote.syncs).toEqual([]);
    await connect(k);
    fakeRemote.next = ["夜里的一条"];
    k.clock.advanceTo(new Date("2026-10-26T04:00:00+08:00"));
    await k.internalJobs.whenIdle();
    await k.dataSources.whenIdle();
    expect(fakeRemote.syncs).toEqual(["scheduled"]);
    expect(sourceOf(k, FAKE_SOURCE_ID)).toMatchObject({ count: 1, lastSync: { trigger: "scheduled", added: 1 } });
  });
});

describe("共用导入文件夹", () => {
  it("认得的文件：交给那个数据源导入、挪进已导入，最近导入里有；认不出的留在原地并提示", async () => {
    const k = await startPluginKernel({ plugins: [fakeDataSourcePlugin] });
    drop(k, "today.fake", "FAKE\n第一条\n第二条\n");
    drop(k, "photo.zip", "PK...");
    drop(k, "notes.fake", "不是假记录\n");
    await k.dataSources.scan();
    expect(inFolder(k).toSorted()).toEqual(["notes.fake", "photo.zip"]);
    expect(imported(k)).toEqual(["today.fake"]);
    const view = k.dataSources.view();
    expect(view.sources[0]).toMatchObject({ count: 2, lastSync: { trigger: "file", added: 2, file: "today.fake" } });
    expect(view.folder.recent).toEqual([{ name: "today.fake", source: FAKE_SOURCE_ID, sourceTitle: "假数据源", at: expect.any(String), added: 2 }]);
    expect(view.folder.pending.map((p) => [p.name, p.problem])).toEqual([
      ["notes.fake", "unrecognized"],
      ["photo.zip", "unrecognized"],
    ]);
    expect(view.folder.pending[0]!.text).toContain("认不出");
    expect(view.folder.scannedAt).toBeDefined();
  });

  it("重名的挪进已导入时加序号；手动导入的数据源（没有连接）也认文件", async () => {
    const k = await startPluginKernel({ plugins: [fakeDataSourcePlugin] });
    drop(k, "bills.csv", "假账单\n午饭 30\n晚饭 50\n");
    await k.dataSources.scan();
    drop(k, "bills.csv", "假账单\n早饭 10\n");
    await k.dataSources.scan();
    expect(imported(k).toSorted()).toEqual(["bills (2).csv", "bills.csv"]);
    expect(sourceOf(k, FAKE_BILLS_ID)).toMatchObject({ count: 3, connection: "manual" });
    expect(inFolder(k)).toEqual([]);
  });

  it("几个数据源都认、插件没启用、导入关着：留在原地，提示写明是哪种情况", async () => {
    const twin: PluginDefinition = {
      name: "twin",
      title: "双胞胎",
      contracts: (ctx) =>
        ctx.dataSources.register({ id: "twin", title: "另一个数据源", usages: { import: { default: true } }, files: [{ title: "也认 .fake", extensions: [".fake"], import: () => Promise.resolve({ added: 0 }) }] }),
      setup() {},
    };
    const k = await startPluginKernel({ plugins: [fakeDataSourcePlugin, twin] });
    drop(k, "both.fake", "FAKE\n一\n");
    await k.dataSources.scan();
    expect(k.dataSources.view().folder.pending).toEqual([{ name: "both.fake", size: expect.any(Number), problem: "ambiguous", text: expect.stringMatching(/假数据源.*另一个数据源/) }]);

    const k2 = await startPluginKernel({ plugins: [fakeDataSourcePlugin] });
    await k2.dataSources.act(FAKE_BILLS_ID, { action: "usage", usage: "import", on: false, idempotencyKey: key() });
    drop(k2, "bills.csv", "假账单\n午饭 30\n");
    await k2.settings.act(FAKE_SOURCE_PLUGIN, { action: "disable", idempotencyKey: key() });
    drop(k2, "today.fake", "FAKE\n一\n");
    await k2.dataSources.scan();
    expect(k2.dataSources.view().folder.pending.map((p) => [p.name, p.problem, p.text])).toEqual([
      ["bills.csv", "plugin_off", expect.stringContaining("假数据源插件没启用")],
      ["today.fake", "plugin_off", expect.stringContaining("假数据源插件没启用")],
    ]);
    await k2.settings.act(FAKE_SOURCE_PLUGIN, { action: "enable", idempotencyKey: key() });
    await k2.dataSources.scan();
    expect(k2.dataSources.view().folder.pending.map((p) => [p.name, p.problem])).toEqual([["bills.csv", "import_off"]]);
    expect(imported(k2)).toEqual(["today.fake"]);
  });

  it("导入出错：挪回原地、提示原因；自动再看时不重试，手动再看一遍（现在检查）时重试", async () => {
    const k = await startPluginKernel({ plugins: [fakeDataSourcePlugin] });
    fakeRemote.importFail = "第 3 行格式不对";
    drop(k, "today.fake", "FAKE\n一\n");
    await k.dataSources.scan();
    expect(inFolder(k)).toEqual(["today.fake"]);
    expect(imported(k)).toEqual([]);
    expect(k.dataSources.view().folder.pending).toEqual([{ name: "today.fake", size: expect.any(Number), problem: "failed", text: expect.stringContaining("第 3 行格式不对") }]);
    fakeRemote.importFail = undefined;
    await k.dataSources.scan();
    expect(inFolder(k)).toEqual(["today.fake"]);
    const result = await k.dataSources.folder({ action: "scan" });
    expect(result.view.folder.pending).toEqual([]);
    expect(imported(k)).toEqual(["today.fake"]);
  });

  it("在电脑上打开：交给打开文件夹的那一下（测试换成假的）", async () => {
    const k = await startPluginKernel({ plugins: [fakeDataSourcePlugin] });
    expect(await k.dataSources.folder({ action: "open" })).toMatchObject({ opened: true });
    expect(k.openedFolders).toEqual([k.layout.imports]);
    expect(fs.existsSync(k.layout.importedDir)).toBe(true);
  });
});
