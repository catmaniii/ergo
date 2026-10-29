// 插件宿主（126 号票，ADR-0027）：按依赖排序装、依赖方先停；每次注册返回撤销函数、记在插件名下，停用时全部撤掉；
// 缺依赖的不装、原因可见；可选依赖；数据契约停用也登记；装配、启动出错的不装，依赖它的也不装；停用的插件的视图不再更新。
// 用真的登记表：卡片类型、彻底删除的改写函数、素材模块、快速动作、内部作业、看板种类、事件触发的订阅方、agent 贡献（128 号票）、
// 转发登记表（132 号票）、运营手段（130 号票）、agent 运行时（286 号票）、事件存储。
// 走组合根和插件清单的那条路在主切面测（test/main/plugins.test.ts）。
import path from "node:path";
import { type EventType, Type, workdayCalendar } from "@ergo/protocol";
import { describe, expect, it, onTestFinished } from "vitest";
import { defineHostTool } from "../../src/agent-manager/host-tools.ts";
import { createAgentContributions } from "../../src/agent-host/contributions.ts";
import { createAppRegistry } from "../../src/apps/registry.ts";
import { boardKind, BoardKindRegistry } from "../../src/board/kinds.ts";
import { CardTypeRegistry } from "../../src/cards/registry.ts";
import { cardsView } from "../../src/cards/views.ts";
import { createDataSourceRegistry } from "../../src/data-sources/registry.ts";
import { RequestRejected } from "../../src/errors.ts";
import { EventSubscriberRegistry } from "../../src/event-sources/index.ts";
import { createEphemeralBus } from "../../src/events/ephemeral.ts";
import { type DerivedView, type EventStore, openEventStore, type StoredEvent } from "../../src/events/event-store.ts";
import type { PurgeQuotes, PurgeRewriter } from "../../src/events/purge.ts";
import { createInboxService } from "../../src/inbox/inbox.ts";
import { inboxView } from "../../src/inbox/views.ts";
import { type MaterialSource, userDecisionDraft } from "../../src/materials/capture.ts";
import { openMaterials } from "../../src/materials/materials.ts";
import { PurgeRewriters } from "../../src/memory/rewriters.ts";
import { OperationMeansRegistry } from "../../src/operations/index.ts";
import { bindService, createPluginHost, type PluginContext, type PluginDefinition, type PluginHost, serviceKey } from "../../src/plugins/host.ts";
import { QuickActionRegistry } from "../../src/quick-actions/index.ts";
import { createRuntimeRegistry, piRuntime } from "../../src/runtime/index.ts";
import { clockIso } from "../../src/scheduler/clock.ts";
import { createInternalJobs, internalJobsView } from "../../src/scheduler/internal-jobs.ts";
import { createScheduler } from "../../src/scheduler/scheduler.ts";
import { suggestTaskFixture } from "../helpers/card-fixtures.ts";
import { ManualClock } from "../helpers/clock.ts";
import { FakeEmbedder } from "../helpers/embedder.ts";
import { FAKE_RUNTIME_ENTRY, fakeRuntime, fakeRuntimePlugin } from "../helpers/fake-runtime.ts";
import { tidyNoteFixture } from "../helpers/quick-action-fixtures.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const START = new Date("2026-10-08T09:00:00+08:00");
/** 测试插件拥有的事件类型 */
const NOTE_EVENT = "test_plugin_note" as EventType;
/** 内核给插件的服务（替身）：事件存储 */
const STORE = serviceKey<EventStore>("store");

/** 测试插件的视图：数一数笔记事件 */
const notesView: DerivedView = {
  name: "test_notes",
  create: (db) => db.exec("CREATE TABLE IF NOT EXISTS test_notes (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL)"),
  clear: (db) => db.exec("DELETE FROM test_notes"),
  apply(db, event) {
    if (event.type !== NOTE_EVENT) return;
    db.run("INSERT INTO test_notes (id, n) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET n = n + 1");
  },
};
const noteCount = (store: EventStore) => Number(store.reader.get<{ n: number }>("SELECT n FROM test_notes")?.n ?? 0);

/**
 * 内核的替身：真的事件存储（登记宿主收齐的视图，记下停着的）和各登记表。setup 在素材模块启动之前（和组合根一样），
 * 测试结束时先停宿主再关库
 */
async function kernel(host: PluginHost, options: { dir?: string } = {}) {
  const dir = options.dir ?? makeTempDir("ergo-plugins-");
  const clock = new ManualClock(START);
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  const store = openEventStore({ file: path.join(dir, "ergo.db"), views: [cardsView, inboxView, internalJobsView, ...host.views()], dormantViews: host.dormantViews(), now: () => clockIso(clock), log });
  const scheduler = createScheduler({ clock, log });
  const cardTypes = new CardTypeRegistry();
  const purge = new PurgeRewriters();
  const quickActions = new QuickActionRegistry();
  const boardKinds = new BoardKindRegistry([]);
  const eventSubscribers = new EventSubscriberRegistry();
  const operationMeans = new OperationMeansRegistry();
  const agent = createAgentContributions({ log });
  const apps = createAppRegistry();
  const runtimes = createRuntimeRegistry({ log });
  runtimes.register(piRuntime);
  const dataSources = createDataSourceRegistry();
  const internalJobs = createInternalJobs({ store, scheduler, clock, log, scheduleContext: () => ({ calendar: workdayCalendar([], { rules: [], marks: [] }) }) });
  const inbox = createInboxService({ store, notifications: createEphemeralBus(), now: () => clockIso(clock) });
  const materials = openMaterials({ store, dbDir: dir, materialsDir: path.join(dir, "materials"), log });
  // 采成素材（记忆插件开着时那样，129 号票）：插件经契约声明的来源采得出素材
  materials.collect({ embedder: new FakeEmbedder(), scheduler, clock, inbox, staleCardDays: 7 });
  let closed = false;
  /** 停宿主、关库（只做一次；测试里换一个宿主接着用同一个数据目录时先叫它） */
  const close = async () => {
    if (closed) return;
    closed = true;
    await host.stop();
    await internalJobs.stop();
    await materials.stop();
    scheduler.stop();
    store.close();
  };
  onTestFinished(close);
  const k = { dir, clock, logs, store, scheduler, cardTypes, purge, quickActions, boardKinds, eventSubscribers, operationMeans, agent, apps, runtimes, dataSources, internalJobs, materials, close };
  await host.setup({
    services: [bindService(STORE, store)],
    surfaces: {
      cardTypes,
      purge,
      materialSources: materials,
      quickActions,
      internalJobs,
      boardKinds,
      eventSubscribers,
      operationMeans,
      agent,
      apps,
      views: { detach: (name) => store.detachView(name), attach: (view) => store.attachView(view) },
      runtimes,
      dataSources,
    },
  });
  await host.start();
  materials.start();
  return k;
}

/** 建宿主：日志收进 logs */
function hostOf(plugins: readonly PluginDefinition[], disabled: readonly string[] = [], removed: readonly string[] = []) {
  const logs: string[] = [];
  const host = createPluginHost({ plugins, disabled, removed, kernel: [STORE], log: (line) => logs.push(line) });
  return { host, logs };
}

/** 一个只记下装配、start、stop 先后的插件 */
function tracer(name: string, trace: string[], extra: Partial<PluginDefinition> = {}): PluginDefinition {
  return {
    name,
    title: name,
    ...extra,
    setup(ctx) {
      trace.push(`${name}:setup`);
      for (const key of extra.provides ?? []) ctx.provide(key, { from: name });
      ctx.lifecycle({ start: () => void trace.push(`${name}:start`), stop: () => void trace.push(`${name}:stop`) });
    },
  };
}

describe("注册都能撤销", () => {
  it("一个插件登记卡片类型、改写函数和引用、快速动作、内部作业、看板种类、事件触发的订阅方、运营手段、agent 贡献、转发的应用、监听、视图、start/stop → 停用 → 都不在了（倒着撤），之后再登记报错", async () => {
    const NOTES = serviceKey<{ hello: string }>("notes");
    const trace: string[] = [];
    let saved: PluginContext | undefined;
    const seen: string[] = [];
    const quoted: StoredEvent[] = [];
    const notePurge: PurgeRewriter = { eventType: NOTE_EVENT, rewrite: () => ({ deleted: true }) };
    const noteQuotes: PurgeQuotes = { eventType: "test_quoted", quotedIn: () => quoted };
    const noteTool = defineHostTool({ name: "note_lookup", title: "查笔记", description: "查笔记", parameters: Type.Object({}), readOnlyOrIdempotent: true, run: () => ({ text: "没有" }) });
    const lateTool = defineHostTool({ name: "note_late", title: "笔记的末尾工具", description: "测试用", parameters: Type.Object({}), readOnlyOrIdempotent: true, run: () => ({ text: "没有" }) });
    const notes: PluginDefinition = {
      name: "notes",
      title: "笔记",
      needs: [STORE],
      provides: [NOTES],
      views: [notesView],
      setup(ctx) {
        saved = ctx;
        const store = ctx.use(STORE);
        ctx.provide(NOTES, { hello: "笔记" });
        ctx.cardTypes.register(suggestTaskFixture);
        ctx.purge.register(notePurge);
        ctx.purge.registerQuotes(noteQuotes);
        ctx.quickActions.register(tidyNoteFixture);
        ctx.internalJobs.register({ name: "test-notes-digest", schedule: { kind: "daily", time: "03:00" }, run: async () => {} });
        ctx.boardKinds.register(
          boardKind<{ id: string }>({ label: "笔记", order: 15, describes: "每条笔记", eventType: NOTE_EVENT, fromEvent: (p) => p as { id: string }, list: () => [], toEntry: (n) => ({ key: n.id, name: n.id, status: "", group: undefined }) }),
        );
        ctx.eventSubscribers.register({ kind: "note", subscriptions: () => [], watches: () => false, deliver: () => {} });
        // 运营手段（130 号票）：要用户手动的一种
        ctx.operationMeans.register({ id: "note_board", label: "笔记墙", hint: "贴到笔记墙上", automatic: false, check: () => [], describe: () => "笔记墙" });
        // agent 贡献（128 号票）：给秘书的工具、跟在输入后面的和被唤起时注入的上下文块、钩子订阅
        ctx.agent.tools.register({ to: { agents: ["secretary"] }, tools: () => [noteTool] });
        ctx.agent.context.register({ when: "input", text: () => "【笔记】" });
        ctx.agent.context.register({ when: "wake", id: "briefing", text: () => "【笔记简报】" });
        ctx.agent.hooks.register({ id: "rules", kind: "system_prompt_suffix", text: () => "【笔记的规矩】" });
        // 212 号票：排在内核的工具之后的工具、输入附注
        ctx.agent.tools.register({ to: { agents: ["secretary"] }, at: "end", tools: () => [lateTool] });
        ctx.agent.notes.register({ text: () => "（笔记的附注）" });
        // 转发的应用（132 号票）
        ctx.apps.register({ name: "notes-web", target: "http://127.0.0.1:5173", title: "笔记" });
        ctx.effect(() => {
          const off = store.onAppend((e) => seen.push(e.type));
          return () => {
            trace.push("effect:undo");
            off();
          };
        });
        ctx.lifecycle({ start: () => void trace.push("start"), stop: () => void trace.push("stop") });
      },
    };
    const { host } = hostOf([notes]);
    const k = await kernel(host);

    const note = k.store.append({ channel: "notes-test", type: NOTE_EVENT, payload: { id: "n-1", text: "周三体检" } }).event;
    expect(host.report()).toEqual({ running: ["notes"], disabled: [], skipped: [] });
    expect(host.service(NOTES)).toEqual({ hello: "笔记" });
    expect(k.cardTypes.get("suggest_task")).toBeDefined();
    expect(k.purge.rewrite(note, { deletedAt: clockIso(k.clock), materialIds: new Set() })).toEqual({ deleted: true });
    quoted.push(note);
    expect(k.purge.related({ ...note, type: "test_quoted" }, k.store)).toEqual([note]);
    expect(k.quickActions.get("tidy_note")).toBeDefined();
    expect(k.internalJobs.state("test-notes-digest")).toBeDefined();
    expect(k.scheduler.pending().map((p) => p.key)).toContain("internal:test-notes-digest");
    expect(k.boardKinds.list().map((b) => b.label)).toEqual(["笔记"]);
    expect(k.eventSubscribers.list().map((s) => s.kind)).toEqual(["note"]);
    expect(k.operationMeans.list().map((m) => m.id)).toEqual(["note_board"]);
    const secretary = { agent: "secretary", agentId: "secretary", session: "secretary" } as const;
    expect(k.agent.toolsFor(secretary).map((t) => t.spec.name)).toEqual(["note_lookup"]);
    expect(k.agent.toolsFor({ agent: "task", agentId: "tm-1", session: "execution" })).toEqual([]);
    expect(k.agent.inputContextFor(secretary, {} as never)).toBe("【笔记】");
    expect(k.agent.toolsFor(secretary, "end").map((t) => t.spec.name)).toEqual(["note_late"]);
    expect(k.agent.inputNoteFor(secretary, {} as never)).toBe("（笔记的附注）");
    // 上下文块、钩子订阅的 id 前面加上插件名
    expect(k.agent.manifestFor(secretary)).toEqual({
      contextBlocks: [{ id: "notes:briefing", text: "【笔记简报】" }],
      hooks: [{ id: "notes:rules", kind: "system_prompt_suffix", text: "【笔记的规矩】" }],
    });
    expect(k.apps.get("notes-web")).toMatchObject({ title: "笔记", port: 5173 });
    expect(seen).toEqual([NOTE_EVENT]);
    expect(noteCount(k.store)).toBe(1);

    expect(await host.disable("notes")).toEqual(["notes"]);
    // 倒着撤：start/stop 最后声明的先撤，装配时登记的监听在它后面撤
    expect(trace).toEqual(["start", "stop", "effect:undo"]);
    expect(host.report()).toEqual({ running: [], disabled: ["notes"], skipped: [] });
    expect(host.service(NOTES)).toBeUndefined();
    expect(k.cardTypes.get("suggest_task")).toBeUndefined();
    expect(() => k.purge.rewrite(note, { deletedAt: clockIso(k.clock), materialIds: new Set() })).toThrow(/没有登记改写函数/);
    expect(k.purge.related({ ...note, type: "test_quoted" }, k.store)).toEqual([]);
    expect(k.quickActions.get("tidy_note")).toBeUndefined();
    expect(k.scheduler.pending().map((p) => p.key)).not.toContain("internal:test-notes-digest");
    expect(k.boardKinds.list()).toEqual([]);
    expect(k.eventSubscribers.list()).toEqual([]);
    expect(k.operationMeans.list()).toEqual([]);
    expect(k.agent.toolsFor(secretary)).toEqual([]);
    expect(k.agent.inputContextFor(secretary, {} as never)).toBeUndefined();
    expect(k.agent.toolsFor(secretary, "end")).toEqual([]);
    expect(k.agent.inputNoteFor(secretary, {} as never)).toBeUndefined();
    expect(k.agent.manifestFor(secretary)).toEqual({ contextBlocks: [], hooks: [] });
    expect(k.apps.list()).toEqual([]);
    // 新的笔记事件：监听不再收到、视图不再更新（表和里面的内容留着）
    k.store.append({ channel: "notes-test", type: NOTE_EVENT, payload: { id: "n-2", text: "周五复查" } });
    expect(seen).toEqual([NOTE_EVENT]);
    expect(noteCount(k.store)).toBe(1);
    // 停了以后再经它登记：报错，不会悄悄漏掉
    expect(() => saved!.cardTypes.register(suggestTaskFixture)).toThrow(/已经停了/);
    expect(() => saved!.effect(() => () => {})).toThrow(/已经停了/);
  });

  it("停用插件的视图下次装上时整表按事件日志补一遍（停着时追加的也算上）", async () => {
    const dir = makeTempDir("ergo-plugins-");
    const viewOnly: PluginDefinition = { name: "notes", title: "笔记", views: [notesView], setup: () => {} };
    const first = hostOf([viewOnly]);
    const k1 = await kernel(first.host, { dir });
    k1.store.append({ channel: "notes-test", type: NOTE_EVENT, payload: {} });
    await first.host.disable("notes");
    k1.store.append({ channel: "notes-test", type: NOTE_EVENT, payload: {} });
    expect(noteCount(k1.store)).toBe(1);
    await k1.close();

    // 配置里停用着再起一次：还是停着的，表不动
    const second = hostOf([viewOnly], ["notes"]);
    expect(second.host.views()).toEqual([]);
    expect(second.host.dormantViews()).toEqual(["test_notes"]);
    const k2 = await kernel(second.host, { dir });
    k2.store.append({ channel: "notes-test", type: NOTE_EVENT, payload: {} });
    await k2.close();

    // 又装上了：三条全算上
    const third = hostOf([viewOnly]);
    const k3 = await kernel(third.host, { dir });
    expect(noteCount(k3.store)).toBe(3);
    expect(k3.logs.some((l) => l.includes("视图 test_notes") && l.includes("整表按事件日志补一遍"))).toBe(true);
  });
});

describe("依赖靠声明", () => {
  const A = serviceKey<unknown>("a");
  const B = serviceKey<unknown>("b");

  it("按依赖排顺序装和启动（清单里的先后不算），守护进程停时依赖方先停", async () => {
    const trace: string[] = [];
    const { host } = hostOf([tracer("c", trace, { needs: [B] }), tracer("b", trace, { needs: [A], provides: [B] }), tracer("a", trace, { provides: [A] })]);
    await kernel(host);
    expect(trace).toEqual(["a:setup", "b:setup", "c:setup", "a:start", "b:start", "c:start"]);
    expect(host.report().running).toEqual(["a", "b", "c"]);
    await host.stop();
    expect(trace.slice(6)).toEqual(["c:stop", "b:stop", "a:stop"]);
  });

  it("运行中停用一个插件：依赖它的先停，都记成停用了（211 号票：设置里一起写进 plugins.disabled）", async () => {
    const trace: string[] = [];
    const { host, logs } = hostOf([tracer("a", trace, { provides: [A] }), tracer("b", trace, { needs: [A], provides: [B] }), tracer("c", trace, { needs: [B] }), tracer("d", trace)]);
    await kernel(host);
    trace.length = 0;
    expect(await host.disable("a")).toEqual(["a", "b", "c"]);
    expect(trace).toEqual(["c:stop", "b:stop", "a:stop"]);
    expect(host.report()).toEqual({ running: ["d"], disabled: ["a", "b", "c"], skipped: [] });
    expect(logs).toContain("插件停用了：b、c、a");
  });

  it("给网页的状况（193 号票）：清单里每个插件按清单的先后，名字、给人看的名字、在运行 / 停用了 / 没装上（带原因）；运行中停用时通知", async () => {
    const trace: string[] = [];
    const WEATHER = serviceKey<unknown>("weather");
    const { host } = hostOf([tracer("a", trace, { provides: [A], title: "甲" }), tracer("x", trace, { needs: [WEATHER] }), tracer("b", trace, { needs: [A] }), tracer("off", trace)], ["off"]);
    await kernel(host);
    expect(host.status()).toEqual([
      { name: "a", title: "甲", state: "running" },
      { name: "x", title: "x", state: "skipped", reason: "要的服务 weather 没有谁提供" },
      { name: "b", title: "b", state: "running" },
      { name: "off", title: "off", state: "disabled" },
    ]);
    let changes = 0;
    const off = host.onChange(() => changes++);
    await host.disable("a");
    expect(changes).toBe(1);
    expect(host.status().map((p) => [p.name, p.state, p.reason])).toEqual([
      ["a", "disabled", undefined],
      ["x", "skipped", "要的服务 weather 没有谁提供"],
      ["b", "disabled", undefined],
      ["off", "disabled", undefined],
    ]);
    // 已经停了的再停：没有变化，不通知；取消登记以后也不通知
    await host.disable("a");
    expect(changes).toBe(1);
    off();
    await host.stop();
    expect(changes).toBe(1);
  });

  it("缺依赖的不装：原因写进日志和 report（没人提供、提供它的插件在配置里停用了或没装、循环依赖）；它们的视图记成停着的", async () => {
    const trace: string[] = [];
    const P = serviceKey<unknown>("p");
    const Q = serviceKey<unknown>("q");
    const WEATHER = serviceKey<unknown>("weather");
    const { host, logs } = hostOf(
      [
        tracer("x", trace, { needs: [WEATHER], views: [notesView] }),
        tracer("a", trace, { provides: [A] }),
        tracer("y", trace, { needs: [A], provides: [B] }),
        tracer("z", trace, { needs: [B] }),
        tracer("p", trace, { needs: [Q], provides: [P] }),
        tracer("q", trace, { needs: [P], provides: [Q] }),
        tracer("ok", trace, { needs: [STORE] }),
      ],
      ["a", "nope"],
    );
    expect(host.views()).toEqual([]);
    expect(host.dormantViews()).toEqual(["test_notes"]);
    await kernel(host);
    expect(trace).toEqual(["ok:setup", "ok:start"]);
    expect(host.report()).toEqual({
      running: ["ok"],
      disabled: ["a"],
      skipped: [
        { plugin: "x", reason: "要的服务 weather 没有谁提供" },
        { plugin: "y", reason: "要的服务 a 由插件 a 提供，它在配置里停用了" },
        { plugin: "z", reason: "要的服务 b 由插件 y 提供，它没装（要的服务 a 由插件 a 提供，它在配置里停用了）" },
        { plugin: "p", reason: "循环依赖：p → q → p" },
        { plugin: "q", reason: "循环依赖：p → q → p" },
      ],
    });
    expect(logs).toEqual([
      "配置 plugins.disabled 里的 nope 不是认得的插件（认得的：x、a、y、z、p、q、ok），不管它",
      "插件 x（x）没装：要的服务 weather 没有谁提供",
      "插件 a（a）在配置里停用了",
      "插件 y（y）没装：要的服务 a 由插件 a 提供，它在配置里停用了",
      "插件 z（z）没装：要的服务 b 由插件 y 提供，它没装（要的服务 a 由插件 a 提供，它在配置里停用了）",
      "插件 p（p）没装：循环依赖：p → q → p",
      "插件 q（q）没装：循环依赖：p → q → p",
    ]);
  });

  it("可选依赖（wants）：提供它的插件在就先装它、取得到；不在照装、取到 undefined；它运行中停了也不连带，现取是 undefined", async () => {
    const trace: string[] = [];
    let ctxOfW: PluginContext | undefined;
    const w: PluginDefinition = {
      name: "w",
      title: "w",
      wants: [A],
      setup(ctx) {
        ctxOfW = ctx;
        trace.push(`w:setup:${JSON.stringify(ctx.optional(A))}`);
      },
    };
    const { host } = hostOf([w, tracer("a", trace, { provides: [A] })]);
    await kernel(host);
    expect(trace).toEqual(["a:setup", 'w:setup:{"from":"a"}', "a:start"]);
    await host.disable("a");
    expect(host.report().running).toEqual(["w"]);
    expect(ctxOfW!.optional(A)).toBeUndefined();

    const off = hostOf([w, tracer("a", [], { provides: [A] })], ["a"]);
    trace.length = 0;
    await kernel(off.host);
    expect(trace).toEqual(["w:setup:undefined"]);
    expect(off.host.report().running).toEqual(["w"]);
  });

  it("没声明就取服务、声明了提供却没 provide：算装配出错，不装", async () => {
    const sneaky: PluginDefinition = { name: "sneaky", title: "偷取", setup: (ctx) => void ctx.use(STORE) };
    const lazy: PluginDefinition = { name: "lazy", title: "偷懒", provides: [A], setup: () => {} };
    const { host } = hostOf([sneaky, lazy]);
    await kernel(host);
    expect(host.report().skipped).toEqual([
      { plugin: "sneaky", reason: "装配出错：插件 sneaky 要用服务 store：先在 needs 里声明" },
      { plugin: "lazy", reason: "装配出错：声明了提供服务 a，装配时没有 provide" },
    ]);
  });
});

describe("出错的插件", () => {
  const A = serviceKey<unknown>("a");

  it("装配出错：已经登记的撤掉，依赖它的不装，别的照常", async () => {
    const trace: string[] = [];
    const bad: PluginDefinition = {
      name: "bad",
      title: "坏的",
      provides: [A],
      setup(ctx) {
        ctx.cardTypes.register(suggestTaskFixture);
        throw new Error("装到一半坏了");
      },
    };
    const { host, logs } = hostOf([bad, tracer("child", trace, { needs: [A] }), tracer("fine", trace)]);
    const k = await kernel(host);
    expect(k.cardTypes.get("suggest_task")).toBeUndefined();
    expect(trace).toEqual(["fine:setup", "fine:start"]);
    expect(host.report().skipped).toEqual([
      { plugin: "bad", reason: "装配出错：装到一半坏了" },
      { plugin: "child", reason: "依赖的插件 bad 没装上（装配出错：装到一半坏了）" },
    ]);
    expect(logs).toContain("插件 bad（坏的）装配出错：装到一半坏了，没装上");
  });

  it("启动出错：它和依赖它的（已经装配好的）都撤掉", async () => {
    const trace: string[] = [];
    const bad: PluginDefinition = {
      name: "bad",
      title: "坏的",
      provides: [A],
      setup(ctx) {
        ctx.provide(A, {});
        ctx.quickActions.register(tidyNoteFixture);
        ctx.lifecycle({
          start: () => {
            throw new Error("起不来");
          },
        });
      },
    };
    const child: PluginDefinition = { name: "child", title: "子", needs: [A], setup: (ctx) => void ctx.cardTypes.register(suggestTaskFixture) };
    const { host } = hostOf([bad, child, tracer("fine", trace)]);
    const k = await kernel(host);
    expect(k.quickActions.get("tidy_note")).toBeUndefined();
    expect(k.cardTypes.get("suggest_task")).toBeUndefined();
    expect(host.service(A)).toBeUndefined();
    expect(host.report()).toEqual({
      running: ["fine"],
      disabled: [],
      skipped: [
        { plugin: "bad", reason: "启动出错：起不来" },
        { plugin: "child", reason: "依赖的插件 bad 启动出错了" },
      ],
    });
  });
});

describe("数据契约", () => {
  it("素材来源（129 号票）写在契约里：停用的插件的事件照样采得成素材（重建 materials.db、留原话副本靠它），运行中停用后也不撤", async () => {
    const noteSource: MaterialSource = {
      name: "test-note",
      eventType: NOTE_EVENT,
      capture: (event) => [userDecisionDraft({ kind: "approval_decision", accepted: { text: (event.payload as { text: string }).text, field: "text" } })],
    };
    const plugin: PluginDefinition = { name: "notes", title: "笔记", contracts: (ctx) => ctx.materialSources.register(noteSource), setup: () => {} };

    const off = hostOf([plugin], ["notes"]);
    const k = await kernel(off.host);
    k.store.append({ channel: "notes-test", type: NOTE_EVENT, payload: { id: "n-1", text: "周三体检" } });
    expect(k.materials.list().map((m) => m.segments[0]?.text)).toEqual(["周三体检"]);
    await k.close();

    const on = hostOf([plugin]);
    const k2 = await kernel(on.host);
    k2.store.append({ channel: "notes-test", type: NOTE_EVENT, payload: { id: "n-2", text: "周五复查" } });
    await on.host.disable("notes");
    k2.store.append({ channel: "notes-test", type: NOTE_EVENT, payload: { id: "n-3", text: "下周一取报告" } });
    expect(k2.materials.list().map((m) => m.segments[0]?.text)).toEqual(["周五复查", "下周一取报告"]);
  });

  it("停用的插件的契约照样登记（卡片类型、改写函数、前端请求），要用插件服务的地方回\"X插件没启用\"；启用时照常", async () => {
    const NOTES = serviceKey<{ act: () => string }>("notes");
    const notePurge: PurgeRewriter = { eventType: NOTE_EVENT, rewrite: () => ({ deleted: true }) };
    const plugin: PluginDefinition = {
      name: "notes",
      title: "笔记",
      provides: [NOTES],
      contracts(ctx) {
        const dismissed = () => {
          ctx.active(NOTES).act();
          return { status: "dismissed" as const };
        };
        ctx.cardTypes.register({ ...suggestTaskFixture, actions: { ...suggestTaskFixture.actions, dismiss: { input: undefined, run: dismissed } } });
        ctx.purge.register(notePurge);
        ctx.requests.register("daemonInfo", () => ({ version: ctx.active(NOTES).act(), startedAt: "", now: "" }));
      },
      setup: (ctx) => ctx.provide(NOTES, { act: () => "做了" }),
    };
    const dismiss = (k: Awaited<ReturnType<typeof kernel>>) =>
      k.cardTypes.get("suggest_task")!.definition.actions.dismiss!.run({ card: {} as never, payload: { title: "", why: "" }, action: "dismiss", input: undefined, now: "", idempotencyKey: "k" });

    const off = hostOf([plugin], ["notes"]);
    const k = await kernel(off.host);
    expect(k.cardTypes.get("suggest_task")).toBeDefined();
    expect(() => dismiss(k)).toThrow(new RequestRejected("not_allowed", "笔记插件没启用"));
    expect(() => off.host.requests().daemonInfo!()).toThrow("笔记插件没启用");
    const note = k.store.append({ channel: "notes-test", type: NOTE_EVENT, payload: {} }).event;
    expect(k.purge.rewrite(note, { deletedAt: "", materialIds: new Set() })).toEqual({ deleted: true });

    const on = hostOf([plugin]);
    const k2 = await kernel(on.host);
    expect(dismiss(k2)).toEqual({ status: "dismissed" });
    expect(on.host.requests().daemonInfo!()).toMatchObject({ version: "做了" });
    // 运行中停用：契约还在，回"没启用"
    await on.host.disable("notes");
    expect(k2.cardTypes.get("suggest_task")).toBeDefined();
    expect(() => dismiss(k2)).toThrow("笔记插件没启用");
  });

  it("运行时贡献点（286 号票）写在契约里：配置里停用的插件也登记（认得、写得出\"X插件没启用\"），能不能用跟着插件在不在运行；运行中停用、启用跟着变；宿主停时撤掉", async () => {
    const off = hostOf([fakeRuntimePlugin], ["fake-runtime"]);
    const k = await kernel(off.host);
    expect(k.runtimes.get("fake")).toBe(fakeRuntime);
    expect(k.runtimes.unavailable("fake")).toEqual({ reason: "假运行时插件没启用", plugin: "假运行时" });
    expect(k.runtimes.view().runtimes.map((r) => [r.id, r.plugin, r.available])).toEqual([
      ["pi", undefined, true],
      ["fake", "fake-runtime", false],
    ]);
    await k.close();
    // 宿主停时契约撤掉
    expect(k.runtimes.get("fake")).toBeUndefined();

    const on = hostOf([fakeRuntimePlugin]);
    const k2 = await kernel(on.host);
    expect(k2.runtimes.resolve("fake").entry).toBe(FAKE_RUNTIME_ENTRY);
    await on.host.disable("fake-runtime");
    expect(() => k2.runtimes.resolve("fake")).toThrow(new RequestRejected("not_allowed", "假运行时插件没启用"));
    await on.host.enable("fake-runtime");
    expect(k2.runtimes.unavailable("fake")).toBeUndefined();
    // 移除了也认得（维护者还记着它）
    await on.host.remove("fake-runtime");
    expect(k2.runtimes.unavailable("fake")?.reason).toBe("假运行时插件没启用");
  });

  it("数据源贡献点（295 号票）写在契约里：配置里停用的插件也登记（设置 · 数据源照样列出），在不在运行跟着插件；运行中停用、启用跟着变；宿主停时撤掉", async () => {
    const plugin: PluginDefinition = {
      name: "life",
      title: "生活",
      contracts: (ctx) => ctx.dataSources.register({ id: "life", title: "生活记录", usages: { import: { default: true } }, files: [{ title: "生活文件", extensions: [".life"], import: () => Promise.resolve({ added: 0 }) }] }),
      setup() {},
    };
    const off = hostOf([plugin], ["life"]);
    const k = await kernel(off.host);
    const entry = k.dataSources.get("life")!;
    expect(entry.source.title).toBe("生活记录");
    expect([entry.owner.plugin, entry.owner.title, entry.owner.running()]).toEqual(["life", "生活", false]);
    await k.close();
    expect(k.dataSources.get("life")).toBeUndefined();

    const on = hostOf([plugin]);
    const k2 = await kernel(on.host);
    expect(k2.dataSources.get("life")!.owner.running()).toBe(true);
    await on.host.disable("life");
    expect(k2.dataSources.get("life")!.owner.running()).toBe(false);
    await on.host.enable("life");
    expect(k2.dataSources.get("life")!.owner.running()).toBe(true);
  });

  it("内核现取插件的服务（213 号票，PluginHost.active：网关的日历接口这样取）：插件在运行时给出；配置里停用、运行中停用时回\"X插件没启用\"（not_allowed）；再启用照常；内核的照给；谁都不提供的算写错了代码", async () => {
    const NOTES = serviceKey<{ act: () => string }>("notes");
    const plugin: PluginDefinition = { name: "notes", title: "笔记", provides: [NOTES], setup: (ctx) => ctx.provide(NOTES, { act: () => "做了" }) };
    const off = hostOf([plugin], ["notes"]);
    await kernel(off.host);
    expect(() => off.host.active(NOTES)).toThrow(new RequestRejected("not_allowed", "笔记插件没启用"));
    const on = hostOf([plugin]);
    const k = await kernel(on.host);
    expect(on.host.active(NOTES).act()).toBe("做了");
    expect(on.host.active(STORE)).toBe(k.store);
    await on.host.disable("notes");
    let refused: unknown;
    try {
      on.host.active(NOTES);
    } catch (err) {
      refused = err;
    }
    expect(refused).toBeInstanceOf(RequestRejected);
    expect(refused).toMatchObject({ code: "not_allowed", message: "笔记插件没启用" });
    await on.host.enable("notes");
    expect(on.host.active(NOTES).act()).toBe("做了");
    expect(() => on.host.active(serviceKey("nobody"))).toThrow("服务 nobody 不是内核或哪个插件提供的");
  });
});

/** 一个登记了视图、卡片类型、给秘书的工具、内部作业、监听、start/stop 的插件；数一数装配了几次 */
function notesPlugin(trace: string[]) {
  const NOTES = serviceKey<{ n: number }>("notes");
  const contexts: PluginContext[] = [];
  let setups = 0;
  const tool = defineHostTool({ name: "note_lookup", title: "查笔记", description: "查笔记", parameters: Type.Object({}), readOnlyOrIdempotent: true, run: () => ({ text: "查到了" }) });
  const plugin: PluginDefinition = {
    name: "notes",
    title: "笔记",
    needs: [STORE],
    provides: [NOTES],
    views: [notesView],
    setup(ctx) {
      contexts.push(ctx);
      setups += 1;
      ctx.provide(NOTES, { n: setups });
      ctx.cardTypes.register(suggestTaskFixture);
      ctx.internalJobs.register({ name: "test-notes-digest", schedule: { kind: "daily", time: "03:00" }, run: async () => {} });
      ctx.agent.tools.register({ to: { agents: ["secretary"] }, tools: () => [tool] });
      ctx.effect(() => () => void trace.push("effect:undo"));
      ctx.lifecycle({ start: () => void trace.push(`start:${setups}`), stop: () => void trace.push("stop") });
    },
  };
  return { plugin, NOTES, contexts, setups: () => setups };
}

describe("运行中启用、移除（211 号票：设置里的热插拔）", () => {
  const A = serviceKey<unknown>("a");
  const B = serviceKey<unknown>("b");
  const secretary = { agent: "secretary", agentId: "secretary", session: "secretary" } as const;
  const call = { callId: "c-1", agentId: "secretary", conversation: "secretary" } as never;

  it("运行中停用后再启用：新的一次装配，登记都回来（卡片类型、给秘书的工具、内部作业、服务、start），停着时追加的事件视图整表补齐；上一次的 ctx 照样不能再登记", async () => {
    const trace: string[] = [];
    const notes = notesPlugin(trace);
    const { host, logs } = hostOf([notes.plugin]);
    const k = await kernel(host);
    let changes = 0;
    host.onChange(() => changes++);
    k.store.append({ channel: "notes-test", type: NOTE_EVENT, payload: {} });
    await host.disable("notes");
    k.store.append({ channel: "notes-test", type: NOTE_EVENT, payload: {} });
    k.store.append({ channel: "notes-test", type: NOTE_EVENT, payload: {} });
    expect(noteCount(k.store)).toBe(1);
    expect(k.cardTypes.get("suggest_task")).toBeUndefined();

    expect(await host.enable("notes")).toEqual(["notes"]);
    expect(changes).toBe(2);
    expect(notes.setups()).toBe(2);
    expect(trace).toEqual(["start:1", "stop", "effect:undo", "start:2"]);
    expect(host.report()).toEqual({ running: ["notes"], disabled: [], skipped: [] });
    expect(host.status()).toEqual([{ name: "notes", title: "笔记", state: "running" }]);
    expect(host.service(notes.NOTES)).toEqual({ n: 2 });
    expect(k.cardTypes.get("suggest_task")).toBeDefined();
    expect(k.agent.toolsFor(secretary).map((t) => t.spec.name)).toEqual(["note_lookup"]);
    expect(k.scheduler.pending().map((p) => p.key)).toContain("internal:test-notes-digest");
    // 视图：停着时追加的两条也算上；之后照常更新
    expect(noteCount(k.store)).toBe(3);
    expect(k.logs.some((l) => l.startsWith("视图 test_notes 从事件 #") && l.endsWith("整表按事件日志补一遍"))).toBe(true);
    k.store.append({ channel: "notes-test", type: NOTE_EVENT, payload: {} });
    expect(noteCount(k.store)).toBe(4);
    expect(logs).toContain("插件启用了：notes");
    // 上一次装配的 ctx 已经停了：再经它登记照样报错
    expect(() => notes.contexts[0]!.cardTypes.register(suggestTaskFixture)).toThrow(/已经停了/);
    // 已经在运行的再启用：没有变化，不通知
    expect(await host.enable("notes")).toEqual([]);
    expect(changes).toBe(2);
  });

  it("停用后正在跑的一轮里再调它的工具（agent 手里还是旧的）：回“X插件没启用”（isError），不做；再启用后新拿到的照常，旧的照样回没启用", async () => {
    const trace: string[] = [];
    const notes = notesPlugin(trace);
    const { host } = hostOf([notes.plugin]);
    const k = await kernel(host);
    const [held] = k.agent.toolsFor(secretary);
    expect(await held!.run({}, call)).toEqual({ text: "查到了" });
    // 同一个工具包出来的是同一个（守卫、agent 贡献按工具认）
    expect(k.agent.toolsFor(secretary)[0]).toBe(held);
    await host.disable("notes");
    expect(await held!.run({}, call)).toEqual({ text: "笔记插件没启用：现在用不了 note_lookup（用户停用了这个插件）。如实告诉用户，不要说已经做好了。", isError: true });
    await host.enable("notes");
    const [fresh] = k.agent.toolsFor(secretary);
    expect(await fresh!.run({}, call)).toEqual({ text: "查到了" });
    expect((await held!.run({}, call)).isError).toBe(true);
  });

  it("依赖方一起停、一起开：设置里看得到停用时一起停的、启用时一起开的；启用按依赖排顺序装配、启动", async () => {
    const trace: string[] = [];
    const { host } = hostOf([tracer("a", trace, { provides: [A] }), tracer("b", trace, { needs: [A], provides: [B] }), tracer("c", trace, { needs: [B] }), tracer("d", trace)]);
    await kernel(host);
    const row = (name: string) => host.info().find((p) => p.name === name)!;
    expect([row("a").stopsWith, row("b").stopsWith, row("c").stopsWith, row("d").stopsWith]).toEqual([["b", "c"], ["c"], [], []]);
    expect([row("a").needs, row("b").needs, row("c").needs]).toEqual([[], ["a"], ["b"]]);
    expect([row("a").neededBy, row("b").neededBy, row("c").neededBy]).toEqual([["b"], ["c"], []]);
    expect(await host.disable("a")).toEqual(["a", "b", "c"]);
    expect([row("a").startsWith, row("b").startsWith, row("c").startsWith]).toEqual([[], ["a"], ["a", "b"]]);
    trace.length = 0;
    expect(await host.enable("c")).toEqual(["a", "b", "c"]);
    expect(trace).toEqual(["a:setup", "a:start", "b:setup", "b:start", "c:setup", "c:start"]);
    expect(host.report().running).toEqual(["d", "a", "b", "c"]);
    // 再停：依赖方先停（按现在装的先后倒着）
    trace.length = 0;
    await host.stop();
    expect(trace).toEqual(["c:stop", "b:stop", "a:stop", "d:stop"]);
  });

  it("只启用被依赖的那个：依赖方照旧停用着（用户停的）；因为它没开而没装上的（启用着的）跟着装上", async () => {
    const trace: string[] = [];
    // b、c 都要 a；配置里停了 a 和 c：b 没装上（“它要用的「a」插件没开”）
    const { host } = hostOf([tracer("a", trace, { provides: [A] }), tracer("b", trace, { needs: [A] }), tracer("c", trace, { needs: [A] })], ["a", "c"]);
    await kernel(host);
    const b = host.info().find((p) => p.name === "b")!;
    expect(b).toMatchObject({ state: "skipped", problem: "它要用的「a」插件没开", startsWith: ["a"] });
    expect(await host.enable("a")).toEqual(["a", "b"]);
    expect(host.report()).toEqual({ running: ["a", "b"], disabled: ["c"], skipped: [] });
  });

  it("移除：停用它（依赖方一起停用），它自己记成移除了；状况、report、停着的视图里都是；装回就是启用。配置里移除了的不装", async () => {
    const trace: string[] = [];
    const { host } = hostOf([tracer("a", trace, { provides: [A], views: [notesView] }), tracer("b", trace, { needs: [A] }), tracer("d", trace)]);
    await kernel(host);
    let changes = 0;
    host.onChange(() => changes++);
    expect(await host.remove("a")).toEqual(["b", "a"]);
    expect(changes).toBe(1);
    expect(host.status().map((p) => [p.name, p.state])).toEqual([
      ["a", "removed"],
      ["b", "disabled"],
      ["d", "running"],
    ]);
    expect(host.report()).toEqual({ running: ["d"], disabled: ["b"], skipped: [], removed: ["a"] });
    expect(host.dormantViews()).toEqual(["test_notes"]);
    // 停用了的再移除：只是它自己变成移除了；移除了的再移除、停用都不动
    expect(await host.remove("b")).toEqual(["b"]);
    expect(await host.remove("b")).toEqual([]);
    expect(await host.disable("b")).toEqual([]);
    // 装回
    expect(await host.enable("a")).toEqual(["a"]);
    expect(host.status().map((p) => p.state)).toEqual(["running", "removed", "running"]);

    // 配置里移除了的（两边都写了算移除）：不装，日志写明
    const again = hostOf([tracer("a", [], { provides: [A], views: [notesView] }), tracer("b", [], { needs: [A] })], ["a"], ["a"]);
    expect(again.host.dormantViews()).toEqual(["test_notes"]);
    expect(again.logs).toContain("插件 a（a）在配置里移除了");
    expect(again.logs).toContain("插件 b（b）没装：要的服务 a 由插件 a 提供，它在配置里移除了");
    await kernel(again.host);
    expect(again.host.report()).toEqual({ running: [], disabled: [], skipped: [{ plugin: "b", reason: "要的服务 a 由插件 a 提供，它在配置里移除了" }], removed: ["a"] });
  });

  it("启用不了的（要的服务没有谁提供、循环依赖）：回 not_allowed 和给人看的原因，设置里写明；不认得的插件回 not_found", async () => {
    const P = serviceKey<unknown>("p");
    const Q = serviceKey<unknown>("q");
    const WEATHER = serviceKey<unknown>("weather");
    const { host } = hostOf([tracer("x", [], { needs: [WEATHER] }), tracer("p", [], { needs: [Q], provides: [P] }), tracer("q", [], { needs: [P], provides: [Q] })]);
    await kernel(host);
    await expect(host.enable("x")).rejects.toThrow(new RequestRejected("not_allowed", "缺少它要用的功能（weather）"));
    await expect(host.enable("p")).rejects.toThrow("几个插件互相要用对方（p → q → p），装不上");
    await expect(host.enable("nope")).rejects.toMatchObject({ code: "not_found" });
    expect(host.info().map((p) => [p.name, p.problem, p.cannotEnable])).toEqual([
      ["x", "缺少它要用的功能（weather）", "缺少它要用的功能（weather）"],
      ["p", "几个插件互相要用对方（p → q → p），装不上", "几个插件互相要用对方（p → q → p），装不上"],
      ["q", "几个插件互相要用对方（p → q → p），装不上", "几个插件互相要用对方（p → q → p），装不上"],
    ]);
    // 没装上的停用：记成停用了（设置里点了停用，不再算降级）
    expect(await host.disable("x")).toEqual(["x"]);
    expect(host.report().disabled).toEqual(["x"]);
  });

  it("运行中启用时装配出错：它记成没装上（给人看的原因），依赖它的不装；下次再启用照常", async () => {
    let fail = false;
    const flaky: PluginDefinition = {
      name: "flaky",
      title: "不稳",
      provides: [A],
      setup(ctx) {
        ctx.provide(A, {});
        if (fail) throw new Error("这次坏了");
      },
    };
    const { host } = hostOf([flaky, tracer("child", [], { needs: [A] })]);
    await kernel(host);
    await host.disable("flaky");
    fail = true;
    expect(await host.enable("child")).toEqual([]);
    expect(host.info().map((p) => [p.name, p.state, p.problem])).toEqual([
      ["flaky", "skipped", "装的时候出错了：这次坏了"],
      ["child", "skipped", "它要用的「不稳」插件没装上"],
    ]);
    fail = false;
    expect(await host.enable("child")).toEqual(["flaky", "child"]);
  });

  it("要的外部组件没装（315 号票，missing）：不装配、记成没装上（设置里 missing、那一句、启用不了），依赖它的不装，运行时写那一句；装好后启用就装上（依赖它的跟着装上）", async () => {
    let installed = false;
    const trace: string[] = [];
    const EXT = serviceKey<unknown>("ext");
    const external: PluginDefinition = {
      ...fakeRuntimePlugin,
      provides: [EXT],
      missing: () => (installed ? undefined : "没装外面那个组件：运行 npm install 外面那个"),
      setup(ctx) {
        trace.push("setup");
        ctx.provide(EXT, {});
      },
    };
    const { host, logs } = hostOf([external, tracer("child", [], { needs: [EXT] }), tracer("other", [], { provides: [A] })]);
    const k = await kernel(host);
    expect(trace).toEqual([]);
    const info = host.info().find((p) => p.name === "fake-runtime")!;
    expect(info).toMatchObject({ state: "skipped", missing: true, problem: "没装外面那个组件：运行 npm install 外面那个", cannotEnable: "没装外面那个组件：运行 npm install 外面那个" });
    expect(host.report().skipped).toEqual([
      { plugin: "fake-runtime", reason: "要的外部组件没装：没装外面那个组件：运行 npm install 外面那个" },
      { plugin: "child", reason: "依赖的插件 fake-runtime 没装上（要的外部组件没装：没装外面那个组件：运行 npm install 外面那个）" },
    ]);
    expect(host.info().find((p) => p.name === "child")).toMatchObject({ state: "skipped", problem: "它要用的「假运行时」插件没装上" });
    expect(logs).toContainEqual(expect.stringContaining("插件 fake-runtime（假运行时）没装：要的外部组件没装：没装外面那个组件"));
    // 别的插件照常
    expect(host.report().running).toEqual(["other"]);
    // 运行时写那一句，不写"没启用"
    expect(k.runtimes.unavailable("fake")).toEqual({ reason: "没装外面那个组件：运行 npm install 外面那个", plugin: "假运行时" });
    await expect(host.enable("fake-runtime")).rejects.toThrow(new RequestRejected("not_allowed", "没装外面那个组件：运行 npm install 外面那个"));
    expect(trace).toEqual([]);
    // 装好了：启用就装上，状况里不再带 missing
    installed = true;
    expect(host.info().find((p) => p.name === "fake-runtime")?.cannotEnable).toBeUndefined();
    // 因为它没装上而没装的（启用着的）跟着装上
    expect(await host.enable("fake-runtime")).toEqual(["fake-runtime", "child"]);
    expect(trace).toEqual(["setup"]);
    expect(host.info().find((p) => p.name === "fake-runtime")).toMatchObject({ state: "running" });
    expect(host.info().find((p) => p.name === "fake-runtime")?.missing).toBeUndefined();
    expect(k.runtimes.unavailable("fake")).toBeUndefined();
    // 停用以后写的是"没启用"（不是没装）
    await host.disable("fake-runtime");
    expect(host.info().find((p) => p.name === "fake-runtime")?.missing).toBeUndefined();
    expect(k.runtimes.unavailable("fake")?.reason).toBe("假运行时插件没启用");
  });

  it("设置里看的：一句话、它带来了什么、连数据删写明的（契约里写一次，停用也在）", async () => {
    const spec = { deletes: ["全部笔记"], keeps: ["备份里的一份"], events: [{ channel: "notes-test", type: NOTE_EVENT }] };
    const plugin: PluginDefinition = {
      name: "notes",
      title: "笔记",
      summary: "记下你说的笔记",
      brings: { tools: ["查笔记"], cards: ["笔记卡"], jobs: ["每晚整理笔记"] },
      contracts: (ctx) => ctx.removal.declare(spec),
      setup: () => {},
    };
    const { host } = hostOf([plugin, tracer("plain", [])], ["notes"]);
    await kernel(host);
    expect(host.info()).toEqual([
      {
        name: "notes",
        title: "笔记",
        summary: "记下你说的笔记",
        state: "disabled",
        brings: { tools: ["查笔记"], cards: ["笔记卡"], jobs: ["每晚整理笔记"] },
        needs: [],
        neededBy: [],
        stopsWith: [],
        startsWith: [],
        removal: { deletes: ["全部笔记"], keeps: ["备份里的一份"] },
      },
      { name: "plain", title: "plain", summary: "", state: "running", brings: { tools: [], cards: [], jobs: [] }, needs: [], neededBy: [], stopsWith: [], startsWith: [] },
    ]);
    expect(host.removalOf("notes")).toBe(spec);
    expect(host.removalOf("plain")).toBeUndefined();
    const twice: PluginDefinition = { name: "twice", title: "两次", contracts: (ctx) => [1, 2].forEach(() => ctx.removal.declare(spec)), setup: () => {} };
    await expect(kernel(hostOf([twice]).host)).rejects.toThrow("已经写过了");
  });
});
