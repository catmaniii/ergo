// 存储：建表、按 id 读写、追加修订日志（第 4 节）。上层（kg/、engine.ts，以后的 retrieval/、rg/）都经它读写，不直接写表；
// ③ 号票的检索要直接查 FTS 和向量表时用 db（只读地用）。
// - 写入前校验（domain/validate.ts），不合格的不写；
// - 每次新建、改动都追加一条修订（哪个对象、改了什么、因为哪条证据、什么时候），没有改动的不写；
// - 索引跟着内容走：证据的原文、事实的精炼陈述各有一张关键词表和一张向量表；被忘掉的证据、被撤回的事实从索引里删掉，
//   原文或陈述改了，关键词表换掉、旧向量作废（等 indexVectors 补算）。
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { formatId, type IdKind, USER_ENTITY_ID } from "../domain/ids.ts";
import { toMs, toMsOrNull } from "../domain/time.ts";
import type {
  Claim,
  ClaimReview,
  WriteIntent,
  ClaimStatus,
  ClaimTier,
  Entity,
  Evidence,
  EvidenceDraft,
  EvidenceStatus,
  Fact,
  FactStatus,
  Inference,
  Link,
  LinkWeight,
  ObjectType,
  Predicate,
  Derivation,
  PredictionBlame,
  PredictionRecord,
  PredictionStatus,
  Probe,
  ProbeOutcome,
  Revision,
  RevisionCause,
  SourceLevel,
  StoredLink,
  Strategy,
  StrategyStatus,
} from "../domain/types.ts";
import { assertValid } from "../domain/validate.ts";
import { SCHEMA, SCHEMA_VERSION } from "./schema.ts";

// 225 号票：推理库落盘时要把 schema 版本写进 manifest、版本对不上不自动迁移，守护进程要拿它和库里的 user_version 比
export { SCHEMA_VERSION } from "./schema.ts";
import { type Database, openDatabase, type SqlValue } from "./sqlite.ts";

export type NewFact = Omit<Fact, "id"> & { id?: string };
/** 新建的结论：复核标记不给按 false（329 号票） */
export type NewClaim = Omit<Claim, "id" | "needsReview"> & { id?: string; needsReview?: boolean };
export type NewInference = Omit<Inference, "id" | "createdAt"> & { id?: string; createdAt?: string };
export type NewProbe = Omit<Probe, "id" | "createdAt"> & { id?: string; createdAt?: string };
export type NewEntity = Omit<Entity, "id"> & { id?: string };
export type NewStrategy = Omit<Strategy, "id" | "createdAt"> & { id?: string; createdAt?: string };
/** 330 号票：预测节点新加的几项可以不给——来源默认就是 claimId、推法按 defeasible、落空的墓碑默认是判它的那条证据、往回打的结果为空 */
export type NewPrediction = Omit<PredictionRecord, "id" | "premiseIds" | "derivation" | "retractedBy" | "blame"> &
  Partial<Pick<PredictionRecord, "premiseIds" | "derivation" | "retractedBy" | "blame">> & { id?: string };

/**
 * 267 号票：写推理图谱（和它底下的证据、事实层）的那组操作——存储自己有一份（不检查），唯一写入口（rg/write-gate.ts）
 * 有一份同样签名的（写之前检查、写完留痕）。引擎打开时把写入口挂到存储上（MemoryStore.writer），
 * 拿着存储的模块（预测账本、对抗复核、知识图谱、彻底删除）用 rgWriter(store) / rgSession(store, …) 写，就自动经写入口；
 * 没挂写入口的裸存储（只测存储的测试）照旧直接写。
 */
export interface RgWriter {
  insertEvidence(draft: EvidenceDraft, cause?: RevisionCause): Evidence;
  updateEvidence(id: string, patch: Partial<Pick<Evidence, "status" | "text">>, cause: RevisionCause): Evidence;
  deleteEvidence(id: string, cause: RevisionCause): boolean;
  insertFact(fact: NewFact, cause: RevisionCause): Fact;
  updateFact(id: string, patch: Partial<Omit<Fact, "id">>, cause: RevisionCause): Fact;
  deleteFact(id: string, cause: RevisionCause): boolean;
  insertClaim(claim: NewClaim, cause?: RevisionCause): Claim;
  updateClaim(id: string, patch: Partial<Omit<Claim, "id">>, cause: RevisionCause): Claim;
  putLink(link: Link, cause?: RevisionCause): StoredLink;
  removeLink(key: Omit<Link, "rationale">, cause: RevisionCause): boolean;
  insertInference(inference: NewInference, cause?: RevisionCause): Inference;
  updateInference(id: string, patch: Partial<Omit<Inference, "id">>, cause: RevisionCause): Inference;
  insertProbe(probe: NewProbe, cause?: RevisionCause): Probe;
  updateProbe(id: string, patch: Partial<Omit<Probe, "id">>, cause: RevisionCause): Probe;
  putPrediction(prediction: NewPrediction, cause?: RevisionCause): PredictionRecord;
  updatePrediction(id: string, patch: Partial<Omit<PredictionRecord, "id">>, cause: RevisionCause): PredictionRecord;
}

/** 唯一写入口：同一组写操作，外加"开一次写"（检查、留痕的单位） */
export interface RgGate extends RgWriter {
  write<T>(intent: WriteIntent, fn: () => T): T;
}

/** 写推理图谱用谁：挂了写入口用写入口（要在 rgSession 里），没挂（裸存储）用存储自己 */
export function rgWriter(store: MemoryStore): RgWriter {
  return store.writer ?? store;
}

/** 开一次写：挂了写入口就经写入口（检查、留痕），没挂就是一个普通事务 */
export function rgSession<T>(store: MemoryStore, intent: WriteIntent, fn: () => T): T {
  return store.writer ? store.writer.write(intent, fn) : store.transaction(fn);
}

export interface StoreOptions {
  /** 修订、推断、追问记的"什么时候"；测试和演示注入固定的时间 */
  clock?: () => string;
}

/** 查事实时默认要的状态：成立过的（纠正、撤回的从来没成立过） */
export const HELD_STATUSES: readonly FactStatus[] = ["active", "contested", "superseded"];

const json = (v: unknown) => JSON.stringify(v);
const parse = <T>(v: unknown): T => JSON.parse(String(v)) as T;
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** 一张对象表怎么读写 */
interface TableSpec<T extends { id: string }> {
  type: ObjectType;
  kind: IdKind;
  table: string;
  columns: readonly string[];
  /** 这些字段的内容不进修订日志（只记改了、多长）：证据原文被忘掉后不能还留在只追加的日志里 */
  redacted?: readonly string[];
  toRow(o: T): SqlValue[];
  fromRow(r: Record<string, unknown>): T;
}

const EVIDENCE: TableSpec<Evidence> = {
  type: "evidence",
  kind: "evidence",
  table: "evidence",
  redacted: ["text"],
  columns: ["id", "source_level", "mode", "kind", "text", "context", "event_time", "event_ms", "observed_at", "observed_ms", "source_ref", "content_hash", "status"],
  toRow: (e) => [e.id, e.sourceLevel, e.mode, e.kind, e.text, json(e.context), e.eventTime, toMsOrNull(e.eventTime), e.observedAt, toMs(e.observedAt), e.sourceRef, e.contentHash, e.status],
  fromRow: (r) => ({
    id: String(r.id),
    sourceLevel: r.source_level as Evidence["sourceLevel"],
    mode: r.mode as Evidence["mode"],
    kind: r.kind as Evidence["kind"],
    text: String(r.text),
    context: parse<string[]>(r.context),
    eventTime: str(r.event_time),
    observedAt: String(r.observed_at),
    sourceRef: str(r.source_ref),
    contentHash: String(r.content_hash),
    status: r.status as EvidenceStatus,
  }),
};

const ENTITY: TableSpec<Entity> = {
  type: "entity",
  kind: "entity",
  table: "entities",
  columns: ["id", "type", "name", "aliases"],
  toRow: (e) => [e.id, e.type, e.name, json(e.aliases)],
  fromRow: (r) => ({ id: String(r.id), type: r.type as Entity["type"], name: String(r.name), aliases: parse<string[]>(r.aliases) }),
};

const FACT: TableSpec<Fact> = {
  type: "fact",
  kind: "fact",
  table: "facts",
  columns: [
    "id",
    "subject_id",
    "predicate",
    "object_entity",
    "object_value",
    "negated",
    "statement",
    "assertion",
    "context",
    "evidence_ids",
    "event_time",
    "observed_at",
    "valid_from",
    "valid_from_ms",
    "valid_to",
    "valid_to_ms",
    "status",
    "superseded_by",
    "retracted_by",
    "contested_with",
    "extracted_by",
  ],
  toRow: (f) => [
    f.id,
    f.subjectId,
    f.predicate,
    f.object.type === "entity" ? f.object.id : null,
    f.object.type === "value" ? f.object.value : null,
    f.negated ? 1 : 0,
    f.statement,
    f.assertion,
    json(f.context),
    json(f.evidenceIds),
    f.eventTime,
    f.observedAt,
    f.validFrom,
    toMsOrNull(f.validFrom),
    f.validTo,
    toMsOrNull(f.validTo),
    f.status,
    f.supersededBy,
    f.retractedBy,
    json(f.contestedWith),
    f.extractedBy,
  ],
  fromRow: (r) => ({
    id: String(r.id),
    subjectId: String(r.subject_id),
    predicate: r.predicate as Predicate,
    object: r.object_entity !== null ? { type: "entity", id: String(r.object_entity) } : { type: "value", value: String(r.object_value) },
    negated: Number(r.negated) === 1,
    statement: String(r.statement),
    assertion: r.assertion as Fact["assertion"],
    context: parse<string[]>(r.context),
    evidenceIds: parse<string[]>(r.evidence_ids),
    eventTime: str(r.event_time),
    observedAt: String(r.observed_at),
    validFrom: str(r.valid_from),
    validTo: str(r.valid_to),
    status: r.status as FactStatus,
    supersededBy: str(r.superseded_by),
    retractedBy: str(r.retracted_by),
    contestedWith: parse<string[]>(r.contested_with),
    extractedBy: String(r.extracted_by),
  }),
};

const CLAIM: TableSpec<Claim> = {
  type: "claim",
  kind: "claim",
  table: "claims",
  columns: [
    "id",
    "tier",
    "statement",
    "kind",
    "epistemic",
    "method",
    "status",
    "confidence",
    "context",
    "valid_from",
    "valid_to",
    "inferred_at",
    "reviewed_at",
    "retracted_by",
    "superseded_by",
    "competes_with",
    "predicts",
    "needs_review",
  ],
  toRow: (c) => [
    c.id,
    c.tier,
    c.statement,
    c.kind,
    c.epistemic,
    c.method,
    c.status,
    c.confidence,
    json(c.context),
    c.validFrom,
    c.validTo,
    c.inferredAt,
    c.reviewedAt,
    c.retractedBy,
    c.supersededBy,
    json(c.competesWith),
    json(c.predicts),
    c.needsReview ? 1 : 0,
  ],
  fromRow: (r) => ({
    id: String(r.id),
    tier: r.tier as Claim["tier"],
    statement: String(r.statement),
    kind: r.kind as Claim["kind"],
    epistemic: r.epistemic as Claim["epistemic"],
    method: r.method as Claim["method"],
    status: r.status as ClaimStatus,
    confidence: r.confidence as Claim["confidence"],
    context: parse<string[]>(r.context),
    validFrom: str(r.valid_from),
    validTo: str(r.valid_to),
    inferredAt: String(r.inferred_at),
    reviewedAt: str(r.reviewed_at),
    retractedBy: str(r.retracted_by),
    supersededBy: str(r.superseded_by),
    competesWith: parse<string[]>(r.competes_with),
    predicts: parse<Claim["predicts"]>(r.predicts),
    needsReview: Number(r.needs_review ?? 0) === 1,
  }),
};

const INFERENCE: TableSpec<Inference> = {
  type: "inference",
  kind: "inference",
  table: "inferences",
  columns: ["id", "conclusion_claim_id", "premise_ids", "method", "rationale", "by", "status", "created_at"],
  toRow: (i) => [i.id, i.conclusionClaimId, json(i.premiseIds), i.method, i.rationale, i.by, i.status, i.createdAt],
  fromRow: (r) => ({
    id: String(r.id),
    conclusionClaimId: String(r.conclusion_claim_id),
    premiseIds: parse<string[]>(r.premise_ids),
    method: r.method as Inference["method"],
    rationale: String(r.rationale),
    by: String(r.by),
    status: r.status as Inference["status"],
    createdAt: String(r.created_at),
  }),
};

const PROBE: TableSpec<Probe> = {
  type: "probe",
  kind: "probe",
  table: "probes",
  columns: ["id", "discriminates", "ask", "queries", "if_found", "outcome", "found_evidence_ids", "created_at"],
  toRow: (p) => [p.id, json(p.discriminates), p.ask, json(p.queries), p.ifFound, p.outcome, json(p.foundEvidenceIds), p.createdAt],
  fromRow: (r) => ({
    id: String(r.id),
    discriminates: parse<string[]>(r.discriminates),
    ask: String(r.ask),
    queries: parse<string[]>(r.queries),
    ifFound: str(r.if_found),
    outcome: r.outcome as ProbeOutcome,
    foundEvidenceIds: parse<string[]>(r.found_evidence_ids),
    createdAt: String(r.created_at),
  }),
};

/** 交互策略（196 号票） */
const STRATEGY: TableSpec<Strategy> = {
  type: "strategy",
  kind: "strategy",
  table: "strategies",
  columns: ["id", "key", "template", "trigger", "when_text", "actions", "basis_claim_ids", "status", "confirmed_by", "confirmed_at", "created_at"],
  toRow: (st) => [st.id, st.key, st.template, json(st.trigger), st.when, json(st.actions), json(st.basisClaimIds), st.status, st.confirmedBy, st.confirmedAt, st.createdAt],
  fromRow: (r) => ({
    id: String(r.id),
    key: String(r.key),
    template: String(r.template),
    trigger: parse<Strategy["trigger"]>(r.trigger),
    when: String(r.when_text),
    actions: parse<string[]>(r.actions),
    basisClaimIds: parse<string[]>(r.basis_claim_ids),
    status: r.status as StrategyStatus,
    confirmedBy: str(r.confirmed_by),
    confirmedAt: str(r.confirmed_at),
    createdAt: String(r.created_at),
  }),
};

/** 预测账本（226 号票）：结论当时预测了什么、后来应验没有 */
const PREDICTION: TableSpec<PredictionRecord> = {
  type: "prediction",
  kind: "prediction",
  table: "predictions",
  columns: ["id", "claim_id", "predicts", "made_at", "due_at", "status", "evidence_id", "judged_at", "note", "premise_ids", "derivation", "retracted_by", "blame"],
  toRow: (p) => [p.id, p.claimId, p.predicts, p.madeAt, p.dueAt, p.status, p.evidenceId, p.judgedAt, p.note, json(p.premiseIds), p.derivation, p.retractedBy, p.blame === null ? null : json(p.blame)],
  fromRow: (r) => ({
    id: String(r.id),
    claimId: String(r.claim_id),
    premiseIds: parse<string[]>(r.premise_ids ?? "[]"),
    derivation: (r.derivation ?? "defeasible") as Derivation,
    retractedBy: str(r.retracted_by),
    blame: r.blame === null || r.blame === undefined ? null : parse<PredictionBlame>(r.blame),
    predicts: String(r.predicts),
    madeAt: String(r.made_at),
    dueAt: str(r.due_at),
    status: r.status as PredictionStatus,
    evidenceId: str(r.evidence_id),
    judgedAt: str(r.judged_at),
    note: String(r.note),
  }),
};

/** 两个对象哪些字段不一样（按 JSON 比） */
function diff<T extends object>(before: T, after: T): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(after) as (keyof T & string)[]) {
    if (json(before[key]) !== json(after[key])) changes[key] = { from: before[key], to: after[key] };
  }
  return changes;
}

function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

function toBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

function fromBlob(blob: unknown): Float32Array {
  const bytes = blob as Uint8Array;
  // 拷一份：SQLite 给的缓冲区不保证按 4 字节对齐
  return new Float32Array(bytes.slice().buffer);
}

export function contentHashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export class MemoryStore implements RgWriter {
  readonly db: Database;
  private readonly clock: () => string;
  /** 267 号票：引擎挂上的唯一写入口（rg/write-gate.ts）；裸存储没有 */
  writer: RgGate | undefined;

  private constructor(db: Database, clock: () => string) {
    this.db = db;
    this.clock = clock;
  }

  /** 打开（不存在则创建）一个库；":memory:" 是内存库（测试用） */
  static open(file: string, options: StoreOptions = {}): MemoryStore {
    const db = openDatabase(file);
    const store = new MemoryStore(db, options.clock ?? (() => new Date().toISOString()));
    db.transaction(() => {
      db.exec(SCHEMA);
      const version = Number(db.get<{ user_version: number }>("PRAGMA user_version")?.user_version ?? 0);
      if (version > SCHEMA_VERSION) throw new Error(`记忆 PoC 库的版本 ${version} 比代码认识的 ${SCHEMA_VERSION} 新`);
      // 1 版（188 号票）的库：关联表还没有多重这一列（rg_* 表上面的 CREATE IF NOT EXISTS 已经建好）
      if (version === 1) db.exec("ALTER TABLE links ADD COLUMN weight TEXT NOT NULL DEFAULT 'weak'");
      // 329 号票：结论的复核标记（"待复核"不再占真值状态）。不升表版本（守护进程版本对不上就不开库）；老库在这里补上这一列，
      // 老库里状态还是 needs_review 的由规矩迁移（rg/migrate-rules.ts）照新规矩重算
      if (!db.all<{ name: string }>("PRAGMA table_info(claims)").some((c) => c.name === "needs_review")) db.exec("ALTER TABLE claims ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0");
      // 330 号票（R10）：预测账本做成预测节点。老库补四列：来源就是原来那条结论，推法按 defeasible（原始推理图谱：缺省按弱的算），
      // 落空的 retracted_by 记当时判它的那条证据；往回打来源的结果（blame）老账本没有，留空（不追溯着打，留给 333 号票的全量重判）
      const predictionColumns = new Set(db.all<{ name: string }>("PRAGMA table_info(predictions)").map((c) => c.name));
      if (!predictionColumns.has("premise_ids")) {
        db.exec("ALTER TABLE predictions ADD COLUMN premise_ids TEXT NOT NULL DEFAULT '[]'");
        db.exec("UPDATE predictions SET premise_ids = json_array(claim_id) WHERE premise_ids = '[]'");
      }
      if (!predictionColumns.has("derivation")) db.exec("ALTER TABLE predictions ADD COLUMN derivation TEXT NOT NULL DEFAULT 'defeasible'");
      if (!predictionColumns.has("retracted_by")) {
        db.exec("ALTER TABLE predictions ADD COLUMN retracted_by TEXT");
        db.exec("UPDATE predictions SET retracted_by = evidence_id WHERE status = 'miss'");
      }
      if (!predictionColumns.has("blame")) db.exec("ALTER TABLE predictions ADD COLUMN blame TEXT");
      if (version < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      if (!store.getEntity(USER_ENTITY_ID)) store.insertEntity({ id: USER_ENTITY_ID, type: "person", name: "用户", aliases: ["我", "本人", "user"] }, { reason: "建库" });
    });
    return store;
  }

  close(): void {
    this.db.close();
  }

  /**
   * 把整个库另存成一个独立的 SQLite 文件（216 号票：建好的库存下来，后面的实验直接读回来用）。用 VACUUM INTO：
   * 内存库也能存，存出来的是一个完整的单文件（没有 -wal），表、索引（含 FTS5）、版本号都在。目标文件已经有了先删掉；不能在事务里调。
   */
  saveCopy(file: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.rmSync(file, { force: true });
    this.db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
  }

  now(): string {
    return this.clock();
  }

  /** 日志模式：文件库是 wal */
  journalMode(): string {
    return String(this.db.get<{ journal_mode: string }>("PRAGMA journal_mode")?.journal_mode);
  }

  /** 彻底删除之后做一次 WAL 检查点（删掉的内容不留在 WAL 里；内存库没有 WAL，出错就当没有） */
  checkpoint(): void {
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // 内存库、只读库没有 WAL：没有要检查点的
    }
  }

  /** 在一个事务里做；可以嵌套（里面的并进外面的） */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn);
  }

  /** 267 号票：能单独回滚的一段（在事务里是保存点，不在就是事务） */
  savepoint<T>(fn: () => T): T {
    return this.db.savepoint(fn);
  }

  /** 修订日志里最新的那一条的 seq（没有是 0）；写入口按它圈出一次写留下的修订 */
  latestRevisionSeq(): number {
    return Number(this.db.get<{ seq: number | null }>("SELECT max(seq) AS seq FROM revisions")?.seq ?? 0);
  }

  /** seq 在 (after, upTo] 里的修订（按先后） */
  revisionsBetween(after: number, upTo: number): Revision[] {
    return this.db.all("SELECT * FROM revisions WHERE seq > ? AND seq <= ? ORDER BY seq", after, upTo).map((r) => ({
      seq: Number(r.seq),
      objectType: r.object_type as ObjectType,
      objectId: String(r.object_id),
      op: r.op as Revision["op"],
      changes: parse<Revision["changes"]>(r.changes),
      causeEvidenceId: str(r.cause_evidence_id),
      reason: String(r.reason),
      at: String(r.at),
    }));
  }

  // ---------- 通用 ----------

  private nextId(kind: IdKind, table: string): string {
    let n = Number(this.db.get<{ value: number }>("SELECT value FROM counters WHERE name = ?", kind)?.value ?? 0);
    let id: string;
    do {
      n += 1;
      id = formatId(kind, n);
    } while (this.db.get(`SELECT 1 AS found FROM ${table} WHERE id = ?`, id));
    this.db.run("INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value", kind, n);
    return id;
  }

  private appendRevision(type: ObjectType, objectId: string, op: Revision["op"], changes: Revision["changes"], cause: RevisionCause): void {
    this.db.run(
      "INSERT INTO revisions (object_type, object_id, op, changes, cause_evidence_id, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      type,
      objectId,
      op,
      json(changes),
      cause.evidenceId ?? null,
      cause.reason,
      this.clock(),
    );
  }

  /**
   * 199 号票：给不在对象表里的改动记一条修订（事实上的标记：说的和做的不一样标 gap、关联到需求断言、写回补的场景，kg/marks.ts）。
   * 只追加，和别的修订一样改不了、删不了
   */
  recordRevision(type: ObjectType, objectId: string, op: Revision["op"], changes: Revision["changes"], cause: RevisionCause): void {
    this.appendRevision(type, objectId, op, changes, cause);
  }

  private getRow<T extends { id: string }>(spec: TableSpec<T>, id: string): T | undefined {
    const row = this.db.get(`SELECT * FROM ${spec.table} WHERE id = ?`, id);
    return row && spec.fromRow(row);
  }

  private insertRow<T extends { id: string }>(spec: TableSpec<T>, value: NoInfer<T>, cause: RevisionCause, after?: (v: NoInfer<T>) => void): T {
    assertValid(spec.type, value as never);
    return this.transaction(() => {
      const placeholders = spec.columns.map(() => "?").join(", ");
      this.db.run(`INSERT INTO ${spec.table} (${spec.columns.join(", ")}) VALUES (${placeholders})`, ...spec.toRow(value));
      after?.(value);
      this.appendRevision(spec.type, value.id, "create", {}, cause);
      return value;
    });
  }

  private updateRow<T extends { id: string }>(spec: TableSpec<T>, id: string, patch: NoInfer<Partial<T>>, cause: RevisionCause, after?: (before: NoInfer<T>, next: NoInfer<T>) => void): T {
    return this.transaction(() => {
      const before = this.getRow(spec, id);
      if (!before) throw new Error(`没有这个${spec.type}：${id}`);
      const next = { ...before, ...patch, id } as T;
      const changes = diff(before, next);
      if (Object.keys(changes).length === 0) return before;
      for (const field of spec.redacted ?? []) {
        const c = changes[field];
        if (c) changes[field] = { from: { redacted: true, chars: String(c.from).length }, to: { redacted: true, chars: String(c.to).length } };
      }
      assertValid(spec.type, next as never);
      const sets = spec.columns.slice(1).map((c) => `${c} = ?`).join(", ");
      this.db.run(`UPDATE ${spec.table} SET ${sets} WHERE id = ?`, ...spec.toRow(next).slice(1), id);
      after?.(before, next);
      this.appendRevision(spec.type, id, "update", changes, cause);
      return next;
    });
  }

  /** 修订日志：某个对象的（按先后）；给了种类只要那一种（关联的修订记在断言 id 下面，种类是 link） */
  revisions(objectId?: string, objectType?: ObjectType): Revision[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (objectId !== undefined) {
      where.push("object_id = ?");
      params.push(objectId);
    }
    if (objectType !== undefined) {
      where.push("object_type = ?");
      params.push(objectType);
    }
    return this.db.all(`SELECT * FROM revisions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY seq`, ...params).map((r) => ({
      seq: Number(r.seq),
      objectType: r.object_type as ObjectType,
      objectId: String(r.object_id),
      op: r.op as Revision["op"],
      changes: parse<Revision["changes"]>(r.changes),
      causeEvidenceId: str(r.cause_evidence_id),
      reason: String(r.reason),
      at: String(r.at),
    }));
  }

  // ---------- 证据 ----------

  /** 写一条证据：沿用给的 id（不给就分配 ev-NNNN）、算内容哈希、状态 active、建关键词索引。同一个 id 内容一样再写原样返回，不一样抛错 */
  insertEvidence(draft: EvidenceDraft, cause: RevisionCause = { reason: "证据入库" }): Evidence {
    return this.transaction(() => {
      const contentHash = contentHashOf(draft.text);
      if (draft.id !== undefined) {
        const existing = this.getEvidence(draft.id);
        if (existing) {
          if (existing.contentHash !== contentHash) throw new Error(`证据 ${draft.id} 已经在了，内容不一样`);
          return existing;
        }
      }
      const evidence: Evidence = {
        id: draft.id ?? this.nextId("evidence", "evidence"),
        sourceLevel: draft.sourceLevel,
        mode: draft.mode,
        kind: draft.kind,
        text: draft.text,
        context: [...draft.context],
        eventTime: draft.eventTime,
        observedAt: draft.observedAt,
        sourceRef: draft.sourceRef ?? null,
        contentHash,
        status: "active",
      };
      return this.insertRow(EVIDENCE, evidence, { ...cause, evidenceId: cause.evidenceId ?? evidence.id }, (e) => this.reindexEvidence(e, false));
    });
  }

  getEvidence(id: string): Evidence | undefined {
    return this.getRow(EVIDENCE, id);
  }

  /** 证据，按发生的时间排（不知道的按知道的时间），同时的按写入先后 */
  listEvidence(filter: { status?: EvidenceStatus | EvidenceStatus[]; sourceLevel?: SourceLevel } = {}): Evidence[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (filter.status !== undefined) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      where.push(`status IN (${statuses.map(() => "?").join(", ")})`);
      params.push(...statuses);
    }
    if (filter.sourceLevel !== undefined) {
      where.push("source_level = ?");
      params.push(filter.sourceLevel);
    }
    return this.db
      .all(`SELECT * FROM evidence ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY coalesce(event_ms, observed_ms), observed_ms, rowid`, ...params)
      .map(EVIDENCE.fromRow);
  }

  /** 改证据的状态或原文（忘掉时原文清空）；索引跟着走 */
  updateEvidence(id: string, patch: Partial<Pick<Evidence, "status" | "text">>, cause: RevisionCause): Evidence {
    return this.updateRow(EVIDENCE, id, patch, cause, (before, next) => {
      if (before.text !== next.text || before.status !== next.status) this.reindexEvidence(next, before.text !== next.text);
    });
  }

  /**
   * 彻底删除一条证据（234 号票，ADR-0008 的"连派生内容一起删"）：关键词索引、向量、事实关联、抽取记录一起删。
   * 修订日志记一条 delete，只记原文多长，不记原文。返回有没有删到
   */
  deleteEvidence(id: string, cause: RevisionCause): boolean {
    const evidence = this.getEvidence(id);
    if (!evidence) return false;
    this.db.run("DELETE FROM evidence_fts WHERE evidence_id = ?", id);
    this.db.run("DELETE FROM evidence_vectors WHERE evidence_id = ?", id);
    this.db.run("DELETE FROM fact_evidence WHERE evidence_id = ?", id);
    this.db.run("DELETE FROM extraction_log WHERE evidence_id = ?", id);
    this.db.run("DELETE FROM person_info_log WHERE evidence_id = ?", id);
    this.db.run("DELETE FROM evidence WHERE id = ?", id);
    this.appendRevision("evidence", id, "delete", { text: { from: { redacted: true, chars: evidence.text.length }, to: null }, status: { from: evidence.status, to: null } }, cause);
    return true;
  }

  /** 证据的关键词索引：被忘掉的、没有原文的不进；原文变了旧向量作废 */
  private reindexEvidence(e: Evidence, textChanged: boolean): void {
    this.db.run("DELETE FROM evidence_fts WHERE evidence_id = ?", e.id);
    if (e.status !== "forgotten" && e.text.length > 0) this.db.run("INSERT INTO evidence_fts (evidence_id, body) VALUES (?, ?)", e.id, e.text);
    if (textChanged || e.status === "forgotten") this.db.run("DELETE FROM evidence_vectors WHERE evidence_id = ?", e.id);
  }

  putEvidenceVector(evidenceId: string, model: string, vector: Float32Array): void {
    this.db.run(
      "INSERT INTO evidence_vectors (evidence_id, model, dims, vector) VALUES (?, ?, ?, ?) ON CONFLICT (evidence_id, model) DO UPDATE SET dims = excluded.dims, vector = excluded.vector",
      evidenceId,
      model,
      vector.length,
      toBlob(vector),
    );
  }

  getEvidenceVector(evidenceId: string, model: string): Float32Array | undefined {
    const row = this.db.get<{ vector: Uint8Array }>("SELECT vector FROM evidence_vectors WHERE evidence_id = ? AND model = ?", evidenceId, model);
    return row && fromBlob(row.vector);
  }

  /** 这个模型还没算过向量的证据（被忘掉的不算） */
  evidenceMissingVectors(model: string): Evidence[] {
    return this.db
      .all(
        `SELECT e.* FROM evidence e WHERE e.status != 'forgotten' AND e.text != ''
         AND NOT EXISTS (SELECT 1 FROM evidence_vectors v WHERE v.evidence_id = e.id AND v.model = ?)
         ORDER BY coalesce(e.event_ms, e.observed_ms), e.observed_ms, e.rowid`,
        model,
      )
      .map(EVIDENCE.fromRow);
  }

  // ---------- 实体 ----------

  insertEntity(entity: NewEntity, cause: RevisionCause = { reason: "新实体" }): Entity {
    return this.transaction(() => {
      const value: Entity = { ...entity, id: entity.id ?? this.nextId("entity", "entities"), aliases: [...entity.aliases] };
      return this.insertRow(ENTITY, value, cause, (e) => this.indexNames(e));
    });
  }

  getEntity(id: string): Entity | undefined {
    return this.getRow(ENTITY, id);
  }

  listEntities(): Entity[] {
    return this.db.all("SELECT * FROM entities ORDER BY rowid").map(ENTITY.fromRow);
  }

  /** 按名字或别名找（大小写、首尾空白不敏感）；同名的取最早建的 */
  findEntityByName(name: string): Entity | undefined {
    const row = this.db.get<{ entity_id: string }>(
      "SELECT n.entity_id FROM entity_names n JOIN entities e ON e.id = n.entity_id WHERE n.name_key = ? ORDER BY e.rowid LIMIT 1",
      nameKey(name),
    );
    return row && this.getEntity(row.entity_id);
  }

  /** 加一个别名（已经有的不重复加） */
  addAlias(id: string, alias: string, cause: RevisionCause): Entity {
    const entity = this.getEntity(id);
    if (!entity) throw new Error(`没有这个实体：${id}`);
    const known = [entity.name, ...entity.aliases].map(nameKey);
    if (known.includes(nameKey(alias))) return entity;
    return this.updateRow(ENTITY, id, { aliases: [...entity.aliases, alias.trim()] }, cause, (_before, next) => this.indexNames(next));
  }

  private indexNames(e: Entity): void {
    for (const name of [e.name, ...e.aliases]) this.db.run("INSERT OR IGNORE INTO entity_names (name_key, entity_id) VALUES (?, ?)", nameKey(name), e.id);
  }

  // ---------- 事实 ----------

  insertFact(fact: NewFact, cause: RevisionCause): Fact {
    return this.transaction(() => {
      const value: Fact = { ...fact, id: fact.id ?? this.nextId("fact", "facts"), context: [...fact.context], evidenceIds: [...fact.evidenceIds], contestedWith: [...fact.contestedWith] };
      return this.insertRow(FACT, value, cause, (f) => {
        this.syncFactEvidence(f);
        this.reindexFact(f, false);
      });
    });
  }

  getFact(id: string): Fact | undefined {
    return this.getRow(FACT, id);
  }

  updateFact(id: string, patch: Partial<Omit<Fact, "id">>, cause: RevisionCause): Fact {
    return this.updateRow(FACT, id, patch, cause, (before, next) => {
      if (json(before.evidenceIds) !== json(next.evidenceIds)) this.syncFactEvidence(next);
      if (before.statement !== next.statement || before.status !== next.status) this.reindexFact(next, before.statement !== next.statement);
    });
  }

  /**
   * 彻底删除一条事实（234 号票）：关键词、向量、证据关联一起删。修订日志记一条 delete，只记陈述多长，不记陈述。
   * 返回有没有删到
   */
  deleteFact(id: string, cause: RevisionCause): boolean {
    const fact = this.getFact(id);
    if (!fact) return false;
    this.db.run("DELETE FROM fact_fts WHERE fact_id = ?", id);
    this.db.run("DELETE FROM fact_vectors WHERE fact_id = ?", id);
    this.db.run("DELETE FROM fact_evidence WHERE fact_id = ?", id);
    this.db.run("DELETE FROM rg_explicit WHERE fact_id = ?", id);
    this.db.run("DELETE FROM facts WHERE id = ?", id);
    this.appendRevision("fact", id, "delete", { statement: { from: { redacted: true, chars: fact.statement.length }, to: null }, status: { from: fact.status, to: null } }, cause);
    return true;
  }

  /** 事实，按写入先后；可按状态、主语、谓词、宾语实体过滤 */
  listFacts(filter: { status?: readonly FactStatus[]; subjectId?: string; predicate?: Predicate; objectId?: string } = {}): Fact[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (filter.status !== undefined) {
      where.push(`status IN (${filter.status.map(() => "?").join(", ")})`);
      params.push(...filter.status);
    }
    if (filter.subjectId !== undefined) {
      where.push("subject_id = ?");
      params.push(filter.subjectId);
    }
    if (filter.predicate !== undefined) {
      where.push("predicate = ?");
      params.push(filter.predicate);
    }
    if (filter.objectId !== undefined) {
      where.push("object_entity = ?");
      params.push(filter.objectId);
    }
    return this.db.all(`SELECT * FROM facts ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY rowid`, ...params).map(FACT.fromRow);
  }

  /** 证据里有这一条的事实 */
  factsByEvidence(evidenceId: string): Fact[] {
    return this.db.all("SELECT f.* FROM facts f JOIN fact_evidence x ON x.fact_id = f.id WHERE x.evidence_id = ? ORDER BY f.rowid", evidenceId).map(FACT.fromRow);
  }

  /** 主语或宾语是这个实体的事实（图上的邻接） */
  factsTouching(entityId: string, statuses: readonly FactStatus[] = HELD_STATUSES): Fact[] {
    return this.db
      .all(
        `SELECT * FROM facts WHERE (subject_id = ? OR object_entity = ?) AND status IN (${statuses.map(() => "?").join(", ")}) ORDER BY rowid`,
        entityId,
        entityId,
        ...statuses,
      )
      .map(FACT.fromRow);
  }

  /** 在时间 at 成立的事实：validFrom ≤ at < validTo（validFrom 空是很早以前、validTo 空是现在仍成立），默认只要成立过的状态 */
  factsValidAt(at: string, statuses: readonly FactStatus[] = HELD_STATUSES): Fact[] {
    const t = toMs(at);
    return this.db
      .all(
        `SELECT * FROM facts WHERE status IN (${statuses.map(() => "?").join(", ")})
         AND (valid_from_ms IS NULL OR valid_from_ms <= ?) AND (valid_to_ms IS NULL OR ? < valid_to_ms) ORDER BY rowid`,
        ...statuses,
        t,
        t,
      )
      .map(FACT.fromRow);
  }

  private syncFactEvidence(f: Fact): void {
    this.db.run("DELETE FROM fact_evidence WHERE fact_id = ?", f.id);
    for (const ev of f.evidenceIds) this.db.run("INSERT OR IGNORE INTO fact_evidence (fact_id, evidence_id) VALUES (?, ?)", f.id, ev);
  }

  /** 精炼陈述的关键词索引：撤回的不进；陈述变了旧向量作废 */
  private reindexFact(f: Fact, statementChanged: boolean): void {
    this.db.run("DELETE FROM fact_fts WHERE fact_id = ?", f.id);
    if (f.status !== "retracted") this.db.run("INSERT INTO fact_fts (fact_id, body) VALUES (?, ?)", f.id, f.statement);
    if (statementChanged || f.status === "retracted") this.db.run("DELETE FROM fact_vectors WHERE fact_id = ?", f.id);
  }

  putFactVector(factId: string, model: string, vector: Float32Array): void {
    this.db.run(
      "INSERT INTO fact_vectors (fact_id, model, dims, vector) VALUES (?, ?, ?, ?) ON CONFLICT (fact_id, model) DO UPDATE SET dims = excluded.dims, vector = excluded.vector",
      factId,
      model,
      vector.length,
      toBlob(vector),
    );
  }

  getFactVector(factId: string, model: string): Float32Array | undefined {
    const row = this.db.get<{ vector: Uint8Array }>("SELECT vector FROM fact_vectors WHERE fact_id = ? AND model = ?", factId, model);
    return row && fromBlob(row.vector);
  }

  /** 这个模型还没算过向量的事实（撤回的不算） */
  factsMissingVectors(model: string): Fact[] {
    return this.db
      .all(
        "SELECT f.* FROM facts f WHERE f.status != 'retracted' AND NOT EXISTS (SELECT 1 FROM fact_vectors v WHERE v.fact_id = f.id AND v.model = ?) ORDER BY f.rowid",
        model,
      )
      .map(FACT.fromRow);
  }

  // ---------- 断言、关联、推断、追问（④ 号票写逻辑） ----------

  insertClaim(claim: NewClaim, cause: RevisionCause = { reason: "新断言" }): Claim {
    return this.transaction(() => this.insertRow(CLAIM, { ...claim, needsReview: claim.needsReview ?? false, id: claim.id ?? this.nextId("claim", "claims") }, cause));
  }

  getClaim(id: string): Claim | undefined {
    return this.getRow(CLAIM, id);
  }

  updateClaim(id: string, patch: Partial<Omit<Claim, "id">>, cause: RevisionCause): Claim {
    return this.updateRow(CLAIM, id, patch, cause);
  }

  listClaims(filter: { status?: ClaimStatus | readonly ClaimStatus[]; tier?: ClaimTier; needsReview?: boolean } = {}): Claim[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (filter.needsReview !== undefined) {
      where.push("needs_review = ?");
      params.push(filter.needsReview ? 1 : 0);
    }
    if (filter.status !== undefined) {
      const statuses = typeof filter.status === "string" ? [filter.status] : filter.status;
      where.push(`status IN (${statuses.map(() => "?").join(", ")})`);
      params.push(...statuses);
    }
    if (filter.tier !== undefined) {
      where.push("tier = ?");
      params.push(filter.tier);
    }
    return this.db.all(`SELECT * FROM claims ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY rowid`, ...params).map(CLAIM.fromRow);
  }

  /** 329 号票（R11 复活）：墓碑指向这一条（证据、事实或结论）的结论 */
  claimsRetractedBy(id: string): Claim[] {
    return this.db.all("SELECT * FROM claims WHERE retracted_by = ? ORDER BY rowid", id).map(CLAIM.fromRow);
  }

  // ---------- 对抗复核（227 号票） ----------

  /** 这条结论复核过没有（每条结论只复核一次） */
  claimReviewed(claimId: string): boolean {
    return this.db.get("SELECT 1 AS hit FROM claim_reviews WHERE claim_id = ?", claimId) !== undefined;
  }

  /** 记下对抗复核的结果；已经记过的不覆盖（复核过的结论不再复核） */
  recordClaimReview(review: ClaimReview): void {
    this.transaction(() => this.db.run("INSERT OR IGNORE INTO claim_reviews (claim_id, verdict, why, inference, at) VALUES (?, ?, ?, ?, ?)", review.claimId, review.verdict, review.why, review.inference, review.at));
  }

  /** 写一条关联（同一个断言、目标、极性已经有的只改理由和多重）；多重不给按 weak；修订记在断言 id 下面 */
  putLink(link: Link, cause: RevisionCause = { reason: "新关联" }): StoredLink {
    assertValid("link", link);
    const stored: StoredLink = { ...link, weight: link.weight ?? "weak" };
    return this.transaction(() => {
      const existing = this.db.get<{ rationale: string; weight: string }>(
        "SELECT rationale, weight FROM links WHERE claim_id = ? AND target = ? AND polarity = ?",
        link.claimId,
        link.target,
        link.polarity,
      );
      if (existing?.rationale === stored.rationale && existing.weight === stored.weight) return stored;
      if (existing) {
        this.db.run("UPDATE links SET rationale = ?, weight = ? WHERE claim_id = ? AND target = ? AND polarity = ?", stored.rationale, stored.weight, link.claimId, link.target, link.polarity);
        const changes: Revision["changes"] = {};
        if (existing.rationale !== stored.rationale) changes.rationale = { from: existing.rationale, to: stored.rationale };
        if (existing.weight !== stored.weight) changes.weight = { from: existing.weight, to: stored.weight };
        this.appendRevision("link", link.claimId, "update", { target: { from: link.target, to: link.target }, ...changes }, cause);
      } else {
        this.db.run("INSERT INTO links (claim_id, target, polarity, rationale, weight) VALUES (?, ?, ?, ?, ?)", link.claimId, link.target, link.polarity, stored.rationale, stored.weight);
        this.appendRevision(
          "link",
          link.claimId,
          "create",
          { target: { from: null, to: link.target }, polarity: { from: null, to: link.polarity }, weight: { from: null, to: stored.weight } },
          cause,
        );
      }
      return stored;
    });
  }

  /** 拿掉一条关联（证据不再支持、反驳这条断言时） */
  removeLink(key: Omit<Link, "rationale">, cause: RevisionCause): boolean {
    return this.transaction(() => {
      const { changes } = this.db.run("DELETE FROM links WHERE claim_id = ? AND target = ? AND polarity = ?", key.claimId, key.target, key.polarity);
      if (changes > 0) this.appendRevision("link", key.claimId, "delete", { target: { from: key.target, to: null }, polarity: { from: key.polarity, to: null } }, cause);
      return changes > 0;
    });
  }

  private toLink = (r: Record<string, unknown>): StoredLink => ({
    claimId: String(r.claim_id),
    target: String(r.target),
    polarity: r.polarity as Link["polarity"],
    rationale: String(r.rationale),
    weight: r.weight as LinkWeight,
  });

  linksOf(claimId: string): StoredLink[] {
    return this.db.all("SELECT * FROM links WHERE claim_id = ? ORDER BY rowid", claimId).map(this.toLink);
  }

  linksTo(target: string): StoredLink[] {
    return this.db.all("SELECT * FROM links WHERE target = ? ORDER BY rowid", target).map(this.toLink);
  }

  insertInference(inference: NewInference, cause: RevisionCause = { reason: "新推断" }): Inference {
    return this.transaction(() => {
      const value: Inference = { ...inference, id: inference.id ?? this.nextId("inference", "inferences"), createdAt: inference.createdAt ?? this.clock() };
      return this.insertRow(INFERENCE, value, cause, (i) => this.syncPremises(i));
    });
  }

  getInference(id: string): Inference | undefined {
    return this.getRow(INFERENCE, id);
  }

  updateInference(id: string, patch: Partial<Omit<Inference, "id">>, cause: RevisionCause): Inference {
    return this.updateRow(INFERENCE, id, patch, cause, (before, next) => {
      if (json(before.premiseIds) !== json(next.premiseIds)) this.syncPremises(next);
    });
  }

  /** 推出这条断言的推断 */
  inferencesOf(conclusionClaimId: string): Inference[] {
    return this.db.all("SELECT * FROM inferences WHERE conclusion_claim_id = ? ORDER BY rowid", conclusionClaimId).map(INFERENCE.fromRow);
  }

  /** 前提里有这一条（事实、断言或证据）的推断：失效传播顺着它往下走 */
  inferencesByPremise(premiseId: string): Inference[] {
    return this.db
      .all("SELECT i.* FROM inferences i JOIN inference_premises p ON p.inference_id = i.id WHERE p.premise_id = ? ORDER BY i.rowid", premiseId)
      .map(INFERENCE.fromRow);
  }

  private syncPremises(i: Inference): void {
    this.db.run("DELETE FROM inference_premises WHERE inference_id = ?", i.id);
    for (const p of i.premiseIds) this.db.run("INSERT OR IGNORE INTO inference_premises (inference_id, premise_id) VALUES (?, ?)", i.id, p);
  }

  insertProbe(probe: NewProbe, cause: RevisionCause = { reason: "新追问" }): Probe {
    return this.transaction(() => this.insertRow(PROBE, { ...probe, id: probe.id ?? this.nextId("probe", "probes"), createdAt: probe.createdAt ?? this.clock() }, cause));
  }

  getProbe(id: string): Probe | undefined {
    return this.getRow(PROBE, id);
  }

  updateProbe(id: string, patch: Partial<Omit<Probe, "id">>, cause: RevisionCause): Probe {
    return this.updateRow(PROBE, id, patch, cause);
  }

  listProbes(filter: { outcome?: ProbeOutcome } = {}): Probe[] {
    return (
      filter.outcome === undefined ? this.db.all("SELECT * FROM probes ORDER BY rowid") : this.db.all("SELECT * FROM probes WHERE outcome = ? ORDER BY rowid", filter.outcome)
    ).map(PROBE.fromRow);
  }

  // ---------- 交互策略（196 号票，逻辑在 rg/strategies.ts） ----------

  insertStrategy(strategy: NewStrategy, cause: RevisionCause = { reason: "新策略" }): Strategy {
    return this.transaction(() =>
      this.insertRow(STRATEGY, {
        ...strategy,
        id: strategy.id ?? this.nextId("strategy", "strategies"),
        createdAt: strategy.createdAt ?? this.clock(),
        trigger: structuredClone(strategy.trigger),
        actions: [...strategy.actions],
        basisClaimIds: [...strategy.basisClaimIds],
      }, cause),
    );
  }

  getStrategy(id: string): Strategy | undefined {
    return this.getRow(STRATEGY, id);
  }

  updateStrategy(id: string, patch: Partial<Omit<Strategy, "id">>, cause: RevisionCause): Strategy {
    return this.updateRow(STRATEGY, id, patch, cause);
  }

  /** 策略，按写入先后；可按状态、key 过滤 */
  listStrategies(filter: { status?: StrategyStatus | readonly StrategyStatus[]; key?: string } = {}): Strategy[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (filter.status !== undefined) {
      const statuses = typeof filter.status === "string" ? [filter.status] : filter.status;
      where.push(`status IN (${statuses.map(() => "?").join(", ")})`);
      params.push(...statuses);
    }
    if (filter.key !== undefined) {
      where.push("key = ?");
      params.push(filter.key);
    }
    return this.db.all(`SELECT * FROM strategies ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY rowid`, ...params).map(STRATEGY.fromRow);
  }

  // ---------- 预测账本（226 号票，逻辑在 rg/predictions.ts） ----------

  /** 记一条预测（不给 id 就分配 pd-NNNN）；新建进修订日志（对象种类 prediction） */
  putPrediction(prediction: NewPrediction, cause: RevisionCause = { reason: "新预测" }): PredictionRecord {
    const full: PredictionRecord = {
      ...prediction,
      premiseIds: prediction.premiseIds ?? [prediction.claimId],
      derivation: prediction.derivation ?? "defeasible",
      retractedBy: prediction.retractedBy !== undefined ? prediction.retractedBy : prediction.status === "miss" ? prediction.evidenceId : null,
      blame: prediction.blame ?? null,
      id: prediction.id ?? "",
    };
    return this.transaction(() => this.insertRow(PREDICTION, { ...full, id: prediction.id ?? this.nextId("prediction", "predictions") }, cause));
  }

  getPrediction(id: string): PredictionRecord | undefined {
    return this.getRow(PREDICTION, id);
  }

  /**
   * 预测账本，按写入先后；可按状态、结论过滤；dueBefore 是到期时间不晚于它（到期判从最早到期的开始）。
   * due_at 可能为空（还没定到期时间），dueBefore 时不列。330 号票：premiseId 是来源里有它的（预测节点依赖它）、retractedBy 是被它撤的。
   */
  listPredictions(
    filter: { status?: PredictionStatus | readonly PredictionStatus[]; claimId?: string; dueBefore?: string; premiseId?: string; retractedBy?: string } = {},
  ): PredictionRecord[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (filter.status !== undefined) {
      const statuses = typeof filter.status === "string" ? [filter.status] : filter.status;
      where.push(`status IN (${statuses.map(() => "?").join(", ")})`);
      params.push(...statuses);
    }
    if (filter.claimId !== undefined) {
      where.push("claim_id = ?");
      params.push(filter.claimId);
    }
    if (filter.premiseId !== undefined) {
      where.push("EXISTS (SELECT 1 FROM json_each(predictions.premise_ids) WHERE value = ?)");
      params.push(filter.premiseId);
    }
    if (filter.retractedBy !== undefined) {
      where.push("retracted_by = ?");
      params.push(filter.retractedBy);
    }
    const rows = this.db.all(`SELECT * FROM predictions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY rowid`, ...params).map(PREDICTION.fromRow);
    if (filter.dueBefore === undefined) return rows;
    const due = toMs(filter.dueBefore);
    return rows.filter((p) => p.dueAt !== null && toMs(p.dueAt) <= due);
  }

  updatePrediction(id: string, patch: Partial<Omit<PredictionRecord, "id">>, cause: RevisionCause): PredictionRecord {
    return this.updateRow(PREDICTION, id, patch, cause);
  }

  // ---------- 抽取记录 ----------

  isExtracted(evidenceId: string, extractor: string): boolean {
    return this.db.get("SELECT 1 AS found FROM extraction_log WHERE evidence_id = ? AND extractor = ?", evidenceId, extractor) !== undefined;
  }

  markExtracted(evidenceId: string, extractor: string, factIds: readonly string[]): void {
    this.db.run(
      "INSERT INTO extraction_log (evidence_id, extractor, fact_ids, at) VALUES (?, ?, ?, ?) ON CONFLICT (evidence_id, extractor) DO UPDATE SET fact_ids = excluded.fact_ids, at = excluded.at",
      evidenceId,
      extractor,
      json(factIds),
      this.clock(),
    );
  }
}
