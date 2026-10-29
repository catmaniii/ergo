// 226 号票：预测账本（结论当时预测了什么、后来应验没有）。不跑真模型：判预测的模型用假的。
// 规则（票面）：需求层 +14 天、价值观层 +30 天到期；同一结论只留一条开着的；到期判每夜最多 10 条；
// 判不了、没有模型、预算用完都留 open；这一步只记账，不改结论的把握和状态。
import { afterEach, describe, expect, it } from "vitest";
import { addDays } from "../../src/domain/time.ts";
import type { Claim, EvidenceDraft } from "../../src/domain/types.ts";
import { FakeChatModel } from "../../src/llm/chat.ts";
import {
  judgeDuePredictions,
  LlmPredictionJudge,
  MAX_DUE_PREDICTIONS,
  MAX_JUDGE_EVIDENCE,
  PREDICTION_DUE_DAYS,
  recordPredictions,
  runPredictions,
  type PredictionBudget,
  type PredictionJudge,
  type PredictionJudgeInput,
  type PredictionVerdict,
} from "../../src/rg/predictions.ts";
import type { NewClaim } from "../../src/store/store.ts";
import { MemoryStore } from "../../src/store/store.ts";
import { closeEngines, openEngine, say } from "./helpers.ts";

const AT = "2026-10-10T03:00:00+08:00";
const MADE_AT = "2026-10-09T22:00:00+08:00";
const DUE = addDays(AT, 14);
const dueFor = (tier: "need" | "value"): string => addDays(AT, PREDICTION_DUE_DAYS[tier]);

const stores: MemoryStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
afterEach(closeEngines);

function newStore(now: () => string = () => AT): MemoryStore {
  const store = MemoryStore.open(":memory:", { clock: now });
  stores.push(store);
  return store;
}

function addEvidence(store: MemoryStore, id: string, text: string, observedAt: string): EvidenceDraft {
  return store.insertEvidence({ id, sourceLevel: "self", mode: "say", kind: "utterance", text, context: ["weekend"], eventTime: observedAt, observedAt });
}

function addClaim(store: MemoryStore, over: Partial<Omit<Claim, "id">> = {}): Claim {
  const input: NewClaim = {
    tier: "need",
    statement: "需要留出恢复时间",
    kind: "hypothesis",
    epistemic: "inferred",
    method: "induction",
    status: "active",
    confidence: "medium",
    context: ["weekend"],
    validFrom: null,
    validTo: null,
    inferredAt: MADE_AT,
    reviewedAt: null,
    retractedBy: null,
    supersededBy: null,
    competesWith: [],
    predicts: [{ claim: "下个月还会推掉周末的聚会", outcome: "pending", evidenceIds: [] }],
    ...over,
  };
  return store.insertClaim(input);
}

interface FakeJudge extends PredictionJudge {
  calls: PredictionJudgeInput[];
}

/** 假模型：按顺序给结果（对象是判定、null 是判不了、Error 是出错），记下每次喂进去的 */
function fakeJudge(...results: (PredictionVerdict | null | Error)[]): FakeJudge {
  const calls: PredictionJudgeInput[] = [];
  return {
    calls,
    async judgePrediction(input) {
      calls.push(input);
      const next = results[Math.min(calls.length - 1, results.length - 1)]!;
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

const budget = (limit: number): PredictionBudget & { used: number } => {
  let used = 0;
  return {
    get used() {
      return used;
    },
    take: () => {
      if (used >= limit) return false;
      used += 1;
      return true;
    },
  };
};

describe("记下来：需求 +14 天、价值观 +30 天；同一结论只留一条开着的", () => {
  it("新出的需求、价值观结论建一条；低把握、别的层、撤回了的、没有 predicts 的不建", () => {
    const store = newStore();
    const need = addClaim(store);
    const value = addClaim(store, { tier: "value", statement: "长期看重自主安排" });
    const low = addClaim(store, { confidence: "low" });
    const preference = addClaim(store, { tier: "preference" });
    const retracted = addClaim(store, { status: "retracted", retractedBy: "ev-0001" });
    const noPredicts = addClaim(store, { predicts: [] });

    const ids = [need.id, value.id, low.id, preference.id, retracted.id, noPredicts.id];
    expect(recordPredictions(store, ids, AT)).toHaveLength(2);
    const open = store.listPredictions({ status: "open" });
    expect(open.map((p) => p.claimId).toSorted()).toEqual([need.id, value.id].toSorted());
    expect(open.find((p) => p.claimId === need.id)).toMatchObject({ predicts: "下个月还会推掉周末的聚会", madeAt: AT, dueAt: dueFor("need"), status: "open", evidenceId: null, judgedAt: null, note: "" });
    expect(open.find((p) => p.claimId === value.id)?.dueAt).toBe(dueFor("value"));
    expect(PREDICTION_DUE_DAYS).toEqual({ need: 14, value: 30 });

    // 再整理一次同一条结论：不重复建
    expect(recordPredictions(store, ids, AT)).toEqual([]);
    expect(store.listPredictions()).toHaveLength(2);
  });

  it("一条结论的 predicts 有几条就一起记下来（用「；」连起来）", () => {
    const store = newStore();
    const claim = addClaim(store, {
      predicts: [
        { claim: "下个月还会推掉周末的聚会", outcome: "pending", evidenceIds: [] },
        { claim: "下次约他会先问时间", outcome: "pending", evidenceIds: [] },
      ],
    });
    recordPredictions(store, [claim.id], AT);
    expect(store.listPredictions()[0]?.predicts).toBe("下个月还会推掉周末的聚会；下次约他会先问时间");
  });
});

describe("到期判：hit / miss / unclear 写状态、时间、理由、最相关的证据", () => {
  it("到期了、有 made_at 之后的新证据：判 hit", async () => {
    const store = newStore();
    const claim = addClaim(store);
    recordPredictions(store, [claim.id], AT);
    const old = addEvidence(store, "ev-old", "这周末想休息", MADE_AT);
    const fresh = addEvidence(store, "ev-new", "他又推掉了周末的聚会", addDays(AT, 2));
    const judge = fakeJudge({ outcome: "hit", why: "上周又推掉了一次" });

    const stats = await judgeDuePredictions(store, DUE, judge);
    expect(stats).toEqual({ created: 0, judged: 1, hit: 1, miss: 0, unclear: 0, open: 0 });
    expect(store.listPredictions()[0]).toMatchObject({ status: "hit", judgedAt: DUE, evidenceId: fresh.id, note: "上周又推掉了一次" });
    expect(judge.calls).toHaveLength(1);
    expect(judge.calls[0]).toMatchObject({ claimId: claim.id, statement: claim.statement, predicts: "下个月还会推掉周末的聚会", madeAt: AT });
    // 只喂 made_at 之后的新证据，带原话
    expect(judge.calls[0]!.evidence.map((e) => e.id)).toEqual([fresh.id]);
    expect(judge.calls[0]!.evidence[0]!.text).toBe("他又推掉了周末的聚会");
    expect(judge.calls[0]!.evidence.some((e) => e.id === old.id)).toBe(false);
  });

  it("判 miss；判 unclear 也写 judged_at，还开着的只剩别的", async () => {
    const store = newStore();
    const missClaim = addClaim(store, { statement: "会主动约朋友" });
    const unclearClaim = addClaim(store, { statement: "会按时交报告" });
    recordPredictions(store, [missClaim.id], AT);
    recordPredictions(store, [unclearClaim.id], AT);
    addEvidence(store, "ev-new", "他周末没出门，也没约人", addDays(AT, 3));

    const judge = fakeJudge({ outcome: "miss", why: "他周末没出门，也没约人" }, { outcome: "unclear", why: "说不清" });
    const stats = await judgeDuePredictions(store, DUE, judge);
    expect(stats).toEqual({ created: 0, judged: 2, hit: 0, miss: 1, unclear: 1, open: 0 });
    const byClaim = new Map(store.listPredictions().map((p) => [p.claimId, p]));
    expect(byClaim.get(missClaim.id)).toMatchObject({ status: "miss", note: "他周末没出门，也没约人" });
    expect(byClaim.get(unclearClaim.id)).toMatchObject({ status: "unclear", note: "说不清" });
  });

  it("还没到期的不判", async () => {
    const store = newStore();
    const claim = addClaim(store);
    recordPredictions(store, [claim.id], AT);
    addEvidence(store, "ev-new", "他又推掉了", addDays(AT, 1));
    const judge = fakeJudge({ outcome: "hit", why: "应验" });
    expect(await judgeDuePredictions(store, addDays(AT, 13), judge)).toMatchObject({ judged: 0, open: 1 });
    expect(judge.calls).toHaveLength(0);
  });
});

describe("判不了的留 open（下夜再判）：没模型、预算用完、解析不了、没有新证据", () => {
  it("没有模型：只记下来，判不了；给了模型、有预算才判", async () => {
    const store = newStore();
    const claim = addClaim(store);
    addEvidence(store, "ev-new", "他又推掉了", addDays(AT, 2));

    const recorded = await runPredictions(store, { at: AT, claimIds: [claim.id] });
    expect(recorded).toMatchObject({ created: 1, judged: 0, open: 1 });
    expect(store.listPredictions()[0]?.status).toBe("open");

    const judge = fakeJudge({ outcome: "hit", why: "应验" });
    const judged = await runPredictions(store, { at: DUE, claimIds: [], judge, budget: budget(3) });
    expect(judged).toMatchObject({ created: 0, judged: 1, hit: 1, open: 0 });
    expect(judge.calls).toHaveLength(1);
  });

  it("预算用完：一次都不问模型，留 open", async () => {
    const store = newStore();
    const claim = addClaim(store);
    recordPredictions(store, [claim.id], AT);
    addEvidence(store, "ev-new", "他又推掉了", addDays(AT, 2));
    const judge = fakeJudge({ outcome: "hit", why: "应验" });
    const stats = await judgeDuePredictions(store, DUE, judge, { budget: budget(0) });
    expect(stats).toMatchObject({ judged: 0, open: 1 });
    expect(judge.calls).toHaveLength(0);
    expect(store.listPredictions()[0]?.status).toBe("open");
  });

  it("模型说判不了（返回空）或者出错：留 open", async () => {
    const store = newStore();
    const first = addClaim(store);
    const second = addClaim(store, { statement: "会按时交报告" });
    recordPredictions(store, [first.id, second.id], AT);
    addEvidence(store, "ev-new", "什么也没发生", addDays(AT, 2));
    const judge = fakeJudge(null, new Error("模型超时"));
    const stats = await judgeDuePredictions(store, DUE, judge);
    expect(stats).toMatchObject({ judged: 0, open: 2 });
    expect(store.listPredictions().map((p) => p.status)).toEqual(["open", "open"]);
    expect(judge.calls).toHaveLength(2);
  });

  it("made_at 之后没有新证据：不判，也不问模型", async () => {
    const store = newStore();
    const claim = addClaim(store);
    recordPredictions(store, [claim.id], AT);
    const judge = fakeJudge({ outcome: "hit", why: "应验" });
    expect(await judgeDuePredictions(store, DUE, judge)).toMatchObject({ judged: 0, open: 1 });
    expect(judge.calls).toHaveLength(0);
  });

  it("判的时候最多喂 10 条新证据", async () => {
    const store = newStore();
    const claim = addClaim(store);
    recordPredictions(store, [claim.id], AT);
    for (let i = 0; i < MAX_JUDGE_EVIDENCE + 3; i += 1) addEvidence(store, `ev-${String(i).padStart(3, "0")}`, `新记录 ${i}`, addDays(AT, 1));
    const judge = fakeJudge({ outcome: "unclear", why: "太多" });
    await judgeDuePredictions(store, DUE, judge);
    expect(judge.calls[0]!.evidence).toHaveLength(MAX_JUDGE_EVIDENCE);
    // 留的是最新的一批
    expect(judge.calls[0]!.evidence.at(-1)!.text).toBe(`新记录 ${MAX_JUDGE_EVIDENCE + 2}`);
  });
});

describe("到期判每夜最多 10 条", () => {
  it("12 条到期只判前 10 条，剩下 2 条留着", async () => {
    const store = newStore();
    const ids = Array.from({ length: 12 }, (_, i) => addClaim(store, { statement: `结论 ${i}` }).id);
    expect(recordPredictions(store, ids, AT)).toHaveLength(12);
    for (let i = 0; i < 12; i += 1) addEvidence(store, `ev-${String(i).padStart(3, "0")}`, `新记录 ${i}`, addDays(AT, 1));
    const judge = fakeJudge({ outcome: "hit", why: "应验" });
    const stats = await judgeDuePredictions(store, DUE, judge);
    expect(MAX_DUE_PREDICTIONS).toBe(10);
    expect(stats).toEqual({ created: 0, judged: 10, hit: 10, miss: 0, unclear: 0, open: 2 });
    expect(judge.calls).toHaveLength(10);
  });
});

describe("判了进修订日志；这一步只记账，不改结论", () => {
  it("create、update 两条修订；结论的把握、状态一点没动", async () => {
    const store = newStore();
    const claim = addClaim(store);
    recordPredictions(store, [claim.id], AT);
    addEvidence(store, "ev-new", "他又推掉了周末的聚会", addDays(AT, 2));
    const before = store.getClaim(claim.id)!;
    await judgeDuePredictions(store, DUE, fakeJudge({ outcome: "hit", why: "又推掉了一次" }));
    const prediction = store.listPredictions()[0]!;
    const revs = store.revisions(prediction.id, "prediction");
    expect(revs.map((r) => r.op)).toEqual(["create", "update"]);
    expect(revs[1]).toMatchObject({ causeEvidenceId: "ev-new", changes: { status: { from: "open", to: "hit" } } });
    expect(store.getClaim(claim.id)).toEqual(before);
  });
});

describe("模型判（LlmPredictionJudge）：只喂结论、它写的 predicts、made_at 之后的新证据原话", () => {
  const input: PredictionJudgeInput = {
    claimId: "cl-0001",
    statement: "需要留出恢复时间",
    predicts: "下个月还会推掉周末的聚会",
    madeAt: AT,
    evidence: [{ id: "ev-new", text: "他又推掉了周末的聚会", observedAt: addDays(AT, 2) }],
  };

  it("要 JSON、解析成 hit / miss / unclear；请求里带结论、预测和证据原话", async () => {
    const model = new FakeChatModel((request) => {
      expect(request.purpose).toBe("prediction");
      expect(request.user).toContain("需要留出恢复时间");
      expect(request.user).toContain("下个月还会推掉周末的聚会");
      expect(request.user).toContain("他又推掉了周末的聚会");
      expect(request.user).toContain("ev-new");
      return { outcome: "miss", why: "记录里他又推掉了" };
    });
    const judge = new LlmPredictionJudge(model);
    expect(await judge.judgePrediction(input)).toEqual({ outcome: "miss", why: "记录里他又推掉了" });
    expect(model.calls).toHaveLength(1);
  });

  it("解析不了、outcome 不认得、why 空：判不了（返回 null），留 open", async () => {
    expect(await new LlmPredictionJudge(new FakeChatModel(() => "不是 JSON")).judgePrediction(input)).toBeNull();
    expect(await new LlmPredictionJudge(new FakeChatModel(() => ({ outcome: "应验", why: "x" }))).judgePrediction(input)).toBeNull();
    expect(await new LlmPredictionJudge(new FakeChatModel(() => ({ outcome: "hit", why: " " }))).judgePrediction(input)).toBeNull();
    expect(await new LlmPredictionJudge(new FakeChatModel(() => ({ outcome: "unclear", why: "证据不够" }))).judgePrediction(input)).toEqual({ outcome: "unclear", why: "证据不够" });
  });
});

describe("接到整理流程：reflect 末尾记下来、到期判；nightly 报告里有一行", () => {
  it("reflect 跳过（没有新证据）时照样判到期预测，统计写进 ReflectReport", async () => {
    const t = openEngine(AT, { predictionJudge: fakeJudge({ outcome: "hit", why: "又推掉了一次" }) });
    const claim = addClaim(t.engine.store);
    recordPredictions(t.engine.store, [claim.id], AT);
    const evidence = t.engine.ingestEvidence(say("ev-new", "他又推掉了周末的聚会", addDays(AT, 2)));
    // 这条证据算整理过了：reflect 直接走"没有新证据、也没有待复核的"的跳过分支
    t.engine.rg.registry.markReflected(evidence.id, t.engine.rg.reasoner.id);
    t.setNow(DUE);

    const report = await t.engine.reflect();
    expect(report.skipped).toBeDefined();
    expect(report.predictions).toEqual({ created: 0, judged: 1, hit: 1, miss: 0, unclear: 0, open: 0 });
    expect(t.engine.store.listPredictions()[0]).toMatchObject({ status: "hit", judgedAt: DUE });
  });

  it("夜间整理：报告字段和一行文字；预测判了也不改结论的把握和状态", async () => {
    const t = openEngine(AT, { predictionJudge: fakeJudge({ outcome: "hit", why: "又推掉了一次" }) });
    const claim = addClaim(t.engine.store);
    recordPredictions(t.engine.store, [claim.id], AT);
    t.engine.ingestEvidence(say("ev-new", "他又推掉了周末的聚会", addDays(AT, 2)));
    const before = t.engine.store.getClaim(claim.id)!;
    t.setNow(DUE);

    const result = await t.engine.runNightly({ userActive: false });
    if (!result.ran) throw new Error("这一夜应该跑");
    expect(result.report.predictions).toEqual({ created: 0, judged: 1, hit: 1, miss: 0, unclear: 0, open: 0 });
    expect(result.report.text).toContain("预测账本");
    expect(result.report.text).toContain("应验 1");
    expect(t.engine.store.getClaim(claim.id)).toEqual(before);
  });

  it("预算用完（maxModelCalls 0）：到期预测留 open，下夜再判", async () => {
    const judge = fakeJudge({ outcome: "hit", why: "又推掉了一次" });
    const t = openEngine(AT, { predictionJudge: judge });
    const claim = addClaim(t.engine.store);
    recordPredictions(t.engine.store, [claim.id], AT);
    t.engine.ingestEvidence(say("ev-new", "他又推掉了周末的聚会", addDays(AT, 2)));
    t.setNow(DUE);

    const result = await t.engine.runNightly({ userActive: false, maxModelCalls: 0 });
    if (!result.ran) throw new Error("这一夜应该跑");
    expect(result.report.predictions).toMatchObject({ judged: 0, open: 1 });
    expect(judge.calls).toHaveLength(0);
    expect(t.engine.store.listPredictions()[0]?.status).toBe("open");
  });
});
