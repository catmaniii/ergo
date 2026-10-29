// MemoryEngine：记忆 PoC 对外的操作（第 7.2 节）。188 号票做写入和查询：
// - 写入：ingestEvidence / ingestFrom（证据入库、建关键词索引）、extractFacts（抽事实、变化判定，增量、幂等）、indexVectors（补算向量）；
// - 查询：getEvidence / getFact / getEntity、factsAt（那时成立的事实，按场景过滤）、neighbors（一跳、两跳）；
// - 失效：correct（纠正）、invalidateEvidence（忘掉）做到事实这一层，再调推理图谱的传播钩子（④ 号票接上）。
// - 检索（190 号票，③）：search 的 vector / hybrid / hybrid_kg 交给 retrieval/search.ts；
// - 推理图谱（④ 号票，rg/reasoning-graph.ts）：reflect、explainClaim、findCounterevidence、tracePremises、getUserModel、answer，
//   search 的 hybrid_kg_rg 模式（另接了 ReasoningRetrieval 时用接上的那个）；它也是默认的传播钩子。
// - 为任务调出相关的用户模型、交互策略（196 号票）：indexClaims、relevantUserModel、compileStrategies、listStrategies、confirmStrategy、
//   adviseTask（rg/claim-index.ts、value-retrieval.ts、strategies.ts、advice.ts）。
// - 回答层（202 号票）：answer 先分流（rg/question.ts），关于自己的判断、为什么查用户模型和推理图谱、过相关门槛（rg/relevance.ts），
//   任务走 adviseTask；门槛可以在打开引擎时配（relevanceGate）。
// - 每日整理和了解你问题（198 号票）：runNightly（nightly.ts）、pickQuestion、recordQuestionAnswer、recordQuestionSkipped、declineQuestion、
//   264 号票接进线上时加的 markQuestionAsked（秘书真的带上了才记问过）、readQuestionReply（用户的下一句是不是在答）、
//   listQuestions（rg/questions.ts、rg/question-sources.ts）。
// - 给大模型回答器的记忆简报（216 号票）：memoryBrief（llm/brief.ts；回答器本身是 llm/answerer.ts 的 LlmAnswerer）；
//   每条消息的记忆简报（266 号票，守护进程追加在秘书每一轮输入的尾部）：messageBrief。
// - 用户对一条结论直接表态（263 号票）：recordClaimVerdict（对 / 不对 / 拿不准，rg/verdicts.ts）、rejectClaim、markClaimForReview。
// - 推理图谱的唯一写入口（267 号票，ADR-0030，rg/write-gate.ts）：engine.gate。上面这些写操作一律经它——写之前按推理图谱的规矩检查（rg/graph-rules.ts 和写入口自己那几条）、
//   权限分档、写完留痕；证据入库、抽事实、纠正、忘掉也一样（忘掉、纠正默认算用户发起）。打开时可以开成只读（秘书、维护者那一份）。
import { USER_ENTITY_ID } from "./domain/ids.ts";
import type { Claim, Entity, Evidence, EvidenceDraft, Fact } from "./domain/types.ts";
import type { Strategy, StrategyStatus } from "./domain/types.ts";
import type { Embedder } from "./embedding/embedder.ts";
import type { EvidenceSource } from "./evidence/source.ts";
import type { ChatModel } from "./llm/chat.ts";
import type { FactExtractor } from "./kg/extractor.ts";
import { alignAliases, isAliasAware } from "./kg/align.ts";
import { RelationalFactExtractor } from "./kg/relations.ts";
import { isPreparableExtractor } from "./kg/llm-extractor.ts";
import { KnowledgeGraph, type ChangeRecord, type FactInvalidation, type FactsAtQuery, type Neighborhood, type NeighborOptions } from "./kg/graph.ts";
import { DEFAULT_LEXICON, type Lexicon } from "./kg/lexicon.ts";
import { Retriever } from "./retrieval/search.ts";
import type { Hit, ReasoningRetrieval, SearchOptions } from "./retrieval/types.ts";
import { createBudget, DEFAULT_MAX_MODEL_CALLS, ReasoningGraph } from "./rg/reasoning-graph.ts";
import type { PredictionJudge } from "./rg/predictions.ts";
import { RuleReasoner } from "./rg/rule-reasoner.ts";
import type { Answer, AnswerOptions, ClaimExplanation, DroppedOutput, ModelBudget, PremiseTrace, Reasoner, ReasoningStats, ReflectOptions, ReflectReport, UserModel, UserModelQuery } from "./rg/types.ts";
import { MemoryStore } from "./store/store.ts";
import { adviseTask, type AdviseOptions, type TaskAdvice } from "./rg/advice.ts";
import { ClaimIndex, type ClaimIndexReport, type ClaimVectorReport } from "./rg/claim-index.ts";
import { StrategyBook, type CompileReport } from "./rg/strategies.ts";
import { relevantUserModel, type RelevantUserModel, type RelevantUserModelOptions } from "./rg/value-retrieval.ts";
import type { RelevanceGate } from "./rg/relevance.ts";
import { runNightly, type NightlyOptions, type NightlyResult } from "./nightly.ts";
import { QuestionBook, type AnswerReading, type AnswerRecord, type PickOptions, type PickResult, type Question, type QuestionStatus, type QuestionView, type QuestionWriteBy, type ReplyReading, type SkipRecord } from "./rg/questions.ts";
import type { JointSummary, KnowYouQuestion, QuestionSink } from "./rg/joint.ts";
import type { FactMark } from "./kg/marks.ts";
import { memoryBrief as buildMemoryBrief, messageBrief as buildMessageBrief, type MemoryBrief, type MemoryBriefOptions, type MessageBrief, type MessageBriefOptions } from "./llm/brief.ts";
import { recordClaimVerdict, type ClaimVerdict, type ClaimVerdictOptions, type ClaimVerdictResult } from "./rg/verdicts.ts";
import { isVerdictEvidence } from "./evidence/boundary.ts";
import { ReasoningWriteGate, type WriteGateOptions } from "./rg/write-gate.ts";
import type { WriteActor } from "./domain/types.ts";

/** 还没做的操作（留给后面的票） */
export class NotImplementedYet extends Error {
  constructor(operation: string, ticket: string) {
    super(`${operation} 还没做（${ticket}）`);
    this.name = "NotImplementedYet";
  }
}

/** 证据失效时交给推理图谱的事：起因、事实这一层的变化 */
export interface InvalidationEvent extends FactInvalidation {
  /** 证据被忘掉、证据被另一条纠正、抽事实时一条纠正的话把旧事实纠正了 */
  cause: "evidence_forgotten" | "evidence_corrected" | "fact_corrected";
  /** 失效的证据（fact_corrected 时是那条纠正的话） */
  evidenceId: string;
  /** 纠正它的证据（evidence_corrected 时） */
  byEvidenceId: string | null;
  reason: string;
  /** 199 号票：写回知识图谱时，定根源的那组断言自己不跟着待复核（它的前提里就有被改掉的事实） */
  sparedClaimIds?: string[];
}

/**
 * 推理图谱的传播钩子（第 7.3 节第 2–6 条，④ 号票实现；329 号票照原始推理图谱改，ADR-0032）：前提里的事实被用户纠正 → 往上按 R8 撤
 * （有直接证实的留下）；被忘掉、失效的 → 加复核标记、已验证的降回猜测、悬空的撤；
 * 支持、反证被拿掉后重算置信度，一路往下传。在引擎的同一个事务里调用：钩子出错，整个纠正或忘掉都不算。
 */
export interface ReasoningPropagation {
  onInvalidation(event: InvalidationEvent, engine: MemoryEngine): void;
}

export interface MemoryEngineOptions {
  /** SQLite 文件；":memory:" 是内存库（测试用） */
  file: string;
  /** 修订、"现在"用的时钟；演示和测试注入合成数据的 now */
  clock?: () => string;
  /** 默认规则版（199 号票起是 RelationalFactExtractor，rule:4：188 的规则版加实体关系；207 号票修问句和否定，rule:4.1） */
  extractor?: FactExtractor;
  /** 不给就不算向量 */
  embedder?: Embedder;
  /** 不给 = 推理图谱自己（ReasoningGraph）；测试可以换成别的 */
  propagation?: ReasoningPropagation;
  lexicon?: Lexicon;
  /** D 组检索（hybrid_kg_rg）：④ 号票的推理图谱接上；不给时用自带的推理图谱 */
  reasoningRetrieval?: ReasoningRetrieval;
  /** 推理实现，默认规则版（RuleReasoner）；模型版是 LlmReasoner */
  reasoner?: Reasoner;
  /** 226 号票：判到期预测的模型；不给就只记账本、到期预测留 open（reflect 时也可以单独传） */
  predictionJudge?: PredictionJudge;
  /** 227 号票：对抗复核用的模型（独立复核员）；不给就不复核（规则版不调模型） */
  reviewer?: ChatModel;
  /** 回答层和 D 组检索的相关门槛（202 号票）；不给用 DEFAULT_RELEVANCE_GATE（三条路、前 3 名、往上走看检索前 5 条） */
  relevanceGate?: Partial<RelevanceGate>;
  /** 199 号票：知识图谱和推理图谱联动（对比模式、矛盾根源、写回），默认开；false 关掉 */
  joint?: boolean;
  /** 267 号票：唯一写入口的设置——只读（秘书、维护者那一份）、敏感类别里没打开推断的那几类的场景标签 */
  writeGate?: WriteGateOptions;
}

/** 267 号票：纠正、忘掉是谁发起的（默认用户自己；经记忆管理员转达的写 via） */
export interface UserActionOptions {
  actor?: WriteActor;
  via?: string;
}

export interface ExtractionReport {
  /** 这次处理的证据（按发生时间） */
  processed: string[];
  newFactIds: string[];
  /** 并进已有事实的（多了一条证据） */
  mergedFactIds: string[];
  changes: ChangeRecord[];
  probeIds: string[];
  /** 被纠正的话纠正掉的旧事实 */
  correctedFactIds: string[];
}

export interface VectorIndexReport {
  model: string | null;
  /** 这次算了几条证据、几条事实 */
  evidence: number;
  facts: number;
  /** 跳过时的原因 */
  skipped?: string;
}

const VECTOR_BATCH = 16;

export class MemoryEngine {
  readonly store: MemoryStore;
  readonly kg: KnowledgeGraph;
  readonly extractor: FactExtractor;
  /** 推理图谱（④ 号票） */
  readonly rg: ReasoningGraph;
  /** 267 号票：推理图谱的唯一写入口（检查、权限分档、留痕） */
  readonly gate: ReasoningWriteGate;
  /** 227 号票：对抗复核的模型（独立复核员）；没给时整理末尾不复核 */
  readonly reviewer: ChatModel | undefined;
  private readonly embedder: Embedder | undefined;
  private readonly predictionJudge: PredictionJudge | undefined;
  private propagation: ReasoningPropagation | undefined;
  private readonly retriever: Retriever;
  private reasoningRetrieval: ReasoningRetrieval | undefined;

  private constructor(options: MemoryEngineOptions) {
    this.store = MemoryStore.open(options.file, { clock: options.clock });
    this.gate = new ReasoningWriteGate(this, options.writeGate);
    this.store.writer = this.gate;
    this.kg = new KnowledgeGraph(this.store, options.lexicon ?? DEFAULT_LEXICON);
    this.extractor = options.extractor ?? new RelationalFactExtractor(options.lexicon ?? DEFAULT_LEXICON);
    this.reviewer = options.reviewer;
    this.embedder = options.embedder;
    this.predictionJudge = options.predictionJudge;
    this.retriever = new Retriever(this.kg, options.embedder);
    this.reasoningRetrieval = options.reasoningRetrieval;
    this.rg = new ReasoningGraph(this, { reasoner: options.reasoner ?? new RuleReasoner(), lexicon: options.lexicon ?? DEFAULT_LEXICON, joint: options.joint });
    // 201 号票：模型版往上抽要看已有的组（下次整理不重复问模型）
    (this.rg.reasoner as { attachGraph?: (rg: ReasoningGraph) => void }).attachGraph?.(this.rg);
    this.propagation = options.propagation ?? this.rg;
    if (options.relevanceGate) this.rg.relevanceGate = options.relevanceGate;
    // 207 号票：联动分不出的问题默认交给 198 的问题箱
    this.rg.joint?.setQuestionSink(this.questions);
  }

  static open(options: MemoryEngineOptions): MemoryEngine {
    return new MemoryEngine(options);
  }

  close(): void {
    this.store.close();
  }

  /** 接上（或换掉）D 组检索（hybrid_kg_rg，④ 号票） */
  setReasoningRetrieval(retrieval: ReasoningRetrieval | undefined): void {
    this.reasoningRetrieval = retrieval;
  }

  /** 打开引擎时给的向量函数（205 号票：回答层按背景语料校准向量门槛要用）；没给时是 undefined */
  getEmbedder(): Embedder | undefined {
    return this.embedder;
  }

  /** 接上（或换掉）推理图谱的传播钩子 */
  setPropagation(propagation: ReasoningPropagation | undefined): void {
    this.propagation = propagation;
  }

  // ---------- 写入 ----------

  /** 证据入库、建关键词索引（status = active）。同一个 id 再写一次原样返回（经写入口：证据入库） */
  ingestEvidence(draft: EvidenceDraft): Evidence {
    return this.gate.write({ op: "ingest", reason: "证据入库" }, () => this.gate.insertEvidence(draft));
  }

  /** 一个来源的全部证据入库 */
  ingestFrom(source: EvidenceSource): Evidence[] {
    return this.gate.write({ op: "ingest", reason: `证据入库（${source.name}）` }, () => source.read().map((d) => this.ingestEvidence(d)));
  }

  /**
   * 抽事实：给了 evidenceIds 只处理这几条，否则处理所有还没被这个抽取器处理过的有效证据；按发生时间的先后。
   * 每条事实写入时做变化判定（kg/graph.ts）。纠正的话纠正了旧事实时调传播钩子。增量、幂等：处理过的记下来，不再处理。
   */
  extractFacts(options: { evidenceIds?: readonly string[] } = {}): ExtractionReport {
    return this.gate.write({ op: "extract", reason: `抽事实（${this.extractor.id}）` }, () => {
      const report: ExtractionReport = { processed: [], newFactIds: [], mergedFactIds: [], changes: [], probeIds: [], correctedFactIds: [] };
      const wanted = options.evidenceIds ? new Set(options.evidenceIds) : undefined;
      // 263 号票：用户的表态证据（"用户说这条结论对"）不抽事实：不是用户原来的话，抽了会和那条结论自己的依据重复计数
      const queue = this.store.listEvidence({ status: "active" }).filter((e) => (wanted ? wanted.has(e.id) : true) && !isVerdictEvidence(e) && !this.store.isExtracted(e.id, this.extractor.id));
      for (const evidence of queue) {
        const factIds: string[] = [];
        const corrected: string[] = [];
        // 199 号票：先对齐这条证据说出的别名（"老王（组里都喊他王哥）"），这条证据里的两个叫法就落到同一个实体
        if (isAliasAware(this.extractor)) alignAliases(this.kg, this.extractor.aliasesOf(evidence, this.kg.view()), evidence);
        for (const draft of this.extractor.extract(evidence, this.kg.view())) {
          const r = this.kg.addFact(draft, evidence, this.extractor.id);
          factIds.push(r.fact.id);
          (r.merged ? report.mergedFactIds : report.newFactIds).push(r.fact.id);
          report.changes.push(...r.changes);
          report.probeIds.push(...r.probeIds);
          corrected.push(...r.correctedFactIds);
          // 329 号票（R4 传播铁律）：旧事实因为真冲突变成拿不准，以它为前提的已验证在同一次写里降回猜测（前提照挂、保留）
          for (const change of r.changes) if (change.kind === "conflict") this.factUnverified(change.oldFactId, `真冲突：和 ${change.newFactId} 同时间同场景互相排斥（证据 ${evidence.id}）`, evidence.id);
        }
        this.store.markExtracted(evidence.id, this.extractor.id, factIds);
        report.processed.push(evidence.id);
        report.correctedFactIds.push(...corrected);
        if (corrected.length > 0) {
          this.propagate({
            cause: "fact_corrected",
            evidenceId: evidence.id,
            byEvidenceId: null,
            reason: `证据 ${evidence.id} 纠正了 ${corrected.join("、")}`,
            retractedFactIds: corrected,
            weakenedFactIds: [],
            restoredFactIds: [],
          });
        }
      }
      return report;
    });
  }

  /**
   * 抽事实的异步版（192 号票）：模型版的抽取器先按预算 prepare（发请求、校验、缓存），再同步抽准备好的；规则版就是 extractFacts()。
   * reflect 的第 1 步、评测建库都走它（模型版的抽取器不 prepare 不能抽）。预算不给时按 maxModelCalls（默认同 reflect）新开一份。
   */
  async extractPending(options: { budget?: ModelBudget; maxModelCalls?: number; dropped?: DroppedOutput[]; stats?: ReasoningStats } = {}): Promise<ExtractionReport> {
    const extractor = this.extractor;
    if (!isPreparableExtractor(extractor)) return this.extractFacts();
    const todo = this.store.listEvidence({ status: "active" }).filter((e) => !isVerdictEvidence(e) && !this.store.isExtracted(e.id, extractor.id));
    const budget = options.budget ?? createBudget(options.maxModelCalls ?? DEFAULT_MAX_MODEL_CALLS);
    const ready = todo.length === 0 ? [] : await extractor.prepare(todo, this.kg.view(), { budget, dropped: options.dropped ?? [], stats: options.stats?.steps });
    return this.extractFacts({ evidenceIds: ready });
  }

  /** 给还没有向量的证据原文、事实精炼陈述补算向量（文档角色）。没有向量函数或模型不在时跳过 */
  async indexVectors(): Promise<VectorIndexReport> {
    const embedder = this.embedder;
    if (!embedder) return { model: null, evidence: 0, facts: 0, skipped: "没有向量函数（打开引擎时没给 embedder）" };
    if (!embedder.available()) return { model: embedder.model, evidence: 0, facts: 0, skipped: embedder.unavailableHint() };
    const model = embedder.model;
    let evidence = 0;
    let facts = 0;
    const pending = this.store.evidenceMissingVectors(model);
    for (let i = 0; i < pending.length; i += VECTOR_BATCH) {
      const batch = pending.slice(i, i + VECTOR_BATCH);
      const vectors = await embedder.embedDocuments(batch.map((e) => e.text));
      batch.forEach((e, j) => {
        // 算的时候被忘掉、改了原文的不写
        const now = this.store.getEvidence(e.id);
        if (now?.status === "forgotten" || now?.text !== e.text) return;
        this.store.putEvidenceVector(e.id, model, vectors[j]!);
        evidence += 1;
      });
    }
    const pendingFacts = this.store.factsMissingVectors(model);
    for (let i = 0; i < pendingFacts.length; i += VECTOR_BATCH) {
      const batch = pendingFacts.slice(i, i + VECTOR_BATCH);
      const vectors = await embedder.embedDocuments(batch.map((f) => f.statement));
      batch.forEach((f, j) => {
        const now = this.store.getFact(f.id);
        if (now?.status === "retracted" || now?.statement !== f.statement) return;
        this.store.putFactVector(f.id, model, vectors[j]!);
        facts += 1;
      });
    }
    return { model, evidence, facts };
  }

  // ---------- 查询 ----------

  getEvidence(id: string): Evidence | undefined {
    return this.store.getEvidence(id);
  }

  getFact(id: string): Fact | undefined {
    return this.store.getFact(id);
  }

  getEntity(id: string): Entity | undefined {
    return this.store.getEntity(id);
  }

  /** 在时间 at（默认现在）成立、场景对得上的事实 */
  factsAt(query: Omit<FactsAtQuery, "at"> & { at?: string }): Fact[] {
    return this.kg.factsAt({ ...query, at: query.at ?? this.store.now() });
  }

  /** 从一个实体走一跳或两跳（默认用户本人） */
  neighbors(entityId: string = USER_ENTITY_ID, hops: 1 | 2 = 1, options: NeighborOptions = {}): Neighborhood {
    return this.kg.neighbors(entityId, hops, options);
  }

  // ---------- 纠正和忘掉 ----------

  /**
   * 纠正：用户用 by 这条（本人的）证据说 evidenceId 那条不对。旧证据 corrected（原文留着当记录）；
   * 只靠它的事实 corrected，有别的证据的去掉它；然后调推理图谱的传播钩子。已经纠正过的再纠正什么都不做。
   */
  correct(evidenceId: string, by: string, options: UserActionOptions = {}): InvalidationEvent {
    return this.gate.write({ op: "correct", ...options, reason: `纠正：${evidenceId} 被 ${by} 纠正` }, () => {
      const target = this.store.getEvidence(evidenceId);
      if (!target) throw new Error(`没有这条证据：${evidenceId}`);
      if (target.status === "forgotten") throw new Error(`证据 ${evidenceId} 已经被忘掉了，不用再纠正`);
      const corrector = this.store.getEvidence(by);
      if (!corrector) throw new Error(`没有这条证据：${by}`);
      if (by === evidenceId) throw new Error("一条证据不能纠正它自己");
      if (corrector.sourceLevel !== "self") throw new Error(`只有本人的证据能纠正（${by} 的来源是 ${corrector.sourceLevel}）`);
      const reason = `被 ${by} 纠正`;
      if (target.status === "corrected") return this.emptyEvent("evidence_corrected", evidenceId, by, reason);
      this.gate.updateEvidence(evidenceId, { status: "corrected" }, { evidenceId: by, reason });
      const facts = this.kg.dropEvidence(evidenceId, "corrected", by);
      const event: InvalidationEvent = { cause: "evidence_corrected", evidenceId, byEvidenceId: by, reason, ...facts };
      this.propagate(event);
      return event;
    });
  }

  /**
   * 忘掉：证据 forgotten，原文清空，关键词和向量索引删掉；只靠它的事实 retracted，有别的证据的去掉它；
   * 由它派生的状态（它取代、冲突、纠正过的旧事实）恢复；然后调推理图谱的传播钩子。已经忘掉的再忘什么都不做。
   */
  invalidateEvidence(id: string, reason: string, options: UserActionOptions = {}): InvalidationEvent {
    return this.gate.write({ op: "forget", ...options, reason: `忘掉：${reason}` }, () => {
      const target = this.store.getEvidence(id);
      if (!target) throw new Error(`没有这条证据：${id}`);
      if (target.status === "forgotten") return this.emptyEvent("evidence_forgotten", id, null, reason);
      this.gate.updateEvidence(id, { status: "forgotten", text: "" }, { evidenceId: id, reason });
      const facts = this.kg.dropEvidence(id, "forgotten", id);
      const event: InvalidationEvent = { cause: "evidence_forgotten", evidenceId: id, byEvidenceId: null, reason, ...facts };
      this.propagate(event);
      return event;
    });
  }

  /** 329 号票：一条事实变得没验证（拿不准）：以它为前提的已验证降回猜测（R4，rg/status-keeper.ts；要在调用方开的那一次写里调） */
  private factUnverified(factId: string, reason: string, evidenceId: string | null): void {
    if (this.store.getFact(factId)?.status !== "contested") return;
    const at = this.store.now();
    this.rg.keeper.downgradeDependents(factId, at, { evidenceId, reason: `前提 ${factId} 拿不准了（${reason}）` }, this.rg.view(at));
  }

  private emptyEvent(cause: InvalidationEvent["cause"], evidenceId: string, by: string | null, reason: string): InvalidationEvent {
    return { cause, evidenceId, byEvidenceId: by, reason, retractedFactIds: [], weakenedFactIds: [], restoredFactIds: [] };
  }

  private propagate(event: InvalidationEvent): void {
    this.propagation?.onInvalidation(event, this);
  }

  // ---------- 检索（③ 号票）和推理图谱（④ 号票） ----------

  /**
   * 检索（第 6 节）：vector（A）、hybrid（B）、hybrid_kg（C）见 retrieval/search.ts；
   * hybrid_kg_rg（D）由推理图谱做（④）；另接了 ReasoningRetrieval 时交给它，它拿到的 base 是 C 组的检索。
   */
  async search(query: string, options: SearchOptions): Promise<Hit[]> {
    if (options.mode !== "hybrid_kg_rg") return this.retriever.search(query, options);
    const rg = this.reasoningRetrieval;
    if (rg) return rg.search(query, options, (q, o) => this.retriever.search(q, { ...o, mode: "hybrid_kg" }));
    return this.rg.search(query, options);
  }

  /**
   * 整理（做梦阶段，第 3 节）：抽事实 → 生成竞争假设 → 跑追问 → 调状态 → 往上抽需求、价值 → 对抗复核（给了 reviewer 才做）
   * → 预测账本（记下来；给了 predictionJudge 才判到期的）→ 编策略（模型版）；幂等、增量、有预算。用户模型不存，getUserModel 每次现算
   */
  async reflect(options: ReflectOptions = {}): Promise<ReflectReport> {
    const report = await this.rg.reflect({ ...options, predictionJudge: options.predictionJudge ?? this.predictionJudge });
    return this.writeStrategiesAfterReflect(report, options);
  }

  /**
   * 201 号票：推理实现会写策略（模型版）时，整理末尾把还没有模型写的策略的成立的需求、价值交给它写，用这次 reflect 剩下的预算；
   * 预算不够没写成的留到下次（budgetExhausted）。规则版没有 writeStrategies，什么都不做（策略按需按模板编）
   */
  private async writeStrategiesAfterReflect(report: ReflectReport, options: ReflectOptions): Promise<ReflectReport> {
    const reasoner = this.rg.reasoner;
    if (!reasoner.writeStrategies) return report;
    const onStep = options.onStep ?? (() => {});
    onStep({ step: "strategies", phase: "start" });
    const budget = createBudget(Math.max(0, (options.maxModelCalls ?? DEFAULT_MAX_MODEL_CALLS) - report.modelCalls));
    const written = await this.strategies.writeWithModel({ id: reasoner.id, writeStrategies: reasoner.writeStrategies.bind(reasoner) }, { budget, dropped: report.dropped, stats: report.stats });
    report.modelCalls += budget.used;
    // 270 号票：编策略那一道花了几次
    if (report.spend) report.spend.strategies += budget.used;
    if (written.leftover) report.budgetExhausted = true;
    report.strategies = { created: written.created, updated: written.updated };
    onStep({ step: "strategies", phase: "end", detail: `新写 ${written.created.length} 条、改 ${written.updated.length} 条` });
    return report;
  }

  /** 结论、推法、前提链、支持证据和反证（带原文）、竞争假设、追问和结果、修订历史 */
  explainClaim(claimId: string): ClaimExplanation {
    return this.rg.explainClaim(claimId);
  }

  /** 给这条假设生成或复用追问，跑第二轮检索，写关联 */
  async findCounterevidence(claimId: string): Promise<Hit[]> {
    return this.rg.findCounterevidence(claimId);
  }

  /** 一直追到证据 */
  tracePremises(claimId: string): PremiseTrace {
    return this.rg.tracePremises(claimId);
  }

  /** 用户确认了一条断言（by 是本人的证据）：标 user_confirmed，记决定性支持，重定它那组的状态（195 号票） */
  confirmClaim(claimId: string, byEvidenceId: string): Claim {
    return this.rg.confirmClaim(claimId, byEvidenceId);
  }

  /** 263 号票：用户说这条断言不对（by 是本人的证据）：记决定性的反证，重定它那组（没有决定性的支持就撤回）；明说的不改 */
  rejectClaim(claimId: string, byEvidenceId: string): Claim {
    return this.rg.rejectClaim(claimId, byEvidenceId);
  }

  /** 263 号票：把一条断言标成待复核，下一次整理按现有的关联重判；它成立时往下的依赖也待复核 */
  markClaimForReview(claimId: string, reason: string, byEvidenceId: string | null = null): Claim {
    return this.rg.markClaimForReview(claimId, { evidenceId: byEvidenceId, reason });
  }

  /**
   * 263 号票：用户对一条结论直接表态（对 / 不对 / 拿不准）：记一条本人的表态证据（不抽事实），收回他先前相反的表态，
   * 再走 confirmClaim / rejectClaim / markClaimForReview——整理计分认这些，不会把它改回去。被拒时抛 ClaimVerdictRefused（rg/verdicts.ts）
   */
  recordClaimVerdict(claimId: string, verdict: ClaimVerdict, options: ClaimVerdictOptions = {}): ClaimVerdictResult {
    return recordClaimVerdict(this, claimId, verdict, options);
  }

  /** 用户模型快照（第 4.4 节） */
  getUserModel(query: UserModelQuery = {}): UserModel {
    return this.rg.getUserModel(query);
  }

  /** 带证据的回答：简单问题走检索，"为什么"、偏好类走推理图谱；每个论断后面带证据 id，证据不足时明说不确定 */
  async answer(question: string, options: AnswerOptions = {}): Promise<Answer> {
    return this.rg.answer(question, options);
  }

  // ---------- 知识图谱和推理图谱联动（199 号票） ----------

  /** 联动的结果：找出的隐蔽联系（对比模式）、矛盾和它们的根源、写回了什么、问题队列（评测、演示看的；只读） */
  jointSummary(at?: string): JointSummary {
    const joint = this.rg.joint;
    if (!joint) return { at: at ?? this.store.now(), motifs: [], conflicts: [], questions: [] };
    return joint.summary(at);
  }

  /** "了解你问题"队列里联动出的问题（查不清的矛盾根源、分不出的对比模式）；默认只要还开着的 */
  knowYouQuestions(options: { all?: boolean } = {}): KnowYouQuestion[] {
    return this.rg.joint?.questions(options) ?? [];
  }

  /** 换掉联动交问题的钩子（默认是问题箱 questions，207 号票）；新进的问题在整理时交给它，传 undefined 就只在 joint_questions 记账 */
  setQuestionSink(sink: QuestionSink | undefined): void {
    this.rg.joint?.setQuestionSink(sink);
  }

  /** 一条事实上的标记：说的和做的不一样标的 gap、关联到的需求断言（写回加的） */
  factMarks(factId: string): FactMark[] {
    return this.rg.writeback.marks.of(factId);
  }

  // ---------- 为任务调出相关的用户模型、交互策略（196 号票） ----------

  private claimIndexCache: ClaimIndex | undefined;
  private strategyBookCache: StrategyBook | undefined;

  /** 结论的索引：断言陈述的关键词、向量，适用领域 */
  get claimIndex(): ClaimIndex {
    return (this.claimIndexCache ??= new ClaimIndex(this.store));
  }

  /** 交互策略的编译、同步、确认 */
  get strategies(): StrategyBook {
    return (this.strategyBookCache ??= new StrategyBook(this.rg, this.claimIndex));
  }

  /** 同步结论的索引（关键词、领域），补算断言陈述的向量；relevantUserModel 自己也会做，这里给想先建好的调用方 */
  async indexClaims(): Promise<ClaimIndexReport & { vectors: ClaimVectorReport }> {
    const report = this.claimIndex.sync();
    return { ...report, vectors: await this.claimIndex.indexVectors(this.embedder) };
  }

  /** 为任务调出相关的用户模型：往上走、结论索引、领域三条路 RRF 合并，每层最相关的 k 条（默认 2），带来路 */
  async relevantUserModel(task: string, options: RelevantUserModelOptions = {}): Promise<RelevantUserModel> {
    return relevantUserModel(this.rg, this.claimIndex, this.embedder, task, options);
  }

  /** 把成立的需求、价值编译成交互策略（新的 proposed），已有的跟着依据走 */
  compileStrategies(): CompileReport {
    return this.strategies.compile();
  }

  /** 交互策略（先跟着依据同步）；默认不含撤回的 */
  listStrategies(filter: { status?: StrategyStatus | readonly StrategyStatus[] } = {}): Strategy[] {
    return this.strategies.list(filter);
  }

  /** 用户确认一条交互策略（by 是本人有效的证据）：proposed → active，进用户模型快照 */
  confirmStrategy(strategyId: string, byEvidenceId: string): Strategy {
    return this.strategies.confirm(strategyId, byEvidenceId);
  }

  /** 给任务出建议：明说的要求 > 硬约束 > 明确的偏好 > 相关的需求和价值观 > 能用的策略；拿不准时附一个能区分的追问 */
  async adviseTask(task: string, options: AdviseOptions = {}): Promise<TaskAdvice> {
    return adviseTask({ rg: this.rg, index: this.claimIndex, strategies: this.strategies, relevant: (t, o) => this.relevantUserModel(t, o) }, task, options);
  }

  // ---------- 给大模型回答器的记忆简报（216 号票） ----------

  /** 记忆简报：A、B、C 是这组检索出的记录（原话、时间、谁说的、精炼陈述），D 是 C 的记录加和问题相关的用户画像；有长度上限 */
  memoryBrief(question: string, options: MemoryBriefOptions): Promise<MemoryBrief> {
    return buildMemoryBrief(this, question, options);
  }

  /**
   * 每条消息的记忆简报（266 号票）：只用本机检索和相关门槛判有没有相关的，有才带过了门槛的结论连原话（D 组那几节、BRIEF_LIMITS）；
   * known 里带过、没变的不再带。不调模型
   */
  messageBrief(text: string, options: MessageBriefOptions = {}): Promise<MessageBrief> {
    return buildMessageBrief(this, text, options);
  }

  // ---------- 每日整理和了解你问题（198 号票） ----------

  private questionBookCache: QuestionBook | undefined;

  /** 了解你问题的问题箱 */
  get questions(): QuestionBook {
    return (this.questionBookCache ??= new QuestionBook(this));
  }

  /** 每日整理：03:00（可配置），用户在用就往后推 30 分钟、最晚 05:00；跑了就 reflect、判回答、编策略、出了解你问题，返回整理报告 */
  runNightly(options: NightlyOptions = {}): Promise<NightlyResult> {
    return runNightly(this, options);
  }

  /** 这一轮要不要在回话末尾顺口问一个了解你问题、问哪个；不问时写明为什么（急事、在等决定、今天问过了、话题对不上、问题箱空） */
  pickQuestion(conversationText: string, options: PickOptions = {}): PickResult {
    return this.questions.pick(conversationText, options);
  }

  /** 秘书真的在回话里顺口问了这个问题（264 号票：线上先 pickQuestion 的 peek 挑、带上了才记）：记"问过" */
  markQuestionAsked(questionId: string, options: { at?: string; how?: string } & QuestionWriteBy = {}): QuestionView {
    return this.questions.markAsked(questionId, options);
  }

  /** 用户在顺口问以后的下一句：是在答这个问题、跳过、说"别问这个"，还是在说别的（264 号票，规则版，不调模型） */
  readQuestionReply(questionId: string, reply: string): ReplyReading {
    return this.questions.readReply(questionId, reply);
  }

  /** 用户回答了一个了解你问题：回答记成本人证据；明确的马上标"你确认过"或撤回，不明确的下一夜按问题里写的判法判 */
  recordQuestionAnswer(questionId: string, evidence: EvidenceDraft | string, options: { at?: string; reading?: AnswerReading; note?: string } & QuestionWriteBy = {}): AnswerRecord {
    return this.questions.recordAnswer(questionId, evidence, options);
  }

  /** 用户没接顺口问的问题：跳过一次；同一个问题跳过两次就不再问，记一条回避信号 */
  recordQuestionSkipped(questionId: string, options: { at?: string } & QuestionWriteBy = {}): SkipRecord {
    return this.questions.recordSkip(questionId, options);
  }

  /** 用户说"别问这个"：这一类都不再问（可以带上用户的原话） */
  declineQuestion(questionId: string, options: { at?: string; evidence?: EvidenceDraft | string } & QuestionWriteBy = {}): Question {
    return this.questions.decline(questionId, options);
  }

  /** 问题箱和问过的问题（为什么问、为了弄清哪个假设、经过），按优先级 */
  listQuestions(filter: { status?: QuestionStatus | readonly QuestionStatus[] } = {}): QuestionView[] {
    return this.questions.list(filter);
  }
}
