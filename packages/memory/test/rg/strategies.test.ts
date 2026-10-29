// 196 号票：交互策略（规则版）——成立的需求、价值编译成"什么场合 → 怎么做"，用户确认才生效。
// 330 号票（R6）：可以建在猜测上（标"建在猜测上"，照旧要点头）；依据变成猜测不暂停；依据都被推翻了，点过头的不自动停、不自动撤，
// 问题箱出一条"这条做法的理由没了，还要不要"，没点头的提议收回。
import { afterEach, describe, expect, it } from "vitest";
import { generateQuestions } from "../../src/rg/question-sources.ts";
import { basisGone, onGuessAt } from "../../src/rg/strategies.ts";
import { closeEngines, openEngine, say } from "./helpers.ts";
import { member, NEED, NOW, storyEngine, VALUE } from "./task-helpers.ts";

afterEach(closeEngines);

const statusTrail = (engine: import("../../src/engine.ts").MemoryEngine, id: string) =>
  engine.store.revisions(id, "strategy").flatMap((r) => (r.op === "create" ? ["proposed"] : r.changes.status ? [String(r.changes.status.to)] : []));

const AUTONOMY = "protect_autonomy|autonomy";
const RECOVERY = "leave_recovery|load";

async function compiled() {
  const t = await storyEngine();
  const report = t.engine.compileStrategies();
  // 330 号票（R6）：自主安排一条（依据有已验证的），留出休息一条（依据都是猜测）
  expect(report.strategies.map((s) => s.key).toSorted()).toEqual([RECOVERY, AUTONOMY].toSorted());
  return { ...t, strategy: report.strategies.find((s) => s.key === AUTONOMY)!, recovery: report.strategies.find((s) => s.key === RECOVERY)! };
}

/** 跑一遍出问题（同每晚整理：先编策略再出问题），交回"做法的理由没了"那几条 */
function basisQuestions(engine: import("../../src/engine.ts").MemoryEngine, at: string) {
  engine.compileStrategies();
  engine.questions.refresh(generateQuestions(engine.rg, at).drafts, at);
  return engine.listQuestions().filter((q) => q.kind === "strategy_basis" && (q.status === "open" || q.status === "asked"));
}

describe("编译：成立的需求、价值 → 什么场合怎么做", () => {
  it("'重视自主安排'（需求）和'长期看重自主安排'（价值）编成一条策略，proposed，挂着这两条依据（330：还有'现阶段的需要'那条猜测）", async () => {
    const { engine, strategy } = await compiled();
    const need = member(engine, NEED, "need_autonomy");
    const value = member(engine, VALUE, "value_enduring");
    const phase = member(engine, VALUE, "value_phase");
    expect(strategy).toMatchObject({
      key: "protect_autonomy|autonomy",
      template: "protect_autonomy",
      when: "安排周末、工作日的活动时",
      actions: ["留出空白，不要排满", "替用户约人、定时间之前先问他"],
      status: "proposed",
      confirmedBy: null,
    });
    expect(strategy.basisClaimIds.toSorted()).toEqual([need.id, value.id, phase.id].toSorted());
    // 依据里有已验证的：不算建在猜测上
    expect(onGuessAt(engine.store, strategy, NOW)).toBe(false);
    expect(strategy.trigger.domains).toEqual(["schedule", "social", "career"]);
    expect(strategy.trigger.scenes).toEqual([
      ["weekend", "social"],
      ["workday", "work"],
    ]);
    expect(strategy.id).toMatch(/^st-\d{4}$/);
    // 还没确认：不进用户模型快照
    expect(engine.getUserModel({}).strategies).toEqual([]);
    // 修订日志里有新建这一条
    expect(engine.store.revisions(strategy.id, "strategy")[0]).toMatchObject({ op: "create", objectType: "strategy" });
  });

  it("幂等：再编译一次没有新建、没有改动", async () => {
    const { engine } = await compiled();
    const again = engine.compileStrategies();
    expect(again).toMatchObject({ created: [], updated: [], statusChanged: [] });
  });

  it("330 号票（R6）：猜测也能编——'留出休息'那条依据都是猜测，标'建在猜测上'，照旧 proposed、要点头才生效；把握 low 的猜测不拿来编", async () => {
    const { engine, recovery } = await compiled();
    expect(recovery.status).toBe("proposed");
    expect(recovery.basisClaimIds.map((id) => engine.store.getClaim(id)!.status)).toEqual(recovery.basisClaimIds.map(() => "contested"));
    expect(onGuessAt(engine.store, recovery, NOW)).toBe(true);
    // 没点头：不进快照，任务建议里是"待你确认"
    expect(engine.getUserModel({}).strategies).toEqual([]);
    // 点了头才生效，快照里标着建在猜测上
    engine.ingestEvidence(say("ev-ok", "好，以后给我留点休息时间", NOW));
    engine.confirmStrategy(recovery.id, "ev-ok");
    expect(engine.getUserModel({}).strategies).toEqual([expect.objectContaining({ strategyId: recovery.id, onGuess: true, basisGone: false })]);
    // 把握 low 的猜测：不编出新的提议
    const t = openEngine(NOW);
    const low = t.engine.store.insertClaim({
      tier: "need",
      statement: "用户可能需要多陪家人",
      kind: "hypothesis",
      epistemic: "inferred",
      method: "induction",
      status: "contested",
      confidence: "low",
      context: [],
      validFrom: null,
      validTo: null,
      inferredAt: NOW,
      reviewedAt: null,
      retractedBy: null,
      supersededBy: null,
      competesWith: [],
      predicts: [],
    });
    expect(t.engine.compileStrategies().strategies.flatMap((s) => s.basisClaimIds)).not.toContain(low.id);
  });

  it("别的主题：不分场合都喜欢爬山 → '有空闲、要推荐活动时：可以优先提议爬山'", async () => {
    const t = openEngine(NOW);
    // 229 号票：三种场合靠方面不同（周末社交 / 工作 / 家里），只差日型不算两种
    t.engine.ingestEvidence(say("ev-h1", "周末我喜欢去爬山", "2026-08-09T10:00:00+08:00", { context: ["weekend", "social"] }));
    t.engine.ingestEvidence(say("ev-h2", "工作日晚上也喜欢去爬山", "2026-09-09T20:00:00+08:00", { context: ["workday", "work"] }));
    t.engine.ingestEvidence(say("ev-h3", "放假也最喜欢爬山", "2026-10-02T10:00:00+08:00", { context: ["holiday", "family"] }));
    await t.engine.reflect();
    const [s] = t.engine.compileStrategies().strategies;
    expect(s).toMatchObject({ template: "offer_interest", when: "有空闲、要推荐活动时（爬山）", actions: ["可以优先提议爬山", "只是提议，去不去由用户定"], status: "proposed" });
    expect(s!.trigger.activities.map((a) => a.name)).toEqual(["爬山"]);
    expect(s!.trigger.domains).toContain("health");
  });

  it("没有主题的需求（比如模型版出的）用通用模板：涉及它的领域的事时考虑到它", async () => {
    const t = openEngine(NOW);
    for (const [id, text, at] of [
      ["ev-g1", "我想多陪陪爸妈", "2026-08-01T10:00:00+08:00"],
      ["ev-g2", "我希望周末能回家", "2026-09-01T10:00:00+08:00"],
      ["ev-g3", "我想多陪家人", "2026-10-01T10:00:00+08:00"],
    ] as const)
      t.engine.ingestEvidence(say(id, text, at, { context: ["family"] }));
    t.engine.extractFacts();
    const facts = t.engine.store.listFacts().map((f) => f.id);
    const claim = t.engine.store.insertClaim({
      tier: "need",
      statement: "用户需要和家人在一起的时间",
      kind: "hypothesis",
      epistemic: "inferred",
      method: "induction",
      status: "active",
      confidence: "medium",
      context: [],
      validFrom: null,
      validTo: null,
      inferredAt: NOW,
      reviewedAt: null,
      retractedBy: null,
      supersededBy: null,
      competesWith: [],
      predicts: [],
    });
    for (const f of facts) t.engine.store.putLink({ claimId: claim.id, target: f, polarity: "supports", weight: "weak", rationale: "测试" });
    const [s] = t.engine.compileStrategies().strategies;
    expect(s).toMatchObject({ template: "consider_motive", when: "涉及时间安排、家庭的事时", actions: ["考虑到：用户需要和家人在一起的时间", "拿不准时先问"], basisClaimIds: [claim.id] });
  });
});

describe("确认：只有用户确认才 active，进用户模型快照", () => {
  it("别人转述的、被忘掉的不能确认；本人的话确认后 active，快照里有，修订日志记着是哪句话确认的", async () => {
    const { engine, strategy } = await compiled();
    engine.ingestEvidence(say("ev-x", "同事说他周末最讨厌被安排", NOW, { sourceLevel: "untrusted" }));
    expect(() => engine.confirmStrategy(strategy.id, "ev-x")).toThrow(/本人/);
    engine.ingestEvidence(say("ev-gone", "以后就这样吧", NOW));
    engine.invalidateEvidence("ev-gone", "用户说忘掉");
    expect(() => engine.confirmStrategy(strategy.id, "ev-gone")).toThrow(/本人有效/);
    expect(engine.store.getStrategy(strategy.id)!.status).toBe("proposed");

    engine.ingestEvidence(say("ev-ok", "对，以后周末别给我排满，约人前先问我", NOW));
    const active = engine.confirmStrategy(strategy.id, "ev-ok");
    expect(active).toMatchObject({ status: "active", confirmedBy: "ev-ok", confirmedAt: NOW });
    expect(engine.store.revisions(strategy.id, "strategy").at(-1)).toMatchObject({ causeEvidenceId: "ev-ok", reason: expect.stringContaining("用户确认") });
    expect(engine.getUserModel({}).strategies).toEqual([
      expect.objectContaining({ strategyId: strategy.id, text: "安排周末、工作日的活动时：留出空白，不要排满；替用户约人、定时间之前先问他", confirmedBy: "ev-ok" }),
    ]);
    // 确认的是"怎么为他服务"，不顺带确认"他为什么这样"
    expect(engine.store.getClaim(strategy.basisClaimIds[0]!)!.epistemic).toBe("inferred");
    // 再确认一次原样返回
    expect(engine.confirmStrategy(strategy.id, "ev-ok")).toMatchObject({ status: "active" });
  });

  it("快照按 at 算：确认以前的时间点没有这条策略", async () => {
    const { engine, strategy, setNow } = await compiled();
    setNow("2026-10-13T12:00:00+08:00");
    engine.ingestEvidence(say("ev-ok", "好，就这么办", "2026-10-13T12:00:00+08:00"));
    engine.confirmStrategy(strategy.id, "ev-ok");
    expect(engine.getUserModel({}).strategies).toHaveLength(1);
    expect(engine.getUserModel({ at: NOW }).strategies).toEqual([]);
  });

  it("确认它的那句话被忘掉 → 回到 proposed，要重新确认", async () => {
    const { engine, strategy } = await compiled();
    engine.ingestEvidence(say("ev-ok", "以后就这样", NOW));
    engine.confirmStrategy(strategy.id, "ev-ok");
    engine.invalidateEvidence("ev-ok", "用户说忘掉");
    const s = engine.listStrategies().find((x) => x.id === strategy.id);
    expect(s).toMatchObject({ status: "proposed", confirmedBy: null, confirmedAt: null });
    expect(engine.store.revisions(strategy.id, "strategy").at(-1)).toMatchObject({ causeEvidenceId: "ev-ok", reason: expect.stringContaining("重新确认") });
    expect(engine.getUserModel({}).strategies).toEqual([]);
  });
});

describe("跟着依据走（330 号票 R6）：依据变成猜测照旧用、标出来；依据都被推翻 → 点过头的问还要不要，没点头的收回", () => {
  it("依据被忘掉（工作日那句话）→ 需求、价值降成猜测 → 策略不暂停，照旧在用；reflect 后还是猜测 → 照旧在用，快照里标'建在猜测上'", async () => {
    const { engine, strategy } = await compiled();
    engine.ingestEvidence(say("ev-ok", "以后就这样", NOW));
    engine.confirmStrategy(strategy.id, "ev-ok");
    engine.invalidateEvidence("ev-d3", "用户说忘掉");
    expect(engine.listStrategies().find((s) => s.id === strategy.id)!.status).toBe("active");
    await engine.reflect();
    const need = member(engine, NEED, "need_autonomy");
    expect(engine.store.getClaim(need.id)!.status).toBe("contested");
    expect(engine.listStrategies().find((s) => s.id === strategy.id)!.status).toBe("active");
    expect(engine.getUserModel({}).strategies).toEqual([expect.objectContaining({ strategyId: strategy.id, onGuess: true, basisGone: false })]);
    expect(statusTrail(engine, strategy.id)).toEqual(["proposed", "active"]);
  });

  it("底下的猜测被推翻（用户说需求不对，往上传撤回）→ 做法还在、照旧在用，问题箱出一条'这条做法的理由没了，还要不要'；答'还要' → 记成重新确认，不再问", async () => {
    const { engine, strategy, setNow } = await compiled();
    engine.ingestEvidence(say("ev-ok", "以后就这样", NOW));
    engine.confirmStrategy(strategy.id, "ev-ok");
    engine.recordClaimVerdict(member(engine, NEED, "need_autonomy").id, "reject", { note: "测试：用户说不对" });
    expect(strategy.basisClaimIds.map((id) => engine.store.getClaim(id)!.status)).toEqual(strategy.basisClaimIds.map(() => "retracted"));
    // 不自动暂停、不自动撤
    expect(engine.listStrategies().find((s) => s.id === strategy.id)!.status).toBe("active");
    expect(basisGone(engine.store, strategy)).toBe(true);
    expect(engine.getUserModel({}).strategies).toEqual([expect.objectContaining({ strategyId: strategy.id, basisGone: true })]);
    const NIGHT = "2026-10-13T03:00:00+08:00";
    setNow(NIGHT);
    const [q] = basisQuestions(engine, NIGHT);
    expect(q).toMatchObject({ kind: "strategy_basis", targets: [{ id: strategy.id, kind: "strategy" }] });
    expect(q!.text).toContain("还要照旧吗");
    const ANSWER_AT = "2026-10-13T20:00:00+08:00";
    setNow(ANSWER_AT);
    const r = engine.recordQuestionAnswer(q!.id, say("ev-keep", "还要，照旧。", ANSWER_AT), { reading: { verdict: "yes", clear: true } });
    expect(r).toMatchObject({ applied: "now" });
    expect(engine.store.getStrategy(strategy.id)).toMatchObject({ status: "active", confirmedBy: "ev-keep" });
    expect(engine.store.revisions(strategy.id, "strategy").at(-1)).toMatchObject({ causeEvidenceId: "ev-keep", reason: expect.stringContaining("用户说还要") });
    // 知道理由没了还要：以后不再问
    setNow("2026-10-20T03:00:00+08:00");
    expect(basisQuestions(engine, "2026-10-20T03:00:00+08:00")).toEqual([]);
  });

  it("答'不要了' → 做法撤回，墓碑是这句话", async () => {
    const { engine, strategy, setNow } = await compiled();
    engine.ingestEvidence(say("ev-ok", "以后就这样", NOW));
    engine.confirmStrategy(strategy.id, "ev-ok");
    engine.recordClaimVerdict(member(engine, NEED, "need_autonomy").id, "reject", { note: "测试：用户说不对" });
    const NIGHT = "2026-10-13T03:00:00+08:00";
    setNow(NIGHT);
    const [q] = basisQuestions(engine, NIGHT);
    const ANSWER_AT = "2026-10-13T20:00:00+08:00";
    setNow(ANSWER_AT);
    engine.recordQuestionAnswer(q!.id, say("ev-drop", "不要了。", ANSWER_AT), { reading: { verdict: "no", clear: true } });
    expect(engine.store.getStrategy(strategy.id)!.status).toBe("retracted");
    expect(engine.store.revisions(strategy.id, "strategy").at(-1)).toMatchObject({ causeEvidenceId: "ev-drop", reason: expect.stringContaining("用户说不要了") });
    expect(statusTrail(engine, strategy.id)).toEqual(["proposed", "active", "retracted"]);
    expect(engine.getUserModel({}).strategies).toEqual([]);
  });

  it("还没点头的提议，依据都被推翻 → 收回（retracted），不问", async () => {
    const { engine, strategy } = await compiled();
    engine.recordClaimVerdict(member(engine, NEED, "need_autonomy").id, "reject", { note: "测试：用户说不对" });
    expect(engine.listStrategies().map((s) => s.id)).not.toContain(strategy.id);
    expect(engine.store.getStrategy(strategy.id)!.status).toBe("retracted");
    expect(engine.store.revisions(strategy.id, "strategy").at(-1)!.reason).toMatch(/还没确认的提议.*收回/);
    expect(basisQuestions(engine, "2026-10-13T03:00:00+08:00").flatMap((q) => q.targets.map((t) => t.id))).not.toContain(strategy.id);
  });

  it("快照只读：依据被推翻了也不写库，照样在快照里、标'理由没了'", async () => {
    const { engine, strategy } = await compiled();
    engine.ingestEvidence(say("ev-ok", "以后就这样", NOW));
    engine.confirmStrategy(strategy.id, "ev-ok");
    engine.recordClaimVerdict(member(engine, NEED, "need_autonomy").id, "reject", { note: "测试：用户说不对" });
    const before = engine.store.revisions(strategy.id, "strategy").length;
    expect(engine.getUserModel({}).strategies).toEqual([expect.objectContaining({ strategyId: strategy.id, basisGone: true })]);
    expect(engine.store.revisions(strategy.id, "strategy")).toHaveLength(before);
  });

  it("依据标着复核后又恢复（忘掉一次周末推掉的活动，观察还够）→ 一直在用，reflect 后依据回到已验证、不再标'建在猜测上'", async () => {
    const { engine, strategy } = await compiled();
    engine.ingestEvidence(say("ev-ok", "以后就这样", NOW));
    engine.confirmStrategy(strategy.id, "ev-ok");
    engine.invalidateEvidence("ev-w4", "用户说忘掉");
    expect(engine.listStrategies().find((s) => s.id === strategy.id)!.status).toBe("active");
    await engine.reflect();
    expect(member(engine, NEED, "need_autonomy").status).toBe("active");
    expect(engine.getUserModel({}).strategies).toEqual([expect.objectContaining({ strategyId: strategy.id, onGuess: false, basisGone: false })]);
    expect(statusTrail(engine, strategy.id)).toEqual(["proposed", "active"]);
  });

  it("老库里暂停着的（330 以前依据拿不准就停）：依据还活着 → 同步时恢复（确认过的回到 active）", async () => {
    const { engine, strategy } = await compiled();
    engine.ingestEvidence(say("ev-ok", "以后就这样", NOW));
    engine.confirmStrategy(strategy.id, "ev-ok");
    engine.store.updateStrategy(strategy.id, { status: "paused" }, { evidenceId: null, reason: "测试：老库里暂停着" });
    engine.listStrategies();
    expect(engine.store.getStrategy(strategy.id)).toMatchObject({ status: "active", confirmedBy: "ev-ok" });
  });
});
