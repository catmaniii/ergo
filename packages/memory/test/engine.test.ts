import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { USER_ENTITY_ID } from "../src/domain/ids.ts";
import type { EvidenceDraft, Fact } from "../src/domain/types.ts";
import { FakeEmbedder } from "../src/embedding/fake.ts";
import { MemoryEngine, type InvalidationEvent } from "../src/engine.ts";
import { SyntheticEventsSource } from "../src/evidence/synthetic.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/weekend-events.json", import.meta.url));
const CLOCK = "2026-10-20T12:00:00+08:00";

const engines: MemoryEngine[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function open(options: Partial<Parameters<typeof MemoryEngine.open>[0]> = {}): MemoryEngine {
  const engine = MemoryEngine.open({ file: ":memory:", clock: () => CLOCK, ...options });
  engines.push(engine);
  return engine;
}

/** 关于用户的、谓词加宾语名的简写 */
function brief(engine: MemoryEngine, f: Fact): string {
  const obj = f.object.type === "value" ? f.object.value : engine.getEntity(f.object.id)!.name;
  return `${f.negated ? "¬" : ""}${f.predicate}(${obj})`;
}

const draft = (id: string, text: string, at: string, over: Partial<EvidenceDraft> = {}): EvidenceDraft => ({
  id,
  sourceLevel: "self",
  mode: "say",
  kind: "utterance",
  text,
  context: [],
  eventTime: at,
  observedAt: at,
  ...over,
});

describe("MemoryEngine：周末社交案例的写入和查询", () => {
  it("证据入库、抽事实：参与和拒绝、时间、场景都在事实图谱里", () => {
    const engine = open();
    const evidence = engine.ingestFrom(SyntheticEventsSource.fromFile(FIXTURE));
    expect(evidence.map((e) => e.id)).toEqual(["ev-w01", "ev-w02", "ev-w03", "ev-w04", "ev-u01"]);
    expect(engine.getEvidence("ev-w01")).toMatchObject({ text: "这周六的聚会我就不去了，最近周末想好好休息。", sourceLevel: "self", status: "active", sourceRef: "fixture:ev-w01" });

    const report = engine.extractFacts();
    expect(report.processed).toEqual(["ev-w01", "ev-w02", "ev-w03", "ev-w04", "ev-u01"]);
    const facts = report.newFactIds.map((id) => engine.getFact(id)!);
    expect(facts.map((f) => brief(engine, f))).toEqual([
      "declined(聚会)",
      "prefers(休息)",
      "participated_in(技术交流)",
      "declined(活动)",
      "¬dislikes(见朋友)",
      "dislikes(被提前排满)",
      "dislikes(社交)",
    ]);
    expect(facts[0]!.statement).toBe("用户 2026-10-01 在周末、社交场合拒绝了聚会");
    expect(facts[2]!.statement).toBe("用户 2026-10-03 在工作日、社交场合、工作中参加了技术交流");
    expect(facts.at(-1)).toMatchObject({ assertion: "third_party_reported", evidenceIds: ["ev-u01"] });

    // 再抽一遍什么都不做（记着处理过哪些证据）
    expect(engine.extractFacts()).toMatchObject({ processed: [], newFactIds: [] });
  });

  it("按时间点和场景查：周末的不推广到工作日", () => {
    const engine = open();
    engine.ingestFrom(SyntheticEventsSource.fromFile(FIXTURE));
    engine.extractFacts();
    const weekend = engine.factsAt({ at: "2026-10-14T00:00:00+08:00", context: ["weekend"], subjectId: USER_ENTITY_ID }).map((f) => brief(engine, f));
    expect(weekend).toEqual(["declined(聚会)", "prefers(休息)", "declined(活动)", "¬dislikes(见朋友)", "dislikes(被提前排满)", "dislikes(社交)"]);
    const workday = engine.factsAt({ at: "2026-10-14T00:00:00+08:00", context: ["workday"] }).map((f) => brief(engine, f));
    expect(workday).toEqual(["participated_in(技术交流)", "dislikes(社交)"]);
    // 10 月 5 日那时只知道前两条
    expect(engine.factsAt({ at: "2026-10-05T00:00:00+08:00" }).map((f) => brief(engine, f))).toEqual(["declined(聚会)", "prefers(休息)", "participated_in(技术交流)"]);
    // 不填时间 = 现在（时钟）
    expect(engine.factsAt({}).length).toBe(7);
  });

  it("按实体查邻接：从聚会一跳到用户、两跳到用户的其他事", () => {
    const engine = open();
    engine.ingestFrom(SyntheticEventsSource.fromFile(FIXTURE));
    engine.extractFacts();
    const party = engine.store.findEntityByName("聚会")!;
    expect(engine.neighbors(party.id, 1).entities.map((e) => e.entity.name)).toEqual(["用户"]);
    const two = engine.neighbors(party.id, 2).entities.map((e) => `${e.entity.name}:${e.hops}`);
    expect(two).toEqual(expect.arrayContaining(["用户:1", "技术交流:2", "见朋友:2", "休息:2"]));
  });

  it("库是一个文件：关了再开，证据、事实、抽取记录都在", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-lab-engine-"));
    dirs.push(dir);
    const file = path.join(dir, "lab.db");
    const first = MemoryEngine.open({ file, clock: () => CLOCK });
    first.ingestFrom(SyntheticEventsSource.fromFile(FIXTURE));
    const ids = first.extractFacts().newFactIds;
    first.close();
    const again = open({ file });
    expect(again.getFact(ids[0]!)?.predicate).toBe("declined");
    expect(again.extractFacts().processed).toEqual([]);
  });
});

function withHook() {
  const events: InvalidationEvent[] = [];
  const engine = open({ propagation: { onInvalidation: (event) => events.push(event) } });
  return { engine, events };
}

describe("MemoryEngine：纠正和忘掉（事实这一层 + 推理图谱的钩子）", () => {
  it("忘掉一条证据：原文清空、索引删掉；只靠它的事实撤回，有别的证据的去掉它；钩子收到一次", () => {
    const { engine, events } = withHook();
    engine.ingestEvidence(draft("ev-1", "我喜欢爬山", "2026-10-01T10:00:00+08:00"));
    engine.ingestEvidence(draft("ev-2", "还是喜欢爬山，也喜欢吃辣", "2026-10-02T10:00:00+08:00"));
    engine.extractFacts();
    const hike = engine.factsAt({}).find((f) => brief(engine, f) === "prefers(爬山)")!;
    const spicy = engine.factsAt({}).find((f) => brief(engine, f) === "prefers(吃辣)")!;
    expect(hike.evidenceIds).toEqual(["ev-1", "ev-2"]);

    const report = engine.invalidateEvidence("ev-2", "用户说忘掉");
    expect(engine.getEvidence("ev-2")).toMatchObject({ status: "forgotten", text: "" });
    expect(engine.store.db.all("SELECT * FROM evidence_fts WHERE evidence_id = 'ev-2'")).toEqual([]);
    expect(report).toMatchObject({ cause: "evidence_forgotten", evidenceId: "ev-2", byEvidenceId: null, reason: "用户说忘掉", retractedFactIds: [spicy.id], weakenedFactIds: [hike.id] });
    expect(engine.getFact(spicy.id)).toMatchObject({ status: "retracted", retractedBy: "ev-2" });
    expect(engine.getFact(hike.id)).toMatchObject({ status: "active", evidenceIds: ["ev-1"] });
    expect(events).toEqual([report]);
    expect(engine.store.revisions("ev-2").map((r) => r.reason)).toEqual(["证据入库", "用户说忘掉"]);
    // 再忘一次什么都不做
    expect(engine.invalidateEvidence("ev-2", "又说一次")).toMatchObject({ retractedFactIds: [], weakenedFactIds: [] });
    expect(events).toHaveLength(1);
  });

  it("用一条本人证据纠正另一条：旧证据 corrected，只靠它的事实 corrected，钩子收到", () => {
    const { engine, events } = withHook();
    engine.ingestEvidence(draft("ev-1", "我喜欢爬山", "2026-10-01T10:00:00+08:00"));
    engine.ingestEvidence(draft("ev-2", "上次说的不对", "2026-10-05T10:00:00+08:00", { kind: "correction" }));
    engine.extractFacts();
    const [hike] = engine.factsAt({});
    const report = engine.correct("ev-1", "ev-2");
    expect(engine.getEvidence("ev-1")).toMatchObject({ status: "corrected", text: "我喜欢爬山" });
    expect(engine.getFact(hike!.id)).toMatchObject({ status: "corrected", retractedBy: "ev-2" });
    expect(report).toMatchObject({ cause: "evidence_corrected", evidenceId: "ev-1", byEvidenceId: "ev-2", retractedFactIds: [hike!.id] });
    expect(events).toEqual([report]);
  });

  it("纠正要由本人的证据来做；不能纠正忘掉了的、不能自己纠正自己", () => {
    const engine = open();
    engine.ingestEvidence(draft("ev-1", "我喜欢爬山", "2026-10-01T10:00:00+08:00"));
    engine.ingestEvidence(draft("ev-2", "他其实不喜欢爬山", "2026-10-05T10:00:00+08:00", { sourceLevel: "untrusted" }));
    engine.ingestEvidence(draft("ev-3", "我说错了", "2026-10-06T10:00:00+08:00", { kind: "correction" }));
    expect(() => engine.correct("ev-1", "ev-2")).toThrow(/本人/);
    expect(() => engine.correct("ev-1", "ev-1")).toThrow(/自己/);
    expect(() => engine.correct("ev-9", "ev-3")).toThrow(/ev-9/);
    engine.invalidateEvidence("ev-1", "忘掉");
    expect(() => engine.correct("ev-1", "ev-3")).toThrow(/忘掉/);
  });

  it("纠正的话抽成事实时把旧事实纠正了：钩子也收到（fact_corrected）", () => {
    const { engine, events } = withHook();
    engine.ingestEvidence(draft("ev-1", "我喜欢爬山", "2026-10-01T10:00:00+08:00"));
    engine.extractFacts();
    const [old] = engine.factsAt({});
    engine.ingestEvidence(draft("ev-2", "记错了，我其实一直不喜欢爬山", "2026-10-15T10:00:00+08:00", { kind: "correction" }));
    const report = engine.extractFacts();
    expect(report.correctedFactIds).toEqual([old!.id]);
    expect(report.changes).toEqual([expect.objectContaining({ kind: "correction", oldFactId: old!.id })]);
    expect(events).toEqual([expect.objectContaining({ cause: "fact_corrected", evidenceId: "ev-2", retractedFactIds: [old!.id] })]);
  });

  it("钩子在同一个事务里：钩子出错，纠正整个不算", () => {
    const engine = open({
      propagation: {
        onInvalidation: () => {
          throw new Error("推理图谱传播出错");
        },
      },
    });
    engine.ingestEvidence(draft("ev-1", "我喜欢爬山", "2026-10-01T10:00:00+08:00"));
    engine.extractFacts();
    expect(() => engine.invalidateEvidence("ev-1", "忘掉")).toThrow("推理图谱传播出错");
    expect(engine.getEvidence("ev-1")!.status).toBe("active");
    expect(engine.factsAt({})).toHaveLength(1);
  });
});

describe("MemoryEngine：向量", () => {
  it("给证据原文和事实的精炼陈述各算一份向量（文档角色），算过的不再算；忘掉的不算", async () => {
    const embedder = new FakeEmbedder();
    const engine = open({ embedder });
    engine.ingestFrom(SyntheticEventsSource.fromFile(FIXTURE));
    engine.extractFacts();
    engine.invalidateEvidence("ev-u01", "忘掉");
    expect(await engine.indexVectors()).toEqual({ model: "fake-embed@1", evidence: 4, facts: 6 });
    expect(embedder.calls.every((c) => c.role === "document")).toBe(true);
    expect(engine.store.getFactVector(engine.factsAt({})[0]!.id, "fake-embed@1")).toBeInstanceOf(Float32Array);
    expect(await engine.indexVectors()).toEqual({ model: "fake-embed@1", evidence: 0, facts: 0 });
  });

  it("没有向量函数、模型不在时跳过，说明原因", async () => {
    expect(await open().indexVectors()).toMatchObject({ model: null, evidence: 0, facts: 0, skipped: expect.stringMatching(/没有向量函数/) });
    const missing = open({ embedder: new FakeEmbedder({ available: false }) });
    missing.ingestEvidence(draft("ev-1", "我喜欢爬山", "2026-10-01T10:00:00+08:00"));
    expect(await missing.indexVectors()).toMatchObject({ model: "fake-embed@1", evidence: 0, facts: 0, skipped: expect.stringMatching(/不在/) });
  });
});

describe("MemoryEngine：检索和推理图谱都接上了", () => {
  it("空库时四种检索都回空；没有断言时解释、追溯报没有这条", async () => {
    const engine = open();
    await expect(engine.search("周末", { mode: "hybrid" })).resolves.toEqual([]);
    await expect(engine.search("周末", { mode: "hybrid_kg" })).resolves.toEqual([]);
    await expect(engine.search("周末", { mode: "hybrid_kg_rg" })).resolves.toEqual([]);
    expect((await engine.reflect()).skipped).toMatch(/没有新证据/);
    expect(() => engine.explainClaim("cl-0001")).toThrow(/cl-0001/);
    expect(() => engine.tracePremises("cl-0001")).toThrow(/cl-0001/);
    await expect(engine.findCounterevidence("cl-0001")).rejects.toThrow(/cl-0001/);
    expect(engine.getUserModel({})).toMatchObject({ state: [], preferences: [], values: [], uncertain: [] });
  });
});
