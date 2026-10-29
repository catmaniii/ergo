// 198 号票：了解你问题——整理时生成（分不清的竞争假设 + 调研 11 的六个来源）、顺口问（pickQuestion）、回答回写（recordQuestionAnswer）、
// 跳过和"别问这个"。规则版，例子都是自己写的（周末社交案例的前三条，加上几条手写的话）。
import { afterEach, describe, expect, it } from "vitest";
import type { EvidenceDraft } from "../../src/domain/types.ts";
import type { MemoryEngine } from "../../src/engine.ts";
import { classifyAnswer, type QuestionView } from "../../src/rg/questions.ts";
import { answerSeparation, generateQuestions, leadingPhrases, type AnswerEffect } from "../../src/rg/question-sources.ts";
import { claimOf, closeEngines, explicitClaimOf, factOf, ingestWeekend, openEngine, say, type TestEngine } from "./helpers.ts";

afterEach(closeEngines);

const FIRST_THREE = ["ev-w01", "ev-w02", "ev-w03"];
const NIGHT1 = "2026-10-10T03:00:00+08:00";
const GROUP = "repeated_decline|weekend|social";
const WEEKEND_TALK = "这周六同学约我聚会，我还在想要不要去。";

/** 周末社交案例的前三条，第一夜（10-10 03:00）整理一次 */
async function firstNight(): Promise<TestEngine> {
  const t = openEngine("2026-10-09T22:00:00+08:00");
  ingestWeekend(t.engine, FIRST_THREE);
  t.setNow(NIGHT1);
  const r = await t.engine.runNightly({ userActive: false });
  expect(r.ran).toBe(true);
  return t;
}

/** 区分这两个模板的断言的那个问题 */
function questionBetween(engine: MemoryEngine, a: string, b: string): QuestionView {
  const ids = [claimOf(engine, a).id, claimOf(engine, b).id].toSorted();
  const q = engine.listQuestions().find((x) => x.kind === "unresolved" && x.targets.map((t) => t.id).toSorted().join() === ids.join());
  if (!q) throw new Error(`没有区分 ${a} 和 ${b} 的问题`);
  return q;
}

const answer = (id: string, text: string, at: string, over: Partial<EvidenceDraft> = {}) => say(id, text, at, over);

describe("生成：整理时出了解你问题", () => {
  it("追问以后还分不清的竞争假设出问题：'周末自主'和'近期太累'那一个写明区分谁、什么回答支持哪边、领域和场景、优先级、过期时间", async () => {
    const { engine } = await firstNight();
    const autonomy = claimOf(engine, "scene_autonomy");
    const tired = claimOf(engine, "recent_state");
    const q = questionBetween(engine, "scene_autonomy", "recent_state");
    expect(q.text).toBe("这阵子工作或者身体上是不是特别忙、特别累？");
    expect(q.sources).toContain("unresolved");
    expect(q.status).toBe("open");
    expect(q.topic).toBe(GROUP);
    expect(q.answers.yes).toMatchObject({ supports: [tired.id], refutes: [] });
    expect(q.answers.no).toMatchObject({ supports: [], refutes: [tired.id] });
    expect(q.why).toContain(autonomy.id);
    expect(q.why).toContain(tired.id);
    expect(q.why).toMatch(/分不清/);
    expect(q.domains).toEqual(expect.arrayContaining(["schedule", "social"]));
    expect(q.scenes).toContain("weekend");
    // 近期状态 14 天就过期（10-22），比默认的 30 天早：问题跟着它过期
    expect(q.expiresAt).toBe(tired.validTo);
    expect(q.priorityDetail.fresh).toBe(1);
    expect(q.priority).toBeGreaterThan(0);
  });

  it("每组追问各出一个问题；同一个问题再整理一次不重复建（按 key 去重）", async () => {
    const t = await firstNight();
    const before = t.engine.listQuestions();
    const probes = t.engine.rg.registry.probesOf(GROUP);
    expect(before.filter((q) => q.kind === "unresolved")).toHaveLength(probes.length);
    t.setNow("2026-10-11T03:00:00+08:00");
    await t.engine.runNightly({ userActive: false });
    const after = t.engine.listQuestions();
    expect(after.map((q) => q.id).toSorted()).toEqual(before.map((q) => q.id).toSorted());
    expect(new Set(after.map((q) => q.key)).size).toBe(after.length);
  });

  it("优先级 = 回答能不能分出胜负 × 分数接近的程度 × 近 30 天这类事多不多 × 还没问过（207）：两种回答都能分出胜负的'时间由你自己定，你会去吗'排第一，只能动一边的'是不是特别忙、特别累'排在后面，规范性判断（'要'只算弱的、'不要'不判）排最后", async () => {
    const { engine } = await firstNight();
    const queue = engine.listQuestions({ status: "open" });
    for (let i = 1; i < queue.length; i++) expect(queue[i - 1]!.priority).toBeGreaterThanOrEqual(queue[i]!.priority);
    for (const q of queue) {
      const d = q.priorityDetail;
      expect(q.priority).toBeCloseTo(d.separation * d.closeness * d.frequency * d.fresh, 2);
    }
    const own = questionBetween(engine, "scene_autonomy", "dislike_content");
    const busy = questionBetween(engine, "scene_autonomy", "recent_state");
    expect(own.priorityDetail.separation).toBe(1);
    expect(busy.priorityDetail.separation).toBe(0.5);
    expect(own.priorityDetail.closeness).toBe(busy.priorityDetail.closeness);
    expect(queue[0]!.id).toBe(own.id);
    expect(busy.priority).toBeLessThan(own.priority);
    const normative = queue.find((q) => q.kind === "normative")!;
    expect(normative.priorityDetail.separation).toBe(0.25);
    expect(queue.at(-1)!.id).toBe(normative.id);
  });

  it("措辞检查：生成的问题里没有'因为你……所以''你是不是因为'这类诱导，也不问为什么", async () => {
    const { engine } = await firstNight();
    for (const q of engine.listQuestions()) expect({ text: q.text, hits: leadingPhrases(q.text) }).toEqual({ text: q.text, hits: [] });
    expect(leadingPhrases("你是不是因为太累了才不去聚会？")).not.toEqual([]);
    expect(leadingPhrases("因为你周末想休息，所以不去聚会吧？")).not.toEqual([]);
    expect(leadingPhrases("你为什么不去聚会？")).not.toEqual([]);
    expect(leadingPhrases("其实你就是不喜欢社交，对吧？")).not.toEqual([]);
    expect(leadingPhrases("上次推掉的周末活动，要是时间由你自己定，你会去吗？")).toEqual([]);
  });

  it("措辞不过关的追问不出问题，记在丢掉的里面", async () => {
    const { engine } = await firstNight();
    const members = engine.rg.registry.members(GROUP);
    const probe = engine.store.insertProbe({
      discriminates: [members[1]!.claimId, members[2]!.claimId],
      ask: "你是不是因为太累了才不去聚会？",
      queries: ["聚会"],
      ifFound: members[2]!.claimId,
      outcome: "not_found",
      foundEvidenceIds: [],
    });
    engine.rg.registry.addProbe(probe.id, GROUP, "model:leading");
    const { drafts, dropped } = generateQuestions(engine.rg, NIGHT1);
    expect(drafts.some((d) => d.probeId === probe.id)).toBe(false);
    expect(dropped.some((x) => x.key === `probe:${probe.id}` && /诱导|措辞/.test(x.reason))).toBe(true);
  });

  it("规范性判断只能以问题出现：'近期太忙或太累'出一个'要不要我帮你少排一些'的问题，回答'要'只算弱的支持", async () => {
    const { engine } = await firstNight();
    const tired = claimOf(engine, "recent_state");
    const q = engine.listQuestions().find((x) => x.kind === "normative")!;
    expect(q.targets.map((t) => t.id)).toEqual([tired.id]);
    expect(q.text).toMatch(/要不要我/);
    expect(q.text).not.toMatch(/太忙|太累/);
    expect(q.answers.yes).toMatchObject({ supports: [tired.id], maxWeight: "weak" });
    expect(q.answers.no).toMatchObject({ supports: [], refutes: [] });
  });
});

const eff = (supports: string[], refutes: string[], maxWeight: AnswerEffect["maxWeight"] = "decisive", facts?: AnswerEffect["facts"]): AnswerEffect => ({ supports, refutes, maxWeight, note: "", ...(facts ? { facts } : {}) });

describe("回答能不能分出胜负（207）", () => {

  it("两条假设对这个回答的预期差得多不多：一边支持、一边反驳是 1；只动一边是 0.5；两种回答取平均", () => {
    expect(answerSeparation({ yes: eff(["a"], ["b"]), no: eff(["b"], ["a"]) }, ["a", "b"])).toBe(1);
    expect(answerSeparation({ yes: eff(["b"], []), no: eff([], ["b"]) }, ["a", "b"])).toBe(0.5);
    expect(answerSeparation({ yes: eff(["a"], ["b"]), no: eff(["b"], []) }, ["a", "b"])).toBe(0.75);
    expect(answerSeparation({ yes: eff([], []), no: eff([], []) }, ["a", "b"])).toBe(0);
  });

  it("只有一条的（和'它不对'比）：支持或反驳它是 1；最多只能记弱的减半；事实这一层定下来、到期也算", () => {
    expect(answerSeparation({ yes: eff(["a"], []), no: eff([], ["a"]) }, ["a"])).toBe(1);
    expect(answerSeparation({ yes: eff(["a"], [], "weak"), no: eff([], [], "weak") }, ["a"])).toBe(0.25);
    expect(answerSeparation({ yes: eff([], [], "decisive", { activate: ["f2"], supersede: ["f1"] }), no: eff([], [], "decisive", { activate: ["f1"], supersede: ["f2"] }) }, ["f1", "f2"])).toBe(1);
  });
});

describe("另外五个来源（调研 11 的六个来源，规范性判断见上）", () => {
  it("矛盾：同一天说喜欢又说不喜欢爬山 → 问现在是哪个；回答得很明确，事实这一层马上定下来", async () => {
    const t = openEngine("2026-10-01T22:00:00+08:00");
    t.engine.ingestEvidence(say("ev-c1", "我喜欢爬山。", "2026-10-01T10:00:00+08:00"));
    t.engine.ingestEvidence(say("ev-c2", "我不喜欢爬山。", "2026-10-01T18:00:00+08:00"));
    t.setNow("2026-10-02T03:00:00+08:00");
    await t.engine.runNightly({ userActive: false });
    const likes = factOf(t.engine, "ev-c1", "prefers", "爬山");
    const dislikes = factOf(t.engine, "ev-c2", "dislikes", "爬山");
    expect([likes.status, dislikes.status]).toEqual(["contested", "contested"]);
    const q = t.engine.listQuestions().find((x) => x.kind === "contradiction")!;
    expect(q.text).toContain("喜欢爬山");
    expect(q.text).toContain("不喜欢爬山");
    expect(q.topic).toBe(`object:${(likes.object as { id: string }).id}`);
    t.setNow("2026-10-02T20:00:00+08:00");
    const r = t.engine.recordQuestionAnswer(q.id, answer("ev-c3", "对，确实不喜欢。", "2026-10-02T20:00:00+08:00"));
    expect(r).toMatchObject({ verdict: "yes", clear: true, applied: "now" });
    expect(t.engine.getFact(dislikes.id)!.status).toBe("active");
    expect(t.engine.getFact(likes.id)!.status).toBe("superseded");
    expect(explicitClaimOf(t.engine, dislikes).status).toBe("active");
    expect(explicitClaimOf(t.engine, likes).status).toBe("superseded");
  });

  it("张力：说过喜欢周末徒步，后来推掉了周六的徒步 → 问下次还想不想去", async () => {
    const t = openEngine("2026-10-05T22:00:00+08:00");
    t.engine.ingestEvidence(say("ev-t1", "我喜欢徒步。", "2026-10-01T10:00:00+08:00", { context: ["weekend"] }));
    t.engine.ingestEvidence(say("ev-t2", "推掉了周六的徒步。", "2026-10-05T10:00:00+08:00", { mode: "do", kind: "action", context: ["weekend", "social"] }));
    t.setNow("2026-10-06T03:00:00+08:00");
    await t.engine.runNightly({ userActive: false });
    const stated = explicitClaimOf(t.engine, factOf(t.engine, "ev-t1", "prefers", "徒步"));
    const q = t.engine.listQuestions().find((x) => x.kind === "tension")!;
    expect(q.text).toContain("徒步");
    expect(q.answers.yes.supports).toEqual([stated.id]);
    expect(q.answers.no.refutes).toEqual([stated.id]);
    expect(q.why).toMatch(/说的和做的/);
  });

  it("预测落空：'周末自主'成立以后，用户又去了朋友安排的周六郊游 → 问以后还会不会这样", async () => {
    const t = openEngine("2026-10-09T22:00:00+08:00");
    ingestWeekend(t.engine, [...FIRST_THREE, "ev-w04"]);
    t.setNow("2026-10-13T03:00:00+08:00");
    await t.engine.runNightly({ userActive: false });
    const autonomy = claimOf(t.engine, "scene_autonomy");
    expect(autonomy.status).toBe("active");
    t.setNow("2026-10-17T22:00:00+08:00");
    t.engine.ingestEvidence(say("ev-p1", "参加了朋友安排的周六郊游。", "2026-10-17T10:00:00+08:00", { mode: "do", kind: "action", context: ["weekend", "social"] }));
    t.setNow("2026-10-18T03:00:00+08:00");
    await t.engine.runNightly({ userActive: false });
    const q = t.engine.listQuestions().find((x) => x.kind === "prediction_violation" && x.targets.some((g) => g.id === autonomy.id))!;
    expect(q).toBeDefined();
    expect(q.text).toContain("郊游");
    expect(q.answers.yes.refutes).toEqual([autonomy.id]);
    expect(q.answers.no.supports).toEqual([autonomy.id]);
  });

  it("334：前几天说喜欢看电影，今天没头没尾地说不喜欢 → 当矛盾（两条都拿不准），问'现在更接近后一种吗'；答'不是'就是先说的那句", async () => {
    const t = openEngine("2026-10-05T22:00:00+08:00");
    t.engine.ingestEvidence(say("ev-o1", "我喜欢看电影。", "2026-10-01T10:00:00+08:00"));
    t.engine.ingestEvidence(say("ev-o2", "我不喜欢看电影。", "2026-10-05T10:00:00+08:00"));
    t.setNow("2026-10-06T03:00:00+08:00");
    await t.engine.runNightly({ userActive: false });
    const old = factOf(t.engine, "ev-o1", "prefers", "看电影");
    const flip = factOf(t.engine, "ev-o2", "dislikes", "看电影");
    expect([old.status, flip.status]).toEqual(["contested", "contested"]);
    expect(t.engine.listQuestions().filter((x) => x.kind === "out_of_character")).toEqual([]);
    const q = t.engine.listQuestions().find((x) => x.kind === "contradiction")!;
    expect(q.text).toBe('关于看电影：你10 月 1 日说过"喜欢看电影"，10 月 5 日又说"不喜欢看电影"。现在更接近后一种吗？');
    t.setNow("2026-10-06T20:00:00+08:00");
    const r = t.engine.recordQuestionAnswer(q.id, answer("ev-o3", "根本不是。", "2026-10-06T20:00:00+08:00"));
    expect(r).toMatchObject({ verdict: "no", clear: true, applied: "now" });
    expect(t.engine.getFact(old.id)!.status).toBe("active");
    expect(t.engine.getFact(flip.id)!.status).toBe("superseded");
  });

  it("反常输入（老库里 334 以前按日子先后接上的）：先问一句；明确说'不是'就当纠正，旧的那条恢复", async () => {
    const t = openEngine("2026-10-05T22:00:00+08:00");
    t.engine.ingestEvidence(say("ev-o1", "我喜欢看电影。", "2026-10-01T10:00:00+08:00"));
    t.engine.ingestEvidence(say("ev-o2", "我不喜欢看电影。", "2026-10-05T10:00:00+08:00"));
    t.setNow("2026-10-06T03:00:00+08:00");
    await t.engine.runNightly({ userActive: false });
    const old = factOf(t.engine, "ev-o1", "prefers", "看电影");
    const flip = factOf(t.engine, "ev-o2", "dislikes", "看电影");
    // 摆成 334 以前的样子：后说的接上、先说的到期被取代
    const cause = { reason: "测试：摆成 334 以前按日子先后接上的样子" };
    t.engine.store.updateFact(flip.id, { status: "active", contestedWith: [] }, cause);
    t.engine.store.updateFact(old.id, { status: "active", contestedWith: [] }, cause);
    t.engine.store.updateFact(old.id, { status: "superseded", supersededBy: flip.id, validTo: flip.validFrom }, cause);
    t.setNow("2026-10-07T03:00:00+08:00");
    await t.engine.reflect();
    await t.engine.runNightly({ userActive: false });
    const q = t.engine.listQuestions().find((x) => x.kind === "out_of_character")!;
    expect(q.text).toContain("不喜欢看电影");
    t.setNow("2026-10-07T20:00:00+08:00");
    const r = t.engine.recordQuestionAnswer(q.id, answer("ev-o3", "根本不是，记错了。", "2026-10-07T20:00:00+08:00"));
    expect(r).toMatchObject({ verdict: "no", clear: true, applied: "now" });
    expect(t.engine.getFact(flip.id)!.status).toBe("corrected");
    expect(t.engine.getFact(old.id)!.status).toBe("active");
  });

  it("低置信但高价值：一条假设算成立、把握却还低（竞争的都排除了）→ 出确认的问题，回答只动它自己", async () => {
    const t = await firstNight();
    const autonomy = claimOf(t.engine, "scene_autonomy");
    const cause = { reason: "测试：手工摆成'成立但把握低'" };
    for (const m of t.engine.rg.registry.members(GROUP)) {
      if (m.claimId !== autonomy.id) t.engine.store.updateClaim(m.claimId, { status: "retracted", retractedBy: "ev-w02" }, cause);
    }
    t.engine.store.updateClaim(autonomy.id, { status: "active", confidence: "low" }, cause);
    const { drafts } = generateQuestions(t.engine.rg, NIGHT1);
    const confirm = drafts.filter((d) => d.sources.includes("low_confidence_high_value"));
    expect(confirm.length).toBeGreaterThan(0);
    for (const d of confirm) {
      expect(d.targets.map((x) => x.id)).toEqual([autonomy.id]);
      expect([...d.answers.yes.supports, ...d.answers.yes.refutes, ...d.answers.no.supports, ...d.answers.no.refutes].every((id) => id === autonomy.id)).toBe(true);
    }
  });
});

describe("顺口问：pickQuestion", () => {
  it("话题对得上、不是急事、今天还没问过 → 回话末尾带一句，写明理由；问的是优先级最高的那个", async () => {
    const t = await firstNight();
    t.setNow("2026-10-10T20:00:00+08:00");
    const r = t.engine.pickQuestion(WEEKEND_TALK);
    expect(r.ask).toBe(true);
    const q = questionBetween(t.engine, "scene_autonomy", "dislike_content");
    expect(r.question!.id).toBe(q.id);
    expect(r.text).toContain(q.text);
    expect(r.text).toMatch(/不想答可以跳过/);
    expect(r.detail).toMatch(/时间安排|社交/);
    expect(t.engine.listQuestions().find((x) => x.id === q.id)!.status).toBe("asked");
  });

  it("每天最多 1 个：同一天再聊到周末也不问；第二天可以再问", async () => {
    const t = await firstNight();
    t.setNow("2026-10-10T20:00:00+08:00");
    expect(t.engine.pickQuestion(WEEKEND_TALK).ask).toBe(true);
    t.setNow("2026-10-10T23:30:00+08:00");
    const again = t.engine.pickQuestion("周日要不要约朋友去爬山？");
    expect(again).toMatchObject({ ask: false, reason: "asked_today" });
    t.setNow("2026-10-11T20:00:00+08:00");
    expect(t.engine.pickQuestion(WEEKEND_TALK).ask).toBe(true);
  });

  it("话题对不上不问，留在问题箱：查天气；聊的是工作日的事（场景对不上）", async () => {
    const t = await firstNight();
    t.setNow("2026-10-10T09:00:00+08:00");
    expect(t.engine.pickQuestion("帮我查一下明天上海的天气。")).toMatchObject({ ask: false, reason: "no_match" });
    expect(t.engine.pickQuestion("下周三的项目评审怎么准备？")).toMatchObject({ ask: false, reason: "no_match" });
    expect(t.engine.listQuestions({ status: "open" }).length).toBeGreaterThan(0);
    expect(t.engine.listQuestions({ status: "asked" })).toEqual([]);
  });

  it("急事不问、在等用户做决定时不问", async () => {
    const t = await firstNight();
    t.setNow("2026-10-10T12:00:00+08:00");
    expect(t.engine.pickQuestion("会议提前了，赶紧帮我把周六的安排改一下！")).toMatchObject({ ask: false, reason: "urgent" });
    expect(t.engine.pickQuestion(WEEKEND_TALK, { urgent: true })).toMatchObject({ ask: false, reason: "urgent" });
    expect(t.engine.pickQuestion(WEEKEND_TALK, { awaitingDecision: true })).toMatchObject({ ask: false, reason: "awaiting_decision" });
    expect(t.engine.listQuestions({ status: "asked" })).toEqual([]);
  });

  it("同一个问题跳过 2 次就不再问，记一条回避信号（系统观察到的，不当推断的依据）", async () => {
    const t = await firstNight();
    const asked = new Map<string, number>();
    for (let day = 10; day <= 21; day++) {
      t.setNow(`2026-10-${day}T20:00:00+08:00`);
      const r = t.engine.pickQuestion(WEEKEND_TALK);
      if (!r.ask) continue;
      asked.set(r.question!.id, (asked.get(r.question!.id) ?? 0) + 1);
      t.engine.recordQuestionSkipped(r.question!.id);
    }
    expect(asked.size).toBeGreaterThan(1);
    for (const n of asked.values()) expect(n).toBe(2);
    const retired = t.engine.listQuestions({ status: "retired" });
    expect(retired.map((q) => q.id).toSorted()).toEqual([...asked.keys()].toSorted());
    const signals = t.engine.store.listEvidence({ sourceLevel: "system" }).filter((e) => e.context.includes("avoidance"));
    expect(signals).toHaveLength(retired.length);
    for (const s of signals) expect(s).toMatchObject({ mode: "do", kind: "action" });
    // 都退下了：问题箱里没有能问的
    t.setNow("2026-10-22T09:00:00+08:00");
    expect(t.engine.pickQuestion(WEEKEND_TALK).ask).toBe(false);
  });

  it("问了没回、到第二天还没回答，算跳过一次", async () => {
    const t = await firstNight();
    t.setNow("2026-10-10T20:00:00+08:00");
    const r = t.engine.pickQuestion(WEEKEND_TALK);
    t.setNow("2026-10-11T09:00:00+08:00");
    t.engine.pickQuestion("帮我查一下明天上海的天气。");
    expect(t.engine.listQuestions().find((q) => q.id === r.question!.id)).toMatchObject({ status: "open", skippedCount: 1 });
  });

  it("'别问这个'：这一类（同一组假设）都不再问，下一夜也不再生成；别的组照样问", async () => {
    const t = openEngine("2026-10-09T22:00:00+08:00");
    ingestWeekend(t.engine, FIRST_THREE);
    t.engine.ingestEvidence(say("ev-k1", "周三晚上的加班我就不去了。", "2026-10-07T10:00:00+08:00", { context: ["workday", "work"] }));
    t.engine.ingestEvidence(say("ev-k2", "推掉了周四的团建。", "2026-10-08T10:00:00+08:00", { mode: "do", kind: "action", context: ["workday", "work"] }));
    t.setNow(NIGHT1);
    await t.engine.runNightly({ userActive: false });
    t.setNow("2026-10-10T20:00:00+08:00");
    const r = t.engine.pickQuestion(WEEKEND_TALK);
    expect(r.question!.topic).toBe(GROUP);
    const declined = t.engine.declineQuestion(r.question!.id);
    expect(declined.status).toBe("declined");
    expect(t.engine.listQuestions({ status: ["open", "asked"] }).filter((q) => q.topic === GROUP)).toEqual([]);
    t.setNow("2026-10-11T03:00:00+08:00");
    await t.engine.runNightly({ userActive: false });
    expect(t.engine.listQuestions({ status: ["open", "asked"] }).filter((q) => q.topic === GROUP)).toEqual([]);
    t.setNow("2026-10-11T20:00:00+08:00");
    expect(t.engine.pickQuestion(WEEKEND_TALK).ask).toBe(false);
    const work = t.engine.pickQuestion("下周三公司的团建要不要去？");
    expect(work.ask).toBe(true);
    expect(work.question!.topic).toBe("repeated_decline|workday|work");
  });
});

/** 第一夜以后，第二天晚上"近期太累"那一个（207 起它不是优先级最高的，直接拿它来答） */
async function askedTired() {
  const t = await firstNight();
  t.setNow("2026-10-10T20:00:00+08:00");
  return { ...t, q: questionBetween(t.engine, "scene_autonomy", "recent_state") };
}

describe("回答回写：recordQuestionAnswer", () => {

  it("回答得很明确（'对，确实特别忙'）：马上标'你确认过'，这一组重新定状态", async () => {
    const t = await askedTired();
    const tired = claimOf(t.engine, "recent_state");
    expect(tired.status).toBe("contested");
    const r = t.engine.recordQuestionAnswer(t.q.id, answer("ev-a1", "对，确实特别忙。", "2026-10-10T20:05:00+08:00"));
    expect(r).toMatchObject({ verdict: "yes", clear: true, applied: "now" });
    const now = t.engine.store.getClaim(tired.id)!;
    expect(now).toMatchObject({ epistemic: "user_confirmed", status: "active" });
    expect(t.engine.store.linksOf(tired.id).some((l) => l.target === "ev-a1" && l.polarity === "supports" && l.weight === "decisive")).toBe(true);
    expect(t.engine.listQuestions().find((x) => x.id === t.q.id)).toMatchObject({ status: "resolved", answerEvidenceId: "ev-a1", verdict: "yes" });
    expect(r.question.outcome).toContain(tired.id);
  });

  it("回答得很明确（'一点都不忙'）：马上撤回，墓碑指向这句回答", async () => {
    const t = await askedTired();
    const tired = claimOf(t.engine, "recent_state");
    t.engine.recordQuestionAnswer(t.q.id, answer("ev-a2", "一点都不忙。", "2026-10-10T20:05:00+08:00"));
    expect(t.engine.store.getClaim(tired.id)).toMatchObject({ status: "retracted", retractedBy: "ev-a2" });
  });

  it("有偏向但不算明确（'会啊'）：先记下，下一夜按问题里写的判法定输赢", async () => {
    const t = await firstNight();
    const own = questionBetween(t.engine, "scene_autonomy", "dislike_content");
    const autonomy = claimOf(t.engine, "scene_autonomy");
    t.setNow("2026-10-10T20:00:00+08:00");
    const r = t.engine.recordQuestionAnswer(own.id, answer("ev-a3", "会啊。", "2026-10-10T20:00:00+08:00"));
    expect(r).toMatchObject({ verdict: "yes", clear: false, applied: "nightly" });
    expect(t.engine.store.getClaim(autonomy.id)!.status).toBe("contested");
    expect(t.engine.listQuestions().find((x) => x.id === own.id)!.status).toBe("answered");
    t.setNow("2026-10-11T03:00:00+08:00");
    const night = await t.engine.runNightly({ userActive: false });
    expect(t.engine.store.getClaim(autonomy.id)!.status).toBe("active");
    expect(t.engine.store.linksOf(autonomy.id).some((l) => l.target === "ev-a3" && l.polarity === "supports" && l.weight === "strong")).toBe(true);
    const resolved = t.engine.listQuestions().find((x) => x.id === own.id)!;
    expect(resolved.status).toBe("resolved");
    expect(resolved.outcome).toMatch(new RegExp(`${autonomy.id}.*成立`));
    expect(night.ran && night.report.questions.resolved.map((x) => x.id)).toContain(own.id);
  });

  it("含糊的回答（'说不好，看情况吧'）：照样记成本人证据，不判输赢", async () => {
    const t = await askedTired();
    const before = t.engine.store.linksOf(claimOf(t.engine, "recent_state").id).length;
    const r = t.engine.recordQuestionAnswer(t.q.id, answer("ev-a4", "说不好，看情况吧。", "2026-10-10T20:05:00+08:00"));
    expect(r).toMatchObject({ verdict: "unclear", applied: "none" });
    expect(t.engine.getEvidence("ev-a4")).toMatchObject({ sourceLevel: "self", status: "active" });
    t.setNow("2026-10-11T03:00:00+08:00");
    await t.engine.runNightly({ userActive: false });
    expect(t.engine.store.linksOf(claimOf(t.engine, "recent_state").id).filter((l) => l.target === "ev-a4")).toEqual([]);
    expect(t.engine.store.linksOf(claimOf(t.engine, "recent_state").id).length).toBeGreaterThanOrEqual(before);
    expect(t.engine.listQuestions().find((x) => x.id === t.q.id)!.outcome).toMatch(/不判/);
  });

  it("只认本人的回答；退下的、'别问这个'的问题不能再答", async () => {
    const t = await askedTired();
    expect(() => t.engine.recordQuestionAnswer(t.q.id, answer("ev-x1", "是的。", "2026-10-10T20:05:00+08:00", { sourceLevel: "agent" }))).toThrow(/本人/);
    t.engine.declineQuestion(t.q.id);
    expect(() => t.engine.recordQuestionAnswer(t.q.id, answer("ev-x2", "是的。", "2026-10-10T20:06:00+08:00"))).toThrow(/不能再答/);
    expect(() => t.engine.recordQuestionAnswer("qu-9999", answer("ev-x3", "是的。", "2026-10-10T20:06:00+08:00"))).toThrow(/没有这个问题/);
  });

  it("刚回答过关于某条假设的问题，30 天内不再就它发问（问题箱里关于它的别的问题也不用问了）", async () => {
    const t = await askedTired();
    const tired = claimOf(t.engine, "recent_state");
    const normative = t.engine.listQuestions().find((x) => x.kind === "normative")!;
    expect(normative.targets.map((x) => x.id)).toEqual([tired.id]);
    t.engine.recordQuestionAnswer(t.q.id, answer("ev-a6", "嗯，是的。", "2026-10-10T20:05:00+08:00"));
    t.setNow("2026-10-11T03:00:00+08:00");
    const night = await t.engine.runNightly({ userActive: false });
    expect(t.engine.listQuestions().find((x) => x.id === normative.id)!.status).toBe("obsolete");
    expect(night.ran && night.report.questions.notCreated.some((x) => x.key === normative.key && x.reason.includes(tired.id))).toBe(true);
  });

  it("记忆页看得到：为什么问、为了弄清哪个假设、问过几次、怎么回答的", async () => {
    const t = await firstNight();
    t.setNow("2026-10-10T20:00:00+08:00");
    const q = t.engine.pickQuestion(WEEKEND_TALK).question!;
    t.engine.recordQuestionAnswer(q.id, answer("ev-a5", "确实会去。", "2026-10-10T20:05:00+08:00"));
    const view = t.engine.listQuestions().find((x) => x.id === q.id)!;
    expect(view.why).toMatch(/分不清/);
    expect(view.targets.every((x) => x.statement.length > 0 && x.status.length > 0)).toBe(true);
    expect(view.history.map((h) => h.event)).toEqual(["created", "asked", "answered", "resolved"]);
  });
});

describe("回答的读法：classifyAnswer（规则版）", () => {
  it.each([
    ["对，确实特别忙。", "yes", true],
    ["会啊。", "yes", false],
    ["嗯，是的。", "yes", false],
    ["没错，就是这样。", "yes", true],
    ["一点都不忙。", "no", true],
    ["还好，这阵子不忙，就是不想周末被别人提前排满。", "no", false],
    ["不会，周末我想自己安排。", "no", false],
    ["当然不会。", "no", true],
    ["说不好，看情况吧。", "unclear", false],
    ["我也不知道。", "unclear", false],
    ["可能吧。", "unclear", false],
  ] as const)("%s → %s（明确：%s）", (text, verdict, clear) => {
    expect(classifyAnswer(text)).toMatchObject({ verdict, clear });
  });
});
