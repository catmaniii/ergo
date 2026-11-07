// 记忆简报的各步耗时和超时（427）。走生产里那条路：每条消息的简报（message-brief.ts）→ 会意插件（provider/subtext.ts）
// → 组合根建的那份只读引擎（provider/subtext-runtime.ts，秘书那一侧共用的向量函数 secretaryEmbedder）。
// 临时目录里的真 SQLite、真 MemoryEngine（规则版整理、假向量），真事件存储；向量模型的慢（排队、冷启动）用可控的假延迟模拟，
// 不调真模型、不碰真的数据目录。例子是测试的那个人（自己写的）。
import path from "node:path";
import { backgroundVectors, type EvidenceDraft } from "@ergo/memory";
import { CHANNELS, EVENT_TYPES, type MemoryBriefInput, type MemoryProviderContext, type MessageEnvelope } from "@ergo/protocol";
import { describe, expect, it, onTestFinished } from "vitest";
import { DEFAULT_MEMORY_CONFIG } from "../../src/config/config.ts";
import { conversationMessagesView } from "../../src/conversation/views.ts";
import { openEventStore, type EventStore } from "../../src/events/event-store.ts";
import type { Material, Materials } from "../../src/materials/index.ts";
import { kernelEmbedderAdapter, secretaryEmbedder } from "../../src/memory/embedder-adapter.ts";
import { createMessageBriefs, MESSAGE_BRIEF_TIMEOUT_MS, type MessageBriefs, type MessageBriefsOptions } from "../../src/memory/message-brief.ts";
import { createSubtextProvider } from "../../src/memory/provider/subtext.ts";
import { createSubtextRuntime } from "../../src/memory/provider/subtext-runtime.ts";
import { openReasoningDb } from "../../src/memory/rg-db.ts";
import { clockIso } from "../../src/scheduler/clock.ts";
import { ManualClock } from "../helpers/clock.ts";
import { FakeEmbedder } from "../helpers/embedder.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const NOW = new Date(2026, 9, 12, 12, 0);
const { secretary: SECRETARY } = CHANNELS;

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
const WEEKEND = { context: ["weekend", "social"] };
const WORKDAY = { context: ["workday", "work"] };
const STORY: readonly EvidenceDraft[] = [
  say("ev-w1", "这周六的饭局我就不去了", "2026-03-07T10:00:00+08:00", WEEKEND),
  say("ev-w2", "周日的剧本杀我推掉了", "2026-03-15T10:00:00+08:00", WEEKEND),
  say("ev-w4", "周六的生日会我也没去", "2026-03-21T10:00:00+08:00", WEEKEND),
  say("ev-w3", "我不喜欢周末被排得满满的", "2026-04-04T10:00:00+08:00", { context: ["weekend"] }),
  say("ev-d1", "周二的分享会我推掉了", "2026-10-06T10:00:00+08:00", WORKDAY),
  say("ev-d2", "拒绝了周四的临时会议", "2026-10-08T10:00:00+08:00", WORKDAY),
  say("ev-d3", "工作日我也不喜欢被提前排满", "2026-10-09T10:00:00+08:00", { context: ["workday"] }),
  say("ev-a1", "我不吃香菜，一吃就过敏", "2026-05-01T10:00:00+08:00"),
];
const TALK = "这周六同事又约我去团建，周末被排得满满的好烦";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 假的内核向量函数，像工作线程里的 bge-m3：一次只算一批（排队），每批要 delayMs；
 * cold 时模型"卸掉了"（loaded 是 false），warm 要等测试放行（finishLoading）才加载好
 */
class SlowKernel extends FakeEmbedder {
  delayMs = 0;
  isLoaded = true;
  private queue: Promise<unknown> = Promise.resolve();
  private loading: { promise: Promise<void>; release: () => void } | undefined;
  override embed(texts: readonly string[]): Promise<Float32Array[]> {
    const run = this.queue.then(async () => {
      await sleep(this.delayMs);
      return super.embed(texts);
    });
    this.queue = run.catch(() => {});
    return run;
  }
  loaded(): boolean {
    return this.isLoaded;
  }
  warm(): Promise<void> {
    if (this.isLoaded) return Promise.resolve();
    if (this.loading === undefined) {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = () => {
          this.isLoaded = true;
          resolve();
        };
      });
      this.loading = { promise, release };
    }
    return this.loading.promise;
  }
  /** 模型加载好了 */
  finishLoading(): void {
    this.loading?.release();
  }
  /** 交给它算过的文字里有这一句的批数 */
  batchesWith(text: string): number {
    return this.calls.filter((batch) => batch.includes(text)).length;
  }
}

/** 素材库里只有 STORY 背后的那几条 */
function materialOf(id: string): Material {
  return {
    id,
    kind: "user_utterance",
    mode: "say",
    time: "2026-10-09T10:00:00.000+08:00",
    conversation: "secretary",
    task: null,
    project: null,
    source: "self",
    ref: { event: { globalSeq: 1, channel: "secretary", seq: 1, type: EVENT_TYPES.message } },
    context: [],
    segments: [],
    original: null,
    noInfer: false,
  };
}
const materials: Pick<Materials, "get" | "list"> = {
  get: (id) => (STORY.some((d) => d.sourceRef === id) ? materialOf(id) : undefined),
  list: () => STORY.map((d) => materialOf(d.sourceRef!)),
};

function eventStore(): EventStore {
  const store = openEventStore({ file: path.join(makeTempDir("ergo-brief-timing-store-"), "ergo.db"), views: [conversationMessagesView] });
  onTestFinished(() => store.close());
  return store;
}

/** 临时目录里的 rg.db：灌证据、规则版整理一遍、算好证据和结论的向量（和每晚整理之后一样） */
async function reasoningDb(): Promise<string> {
  const clock = new ManualClock(NOW);
  const file = path.join(makeTempDir("ergo-brief-timing-"), "db", "rg.db");
  const opened = openReasoningDb({ file, clock: () => clockIso(clock), model: "deepseek-flash", embedder: kernelEmbedderAdapter(new FakeEmbedder()) });
  if (!opened.ok) throw new Error("应该能建库");
  for (const draft of STORY) opened.engine.ingestEvidence(draft);
  await opened.engine.reflect();
  await opened.engine.indexVectors();
  await opened.engine.indexClaims();
  opened.engine.close();
  return file;
}

function providerContext(logs: string[]): MemoryProviderContext {
  return {
    dataDir: makeTempDir("ergo-brief-timing-subtext-"),
    identity: () => ({ language: "zh", assistantName: "二狗" }),
    llm: () => Promise.reject(new Error("不该调模型")),
    embed: () => Promise.reject(new Error("不该经宿主算向量")),
    now: () => NOW,
    log: (line) => logs.push(line),
    signal: new AbortController().signal,
  };
}

/**
 * 生产里那条路：会意插件（组合根那份只读引擎，秘书那一侧共用的向量函数）+ 每条消息的简报。
 * 背景语料向量先预热好（记忆插件起来 20 秒后做的那一下，预热的是同一个实例），预热算的那一批不算进 kernel.calls
 */
async function briefPath(kernel: SlowKernel, over: Partial<MessageBriefsOptions> & { modelWaitMs?: number } = {}) {
  const file = await reasoningDb();
  const store = eventStore();
  const logs: string[] = [];
  const clock = new ManualClock(NOW);
  const embedder = secretaryEmbedder(kernel);
  const runtime = createSubtextRuntime({
    file,
    clock,
    model: "deepseek-flash",
    embedder,
    ...(over.modelWaitMs === undefined ? {} : { modelWaitMs: over.modelWaitMs }),
    config: DEFAULT_MEMORY_CONFIG,
    store,
    materials,
    log: (line) => logs.push(line),
  });
  onTestFinished(() => runtime.close());
  const provider = createSubtextProvider(runtime.deps);
  await provider.start(providerContext(logs));
  await backgroundVectors(embedder);
  kernel.calls.splice(0);
  const asked: MemoryBriefInput[] = [];
  const briefs = createMessageBriefs({
    brief: (input) => (asked.push(input), provider.brief(input)),
    store,
    materials,
    enabled: () => true,
    now: () => clockIso(clock),
    log: (line) => logs.push(line),
    ...over,
  });
  const off = store.onAppend((event) => briefs.onEvent(event));
  onTestFinished(off);
  return { store, briefs, logs, asked };
}

let seq = 0;
function userMessage(store: EventStore, text: string): MessageEnvelope {
  seq += 1;
  const message: MessageEnvelope = { id: `m-timing-${seq}`, conversation: SECRETARY, speaker: "user", time: clockIso(new ManualClock(NOW)), parts: [{ type: "text", text }] };
  store.append({ channel: SECRETARY, type: EVENT_TYPES.message, payload: { message } });
  return message;
}

const say1 = (store: EventStore, b: MessageBriefs, text: string) => b.inputText(userMessage(store, text), { agentId: "secretary" });
const timeouts = (logs: readonly string[]) => logs.filter((line) => line.includes("记忆简报超时"));

describe("记忆简报：各步耗时（日志一行、体检的统计）", () => {
  it("带了：日志一行写各步毫秒；stats 记一次 brought，各步按先后（打开推理库、检索、往上走的起点、三条路、向量门槛、挑结论、拼正文、对回素材）", async () => {
    const kernel = new SlowKernel();
    const { store, briefs, logs } = await briefPath(kernel);
    expect(await say1(store, briefs, TALK)).toBeDefined();
    const line = logs.find((l) => l.startsWith("记忆简报：带了"));
    expect(line).toMatch(/^记忆简报：带了 \d+ 条（约 \d+ token，\d+ 毫秒(；各步：.+)?）$/);
    const stats = briefs.stats();
    expect(stats.counts).toEqual({ asked: 1, brought: 1, empty: 0, timeout: 0, error: 0 });
    const [run] = stats.recent;
    expect(run).toMatchObject({ outcome: "brought", at: clockIso(new ManualClock(NOW)) });
    expect(run!.items).toBeGreaterThan(0);
    expect(run!.ms).toBeLessThan(MESSAGE_BRIEF_TIMEOUT_MS);
    // 第一次还要往回认带过的（守护进程起来后的第一条）
    expect(run!.steps.map((s) => s.step)).toEqual(["recall", "open", "search", "base", "userModel", "vectorGate", "profile", "render", "hits"]);
    expect(run!.steps.every((s) => Number.isInteger(s.ms) && s.ms >= 0)).toBe(true);

    // 不相关的也记一笔、写一行（看得出没带是因为不相关，不是因为慢）
    expect(await say1(store, briefs, "明天上海会下雨吗")).toBeUndefined();
    expect(logs.some((l) => l.startsWith("记忆简报：没有要带的（"))).toBe(true);
    expect(briefs.stats().counts).toMatchObject({ asked: 2, empty: 1 });
    // 交出去的是拷贝
    briefs.stats().recent[0]!.steps.length = 0;
    expect(briefs.stats().recent[0]!.steps.length).toBeGreaterThan(0);
  });

  it("超时：日志写到上限那一刻做完了哪几步；那一份接着算完再记一行它一共用了多久；stats 记一次 timeout，带上后来的耗时", async () => {
    const store = eventStore();
    const logs: string[] = [];
    const briefs = createMessageBriefs({
      store,
      materials,
      enabled: () => true,
      timeoutMs: 50,
      log: (line) => logs.push(line),
      brief: async (input) => {
        input.onStep?.("search", 30);
        await sleep(150);
        input.onStep?.("userModel", 120);
        return { text: "迟到的简报" };
      },
    });
    expect(await say1(store, briefs, TALK)).toBeUndefined();
    expect(timeouts(logs)).toHaveLength(1);
    expect(timeouts(logs)[0]).toContain("检索 30");
    expect(timeouts(logs)[0]).not.toContain("三条路找结论");
    expect(briefs.stats().counts).toMatchObject({ asked: 1, timeout: 1 });
    await sleep(250);
    const late = logs.find((l) => l.includes("超时的那一份后来算完了"));
    expect(late).toMatch(/一共 \d+ 毫秒；各步：检索 30、三条路找结论 120/);
    const [run] = briefs.stats().recent;
    expect(run!.outcome).toBe("timeout");
    expect(run!.lateMs).toBeGreaterThanOrEqual(150);
    expect(run!.steps.map((s) => s.step)).toEqual(["recall", "search", "userModel"].filter((s) => run!.steps.some((x) => x.step === s)));
  });

  it("出错：记一次 error，日志写原因和用了多久", async () => {
    const store = eventStore();
    const logs: string[] = [];
    const briefs = createMessageBriefs({ store, materials, enabled: () => true, log: (line) => logs.push(line), brief: () => Promise.reject(new Error("推理库坏了")) });
    expect(await say1(store, briefs, TALK)).toBeUndefined();
    expect(logs.some((l) => l.startsWith("记忆简报出错，这一轮不带：推理库坏了（"))).toBe(true);
    expect(briefs.stats().counts).toMatchObject({ asked: 1, error: 1 });
  });
});

describe("记忆简报：慢在哪修在哪（427）", () => {
  it("一份简报只算一次这句话的查询向量（检索、往上走的起点、结论索引、两道向量门槛共用）；起来时预热的背景语料向量简报用得上，不再算", async () => {
    const kernel = new SlowKernel();
    const { store, briefs } = await briefPath(kernel);
    expect(await say1(store, briefs, TALK)).toBeDefined();
    expect(kernel.batchesWith(TALK)).toBe(1);
    // 200 句背景语料只在预热时算过一次（预热和简报用的是同一个实例）
    expect(kernel.calls.filter((batch) => batch.length >= 100)).toEqual([]);
  });

  it("算向量慢、几条消息一起来（像工作线程排队，一批 300 毫秒）：每条都在上限内回来，不超时", async () => {
    const kernel = new SlowKernel();
    const { store, briefs, logs } = await briefPath(kernel);
    kernel.delayMs = 300;
    const texts = [TALK, "周末又被排满了，好烦", "工作日也老被提前排满"];
    const results = await Promise.all(texts.map((text) => say1(store, briefs, text)));
    expect(timeouts(logs)).toEqual([]);
    expect(results[0]).toBeDefined();
    expect(briefs.stats().counts.timeout).toBe(0);
    // 每句话只交给模型一次
    for (const text of texts) expect(kernel.batchesWith(text)).toBe(1);
  });

  it("向量模型闲置卸掉了（冷启动要好几秒）：简报等一小会儿，等不到这一轮就不算向量、只走关键词——照样带，不超时；模型接着在后台加载，下一条照常算向量", async () => {
    const kernel = new SlowKernel();
    const { store, briefs, logs } = await briefPath(kernel, { modelWaitMs: 50 });
    kernel.isLoaded = false;
    const block = await say1(store, briefs, TALK);
    expect(block).toBeDefined();
    expect(block).toContain("「我不喜欢周末被排得满满的」");
    expect(timeouts(logs)).toEqual([]);
    // 这一轮没把这句话交给（还没加载好的）模型
    expect(kernel.batchesWith(TALK)).toBe(0);
    expect(logs.find((l) => l.startsWith("记忆简报：带了"))).toContain("向量模型没等到、这一轮不算向量");
    expect(briefs.stats().recent[0]!.steps.map((s) => s.step)).toContain("modelCold");

    // 模型加载好了：下一条照常算向量
    kernel.finishLoading();
    const next = "周末又被排满了，好烦";
    await say1(store, briefs, next);
    expect(kernel.batchesWith(next)).toBe(1);
    expect(briefs.stats().recent[1]!.steps.map((s) => s.step)).not.toContain("modelCold");
  });

  it("模型在等的那一小会儿里加载好了：照常算向量，各步里记下等了多久", async () => {
    const kernel = new SlowKernel();
    const { store, briefs } = await briefPath(kernel, { modelWaitMs: 2_000 });
    kernel.isLoaded = false;
    setTimeout(() => kernel.finishLoading(), 30);
    expect(await say1(store, briefs, TALK)).toBeDefined();
    expect(kernel.batchesWith(TALK)).toBe(1);
    const steps = briefs.stats().recent[0]!.steps;
    expect(steps.map((s) => s.step)).toContain("modelLoad");
    expect(steps.find((s) => s.step === "modelLoad")!.ms).toBeGreaterThanOrEqual(20);
  });
});

describe("用户发来一句就预热向量模型", () => {
  it("秘书主会话里用户本人的一句：叫 prewarm（不等）；秘书的回话、别的会话、简报关着都不叫", () => {
    const store = eventStore();
    let warmed = 0;
    let on = true;
    const briefs = createMessageBriefs({ store, materials, enabled: () => on, log: () => {}, prewarm: () => (warmed += 1), brief: () => Promise.resolve(undefined) });
    const off = store.onAppend((event) => briefs.onEvent(event));
    onTestFinished(off);
    userMessage(store, TALK);
    expect(warmed).toBe(1);
    const reply: MessageEnvelope = { id: "m-agent-x", conversation: SECRETARY, speaker: "agent", time: clockIso(new ManualClock(NOW)), parts: [{ type: "text", text: "好的" }] };
    store.append({ channel: SECRETARY, type: EVENT_TYPES.message, payload: { message: reply } });
    const elsewhere: MessageEnvelope = { id: "m-other-x", conversation: "maintainer:tm-1", speaker: "user", time: clockIso(new ManualClock(NOW)), parts: [{ type: "text", text: TALK }] };
    store.append({ channel: "maintainer:tm-1", type: EVENT_TYPES.message, payload: { message: elsewhere } });
    on = false;
    userMessage(store, TALK);
    expect(warmed).toBe(1);
  });
});
