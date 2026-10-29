// 207 号票：199 的矛盾根源、对比模式分不出时出的问题，经 QuestionSink 接到 198 的问题箱（QuestionBook），照 198 的格式
// （为什么问、区分哪几个、回答各支持哪边、领域和场景、优先级、过期时间），走同一套顺口问、跳过、"别问这个"、回写。
// 例子都是自己写的（和 199 的测试同一类说法）。
import { afterEach, describe, expect, it } from "vitest";
import { addDays } from "../../src/domain/time.ts";
import type { EvidenceDraft } from "../../src/domain/types.ts";
import type { MemoryEngine } from "../../src/engine.ts";
import { leadingPhrases } from "../../src/rg/question-sources.ts";
import type { QuestionView } from "../../src/rg/questions.ts";
import { closeEngines, openEngine, say, type TestEngine } from "./helpers.ts";

afterEach(closeEngines);

const did = (id: string, text: string, at: string, context: string[] = []): EvidenceDraft => say(id, text, at, { mode: "do", kind: "action", context });

/** 说在找工作、两次推掉面试，没有约束的证据、也没有成立的需求能解释：矛盾根源分不出 */
const JOB: EvidenceDraft[] = [
  say("ev-j1", "我在投简历了，这礼拜面了两家。", "2026-03-10T22:00:00+08:00", { context: ["work"] }),
  did("ev-j2", "上海一家公司约用户二面。用户回：“不好意思，这个机会先不考虑了。”", "2026-04-02T15:00:00+08:00", ["work"]),
  did("ev-j3", "深圳一家公司约用户终面。用户回：“先不考虑了。”", "2026-05-22T18:00:00+08:00", ["work"]),
];

/** 老王（也叫王哥）约的三次都推了，别人约的去了；没有"只差组织者"的对照，所以分不出是和组织者有关还是各有各的原因 */
const INVITES: EvidenceDraft[] = [
  did("ev-d1", "隔壁组老王（组里都叫他王哥）上周一在部门群里约这周五晚上吃火锅。用户没接龙，回他：“下回吧。”", "2026-03-06T10:00:00+08:00", ["workday", "social"]),
  did("ev-d2", "王哥周三在部门群里约这周六上午打羽毛球。用户回他：“这周脚不舒服，就不去了。”", "2026-03-20T21:00:00+08:00", ["weekend", "social"]),
  did("ev-d3", "老王上周四在部门群里约这周五晚上去吃串串。用户没接龙，回：“这周有点累，下次一定。”", "2026-04-09T18:00:00+08:00", ["workday", "social"]),
  did("ev-a3", "阿珂上周五就约了这周五晚上去听现场，用户当时就答应了，当晚去了。", "2026-04-17T22:00:00+08:00", ["workday", "social"]),
  did("ev-a4", "表姐周三就打电话约这周日中午去她家吃饭，用户当时就说好，周日去了。", "2026-04-26T14:00:00+08:00", ["weekend", "family"]),
];

const DAY = "2026-10-19T12:00:00+08:00";

async function reflected(drafts: EvidenceDraft[]): Promise<TestEngine> {
  const t = openEngine(DAY);
  for (const d of drafts) t.engine.ingestEvidence(d);
  await t.engine.reflect();
  return t;
}

function groupOf(engine: MemoryEngine, prefix: string): string {
  const g = engine.rg.registry.listGroups({ live: true }).find((x) => x.key.startsWith(prefix));
  if (!g) throw new Error(`没有 ${prefix} 的组`);
  return g.key;
}

/** 问题箱里出自这一组的问题（看它用的是这组的哪条追问） */
function questionsOfGroup(engine: MemoryEngine, groupKey: string, status?: QuestionView["status"]): QuestionView[] {
  const probes = new Set(engine.rg.registry.probesOf(groupKey).map((p) => p.probeId));
  return engine.listQuestions(status ? { status } : {}).filter((q) => q.probeId !== null && probes.has(q.probeId));
}

describe("199 的问题接到 198 的问题箱", () => {
  it("默认接上：reflect 里矛盾根源分不出 → 问题箱里就有，照 198 的格式（为什么问、区分哪几个、回答各支持哪边、领域和场景、优先级、过期时间）", async () => {
    const { engine } = await reflected(JOB);
    const key = groupOf(engine, "conflict_root|say_do|");
    const members = new Set(engine.rg.registry.members(key).map((m) => m.claimId));
    const qs = questionsOfGroup(engine, key, "open");
    expect(qs.length).toBeGreaterThan(1);
    for (const q of qs) {
      expect(q.kind).toBe("unresolved");
      expect(q.sources).toEqual(expect.arrayContaining(["unresolved", "tension"]));
      expect(q.text).toMatch(/？$/);
      expect(leadingPhrases(q.text)).toEqual([]);
      expect(q.targets).toHaveLength(2);
      for (const t of q.targets) {
        expect(members.has(t.id)).toBe(true);
        expect(q.why).toContain(t.id);
      }
      const ids = q.targets.map((t) => t.id);
      for (const effect of [q.answers.yes, q.answers.no]) for (const id of [...effect.supports, ...effect.refutes]) expect(ids).toContain(id);
      expect([...q.answers.yes.supports, ...q.answers.yes.refutes, ...q.answers.no.supports, ...q.answers.no.refutes].length).toBeGreaterThan(0);
      expect(q.domains).toContain("career");
      expect(Array.isArray(q.scenes)).toBe(true);
      expect(q.topic).toMatch(/^object:/);
      expect(q.priority).toBeGreaterThan(0);
      expect(q.priorityDetail.separation).toBeGreaterThan(0);
      expect(q.expiresAt).toBe(addDays(q.createdAt, 30));
    }
    // 没有成立的需求时不问"背后是不是有一个更在意的东西"（问不出具体的事）
    expect(qs.some((q) => /更在意/.test(q.text))).toBe(false);
    // joint_questions 照旧记账，和问题箱一一对上
    expect(engine.knowYouQuestions().map((q) => q.key).toSorted()).toEqual(qs.map((q) => q.key).toSorted());
    for (const k of engine.knowYouQuestions()) expect(k).toMatchObject({ groupKey: key, kind: "conflict_root", why: expect.any(String), answers: expect.any(Object), priority: expect.any(Number) });
  });

  it("每日整理照样认这几个问题：整理报告的新出里有它们；再整理一夜不重复建、不标'不用问了'", async () => {
    const t = openEngine(DAY);
    for (const d of JOB) t.engine.ingestEvidence(d);
    t.setNow("2026-10-20T03:00:00+08:00");
    const first = await t.engine.runNightly({ userActive: false });
    if (!first.ran) throw new Error("应该跑了");
    const key = groupOf(t.engine, "conflict_root|say_do|");
    const ids = questionsOfGroup(t.engine, key, "open").map((q) => q.id);
    expect(ids.length).toBeGreaterThan(1);
    expect(first.report.questions.added.map((q) => q.id)).toEqual(expect.arrayContaining(ids));
    t.setNow("2026-10-21T03:00:00+08:00");
    const second = await t.engine.runNightly({ userActive: false });
    if (!second.ran) throw new Error("应该跑了");
    expect(second.report.questions.added).toEqual([]);
    expect(second.report.questions.obsolete).toEqual([]);
    expect(questionsOfGroup(t.engine, key, "open").map((q) => q.id).toSorted()).toEqual(ids.toSorted());
  });

  it("顺口问对得上话题时会问到它；回答得很明确马上判、那一组定了 → 下一次整理写回知识图谱，同一组别的问题标'不用问了'", async () => {
    const t = await reflected(JOB);
    const { engine } = t;
    const key = groupOf(engine, "conflict_root|say_do|");
    t.setNow("2026-10-19T20:00:00+08:00");
    const picked = engine.pickQuestion("又有一家公司约我面试，我还没回人家。", { context: ["work"] });
    expect(picked.ask).toBe(true);
    expect(questionsOfGroup(engine, key).map((q) => q.id)).toContain(picked.question!.id);
    // 用户回答"是想找，只是这阵子耽误了"的那一问
    const constraint = questionsOfGroup(engine, key).find((q) => /耽误/.test(q.text))!;
    const gap = engine.rg.registry.members(key).find((m) => m.template === "root:say_do_gap")!.claimId;
    expect(constraint.answers.yes.supports).toEqual([gap]);
    t.setNow("2026-10-19T20:05:00+08:00");
    const rec = engine.recordQuestionAnswer(constraint.id, say("ev-ans", "确实，这阵子天天加班，根本顾不上。", "2026-10-19T20:05:00+08:00", { context: ["work"] }));
    expect(rec).toMatchObject({ verdict: "yes", clear: true, applied: "now" });
    expect(engine.store.getClaim(gap)).toMatchObject({ status: "active", epistemic: "user_confirmed" });
    await engine.reflect();
    // 写回：说的和做的两边都标 gap（ref 是这条根源）；330 号票（R14）发现矛盾时记的那一笔（ref 是矛盾本身）也还在
    const stated = engine.store.factsByEvidence("ev-j1").find((f) => f.predicate === "works_on")!;
    expect(engine.factMarks(stated.id).map((m) => m.kind)).toEqual(["gap", "gap"]);
    expect(engine.factMarks(stated.id).map((m) => m.ref)).toContain(gap);
    // 同一组别的问题：不用问了；joint_questions 也关了
    const rest = questionsOfGroup(engine, key).filter((q) => q.id !== constraint.id);
    expect(rest.length).toBeGreaterThan(0);
    for (const q of rest) expect(q.status).toBe("obsolete");
    expect(engine.knowYouQuestions()).toEqual([]);
  });

  it("跳过一次回到问题箱、优先级减半；再整理一次照样是它（不重复建、减半不被冲掉）", async () => {
    const t = await reflected(JOB);
    const { engine } = t;
    t.setNow("2026-10-19T20:00:00+08:00");
    const picked = engine.pickQuestion("又有一家公司约我面试，我还没回人家。", { context: ["work"] });
    const before = picked.question!;
    engine.recordQuestionSkipped(before.id);
    engine.ingestEvidence(say("ev-x", "中午吃了碗牛肉面。", "2026-10-19T21:00:00+08:00", { context: ["food"] }));
    await engine.reflect();
    const after = engine.listQuestions().filter((q) => q.key === before.key);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: before.id, status: "open", skippedCount: 1 });
    expect(after[0]!.priorityDetail.fresh).toBe(0.5);
    expect(after[0]!.priority).toBeCloseTo(before.priority / 2, 2);
  });

  it("别问这个：这一类（同一样东西）的问题都关掉，再整理、再过一夜都不重新进问题箱", async () => {
    const t = await reflected(JOB);
    const { engine } = t;
    const key = groupOf(engine, "conflict_root|say_do|");
    const first = questionsOfGroup(engine, key, "open")[0]!;
    engine.declineQuestion(first.id, { evidence: say("ev-no", "这个别问了。", "2026-10-19T20:00:00+08:00") });
    for (const q of questionsOfGroup(engine, key)) expect(q.status).toBe("declined");
    engine.ingestEvidence(say("ev-x", "中午吃了碗牛肉面。", "2026-10-19T21:00:00+08:00", { context: ["food"] }));
    await engine.reflect();
    t.setNow("2026-10-20T03:00:00+08:00");
    await engine.runNightly({ userActive: false });
    expect(questionsOfGroup(engine, key, "open")).toEqual([]);
  });

  it("对比模式分不出时也进问题箱：问的是能用'会去 / 不会去'回答的具体的事，两种回答都能分出胜负", async () => {
    const { engine } = await reflected(INVITES);
    const key = groupOf(engine, "contrast|organizer|");
    const motif = engine.rg.registry.members(key).find((m) => m.template === "contrast:organizer")!.claimId;
    expect(engine.store.getClaim(motif)!.status).not.toBe("active");
    const qs = questionsOfGroup(engine, key, "open");
    expect(qs.length).toBeGreaterThan(0);
    for (const q of qs) {
      expect(q.text).toMatch(/你会去吗？$/);
      expect(leadingPhrases(q.text)).toEqual([]);
      expect(q.topic).toBe(key);
      expect(q.priorityDetail.separation).toBe(1);
      expect(q.targets.map((x) => x.id)).toContain(motif);
    }
    expect(qs.some((q) => /老王|王哥/.test(q.text))).toBe(true);
  });

  it("换了接收的钩子（setQuestionSink）就不再进问题箱，只交给新的钩子；joint_questions 照旧记账", async () => {
    const received: string[] = [];
    const t = openEngine(DAY);
    t.engine.setQuestionSink({ onQuestion: (q) => received.push(q.key) });
    for (const d of JOB) t.engine.ingestEvidence(d);
    await t.engine.reflect();
    expect(received.length).toBeGreaterThan(1);
    expect(t.engine.knowYouQuestions().map((q) => q.key).toSorted()).toEqual(received.toSorted());
    expect(t.engine.listQuestions()).toEqual([]);
  });
});
