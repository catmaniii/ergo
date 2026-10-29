// 226 号票：预测账本的表和存储方法（增、查、改，改动进修订日志）。
// 账本的建、判在 rg/predictions.ts（test/rg/predictions.test.ts），这里只管存储这一层。
import { afterEach, describe, expect, it } from "vitest";
import type { Claim, EvidenceDraft } from "../../src/domain/types.ts";
import { ValidationError } from "../../src/domain/validate.ts";
import { MemoryStore, type NewPrediction } from "../../src/store/store.ts";

const CLOCK = "2026-10-10T03:00:00+08:00";
const MADE_AT = "2026-10-10T03:00:00+08:00";
const DUE_AT = "2026-10-24T03:00:00+08:00";

const stores: MemoryStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function open(): MemoryStore {
  const store = MemoryStore.open(":memory:", { clock: () => CLOCK });
  stores.push(store);
  return store;
}

const draft = (id: string, observedAt = MADE_AT): EvidenceDraft => ({
  id,
  sourceLevel: "self",
  mode: "say",
  kind: "utterance",
  text: "这周末还是想自己安排。",
  context: ["weekend"],
  eventTime: observedAt,
  observedAt,
});

function addClaim(store: MemoryStore, over: Partial<Omit<Claim, "id">> = {}): Claim {
  return store.insertClaim({
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
    inferredAt: CLOCK,
    reviewedAt: null,
    retractedBy: null,
    supersededBy: null,
    competesWith: [],
    predicts: [{ claim: "下个月还会推掉周末的聚会", outcome: "pending", evidenceIds: [] }],
    ...over,
  });
}

function newPrediction(claimId: string, over: Partial<NewPrediction> = {}): NewPrediction {
  return {
    claimId,
    predicts: "下个月还会推掉周末的聚会",
    madeAt: MADE_AT,
    dueAt: DUE_AT,
    status: "open",
    evidenceId: null,
    judgedAt: null,
    note: "",
    ...over,
  };
}

describe("预测账本：存储", () => {
  it("写一条、按 id 读；不给 id 就分配 pd-NNNN；新建进修订日志", () => {
    const store = open();
    const claim = addClaim(store);
    const prediction = store.putPrediction(newPrediction(claim.id));
    expect(prediction).toMatchObject({ id: "pd-0001", claimId: claim.id, status: "open", judgedAt: null, evidenceId: null, note: "" });
    expect(store.getPrediction(prediction.id)).toEqual(prediction);
    const revs = store.revisions(prediction.id, "prediction");
    expect(revs.map((r) => r.op)).toEqual(["create"]);
    expect(revs[0]).toMatchObject({ objectType: "prediction", objectId: prediction.id, at: CLOCK });
    expect(store.getPrediction("pd-9999")).toBeUndefined();
  });

  it("查：按状态、结论、到期时间；按写入先后", () => {
    const store = open();
    store.insertEvidence(draft("ev-001"));
    const c1 = addClaim(store);
    const c2 = addClaim(store, { statement: "长期看重自主安排", tier: "value" });
    const a = store.putPrediction(newPrediction(c1.id, { dueAt: "2026-10-24T03:00:00+08:00" }));
    const b = store.putPrediction(newPrediction(c2.id, { dueAt: "2026-11-09T03:00:00+08:00" }));
    const c = store.putPrediction(newPrediction(c1.id, { dueAt: "2026-10-12T03:00:00+08:00", status: "hit", judgedAt: "2026-10-12T03:00:00+08:00", evidenceId: "ev-001", note: "应验了" }));

    expect(store.listPredictions().map((p) => p.id)).toEqual([a.id, b.id, c.id]);
    expect(store.listPredictions({ status: "open" }).map((p) => p.id)).toEqual([a.id, b.id]);
    expect(store.listPredictions({ status: ["open", "hit"] }).map((p) => p.id)).toEqual([a.id, b.id, c.id]);
    expect(store.listPredictions({ claimId: c1.id }).map((p) => p.id)).toEqual([a.id, c.id]);
    expect(store.listPredictions({ dueBefore: "2026-10-24T03:00:00+08:00" }).map((p) => p.id)).toEqual([a.id, c.id]);
    expect(store.listPredictions({ status: "open", claimId: c2.id }).map((p) => p.id)).toEqual([b.id]);
  });

  it("改：判了以后写状态、判定时间、理由、证据，改动进修订日志；没改的不写", () => {
    const store = open();
    store.insertEvidence(draft("ev-001"));
    const claim = addClaim(store);
    const prediction = store.putPrediction(newPrediction(claim.id));
    const judged = store.updatePrediction(
      prediction.id,
      { status: "hit", judgedAt: CLOCK, evidenceId: "ev-001", note: "又推掉了一次" },
      { reason: "到期判：hit", evidenceId: "ev-001" },
    );
    expect(judged).toMatchObject({ status: "hit", judgedAt: CLOCK, evidenceId: "ev-001", note: "又推掉了一次" });
    const revs = store.revisions(prediction.id, "prediction");
    expect(revs.map((r) => r.op)).toEqual(["create", "update"]);
    expect(revs[1]).toMatchObject({
      causeEvidenceId: "ev-001",
      reason: "到期判：hit",
      changes: { status: { from: "open", to: "hit" }, judgedAt: { from: null, to: CLOCK }, note: { from: "", to: "又推掉了一次" } },
    });
    store.updatePrediction(prediction.id, { note: "又推掉了一次" }, { reason: "重复" });
    expect(store.revisions(prediction.id, "prediction")).toHaveLength(2);
  });

  it("写入前校验：状态、id、时间、判定时间和状态要对得上", () => {
    const store = open();
    const claim = addClaim(store);
    expect(() => store.putPrediction(newPrediction(claim.id, { status: "pending" as never }))).toThrow(ValidationError);
    expect(() => store.putPrediction({ ...newPrediction(claim.id), id: "xx-0001" })).toThrow(ValidationError);
    expect(() => store.putPrediction(newPrediction(claim.id, { madeAt: "2026-10-10" }))).toThrow(ValidationError);
    expect(() => store.putPrediction(newPrediction(claim.id, { status: "hit" }))).toThrow(/judgedAt/);
    expect(() => store.putPrediction(newPrediction(claim.id, { judgedAt: CLOCK }))).toThrow(/judgedAt/);
    expect(() => store.putPrediction(newPrediction(claim.id, { claimId: "fa-0001" }))).toThrow(ValidationError);
    expect(() => store.putPrediction(newPrediction(claim.id, { evidenceId: "cl-0001" }))).toThrow(ValidationError);
    expect(store.listPredictions()).toEqual([]);
  });
});
