// 记忆 PoC 的数据模型（docs/memory-architecture.md 第 4 节）：证据、实体、事实、断言、关联、推断、追问、修订。
// 这里只有类型和枚举；校验在 validate.ts，id 在 ids.ts，时间在 time.ts。
// 时间一律是带时区的 ISO 8601 字符串（合成数据写 +08:00），比较先换成毫秒（time.ts）。
// 四个时间分开记（第 5 节）：eventTime 发生的时间、observedAt 二狗知道的时间、validFrom / validTo 有效期、inferredAt / reviewedAt 推断和复核的时间。

// ---------- 证据 ----------

/** 来源等级，同二狗的素材（二狗那边的 external_untrusted 在这里写 untrusted） */
export const SOURCE_LEVELS = ["self", "agent", "untrusted", "system"] as const;
export type SourceLevel = (typeof SOURCE_LEVELS)[number];

/** 说还是做，同二狗 */
export const MODES = ["say", "do"] as const;
export type Mode = (typeof MODES)[number];

/**
 * 证据的种类：合成数据用的这几种（188 号票定的 events.json 格式），另加 event（不是用户说的或做的、只是发生了的事）。
 * 接二狗时由素材库适配器把素材类型对上来：发言、澄清回答、投喂、记忆命令 → utterance，对产出的反应 → reaction，
 * 审批 → approval，任务结局、回避信号 → action。
 */
export const EVIDENCE_KINDS = ["utterance", "action", "approval", "reaction", "correction", "event"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** active 有效；forgotten 被忘掉（原文清空、索引删掉）；corrected 被用户纠正（原文留着当记录） */
export const EVIDENCE_STATUSES = ["active", "forgotten", "corrected"] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

export interface Evidence {
  /** ev- 开头 */
  id: string;
  sourceLevel: SourceLevel;
  mode: Mode;
  kind: EvidenceKind;
  /** 原文。被忘掉后是空串 */
  text: string;
  /** 情境标签，如 weekend、workday、social、work */
  context: string[];
  /** 事情发生的时间；null = 不知道 */
  eventTime: string | null;
  /** 二狗知道的时间 */
  observedAt: string;
  /** 出处：合成数据是 fixture:<事件 id>，接二狗时是素材 id；不知道是 null */
  sourceRef: string | null;
  /** 原文的 sha256（入库时算，忘掉后保留） */
  contentHash: string;
  status: EvidenceStatus;
}

/** 写入证据时给的（id、内容哈希、状态由入库时定） */
export interface EvidenceDraft {
  /** 不给就由存储分配 ev-NNNN；合成数据沿用事件 id */
  id?: string;
  sourceLevel: SourceLevel;
  mode: Mode;
  kind: EvidenceKind;
  text: string;
  context: string[];
  eventTime: string | null;
  observedAt: string;
  sourceRef?: string | null;
}

// ---------- 实体 ----------

export const ENTITY_TYPES = ["person", "place", "activity", "project", "organization", "topic", "event"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export interface Entity {
  /** en- 开头；用户本人固定是 en-user */
  id: string;
  type: EntityType;
  name: string;
  aliases: string[];
}

// ---------- 事实 ----------

/** 一小组通用谓词（第 4.2 节），不建大本体 */
export const PREDICATES = [
  "participated_in",
  "declined",
  "initiated",
  "said_about",
  "prefers",
  "dislikes",
  "works_on",
  "occurred_at",
  "associated_with",
  // 199 号票：实体和实体之间的关系（kg/relations.ts）。事件当实体：组织者、参加的人、地点、时间段、活动类型、提前多久约的；
  // 用户和谁一起、提到了谁；人和人的关系：同事、家人、朋友、工作上的联系人
  "organized_by",
  "involves",
  "held_at",
  "in_slot",
  "of_type",
  "lead_time",
  "went_with",
  "mentioned",
  "colleague_of",
  "family_of",
  "friend_of",
  "work_contact_of",
] as const;
export type Predicate = (typeof PREDICATES)[number];

/**
 * 事情类的谓词：每条是一次发生的事（某天参加了、拒绝了），有效期从发生时起、不会结束，彼此不互相取代。
 * 其余（喜欢、不喜欢、在做、和…有关）是状态类：成立一段时间，会变、会被取代。
 * 199 号票：事件的属性、"和谁一起""提到了谁"也是事情类；人和人的关系是状态类。
 */
export const EPISODIC_PREDICATES: ReadonlySet<Predicate> = new Set<Predicate>([
  "participated_in",
  "declined",
  "initiated",
  "said_about",
  "occurred_at",
  "organized_by",
  "involves",
  "held_at",
  "in_slot",
  "of_type",
  "lead_time",
  "went_with",
  "mentioned",
]);

/** 出处：用户自己说的、观察到的（本人做的事）、别人转述的、模型抽出来的 */
export const ASSERTIONS = ["user_stated", "observed", "third_party_reported", "model_extracted"] as const;
export type Assertion = (typeof ASSERTIONS)[number];

/**
 * active 现在成立；contested 和另一条同时间、同场景互相排斥（真冲突）；superseded 观点变了，到 validTo 为止（不删）；
 * corrected 用户说以前就记错了；retracted 依据的证据都没了
 */
export const FACT_STATUSES = ["active", "contested", "superseded", "corrected", "retracted"] as const;
export type FactStatus = (typeof FACT_STATUSES)[number];

/** 事实的宾语：一个实体，或者一个值 */
export type FactObject = { type: "entity"; id: string } | { type: "value"; value: string };

export interface Fact {
  /** fa- 开头 */
  id: string;
  subjectId: string;
  predicate: Predicate;
  object: FactObject;
  /** 否定：不反感见朋友 = dislikes 见朋友 取反；不想升职 = prefers 升职 取反 */
  negated: boolean;
  /**
   * 精炼陈述：一句单独看得懂的话，带时间和场景、去掉口语碎屑（用户 2026-10-20 提）。
   * 规则版按模板拼（kg/statement.ts），模型版由模型写。检索时和原话分开建索引，命中后经 evidenceIds 回到原话
   */
  statement: string;
  assertion: Assertion;
  context: string[];
  /** 从哪几条证据来，至少一条 */
  evidenceIds: string[];
  /** 事情发生（或这句话说出来）的时间；null = 不知道 */
  eventTime: string | null;
  observedAt: string;
  /** null = 不知道从什么时候起（比如"一直""以前"），查询时当成很早以前 */
  validFrom: string | null;
  /** null = 现在仍成立 */
  validTo: string | null;
  status: FactStatus;
  /** 观点变化：取代它的那条事实 */
  supersededBy: string | null;
  /** 纠正或撤回：导致它失效的那条证据（纠正它的证据，或者失效的那条证据） */
  retractedBy: string | null;
  /** 真冲突：和它互相排斥的事实 */
  contestedWith: string[];
  /** 抽出它的抽取器（rule:<版本> | model:<名>） */
  extractedBy: string;
}

// ---------- 推理图谱：断言、关联、推断、追问 ----------

/** 近期状态 / 偏好和目标 / 稳定需求 / 长期价值取向 */
export const CLAIM_TIERS = ["state", "preference", "need", "value"] as const;
export type ClaimTier = (typeof CLAIM_TIERS)[number];

/**
 * 身份（329 号票，ADR-0032）：建号时定、之后不改（写入口拦着），只说它是怎么来的——conclusion 用户明说起的、hypothesis 推断起的。
 * 不表达验没验证过：那是状态（active 已验证 / contested 猜测）
 */
export const CLAIM_KINDS = ["hypothesis", "conclusion"] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

export const EPISTEMIC_STATUSES = ["explicit", "inferred", "user_confirmed"] as const;
export type EpistemicStatus = (typeof EPISTEMIC_STATUSES)[number];

export const METHODS = ["explicit", "deduction", "induction", "abduction", "user_confirmation"] as const;
export type Method = (typeof METHODS)[number];

/**
 * 真值状态（329 号票，ADR-0032，照原始推理图谱）：active 已验证（verified：证据达标、推出来的还要前提都已验证或有直接证实）、
 * contested 猜测（unverified：没验证过，按把握分高低；竞争中分不出胜负的也是）、retracted 撤回（被推翻，留墓碑）、
 * superseded 被取代。"待复核"不占真值状态，是单独的复核标记（Claim.needsReview）
 */
export const CLAIM_STATUSES = ["active", "contested", "retracted", "superseded"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

/** 不用小数，不冒充校准过的概率 */
export const CONFIDENCES = ["low", "medium", "high"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const PREDICTION_OUTCOMES = ["pending", "hit", "miss"] as const;
export type PredictionOutcome = (typeof PREDICTION_OUTCOMES)[number];

export interface Prediction {
  /** 预测的内容（一句话） */
  claim: string;
  outcome: PredictionOutcome;
  evidenceIds: string[];
  /**
   * 330 号票（R10）：这条预测是怎么从结论推出来的——deductive 演绎（结论对它就必然发生）、defeasible 可废止（大概会）。
   * 不写按 defeasible（原始推理图谱：缺省按弱的算）。谁能标演绎见 ADR-0032
   */
  derivation?: Derivation;
}

/**
 * 330 号票（R10，原始推理图谱的 derivation）：deductive 演绎——前提真它就必然真，落空了按 modus tollens 往回撤来源；
 * defeasible 可废止（归纳、溯因、判断）——前提真它也可能错，落空了来源只挨一条反证
 */
export const DERIVATIONS = ["deductive", "defeasible"] as const;
export type Derivation = (typeof DERIVATIONS)[number];

// ---------- 预测节点（226 号票的账本，330 号票 R10 做成从结论推出来的节点） ----------

/**
 * 预测节点的状态（330 号票，照原始推理图谱的 unverified / verified / retracted）：
 * open 未验证、到期再判；hit 应验了（已验证，靠的是那条观察——依据就是 evidenceId，来源不因此变已验证）；
 * miss 落空了（撤回，retractedBy 是证伪它的那条观察，再按推法往回打来源）；unclear 说不清（还是未验证，不再判）；
 * void 来源被撤回、跟着撤（R8，retractedBy 是那条来源；来源复活它跟着回到 open，R11）
 */
export const PREDICTION_STATUSES = ["open", "hit", "miss", "unclear", "void"] as const;
export type PredictionStatus = (typeof PREDICTION_STATUSES)[number];

/**
 * 预测落空以后往回打来源的结果（330 号票 R10）：
 * culprit 找到了错的那条前提（演绎：只有它没验证、别的都已验证，或者只有一条来源），撤回了（再按 R8 往上传）；
 * undetermined 演绎、没验证的来源不止一条（Duhem-Quine），判不出撤哪条，不乱撤，就每条往问题箱出一个问题；
 * counterexample 演绎、来源都已验证（原始 §6：前提全真，只能是漏了条件或反证有误），每条挨一条有分量的反例（R12 接着管）、出问题；
 * counter 可废止：每条来源挨一条反证（按现在的计分）；exception 判不出的那几条后来用户都确认还对，不撤来源、这次算例外；
 * none 来源都已经不在了
 */
export interface PredictionBlame {
  mode: "culprit" | "undetermined" | "counterexample" | "counter" | "exception" | "none";
  /** culprit：撤回的那条；undetermined：嫌疑的几条；counterexample、counter：挨了反证的几条 */
  claimIds: string[];
  at: string;
}

/**
 * 一条预测节点（表 predictions，逻辑在 rg/predictions.ts）：从结论推出来的"如果它对，接下来会看到什么"，挂在结论下面，
 * 带推法（演绎 / 可废止）；后来应验没有。Claim.predicts 是结论上写的预测文本，这里才是节点和"后来判没判"的记录。
 */
export interface PredictionRecord {
  /** pd- 开头 */
  id: string;
  /** 哪条结论（cl- 开头）：第一条来源（老账本只有这一条） */
  claimId: string;
  /** 330 号票：从哪几条结论推出来的（依赖边；第一条就是 claimId）；几条一起推出的落空时按 Duhem-Quine 判撤哪条 */
  premiseIds: string[];
  /** 330 号票：演绎还是可废止（老账本按 defeasible） */
  derivation: Derivation;
  /** 330 号票：撤回它的东西——落空时是证伪它的那条观察，作废时是被撤回的那条来源 */
  retractedBy: string | null;
  /** 330 号票：落空以后往回打来源的结果（没落空是 null） */
  blame: PredictionBlame | null;
  /** 当时写的预测（结论 predicts 里的几条用「；」连起来） */
  predicts: string;
  /** 记下来的时间（整理的那一夜） */
  madeAt: string;
  /** 到期判的时间（需求层 madeAt +14 天、价值层 +30 天） */
  dueAt: string | null;
  status: PredictionStatus;
  /** 判定时最相关的那条证据 */
  evidenceId: string | null;
  judgedAt: string | null;
  /** 判定的理由（模型给的 why）；开着时是空串 */
  note: string;
}

export interface Claim {
  /** cl- 开头 */
  id: string;
  tier: ClaimTier;
  statement: string;
  kind: ClaimKind;
  epistemic: EpistemicStatus;
  method: Method;
  status: ClaimStatus;
  confidence: Confidence;
  context: string[];
  validFrom: string | null;
  validTo: string | null;
  inferredAt: string;
  reviewedAt: string | null;
  /** 撤回它的那条证据、事实或断言（墓碑） */
  retractedBy: string | null;
  supersededBy: string | null;
  /** 竞争假设互相登记 */
  competesWith: string[];
  predicts: Prediction[];
  /**
   * 复核标记（329 号票，原始推理图谱的 dirty）：下一次整理要重判它（重跑它那组的追问、重算状态），判完摘掉。
   * 不改真值状态（真值跟着证据走）；依据被删、被忘掉、在重推的，标着它的这段时间写入口和自检不查它悬空、缺前提
   */
  needsReview: boolean;
}

export const LINK_POLARITIES = ["supports", "refutes", "context"] as const;
export type LinkPolarity = (typeof LINK_POLARITIES)[number];

/**
 * 一条关联有多重（④ 号票，按证据权重分档——证据对两边假设的似然比，用分贝记、可加；四档去掉"没有判别力"那一档，它直接不建关联）：
 * weak 弱（约 3 dB，一条旁证）、strong 强（约 6 dB，"冒烟的枪"的量级，还不算决定性）、
 * decisive 决定性（约 10 dB：用户自己明说的、纠正的，对手几乎不可能产生这个观察）。不用小数
 */
export const LINK_WEIGHTS = ["weak", "strong", "decisive"] as const;
export type LinkWeight = (typeof LINK_WEIGHTS)[number];

/** 证据或事实支持、反驳哪条断言（或只是它的背景） */
export interface Link {
  claimId: string;
  /** 证据 id 或事实 id */
  target: string;
  polarity: LinkPolarity;
  rationale: string;
  /** 多重；写入时不给按 weak 存，读出来总有 */
  weight?: LinkWeight;
}

/** 存储里读出来的关联：总带着多重 */
export type StoredLink = Link & { weight: LinkWeight };

/**
 * 推断（一条结论的依据：前提和推法）的状态：active 现在的依据；needs_review 前提被删、被忘掉，等下一次整理重推（停用）；
 * retracted 结论撤回了；history 329 号票（R7）：结论被直接证实以后改挂到直接证实上，原来的推理链记作历史（前提以后被推翻也不牵连它）
 */
export const INFERENCE_STATUSES = ["active", "needs_review", "retracted", "history"] as const;
export type InferenceStatus = (typeof INFERENCE_STATUSES)[number];

/** 结论 ← 前提 */
export interface Inference {
  /** in- 开头 */
  id: string;
  conclusionClaimId: string;
  /** 事实、断言或证据的 id */
  premiseIds: string[];
  method: Method;
  rationale: string;
  /** rule:<版本> | model:<名> */
  by: string;
  status: InferenceStatus;
  createdAt: string;
}

export const PROBE_OUTCOMES = ["open", "found", "not_found"] as const;
export type ProbeOutcome = (typeof PROBE_OUTCOMES)[number];

/**
 * 判别性追问：能区分几条竞争断言（或两条冲突的事实）的问题和检索。
 * 搜不到不判负：if_absent 固定是 inconclusive，所以不存
 */
export interface Probe {
  /** pr- 开头 */
  id: string;
  /** 要区分的几条：断言 id；事实真冲突时是两条事实的 id。至少两条 */
  discriminates: string[];
  /** 了解你问题的问法 */
  ask: string;
  /** 第二轮检索用的查询 */
  queries: string[];
  /** 找到了支持哪一条；事前不知道是 null */
  ifFound: string | null;
  outcome: ProbeOutcome;
  foundEvidenceIds: string[];
  createdAt: string;
}

// ---------- 交互策略（196 号票） ----------

/**
 * proposed：由成立的需求、价值断言编译出来，等用户确认；active：用户确认过（confirmedBy 是本人有效的证据），进用户模型快照；
 * paused：依据的断言都不成立了（待复核、还拿不准、置信度掉到 low），等依据恢复；retracted：依据的断言都撤回了（墓碑，不再恢复）
 */
export const STRATEGY_STATUSES = ["proposed", "active", "paused", "retracted"] as const;
export type StrategyStatus = (typeof STRATEGY_STATUSES)[number];

/** 策略的触发场合：领域、场景（情境标签的几组）、活动 */
export interface StrategyTrigger {
  domains: string[];
  scenes: string[][];
  activities: { id: string; name: string }[];
}

/** 一条交互策略（05 号调研 §6.2 的 P 层）："什么场合 → 怎么做"，挂着它依据的断言 */
export interface Strategy {
  /** st- 开头 */
  id: string;
  /** 同一个模板、同一个主题 → 同一条策略（重新编译时按它对上） */
  key: string;
  /** 出自哪个策略模板 */
  template: string;
  trigger: StrategyTrigger;
  /** 触发场合的说法（"安排周末、工作日的活动时"） */
  when: string;
  /** 怎么做，一条一句 */
  actions: string[];
  /** 依据的断言（成立的 need、value） */
  basisClaimIds: string[];
  status: StrategyStatus;
  /** 用户确认它的证据（本人、有效）；没确认是 null */
  confirmedBy: string | null;
  confirmedAt: string | null;
  createdAt: string;
}

// ---------- 对抗复核（227 号票） ----------

/**
 * 一条结论的对抗复核（表 claim_reviews）：独立的复核员不看结论，只从支持它的证据原话重推，再判候选结论。
 * 每条结论只复核一次，不进修订日志（这是复核的簿记，不是对断言的改动）。
 */
export interface ClaimReview {
  claimId: string;
  /** yes 支持、no 不支持（结论改成待复核）、unclear 看不出来（只计数） */
  verdict: "yes" | "no" | "unclear";
  /** 复核员给的理由 */
  why: string;
  /** 复核员先写下的、从观察原话自己推出的结论 */
  inference: string;
  at: string;
}

// ---------- 修订日志 ----------

export const OBJECT_TYPES = ["evidence", "entity", "fact", "claim", "link", "inference", "probe", "strategy", "prediction"] as const;
export type ObjectType = (typeof OBJECT_TYPES)[number];

/** 追加式的修订日志：哪个对象、改了什么、因为哪条证据、什么时候。只追加，改不了、删不了（库里有触发器） */
export interface Revision {
  seq: number;
  objectType: ObjectType;
  objectId: string;
  /**
   * delete：拿掉关联（证据不再支持某条断言时），或者彻底删除（234 号票：证据、事实连派生内容一起删）
   */
  op: "create" | "update" | "delete";
  /** update 时每个改了的字段的前后值；create、delete 时是写进去、拿掉的那些字段 */
  changes: Record<string, { from: unknown; to: unknown }>;
  causeEvidenceId: string | null;
  reason: string;
  at: string;
}

/** 写修订时说明原因 */
export interface RevisionCause {
  reason: string;
  evidenceId?: string | null;
}

// ---------- 唯一写入口的留痕（267 号票，ADR-0030） ----------

/**
 * 谁写的：nightly 记忆管理员的夜班（每晚整理、立即整理一次）；curator 记忆管理员白天自己的判断；
 * user_verdict 用户的表态（经记忆管理员 review_memory_claim 记下的对 / 不对 / 拿不准，回答了解你问题）；
 * user 用户自己发起的（忘掉、彻底删除、别推断、纠正、敏感类别的设置）
 */
export const WRITE_ACTORS = ["nightly", "curator", "user_verdict", "user"] as const;
export type WriteActor = (typeof WRITE_ACTORS)[number];

/**
 * 写入口的一组写操作（rg/write-gate.ts 的 OP_TIER 定每种的权限档）：
 * ingest 证据入库、extract 抽事实、explicit 明说的结论跟着事实走、propose 提假设、attach 挂支持或反证、probe 提追问、
 * mark_review 标待复核、verdict 记下用户的表态、predict 记预测和判预测、decide 判成立或推翻、lift 往上抽成需求和价值观、
 * writeback 结论写回知识图谱、validate 每晚校验、correct 纠正、forget 忘掉、purge 彻底删除、no_infer 别推断；
 * 问题箱（264 号票的顺口问接进线上后一并收进写入口）：question 出问题、更新问题箱、问题过期或不用问了，ask 记"问过"，
 * skip 跳过（问了没答到第二天也算一次；跳过两次退下、记回避信号），decline "别问这个"；
 * migrate 329 号票（R16 ①）：老库照新规矩迁移一次（rg/migrate-rules.ts；333 号票先在副本上跑，用户点头再上真库，先备份）
 */
export const WRITE_OPS = [
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
export type WriteOp = (typeof WRITE_OPS)[number];

/** 留痕里的对象：修订日志认的那几样，加上问题箱里的问题 */
export type WriteObjectType = ObjectType | "question";

/** 开一次写：做什么、谁做的（不给就跟外面那一次、再不给按这种写操作的默认）、经谁转达、为什么 */
export interface WriteIntent {
  op: WriteOp;
  actor?: WriteActor;
  /** 经谁转达（"经记忆管理员"、"设置页"）；不放用户的原话 */
  via?: string;
  /** 为什么写（进留痕） */
  reason: string;
  /**
   * 199 号票的写回：结论把自己的判断写回它的前提事实时（"那条记错了"），这几条结论自己不算"依赖它的"——它们就是起因，
   * 不用跟着转待复核（写入口的 dependents 检查跳过它们）
   */
  spares?: readonly string[];
}

/** 一条留痕（表 rg_writes，只追加）：一次写碰到的一个对象 */
export interface WriteRecord {
  seq: number;
  at: string;
  actor: WriteActor;
  via: string | null;
  op: WriteOp;
  objectType: WriteObjectType;
  objectId: string;
  /** 结论写完以后的推法（别的对象是 null） */
  method: Method | null;
  /** 依据：结论的成立推断的前提和能当依据的支持；事实的证据；预测的结论和证据；问题要弄清的结论、事实和回答的证据（只有 id） */
  basis: string[];
  reason: string;
  /** 这一次写给这个对象留下的修订（revisions 的 seq） */
  revisionSeqs: number[];
}
