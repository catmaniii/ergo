// 195 号票：规则版的需求、价值层通用规则。例子都是自己写的（不看 fixtures/truth）。
import { afterEach, describe, expect, it } from "vitest";
import { addDays } from "../../src/domain/time.ts";
import type { Claim, EvidenceDraft } from "../../src/domain/types.ts";
import type { MemoryEngine } from "../../src/engine.ts";
import { hasDisjointScenes, hasDisjointScenesStrict, scenesDiffer } from "../../src/rg/lift.ts";
import { mergeScenes } from "../../src/rg/llm-lift.ts";
import type { LiftInput } from "../../src/rg/types.ts";
import { closeEngines, explicitClaimOf, factOf, openEngine, say } from "./helpers.ts";

afterEach(closeEngines);

const WEEKEND = { context: ["weekend", "social"] };
const WORKDAY = { context: ["workday", "work"] };

/** 周末两次推掉活动、说不喜欢周末被排满；工作日两次推掉会议和加班、说工作日也不喜欢被排满
 *  （229 号票：明说的那两句也带上方面标签——只差日型不算两种场合，跨场景要靠方面不同） */
function autonomyEvents(dates: { w1: string; w2: string; w3: string; d1: string; d2: string; d3: string }): EvidenceDraft[] {
  return [
    say("ev-1", "周六的聚餐我不去了", dates.w1, WEEKEND),
    say("ev-2", "周日的生日会推掉了", dates.w2, WEEKEND),
    say("ev-3", "我不喜欢周末被提前排满", dates.w3, WEEKEND),
    say("ev-4", "推掉了周三的临时会议", dates.d1, WORKDAY),
    say("ev-5", "拒绝了周四晚上的加班安排", dates.d2, WORKDAY),
    say("ev-6", "我不喜欢工作日也被提前排满", dates.d3, WORKDAY),
  ];
}

/** 8 月、9 月在周末，10 月在工作日：两种场景、三个月 */
const AUG_TO_OCT = {
  w1: "2026-08-08T10:00:00+08:00",
  w2: "2026-08-16T10:00:00+08:00",
  w3: "2026-09-05T10:00:00+08:00",
  d1: "2026-10-07T10:00:00+08:00",
  d2: "2026-10-08T10:00:00+08:00",
  d3: "2026-10-09T10:00:00+08:00",
};

const NEED = "lift:need|autonomy";
const VALUE = "lift:value|autonomy";

function member(engine: MemoryEngine, key: string, template: string): Claim {
  const m = engine.rg.registry.members(key).find((x) => x.template === template);
  if (!m) throw new Error(`${key} 里没有 ${template}`);
  return engine.store.getClaim(m.claimId)!;
}

async function crossScene(dates = AUG_TO_OCT) {
  const t = openEngine("2026-10-12T12:00:00+08:00");
  for (const e of autonomyEvents(dates)) t.engine.ingestEvidence(e);
  await t.engine.reflect();
  return t;
}

/** 223 号票：灌几条证据、整理一次，返回引擎和这次的报告 */
async function reflectStory(events: EvidenceDraft[]) {
  const t = openEngine("2026-10-12T12:00:00+08:00");
  for (const e of events) t.engine.ingestEvidence(e);
  const report = await t.engine.reflect();
  return { ...t, report };
}

describe("需求层：同一主题跨场景、跨时期成立才往上抽", () => {
  it("周末、工作日都在回避被别人排满（8 到 10 月）→ 需求层一组竞争假设：重视自主安排 / 近期整体负荷高 / 对活动本身没兴趣", async () => {
    const { engine } = await crossScene();
    const weekend = member(engine, "repeated_decline|weekend|social", "scene_autonomy");
    const workday = member(engine, "repeated_decline|workday|work", "scene_autonomy");
    expect([weekend.status, workday.status]).toEqual(["active", "active"]);
    const group = engine.rg.registry.getGroup(NEED)!;
    expect(group).toMatchObject({ live: true, pattern: "lift:need" });
    const stated = [explicitClaimOf(engine, factOf(engine, "ev-3", "dislikes")), explicitClaimOf(engine, factOf(engine, "ev-6", "dislikes"))];
    expect(group.observationIds.toSorted()).toEqual([weekend.id, workday.id, ...stated.map((c) => c.id)].toSorted());
    expect(engine.rg.registry.members(NEED).map((m) => m.template)).toEqual(["need_autonomy", "overall_load", "no_interest"]);
    const autonomy = member(engine, NEED, "need_autonomy");
    expect(autonomy).toMatchObject({ tier: "need", kind: "hypothesis", epistemic: "inferred", method: "induction", status: "active", confidence: "medium" });
    expect(autonomy.competesWith.toSorted()).toEqual([member(engine, NEED, "overall_load").id, member(engine, NEED, "no_interest").id].toSorted());
    // 推断是"结论 ← 这几条断言"，追溯一直到原话
    expect(engine.store.inferencesOf(autonomy.id)[0]!.premiseIds.toSorted()).toEqual(group.observationIds.toSorted());
    const trace = engine.tracePremises(autonomy.id);
    expect(trace.premises.every((p) => p.kind === "claim")).toBe(true);
    const leaves = (x: typeof trace): string[] => (x.premises.length === 0 ? [x.id] : x.premises.flatMap(leaves));
    // 329 号票（R7）：下层的"自主安排"各自被那句明说的话直接证实（不靠推掉活动那几条观察），依据改挂到明说的话上，
    // 推掉活动的那条推理链记作历史——前提链走现在的依据，追到的原话是两句明说的
    expect([...new Set(leaves(trace))].toSorted()).toEqual(["ev-3", "ev-6"]);
    expect(engine.store.inferencesOf(weekend.id).find((i) => i.status === "history")!.premiseIds.toSorted()).toEqual(engine.rg.registry.getGroup("repeated_decline|weekend|social")!.observationIds.toSorted());
    // 两条明说的话对"重视自主安排"是强支持；"近期负荷"被时间跨度反驳；"没兴趣"被"问题在被排满"反驳
    expect(engine.store.linksOf(autonomy.id).filter((l) => l.weight === "strong").map((l) => l.target).toSorted()).toEqual([factOf(engine, "ev-3", "dislikes").id, factOf(engine, "ev-6", "dislikes").id].toSorted());
    expect(engine.store.linksOf(member(engine, NEED, "overall_load").id).find((l) => l.polarity === "refutes")!.rationale).toMatch(/不像一阵子的负荷/);
    expect(member(engine, NEED, "no_interest").status).toBe("contested");
    // 每条都有判别性追问认领
    const probes = engine.rg.registry.probesOf(NEED).map((p) => engine.store.getProbe(p.probeId)!);
    for (const m of engine.rg.registry.members(NEED)) expect(probes.some((p) => p.discriminates.includes(m.claimId))).toBe(true);
  });

  it("用户模型：需求归在长期价值取向那一层，标推断的；价值层的组只覆盖两个月，两条都还拿不准", async () => {
    const { engine } = await crossScene();
    const autonomy = member(engine, NEED, "need_autonomy");
    const model = engine.getUserModel({});
    expect(model.values).toEqual([expect.objectContaining({ claimId: autonomy.id, tier: "need", label: "inferred", confidence: "medium" })]);
    expect(model.values[0]!.evidenceIds.toSorted()).toEqual(["ev-1", "ev-2", "ev-3", "ev-4", "ev-5", "ev-6"]);
    // 价值层：需求自己也跨三个月、两种场景，出了一组；证据只有两个月的跨度，"长期看重"和"现阶段"分不出来
    expect(engine.rg.registry.members(VALUE).map((m) => m.template)).toEqual(["value_enduring", "value_phase"]);
    expect(member(engine, VALUE, "value_enduring").status).toBe("contested");
    expect(model.uncertain.map((u) => u.claimId)).toContain(member(engine, VALUE, "value_enduring").id);
  });

  it("只在一个场景（都是周末）→ 不往上抽", async () => {
    const t = openEngine("2026-10-12T12:00:00+08:00");
    for (const e of autonomyEvents(AUG_TO_OCT).slice(0, 3)) t.engine.ingestEvidence(e);
    t.engine.ingestEvidence(say("ev-7", "周六的剧本杀也不去了", "2026-10-03T10:00:00+08:00", WEEKEND));
    await t.engine.reflect();
    expect(member(t.engine, "repeated_decline|weekend|social", "scene_autonomy").status).toBe("active");
    expect(t.engine.rg.registry.listGroups().filter((g) => g.pattern.startsWith("lift:"))).toEqual([]);
  });

  it("只有一个时期（都在 10 月）→ 不往上抽", async () => {
    const { engine } = await crossScene({
      w1: "2026-10-03T10:00:00+08:00",
      w2: "2026-10-04T10:00:00+08:00",
      w3: "2026-10-05T10:00:00+08:00",
      d1: "2026-10-07T10:00:00+08:00",
      d2: "2026-10-08T10:00:00+08:00",
      d3: "2026-10-09T10:00:00+08:00",
    });
    expect(member(engine, "repeated_decline|weekend|social", "scene_autonomy").status).toBe("active");
    expect(member(engine, "repeated_decline|workday|work", "scene_autonomy").status).toBe("active");
    expect(engine.rg.registry.getGroup(NEED)).toBeUndefined();
  });

  it("只有两条证据（周末、工作日各说了一次）→ 不往上抽", async () => {
    const t = openEngine("2026-10-12T12:00:00+08:00");
    t.engine.ingestEvidence(say("ev-3", "我不喜欢周末被提前排满", AUG_TO_OCT.w3, { context: ["weekend"] }));
    t.engine.ingestEvidence(say("ev-6", "我不喜欢工作日也被提前排满", AUG_TO_OCT.d3, { context: ["workday"] }));
    await t.engine.reflect();
    expect(t.engine.rg.registry.listGroups()).toEqual([]);
  });

  it("另一族：周末、工作日、假期都说喜欢爬山 → 稳定的兴趣 / 各场合各自的原因", async () => {
    const t = openEngine("2026-10-12T12:00:00+08:00");
    // 229 号票：三种场合靠方面不同（周末社交 / 工作 / 家里），只差日型不算两种
    t.engine.ingestEvidence(say("ev-a", "周末我喜欢去爬山", "2026-08-09T10:00:00+08:00", { context: ["weekend", "social"] }));
    t.engine.ingestEvidence(say("ev-b", "工作日晚上也喜欢去爬山", "2026-09-09T20:00:00+08:00", { context: ["workday", "work"] }));
    t.engine.ingestEvidence(say("ev-c", "放假也最喜欢爬山", "2026-10-02T10:00:00+08:00", { context: ["holiday", "family"] }));
    await t.engine.reflect();
    const group = t.engine.rg.registry.listGroups().find((g) => g.key.startsWith("lift:need|interest:"))!;
    expect(t.engine.rg.registry.members(group.key).map((m) => m.template)).toEqual(["stable_interest", "situational"]);
    expect(member(t.engine, group.key, "stable_interest")).toMatchObject({ tier: "need", status: "active", statement: expect.stringContaining("爬山") });
  });
});

describe("需求层：反证和失效", () => {
  // 330 号票（R14）：随口说的不再自动算决定性，要推翻得是用户的纠正（当面的、明确的）
  it("加入反证：用户纠正说喜欢别人定好的行程 → '重视自主安排'撤回留墓碑，价值层跟着撤回；剩下的仍分不出来", async () => {
    const t = await crossScene();
    const autonomy = member(t.engine, NEED, "need_autonomy");
    const enduring = member(t.engine, VALUE, "value_enduring");
    t.setNow("2026-10-13T12:00:00+08:00");
    t.engine.ingestEvidence(say("ev-7", "之前说的不对，假期我喜欢别人定好的行程", "2026-10-11T10:00:00+08:00", { kind: "correction", context: ["holiday"] }));
    await t.engine.reflect();
    const likes = factOf(t.engine, "ev-7", "prefers", "行程");
    expect(t.engine.store.getClaim(autonomy.id)).toMatchObject({ status: "retracted", retractedBy: likes.id });
    expect(t.engine.store.linksOf(autonomy.id).find((l) => l.target === likes.id)).toMatchObject({ polarity: "refutes", weight: "decisive" });
    expect(t.engine.rg.registry.getGroup(VALUE)!.live).toBe(false);
    expect(t.engine.store.getClaim(enduring.id)).toMatchObject({ status: "retracted", retractedBy: autonomy.id });
    // 只靠共有的观察，"近期负荷"不会因为对手被排除就成立
    expect(member(t.engine, NEED, "overall_load").status).toBe("contested");
    expect(t.engine.getUserModel({}).values).toEqual([]);
  });

  it("加入反证：这阵子又忙又累 → '重视自主安排'被削弱，和'近期整体负荷高'分不出来", async () => {
    const t = await crossScene();
    t.setNow("2026-10-13T12:00:00+08:00");
    t.engine.ingestEvidence(say("ev-8", "这阵子事情多，忙不过来", "2026-10-10T10:00:00+08:00", { context: ["work"] }));
    t.engine.ingestEvidence(say("ev-9", "最近太累了，天天加班", "2026-10-11T10:00:00+08:00", { context: ["work"] }));
    await t.engine.reflect();
    const load = member(t.engine, NEED, "overall_load");
    const busy = ["ev-8", "ev-9"].flatMap((id) => t.engine.store.factsByEvidence(id).filter((f) => f.predicate === "said_about" && !f.negated).map((f) => f.id));
    expect(busy).toContain(factOf(t.engine, "ev-8", "said_about", "忙").id);
    expect(t.engine.store.linksOf(load.id).filter((l) => l.weight === "strong" && l.polarity === "supports").map((l) => l.target).toSorted()).toEqual(busy.toSorted());
    expect(member(t.engine, NEED, "need_autonomy").status).toBe("contested");
    expect(t.engine.getUserModel({}).values).toEqual([]);
  });

  it("依赖的偏好被撤回（忘掉工作日那句话）→ 需求层、价值层立刻降成猜测（不静默成立），不进用户模型；reflect 后工作日那条还是猜测、照样能往上抽（R4），组还在、都是猜测", async () => {
    const { engine } = await crossScene();
    const lifted = [...engine.rg.registry.members(NEED), ...engine.rg.registry.members(VALUE)].map((m) => m.claimId);
    const stated = explicitClaimOf(engine, factOf(engine, "ev-6", "dislikes"));
    engine.invalidateEvidence("ev-6", "用户说忘掉");
    for (const id of lifted) expect(engine.store.getClaim(id)!.status).toBe("contested");
    const autonomy = member(engine, NEED, "need_autonomy");
    expect(engine.store.revisions(autonomy.id, "claim").filter((r) => r.changes.status?.to === "contested").at(-1)).toMatchObject({ causeEvidenceId: "ev-6" });
    // 价值层只经需求层依赖这句话（本来就还是猜测）：照样是猜测、保留，前提照挂在需求上
    for (const m of engine.rg.registry.members(VALUE)) {
      expect(engine.store.getClaim(m.claimId)!.status).toBe("contested");
      expect(engine.store.inferencesOf(m.claimId).find((i) => i.status === "active")!.premiseIds).toEqual([autonomy.id]);
    }
    expect(engine.getUserModel({}).values).toEqual([]);
    await engine.reflect();
    // 329 号票（R4）：工作日的"自主安排"没了明说那句的直接证实，退回推掉活动的推理链、是猜测；猜测也能往上抽，
    // 两种场合还在，组不撤；推出来的需求、价值都是猜测。不在了的那句明说的从前提里去掉（它撤回了），没去掉还活着的
    expect(engine.rg.registry.getGroup(NEED)!.live).toBe(true);
    for (const id of lifted) expect(engine.store.getClaim(id)).toMatchObject({ status: "contested", retractedBy: null });
    expect(engine.store.getClaim(stated.id)!.status).toBe("retracted");
    const workday = member(engine, "repeated_decline|workday|work", "scene_autonomy");
    expect(workday.status).toBe("contested");
    expect(engine.store.inferencesOf(autonomy.id).find((i) => i.status === "active")!.premiseIds.toSorted()).toEqual(
      [explicitClaimOf(engine, factOf(engine, "ev-3", "dislikes")).id, member(engine, "repeated_decline|weekend|social", "scene_autonomy").id, workday.id].toSorted(),
    );
  });

  it("依赖的偏好在 reflect 里被推翻（用户纠正说周六喜欢被排满）→ 需求层按 R8 连带撤回，修订日志里有", async () => {
    const t = await crossScene();
    const autonomy = member(t.engine, NEED, "need_autonomy");
    t.setNow("2026-10-13T12:00:00+08:00");
    t.engine.ingestEvidence(say("ev-7", "之前说的不对，周六我其实喜欢被提前排满", "2026-10-10T10:00:00+08:00", { kind: "correction", context: ["weekend"] }));
    await t.engine.reflect();
    expect(member(t.engine, "repeated_decline|weekend|social", "scene_autonomy").status).toBe("retracted");
    const statuses = t.engine.store.revisions(autonomy.id, "claim").flatMap((r) => (r.changes.status ? [r.changes.status.to] : []));
    // 下层那条被纠正推翻了，按 R8 连带撤回（撤回只留给真有推翻者的，Q2）。330 号票：纠正走的是"纠正"不是"改口"，明说的那条
    // 被纠正掉、不先经过一次降回猜测，所以修订里直接是撤回
    expect(statuses.at(-1)).toBe("retracted");
    // 墓碑指向被纠正掉的那条明说的"不喜欢被提前排满"（它是需求的前提之一，最先被推翻）
    expect(t.engine.store.getClaim(autonomy.id)!.retractedBy).toBe(explicitClaimOf(t.engine, factOf(t.engine, "ev-3", "dislikes")).id);
    expect(t.engine.rg.registry.getGroup(NEED)!.live).toBe(false);
  });
});

describe("价值层", () => {
  const MARCH_TO_OCT = { ...AUG_TO_OCT, w1: "2026-03-07T10:00:00+08:00", w2: "2026-03-15T10:00:00+08:00", w3: "2026-04-04T10:00:00+08:00" };

  it("需求跨了半年以上、两种场景 → '长期看重自主安排'成立，置信度最多 medium，标推断的", async () => {
    const { engine } = await crossScene(MARCH_TO_OCT);
    const enduring = member(engine, VALUE, "value_enduring");
    expect(enduring).toMatchObject({ tier: "value", status: "active", confidence: "medium", epistemic: "inferred", method: "induction" });
    expect(member(engine, VALUE, "value_phase").status).toBe("contested");
    const values = engine.getUserModel({}).values.map((e) => [e.tier, e.label]);
    expect(values).toEqual([
      ["need", "inferred"],
      ["value", "inferred"],
    ]);
  });

  it("只有用户确认过才标 user_confirmed；确认了置信度也最多 medium；别人转述的不能确认", async () => {
    const t = await crossScene(MARCH_TO_OCT);
    const enduring = member(t.engine, VALUE, "value_enduring");
    t.engine.ingestEvidence(say("ev-x", "同事说他就是喜欢什么都自己说了算", "2026-10-12T09:00:00+08:00", { sourceLevel: "untrusted" }));
    expect(() => t.engine.confirmClaim(enduring.id, "ev-x")).toThrow(/本人/);
    t.engine.ingestEvidence(say("ev-y", "对，我一直都很在意自己安排时间", "2026-10-12T10:00:00+08:00"));
    const confirmed = t.engine.confirmClaim(enduring.id, "ev-y");
    expect(confirmed).toMatchObject({ epistemic: "user_confirmed", method: "user_confirmation", confidence: "medium", status: "active" });
    expect(t.engine.store.linksOf(enduring.id).find((l) => l.target === "ev-y")).toMatchObject({ polarity: "supports", weight: "decisive" });
    expect(t.engine.getUserModel({}).values.find((e) => e.claimId === enduring.id)).toMatchObject({ label: "user_confirmed", confidence: "medium" });
  });
});

// 223 号票：往上抽的"两种场合"从"所有共享维度都无交集"放宽成"有一个维度不同"；
// 229 号票再收窄成只看"方面（domain）"维度：只差日型（周末/工作日/假期）或出行（出差/休假）不算两种。
// 老严格判定（双方都写了标签的维度全都无交集）只用来统计，不卡门槛。
describe("229：两种场合只看方面维度不同，严格判定只做统计", () => {
  const HOME_LEISURE = ["family", "leisure"];
  const HOME_WORK = ["family", "work"];
  /** 家里、休闲 和 家里、工作 两种场合（方面不同）：八月两条、九月一条，三个证据两个月 */
  const HOME_STORY: EvidenceDraft[] = [
    say("ev-h1", "我不喜欢在家里被提前排满", "2026-08-08T10:00:00+08:00", { context: HOME_LEISURE }),
    say("ev-h2", "我也讨厌家里被安排聚会", "2026-08-16T10:00:00+08:00", { context: HOME_LEISURE }),
    say("ev-h3", "我不喜欢家里给我安排的行程", "2026-09-06T10:00:00+08:00", { context: HOME_WORK }),
  ];
  /** 只差日型：周末、工作 和 工作日、工作，方面都是 work */
  const DAYTYPE_STORY: EvidenceDraft[] = [
    say("ev-t1", "我不喜欢被提前排满", "2026-08-08T10:00:00+08:00", { context: ["weekend", "work"] }),
    say("ev-t2", "我也讨厌被安排加班", "2026-08-16T10:00:00+08:00", { context: ["weekend", "work"] }),
    say("ev-t3", "我不喜欢被提前安排行程", "2026-09-06T10:00:00+08:00", { context: ["workday", "work"] }),
  ];

  it("「家里、休闲」vs「家里、工作」→ 两种（方面不同）；老严格判定不认", () => {
    expect(scenesDiffer(HOME_LEISURE, HOME_WORK)).toBe(true);
    expect(hasDisjointScenes([HOME_LEISURE, HOME_WORK])).toBe(true);
    expect(hasDisjointScenesStrict([HOME_LEISURE, HOME_WORK])).toBe(false);
  });

  it("只差日型不算两种：「周末、工作」vs「工作日、工作」、「周末」vs「工作日」", () => {
    expect(scenesDiffer(["weekend", "work"], ["workday", "work"])).toBe(false);
    expect(hasDisjointScenes([["weekend", "work"], ["workday", "work"]])).toBe(false);
    expect(scenesDiffer(["weekend"], ["workday"])).toBe(false);
    expect(scenesDiffer(["holiday"], ["workday"])).toBe(false);
    // 老严格判定照样认得出它们不相交，只是不再卡门槛
    expect(hasDisjointScenesStrict([["weekend", "work"], ["workday", "work"]])).toBe(true);
  });

  it("只差出行不算两种：「出差、工作」vs「假期、工作」、「出差、工作」vs「休假、工作」", () => {
    expect(scenesDiffer(["business_trip", "work"], ["holiday", "work"])).toBe(false);
    expect(scenesDiffer(["business_trip", "work"], ["vacation", "work"])).toBe(false);
    expect(scenesDiffer(["business_trip"], ["vacation"])).toBe(false);
  });

  it("「周末、社交」vs「工作日、工作」→ 两种（方面不同）；老严格判定也过", () => {
    const weekend = ["weekend", "social"];
    const workday = ["workday", "work"];
    expect(scenesDiffer(weekend, workday)).toBe(true);
    expect(hasDisjointScenes([weekend, workday])).toBe(true);
    expect(hasDisjointScenesStrict([weekend, workday])).toBe(true);
  });

  it("两边一样、被包含合并后只剩一组、有一边不限场合 → 都不算", () => {
    expect(scenesDiffer(["family"], ["family"])).toBe(false);
    expect(hasDisjointScenes([["family"], ["family"]])).toBe(false);
    const merged = mergeScenes([{ scenes: [["family"]] }, { scenes: [HOME_LEISURE] }] as unknown as LiftInput[]);
    expect(merged).toEqual([HOME_LEISURE]);
    expect(hasDisjointScenes(merged)).toBe(false);
    // 空场景（不限场合）和任何场景都不算两种
    expect(scenesDiffer([], HOME_LEISURE)).toBe(false);
    expect(scenesDiffer(HOME_LEISURE, [])).toBe(false);
    expect(scenesDiffer([], [])).toBe(false);
    expect(hasDisjointScenes([[], HOME_LEISURE])).toBe(false);
    expect(hasDisjointScenesStrict([[], HOME_LEISURE])).toBe(false);
  });

  it("不认得的标签：两边都没有方面时、集合不同才算；一边有方面标签不算", () => {
    expect(scenesDiffer(["办公室"], ["咖啡馆"])).toBe(true);
    expect(scenesDiffer(["办公室"], ["办公室"])).toBe(false);
    expect(scenesDiffer(["办公室", "weekend"], ["咖啡馆", "workday"])).toBe(true);
    expect(scenesDiffer(["办公室", "weekend"], ["weekend"])).toBe(false);
    expect(scenesDiffer(["办公室"], ["weekend"])).toBe(false);
    // 一边有方面标签、另一边只有不认得的标签：不算两种（不认得的标签只在两边都没有方面时比）
    expect(scenesDiffer(["办公室"], ["family"])).toBe(false);
    expect(scenesDiffer(["办公室", "family"], ["咖啡馆", "family"])).toBe(false);
  });

  it("两种方面不同的场合、两个月份、三条证据 → 规则版照样出需求层一组；老严格判定不过，统计记在 passedLoose", async () => {
    const { engine, report } = await reflectStory(HOME_STORY);
    const group = engine.rg.registry.getGroup(NEED)!;
    expect(group).toMatchObject({ live: true, pattern: "lift:need" });
    expect((group.params as { scenes: string[][] }).scenes).toEqual(expect.arrayContaining([HOME_LEISURE, HOME_WORK]));
    expect(report.stats!.lift).toMatchObject({ passed: 1, passedStrict: 0, passedLoose: 1 });
  });

  it("只差日型不算两种：周末、工作 和 工作日、工作 三条证据两个月 → 不出需求层一组", async () => {
    const { engine } = await reflectStory(DAYTYPE_STORY);
    expect(engine.rg.registry.getGroup(NEED)).toBeUndefined();
    expect(engine.rg.registry.listGroups().filter((g) => g.pattern.startsWith("lift:"))).toEqual([]);
  });

  it("门槛的月份、证据条数不受影响：同样的两种场合，只有一个月、或者只有两条证据 → 还是不出", async () => {
    const oneMonth = HOME_STORY.map((e) => ({ ...e, eventTime: "2026-08-08T10:00:00+08:00", observedAt: "2026-08-08T10:00:00+08:00" }));
    const a = await reflectStory(oneMonth);
    expect(a.engine.rg.registry.getGroup(NEED)).toBeUndefined();
    // 两个月份、两种场合，只有两条证据
    const b = await reflectStory([HOME_STORY[0]!, HOME_STORY[2]!]);
    expect(b.engine.rg.registry.getGroup(NEED)).toBeUndefined();
  });
});

describe("226：规则版往上抽也给每条解释拼一条预测，并记进预测账本", () => {
  it("需求、价值两层的解释都写明「接下来两周……」；成立的自主需求记一条（+14 天），还拿不准的不记", async () => {
    const { engine } = await crossScene();
    const autonomy = member(engine, NEED, "need_autonomy");
    expect(autonomy.predicts).toHaveLength(1);
    expect(autonomy.predicts[0]).toMatchObject({ outcome: "pending", evidenceIds: [] });
    expect(autonomy.predicts[0]!.claim).toContain("接下来两周");
    for (const template of ["overall_load", "no_interest"]) expect(member(engine, NEED, template).predicts[0]!.claim).toContain("接下来两周");
    expect(member(engine, VALUE, "value_enduring").predicts[0]!.claim).toContain("接下来两周");

    const open = engine.store.listPredictions({ status: "open" });
    expect(open.map((p) => p.claimId)).toEqual([autonomy.id]);
    expect(open[0]).toMatchObject({ predicts: autonomy.predicts[0]!.claim, madeAt: "2026-10-12T12:00:00+08:00", dueAt: "2026-10-26T12:00:00+08:00" });
  });

  it("价值层成立时也记一条，+30 天；同一结论再整理不会重复记", async () => {
    const MARCH_TO_OCT = { ...AUG_TO_OCT, w1: "2026-03-07T10:00:00+08:00", w2: "2026-03-15T10:00:00+08:00", w3: "2026-04-04T10:00:00+08:00" };
    const t = await crossScene(MARCH_TO_OCT);
    const enduring = member(t.engine, VALUE, "value_enduring");
    const open = t.engine.store.listPredictions({ status: "open" });
    expect(open.find((p) => p.claimId === enduring.id)).toMatchObject({ dueAt: addDays("2026-10-12T12:00:00+08:00", 30) });
    t.setNow("2026-10-13T12:00:00+08:00");
    t.engine.ingestEvidence(say("ev-9", "今天去公司开了个会", "2026-10-13T10:00:00+08:00", { context: ["workday", "work"] }));
    await t.engine.reflect();
    expect(t.engine.store.listPredictions({ claimId: enduring.id })).toHaveLength(1);
  });
});
