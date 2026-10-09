// token 用量（纯函数，24 号票）：
// - 任务卡、作业卡上的总量和任务详情里按 agent 的细分，来自看板频道上的 token_totals（每次记账后一条最新的合计）；
// - 阶段的预算用了多少（任务详情的阶段抽屉）也来自它（按调用时的阶段）；
// - 消耗页的数据经 HTTP 取（GET /api/usage），这里给范围的几个快捷选项和 agent 的叫法。
import {
  LEDGER_PURPOSE_LABEL,
  LEDGER_ROLE_LABEL,
  ledgerOwnerKey,
  localDate,
  localDateKey,
  type LedgerOwner,
  type LedgerPurpose,
  type LedgerRole,
  parseLocalDate,
  type TokenCounts,
  type TokenTotalsEventPayload,
  tokenTotal,
} from "./protocol.ts";
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

/** 作业卡上的 token 总量（还没有用量是 0；作业身份由 19 号票带上） */
export function jobTokenTotal(state: UiState, jobId: string): number {
  const totals = ownerTokens(state, { kind: "scheduled_job", id: jobId });
  return totals ? tokenTotal(totals.tokens) : 0;
}

/** 任务详情里按 agent 的一行 */
export interface TaskUsageRow {
  key: string;
  /** "维护者 tm-1"、"维护者 tm-1 · 范围审视"、"维护者 tm-1 · 压缩"、"评审子 agent review-t-1-s2-1" */
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

/** 任务详情里按 agent 细分的用量（维护者、评审子 agent、并行子 agent 各一行，范围审视、压缩各单独一行）和合计；各行之和就是任务卡上的总量 */
export function taskUsage(state: UiState, taskId: string): { rows: TaskUsageRow[]; total: number; calls: number } {
  const totals = ownerTokens(state, { kind: "task", id: taskId });
  if (!totals) return { rows: [], total: 0, calls: 0 };
  const rows = totals.byAgent.map((r) => ({
    key: `${r.agentId}:${r.role}:${r.purpose}`,
    label: r.purpose === "work" ? agentLabel(r.agentId, r.role) : `${agentLabel(r.agentId, r.role)} · ${LEDGER_PURPOSE_LABEL[r.purpose]}`,
    agentId: r.agentId,
    role: r.role,
    purpose: r.purpose,
    tokens: r.tokens,
    total: tokenTotal(r.tokens),
    calls: r.calls,
  }));
  return { rows, total: tokenTotal(totals.tokens), calls: totals.calls };
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

export const USAGE_RANGE_PRESET_LABEL: Readonly<Record<UsageRangePreset, string>> = { today: "今天", "7d": "近 7 天", "30d": "近 30 天", month: "本月" };

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

/** 消耗页上 agent 的叫法：维护者带上它所在的项目或任务（项目在前：任务转为项目后维护者归项目），未归属的就写 id，别的是角色加 id */
export function usageAgentName(state: UiState, agentId: string, role: LedgerRole): string {
  if (role === "unattributed") return agentId;
  if (role === "maintainer") {
    const project = Object.values(state.projects).find((p) => p.maintainerId === agentId);
    if (project) return `项目「${project.name}」的维护者`;
    const task = Object.values(state.tasks).find((t) => t.maintainerId === agentId);
    if (task) return `任务「${task.title}」的维护者`;
  }
  return agentLabel(agentId, role);
}
