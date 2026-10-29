// 推理图谱（第 4.3、7 节，④ 号票）：引擎的 reflect、explainClaim、findCounterevidence、tracePremises、getUserModel、answer、
// search(hybrid_kg_rg) 都落在这里；它也是引擎默认的传播钩子（第 7.3 节第 2–6 条）。
//
// reflect()（做梦阶段的一次整理，幂等、增量，有预算）：
//   1. 抽事实（模型版的抽取器先 prepare，按预算发请求）；
//   2. 没有新证据、也没有待复核的断言 → 什么都不做；
//   3. 用户明说的偏好、状态 → 明说的断言（explicit，状态跟着事实走：被取代、被纠正、冲突）；
//   4. 推理实现在能当依据的本人事实里认观察模式，出竞争假设（至少两条，互相登记 competesWith），推断记"结论 ← 观察"；
//      观察不够两条的组撤下（Q2：组里的结论没有推翻者，不撤，留成猜测、把握降一档）；
//   5. 每组出判别性追问（第一次见到这组时），跑第二轮检索（最多两轮，没有新证据就停），judge 判找到了什么，写关联；
//      事实这一层真冲突的追问也在这里判；
//   6. 按关联定状态和置信度（scoring.ts）；
//   7. 记下整理过的证据。
//   270 号票：模型版（exhaustive: false）的预算按道花（rg/nightly-lanes.ts）：新证据那几步排第一、用前段；第 5 步的追问先问没问过的、
//   检索结果里有新证据的，剩下的预算才重跑待复核、到期复评那几组的旧追问，别的旧追问不重判；预算用完没问到的追问不写结果。
//   第 7 步整理完一条记一条（抽事实、出假设、出追问没被挡住，欠它的追问都问过了），不再是"这一次被挡过就一条都不记"。
//   规则版（exhaustive: true）每次全部重来，照旧。
//   271 号票：判顺口问的回答那一道（ReflectOptions.replies）排在新证据之后、重跑旧追问之前：保底的那份从前段里划出来（新证据那几步、
//   抽事实都让出它），新证据那一道问完追问就跑，给它的至少还有保底那么多、新证据没用完的前段也给它，剩下的才轮到重跑旧追问。
//   227 号票：末尾再走一步对抗复核（rg/adversarial.ts）：新出的 need/value 结论交给不告诉结论的复核员，
//   只从支持证据原话重推、再判支不支持；判 no 的加复核标记。有单独的 5 次调用预算，没给复核模型（规则版）就不做。
// 329 号票（ADR-0032）：结论的状态照原始推理图谱——已验证 / 猜测 / 撤回（被取代照旧），"待复核"是单独的复核标记；
//   猜测都能往上推（往上抽、联动），推出来的也是猜测；传播铁律、直接证实、推翻往上传、复活在 rg/status-keeper.ts（StatusKeeper）。
// 写入一律经唯一写入口（267 号票，rg/write-gate.ts：写之前检查、写完留痕，存储照旧记修订日志）；整理中途的检索是异步的，
// 所以每一步各自开一次写（记成夜班），组、结论这一层再各开一次：被写入口拒了的那一组记进 dropped（stage gate）交回调用方，别的照常写。
import { USER_ENTITY_ID } from "../domain/ids.ts";
import { addDays, toMs, validAt } from "../domain/time.ts";
import type { Claim, Evidence, Fact, Probe, RevisionCause, WriteActor, WriteIntent, WriteOp } from "../domain/types.ts";
import type { InvalidationEvent, MemoryEngine, ReasoningPropagation } from "../engine.ts";
import { canSupportUserClaims, isVerdictEvidence } from "../evidence/boundary.ts";
import { sameObject } from "../kg/change.ts";
import { isPreparableExtractor } from "../kg/llm-extractor.ts";
import { DEFAULT_LEXICON, type Lexicon } from "../kg/lexicon.ts";
import { factPhrase } from "../kg/statement.ts";
import type { Hit, SearchOptions } from "../retrieval/types.ts";
import { HELD_STATUSES, type MemoryStore, type RgWriter } from "../store/store.ts";
import { type ReasoningWriteGate, ReasoningWriteRefused } from "./write-gate.ts";
import { userModelSnapshot } from "../user-model/snapshot.ts";
import { answerQuestion } from "./answer.ts";
import { adversarialReview } from "./adversarial.ts";
import { contextPhrase, isArrangement, isRest, isStateTopic, RECENT_MARKERS } from "./concepts.ts";
import { explainClaim, tracePremises } from "./explain.ts";
import { fallbackSearch } from "./fallback-search.ts";
import { isJointGroup, isRootGroup, JointReasoner, ROOT_PATTERN, type KgPhase } from "./joint.ts";
import { RgRegistry, type GroupRecord } from "./registry.ts";
import { KgWriteback } from "./writeback.ts";
import { searchWithReasoning } from "./rg-search.ts";
import type { AdviseOptions, TaskAdvice } from "./advice.ts";
import type { RelevanceGate } from "./relevance.ts";
import type { Embedder } from "../embedding/embedder.ts";
import type { RelevantUserModel, RelevantUserModelOptions } from "./value-retrieval.ts";
import { emptyReasoningStats } from "./build-stats.ts";
import { runPredictions } from "./predictions.ts";
import { PredictionBackprop } from "./falsify.ts";
import { confidenceOf, type Counterexample, decideGroup, evidenceBehind, tally } from "./scoring.ts";
import { ironLawReason, storeLookup, unverifiedPremises } from "./graph-rules.ts";
import { isDirectInference, StatusKeeper, USER_CONFIRMATION, USER_DENIAL } from "./status-keeper.ts";
import { RELAYED_BASIS, relayedEligible, relayedGuessOf, selfCounterparts } from "./relayed.ts";
import { narrowClaim, separatingTags, tagsLabel } from "./contradictions.ts";
import { contextsCompatible } from "../kg/context.ts";
import {
  emptySpend,
  isReviewDue,
  newEvidenceQueue,
  owedProbes,
  rejudgeOrder,
  settledEvidence,
  spendMeter,
  type ProbeSlot,
  type ReflectLane,
  type RejudgeGroup,
} from "./nightly-lanes.ts";
import type {
  AdversarialReviewReport,
  Answer,
  AskLedger,
  AskStep,
  AnswerOptions,
  ClaimExplanation,
  DroppedOutput,
  GroupView,
  HypothesisGroupDraft,
  JudgeHit,
  LiftInput,
  LiftLevel,
  LinkDraft,
  ModelBudget,
  PremiseTrace,
  ProbeDraft,
  Reasoner,
  ReasonerContext,
  ReflectOptions,
  ReflectReport,
  ReasoningStats,
  ReflectStepEvent,
  RgView,
  UserModel,
  UserModelQuery,
} from "./types.ts";

/** 一次 reflect 默认最多调几次模型 */
export const DEFAULT_MAX_MODEL_CALLS = 40;
/**
 * 218 号票：一次 reflect 的预算留多少给往上抽和编策略（第 7、9 步）：出假设、追问、判证据（第 3–6b 步）最多用到 1 − 这一份。
 * 第一次真跑 218 时出假设分批、组多了，追问和判证据把 200 次用光，往上抽、编策略一次都没问成
 */
export const LIFT_BUDGET_SHARE = 0.25;
/**
 * 334 号票（用户 2026-10-27 选 B，ADR-0032"每晚的预算"）：后 1/4 里先给编交互策略留几次（推理实现会写策略时；不超过后 1/4）。
 * 抽事实、判回答、往上抽、判预测都用不到这几次，编策略（引擎在 reflect 末尾）至少有这么多。R4 让猜测也能往上推以后，
 * 往上抽的组多了、判它们的证据把 200 次用光，p2、p4 的评测库和线上的库交互策略一条都没编出来过。
 * 一次最多写 12 个依据（STRATEGY_BATCH_BASES），4 次是 48 个；没用上的不挪给别的步骤（宁可少抽一点也要每晚编得到）
 */
export const STRATEGY_RESERVE_CALLS = 4;
/** 追问每个查询取几条 */
export const PROBE_HITS_PER_QUERY = 8;
/** 近期状态不写到期时默认几天（同 domain/validate.ts） */
const STATE_DAYS = 14;
// 用户确认、用户否认的说法开头（USER_CONFIRMATION、USER_DENIAL）329 号票挪到 rg/status-keeper.ts（包入口照旧导出）

/**
 * 218 号票：同一份预算的前一段——最多用到 cap（共用计数）；被 cap 挡过一次 capped 就是 true（这一段没做完）
 */
export function capBudget(inner: ModelBudget, cap: number): ModelBudget & { readonly capped: boolean } {
  let capped = false;
  return {
    get limit() {
      return Math.min(inner.limit, cap);
    },
    get used() {
      return inner.used;
    },
    get exhausted() {
      return inner.used >= Math.min(inner.limit, cap);
    },
    get capped() {
      return capped;
    },
    take() {
      if (inner.used >= cap) {
        capped = true;
        return false;
      }
      return inner.take();
    },
  };
}

export function createBudget(limit: number): ModelBudget {
  let used = 0;
  return {
    limit,
    get used() {
      return used;
    },
    get exhausted() {
      return used >= limit;
    },
    take() {
      if (used >= limit) return false;
      used += 1;
      return true;
    },
  };
}

/** 往上抽出来的组（需求层、价值层） */
export const isLift = (g: Pick<GroupRecord, "pattern">): boolean => g.pattern.startsWith("lift:");

/** 参加推断的出处：本人说的、做的 */
const SELF_ASSERTIONS = new Set(["user_stated", "observed"]);

export interface ReasoningGraphOptions {
  reasoner: Reasoner;
  lexicon?: Lexicon;
  /** 199 号票：知识图谱和推理图谱联动（对比模式、矛盾根源、写回），默认开；false 关掉（消融用） */
  joint?: boolean;
}

/** 333 号票：按新规矩重定前后比的那几样（状态、把握、墓碑、取代者） */
const settleSignature = (c: Claim): string => `${c.status}|${c.confidence}|${c.retractedBy ?? ""}|${c.supersededBy ?? ""}`;

/** 原有的观察模式那几步管的组（不含往上抽的、联动的） */
const generic = (g: Pick<GroupRecord, "pattern">): boolean => !isLift(g) && !isJointGroup(g);

/** 270 号票：一次整理里按道跑追问要记的账（模型版才有） */
interface LaneNight {
  /** 这次要整理的新证据 */
  pendingSet: ReadonlySet<string>;
  /** 新证据 id → 先后 */
  order: ReadonlyMap<string, number>;
  /** 每条新证据欠哪几条追问（观察模式那几组的；往上抽的组不算） */
  owed: Map<string, Set<string>>;
  /** 这次问过的追问 */
  asked: Set<string>;
  /** 被预算挡住、这次不算整理过的新证据（抽事实、出假设、出追问没做完） */
  blocked: Set<string>;
  /** 跑之前待复核的结论 */
  reviewBefore: ReadonlySet<string>;
  /** 哪一道被预算挡住、没做完 */
  cut: boolean;
}

/** 270 号票：一次按道跑追问的结果 */
interface LaneRun {
  rounds: number;
  /** 追问这次全问过一遍的组（到期复评的结论记下复核时间） */
  reviewed: Set<string>;
}

type Meter = <T>(lane: ReflectLane, fn: () => Promise<T>) => Promise<T>;

/** 272 号票：一次整理里的问过的账（推理实现看 signature、交回 settle；这一步做完由 reflect commit） */
interface NightAskLedger extends AskLedger {
  /** 这一步这次问到了的记下（grouped 的是进了组的，不记） */
  commit(step: AskStep, grouped: (subject: string) => boolean): void;
}

export class ReasoningGraph implements ReasoningPropagation {
  readonly registry: RgRegistry;
  readonly reasoner: Reasoner;
  /** 199 号票：知识图谱和推理图谱联动（rg/joint.ts）；关掉时是 undefined */
  readonly joint: JointReasoner | undefined;
  /** 199 号票：结论写回知识图谱（rg/writeback.ts） */
  readonly writeback: KgWriteback;
  /** 329 号票：真值维护（传播铁律、直接证实、推翻往上传、复活；rg/status-keeper.ts） */
  readonly keeper: StatusKeeper;
  /** 330 号票（R10）：预测落空往回打来源（rg/falsify.ts） */
  readonly backprop: PredictionBackprop;
  private readonly engine: MemoryEngine;
  private readonly lexicon: Lexicon;
  /** 回答层和 D 组检索的相关门槛（202 号票，rg/relevance.ts）；不给用 DEFAULT_RELEVANCE_GATE */
  relevanceGate: Partial<RelevanceGate> | undefined;

  constructor(engine: MemoryEngine, options: ReasoningGraphOptions) {
    this.engine = engine;
    this.reasoner = options.reasoner;
    this.lexicon = options.lexicon ?? DEFAULT_LEXICON;
    this.registry = new RgRegistry(engine.store);
    this.joint = options.joint === false ? undefined : new JointReasoner(engine, this);
    this.writeback = new KgWriteback(engine, this);
    this.keeper = new StatusKeeper(engine);
    this.backprop = new PredictionBackprop(this);
  }

  get store(): MemoryStore {
    return this.engine.store;
  }

  /** 267 号票：唯一写入口（查留痕用；写在 write / attempt 里） */
  get gate(): ReasoningWriteGate {
    return this.engine.gate;
  }

  /** 267 号票：写推理图谱经唯一写入口（要在 write / attempt 开的那一次写里） */
  private get w(): RgWriter {
    return this.engine.gate;
  }

  /**
   * 267 号票：开一次写；被写入口拒了时，给了 dropped 就把原因记进去（stage gate，交回给调用方）、返回 undefined，
   * 没给就照抛（用户的表态这类，原因交回给管理员）
   */
  private attempt<T>(intent: WriteIntent, dropped: DroppedOutput[] | undefined, fn: () => T): T | undefined {
    try {
      return this.engine.gate.write(intent, fn);
    } catch (err) {
      if (dropped !== undefined && err instanceof ReasoningWriteRefused) {
        dropped.push({ stage: "gate", reason: err.message, item: err.problems });
        return undefined;
      }
      throw err;
    }
  }

  /** 整理里的一步：记成夜班 */
  private night<T>(op: WriteOp, reason: string, dropped: DroppedOutput[], fn: () => T): T | undefined {
    return this.attempt({ op, actor: "nightly", reason }, dropped, fn);
  }

  /** 推理实现看的只读视图（按 at 算"成立的"） */
  view(at: string = this.store.now()): RgView {
    const store = this.store;
    const usableEvidence = (id: string) => {
      const e = store.getEvidence(id);
      return e !== undefined && canSupportUserClaims(e);
    };
    return {
      at,
      fact: (id) => store.getFact(id),
      evidence: (id) => store.getEvidence(id),
      entity: (id) => store.getEntity(id),
      entityName: (id) => store.getEntity(id)?.name ?? id,
      factsOfEvidence: (id) => store.factsByEvidence(id).filter((f) => (HELD_STATUSES as readonly string[]).includes(f.status) && validAt(f, at)),
      usableEvidence,
      usableFact: (f) => SELF_ASSERTIONS.has(f.assertion) && f.evidenceIds.some(usableEvidence),
      isCorrection: (id) => store.getEvidence(id)?.kind === "correction" || store.listFacts({ status: ["corrected"] }).some((f) => f.retractedBy === id),
    };
  }

  // ---------- 检索 ----------

  /** 追问和回答用的底层检索：③ 号票的 search(hybrid_kg)；还没做时用 188 的关键词和邻接顶上 */
  async baseSearch(query: string, options: Omit<SearchOptions, "mode">): Promise<Hit[]> {
    try {
      return await this.engine.search(query, { ...options, mode: "hybrid_kg" });
    } catch (err) {
      if (err instanceof Error && err.name === "NotImplementedYet") return fallbackSearch(this.store, query, options, this.lexicon);
      throw err;
    }
  }

  /** search(hybrid_kg_rg)：第 6 节 D 组 */
  search(query: string, options: SearchOptions): Promise<Hit[]> {
    return searchWithReasoning(this, query, options);
  }

  // ---------- reflect ----------

  async reflect(options: ReflectOptions = {}): Promise<ReflectReport> {
    const at = this.store.now();
    const budget = createBudget(options.maxModelCalls ?? DEFAULT_MAX_MODEL_CALLS);
    const maxRounds = Math.max(1, Math.min(2, options.maxRounds ?? 2));
    const dropped: DroppedOutput[] = [];
    // 237 号票：每一步的进度（建库 CLI 打出来，卡住时看最后一行停在哪一步）
    const onStep = options.onStep ?? (() => {});
    // 218：每一步的模型调用、往上抽门槛的结果
    const stats = emptyReasoningStats();
    // 270：按道记账（新证据、重跑旧追问、往上抽、判预测；编策略由引擎在后面记）
    const spend = emptySpend(budget.limit);
    const meter: Meter = spendMeter(budget, spend);
    const report: ReflectReport = { processedEvidenceIds: [], newClaimIds: [], changedClaimIds: [], probeIds: [], modelCalls: 0, rounds: 0, budgetExhausted: false, dropped, stats, spend, backlog: 0 };
    // 218：出假设、追问、判证据用前一段，留 LIFT_BUDGET_SHARE 给往上抽、编策略；前一段被挡过也算预算用完（这次的证据下次接着做）
    const frontCap = budget.limit - Math.floor(budget.limit * LIFT_BUDGET_SHARE);
    // 334：后一段里给编策略留 STRATEGY_RESERVE_CALLS 次——reflect 里的步骤（抽事实、判回答、往上抽、判预测）最多用到 usable，
    // 剩下的归引擎在 reflect 末尾编策略（engine.writeStrategiesAfterReflect 用"总数 − 这次用掉的"）
    const strategyReserve = this.reasoner.writeStrategies ? Math.min(STRATEGY_RESERVE_CALLS, budget.limit - frontCap) : 0;
    const usable = capBudget(budget, budget.limit - strategyReserve);
    // 271：判回答那一道的保底从前段里划出来——新证据那几步最多用到前段减掉它（抽事实本来用整份，也让出这一份）
    const reserve = Math.max(0, Math.min(options.replies?.reserve ?? 0, frontCap));
    const early = capBudget(budget, frontCap - reserve);
    /** 判回答跑完以后的前段（重跑旧追问、新证据剩下的几步用；保底没用完的还回来） */
    const front = capBudget(budget, frontCap);
    let repliesRan = false;
    let repliesCut = false;
    // 271：判回答那一道（只跑一次）：给的预算至少还有 reserve 次，新证据没用完的前段也给它，不超过整份
    const runReplies = async () => {
      const lane = options.replies;
      if (lane === undefined || repliesRan) return;
      repliesRan = true;
      const cap = capBudget(budget, Math.min(usable.limit, Math.max(frontCap, budget.used + reserve)));
      onStep({ step: "replies", phase: "start", detail: `保底 ${reserve} 次` });
      await meter("replies", () => lane.run(cap));
      if (cap.capped) repliesCut = true;
      onStep({ step: "replies", phase: "end", detail: `判回答用了 ${spend.replies} 次模型调用` });
    };
    // 333 号票：全量重判一次（full-rejudge.ts）只按新规矩重判已有的结论——不碰新证据（不抽事实、不出假设、不记整理过），没有新证据也照跑
    const full = options.full === true;
    const pending = full ? [] : this.pendingEvidence(options.since);
    // 270：模型版（明确写了 exhaustive: false）按道花预算、整理完一条记一条；规则版每次全部重来，照旧
    const night: LaneNight | undefined =
      this.reasoner.exhaustive === false
        ? {
            pendingSet: new Set(pending.map((e) => e.id)),
            order: new Map(pending.map((e, i) => [e.id, i])),
            owed: new Map(),
            asked: new Set(),
            blocked: new Set(),
            reviewBefore: new Set(this.store.listClaims({ needsReview: true }).map((c) => c.id)),
            cut: false,
          }
        : undefined;
    // 271：判回答跑完以后前段换成 front（重跑旧追问、新证据剩下的几步用），被它挡住和以前被 early 挡住一样算
    // 334：留给编策略的那几次不算"预算用完"——只有真被 usable 挡过（有步骤还想问）才算
    const exhausted = () => budget.exhausted || usable.capped || early.capped || front.capped || night?.cut === true;
    // 272：模型版问过、没变化就不再问的账（出假设的观察、往上抽的下层断言）；规则版每次全部重来，不用
    const ledger = night ? this.askLedger() : undefined;
    // 226 号票：预测账本的两步（记下来、到期判）在整理末尾跑，所以评测建库也跑得到；
    // 跳过（没有新证据）的时候也要判到期的预测，所以收尾统一走 finish
    const finish = async (): Promise<ReflectReport> => {
      onStep({ step: "prediction", phase: "start" });
      // 330 号票（R10）：还没找到错处的演绎落空先再看一遍（用户答了问题、嫌疑只剩一条的，这一夜定下来）
      this.backprop.reassess(at);
      report.predictions = await meter("predictions", () =>
        runPredictions(this.store, {
          at,
          claimIds: [...new Set([...report.newClaimIds, ...report.changedClaimIds])],
          judge: options.predictionJudge,
          budget: usable,
          dueLimit: options.predictionDueLimit,
          onMiss: (p) => this.backprop.missed(p, at),
        }),
      );
      onStep({ step: "prediction", phase: "end", detail: `新记 ${report.predictions.created} 条、到期判 ${report.predictions.judged} 条` });
      report.modelCalls = budget.used;
      // 271：判回答那一道没判完（留到下一夜）也算预算用完；它不影响新证据算不算整理过
      report.budgetExhausted = exhausted() || repliesCut;
      return report;
    };

    onStep({ step: "extract", phase: "start", detail: full ? "全量重判一次：不碰新证据" : `${pending.length} 条证据待整理` });
    const extractBudget = reserve > 0 ? capBudget(usable, usable.limit - reserve) : usable;
    if (!full) await meter("newEvidence", () => this.extract(extractBudget, dropped, stats));
    onStep({ step: "extract", phase: "end", detail: full ? "跳过（全量重判一次）" : `抽事实用了 ${stats.steps.extract?.calls ?? 0} 次模型调用` });
    // 270：抽事实被预算挡住（抽取器按时间先后抽，预算用完就停）：还没抽的这一夜不算整理过
    if (night && extractBudget.exhausted) {
      for (const e of pending) {
        if (!this.extracted(e)) {
          night.blocked.add(e.id);
          night.cut = true;
        }
      }
    }
    const needsReview = this.store.listClaims({ needsReview: true });
    if (!full && pending.length === 0 && needsReview.length === 0) {
      report.skipped = "没有新证据，也没有标着复核的断言";
      // 271：没有新证据的夜里判回答照样跑
      await runReplies();
      return finish();
    }
    const before = new Map(this.store.listClaims().map((c) => [c.id, JSON.stringify(c)]));
    // 199：知识图谱这一步的最后——找对比模式、认矛盾（rg/joint.ts）
    onStep({ step: "joint", phase: "start", detail: "找对比模式、认矛盾" });
    const phase = this.joint?.kgPhase(at, this.view(at));
    this.night("explicit", "明说的结论跟着事实走", dropped, () => this.syncExplicit(at, report));
    this.syncRelayed(at, report);
    onStep({ step: "joint", phase: "end" });

    const existingGroups = this.registry
      .listGroups({ live: true })
      .filter(generic)
      .map((g) => this.groupView(g.key))
      .filter((g): g is GroupView => g !== undefined);
    const ctx: ReasonerContext = { view: this.view(at), budget: early, dropped, existingGroups, stats, ...(ledger ? { asked: ledger } : {}) };

    onStep({ step: "propose", phase: "start", detail: full ? "全量重判一次：不出新假设，已有的组照旧" : `${existingGroups.length} 个已有的组` });
    // 333 号票：全量重判一次不出新假设（出假设管的是新观察；也不能拿"这次没再出来"去撤已有的组）
    const proposedGroups = full ? 0 : await this.proposeNew(at, ctx, report, meter, night, ledger);
    onStep({ step: "propose", phase: "end", detail: full ? "跳过（全量重判一次）" : `${proposedGroups} 组` });

    onStep({ step: "probes", phase: "start" });
    const unprobed = await meter("newEvidence", () => this.ensureProbes(generic, ctx));
    // 270：新组的追问因为预算没出成：这组观察背后的新证据这一夜不算整理过
    if (night) for (const key of unprobed) this.blockGroup(night, key);
    onStep({ step: "probes", phase: "end", detail: `${this.store.listProbes().length} 条追问` });
    onStep({ step: "judge", phase: "start" });
    let reviewed: ReadonlySet<string> = new Set();
    if (night) {
      // 270：新证据那一道先（没问过的、检索结果里有新证据的），剩下的才重跑待复核、到期复评那几组的旧追问
      // 271：两道中间跑判回答（排在新证据之后、重跑旧追问之前），重跑旧追问用判回答剩下的前段
      const run = await this.judgeByLane(generic, night, maxRounds, ctx, report, meter, { first: "newEvidence", rest: "rejudge", owes: true, between: runReplies, restBudget: front });
      report.rounds = run.rounds;
      reviewed = run.reviewed;
    } else {
      report.rounds = await meter("newEvidence", () => this.runProbes(maxRounds, ctx, report, generic));
      await runReplies();
    }
    // 271：判回答跑过了，保底那份没用完的还给新证据剩下的几步（事实冲突的追问、联动）
    ctx.budget = front;
    await meter("newEvidence", () => this.runFactProbes(ctx, report));
    this.night("decide", "按证据定状态", dropped, () => this.decideAll(at, ctx.view, generic, dropped));
    this.markReviewed(reviewed, at, dropped);
    onStep({ step: "judge", phase: "end", detail: `${report.probeIds.length} 条追问判过` });

    // 199：对比模式、矛盾根源各出一组竞争假设 → 追问 → 计分（和原有的观察模式一起，在往上抽之前）
    if (this.joint && phase) {
      onStep({ step: "joint", phase: "start", detail: "矛盾根源出组、追问" });
      await meter("newEvidence", () => this.reasonJoint(phase, at, maxRounds, ctx, report));
      onStep({ step: "joint", phase: "end" });
    }

    // 往上抽：偏好、状态 → 需求 → 长期价值取向（195 号票）
    await this.liftLevels(at, maxRounds, { ...ctx, budget: usable }, report, onStep, meter, night, ledger);

    // 199：往上抽出了新的需求、价值以后，矛盾根源再对一遍"更深的需求"（用价值观来验证；追问不再跑）
    if (this.joint && phase) {
      onStep({ step: "joint", phase: "start", detail: "矛盾根源再对一遍更深的需求" });
      await meter("lift", () => this.reasonJoint(phase, at, maxRounds, ctx, report, false));
      onStep({ step: "joint", phase: "end" });
    }

    // 199：写回知识图谱（明说的断言跟着改了的事实走），分不出的进"了解你问题"的队列
    if (this.joint && phase) {
      const joint = this.joint;
      onStep({ step: "writeback", phase: "start" });
      const written = this.night("writeback", "结论写回知识图谱", dropped, () => this.writeback.sync(at)) ?? { applied: [], reverted: [] };
      this.night("explicit", "明说的结论跟着事实走（写回以后）", dropped, () => this.syncExplicit(at, report));
      this.syncRelayed(at, report);
      onStep({ step: "writeback", phase: "end" });
      onStep({ step: "questions", phase: "start" });
      const questions = this.store.transaction(() => joint.syncQuestions(at));
      onStep({ step: "questions", phase: "end", detail: `${questions.length} 条问题` });
      const live = this.registry.listGroups({ live: true });
      report.joint = {
        motifGroups: live.filter((g) => isJointGroup(g) && !isRootGroup(g)).map((g) => g.key),
        conflictGroups: live.filter(isRootGroup).map((g) => g.key),
        writebacks: { applied: written.applied.map((w) => w.claimId), reverted: written.reverted.map((w) => w.claimId) },
        questions: questions.map((q) => q.key),
      };
    }

    // 329 号票：标着复核、不在活着的组里的（组撤了还留着的、没有组的推断）重判，摘掉标记——不让它一直卡在复核上
    this.night("decide", "标着复核、不在组里的重判", dropped, () => this.rejudgeLoose(at));

    // 227：对抗复核这次整理出来的 need/value 结论（独立复核员不看结论、只从证据重推；单独的调用预算）
    onStep({ step: "review", phase: "start" });
    report.review = await this.reviewNewConclusions(at, dropped);
    onStep({ step: "review", phase: "end", detail: `${report.review?.reviewed.length ?? 0} 条复核` });

    await runReplies();
    // 270：模型版整理完一条记一条（抽事实、出假设、出追问没被挡住，欠它的追问都问过了）；规则版照旧，预算用完的那次一条都不记
    const done = night ? settledEvidence(pending.map((e) => e.id), night.owed, night.asked, night.blocked) : exhausted() ? [] : pending.map((e) => e.id);
    this.store.transaction(() => {
      for (const id of done) this.registry.markReflected(id, this.reasoner.id);
    });
    report.processedEvidenceIds = done;
    report.backlog = pending.length - done.length;
    for (const c of this.store.listClaims()) {
      const was = before.get(c.id);
      if (was !== undefined && was !== JSON.stringify(c)) report.changedClaimIds.push(c.id);
    }
    return finish();
  }

  /** 出假设（reflect 的第 4 步）：推理实现给能当依据的观察出竞争假设分组，这次没再出来的组撤下（Q2：结论留成猜测）。交回出了几组 */
  private async proposeNew(at: string, ctx: ReasonerContext, report: ReflectReport, meter: Meter, night: LaneNight | undefined, ledger: NightAskLedger | undefined): Promise<number> {
    const { dropped, stats } = ctx;
    const unaskedBefore = stats?.steps.propose?.unasked ?? 0;
    const drafts = await meter("newEvidence", () => this.reasoner.propose(this.observations(at), ctx));
    this.night("propose", "出假设（竞争假设分组）", dropped, () => {
      const proposed = new Set<string>();
      for (const d of drafts) if (this.proposeGroup("propose", d, at, report, dropped)) proposed.add(d.key);
      this.retireGroups(proposed, at, ctx.view, dropped);
    });
    // 272：这次问到了、还没进组的观察记在账上（下一夜没变化就不再问）；进了组的不记
    if (ledger) {
      const grouped = new Set(this.registry.listGroups({ live: true }).filter(generic).flatMap((g) => g.observationIds));
      ledger.commit("propose", (id) => grouped.has(id));
    }
    // 270：出假设被预算挡住（有一批没问成）：观察还不在任何组里的那些新证据，这一夜不算整理过
    if (night && (stats?.steps.propose?.unasked ?? 0) > unaskedBefore) this.blockUngrouped(night, at);
    return drafts.length;
  }

  /**
   * 272 号票：问过、没变化就不再问的账。签名从 rg_asked 读；这次问到了的先攒着，这一步做完、看过进没进组再记（commit）——
   * 进了组的不记，以后组撤了还会再问；没进组的记下签名，下一夜签名没变就不再当这一批问
   */
  private askLedger(): NightAskLedger {
    const reasoner = this.reasoner.id;
    const pending = new Map<AskStep, Map<string, string>>();
    return {
      signature: (step, subject) => this.registry.askedSignature(step, reasoner, subject),
      settle: (step, entries) => {
        const got = pending.get(step) ?? new Map<string, string>();
        for (const e of entries) got.set(e.subject, e.signature);
        pending.set(step, got);
      },
      commit: (step, grouped) => {
        const got = pending.get(step);
        if (!got) return;
        pending.delete(step);
        this.store.transaction(() => {
          for (const [subject, signature] of got) if (!grouped(subject)) this.registry.markAsked(step, reasoner, subject, signature);
        });
      },
    };
  }

  /** 270 号票：这条证据抽过事实了（规则版的抽取器同步抽，算抽过；表态证据不抽事实，也算） */
  private extracted(e: Evidence): boolean {
    const extractor = this.engine.extractor;
    return !isPreparableExtractor(extractor) || isVerdictEvidence(e) || this.store.isExtracted(e.id, extractor.id);
  }

  /** 270 号票：出假设没做完——能当依据、还不在任何活着的组里的观察，背后的新证据这一夜不算整理过 */
  private blockUngrouped(night: LaneNight, at: string): void {
    const grouped = new Set(this.registry.listGroups({ live: true }).flatMap((g) => g.observationIds));
    for (const f of this.observations(at)) {
      if (grouped.has(f.id)) continue;
      for (const id of f.evidenceIds) if (night.pendingSet.has(id)) night.blocked.add(id);
    }
    night.cut = true;
  }

  /** 270 号票：这组没做完（追问没出成）——观察背后的新证据这一夜不算整理过 */
  private blockGroup(night: LaneNight, key: string): void {
    for (const id of this.groupEvidence(key)) if (night.pendingSet.has(id)) night.blocked.add(id);
    night.cut = true;
  }

  /** 一组的观察背后的证据（观察模式的组观察是事实；往上抽的组观察是断言，不算） */
  private groupEvidence(key: string): string[] {
    const g = this.registry.getGroup(key);
    if (!g) return [];
    return [...new Set(g.observationIds.flatMap((id) => this.store.getFact(id)?.evidenceIds ?? []))];
  }

  /**
   * 227 号票：对抗复核（独立复核员不看结论、只从支持证据重推）新出的 need/value 结论。
   * 末尾单独一步：有自己的 5 次调用预算，判 no 的加复核标记（329 号票：不改真值状态，往下的不动）；没给复核模型（规则版）就不做
   */
  private async reviewNewConclusions(at: string, dropped: DroppedOutput[]): Promise<AdversarialReviewReport | undefined> {
    const model = this.engine.reviewer;
    if (!model) return undefined;
    const outcome = await adversarialReview({ store: this.store, at, model, dropped });
    return outcome.report;
  }

  /** 199：对比模式、矛盾根源（rg/joint.ts）：出组（不成立了的撤下，结论留成猜测）→ 第一次见到的组出追问 → 跑追问 → 定状态 */
  private async reasonJoint(phase: KgPhase, at: string, maxRounds: number, ctx: ReasonerContext, report: ReflectReport, probes = true): Promise<void> {
    const joint = this.joint!;
    const drafts = joint.propose(phase, ctx.view);
    this.night("propose", "联动：对比模式、矛盾根源出组", ctx.dropped, () => {
      const proposed = new Set<string>();
      for (const d of drafts) if (this.proposeGroup("propose", d, at, report, ctx.dropped)) proposed.add(d.key);
      this.retireJointGroups(proposed, at, ctx.dropped);
    });
    if (probes) {
      await this.ensureProbes(isJointGroup, ctx, joint);
      report.rounds = Math.max(report.rounds, await this.runProbes(maxRounds, ctx, report, isJointGroup, joint));
    }
    this.night("decide", "联动的组按证据定状态", ctx.dropped, () => this.decideAll(at, ctx.view, isJointGroup, ctx.dropped));
  }

  /**
   * 这次没再出来的联动组：对比不明显了、矛盾不在了（证据被忘掉）——组撤下。
   * Q2（主会话 2026-10-27）：没有推翻者，组里的结论不撤，留成猜测、把握降一档、前提照挂（StatusKeeper.keepAsGuess）；
   * 有直接证实的（R7）不动；前提一条都不在了的按"不留悬空"撤回
   */
  private retireJointGroups(proposed: ReadonlySet<string>, at: string, dropped: DroppedOutput[]): void {
    for (const g of this.registry.listGroups({ live: true })) {
      if (!isJointGroup(g) || proposed.has(g.key)) continue;
      const cause: RevisionCause = { evidenceId: this.store.getFact(g.observationIds[0] ?? "")?.evidenceIds[0] ?? null, reason: `${isRootGroup(g) ? "矛盾不在了" : "对比模式不明显了"}（${g.description}），组撤下` };
      this.attempt({ op: "decide", reason: cause.reason }, dropped, () => {
        this.registry.setGroupLive(g.key, false);
        for (const m of this.registry.members(g.key)) {
          const claim = this.store.getClaim(m.claimId);
          if (claim) this.keeper.keepAsGuess(claim, at, cause, this.view(at));
        }
      });
    }
  }

  /** 这条结论现在的依据是直接证实（R7）：推理链塌了它照样成立 */
  hasDirectBasis(claimId: string): boolean {
    return this.store.inferencesOf(claimId).some((i) => i.status === "active" && isDirectInference(i));
  }

  /** 这次要整理的证据：给了 since 是它之后的（按发生时间），否则是这个推理实现还没整理过的 */
  private pendingEvidence(since: string | undefined): Evidence[] {
    const all = this.store.listEvidence();
    if (since !== undefined) {
      const i = all.findIndex((e) => e.id === since);
      if (i < 0) throw new Error(`没有这条证据：${since}`);
      return all.slice(i + 1).filter((e) => e.status === "active");
    }
    return all.filter((e) => e.status === "active" && !this.registry.isReflected(e.id, this.reasoner.id));
  }

  /** 抽事实：模型版的抽取器先按预算 prepare，只抽准备好的（engine.extractPending） */
  private async extract(budget: ModelBudget, dropped: DroppedOutput[], stats: ReasoningStats): Promise<void> {
    await this.engine.extractPending({ budget, dropped, stats });
  }

  /** 观察：在 at 成立的、关于用户的、能当依据的事实 */
  private observations(at: string): Fact[] {
    const view = this.view(at);
    return this.store.factsValidAt(at).filter((f) => f.subjectId === USER_ENTITY_ID && view.usableFact(f));
  }

  // ---------- 明说的断言 ----------

  /** 能出明说断言的事实：用户自己说的偏好（喜欢、不喜欢）和近期状态（忙、累……） */
  private explicitEligible(f: Fact): boolean {
    if (f.subjectId !== USER_ENTITY_ID || f.assertion !== "user_stated") return false;
    if (f.predicate === "prefers" || f.predicate === "dislikes") return true;
    return f.predicate === "said_about" && f.object.type === "entity" && isStateTopic(this.store.getEntity(f.object.id)?.name ?? "");
  }

  private objectName(f: Fact): string {
    return f.object.type === "entity" ? (this.store.getEntity(f.object.id)?.name ?? f.object.id) : f.object.value;
  }

  /** 说的是一阵子的事：状态词，或者说这句话的分句里有"最近、这阵子" */
  private isRecent(f: Fact): boolean {
    if (f.predicate === "said_about") return true;
    const name = this.objectName(f);
    const aliases = f.object.type === "entity" ? (this.store.getEntity(f.object.id)?.aliases ?? []) : [];
    return f.evidenceIds.some((id) => {
      const text = this.store.getEvidence(id)?.text ?? "";
      const clauses = text.split(/[，,。！!？?；;\n]+/);
      const clause = clauses.find((c) => [name, ...aliases].some((n) => n.length > 0 && c.includes(n))) ?? text;
      return RECENT_MARKERS.some((m) => clause.includes(m));
    });
  }

  private explicitStatement(f: Fact, state: boolean): string {
    const name = this.objectName(f);
    if (f.predicate === "said_about") return `用户近期${f.negated ? "不" : ""}${name}（${(f.eventTime ?? f.observedAt).slice(0, 10)} 自己说的）`;
    return `用户${state ? "最近" : ""}${contextPhrase(f.context)}${factPhrase(f.predicate, f.negated, name)}`;
  }

  /**
   * 明说的事实 → 明说的断言：没建的建上（结论 ← 这条事实），建了的状态、有效期、竞争关系跟着事实走。
   * 267 号票：每条各开一次写（被写入口拒了的那条记进 dropped，别的照常）
   */
  private syncExplicit(at: string, report: ReflectReport): void {
    const view = this.view(at);
    const facts = this.store.listFacts({ subjectId: USER_ENTITY_ID }).filter((f) => this.explicitEligible(f));
    // 先把该建的都建上，再统一改状态（取代、冲突要指向别的断言）
    for (const f of facts) {
      if (this.registry.explicitClaimOf(f.id)) continue;
      if (!(HELD_STATUSES as readonly string[]).includes(f.status) || !view.usableFact(f)) continue;
      const created = this.attempt({ op: "explicit", reason: `用户明说：${f.statement}` }, report.dropped, () => this.createExplicit(f, at));
      if (created !== undefined) report.newClaimIds.push(created);
    }
    for (const { factId, claimId } of this.registry.listExplicit()) {
      const f = this.store.getFact(factId);
      const claim = this.store.getClaim(claimId);
      if (!f || !claim) continue;
      this.attempt({ op: "explicit", reason: `明说的结论跟着事实 ${factId} 走` }, report.dropped, () => this.followFact(f, claim, at));
    }
  }

  /**
   * 330 号票（R3，relayed.ts）：别人转述的起猜测、跟着走。每条各开一次写（被写入口拒了的记进 dropped）：
   * - 没起过、能起、用户自己没说过同样的也没说过相反的 → 起一条猜测（推断的、溯因、把握 low，理由以"别人转述："开头，依据只当背景）；
   *   用户自己说过相反的（转述和本人对着干）不起、不记反证，问题箱出一个问题（question-sources.ts 的 relayed）；
   * - 起了的、还活着：用户自己说了同样的话 → 被明说的那条取代；说了相反的 → 撤回（他亲口说的推翻了它，墓碑指那条事实）。
   * 转述的那句被忘掉、纠正了，由失效传播撤（不留悬空）；用户答问题由问题箱确认或撤回
   */
  private syncRelayed(at: string, report: ReflectReport): void {
    for (const f of this.store.listFacts({ subjectId: USER_ENTITY_ID })) {
      if (f.assertion !== "third_party_reported") continue;
      const guessId = relayedGuessOf(this.store, f.id);
      const { agrees, conflicts } = selfCounterparts(this.store, f);
      if (guessId === undefined) {
        if (!relayedEligible(this.store, f) || agrees.length > 0 || conflicts.length > 0) continue;
        const created = this.attempt({ op: "propose", actor: "nightly", reason: `别人转述：${f.statement}（起一个猜测）` }, report.dropped, () => this.createRelayed(f, at));
        if (created !== undefined) report.newClaimIds.push(created);
        continue;
      }
      const guess = this.store.getClaim(guessId);
      if (!guess || (guess.status !== "active" && guess.status !== "contested")) continue;
      const own = agrees.find((x) => x.status === "active");
      const against = conflicts.find((x) => x.status === "active");
      if (own) {
        const stated = this.registry.explicitClaimOf(own.id);
        if (stated === undefined) continue;
        this.attempt({ op: "decide", actor: "nightly", reason: `用户自己说了同样的话：${own.statement}` }, report.dropped, () => {
          const cause: RevisionCause = { evidenceId: own.evidenceIds[0] ?? null, reason: `用户自己说了同样的话（${own.id}「${own.statement}」），转述起的猜测被明说的 ${stated} 取代` };
          this.w.updateClaim(guessId, { status: "superseded", supersededBy: stated, needsReview: false, reviewedAt: at }, cause);
        });
      } else if (against) {
        this.attempt({ op: "decide", actor: "nightly", reason: `用户自己说了相反的：${against.statement}` }, report.dropped, () => {
          const cause: RevisionCause = { evidenceId: against.evidenceIds[0] ?? null, reason: `用户自己说了相反的（${against.id}「${against.statement}」），转述起的猜测撤回` };
          this.w.updateClaim(guessId, { status: "retracted", retractedBy: against.id, needsReview: false, reviewedAt: at }, cause);
          for (const inf of this.store.inferencesOf(guessId)) if (inf.status === "active" || inf.status === "needs_review") this.w.updateInference(inf.id, { status: "retracted" }, cause);
          this.keeper.retractDependents(guessId, at, { ...cause, reason: `前提 ${guessId} 被用户自己的话推翻了` }, this.view(at));
        });
      }
    }
  }

  /** 330 号票（R3）：一条转述的事实起一条猜测（结论 ← 这条事实，只当背景）；返回结论 id */
  private createRelayed(f: Fact, at: string): string {
    const state = this.isRecent(f);
    const start = f.validFrom ?? f.eventTime ?? f.observedAt;
    const said = f.evidenceIds.map((id) => this.store.getEvidence(id)).find((e) => e?.status === "active");
    const cause: RevisionCause = { evidenceId: said?.id ?? null, reason: `别人转述：${f.statement}` };
    const claim = this.w.insertClaim(
      {
        tier: state ? "state" : "preference",
        statement: this.explicitStatement(f, state),
        kind: "hypothesis",
        epistemic: "inferred",
        method: "abduction",
        status: "contested",
        confidence: "low",
        context: [...f.context],
        validFrom: f.validFrom ?? null,
        validTo: state ? (f.validTo ?? addDays(start, STATE_DAYS)) : f.validTo,
        inferredAt: at,
        reviewedAt: null,
        retractedBy: null,
        supersededBy: null,
        competesWith: [],
        predicts: [],
      },
      cause,
    );
    this.w.insertInference(
      {
        conclusionClaimId: claim.id,
        premiseIds: [f.id],
        method: "abduction",
        rationale: `${RELAYED_BASIS}${said ? `「${said.text}」` : f.statement}——只是转述、用户没确认过，只能当猜测，问用户确认`,
        by: this.reasoner.id,
        status: "active",
      },
      cause,
    );
    this.w.putLink({ claimId: claim.id, target: f.id, polarity: "context", weight: "weak", rationale: `别人转述：${f.statement}——只当背景，不当依据（R3）` }, cause);
    return claim.id;
  }

  /** 一条明说的事实建一条明说的结论（结论 ← 这条事实，决定性的支持）；返回结论 id */
  private createExplicit(f: Fact, at: string): string {
    const state = this.isRecent(f);
    const validFrom = f.validFrom ?? null;
    const start = f.validFrom ?? f.eventTime ?? f.observedAt;
    const cause: RevisionCause = { evidenceId: f.evidenceIds[0] ?? null, reason: `用户明说：${f.statement}` };
    // 329 号票（R4）：事实拿不准（真冲突里的一边）时，这条一建出来就是猜测（身份照旧是 conclusion，不改）
    const unsure = f.status === "contested";
    const claim = this.w.insertClaim(
      {
        tier: state ? "state" : "preference",
        statement: this.explicitStatement(f, state),
        kind: "conclusion",
        epistemic: "explicit",
        method: "explicit",
        status: unsure ? "contested" : "active",
        confidence: unsure ? "medium" : "high",
        context: [...f.context],
        validFrom,
        validTo: state ? (f.validTo ?? addDays(start, STATE_DAYS)) : f.validTo,
        inferredAt: at,
        reviewedAt: null,
        retractedBy: null,
        supersededBy: null,
        competesWith: [],
        predicts: [],
      },
      cause,
    );
    this.registry.addExplicit(f.id, claim.id);
    this.w.insertInference({ conclusionClaimId: claim.id, premiseIds: [f.id], method: "explicit", rationale: "用户自己说的", by: this.reasoner.id, status: "active" }, cause);
    this.w.putLink({ claimId: claim.id, target: f.id, polarity: "supports", weight: "decisive", rationale: `用户明说：${f.statement}` }, cause);
    return claim.id;
  }

  /**
   * 明说的结论跟着它那条事实走：状态、有效期、竞争关系、场景和陈述。
   * 329 号票（ADR-0032）：身份不改（326 号票"拿不准降成假设 / 拿稳了升回结论"去掉）；事实拿不准 → 这条是猜测（contested），
   * 往下的已验证跟着降回猜测（R4）；事实被用户纠正 → 撤回，往上的按 R8 撤（有直接证实的留下）；事实因为证据被忘掉而撤回 →
   * 撤回（不留悬空），往上的按"来源失效"（加复核标记、已验证的降回猜测）；撤了的事实回来了 → 复活，连带撤回的跟着回来（R11）。
   * 跟着事实走了一遍就算复核过，摘掉复核标记
   */
  private followFact(f: Fact, claim: Claim, at: string): void {
    const claimId = claim.id;
    // 199：写回会补事实的场景，明说的断言的场景、陈述跟着事实走
    const patch: Partial<Claim> = {
      validFrom: f.validFrom,
      competesWith: [],
      supersededBy: null,
      retractedBy: null,
      context: [...f.context],
      statement: this.explicitStatement(f, claim.tier === "state"),
      needsReview: false,
    };
    if (claim.tier === "state") patch.validTo = f.validTo ?? claim.validTo;
    else patch.validTo = f.validTo;
    let reason = "事实成立";
    if (f.status === "active") {
      patch.status = "active";
      patch.confidence = "high";
      // 330 号票（R14）：说的和做的对不上（记了 gap）、还没弄清——哪边都不自动赢：明说的这条先当猜测、标复核
      const gap = this.openSayDoGap(f, claim);
      if (gap !== undefined) {
        patch.status = "contested";
        patch.confidence = "medium";
        patch.needsReview = true;
        reason = `说的和做的对不上（${gap}）：哪边都不自动赢，先当猜测、等弄清（R14）`;
      }
    } else if (f.status === "contested") {
      patch.status = "contested";
      patch.confidence = "medium";
      patch.competesWith = f.contestedWith.map((id) => this.registry.explicitClaimOf(id)).filter((id): id is string => id !== undefined);
      reason = `事实真冲突：${f.contestedWith.join("、")}（拿不准，这条是猜测）`;
    } else if (f.status === "superseded") {
      const by = f.supersededBy ? this.registry.explicitClaimOf(f.supersededBy) : undefined;
      patch.status = by ? "superseded" : "active";
      patch.supersededBy = by ?? null;
      reason = by ? `观点变化：被 ${by} 取代（事实 ${f.supersededBy}）` : `观点变化：到 ${f.validTo} 为止`;
    } else {
      patch.status = "retracted";
      // 墓碑（R8）：被纠正的指纠正它的那句话（推翻者）；证据被忘掉而撤回的指那条事实（不在了的前提，来源失效）
      patch.retractedBy = f.status === "corrected" ? (f.retractedBy ?? f.id) : f.id;
      reason = f.status === "corrected" ? `事实被纠正（${f.retractedBy}）` : `事实被撤回（${f.retractedBy}）`;
    }
    if (claim.needsReview || claim.status !== patch.status) patch.reviewedAt = at;
    this.w.updateClaim(claimId, patch, { evidenceId: f.retractedBy ?? f.evidenceIds[0] ?? null, reason: `明说的断言跟着事实走：${reason}` });
    const inferenceStatus = patch.status === "retracted" ? "retracted" : "active";
    for (const inf of this.store.inferencesOf(claimId)) {
      if (inf.status !== inferenceStatus && inf.status !== "history") this.w.updateInference(inf.id, { status: inferenceStatus }, { evidenceId: f.retractedBy ?? null, reason: `明说的断言 ${claimId} ${patch.status}` });
    }
    const view = this.view(at);
    const next: RevisionCause = { evidenceId: f.retractedBy ?? null, reason: `前提 ${claimId}：${reason}` };
    const wasLive = claim.status === "active" || claim.status === "contested";
    if (patch.status === "retracted" && wasLive) {
      if (f.status === "corrected") this.keeper.retractDependents(claimId, at, next, view);
      else this.keeper.sourceLost(claimId, at, next, view);
    } else if (claim.status === "active" && patch.status !== "active") {
      this.keeper.downgradeDependents(claimId, at, next, view);
    } else if (claim.status === "retracted" && patch.status !== "retracted") {
      this.keeper.reinstateDependents(claimId, at, next);
    }
  }

  /**
   * 330 号票（R14）：这条明说的事实有没有还没弄清的"说的和做的对不上"——记了 gap（ref 是那个矛盾）、用户没当面确认过这条结论、
   * 那个矛盾的根源组也没有用户确认过的根源。有就交回一句说明（和哪几条做的对不上），没有是 undefined
   */
  private openSayDoGap(f: Fact, claim: Claim): string | undefined {
    const gaps = this.writeback.marks.of(f.id).filter((m) => m.kind === "gap" && m.ref.startsWith("say_do|"));
    if (gaps.length === 0) return undefined;
    const confirmed = this.store.linksOf(claim.id).some((l) => l.polarity === "supports" && l.rationale.startsWith(USER_CONFIRMATION) && this.store.getEvidence(l.target)?.status === "active");
    if (confirmed) return undefined;
    const open = gaps.filter((m) => {
      const root = this.registry.getGroup(`${ROOT_PATTERN}|${m.ref}`);
      return !(root && this.registry.members(root.key).some((x) => this.store.getClaim(x.claimId)?.status === "active"));
    });
    return open.length === 0 ? undefined : `和 ${[...new Set(open.flatMap((m) => m.detail.with ?? []))].join("、")}`;
  }

  // ---------- 竞争假设 ----------

  groupView(key: string): GroupView | undefined {
    const g = this.registry.getGroup(key);
    if (!g) return undefined;
    const members = this.registry
      .members(key)
      .map((m) => ({ claim: this.store.getClaim(m.claimId)!, template: m.template }))
      .filter((m) => m.claim !== undefined);
    return { key: g.key, pattern: g.pattern, params: g.params, description: g.description, observationIds: g.observationIds, members };
  }

  /** 关联的目标得是存在的事实或证据（模型编出来的 id 写入前丢掉） */
  private targetExists(target: string): boolean {
    return this.store.getFact(target) !== undefined || this.store.getEvidence(target) !== undefined;
  }

  private causeOf(target: string, reason: string): RevisionCause {
    const fact = this.store.getFact(target);
    return { evidenceId: fact ? (fact.evidenceIds[0] ?? null) : this.store.getEvidence(target) ? target : null, reason };
  }

  /**
   * 267 号票：一组各开一次写（提假设、往上抽）：被写入口拒了的整组不写，原因记进 dropped；新结论等写成了才记进报告
   */
  private proposeGroup(op: "propose" | "lift", d: HypothesisGroupDraft, at: string, report: ReflectReport, dropped: DroppedOutput[]): boolean {
    const fresh: string[] = [];
    const ok = this.attempt({ op, reason: `${op === "lift" ? "往上抽" : "出假设"}：${d.description}` }, dropped, () => this.upsertGroup(d, at, fresh, dropped));
    if (ok !== true) return false;
    report.newClaimIds.push(...fresh);
    return true;
  }

  /** 新建或更新一组竞争假设；不合格（不到两条）返回 false。新建的结论 id 记进 fresh */
  private upsertGroup(d: HypothesisGroupDraft, at: string, fresh: string[], dropped: DroppedOutput[]): boolean {
    const hypotheses = d.hypotheses.filter((h, i) => d.hypotheses.findIndex((x) => x.template === h.template) === i);
    const observationIds = d.observationIds.filter((id) => this.store.getFact(id) !== undefined || this.store.getClaim(id) !== undefined);
    if (hypotheses.length < 2 || observationIds.length === 0) {
      dropped.push({ stage: "propose", reason: hypotheses.length < 2 ? "竞争假设不到两条" : "观察的事实、断言都不存在", item: d.key });
      return false;
    }
    this.registry.putGroup({ key: d.key, pattern: d.pattern, params: d.params, description: d.description, observationIds, live: true, by: this.reasoner.id });
    const existing = new Map(this.registry.members(d.key).map((m) => [m.template, m.claimId]));
    const ids: string[] = [];
    /** 329 号票：撤了的重新推出来（新建）时，旧 id → 新 id（这一组的追问跟着换） */
    const replaced = new Map<string, string>();
    for (const h of hypotheses) {
      const cause: RevisionCause = { evidenceId: this.store.getFact(observationIds.at(-1)!)?.evidenceIds[0] ?? null, reason: `竞争假设（${d.description}）` };
      let claimId = existing.get(h.template);
      const old = claimId === undefined ? undefined : this.store.getClaim(claimId);
      if (old && old.status === "retracted" && !this.keeper.retractedByScoring(old)) {
        if (this.keeper.retractionStands(old)) {
          // 329 号票（R8、R11）：被推翻撤掉的不复活（复活只认推翻它的自己被推翻）；证据够了重新推 = 新建一条（原始推理图谱的撤旧建新），
          // 旧的留墓碑、移出这一组
          this.registry.removeMember(old.id);
          claimId = undefined;
        } else {
          // 推翻它的已经不在了（以前的组撤下时墓碑指着的观察又成立了）：复活成猜测（R11），下面照常更新
          this.keeper.reinstate(old, at, { ...cause, reason: `推翻它的 ${old.retractedBy} 已经不再成立，组又出来了，复活成猜测` });
        }
      }
      if (!claimId) {
        // 226 号票：这条解释当时写下的预测（模型版、规则版的往上抽都会写），结论照它记下来
        const predicts: Claim["predicts"] = h.predicts ? [{ claim: h.predicts, outcome: "pending", evidenceIds: [], derivation: h.predictsDerivation ?? "defeasible" }] : [];
        const claim = this.w.insertClaim(
          {
            tier: h.tier,
            statement: h.statement,
            kind: "hypothesis",
            epistemic: "inferred",
            method: h.method,
            status: "contested",
            confidence: "low",
            context: h.context,
            validFrom: h.validFrom,
            validTo: h.validTo,
            inferredAt: at,
            reviewedAt: null,
            retractedBy: null,
            supersededBy: null,
            competesWith: [],
            predicts,
          },
          cause,
        );
        claimId = claim.id;
        this.registry.addMember(claimId, d.key, h.template);
        this.w.insertInference({ conclusionClaimId: claimId, premiseIds: observationIds, method: h.method, rationale: d.description, by: this.reasoner.id, status: "active" }, cause);
        fresh.push(claimId);
        if (old) replaced.set(old.id, claimId);
      } else {
        const patch: Partial<Claim> = { statement: h.statement, context: h.context, validFrom: h.validFrom, validTo: h.validTo };
        // 同一条解释又写了一条预测：更新上去（没写就保留原来的）
        if (h.predicts) patch.predicts = [{ claim: h.predicts, outcome: "pending", evidenceIds: [], derivation: h.predictsDerivation ?? "defeasible" }];
        this.w.updateClaim(claimId, patch, { ...cause, reason: `新的观察：${d.description}` });
        // 329 号票：只更新推理链（前提照这次的观察）；改挂到直接证实上的（R7）链照旧记作历史；计分撤回的由定状态那一步判
        const current = this.store.getClaim(claimId)!;
        const direct = this.hasDirectBasis(claimId);
        for (const inf of this.store.inferencesOf(claimId)) {
          if (isDirectInference(inf)) continue;
          const status = current.status === "retracted" ? inf.status : direct ? "history" : "active";
          this.w.updateInference(inf.id, { premiseIds: observationIds, rationale: d.description, status }, { ...cause, reason: `新的观察：${d.description}` });
        }
      }
      ids.push(claimId);
      for (const link of h.links) {
        if (!this.targetExists(link.target)) {
          dropped.push({ stage: "propose", reason: `关联的目标不存在：${link.target}`, item: link });
          continue;
        }
        this.w.putLink({ claimId, ...link }, this.causeOf(link.target, `${h.template}：${link.rationale}`));
      }
    }
    for (const id of ids) {
      const competesWith = ids.filter((x) => x !== id);
      this.w.updateClaim(id, { competesWith }, { reason: `竞争假设互相登记（${d.key}）` });
    }
    // 329 号票：重新推出来的新结论接上旧的那条在这一组追问里的位置
    if (replaced.size > 0) {
      for (const { probeId } of this.registry.probesOf(d.key)) {
        const probe = this.store.getProbe(probeId);
        if (!probe || !probe.discriminates.some((id) => replaced.has(id))) continue;
        const discriminates = [...new Set(probe.discriminates.map((id) => replaced.get(id) ?? id))];
        const ifFound = probe.ifFound === null ? null : (replaced.get(probe.ifFound) ?? probe.ifFound);
        this.w.updateProbe(probeId, { discriminates, ifFound }, { reason: `撤了的结论重新推出来：${[...replaced].map(([a, b]) => `${a} → ${b}`).join("、")}` });
      }
    }
    return true;
  }

  /**
   * 观察不够两条的组撤下（Q2：组里的结论留成猜测、把握降一档，不撤）。
   * 推理实现每次都认全部模式时（exhaustive），这次没再认出来的组也不成立了；观察都还在、只是换成了别的组（比如场景变了）的，
   * 组里的断言被新组里同一个模板的断言取代（superseded），新组没有同模板的留成猜测。
   */
  private retireGroups(proposed: ReadonlySet<string>, at: string, view: RgView, dropped: DroppedOutput[]): void {
    for (const g of this.registry.listGroups({ live: true })) {
      if (proposed.has(g.key) || isLift(g) || isJointGroup(g)) continue;
      const dead = g.observationIds.filter((id) => {
        const f = this.store.getFact(id);
        return !f || !(HELD_STATUSES as readonly string[]).includes(f.status) || !view.usableFact(f);
      });
      const exhaustive = this.reasoner.exhaustive === true && g.by === this.reasoner.id;
      if (g.observationIds.length - dead.length >= 2 && !exhaustive) continue;
      this.attempt({ op: "decide", reason: `观察模式不成立了（${g.description}），组里的结论撤回或被接上` }, dropped, () => this.retireGroup(g, proposed, dead, at));
    }
  }

  /**
   * 撤下一组（retireGroups 判定要撤的）：被新组同一个模板接上的标取代（往下按传播铁律降回猜测），别的留成猜测。
   * Q2（主会话 2026-10-27）：观察不够两条、这次没再认出来，都没有推翻者——不撤，留成猜测、把握降一档、前提照挂
   * （StatusKeeper.keepAsGuess；前提一条都不在了的按"不留悬空"撤回）。有直接证实的（R7）不动
   */
  private retireGroup(g: GroupRecord, proposed: ReadonlySet<string>, dead: readonly string[], at: string): void {
    this.registry.setGroupLive(g.key, false);
    const successor =
      dead.length === 0
        ? this.registry.listGroups({ live: true }).find((o) => o.key !== g.key && o.pattern === g.pattern && proposed.has(o.key) && o.observationIds.some((id) => g.observationIds.includes(id)))
        : undefined;
    const heirs = new Map((successor ? this.registry.members(successor.key) : []).map((m) => [m.template, m.claimId]));
    const cause = dead[0] ?? g.observationIds[0]!;
    for (const m of this.registry.members(g.key)) {
      const claim = this.store.getClaim(m.claimId);
      if (!claim || claim.status === "retracted" || claim.status === "superseded" || this.hasDirectBasis(claim.id)) continue;
      const heir = heirs.get(m.template);
      if (successor && heir) {
        this.w.updateClaim(claim.id, { status: "superseded", supersededBy: heir, needsReview: false, reviewedAt: at }, { reason: `观察换成了另一组（${successor.description}），由 ${heir} 接上` });
        for (const inf of this.store.inferencesOf(claim.id)) if (inf.status === "active" || inf.status === "needs_review") this.w.updateInference(inf.id, { status: "retracted" }, this.causeOf(cause, "观察换成了另一组"));
        this.keeper.downgradeDependents(claim.id, at, this.causeOf(cause, `前提 ${claim.id} 被取代了`), this.view(at));
      } else {
        const left = g.observationIds.length - dead.length;
        this.keeper.keepAsGuess(claim, at, this.causeOf(cause, `观察模式不成立了（${g.description}；还剩 ${left} 条观察${successor ? "，换成的那组没有同一个解释" : ""}）`), this.view(at));
      }
    }
  }

  /** 校验并写入追问草稿：要区分的得是组里的断言、至少两条；ifFound 得是其中一条 */
  private insertProbes(group: GroupView, drafts: ProbeDraft[], dropped: DroppedOutput[]): void {
    const members = new Set(group.members.map((m) => m.claim.id));
    for (const d of drafts) {
      const discriminates = [...new Set(d.discriminates)];
      const queries = d.queries.map((q) => q.trim()).filter((q) => q.length > 0);
      if (discriminates.length < 2 || discriminates.some((id) => !members.has(id))) {
        dropped.push({ stage: "probes", reason: "要区分的不是这组里的断言（或不到两条）", item: d });
        continue;
      }
      if (d.ifFound !== null && !discriminates.includes(d.ifFound)) {
        dropped.push({ stage: "probes", reason: `ifFound ${d.ifFound} 不在要区分的里面`, item: d });
        continue;
      }
      if (d.ask.trim().length === 0 || queries.length === 0) {
        dropped.push({ stage: "probes", reason: "没有问法或查询", item: d });
        continue;
      }
      const probe = this.w.insertProbe({ discriminates, ask: d.ask, queries, ifFound: d.ifFound, outcome: "open", foundEvidenceIds: [] }, { reason: `判别性追问（${group.key}：${d.template}）` });
      this.registry.addProbe(probe.id, group.key, d.template);
    }
  }

  /** 一组查询各搜一遍，合起来（同一条证据留分数高的，记上经过哪个追问） */
  async probeSearch(queries: readonly string[], at: string, probeId: string | null): Promise<Hit[]> {
    const merged = new Map<string, Hit>();
    for (const q of queries) {
      for (const hit of await this.baseSearch(q, { at, limit: PROBE_HITS_PER_QUERY })) {
        const prev = merged.get(hit.evidenceId);
        const next: Hit = prev && prev.fused >= hit.fused ? prev : { ...hit, via: { factIds: [...hit.via.factIds], probeIds: [...hit.via.probeIds] } };
        if (prev && next !== prev) for (const f of prev.via.factIds) if (!next.via.factIds.includes(f)) next.via.factIds.push(f);
        if (probeId && !next.via.probeIds.includes(probeId)) next.via.probeIds.push(probeId);
        merged.set(hit.evidenceId, next);
      }
    }
    return [...merged.values()].toSorted((a, b) => b.fused - a.fused);
  }

  toJudgeHits(hits: readonly Hit[], view: RgView): JudgeHit[] {
    return hits.flatMap((hit) => {
      const evidence = this.store.getEvidence(hit.evidenceId);
      return evidence ? [{ hit, evidence, facts: view.factsOfEvidence(evidence.id) }] : [];
    });
  }

  /** 跑一条追问：检索、判定、写关联和结果。返回这次新找到的证据（270 号票：已经搜过的把结果传进来，不再搜一遍） */
  async runProbe(
    probe: Probe,
    group: GroupView,
    queries: readonly string[],
    ctx: ReasonerContext,
    judge: Pick<Reasoner, "judge"> = this.reasoner,
    searched?: Hit[],
  ): Promise<{ found: string[]; hits: Hit[] }> {
    const hits = searched ?? (await this.probeSearch(queries, ctx.view.at, probe.id));
    const jhits = this.toJudgeHits(hits, ctx.view);
    const judgement = await judge.judge(probe, group, jhits, ctx);
    const hitEvidence = new Set(jhits.map((h) => h.evidence.id));
    const hitFacts = new Set(jhits.flatMap((h) => h.facts.map((f) => f.id)));
    const members = new Set(group.members.map((m) => m.claim.id));
    const found = judgement.foundEvidenceIds.filter((id) => {
      const ok = hitEvidence.has(id) && ctx.view.usableEvidence(id);
      if (!ok) ctx.dropped.push({ stage: "judge", reason: `找到的证据不在检索结果里或不能当依据：${id}`, item: id });
      return ok;
    });
    const written = this.attempt({ op: "attach", reason: `追问 ${probe.id} 判证据（${group.key}）` }, ctx.dropped, () => {
      for (const link of judgement.links) this.writeJudgedLink(link, members, hitEvidence, hitFacts, probe, ctx);
      const union = [...new Set([...probe.foundEvidenceIds, ...found])];
      const ifFound = probe.ifFound ?? (judgement.ifFound !== null && probe.discriminates.includes(judgement.ifFound) ? judgement.ifFound : null);
      this.w.updateProbe(probe.id, { outcome: union.length > 0 ? "found" : "not_found", foundEvidenceIds: union, ifFound }, { evidenceId: found[0] ?? null, reason: `追问检索：${queries.join("、")}` });
      return true;
    });
    // 267 号票：被写入口拒了的这次什么都没写，也就没有"新找到的"
    return { found: written === true ? found.filter((id) => !probe.foundEvidenceIds.includes(id)) : [], hits };
  }

  /** 判定交回的一条关联：断言得是组里的、目标得是这次检索到的；不能当依据的只能是背景 */
  private writeJudgedLink(link: LinkDraft, members: ReadonlySet<string>, hitEvidence: ReadonlySet<string>, hitFacts: ReadonlySet<string>, probe: Probe, ctx: ReasonerContext): void {
    if (!members.has(link.claimId)) {
      ctx.dropped.push({ stage: "judge", reason: `关联的断言不在这组里：${link.claimId}`, item: link });
      return;
    }
    if (!hitEvidence.has(link.target) && !hitFacts.has(link.target)) {
      ctx.dropped.push({ stage: "judge", reason: `关联的目标不在检索结果里：${link.target}`, item: link });
      return;
    }
    const fact = this.store.getFact(link.target);
    const usable = fact ? ctx.view.usableFact(fact) : ctx.view.usableEvidence(link.target);
    const draft = usable || link.polarity === "context" ? link : { ...link, polarity: "context" as const, weight: "weak" as const, rationale: `${link.rationale}（不是本人的，只当背景）` };
    const { claimId, target, polarity, weight, rationale } = draft;
    this.w.putLink({ claimId, target, polarity, weight, rationale }, this.causeOf(target, `追问 ${probe.id}：${rationale}`));
  }

  /** 跑各组的追问：第一轮用追问自己的查询；第一轮有新证据时，第二轮用找到的事实里的名字扩展查询 */
  private async runProbes(maxRounds: number, ctx: ReasonerContext, report: ReflectReport, only: (g: GroupRecord) => boolean = () => true, judge: Pick<Reasoner, "judge"> = this.reasoner): Promise<number> {
    let rounds = 0;
    const expansions = new Map<string, Set<string>>();
    for (let round = 1; round <= maxRounds; round++) {
      let fresh = false;
      for (const g of this.registry.listGroups({ live: true }).filter(only)) {
        const group = this.groupView(g.key);
        if (!group || group.members.every((m) => m.claim.status === "retracted")) continue;
        for (const { probeId } of this.registry.probesOf(g.key)) {
          const probe = this.store.getProbe(probeId);
          if (!probe) continue;
          let queries = probe.queries;
          if (round > 1) {
            queries = [...(expansions.get(probeId) ?? [])].filter((q) => !probe.queries.includes(q));
            if (queries.length === 0) continue;
          }
          const { found } = await this.runProbe(probe, this.groupView(g.key)!, queries, ctx, judge);
          if (!report.probeIds.includes(probeId)) report.probeIds.push(probeId);
          if (found.length > 0) fresh = true;
          const names = new Set<string>();
          for (const id of found) for (const f of ctx.view.factsOfEvidence(id)) if (f.object.type === "entity") names.add(ctx.view.entityName(f.object.id));
          expansions.set(probeId, names);
        }
      }
      rounds = round;
      if (!fresh) break;
    }
    return rounds;
  }

  /** 事实这一层真冲突的追问（discriminates 是两条事实）：找另外的本人证据说的是哪一边 */
  private async runFactProbes(ctx: ReasonerContext, report: ReflectReport): Promise<void> {
    for (const probe of this.store.listProbes()) {
      if (this.registry.groupOfProbe(probe.id) !== undefined) continue;
      const [a, b] = probe.discriminates.map((id) => this.store.getFact(id));
      if (!a || !b) continue;
      const hits = await this.probeSearch(probe.queries, ctx.view.at, probe.id);
      const agree: Record<string, string[]> = { [a.id]: [], [b.id]: [] };
      for (const { evidence, facts } of this.toJudgeHits(hits, ctx.view)) {
        if (!ctx.view.usableEvidence(evidence.id)) continue;
        for (const f of facts) {
          if (f.id === a.id || f.id === b.id || f.subjectId !== a.subjectId) continue;
          for (const side of [a, b]) if (sameObject(f.object, side.object) && f.predicate === side.predicate && f.negated === side.negated) agree[side.id]!.push(f.id);
        }
      }
      const found = [...new Set([...agree[a.id]!, ...agree[b.id]!].flatMap((id) => this.store.getFact(id)?.evidenceIds ?? []))].filter((id) => ctx.view.usableEvidence(id));
      const winner = agree[a.id]!.length === agree[b.id]!.length ? null : agree[a.id]!.length > agree[b.id]!.length ? a.id : b.id;
      this.attempt({ op: "attach", reason: `真冲突的追问 ${probe.id} 判证据` }, ctx.dropped, () => {
        for (const side of [a, b]) {
          const claimId = this.registry.explicitClaimOf(side.id);
          if (!claimId) continue;
          for (const factId of agree[side.id]!) this.w.putLink({ claimId, target: factId, polarity: "supports", weight: "weak", rationale: `另一次也这么说（追问 ${probe.id}）` }, this.causeOf(factId, `追问 ${probe.id}`));
        }
        const union = [...new Set([...probe.foundEvidenceIds, ...found])];
        this.w.updateProbe(probe.id, { outcome: union.length > 0 ? "found" : "not_found", foundEvidenceIds: union, ifFound: probe.ifFound ?? winner }, { evidenceId: found[0] ?? null, reason: `真冲突的追问检索：${probe.queries.join("、")}` });
      });
      report.probeIds.push(probe.id);
    }
  }

  /** 第一次见到的组出判别性追问；返回因为预算用完没出成追问的组（270 号票：这几组观察背后的新证据这一夜不算整理过） */
  private async ensureProbes(only: (g: GroupRecord) => boolean, ctx: ReasonerContext, from: Pick<Reasoner, "probesFor"> = this.reasoner): Promise<string[]> {
    const unprobed: string[] = [];
    for (const g of this.registry.listGroups({ live: true }).filter(only)) {
      if (this.registry.probesOf(g.key).length > 0) continue;
      const view = this.groupView(g.key)!;
      const probes = await from.probesFor(view, ctx);
      if (probes.length === 0 && ctx.budget.exhausted) unprobed.push(g.key);
      this.attempt({ op: "probe", reason: `判别性追问（${g.key}）` }, ctx.dropped, () => this.insertProbes(view, probes, ctx.dropped));
    }
    return unprobed;
  }

  /**
   * 270 号票：按道跑一批组的追问（模型版）。先把这批组的每条追问搜一遍（和以前一样每夜都搜，判证据才花钱），
   * 再按 rg/nightly-lanes.ts 排：
   * - 第一道（lanes.first）：没问过的追问、检索结果里有新证据的追问，按最早那条新证据的先后；owes 时记下每条新证据欠哪几条追问；
   * - 第二道（lanes.rest）：第一道剩下的预算，重跑待复核的组、有到期复评结论的组的追问；别的组检索结果里没新东西，不重判。
   * 预算用完就停（没问到的追问不写结果，没问过的留着下一夜最先问），记 night.cut。
   */
  private async judgeByLane(
    only: (g: GroupRecord) => boolean,
    night: LaneNight,
    maxRounds: number,
    ctx: ReasonerContext,
    report: ReflectReport,
    meter: Meter,
    lanes: { first: ReflectLane; rest: ReflectLane; owes: boolean; between?: () => Promise<void>; restBudget?: ModelBudget },
  ): Promise<LaneRun> {
    const at = ctx.view.at;
    const groups = this.registry
      .listGroups({ live: true })
      .filter(only)
      .map((g) => this.groupView(g.key))
      .filter((g): g is GroupView => g !== undefined && !g.members.every((m) => m.claim.status === "retracted"));
    const slots: ProbeSlot[] = [];
    const hits = new Map<string, Hit[]>();
    for (const group of groups) {
      const evidence = this.groupEvidence(group.key);
      for (const { probeId } of this.registry.probesOf(group.key)) {
        const probe = this.store.getProbe(probeId);
        if (!probe) continue;
        const found = await this.probeSearch(probe.queries, at, probe.id);
        hits.set(probeId, found);
        const never = probe.outcome === "open";
        slots.push({ probeId, groupKey: group.key, never, pendingHits: found.map((h) => h.evidenceId).filter((id) => night.pendingSet.has(id)), groupEvidence: never ? evidence : [] });
      }
    }
    if (lanes.owes) {
      for (const [evidenceId, probes] of owedProbes(slots, night.pendingSet)) night.owed.set(evidenceId, new Set([...(night.owed.get(evidenceId) ?? []), ...probes]));
    }
    const first = await meter(lanes.first, () => this.runLane(newEvidenceQueue(slots, night.order), hits, maxRounds, ctx, report, night));
    let rounds = first.rounds;
    // 271：两道中间的那一道（判回答）：第一道被挡住也照跑（它有自己的保底）
    if (lanes.between) await lanes.between();
    if (!first.cut) {
      const ranked: RejudgeGroup[] = groups.map((g) => {
        const due = g.members.map((m) => m.claim).filter((c) => isReviewDue(c, at));
        return {
          key: g.key,
          needsReview: g.members.some((m) => night.reviewBefore.has(m.claim.id) || m.claim.needsReview),
          dueSince: due.length === 0 ? null : Math.min(...due.map((c) => toMs(c.reviewedAt ?? c.inferredAt))),
        };
      });
      const queue = rejudgeOrder(ranked).flatMap((key) => slots.filter((s) => s.groupKey === key));
      const restCtx = lanes.restBudget === undefined ? ctx : { ...ctx, budget: lanes.restBudget };
      const rest = await meter(lanes.rest, () => this.runLane(queue, hits, maxRounds, restCtx, report, night));
      rounds = Math.max(rounds, rest.rounds);
    }
    const reviewed = new Set(groups.map((g) => g.key).filter((key) => slots.some((s) => s.groupKey === key) && slots.every((s) => s.groupKey !== key || night.asked.has(s.probeId))));
    return { rounds, reviewed };
  }

  /**
   * 270 号票：按排好的先后问一串追问（第一轮用追问自己的查询和搜好的结果；第一轮有新找到的证据时，第二轮用找到的事实里的名字扩展查询）。
   * 这一夜问过的跳过；要问模型（检索结果不空）而预算已经用完就停，记 night.cut。返回跑了几轮、这一串有没有被预算挡住
   */
  private async runLane(
    queue: readonly ProbeSlot[],
    hits: ReadonlyMap<string, Hit[]>,
    maxRounds: number,
    ctx: ReasonerContext,
    report: ReflectReport,
    night: LaneNight,
  ): Promise<{ rounds: number; cut: boolean }> {
    const expansions = new Map<string, { groupKey: string; names: Set<string> }>();
    let fresh = false;
    let cut = false;
    for (const slot of queue) {
      if (night.asked.has(slot.probeId)) continue;
      const probe = this.store.getProbe(slot.probeId);
      const group = this.groupView(slot.groupKey);
      if (!probe || !group) continue;
      const searched = hits.get(slot.probeId) ?? [];
      if (searched.length > 0 && ctx.budget.exhausted) {
        cut = true;
        break;
      }
      const { found } = await this.runProbe(probe, group, probe.queries, ctx, this.reasoner, searched);
      night.asked.add(slot.probeId);
      if (!report.probeIds.includes(slot.probeId)) report.probeIds.push(slot.probeId);
      if (found.length > 0) fresh = true;
      const names = new Set<string>();
      for (const id of found) for (const f of ctx.view.factsOfEvidence(id)) if (f.object.type === "entity") names.add(ctx.view.entityName(f.object.id));
      expansions.set(slot.probeId, { groupKey: slot.groupKey, names });
    }
    if (cut || !fresh || maxRounds < 2) {
      if (cut) night.cut = true;
      return { rounds: 1, cut };
    }
    for (const [probeId, { groupKey, names }] of expansions) {
      const probe = this.store.getProbe(probeId);
      const group = this.groupView(groupKey);
      if (!probe || !group) continue;
      const queries = [...names].filter((q) => !probe.queries.includes(q));
      if (queries.length === 0) continue;
      if (ctx.budget.exhausted) {
        cut = true;
        break;
      }
      await this.runProbe(probe, group, queries, ctx);
    }
    if (cut) night.cut = true;
    return { rounds: 2, cut };
  }

  // ---------- 往上抽（195 号票） ----------

  /**
   * 两层各走一遍：成立的偏好、状态 → 需求层的组；成立的需求 → 价值层的组。每层：推理实现出草稿（同一主题在两种以上场景、
   * 两个以上时期成立的才有）→ 新建或更新组（推断是"结论 ← 这几条断言"）→ 条件不成立了的组撤下（Q2：结论留成猜测）→ 追问 → 定状态。
   * 推理实现没有 lift（模型版）就不做。
   */
  private async liftLevels(
    at: string,
    maxRounds: number,
    ctx: ReasonerContext,
    report: ReflectReport,
    onStep: (event: ReflectStepEvent) => void,
    meter: Meter,
    night: LaneNight | undefined,
    ledger?: NightAskLedger,
  ): Promise<void> {
    const lift = this.reasoner.lift?.bind(this.reasoner);
    if (!lift) return;
    for (const level of ["need", "value"] as const) {
      onStep({ step: "lift", phase: "start", detail: level === "need" ? "需求层" : "价值层" });
      const drafts = await meter("lift", () => lift(level, this.liftInputs(level, ctx.view), ctx));
      this.night("lift", level === "need" ? "往上抽：需求层" : "往上抽：价值层", ctx.dropped, () => {
        const proposed = new Set<string>();
        for (const d of drafts) if (this.proposeGroup("lift", d, at, report, ctx.dropped)) proposed.add(d.key);
        this.retireLiftGroups(level, proposed, at, ctx.dropped);
      });
      const atLevel = (g: GroupRecord) => g.pattern === `lift:${level}`;
      // 272：这次问到了、还没被这一层的组用上的下层断言记在账上（下一夜没变化就不再问）；用上了的不记
      if (ledger) {
        const used = new Set(this.registry.listGroups({ live: true }).filter(atLevel).flatMap((g) => g.observationIds));
        ledger.commit(`lift:${level}`, (id) => used.has(id));
      }
      const unprobed = await meter("lift", () => this.ensureProbes(atLevel, ctx));
      let reviewed: ReadonlySet<string> = new Set();
      if (night) {
        // 270：往上抽的组的追问也按道选（没问过的、有新证据的、待复核和到期的），都记在往上抽这一道；新证据欠不欠它们不算
        if (unprobed.length > 0) night.cut = true;
        const run = await this.judgeByLane(atLevel, night, maxRounds, ctx, report, meter, { first: "lift", rest: "lift", owes: false });
        report.rounds = Math.max(report.rounds, run.rounds);
        reviewed = run.reviewed;
      } else {
        report.rounds = Math.max(report.rounds, await meter("lift", () => this.runProbes(maxRounds, ctx, report, atLevel)));
      }
      this.night("decide", level === "need" ? "需求层按证据定状态" : "价值层按证据定状态", ctx.dropped, () => this.decideAll(at, ctx.view, atLevel, ctx.dropped));
      this.markReviewed(reviewed, at, ctx.dropped);
      onStep({ step: "lift", phase: "end", detail: `${level === "need" ? "需求层" : "价值层"} ${drafts.length} 组` });
    }
  }

  /**
   * 能往上抽的断言：还活着的（已验证、猜测都算，329 号票 R4：把握 low 的、竞争中分不出胜负的也能当前提往上推，推出来的是猜测）；
   * 需求层要偏好、状态，价值层要往上抽出来的需求
   */
  liftInputs(level: LiftLevel, view: RgView): LiftInput[] {
    const inputs: LiftInput[] = [];
    for (const claim of this.store.listClaims({ status: ["active", "contested"] })) {
      const member = this.registry.memberOf(claim.id);
      const group = member ? this.registry.getGroup(member.groupKey) : undefined;
      const lifted = group !== undefined && isLift(group);
      // 199：矛盾根源的假设说的是"为什么对不上"，不往上抽
      const wanted = level === "need" ? (claim.tier === "preference" || claim.tier === "state") && !lifted && !(group !== undefined && isRootGroup(group)) : claim.tier === "need" && group?.pattern === "lift:need";
      if (!wanted) continue;
      const factId = this.registry.explicitFactOf(claim.id);
      const fact = factId ? (this.store.getFact(factId) ?? null) : null;
      if (!group && !fact) continue;
      const params = (group?.params ?? {}) as { daytype?: string | null; domain?: string | null; scenes?: string[][]; activities?: { id: string; name: string }[] };
      // 220：模型出的假设组（pattern = model）没有日子、方面的参数，用模型给这条假设写的场景（没写的照旧为空）；规则版照旧取组的日子和方面
      const groupScene = group?.pattern === "model" ? claim.context : [params.daytype, params.domain].filter((t): t is string => typeof t === "string");
      const scenes = group ? (lifted ? (params.scenes ?? []) : [groupScene]) : [claim.context];
      const entity = fact?.object.type === "entity" ? this.store.getEntity(fact.object.id) : undefined;
      const links = this.store.linksOf(claim.id);
      const factsOf = (polarity: "supports" | "refutes") =>
        links
          .filter((l) => l.polarity === polarity)
          .map((l) => this.store.getFact(l.target))
          .filter((f): f is Fact => f !== undefined && (HELD_STATUSES as readonly string[]).includes(f.status) && view.usableFact(f));
      const supports = factsOf("supports");
      inputs.push({
        claim,
        template: member?.template ?? null,
        groupKey: member?.groupKey ?? null,
        fact,
        scenes,
        // 明说的只有宾语真是个活动时才算（"被提前排满"这类不是活动）
        activities: group ? (params.activities ?? []) : entity && (entity.type === "activity" || entity.type === "event") && !isArrangement(entity.name) && !isRest(entity.name) ? [{ id: entity.id, name: entity.name }] : [],
        supports,
        refutes: factsOf("refutes"),
        supportEvidenceIds: [...new Set(supports.flatMap((f) => evidenceBehind(f.id, view)))],
      });
    }
    return inputs;
  }

  /** 这一层这次没再出来的组：条件不成立了，组撤下（Q2：组里的结论留成猜测，见 retireLiftGroup） */
  private retireLiftGroups(level: LiftLevel, proposed: ReadonlySet<string>, at: string, dropped: DroppedOutput[]): void {
    for (const g of this.registry.listGroups({ live: true })) {
      if (g.pattern !== `lift:${level}` || proposed.has(g.key)) continue;
      this.attempt({ op: "decide", reason: `往上抽的条件不成立了（${g.description}）` }, dropped, () => this.retireLiftGroup(g, at));
    }
  }

  /**
   * 撤下一组往上抽的（条件不成立了：场景只剩一种、证据条数或时期不够……）。
   * Q2（主会话 2026-10-27）：没有推翻者（下层被推翻的，R8 当场就连带撤了），这是证据变少——组里的结论不撤，留成猜测、
   * 把握降一档、前提照挂（StatusKeeper.keepAsGuess）；有直接证实的（R7，比如用户确认过的需求）不动
   */
  private retireLiftGroup(g: GroupRecord, at: string): void {
    this.registry.setGroupLive(g.key, false);
    const droppedPremise = g.observationIds.find((id) => {
      const c = this.store.getClaim(id);
      return c !== undefined && (c.status === "retracted" || c.status === "superseded");
    });
    const cause: RevisionCause = { evidenceId: null, reason: `往上抽的条件不成立了（${g.description}${droppedPremise ? `；${droppedPremise} 不在了` : ""}）` };
    for (const m of this.registry.members(g.key)) {
      const claim = this.store.getClaim(m.claimId);
      if (claim) this.keeper.keepAsGuess(claim, at, cause, this.view(at));
    }
  }

  /**
   * 用户确认了一条断言（by 是本人的证据，比如他对追问的回答）：标 user_confirmed（显示"你确认过"），记一条决定性的支持，
   * 重新定它那组的状态。need、value 的置信度照样最多 medium：用户的话在"他为什么这样"上只是一条证据（第 4.3 节）。
   * 329 号票（R7）：用户亲口确认是直接证实——依据改挂到这份确认上（原来的推理链记作历史），已验证；以后前提被推翻它照样成立。
   * 明说的断言跟着用户那句话走，只记支持、不改挂
   */
  confirmClaim(claimId: string, byEvidenceId: string): Claim {
    return this.engine.gate.write({ op: "verdict", reason: `用户确认结论 ${claimId}（证据 ${byEvidenceId}）` }, () => {
      const claim = this.store.getClaim(claimId);
      if (!claim) throw new Error(`没有这条断言：${claimId}`);
      const evidence = this.store.getEvidence(byEvidenceId);
      if (!evidence) throw new Error(`没有这条证据：${byEvidenceId}`);
      if (!canSupportUserClaims(evidence)) throw new Error(`只有本人有效的证据能确认（${byEvidenceId} 的来源是 ${evidence.sourceLevel}、状态是 ${evidence.status}）`);
      if (claim.status === "retracted") throw new Error(`断言 ${claimId} 已经撤回了，不能确认`);
      const at = this.store.now();
      const cause: RevisionCause = { evidenceId: byEvidenceId, reason: `${USER_CONFIRMATION}${evidence.text}` };
      this.w.putLink({ claimId, target: byEvidenceId, polarity: "supports", weight: "decisive", rationale: `${USER_CONFIRMATION}${evidence.text}` }, cause);
      const patch: Partial<Claim> = { reviewedAt: at };
      if (claim.epistemic === "inferred") Object.assign(patch, { epistemic: "user_confirmed", method: "user_confirmation" });
      this.w.updateClaim(claimId, patch, cause);
      const member = this.registry.memberOf(claimId);
      if (member && this.registry.getGroup(member.groupKey)?.live) {
        this.decideAll(at, this.view(at), (g) => g.key === member.groupKey);
      } else if (claim.epistemic !== "explicit" && claim.status !== "superseded") {
        // 不在活着的组里（组撤了、或者本来就不在组里）：直接改挂到这份确认上、已验证
        const current = this.store.getClaim(claimId)!;
        const direct = this.keeper.directBasis(current, this.view(at), { full: new Map(), independent: new Map() });
        if (direct) {
          this.keeper.attachDirect(current, direct, this.reasoner.id, cause);
          this.w.updateClaim(claimId, { status: "active", retractedBy: null, needsReview: false }, { ...cause, reason: `${cause.reason}（直接证实，已验证）` });
        }
      }
      return this.store.getClaim(claimId)!;
    });
  }

  /**
   * 263 号票：用户说这条断言不对（by 是本人的证据，比如他经记忆管理员的表态）：记一条决定性的反证，重定它那组的状态——
   * 没有决定性的支持就撤回（retractedBy 指向这句话，留墓碑），以后每次整理计分都还是这个结果。不在活着的组里的直接撤回。
   * 明说的断言跟着事实走，不在这里改（要改得纠正、忘掉那句话）。
   * 329 号票（R8）：撤回往上传——建在它上面的（传递），有直接证实的留下，没有的一律撤回
   */
  rejectClaim(claimId: string, byEvidenceId: string): Claim {
    return this.engine.gate.write({ op: "verdict", reason: `用户否认结论 ${claimId}（证据 ${byEvidenceId}）` }, () => {
      const claim = this.store.getClaim(claimId);
      if (!claim) throw new Error(`没有这条断言：${claimId}`);
      const evidence = this.store.getEvidence(byEvidenceId);
      if (!evidence) throw new Error(`没有这条证据：${byEvidenceId}`);
      if (!canSupportUserClaims(evidence)) throw new Error(`只有本人有效的证据能否认（${byEvidenceId} 的来源是 ${evidence.sourceLevel}、状态是 ${evidence.status}）`);
      if (claim.status === "retracted" || claim.status === "superseded") throw new Error(`断言 ${claimId} 已经${claim.status === "retracted" ? "撤回" : "被取代"}了`);
      if (claim.epistemic === "explicit") throw new Error(`明说的断言 ${claimId} 跟着用户说的话走，要改得纠正那句话`);
      const at = this.store.now();
      const cause: RevisionCause = { evidenceId: byEvidenceId, reason: `${USER_DENIAL}${evidence.text}` };
      this.w.putLink({ claimId, target: byEvidenceId, polarity: "refutes", weight: "decisive", rationale: `${USER_DENIAL}${evidence.text}` }, cause);
      this.w.updateClaim(claimId, { reviewedAt: at }, cause);
      const member = this.registry.memberOf(claimId);
      if (member && this.registry.getGroup(member.groupKey)?.live) {
        this.decideAll(at, this.view(at), (g) => g.key === member.groupKey);
      } else {
        this.w.updateClaim(claimId, { status: "retracted", retractedBy: byEvidenceId, needsReview: false, reviewedAt: at }, cause);
        for (const inf of this.store.inferencesOf(claimId)) if (inf.status === "active" || inf.status === "needs_review") this.w.updateInference(inf.id, { status: "retracted" }, cause);
        this.keeper.retractDependents(claimId, at, { ...cause, reason: `前提 ${claimId} 被用户否掉了` }, this.view(at));
      }
      return this.store.getClaim(claimId)!;
    });
  }

  /**
   * 263 号票：给一条断言加复核标记（用户说拿不准、每晚校验不合格）：下一次整理按现有的关联重判。
   * 329 号票："待复核"不占真值状态——只加标记，已验证 / 猜测不变，往下的也不动（真值跟着证据走）。撤回、取代了的不改
   */
  markClaimForReview(claimId: string, cause: RevisionCause, by: { op?: "mark_review" | "validate"; actor?: WriteActor } = {}): Claim {
    return this.engine.gate.write({ op: by.op ?? "mark_review", ...(by.actor === undefined ? {} : { actor: by.actor }), reason: cause.reason }, () => {
      const claim = this.store.getClaim(claimId);
      if (!claim) throw new Error(`没有这条断言：${claimId}`);
      if (claim.status === "retracted" || claim.status === "superseded") throw new Error(`断言 ${claimId} 已经${claim.status === "retracted" ? "撤回" : "被取代"}了`);
      if (claim.needsReview) return claim;
      this.w.updateClaim(claimId, { needsReview: true, reviewedAt: this.store.now() }, cause);
      return this.store.getClaim(claimId)!;
    });
  }

  /**
   * 198 号票：按现有的关联重新定一组的状态和置信度（同 reflect 第 6 步，只这一组）。了解你问题的回答写了支持、反证以后用：
   * 回答得很明确的马上定，不明确的在每日整理里定。
   */
  redecideGroup(groupKey: string): void {
    const at = this.store.now();
    this.engine.gate.write({ op: "decide", reason: `重定 ${groupKey} 这一组` }, () => this.decideAll(at, this.view(at), (g) => g.key === groupKey));
  }

  // ---------- 定状态 ----------

  /** 一组里参加计分的结论：被取代的不算；撤回的只有计分撤的（墓碑指向它自己的反证）算，被推翻、连带撤回的不复活（R11） */
  private scoredMembers(key: string): Claim[] {
    return this.registry
      .members(key)
      .map((m) => this.store.getClaim(m.claimId))
      .filter((c): c is Claim => c !== undefined && c.status !== "superseded" && (c.status !== "retracted" || this.keeper.retractedByScoring(c)));
  }

  /** 一组的打分和判定（不写） */
  decisionsFor(key: string, view: RgView) {
    const members = this.scoredMembers(key);
    const tallies = members.map((c) => tally(c.id, this.store.linksOf(c.id), view));
    return { members, tallies, decisions: decideGroup(tallies) };
  }

  /**
   * 按关联给每组定状态和置信度（第 5 节、第 7.3 节第 5 条：标着复核的在这里重判，摘掉标记）。
   * 267 号票：一组各开一次写（判成立或推翻）；给了 dropped 时被写入口拒了的那一组记进去、别的组照常，没给就照抛
   */
  private decideAll(at: string, view: RgView, only: (g: GroupRecord) => boolean = () => true, dropped?: DroppedOutput[]): void {
    for (const g of this.registry.listGroups({ live: true }).filter(only)) {
      this.attempt({ op: "decide", reason: `按证据定 ${g.key} 这一组的状态` }, dropped, () => this.settleGroup(g, at, view));
    }
  }

  /**
   * 270 号票：这一夜追问全问过一遍的组，组里到期复评的结论记下复核时间（REVIEW_DUE_DAYS 天里不再当到期的重跑）。
   * 一组单开一次写：被写入口拒了只记进 dropped，不连累前面定好的状态
   */
  private markReviewed(keys: ReadonlySet<string>, at: string, dropped: DroppedOutput[]): void {
    for (const key of keys) {
      const due = this.registry
        .members(key)
        .map((m) => this.store.getClaim(m.claimId))
        .filter((c): c is Claim => c !== undefined && isReviewDue(c, at));
      if (due.length === 0) continue;
      this.night("decide", `到期复评：${key} 这一组的追问这一夜全问过一遍，记下复核时间`, dropped, () => {
        for (const c of due) this.w.updateClaim(c.id, { reviewedAt: at }, { reason: "到期复评：这一组的追问这一夜全问过一遍" });
      });
    }
  }

  /**
   * 一组按关联定状态和置信度（329 号票，ADR-0032）：
   * - 决定性反证（证伪）→ 撤回，往上按 R8 传（有直接证实的留下，没有的撤）；
   * - 证据达标（scoring.ts 的分贝计分：领先 6 分贝、有别的假设没有的强支持）→ 推出来的还要前提都已验证（R4 铁律），
   *   或者有直接证实（R7：用户亲口确认，或者只算不靠前提的独立证据也达标；依据改挂上去）才是已验证，不然是猜测；
   * - 别的都是猜测，按把握分高低；从已验证降下来的，往下的已验证跟着降（R4）；计分撤的又回来了，连带撤回的跟着回来（R11）。
   * 依据在（有成立的推断）的摘掉复核标记；依据还在重推（推断停用着）的照旧标着
   */
  /**
   * 按证据定一组的状态。keepFlags：失效传播、彻底删除当场重定时，真值状态当场跟着证据走，复核标记留着（下一次整理重判时摘掉）
   */
  private settleGroup(g: GroupRecord, at: string, view: RgView, options: { keepFlags?: boolean; narrowed?: boolean } = {}): void {
    const { members, tallies, decisions } = this.decisionsFor(g.key, view);
    const judged = { full: decisions, independent: this.keeper.groupDecisions(members, view).independent };
    const lookup = storeLookup(this.store);
    // 330 号票（R12、R13）：要收窄的（事实自己的场景标签能把两边分开），这一组定完再收窄、再定一遍
    const narrowings: { claim: Claim; tags: string[]; outside: Set<string>; reason: string; rivalGroup?: string }[] = [];
    const competitors = this.crossGroupCompetitors(g.key);
    members.forEach((claim, i) => {
      const d = decisions.get(claim.id);
      if (!d) return;
      const confidence = confidenceOf(claim, tallies[i]!);
      const cause = d.retractedBy ? this.causeOf(d.retractedBy, d.reason) : { reason: d.reason };
      if (d.status === "retracted") {
        const patch: Partial<Claim> = { status: "retracted", retractedBy: d.retractedBy, confidence, needsReview: false };
        if (claim.status !== "retracted" || claim.retractedBy !== d.retractedBy || claim.needsReview) patch.reviewedAt = at;
        this.w.updateClaim(claim.id, patch, cause);
        for (const inf of this.store.inferencesOf(claim.id)) if (inf.status === "active" || inf.status === "needs_review") this.w.updateInference(inf.id, { status: "retracted" }, cause);
        if (claim.status !== "retracted") this.keeper.retractDependents(claim.id, at, { ...cause, reason: `前提 ${claim.id} 被推翻了（${d.reason}）` }, view);
        return;
      }
      if (claim.status === "retracted") {
        // 计分撤的又站住了（反证被拿掉）：推理链恢复
        const chain = this.store
          .inferencesOf(claim.id)
          .filter((inf) => !isDirectInference(inf))
          .findLast((inf) => inf.status === "retracted");
        if (chain) this.w.updateInference(chain.id, { status: "active" }, cause);
      }
      // 330 号票（矛盾根源，用户 10-27 选 A）：根源判断是琢磨出来的，只有用户亲口确认（直接证实）才算已验证，不靠计分、不靠独立证据
      const root = isRootGroup(g);
      const found = this.keeper.directBasis(claim, view, judged);
      const direct = root && found?.kind !== "user" ? undefined : found;
      let status: "active" | "contested" = d.status === "active" ? "active" : "contested";
      let reason = d.reason;
      // 330 号票（R12）：碰上还没弄清的有分量的反例——降回猜测、标复核；支持和反例按事实自己的场景标签能分开的收窄
      let flag = d.counterexample !== undefined && !direct;
      if (flag && d.counterexample && !options.narrowed) {
        const supports = this.store.linksOf(claim.id).filter((l) => l.polarity === "supports" && !(d.counterexample!.target === l.target)).map((l) => l.target);
        const tags = separatingTags(supports, [d.counterexample.target], claim.context, view);
        if (tags) narrowings.push({ claim, tags, outside: new Set([d.counterexample.target]), reason: `支持都在${tagsLabel(tags)}，反例 ${d.counterexample.target} 不在（R12 要分场合）` });
      }
      if (direct) {
        this.keeper.attachDirect(claim, direct, this.reasoner.id, cause);
        status = "active";
        reason = direct.kind === "user" ? `用户亲口确认过（直接证实），已验证` : `不靠前提的独立证据达标（直接证实），已验证`;
      } else if (root && status === "active") {
        status = "contested";
        reason = `${reason}；矛盾根源是琢磨出来的判断，没经用户亲口确认只当猜测（用户 10-27 选 A：不豁免铁律）`;
        this.keeper.restoreChain(claim.id, cause);
      } else {
        this.keeper.restoreChain(claim.id, cause);
        const bad = status === "active" ? unverifiedPremises(lookup, claim.id) : [];
        if (bad.length > 0) {
          status = "contested";
          reason = `证据够了，但${ironLawReason(bad)}`;
        }
      }
      // 依据还在重推（推断停用着，没有成立的推断）：不能算已验证，先当猜测、标着复核
      const pending = !this.store.inferencesOf(claim.id).some((inf) => inf.status === "active");
      if (pending && status === "active") {
        status = "contested";
        reason = "依据在重推（前提被删了、推断停用着），先当猜测";
      }
      // 330 号票（R13）：别的组里和它互相竞争、场合对得上、也够已验证的——两条都降回猜测、标复核（各自的支持按场景标签能分开就各自收窄）
      if (status === "active" && !direct) {
        const rival = (competitors.get(claim.id) ?? []).find((other) => this.standaloneVerified(other, claim, view));
        if (rival) {
          status = "contested";
          flag = true;
          reason = `和 ${rival.id}「${rival.statement}」互相矛盾、都够已验证：都降回猜测，等弄清（R13）`;
          if (!options.narrowed) {
            const mine = this.store.linksOf(claim.id).filter((l) => l.polarity === "supports").map((l) => l.target);
            const theirs = this.store.linksOf(rival.id).filter((l) => l.polarity === "supports").map((l) => l.target);
            const tags = separatingTags(mine, theirs, claim.context, view);
            const rivalGroup = this.registry.memberOf(rival.id)?.groupKey;
            if (tags && separatingTags(theirs, mine, [], view))
              narrowings.push({ claim, tags, outside: new Set(theirs.filter((t) => !mine.includes(t))), reason: `和 ${rival.id} 的支持按场合分得开：这条的都在${tagsLabel(tags)}（R13 先试收窄）`, ...(rivalGroup ? { rivalGroup } : {}) });
          }
        }
      }
      const patch: Partial<Claim> = { status, retractedBy: null, confidence, needsReview: pending || flag || (options.keepFlags === true && claim.needsReview) };
      const changed = claim.status !== status || claim.confidence !== confidence || claim.retractedBy !== null;
      if (changed || claim.needsReview) patch.reviewedAt = at;
      this.w.updateClaim(claim.id, patch, { ...cause, reason });
      if (claim.status === "active" && status !== "active") this.keeper.downgradeDependents(claim.id, at, { ...cause, reason: `前提 ${claim.id} 降回猜测（${reason}）` }, view);
      if (claim.status === "retracted") this.keeper.reinstateDependents(claim.id, at, { ...cause, reason: `前提 ${claim.id} 又站住了` });
    });
    if (narrowings.length === 0) return;
    for (const n of narrowings) {
      const current = this.store.getClaim(n.claim.id);
      if (!current || current.status === "superseded" || current.status === "retracted") continue;
      narrowClaim({ store: this.store, registry: this.registry, keeper: this.keeper, reasonerId: this.reasoner.id }, current, n.tags, n.outside, at, { evidenceId: null, reason: n.reason }, view);
    }
    this.settleGroup(g, at, this.view(at), { ...options, narrowed: true });
    // R13：对面那组也按收窄以后的样子再定一遍（它自己的支持也分得开的，这一遍里收窄）
    for (const key of new Set(narrowings.map((n) => n.rivalGroup).filter((k): k is string => k !== undefined && k !== g.key))) {
      const other = this.registry.getGroup(key);
      if (other?.live) this.settleGroup(other, at, this.view(at), options);
    }
  }

  /** 330 号票（R12）：这条结论现在有没有还没弄清的有分量的反例（按它那组的证据算；不在活着的组里的、矛盾根源的没有） */
  openCounterexample(claimId: string, view: RgView = this.view()): Counterexample | undefined {
    const member = this.registry.memberOf(claimId);
    const g = member ? this.registry.getGroup(member.groupKey) : undefined;
    if (!g?.live || isRootGroup(g)) return undefined;
    return this.decisionsFor(g.key, view).decisions.get(claimId)?.counterexample;
  }

  /** 330 号票（R13）：跨组互相矛盾、单看自己那组都够已验证、场合对得上的几对（用户亲口确认了一边的不算） */
  verifiedConflicts(view: RgView = this.view()): [Claim, Claim][] {
    const out: [Claim, Claim][] = [];
    const seen = new Set<string>();
    for (const g of this.registry.listGroups({ live: true })) {
      if (isRootGroup(g)) continue;
      for (const [id, rivals] of this.crossGroupCompetitors(g.key)) {
        const claim = this.store.getClaim(id);
        if (!claim) continue;
        for (const rival of rivals) {
          const key = [id, rival.id].toSorted().join("|");
          if (seen.has(key)) continue;
          seen.add(key);
          if (this.standaloneVerified(rival, claim, view) && this.standaloneVerified(claim, rival, view)) out.push([claim, rival]);
        }
      }
    }
    return out;
  }

  /**
   * 330 号票（R13）：一组里每条结论在别的组里的竞争者（它的 competesWith，加上把它写进 competesWith 的；还活着的；场合对得上的）。
   * 明说的结论不在组里，也算
   */
  private crossGroupCompetitors(groupKey: string): Map<string, Claim[]> {
    const out = new Map<string, Claim[]>();
    const mine = new Set(this.registry.members(groupKey).map((m) => m.claimId));
    if (mine.size === 0) return out;
    const live = this.store.listClaims({ status: ["active", "contested"] });
    const byId = new Map(live.map((c) => [c.id, c]));
    const add = (a: Claim, b: Claim) => {
      if (!mine.has(a.id) || mine.has(b.id) || this.registry.memberOf(b.id)?.groupKey === groupKey) return;
      if (!contextsCompatible(a.context, b.context)) return;
      const list = out.get(a.id) ?? [];
      if (!list.some((x) => x.id === b.id)) list.push(b);
      out.set(a.id, list);
    };
    for (const c of live) {
      for (const id of c.competesWith) {
        const other = byId.get(id);
        if (!other) continue;
        add(c, other);
        add(other, c);
      }
    }
    return out;
  }

  /**
   * 330 号票（R13）：别的组里那条结论单看自己那组的证据够不够已验证（不看它和别的组打不打架，免得两组谁先定谁赢）；
   * 明说的、不在活着的组里的看它现在的状态
   */
  private standaloneVerified(other: Claim, against: Claim, view: RgView): boolean {
    const member = this.registry.memberOf(other.id);
    const group = member ? this.registry.getGroup(member.groupKey) : undefined;
    if (!member || !group?.live) return other.status === "active";
    if (isRootGroup(group)) return false;
    const d = this.decisionsFor(member.groupKey, view).decisions.get(other.id);
    if (d?.status !== "active") return false;
    // 用户亲口确认过的那条赢（当面确认的最有分量），这边让
    return !(this.keeper.directBasis(against, view, { full: new Map(), independent: new Map() })?.kind === "user");
  }

  /** 329 号票：标着复核、不在活着的组里的结论重判（status-keeper.ts 的 rejudge；明说的由 syncExplicit 跟着事实走） */
  private rejudgeLoose(at: string): void {
    const view = this.view(at);
    for (const flagged of this.store.listClaims({ needsReview: true })) {
      const claim = this.store.getClaim(flagged.id);
      if (!claim?.needsReview) continue;
      const member = this.registry.memberOf(claim.id);
      if (member && this.registry.getGroup(member.groupKey)?.live) continue;
      this.keeper.rejudge(claim, at, { evidenceId: null, reason: "整理重判标着复核的" }, view);
    }
  }

  /**
   * 333 号票（全量重判一次，full-rejudge.ts）：每个活着的组（观察模式、往上抽、联动）按新规矩当场重定——R2 证据达标、R4 铁律、
   * R7 直接证实、R12 反例、R13 两条都已验证、R14 当面的才算决定性都在 settleGroup 里；跑之前的复核标记留着。
   * 跑之前到跑之后状态、把握、墓碑、取代者变了的（还活着的）加复核标记：接下来的整理按道重跑它那一组的追问（模型重判），
   * 再按证据定、摘掉标记。一组各开一次写（被写入口拒了只记进 dropped）。交回变了的
   */
  settleForRejudge(at: string, dropped: DroppedOutput[]): string[] {
    const before = new Map(this.store.listClaims().map((c) => [c.id, settleSignature(c)]));
    for (const { key } of this.registry.listGroups({ live: true })) {
      const g = this.registry.getGroup(key);
      if (!g?.live) continue;
      this.attempt({ op: "rejudge", reason: `全量重判：按新规矩重定 ${key} 这一组` }, dropped, () => this.settleGroup(g, at, this.view(at), { keepFlags: true }));
    }
    const changed = this.store
      .listClaims()
      .filter((c) => before.has(c.id) && before.get(c.id) !== settleSignature(c))
      .map((c) => c.id);
    if (changed.length > 0) {
      this.attempt({ op: "rejudge", reason: "全量重判：按新规矩重定以后变了的，加复核标记" }, dropped, () => {
        for (const id of changed) this.keeper.flag(id, { evidenceId: null, reason: "全量重判：按新规矩重定以后变了，接下来重跑它那一组的追问" });
      });
    }
    return changed;
  }

  /** 329 号票：当场按现有的关联重定一组（彻底删除拿掉关联以后用；要在调用方开的那一次写里调）。组不在了就什么都不做 */
  settleGroupNow(groupKey: string, at: string): void {
    const g = this.registry.getGroup(groupKey);
    if (g?.live) this.settleGroup(g, at, this.view(at), { keepFlags: true });
  }

  // ---------- 失效传播（第 7.3 节第 2–6 条；329 号票照原始推理图谱改，ADR-0032） ----------

  /**
   * 证据被忘掉、被纠正，事实被纠正（engine.correct / invalidateEvidence / 抽事实时一条纠正的话）：
   * 1. 明说的结论跟着它那条事实走（followFact：被纠正的撤回、往上按 R8；证据被忘掉而撤回的撤回、往上按"来源失效"；恢复的复活）；
   * 2. 以失效的事实为前提的推断：事实被用户纠正 → 用户亲口否掉，往上按 R8 撤（有直接证实的留下）；事实因为证据被忘掉而撤回、
   *    证据失效 → 来源失效（加复核标记、已验证的降回猜测、悬空的撤；直接证实的那份东西没了就退回原来的推理链）；
   * 3. 指向失效的证据、事实的支持、反证、背景拿掉，那几条加复核标记，它们的组当场按剩下的关联重定（计分撤的复活也在这里，R11）；
   * 4. 恢复了的事实：墓碑指向它的（被连带撤回的）跟着回来（R11）。
   * 纠正本身也是证据：它的事实在下一次 reflect 里按各条假设的预期判（纠正的多重升一档）。
   */
  onInvalidation(event: InvalidationEvent): void {
    const at = this.store.now();
    const view = this.view(at);
    const causeEvidence = event.byEvidenceId ?? event.evidenceId;
    const label =
      event.cause === "evidence_forgotten" ? `证据 ${event.evidenceId} 被忘掉` : event.cause === "evidence_corrected" ? `证据 ${event.evidenceId} 被 ${event.byEvidenceId} 纠正` : `${event.evidenceId} 纠正了事实`;
    const cause = (reason: string): RevisionCause => ({ evidenceId: causeEvidence, reason: `传播：${reason}` });
    // 199：写回时这组根源假设自己不算（它的前提里就有被写回改掉的事实）
    const spared = new Set(event.sparedClaimIds ?? []);

    // 1. 明说的结论跟着事实走
    for (const factId of [...event.retractedFactIds, ...event.restoredFactIds]) {
      const claimId = this.registry.explicitClaimOf(factId);
      const fact = this.store.getFact(factId);
      const claim = claimId ? this.store.getClaim(claimId) : undefined;
      if (!fact || !claim || spared.has(claim.id) || claim.status === "superseded") continue;
      this.followFact(fact, claim, at);
    }

    // 2. 以失效的事实、证据为前提的推断
    for (const factId of event.retractedFactIds) {
      const fact = this.store.getFact(factId);
      if (fact?.status === "corrected") this.keeper.retractDependents(factId, at, cause(`前提 ${factId} 被用户纠正了（${label}）`), view, spared);
      else this.keeper.sourceLost(factId, at, cause(`前提 ${factId} 不在了（${label}）`), view, { spared });
    }
    const dead = [...event.retractedFactIds];
    const evidence = this.store.getEvidence(event.evidenceId);
    if (event.cause !== "fact_corrected" && evidence && evidence.status !== "active") {
      dead.push(event.evidenceId);
      this.keeper.sourceLost(event.evidenceId, at, cause(`前提 ${event.evidenceId} 失效（${label}）`), view, { spared });
    }

    // 3. 拿掉指向失效的证据、事实的关联；那几条加复核标记，它们的组当场重定
    const regroup = new Set<string>();
    const refuted = new Map<string, Set<string>>();
    for (const id of dead) {
      for (const link of this.store.linksTo(id)) {
        if (spared.has(link.claimId)) continue;
        if (link.polarity === "refutes") refuted.set(id, (refuted.get(id) ?? new Set()).add(link.claimId));
        this.w.removeLink(link, cause(`${id} 失效（${label}），拿掉这条${link.polarity === "supports" ? "支持" : link.polarity === "refutes" ? "反证" : "背景"}`));
        if (link.polarity === "context") continue;
        this.keeper.flag(link.claimId, cause(`${link.polarity === "supports" ? "支持" : "反证"} ${id} 失效（${label}），下一次整理重判`));
        const member = this.registry.memberOf(link.claimId);
        if (member) regroup.add(member.groupKey);
      }
    }
    // 推翻者不在了（反证、用户否认的那句被忘掉、被纠正；只认这条结论上真有指向它的反证的）：墓碑指向它的撤回站不住了，复活成猜测（R11），连带撤回的跟着回来；它们的组一起重定
    for (const [id, claimIds] of refuted) {
      for (const claimId of claimIds) {
        const claim = this.store.getClaim(claimId);
        if (claim?.status !== "retracted" || claim.retractedBy !== id) continue;
        for (const revived of this.keeper.reinstate(claim, at, cause(`推翻它的 ${id} 失效了（${label}），复活成猜测`))) {
          const member = this.registry.memberOf(revived);
          if (member) regroup.add(member.groupKey);
        }
      }
    }
    for (const key of regroup) {
      const g = this.registry.getGroup(key);
      if (g?.live) this.settleGroup(g, at, this.view(at), { keepFlags: true });
    }

    // 4. 恢复了的事实：被连带撤回的跟着回来（R11）；恢复成拿不准的，以它为前提的已验证降回猜测（R4）
    for (const factId of event.restoredFactIds) {
      this.keeper.reinstateDependents(factId, at, cause(`事实 ${factId} 恢复了（${label}）`));
      if (this.store.getFact(factId)?.status === "contested") this.keeper.downgradeDependents(factId, at, cause(`前提 ${factId} 恢复成拿不准（${label}）`), this.view(at), spared);
    }
  }

  // ---------- 查询 ----------

  explainClaim(claimId: string): ClaimExplanation {
    return explainClaim(this, claimId);
  }

  tracePremises(claimId: string): PremiseTrace {
    return tracePremises(this, claimId);
  }

  /** 给这条断言跑能找反证的追问（复用它那组的追问；明说的断言按宾语找说法相反的），写关联，返回检索到的 */
  async findCounterevidence(claimId: string): Promise<Hit[]> {
    const claim = this.store.getClaim(claimId);
    if (!claim) throw new Error(`没有这条断言：${claimId}`);
    const at = this.store.now();
    const ctx: ReasonerContext = { view: this.view(at), budget: createBudget(DEFAULT_MAX_MODEL_CALLS), dropped: [] };
    const member = this.registry.memberOf(claimId);
    const hits = new Map<string, Hit>();
    if (member) {
      const group = this.groupView(member.groupKey);
      if (!group) return [];
      const judge = isJointGroup(group) && this.joint ? this.joint : this.reasoner;
      for (const { probeId } of this.registry.probesOf(member.groupKey)) {
        const probe = this.store.getProbe(probeId);
        if (!probe || !probe.discriminates.includes(claimId)) continue;
        const r = await this.runProbe(probe, group, probe.queries, ctx, judge);
        for (const h of r.hits) if (!hits.has(h.evidenceId)) hits.set(h.evidenceId, h);
      }
      this.decideAll(at, ctx.view, undefined, ctx.dropped);
      return [...hits.values()];
    }
    const factId = this.registry.explicitFactOf(claimId);
    const fact = factId ? this.store.getFact(factId) : undefined;
    if (!fact) return [];
    const found = await this.probeSearch([this.objectName(fact)], at, null);
    this.engine.gate.write({ op: "attach", reason: `给明说的结论 ${claimId} 找反证` }, () => {
      for (const { evidence, facts } of this.toJudgeHits(found, ctx.view)) {
        if (!ctx.view.usableEvidence(evidence.id)) continue;
        for (const f of facts) {
          if (f.id === fact.id || !sameObject(f.object, fact.object)) continue;
          const opposite = (f.predicate === fact.predicate && f.negated !== fact.negated) || (f.negated === fact.negated && [f.predicate, fact.predicate].toSorted().join() === "dislikes,prefers");
          if (opposite) this.w.putLink({ claimId, target: f.id, polarity: "refutes", weight: "strong", rationale: `另一次说法相反：${f.statement}` }, this.causeOf(f.id, "找反证"));
        }
      }
    });
    return found;
  }

  getUserModel(query: UserModelQuery = {}): UserModel {
    const at = query.at ?? this.store.now();
    return userModelSnapshot(this.store, this.view(at), { ...query, at });
  }

  answer(question: string, options: AnswerOptions = {}): Promise<Answer> {
    return answerQuestion(this, question, options);
  }

  /** 为问题、任务调出相关的断言（196 号票的三条路，引擎的 relevantUserModel）；202 号票的回答层和 D 组检索用它判相关门槛 */
  relevantUserModel(task: string, options: RelevantUserModelOptions = {}): Promise<RelevantUserModel> {
    return this.engine.relevantUserModel(task, options);
  }

  /** 引擎的向量函数（205 号票：回答层按背景语料校准向量门槛要用）；没给时是 undefined */
  embedder(): Embedder | undefined {
    return this.engine.getEmbedder();
  }

  /** 给任务出建议（196 号票，引擎的 adviseTask）；202 号票的回答层把"帮我……"交给它 */
  adviseTask(task: string, options: AdviseOptions = {}): Promise<TaskAdvice> {
    return this.engine.adviseTask(task, options);
  }

  /** 能当依据的支持证据（给回答、explain 用） */
  evidenceOfTarget(target: string, view: RgView = this.view()): string[] {
    return evidenceBehind(target, view);
  }

  /** 给定一组的状态（演示、回答用） */
  groupRecord(key: string): GroupRecord | undefined {
    return this.registry.getGroup(key);
  }
}
