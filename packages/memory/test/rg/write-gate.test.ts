// 267 号票：推理图谱的唯一写入口（ADR-0030）。谁写都经它：每晚整理（管理员的夜班）、记忆管理员、记下用户的表态、用户发起的删除。
// 写之前按推理图谱的规矩检查，不合格的整次拒掉（什么都不留）、把原因交回调用方；权限分档；每次写入都留痕。
// 例子是周末社交案例（任务书第 11 节，规则版）：四条进来以后"重视周末自主安排"成立、"不喜欢社交"被"我不反感见朋友"撤回。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Claim } from "../../src/domain/types.ts";
import type { NewClaim } from "../../src/store/store.ts";
import { purgeEvidence } from "../../src/purge.ts";
import { ReasoningWriteRefused, type WriteCheck } from "../../src/rg/write-gate.ts";
import { MemoryEngine } from "../../src/engine.ts";
import { claimOf, closeEngines, explicitClaimOf, factOf, ingestWeekend, openEngine, say } from "./helpers.ts";

afterEach(closeEngines);

const NOW = "2026-10-13T12:00:00+08:00";

async function afterFour(options: Parameters<typeof openEngine>[1] = {}) {
  const t = openEngine("2026-10-09T12:00:00+08:00", options);
  ingestWeekend(t.engine, ["ev-w01", "ev-w02", "ev-w03", "ev-u01"]);
  await t.engine.reflect();
  t.setNow(NOW);
  ingestWeekend(t.engine, ["ev-w04"]);
  await t.engine.reflect();
  return t;
}

/** 330 号票（R14）：随口说的不再自动算决定性，要"不喜欢社交"撤回得用户纠正一句 */
async function afterCorrection() {
  const t = await afterFour();
  t.setNow("2026-10-14T12:00:00+08:00");
  t.engine.ingestEvidence(say("ev-w05", "我不是不喜欢社交，之前那么说不对，跟朋友见面我挺乐意的。", "2026-10-14T11:00:00+08:00", { kind: "correction", context: ["weekend", "social"] }));
  await t.engine.reflect();
  return t;
}

/** 一条新结论的草稿（推断出来的偏好，还拿不准） */
function draft(over: Partial<NewClaim> = {}): NewClaim {
  return {
    tier: "preference",
    statement: "测试：用户喜欢安静的周末",
    kind: "hypothesis",
    epistemic: "inferred",
    method: "abduction",
    status: "contested",
    confidence: "low",
    context: ["weekend"],
    validFrom: null,
    validTo: null,
    inferredAt: NOW,
    reviewedAt: null,
    retractedBy: null,
    supersededBy: null,
    competesWith: [],
    predicts: [],
    ...over,
  };
}

/** 经写入口新写一条结论：结论 + 推断（前提、推法、理由）+ 支持 */
function propose(engine: MemoryEngine, claim: NewClaim, premiseIds: readonly string[], supports: readonly string[] = [], options: { op?: "propose" | "lift"; rationale?: string } = {}): Claim {
  return engine.gate.write({ op: options.op ?? "propose", reason: "测试：新写一条结论" }, () => {
    const created = engine.gate.insertClaim(claim, { reason: "测试：新结论" });
    engine.gate.insertInference({ conclusionClaimId: created.id, premiseIds: [...premiseIds], method: claim.method, rationale: options.rationale ?? "测试的推法：两次都在周末推掉活动", by: "rule:test", status: "active" }, { reason: "测试：推断" });
    for (const target of supports) engine.gate.putLink({ claimId: created.id, target, polarity: "supports", weight: "strong", rationale: "测试的支持" }, { reason: "测试：支持" });
    return created;
  });
}

/** 期望这次写被拒、拒的原因里有这一条检查，库里什么都没留 */
function expectRefused(engine: MemoryEngine, check: WriteCheck, fn: () => void): ReasoningWriteRefused {
  const claimsBefore = engine.store.listClaims().length;
  const revisionsBefore = engine.store.revisions().length;
  let refused: unknown;
  try {
    fn();
  } catch (err) {
    refused = err;
  }
  expect(refused).toBeInstanceOf(ReasoningWriteRefused);
  const err = refused as ReasoningWriteRefused;
  expect(err.problems.map((p) => p.check)).toContain(check);
  // 原因交回给调用方：每一条都说清哪里不合格
  for (const p of err.problems) expect(p.message.length).toBeGreaterThan(4);
  expect(err.message).toContain("写入口");
  // 整次拒掉：一个字都没写进去
  expect(engine.store.listClaims()).toHaveLength(claimsBefore);
  expect(engine.store.revisions()).toHaveLength(revisionsBefore);
  return err;
}

describe("写之前检查：每条检查各一条拒绝", () => {
  it("合格的写照常写进去（对照）", async () => {
    const { engine } = await afterFour();
    const rest = factOf(engine, "ev-w01", "prefers", "休息");
    const claim = propose(engine, draft(), [rest.id], [rest.id]);
    expect(engine.store.getClaim(claim.id)).toMatchObject({ status: "contested" });
  });

  it("前提和推法没写明：没有推断的结论拒掉", async () => {
    const { engine } = await afterFour();
    const err = expectRefused(engine, "premise", () => engine.gate.write({ op: "propose", reason: "测试" }, () => engine.gate.insertClaim(draft(), { reason: "测试：只写结论不写推断" })));
    expect(err.problems.find((p) => p.check === "premise")!.message).toContain("前提");
  });

  it("推断写了前提、没写理由的也拒掉", async () => {
    const { engine } = await afterFour();
    const rest = factOf(engine, "ev-w01", "prefers", "休息");
    const err = expectRefused(engine, "premise", () => propose(engine, draft(), [rest.id], [rest.id], { rationale: " " }));
    expect(err.problems.find((p) => p.check === "premise")!.message).toContain("理由");
  });

  it("引用的证据、事实不存在（编的）：拒掉", async () => {
    const { engine } = await afterFour();
    const autonomy = claimOf(engine, "scene_autonomy");
    const err = expectRefused(engine, "exists", () =>
      engine.gate.write({ op: "attach", reason: "测试" }, () => engine.gate.putLink({ claimId: autonomy.id, target: "ev-nope", polarity: "supports", weight: "strong", rationale: "编的证据" }, { reason: "测试" })),
    );
    expect(err.problems[0]!.message).toContain("ev-nope");
    const rest = factOf(engine, "ev-w01", "prefers", "休息");
    expectRefused(engine, "exists", () => propose(engine, draft(), [rest.id, "fa-9999"], [rest.id]));
  });

  it("按推法封顶把握：需求只有两条证据还标 medium，拒掉", async () => {
    const { engine } = await afterFour();
    const autonomy = claimOf(engine, "scene_autonomy");
    const party = factOf(engine, "ev-w01", "declined", "聚会");
    const activity = factOf(engine, "ev-w03", "declined");
    const need = draft({ tier: "need", method: "induction", statement: "测试：用户需要自主安排时间", confidence: "medium", status: "contested" });
    const err = expectRefused(engine, "confidence_cap", () => propose(engine, need, [autonomy.id], [party.id, activity.id], { op: "propose" }));
    expect(err.problems.find((p) => p.check === "confidence_cap")!.message).toMatch(/low/);
    // 同样的结论标 low 就收
    expect(propose(engine, { ...need, confidence: "low" }, [autonomy.id], [party.id, activity.id]).confidence).toBe("low");
  });

  it("往上抽不过结构门槛（只落一种场合）：拒掉", async () => {
    const { engine } = await afterFour();
    const autonomy = claimOf(engine, "scene_autonomy");
    const party = factOf(engine, "ev-w01", "declined", "聚会");
    expectRefused(engine, "lift_threshold", () =>
      engine.gate.write({ op: "lift", reason: "测试：往上抽" }, () => {
        engine.rg.registry.putGroup({ key: "lift:need|test", pattern: "lift:need", params: {}, description: "测试：只有周末一种场合", observationIds: [autonomy.id], live: true, by: "rule:test" });
        const need = engine.gate.insertClaim(draft({ tier: "need", method: "induction", statement: "测试：用户需要自主安排时间" }), { reason: "测试" });
        engine.rg.registry.addMember(need.id, "lift:need|test", "need_test");
        engine.gate.insertInference({ conclusionClaimId: need.id, premiseIds: [autonomy.id], method: "induction", rationale: "测试：往上抽", by: "rule:test", status: "active" }, { reason: "测试" });
        engine.gate.putLink({ claimId: need.id, target: party.id, polarity: "supports", weight: "weak", rationale: "观察" }, { reason: "测试" });
      }),
    );
    // 整次拒掉：组的簿记也跟着回滚
    expect(engine.rg.registry.getGroup("lift:need|test")).toBeUndefined();
  });

  it("不留悬空结论：前提都不成立了（只靠已撤回的那条）还要写成拿不准，拒掉", async () => {
    const { engine } = await afterCorrection();
    const social = claimOf(engine, "dislike_domain");
    expect(social.status).toBe("retracted");
    const party = factOf(engine, "ev-w01", "declined", "聚会");
    const err = expectRefused(engine, "dangling", () => propose(engine, draft({ statement: "测试：只靠一条撤回了的结论" }), [social.id], [party.id]));
    expect(err.problems.find((p) => p.check === "dangling")!.objectId).toMatch(/^cl-/);
  });

  it("依据变了，依赖它的要跟着走：撤掉一条结论、不管只靠它的下游（悬空），拒掉；同一次写里按 R8 把下游撤掉就收", async () => {
    const { engine } = await afterFour();
    const autonomy = claimOf(engine, "scene_autonomy");
    expect(autonomy.status).toBe("active");
    const party = factOf(engine, "ev-w01", "declined", "聚会");
    const dependent = propose(engine, draft({ statement: "测试：建在周末自主上的一条" }), [autonomy.id], [party.id]);
    const retract = () => engine.gate.updateClaim(autonomy.id, { status: "retracted", retractedBy: "ev-w01", reviewedAt: NOW }, { reason: "测试：撤回", evidenceId: "ev-w01" });
    const err = expectRefused(engine, "dependents", () => engine.gate.write({ op: "decide", reason: "测试" }, retract));
    expect(err.problems.find((p) => p.check === "dependents")!.objectId).toBe(dependent.id);
    engine.gate.write({ op: "decide", reason: "测试" }, () => {
      retract();
      engine.rg.keeper.retractDependents(autonomy.id, NOW, { reason: "测试：前提撤回了", evidenceId: "ev-w01" }, engine.rg.view(NOW));
    });
    expect(engine.store.getClaim(dependent.id)).toMatchObject({ status: "retracted", retractedBy: autonomy.id });
  });
});

describe("权限分档", () => {
  it("直接做：夜班提假设、挂证据，过了检查就写", async () => {
    const { engine } = await afterFour();
    const rest = factOf(engine, "ev-w01", "prefers", "休息");
    const claim = propose(engine, draft(), [rest.id], [rest.id]);
    expect(engine.gate.history(claim.id).at(-1)).toMatchObject({ actor: "nightly", op: "propose" });
  });

  it("要有证据：判一条结论成立，没有一条能当依据的支持就拒", async () => {
    const { engine } = await afterFour();
    const rest = factOf(engine, "ev-w01", "prefers", "休息");
    const bare = propose(engine, draft({ statement: "测试：没有支持的一条" }), [rest.id]);
    expectRefused(engine, "evidence_backed", () => engine.gate.write({ op: "decide", reason: "测试" }, () => engine.gate.updateClaim(bare.id, { status: "active", reviewedAt: NOW }, { reason: "测试：判成立" })));
    // 挂上支持再判就收
    engine.gate.write({ op: "decide", reason: "测试" }, () => {
      engine.gate.putLink({ claimId: bare.id, target: rest.id, polarity: "supports", weight: "strong", rationale: "测试" }, { reason: "测试" });
      engine.gate.updateClaim(bare.id, { status: "active", reviewedAt: NOW }, { reason: "测试：判成立" });
    });
    expect(engine.store.getClaim(bare.id)!.status).toBe("active");
  });

  it("要用户确认：推翻用户明说的结论——记忆管理员自己判不行，按用户的表态可以", async () => {
    const { engine } = await afterFour();
    const explicit = explicitClaimOf(engine, factOf(engine, "ev-w01", "prefers", "休息"));
    expect(explicit.epistemic).toBe("explicit");
    const autonomy = claimOf(engine, "scene_autonomy");
    const overturn = () => engine.gate.updateClaim(explicit.id, { status: "retracted", retractedBy: autonomy.id, reviewedAt: NOW }, { reason: "测试：推翻" });
    const err = expectRefused(engine, "user_confirm", () => engine.gate.write({ op: "decide", actor: "curator", reason: "测试：管理员自己判它不对" }, overturn));
    expect(err.problems.find((p) => p.check === "user_confirm")!.message).toContain("用户");
    engine.gate.write({ op: "verdict", actor: "user_verdict", reason: "测试：用户说这条不对" }, overturn);
    expect(engine.store.getClaim(explicit.id)!.status).toBe("retracted");
  });

  it("要用户确认：敏感类别（健康）上推断要拒；配置里打开了这一类、或者是用户明说的就收", async () => {
    const locked = await afterFour({ writeGate: { sensitiveTags: ["health"] } });
    const rest = factOf(locked.engine, "ev-w01", "prefers", "休息");
    const health = draft({ statement: "测试：用户最近身体不太好", context: ["health"], tier: "state", validTo: "2026-10-27T12:00:00+08:00" });
    const err = expectRefused(locked.engine, "sensitive", () => propose(locked.engine, health, [rest.id], [rest.id]));
    expect(err.problems.find((p) => p.check === "sensitive")!.message).toContain("health");
    // 明说的（用户自己说的）照常记
    const said = propose(locked.engine, { ...health, kind: "conclusion", epistemic: "explicit", method: "explicit", status: "active", confidence: "high", statement: "测试：用户说最近身体不太好" }, [rest.id], [rest.id]);
    expect(said.status).toBe("active");
    // 没锁健康的引擎照常推
    const open = await afterFour();
    const rest2 = factOf(open.engine, "ev-w01", "prefers", "休息");
    expect(propose(open.engine, health, [rest2.id], [rest2.id]).context).toEqual(["health"]);
  });

  it("要用户确认：忘掉、彻底删除只由用户发起——夜班、管理员自己下的拒掉", async () => {
    const { engine } = await afterFour();
    expectRefused(engine, "permission", () => engine.gate.write({ op: "forget", actor: "nightly", reason: "测试：夜班想忘掉一条" }, () => engine.invalidateEvidence("ev-w02", "测试")));
    expectRefused(engine, "permission", () => engine.gate.write({ op: "propose", actor: "nightly", reason: "测试：夜班里顺手忘掉" }, () => engine.invalidateEvidence("ev-w02", "测试")));
    expectRefused(engine, "permission", () => purgeEvidence(engine, ["ev-w02"], { reason: "测试：管理员自己删", actor: "curator" }));
    expect(engine.getEvidence("ev-w02")!.status).toBe("active");
    // 用户发起的照常做（engine.invalidateEvidence 默认就是用户发起）
    engine.invalidateEvidence("ev-w02", "用户让忘掉");
    expect(engine.getEvidence("ev-w02")!.status).toBe("forgotten");
    expect(engine.gate.history("ev-w02").at(-1)).toMatchObject({ actor: "user", op: "forget" });
  });

  it("用户的表态只能按用户的话记：夜班冒充表态拒掉", async () => {
    const { engine } = await afterFour();
    const autonomy = claimOf(engine, "scene_autonomy");
    const err = expectRefused(engine, "permission", () => engine.gate.write({ op: "verdict", actor: "nightly", reason: "测试" }, () => engine.gate.updateClaim(autonomy.id, { reviewedAt: NOW }, { reason: "测试" })));
    expect(err.message).toContain("只能按用户的话记");
  });

  it("永远不做：改原话、删证据、编造证据，写入口直接拒（谁来都一样）", async () => {
    const { engine } = await afterFour();
    expectRefused(engine, "never", () => engine.gate.write({ op: "correct", actor: "user", reason: "测试" }, () => engine.gate.updateEvidence("ev-w01", { text: "改过的原话" }, { reason: "测试：改原话" })));
    expectRefused(engine, "never", () => engine.gate.write({ op: "forget", actor: "user", reason: "测试" }, () => engine.gate.deleteEvidence("ev-w01", { reason: "测试：忘掉时顺手删证据" })));
    expectRefused(engine, "never", () => engine.gate.write({ op: "propose", reason: "测试" }, () => engine.gate.insertEvidence(say("ev-fake", "我最讨厌周末出门。", NOW), { reason: "测试：编一条用户说过的话" })));
    expect(engine.getEvidence("ev-fake")).toBeUndefined();
    expect(engine.getEvidence("ev-w01")!.text).toContain("这周六的聚会");
  });

  it("只读的引擎（秘书、维护者那一份）：什么都写不进去", async () => {
    const built = await afterFour();
    const autonomy = claimOf(built.engine, "scene_autonomy");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rg-readonly-"));
    const file = path.join(dir, "rg.db");
    built.engine.store.saveCopy(file);
    const reader = MemoryEngine.open({ file, clock: () => NOW, writeGate: { readOnly: true } });
    try {
      expectRefused(reader, "permission", () => reader.gate.write({ op: "mark_review", reason: "测试" }, () => reader.gate.updateClaim(autonomy.id, { needsReview: true }, { reason: "测试" })));
      expect(() => reader.recordClaimVerdict(autonomy.id, "doubt")).toThrow(ReasoningWriteRefused);
      expect(() => reader.ingestEvidence(say("ev-x1", "随便说一句。", NOW))).toThrow(ReasoningWriteRefused);
      expect(() => reader.invalidateEvidence("ev-w01", "测试")).toThrow(ReasoningWriteRefused);
      expect(reader.store.getClaim(autonomy.id)!.status).toBe("active");
    } finally {
      reader.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("不开写入口直接调写操作：报错（不能绕过检查和留痕）", async () => {
    const { engine } = await afterFour();
    const autonomy = claimOf(engine, "scene_autonomy");
    expect(() => engine.gate.updateClaim(autonomy.id, { needsReview: true }, { reason: "测试" })).toThrow(/写入口/);
  });

  it("整理时被拒的不让整夜失败：交回给调用方（记进 dropped），别的照常写", async () => {
    // 把"周末"当成没打开的敏感类别：周末那组假设都推不出来，明说的照常记
    const t = openEngine("2026-10-09T12:00:00+08:00", { writeGate: { sensitiveTags: ["weekend"] } });
    ingestWeekend(t.engine, ["ev-w01", "ev-w02", "ev-w03"]);
    const report = await t.engine.reflect();
    const gate = report.dropped.filter((d) => d.stage === "gate");
    expect(gate.length).toBeGreaterThan(0);
    expect(gate[0]!.reason).toContain("敏感");
    expect(t.engine.store.listClaims().some((c) => c.epistemic === "explicit")).toBe(true);
    expect(t.engine.store.listClaims().every((c) => c.epistemic !== "inferred" || !c.context.includes("weekend"))).toBe(true);
  });
});

describe("留痕：每次写入记下谁写的、推法、依据、原因", () => {
  it("每晚整理写的记成夜班：出假设、判成立，带推法和依据（前提、支持）", async () => {
    const { engine } = await afterFour();
    const autonomy = claimOf(engine, "scene_autonomy");
    const history = engine.gate.history(autonomy.id);
    expect(history.length).toBeGreaterThan(0);
    expect(history.every((r) => r.actor === "nightly")).toBe(true);
    expect(history.map((r) => r.op)).toEqual(expect.arrayContaining(["propose", "decide"]));
    const decided = history.find((r) => r.op === "decide")!;
    expect(decided.method).toBe("abduction");
    expect(decided.basis).toEqual(expect.arrayContaining([factOf(engine, "ev-w01", "declined", "聚会").id]));
    expect(decided.reason.length).toBeGreaterThan(0);
    expect(decided.revisionSeqs.length).toBeGreaterThan(0);
  });

  it("用户的表态记成用户的表态（经记忆管理员），原因写管理员记下的那句", async () => {
    const t = openEngine("2026-10-09T12:00:00+08:00");
    ingestWeekend(t.engine, ["ev-w01", "ev-w02", "ev-w03", "ev-u01"]);
    await t.engine.reflect();
    const autonomy = claimOf(t.engine, "scene_autonomy");
    t.engine.recordClaimVerdict(autonomy.id, "confirm", { via: "经记忆管理员", note: "记忆管理员按用户的话改成成立：用户说就是这样" });
    const last = t.engine.gate.history(autonomy.id).at(-1)!;
    expect(last).toMatchObject({ actor: "user_verdict", via: "经记忆管理员", op: "verdict", method: "user_confirmation" });
    expect(last.reason).toContain("用户说就是这样");
  });

  it("结论的修改历史（explain 的修订）每一条都标着是谁、做什么写的", async () => {
    const { engine } = await afterFour();
    const autonomy = claimOf(engine, "scene_autonomy");
    const revisions = engine.explainClaim(autonomy.id).revisions;
    expect(revisions.length).toBeGreaterThan(0);
    for (const r of revisions) expect(r.by).toMatchObject({ actor: "nightly" });
  });

  it("没有绕过写入口的写：整理、表态、纠正、忘掉、彻底删除之后，每一条修订都对得上一条留痕", async () => {
    const t = await afterFour();
    const autonomy = claimOf(t.engine, "scene_autonomy");
    t.engine.recordClaimVerdict(autonomy.id, "confirm", { via: "经记忆管理员" });
    t.engine.ingestEvidence(say("ev-c1", "上次说的不对，我其实没推掉技术交流会。", NOW, { kind: "correction" }));
    t.engine.correct("ev-w02", "ev-c1");
    t.engine.invalidateEvidence("ev-w03", "用户让忘掉");
    purgeEvidence(t.engine, ["ev-w01"], { reason: "彻底删除素材" });
    t.setNow("2026-10-14T03:00:00+08:00");
    await t.engine.runNightly({ userActive: false });
    const traced = new Set(t.engine.gate.records().flatMap((r) => r.revisionSeqs));
    const untraced = t.engine.store.revisions().filter((r) => r.objectType !== "entity" && !traced.has(r.seq));
    expect(untraced).toEqual([]);
  });

  it("忘掉一条证据：证据、事实、依赖它的结论都记成用户发起的忘掉", async () => {
    const { engine } = await afterFour();
    const autonomy = claimOf(engine, "scene_autonomy");
    engine.invalidateEvidence("ev-w04", "用户让忘掉");
    expect(engine.gate.history(autonomy.id).at(-1)).toMatchObject({ actor: "user", op: "forget" });
    expect(engine.store.getClaim(autonomy.id)).toMatchObject({ status: "contested", needsReview: true });
  });
});

describe("问题箱（264 号票的顺口问）也经唯一写入口", () => {
  it("出问题记夜班；记问过是记忆管理员、回答回写（回答证据入库、明确时马上判）是用户的表态，都写明经谁转达；别问这个只由用户发起", async () => {
    const t = openEngine("2026-10-09T22:00:00+08:00");
    ingestWeekend(t.engine, ["ev-w01", "ev-w02", "ev-w03"]);
    t.setNow("2026-10-10T03:00:00+08:00");
    expect((await t.engine.runNightly({ userActive: false })).ran).toBe(true);
    const via = "经秘书顺口问";
    t.setNow("2026-10-10T20:00:00+08:00");
    const peeked = t.engine.pickQuestion("这周六同学约我聚会，我还在想要不要去。", { peek: true, via });
    const q = peeked.question!;
    expect(t.engine.gate.history(q.id)[0]).toMatchObject({ objectType: "question", op: "question", actor: "nightly" });
    // 别问这个：夜班、管理员自己下不了
    expect(() => t.engine.declineQuestion(q.id, { actor: "nightly" })).toThrow(ReasoningWriteRefused);
    t.engine.markQuestionAsked(q.id, { via });
    t.setNow("2026-10-10T20:05:00+08:00");
    const record = t.engine.recordQuestionAnswer(q.id, say("ev-a1", "确实，时间我自己定的话一定会去", "2026-10-10T20:05:00+08:00"), { via });
    expect(record).toMatchObject({ clear: true, applied: "now" });
    const rows = t.engine.gate.history(q.id).filter((r) => r.op !== "question");
    expect(rows.map((r) => [r.op, r.actor, r.via])).toEqual([
      ["ask", "curator", via],
      ["verdict", "user_verdict", via],
    ]);
    expect(t.engine.gate.history(record.evidenceId)).toEqual([expect.objectContaining({ op: "ingest", actor: "user_verdict", via })]);
    // 明确时马上判：改到的结论也记成用户的表态、经秘书顺口问
    const claimRows = t.engine.gate.records({ actor: "user_verdict" }).filter((r) => r.objectType === "claim");
    expect(claimRows.length).toBeGreaterThan(0);
    expect(claimRows.every((r) => r.via === via)).toBe(true);
  });
});
