// token 账本与消耗页的 schema（规格第 16 节，24 号票），用 TypeBox 定义，守护进程和 Web 共用生成的类型。
// - 看板频道上的 token_totals 事件：一个任务（或定时作业）名下的用量合计，每次新的模型调用后推一条；
// - 单价（每百万 token）：配置里的 tokenPrices（不分时段），没写的用框架自带的价格表（token-prices.ts，分高峰、空闲，94 号票）；
// - 消耗页：GET /api/usage?from=&to= 的响应（按天、按 agent 汇总，秘书单列为系统开销，未归属的另列，粗估成本）。
// 名字（角色、归属种类、调用用途、消耗页上的三类）和纯函数（合计、成本）在 usage.ts；自带价格表和高峰时段在 token-prices.ts。
import { type Static, Type } from "typebox";
import { LEDGER_OWNER_KINDS, LEDGER_PURPOSES, LEDGER_ROLES, USAGE_CATEGORIES, WEB_CALL_SERVICES } from "./usage.ts";
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

/**
 * 一个模型和它的单价（消耗页上列出用到的单价）：
 * - source: "config"：配置里写的单价，不分时段；
 * - source: "builtin"：框架自带的价格表（94 号票），高峰、空闲各一份；pricedAs 是按哪个模型算的（旧名字按 deepseek-flash）
 */
export const ModelPrice = Type.Union([
  Type.Object({ model: Type.String(), source: Type.Literal("config"), ...TokenPrice.properties }),
  Type.Object({ model: Type.String(), source: Type.Literal("builtin"), pricedAs: Type.String(), peak: TokenPrice, offPeak: TokenPrice }),
]);
export type ModelPrice = Static<typeof ModelPrice>;

/** 用到了框架自带的价格表时，消耗页上写明的：价格取自哪里、哪天读的，高峰时段怎么算，哪几年缺国内节假日数据 */
export const BuiltinPricingNote = Type.Object({
  source: Type.Object({ title: Type.String(), url: Type.String(), readOn: LocalDate }),
  /** 高峰时段规则的说法（token-prices.ts 的 describePeakHours） */
  peakHours: Type.String(),
  /** 按自带价格表算的用量落在哪几年、那几年没有国内节假日数据（只按周一至周五算高峰） */
  missingHolidayYears: Type.Array(Type.Integer()),
});
export type BuiltinPricingNote = Static<typeof BuiltinPricingNote>;

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

/**
 * 成本怎么算的：一律粗估。配置里写了单价的模型 = 用量 × 配置的单价（不分时段）；没写的用框架自带的价格表，
 * 每一笔按记账时间落在高峰还是空闲时段算（94 号票）；两边都没有的不算进成本
 */
export const UsagePricing = Type.Object({
  estimate: Type.Literal(true),
  /** 货币（配置里的 tokenPrices.currency，默认 CNY；自带价格表是人民币，货币不一样时不用它） */
  currency: Type.String(),
  /** 用到的单价 */
  prices: Type.Array(ModelPrice),
  /** 范围里有用量、配置里和自带价格表里都没有单价的模型：它们的用量不算进成本 */
  unpriced: Type.Array(Type.String()),
  /** 用到了自带价格表时：价格来源、高峰时段规则、缺节假日数据的年份 */
  builtin: Type.Optional(BuiltinPricingNote),
  /** 配置里的单价读不出来时的原因（这时只按自带价格表算） */
  problem: Type.Optional(Type.String()),
});
export type UsagePricing = Static<typeof UsagePricing>;

/** 按次计费的联网调用的一段合计（154 号票）：几次、粗估多少钱 */
export const UsageWebTally = Type.Object({ calls: Count, cost: Type.Number({ minimum: 0 }) });
export type UsageWebTally = Static<typeof UsageWebTally>;

/** 消耗页"联网"一节的一个 agent：它发起的联网搜索、读网页（记在它名下，和 token 用量同一套归属） */
export const UsageWebAgentRow = Type.Object({
  agentId: Type.String(),
  role: Type.Enum(LEDGER_ROLES),
  category: Type.Enum(USAGE_CATEGORIES),
  search: UsageWebTally,
  fetch: UsageWebTally,
});
export type UsageWebAgentRow = Static<typeof UsageWebAgentRow>;

/** 联网调用的单价（每次多少钱）和来源：框架自带的（token-prices.ts 的 BUILTIN_WEB_CALL_PRICES） */
export const WebCallPrice = Type.Object({
  service: Type.Enum(WEB_CALL_SERVICES),
  search: Type.Number({ minimum: 0 }),
  fetch: Type.Number({ minimum: 0 }),
  currency: Type.String(),
  source: Type.Object({ title: Type.String(), url: Type.String(), readOn: LocalDate }),
});
export type WebCallPrice = Static<typeof WebCallPrice>;

/**
 * 消耗页上按次计费的联网调用（154 号票）：DeepSeek 的联网搜索、读网页各几次、多少钱，按 agent 分；
 * 只记成功、有结果的（DeepSeek 只对这些计费）。成本是粗估、查的时候按现在的单价算，不算进 token 的合计（total 里只有模型调用），页面上另写
 */
export const UsageWeb = Type.Object({
  search: UsageWebTally,
  fetch: UsageWebTally,
  agents: Type.Array(UsageWebAgentRow),
  /** 范围里有调用时用到的单价 */
  price: Type.Optional(WebCallPrice),
  /** 配置里的货币不是人民币：自带的单价用不了，联网调用不算进成本（cost 都是 0） */
  unpriced: Type.Boolean(),
});
export type UsageWeb = Static<typeof UsageWeb>;

/**
 * 消耗页上的"记忆简报"一项（266 号票）：范围里自动带了几次、估的 token、粗估的钱。这些 token 已经算在秘书的用量里（是秘书这一轮多读的输入），
 * 这里另列出来；钱按带进去那一次没命中缓存、秘书最近一次干活用的模型的单价算（之后留在会话里每次照样读，命中缓存，没算进来）
 */
export const UsageMemoryBrief = Type.Object({ count: Count, tokens: Count, cost: Type.Number({ minimum: 0 }) });
export type UsageMemoryBrief = Static<typeof UsageMemoryBrief>;

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
  /** 按次计费的联网调用（DeepSeek 的联网搜索、读网页，154 号票） */
  web: UsageWeb,
  /** 记忆简报（266 号票）：已经算在秘书的用量里，另列一项 */
  memoryBrief: UsageMemoryBrief,
});
export type UsageSummary = Static<typeof UsageSummary>;
