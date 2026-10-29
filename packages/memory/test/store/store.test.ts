import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { USER_ENTITY_ID } from "../../src/domain/ids.ts";
import type { EvidenceDraft, Fact } from "../../src/domain/types.ts";
import { ValidationError } from "../../src/domain/validate.ts";
import { MemoryStore, type NewFact } from "../../src/store/store.ts";

const T1 = "2026-10-01T20:10:00+08:00";
const T2 = "2026-10-03T19:30:00+08:00";
const CLOCK = "2026-10-20T12:00:00+08:00";

const dirs: string[] = [];
function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-lab-store-"));
  dirs.push(dir);
  return path.join(dir, "memory-lab.db");
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const draft = (over: Partial<EvidenceDraft> = {}): EvidenceDraft => ({
  id: "ev-001",
  sourceLevel: "self",
  mode: "say",
  kind: "utterance",
  text: "这周六的聚会我就不去了，最近周末想好好休息。",
  context: ["weekend", "social"],
  eventTime: T1,
  observedAt: T1,
  ...over,
});

function newFact(store: MemoryStore, over: Partial<NewFact> = {}): NewFact {
  const party = store.findEntityByName("聚会") ?? store.insertEntity({ type: "activity", name: "聚会", aliases: ["派对"] });
  return {
    subjectId: USER_ENTITY_ID,
    predicate: "declined",
    object: { type: "entity", id: party.id },
    negated: false,
    statement: "用户 2026-10-01 在周末、社交场合拒绝了聚会",
    assertion: "user_stated",
    context: ["weekend", "social"],
    evidenceIds: ["ev-001"],
    eventTime: T1,
    observedAt: T1,
    validFrom: T1,
    validTo: null,
    status: "active",
    supersededBy: null,
    retractedBy: null,
    contestedWith: [],
    extractedBy: "rule:1",
    ...over,
  };
}

function open(file = ":memory:"): MemoryStore {
  return MemoryStore.open(file, { clock: () => CLOCK });
}

describe("存储：一个 SQLite 文件（WAL）", () => {
  it("文件库开 WAL；关了再开，什么都还在", () => {
    const file = tempFile();
    const store = open(file);
    expect(store.journalMode()).toBe("wal");
    const ev = store.insertEvidence(draft());
    const fact = store.insertFact(newFact(store), { reason: "规则抽取", evidenceId: ev.id });
    const claim = store.insertClaim({
      tier: "preference",
      statement: "当前阶段重视周末自主安排",
      kind: "hypothesis",
      epistemic: "inferred",
      method: "abduction",
      status: "active",
      confidence: "low",
      context: ["weekend"],
      validFrom: T1,
      validTo: null,
      inferredAt: CLOCK,
      reviewedAt: null,
      retractedBy: null,
      supersededBy: null,
      competesWith: [],
      predicts: [{ claim: "下次周末聚会也会推掉", outcome: "pending", evidenceIds: [] }],
    });
    store.putLink({ claimId: claim.id, target: ev.id, polarity: "supports", rationale: "说最近周末想休息" });
    const inference = store.insertInference({ conclusionClaimId: claim.id, premiseIds: [fact.id, ev.id], method: "abduction", rationale: "拒绝周末聚会 + 想休息", by: "rule:1", status: "active" });
    const probe = store.insertProbe({ discriminates: [claim.id, fact.id], ask: "周末主动约过朋友吗？", queries: ["约朋友"], ifFound: null, outcome: "open", foundEvidenceIds: [] });
    store.close();

    const again = open(file);
    expect(again.getEvidence(ev.id)).toEqual(ev);
    expect(again.getFact(fact.id)).toEqual(fact);
    expect(again.getClaim(claim.id)).toEqual(claim);
    expect(again.linksOf(claim.id)).toEqual([{ claimId: claim.id, target: ev.id, polarity: "supports", rationale: "说最近周末想休息", weight: "weak" }]);
    expect(again.getInference(inference.id)).toEqual(inference);
    expect(again.getProbe(probe.id)).toEqual(probe);
    expect(again.getEntity(USER_ENTITY_ID)?.name).toBe("用户");
    again.close();
  });

  it("证据：沿用给的 id、算内容哈希；不给 id 就分配 ev-NNNN；同一个 id 再写一次原样返回", () => {
    const store = open();
    const ev = store.insertEvidence(draft());
    expect(ev).toMatchObject({ id: "ev-001", status: "active", sourceRef: null });
    expect(ev.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(store.insertEvidence(draft())).toEqual(ev);
    expect(() => store.insertEvidence(draft({ text: "别的话" }))).toThrow(/ev-001/);
    const auto = store.insertEvidence(draft({ id: undefined, text: "又一句" }));
    expect(auto.id).toBe("ev-0001");
    store.close();
  });

  it("写入前校验，不合格的不写", () => {
    const store = open();
    expect(() => store.insertEvidence(draft({ eventTime: "2026-10-01" }))).toThrow(ValidationError);
    expect(store.listEvidence()).toEqual([]);
    expect(() => store.insertFact(newFact(store, { evidenceIds: [] }), { reason: "x" })).toThrow(ValidationError);
    store.close();
  });

  it("证据按发生的时间排（不知道的按知道的时间）", () => {
    const store = open();
    store.insertEvidence(draft({ id: "ev-b", eventTime: T2, observedAt: T2 }));
    store.insertEvidence(draft({ id: "ev-c", eventTime: null, observedAt: "2026-10-02T09:00:00+08:00" }));
    store.insertEvidence(draft({ id: "ev-a" }));
    expect(store.listEvidence().map((e) => e.id)).toEqual(["ev-a", "ev-c", "ev-b"]);
    store.close();
  });

  it("实体：按名字和别名找（大小写不敏感），加别名", () => {
    const store = open();
    const e = store.insertEntity({ type: "activity", name: "技术交流", aliases: ["技术分享会", "Meetup"] });
    expect(e.id).toBe("en-0001");
    expect(store.findEntityByName("技术分享会")?.id).toBe(e.id);
    expect(store.findEntityByName("meetup")?.id).toBe(e.id);
    expect(store.findEntityByName("我")?.id).toBe(USER_ENTITY_ID);
    store.addAlias(e.id, "技术沙龙", { reason: "对齐" });
    expect(store.findEntityByName("技术沙龙")?.id).toBe(e.id);
    expect(store.getEntity(e.id)?.aliases).toEqual(["技术分享会", "Meetup", "技术沙龙"]);
    store.close();
  });

  it("事实：按证据反查、按 id 改，改动写进修订日志", () => {
    const store = open();
    store.insertEvidence(draft());
    store.insertEvidence(draft({ id: "ev-002", text: "推掉了周末的活动", eventTime: T2, observedAt: T2 }));
    const f = store.insertFact(newFact(store), { reason: "规则抽取", evidenceId: "ev-001" });
    expect(f.id).toBe("fa-0001");
    const updated = store.updateFact(f.id, { evidenceIds: ["ev-001", "ev-002"] }, { reason: "又一条证据", evidenceId: "ev-002" });
    expect(updated.evidenceIds).toEqual(["ev-001", "ev-002"]);
    expect(store.factsByEvidence("ev-002").map((x) => x.id)).toEqual([f.id]);
    store.updateFact(f.id, { evidenceIds: ["ev-002"] }, { reason: "去掉失效的证据", evidenceId: "ev-001" });
    expect(store.factsByEvidence("ev-001")).toEqual([]);

    const revs = store.revisions(f.id);
    expect(revs.map((r) => r.op)).toEqual(["create", "update", "update"]);
    expect(revs[1]).toMatchObject({ objectType: "fact", causeEvidenceId: "ev-002", reason: "又一条证据", at: CLOCK, changes: { evidenceIds: { from: ["ev-001"], to: ["ev-001", "ev-002"] } } });
    // 没改动的不写修订
    store.updateFact(f.id, { evidenceIds: ["ev-002"] }, { reason: "重复" });
    expect(store.revisions(f.id)).toHaveLength(3);
    store.close();
  });

  it("修订日志只追加：改不了、删不了", () => {
    const store = open();
    store.insertEvidence(draft());
    expect(store.revisions("ev-001")).toHaveLength(1);
    expect(() => store.db.run("UPDATE revisions SET reason = 'x'")).toThrow(/只追加/);
    expect(() => store.db.run("DELETE FROM revisions")).toThrow(/只追加/);
    expect(store.revisions("ev-001")).toHaveLength(1);
    store.close();
  });

  it("证据和精炼陈述各有一张关键词索引（trigram）；忘掉的证据、撤回的事实从索引里删掉", () => {
    const store = open();
    store.insertEvidence(draft());
    const f = store.insertFact(newFact(store), { reason: "抽取" });
    const ftsEvidence = (q: string) => store.db.all<{ evidence_id: string }>("SELECT evidence_id FROM evidence_fts WHERE evidence_fts MATCH ?", q).map((r) => r.evidence_id);
    const ftsFact = (q: string) => store.db.all<{ fact_id: string }>("SELECT fact_id FROM fact_fts WHERE fact_fts MATCH ?", q).map((r) => r.fact_id);
    expect(ftsEvidence("好好休息")).toEqual(["ev-001"]);
    expect(ftsFact("拒绝了聚会")).toEqual([f.id]);

    store.putEvidenceVector("ev-001", "fake@1", new Float32Array([1, 0]));
    store.putFactVector(f.id, "fake@1", new Float32Array([0, 1]));
    // 精炼陈述改了：索引跟着换，旧向量作废
    store.updateFact(f.id, { statement: "用户 2026-10-01 拒绝了周六的聚会" }, { reason: "重写陈述" });
    expect(ftsFact("拒绝了聚会")).toEqual([]);
    expect(ftsFact("周六的聚会")).toEqual([f.id]);
    expect(store.getFactVector(f.id, "fake@1")).toBeUndefined();

    store.updateFact(f.id, { status: "retracted", retractedBy: "ev-001" }, { reason: "证据忘掉了", evidenceId: "ev-001" });
    expect(ftsFact("周六的聚会")).toEqual([]);
    store.updateEvidence("ev-001", { status: "forgotten", text: "" }, { reason: "忘掉", evidenceId: "ev-001" });
    expect(ftsEvidence("好好休息")).toEqual([]);
    // 修订日志只追加，所以原文不能记进去：只记改了、多长
    const forgot = store.revisions("ev-001").at(-1)!;
    expect(forgot.changes.text).toEqual({ from: { redacted: true, chars: 22 }, to: { redacted: true, chars: 0 } });
    expect(JSON.stringify(store.revisions())).not.toContain("好好休息");
    expect(store.getEvidenceVector("ev-001", "fake@1")).toBeUndefined();
    store.close();
  });

  it("向量：每条记模型名，按模型列出还没有向量的证据和事实", () => {
    const store = open();
    store.insertEvidence(draft());
    store.insertEvidence(draft({ id: "ev-002", text: "报名了技术交流会", eventTime: T2, observedAt: T2 }));
    const f = store.insertFact(newFact(store), { reason: "抽取" });
    store.putEvidenceVector("ev-001", "fake@1", new Float32Array([0.6, 0.8]));
    expect(Array.from(store.getEvidenceVector("ev-001", "fake@1")!)).toEqual([0.6000000238418579, 0.800000011920929]);
    expect(store.getEvidenceVector("ev-001", "other@2")).toBeUndefined();
    expect(store.evidenceMissingVectors("fake@1").map((e) => e.id)).toEqual(["ev-002"]);
    expect(store.evidenceMissingVectors("other@2").map((e) => e.id)).toEqual(["ev-001", "ev-002"]);
    expect(store.factsMissingVectors("fake@1").map((x) => x.id)).toEqual([f.id]);
    store.close();
  });

  it("断言、关联、推断、追问：按 id 改、按前提和目标反查", () => {
    const store = open();
    store.insertEvidence(draft());
    const fact = store.insertFact(newFact(store), { reason: "抽取" });
    const base = {
      tier: "preference" as const,
      kind: "hypothesis" as const,
      epistemic: "inferred" as const,
      method: "abduction" as const,
      status: "active" as const,
      confidence: "low" as const,
      context: ["weekend"],
      validFrom: T1,
      validTo: null,
      inferredAt: CLOCK,
      reviewedAt: null,
      retractedBy: null,
      supersededBy: null,
      competesWith: [],
      predicts: [],
    };
    const h1 = store.insertClaim({ ...base, statement: "普遍不喜欢社交" });
    const h2 = store.insertClaim({ ...base, statement: "当前阶段重视周末自主安排", competesWith: [h1.id] });
    store.updateClaim(h1.id, { competesWith: [h2.id], status: "contested" }, { reason: "登记竞争假设" });
    expect(store.getClaim(h1.id)).toMatchObject({ status: "contested", competesWith: [h2.id] });
    expect(store.listClaims({ status: "contested" }).map((c) => c.id)).toEqual([h1.id]);

    store.putLink({ claimId: h1.id, target: fact.id, polarity: "supports", rationale: "拒绝聚会" });
    store.putLink({ claimId: h2.id, target: fact.id, polarity: "supports", rationale: "拒绝的是周末的" });
    expect(store.linksTo(fact.id).map((l) => l.claimId).toSorted()).toEqual([h1.id, h2.id].toSorted());
    store.removeLink({ claimId: h1.id, target: fact.id, polarity: "supports" }, { reason: "不再支持" });
    expect(store.linksTo(fact.id).map((l) => l.claimId)).toEqual([h2.id]);

    const inf = store.insertInference({ conclusionClaimId: h2.id, premiseIds: [fact.id, "ev-001"], method: "abduction", rationale: "", by: "rule:1", status: "active" });
    expect(store.inferencesByPremise(fact.id).map((i) => i.id)).toEqual([inf.id]);
    expect(store.inferencesOf(h2.id).map((i) => i.id)).toEqual([inf.id]);
    store.updateInference(inf.id, { status: "needs_review" }, { reason: "前提被纠正", evidenceId: "ev-001" });
    expect(store.getInference(inf.id)?.status).toBe("needs_review");

    const probe = store.insertProbe({ discriminates: [h1.id, h2.id], ask: "工作日愿意参加交流吗？", queries: ["技术交流"], ifFound: h2.id, outcome: "open", foundEvidenceIds: [] });
    store.updateProbe(probe.id, { outcome: "found", foundEvidenceIds: ["ev-001"] }, { reason: "找到了" });
    expect(store.listProbes({ outcome: "found" }).map((p) => p.id)).toEqual([probe.id]);
    expect(store.revisions(h1.id, "claim").map((r) => r.op)).toEqual(["create", "update"]);
    expect(store.revisions(h1.id, "link").map((r) => r.op)).toEqual(["create", "delete"]);
    store.close();
  });

  it("事务：出错整体回滚，可以嵌套（里面的并进外面的）", () => {
    const store = open();
    expect(() =>
      store.transaction(() => {
        store.insertEvidence(draft());
        store.transaction(() => store.insertEvidence(draft({ id: "ev-002", text: "第二句" })));
        throw new Error("中途出错");
      }),
    ).toThrow("中途出错");
    expect(store.listEvidence()).toEqual([]);
    store.close();
  });

  it("抽取记录：哪条证据被哪个抽取器处理过", () => {
    const store = open();
    store.insertEvidence(draft());
    expect(store.isExtracted("ev-001", "rule:1")).toBe(false);
    store.markExtracted("ev-001", "rule:1", ["fa-0001"]);
    expect(store.isExtracted("ev-001", "rule:1")).toBe(true);
    expect(store.isExtracted("ev-001", "model:deepseek")).toBe(false);
    store.close();
  });

  it("按状态和时间查事实的底层：validFrom ≤ at < validTo", () => {
    const store = open();
    store.insertEvidence(draft());
    const a = store.insertFact(newFact(store, { validFrom: "2026-03-01T00:00:00+08:00", validTo: "2026-10-10T00:00:00+08:00", status: "superseded", supersededBy: "fa-0002" }), { reason: "x" });
    const b = store.insertFact(newFact(store, { validFrom: "2026-10-10T00:00:00+08:00" }), { reason: "x" });
    const c = store.insertFact(newFact(store, { validFrom: null, status: "corrected", retractedBy: "ev-001" }), { reason: "x" });
    const ids = (at: string) => store.factsValidAt(at).map((f: Fact) => f.id);
    expect(ids("2026-05-01T00:00:00+08:00")).toEqual([a.id]);
    expect(ids("2026-10-10T00:00:00+08:00")).toEqual([b.id]);
    expect(ids("2026-10-15T00:00:00+08:00")).toEqual([b.id]);
    expect(c.status).toBe("corrected");
    store.close();
  });
});
