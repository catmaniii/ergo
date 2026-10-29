// 330 号票 A（R12、R13、R14、矛盾根源选 A）：矛盾怎么处理。例子都是自己写的（不看 fixtures/truth）。
// - R12 已验证碰上有分量的反例：先降回猜测、加复核标记；弄清以后三种结局——只是例外（后面又有够分量的支持、或者你当面确认）恢复已验证；
//   支持都在一种场合、反例在另一种场合 → 结论层收窄成"在某场合下成立"（新结论取代原结论，留痕）；真错（你当面否掉）撤回。
// - R13 两条打架都已验证（跨组）：都降回猜测；各自的支持能按场合分开就各自收窄；分不清出一个问题；自检查"互相矛盾却都已验证"。
// - R14 随口说的不再自动算决定性（当面问、你明确确认 / 否掉的才算）；说的和做的对不上当矛盾处理，哪边都不自动赢，"嘴上和行为不一样"记一笔。
// - 矛盾根源（用户 10-27 选 A）：不豁免铁律——琢磨出来的根源判断没经你确认只当猜测、出问题、不写回；你答了才定、才改事实。
import { afterEach, describe, expect, it } from "vitest";
import type { Claim, EvidenceDraft, LinkWeight } from "../../src/domain/types.ts";
import type { MemoryEngine } from "../../src/engine.ts";
import { checkReasoningGraph } from "../../src/rg/graph-check.ts";
import { generateQuestions } from "../../src/rg/question-sources.ts";
import { closeEngines, openEngine, say } from "./helpers.ts";

afterEach(closeEngines);

const NOW = "2026-10-20T12:00:00+08:00";
const did = (id: string, text: string, at: string, context: string[] = []): EvidenceDraft => say(id, text, at, { mode: "do", kind: "action", context });

/** 往一组里放一条推断的结论（前提是给的证据，归纳），交回它 */
function hypothesis(engine: MemoryEngine, groupKey: string, template: string, statement: string, premises: string[], extra: Partial<Claim> = {}): Claim {
  const claim = engine.store.insertClaim({
    tier: "preference",
    statement,
    kind: "hypothesis",
    epistemic: "inferred",
    method: "induction",
    status: "contested",
    confidence: "low",
    context: [],
    validFrom: null,
    validTo: null,
    inferredAt: "2026-09-01T03:00:00+08:00",
    reviewedAt: null,
    retractedBy: null,
    supersededBy: null,
    competesWith: [],
    predicts: [],
    ...extra,
  });
  engine.store.insertInference({ conclusionClaimId: claim.id, premiseIds: premises, method: "induction", rationale: `测试：${statement}`, by: "rule:1", status: "active" });
  engine.rg.registry.addMember(claim.id, groupKey, template);
  return claim;
}

function group(engine: MemoryEngine, key: string, observationIds: string[]): void {
  engine.rg.registry.putGroup({ key, pattern: "test", params: {}, description: `测试组 ${key}`, observationIds, live: true, by: "test" });
}

const link = (engine: MemoryEngine, claimId: string, target: string, polarity: "supports" | "refutes", weight: LinkWeight, rationale = "测试") =>
  engine.store.putLink({ claimId, target, polarity, weight, rationale });

/** 周末都待在家的三次（周末），"喜欢周末宅着"领先、"最近太累"落后 */
function homebody() {
  const t = openEngine(NOW);
  for (const [id, text, at] of [
    ["ev-h1", "周六在家待了一天，哪也没去", "2026-09-05T20:00:00+08:00"],
    ["ev-h2", "周日也没出门，在家看书", "2026-09-13T20:00:00+08:00"],
    ["ev-h3", "这周末又宅在家里", "2026-09-20T20:00:00+08:00"],
  ] as const)
    t.engine.ingestEvidence(say(id, text, at, { context: ["weekend"] }));
  group(t.engine, "g-home", ["ev-h1", "ev-h2", "ev-h3"]);
  const home = hypothesis(t.engine, "g-home", "home", "用户喜欢在家待着", ["ev-h1", "ev-h2", "ev-h3"]);
  const tired = hypothesis(t.engine, "g-home", "tired", "用户最近太累、不想出门", ["ev-h1"]);
  link(t.engine, home.id, "ev-h1", "supports", "strong");
  link(t.engine, home.id, "ev-h2", "supports", "strong");
  link(t.engine, home.id, "ev-h3", "supports", "weak");
  link(t.engine, tired.id, "ev-h1", "supports", "weak");
  t.engine.rg.redecideGroup("g-home");
  expect(t.engine.store.getClaim(home.id)!.status).toBe("active");
  return { ...t, home, tired };
}

const claimOf = (engine: MemoryEngine, id: string) => engine.store.getClaim(id)!;

describe("R12 已验证碰上有分量的反例", () => {
  it("一条强反例（以前领先 6 分贝照样成立、反例只记一笔）→ 降回猜测、加复核标记，修订里写明是反例", async () => {
    const { engine, home } = homebody();
    engine.ingestEvidence(did("ev-c1", "周六跟朋友去爬山了，玩了一整天", "2026-10-03T20:00:00+08:00", ["weekend"]));
    link(engine, home.id, "ev-c1", "refutes", "strong");
    engine.rg.redecideGroup("g-home");
    expect(claimOf(engine, home.id)).toMatchObject({ status: "contested", needsReview: true });
    expect(engine.store.revisions(home.id, "claim").at(-1)!.reason).toContain("反例");
    // 弱的旁证不算有分量：不降
    const t = homebody();
    t.engine.ingestEvidence(did("ev-c2", "周日下楼买了个菜", "2026-10-04T10:00:00+08:00", ["weekend"]));
    link(t.engine, t.home.id, "ev-c2", "refutes", "weak");
    t.engine.rg.redecideGroup("g-home");
    expect(claimOf(t.engine, t.home.id).status).toBe("active");
  });

  it("只是例外：反例以后又有够分量的支持（6 分贝以上）→ 恢复已验证、摘掉复核标记", async () => {
    const { engine, home } = homebody();
    engine.ingestEvidence(did("ev-c1", "周六跟朋友去爬山了，玩了一整天", "2026-10-03T20:00:00+08:00", ["weekend"]));
    link(engine, home.id, "ev-c1", "refutes", "strong");
    engine.rg.redecideGroup("g-home");
    expect(claimOf(engine, home.id).status).toBe("contested");
    engine.ingestEvidence(say("ev-h4", "这周末又在家待着，还是家里舒服", "2026-10-11T20:00:00+08:00", { context: ["weekend"] }));
    link(engine, home.id, "ev-h4", "supports", "strong");
    engine.rg.redecideGroup("g-home");
    expect(claimOf(engine, home.id)).toMatchObject({ status: "active", needsReview: false });
  });

  it("要分场合：支持都在周末、反例在工作日 → 收窄成'在周末成立'的新结论（取代原结论，留痕），新结论已验证、反例只当背景", async () => {
    const { engine, home } = homebody();
    engine.ingestEvidence(did("ev-c3", "工作日晚上和同事出去吃饭唱歌到很晚", "2026-10-08T23:00:00+08:00", ["workday", "social"]));
    link(engine, home.id, "ev-c3", "refutes", "strong");
    engine.rg.redecideGroup("g-home");
    const old = claimOf(engine, home.id);
    expect(old.status).toBe("superseded");
    const narrowed = claimOf(engine, old.supersededBy!);
    expect(narrowed).toMatchObject({ status: "active", context: ["weekend"] });
    expect(narrowed.statement).toContain("周末");
    expect(engine.rg.registry.memberOf(narrowed.id)).toMatchObject({ groupKey: "g-home", template: "home" });
    expect(engine.store.linksOf(narrowed.id).find((l) => l.target === "ev-c3")).toMatchObject({ polarity: "context" });
    expect(engine.store.revisions(old.id, "claim").at(-1)!.reason).toContain("收窄");
  });

  it("真错：你当面说不对 → 撤回（墓碑是你那句话）", async () => {
    const { engine, home } = homebody();
    engine.ingestEvidence(did("ev-c1", "周六跟朋友去爬山了，玩了一整天", "2026-10-03T20:00:00+08:00", ["weekend"]));
    link(engine, home.id, "ev-c1", "refutes", "strong");
    engine.rg.redecideGroup("g-home");
    engine.recordClaimVerdict(home.id, "reject", { note: "测试：用户说不对" });
    expect(claimOf(engine, home.id).status).toBe("retracted");
  });

  it("当面确认的赢：你确认过，再来一条强反例 → 照样已验证", async () => {
    const { engine, home } = homebody();
    engine.recordClaimVerdict(home.id, "confirm", { note: "测试：用户说对" });
    engine.ingestEvidence(did("ev-c1", "周六跟朋友去爬山了，玩了一整天", "2026-10-03T20:00:00+08:00", ["weekend"]));
    link(engine, home.id, "ev-c1", "refutes", "strong");
    engine.rg.redecideGroup("g-home");
    expect(claimOf(engine, home.id).status).toBe("active");
  });

  it("出一个问题问你：是例外吗（是：照旧已验证；不是：撤回）", async () => {
    const { engine, home } = homebody();
    engine.ingestEvidence(did("ev-c1", "周六跟朋友去爬山了，玩了一整天", "2026-10-03T20:00:00+08:00", ["weekend"]));
    link(engine, home.id, "ev-c1", "refutes", "strong");
    engine.rg.redecideGroup("g-home");
    const drafts = generateQuestions(engine.rg, NOW).drafts.filter((d) => d.kind === "counterexample");
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ targets: [{ id: home.id, kind: "claim" }], answers: { yes: { supports: [home.id] }, no: { refutes: [home.id] } } });
    expect(drafts[0]!.text).toContain("例外");
  });

  it("问题进问题箱、你答了：是例外 → 已验证（你当面确认的赢）；不是 → 撤回", async () => {
    for (const [reply, status] of [
      ["对，平时就是爱宅着，那次是朋友硬拉的", "active"],
      ["不对，其实我现在挺爱出门的", "retracted"],
    ] as const) {
      const { engine, home } = homebody();
      engine.ingestEvidence(did("ev-c1", "周六跟朋友去爬山了，玩了一整天", "2026-10-03T20:00:00+08:00", ["weekend"]));
      link(engine, home.id, "ev-c1", "refutes", "strong");
      engine.rg.redecideGroup("g-home");
      engine.questions.refresh(generateQuestions(engine.rg, NOW).drafts, NOW);
      const q = engine.listQuestions().find((x) => x.kind === "counterexample")!;
      expect(q).toBeDefined();
      engine.recordQuestionAnswer(q.id, say("ev-ans", reply, "2026-10-20T11:00:00+08:00"), { reading: { verdict: status === "active" ? "yes" : "no", clear: true } });
      expect(claimOf(engine, home.id).status).toBe(status);
    }
  });
});

describe("R14 随口说的不再自动算决定性", () => {
  it("你随口说的'决定性'反证只算强的：不撤回（降成猜测、等弄清）；当面否掉的照样撤回", async () => {
    const { engine, home } = homebody();
    engine.ingestEvidence(say("ev-s1", "其实我也没那么爱待在家", "2026-10-05T20:00:00+08:00", { context: ["weekend"] }));
    link(engine, home.id, "ev-s1", "refutes", "decisive", "用户自己说的");
    engine.rg.redecideGroup("g-home");
    expect(claimOf(engine, home.id)).toMatchObject({ status: "contested", needsReview: true, retractedBy: null });
  });
});

/** 两组：一组"喜欢在家待着"（周末待在家三次），另一组"喜欢出去玩"（三次出去玩），互相是竞争解释 */
function rivals(outScene: string) {
  const t = homebody();
  for (const [id, text, at] of [
    ["ev-o1", "和朋友出去逛了一天街", "2026-09-07T20:00:00+08:00"],
    ["ev-o2", "又和朋友出去玩到很晚", "2026-09-17T20:00:00+08:00"],
    ["ev-o3", "跟同事去看了场演出", "2026-09-24T20:00:00+08:00"],
  ] as const)
    t.engine.ingestEvidence(did(id, text, at, [outScene, "social"]));
  group(t.engine, "g-out", ["ev-o1", "ev-o2", "ev-o3"]);
  const out = hypothesis(t.engine, "g-out", "out", "用户喜欢出去玩", ["ev-o1", "ev-o2", "ev-o3"], { competesWith: [t.home.id] });
  const other = hypothesis(t.engine, "g-out", "other", "只是凑巧", ["ev-o1"]);
  link(t.engine, out.id, "ev-o1", "supports", "strong");
  link(t.engine, out.id, "ev-o2", "supports", "strong");
  link(t.engine, out.id, "ev-o3", "supports", "weak");
  link(t.engine, other.id, "ev-o1", "supports", "weak");
  t.engine.rg.redecideGroup("g-out");
  t.engine.rg.redecideGroup("g-home");
  return { ...t, out };
}

describe("R13 两条打架都已验证", () => {
  it("跨组、场合对得上：都降回猜测、加复核标记；出一个问题", async () => {
    const { engine, home, out } = rivals("weekend");
    expect(claimOf(engine, home.id)).toMatchObject({ status: "contested", needsReview: true });
    expect(claimOf(engine, out.id)).toMatchObject({ status: "contested", needsReview: true });
    // 再定一遍还是这样（不来回翻）
    engine.rg.redecideGroup("g-home");
    engine.rg.redecideGroup("g-out");
    expect([claimOf(engine, home.id).status, claimOf(engine, out.id).status]).toEqual(["contested", "contested"]);
    const drafts = generateQuestions(engine.rg, NOW).drafts.filter((d) => d.key.startsWith("verified-conflict:"));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.targets.map((x) => x.id).toSorted()).toEqual([home.id, out.id].toSorted());
    // 你答了"更接近前一条"：前一条你当面确认、已验证；后一条撤回
    engine.questions.refresh(drafts, NOW);
    const q = engine.listQuestions().find((x) => x.kind === "contradiction")!;
    const first = q.answers.yes.supports[0]!;
    const second = first === home.id ? out.id : home.id;
    engine.recordQuestionAnswer(q.id, say("ev-ans", "前一个，更接近", "2026-10-20T11:00:00+08:00"), { reading: { verdict: "yes", clear: true } });
    expect(claimOf(engine, first).status).toBe("active");
    expect(claimOf(engine, second).status).toBe("retracted");
  });

  it("各自的支持能按场合分开（一边都在周末、一边都在工作日）→ 各自收窄，都已验证", async () => {
    const { engine, home, out } = rivals("workday");
    const h = claimOf(engine, home.id);
    const o = claimOf(engine, out.id);
    expect(h.status).toBe("superseded");
    expect(o.status).toBe("superseded");
    expect(claimOf(engine, h.supersededBy!)).toMatchObject({ status: "active", context: ["weekend"] });
    expect(claimOf(engine, o.supersededBy!)).toMatchObject({ status: "active", context: ["workday"] });
  });

  it("同组：计分只让一条领先（另一条照旧猜测）；硬改成两条都已验证的，自检报出来", async () => {
    const { engine, home, tired } = homebody();
    engine.store.updateClaim(home.id, { competesWith: [tired.id] }, { reason: "测试：登记竞争" });
    engine.rg.redecideGroup("g-home");
    expect([claimOf(engine, home.id).status, claimOf(engine, tired.id).status]).toEqual(["active", "contested"]);
    expect(checkReasoningGraph(engine.store).problems).toEqual([]);
    engine.store.updateClaim(tired.id, { status: "active" }, { reason: "测试：直接改" });
    expect(checkReasoningGraph(engine.store).problems.filter((p) => p.check === "conflict")).toHaveLength(1);
  });

  it("自检：互相矛盾却都已验证的报出来（跨组也查）", async () => {
    const { engine, home, out } = rivals("weekend");
    engine.store.updateClaim(home.id, { status: "active", needsReview: false }, { reason: "测试：直接改" });
    engine.store.updateClaim(out.id, { status: "active", needsReview: false }, { reason: "测试：直接改" });
    const problems = checkReasoningGraph(engine.store).problems.filter((p) => p.check === "conflict");
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain("互相矛盾");
  });
});

/** 说下礼拜起每天跑步，两次一条跑步记录也没有 */
const RUN: EvidenceDraft[] = [
  say("ev-r1", "我喜欢跑步，每天早上都想跑五公里。", "2026-05-10T21:30:00+08:00", { context: ["exercise"] }),
  did("ev-r3", "这周用户每天都是八点以后才起，手环里一条跑步记录也没有。", "2026-05-15T20:00:00+08:00", ["workday", "exercise"]),
  did("ev-r5", "这周工作日用户每天七点多才起，手环里一条跑步记录也没有。", "2026-06-26T20:00:00+08:00", ["workday", "exercise"]),
];

describe("R14 说的和做的对不上", () => {
  it("明说的'喜欢跑步'碰上一再没跑：明说的那条成了猜测、标着复核（哪边都不自动赢）；'嘴上和行为不一样'记一笔；你当面确认 → 已验证", async () => {
    const t = openEngine(NOW);
    for (const d of RUN) t.engine.ingestEvidence(d);
    await t.engine.reflect();
    const said = t.engine.store.factsByEvidence("ev-r1").find((f) => f.assertion === "user_stated")!;
    const stated = claimOf(t.engine, t.engine.rg.registry.explicitClaimOf(said.id)!);
    expect(stated).toMatchObject({ status: "contested", needsReview: true });
    expect(t.engine.factMarks(said.id).map((m) => m.kind)).toContain("gap");
    t.engine.ingestEvidence(say("ev-yes", "对，我是真喜欢跑步，就是最近太忙", "2026-10-20T10:00:00+08:00"));
    t.engine.rg.confirmClaim(stated.id, "ev-yes");
    await t.engine.reflect();
    expect(claimOf(t.engine, stated.id).status).toBe("active");
    // 自检不误报
    expect(checkReasoningGraph(t.engine.store).problems).toEqual([]);
  });
});

/** 说差点没赶上高铁（照字面抽成没坐上），另一次说坐了、报销里车票已检票 */
const TRAIN: EvidenceDraft[] = [
  say("ev-t1", "今天去杭州见客户，早上差点没赶上八点那班高铁。", "2026-05-06T21:00:00+08:00", { context: ["workday", "work", "travel"] }),
  say("ev-t2", "上周三坐八点那班高铁去的杭州，车上睡了一觉。", "2026-05-06T08:00:00+08:00", { observedAt: "2026-05-11T12:00:00+08:00", context: ["work", "travel"] }),
  did("ev-t3", "用户提交了差旅报销，附件里有一张 5 月 6 日 08:00 开往杭州东的高铁票，状态是已检票。", "2026-05-08T10:00:00+08:00", ["work", "travel"]),
];

/** 一月说最烦打电话（供应商），四月和妈打电话聊得挺开心，七月又说不爱打电话（客户） */
const PHONE: EvidenceDraft[] = [
  say("ev-p1", "供应商又打电话来催交期，我最烦打电话了。", "2026-01-20T16:20:00+08:00", { context: ["workday"] }),
  say("ev-p2", "晚上跟我妈打电话，聊了四十分钟，聊得挺开心。", "2026-04-16T21:30:00+08:00", { context: ["workday"] }),
  say("ev-p3", "客户又拉了个电话会，我是真不爱打电话。", "2026-07-22T17:40:00+08:00", { context: ["workday"] }),
];

/** 334b：矛盾那一路的问题问的是哪两条事实（key 是 contradiction:<先说的>|<后说的>） */
const pairOf = (d: { key: string }) => d.key.slice("contradiction:".length).split("|");

function rootGroupOf(engine: MemoryEngine, prefix: string): string {
  const g = engine.rg.registry.listGroups().find((x) => x.key.startsWith(`conflict_root|${prefix}`));
  if (!g) throw new Error(`没有 ${prefix} 的根源组`);
  return g.key;
}

describe("矛盾根源（用户选 A：不豁免铁律）", () => {
  it("琢磨出来的根源（从图上的关系补出场景）证据再多也只当猜测：不定根源、不改事实；同一处矛盾只问'现在更接近哪个'（334b）；你答了才定、才改事实", async () => {
    const t = openEngine(NOW);
    for (const d of PHONE) t.engine.ingestEvidence(d);
    const report = await t.engine.reflect();
    const key = rootGroupOf(t.engine, "flip_flop|");
    for (const m of t.engine.rg.registry.members(key)) expect(claimOf(t.engine, m.claimId).status).toBe("contested");
    expect(report.joint?.writebacks.applied).toEqual([]);
    const p2 = t.engine.store.factsByEvidence("ev-p2").find((f) => f.predicate === "prefers")!;
    expect(p2.context).toEqual(["workday"]);
    const scene = t.engine.rg.registry.members(key).find((m) => m.template === "root:scene_differs")!;
    const question = t.engine.listQuestions().find((q) => q.targets.some((x) => x.id === scene.claimId) || q.answers.yes.supports.includes(scene.claimId) || q.answers.no.supports.includes(scene.claimId));
    // 334b（用户 10-27）：根源组的两边正是事实层还拿不准的那几句，同一处矛盾只留"现在更接近哪个"，根源的追问不另出问题
    expect(question).toBeUndefined();
    expect(t.engine.listQuestions({ status: "open" })).toEqual([]);
    const sides = t.engine.rg.registry.getGroup(key)!.params as { sideA: string[]; sideB: string[] };
    const { drafts, dropped } = generateQuestions(t.engine.rg, NOW);
    expect(drafts.length).toBeGreaterThan(0);
    expect(drafts.every((d) => d.kind === "contradiction")).toBe(true);
    expect(drafts.some((d) => pairOf(d).some((id) => sides.sideA.includes(id)) && pairOf(d).some((id) => sides.sideB.includes(id)))).toBe(true);
    expect(dropped.filter((d) => d.reason.includes("同一处矛盾只留那一个问题")).length).toBeGreaterThan(0);
    // 你确认"场景不同"：定了根源，下一次整理照它改事实（补场景）
    t.engine.ingestEvidence(say("ev-yes", "对，跟家里人打电话我不烦，烦的是工作电话", "2026-10-20T10:00:00+08:00"));
    t.engine.rg.confirmClaim(scene.claimId, "ev-yes");
    expect(claimOf(t.engine, scene.claimId).status).toBe("active");
    const again = await t.engine.reflect();
    expect(again.joint?.writebacks.applied).toHaveLength(1);
    expect(checkReasoningGraph(t.engine.store).problems).toEqual([]);
    expect(t.engine.rg.writeback.list().map((w) => w.root)).toEqual(["scene_differs"]);
    expect(t.engine.store.getFact(p2.id)!.context).toEqual(["workday", "family"]);
  });

  it("事实本身写清了场合（两边的场景标签其实对不上）→ 直接把事实改成不冲突（留痕、能撤回），不建根源猜测", async () => {
    const t = openEngine(NOW);
    for (const d of TRAIN) t.engine.ingestEvidence(d);
    await t.engine.reflect();
    const f1 = t.engine.store.factsByEvidence("ev-t1").find((f) => f.predicate === "participated_in")!;
    expect(f1.status).toBe("contested");
    // 用户在别处补清了场合：ev-t1 那条其实是假期出去玩（不是出差）——事实自己带的场景标签和另一边（工作、旅行）对不上了
    t.engine.store.updateFact(f1.id, { context: ["holiday", "leisure"] }, { reason: "测试：场景补清了" });
    // 下一次整理（有新素材）
    t.engine.ingestEvidence(say("ev-x", "中午吃了碗牛肉面。", "2026-10-19T12:00:00+08:00"));
    await t.engine.reflect();
    expect(t.engine.store.getFact(f1.id)!.status).toBe("active");
    expect(t.engine.store.revisions(f1.id, "fact").at(-1)!.reason).toContain("事实本身");
  });
});
