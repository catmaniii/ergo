// 推理图谱的接口（第 4.3、4.4、7 节）：推理实现（规则版、模型版共用一个接口）、它们交出来的草稿、追问的判定、
// reflect 的报告、用户模型快照、explain、追溯、带证据的回答。断言、关联、推断、追问的类型和存储在 domain/types.ts、store/store.ts。
import type {
  Claim,
  ClaimStatus,
  ClaimTier,
  Derivation,
  Confidence,
  Entity,
  Evidence,
  EvidenceKind,
  EvidenceStatus,
  Fact,
  Inference,
  LinkPolarity,
  LinkWeight,
  Method,
  Mode,
  PredictionRecord,
  Probe,
  Revision,
  SourceLevel,
  StoredLink,
  WriteActor,
  WriteOp,
} from "../domain/types.ts";
import type { StageStatsMap } from "../llm/robust.ts";
import type { Hit } from "../retrieval/types.ts";
import type { TaskAdvice } from "./advice.ts";
import type { QuestionKind } from "./question.ts";
import type { PredictionJudge, PredictionStats } from "./predictions.ts";
import type { RelevanceGate } from "./relevance.ts";
import type { ReflectSpend } from "./nightly-lanes.ts";

// ---------- reflect ----------

export interface ReflectOptions {
  /** 从哪条证据之后接着整理（按发生时间的顺序，这条之后的都当新的再整理一遍）；不给 = 接着上次（没整理过的） */
  since?: string;
  /** 追问检索最多几轮（1 或 2，默认 2；第二轮用第一轮找到的东西扩展查询，没有新证据就停） */
  maxRounds?: number;
  /** 这一次最多调几次模型（规则版不调；默认 DEFAULT_MAX_MODEL_CALLS） */
  maxModelCalls?: number;
  /** 226 号票：判到期预测的模型；不给就只记账本、到期预测留 open（下夜或者给了模型再判） */
  predictionJudge?: PredictionJudge;
  /** 226 号票：这次最多判几条到期预测（默认 rg/predictions.ts 的 MAX_DUE_PREDICTIONS）；每夜第二次 reflect 传 0，保证一夜总共最多 10 条 */
  predictionDueLimit?: number;
  /** 237 号票：每一步开始、结束时报一下（建库 CLI 打带时间戳的进度、卡住时一眼看出停在哪一步；不报就什么都不做） */
  onStep?: (event: ReflectStepEvent) => void;
  /**
   * 271 号票：判顺口问的回答那一道（每晚整理交来，rg/reply-judge.ts）。reserve 是保底几次：从前段里划出来，新证据那几步最多用到
   * 前段减掉它；reflect 在新证据那一道问完追问、重跑旧追问之前调 run（只调一次），给的预算至少还有 reserve 次、新证据没用完的前段也给它；
   * 没有新证据的夜里也照样调。花的次数记在 spend.replies
   */
  replies?: ReflectRepliesLane;
  /**
   * 333 号票：全量重判一次（full-rejudge.ts 调）——只按新规矩重判已有的结论：不碰新证据（不抽事实、不出新假设、不记整理过，
   * 新证据留给下一次每晚整理），没有新证据、没有标着复核的也照跑；别的步骤（明说的跟着事实走、转述、追问按道重跑标着复核的组、
   * 联动、往上抽、写回、重判、对抗复核、预测、编策略）和每晚整理是同一套
   */
  full?: boolean;
}

/** 271 号票：交给 reflect 的判回答那一道 */
export interface ReflectRepliesLane {
  /** 保底几次（不超过前段） */
  reserve: number;
  /** 用给的预算判（每问一次模型 take 一次；take 不到就停，没判的留到下一夜） */
  run(budget: ModelBudget): Promise<void>;
}

/** 237 号票：整理走到哪一步了 */
export type ReflectStep = "extract" | "propose" | "probes" | "judge" | "replies" | "joint" | "lift" | "writeback" | "questions" | "review" | "prediction" | "strategies";

/** 237 号票：一步开始了（start）或者做完了（end）；detail 是一句说明（几条、几组、跳过原因……） */
export interface ReflectStepEvent {
  step: ReflectStep;
  phase: "start" | "end";
  detail?: string;
}

/** 模型输出里被丢掉的一项：伪造的证据 id、对不上的字段 */
export interface DroppedOutput {
  /** 201 号票加了 lift（往上抽）、strategies（编交互策略）；227 号票加了 review（对抗复核）；267 号票加了 gate（唯一写入口拒了的写，item 是不合格的地方） */
  stage: "extract" | "propose" | "probes" | "judge" | "lift" | "strategies" | "review" | "gate";
  reason: string;
  item?: unknown;
}

// ---------- 对抗复核（227 号票） ----------

/** 交给复核员的输入：候选结论的 id、结论原文、支持它的证据原话（已打乱、最多 8 条） */
export interface ReviewInput {
  claimId: string;
  statement: string;
  observations: string[];
}

/** 复核员的判断：先写自己从观察推出的结论，再判候选结论支不支持 */
export interface ReviewVerdict {
  /** yes 支持、no 不支持、unclear 看不出来 */
  support: "yes" | "no" | "unclear";
  why: string;
  /** 先写下的、从观察原话自己推出的结论（没看候选结论之前的那一步） */
  inference: string;
}

/** 一次整理里对抗复核做了什么（reflect 末尾一步；整理报告展示它） */
export interface AdversarialReviewReport {
  /** 复核了这几条（判过、记下来了） */
  reviewed: string[];
  /** 判 no、改成待复核的（进整理报告的 rejectedByReview） */
  rejectedByReview: string[];
  /** 判 unclear 的条数（只看数，结论不动） */
  unclear: number;
  /** 这一步调了几次模型（单独预算，最多 5 次） */
  modelCalls: number;
  /** 预算用完了，剩下的下夜再判 */
  budgetExhausted: boolean;
  /** 没复核的原因（没有要复核的结论、没有支持证据原话……） */
  skipped?: string;
}

export interface ReflectReport {
  /** 这次新整理的证据（270 号票起模型版整理完一条记一条；规则版预算用完的那次是空的） */
  processedEvidenceIds: string[];
  newClaimIds: string[];
  /** 状态、置信度、有效期、竞争关系有变化的旧断言 */
  changedClaimIds: string[];
  /** 这次跑过的追问（270 号票起模型版只算真问了的：预算用完没轮到的不算） */
  probeIds: string[];
  modelCalls: number;
  /** 追问检索跑了几轮 */
  rounds: number;
  /** 模型调用的预算用完了，没做完的留给下一次 */
  budgetExhausted: boolean;
  dropped: DroppedOutput[];
  /** 什么都没做的原因（没有新证据、也没有待复核的） */
  skipped?: string;
  /** 模型版在整理末尾编的交互策略（201 号票；推理实现有 writeStrategies 时才有） */
  strategies?: { created: string[]; updated: string[] };
  /** 199 号票：知识图谱和推理图谱联动（关掉时没有） */
  joint?: JointReflectReport;
  /** 218 号票：每一步的模型调用（调用、截断、解析不了、救回、恢复、放弃）、往上抽没过门槛的原因 */
  stats?: ReasoningStats;
  /** 226 号票：预测账本这一步做了什么（新记、到期判、判的结果、还开着几条） */
  predictions?: PredictionStats;
  /** 227 号票：这次整理末尾的对抗复核（没给复核模型时没有） */
  review?: AdversarialReviewReport;
  /** 270 号票：这次的预算按道花了几次（新证据、重跑旧追问、往上抽、判预测、编策略；对抗复核另算，在 review.modelCalls） */
  spend?: ReflectSpend;
  /** 270 号票：跑完还有几条新证据没整理完（预算用完没轮到的，下一次按时间先后接着做） */
  backlog?: number;
}

/** 218 号票：一次整理（或建库）里推理每一步的模型调用统计、往上抽门槛的判法结果（rg/build-stats.ts 合并、汇总） */
export interface ReasoningStats {
  /** 每一步（extract、propose、probes、judge、lift、strategies）的调用统计（llm/robust.ts） */
  steps: StageStatsMap;
  lift: LiftGateStats;
}

/** 往上抽的门槛哪一条没过（rg/llm-lift.ts 的 liftThreshold；门槛的数见 rg/lift.ts） */
export const LIFT_GATE_REASONS = ["场景不够", "月份不够", "证据条数不够"] as const;
export type LiftGateReason = (typeof LIFT_GATE_REASONS)[number];

/** 模型交回的一组没过门槛：差在哪 */
export interface LiftGateFailure {
  level: LiftLevel;
  reasons: LiftGateReason[];
  /** 它挑了几条下层断言 */
  premises: number;
  /** 有没有两种不同的场合（229 号票起只看方面维度判不同：方面标签不同才算两种；严格判定只在 LiftGateStats 里另记）、几种场景（合并以后）、几个月、几条证据、证据前后跨几天 */
  disjointScenes: boolean;
  scenes: number;
  months: number;
  evidence: number;
  spanDays: number;
}

export interface LiftGateStats {
  /** 过了门槛的组：模型交回、按它挑的下层断言再判过的，加上规则版按主题出出来的 */
  passed: number;
  /** 223 号票：过的组里，老严格判定（双方都写了标签的维度全都无交集）也过的几组 */
  passedStrict: number;
  /** 229 号票：过的组里，只按新判定（方面维度的标签不同，或者两边都没有方面时不认得的标签不同）才过的几组；passed = passedStrict + passedLoose */
  passedLoose: number;
  /**
   * 256 号票：结构门槛（两种场合、两条以上证据）过了、只是月份或证据条数还不够的组——照样出结论，
   * 标成临时的，置信度按薄的压着（不进 passed，免得和 229 那次的口径混在一起）
   */
  provisional: number;
  /** 临时结论是因为哪条软门槛（月份不够、证据条数不够） */
  provisionalByReason: Partial<Record<LiftGateReason, number>>;
  failed: number;
  /** 没过的按哪一条没过计数（一组差两条的两条各算一次） */
  byReason: Partial<Record<LiftGateReason, number>>;
  failures: LiftGateFailure[];
  /** 问模型之前这一层全体就没过门槛、或者没有新的下层断言（不问），按"层：原因"计数 */
  notAsked: Record<string, number>;
  /** 不是门槛、写入前丢掉的组或字段，按原因计数（上位解释不到两条、和已有的组重复、没有能用的下层断言、领域不认得……） */
  rejected: Record<string, number>;
}

/** 199 号票：这次整理里联动做了什么 */
export interface JointReflectReport {
  /** 还成立的对比模式那几组、矛盾根源那几组 */
  motifGroups: string[];
  conflictGroups: string[];
  /** 这次写回、撤回写回的（定根源的断言） */
  writebacks: { applied: string[]; reverted: string[] };
  /** 这次新进"了解你问题"队列的 */
  questions: string[];
}

// ---------- 推理实现 ----------

/** 推理实现能看的东西（只读）：都按"现在"（at）算 */
export interface RgView {
  at: string;
  fact(id: string): Fact | undefined;
  evidence(id: string): Evidence | undefined;
  entity(id: string): Entity | undefined;
  entityName(id: string): string;
  /** 这条证据抽出的、在 at 成立的事实 */
  factsOfEvidence(evidenceId: string): Fact[];
  /** 能当关于用户的依据：本人且有效（evidence/boundary.ts） */
  usableEvidence(evidenceId: string): boolean;
  /** 事实是本人的（用户说的、观察到的），而且至少有一条能当依据的证据 */
  usableFact(fact: Fact): boolean;
  /** 这条证据是用户的纠正：种类是 correction，或者事实这一层判定它纠正了旧事实 */
  isCorrection(evidenceId: string): boolean;
}

/** 模型调用的预算 */
export interface ModelBudget {
  readonly limit: number;
  readonly used: number;
  /** 还有就记一次、返回 true；用完了返回 false */
  take(): boolean;
  readonly exhausted: boolean;
}

export interface ReasonerContext {
  view: RgView;
  budget: ModelBudget;
  /** 丢掉的模型输出记在这里 */
  dropped: DroppedOutput[];
  /** 已经有的组（模型版只给新的观察出假设，不重复建） */
  existingGroups?: GroupView[];
  /** 218 号票：每一步的调用统计、往上抽门槛的结果记在这里（reflect 建，不给就不记） */
  stats?: ReasoningStats;
  /** 272 号票：问过、没变化就不再问的账（reflect 给模型版建；不给就每次照问） */
  asked?: AskLedger;
}

/** 272 号票：账上分的几步（出假设、往上抽的两层） */
export type AskStep = "propose" | "lift:need" | "lift:value";

/**
 * 272 号票：模型版问过、没变化就不再问的账。出假设的观察、往上抽的下层断言问过一次、模型回了话、又没进组的，下一夜签名
 * （陈述、状态、证据这些）没变就不再当这一批问——它在别的观察、下层断言的请求里照样只给摘要，可以一起归组；有了新证据（签名变了）才再问
 */
export interface AskLedger {
  /** 这一条上次问到时的签名；没问过是 undefined */
  signature(step: AskStep, subject: string): string | undefined;
  /** 这次问到了（模型回了话）的几条：这一步做完以后，还没进组的才记下（进了组的不记，以后组撤了还会再问） */
  settle(step: AskStep, entries: ReadonlyArray<{ subject: string; signature: string }>): void;
}

/** 一条关联的草稿（目标是事实或证据的 id） */
export interface TargetLink {
  target: string;
  polarity: LinkPolarity;
  weight: LinkWeight;
  rationale: string;
}

export interface LinkDraft extends TargetLink {
  claimId: string;
}

/** 一条竞争假设的草稿 */
export interface HypothesisDraft {
  /** 规则版是模板 id；模型版是 model:<序号> */
  template: string;
  tier: ClaimTier;
  statement: string;
  context: string[];
  validFrom: string | null;
  /** state 必须有（默认 14 天） */
  validTo: string | null;
  method: Extract<Method, "deduction" | "induction" | "abduction">;
  /** 226 号票：这条解释当时写下的预测（一句话，两周内可以被验证）；没有就是 undefined，结论的 predicts 留空 */
  predicts?: string;
  /**
   * 330 号票（R10）：这条预测的推法。不给按 defeasible；规则版的模板都是"还会、接下来两周"的倾向，不给；
   * 模型版只有结论陈述里真有全称说法时才认 deductive（predictions.ts 的 predictionDerivation，ADR-0032）
   */
  predictsDerivation?: Derivation;
  /** 观察和同一批证据里别的事实对它的关联 */
  links: TargetLink[];
}

/** 一组竞争假设：同一个观察模式的几种解释，至少两条才算竞争 */
export interface HypothesisGroupDraft {
  /** 同样的观察得到同样的 key（再整理一次不重复建） */
  key: string;
  pattern: string;
  params: Record<string, unknown>;
  /** 一句话：观察到了什么 */
  description: string;
  /** 观察到的事实（推断的前提） */
  observationIds: string[];
  hypotheses: HypothesisDraft[];
  /**
   * 256 号票：先出结论、但标"临时"（软门槛没过：月份不够、证据不到 3 条）。
   * 置信度由 scoring 按"证据薄"压到 low；跨度够了以后重抽 + rescore 会自己升上去
   */
  provisional?: boolean;
}

/** 已经建好的一组 */
export interface GroupView {
  key: string;
  pattern: string;
  params: Record<string, unknown>;
  description: string;
  observationIds: string[];
  members: { claim: Claim; template: string }[];
}

/** 一条判别性追问的草稿；discriminates 是组里断言的 id */
export interface ProbeDraft {
  template: string;
  discriminates: string[];
  /** 问用户的问法：问具体的事，不问动机 */
  ask: string;
  /** 第二轮检索用的查询（短语） */
  queries: string[];
  /** 找到了支持哪一条；事前不知道是 null */
  ifFound: string | null;
}

/** 交给 judge 的一条检索结果：命中、证据、证据抽出的事实 */
export interface JudgeHit {
  hit: Hit;
  evidence: Evidence;
  facts: Fact[];
}

export interface ProbeJudgement {
  /** 找到了能区分的证据（不管偏向哪一边）；搜不到是 not_found，判 inconclusive，不判负 */
  outcome: "found" | "not_found";
  foundEvidenceIds: string[];
  /** 事前不知道的追问，找到以后填上支持的那一条 */
  ifFound: string | null;
  /** 找到的证据对组里各条假设的关联（别人转述的只能是 context） */
  links: LinkDraft[];
}

/**
 * 推理实现（第 7.1 节）：规则版 RuleReasoner、模型版 LlmReasoner。都是异步的（模型版要发请求）。
 * 状态和置信度不归它管：由 rg/scoring.ts 按关联统一算（两种实现一个规矩）。
 */
export interface Reasoner {
  /** rule:<版本> | model:<名>，记在推断的 by 上 */
  readonly id: string;
  /**
   * propose 每次都按全部观察重新认一遍模式（规则版）：它建的组这次没再认出来，就是模式不成立了（组撤下：结论被新组取代，或者留成猜测）。
   * 不是（模型版只看新的观察）时，组只在观察不够两条时撤下。
   * 270 号票：明确写 false 的（模型版，增量）整理时预算按道花（rg/nightly-lanes.ts）：追问先问没问过的、检索结果里有新证据的，
   * 剩下的预算才重跑待复核、到期复评的组，别的旧追问不重判；整理完一条新证据记一条。true 或没写的照旧每次全部重跑
   */
  readonly exhaustive?: boolean;
  /** 观察 → 竞争假设分组（每组至少两条） */
  propose(observations: Fact[], ctx: ReasonerContext): Promise<HypothesisGroupDraft[]>;
  /** 一组竞争假设 → 能区分它们的追问 */
  probesFor(group: GroupView, ctx: ReasonerContext): Promise<ProbeDraft[]>;
  /** 追问的检索结果 → 找到了没有、各条证据对各条假设的关联 */
  judge(probe: Probe, group: GroupView, hits: JudgeHit[], ctx: ReasonerContext): Promise<ProbeJudgement>;
  /**
   * 抽跨场景、跨时期的不变量（195 号票，可选）：level = need 时输入是成立的偏好、状态断言，level = value 时是成立的需求断言；
   * 同一主题在两种以上场景、两个以上时期都成立，出上一层的一组竞争假设（观察 = 这些断言）。规则版实现，模型版暂不实现
   */
  lift?(level: LiftLevel, inputs: LiftInput[], ctx: ReasonerContext): Promise<HypothesisGroupDraft[]>;
  /**
   * 把成立的需求、价值写成交互策略（201 号票，可选；模型版实现）：每个依据一条"什么场合 → 怎么做"。
   * 引擎在 reflect() 末尾调，用同一次 reflect 剩下的预算；写出来的照旧是 proposed，本人确认才 active
   */
  writeStrategies?(bases: StrategyBasisInput[], ctx: Pick<ReasonerContext, "budget" | "dropped" | "stats">): Promise<WrittenStrategy[]>;
}

/** 交给推理实现写策略的一个依据（201 号票）：同一主题的成立的需求、价值 */
export interface StrategyBasisInput {
  /** 照抄回来的 key（同 Strategy.key） */
  key: string;
  claims: { claimId: string; tier: ClaimTier; statement: string; label: UserModelEntry["label"]; confidence: Confidence }[];
  scenes: string[][];
  activities: string[];
  domains: string[];
}

/** 推理实现写出来的一条策略（校验过的） */
export interface WrittenStrategy {
  key: string;
  when: string;
  actions: string[];
  domains: string[];
}

/** 往上抽的层：偏好、状态 → 需求；需求 → 长期价值取向 */
export type LiftLevel = "need" | "value";

/** 往上抽的一条输入：一条成立的断言，带它成立的场景和依据 */
export interface LiftInput {
  claim: Claim;
  /** 推断的：它那组的模板和组；明说的是 null */
  template: string | null;
  groupKey: string | null;
  /** 明说的断言对应的事实 */
  fact: Fact | null;
  /**
   * 它成立的场景：推断的取它那组的日子和方面（往上抽出来的取各场景的并；220 号票起模型出的组取模型给这条假设写的场景），
   * 明说的取断言的场景
   */
  scenes: string[][];
  /** 涉及的活动：推断的取它那组的，明说的取事实的宾语 */
  activities: { id: string; name: string }[];
  /** 能当依据的支持事实、反驳事实 */
  supports: Fact[];
  refutes: Fact[];
  /** 支持背后能当依据的证据 */
  supportEvidenceIds: string[];
}

// ---------- 用户模型 ----------

export interface UserModelQuery {
  /** 默认现在 */
  at?: string;
  context?: string[];
}

export interface UserModelEntry {
  claimId: string;
  statement: string;
  tier: ClaimTier;
  /** 用户说的 / 推断的 / 你确认过的 */
  label: "user_stated" | "inferred" | "user_confirmed";
  confidence: Confidence;
  /** 支持它的证据（只有本人的有效证据） */
  evidenceIds: string[];
  context: string[];
  validFrom: string | null;
  validTo: string | null;
  /** 近期状态可以是 low，但要标出来 */
  lowConfidence?: boolean;
  /** 330 号票：标着复核（依据刚变了、等下一次整理重判）——照它的真值状态给，标出来 */
  needsReview?: boolean;
}

/**
 * 还拿不准的一条（330 号票 R5：猜测也给，标明是猜测、把握多少）：contested 是猜测（没验证）；thin 是已验证、证据还不够（把握 low）
 */
export interface UncertainEntry {
  claimId: string;
  statement: string;
  tier: ClaimTier;
  /** contested：猜测（没验证，竞争中的、前提没证实的都算）；thin：已验证、证据还不够（置信度不到 medium） */
  reason: "contested" | "thin";
  /** 330 号票：真值状态（contested 猜测 / active 已验证） */
  status: ClaimStatus;
  /** 330 号票：把握 */
  confidence: Confidence;
  /** 330 号票：用户说的 / 推断的 / 你确认过的 */
  label: UserModelEntry["label"];
  competesWith: string[];
  competitors: { claimId: string; statement: string; status: ClaimStatus }[];
  evidenceIds: string[];
  /** 330 号票：标着复核 */
  needsReview?: boolean;
}

export interface UserModel {
  at: string;
  context: string[];
  state: UserModelEntry[];
  preferences: UserModelEntry[];
  /** 稳定需求和长期价值取向合在这一层 */
  values: UserModelEntry[];
  /** 还拿不准的单列：contested 的附上竞争的那几条；证据还不够的也在这里 */
  uncertain: UncertainEntry[];
  /** 用户确认过、依据在 at 还成立的交互策略（196 号票；userModelSnapshot 总会填） */
  strategies?: StrategyEntry[];
}

/** 用户模型快照里的一条交互策略（196 号票，rg/strategies.ts） */
export interface StrategyEntry {
  strategyId: string;
  when: string;
  actions: string[];
  /** 触发场合：做法一；做法二 */
  text: string;
  basisClaimIds: string[];
  domains: string[];
  confirmedBy: string | null;
  /** 330 号票（R6）：建在猜测上（依据里还活着的都是猜测、没有已验证的） */
  onGuess: boolean;
  /** 330 号票（R6）：依据都不在了（被推翻、被取代）——做法照旧在用，等用户回答"还要不要" */
  basisGone: boolean;
}

// ---------- explain、追溯 ----------

export interface EvidenceView {
  id: string;
  text: string;
  sourceLevel: SourceLevel;
  mode: Mode;
  kind: EvidenceKind;
  status: EvidenceStatus;
  eventTime: string | null;
  observedAt: string;
  /** 能不能当关于用户的依据（本人且有效） */
  usable: boolean;
}

export interface ExplainedLink extends StoredLink {
  /** 目标是事实时它的精炼陈述 */
  statement: string | null;
  /** 330 号票（R14）：计分时算多重（随口说的"决定性"按强的算；和 weight 一样时也写） */
  counted?: StoredLink["weight"];
  /** 原话（目标是事实时经它的 evidenceIds） */
  evidence: EvidenceView[];
}

/** 从一条断言一直追到证据 */
export interface PremiseTrace {
  id: string;
  kind: "claim" | "fact" | "evidence";
  /** 断言、事实的陈述，证据的原文 */
  label: string;
  status: string;
  premises: PremiseTrace[];
  /** 到了深度上限没往下追 */
  truncated?: boolean;
}

/** 330 号票（R5）：一条猜测为什么还是猜测——没证实的前提（R4 铁律压着），和证据哪里不够（一句话；不缺的是 null） */
export interface GuessReason {
  unverifiedPremises: { id: string; statement: string; status: string }[];
  evidence: string | null;
}

export interface ClaimExplanation {
  claim: Claim;
  /** 它所在的那组竞争假设（明说的、单独的断言是 null） */
  group: { key: string; pattern: string; description: string } | null;
  inferences: Inference[];
  supports: ExplainedLink[];
  refutes: ExplainedLink[];
  /** 只当背景的（别人转述的） */
  background: ExplainedLink[];
  competitors: Claim[];
  probes: Probe[];
  premises: PremiseTrace;
  /** 330 号票（R5）：猜测为什么还是猜测（不是猜测的是 null） */
  whyGuess: GuessReason | null;
  /** 330 号票（R10）：从它推出来的预测节点（它是来源之一的） */
  predictions: PredictionRecord[];
  /** 用到的全部原话 */
  evidence: EvidenceView[];
  /** 修订（267 号票：每条带上是哪一次写留下的——谁写的、哪种写操作、经谁转达；唯一写入口以前的老修订没有） */
  revisions: ExplainedRevision[];
  /** 拼好的一段说明（演示用） */
  text: string;
}

// ---------- 带证据的回答 ----------

export interface AnswerOptions {
  at?: string;
  context?: string[];
  /** 这一次用的相关门槛（202 号票）；不给用引擎配的（relevanceGate），再不给用 DEFAULT_RELEVANCE_GATE */
  gate?: Partial<RelevanceGate>;
}

/**
 * 回答里一条引用的角色（192 号票，评测按它分"断言了什么"）：
 * conclusion：比较可能的解释（推断的断言，当结论说）；stated：用户说过的（明说的断言）；record：检索到的记录（事实、原话）；
 * open：还没排除、拿不准的（202 号票起也包括互相矛盾的记录、只是同一方面的背景）；excluded：已经排除的（证据是撤回它的那句话）；
 * counter：和结论不太一致的、某条解释的反证
 */
export type CitationRole = "conclusion" | "stated" | "record" | "open" | "excluded" | "counter";

export interface Citation {
  claimId: string | null;
  factId: string | null;
  evidenceIds: string[];
  text: string;
  role?: CitationRole;
}

export interface Answer {
  question: string;
  /** 问题分流的结果（202 号票，rg/question.ts）：事实回忆、关于自己的判断、为什么、任务和建议 */
  kind: QuestionKind;
  /** 事实回忆走检索；关于自己的判断、为什么走推理图谱（查用户模型和推理图谱）；任务走 adviseTask（advice）；llm：大模型读记忆简报回答（216 号票，llm/answerer.ts） */
  route: "retrieval" | "reasoning" | "advice" | "llm";
  /** 回答文字（模板拼的，或大模型写的），每个论断后面带证据 id */
  text: string;
  /** 证据不足、竞争假设没分出来时是 false（回答里明说"不确定"） */
  certain: boolean;
  citations: Citation[];
  /** 能区分的追问（不确定时给） */
  probes: { probeId: string | null; ask: string }[];
  /** 不确定时缺什么证据（202 号票）；有结论时是空的 */
  missing: string[];
  hits: Hit[];
  /** 任务走 adviseTask 时的完整建议 */
  advice?: TaskAdvice;
}

/** 267 号票：一条修订和留下它的那次写（唯一写入口的留痕） */
export type ExplainedRevision = Revision & { by?: { actor: WriteActor; op: WriteOp; via: string | null } };
