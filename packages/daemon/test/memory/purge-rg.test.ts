// 234 号票：彻底删除登记进推理库、别推断、敏感类别（模块层，临时目录 + 规则版，不调模型）。
// 覆盖：删素材 → 按素材 id 找到证据、证据和它的事实没了、依赖的结论待复核、相关问题过期、审计有记录、
// 原文在 rg.db 里搜不到；别推断不静默保留成立；素材检索不受影响。（直接删事实的 purgeFacts 263 号票删了：没有调用方）
// 303 号票：几条数据源素材合成的一条证据，删其中一条就撤整条、剩下的下一夜重新读；启动时数据源素材的证据照现在的敏感类别重读一遍，
// 读出来不一样的（位置关了要去掉地点）撤掉。
import fs from "node:fs";
import path from "node:path";
import { type DeleteCommandPayload, EVENT_TYPES, type MemoryCommandEventPayload, type MemoryDeleteMode } from "@ergo/protocol";
import { type Claim, type MemoryEngine, purgeRecords, type QuestionDraft } from "@ergo/memory";
import { describe, expect, it } from "vitest";
import { SENSITIVE_CATEGORIES, type SensitiveCategory } from "../../src/config/config.ts";
import type { DataSourceRecordMaterial } from "../../src/data-sources/material.ts";
import { dataSourceMaterial } from "../../src/data-sources/material.ts";
import type { MaterialSource } from "../../src/materials/capture.ts";
import { DIGEST_OVER, digestRef, ingestedMaterialIds } from "../../src/memory/data-source-evidence.ts";
import { MATERIALS_CHANNEL } from "../../src/materials/commands.ts";
import { MaterialsEvidenceSource } from "../../src/memory/evidence-source.ts";
import { createReasoningPurge, type ReasoningPurge } from "../../src/memory/purge-rg.ts";
import { openReasoningDb } from "../../src/memory/rg-db.ts";
import { clockIso } from "../../src/scheduler/clock.ts";
import { openDatabase } from "../../src/storage/sqlite.ts";
import { materialsSetup, postMessage, text } from "../materials/helpers.ts";

type Setup = ReturnType<typeof materialsSetup>;

const MODEL = "deepseek-flash";
const AT = "2026-10-20T12:00:00+08:00";

/** 打开 rg.db（版本对不上直接让测试失败） */
function openEngine(file: string, clock: Setup["clock"]): MemoryEngine {
  const opened = openReasoningDb({ file, clock: () => clockIso(clock), model: MODEL });
  if (!opened.ok) throw new Error(`推理库打不开：${JSON.stringify(opened.issue)}`);
  return opened.engine;
}

/** 一条测试断言（推理出来的结论），挂在一个前提上 */
function chainClaim(engine: MemoryEngine, premise: string, statement: string): Claim {
  const claim = engine.store.insertClaim({
    tier: "need",
    statement,
    kind: "hypothesis",
    epistemic: "inferred",
    method: "induction",
    status: "active",
    confidence: "medium",
    context: [],
    validFrom: null,
    validTo: null,
    inferredAt: AT,
    reviewedAt: null,
    retractedBy: null,
    supersededBy: null,
    competesWith: [],
    predicts: [],
  });
  engine.store.insertInference({ conclusionClaimId: claim.id, premiseIds: [premise], method: "induction", rationale: "测试用", by: "rule:test", status: "active" });
  return claim;
}

/** 一个要弄清那条结论的问题（目标就是这条断言） */
function questionOn(engine: MemoryEngine, claim: Claim): string {
  const draft: QuestionDraft = {
    key: `q-${claim.id}`,
    topic: `claim:${claim.id}`,
    kind: "unresolved",
    sources: ["unresolved"],
    text: "你更希望哪一种？",
    why: "两条解释分不清",
    targets: [{ id: claim.id, kind: "claim", statement: claim.statement }],
    answers: {
      yes: { supports: [claim.id], refutes: [], maxWeight: "decisive", note: "是" },
      no: { supports: [], refutes: [claim.id], maxWeight: "decisive", note: "不是" },
    },
    domains: [],
    scenes: [],
    terms: [],
    probeId: null,
    validUntil: null,
    separation: 1,
    closeness: 1,
    frequency: 1,
  };
  const offered = engine.questions.offer(draft, AT);
  if (offered.question === undefined) throw new Error(`问题没进箱：${offered.skipped}`);
  return offered.question.id;
}

interface Seeded {
  evidenceId: string;
  factId: string;
  claimId: string;
  questionId: string;
  explicitClaimId: string | undefined;
}

/**
 * 按一条素材生成证据、整理一遍，再挂一条依赖它的结论和一个问题。
 * 只灌这一条素材的证据（免得几条素材的证据混在一起）。
 */
async function seed(file: string, t: Setup, materialId: string): Promise<Seeded> {
  const engine = openEngine(file, t.clock);
  try {
    const source = new MaterialsEvidenceSource({
      materials: { list: () => t.materials.list().filter((m) => m.id === materialId) },
      clock: t.clock,
      inferableSensitiveCategories: SENSITIVE_CATEGORIES,
    });
    for (const draft of source.read()) engine.ingestEvidence(draft);
    await engine.reflect();
    const evidence = engine.store.listEvidence().find((e) => e.sourceRef === materialId);
    if (evidence === undefined) throw new Error("素材没有变成证据");
    const fact = engine.store.factsByEvidence(evidence.id)[0];
    if (fact === undefined) throw new Error("证据没有抽出事实");
    const claim = chainClaim(engine, fact.id, "用户想把周末留给自己安排");
    const questionId = questionOn(engine, claim);
    return { evidenceId: evidence.id, factId: fact.id, claimId: claim.id, questionId, explicitClaimId: engine.rg.registry.explicitClaimOf(fact.id) };
  } finally {
    engine.close();
  }
}

let commandNo = 0;
function command(t: Setup, mode: MemoryDeleteMode, materialIds: string[]) {
  const from: DeleteCommandPayload["from"] = { kind: "project_deletion", projectId: "p-234" };
  const payload = { commandId: `cmd-234-${++commandNo}`, command: mode, materialIds, from } as MemoryCommandEventPayload;
  t.store.append({ channel: MATERIALS_CHANNEL, type: EVENT_TYPES.memoryCommand, payload });
}

function purgeOf(t: Setup, options: { sensitiveCategories?: SensitiveCategory[]; materials?: boolean } = {}): ReasoningPurge {
  return createReasoningPurge({
    file: path.join(t.root, "db", "rg.db"),
    store: t.store,
    clock: t.clock,
    config: { maxModelCalls: 200, extractor: "model", sensitiveCategories: options.sensitiveCategories ?? [], enabled: true, nightlyTimeoutMinutes: 60, curator: { maxModelCalls: 8 } },
    ...(options.materials === true ? { materials: t.materials } : {}),
    log: () => {},
  });
}

/** rg.db 里还有没有这段原文（证据、事实、索引、修订日志里都不应该有） */
function foundText(file: string, needle: string): string[] {
  const db = openDatabase(file);
  try {
    const like = `%${needle}%`;
    const checks: Array<[string, string]> = [
      ["evidence", "SELECT COUNT(*) AS n FROM evidence WHERE text LIKE ?"],
      ["evidence_fts", "SELECT COUNT(*) AS n FROM evidence_fts WHERE body LIKE ?"],
      ["facts", "SELECT COUNT(*) AS n FROM facts WHERE statement LIKE ?"],
      ["fact_fts", "SELECT COUNT(*) AS n FROM fact_fts WHERE body LIKE ?"],
      ["revisions", "SELECT COUNT(*) AS n FROM revisions WHERE changes LIKE ?"],
    ];
    return checks.filter(([, sql]) => Number(db.get<{ n: number }>(sql, like)?.n ?? 0) > 0).map(([table]) => table);
  } finally {
    db.close();
  }
}

describe("彻底删除：素材 → 证据 → 事实 → 依赖的结论和问题", () => {
  it("删素材以后证据、事实没了，依赖的结论待复核、问题过期、审计有记录，rg.db 里搜不到原文；别的素材检索照常", async () => {
    const t = materialsSetup();
    const SENTENCE = "我打算下个月把车库改成书房";
    postMessage(t.store, [text(SENTENCE)]);
    postMessage(t.store, [text("周五晚上和老王吃饭")]);
    const kept = t.materials.list().find((m) => m.segments[0]?.text === "周五晚上和老王吃饭")!;
    const doomed = t.materials.list().find((m) => m.segments[0]?.text === SENTENCE)!;
    const file = path.join(t.root, "db", "rg.db");
    const seeded = await seed(file, t, doomed.id);

    const purge = purgeOf(t);
    const off = purge.start();
    try {
      command(t, "purge", [doomed.id]);
    } finally {
      off();
    }

    // 素材库那边照常删掉了这条，别的素材照样检索得到（素材检索不受影响）
    expect(t.materials.get(doomed.id)).toBeUndefined();
    expect(t.materials.searchKeyword("老王").map((m) => m.id)).toEqual([kept.id]);

    const engine = openEngine(file, t.clock);
    try {
      expect(engine.getEvidence(seeded.evidenceId)).toBeUndefined();
      expect(engine.getFact(seeded.factId)).toBeUndefined();
      // 329 号票：待复核不再是状态——依赖的结论加复核标记（只靠被删的那条的，推断停用、先当猜测，等整理重推）
      expect(engine.store.getClaim(seeded.claimId)!.needsReview).toBe(true);
      const explicit = seeded.explicitClaimId === undefined ? undefined : engine.store.getClaim(seeded.explicitClaimId);
      expect(explicit === undefined || explicit.needsReview).toBe(true);
      expect(engine.questions.get(seeded.questionId)!.status).toBe("expired");
      // 审计：删了什么、影响了哪些结论，只有 id 和原因，没有原文
      const [record] = purgeRecords(engine);
      expect(record).toMatchObject({
        reason: "彻底删除素材",
        materialIds: [doomed.id],
        evidenceIds: [seeded.evidenceId],
        factIds: [seeded.factId],
        claimIds: expect.arrayContaining([seeded.claimId]),
        questionIds: [seeded.questionId],
      });
      // 修改走修订日志：证据、事实各有一条删除
      expect(engine.store.revisions(seeded.evidenceId, "evidence").at(-1)).toMatchObject({ op: "delete" });
      expect(engine.store.revisions(seeded.factId, "fact").at(-1)).toMatchObject({ op: "delete" });
      // 结论的修订原因写清是因为删除
      expect(engine.store.revisions(seeded.claimId, "claim").at(-1)!.reason).toMatch(/彻底删除素材/);
    } finally {
      engine.close();
    }
    expect(foundText(file, SENTENCE)).toEqual([]);
  });
});

describe("别推断：标了以后已有的推断不保留成立", () => {
  it("标了别推断：那条素材的证据从推理库撤掉、依赖它的结论待复核，不自动恢复；素材检索照常", async () => {
    const t = materialsSetup();
    postMessage(t.store, [text("我喜欢爬山")]);
    postMessage(t.store, [text("周五晚上和老王吃饭")]);
    const marked = t.materials.list().find((m) => m.segments[0]?.text === "我喜欢爬山")!;
    const other = t.materials.list().find((m) => m.segments[0]?.text === "周五晚上和老王吃饭")!;
    const file = path.join(t.root, "db", "rg.db");
    const seeded = await seed(file, t, marked.id);
    const otherSeeded = await seed(file, t, other.id);

    const purge = purgeOf(t);
    const off = purge.start();
    try {
      command(t, "no_infer", [marked.id]);
    } finally {
      off();
    }

    // 素材本身还在（只是标了不参与推断），检索照常
    expect(t.materials.get(marked.id)?.noInfer).toBe(true);
    expect(t.materials.searchKeyword("爬山").map((m) => m.id)).toEqual([marked.id]);

    const engine = openEngine(file, t.clock);
    try {
      expect(engine.getEvidence(seeded.evidenceId)).toBeUndefined();
      expect(engine.getFact(seeded.factId)).toBeUndefined();
      expect(engine.store.getClaim(seeded.claimId)!.needsReview).toBe(true);
      // 没标的素材照样在
      expect(engine.getEvidence(otherSeeded.evidenceId)).toBeDefined();
      expect(purgeRecords(engine).some((r) => r.reason.includes("别推断"))).toBe(true);
    } finally {
      engine.close();
    }

    // 取消标记不会自动恢复：标记还在时再对一遍历史命令，结论不会自己回到成立（下次整理才重新推）
    purge.reconcile();
    const again = openEngine(file, t.clock);
    try {
      expect(again.store.getClaim(seeded.claimId)!.needsReview).toBe(true);
      expect(again.getEvidence(seeded.evidenceId)).toBeUndefined();
      expect(again.getEvidence(otherSeeded.evidenceId)).toBeDefined();
    } finally {
      again.close();
    }
  });
});

describe("启动时补做历史命令", () => {
  it("记忆插件停用期间下的彻底删除，开着时补做：证据、事实删掉，结论待复核，审计有记录", async () => {
    const t = materialsSetup();
    postMessage(t.store, [text("我打算下个月把车库改成书房")]);
    const [material] = t.materials.list();
    const file = path.join(t.root, "db", "rg.db");
    const seeded = await seed(file, t, material!.id);
    // 命令是有的（事件日志），但这次没人订阅处理（模拟插件停着）
    command(t, "purge", [material!.id]);

    purgeOf(t).reconcile();

    const engine = openEngine(file, t.clock);
    try {
      expect(engine.getEvidence(seeded.evidenceId)).toBeUndefined();
      expect(engine.getFact(seeded.factId)).toBeUndefined();
      expect(engine.store.getClaim(seeded.claimId)!.needsReview).toBe(true);
      expect(purgeRecords(engine)).toHaveLength(1);
    } finally {
      engine.close();
    }
    // 库文件在（删除只是删内容，不是删库）
    expect(fs.existsSync(file)).toBe(true);
  });

  it("敏感类别（健康）默认不用于推断：已经进过库的证据在启动时撤掉，依赖的结论待复核，素材照旧记录可检索", async () => {
    const t = materialsSetup();
    postMessage(t.store, [text("我喜欢跑步")]);
    const [material] = t.materials.list();
    const file = path.join(t.root, "db", "rg.db");
    const seeded = await seed(file, t, material!.id);

    purgeOf(t).reconcile();

    const engine = openEngine(file, t.clock);
    try {
      expect(engine.getEvidence(seeded.evidenceId)).toBeUndefined();
      expect(engine.store.getClaim(seeded.claimId)!.needsReview).toBe(true);
      expect(purgeRecords(engine).some((record) => record.reason.includes("敏感类别"))).toBe(true);
    } finally {
      engine.close();
    }
    // 默认允许记录：素材还在、检索得到（只是不用于推断）
    expect(t.materials.get(material!.id)).toBeDefined();
    expect(t.materials.searchKeyword("跑步").map((m) => m.id)).toEqual([material!.id]);
  });
});

// 303 号票：数据源素材的证据（测试自己的一类事件，负载里给一条记录，用 dataSourceMaterial 写成素材）
const RECORD_EVENT = "test-data-source-record" as never;
const recordSource: MaterialSource = { name: "test-data-source-record", eventType: RECORD_EVENT, capture: (event) => [dataSourceMaterial({ id: "camera", sensitive: [] }, event.payload as DataSourceRecordMaterial)] };
function addRecord(t: Setup, payload: DataSourceRecordMaterial) {
  t.store.append({ channel: "test-data-source", type: RECORD_EVENT, payload });
  return t.materials.list().at(-1)!;
}
/** 照每晚整理那样把素材读进推理库（跳过已经读进来的） */
function ingest(file: string, t: Setup, allowed: readonly SensitiveCategory[]): void {
  const engine = openEngine(file, t.clock);
  try {
    const source = new MaterialsEvidenceSource({ materials: t.materials, clock: t.clock, inferableSensitiveCategories: allowed, skip: ingestedMaterialIds(engine.store.listEvidence()) });
    for (const draft of source.read()) engine.ingestEvidence(draft);
  } finally {
    engine.close();
  }
}
const evidenceRefs = (file: string, t: Setup) => {
  const engine = openEngine(file, t.clock);
  try {
    return engine.store.listEvidence().map((e) => [e.sourceRef, e.text] as const);
  } finally {
    engine.close();
  }
};

describe("303：数据源素材的证据", () => {
  it("几条合成的一条：删其中一条就撤整条（审计记着删的那条），剩下的下一夜一条一条重新读", () => {
    const t = materialsSetup({ sources: [recordSource] });
    const members = Array.from({ length: DIGEST_OVER + 1 }, (_, i) => addRecord(t, { kind: "observed_behavior", text: `第 ${i + 1} 件事`, time: `2026-10-05T1${i}:00:00.000+08:00` }));
    const file = path.join(t.root, "db", "rg.db");
    ingest(file, t, SENSITIVE_CATEGORIES);
    expect(evidenceRefs(file, t).map(([ref]) => ref)).toEqual([digestRef(members.map((m) => m.id))]);

    const purge = purgeOf(t);
    const off = purge.start();
    try {
      command(t, "purge", [members[1]!.id]);
    } finally {
      off();
    }
    const engine = openEngine(file, t.clock);
    try {
      expect(engine.store.listEvidence()).toEqual([]);
      expect(purgeRecords(engine).at(-1)).toMatchObject({ materialIds: [members[1]!.id] });
    } finally {
      engine.close();
    }
    ingest(file, t, SENSITIVE_CATEGORIES);
    expect(evidenceRefs(file, t).map(([ref]) => ref)).toEqual([members[0]!.id, members[2]!.id, members[3]!.id]);
  });

  it("启动时照现在的敏感类别重读：位置关了，带地点的那条撤掉、下一夜不带地点重新读进来；读出来一样的不动", () => {
    const t = materialsSetup({ sources: [recordSource] });
    const there = addRecord(t, { kind: "observed_behavior", text: "开了两个会", time: "2026-10-07T14:00:00.000+08:00", scene: { place: "望京的公司" }, sensitive: [] });
    const plain = addRecord(t, { kind: "observed_behavior", text: "看了场电影", time: "2026-10-07T20:00:00.000+08:00", sensitive: [] });
    const file = path.join(t.root, "db", "rg.db");
    ingest(file, t, ["location"]);
    expect(evidenceRefs(file, t)).toEqual([
      [there.id, "开了两个会\n［场景］时间 14:00 · 地点 望京的公司"],
      [plain.id, "看了场电影\n［场景］时间 20:00"],
    ]);

    // 没给素材库：不对这一样（老的调用方照旧）
    purgeOf(t, { sensitiveCategories: [] }).reconcile();
    expect(evidenceRefs(file, t)).toHaveLength(2);

    purgeOf(t, { sensitiveCategories: [], materials: true }).reconcile();
    expect(evidenceRefs(file, t)).toEqual([[plain.id, "看了场电影\n［场景］时间 20:00"]]);
    const engine = openEngine(file, t.clock);
    try {
      expect(purgeRecords(engine).at(-1)).toMatchObject({ reason: "数据源素材的敏感类别设置变了，照新的设置重新读", materialIds: [there.id] });
    } finally {
      engine.close();
    }
    // 再对一遍没有要撤的；下一夜不带地点重新读进来
    purgeOf(t, { sensitiveCategories: [], materials: true }).reconcile();
    ingest(file, t, []);
    expect(evidenceRefs(file, t)).toEqual([
      [there.id, "开了两个会\n［场景］时间 14:00"],
      [plain.id, "看了场电影\n［场景］时间 20:00"],
    ]);
  });
});
