// token 账本与消耗页的 schema（规格第 16 节，24 号票），用 TypeBox 定义，守护进程和 Web 共用生成的类型。
// - 看板频道上的 token_totals 事件：一个任务（或定时作业）名下的用量合计，每次新的模型调用后推一条；
// - 单价（配置里的 tokenPrices，每百万 token）；
// - 消耗页：GET /api/usage?from=&to= 的响应（按天、按 agent 汇总，秘书单列为系统开销，未归属的另列，粗估成本）。
// 名字（角色、归属种类、调用用途、消耗页上的三类）和纯函数（合计、成本）在 usage.ts。
import { type Static, Type } from "typebox";
import { LEDGER_OWNER_KINDS, LEDGER_PURPOSES, LEDGER_ROLES, USAGE_CATEGORIES } from "./usage.ts";
import { LocalDate } from "./workday-calendar.ts";

const Count = Type.Integer({ minimum: 0 });

/** 一笔用量：输入里命中缓存的、没命中的，和输出（token 数） */
export const TokenCounts = Type.Object({ cacheHit: Count, cacheMiss: Count, output: Count });
export type TokenCounts = Static<typeof TokenCounts>;

/** 用量记在谁名下：任务、项目或定时作业（秘书的是系统开销，没给归属的是未归属，都不在任何名下） */
export const LedgerOwner = Type.Object({ kind: Type.Enum(LEDGER_OWNER_KINDS), id: Type.String() });
export type LedgerOwner = Static<typeof LedgerOwner>;

/** 某个名下按 agent 分的一行：维护者、评审子 agent、并行子 agent 各一行；范围审视、压缩的用量各另占一行（purpose） */
export const TokenAgentRow = Type.Object({
  agentId: Type.String(),
  role: Type.Enum(LEDGER_ROLES),
  purpose: Type.Enum(LEDGER_PURPOSES),
  tokens: TokenCounts,
  /** 几次模型调用 */
  calls: Count,
});
export type TokenAgentRow = Static<typeof TokenAgentRow>;

/** 任务名下按阶段分的一行（调用时所在的阶段；评审子 agent 记在它评审的阶段，子 agent 记在它被派去的阶段） */
export const TokenStageRow = Type.Object({
  stageId: Type.String(),
  /** 这个阶段的全部用量（含评审子 agent、范围审视的） */
  tokens: TokenCounts,
  calls: Count,
  /** 算进阶段预算的 token 总数：不算评审子 agent 的、不算范围审视的（压缩算）。阶段抽屉、预算阈值看它 */
  budgetTokens: Count,
});
export type TokenStageRow = Static<typeof TokenStageRow>;

/**
 * `token_totals` 事件（看板频道）：一个任务或定时作业名下的用量合计（每次记账后的最新样子，不是增量）。
 * 任务卡、作业卡上的总量和任务详情里按 agent 的细分都来自它
 */
export const TokenTotalsEventPayload = Type.Object({
  owner: LedgerOwner,
  tokens: TokenCounts,
  calls: Count,
  byAgent: Type.Array(TokenAgentRow),
  /** 只有任务有：调用记在哪个阶段（没开始执行、全部验收之后的收尾调用不算进任何阶段） */
  byStage: Type.Array(TokenStageRow),
  /** 最近一次记账的时间 */
  time: Type.String(),
});
export type TokenTotalsEventPayload = Static<typeof TokenTotalsEventPayload>;

// ───────────────────────── 单价 ─────────────────────────

const Price = Type.Number({ minimum: 0 });

/** 一个模型的单价：每百万 token 多少钱（输入命中缓存、没命中、输出各一个） */
export const TokenPrice = Type.Object({ cacheHit: Price, cacheMiss: Price, output: Price });
export type TokenPrice = Static<typeof TokenPrice>;

/** 一个模型和它的单价（消耗页上列出用到的单价） */
export const ModelPrice = Type.Object({ model: Type.String(), ...TokenPrice.properties });
export type ModelPrice = Static<typeof ModelPrice>;

// ───────────────────────── 消耗页（GET /api/usage） ─────────────────────────

/** 消耗页上的一个 agent：范围内（或某一天）它的用量；category 是三类之一（记在名下的、系统开销、未归属） */
export const UsageAgentRow = Type.Object({
  agentId: Type.String(),
  role: Type.Enum(LEDGER_ROLES),
  category: Type.Enum(USAGE_CATEGORIES),
  tokens: TokenCounts,
  calls: Count,
  /** 粗估成本（配了单价的模型的那部分） */
  cost: Type.Number({ minimum: 0 }),
});
export type UsageAgentRow = Static<typeof UsageAgentRow>;

/** 一段用量的合计：token、调用次数、粗估成本 */
export const UsageTally = Type.Object({ tokens: TokenCounts, calls: Count, cost: Type.Number({ minimum: 0 }) });
export type UsageTally = Static<typeof UsageTally>;

/** 消耗页上的一天：当天合计、系统开销、未归属和按 agent 的 */
export const UsageDay = Type.Object({
  date: LocalDate,
  total: UsageTally,
  system: UsageTally,
  unattributed: UsageTally,
  agents: Type.Array(UsageAgentRow),
});
export type UsageDay = Static<typeof UsageDay>;

/** 成本怎么算的：一律粗估（用量 × 配置里的单价，不按时段计价） */
export const UsagePricing = Type.Object({
  estimate: Type.Literal(true),
  /** 货币（配置里的 tokenPrices.currency，如 CNY） */
  currency: Type.String(),
  /** 用到的单价 */
  prices: Type.Array(ModelPrice),
  /** 范围里有用量、配置里没有单价的模型：它们的用量不算进成本 */
  unpriced: Type.Array(Type.String()),
  /** 配置读不出来时的原因（这时成本都是 0） */
  problem: Type.Optional(Type.String()),
});
export type UsagePricing = Static<typeof UsagePricing>;

/** 消耗页的数据：选定范围（含两头的日期）里按天、按 agent 的汇总，系统开销、未归属单列，粗估成本 */
export const UsageSummary = Type.Object({
  from: LocalDate,
  to: LocalDate,
  /** 有用量的日子，按日期排 */
  days: Type.Array(UsageDay),
  /** 范围内按 agent 的合计（系统开销、未归属的也在里面，看 category） */
  agents: Type.Array(UsageAgentRow),
  total: UsageTally,
  system: UsageTally,
  unattributed: UsageTally,
  pricing: UsagePricing,
});
export type UsageSummary = Static<typeof UsageSummary>;
