// token 用量（纯函数，24 号票）：
// - 任务卡、作业卡上的总量和任务详情里按 agent 的细分，来自看板频道上的 token_totals（每次记账后一条最新的合计）；
// - 阶段的预算用了多少（任务详情的阶段抽屉）也来自它（按调用时的阶段）；
// - 消耗页的数据经 HTTP 取（GET /api/usage），这里给范围的几个快捷选项和 agent 的叫法；
// - 消耗页单价那块（94 号票）：用到的单价一行一份（自带价格表的分高峰、空闲两行），下面写明高峰时段怎么算、价格取自哪天等。
// - 消耗页"联网搜索、读网页"一节（154 号票）：DeepSeek 按次计费的调用的合计和说明。
import {
  LEDGER_PURPOSE_LABEL,
  LEDGER_ROLE_LABEL,
  ledgerOwnerKey,
  localDate,
  localDateKey,
  type LedgerOwner,
  type LedgerPurpose,
  type LedgerRole,
  missingHolidayDataText,
  parseLocalDate,
  PRICE_PERIOD_LABEL,
  type PricePeriod,
  type TokenCounts,
  type TokenPrice,
  type TokenTotalsEventPayload,
  tokenTotal,
  type UsagePricing,
  type UsageWeb,
  type UsageWebTally,
  t,
  tTable,
} from "./protocol.ts";
import { maintainerLabel } from "./readable-ids.ts";
import type { UiState } from "./ui-state.ts";

/** 某个任务或定时作业名下的最新合计（还没有用量是 undefined） */
export function ownerTokens(state: UiState, owner: LedgerOwner): TokenTotalsEventPayload | undefined {
  return state.tokenTotals[ledgerOwnerKey(owner)];
}

/** 任务卡上的 token 总量（还没有用量是 0） */
export function taskTokenTotal(state: UiState, taskId: string): number {
  const totals = ownerTokens(state, { kind: "task", id: taskId });
  return totals ? tokenTotal(totals.tokens) : 0;
}

/** 任务名下的 token 里缓存命中的（311 号票：任务卡等处写"（其中缓存命中 …）"；还没有用量是 0） */
export function taskTokenCacheHit(state: UiState, taskId: string): number {
  return ownerTokens(state, { kind: "task", id: taskId })?.tokens.cacheHit ?? 0;
}

/** 作业卡上的 token 总量（还没有用量是 0；作业身份由 19 号票带上） */
export function jobTokenTotal(state: UiState, jobId: string): number {
  const totals = ownerTokens(state, { kind: "scheduled_job", id: jobId });
  return totals ? tokenTotal(totals.tokens) : 0;
}

/** 任务详情里按 agent 的一行 */
export interface TaskUsageRow {
  key: string;
  /** "tm-1「X 的调研的任务维护者」"、"… · 范围审视"、"… · 压缩"（159 号票：维护者写编号加它属于谁）、"评审子 agent review-t-1-s2-1" */
  label: string;
  agentId: string;
  role: LedgerRole;
  /** 干活、范围审视、压缩 */
  purpose: LedgerPurpose;
  tokens: TokenCounts;
  total: number;
  calls: number;
}

/** agent 的叫法：秘书写名字占位（界面按用户起的名字显示，43 号票），别的是角色加 id */
export function agentLabel(agentId: string, role: LedgerRole): string {
  return role === "secretary" ? LEDGER_ROLE_LABEL.secretary : `${LEDGER_ROLE_LABEL[role]} ${agentId}`;
}

/** 任务详情里一行 agent 的叫法：维护者写"tm-1「X 的调研的任务维护者」"（159、163 号票），别的是角色加 id */
function taskAgentLabel(state: UiState, agentId: string, role: LedgerRole): string {
  return role === "maintainer" ? maintainerLabel(state, agentId) : agentLabel(agentId, role);
}

/**
 * 任务详情里按 agent 细分的用量（维护者、评审子 agent、并行子 agent 各一行，范围审视、压缩各单独一行）和合计；各行之和就是任务卡上的总量。
 * cacheHit 是合计里缓存命中的（311 号票：详情顶上写"（其中缓存命中 …）"）
 */
export function taskUsage(state: UiState, taskId: string): { rows: TaskUsageRow[]; total: number; cacheHit: number; calls: number } {
  const totals = ownerTokens(state, { kind: "task", id: taskId });
  if (!totals) return { rows: [], total: 0, cacheHit: 0, calls: 0 };
  const rows = totals.byAgent.map((r) => ({
    key: `${r.agentId}:${r.role}:${r.purpose}`,
    label: r.purpose === "work" ? taskAgentLabel(state, r.agentId, r.role) : `${taskAgentLabel(state, r.agentId, r.role)} · ${LEDGER_PURPOSE_LABEL[r.purpose]}`,
    agentId: r.agentId,
    role: r.role,
    purpose: r.purpose,
    tokens: r.tokens,
    total: tokenTotal(r.tokens),
    calls: r.calls,
  }));
  return { rows, total: tokenTotal(totals.tokens), cacheHit: totals.tokens.cacheHit, calls: totals.calls };
}

/**
 * 任务每个阶段算进预算的 token（阶段抽屉里和预算放在一起）：不算评审子 agent 的、范围审视的；
 * 全部验收之后的收尾调用不算进任何阶段。还没用的阶段不在里面
 */
export function stageTokens(state: UiState, taskId: string): Readonly<Record<string, number>> {
  const totals = ownerTokens(state, { kind: "task", id: taskId });
  return Object.fromEntries((totals?.byStage ?? []).map((s) => [s.stageId, s.budgetTokens]));
}

/** 消耗页的范围快捷选项：今天、近 7 天、近 30 天、本月 */
export const USAGE_RANGE_PRESETS = ["today", "7d", "30d", "month"] as const;
export type UsageRangePreset = (typeof USAGE_RANGE_PRESETS)[number];

export const USAGE_RANGE_PRESET_LABEL: Readonly<Record<UsageRangePreset, string>> = tTable({
  today: "state.usage.range.today",
  "7d": "state.usage.range.last7",
  "30d": "state.usage.range.last30",
  month: "state.usage.range.month",
});

/** 快捷选项落成的范围（含两头的本地日期）；now 是现在 */
export function usageRange(preset: UsageRangePreset, now: Date): { from: string; to: string } {
  const to = localDate(now);
  const daysBack = (n: number) => localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n));
  switch (preset) {
    case "today":
      return { from: to, to };
    case "7d":
      return { from: daysBack(6), to };
    case "30d":
      return { from: daysBack(29), to };
    case "month":
      return { from: localDate(new Date(now.getFullYear(), now.getMonth(), 1)), to };
  }
}

/** 范围里的每一天（含两头；最多一年，按天的图表用） */
export function rangeDays(from: string, to: string): string[] {
  const start = parseLocalDate(from);
  const days: string[] = [];
  for (let i = 0; i < 366; i++) {
    const d = new Date(Date.UTC(start.year, start.month - 1, start.day + i));
    const key = localDateKey(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    if (key > to) break;
    days.push(key);
  }
  return days;
}

/**
 * 消耗页上 agent 的叫法：维护者写编号加它属于哪个项目或任务（"pm-1「记账本的项目维护者」"，项目在前：任务转为项目后维护者归项目；
 * 删掉了的"tm-9（已删除）"，159、163 号票），未归属的就写 id，别的是角色加 id
 */
export function usageAgentName(state: UiState, agentId: string, role: LedgerRole): string {
  if (role === "unattributed") return agentId;
  return role === "maintainer" ? maintainerLabel(state, agentId) : agentLabel(agentId, role);
}

/** 消耗页单价表里的一行：一个模型的一份单价（每百万 token） */
export interface UsagePriceRow {
  key: string;
  model: string;
  /** 旧名字按别的模型计价时写明："按 deepseek/deepseek-flash 计价" */
  note?: string;
  /** 自带价格表的是"高峰""空闲"，配置里的不分时段 */
  period: string;
  price: TokenPrice;
}

/** 消耗页单价表的行：自带价格表的模型高峰、空闲各一行，配置里的一行（不分时段） */
export function usagePriceRows(pricing: UsagePricing): UsagePriceRow[] {
  return pricing.prices.flatMap((p): UsagePriceRow[] => {
    if (p.source === "config") return [{ key: `${p.model}:config`, model: p.model, period: t("state.usage.price.configPeriod"), price: { cacheHit: p.cacheHit, cacheMiss: p.cacheMiss, output: p.output } }];
    const note = p.pricedAs === p.model ? {} : { note: t("state.usage.price.pricedAs", { model: p.pricedAs }) };
    const row = (period: PricePeriod, price: TokenPrice): UsagePriceRow => ({ key: `${p.model}:${period}`, model: p.model, ...note, period: PRICE_PERIOD_LABEL[period], price });
    return [row("peak", p.peak), row("off_peak", p.offPeak)];
  });
}

/** 单价表下面的说明：高峰时段怎么算、自带价格表取自哪里哪天、缺节假日数据的年份、没有单价的模型、配置读不出来的原因 */
export function usagePricingNotes(pricing: UsagePricing): string[] {
  const notes: string[] = [];
  const { builtin } = pricing;
  if (builtin) {
    notes.push(builtin.peakHours);
    notes.push(t("state.usage.price.builtinSource", { title: builtin.source.title, readOn: builtin.source.readOn }));
    for (const year of builtin.missingHolidayYears) notes.push(t("state.usage.price.missingHolidays", { missing: missingHolidayDataText(year, ["cn"]) }));
  }
  if (pricing.unpriced.length > 0) notes.push(t("state.usage.price.unpriced", { models: pricing.unpriced.join(t("state.usage.listSep")) }));
  if (pricing.problem) notes.push(t("state.usage.price.configProblem", { problem: pricing.problem }));
  return notes;
}

/** 按次计费的联网调用的合计（联网搜索 + 读网页，154 号票） */
export function usageWebTotal(web: UsageWeb): UsageWebTally {
  return { calls: web.search.calls + web.fetch.calls, cost: web.search.cost + web.fetch.cost };
}

/** "联网搜索、读网页"一节下面的说明：单价和来源、只算成功的、记在谁名下；货币不是人民币时没算钱 */
export function usageWebNotes(web: UsageWeb): string[] {
  const notes: string[] = [];
  if (web.price) {
    const { search, source } = web.price;
    notes.push(t("state.usage.web.price", { search, perThousand: Math.round(search * 1000 * 100) / 100, title: source.title, readOn: source.readOn }));
  }
  if (web.unpriced) notes.push(t("state.usage.web.unpriced"));
  return notes;
}
