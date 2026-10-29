// 202 号票：回答层——问题分流、相关门槛、D 组只在真命中假设时才加证据、检索和推理两条路都能说不确定、接上 196 号票的用户模型检索。
// 例子都是自己写的（test/rg/task-helpers.ts 的"推掉别人排好的活动"、周末社交案例，和这里现写的几条），不看 fixtures/truth。
import { afterEach, describe, expect, it } from "vitest";
import { FakeEmbedder } from "../../src/embedding/fake.ts";
import type { Hit } from "../../src/retrieval/types.ts";
import { GENERIC_PROBE, MISSING, SELF_PROBE } from "../../src/rg/answer.ts";
import { classifyQuestion, stripFrame, topicTerms } from "../../src/rg/question.ts";
import { DEFAULT_RELEVANCE_GATE, gateClaims, hitSupported, resolveGate } from "../../src/rg/relevance.ts";
import type { Answer } from "../../src/rg/types.ts";
import type { RelevantUserModel, RouteTrace } from "../../src/rg/value-retrieval.ts";
import { claimOf, closeEngines, ingestWeekend, openEngine, say } from "./helpers.ts";
import { member, NEED, NOW, statedOf, storyEngine, VALUE, WEEKEND_GROUP, WORKDAY_GROUP } from "./task-helpers.ts";

afterEach(closeEngines);

const byRole = (a: Answer, role: string) => a.citations.filter((c) => c.role === role).map((c) => c.claimId);

/** 手搭一个 relevantUserModel 的结果（只要 fused 和 traces） */
const model = (traces: Record<string, RouteTrace[]>): RelevantUserModel =>
  ({ fused: Object.keys(traces), traces, routes: { upward: [], index: [], domain: [] } }) as unknown as RelevantUserModel;
const hit = (id: string, channels: Hit["channels"] = { evidence_keyword: { rank: 1, score: 1 } }): Hit => ({ evidenceId: id, sourceLevel: "self", channels, fused: 0, via: { factIds: [], probeIds: [] } });
/** 手搭的检索结果里只有 e1 不挨着问题 */
const notE1 = (h: Hit) => h.evidenceId !== "e1";

/** 带假向量的"推掉别人排好的活动"：向量那一路总会给满结果，才看得出门槛挡没挡住 */
async function storyWithVectors() {
  const t = await storyEngine({ embedder: new FakeEmbedder() });
  await t.engine.indexVectors();
  return t;
}

describe("问题分流（规则版：句式和关键词）", () => {
  it("事实回忆、关于自己的判断、为什么、任务和建议", () => {
    for (const q of ["10月3日参加了什么", "上周六在哪吃的饭", "我跟谁去的杭州", "周二的分享会", "那阵子还夜跑吗"]) expect({ q, kind: classifyQuestion(q) }).toEqual({ q, kind: "recall" });
    for (const q of ["我是不是特别看重自主安排", "我到底喜不喜欢爬山", "我是什么样的人", "我喜欢夜跑吗", "我更愿意在家办公还是去公司"]) expect({ q, kind: classifyQuestion(q) }).toEqual({ q, kind: "self" });
    for (const q of ["为什么我老推周末的局", "是不是因为太累了才不去", "我老推掉这些局，图啥"]) expect({ q, kind: classifyQuestion(q) }).toEqual({ q, kind: "why" });
    for (const q of ["帮我安排下周六", "下周六帮我排满，从早到晚都安排上", "替我约个时间", "给我推荐个周末去处"]) expect({ q, kind: classifyQuestion(q) }).toEqual({ q, kind: "task" });
  });

  it("问法里的词不算话题：'我是不是喜欢夜跑'的话题词只有夜跑那几个", () => {
    expect(stripFrame("我是不是特别看重自主安排").replace(/\s+/g, "")).toBe("我自主安排");
    expect(topicTerms("我是不是喜欢夜跑")).toEqual(["夜跑"]);
    expect(topicTerms("为什么我不想去聚餐？")).toContain("聚餐");
    expect(topicTerms("我是不是特别看重自主安排")).toEqual(expect.arrayContaining(["自主安", "主安排", "自主", "安排"]));
    expect(topicTerms("我是不是特别看重自主安排")).not.toContain("看重");
  });

  it("各走各的：事实回忆只走检索；关于自己的、为什么查用户模型和推理图谱；任务走 adviseTask", async () => {
    const { engine } = await storyEngine();
    const recall = await engine.answer("周二的分享会");
    expect(recall).toMatchObject({ kind: "recall", route: "retrieval", certain: true });
    expect(recall.citations.flatMap((c) => c.evidenceIds)).toContain("ev-d1");
    expect(recall.citations.every((c) => c.claimId === null)).toBe(true);

    const self = await engine.answer("我是不是特别看重自主安排？");
    expect(self).toMatchObject({ kind: "self", route: "reasoning", certain: true, missing: [] });

    const why = await engine.answer("为什么我老推掉周末的饭局？");
    expect(why).toMatchObject({ kind: "why", route: "reasoning" });

    const task = await engine.answer("帮我安排下周六");
    expect(task).toMatchObject({ kind: "task", route: "advice" });
    expect(task.advice!.explicit.requirements).toEqual(["帮我安排下周六"]);
    expect(task.text).toBe(task.advice!.text);
    // 引用按建议的各层记角色：忌口、你说过的是 stated，推断的需求是 conclusion，还拿不准的是 open
    expect(byRole(task, "stated")).toEqual(expect.arrayContaining([statedOf(engine, "ev-a1", "dislikes").id, statedOf(engine, "ev-w3", "dislikes").id]));
    expect(byRole(task, "conclusion")).toContain(member(engine, NEED, "need_autonomy").id);
    expect(byRole(task, "open")).toContain(member(engine, NEED, "no_interest").id);
  });
});

describe("接上 196 号票的用户模型检索：关于自己的判断、为什么也说需求和价值观", () => {
  it("'我是不是特别看重自主安排'：结论索引找到价值观和两个场合的偏好，当结论说（推断的、带置信度和证据）；只是同一方面的只当背景", async () => {
    const { engine } = await storyEngine();
    const value = member(engine, VALUE, "value_enduring");
    const a = await engine.answer("我是不是特别看重自主安排？");
    expect(a.certain).toBe(true);
    expect(byRole(a, "conclusion")).toEqual(expect.arrayContaining([value.id, member(engine, WEEKEND_GROUP, "scene_autonomy").id, member(engine, WORKDAY_GROUP, "scene_autonomy").id]));
    expect(a.text).toMatch(/相关的价值观（推断的，置信 medium）：用户长期看重自主安排自己的时间.*［/);
    const valueCite = a.citations.find((c) => c.claimId === value.id)!;
    expect(valueCite.evidenceIds.toSorted()).toEqual(["ev-d1", "ev-d2", "ev-d3", "ev-w1", "ev-w2", "ev-w3", "ev-w4"]);
    // 明说的"不喜欢被提前排满"只是领域对上（时间安排），列成同一方面的背景，不当结论
    const stated = statedOf(engine, "ev-w3", "dislikes").id;
    expect(byRole(a, "open")).toContain(stated);
    expect(byRole(a, "stated")).not.toContain(stated);
    expect(a.text).toContain("同一方面还有（不一定和这个问题直接相关）：用户在周末不喜欢被提前排满");
  });

  it("'为什么我老推掉周末的饭局'：比较可能的解释是'重视周末的自主安排'，往上的需求一起说", async () => {
    const { engine } = await storyEngine();
    const a = await engine.answer("为什么我老推掉周末的饭局？");
    expect(a.certain).toBe(true);
    const conclusions = byRole(a, "conclusion");
    expect(conclusions[0]).toBe(member(engine, WEEKEND_GROUP, "scene_autonomy").id);
    expect(conclusions).toContain(member(engine, NEED, "need_autonomy").id);
    expect(a.text).toMatch(/^比较可能的解释（推断的，置信 medium）：用户重视周末的自主安排/);
    expect(a.text).toMatch(/相关的需求（推断的，置信 medium）：用户重视自主安排/);
    // 工作日那组和这个问题不沾边，不拿来答
    expect(a.citations.map((c) => c.claimId)).not.toContain(member(engine, WORKDAY_GROUP, "scene_autonomy").id);
  });
});

describe("相关门槛：三条路里至少一条命中、名次在前几名；对不上就当没有", () => {
  it("gateClaims：往上走看挂着它的检索结果排第几（只算挨着问题的）；结论索引要话题词或向量、同分并列；领域按名次；路、名次都能配", () => {
    const base = ["e1", "e2", "e3", "e4", "e5", "e6", "e7"].map((id) => hit(id));
    const m = model({
      // 挂在第 2 条（挨着）、第 5 条上的都过，不管这条路里有几条断言；只挂在第 1 条（不挨着）上的不过
      a: [{ route: "upward", rank: 1, score: 1, hitEvidenceIds: ["e1", "e2"] }],
      b: [{ route: "upward", rank: 2, score: 0.5, hitEvidenceIds: ["e2"] }],
      c: [{ route: "upward", rank: 3, score: 0.2, hitEvidenceIds: ["e5"] }],
      d: [{ route: "upward", rank: 4, score: 1, hitEvidenceIds: ["e1"] }],
      // 只挂在第 6 条上：检索的名次不在前 5
      e: [{ route: "upward", rank: 5, score: 1 / 6, hitEvidenceIds: ["e6"] }],
      // 结论索引：陈述里有话题词的过；只靠"喜欢"这类问法的词对上的不过；向量找到的、余弦超过门槛（这里给 0.5）的过
      f: [{ route: "index", rank: 1, score: 0.03, channels: { keyword: { rank: 1, score: 2 } } }],
      g: [{ route: "index", rank: 2, score: 0.02, channels: { keyword: { rank: 2, score: 1 } } }],
      h: [{ route: "index", rank: 3, score: 0.01, channels: { vector: { rank: 1, score: 0.6 } } }],
      // 领域：名次到 3 的过，第 4 名不过；只有领域命中的不算"直接说到"
      i: [{ route: "domain", rank: 3, score: 1, domains: ["schedule"] }],
      j: [{ route: "domain", rank: 4, score: 1, domains: ["schedule"] }],
    });
    const statements: Record<string, string> = { f: "用户重视夜跑", g: "用户喜欢热闹", h: "用户周末爱运动" };
    const gated = gateClaims(m, base, notE1, ["夜跑"], (id) => statements[id] ?? "", DEFAULT_RELEVANCE_GATE, 0.5);
    expect(gated.map((g) => g.claimId)).toEqual(["a", "b", "c", "f", "h", "i"]);
    expect(gated.find((g) => g.claimId === "a")!.via).toEqual([{ route: "upward", rank: 2 }]);
    expect(gated.find((g) => g.claimId === "c")!.via).toEqual([{ route: "upward", rank: 5 }]);
    expect(gated.find((g) => g.claimId === "i")!.direct).toBe(false);
    expect(gated.filter((g) => g.claimId !== "i").every((g) => g.direct)).toBe(true);
    // 能配：只走结论索引；名次只要第 1；往上走看检索前 6 条
    const onlyIndex = gateClaims(m, base, notE1, ["夜跑"], (id) => statements[id] ?? "", resolveGate({ routes: ["index"], topN: 1 }), 0.5);
    expect(onlyIndex.map((g) => g.claimId)).toEqual(["f"]);
    const deeper = gateClaims(m, base, notE1, ["夜跑"], (id) => statements[id] ?? "", resolveGate({ routes: ["upward"], hitRank: 6 }));
    expect(deeper.map((g) => g.claimId)).toEqual(["a", "b", "c", "e"]);
    const shallow = gateClaims(m, base, notE1, ["夜跑"], (id) => statements[id] ?? "", resolveGate({ routes: ["upward"], hitRank: 2 }));
    expect(shallow.map((g) => g.claimId)).toEqual(["a", "b"]);
  });

  it("hitSupported：检索结果要有话题词、或者事实图谱那一路带来的、或者余弦超过门槛（205 号票起按背景语料校准，这里直接给）才算挨着问题", async () => {
    const { engine } = await storyEngine();
    const view = engine.rg.view();
    expect(hitSupported(hit("ev-w1", { evidence_vector: { rank: 1, score: 0.2 } }), ["饭局"], view, 0.5)).toBe(true);
    expect(hitSupported(hit("ev-w1", { evidence_vector: { rank: 1, score: 0.2 } }), ["夜跑"], view, 0.5)).toBe(false);
    expect(hitSupported(hit("ev-w1", { evidence_vector: { rank: 1, score: 0.55 } }), ["夜跑"], view, 0.5)).toBe(true);
    expect(hitSupported(hit("ev-w1", { graph: { rank: 1, score: 1 } }), [], view, null)).toBe(true);
    // 精炼陈述里有也算（"拒绝了周六的饭局"这类陈述）
    expect(hitSupported(hit("ev-w2", { fact_vector: { rank: 1, score: 0.1 } }), ["剧本杀"], view, 0.5)).toBe(true);
  });

  it("和问题无关的假设挡在外面：'我是不是喜欢夜跑'只在'喜欢'这个问法的词上对上了原话和断言，不拿它们来答，明说不确定、说缺什么", async () => {
    const { engine } = await storyEngine();
    // 检索按"喜欢"找到了"我不喜欢周末被排得满满的"这几条，但它们和夜跑不挨着
    const c = await engine.search("我是不是喜欢夜跑？", { mode: "hybrid_kg", limit: 5 });
    expect(c.map((h) => h.evidenceId)).toContain("ev-w3");
    const a = await engine.answer("我是不是喜欢夜跑？");
    expect(a).toMatchObject({ kind: "self", route: "reasoning", certain: false });
    expect(a.text).toMatch(/^不确定：证据不够/);
    expect(byRole(a, "conclusion")).toEqual([]);
    expect(byRole(a, "stated")).toEqual([]);
    expect(a.text).not.toContain("自主安排");
    expect(a.missing).toEqual([MISSING.ownView, MISSING.repeated]);
    expect(a.probes).toEqual([{ probeId: null, ask: SELF_PROBE }]);
  });

  it("门槛能配：在引擎上配（relevanceGate），也能一次一配（answer 的 gate）", async () => {
    const { engine } = await storyEngine({ relevanceGate: { topN: 0 } });
    const a = await engine.answer("我是不是特别看重自主安排？");
    expect(a.certain).toBe(false);
    expect(byRole(a, "conclusion")).toEqual([]);
    const b = await engine.answer("我是不是特别看重自主安排？", { gate: { topN: 3 } });
    expect(b.certain).toBe(true);
  });
});

describe("D 组检索：只在问题真的命中某个假设时才加它的证据", () => {
  it("没命中时和 C 组一模一样（同样的条数、顺序、分数）：只在问法的词上对上、只是领域对上（同一方面）都不算命中", async () => {
    const plain = (await storyEngine()).engine;
    const vectors = (await storyWithVectors()).engine;
    for (const [engine, q] of [
      [plain, "我是不是喜欢夜跑？"],
      [vectors, "出差住的酒店"],
    ] as const) {
      const c = await engine.search(q, { mode: "hybrid_kg", limit: 10 });
      const d = await engine.search(q, { mode: "hybrid_kg_rg", limit: 10 });
      expect(c.length).toBeGreaterThan(0);
      expect(d.map((h) => [h.evidenceId, h.fused])).toEqual(c.map((h) => [h.evidenceId, h.fused]));
      expect(d.every((h) => h.channels.probe === undefined)).toBe(true);
    }
    // "出差住的酒店"领域对上了工作日那组（工作发展），但那只是同一方面
    const rel = await vectors.relevantUserModel("出差住的酒店");
    expect(rel.domains).toEqual(["career", "travel"]);
    expect(rel.routes.domain.length).toBeGreaterThan(0);
  });

  it("命中了：'周末的饭局'过了门槛，带上'重视周末的自主安排'那组的支持证据，记在 probe 这一路、经过哪条假设", async () => {
    const { engine } = await storyWithVectors();
    const d = await engine.search("周末的饭局", { mode: "hybrid_kg_rg", limit: 10 });
    const weekend = member(engine, WEEKEND_GROUP, "scene_autonomy").id;
    const viaWeekend = d.filter((h) => (h as { via: { claimIds?: string[] } }).via.claimIds?.includes(weekend));
    expect(viaWeekend.length).toBeGreaterThan(0);
    expect(viaWeekend.every((h) => h.channels.probe !== undefined)).toBe(true);
  });
});

describe("检索那条路能说不确定", () => {
  it("前几条都和问题不挨着（没有话题词、余弦不到 0.5）：明说不确定、说缺什么，不把凑数的记录当答案", async () => {
    const { engine } = await storyWithVectors();
    const a = await engine.answer("上个月在杭州吃了什么");
    expect(a).toMatchObject({ kind: "recall", route: "retrieval", certain: false, citations: [] });
    expect(a.hits.length).toBeGreaterThan(0);
    expect(a.text).toMatch(/^不确定：没找到和这个问题直接相关的记录/);
    expect(a.missing).toEqual([MISSING.record]);
  });

  it("说到的事实之间真冲突（同时间同场景互相排斥）：明说不确定，两边都列出来、带证据，给能区分的问题", async () => {
    const { engine } = openEngine("2026-10-20T12:00:00+08:00");
    engine.ingestEvidence(say("ev-c1", "我喜欢爬山", "2026-10-11T10:00:00+08:00", { context: ["weekend"] }));
    engine.ingestEvidence(say("ev-c2", "我不喜欢爬山", "2026-10-11T10:00:00+08:00", { context: ["weekend"] }));
    await engine.reflect();
    const contested = engine.store.listFacts({ status: ["contested"] });
    expect(contested).toHaveLength(2);
    const a = await engine.answer("周末爬山");
    expect(a).toMatchObject({ kind: "recall", route: "retrieval", certain: false });
    expect(a.text).toMatch(/^不确定：记录之间互相矛盾/);
    expect(a.citations.filter((c) => c.role === "open").flatMap((c) => c.evidenceIds).toSorted()).toEqual(["ev-c1", "ev-c2"]);
    expect(a.missing).toEqual([MISSING.resolve]);
    expect(a.probes).toHaveLength(1);
  });

  it("只有别人说的：不当依据，说缺本人的记录", async () => {
    const { engine } = openEngine("2026-10-20T12:00:00+08:00");
    engine.ingestEvidence(say("ev-h1", "听说他周末老去钓鱼", "2026-10-11T10:00:00+08:00", { sourceLevel: "untrusted" }));
    await engine.reflect();
    const a = await engine.answer("周末钓鱼");
    expect(a.certain).toBe(false);
    expect(a.text).toMatch(/只有别人说的（不当依据）：ev-h1/);
    expect(a.missing).toEqual([MISSING.ownRecord]);
  });
});

describe("推理那条路能说不确定", () => {
  it("只有还拿不准的竞争假设、用户也没明说过相关的话：明说不确定，列几种可能，附能区分的追问，说缺什么", async () => {
    // 周末社交案例前三条去掉"最近周末想好好休息"那半句（205 号票起，明说过相关的话就以明说的为准）
    const t = openEngine("2026-10-09T12:00:00+08:00");
    const ws = { context: ["weekend", "social"] };
    t.engine.ingestEvidence(say("ev-1", "这周六的聚会我就不去了", "2026-10-01T20:10:00+08:00", ws));
    t.engine.ingestEvidence(say("ev-2", "主动报名参加了周三晚上的技术交流会", "2026-10-03T19:30:00+08:00", { mode: "do", kind: "action", context: ["workday", "work", "social"] }));
    t.engine.ingestEvidence(say("ev-3", "推掉了朋友安排得很紧凑的周末活动", "2026-10-08T21:00:00+08:00", { mode: "do", kind: "action", ...ws }));
    await t.engine.reflect();
    const a = await t.engine.answer("为什么我最近不想参加周末的聚会？", { context: ["weekend"] });
    expect(a).toMatchObject({ kind: "why", route: "reasoning", certain: false });
    expect(a.text).toMatch(/^不确定：/);
    expect(byRole(a, "open")).toContain(claimOf(t.engine, "scene_autonomy").id);
    expect(byRole(a, "conclusion")).toEqual([]);
    expect(a.probes.length).toBeGreaterThan(0);
    expect(a.probes.every((p) => p.probeId?.startsWith("pr-"))).toBe(true);
    expect(a.missing).toEqual([MISSING.distinguish]);
  });

  it("问为什么、什么都没过门槛：说证据不够，只列挨着问题的记录，给问最近一次的追问", async () => {
    const { engine } = openEngine("2026-10-20T12:00:00+08:00");
    engine.ingestEvidence(say("ev-4", "周六的聚餐我不去了", "2026-09-05T10:00:00+08:00", { context: ["weekend", "social"] }));
    engine.ingestEvidence(say("ev-5", "下午买了一盆绿萝", "2026-09-06T10:00:00+08:00"));
    await engine.reflect();
    const a = await engine.answer("为什么我不想去聚餐？");
    expect(a).toMatchObject({ kind: "why", certain: false });
    expect(a.text).toContain("［ev-4］");
    expect(a.text).not.toContain("ev-5");
    expect(a.probes).toEqual([{ probeId: null, ask: GENERIC_PROBE }]);
    expect(a.missing).toEqual([MISSING.repeated, MISSING.ownReason]);
  });
});

describe("明说的要求不被推翻", () => {
  it("'下周六帮我排满，从早到晚都安排上'走 adviseTask：要求排第一，'不要排满'这条做法这次不用，需求标'以你说的为准'", async () => {
    const t = await storyEngine();
    const [s] = t.engine.compileStrategies().strategies;
    t.engine.ingestEvidence(say("ev-ok", "对，以后周末别给我排满", NOW));
    t.engine.confirmStrategy(s!.id, "ev-ok");
    const a = await t.engine.answer("下周六帮我排满，从早到晚都安排上");
    expect(a).toMatchObject({ kind: "task", route: "advice" });
    expect(a.text.indexOf("「下周六帮我排满」")).toBeLessThan(a.text.indexOf("②"));
    expect(a.text).toContain("「留出空白，不要排满」这次不用");
    const need = a.advice!.motives.find((m) => m.claimId === member(t.engine, NEED, "need_autonomy").id)!;
    expect(need.overriddenBy).toBe("下周六帮我排满");
  });

  // 330 号票（R14）：随口说的不再自动算决定性——"不反感见朋友"只算一条强反证，"不喜欢社交"降成猜测、列在还没排除的，不再是已经排除的
  it("关于自己的判断：用户明说的'不反感见朋友'照说，'不喜欢社交'碰上它只是猜测（还没排除），不当结论", async () => {
    const t = openEngine("2026-10-09T12:00:00+08:00");
    ingestWeekend(t.engine, ["ev-w01", "ev-w02", "ev-w03", "ev-u01"]);
    await t.engine.reflect();
    t.setNow("2026-10-13T12:00:00+08:00");
    ingestWeekend(t.engine, ["ev-w04"]);
    await t.engine.reflect();
    const a = await t.engine.answer("我是不是不喜欢周末的聚会？", { context: ["weekend"] });
    expect(a.kind).toBe("self");
    const social = claimOf(t.engine, "dislike_domain").id;
    expect(byRole(a, "conclusion")).not.toContain(social);
    expect(byRole(a, "excluded")).not.toContain(social);
    expect(byRole(a, "open")).toContain(social);
    expect(a.text).toMatch(/还没完全排除：用户不喜欢社交/);
    expect(a.text).toContain("不反感见朋友");
  });
});
