// 337 号票第一段：会意 / Subtext 记忆插件（memory/provider/subtext.ts）。用临时目录里的真 SQLite、真 MemoryEngine（规则版抽取和推理、
// 假向量，不下载）、真的彻底删除（purge-rg.ts），不调模型、不碰真的数据目录。
// 这一版插件只包一层（检索、简报、体检、按来源删、跳过 observe），按原话记一条还没接——测试照实际做到的断言。
import fs from "node:fs";
import path from "node:path";
import { type EvidenceDraft, type MemoryEngine } from "@ergo/memory";
import { EVENT_TYPES, type MemoryItem, type MemoryProviderContext, type MemorySource } from "@ergo/protocol";
import { describe, expect, it, onTestFinished } from "vitest";
import { DEFAULT_MEMORY_CONFIG } from "../../src/config/config.ts";
import type { Material, Materials } from "../../src/materials/index.ts";
import { kernelEmbedderAdapter } from "../../src/memory/embedder-adapter.ts";
import { createMemoryEngineProvider } from "../../src/memory/engine-provider.ts";
import { createMemoryHost, createMemoryProviderRegistry, type MemoryProviderFactory } from "../../src/memory/provider/host.ts";
import { createSubtextProvider, SUBTEXT_INFO, subtextProviderFactory, type SubtextProviderDeps } from "../../src/memory/provider/subtext.ts";
import { createReasoningPurge } from "../../src/memory/purge-rg.ts";
import { openReasoningDb } from "../../src/memory/rg-db.ts";
import { clockIso } from "../../src/scheduler/clock.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { ManualClock } from "../helpers/clock.ts";
import { FakeEmbedder } from "../helpers/embedder.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const NOW = new Date(2026, 9, 12, 12, 0);

/** 说一句（规则版抽取认得的那几类：词里的"周末""工作日""不吃香菜"） */
const say = (id: string, text: string, at: string, over: Partial<EvidenceDraft> = {}): EvidenceDraft => ({
  id,
  sourceLevel: "self",
  mode: "say",
  kind: "utterance",
  text,
  context: [],
  eventTime: at,
  observedAt: at,
  sourceRef: `mat-${id}`,
  ...over,
});

const WORKDAY = { context: ["workday", "work"] };
const WEEKEND = { context: ["weekend", "social"] };

const STORY: readonly EvidenceDraft[] = [
  say("ev-w1", "这周六的饭局我就不去了", "2026-03-07T10:00:00+08:00", WEEKEND),
  say("ev-w2", "周日的剧本杀我推掉了", "2026-03-15T10:00:00+08:00", WEEKEND),
  say("ev-w4", "周六的生日会我也没去", "2026-03-21T10:00:00+08:00", WEEKEND),
  say("ev-w3", "我不喜欢周末被排得满满的", "2026-04-04T10:00:00+08:00", { context: ["weekend"] }),
  say("ev-d1", "周二的分享会我推掉了", "2026-10-06T10:00:00+08:00", WORKDAY),
  say("ev-d2", "拒绝了周四的临时会议", "2026-10-08T10:00:00+08:00", WORKDAY),
  say("ev-d3", "工作日我也不喜欢被提前排满", "2026-10-09T10:00:00+08:00", { context: ["workday"] }),
  say("ev-a1", "我不吃香菜，一吃就过敏", "2026-05-01T10:00:00+08:00"),
  // 出处不是素材（合成数据、表态证据这类没有 sourceRef）：检索命中了也不交出去（用户 2026-10-28：没有出处的不进简报）
  say("ev-nosrc", "周末被排得满满的，团建我也不想去", "2026-04-05T10:00:00+08:00", { sourceRef: null }),
];

const TALK = "这周六同事又约我去团建，周末被排得满满的";
const QUERY = "周末被排得满满";

/** 向量模型"不在"的假向量函数：相关门槛只按话题词认，不让假向量掺进来 */
const vectors = () => kernelEmbedderAdapter(new FakeEmbedder({ available: false }));

/** 一条素材信封（只填插件用到的那些：出处、会话、任务、项目、来自哪条消息） */
function materialOf(id: string, over: { conversation?: string | null; task?: string | null; project?: string | null; messageId?: string } = {}): Material {
  return {
    id,
    kind: "user_utterance",
    mode: "say",
    time: "2026-04-04T10:00:00.000+08:00",
    conversation: over.conversation === undefined ? "secretary" : over.conversation,
    task: over.task ?? null,
    project: over.project ?? null,
    source: "self",
    ref: { event: { globalSeq: 1, channel: "secretary", seq: 1, type: EVENT_TYPES.message }, ...(over.messageId === undefined ? {} : { messageId: over.messageId }) },
    context: [],
    segments: [],
    original: null,
    noInfer: false,
  };
}

/** 假素材库：只认这几条，只实现插件用到的 get / list（筛选照 MaterialFilter 的三项：种类、会话、消息） */
function fakeMaterials(items: readonly Material[]): Pick<Materials, "get" | "list"> {
  return {
    get: (id) => items.find((m) => m.id === id),
    list: (filter = {}) =>
      items.filter(
        (m) =>
          (filter.kind === undefined || m.kind === filter.kind) &&
          (filter.conversation === undefined || m.conversation === filter.conversation) &&
          (filter.messageId === undefined || m.ref.messageId === filter.messageId),
      ),
  };
}

interface Built {
  deps: SubtextProviderDeps;
  engine: () => MemoryEngine | undefined;
  file: string;
}

/**
 * 临时目录里的 rg.db（灌证据、规则版整理一遍）、读它的只读引擎（和组合根那一份一样懒打开、缓存）、
 * 推理库的彻底删除（purge-rg.ts 的同一份），以及素材库。
 */
async function built(options: { materials?: Pick<Materials, "get" | "list">; logs?: string[] } = {}): Promise<Built> {
  const clock = new ManualClock(NOW);
  const file = path.join(makeTempDir("ergo-subtext-"), "db", "rg.db");
  const opened = openReasoningDb({ file, clock: () => clockIso(clock), model: "deepseek-flash", embedder: vectors() });
  if (!opened.ok) throw new Error("应该能建库");
  for (const draft of STORY) opened.engine.ingestEvidence(draft);
  await opened.engine.reflect();
  await opened.engine.indexVectors();
  opened.engine.close();
  const provider = createMemoryEngineProvider({ file, clock: () => clockIso(clock), model: "deepseek-flash", embedder: vectors() });
  onTestFinished(() => provider.close());
  // 只借 purgeMaterials：它的 start()（订阅记忆命令）和 reconcile() 由记忆插件自己那一份做，这里都不叫
  const purge = createReasoningPurge({
    file,
    store: { read: () => [], onAppend: () => () => {} },
    clock,
    config: DEFAULT_MEMORY_CONFIG,
    ...(options.materials === undefined ? {} : { materials: options.materials }),
    ...(options.logs === undefined ? {} : { log: (line: string) => options.logs!.push(line) }),
  });
  return {
    file,
    engine: () => provider.get(),
    deps: {
      engine: () => provider.get(),
      ...(options.materials === undefined ? {} : { materials: options.materials }),
      deleteMaterials: (materialIds) => purge.purgeMaterials(materialIds),
      lastConsolidatedAt: () => "2026-10-11T03:04:05.000+08:00",
      bytes: () => 4096,
    },
  };
}

/** 素材：ev-a1 那条在秘书的会话里，其余的在维护者的会话里（测按会话删时好一次只删一条） */
const CONVERSATION_OF = (evidenceId: string) => (evidenceId === "ev-a1" ? "secretary" : "maintainer:p-notes");

const ALL_MATERIALS = STORY.filter((draft) => draft.sourceRef !== null).map((draft) => materialOf(draft.sourceRef!, { messageId: `m-${draft.id}`, conversation: CONVERSATION_OF(draft.id!) }));

/** 插件要求的上下文（这一版只用到 dataDir、log、now） */
function context(dataDir: string, logs: string[] = []): MemoryProviderContext {
  const abort = new AbortController();
  return {
    dataDir,
    identity: () => ({ language: "zh", userName: "小明", assistantName: "二狗" }),
    llm: () => Promise.reject(new Error("这一版不该调模型")),
    embed: () => Promise.reject(new Error("这一版不该算向量")),
    now: () => NOW,
    log: (line) => logs.push(line),
    signal: abort.signal,
  };
}

/** 起来一个会意实例 */
async function started(deps: SubtextProviderDeps, logs: string[] = []) {
  const provider = createSubtextProvider(deps);
  await provider.start(context(makeTempDir(), logs));
  return provider;
}

describe("会意插件对宿主的说法", () => {
  it("id 是 subtext、名字是「会意 / Subtext」、接口版本是宿主认的那个，声明了 brief、标着实验性", () => {
    const factory = subtextProviderFactory({ engine: () => undefined });
    expect(factory.id).toBe("subtext");
    expect(factory.name).toEqual({ zh: "会意", en: "Subtext" });
    expect(factory.api).toBe(SUBTEXT_INFO.api);
    expect(factory.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(SUBTEXT_INFO).toMatchObject({ id: "subtext", experimental: true, capabilities: { brief: true }, requirements: {} });
  });

  it("还没 start 时各方法都按\"没在跑\"拒", async () => {
    const provider = createSubtextProvider({ engine: () => undefined });
    await expect(provider.search({ text: "香菜" })).rejects.toMatchObject({ code: "not_found" });
    await expect(provider.health()).rejects.toMatchObject({ code: "not_found" });
    await expect(provider.brief({ text: TALK })).rejects.toMatchObject({ code: "not_found" });
    await expect(provider.observe({ at: "2026-10-28T09:00:00.000Z", source: { kind: "message", id: "m-1" }, text: "原话" })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("search：交给现有的引擎检索，每条都带出处", () => {
  it("命中的证据映射成条目：出处是素材 id 加上它来自哪条消息；没有出处的条目不交出去", async () => {
    const { deps } = await built({ materials: fakeMaterials(ALL_MATERIALS) });
    const provider = await started(deps);
    const found = await provider.search({ text: QUERY, limit: 10 });

    expect(found.items.length).toBeGreaterThan(0);
    for (const item of found.items) expect(item.sources.length).toBeGreaterThan(0);
    const hit = found.items.find((item) => item.id === "ev-w3");
    expect(hit).toBeDefined();
    expect(hit!.sources).toEqual([
      { kind: "material", id: "mat-ev-w3" },
      { kind: "message", id: "m-ev-w3" },
    ]);
    expect(hit!.text).toBe("我不喜欢周末被排得满满的");
    expect(hit!.kind).toBe("utterance");
    expect(hit!.createdAt).toBe("2026-04-04T10:00:00+08:00");
    expect(hit!.tags).toEqual(["weekend"]);
    // 出处不是素材的那条不在结果里
    expect(found.items.map((item) => item.id)).not.toContain("ev-nosrc");
    expect(found.tookMs).toBeGreaterThanOrEqual(0);
  });

  it("没有素材库时出处只有素材 id（不硬编消息）；按种类、按范围筛得掉", async () => {
    const { deps } = await built({ materials: fakeMaterials(ALL_MATERIALS) });
    const scalar = createSubtextProvider({ engine: deps.engine, deleteMaterials: deps.deleteMaterials });
    await scalar.start(context(makeTempDir()));
    const found = await scalar.search({ text: QUERY });
    for (const item of found.items) expect(item.sources.every((source) => source.kind === "material")).toBe(true);

    // 种类对不上就是空
    expect((await scalar.search({ text: QUERY, kinds: ["action"] })).items).toEqual([]);

    // 范围（会话）：这几条素材在维护者的那个会话里（secretary 里只有"不吃香菜"那条）
    const provider = await started(deps);
    expect((await provider.search({ text: QUERY, scope: { conversationId: "maintainer:p-notes" } })).items.length).toBeGreaterThan(0);
    expect((await provider.search({ text: QUERY, scope: { conversationId: "secretary" } })).items).toEqual([]);
  });

  it("库用不了（引擎拿不到）时回空，不抛错", async () => {
    const provider = await started({ engine: () => undefined });
    await expect(provider.search({ text: "香菜" })).resolves.toMatchObject({ items: [] });
    await expect(provider.brief({ text: TALK })).resolves.toBeUndefined();
  });
});

describe("brief：用现有的每条消息简报", () => {
  it("相关时回正文、这次带上了哪几条（keys 就是引擎的 brought）和为什么带、命中的素材；known 交回来时带过没变的不再带；不相关回 undefined", async () => {
    const { deps } = await built({ materials: fakeMaterials(ALL_MATERIALS) });
    const provider = await started(deps);

    const result = await provider.brief({ text: TALK });
    expect(result).toBeDefined();
    // 返回可以是"一份结果"或"只有正文"（老实现）；会意回的是前者，窄化一下
    if (result === undefined || typeof result === "string") throw new Error("会意的简报应该回一份结果，而不是纯文本");
    expect(result.text).toContain("【对用户的理解】");
    expect(result.text).toContain("我不喜欢周末被排得满满的");
    // keys：带上的每一条一个键（结论 / 组 / 策略），指纹和引擎里是同一套（12 位哈希）
    const keys = Object.entries(result.keys ?? {});
    expect(keys.length).toBeGreaterThan(0);
    for (const [key, print] of keys) {
      expect(key).toMatch(/^(claim|group|strategy):/);
      expect(print).toMatch(/^[0-9a-f]{12}$/);
    }
    // 结构化那两样：为什么带、命中的素材（素材库里有的）
    expect(result.items?.some((item) => item.reason === "direct")).toBe(true);
    expect(result.items?.some((item) => item.reason === "hard")).toBe(true);
    expect(result.hits?.map((hit) => hit.materialId)).toContain("mat-ev-w3");

    // 同一段对话里带过、没变的（宿主下一轮把 keys 当 known 交回来）：这一轮不带
    await expect(provider.brief({ text: TALK, known: result.keys })).resolves.toBeUndefined();

    // 和这个人、这段话题都不搭的话：不带
    await expect(provider.brief({ text: "明天上海会下雨吗" })).resolves.toBeUndefined();
  });
});

describe("forget：按来源删推理库里的东西", () => {
  it("按素材删：证据没了，再搜就搜不到；素材库那边不碰（没有删素材的接口）", async () => {
    const materials = fakeMaterials(ALL_MATERIALS);
    const { deps } = await built({ materials });
    const provider = await started(deps);
    expect((await provider.search({ text: QUERY })).items.map((item) => item.id)).toContain("ev-w3");

    const result = await provider.forget({ source: { kind: "material", id: "mat-ev-w3" } });
    expect(result.removed).toBe(1);
    expect(result.failed).toBeUndefined();

    const after = await provider.search({ text: QUERY });
    expect(after.items.map((item) => item.id)).not.toContain("ev-w3");
    // 素材库照旧（删素材库是内核的事）
    expect(materials.get("mat-ev-w3")?.id).toBe("mat-ev-w3");
  });

  it("按会话 / 消息找得到素材：删的是那几条来源背后的证据", async () => {
    const materials = fakeMaterials(ALL_MATERIALS);
    const { deps } = await built({ materials });
    const provider = await started(deps);

    // 按会话：秘书那个会话里只有"不吃香菜"那一条素材
    const byConversation = await provider.forget({ source: { kind: "conversation", id: "secretary" } });
    expect(byConversation).toEqual({ removed: 1 });
    expect((await provider.search({ text: "我不吃香菜" })).items.map((item) => item.id)).not.toContain("ev-a1");

    // 按消息：这条消息采到的素材背后的证据
    const byMessage = await provider.forget({ source: { kind: "message", id: "m-ev-w3" } });
    expect(byMessage).toEqual({ removed: 1 });
    expect((await provider.search({ text: QUERY })).items.map((item) => item.id)).not.toContain("ev-w3");
  });

  it("一次删一大片、推理图谱的写入口不让写时，如实回 failed（整个事务回滚，不删一半还报成功）", async () => {
    const purgeLogs: string[] = [];
    const { deps } = await built({ materials: fakeMaterials(ALL_MATERIALS), logs: purgeLogs });
    const provider = await started(deps);

    // 那个会话里 8 条素材背后的证据一起删：写入口会拒绝（有结论的墓碑引着要一起删掉的事实，不能编造）
    const batch = await provider.forget({ source: { kind: "conversation", id: "maintainer:p-notes" } });
    expect(batch.removed).toBe(0);
    expect(batch.failed).toBeDefined();
    expect(purgeLogs.some((line) => line.includes("出错"))).toBe(true);
    // 一条都没删掉（写入口整个回滚）
    expect((await provider.search({ text: QUERY })).items.map((item) => item.id)).toContain("ev-w3");
  });

  it("整库删（all）明确拒绝；按条目、按时间段还没接；认不出的来源如实回 failed", async () => {
    const { deps } = await built({ materials: fakeMaterials(ALL_MATERIALS) });
    const provider = await started(deps);

    const all = await provider.forget({ all: true });
    expect(all.removed).toBe(0);
    expect(all.failed).toContain("整库删除");

    const byItems = await provider.forget({ items: ["ev-w3"] });
    expect(byItems.removed).toBe(0);
    expect(byItems.failed).toBeDefined();

    const byRange = await provider.forget({ range: { from: "2026-01-01T00:00:00.000Z" } });
    expect(byRange.removed).toBe(0);
    expect(byRange.failed).toBeDefined();

    const toolCall = await provider.forget({ source: { kind: "tool_call", id: "tc-1" } });
    expect(toolCall.removed).toBe(0);
    expect(toolCall.failed).toBeDefined();
  });

  it("推理库用不了时如实回 failed（不是静悄悄回 0）", async () => {
    const provider = await started({ engine: () => undefined, materials: fakeMaterials(ALL_MATERIALS), deleteMaterials: () => undefined });
    const result = await provider.forget({ source: { kind: "material", id: "mat-ev-w3" } });
    expect(result.removed).toBe(0);
    expect(result.failed).toContain("推理库");
  });
});

describe("health / observe / remember", () => {
  it("health 有数：条目数、最后整理时间、占多少字节", async () => {
    const { deps } = await built({ materials: fakeMaterials(ALL_MATERIALS) });
    const provider = await started(deps);
    const health = await provider.health();
    expect(health.items).toBeGreaterThan(0);
    expect(health.lastConsolidatedAt).toBe("2026-10-11T03:04:05.000+08:00");
    expect(health.bytes).toBe(4096);
    expect(health.problems).toBeUndefined();
  });

  it("库用不了时 health 如实说：0 条 + problems", async () => {
    const provider = await started({ engine: () => undefined, lastConsolidatedAt: () => undefined });
    const health = await provider.health();
    expect(health.items).toBe(0);
    expect(health.problems?.length).toBeGreaterThan(0);
    expect(health.bytes).toBeUndefined();
  });

  it("observe 这一步回 skipped（现有管道自己摄取）", async () => {
    const provider = await started({ engine: () => undefined });
    const result = await provider.observe({ at: "2026-10-28T09:00:00.000Z", source: { kind: "message", id: "m-1" }, text: "原话" });
    expect(result.status).toBe("skipped");
  });

  it("remember 没给会话出处时拒绝（出处至少要会话），也不顺手把这句话塞进别处", async () => {
    const { deps } = await built({ materials: fakeMaterials(ALL_MATERIALS) });
    const provider = await started(deps);
    await expect(provider.remember({ text: "记住我不吃香菜" })).rejects.toMatchObject({ code: "bad_params" });
    // 没有顺手塞进任何别的地方：搜回来的条目里没有"记住"那句
    const found = await provider.search({ text: "记住我不吃香菜" });
    expect(found.items.map((item) => item.text)).not.toContain("记住我不吃香菜");
  });
});

describe("经宿主起来、单活、停用之后拒调用", () => {
  it("注册表里登记会意、激活起来；search 走它、数据目录是 <根目录>/memory/subtext/；deactivate 之后宿主拒调用", async () => {
    const { deps } = await built({ materials: fakeMaterials(ALL_MATERIALS) });
    const root = makeTempDir("ergo-subtext-host-");
    const registry = createMemoryProviderRegistry();
    const factory: MemoryProviderFactory = subtextProviderFactory(deps);
    registry.register(factory);
    const logs: string[] = [];
    const host = createMemoryHost({
      rootDir: root,
      registry,
      identity: () => ({ language: "zh", userName: "小明", assistantName: "二狗" }),
      now: () => NOW,
      log: (line) => logs.push(line),
    });

    await host.activate("subtext");
    expect(host.active()).toBe("subtext");
    expect(host.info()?.id).toBe("subtext");
    expect(host.dataDir("subtext")).toBe(path.join(root, "memory", "subtext"));

    const found = await host.search({ text: QUERY, limit: 5 });
    expect(found.items.length).toBeGreaterThan(0);
    for (const item of found.items) expect(item.sources.length).toBeGreaterThan(0);
    // 插件声明了 brief：宿主用会意自己的那一份（现有的每条消息简报，266 号票的正文），不回落去 search 拼；
    // 337 号票起还带回这次带上了哪几条（keys）和结构化那两样
    const brief = await host.brief({ text: TALK });
    expect(brief).toBeDefined();
    expect(brief!.text).toContain("【对用户的理解】");
    expect(brief!.text).toContain("我不喜欢周末被排得满满的");
    expect(Object.keys(brief!.keys ?? {}).length).toBeGreaterThan(0);
    expect(brief!.hits?.map((hit) => hit.materialId)).toContain("mat-ev-w3");
    expect((await host.health()).items).toBeGreaterThan(0);
    expect((await host.observe({ at: "2026-10-28T09:00:00.000Z", source: { kind: "message", id: "m-1" }, text: "原话" })).status).toBe("skipped");

    await host.deactivate();
    expect(host.active()).toBeUndefined();
    expect(logs.some((line) => line.includes("会意起来了"))).toBe(true);
    // 停用之后宿主一律按"没有在跑"拒（插件那边也清掉了上下文）
    await expect(host.search({ text: QUERY })).rejects.toMatchObject({ code: "not_found" });
    await expect(host.remember({ text: "记住我不吃香菜" })).rejects.toMatchObject({ code: "not_found" });
    // brief 是可选能力：没有在跑就是"这一轮不带"
    await expect(host.brief({ text: TALK })).resolves.toBeUndefined();
  });

  it("宿主把条目照样交出去：search 回来的 id、出处都是插件给的样子（插件换成另一个也不影响宿主规矩）", async () => {
    const { deps } = await built({ materials: fakeMaterials(ALL_MATERIALS) });
    const registry = createMemoryProviderRegistry();
    registry.register(subtextProviderFactory(deps));
    const host = createMemoryHost({ rootDir: makeTempDir(), registry, identity: () => ({ language: "zh", assistantName: "二狗" }), now: () => NOW, log: () => {} });
    await host.activate("subtext");
    const [first] = (await host.search({ text: QUERY })).items;
    const item: MemoryItem = first!;
    expect(item.sources.map((source: MemorySource) => source.kind)).toContain("material");
  });
});

describe("组合根里起来（真守护进程、临时数据目录、假向量、假模型）", () => {
  it("记忆插件槽登记的是会意、activate 过；数据目录建在 <数据目录>/memory/subtext/；空库时检索是空、简报不带；停守护进程时停掉", { timeout: 60_000 }, async () => {
    const td = await startTestDaemon({});
    const host = td.daemon.memoryHost;

    // 这一段只是"起来"，不接工具和简报：现有的记忆功能照旧走原来的路
    expect(host.active()).toBe("subtext");
    expect(host.info()).toMatchObject({ id: "subtext", api: 1, experimental: true, name: { zh: "会意", en: "Subtext" }, capabilities: { brief: true } });
    const dir = host.dataDir("subtext");
    expect(dir).toBe(path.join(td.dataDir, "memory", "subtext"));
    expect(fs.existsSync(dir)).toBe(true);

    // 新装的库是空的（还没整理过）：检索空、简报不带、体检 0 条，都不抛错
    await expect(host.search({ text: "周末被排得满满" })).resolves.toMatchObject({ items: [] });
    await expect(host.brief({ text: "周末被排得满满" })).resolves.toBeUndefined();
    expect((await host.health()).items).toBe(0);
    expect(td.daemon.layout.rgDb.startsWith(td.dataDir)).toBe(true);

    await td.daemon.stop();
    expect(host.active()).toBeUndefined();
  });
});
