// 205 号票：回答层的三处修正——向量相关门槛按自带的背景闲聊校准（比随便一句闲聊更像才算挨着）、任务的建议附了追问算有结论、
// 挑到的组还没分出胜负但用户明说过相关的话时以明说的为准。例子都是自己写的，不看评测数据。
import { afterEach, describe, expect, it } from "vitest";
import type { Embedder } from "../../src/embedding/embedder.ts";
import { FakeEmbedder } from "../../src/embedding/fake.ts";
import type { Hit } from "../../src/retrieval/types.ts";
import { BACKGROUND_PERCENTILE, BACKGROUND_SENTENCES, backgroundThreshold, percentile } from "../../src/rg/background.ts";
import { DEFAULT_RELEVANCE_GATE, hitSupported, questionVectorGate, relevantForQuestion } from "../../src/rg/relevance.ts";
import type { Answer } from "../../src/rg/types.ts";
import { claimOf, closeEngines, ingestWeekend, openEngine, say } from "./helpers.ts";
import { member, NEED, storyEngine, WEEKEND_GROUP } from "./task-helpers.ts";

afterEach(closeEngines);

const byRole = (a: Answer, role: string) => a.citations.filter((c) => c.role === role).map((c) => c.claimId);
const hit = (id: string, channels: Hit["channels"]): Hit => ({ evidenceId: id, sourceLevel: "self", channels, fused: 0, via: { factIds: [], probeIds: [] } });

/** 只有向量那一路、余弦是 score 的检索结果 */
const v = (score: number) => hit("ev-w1", { evidence_vector: { rank: 1, score } });

/** 能换模型名的假向量：数一数背景语料算了几次 */
class SwitchableEmbedder implements Embedder {
  model = "fake-a";
  backgroundBatches = 0;
  private readonly inner = new FakeEmbedder();
  available(): boolean {
    return true;
  }
  unavailableHint(): string {
    return "";
  }
  embedDocuments(texts: readonly string[]): Promise<Float32Array[]> {
    if (texts.length === BACKGROUND_SENTENCES.length) this.backgroundBatches += 1;
    return this.inner.embedDocuments(texts);
  }
  embedQueries(texts: readonly string[]): Promise<Float32Array[]> {
    return this.inner.embedQueries(texts);
  }
  async close(): Promise<void> {}
}

async function storyWithVectors() {
  const t = await storyEngine({ embedder: new FakeEmbedder() });
  await t.engine.indexVectors();
  return t;
}

describe("自带的背景语料：200 条左右和任何人无关的日常短句", () => {
  it("条数、不重复、不说'我'、不提'用户'", () => {
    expect(BACKGROUND_SENTENCES.length).toBeGreaterThanOrEqual(180);
    expect(BACKGROUND_SENTENCES.length).toBeLessThanOrEqual(240);
    expect(new Set(BACKGROUND_SENTENCES).size).toBe(BACKGROUND_SENTENCES.length);
    for (const s of BACKGROUND_SENTENCES) {
      expect(s.trim().length).toBeGreaterThan(4);
      expect(s).not.toMatch(/我|用户/);
    }
  });

  it("百分位按最近名次法：20 个数的第 95 百分位是第 19 个", () => {
    const values = Array.from({ length: 20 }, (_, i) => 20 - i);
    expect(percentile(values, 0.95)).toBe(19);
    expect(percentile(values, 0.5)).toBe(10);
    expect(percentile([0.3], 0.95)).toBe(0.3);
    expect(BACKGROUND_PERCENTILE).toBe(0.95);
    expect(DEFAULT_RELEVANCE_GATE.vectorPercentile).toBe(0.95);
  });
});

describe("向量门槛：每个问题和背景语料的余弦分布的第 95 百分位，超过才算挨着", () => {
  it("门槛跟着问题走：没有概念词的问法（假向量只靠字的散列）和背景更像，门槛更高", async () => {
    const e = new FakeEmbedder();
    const plain = await backgroundThreshold(e, "我是不是喜欢夜跑？");
    const topical = await backgroundThreshold(e, "双休那两天的聚餐");
    expect(plain).not.toBeNull();
    expect(topical).not.toBeNull();
    expect(plain!).toBeGreaterThan(topical!);
    // 就是那个分布的第 95 百分位
    const [q] = await e.embedQueries(["双休那两天的聚餐"]);
    const docs = await e.embedDocuments(BACKGROUND_SENTENCES);
    const cos = docs.map((d) => d.reduce((s, x, i) => s + x * q![i]!, 0));
    expect(topical!).toBeCloseTo(percentile(cos, 0.95), 6);
  });

  it("背景向量随模型缓存：同一个模型只算一次，换了模型名重算", async () => {
    const e = new SwitchableEmbedder();
    await backgroundThreshold(e, "第一个问题");
    await backgroundThreshold(e, "第二个问题");
    expect(e.backgroundBatches).toBe(1);
    e.model = "fake-b";
    await backgroundThreshold(e, "第三个问题");
    expect(e.backgroundBatches).toBe(2);
  });

  it("没有向量函数、模型不在：没有门槛（向量那一路不算命中）", async () => {
    expect(await backgroundThreshold(undefined, "随便问问")).toBeNull();
    expect(await backgroundThreshold(new FakeEmbedder({ available: false }), "随便问问")).toBeNull();
    const { engine } = await storyEngine();
    // 263 号票删了只算背景那道的 questionVectorThreshold（没人调了）：两道门槛一起算的 questionVectorGate 里背景那道照样是 null
    expect(await questionVectorGate(engine.rg, "随便问问")).toEqual({ background: null, own: null });
  });

  it("hitSupported 按给的门槛：余弦超过门槛才算，没有门槛时向量不算；有话题词照样算", async () => {
    const { engine } = await storyEngine();
    const view = engine.rg.view();
    expect(hitSupported(v(0.61), ["夜跑"], view, 0.6)).toBe(true);
    expect(hitSupported(v(0.6), ["夜跑"], view, 0.6)).toBe(false);
    expect(hitSupported(v(0.9), ["夜跑"], view, null)).toBe(false);
    expect(hitSupported(v(0.1), ["饭局"], view, 0.6)).toBe(true);
  });

  it("'我到底爱不爱看书'（带假向量）：和背景闲聊差不多像的原话不算挨着——202 的固定 0.5 会拿'不吃香菜'来答，现在不拿，D 组和 C 组一样", async () => {
    const { engine } = await storyWithVectors();
    const q = "我到底爱不爱看书？";
    const base = await engine.rg.baseSearch(q, { limit: 20 });
    const a1 = base.find((h) => h.evidenceId === "ev-a1")!;
    const cos = a1.channels.evidence_vector!.score;
    const rel = await relevantForQuestion(engine.rg, q, {}, base);
    // "我不吃香菜，一吃就过敏"和问题的余弦过了 0.5，但没超过这个问题和背景闲聊的第 95 百分位
    expect(cos).toBeGreaterThan(0.5);
    expect(rel.vectorThreshold!).toBeGreaterThan(cos);
    expect(rel.supportedHitIds).not.toContain("ev-a1");
    expect(rel.gated).toEqual([]);
    const a = await engine.answer(q);
    expect(a).toMatchObject({ kind: "self", certain: false });
    expect(a.citations.flatMap((c) => c.evidenceIds)).not.toContain("ev-a1");
    const c = await engine.search(q, { mode: "hybrid_kg", limit: 10 });
    const d = await engine.search(q, { mode: "hybrid_kg_rg", limit: 10 });
    expect(d.map((h) => [h.evidenceId, h.fused])).toEqual(c.map((h) => [h.evidenceId, h.fused]));
  });

  it("'双休那两天的聚餐'：字面不沾边、意思比背景闲聊像得多的原话算挨着，挂在上面的'重视周末的自主安排'过门槛", async () => {
    const { engine } = await storyWithVectors();
    const q = "双休那两天的聚餐";
    const base = await engine.rg.baseSearch(q, { limit: 20 });
    const rel = await relevantForQuestion(engine.rg, q, {}, base);
    expect(rel.vectorThreshold).not.toBeNull();
    expect(rel.supportedHitIds).toContain("ev-w1");
    expect(rel.gated.map((g) => g.claimId)).toContain(member(engine, WEEKEND_GROUP, "scene_autonomy").id);
  });

  // "A、B、C 组的回答（answerFromHits）也用同一个门槛"（评测的 answerFor）：326 号票起在评测包的 test/eval/answer-calibration.test.ts
});

describe("任务的建议附了追问：算有结论", () => {
  it("'帮我安排下周六'：有还拿不准的、附了追问，certain 照样是 true，不写缺什么", async () => {
    const { engine } = await storyEngine();
    const a = await engine.answer("帮我安排下周六");
    expect(a).toMatchObject({ kind: "task", route: "advice", certain: true, missing: [] });
    expect(a.advice!.question).not.toBeNull();
    expect(a.probes).toEqual([{ probeId: a.advice!.question!.probeId, ask: a.advice!.question!.ask }]);
    expect(byRole(a, "open")).toContain(member(engine, NEED, "no_interest").id);
  });
});

describe("明说的话优先：挑到的组还没分出胜负、但用户明说过相关的话时，以明说的为准", () => {
  it("周末社交案例前三条：几种解释还没分出来，但用户说过'最近周末想好好休息'——算有结论，引用那句原话，几种解释照样列出", async () => {
    const t = openEngine("2026-10-09T12:00:00+08:00");
    ingestWeekend(t.engine, ["ev-w01", "ev-w02", "ev-w03", "ev-u01"]);
    await t.engine.reflect();
    const a = await t.engine.answer("为什么我最近不想参加周末的聚会？", { context: ["weekend"] });
    expect(a).toMatchObject({ kind: "why", route: "reasoning", certain: true, missing: [] });
    expect(a.text).toMatch(/^以你说的为准：用户最近在周末、社交场合偏好休息［ev-w01］/);
    expect(a.text).toContain("原话「这周六的聚会我就不去了，最近周末想好好休息。」");
    expect(a.text).toContain("几种说得通的解释还没分出来");
    const stated = a.citations.filter((c) => c.role === "stated");
    expect(stated[0]!.evidenceIds).toEqual(["ev-w01"]);
    // 推断的几种解释照样列，但只是"还没分出来的"，不当结论
    expect(byRole(a, "conclusion")).toEqual([]);
    expect(byRole(a, "open")).toEqual(expect.arrayContaining([claimOf(t.engine, "scene_autonomy").id, claimOf(t.engine, "dislike_domain").id]));
  });

  it("没有明说的话：组没分出来就照旧说不确定，附能区分的追问", async () => {
    const t = openEngine("2026-10-09T12:00:00+08:00");
    const ws = { context: ["weekend", "social"] };
    t.engine.ingestEvidence(say("ev-1", "这周六的聚会我就不去了", "2026-09-26T10:00:00+08:00", ws));
    t.engine.ingestEvidence(say("ev-2", "推掉了周日的饭局", "2026-10-04T10:00:00+08:00", ws));
    t.engine.ingestEvidence(say("ev-3", "主动报名参加了周三晚上的技术交流会", "2026-10-07T19:30:00+08:00", { mode: "do", kind: "action", context: ["workday", "work"] }));
    await t.engine.reflect();
    expect(t.engine.rg.registry.listGroups().length).toBeGreaterThan(0);
    const a = await t.engine.answer("为什么我老推掉周末的局？", { context: ["weekend"] });
    expect(a).toMatchObject({ kind: "why", certain: false });
    expect(a.text).toMatch(/^不确定：/);
    expect(byRole(a, "stated")).toEqual([]);
    expect(a.probes.length).toBeGreaterThan(0);
  });
});
