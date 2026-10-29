// 任务执行里给用户看的几句（172 号票从 execution-tools.ts 挪出来）：这一支为什么停下、用量和预算（任务和阶段上的说明、
// 待我处理事项，生成时按当时的语言写）、重做时改了这一阶段的什么（时间线那一笔）。交给维护者的通知里用到时包一层 forModel 照旧中文。
import { type PlanStage, t } from "@ergo/protocol";
import type { BranchStopReason } from "./execution.ts";
import type { StageSpend } from "./thresholds.ts";

/** 重做时改了这一阶段的什么（125 号票）："验收标准""交付件""验收标准和交付件" */
export function stageEditWhat(before: PlanStage, after: PlanStage): string {
  const acceptance = JSON.stringify(before.acceptance) !== JSON.stringify(after.acceptance);
  const deliverables = JSON.stringify(before.deliverables) !== JSON.stringify(after.deliverables);
  return acceptance && deliverables ? t("tasks.stop.editBoth") : deliverables ? t("tasks.stop.editDeliverables") : t("tasks.stop.editAcceptance");
}

/** 一栏的改前、改后（逐条编号）；没改是空的 */
const editBlock = (title: string, a: readonly string[], b: readonly string[]): string[] =>
  JSON.stringify(a) === JSON.stringify(b)
    ? []
    : [t("tasks.stop.before", { title }), ...a.map((x, i) => `${i + 1}. ${x}`), t("tasks.stop.after", { title }), ...b.map((x, i) => `${i + 1}. ${x}`)];

/** 重做时改的前后对照（125 号票：时间线那一笔的说明、交给维护者的通知）：改了的那一栏写改前、改后 */
export function stageEditLines(before: PlanStage, after: PlanStage): string[] {
  return [
    ...editBlock(
      t("tasks.stop.acceptanceLabel"),
      before.acceptance.map((a) => a.criterion),
      after.acceptance.map((a) => a.criterion),
    ),
    ...editBlock(t("tasks.stop.deliverablesLabel"), before.deliverables, after.deliverables),
  ];
}

/** 用量和预算："用了 1200 token、5 次工具调用（预算 1000 token、2 次）" */
export const spendText = (used: StageSpend, budget: StageSpend) =>
  t("tasks.stop.spend", { tokens: used.tokens, calls: used.toolCalls, budgetTokens: budget.tokens, budgetCalls: budget.toolCalls });

/** 这一支为什么停下（给维护者的通知、待我处理事项、任务和阶段上的说明共用一句） */
export function stopReasonText(reason: BranchStopReason): string {
  switch (reason.kind) {
    case "pull_backs":
      return t("tasks.stop.pullBacks", { times: reason.count - 1, tool: reason.tool, rules: reason.ruleIds.join(t("protocol.common.listSep")) });
    case "stall":
      return t("tasks.stop.stall", { minutes: reason.minutes, nudges: reason.nudges });
    case "acceptance":
      return t("tasks.stop.acceptance", { returns: reason.returns - 1, nth: reason.returns, judged: reason.judged });
    case "over_budget":
      return t("tasks.stop.overBudget", { spend: spendText(reason.used, reason.budget), times: reason.times });
    case "infeasible":
      return t("tasks.stop.infeasible", { reason: reason.reason });
  }
}

