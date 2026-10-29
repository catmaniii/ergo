// 推理图谱的唯一写入口（267 号票，ADR-0030）：一组受检查的写操作。谁写都经它——每晚整理（记忆管理员的夜班）、记忆管理员、
// 记下用户的表态、用户发起的忘掉 / 彻底删除 / 别推断；秘书和维护者只读（它们那一份引擎开成只读，写一律拒）。
//
// 用法：engine.gate.write({ op, actor?, via?, reason }, () => { engine.gate.updateClaim(…); … })。
// - 写操作（insertClaim、putLink、insertInference……，和存储同样的签名）只能在 write 里调，不然报错——绕不过检查和留痕；
//   拿着存储的模块用 rgWriter(store) / rgSession(store, …)（store/store.ts），引擎挂了写入口就自动经它。
// - 一次 write 是检查和留痕的单位：fn 跑完以后，按这一次留下的修订（revisions）圈出碰过的对象，按推理图谱的规矩查一遍；
//   有不合格的就整次拒掉（保存点回滚，什么都不留），抛 ReasoningWriteRefused，原因逐条交回调用方（模型或管理员）改了再写。
//   嵌套的 write 各查各的、各自留痕（里面那次被拒、调用方接住了，外面那次照样往下走）；没给的 actor / via 跟外面那一次。
// - 过了就留痕：碰过的每个对象一行（rg_writes，只追加）——谁写的、经谁转达、哪种写操作、推法、依据（只有 id）、原因、留下的修订。
//
// 检查（WRITE_CHECKS；只查这一次真改到的，没动的旧数据不翻旧账——整张图由每晚的图谱自检 graph-check.ts 查；
// 引用存在、前提还在、依据还成立这三条判断和它共用 graph-rules.ts 的一份）：
// - premise 前提和推法写明了：还活着（已验证、猜测）的结论要有一条成立的推断，写明前提、推法（和结论的推法对得上）、理由
//   （复核标记着的依据在重推，不查，等整理重判）；
// - exists 引用的证据和事实真实存在：这次写进去的关联目标、推断前提、墓碑、取代者、竞争者、事实的证据、预测的证据、追问的对象；
// - confidence_cap 按推法封顶把握：溯因、归纳最多 medium，需求、价值观证据薄（≤2 条、不跨两个月、不跨两种场景）最多 low（confidenceCap）；
// - lift_threshold 往上抽过结构门槛：两种以上不同的场合、至少两条证据（llm-lift.ts 的 liftThreshold，时期不够的照样能出临时结论）；
// - dangling 不留悬空结论：还活着的结论，推出它的前提里至少有一条还在（没撤回、没被取代、没被忘掉；猜测、拿不准的也算在）
//   （复核标记着的不查，同上）；
// - dependents 传播铁律（329 号票 R4，ADR-0032）：已验证的结论，成立推断写的前提都得已验证（结论已验证、事实成立或被取代、证据有效）。
//   这次碰过的已验证结论查它自己（建的时候就查）；这次变了的前提（结论不再已验证、事实不再成立、证据失效、删了）查依赖它的——
//   依赖它的已验证要在同一次写里降回猜测（前提照挂、保留；reasoning-graph.ts 的 downgradeDependents），撤了的照 R8 撤，有直接证实的改挂依据；
// - cycle 依赖不绕圈（329 号票）：这次写的推断（新建、改了前提、重新成立）不能让结论顺着前提绕回自己；
// - evidence_backed（要有证据那一档）：判一条结论成立，要有至少一条能当依据（本人的、还有效）的支持；推翻要有墓碑（validate 和 exists 管）；
// - user_confirm（要用户确认那一档）：推翻用户亲口说过或确认过的结论，只能由用户发起（用户的表态、用户的纠正、跟着用户的话走）；
// - sensitive（要用户确认那一档）：敏感类别（健康、情绪、财务、关系）里没打开的那几类上，不推断（明说的、用户确认过的照常记）；
// - never（永远不做）：改原话、删证据和事实（只有彻底删除、别推断能删）、编造证据（只有素材入库和用户的表态能添证据）、
//   改结论的身份（kind 建号时定，329 号票 R1：要换得新建一条）；
// - permission：只读的引擎什么都不让写；忘掉、彻底删除、别推断、"别问这个"只由用户发起；用户的表态、纠正只能按用户的话记。
// 326 号票那条"前提里有拿不准的事实就自动降成假设"（改 kind）329 号票去掉了：身份锁死，没验证是状态（猜测），由铁律管。
//
// 问题箱（rg/questions.ts）的改动也经这里（264 号票的顺口问接进线上以后收进来）：出问题、过期（question）、记"问过"（ask）、
// 跳过和回避信号（skip）、"别问这个"（decline）、回答回写（verdict）各开一次写，问题箱向写入口报改了哪个问题（noteQuestion），
// 留痕记一行（object_type = question）；问题箱自己的表不进修订日志，所以这几样只查权限，不查推理图谱的那几条。
import { confidenceAtMost, confidenceCap } from "../domain/validate.ts";
import type {
  Claim,
  Confidence,
  Evidence,
  EvidenceDraft,
  Fact,
  Inference,
  Link,
  Method,
  ObjectType,
  PredictionRecord,
  Probe,
  Revision,
  RevisionCause,
  StoredLink,
  WriteActor,
  WriteIntent,
  WriteObjectType,
  WriteOp,
  WriteRecord,
} from "../domain/types.ts";
import type { MemoryEngine } from "../engine.ts";
import { type MemoryStore, type NewClaim, type NewFact, type NewInference, type NewPrediction, type NewProbe, type RgGate } from "../store/store.ts";
import { isDangling, LIVE_CLAIM_STATUSES, premiseHolds, premiseVerified, refExists, storeLookup, unverifiedPremises, type GraphLookup } from "./graph-rules.ts";
import { findCycles } from "./graph-check.ts";
import { liftThreshold } from "./llm-lift.ts";
import { predictionsFollowSources } from "./predictions.ts";
import { tally } from "./scoring.ts";
import type { LiftLevel, RgView } from "./types.ts";

/** 权限分档（ADR-0030 第 3 条）：直接做（过检查就行）、要有证据（检查会核）、要用户确认（只由用户发起）。"永远不做"的没有写操作 */
export type WriteTier = "direct" | "evidence" | "user_confirm";

export const OP_TIER: Readonly<Record<WriteOp, WriteTier>> = {
  ingest: "direct",
  extract: "direct",
  explicit: "direct",
  propose: "direct",
  attach: "direct",
  probe: "direct",
  mark_review: "direct",
  verdict: "direct",
  predict: "direct",
  writeback: "direct",
  validate: "direct",
  correct: "direct",
  decide: "evidence",
  lift: "evidence",
  forget: "user_confirm",
  purge: "user_confirm",
  no_infer: "user_confirm",
  question: "direct",
  ask: "direct",
  skip: "direct",
  decline: "user_confirm",
  migrate: "direct",
  rejudge: "direct",
};

/** 只由用户发起的（忘掉、彻底删除、别推断、"别问这个"） */
const USER_ONLY_OPS: ReadonlySet<WriteOp> = new Set(["forget", "purge", "no_infer", "decline"]);
/** 只能按用户的话记的（用户的表态、纠正） */
const USER_SPOKEN_OPS: ReadonlySet<WriteOp> = new Set(["verdict", "correct"]);
/** 用户这边的（用户发起、用户的表态） */
const USER_ACTORS: ReadonlySet<WriteActor> = new Set(["user", "user_verdict"]);

/** 没说谁写、外面也没有的时候按写操作定：整理里的都是夜班，表态是用户的表态，删除、纠正是用户发起，标待复核是管理员 */
const OP_DEFAULT_ACTOR: Readonly<Record<WriteOp, WriteActor>> = {
  ingest: "nightly",
  extract: "nightly",
  explicit: "nightly",
  propose: "nightly",
  attach: "nightly",
  probe: "nightly",
  mark_review: "curator",
  verdict: "user_verdict",
  predict: "nightly",
  decide: "nightly",
  lift: "nightly",
  writeback: "nightly",
  validate: "nightly",
  correct: "user",
  forget: "user",
  purge: "user",
  no_infer: "user",
  // 问题箱：出问题、过期是夜班；记"问过"是记忆管理员（ADR-0030：白天提顺口问归它，线上经秘书带出去）；"别问这个"是用户发起
  question: "nightly",
  ask: "curator",
  skip: "nightly",
  decline: "user",
  // 329 号票：老库的规矩迁移是守护进程起来时代码跑的，记在夜班名下（不是用户发起，也不是管理员白天的判断）
  migrate: "nightly",
  // 333 号票：全量重判一次（full-rejudge.ts）是代码按规矩跑的，同每晚整理记在夜班名下
  rejudge: "nightly",
};

/** 谁写的（给人看、给模型看的说法；数据，不随界面语言变） */
export const WRITE_ACTOR_LABELS: Readonly<Record<WriteActor, string>> = {
  nightly: "记忆管理员（夜班）",
  curator: "记忆管理员",
  user_verdict: "用户的表态",
  user: "用户发起",
};

/** 写操作的说法 */
export const WRITE_OP_LABELS: Readonly<Record<WriteOp, string>> = {
  ingest: "证据入库",
  extract: "抽事实",
  explicit: "明说的结论跟着事实走",
  propose: "提假设",
  attach: "挂支持或反证",
  probe: "提追问",
  mark_review: "标待复核",
  verdict: "记下用户的表态",
  predict: "记预测、判预测",
  decide: "判成立或推翻",
  lift: "往上抽",
  writeback: "写回知识图谱",
  validate: "每晚校验",
  correct: "纠正",
  forget: "忘掉",
  purge: "彻底删除",
  no_infer: "别推断",
  question: "更新问题箱",
  ask: "记问过",
  skip: "记跳过",
  decline: "别问这个",
  migrate: "规矩迁移",
  rejudge: "全量重判",
};

export const WRITE_CHECKS = ["premise", "exists", "confidence_cap", "lift_threshold", "dangling", "dependents", "cycle", "evidence_backed", "user_confirm", "sensitive", "never", "permission"] as const;
export type WriteCheck = (typeof WRITE_CHECKS)[number];

/** 一处不合格：哪条检查、哪个对象、怎么不合格（交回给调用方改了再写） */
export interface WriteProblem {
  check: WriteCheck;
  objectId: string | null;
  message: string;
}

/** 这次写被写入口拒了（整次回滚，什么都没留）：problems 逐条说哪里不合格 */
export class ReasoningWriteRefused extends Error {
  readonly problems: WriteProblem[];
  readonly op: WriteOp;
  readonly actor: WriteActor;

  constructor(frame: { op: WriteOp; actor: WriteActor }, problems: readonly WriteProblem[]) {
    super(`推理图谱的写入口没让写（${WRITE_ACTOR_LABELS[frame.actor]}·${WRITE_OP_LABELS[frame.op]}）：${problems.map((p) => p.message).join("；")}`);
    this.name = "ReasoningWriteRefused";
    this.problems = [...problems];
    this.op = frame.op;
    this.actor = frame.actor;
  }
}

export interface WriteGateOptions {
  /** 只读（秘书、维护者那一份引擎）：什么都不让写 */
  readOnly?: boolean;
  /** 敏感类别里没打开推断的那几类的场景标签（守护进程按 memory.sensitiveCategories 给，健康是 health）；不给就不查 */
  sensitiveTags?: readonly string[];
}

/** 推法封顶：溯因、归纳最多 medium（再按 confidenceCap 看证据厚不厚） */
export const METHOD_CONFIDENCE_CAP: Readonly<Record<Method, Confidence>> = {
  explicit: "high",
  user_confirmation: "high",
  deduction: "high",
  induction: "medium",
  abduction: "medium",
};

const CONFIDENCE_RANK: Readonly<Record<Confidence, number>> = { low: 0, medium: 1, high: 2 };
const lower = (a: Confidence, b: Confidence): Confidence => (CONFIDENCE_RANK[a] <= CONFIDENCE_RANK[b] ? a : b);

/** 依据最多记几个 id（太多的截掉） */
const BASIS_MAX = 24;

interface Frame {
  op: WriteOp;
  actor: WriteActor;
  via: string | null;
  reason: string;
  /** 写回时作为起因、不算依赖的结论 */
  spares: ReadonlySet<string>;
  startSeq: number;
  /** 嵌套在里面、已经查过留过痕的那几次写的修订范围 (from, to] */
  children: Array<[number, number]>;
  /** 这一次改过的问题箱里的问题 → 依据（问题要弄清的结论、事实，回答的证据） */
  questions: Map<string, Set<string>>;
}

/** 一次写碰过的一个对象 */
interface Touch {
  type: ObjectType;
  id: string;
  seqs: number[];
  created: boolean;
  deleted: boolean;
  /** 改了的字段改之前的值（这次写里第一次改它时的 from） */
  before: Record<string, unknown>;
  changed: Set<string>;
}

interface ClaimTouch extends Touch {
  /** 这次写的关联（新建、改、拿掉）：目标、极性 */
  links: Array<{ op: Revision["op"]; target: string; polarity: string | null }>;
  /** 这次改过的推断 */
  inferences: Set<string>;
}

interface Touched {
  claims: Map<string, ClaimTouch>;
  inferences: Map<string, Touch>;
  others: Map<string, Touch>;
}

const LIVE: ReadonlySet<string> = new Set(LIVE_CLAIM_STATUSES);

/** 一个还没碰过的对象 */
function blank(type: ObjectType, id: string): Touch {
  return { type, id, seqs: [], created: false, deleted: false, before: {}, changed: new Set() };
}

/** 把一条修订记到它碰过的对象上：新建、删掉、改了哪些字段（改之前的值留第一次的） */
function apply(t: Touch, r: Revision): void {
  t.seqs.push(r.seq);
  if (r.op === "create") t.created = true;
  if (r.op === "delete") t.deleted = true;
  if (r.op === "update") {
    for (const [field, change] of Object.entries(r.changes)) {
      if (!(field in t.before)) t.before[field] = change.from;
      t.changed.add(field);
    }
  }
}
const SUBSTANTIVE = ["status", "confidence", "epistemic", "method", "statement", "context"];

export class ReasoningWriteGate implements RgGate {
  private readonly engine: MemoryEngine;
  private readonly readOnly: boolean;
  private readonly sensitiveTags: readonly string[];
  private readonly frames: Frame[] = [];

  constructor(engine: MemoryEngine, options: WriteGateOptions = {}) {
    this.engine = engine;
    this.readOnly = options.readOnly === true;
    this.sensitiveTags = [...(options.sensitiveTags ?? [])];
  }

  private get store(): MemoryStore {
    return this.engine.store;
  }

  /** 现在是不是在一次写里 */
  get open(): boolean {
    return this.frames.length > 0;
  }

  /** 这一份是不是只读的（秘书、维护者那一份） */
  get isReadOnly(): boolean {
    return this.readOnly;
  }

  /** 开一次写（见文件开头）：fn 里调写操作；写完检查，不合格整次拒掉（抛 ReasoningWriteRefused），合格就留痕 */
  write<T>(intent: WriteIntent, fn: () => T): T {
    const parent = this.frames.at(-1);
    const actor = intent.actor ?? parent?.actor ?? OP_DEFAULT_ACTOR[intent.op];
    const frame: Frame = {
      op: intent.op,
      actor,
      via: intent.via ?? parent?.via ?? null,
      // 用户那边发起的一次写（表态、删除）里面嵌着的，原因前面带上用户那一层的（管理员记下的那句话是这几处改动共同的起因）
      reason: parent !== undefined && USER_ACTORS.has(parent.actor) && parent.reason !== intent.reason ? `${parent.reason}（${intent.reason}）` : intent.reason,
      spares: new Set(intent.spares ?? []),
      startSeq: 0,
      children: [],
      questions: new Map(),
    };
    const denied = this.permissionProblems(frame);
    if (denied.length > 0) throw new ReasoningWriteRefused(frame, denied);
    return this.store.savepoint(() => {
      frame.startSeq = this.store.latestRevisionSeq();
      this.frames.push(frame);
      let result: T;
      try {
        result = fn();
        // 330 号票（R8、R11 落到预测节点上）：这次状态变了的结论，以它为来源的预测跟着作废、跟着回来（同一次写里，免得每个撤回的地方各记着）
        const moved = this.store
          .revisionsBetween(frame.startSeq, this.store.latestRevisionSeq())
          .filter((r) => r.objectType === "claim" && r.changes.status !== undefined)
          .map((r) => r.objectId);
        if (moved.length > 0) predictionsFollowSources(this.store, this, moved);
      } finally {
        this.frames.pop();
      }
      const own = this.store.revisionsBetween(frame.startSeq, this.store.latestRevisionSeq()).filter((r) => !frame.children.some(([from, to]) => r.seq > from && r.seq <= to));
      const touched = this.collect(own);
      const endSeq = this.store.latestRevisionSeq();
      const problems = this.check(frame, touched);
      if (problems.length > 0) throw new ReasoningWriteRefused(frame, problems);
      this.trail(frame, touched);
      parent?.children.push([frame.startSeq, endSeq]);
      return result;
    });
  }

  // ---------- 写操作（只能在 write 里调） ----------

  /**
   * 问题箱（rg/questions.ts）这一次改了一个问题（新建、改状态、记经过、"别问这个"挡住一类）：要在一次写里，留痕记一行。
   * 问题箱自己的表不进修订日志（经过在 question_log 里），所以由它来报
   */
  noteQuestion(questionId: string, basis: readonly string[] = []): void {
    this.guard("改问题箱");
    const frame = this.frames.at(-1)!;
    const known = frame.questions.get(questionId) ?? new Set<string>();
    for (const id of basis) known.add(id);
    frame.questions.set(questionId, known);
  }

  private guard(what: string): void {
    if (this.frames.length === 0) throw new Error(`推理图谱只能经唯一写入口写：${what} 要在 engine.gate.write(…) 里调（先说清谁写、做什么、为什么）`);
  }

  insertEvidence(draft: EvidenceDraft, cause?: RevisionCause): Evidence {
    this.guard("insertEvidence");
    return this.store.insertEvidence(draft, cause);
  }
  updateEvidence(id: string, patch: Partial<Pick<Evidence, "status" | "text">>, cause: RevisionCause): Evidence {
    this.guard("updateEvidence");
    return this.store.updateEvidence(id, patch, cause);
  }
  deleteEvidence(id: string, cause: RevisionCause): boolean {
    this.guard("deleteEvidence");
    return this.store.deleteEvidence(id, cause);
  }
  insertFact(fact: NewFact, cause: RevisionCause): Fact {
    this.guard("insertFact");
    return this.store.insertFact(fact, cause);
  }
  updateFact(id: string, patch: Partial<Omit<Fact, "id">>, cause: RevisionCause): Fact {
    this.guard("updateFact");
    return this.store.updateFact(id, patch, cause);
  }
  deleteFact(id: string, cause: RevisionCause): boolean {
    this.guard("deleteFact");
    return this.store.deleteFact(id, cause);
  }
  insertClaim(claim: NewClaim, cause?: RevisionCause): Claim {
    this.guard("insertClaim");
    return this.store.insertClaim(claim, cause);
  }
  updateClaim(id: string, patch: Partial<Omit<Claim, "id">>, cause: RevisionCause): Claim {
    this.guard("updateClaim");
    return this.store.updateClaim(id, patch, cause);
  }
  putLink(link: Link, cause?: RevisionCause): StoredLink {
    this.guard("putLink");
    return this.store.putLink(link, cause);
  }
  removeLink(key: Omit<Link, "rationale">, cause: RevisionCause): boolean {
    this.guard("removeLink");
    return this.store.removeLink(key, cause);
  }
  insertInference(inference: NewInference, cause?: RevisionCause): Inference {
    this.guard("insertInference");
    return this.store.insertInference(inference, cause);
  }
  updateInference(id: string, patch: Partial<Omit<Inference, "id">>, cause: RevisionCause): Inference {
    this.guard("updateInference");
    return this.store.updateInference(id, patch, cause);
  }
  insertProbe(probe: NewProbe, cause?: RevisionCause): Probe {
    this.guard("insertProbe");
    return this.store.insertProbe(probe, cause);
  }
  updateProbe(id: string, patch: Partial<Omit<Probe, "id">>, cause: RevisionCause): Probe {
    this.guard("updateProbe");
    return this.store.updateProbe(id, patch, cause);
  }
  putPrediction(prediction: NewPrediction, cause?: RevisionCause): PredictionRecord {
    this.guard("putPrediction");
    return this.store.putPrediction(prediction, cause);
  }
  updatePrediction(id: string, patch: Partial<Omit<PredictionRecord, "id">>, cause: RevisionCause): PredictionRecord {
    this.guard("updatePrediction");
    return this.store.updatePrediction(id, patch, cause);
  }

  // ---------- 留痕 ----------

  /** 留痕（按先后）：可按对象、谁写的、哪种写操作过滤 */
  records(filter: { objectId?: string; actor?: WriteActor; op?: WriteOp } = {}): WriteRecord[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.objectId !== undefined) {
      where.push("object_id = ?");
      params.push(filter.objectId);
    }
    if (filter.actor !== undefined) {
      where.push("actor = ?");
      params.push(filter.actor);
    }
    if (filter.op !== undefined) {
      where.push("op = ?");
      params.push(filter.op);
    }
    return this.store.db.all(`SELECT * FROM rg_writes ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY seq`, ...params).map(recordOf);
  }

  /** 一个对象（结论、证据、事实……）的修改历史：谁写的、做什么、推法、依据、原因 */
  history(objectId: string): WriteRecord[] {
    return this.records({ objectId });
  }

  /** 每条修订（seq）是哪一次写留下的（记忆页给修订标"谁写的"） */
  recordsBySeq(objectId: string): Map<number, WriteRecord> {
    const out = new Map<number, WriteRecord>();
    for (const r of this.history(objectId)) for (const seq of r.revisionSeqs) out.set(seq, r);
    return out;
  }

  private trail(frame: Frame, touched: Touched): void {
    const at = this.store.now();
    const rows: Array<{ touch: { type: WriteObjectType; id: string; seqs: number[] }; method: Method | null; basis: string[] }> = [];
    for (const touch of touched.claims.values()) {
      const claim = this.store.getClaim(touch.id);
      rows.push({ touch, method: claim?.method ?? null, basis: claim ? this.claimBasis(claim) : [] });
    }
    for (const touch of touched.others.values()) rows.push({ touch, method: null, basis: this.otherBasis(touch) });
    for (const [id, basis] of frame.questions) rows.push({ touch: { type: "question", id, seqs: [] }, method: null, basis: [...basis] });
    for (const { touch, method, basis } of rows) {
      this.store.db.run(
        "INSERT INTO rg_writes (at, actor, via, op, object_type, object_id, method, basis, reason, revision_seqs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        at,
        frame.actor,
        frame.via,
        frame.op,
        touch.type,
        touch.id,
        method,
        JSON.stringify(basis.slice(0, BASIS_MAX)),
        frame.reason,
        JSON.stringify(touch.seqs),
      );
    }
  }

  /** 结论的依据：成立推断的前提，加上能当依据的支持 */
  private claimBasis(claim: Claim): string[] {
    const view = this.view();
    const premises = this.store.inferencesOf(claim.id).filter((i) => i.status === "active").flatMap((i) => i.premiseIds);
    const supports = tally(claim.id, this.store.linksOf(claim.id), view).supportTargets;
    return [...new Set([...premises, ...supports])];
  }

  private otherBasis(touch: Touch): string[] {
    if (touch.deleted) return [];
    if (touch.type === "fact") return [...(this.store.getFact(touch.id)?.evidenceIds ?? [])];
    if (touch.type === "prediction") {
      const p = this.store.getPrediction(touch.id);
      return p ? [p.claimId, ...(p.evidenceId ? [p.evidenceId] : [])] : [];
    }
    if (touch.type === "probe") return [...(this.store.getProbe(touch.id)?.discriminates ?? [])];
    return [];
  }

  // ---------- 圈出这次碰过的对象 ----------

  private collect(revisions: readonly Revision[]): Touched {
    const touched: Touched = { claims: new Map(), inferences: new Map(), others: new Map() };
    const claimTouch = (id: string): ClaimTouch => {
      let t = touched.claims.get(id);
      if (!t) {
        t = { ...blank("claim", id), links: [], inferences: new Set() };
        touched.claims.set(id, t);
      }
      return t;
    };
    for (const r of revisions) {
      if (r.objectType === "claim") apply(claimTouch(r.objectId), r);
      else if (r.objectType === "link") {
        const t = claimTouch(r.objectId);
        t.seqs.push(r.seq);
        const target = r.changes.target;
        const polarity = r.changes.polarity;
        t.links.push({ op: r.op, target: String(target?.to ?? target?.from ?? ""), polarity: polarity?.to === undefined || polarity.to === null ? (polarity?.from === undefined ? null : String(polarity.from)) : String(polarity.to) });
      } else if (r.objectType === "inference") {
        let t = touched.inferences.get(r.objectId);
        if (!t) {
          t = blank("inference", r.objectId);
          touched.inferences.set(r.objectId, t);
        }
        apply(t, r);
        const conclusion = this.store.getInference(r.objectId)?.conclusionClaimId;
        if (conclusion) {
          const c = claimTouch(conclusion);
          c.seqs.push(r.seq);
          c.inferences.add(r.objectId);
        }
      } else if (r.objectType === "evidence" || r.objectType === "fact" || r.objectType === "prediction" || r.objectType === "probe") {
        const key = `${r.objectType}:${r.objectId}`;
        let t = touched.others.get(key);
        if (!t) {
          t = blank(r.objectType, r.objectId);
          touched.others.set(key, t);
        }
        apply(t, r);
      }
      // 实体、交互策略不归写入口管（实体是抽事实时顺手建的名字，策略是从结论编出来的，另有确认）
    }
    for (const t of touched.claims.values()) t.seqs = [...new Set(t.seqs)].toSorted((a, b) => a - b);
    return touched;
  }

  // ---------- 检查 ----------

  private view(): RgView {
    return this.engine.rg.view();
  }

  /** 写之前就能判的：只读、谁能做这种写 */
  private permissionProblems(frame: Frame): WriteProblem[] {
    const who = WRITE_ACTOR_LABELS[frame.actor];
    if (this.readOnly) return [{ check: "permission", objectId: null, message: "这一份推理图谱是只读的（秘书、维护者只读，不写推理图谱）" }];
    if (USER_ONLY_OPS.has(frame.op) && frame.actor !== "user") {
      return [{ check: "permission", objectId: null, message: `${WRITE_OP_LABELS[frame.op]}只由用户发起（要用户确认），${who}不能自己做` }];
    }
    if (USER_SPOKEN_OPS.has(frame.op) && !USER_ACTORS.has(frame.actor)) {
      return [{ check: "permission", objectId: null, message: `${WRITE_OP_LABELS[frame.op]}只能按用户的话记，${who}不能替用户表态` }];
    }
    return [];
  }

  private check(frame: Frame, touched: Touched): WriteProblem[] {
    const problems: WriteProblem[] = [];
    const view = this.view();
    this.checkNever(frame, touched, problems);
    this.checkExists(touched, problems);
    const liftCache = new Map<string, WriteProblem | null>();
    for (const touch of touched.claims.values()) {
      const claim = this.store.getClaim(touch.id);
      if (!claim) continue;
      this.checkClaim(frame, touch, claim, view, liftCache, problems);
    }
    this.checkDependents(frame, touched, problems);
    this.checkCycles(touched, problems);
    return problems;
  }

  /** 永远不做：改原话、删证据和事实、编造证据 */
  private checkNever(frame: Frame, touched: Touched, problems: WriteProblem[]): void {
    const deleting = frame.op === "purge" || frame.op === "no_infer";
    for (const t of touched.others.values()) {
      if (t.type === "evidence") {
        if (t.created && frame.op !== "ingest" && frame.op !== "verdict") {
          problems.push({ check: "never", objectId: t.id, message: `不能编造证据：只有素材入库和用户的表态能添证据（${WRITE_OP_LABELS[frame.op]}要新添 ${t.id}）` });
        }
        if (t.changed.has("text") && !t.deleted) {
          const cleared = frame.op === "forget" && (this.store.getEvidence(t.id)?.text ?? "") === "";
          if (!cleared) problems.push({ check: "never", objectId: t.id, message: `不能改原话：证据 ${t.id} 的原文只有忘掉时能清空，别的时候一个字都不改` });
        }
        if (t.deleted && !deleting) problems.push({ check: "never", objectId: t.id, message: `不能删证据：证据 ${t.id} 只有彻底删除、别推断（用户发起）能删` });
      }
      if (t.type === "fact" && t.deleted && !deleting) problems.push({ check: "never", objectId: t.id, message: `不能删事实：事实 ${t.id} 只有彻底删除、别推断（用户发起）能删` });
    }
    // 329 号票（R1）：身份锁死——kind 建号时定，之后不改（要换得新建一条，旧的撤回或被取代）。
    // 只有规矩迁移（migrate）能把 326 号票改过的身份改回建号时的那个（修订日志里第一次改 kind 的 from）
    for (const t of touched.claims.values()) {
      if (t.created || !t.changed.has("kind")) continue;
      const original = this.store.revisions(t.id, "claim").find((r) => r.changes.kind !== undefined)?.changes.kind?.from;
      if (frame.op === "migrate" && this.store.getClaim(t.id)?.kind === original) continue;
      problems.push({ check: "never", objectId: t.id, message: `不能改结论 ${t.id} 的身份（kind 建号时定了，${String(t.before.kind)} 不改）：没验证是状态（猜测），要换得新建一条` });
    }
  }

  /** 按存储现查（graph-rules.ts 的几条判断用） */
  private get lookup(): GraphLookup {
    return storeLookup(this.store);
  }

  private exists(id: string): boolean {
    return refExists(this.lookup, id);
  }

  /** 引用的证据和事实真实存在（只查这次写进去的引用） */
  private checkExists(touched: Touched, problems: WriteProblem[]): void {
    const missing = (owner: string, what: string, ids: readonly (string | null | undefined)[]) => {
      for (const id of ids) {
        if (id === null || id === undefined || id === "") continue;
        if (!this.exists(id)) problems.push({ check: "exists", objectId: owner, message: `${owner} 引用的${what} ${id} 不存在（不能编造证据，被删的也不能再引用）` });
      }
    };
    for (const t of touched.claims.values()) {
      const claim = this.store.getClaim(t.id);
      if (!claim) continue;
      for (const link of t.links) if (link.op !== "delete") missing(t.id, "证据或事实", [link.target]);
      if (t.created || t.changed.has("retractedBy")) missing(t.id, "墓碑（撤回它的那条）", [claim.retractedBy]);
      if (t.created || t.changed.has("supersededBy")) missing(t.id, "取代它的结论", [claim.supersededBy]);
      if (t.created || t.changed.has("competesWith")) missing(t.id, "竞争的结论", claim.competesWith);
    }
    for (const t of touched.inferences.values()) {
      const inference = this.store.getInference(t.id);
      if (!inference || inference.status !== "active") continue;
      if (t.created || t.changed.has("premiseIds") || t.changed.has("status")) missing(inference.conclusionClaimId, "前提", inference.premiseIds);
    }
    for (const t of touched.others.values()) {
      if (t.deleted) continue;
      if (t.type === "fact" && (t.created || t.changed.has("evidenceIds"))) missing(t.id, "证据", this.store.getFact(t.id)?.evidenceIds ?? []);
      if (t.type === "prediction") {
        const p = this.store.getPrediction(t.id);
        if (p) missing(t.id, "结论或证据", [p.claimId, p.evidenceId]);
      }
      if (t.type === "probe" && (t.created || t.changed.has("discriminates") || t.changed.has("foundEvidenceIds"))) {
        const p = this.store.getProbe(t.id);
        if (p) missing(t.id, "要区分的对象或找到的证据", [...p.discriminates, ...p.foundEvidenceIds]);
      }
    }
  }

  /** 前提还在吗（graph-rules.ts 的 premiseHolds）：事实成立过（没撤回、没被纠正）、证据有效、结论没撤回没被取代 */
  private holds(id: string): boolean {
    return premiseHolds(this.lookup, id);
  }

  /** 撤回它的这条是用户自己的话、自己做的事吗（本人的证据，或者用户说的、做的那类事实） */
  private causeIsUsers(id: string | null): boolean {
    if (id === null) return false;
    const evidence = this.store.getEvidence(id);
    if (evidence) return evidence.sourceLevel === "self";
    const fact = this.store.getFact(id);
    return fact !== undefined && (fact.assertion === "user_stated" || fact.assertion === "observed");
  }

  private checkClaim(frame: Frame, t: ClaimTouch, claim: Claim, view: RgView, liftCache: Map<string, WriteProblem | null>, problems: WriteProblem[]): void {
    const live = LIVE.has(claim.status);
    const was = <K extends keyof Claim>(field: K): Claim[K] | undefined => (t.created ? undefined : field in t.before ? (t.before[field] as Claim[K]) : claim[field]);
    const substantive = t.created || SUBSTANTIVE.some((f) => t.changed.has(f)) || t.inferences.size > 0 || t.links.length > 0;
    const activeInferences = this.store.inferencesOf(claim.id).filter((i) => i.status === "active");

    if (live && substantive && !claim.needsReview) {
      // 前提和推法写明了（复核标记着的依据在重推，等整理重判完再查）
      const stated = activeInferences.filter((i) => i.premiseIds.length > 0 && i.rationale.trim().length > 0 && methodFits(claim, i.method));
      if (stated.length === 0) {
        problems.push({ check: "premise", objectId: claim.id, message: `结论 ${claim.id} 没写明前提和推法：要有一条成立的推断，写明前提（事实、结论或证据）、推法（${claim.epistemic === "inferred" ? claim.method : "明说 / 用户确认"}）和理由` });
      } else if (!stated.some((i) => i.premiseIds.some((id) => this.holds(id)))) {
        // 不留悬空结论
        const ids = [...new Set(stated.flatMap((i) => i.premiseIds))];
        problems.push({ check: "dangling", objectId: claim.id, message: `结论 ${claim.id} 悬空了：推出它的前提（${ids.join("、")}）都不在了（撤回、被取代、被忘掉或删了），要么撤回、要么加复核标记等重推` });
      }
    }

    // 329 号票：只是降成猜测、复活成猜测（状态改了、把握没动）不重查把握——老数据把握超了的不该挡住降级、撤回往下传
    const statusRaised = t.changed.has("status") && claim.status === "active";
    if (live && (t.created || t.changed.has("confidence") || t.changed.has("epistemic") || t.changed.has("method") || statusRaised || t.links.length > 0)) {
      // 按推法封顶把握
      const tl = tally(claim.id, this.store.linksOf(claim.id), view);
      const evidenceCap = confidenceCap({ tier: claim.tier, epistemic: claim.epistemic, supportCount: tl.supportEvidenceIds.length, periods: tl.periods, contexts: tl.contexts });
      const cap = lower(METHOD_CONFIDENCE_CAP[claim.method], evidenceCap);
      if (!confidenceAtMost(claim.confidence, cap)) {
        const why = evidenceCap === "low" ? `${claim.tier} 的支持只有 ${tl.supportEvidenceIds.length} 条证据、${tl.periods} 个月、${tl.contexts} 种场景` : `推法是 ${claim.method}`;
        problems.push({ check: "confidence_cap", objectId: claim.id, message: `结论 ${claim.id} 的把握 ${claim.confidence} 超过了上限 ${cap}（${why}）` });
      }
    }

    if (claim.status === "active" && (t.created || was("status") !== "active")) {
      // 要有证据：判成立要有能当依据的支持
      const tl = tally(claim.id, this.store.linksOf(claim.id), view);
      if (tl.support <= 0 || tl.supportEvidenceIds.length === 0) {
        problems.push({ check: "evidence_backed", objectId: claim.id, message: `判结论 ${claim.id} 成立要有证据：现在没有一条能当依据的支持（本人的、还有效的证据或事实）` });
      }
    }

    if (live && (t.created || t.inferences.size > 0)) {
      // 往上抽过结构门槛
      const member = this.engine.rg.registry.memberOf(claim.id);
      const group = member ? this.engine.rg.registry.getGroup(member.groupKey) : undefined;
      if (group?.live && group.pattern.startsWith("lift:")) {
        if (!liftCache.has(group.key)) liftCache.set(group.key, this.liftProblem(group.key, group.pattern.slice(5) as LiftLevel, group.observationIds, view));
        const p = liftCache.get(group.key);
        if (p) problems.push({ ...p, objectId: claim.id });
      }
    }

    if (this.sensitiveTags.length > 0 && claim.epistemic === "inferred" && claim.status !== "retracted" && claim.status !== "superseded" && (t.created || t.changed.has("context") || t.changed.has("statement") || t.inferences.size > 0)) {
      // 敏感类别上不推断（要用户确认）
      const premiseFacts = activeInferences.flatMap((i) => i.premiseIds).map((id) => this.store.getFact(id)).filter((f): f is Fact => f !== undefined);
      const hit = [...new Set([...claim.context, ...premiseFacts.flatMap((f) => f.context)].filter((tag) => this.sensitiveTags.includes(tag)))];
      if (hit.length > 0) {
        problems.push({ check: "sensitive", objectId: claim.id, message: `敏感类别（${hit.join("、")}）上的推断要用户确认：这一类默认只记录、不用于推断，配置里打开了才推（用户明说的照常记）` });
      }
    }

    const before = was("epistemic");
    if (!t.created && (before === "explicit" || before === "user_confirmed")) {
      // 推翻用户亲口说过或确认过的（要用户确认）
      const overturned = (t.changed.has("status") && claim.status === "retracted") || (t.changed.has("epistemic") && claim.epistemic === "inferred");
      const byUser = USER_ACTORS.has(frame.actor) || frame.op === "explicit" || (claim.status === "retracted" && this.causeIsUsers(claim.retractedBy));
      if (overturned && !byUser) {
        problems.push({
          check: "user_confirm",
          objectId: claim.id,
          message: `${claim.id} 是用户${before === "explicit" ? "亲口说过" : "确认过"}的结论，推翻它要用户确认（出确认卡，或者由用户发起），${WRITE_ACTOR_LABELS[frame.actor]}不能自己改`,
        });
      }
    }
  }

  /** 往上抽的结构门槛（两种以上场合、至少两条证据）；过了是 null */
  private liftProblem(groupKey: string, level: LiftLevel, premiseIds: readonly string[], view: RgView): WriteProblem | null {
    const inputs = this.engine.rg.liftInputs(level, view).filter((i) => premiseIds.includes(i.claim.id));
    const t = liftThreshold(level, inputs, view);
    if (t.hardFailed.length === 0) return null;
    return {
      check: "lift_threshold",
      objectId: null,
      message: `往上抽（${groupKey}）没过结构门槛：${t.hardFailed.join("、")}（要两种以上不同的场合、至少两条证据；现在 ${t.scenes.length} 种场景、${t.evidenceIds.length} 条证据，能用的下层结论 ${inputs.length} 条）`,
    };
  }

  /**
   * 传播铁律（329 号票 R4）：已验证的结论，成立推断写的前提都得已验证。
   * - 这次碰过的已验证结论（新建的、改了状态和推断的）查它自己：建的时候就压在猜测上的也拦（以前写入口不拦、自检才拦）；
   * - 这次变了的前提（结论不再已验证、事实不再成立、证据失效、删了），不管在链上第几层，以它为前提（成立推断）的结论不能还已验证——
   *   要在同一次写里降回猜测（前提照挂、保留），撤回的照 R8 撤，有直接证实的改挂依据。不设深度上限
   */
  private checkDependents(frame: Frame, touched: Touched, problems: WriteProblem[]): void {
    const lookup = this.lookup;
    const reported = new Set<string>();
    // 这次写让它成了已验证（新建、改了状态）或者动了它的推断（依据）的才查它自己；只加复核标记、改把握的不查（老库里不合规矩的留给自检和迁移）
    const basisTouched = new Set<string>();
    for (const t of touched.inferences.values()) {
      const inference = this.store.getInference(t.id);
      if (inference) basisTouched.add(inference.conclusionClaimId);
    }
    for (const t of touched.claims.values()) {
      const claim = this.store.getClaim(t.id);
      if (!claim || claim.status !== "active" || frame.spares.has(claim.id)) continue;
      if (!(t.created || "status" in t.before || basisTouched.has(claim.id))) continue;
      if (claim.epistemic !== "explicit" && lookup.premisesOf(claim.id).length === 0) {
        reported.add(claim.id);
        problems.push({ check: "dependents", objectId: claim.id, message: `已验证的结论 ${claim.id} 没有成立的依据（推断都停用、撤了）：依据在重推的先当猜测` });
        continue;
      }
      const bad = unverifiedPremises(lookup, claim.id);
      if (bad.length === 0) continue;
      reported.add(claim.id);
      problems.push({
        check: "dependents",
        objectId: claim.id,
        message: `已验证的结论 ${claim.id} 压在没验证的前提（${bad.join("、")}）上：已验证的不能依赖猜测、拿不准或撤回的，要么降回猜测（前提照挂、保留），要么有直接证实改挂依据`,
      });
    }
    // 依据变了（这次写里成了没验证、撤回、删了）：依赖它的已验证要在同一次写里降回猜测或改挂依据（R4），
    // 前提一条都不在了的（悬空）要在同一次写里撤回（R8）或者加复核标记（来源失效、等重推）
    const changed: Array<{ id: string; why: string }> = [];
    for (const t of touched.claims.values()) {
      const claim = this.store.getClaim(t.id);
      if (!claim || t.created) continue;
      const wasStatus = "status" in t.before ? t.before.status : claim.status;
      if (wasStatus === claim.status) continue;
      if (wasStatus === "active" || (LIVE.has(String(wasStatus)) && !LIVE.has(claim.status))) changed.push({ id: claim.id, why: `${String(wasStatus)} → ${claim.status}` });
    }
    for (const t of touched.others.values()) {
      if (t.type !== "fact" && t.type !== "evidence") continue;
      if (t.deleted) {
        changed.push({ id: t.id, why: "删了" });
        continue;
      }
      if (t.changed.has("status") && !premiseVerified(lookup, t.id)) changed.push({ id: t.id, why: `${t.type === "fact" ? "事实" : "证据"} ${String(lookup.statusOf(t.id))}` });
    }
    for (const { id, why } of changed) {
      for (const inference of this.store.inferencesByPremise(id)) {
        if (inference.status !== "active") continue;
        const dependent = this.store.getClaim(inference.conclusionClaimId);
        if (!dependent || !LIVE.has(dependent.status) || reported.has(dependent.id) || frame.spares.has(dependent.id)) continue;
        if (!dependent.needsReview && isDangling(lookup, dependent.id)) {
          reported.add(dependent.id);
          problems.push({
            check: "dependents",
            objectId: dependent.id,
            message: `依据 ${id} 变了（${why}），依赖它的 ${dependent.id} 前提都不在了：要在同一次写里撤回（被推翻往上传）或者加复核标记（来源失效、等重推），不留悬空`,
          });
          continue;
        }
        if (dependent.status !== "active" || unverifiedPremises(lookup, dependent.id).length === 0) continue;
        reported.add(dependent.id);
        problems.push({
          check: "dependents",
          objectId: dependent.id,
          message: `依据 ${id} 变了（${why}），依赖它的已验证结论 ${dependent.id} 要在同一次写里降回猜测（前提照挂、保留；推断 ${inference.id}），不能还当已验证`,
        });
      }
    }
  }

  /** 依赖不绕圈（329 号票）：这次写的推断（新建、改了前提、重新成立）不能让结论顺着成立推断的前提绕回自己 */
  private checkCycles(touched: Touched, problems: WriteProblem[]): void {
    const starts = new Set<string>();
    for (const t of touched.inferences.values()) {
      if (!(t.created || t.changed.has("premiseIds") || t.changed.has("status"))) continue;
      const inference = this.store.getInference(t.id);
      if (inference?.status === "active") starts.add(inference.conclusionClaimId);
    }
    if (starts.size === 0) return;
    const next = (id: string) => [...new Set(this.lookup.premisesOf(id).filter((p) => this.store.getClaim(p) !== undefined))];
    const reported = new Set<string>();
    for (const cycle of findCycles([...starts], next)) {
      if (!cycle.some((id) => starts.has(id)) || reported.has(cycle.join("|"))) continue;
      reported.add(cycle.join("|"));
      problems.push({ check: "cycle", objectId: cycle.find((id) => starts.has(id)) ?? cycle[0]!, message: `依赖绕成了环：${[...cycle, cycle[0]].join(" → ")}（几条结论互为前提，哪条都推不出来）` });
    }
  }
}

/** 推断的推法和结论对得上：推断出来的结论推法要一样；明说的推断写 explicit；用户确认过的照原来推出它的那条 */
function methodFits(claim: Claim, method: Method): boolean {
  if (claim.epistemic === "explicit") return method === "explicit";
  if (claim.epistemic === "inferred") return method === claim.method;
  return true;
}

function recordOf(r: Record<string, unknown>): WriteRecord {
  return {
    seq: Number(r.seq),
    at: String(r.at),
    actor: r.actor as WriteActor,
    via: r.via === null || r.via === undefined ? null : String(r.via),
    op: r.op as WriteOp,
    objectType: r.object_type as WriteObjectType,
    objectId: String(r.object_id),
    method: r.method === null || r.method === undefined ? null : (r.method as Method),
    basis: JSON.parse(String(r.basis)) as string[],
    reason: String(r.reason),
    revisionSeqs: JSON.parse(String(r.revision_seqs)) as number[],
  };
}
