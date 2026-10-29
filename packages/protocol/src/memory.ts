// 记忆的推理库（rg.db）只读看的形状（233 号票）：网页"记忆"页的结论、证据与推理、问题箱三层从这个契约取。
// - 本文件只是类型和取值表（不引用 TypeBox、不引用 @ergo/memory）：守护进程把 @ergo/memory 的数据映射成这里的视图，
//   网页按它画；两边对"一条结论有哪些字段""哪些状态"看法一致；
// - 给人看的说法（层、状态、把握、认知来源、问题的种类和状态、修订的哪种操作）由网页的状态层 state/memory-graph.ts 按这里
//   的取值表查当前语言，守护进程只回原值，不在这层写死中文；
// - 推理库没建、版本对不上、正被每晚整理占着的时候所有接口照旧 200：ready 是 false，数据是空的，reason 是给人看的一句话
//   （守护进程按当前语言写好）。网页照 reason 和空数据的样子显示，不报错。
// 形状和 @ergo/memory 的 domain/types.ts、rg/types.ts 对得上（那边是唯一的出处；这边只搬网页要用的那部分）。
import { maintainerChannel } from "./constants.ts";

/** 结论的层：近期状态、偏好和目标、稳定需求、长期价值取向（@ergo/memory 的 CLAIM_TIERS） */
export const MEMORY_CLAIM_TIERS = ["state", "preference", "need", "value"] as const;
export type MemoryClaimTier = (typeof MEMORY_CLAIM_TIERS)[number];

/**
 * 结论的状态：已验证、猜测（没验证，按把握分高低）、已撤回、已被取代（@ergo/memory 的 CLAIM_STATUSES）。
 * 329 号票起"待复核"不再是状态，是单独的复核标记（MemoryClaimBrief.needsReview）
 */
export const MEMORY_CLAIM_STATUSES = ["active", "contested", "retracted", "superseded"] as const;
export type MemoryClaimStatus = (typeof MEMORY_CLAIM_STATUSES)[number];

/** 把握 */
export const MEMORY_CONFIDENCES = ["low", "medium", "high"] as const;
export type MemoryConfidence = (typeof MEMORY_CONFIDENCES)[number];

/** 认知来源：用户说的（explicit）、推断的（inferred）、你确认过的（user_confirmed） */
export const MEMORY_EPISTEMICS = ["explicit", "inferred", "user_confirmed"] as const;
export type MemoryEpistemic = (typeof MEMORY_EPISTEMICS)[number];

/** 推法：明说、演绎、归纳、溯因、用户确认（@ergo/memory 的 METHODS） */
export const MEMORY_METHODS = ["explicit", "deduction", "induction", "abduction", "user_confirmation"] as const;
export type MemoryMethod = (typeof MEMORY_METHODS)[number];

/** 证据的来源等级（@ergo/memory 的 SOURCE_LEVELS）：本人、agent 的产出、外部不可信、系统 */
export const MEMORY_EVIDENCE_SOURCES = ["self", "agent", "untrusted", "system"] as const;
export type MemoryEvidenceSource = (typeof MEMORY_EVIDENCE_SOURCES)[number];

/** 证据的有效性：有效、忘掉了、被纠正了 */
export const MEMORY_EVIDENCE_STATUSES = ["active", "forgotten", "corrected"] as const;
export type MemoryEvidenceStatus = (typeof MEMORY_EVIDENCE_STATUSES)[number];

/** 证据或事实和结论的关系：支持、反驳、只当背景（@ergo/memory 的 LINK_POLARITIES） */
export const MEMORY_LINK_POLARITIES = ["supports", "refutes", "context"] as const;
export type MemoryLinkPolarity = (typeof MEMORY_LINK_POLARITIES)[number];

/** 一条关联有多重：弱、强、决定性（@ergo/memory 的 LINK_WEIGHTS） */
export const MEMORY_LINK_WEIGHTS = ["weak", "strong", "decisive"] as const;
export type MemoryLinkWeight = (typeof MEMORY_LINK_WEIGHTS)[number];

/**
 * 推断的状态（@ergo/memory 的 INFERENCE_STATUSES）：成立、停用（前提被删了，等整理重推）、撤回、
 * 历史（329 号票：结论被直接证实以后，原来那条推理链记作历史）
 */
export const MEMORY_INFERENCE_STATUSES = ["active", "needs_review", "retracted", "history"] as const;
export type MemoryInferenceStatus = (typeof MEMORY_INFERENCE_STATUSES)[number];

/** 修订日志的哪种操作（@ergo/memory 的 OBJECT_TYPES 里只有对象类型，操作放在 Revision.op） */
export const MEMORY_REVISION_OPS = ["create", "update", "delete"] as const;
export type MemoryRevisionOp = (typeof MEMORY_REVISION_OPS)[number];

/** 267 号票：推理图谱是谁写的（@ergo/memory 的 WRITE_ACTORS：夜班、记忆管理员、用户的表态、用户发起） */
export const MEMORY_WRITE_ACTORS = ["nightly", "curator", "user_verdict", "user"] as const;
export type MemoryWriteActor = (typeof MEMORY_WRITE_ACTORS)[number];

/** 267 号票：唯一写入口的哪种写操作（@ergo/memory 的 WRITE_OPS） */
export const MEMORY_WRITE_OPS = [
  "ingest",
  "extract",
  "explicit",
  "propose",
  "attach",
  "probe",
  "mark_review",
  "verdict",
  "predict",
  "decide",
  "lift",
  "writeback",
  "validate",
  "correct",
  "forget",
  "purge",
  "no_infer",
  "question",
  "ask",
  "skip",
  "decline",
  "migrate",
  "rejudge",
] as const;
export type MemoryWriteOp = (typeof MEMORY_WRITE_OPS)[number];

/** 问题从哪来（@ergo/memory 的 QUESTION_SOURCES） */
export const MEMORY_QUESTION_KINDS = ["unresolved", "contradiction", "low_confidence_high_value", "tension", "normative", "prediction_violation", "out_of_character", "strategy_basis", "relayed", "counterexample"] as const;
export type MemoryQuestionKind = (typeof MEMORY_QUESTION_KINDS)[number];

/** 问题的状态：在箱子里、问了等回答、答了等判、判过了、"别问这个"、跳过两次退下、过期、不用问了 */
export const MEMORY_QUESTION_STATUSES = ["open", "asked", "answered", "resolved", "declined", "retired", "expired", "obsolete"] as const;
export type MemoryQuestionStatus = (typeof MEMORY_QUESTION_STATUSES)[number];

/**
 * 问题的经过里的一笔（@ergo/memory 的 QUESTION_EVENTS）：生成、顺口问了、跳过一次、跳过两次退下、答了、判过了、"别问这个"、过期、不用问了；
 * 271 号票加了 unsure（每晚整理时记忆管理员拿不准用户有没有在答，留到下一夜）
 */
export const MEMORY_QUESTION_EVENTS = ["created", "asked", "skipped", "retired", "answered", "resolved", "declined", "expired", "obsolete", "unsure"] as const;
export type MemoryQuestionEvent = (typeof MEMORY_QUESTION_EVENTS)[number];

/** 用户的回答读成什么：是、不是、说不好（@ergo/memory 的 AnswerVerdict） */
export const MEMORY_ANSWER_VERDICTS = ["yes", "no", "unclear"] as const;
export type MemoryAnswerVerdict = (typeof MEMORY_ANSWER_VERDICTS)[number];

/** 最近一次整理的状态（照守护进程的 nightly-record.ts）：跑了、这一夜还没跑、跳过了、失败了、要重建推理库 */
export const MEMORY_NIGHTLY_STATES = ["ran", "deferred", "skipped", "failed", "rebuild_needed"] as const;
export type MemoryNightlyState = (typeof MEMORY_NIGHTLY_STATES)[number];

/** 结论列表一次最多给多少条（和守护进程的上限一致） */
export const MEMORY_CLAIMS_MAX = 200;
/** 结论列表不给 limit 时给多少条 */
export const MEMORY_CLAIMS_DEFAULT = 50;
/** 问题箱一次最多给多少个 */
export const MEMORY_QUESTIONS_MAX = 200;
/** 问题箱不给 limit 时给多少个 */
export const MEMORY_QUESTIONS_DEFAULT = 50;

/** 推理库这会儿能不能读：不能读时数据是空的，reason 是给人看的一句话 */
export interface MemoryGraphStatus {
  /** 推理库读得到吗（还没建、版本对不上、正被整理作业占着都是 false） */
  ready: boolean;
  /** 不能读时给人看的一句话（守护进程按当前语言写好） */
  reason?: string;
}

/** 结论列表上的查询条件（GET /api/memory/claims 的查询串） */
export interface MemoryClaimQuery {
  tier?: MemoryClaimTier;
  status?: MemoryClaimStatus;
  limit?: number;
}

/** 列表上的一条结论 */
export interface MemoryClaimBrief {
  /** 编号（cl- 开头） */
  id: string;
  /** 陈述 */
  statement: string;
  tier: MemoryClaimTier;
  status: MemoryClaimStatus;
  /** 329 号票：复核标记（依据刚变了、等下一次整理重判；不改真值状态） */
  needsReview: boolean;
  confidence: MemoryConfidence;
  /** 认知来源 */
  epistemic: MemoryEpistemic;
  /** 最后变化的时间 */
  updatedAt: string;
  /** 成立的场景标签（没推出来是空的） */
  context: string[];
  /** 同一组里的竞争解释有几条 */
  competitors: number;
  /** 支持的证据、事实几条；反驳的几条 */
  supports: number;
  refutes: number;
}

/** 结论列表一页（233 号票，GET /api/memory/claims） */
export interface MemoryClaimListPage extends MemoryGraphStatus {
  /** 符合条件的一共几条（不受 limit 限制） */
  total: number;
  items: MemoryClaimBrief[];
}

/** 结论下面的一条原话 */
export interface MemoryEvidenceQuote {
  id: string;
  /** 原话（忘掉的是空串） */
  text: string;
  sourceLevel: MemoryEvidenceSource;
  mode: "say" | "do";
  kind: string;
  status: MemoryEvidenceStatus;
  /** 这件事发生的时间；不知道是 null */
  eventTime: string | null;
  observedAt: string;
  /** 能不能当关于本人的依据（本人且有效） */
  usable: boolean;
}

/** 结论的一条支持、反驳或背景（证据或事实，带它引的原话） */
export interface MemoryClaimLinkView {
  /** 证据编号或事实编号 */
  target: string;
  kind: "evidence" | "fact";
  /** 目标是事实时它的精炼陈述；证据是 null */
  statement: string | null;
  weight: MemoryLinkWeight;
  /** 为什么算支持、反驳、背景 */
  rationale: string;
  evidence: MemoryEvidenceQuote[];
}

/** 从结论一直追到原话的一棵树（证据链） */
export interface MemoryPremiseNode {
  id: string;
  kind: "claim" | "fact" | "evidence";
  /** 结论、事实的陈述，证据的原话 */
  label: string;
  status: string;
  premises: MemoryPremiseNode[];
  /** 到了深度上限没往下追 */
  truncated?: boolean;
}

/** 一条推断（这条结论是怎么推出来的） */
export interface MemoryInferenceView {
  id: string;
  method: MemoryMethod;
  rationale: string;
  /** rule:<版本> | model:<名> */
  by: string;
  status: MemoryInferenceStatus;
  /** 前提：事实、断言或证据的编号 */
  premiseIds: string[];
  createdAt: string;
}

/** 修订记录里改了一个字段 */
export interface MemoryRevisionChange {
  field: string;
  /** 之前、之后的值（长的截断，值是对象的写成 JSON） */
  from: string;
  to: string;
}

/** 一条修订（只追加的日志） */
export interface MemoryRevisionView {
  seq: number;
  op: MemoryRevisionOp;
  changes: MemoryRevisionChange[];
  reason: string;
  at: string;
  /** 267 号票：留下这条修订的那次写（唯一写入口的留痕）：谁写的、哪种写操作、经谁转达；写入口以前的老修订没有 */
  by?: { actor: MemoryWriteActor; op: MemoryWriteOp; via?: string };
}

/** 结论详情里的那条结论（比列表多几个字段） */
export interface MemoryClaimDetailClaim extends MemoryClaimBrief {
  method: MemoryMethod;
  validFrom: string | null;
  validTo: string | null;
  inferredAt: string;
  reviewedAt: string | null;
  /** 撤回它的证据、事实或断言 */
  retractedBy: string | null;
  supersededBy: string | null;
}

/** 一条结论的完整解释（GET /api/memory/claims/<编号>）：证据链、支持/反对、竞争解释、修订 */
export interface MemoryClaimDetailView extends MemoryGraphStatus {
  /** 没有这条结论（ready 时）是 undefined，接口回 404 */
  claim?: MemoryClaimDetailClaim;
  /** 它所在的观察（推断出来的结论才有） */
  group?: { key: string; pattern: string; description: string };
  supports: MemoryClaimLinkView[];
  refutes: MemoryClaimLinkView[];
  /** 只当背景的（别人转述的，不当依据） */
  background: MemoryClaimLinkView[];
  /** 同一组里的竞争解释 */
  competitors: MemoryClaimBrief[];
  /** 这条结论是怎么推出来的 */
  inferences: MemoryInferenceView[];
  /** 证据链（结论 → 前提 → 事实 → 原话） */
  premises?: MemoryPremiseNode;
  /** 用到的全部原话（去重） */
  evidence: MemoryEvidenceQuote[];
  revisions: MemoryRevisionView[];
  /** 330 号票（R5）：猜测为什么还是猜测——没证实的前提、证据哪里不够（不是猜测的没有） */
  whyGuess?: MemoryGuessReason;
}

/** 330 号票（R5）：一条猜测为什么还是猜测（@ergo/memory 的 GuessReason） */
export interface MemoryGuessReason {
  /** 推理链上没证实的前提（猜测、拿不准、撤回的）；status 是原值 */
  unverifiedPremises: { id: string; statement: string; status: string }[];
  /** 证据哪里不够（一句话，守护进程按推理库的说法给；不缺的是 null） */
  evidence: string | null;
}

/** 交互策略（"做法"）的状态（@ergo/memory 的 STRATEGY_STATUSES）：待确认、在用、暂停（老库才有）、撤回 */
export const MEMORY_STRATEGY_STATUSES = ["proposed", "active", "paused", "retracted"] as const;
export type MemoryStrategyStatus = (typeof MEMORY_STRATEGY_STATUSES)[number];

/** 一条做法（330 号票，GET /api/memory/strategies）：什么场合 → 怎么做，挂着它依据的结论 */
export interface MemoryStrategyView {
  id: string;
  /** 触发场合的说法 */
  when: string;
  /** 怎么做，一条一句 */
  actions: string[];
  status: MemoryStrategyStatus;
  /** R6：建在猜测上（依据里还能用的都是猜测） */
  onGuess: boolean;
  /** R6：依据都不在了——照旧在用，等用户回答"还要不要" */
  basisGone: boolean;
  /** 依据的结论现在的样子（不在了是 missing） */
  basis: { id: string; statement: string; status: MemoryClaimStatus | "missing"; confidence: MemoryConfidence | null }[];
  /** 用户点头的时间；还没点头是 null */
  confirmedAt: string | null;
  createdAt: string;
}

/** 做法列表（330 号票，GET /api/memory/strategies）：不含撤回的 */
export interface MemoryStrategiesView extends MemoryGraphStatus {
  items: MemoryStrategyView[];
}

/** 最近一次整理（网页上一行：哪天、跑了没、新增几条） */
export interface MemoryLastNight {
  /** 哪一夜（YYYY-MM-DD） */
  night: string;
  /** 记这条的时间 */
  at: string;
  state: MemoryNightlyState;
  /** 跑起来的时间（只在 state 是 ran 时有） */
  ranAt?: string;
  /** 新出的结论条数 */
  newClaims: number;
  /** 状态、置信度变了的旧结论条数 */
  changedClaims: number;
  /** 跑完还待复核的条数 */
  needsReview: number;
  /** 没跑成、推后的原因（给人看的一句话） */
  reason?: string;
  /** 记忆管理员这一夜自己额外花了几次模型调用（叙述、判断用；242 号票；没见过的是没有） */
  curatorModelCalls?: number;
}

/**
 * 记忆管理员（242 号票）的 agent 编号和它的会话：按需拉起的 agent（243 号票：起来时只建壳，来输入、到 03:00 才拉起，闲置退出），
 * 每晚 03:00 被唤醒去整理，平时是记忆页上可以找它说话的那一层（#/more/memory/curator）。会话照维护者的频道开（maintainer:<agent id>），网页按这个频道订阅、发消息。
 */
export const MEMORY_CURATOR_AGENT_ID = "memory-curator";
export const MEMORY_CURATOR_CONVERSATION = maintainerChannel(MEMORY_CURATOR_AGENT_ID);

/** 各层的结论数 */
export type MemoryTierCounts = Readonly<Record<MemoryClaimTier, number>>;
/** 各状态的结论数 */
export type MemoryStatusCounts = Readonly<Record<MemoryClaimStatus, number>>;

/** 记忆概览（GET /api/memory/summary） */
export interface MemorySummaryView extends MemoryGraphStatus {
  /** 结论一共几条（所有状态） */
  total: number;
  tiers: MemoryTierCounts;
  statuses: MemoryStatusCounts;
  /** 问题箱里还开着的（open、asked）几个 */
  openQuestions: number;
  /** 最近一次整理；一次都没跑过是 undefined */
  lastNight?: MemoryLastNight;
}

/** 一条问题要弄清的对象（断言或事实）现在的样子 */
export interface MemoryQuestionTargetView {
  id: string;
  /** 330 号票：strategy 是一条做法（"做法的理由没了，还要不要"） */
  kind: "claim" | "fact" | "strategy";
  statement: string;
  /** 断言是 CLAIM_STATUSES、事实是 FACT_STATUSES 的原值；不在了是 missing */
  status: string;
}

/** 一条问题的优先级的几项（@ergo/memory 的 PriorityDetail） */
export interface MemoryQuestionPriority {
  /** 回答能不能直接分出胜负 */
  separation: number;
  /** 几个假设分数有多接近 */
  closeness: number;
  /** 这方面的事常不常遇到 */
  frequency: number;
  /** 还没问过 */
  fresh: number;
}

/** 问题箱里的一条（GET /api/memory/questions） */
export interface MemoryQuestionItem {
  id: string;
  /** 问什么 */
  text: string;
  /** 为什么问 */
  why: string;
  kind: MemoryQuestionKind;
  sources: MemoryQuestionKind[];
  /** 能区分哪几条 */
  targets: MemoryQuestionTargetView[];
  priority: number;
  priorityDetail: MemoryQuestionPriority;
  status: MemoryQuestionStatus;
  /** 方面（taskDomains 的原值） */
  domains: string[];
  askedCount: number;
  skippedCount: number;
  /** 判完了的结果（之前 → 之后，谁胜出）；没有是 null */
  outcome: string | null;
  /** 回答记成的那条证据 */
  answerEvidenceId: string | null;
  /** 回答的原话（264 号票：证据还在、能当依据时有；被忘掉、删掉了是 null） */
  answerText: string | null;
  /** 回答读成什么；还没答是 null */
  verdict: MemoryAnswerVerdict | null;
  /** 回答得很明确（马上判的） */
  clear: boolean;
  /** 最近一次顺口问的时间；没问过是 null */
  lastAskedAt: string | null;
  /** 什么时候答的；没答是 null */
  answeredAt: string | null;
  /** 经过（264 号票：问过、跳过、答了、别问这个……），按先后；detail 是 @ergo/memory 写的一句话 */
  history: MemoryQuestionLogEntry[];
  createdAt: string;
  expiresAt: string;
}

/** 问题经过里的一笔 */
export interface MemoryQuestionLogEntry {
  event: MemoryQuestionEvent;
  detail: string;
  at: string;
}

/** 问题箱（GET /api/memory/questions） */
export interface MemoryQuestionsView extends MemoryGraphStatus {
  /** 一共几个（所有状态） */
  total: number;
  /** 还开着的（open、asked）几个 */
  open: number;
  items: MemoryQuestionItem[];
}
