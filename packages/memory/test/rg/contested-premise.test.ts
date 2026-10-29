// 拿不准的事实当前提（326 号票起；329 号票照原始推理图谱改，ADR-0032）：
// - 身份（kind）建号锁死：明说的结论事实变拿不准，不再"降成假设"改 kind，而是状态变成猜测（contested）；
// - 传播铁律：已验证的不能压在没验证的前提上（拿不准的事实也算没验证）——写入口当场拒，依赖它的要在同一次写里降回猜测（前提照挂、保留）；
// - 每晚的图谱自检发现绕过写入口造出来的违规：报出来，照铁律降回猜测（身份不改）；
// - 冲突解决、事实回到成立：明说的那条跟着事实回到已验证；
// - 事实被本人纠正 = 亲口否掉：明说的当场撤回（墓碑指纠正的话），往上没有直接证实的跟着撤；证据被忘掉 = 来源失效：撤回，墓碑指那条事实。
import { afterEach, describe, expect, it } from "vitest";
import type { MemoryEngine } from "../../src/engine.ts";
import { checkReasoningGraph } from "../../src/rg/graph-check.ts";
import { ironLawViolation, unverifiedPremises, type GraphLookup } from "../../src/rg/graph-rules.ts";
import { graphSelfCheck, validateNightly } from "../../src/rg/nightly-validate.ts";
import { ReasoningWriteRefused } from "../../src/rg/write-gate.ts";
import { closeEngines, explicitClaimOf, factOf, openEngine, say } from "./helpers.ts";

afterEach(closeEngines);

/** "我喜欢吃辣"说完，同一天又说"我不喜欢吃辣"：两条事实真冲突，都拿不准 */
async function spicy() {
  const t = openEngine("2026-10-05T09:00:00+08:00");
  t.engine.ingestEvidence(say("ev-1", "我喜欢吃辣", "2026-10-05T08:00:00+08:00"));
  await t.engine.reflect();
  const likes = explicitClaimOf(t.engine, factOf(t.engine, "ev-1", "prefers", "吃辣"));
  t.setNow("2026-10-05T21:00:00+08:00");
  t.engine.ingestEvidence(say("ev-2", "我不喜欢吃辣", "2026-10-05T20:00:00+08:00"));
  await t.engine.reflect();
  const likesFact = factOf(t.engine, "ev-1", "prefers", "吃辣");
  const dislikesFact = factOf(t.engine, "ev-2", "dislikes", "吃辣");
  const dislikes = explicitClaimOf(t.engine, dislikesFact);
  return { ...t, likes, dislikes, likesFact, dislikesFact };
}

const kindRevisions = (engine: MemoryEngine, id: string) => engine.store.revisions(id, "claim").filter((r) => r.changes.kind !== undefined);

/** 按给的状态、前提查 */
const lookup = (statuses: Record<string, string>, premises: Record<string, string[]>): GraphLookup => ({
  statusOf: (id) => statuses[id],
  premisesOf: (id) => premises[id] ?? [],
});

/** 一条明说的结论（前提是给的事实）；status 默认已验证 */
function draftOn(engine: MemoryEngine, factId: string, status: "active" | "contested") {
  const claim = engine.gate.insertClaim({
    tier: "preference",
    statement: "用户偏好吃辣（测试）",
    kind: "conclusion",
    epistemic: "explicit",
    method: "explicit",
    status,
    confidence: status === "active" ? "high" : "medium",
    context: [],
    validFrom: null,
    validTo: null,
    inferredAt: "2026-10-05T21:00:00+08:00",
    reviewedAt: null,
    retractedBy: null,
    supersededBy: null,
    competesWith: [],
    predicts: [],
  });
  engine.gate.insertInference({ conclusionClaimId: claim.id, premiseIds: [factId], method: "explicit", rationale: "用户自己说的", by: "rule:test", status: "active" });
  engine.gate.putLink({ claimId: claim.id, target: factId, polarity: "supports", weight: "decisive", rationale: "用户自己说的" });
  return claim.id;
}

describe("规则本身（graph-rules，写入口和图谱自检共用）", () => {
  it("没验证的前提：猜测、拿不准的事实、被纠正的、撤回的；被新值取代的事实在有效期内还算已验证；只有已验证的结论才查铁律", () => {
    const l = lookup(
      { "cl-a": "active", "cl-b": "contested", "cl-c": "contested", "fa-1": "contested", "fa-2": "active", "fa-3": "superseded", "fa-4": "corrected" },
      { "cl-a": ["cl-b", "fa-2", "fa-3"], "cl-c": ["fa-1", "fa-4"] },
    );
    expect(unverifiedPremises(l, "cl-a")).toEqual(["cl-b"]);
    expect(unverifiedPremises(l, "cl-c")).toEqual(["fa-1", "fa-4"]);
    expect(ironLawViolation(l, "cl-a")).toEqual(["cl-b"]);
    // 猜测本来就可以压在没验证的前提上
    expect(ironLawViolation(l, "cl-c")).toEqual([]);
  });
});

describe("白天写：拿不准的事实上只能是猜测，身份不改", () => {
  it("明说的结论，事实后来真冲突了：跟着事实走成了猜测（kind 还是 conclusion），修订写明为什么；冲突里另一边一建出来就是猜测；写入口一处不拒", async () => {
    const t = await spicy();
    expect(t.likesFact.status).toBe("contested");
    const likes = t.engine.store.getClaim(t.likes.id)!;
    expect(likes).toMatchObject({ kind: "conclusion", status: "contested", epistemic: "explicit" });
    expect(kindRevisions(t.engine, likes.id)).toEqual([]);
    expect(t.engine.store.revisions(likes.id, "claim").find((r) => r.changes.status?.to === "contested")!.reason).toContain("拿不准");
    expect(t.engine.store.getClaim(t.dislikes.id)).toMatchObject({ kind: "conclusion", status: "contested" });
    const report = await t.engine.reflect();
    expect(report.dropped.filter((d) => d.stage === "gate")).toEqual([]);
  });

  it("直接经写入口写一条已验证、前提是拿不准的事实：拒（传播铁律，不再自动改身份）；写成猜测就收，身份照写的", async () => {
    const t = await spicy();
    let refused: unknown;
    try {
      t.engine.gate.write({ op: "explicit", reason: "测试：已验证压在拿不准的事实上" }, () => draftOn(t.engine, t.likesFact.id, "active"));
    } catch (err) {
      refused = err;
    }
    expect(refused).toBeInstanceOf(ReasoningWriteRefused);
    expect((refused as ReasoningWriteRefused).problems.map((p) => p.check)).toContain("dependents");
    const id = t.engine.gate.write({ op: "explicit", reason: "测试：写成猜测" }, () => draftOn(t.engine, t.likesFact.id, "contested"));
    expect(t.engine.store.getClaim(id)).toMatchObject({ kind: "conclusion", status: "contested" });
  });
});

describe("每晚：图谱自检照铁律降回猜测", () => {
  it("已验证的前提后来变成拿不准（绕过写入口改的）：自检报 dependents、交回要降的；每晚校验降回猜测（身份不改），留痕记夜班；再查一遍没问题", async () => {
    const t = openEngine("2026-10-05T09:00:00+08:00");
    t.engine.ingestEvidence(say("ev-1", "我喜欢吃辣", "2026-10-05T08:00:00+08:00"));
    t.engine.ingestEvidence(say("ev-9", "我喜欢爬山", "2026-10-05T08:30:00+08:00"));
    await t.engine.reflect();
    const fact = factOf(t.engine, "ev-1", "prefers", "吃辣");
    const other = factOf(t.engine, "ev-9", "prefers", "爬山");
    const claim = explicitClaimOf(t.engine, fact);
    expect(claim).toMatchObject({ kind: "conclusion", status: "active" });
    t.engine.store.db.run("UPDATE facts SET status = 'contested', contested_with = ? WHERE id = ?", JSON.stringify([other.id]), fact.id);
    const check = checkReasoningGraph(t.engine.store);
    expect(check.problems).toEqual([{ check: "dependents", subject: claim.id, message: expect.stringContaining(`${fact.id}（猜测或拿不准）`) }]);
    expect(check.downgrade).toEqual([claim.id]);
    const v = await validateNightly(t.engine, graphSelfCheck);
    expect(v).toMatchObject({ state: "failed", claimIds: [], downgraded: [claim.id] });
    expect(t.engine.store.getClaim(claim.id)).toMatchObject({ kind: "conclusion", status: "contested" });
    expect(kindRevisions(t.engine, claim.id)).toEqual([]);
    expect(t.engine.store.revisions(claim.id, "claim").at(-1)!.reason).toContain("每晚校验");
    expect(t.engine.gate.history(claim.id).at(-1)).toMatchObject({ actor: "nightly", op: "validate" });
    expect(checkReasoningGraph(t.engine.store).problems).toEqual([]);
  });
});

describe("冲突解决：回到已验证", () => {
  it("冲突的另一边被忘掉、事实回到成立：明说的那条当场跟着事实回到已验证（把握 high、身份不改）；另一边跟着它那条事实撤回；当晚整理一处不拒", async () => {
    const t = await spicy();
    t.setNow("2026-10-06T21:00:00+08:00");
    t.engine.invalidateEvidence("ev-2", "说错了，不算");
    expect(t.engine.store.getFact(t.likesFact.id)!.status).toBe("active");
    expect(t.engine.store.getClaim(t.likes.id)).toMatchObject({ kind: "conclusion", status: "active", confidence: "high" });
    expect(t.engine.store.getClaim(t.dislikes.id)).toMatchObject({ status: "retracted", retractedBy: t.dislikesFact.id });
    const result = await t.engine.runNightly({ userActive: false, manual: true, validator: graphSelfCheck });
    if (!result.ran) throw new Error("应该跑了");
    expect(result.report.reflect.dropped.filter((d) => d.stage === "gate")).toEqual([]);
    expect(result.report.validation).toMatchObject({ state: "ok" });
    expect(kindRevisions(t.engine, t.likes.id)).toEqual([]);
  });
});

describe("事实被推翻：跟着推翻", () => {
  it("事实被本人纠正（亲口否掉）：明说的那条当场撤回，墓碑指纠正的话，推断撤掉；当晚整理照旧", async () => {
    const t = await spicy();
    t.setNow("2026-10-06T21:00:00+08:00");
    t.engine.ingestEvidence(say("ev-3", "上次说的不对", "2026-10-06T20:00:00+08:00", { kind: "correction" }));
    t.engine.correct("ev-1", "ev-3");
    expect(t.engine.store.getFact(t.likesFact.id)!.status).toBe("corrected");
    expect(t.engine.store.getClaim(t.likes.id)).toMatchObject({ status: "retracted", retractedBy: "ev-3" });
    expect(t.engine.store.inferencesOf(t.likes.id).every((i) => i.status === "retracted")).toBe(true);
    await t.engine.reflect();
    expect(t.engine.store.getClaim(t.likes.id)).toMatchObject({ status: "retracted", retractedBy: "ev-3" });
  });

  it("已验证的结论，事实的证据被忘掉（来源失效）：当场撤回，墓碑指那条事实；当晚整理照旧", async () => {
    const t = openEngine("2026-10-05T09:00:00+08:00");
    t.engine.ingestEvidence(say("ev-1", "我喜欢吃辣", "2026-10-05T08:00:00+08:00"));
    await t.engine.reflect();
    const fact = factOf(t.engine, "ev-1", "prefers", "吃辣");
    const claim = explicitClaimOf(t.engine, fact);
    expect(claim).toMatchObject({ kind: "conclusion", status: "active" });
    t.engine.invalidateEvidence("ev-1", "别记这句");
    expect(t.engine.store.getClaim(claim.id)).toMatchObject({ status: "retracted", retractedBy: fact.id });
    await t.engine.reflect();
    expect(t.engine.store.getClaim(claim.id)!.status).toBe("retracted");
  });
});
