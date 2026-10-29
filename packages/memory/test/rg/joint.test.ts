// 199 号票：知识图谱和推理图谱联动。例子都是自己写的（不看 fixtures/truth-kg）：
// 对比模式找"三次推掉都是同一个人约的"、真冲突按证据定根源并写回、说的和做的不一样两条都保留标 gap、
// 价值观能解释两边时"更深的需求"胜出、观点来回变其实是场景不同、重复跑不重复写、查不清的进问题队列。
// 330 号票（用户 10-27 选 A）：矛盾根源不豁免铁律——根源判断是琢磨出来的，证据再领先也只当猜测、不写回，要用户亲口确认了才定、
// 才写回（下面"胜出"的几条都先是猜测，确认以后才写回）。R14：说的和做的对不上，两边先互相记一笔 gap，明说的那条先当猜测。

/** 用户亲口确认这条根源（表态"对"），再来一条无关的话让整理不跳过，整理一次 */
async function confirmRoot(t: { engine: MemoryEngine }, claimId: string) {
  t.engine.recordClaimVerdict(claimId, "confirm", { note: "测试：用户说就是这个原因" });
  t.engine.ingestEvidence(say("ev-yes-x", "中午吃了碗牛肉面。", "2026-10-19T12:00:00+08:00", { context: ["food"] }));
  return t.engine.reflect();
}
import { afterEach, describe, expect, it } from "vitest";
import type { Claim, EvidenceDraft } from "../../src/domain/types.ts";
import type { MemoryEngine } from "../../src/engine.ts";
import type { KnowYouQuestion } from "../../src/rg/joint.ts";
import { closeEngines, openEngine, say } from "./helpers.ts";

afterEach(closeEngines);

const did = (id: string, text: string, at: string, context: string[] = []): EvidenceDraft => say(id, text, at, { mode: "do", kind: "action", context });
const NOW = "2026-10-20T12:00:00+08:00";

async function reflected(drafts: EvidenceDraft[], options: Parameters<typeof openEngine>[1] = {}) {
  const t = openEngine(NOW, options);
  for (const d of drafts) t.engine.ingestEvidence(d);
  const report = await t.engine.reflect();
  return { ...t, report };
}

function member(engine: MemoryEngine, groupKey: string, template: string): Claim {
  const m = engine.rg.registry.members(groupKey).find((x) => x.template === template);
  if (!m) throw new Error(`${groupKey} 里没有 ${template}`);
  return engine.store.getClaim(m.claimId)!;
}

function rootGroup(engine: MemoryEngine, prefix: string): string {
  const g = engine.rg.registry.listGroups().find((x) => x.key.startsWith(`conflict_root|${prefix}`));
  if (!g) throw new Error(`没有 ${prefix} 的根源组：${engine.rg.registry.listGroups().map((x) => x.key).join("、")}`);
  return g.key;
}

const factOfEvidence = (engine: MemoryEngine, evidenceId: string, predicate: string) => {
  const f = engine.store.factsByEvidence(evidenceId).find((x) => x.predicate === predicate);
  if (!f) throw new Error(`${evidenceId} 没有 ${predicate}`);
  return f;
};

// ---------- 对比模式 ----------

/** 老王（也叫王哥）约的三次都推了；同样的聚餐、羽毛球换个人约他就去了 */
const INVITES: EvidenceDraft[] = [
  did("ev-d1", "隔壁组老王（组里都叫他王哥）上周一在部门群里约这周五晚上吃火锅。用户没接龙，回他：“下回吧。”", "2026-03-06T10:00:00+08:00", ["workday", "social"]),
  did("ev-a1", "刘姐上周三在部门群里约了这周五晚上吃烤鱼。用户报了名，当晚去了。", "2026-03-13T22:00:00+08:00", ["workday", "social"]),
  did("ev-d2", "王哥周三在部门群里约这周六上午打羽毛球。用户回他：“这周脚不舒服，就不去了。”", "2026-03-20T21:00:00+08:00", ["weekend", "social"]),
  did("ev-a2", "小许周一在部门群里约了这周六上午打羽毛球。用户报了名，打了两个钟头。", "2026-03-28T12:00:00+08:00", ["weekend", "social"]),
  did("ev-d3", "老王上周四在部门群里约这周五晚上去吃串串。用户没接龙，回：“这周有点累，下次一定。”", "2026-04-09T18:00:00+08:00", ["workday", "social"]),
  did("ev-a3", "阿珂上周五就约了这周五晚上去听现场，用户当时就答应了，当晚去了。", "2026-04-17T22:00:00+08:00", ["workday", "social"]),
  did("ev-a4", "表姐周三就打电话约这周日中午去她家吃饭，用户当时就说好，周日去了。", "2026-04-26T14:00:00+08:00", ["weekend", "family"]),
];

describe("找隐蔽的联系：对比模式", () => {
  it("三次推掉都是同一个人约的（一次用的是别名）、同样的活动换个人约就去了 → 一组竞争假设：和组织者有关 / 和活动类型、时间段……有关 / 各有各的原因", async () => {
    const { engine, report } = await reflected(INVITES);
    const wang = engine.store.findEntityByName("老王")!;
    const key = `contrast|organizer|${wang.id}`;
    expect(report.joint?.motifGroups).toEqual([key]);
    const group = engine.rg.registry.getGroup(key)!;
    expect(group.observationIds).toHaveLength(3);
    const templates = engine.rg.registry.members(key).map((m) => m.template);
    expect(templates[0]).toBe("contrast:organizer");
    expect(templates).toEqual(expect.arrayContaining(["alt:type", "alt:slot", "alt:coincidence"]));
    // 对照（刘姐约的烤鱼、小许约的羽毛球）是强支持，"和组织者有关"领先、成立
    const motif = member(engine, key, "contrast:organizer");
    expect(motif.status).toBe("active");
    const strong = engine.store.linksOf(motif.id).filter((l) => l.weight === "strong").map((l) => engine.store.getFact(l.target)!.evidenceIds[0]);
    expect(strong.toSorted()).toEqual(["ev-a1", "ev-a2"]);
    for (const t of templates.slice(1)) expect(member(engine, key, t).status).not.toBe("active");
    // 每条备择都有一条能区分的追问（问具体的事）
    expect(engine.rg.registry.probesOf(key)).toHaveLength(templates.length - 1);
    // 联动的结果：值带着别名
    const summary = engine.jointSummary();
    expect(summary.motifs).toHaveLength(1);
    expect(summary.motifs[0]).toMatchObject({ dimension: "organizer", status: "active", declinedEvidenceIds: ["ev-d1", "ev-d2", "ev-d3"], controlEvidenceIds: ["ev-a1", "ev-a2"] });
    expect(summary.motifs[0]!.valueNames).toEqual(expect.arrayContaining(["老王", "王哥"]));
  });

  it("Q2：推掉的两次被忘掉、对比不明显了，这组这次没再出来（没有推翻者）→ 组撤下，组里的结论不撤：留成猜测、降把握，前提照挂", async () => {
    const { engine } = await reflected(INVITES);
    const wang = engine.store.findEntityByName("老王")!;
    const key = `contrast|organizer|${wang.id}`;
    const before = engine.rg.registry.members(key).map((m) => engine.store.getClaim(m.claimId)!);
    engine.invalidateEvidence("ev-d2", "用户说忘掉");
    engine.invalidateEvidence("ev-d3", "用户说忘掉");
    await engine.reflect();
    expect(engine.rg.registry.getGroup(key)!.live).toBe(false);
    const rank = { low: 0, medium: 1, high: 2 } as const;
    // "和组织者有关"有不靠这组观察的对照（刘姐、小许约的就去了）直接证实（R7），不动
    const direct = before.filter((c) => engine.rg.hasDirectBasis(c.id));
    expect(direct.map((c) => c.id)).toEqual([member(engine, key, "contrast:organizer").id]);
    expect(engine.store.getClaim(direct[0]!.id)!.status).toBe("active");
    const guesses = before.filter((c) => !engine.rg.hasDirectBasis(c.id));
    expect(guesses.length).toBeGreaterThan(0);
    for (const was of guesses) {
      const now = engine.store.getClaim(was.id)!;
      expect(now).toMatchObject({ status: "contested", retractedBy: null, needsReview: false });
      expect(rank[now.confidence]).toBeLessThanOrEqual(Math.max(0, rank[was.confidence] - 1));
      expect(engine.store.inferencesOf(was.id).find((i) => i.status === "active")!.premiseIds).toEqual(engine.rg.registry.getGroup(key)!.observationIds);
      expect(engine.store.revisions(was.id, "claim").some((r) => r.changes.status?.to === "retracted")).toBe(false);
    }
  });

  it("没有去了的邀约就没有对比；只推了一次的值不算", async () => {
    const { engine } = await reflected(INVITES.filter((d) => d.id!.startsWith("ev-d")));
    expect(engine.jointSummary().motifs).toEqual([]);
    const { engine: e2 } = await reflected(INVITES.filter((d) => d.id !== "ev-d2" && d.id !== "ev-d3"));
    expect(e2.jointSummary().motifs).toEqual([]);
  });

  it("关掉联动（joint: false）就没有这几组", async () => {
    const { engine, report } = await reflected(INVITES, { joint: false });
    expect(report.joint).toBeUndefined();
    expect(engine.rg.registry.listGroups().some((g) => g.pattern === "contrast" || g.pattern === "conflict_root")).toBe(false);
  });
});

// ---------- 矛盾追根溯源 ----------

/** 说差点没赶上高铁（照字面抽成没坐上），另一次说坐了、报销里车票已检票 */
const TRAIN: EvidenceDraft[] = [
  say("ev-t1", "今天去杭州见客户，早上差点没赶上八点那班高铁。", "2026-05-06T21:00:00+08:00", { context: ["workday", "work", "travel"] }),
  say("ev-t2", "上周三坐八点那班高铁去的杭州，车上睡了一觉。", "2026-05-06T08:00:00+08:00", { observedAt: "2026-05-11T12:00:00+08:00", context: ["work", "travel"] }),
  did("ev-t3", "用户提交了差旅报销，附件里有一张 5 月 6 日 08:00 开往杭州东的高铁票，状态是已检票。", "2026-05-08T10:00:00+08:00", ["work", "travel"]),
];

describe("矛盾追根溯源：真冲突", () => {
  // 329 号票：这组根源假设的前提就是那几条拿不准（真冲突）的事实，支持"记错了"的两条证据也正是这几条事实的原话——照传播铁律（R4）
  // 只能是猜测，没有不靠前提的独立证据就到不了已验证，写回（199）也就不发生。照规矩办还是给矛盾根源豁免，等用户定（329 票 Comments 的 Q3）；
  // 这里断言的是照规矩办的样子
  it("同一天坐没坐上高铁对不上 → 五种根源的竞争假设、各带追问；前提都是拿不准的事实，五条都是猜测，判不出胜者，不写回", async () => {
    const { engine, report } = await reflected(TRAIN);
    const key = rootGroup(engine, "contested|");
    expect(engine.rg.registry.members(key).map((m) => m.template)).toEqual(["root:misrecorded", "root:changed_over_time", "root:scene_differs", "root:say_do_gap", "root:deeper_need"]);
    for (const m of engine.rg.registry.members(key)) expect(engine.store.getClaim(m.claimId)!.status).toBe("contested");
    expect(engine.rg.registry.probesOf(key).map((p) => p.template)).toEqual(["check_wording", "check_time", "check_scene", "check_constraint", "check_need"]);
    expect(report.joint?.writebacks.applied).toEqual([]);
    for (const id of ["ev-t1", "ev-t2", "ev-t3"]) expect(factOfEvidence(engine, id, "participated_in").status).toBe("contested");
    expect(engine.jointSummary().conflicts.find((c) => c.key === key)).toMatchObject({ source: "rg", trigger: "contested", winner: null, writeback: null });
  });

  it("另两条证据被忘掉以后矛盾不在了：这组撤下，没有推翻者（Q2）→ 组里的根源假设不撤、留成猜测（把握 low），那条事实恢复成立", async () => {
    const { engine } = await reflected(TRAIN);
    const wrong = factOfEvidence(engine, "ev-t1", "participated_in");
    engine.invalidateEvidence("ev-t2", "用户说忘掉");
    engine.invalidateEvidence("ev-t3", "用户说忘掉");
    await engine.reflect();
    const key = rootGroup(engine, "contested|");
    expect(engine.rg.registry.getGroup(key)!.live).toBe(false);
    for (const m of engine.rg.registry.members(key)) expect(engine.store.getClaim(m.claimId)).toMatchObject({ status: "contested", retractedBy: null, confidence: "low" });
    expect(engine.store.getFact(wrong.id)).toMatchObject({ status: "active", contestedWith: [] });
    expect(engine.rg.writeback.list({ all: true })).toEqual([]);
  });
});

/** 说下礼拜起每天跑步，手环一次没记录；那几天天天加班；后来又说等版本发了要天天跑 */
const RUNNING: EvidenceDraft[] = [
  say("ev-r1", "下礼拜起我每天早上六点起来跑五公里，闹钟都定好了。", "2026-05-10T21:30:00+08:00", { context: ["exercise"] }),
  say("ev-r2", "这礼拜天天加班到一两点，早上根本起不来。", "2026-05-14T23:50:00+08:00", { context: ["workday", "work"] }),
  did("ev-r3", "这周用户每天都是八点以后才起，手环里一条跑步记录也没有。", "2026-05-15T20:00:00+08:00", ["workday", "exercise"]),
  say("ev-r4", "端午去江边跑了五公里，舒服。等这个版本发了，我要天天这么跑。", "2026-06-19T07:40:00+08:00", { context: ["holiday", "exercise"] }),
  did("ev-r5", "这周工作日用户每天七点多才起，手环里一条跑步记录也没有。", "2026-06-26T20:00:00+08:00", ["workday", "exercise"]),
];

describe("矛盾追根溯源：说的和做的不一样", () => {
  it("说要每天跑、行为一再没跑，那段时间天天加班、说的时候带着\"等……了\" → \"说的和做的不一样\"证据领先，可只当猜测、不写回；两边先互相记一笔 gap（R14），明说的那条是猜测；你确认了 → 写回标 gap、明说的恢复已验证", async () => {
    const t = await reflected(RUNNING);
    const { engine, report } = t;
    const key = rootGroup(engine, "say_do|");
    const winner = member(engine, key, "root:say_do_gap");
    expect(winner.status).toBe("contested");
    expect(report.joint?.writebacks.applied).toEqual([]);
    // 后来又说了一遍要跑：不是观点变了
    const changed = member(engine, key, "root:changed_over_time");
    expect(engine.store.linksOf(changed.id).some((l) => l.polarity === "refutes" && l.weight === "strong")).toBe(true);
    const stated = factOfEvidence(engine, "ev-r1", "prefers");
    const did1 = factOfEvidence(engine, "ev-r3", "participated_in");
    expect([stated.status, did1.status]).toEqual(["active", "active"]);
    // R14：发现的时候就记一笔（ref 是这个矛盾），哪边都不自动赢——明说的"喜欢跑步"成了猜测、标着复核
    const conflictKey = key.slice("conflict_root|".length);
    expect(engine.factMarks(stated.id)).toEqual([expect.objectContaining({ kind: "gap", ref: conflictKey, detail: expect.objectContaining({ with: expect.arrayContaining([did1.id]) }) })]);
    expect(engine.factMarks(did1.id).map((m) => m.kind)).toEqual(["gap"]);
    const statedClaim = engine.rg.registry.explicitClaimOf(stated.id)!;
    expect(engine.store.getClaim(statedClaim)).toMatchObject({ status: "contested", needsReview: true });
    // 你确认"就是说的和做的不一样"：根源定了，写回标 gap（ref 是这条根源），明说的那条回到已验证
    const again = await confirmRoot(t, winner.id);
    expect(engine.store.getClaim(winner.id)!.status).toBe("active");
    expect(again.joint?.writebacks.applied).toHaveLength(1);
    expect(engine.factMarks(stated.id).map((m) => m.ref)).toContain(winner.id);
    expect(engine.store.revisions(stated.id, "fact").some((r) => r.reason.includes("标 gap"))).toBe(true);
    expect(engine.store.getClaim(statedClaim)).toMatchObject({ status: "active", needsReview: false });
  });
});

/** 周末、工作日都在回避被别人排满（195 号票的例子，需求层成立）；另外说过挺喜欢聚餐，之后又两次推了周六的聚餐 */
const AUTONOMY: EvidenceDraft[] = [
  say("ev-n0", "我挺喜欢跟朋友聚餐的", "2026-08-01T10:00:00+08:00"),
  say("ev-n1", "周六的聚餐我不去了", "2026-08-08T10:00:00+08:00", { context: ["weekend", "social"] }),
  say("ev-n2", "周日的生日会推掉了", "2026-08-16T10:00:00+08:00", { context: ["weekend", "social"] }),
  say("ev-n3", "我不喜欢周末被提前排满", "2026-09-05T10:00:00+08:00", { context: ["weekend"] }),
  say("ev-n7", "这周六的聚餐又推了", "2026-09-12T10:00:00+08:00", { context: ["weekend", "social"] }),
  say("ev-n4", "推掉了周三的临时会议", "2026-10-07T10:00:00+08:00", { context: ["workday", "work"] }),
  say("ev-n5", "拒绝了周四晚上的加班安排", "2026-10-08T10:00:00+08:00", { context: ["workday", "work"] }),
  say("ev-n6", "我不喜欢工作日也被提前排满", "2026-10-09T10:00:00+08:00", { context: ["workday"] }),
];

describe("矛盾追根溯源：价值观能解释两边", () => {
  it("说喜欢聚餐、又一再推掉周六的聚餐；成立的需求\"重视自主安排\"推出它的证据里就有这几次推掉，适用领域也对得上聚餐 → \"更深的需求\"证据领先、只当猜测；你确认了才两边关联到那条需求", async () => {
    const t = await reflected(AUTONOMY);
    const { engine } = t;
    const need = member(engine, "lift:need|autonomy", "need_autonomy");
    expect(need.status).toBe("active");
    const key = rootGroup(engine, "say_do|");
    const winner = member(engine, key, "root:deeper_need");
    expect(winner.status).toBe("contested");
    expect(winner.statement).toContain(need.statement);
    for (const x of ["root:say_do_gap", "root:misrecorded", "root:changed_over_time", "root:scene_differs"]) expect(member(engine, key, x).status).toBe("contested");
    const stated = factOfEvidence(engine, "ev-n0", "prefers");
    expect(engine.factMarks(stated.id).map((m) => m.kind)).not.toContain("explained_by");
    await confirmRoot(t, winner.id);
    expect(engine.store.getClaim(winner.id)!.status).toBe("active");
    // R14 那一笔（说的和做的对不上）留着，加上"由那条需求解释"
    expect(engine.factMarks(stated.id).filter((m) => m.kind === "explained_by")).toEqual([expect.objectContaining({ kind: "explained_by", ref: need.id })]);
    expect(engine.factMarks(stated.id).map((m) => m.kind).toSorted()).toEqual(["explained_by", "gap"]);
    expect(engine.store.linksOf(need.id).filter((l) => l.polarity === "context").map((l) => l.target)).toEqual(expect.arrayContaining(["ev-n0"]));
  });
});

/** 一月说最烦打电话（供应商），四月和妈打电话聊得挺开心，七月又说不爱打电话（客户）：188 按日子先后判成两次观点变化 */
const PHONE: EvidenceDraft[] = [
  say("ev-p1", "供应商又打电话来催交期，我最烦打电话了。", "2026-01-20T16:20:00+08:00", { context: ["workday"] }),
  say("ev-p2", "晚上跟我妈打电话，聊了四十分钟，聊得挺开心。", "2026-04-16T21:30:00+08:00", { context: ["workday"] }),
  say("ev-p3", "客户又拉了个电话会，我是真不爱打电话。", "2026-07-22T17:40:00+08:00", { context: ["workday"] }),
];

describe("矛盾追根溯源：观点来回变其实是场景不同", () => {
  it("喜欢 → 不喜欢 → 又喜欢、场景标签对得上 → 根源假设；从图上的关系补出场景（妈 → 家里，供应商、客户 → 工作）以后对不上 → \"场景不同\"证据领先、只当猜测；你确认了才写回补场景、恢复被\"观点变化\"取代的事实", async () => {
    const t = await reflected(PHONE);
    const { engine, report } = t;
    const key = rootGroup(engine, "flip_flop|");
    const scene = member(engine, key, "root:scene_differs");
    expect(scene.status).toBe("contested");
    expect(member(engine, key, "root:changed_over_time").status).toBe("contested");
    expect(report.joint?.writebacks.applied).toEqual([]);
    await confirmRoot(t, scene.id);
    expect(engine.store.getClaim(scene.id)!.status).toBe("active");
    const p1 = factOfEvidence(engine, "ev-p1", "dislikes");
    const p2 = factOfEvidence(engine, "ev-p2", "prefers");
    expect(p2).toMatchObject({ status: "active", supersededBy: null, validTo: null });
    expect(p2.context).toEqual(["workday", "family"]);
    expect(p1).toMatchObject({ status: "active", supersededBy: null, validTo: null });
    expect(p1.context).toEqual(["workday", "work"]);
    expect(p2.statement).toContain("家里");
    // 明说的断言跟着事实走
    const claimId = engine.rg.registry.explicitClaimOf(p2.id)!;
    expect(engine.store.getClaim(claimId)).toMatchObject({ status: "active", context: ["workday", "family"] });
  });
});

// ---------- 幂等、问题队列 ----------

describe("重复跑不重复写", () => {
  it("再整理一次（有新的无关证据、或者从头再整理）：写回、标记、组、断言都不多写", async () => {
    const { engine } = await reflected([...TRAIN, ...RUNNING]);
    const snapshot = () => ({
      writebacks: engine.store.revisions().filter((r) => r.reason.startsWith("写回")).length,
      marks: engine.rg.writeback.marks.list({ all: true }).length,
      groups: engine.rg.registry.listGroups().length,
      claims: engine.store.listClaims().length,
      rows: engine.rg.writeback.list({ all: true }).length,
    });
    const before = snapshot();
    engine.ingestEvidence(say("ev-x", "中午吃了碗牛肉面。", "2026-10-19T12:00:00+08:00", { context: ["food"] }));
    const again = await engine.reflect();
    expect(again.joint?.writebacks).toEqual({ applied: [], reverted: [] });
    expect(snapshot()).toEqual(before);
    await engine.reflect({ since: "ev-r1" });
    expect(snapshot()).toEqual(before);
  });
});

describe("查不清的进\"了解你问题\"的队列", () => {
  it("说在找工作、两次推掉面试，没有约束的证据、也没有成立的需求能解释 → 分不出，进队列（钩子每个问题收到一次），再整理不重复进", async () => {
    const received: KnowYouQuestion[] = [];
    const t = openEngine(NOW);
    t.engine.setQuestionSink({ onQuestion: (q) => received.push(q) });
    for (const d of [
      say("ev-j1", "我在投简历了，这礼拜面了两家。", "2026-03-10T22:00:00+08:00", { context: ["work"] }),
      did("ev-j2", "上海一家公司约用户二面。用户回：“不好意思，这个机会先不考虑了。”", "2026-04-02T15:00:00+08:00", ["work"]),
      did("ev-j3", "深圳一家公司约用户终面。用户回：“先不考虑了。”", "2026-05-22T18:00:00+08:00", ["work"]),
    ])
      t.engine.ingestEvidence(d);
    await t.engine.reflect();
    const key = rootGroup(t.engine, "say_do|");
    expect(t.engine.rg.registry.members(key).every((m) => t.engine.store.getClaim(m.claimId)!.status !== "active")).toBe(true);
    // 207：一条能区分的追问一个问题（照 198 的格式），都属于这一组
    expect(received.length).toBeGreaterThan(1);
    for (const q of received) {
      expect(q).toMatchObject({ groupKey: key, kind: "conflict_root" });
      expect(q.ask.length).toBeGreaterThan(0);
      expect(q.priority).toBeGreaterThan(0);
    }
    expect(t.engine.knowYouQuestions().map((q) => q.key)).toEqual(received.map((q) => q.key));
    const n = received.length;
    t.engine.ingestEvidence(say("ev-x", "中午吃了碗牛肉面。", "2026-10-19T12:00:00+08:00"));
    await t.engine.reflect();
    expect(received).toHaveLength(n);
  });
});
