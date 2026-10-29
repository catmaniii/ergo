// 推理图谱：时间（观点变化、纠正、近期状态到期）、场景差异、证据不足时不下结论、纠正作为证据参与判定、另一个观察模式。规则版。
import { afterEach, describe, expect, it } from "vitest";
import { GENERIC_PROBE } from "../../src/rg/answer.ts";
import { claimOf, closeEngines, explicitClaimOf, factOf, openEngine, say, targets } from "./helpers.ts";

afterEach(closeEngines);

const WEEKEND_SOCIAL = { context: ["weekend", "social"] };

describe("证据不足时不下结论", () => {
  it("只拒绝过一次：不出竞争假设；问为什么时回答'不确定'，给出能区分的追问", async () => {
    const { engine } = openEngine("2026-10-20T12:00:00+08:00");
    engine.ingestEvidence(say("ev-4", "周六的聚餐我不去了", "2026-09-05T10:00:00+08:00", WEEKEND_SOCIAL));
    const report = await engine.reflect();
    expect(report.newClaimIds).toEqual([]);
    expect(engine.rg.registry.listGroups()).toEqual([]);
    const answer = await engine.answer("为什么我不想去聚餐？");
    expect(answer).toMatchObject({ route: "reasoning", certain: false });
    expect(answer.text).toMatch(/^不确定：证据不够/);
    expect(answer.text).toContain("［ev-4］");
    expect(answer.probes).toEqual([{ probeId: null, ask: GENERIC_PROBE }]);
  });

  it("简单的事实问题走检索：每句后面带证据 id；没找到就说不确定", async () => {
    const { engine } = openEngine("2026-10-20T12:00:00+08:00");
    engine.ingestEvidence(say("ev-1", "主动报名参加了周三晚上的技术交流会。", "2026-10-03T19:30:00+08:00", { mode: "do", kind: "action", context: ["workday", "work"] }));
    await engine.reflect();
    const found = await engine.answer("技术交流");
    expect(found).toMatchObject({ route: "retrieval", certain: true });
    expect(found.text).toMatch(/参加了技术交流［ev-1］/);
    const none = await engine.answer("杭州");
    expect(none).toMatchObject({ route: "retrieval", certain: false });
    expect(none.text).toMatch(/^不确定/);
  });
});

describe("时间：观点变化、纠正、近期状态到期", () => {
  it("观点变化：旧的明说断言被取代、到变化时为止，问'以前'还答得出", async () => {
    const { engine } = openEngine("2026-10-20T12:00:00+08:00");
    engine.ingestEvidence(say("ev-1", "我喜欢爬山", "2025-05-01T10:00:00+08:00", { context: ["weekend"] }));
    engine.ingestEvidence(say("ev-2", "现在不喜欢爬山了", "2026-09-01T10:00:00+08:00", { context: ["weekend"] }));
    await engine.reflect();
    const before = explicitClaimOf(engine, factOf(engine, "ev-1", "prefers", "爬山"));
    const after = explicitClaimOf(engine, factOf(engine, "ev-2", "dislikes", "爬山"));
    expect(before).toMatchObject({ status: "superseded", supersededBy: after.id, validTo: "2026-09-01T10:00:00+08:00", epistemic: "explicit", tier: "preference" });
    expect(after).toMatchObject({ status: "active", confidence: "high" });
    const then = engine.getUserModel({ at: "2025-06-01T00:00:00+08:00" });
    expect(then.preferences.map((e) => e.claimId)).toEqual([before.id]);
    const now = engine.getUserModel({});
    expect(now.preferences.map((e) => e.claimId)).toEqual([after.id]);
    expect(now.preferences[0]).toMatchObject({ label: "user_stated", evidenceIds: ["ev-2"] });
  });

  it("纠正（抽事实时）：旧的明说断言撤回、墓碑指向纠正的话，新的成立；每一步有修订", async () => {
    const t = openEngine("2026-10-02T12:00:00+08:00");
    t.engine.ingestEvidence(say("ev-1", "我喜欢爬山", "2026-10-01T10:00:00+08:00"));
    await t.engine.reflect();
    const old = explicitClaimOf(t.engine, factOf(t.engine, "ev-1", "prefers", "爬山"));
    t.setNow("2026-10-16T12:00:00+08:00");
    t.engine.ingestEvidence(say("ev-2", "记错了，我其实一直不喜欢爬山", "2026-10-15T10:00:00+08:00", { kind: "correction" }));
    await t.engine.reflect();
    expect(t.engine.store.getClaim(old.id)).toMatchObject({ status: "retracted", retractedBy: "ev-2" });
    const statuses = t.engine.store.revisions(old.id, "claim").flatMap((r) => (r.changes.status ? [r.changes.status.to] : []));
    // 329 号票：用户纠正 = 亲口否掉，当场撤（以前先转待复核、整理时才撤）
    expect(statuses).toEqual(["retracted"]);
    const fresh = explicitClaimOf(t.engine, factOf(t.engine, "ev-2", "dislikes", "爬山"));
    expect(fresh.status).toBe("active");
    expect(t.engine.getUserModel({}).preferences.map((e) => e.claimId)).toEqual([fresh.id]);
  });

  it("纠正（engine.correct）：依赖旧证据的断言当场撤回（用户亲口否掉）、不进用户模型，reflect 后还是撤回", async () => {
    const { engine } = openEngine("2026-10-20T12:00:00+08:00");
    engine.ingestEvidence(say("ev-1", "我喜欢爬山", "2026-10-01T10:00:00+08:00"));
    engine.ingestEvidence(say("ev-2", "上次说的不对", "2026-10-05T10:00:00+08:00", { kind: "correction" }));
    await engine.reflect();
    const claim = explicitClaimOf(engine, factOf(engine, "ev-1", "prefers", "爬山"));
    engine.correct("ev-1", "ev-2");
    expect(engine.store.getClaim(claim.id)).toMatchObject({ status: "retracted", retractedBy: "ev-2" });
    expect(engine.store.inferencesOf(claim.id)[0]!.status).toBe("retracted");
    expect(engine.getUserModel({}).preferences).toEqual([]);
    await engine.reflect();
    expect(engine.store.getClaim(claim.id)).toMatchObject({ status: "retracted", retractedBy: "ev-2" });
    expect(engine.store.inferencesOf(claim.id)[0]!.status).toBe("retracted");
  });

  it("近期状态到期：'这阵子太忙'14 天后不在快照里", async () => {
    const { engine } = openEngine("2026-10-02T12:00:00+08:00");
    engine.ingestEvidence(say("ev-3", "这阵子太忙了，天天加班", "2026-10-01T10:00:00+08:00", { context: ["work"] }));
    await engine.reflect();
    const state = explicitClaimOf(engine, factOf(engine, "ev-3", "said_about", "忙"));
    expect(state).toMatchObject({ tier: "state", validFrom: "2026-10-01T10:00:00+08:00", validTo: "2026-10-15T10:00:00+08:00" });
    expect(engine.getUserModel({ at: "2026-10-05T00:00:00+08:00" }).state.map((e) => e.claimId)).toEqual([state.id]);
    expect(engine.getUserModel({ at: "2026-10-20T00:00:00+08:00" }).state).toEqual([]);
  });
});

async function threeWeekendDeclines() {
  const t = openEngine("2026-09-21T12:00:00+08:00");
  t.engine.ingestEvidence(say("ev-4", "周六的聚餐我不去了", "2026-09-05T10:00:00+08:00", WEEKEND_SOCIAL));
  t.engine.ingestEvidence(say("ev-5", "周日朋友的生日会推掉了", "2026-09-13T10:00:00+08:00", WEEKEND_SOCIAL));
  t.engine.ingestEvidence(say("ev-6", "周六的剧本杀也不去了", "2026-09-20T10:00:00+08:00", WEEKEND_SOCIAL));
  await t.engine.reflect();
  return t;
}

describe("场景差异", () => {
  it("周末的偏好不推广到工作日：问工作日时不出现周末的假设；不限场景的'不喜欢社交'还在", async () => {
    const { engine } = await threeWeekendDeclines();
    const weekendOnly = [claimOf(engine, "scene_autonomy").id, claimOf(engine, "dislike_content").id];
    const workday = engine.getUserModel({ context: ["workday"] });
    const shown = [...workday.state, ...workday.preferences, ...workday.values, ...workday.uncertain].map((e) => e.claimId);
    for (const id of weekendOnly) expect(shown).not.toContain(id);
    expect(shown).toContain(claimOf(engine, "dislike_domain").id);
    const weekend = engine.getUserModel({ context: ["weekend"] });
    expect(weekend.uncertain.map((e) => e.claimId)).toEqual(expect.arrayContaining(weekendOnly));
  });
});

describe("纠正作为证据参与判定", () => {
  it("'记错了，那次聚餐我其实去了'：旧的拒绝被纠正，组按剩下的观察重算；纠正的话直接参加判定，多重升一档", async () => {
    const t = await threeWeekendDeclines();
    const { engine } = t;
    const members = engine.rg.registry.members("repeated_decline|weekend|social").map((m) => m.claimId);
    expect(members).toHaveLength(4);
    t.setNow("2026-09-26T12:00:00+08:00");
    engine.ingestEvidence(say("ev-7", "记错了，那次聚餐我其实去了", "2026-09-25T10:00:00+08:00", { ...WEEKEND_SOCIAL, kind: "correction" }));
    await engine.reflect();
    const declined = factOf(engine, "ev-4", "declined", "聚餐");
    expect(declined).toMatchObject({ status: "corrected", retractedBy: "ev-7" });
    const went = factOf(engine, "ev-7", "participated_in", "聚餐");
    const social = claimOf(engine, "dislike_domain");
    const link = engine.store.linksOf(social.id).find((l) => l.target === went.id)!;
    expect(link).toMatchObject({ polarity: "refutes", weight: "strong" });
    expect(link.rationale).toContain("纠正");
    // 观察换成剩下的两条，推断的前提跟着换
    expect(engine.rg.registry.getGroup("repeated_decline|weekend|social")!.observationIds).toEqual([factOf(engine, "ev-5", "declined").id, factOf(engine, "ev-6", "declined").id]);
    expect(engine.store.inferencesOf(social.id)[0]!.premiseIds).not.toContain(declined.id);
    expect(engine.store.listClaims({ needsReview: true })).toEqual([]);
    expect(targets(engine, social.id, "supports")).not.toContain(declined.id);
  });

  it("周末主动约朋友：反驳'不喜欢社交'，但不反驳'周末自主'（任务书 4.5）", async () => {
    const t = await threeWeekendDeclines();
    t.setNow("2026-09-28T12:00:00+08:00");
    t.engine.ingestEvidence(say("ev-8", "周末主动约了朋友去吃饭", "2026-09-27T10:00:00+08:00", WEEKEND_SOCIAL));
    await t.engine.reflect();
    const invite = factOf(t.engine, "ev-8", "initiated", "吃饭");
    expect(t.engine.store.linksOf(claimOf(t.engine, "dislike_domain").id).find((l) => l.target === invite.id)).toMatchObject({ polarity: "refutes", weight: "strong" });
    expect(t.engine.store.linksOf(claimOf(t.engine, "scene_autonomy").id).find((l) => l.target === invite.id)).toMatchObject({ polarity: "supports" });
  });
});

describe("另一个观察模式：多次参加同一类活动", () => {
  it("工作日两次参加技术交流 → 喜欢活动本身 / 喜欢这类场合 / 只是工作需要；周末自己也去了 → 反驳'只是工作需要'", async () => {
    const t = openEngine("2026-10-10T12:00:00+08:00");
    const work = { mode: "do" as const, kind: "action" as const, context: ["workday", "work"] };
    t.engine.ingestEvidence(say("ev-a", "参加了周三的技术交流会", "2026-10-07T19:00:00+08:00", work));
    t.engine.ingestEvidence(say("ev-b", "又去参加了周四的技术交流会", "2026-10-08T19:00:00+08:00", work));
    await t.engine.reflect();
    const key = "repeated_engage|workday|work";
    expect(t.engine.rg.registry.members(key).map((m) => m.template)).toEqual(["likes_content", "likes_domain", "obligation"]);
    t.setNow("2026-10-12T12:00:00+08:00");
    t.engine.ingestEvidence(say("ev-c", "周六自己去参加了技术交流会", "2026-10-11T14:00:00+08:00", { mode: "do", kind: "action", context: ["weekend", "leisure"] }));
    await t.engine.reflect();
    const weekend = factOf(t.engine, "ev-c", "participated_in", "技术交流");
    const obligation = claimOf(t.engine, "obligation", key);
    expect(t.engine.store.linksOf(obligation.id).find((l) => l.target === weekend.id)).toMatchObject({ polarity: "refutes", weight: "strong" });
    expect(t.engine.store.linksOf(claimOf(t.engine, "likes_content", key).id).find((l) => l.target === weekend.id)).toMatchObject({ polarity: "supports" });
  });
});

describe("找反证", () => {
  it("findCounterevidence：明说的断言按宾语找说法相反的；假设复用它那组的追问", async () => {
    const t = openEngine("2026-10-20T12:00:00+08:00");
    t.engine.ingestEvidence(say("ev-1", "我喜欢爬山", "2026-09-01T10:00:00+08:00", { context: ["weekend"] }));
    t.engine.ingestEvidence(say("ev-2", "我不喜欢爬山", "2026-09-01T18:00:00+08:00", { context: ["weekend"] }));
    await t.engine.reflect();
    const likes = explicitClaimOf(t.engine, factOf(t.engine, "ev-1", "prefers", "爬山"));
    expect(likes.status).toBe("contested");
    const hits = await t.engine.findCounterevidence(likes.id);
    expect(hits.map((h) => h.evidenceId)).toContain("ev-2");
    expect(targets(t.engine, likes.id, "refutes")).toEqual([factOf(t.engine, "ev-2", "dislikes", "爬山").id]);
    // 事实层的真冲突追问也判过：两边都没有第三条证据，搜不到
    const probe = t.engine.store.listProbes().find((p) => p.discriminates.includes(factOf(t.engine, "ev-1", "prefers", "爬山").id))!;
    expect(probe.outcome).toBe("not_found");
  });
});
