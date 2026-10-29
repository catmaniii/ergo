// 227 号票：对抗复核（reflect 末尾的一步，假模型）+ 复评水位、表象覆盖（整理报告）。
// 复核员不看结论：只给支持证据原话（最多 8 条、打乱顺序），先让它写自己的推断，再判候选结论 yes / no / unclear。
// no → 结论待复核（记修订，原因"对抗复核不一致"）；unclear 只计数；单独 5 次调用预算；判过的不重复判。
import { afterEach, describe, expect, it } from "vitest";
import type { Claim, EvidenceDraft, Fact } from "../src/domain/types.ts";
import type { MemoryEngine } from "../src/engine.ts";
import { FakeChatModel, type ChatRequest } from "../src/llm/chat.ts";
import { reviewDueCount } from "../src/nightly.ts";
import { adversarialReview, REVIEW_MAX_CALLS } from "../src/rg/adversarial.ts";
import { isReviewDue } from "../src/rg/nightly-lanes.ts";
import type { HypothesisGroupDraft, ProbeDraft, ProbeJudgement, Reasoner } from "../src/rg/types.ts";
import { closeEngines, ingestWeekend, openEngine, say } from "./rg/helpers.ts";

afterEach(closeEngines);

const NOW = "2026-10-10T03:00:00+08:00";
const SUPPORT_TIME = "2026-09-20T21:00:00+08:00";

/** 一条能进复核的结论：need、active、medium、inferred，带支持它的证据原话 */
function eligibleClaim(engine: MemoryEngine, statement: string, evidenceIds: readonly string[], over: Partial<Omit<Claim, "id">> = {}): Claim {
  const claim = engine.store.insertClaim({
    tier: "need",
    statement,
    kind: "hypothesis",
    epistemic: "inferred",
    method: "abduction",
    status: "active",
    confidence: "medium",
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
  });
  for (const id of evidenceIds) engine.store.putLink({ claimId: claim.id, target: id, polarity: "supports", weight: "strong", rationale: "支持它的原话" });
  return claim;
}

/** 按候选结论（提示词里的「」）给判断的假复核员；另外记下每次请求 */
function reviewerOf(verdicts: Readonly<Record<string, "yes" | "no" | "unclear">>, options: { fallback?: "yes" | "no" | "unclear"; onRequest?: (request: ChatRequest) => void } = {}) {
  return new FakeChatModel((request: ChatRequest) => {
    options.onRequest?.(request);
    const statement = /候选结论：「([^」]+)」/.exec(request.user)?.[1] ?? "";
    const support = verdicts[statement] ?? options.fallback ?? "yes";
    return { inference: "从这些观察看，这个人想自己安排时间", support, why: `复核判 ${support}` };
  }, "fake-reviewer");
}

const ingest = (engine: MemoryEngine, id: string, text: string, over: Partial<EvidenceDraft> = {}) => engine.ingestEvidence(say(id, text, SUPPORT_TIME, over));

describe("对抗复核（227）", () => {
  it("判 no：结论加复核标记（真值状态不动）、记一条原因'对抗复核不一致'的修订，进 rejectedByReview", async () => {
    const t = openEngine(NOW);
    const evidence = ingest(t.engine, "ev-r1", "周末不想被别人提前排满，想自己安排。", { context: ["weekend"] });
    const claim = eligibleClaim(t.engine, "用户需要能自己安排周末", [evidence.id]);
    const model = reviewerOf({ "用户需要能自己安排周末": "no" });

    const out = await adversarialReview({ store: t.engine.store, at: NOW, model });

    expect(out.report.reviewed).toEqual([claim.id]);
    expect(out.report.rejectedByReview).toEqual([claim.id]);
    expect(out.report.unclear).toBe(0);
    expect(out.report.modelCalls).toBe(1);
    expect(t.engine.store.getClaim(claim.id)).toMatchObject({ status: "active", needsReview: true, reviewedAt: NOW });
    expect(t.engine.store.revisions(claim.id, "claim").map((r) => r.reason)).toContain("对抗复核不一致");
    expect(t.engine.store.claimReviewed(claim.id)).toBe(true);
  });

  it("判 yes：结论不动，只记复核过", async () => {
    const t = openEngine(NOW);
    const evidence = ingest(t.engine, "ev-r2", "周末想自己安排时间。", { context: ["weekend"] });
    const before = eligibleClaim(t.engine, "用户需要能自己安排周末", [evidence.id]);
    const model = reviewerOf({ "用户需要能自己安排周末": "yes" });

    const out = await adversarialReview({ store: t.engine.store, at: NOW, model });

    expect(out.report.reviewed).toEqual([before.id]);
    expect(out.report.rejectedByReview).toEqual([]);
    expect(t.engine.store.getClaim(before.id)).toEqual(before);
    expect(t.engine.store.claimReviewed(before.id)).toBe(true);
  });

  it("判 unclear：只计数，结论不动", async () => {
    const t = openEngine(NOW);
    const evidence = ingest(t.engine, "ev-r3", "周末有时候想自己安排，有时候随便。", { context: ["weekend"] });
    const claim = eligibleClaim(t.engine, "用户需要能自己安排周末", [evidence.id]);
    const model = reviewerOf({ "用户需要能自己安排周末": "unclear" });

    const out = await adversarialReview({ store: t.engine.store, at: NOW, model });

    expect(out.report.reviewed).toEqual([claim.id]);
    expect(out.report.rejectedByReview).toEqual([]);
    expect(out.report.unclear).toBe(1);
    expect(t.engine.store.getClaim(claim.id)?.status).toBe("active");
  });

  it("单独 5 次预算：第 6 条不问、记 budgetExhausted；判过的不重复判，下次接着判剩下那条", async () => {
    const t = openEngine(NOW);
    const evidence = ingest(t.engine, "ev-r4", "周末想自己安排。", { context: ["weekend"] });
    const claims = Array.from({ length: 6 }, (_, i) => eligibleClaim(t.engine, `用户需要第 ${i + 1} 件事`, [evidence.id]));
    const model = reviewerOf({});

    const first = await adversarialReview({ store: t.engine.store, at: NOW, model });
    expect(first.report.modelCalls).toBe(REVIEW_MAX_CALLS);
    expect(first.report.reviewed).toEqual(claims.slice(0, REVIEW_MAX_CALLS).map((c) => c.id));
    expect(first.report.budgetExhausted).toBe(true);
    expect(t.engine.store.claimReviewed(claims[5]!.id)).toBe(false);

    const second = await adversarialReview({ store: t.engine.store, at: NOW, model });
    expect(second.report.reviewed).toEqual([claims[5]!.id]);
    expect(second.report.modelCalls).toBe(1);
    expect(second.report.budgetExhausted).toBe(false);

    const third = await adversarialReview({ store: t.engine.store, at: NOW, model });
    expect(third.report.reviewed).toEqual([]);
    expect(third.report.modelCalls).toBe(0);
    expect(third.report.skipped).toContain("没有要复核的结论");
    expect(model.calls).toHaveLength(6);
  });

  it("只复核 active、medium/high、inferred 的 need/value；别的都不碰", async () => {
    const t = openEngine(NOW);
    const evidence = ingest(t.engine, "ev-r5", "周末想自己安排。", { context: ["weekend"] });
    const eligible = eligibleClaim(t.engine, "用户需要能自己安排周末", [evidence.id]);
    eligibleClaim(t.engine, "把握还不够的需求", [evidence.id], { confidence: "low" });
    eligibleClaim(t.engine, "还拿不准的需求", [evidence.id], { status: "contested" });
    eligibleClaim(t.engine, "一条偏好，不是需求", [evidence.id], { tier: "preference" });
    eligibleClaim(t.engine, "用户自己说的需求", [evidence.id], { epistemic: "explicit", method: "explicit" });
    const model = reviewerOf({});

    const out = await adversarialReview({ store: t.engine.store, at: NOW, model });

    expect(out.report.reviewed).toEqual([eligible.id]);
    expect(model.calls).toHaveLength(1);
  });

  it("复核员先只看到观察原话：最多 8 条，候选结论放在'先自己写推断'之后", async () => {
    const t = openEngine(NOW);
    const ids = Array.from({ length: 10 }, (_, i) => ingest(t.engine, `ev-o${i + 1}`, `第 ${i + 1} 条观察：周末想自己安排。`, { context: ["weekend"] }).id);
    const claim = eligibleClaim(t.engine, "用户需要能自己安排周末", ids);
    let request: ChatRequest | undefined;
    const model = reviewerOf({}, { onRequest: (r) => (request = r) });

    await adversarialReview({ store: t.engine.store, at: NOW, model });

    expect(request?.purpose).toBe("review");
    expect(request?.system).toContain("独立复核员");
    const numbered = request!.user.split("\n").filter((line) => /^\d+\. /.test(line));
    expect(numbered).toHaveLength(8);
    for (const line of numbered) expect(line).toMatch(/^\d+\. 第 \d+ 条观察/);
    expect(request!.user.indexOf("先写下")).toBeGreaterThan(-1);
    expect(request!.user.indexOf("先写下")).toBeLessThan(request!.user.indexOf(`候选结论：「${claim.statement}」`));
    // 提示词（模型看到的那段）里不出现系统原来的证据 id，只有原话
    expect(request!.user).not.toContain("ev-o1");
  });
});

// 只出 need/value 结论的推理实现：给出三条本人事实就能建一组，领头的成立、有把握（medium）
class NeedValueReasoner implements Reasoner {
  readonly id = "rule:test-need-value";

  async propose(observations: Fact[]): Promise<HypothesisGroupDraft[]> {
    const ids = observations.slice(0, 3).map((f) => f.id);
    if (ids.length < 3) return [];
    return [
      {
        key: "test|need",
        pattern: "test",
        params: {},
        description: "三个月、三种场合都说想自己安排",
        observationIds: ids,
        hypotheses: [
          {
            template: "test:autonomy",
            tier: "need",
            statement: "用户需要能自己安排周末",
            context: ["weekend"],
            validFrom: null,
            validTo: null,
            method: "abduction",
            links: ids.map((id) => ({ target: id, polarity: "supports", weight: "strong", rationale: "每次都这么说" })),
          },
          {
            template: "test:arranged",
            tier: "need",
            statement: "用户需要别人替他安排周末",
            context: ["weekend"],
            validFrom: null,
            validTo: null,
            method: "abduction",
            links: [],
          },
        ],
      },
    ];
  }

  async probesFor(): Promise<ProbeDraft[]> {
    return [];
  }

  async judge(): Promise<ProbeJudgement> {
    return { outcome: "not_found", foundEvidenceIds: [], ifFound: null, links: [] };
  }
}

describe("整理时跑对抗复核；报告里的复评水位、表象覆盖（227）", () => {
  it("每晚整理时 reflect 末尾复核新结论；判 no 的进整理报告，整理报告里打对抗复核那一行", async () => {
    const t = openEngine("2026-10-10T02:00:00+08:00", { reasoner: new NeedValueReasoner(), reviewer: reviewerOf({ "用户需要能自己安排周末": "no" }), joint: false });
    t.engine.ingestEvidence(say("ev-i1", "我喜欢爬山。", "2026-07-01T10:00:00+08:00", { context: ["weekend"] }));
    t.engine.ingestEvidence(say("ev-i2", "我喜欢游泳。", "2026-08-01T10:00:00+08:00", { context: ["workday"] }));
    t.engine.ingestEvidence(say("ev-i3", "我喜欢跑步。", "2026-09-01T10:00:00+08:00", { context: ["social"] }));
    t.setNow("2026-10-10T03:00:00+08:00");

    const r = await t.engine.runNightly({ userActive: false });
    if (!r.ran) throw new Error("应该跑了");

    const review = r.report.reflect.review;
    expect(review).toMatchObject({ modelCalls: 1, unclear: 0, budgetExhausted: false });
    expect(review!.reviewed).toHaveLength(1);
    expect(review!.rejectedByReview).toEqual([review!.reviewed[0]]);
    const rejected = t.engine.store.getClaim(review!.reviewed[0]!)!;
    expect(rejected).toMatchObject({ status: "active", needsReview: true, tier: "need", confidence: "medium", epistemic: "inferred" });
    expect(r.report.needsReview.map((c) => c.id)).toContain(rejected.id);
    expect(r.report.text).toContain("对抗复核");
    expect(r.report.text).toContain(rejected.id);
  });

  it("表象覆盖：这一夜处理的证据按来源级别（含本人纠正）和说/做分桶，报告里打一行", async () => {
    const t = openEngine("2026-10-09T22:00:00+08:00");
    const drafts: EvidenceDraft[] = [
      say("ev-k1", "周末想自己安排。", "2026-10-09T20:00:00+08:00"),
      say("ev-k2", "周日去爬山了。", "2026-10-09T20:10:00+08:00", { mode: "do", kind: "action" }),
      say("ev-k3", "其实我更喜欢在家。", "2026-10-09T20:20:00+08:00", { kind: "correction" }),
      say("ev-k4", "他最近挺累的。", "2026-10-09T20:30:00+08:00", { sourceLevel: "untrusted" }),
      say("ev-k5", "助理记：用户提到周末。", "2026-10-09T20:40:00+08:00", { sourceLevel: "agent" }),
      say("ev-k6", "系统：这个问题跳过两次。", "2026-10-09T20:50:00+08:00", { sourceLevel: "system", mode: "do", kind: "action" }),
    ];
    for (const draft of drafts) t.engine.ingestEvidence(draft);
    t.setNow("2026-10-10T03:00:00+08:00");

    const r = await t.engine.runNightly({ userActive: false });
    if (!r.ran) throw new Error("应该跑了");

    expect(r.report.reflect.processedEvidenceIds).toEqual(expect.arrayContaining(drafts.map((d) => d.id!)));
    expect(r.report.representation).toEqual({ 本人说的: 1, 本人做的: 1, 本人纠正: 1, 别人转述: 1, 助理记的: 1, 系统记的: 1 });
    expect(r.report.text).toContain("表象覆盖");
    // 没给复核模型（规则版）就不复核，也不调模型
    expect(r.report.reflect.review).toBeUndefined();
  });

  it("复评水位：active 且 reviewed_at 为空或早于 30 天前的条数，报告里打一行", async () => {
    const t = openEngine("2026-10-09T22:00:00+08:00");
    ingestWeekend(t.engine, ["ev-w01", "ev-w02", "ev-w03"]);
    t.engine.ingestEvidence(say("ev-p1", "我喜欢爬山。", "2026-10-08T10:00:00+08:00"));
    t.engine.ingestEvidence(say("ev-p2", "我喜欢游泳。", "2026-10-08T11:00:00+08:00"));
    t.setNow("2026-10-10T03:00:00+08:00");
    expect(await t.engine.runNightly({ userActive: false })).toMatchObject({ ran: true });

    // 两条推断的、成立的：一条很久没复核，一条刚复核过（272 号票起明说的不算，见下一条）
    const stale = eligibleClaim(t.engine, "用户需要能自己安排周末", ["ev-w01"]);
    const recent = eligibleClaim(t.engine, "用户看重周末的自主", ["ev-w01"]);
    t.engine.store.updateClaim(stale.id, { reviewedAt: "2026-08-01T00:00:00+08:00" }, { reason: "测试：很久没复核" });
    t.engine.store.updateClaim(recent.id, { reviewedAt: "2026-10-09T00:00:00+08:00" }, { reason: "测试：刚复核过" });

    t.setNow("2026-10-11T03:00:00+08:00");
    const r = await t.engine.runNightly({ userActive: false });
    if (!r.ran) throw new Error("应该跑了");

    const expected = t.engine.store.listClaims({ status: "active" }).filter((c) => c.epistemic !== "explicit" && c.reviewedAt === null).length + 1;
    expect(r.report.reviewDue).toBe(expected);
    expect(r.report.text).toContain(`到期待复评 ${expected} 条`);
    // 这一夜没有新处理的证据
    expect(r.report.representation).toEqual({});
  });

  // 272 号票第 5 条：线上"到期待复评 106 条"全是用户明说的偏好——明说的跟着用户的话走（那句话被纠正、忘掉时才动），不按 30 天复评，
  // 从这一行和计数里拿掉；推断的照旧
  it("用户明说的结论不算到期待复评：从没复核过、很久没复核的都不算；推断的照旧算", async () => {
    const t = openEngine("2026-10-09T22:00:00+08:00");
    ingestWeekend(t.engine, ["ev-w01", "ev-w02", "ev-w03"]);
    t.engine.ingestEvidence(say("ev-p1", "我喜欢爬山。", "2026-10-08T10:00:00+08:00"));
    t.engine.ingestEvidence(say("ev-p2", "我喜欢游泳。", "2026-10-08T11:00:00+08:00"));
    t.setNow("2026-10-10T03:00:00+08:00");
    expect(await t.engine.runNightly({ userActive: false })).toMatchObject({ ran: true });
    // 一条推断的、成立的（往上抽出来的需求这类），从没复核过
    eligibleClaim(t.engine, "用户需要能自己安排周末", ["ev-w01"]);
    const active = t.engine.store.listClaims({ status: "active" });
    const stated = active.filter((c) => c.epistemic === "explicit");
    const inferred = active.filter((c) => c.epistemic !== "explicit");
    expect(stated.length).toBeGreaterThanOrEqual(2);
    expect(inferred.length).toBeGreaterThanOrEqual(1);
    // 一条明说的很久没复核过，别的明说的从没复核过：都不算；推断的从没复核过：算
    t.engine.store.updateClaim(stated[0]!.id, { reviewedAt: "2026-08-01T00:00:00+08:00" }, { reason: "测试：很久没复核" });
    for (const c of inferred) expect(c.reviewedAt).toBeNull();
    const at = "2026-10-11T03:00:00+08:00";
    for (const c of stated) expect(isReviewDue(t.engine.store.getClaim(c.id)!, at)).toBe(false);
    for (const c of inferred) expect(isReviewDue(c, at)).toBe(true);
    expect(reviewDueCount(t.engine.store, at)).toBe(inferred.length);

    t.setNow(at);
    const r = await t.engine.runNightly({ userActive: false });
    if (!r.ran) throw new Error("应该跑了");
    expect(r.report.reviewDue).toBe(t.engine.store.listClaims({ status: "active" }).filter((c) => c.epistemic !== "explicit" && c.reviewedAt === null).length);
    expect(r.report.text).toContain(`到期待复评 ${r.report.reviewDue} 条（30 天没复核过；用户明说的不算）`);
  });
});
