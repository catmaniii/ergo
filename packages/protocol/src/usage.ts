// token 账本与消耗（规格第 16 节，24 号票）：名字和纯函数，守护进程和 Web 共用。不引用 TypeBox（类型从 usage-schema.ts 取）。
// - 账本每次模型调用记一条：归属（任务、项目或定时作业）、agent 和它的角色、会话、模型、输入（缓存命中 / 未命中）、输出、时间；
//   任务的还记调用时的阶段；范围审视、压缩那几次标出来；
// - 秘书的用量是系统开销（不论它在处理什么）；拉起时没给归属的 agent 记成"未归属"，单列；
// - 成本一律是粗估：用量乘配置里每个模型的单价（每百万 token），不按时段计价。
import { ASSISTANT_NAME_MARK } from "./assistant-name.ts";
import type { LedgerOwner, TokenCounts, TokenPrice } from "./usage-schema.ts";

/** agent 在账本里的角色：秘书、维护者（任务的、项目的、作业的）、评审子 agent、子 agent（20 号票），以及拉起时没给归属的（未归属） */
export const LEDGER_ROLES = ["secretary", "maintainer", "reviewer", "sub_agent", "unattributed"] as const;
export type LedgerRole = (typeof LEDGER_ROLES)[number];

/** 角色的叫法：秘书写名字占位，界面按用户起的名字显示（43 号票） */
export const LEDGER_ROLE_LABEL: Readonly<Record<LedgerRole, string>> = {
  secretary: ASSISTANT_NAME_MARK,
  maintainer: "维护者",
  reviewer: "评审子 agent",
  sub_agent: "子 agent",
  unattributed: "未归属的 agent",
};

/** 用量记在谁名下：任务、项目、定时作业 */
export const LEDGER_OWNER_KINDS = ["task", "project", "scheduled_job"] as const;
export type LedgerOwnerKind = (typeof LEDGER_OWNER_KINDS)[number];

export const LEDGER_OWNER_KIND_LABEL: Readonly<Record<LedgerOwnerKind, string>> = { task: "任务", project: "项目", scheduled_job: "定时作业" };

/** 一次模型调用是做什么的：干活（平常的调用）、范围审视（18 号票）、压缩会话、换模型时写交接摘要（83 号票） */
export const LEDGER_PURPOSES = ["work", "scope_review", "compaction", "handoff"] as const;
export type LedgerPurpose = (typeof LEDGER_PURPOSES)[number];

/** 任务详情里这几种调用另起一行时的标注（干活的不标） */
export const LEDGER_PURPOSE_LABEL: Readonly<Record<LedgerPurpose, string>> = { work: "", scope_review: "范围审视", compaction: "压缩", handoff: "交接摘要" };

/** 消耗页上 agent 的三类：记在任务、项目、作业名下的；系统开销（秘书）；未归属（拉起时没给归属） */
export const USAGE_CATEGORIES = ["owned", "system", "unattributed"] as const;
export type UsageCategory = (typeof USAGE_CATEGORIES)[number];

/** 秘书的用量单列成这一项 */
export const SYSTEM_OVERHEAD_LABEL = "系统开销";

/** 拉起时没给归属的 agent 的用量单列成这一项 */
export const UNATTRIBUTED_LABEL = "未归属";

/** 成本是粗估，页面上一律这样标 */
export const COST_ESTIMATE_LABEL = "粗估";

/** 单价的单位：每百万 token */
export const PRICE_UNIT_TOKENS = 1_000_000;

export const ZERO_TOKENS: Readonly<TokenCounts> = Object.freeze({ cacheHit: 0, cacheMiss: 0, output: 0 });

/** 一笔用量的 token 总量（输入命中 + 未命中 + 输出） */
export function tokenTotal(tokens: TokenCounts): number {
  return tokens.cacheHit + tokens.cacheMiss + tokens.output;
}

export function addTokens(a: TokenCounts, b: TokenCounts): TokenCounts {
  return { cacheHit: a.cacheHit + b.cacheHit, cacheMiss: a.cacheMiss + b.cacheMiss, output: a.output + b.output };
}

/** 输入里命中缓存的比例（没有输入时是 0） */
export function cacheHitRate(tokens: TokenCounts): number {
  const input = tokens.cacheHit + tokens.cacheMiss;
  return input === 0 ? 0 : tokens.cacheHit / input;
}

/** 一笔用量按单价（每百万 token）的粗估成本 */
export function costOf(tokens: TokenCounts, price: TokenPrice): number {
  return (tokens.cacheHit * price.cacheHit + tokens.cacheMiss * price.cacheMiss + tokens.output * price.output) / PRICE_UNIT_TOKENS;
}

/** 归属的键（看板上按它留最新的合计）：task:t-1、scheduled_job:j-1、project:p-1 */
export function ledgerOwnerKey(owner: LedgerOwner): string {
  return `${owner.kind}:${owner.id}`;
}

/** 消耗页上这一行算哪一类：秘书是系统开销（不论它在处理什么）；别的有归属的记在名下，没有的是未归属 */
export function usageCategory(role: LedgerRole, owned: boolean): UsageCategory {
  if (role === "secretary") return "system";
  return owned ? "owned" : "unattributed";
}

/** 货币的符号（认不得的原样写货币代码） */
export function currencySymbol(currency: string): string {
  const symbols: Readonly<Record<string, string>> = { CNY: "¥", RMB: "¥", USD: "$", EUR: "€", SGD: "S$" };
  return symbols[currency.toUpperCase()] ?? `${currency} `;
}
