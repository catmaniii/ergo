// 验收：周末社交案例（任务书第 11 节那 4 条，加 1 条别人转述的"讨厌社交"）。规则版。
// 330 号票（R14）起随口说的不再自动算决定性：第 4 条"我不反感见朋友"只算一条强反证，"不喜欢社交"降成猜测（还没排除），
// 不再被撤回；用户再纠正一句（afterCorrection）才撤回、才是"已经排除"。
import { afterEach, describe, expect, it } from "vitest";
import { answerFromHits } from "../../src/rg/answer.ts";
import { closeEngines, explicitClaimOf, factOf, ingestWeekend, openEngine, claimOf, say, targets } from "./helpers.ts";

afterEach(closeEngines);

const FIRST_THREE = ["ev-w01", "ev-w02", "ev-w03"];
const GROUP = "repeated_decline|weekend|social";

async function afterThree() {
  const t = openEngine("2026-10-09T12:00:00+08:00");
  ingestWeekend(t.engine, [...FIRST_THREE, "ev-u01"]);
  await t.engine.reflect();
  return t;
}

async function afterFour() {
  const t = await afterThree();
  t.setNow("2026-10-13T12:00:00+08:00");
  ingestWeekend(t.engine, ["ev-w04"]);
  await t.engine.reflect();
  return t;
}

/** 第 4 条以后用户又纠正了一句"我不是不喜欢社交"：纠正算决定性（R14），"不喜欢社交"被它撤回 */
async function afterCorrection() {
  const t = await afterFour();
  t.setNow("2026-10-14T12:00:00+08:00");
  t.engine.ingestEvidence(say("ev-w05", "我不是不喜欢社交，之前那么说不对，跟朋友见面我挺乐意的。", "2026-10-14T11:00:00+08:00", { kind: "correction", context: ["weekend", "social"] }));
  await t.engine.reflect();
  return t;
}

describe("周末社交案例：前三条", () => {
  it("一组竞争假设：不喜欢社交 / 重视周末自主安排 / 近期忙累 / 不喜欢活动内容，互相登记", async () => {
    const { engine } = await afterThree();
    const group = engine.rg.registry.getGroup(GROUP)!;
    expect(group.live).toBe(true);
    expect(group.observationIds).toEqual([factOf(engine, "ev-w01", "declined", "聚会").id, factOf(engine, "ev-w03", "declined").id]);
    const members = engine.rg.registry.members(GROUP);
    expect(members.map((m) => m.template)).toEqual(["dislike_domain", "scene_autonomy", "recent_state", "dislike_content"]);
    for (const m of members) {
      const c = engine.store.getClaim(m.claimId)!;
      expect(c.competesWith.toSorted()).toEqual(members.filter((x) => x.claimId !== c.id).map((x) => x.claimId).toSorted());
      expect(c).toMatchObject({ kind: "hypothesis", epistemic: "inferred", method: "abduction" });
    }
    expect(claimOf(engine, "dislike_domain").statement).toContain("不喜欢社交");
    expect(claimOf(engine, "scene_autonomy").statement).toContain("周末的自主安排");
    expect(claimOf(engine, "recent_state")).toMatchObject({ tier: "state", validTo: "2026-10-22T21:00:00+08:00" });
  });

  it("各带支持和反证：'不喜欢社交'被工作日主动参加技术交流反驳，'周末自主'有'周末想休息'支持", async () => {
    const { engine } = await afterThree();
    const declineParty = factOf(engine, "ev-w01", "declined", "聚会");
    const declineActivity = factOf(engine, "ev-w03", "declined");
    const rest = factOf(engine, "ev-w01", "prefers", "休息");
    const tech = factOf(engine, "ev-w02", "participated_in", "技术交流");
    const social = claimOf(engine, "dislike_domain");
    const autonomy = claimOf(engine, "scene_autonomy");
    expect(targets(engine, social.id, "supports")).toEqual(expect.arrayContaining([declineParty.id, declineActivity.id]));
    expect(targets(engine, social.id, "refutes")).toEqual([tech.id]);
    expect(targets(engine, autonomy.id, "supports")).toEqual(expect.arrayContaining([declineParty.id, declineActivity.id, rest.id]));
    // 还分不出来：全部 contested
    for (const m of engine.rg.registry.members(GROUP)) expect(engine.store.getClaim(m.claimId)!.status).toBe("contested");
  });

  it("每条竞争假设都被某条判别性追问认领；追问写清找到了算谁", async () => {
    const { engine } = await afterThree();
    const probes = engine.rg.registry.probesOf(GROUP).map((p) => engine.store.getProbe(p.probeId)!);
    expect(probes.length).toBeGreaterThanOrEqual(4);
    for (const m of engine.rg.registry.members(GROUP)) expect(probes.some((p) => p.discriminates.includes(m.claimId))).toBe(true);
    for (const p of probes) {
      expect(p.discriminates).toHaveLength(2);
      expect(p.discriminates).toContain(p.ifFound);
      expect(["found", "not_found"]).toContain(p.outcome);
    }
    // 问"这阵子忙不忙"的那条搜不到：not_found，不判负（近期忙累的那条照样活着）
    const busy = probes.find((p) => p.queries.includes("加班"))!;
    expect(busy.outcome).toBe("not_found");
    expect(claimOf(engine, "recent_state").status).toBe("contested");
  });

  it("用户模型：竞争假设单列在'还拿不准的'里；明说的'最近周末想休息'是近期状态", async () => {
    const { engine } = await afterThree();
    const model = engine.getUserModel({ context: ["weekend"] });
    expect(model.uncertain.map((u) => u.claimId)).toEqual(expect.arrayContaining([claimOf(engine, "dislike_domain").id, claimOf(engine, "scene_autonomy").id]));
    const social = model.uncertain.find((u) => u.claimId === claimOf(engine, "dislike_domain").id)!;
    expect(social).toMatchObject({ reason: "contested" });
    expect(social.competitors.map((c) => c.claimId)).toContain(claimOf(engine, "scene_autonomy").id);
    expect([...model.preferences, ...model.values].map((e) => e.claimId)).not.toContain(claimOf(engine, "dislike_domain").id);
    expect(model.state).toEqual([expect.objectContaining({ label: "user_stated", statement: expect.stringContaining("休息"), evidenceIds: ["ev-w01"], validTo: "2026-10-15T20:10:00+08:00" })]);
  });

});

describe("周末社交案例：第 4 条进来以后", () => {
  it("只有本人能当依据：别人转述的'讨厌社交'不支持'不喜欢社交'，只当背景", async () => {
    const { engine } = await afterFour();
    const social = claimOf(engine, "dislike_domain");
    const hearsay = engine.store.factsByEvidence("ev-u01").map((f) => f.id);
    expect(hearsay).toHaveLength(1);
    expect([...targets(engine, social.id, "supports"), ...targets(engine, social.id, "refutes")]).not.toEqual(expect.arrayContaining(hearsay));
    expect(targets(engine, social.id, "context")).toEqual(hearsay);
    // 撤回它的是本人的话，不是转述
    expect(social.retractedBy).not.toBe(hearsay[0]);
    const model = engine.getUserModel();
    expect([...model.preferences, ...model.uncertain].flatMap((e) => e.evidenceIds)).not.toContain("ev-u01");
  });

  it("'不喜欢社交'碰上'我不反感见朋友'：随口说的只算强反证（R14），降成猜测、不撤；'重视周末自主安排'成立；用户再纠正一句才撤回（墓碑指向纠正）", async () => {
    const { engine } = await afterFour();
    const okFriends = factOf(engine, "ev-w04", "dislikes", "见朋友", true);
    const booked = factOf(engine, "ev-w04", "dislikes", "被提前排满", false);
    const social = claimOf(engine, "dislike_domain");
    expect(social).toMatchObject({ status: "contested", retractedBy: null, confidence: "low" });
    // 关联上写的还是决定性（模板照写），计分时按强的算
    expect(engine.store.linksOf(social.id).find((l) => l.target === okFriends.id)).toMatchObject({ polarity: "refutes", weight: "decisive" });
    const autonomy = claimOf(engine, "scene_autonomy");
    expect(autonomy).toMatchObject({ status: "active", confidence: "medium" });
    expect(engine.store.linksOf(autonomy.id).find((l) => l.target === booked.id)).toMatchObject({ polarity: "supports", weight: "strong" });
    // 不喜欢活动内容：用户明说不反感同类活动，反驳
    expect(targets(engine, claimOf(engine, "dislike_content").id, "refutes")).toContain(okFriends.id);
    expect(claimOf(engine, "dislike_content").status).toBe("contested");
    // 用户纠正一句：撤回，墓碑指向纠正那条事实，留在修订日志里
    const t = await afterCorrection();
    const corrected = factOf(t.engine, "ev-w05", "dislikes", "社交", true);
    const again = claimOf(t.engine, "dislike_domain");
    expect(again).toMatchObject({ status: "retracted", retractedBy: corrected.id });
    expect(t.engine.store.revisions(again.id, "claim").some((r) => r.changes.status?.to === "retracted" && r.causeEvidenceId === "ev-w05")).toBe(true);
  });

  it("用户模型：'不喜欢社交'只在还拿不准的里（R14 以后是猜测），不当偏好；偏好里有推断的'周末自主'和用户明说的两条", async () => {
    const { engine } = await afterFour();
    const model = engine.getUserModel({ context: ["weekend"] });
    expect([...model.state, ...model.preferences, ...model.values].map((e) => e.claimId)).not.toContain(claimOf(engine, "dislike_domain").id);
    expect(model.uncertain.map((e) => e.claimId)).toContain(claimOf(engine, "dislike_domain").id);
    const autonomy = model.preferences.find((e) => e.claimId === claimOf(engine, "scene_autonomy").id)!;
    expect(autonomy).toMatchObject({ label: "inferred", confidence: "medium" });
    expect(autonomy.evidenceIds.toSorted()).toEqual(["ev-w01", "ev-w03", "ev-w04"]);
    const stated = model.preferences.filter((e) => e.label === "user_stated").map((e) => e.statement);
    expect(stated).toEqual(expect.arrayContaining([expect.stringContaining("不反感见朋友"), expect.stringContaining("不喜欢被提前排满")]));
    // 还没排除的列在"还拿不准的"里，附上竞争的那几条
    expect(model.uncertain.map((u) => u.claimId)).toEqual(expect.arrayContaining([claimOf(engine, "recent_state").id]));
  });

  it("带证据的回答：比较可能的解释、你说过的、已经排除的（用户纠正以后），每句后面带证据 id", async () => {
    const { engine } = await afterCorrection();
    const answer = await engine.answer("为什么我最近不想参加周末的聚会？", { context: ["weekend"] });
    expect(answer.route).toBe("reasoning");
    expect(answer.certain).toBe(true);
    expect(answer.text).toContain(claimOf(engine, "scene_autonomy").statement);
    expect(answer.text).toMatch(/已经排除：用户不喜欢社交.*［ev-w05］/);
    expect(answer.text).toContain("［");
    const cited = answer.citations.flatMap((c) => c.evidenceIds);
    expect(cited).toEqual(expect.arrayContaining(["ev-w01", "ev-w03", "ev-w04"]));
    expect(cited).not.toContain("ev-u01");
  });

  it("192：回答里每条引用带角色——结论、你说过的、已经排除的（证据是撤回它的那句话）、反证、还没排除的", async () => {
    const { engine } = await afterCorrection();
    const answer = await engine.answer("为什么我最近不想参加周末的聚会？", { context: ["weekend"] });
    const role = (r: string) => answer.citations.filter((c) => c.role === r);
    expect(role("conclusion").map((c) => c.claimId)).toEqual([claimOf(engine, "scene_autonomy").id]);
    expect(role("excluded").find((c) => c.claimId === claimOf(engine, "dislike_domain").id)!.evidenceIds).toEqual(["ev-w05"]);
    expect(role("stated").map((c) => c.text)).toEqual(expect.arrayContaining([expect.stringContaining("不反感见朋友")]));
    expect(role("open").map((c) => c.claimId)).toContain(claimOf(engine, "recent_state").id);
    expect(answer.citations.every((c) => c.role !== undefined)).toBe(true);
  });

  it("192：answerFromHits 只按给的检索结果拼回答（不进推理图谱），引用都是记录、最多 5 条", async () => {
    const { engine } = await afterFour();
    const hits = await engine.search("周末的聚会", { mode: "hybrid", limit: 10 });
    const answer = answerFromHits(engine.rg, "周末的聚会", hits, engine.rg.view());
    expect(answer.route).toBe("retrieval");
    expect(answer.citations.length).toBeGreaterThan(0);
    expect(answer.citations.length).toBeLessThanOrEqual(5);
    expect(answer.citations.every((c) => c.role === "record" && c.claimId === null)).toBe(true);
    expect(answer.citations.flatMap((c) => c.evidenceIds)).not.toContain("ev-u01");
  });

  it("explainClaim：结论、前提链（追到原话）、带原文的支持和反证、竞争假设、追问", async () => {
    const { engine } = await afterFour();
    const autonomy = claimOf(engine, "scene_autonomy");
    const x = engine.explainClaim(autonomy.id);
    expect(x.claim.id).toBe(autonomy.id);
    expect(x.group?.key).toBe(GROUP);
    expect(x.premises.kind).toBe("claim");
    const leaves = (t: typeof x.premises): string[] => (t.premises.length === 0 ? [t.id] : t.premises.flatMap(leaves));
    // 329 号票（R7）：第 4 条进来以后它有不靠前提的独立证据（第 1 条里"想好好休息"、第 4 条"不喜欢周末被提前排满"）达标，
    // 依据改挂到这两条上，原来那条推理链（两次推掉活动）记作历史
    expect(leaves(x.premises).toSorted()).toEqual(["ev-w01", "ev-w04"]);
    expect(engine.store.inferencesOf(autonomy.id).map((i) => i.status)).toEqual(["history", "active"]);
    expect(x.premises.premises.map((p) => p.kind)).toEqual(["fact", "fact"]);
    expect(x.supports.flatMap((l) => l.evidence.map((e) => e.text))).toContain("我不反感见朋友，只是不喜欢周末被提前排满。");
    expect(x.competitors.map((c) => c.id)).toContain(claimOf(engine, "dislike_domain").id);
    expect(x.probes.length).toBeGreaterThan(0);
    expect(x.text).toContain("前提链");
    expect(x.text).toContain("「这周六的聚会我就不去了，最近周末想好好休息。」");
    const refuted = engine.explainClaim(claimOf(engine, "dislike_domain").id);
    expect(refuted.refutes.flatMap((l) => l.evidence.map((e) => e.id))).toEqual(expect.arrayContaining(["ev-w02", "ev-w04"]));
    expect(refuted.background.flatMap((l) => l.evidence)).toEqual([expect.objectContaining({ id: "ev-u01", usable: false })]);
  });

  it("search(hybrid_kg_rg)：命中假设时带上它的支持和反证，'为什么'类跑追问做第二轮", async () => {
    const { engine } = await afterFour();
    const hits = await engine.search("为什么周末不想参加聚会", { mode: "hybrid_kg_rg", limit: 10 });
    const w04 = hits.find((h) => h.evidenceId === "ev-w04")!;
    expect(w04.channels.probe).toBeDefined();
    expect((w04.via as { claimIds?: string[] }).claimIds).toContain(claimOf(engine, "scene_autonomy").id);
    expect(hits.map((h) => h.evidenceId)).toEqual(expect.arrayContaining(["ev-w01", "ev-w02", "ev-w03"]));
    expect(hits.some((h) => h.via.probeIds.length > 0)).toBe(true);
  });
});

describe("周末社交案例：删掉、纠正关键证据", () => {
  it("忘掉第 4 条：靠它直接证实的退回推理链、当场重判成猜测（不静默有效）；被它推翻的复活；明说的那条跟着事实撤回、不进用户模型；下一次 reflect 照旧", async () => {
    const { engine } = await afterFour();
    const autonomy = claimOf(engine, "scene_autonomy");
    const social = claimOf(engine, "dislike_domain");
    const okFriends = explicitClaimOf(engine, factOf(engine, "ev-w04", "dislikes", "见朋友", true));
    engine.invalidateEvidence("ev-w04", "用户说忘掉");
    // 329 号票：autonomy 原来靠第 4 条的独立证据直接证实（R7），那份证实没了 → 退回原来的推理链，组当场按剩下的证据重判
    expect(engine.store.getClaim(autonomy.id)!.status).toBe("contested");
    expect(engine.store.inferencesOf(autonomy.id).find((i) => i.status === "active")!.premiseIds).not.toContain(factOf(engine, "ev-w04", "dislikes", undefined, false).id);
    // social 原来被第 4 条"不反感见朋友"推翻，推翻者不在了 → 复活（R11）
    expect(engine.store.getClaim(social.id)).toMatchObject({ status: "contested", retractedBy: null });
    const w04 = factOf(engine, "ev-w04", "dislikes", "见朋友", true);
    expect(engine.store.getClaim(okFriends.id)).toMatchObject({ status: "retracted", retractedBy: w04.id });
    // 每一步都有修订记录，起因是那条证据
    const revs = engine.store.revisions(autonomy.id, "claim").filter((r) => r.causeEvidenceId === "ev-w04");
    expect(revs.some((r) => r.reason.includes("证实它的那份东西不在了"))).toBe(true);
    expect(engine.store.revisions(autonomy.id, "link").some((r) => r.op === "delete" && r.causeEvidenceId === "ev-w04")).toBe(true);
    const model = engine.getUserModel({ context: ["weekend"] });
    const confirmed = [...model.state, ...model.preferences, ...model.values].map((e) => e.claimId);
    expect(confirmed).not.toContain(autonomy.id);
    expect([...confirmed, ...model.uncertain.map((e) => e.claimId)]).not.toContain(okFriends.id);

    const report = await engine.reflect();
    expect(report.skipped).toBeUndefined();
    expect(engine.store.getClaim(okFriends.id)).toMatchObject({ status: "retracted", retractedBy: w04.id });
    expect(engine.store.getClaim(social.id)).toMatchObject({ status: "contested", retractedBy: null });
    expect(engine.store.getClaim(autonomy.id)!.status).toBe("contested");
    expect(engine.store.listClaims({ needsReview: true })).toEqual([]);
  });

  it("忘掉第 1 条：观察只剩一条，组不成立了（没有推翻者，Q2）→ 没有直接证实的不撤、留成猜测、降把握，前提照挂；有独立证据直接证实的留下（R7）", async () => {
    const { engine } = await afterFour();
    const autonomy = claimOf(engine, "scene_autonomy");
    const others = engine.rg.registry
      .members(GROUP)
      .map((m) => engine.store.getClaim(m.claimId)!)
      .filter((c) => c.id !== autonomy.id && c.status !== "retracted");
    expect(others.length).toBeGreaterThan(0);
    const first = factOf(engine, "ev-w01", "declined", "聚会");
    engine.invalidateEvidence("ev-w01", "用户说忘掉");
    await engine.reflect();
    expect(engine.rg.registry.getGroup(GROUP)!.live).toBe(false);
    const rank = { low: 0, medium: 1, high: 2 } as const;
    for (const was of others) {
      const now = engine.store.getClaim(was.id)!;
      expect(now).toMatchObject({ status: "contested", retractedBy: null, needsReview: false });
      expect(rank[now.confidence]).toBeLessThanOrEqual(Math.max(0, rank[was.confidence] - 1));
      expect(engine.store.revisions(was.id, "claim").some((r) => r.changes.status?.to === "retracted")).toBe(false);
    }
    for (const tpl of ["recent_state", "dislike_content"]) expect(claimOf(engine, tpl)).toMatchObject({ status: "contested", retractedBy: null });
    // 第 4 条"不喜欢周末被提前排满"不靠这组观察、自己就够门槛：依据改挂到它上面，照样成立
    expect(engine.store.getClaim(autonomy.id)).toMatchObject({ status: "active", retractedBy: null });
    expect(engine.store.inferencesOf(autonomy.id).find((i) => i.status === "active")!.premiseIds).toEqual([factOf(engine, "ev-w04", "dislikes", undefined, false).id]);
    const recent = claimOf(engine, "recent_state").id;
    expect(engine.explainClaim(recent).text).toContain(`前提链`);
    expect(engine.tracePremises(recent).premises.map((p) => p.id)).toContain(first.id);
  });

  it("再整理一次什么都不做（幂等）；since 重新整理也不多写修订", async () => {
    const { engine } = await afterFour();
    const before = engine.store.revisions().length;
    expect((await engine.reflect()).skipped).toMatch(/没有新证据/);
    expect(engine.store.revisions().length).toBe(before);
    const again = await engine.reflect({ since: "ev-w01" });
    expect(again.processedEvidenceIds).toEqual(["ev-w02", "ev-w03", "ev-w04", "ev-u01"]);
    expect(again.newClaimIds).toEqual([]);
    expect(again.changedClaimIds).toEqual([]);
  });
});
