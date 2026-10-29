// 232 号票：秘书的 ask_memory 工具和每轮醒来的记忆简报（memory.brief 上下文块）。用临时目录里的真 SQLite、真 MemoryEngine
// （规则版抽取和推理、假向量），不调真的模型；引擎经 createMemoryEngineProvider 懒打开，和插件装配时走同一条路。
// 例子是 196 号票测试的那个人（自己写的，不看 @ergo/memory 的 fixtures/truth）：3 月到 10 月周末、工作日都在推掉排好的事，
// 规则版往上抽出需求、价值观；另有一条带"过敏"的忌口（明说的禁忌）和一条早就过期的"最近太累"。
import fs from "node:fs";
import path from "node:path";
import { type EvidenceDraft, type MemoryEngine, type QuestionDraft } from "@ergo/memory";
import { describe, expect, it, onTestFinished } from "vitest";
import { type Materials, EmbeddingUnavailable } from "../../src/materials/index.ts";
import { ASK_MEMORY_MAX_CHARS, ASK_MEMORY_NOT_READY, askMemoryTool } from "../../src/memory/ask-tool.ts";
import { MEMORY_BRIEF_MAX_CHARS, wakeBriefText } from "../../src/memory/context.ts";
import { kernelEmbedderAdapter } from "../../src/memory/embedder-adapter.ts";
import { createMemoryEngineProvider, createWritableEngineUse, type MemoryEngineProvider } from "../../src/memory/engine-provider.ts";
import { openReasoningDb } from "../../src/memory/rg-db.ts";
import { searchMaterialsTool } from "../../src/memory/search-tool.ts";
import { clockIso } from "../../src/scheduler/clock.ts";
import { openDatabase } from "../../src/storage/sqlite.ts";
import { ManualClock } from "../helpers/clock.ts";
import { FakeEmbedder } from "../helpers/embedder.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

/** 本地时间 2026 年 10 月 12 日 12:00（周一）；今天的星期不影响规则版 */
const NOW = new Date(2026, 9, 12, 12, 0);

const say = (id: string, text: string, at: string, over: Partial<EvidenceDraft> = {}): EvidenceDraft => ({
  id,
  sourceLevel: "self",
  mode: "say",
  kind: "utterance",
  text,
  context: [],
  eventTime: at,
  observedAt: at,
  ...over,
});

const WEEKEND = { context: ["weekend", "social"] };
const WORKDAY = { context: ["workday", "work"] };

/** 规则版能往上抽出需求"重视自主安排"和价值"长期看重自主安排"的那个人 */
const STORY: readonly EvidenceDraft[] = [
  say("ev-w1", "这周六的饭局我就不去了", "2026-03-07T10:00:00+08:00", WEEKEND),
  say("ev-w2", "周日的剧本杀我推掉了", "2026-03-15T10:00:00+08:00", WEEKEND),
  say("ev-w4", "周六的生日会我也没去", "2026-03-21T10:00:00+08:00", WEEKEND),
  say("ev-w3", "我不喜欢周末被排得满满的", "2026-04-04T10:00:00+08:00", { context: ["weekend"] }),
  say("ev-d1", "周二的分享会我推掉了", "2026-10-06T10:00:00+08:00", WORKDAY),
  say("ev-d2", "拒绝了周四的临时会议", "2026-10-08T10:00:00+08:00", WORKDAY),
  say("ev-d3", "工作日我也不喜欢被提前排满", "2026-10-09T10:00:00+08:00", { context: ["workday"] }),
  say("ev-t1", "最近太累了", "2026-09-01T10:00:00+08:00"),
  say("ev-a1", "我不吃香菜，一吃就过敏", "2026-05-01T10:00:00+08:00"),
];

/** 只有几次推掉活动、没有明说的话：周末那组几种解释都还拿不准 */
const OPEN_STORY: readonly EvidenceDraft[] = STORY.filter((draft) => ["ev-w1", "ev-w2", "ev-w4", "ev-a1", "ev-t1"].includes(draft.id!));

interface Built {
  file: string;
  clock: ManualClock;
  provider: MemoryEngineProvider;
  /** 懒打开之后能用的引擎（测试里现取） */
  engine(): MemoryEngine;
}

/**
 * 临时目录里的 rg.db：先建库、灌证据、按规则版整理一遍、关掉；再交回懒打开它的 provider（和插件里一样，
 * 开着的时候只开一次）。
 */
async function reasoningDb(evidence: readonly EvidenceDraft[] = STORY): Promise<Built> {
  const clock = new ManualClock(NOW);
  const file = path.join(makeTempDir("ergo-brief-"), "db", "rg.db");
  const opened = openReasoningDb({ file, clock: () => clockIso(clock), model: "deepseek-flash", embedder: kernelEmbedderAdapter(new FakeEmbedder()) });
  if (!opened.ok) throw new Error("应该能建库");
  for (const draft of evidence) opened.engine.ingestEvidence(draft);
  await opened.engine.reflect();
  opened.engine.close();
  const provider = createMemoryEngineProvider({ file, clock: () => clockIso(clock), model: "deepseek-flash", embedder: kernelEmbedderAdapter(new FakeEmbedder()) });
  // 临时目录的删除钩子先登记、后跑，所以这里关引擎在删目录之前
  onTestFinished(() => provider.close());
  return {
    file,
    clock,
    provider,
    engine() {
      const engine = provider.get();
      if (!engine) throw new Error("引擎应该打得开");
      return engine;
    },
  };
}

/** 醒来简报的抬头：唤醒的那个上下文块（266 号票起叫醒来简报，【记忆简报】是每条消息跟在输入后面的那块） */
const HEADER = "【醒来简报】";

/**
 * 一条素材的假素材库（235 号票的降级测试用）：关键词查得到一条、语义查的时候抛"向量模型不在"（和记忆插件没在采集时一样）。
 * search_materials 只用到这两个方法，别的没实现（真素材库 = materials/materials.ts 的那套，在别的测试里）。
 */
function fakeLibrary() {
  const material = {
    id: "mat-degrade-1",
    kind: "user_utterance",
    mode: "say",
    source: "self",
    time: "2026-10-08T09:30:00.000+08:00",
    conversation: "secretary",
    task: null,
    project: null,
    context: [],
    ref: { event: { globalSeq: 1, channel: "secretary", seq: 1, type: "message" } },
    segments: [{ form: "typed", source: "self", notes: [], locator: {}, text: "下个月搬家", sha256: "sha-degrade" }],
    original: null,
    noInfer: false,
  } as const;
  return {
    searchKeyword: () => [material],
    searchSemantic: () => Promise.reject(new EmbeddingUnavailable("测试里没有向量模型")),
  } as unknown as Materials;
}

describe("ask_memory 工具", () => {
  it("只给秘书的只读工具：问一句，返回简报正文（记录 + 用户画像两节、结论带编号、明说的禁忌也在、拿不准的组带能区分的问题），不超过 4000 字", async () => {
    const built = await reasoningDb();
    const tool = askMemoryTool(built.provider);
    expect(tool.spec.name).toBe("ask_memory");
    expect(tool.descriptor).toMatchObject({ readOnlyOrIdempotent: true, nature: "look" });
    // 说明里写清什么时候用、返回的是推断
    expect(tool.spec.description).toMatch(/推断|把握/);
    // 懒打开：第一次用的时候开、之后一直是同一个（不每次都开一个连接）
    const engine = built.provider.get();
    expect(engine).toBeDefined();
    expect(built.provider.get()).toBe(engine);

    const output = await tool.run({ question: "我是不是特别不喜欢周末被安排得满满的？" }, { toolCallId: "call-ask" });
    expect(output.isError ?? false).toBe(false);
    const text = output.text;
    expect(text.length).toBeLessThanOrEqual(ASK_MEMORY_MAX_CHARS);
    // 记录 + 用户画像两节
    expect(text).toContain("【记录】");
    expect(text).toContain("【对用户的理解】");
    // 结论带编号（回答器只认简报里出现的编号）
    const claimIds = [...new Set(text.match(/cl-\d{4}/g) ?? [])];
    expect(claimIds.length).toBeGreaterThan(0);
    // 需求、价值观都在，标了谁说的、把握
    expect(text).toMatch(/需求 · 推断的 · 已验证 · 把握[低中高]/);
    expect(text).toMatch(/价值观 · 推断的 · 已验证 · 把握[低中高]/);
    // 明说的禁忌（"不吃香菜、过敏"）在：简报的优先级里它排最前（放不下时最后砍的是它）
    expect(text).toContain("【明说过的要求和禁忌】");
    expect(text).toMatch(/禁忌：\[cl-\d{4}\].*香菜/);
  });

  // 263 号票：问记忆也进"回忆了 N 条记忆"那一行——命中是简报里引用的证据背后的素材
  it("交回结构化的调用记忆（source 是 ask）：查了什么是问题，命中是简报里引用的证据背后的素材（去重、素材库里没有的不列）", async () => {
    const built = await reasoningDb(STORY.map((draft) => ({ ...draft, sourceRef: `mat-${draft.id}` })));
    const gone = "mat-ev-w3";
    const materials = {
      get: (id: string) =>
        id.startsWith("mat-") && id !== gone ? ({ id, kind: "user_utterance", time: "2026-10-09T10:00:00.000+08:00", conversation: "secretary" } as never) : undefined,
    } as unknown as Pick<Materials, "get">;
    const question = "我是不是特别不喜欢周末被安排得满满的？";
    const output = await askMemoryTool(built.provider, materials).run({ question }, { toolCallId: "call-ask" });
    expect(output.recall).toBeDefined();
    const recall = output.recall!;
    expect(recall).toMatchObject({ source: "ask", query: question });
    expect(recall.why).toBeUndefined();
    // 简报正文里出现的证据（素材库里还在的）一条一个命中，按出现的先后、不重复
    const cited = [...new Set(output.text.match(/ev-[a-z]\d/g) ?? [])].map((id) => `mat-${id}`).filter((id) => id !== gone);
    expect(cited.length).toBeGreaterThan(0);
    expect(recall.hits.map((hit) => hit.materialId).toSorted()).toEqual(cited.toSorted());
    expect(recall.hits[0]).toMatchObject({ kind: "user_utterance", time: "2026-10-09T10:00:00.000+08:00", conversation: "secretary" });
    expect(recall.hits.map((hit) => hit.materialId)).not.toContain(gone);
    // 不给素材库（老的装配）：只交回正文
    const plain = await askMemoryTool(built.provider).run({ question }, { toolCallId: "call-ask-2" });
    expect(plain.recall).toBeUndefined();
  });

  it("拿不准的竞争解释带一个能区分的问题", async () => {
    const built = await reasoningDb(OPEN_STORY);
    const output = await askMemoryTool(built.provider).run({ question: "帮我安排下周六，别太累" }, { toolCallId: "call-ask" });
    expect(output.text).toContain("【还没分出胜负的解释】");
    expect(output.text).toMatch(/能区分的问题：.+/);
  });

  it("引擎用不了（还没建库）：回\"记忆还没准备好\"，不抛错、不当成出错", async () => {
    const file = path.join(makeTempDir("ergo-brief-"), "db", "rg.db");
    const provider = createMemoryEngineProvider({ file, clock: () => clockIso(new ManualClock(NOW)), model: "deepseek-flash" });
    onTestFinished(() => provider.close());
    expect(provider.get()).toBeUndefined();
    expect(fs.existsSync(file)).toBe(false);
    const output = await askMemoryTool(provider).run({ question: "我最看重什么？" }, { toolCallId: "call-ask" });
    expect(output.text).toBe(ASK_MEMORY_NOT_READY);
    expect(output.isError ?? false).toBe(false);
    // 没建库也不顺手建一个
    expect(fs.existsSync(file)).toBe(false);
  });

  // 235 号票：四条降级之三——推理库打不开 / 版本对不上：素材检索照常，简报和 ask_memory 回"记忆还没准备好"
  it("推理库版本对不上：简报是空串、ask_memory 回\"记忆还没准备好\"，素材检索照常（同一条需要素材库的路）", async () => {
    const clock = new ManualClock(NOW);
    const file = path.join(makeTempDir("ergo-brief-"), "db", "rg.db");
    const created = openReasoningDb({ file, clock: () => clockIso(clock), model: "deepseek-flash" });
    if (!created.ok) throw new Error("应该能建库");
    created.engine.close();
    // 把 manifest 的格式版本改错（比如降级了守护进程）：不自动迁移
    const db = openDatabase(file);
    try {
      db.run("UPDATE rg_manifest SET value = '99' WHERE key = 'schema'");
    } finally {
      db.close();
    }
    const provider = createMemoryEngineProvider({ file, clock: () => clockIso(clock), model: "deepseek-flash" });
    onTestFinished(() => provider.close());
    expect(provider.get()).toBeUndefined();
    expect(wakeBriefText(provider.get())).toBe("");
    const asked = await askMemoryTool(provider).run({ question: "我最看重什么？" }, { toolCallId: "call-ask" });
    expect(asked.text).toBe(ASK_MEMORY_NOT_READY);
    expect(asked.isError ?? false).toBe(false);

    // 素材检索是另一条路（素材库，不碰 rg.db）：照常查得到，向量模型不在就退回关键词并说明
    const output = await searchMaterialsTool(fakeLibrary()).run({ query: "搬家", why: "验收：推理库用不了时素材检索照常" }, { toolCallId: "call-search" });
    expect(output.isError ?? false).toBe(false);
    expect(output.text).toContain("mat-degrade-1");
    expect(output.text).toContain("向量模型不在，这次只按关键词检索");
  });
});

describe("每轮醒来的记忆简报", () => {
  it("给你对用户的理解：需求、价值观各最多 3 条、带谁说的和把握，还拿不准的最多 2 组；问题箱里的问题不放（264 号票起顺口问另走每条输入的上下文块）；不超过 1200 字", async () => {
    const built = await reasoningDb();
    const engine = built.engine();
    const need = engine.store.listClaims({ tier: "need", status: "active" })[0]!;
    const value = engine.store.listClaims({ tier: "value", status: "active" })[0]!;
    expect(need).toBeDefined();
    expect(value).toBeDefined();
    // 问题箱里放一个开着的（整理时由 nightly 灌进来；这里直接交一份，省掉一套来源）：简报里不出现它
    const draft: QuestionDraft = {
      key: "test:autonomy",
      topic: "claim:test",
      kind: "unresolved",
      sources: ["unresolved"],
      text: "上次推掉的周末活动，要是时间由你自己定，你会去吗？",
      why: "想分清是重视自己安排时间、还是这阵子太累",
      targets: [{ id: need.id, kind: "claim", statement: need.statement }],
      answers: {
        yes: { supports: [need.id], refutes: [], maxWeight: "strong", note: "会去说明更看重自己安排" },
        no: { supports: [], refutes: [need.id], maxWeight: "strong", note: "不会去说明不是安排的问题" },
      },
      domains: ["time"],
      scenes: [],
      terms: ["周末"],
      probeId: null,
      validUntil: null,
      separation: 1,
      closeness: 0.5,
      frequency: 0.5,
    };
    // 267 号票：简报那份是读者引擎（写入口只读），问题要用一份可写的引擎放进去
    const seeded = createWritableEngineUse({ file: built.file, clock: () => clockIso(built.clock), model: "deepseek-flash" })((writer) => writer.questions.offer(draft, clockIso(built.clock)).question);
    expect(seeded).toBeDefined();

    const text = wakeBriefText(engine);
    expect(text.length).toBeLessThanOrEqual(MEMORY_BRIEF_MAX_CHARS);
    expect(text.startsWith(HEADER)).toBe(true);
    // 需求、价值观各一行，带编号、谁说的（推断的）、把握
    const lines = text.split("\n");
    const needs = lines.filter((line) => line.startsWith("- 需求 "));
    const values = lines.filter((line) => line.startsWith("- 价值观 "));
    expect(needs.length).toBeGreaterThan(0);
    expect(values.length).toBeLessThanOrEqual(3);
    expect(needs.length).toBeLessThanOrEqual(3);
    expect(needs[0]).toContain(`[${need.id}]`);
    expect(needs[0]).toMatch(/推断的 · 把握[低中高]/);
    expect(values[0]).toContain(`[${value.id}]`);
    // 264 号票：问题箱里开着的问题不进简报（秘书不看话题自己问、问了也没人记）；顺口问由每条输入后面的上下文块交
    expect(text).not.toContain("顺口问");
    expect(text).not.toContain("上次推掉的周末活动");
  });

  it("330 号票（R5）：需求、价值观里的猜测也给（最多 3 条，标'猜测'和把握，谁说的）；已经在'还拿不准'那几组里的不重复列；抬头写清猜测可以照着说、把握低的留余地", async () => {
    const built = await reasoningDb();
    const engine = built.engine();
    const text = wakeBriefText(engine);
    expect(text).toContain('"猜测"是还没证实的——可以照着说、拿来推荐，把握低的留余地');
    const lines = text.split("\n");
    const guesses = lines.filter((line) => line.startsWith("- 猜测 · "));
    expect(guesses.length).toBeGreaterThan(0);
    expect(guesses.length).toBeLessThanOrEqual(3);
    for (const line of guesses) {
      expect(line).toMatch(/^- 猜测 · (需求|价值观) \[cl-\d{4}\] .+（(推断的|用户说的|用户确认过) · 把握[低中高]）$/);
      const id = /\[(cl-\d{4})\]/.exec(line)![1]!;
      expect(engine.store.getClaim(id)!.status).toBe("contested");
    }
    expect(text.length).toBeLessThanOrEqual(MEMORY_BRIEF_MAX_CHARS);
  });

  it("竞争解释拿不准时列出来（各一句，带能区分的问题），最多 2 组；这时还没有需求、价值观结论也照样给", async () => {
    const built = await reasoningDb(OPEN_STORY);
    const engine = built.engine();
    expect(engine.store.listClaims({ tier: "need", status: "active" })).toEqual([]);
    const text = wakeBriefText(engine);
    const lines = text.split("\n").filter((line) => line.startsWith("- 还拿不准"));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(2);
    expect(lines[0]).toContain("能区分的问题：");
    expect(text.length).toBeLessThanOrEqual(MEMORY_BRIEF_MAX_CHARS);
  });

  it("空库（还没整理出结论）时是空串，不产生空块；引擎用不了时也是空串", async () => {
    // 建了库、还没整理
    const clock = new ManualClock(NOW);
    const file = path.join(makeTempDir("ergo-brief-"), "db", "rg.db");
    const opened = openReasoningDb({ file, clock: () => clockIso(clock), model: "deepseek-flash" });
    if (!opened.ok) throw new Error("应该能建库");
    opened.engine.close();
    const provider = createMemoryEngineProvider({ file, clock: () => clockIso(clock), model: "deepseek-flash" });
    onTestFinished(() => provider.close());
    expect(wakeBriefText(provider.get())).toBe("");
    // 停用（close）之后就不再有引擎，简报是空串
    provider.close();
    expect(provider.get()).toBeUndefined();
    expect(wakeBriefText(provider.get())).toBe("");
    // 还没建库（引擎没开）
    const missing = createMemoryEngineProvider({ file: path.join(path.dirname(path.dirname(file)), "db", "none.db"), clock: () => clockIso(clock), model: "deepseek-flash" });
    onTestFinished(() => missing.close());
    expect(wakeBriefText(missing.get())).toBe("");
    expect(wakeBriefText(undefined)).toBe("");
  });
});
