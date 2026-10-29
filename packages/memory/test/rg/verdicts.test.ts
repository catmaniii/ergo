// 263 号票：用户对一条结论直接表态（对 / 不对 / 拿不准）走引擎，不直接改库——不然下一次整理计分又把它改回去。
// 例子是周末社交案例（任务书第 11 节，规则版）：前三条时那组四种解释都还拿不准；第 4 条进来以后"重视周末自主安排"成立、
// "不喜欢社交"碰上"我不反感见朋友"——330 号票（R14）起随口说的不再自动算决定性，它只降成猜测；要撤回得用户纠正（afterCorrection）。
import { afterEach, describe, expect, it } from "vitest";
import { isVerdictEvidence, VERDICT_SOURCE_PREFIX } from "../../src/evidence/boundary.ts";
import { judgeDuePredictions, type PredictionJudgeInput } from "../../src/rg/predictions.ts";
import { ClaimVerdictRefused } from "../../src/rg/verdicts.ts";
import { claimOf, closeEngines, explicitClaimOf, factOf, ingestWeekend, openEngine, say } from "./helpers.ts";

afterEach(closeEngines);

const FIRST_THREE = ["ev-w01", "ev-w02", "ev-w03"];

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

/** 330 号票（R14）：第 4 条以后用户又纠正了一句"我不是不喜欢社交"——纠正算决定性，"不喜欢社交"被它撤回（不是表态撤的） */
async function afterCorrection() {
  const t = await afterFour();
  t.setNow("2026-10-14T12:00:00+08:00");
  t.engine.ingestEvidence(say("ev-w05", "我不是不喜欢社交，之前那么说不对，跟朋友见面我挺乐意的。", "2026-10-14T11:00:00+08:00", { kind: "correction", context: ["weekend", "social"] }));
  await t.engine.reflect();
  return t;
}

/** 再来一条和这组无关的话，让下一次整理不跳过（有新证据才整一遍） */
function chatter(t: Awaited<ReturnType<typeof afterThree>>, id: string, at: string): void {
  t.setNow(at);
  t.engine.ingestEvidence(say(id, "今天中午吃了碗面。", at));
}

describe("用户说这条对：走 confirmClaim，整理不改回", () => {
  it("对照：直接改库把还拿不准的那条改成成立，下一次整理计分又改回拿不准", async () => {
    const t = await afterThree();
    const autonomy = claimOf(t.engine, "scene_autonomy");
    expect(autonomy.status).toBe("contested");
    t.engine.store.updateClaim(autonomy.id, { status: "active" }, { reason: "测试：直接改库" });
    chatter(t, "ev-n1", "2026-10-10T12:00:00+08:00");
    await t.engine.reflect();
    expect(t.engine.store.getClaim(autonomy.id)!.status).toBe("contested");
  });

  it("记一条本人的表态证据（不抽事实），标你确认过、记决定性支持、重定那组；再整理一次还是成立", async () => {
    const t = await afterThree();
    const autonomy = claimOf(t.engine, "scene_autonomy");
    const result = t.engine.recordClaimVerdict(autonomy.id, "confirm", { via: "经记忆管理员", note: "记忆管理员按用户的话改成成立：用户说就是这样" });
    expect(result.withdrawn).toEqual([]);
    expect(result.claim).toMatchObject({ status: "active", epistemic: "user_confirmed", method: "user_confirmation" });
    const evidence = t.engine.getEvidence(result.evidenceId)!;
    expect(evidence).toMatchObject({ sourceLevel: "self", mode: "say", kind: "approval", sourceRef: `${VERDICT_SOURCE_PREFIX}${autonomy.id}`, status: "active" });
    expect(evidence.text).toContain("经记忆管理员");
    expect(evidence.text).toContain(autonomy.statement);
    expect(isVerdictEvidence(evidence)).toBe(true);
    // 管理员写的原因进证据入库那条修订
    expect(t.engine.store.revisions(evidence.id, "evidence")[0]!.reason).toContain("用户说就是这样");
    expect(t.engine.store.linksOf(autonomy.id).find((l) => l.target === evidence.id)).toMatchObject({ polarity: "supports", weight: "decisive" });

    chatter(t, "ev-n1", "2026-10-10T12:00:00+08:00");
    const report = await t.engine.reflect();
    expect(report.skipped).toBeUndefined();
    expect(t.engine.store.getClaim(autonomy.id)).toMatchObject({ status: "active", epistemic: "user_confirmed" });
    // 表态那句不抽事实（它是"用户说这条对"，不是用户原来的话，抽了会重复计数）
    expect(t.engine.store.factsByEvidence(evidence.id)).toEqual([]);
  });

  it("因为依据不在了才撤回的（被用户的纠正推翻），不能直接改回成立", async () => {
    const t = await afterCorrection();
    const social = claimOf(t.engine, "dislike_domain");
    expect(social.status).toBe("retracted");
    const before = t.engine.store.listEvidence().length;
    let caught: unknown;
    try {
      t.engine.recordClaimVerdict(social.id, "confirm");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ClaimVerdictRefused);
    expect(caught).toMatchObject({ code: "retracted", claimId: social.id });
    // 拒了就什么都不写
    expect(t.engine.store.listEvidence()).toHaveLength(before);
    expect(t.engine.store.getClaim(social.id)!.status).toBe("retracted");
  });
});

describe("用户说这条不对：记决定性反证，整理不改回", () => {
  it("对照：直接改库把成立的那条改成拿不准，下一次整理计分又改回成立；直接改库撤回的（墓碑指一条还在的证据）不复活，可也没有用户的那句话", async () => {
    const t = await afterFour();
    const autonomy = claimOf(t.engine, "scene_autonomy");
    expect(autonomy.status).toBe("active");
    t.engine.store.updateClaim(autonomy.id, { status: "contested" }, { reason: "测试：直接改库" });
    chatter(t, "ev-n1", "2026-10-14T12:00:00+08:00");
    await t.engine.reflect();
    expect(t.engine.store.getClaim(autonomy.id)!.status).toBe("active");
    // 329 号票（R11）：撤回不被计分改回，只在推翻它的东西不在了时复活。直接改库写的墓碑指着一条还在的证据，所以留着；
    // 但库里没有用户否认的证据、没有反证，下游也没跟着撤——所以用户说不对照样要走 recordClaimVerdict
    // （以前管理员的工具写 retractedBy: null，连库都写不进去——retracted 要有墓碑，校验直接拒；这里给一条当墓碑）
    t.engine.store.updateClaim(autonomy.id, { status: "retracted", retractedBy: "ev-w04" }, { reason: "测试：直接改库" });
    chatter(t, "ev-n2", "2026-10-15T12:00:00+08:00");
    await t.engine.reflect();
    expect(t.engine.store.getClaim(autonomy.id)!.status).toBe("retracted");
    expect(t.engine.store.linksOf(autonomy.id).some((l) => l.polarity === "refutes" && l.weight === "decisive")).toBe(false);
  });

  it("撤回、墓碑指向那句表态；再整理一次还是撤回", async () => {
    const t = await afterFour();
    const autonomy = claimOf(t.engine, "scene_autonomy");
    const result = t.engine.recordClaimVerdict(autonomy.id, "reject", { note: "用户说不是这样" });
    expect(result.claim).toMatchObject({ status: "retracted", retractedBy: result.evidenceId });
    expect(t.engine.store.linksOf(autonomy.id).find((l) => l.target === result.evidenceId)).toMatchObject({ polarity: "refutes", weight: "decisive" });
    chatter(t, "ev-n1", "2026-10-14T12:00:00+08:00");
    await t.engine.reflect();
    expect(t.engine.store.getClaim(autonomy.id)).toMatchObject({ status: "retracted", retractedBy: result.evidenceId });
  });

  it("先说对、后说不对：先前那句确认收回（按纠正处理，不再当依据），撤回，标回推断的；再整理一次还是撤回", async () => {
    const t = await afterFour();
    const autonomy = claimOf(t.engine, "scene_autonomy");
    const confirmed = t.engine.recordClaimVerdict(autonomy.id, "confirm");
    expect(confirmed.claim.epistemic).toBe("user_confirmed");
    t.setNow("2026-10-13T13:00:00+08:00");
    const rejected = t.engine.recordClaimVerdict(autonomy.id, "reject");
    expect(rejected.withdrawn).toEqual([confirmed.evidenceId]);
    expect(t.engine.getEvidence(confirmed.evidenceId)!.status).toBe("corrected");
    expect(rejected.claim).toMatchObject({ status: "retracted", retractedBy: rejected.evidenceId, epistemic: "inferred", method: "abduction" });
    chatter(t, "ev-n1", "2026-10-14T12:00:00+08:00");
    await t.engine.reflect();
    expect(t.engine.store.getClaim(autonomy.id)).toMatchObject({ status: "retracted", retractedBy: rejected.evidenceId });
  });

  it("先说不对、后又说对：先前那句否认收回，恢复成立、标你确认过；再整理一次还是成立", async () => {
    const t = await afterFour();
    const autonomy = claimOf(t.engine, "scene_autonomy");
    const rejected = t.engine.recordClaimVerdict(autonomy.id, "reject");
    t.setNow("2026-10-13T13:00:00+08:00");
    const confirmed = t.engine.recordClaimVerdict(autonomy.id, "confirm");
    expect(confirmed.withdrawn).toEqual([rejected.evidenceId]);
    expect(confirmed.claim).toMatchObject({ status: "active", epistemic: "user_confirmed" });
    chatter(t, "ev-n1", "2026-10-14T12:00:00+08:00");
    await t.engine.reflect();
    expect(t.engine.store.getClaim(autonomy.id)).toMatchObject({ status: "active", epistemic: "user_confirmed" });
  });

  it("明说的断言跟着用户说的话走，不能直接撤：拒绝并交回它背后的证据（要改得纠正、忘掉那句话）", async () => {
    const t = await afterFour();
    const stated = explicitClaimOf(t.engine, factOf(t.engine, "ev-w04", "dislikes", "被提前排满", false));
    expect(stated.epistemic).toBe("explicit");
    let caught: unknown;
    try {
      t.engine.recordClaimVerdict(stated.id, "reject");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ClaimVerdictRefused);
    expect(caught).toMatchObject({ code: "explicit", claimId: stated.id, evidenceIds: ["ev-w04"] });
    expect(t.engine.store.getClaim(stated.id)!.status).toBe("active");
  });

  it("已经撤回的再说不对：拒绝（没什么可改的）", async () => {
    const t = await afterCorrection();
    const social = claimOf(t.engine, "dislike_domain");
    expect(() => t.engine.recordClaimVerdict(social.id, "reject")).toThrow(ClaimVerdictRefused);
  });
});

describe("用户说这条拿不准：加复核标记，下一次整理按证据重判", () => {
  it("加复核标记（真值状态不动，329 号票）；下一次整理按现有的证据重判（证据还撑得住就还是成立），摘掉标记", async () => {
    const t = await afterFour();
    const autonomy = claimOf(t.engine, "scene_autonomy");
    const result = t.engine.recordClaimVerdict(autonomy.id, "doubt", { note: "记忆管理员按用户的话加复核标记" });
    expect(result.claim).toMatchObject({ status: "active", needsReview: true });
    // 拿不准不记支持也不记反证
    expect(t.engine.store.linksOf(autonomy.id).some((l) => l.target === result.evidenceId)).toBe(false);
    expect(t.engine.store.revisions(autonomy.id, "claim").at(-1)!.reason).toContain("记忆管理员");
    await t.engine.reflect();
    expect(t.engine.store.getClaim(autonomy.id)).toMatchObject({ status: "active", needsReview: false });
  });

  it("先说对、后说拿不准：先前那句确认收回，标回推断的；整理时不再靠那句确认", async () => {
    const t = await afterThree();
    const autonomy = claimOf(t.engine, "scene_autonomy");
    const confirmed = t.engine.recordClaimVerdict(autonomy.id, "confirm");
    expect(confirmed.claim.status).toBe("active");
    const doubted = t.engine.recordClaimVerdict(autonomy.id, "doubt");
    expect(doubted.withdrawn).toEqual([confirmed.evidenceId]);
    // 证实它的那句确认收回了（R7）：退回原来的推理链，先当猜测、加复核标记
    expect(doubted.claim).toMatchObject({ status: "contested", needsReview: true, epistemic: "inferred" });
    await t.engine.reflect();
    // 没有那句确认，四种解释又分不出来
    expect(t.engine.store.getClaim(autonomy.id)).toMatchObject({ status: "contested", epistemic: "inferred" });
  });

  it("因为依据不在了才撤回的，不能加复核标记", async () => {
    const t = await afterCorrection();
    const social = claimOf(t.engine, "dislike_domain");
    expect(() => t.engine.recordClaimVerdict(social.id, "doubt")).toThrow(ClaimVerdictRefused);
  });
});

describe("表态证据不当观察", () => {
  it("判到期预测时，用户对结论的表态不算新证据（那不是预测说的事发生了）", async () => {
    const t = await afterFour();
    const autonomy = claimOf(t.engine, "scene_autonomy");
    t.engine.store.putPrediction({ claimId: autonomy.id, predicts: "两周内还会推掉别人排好的周末活动", madeAt: "2026-10-10T03:00:00+08:00", dueAt: "2026-10-13T03:00:00+08:00", status: "open", evidenceId: null, judgedAt: null, note: "" });
    const verdict = t.engine.recordClaimVerdict(autonomy.id, "confirm");
    const seen: PredictionJudgeInput[] = [];
    await judgeDuePredictions(t.engine.store, "2026-10-13T12:00:00+08:00", {
      judgePrediction: async (input) => {
        seen.push(input);
        return { outcome: "unclear", why: "测试" };
      },
    });
    expect(seen).toHaveLength(1);
    const ids = seen[0]!.evidence.map((e) => e.id);
    expect(ids).toContain("ev-w04");
    expect(ids).not.toContain(verdict.evidenceId);
  });
});

