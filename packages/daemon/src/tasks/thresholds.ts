// 阈值（规格第 8 节"阈值"，14 号票）：任务跑偏时打扰用户的程度和偏离的代价成正比。默认值只在这里，配置里写 tasks.thresholds 改。
// - 被拉回（按规则退回，包括用到别的阶段的授权项）满 pullBacks 次后再犯：这一支停下，任务转等我（卡住求助）；
// - 维护者活着、但 stallMs 内没有成功的工具调用也没有阶段推进：催一次（正在干活时以插话送达）；
//   同一次停滞里催满 nudges 次仍无进展：这一支停下，任务转等我（卡住求助）；中间有了进展计数清零；
// - 阶段验收（脚本、评审）退回 acceptanceReturns 次，再宣布完成还不过：这一支停下，任务转等我（卡住求助）；
// - 每个阶段按 token（账本里这个阶段干活用掉的）加工具调用次数累计用量：用量超过预算的 budgetExplainTimes 倍
//   （默认 1：预算用完）让维护者说明进展（任务状态不变），超过 budgetAskTimes 倍（默认 2）这一支停下，任务转等我（超预算）。
//   这两个动作只在 budgetControl 打开时做（93 号票，用户 2026-10-11 定"先不做预算控制，以后再说"：默认关，用量照旧记、照旧显示，
//   超了不说明、不停下；超预算的状态、事项、"追加预算继续"的代码都留着，已经停在超预算的任务照旧能追加预算继续）；
// - 同一任务累计被用户拒绝 rejections 次（审批、计划变更）：整个任务转已暂停；
// - 授权项到期前 renewalLeadMs（默认一天）待我处理里放一条续期事项；
// - 每周的归档清单（archive-list.ts，19 号票）汇总结束超过 archiveAfterDays 天（默认 7）、还没归档的任务。

/** 一天（毫秒）：授权项的有效期、续期事项的提前量按它算 */
export const DAY_MS = 86_400_000;

export interface TaskThresholds {
  /** 被拉回几次之后再犯就找用户（默认 3） */
  pullBacks: number;
  /** 一次停滞里催几次之后仍无进展就找用户（默认 3） */
  nudges: number;
  /** 多久没有成功的工具调用、没有阶段推进算无进展（毫秒，默认 20 分钟；配置写 stallMinutes） */
  stallMs: number;
  /** 阶段验收退回几次之后再不过就找用户（默认 2：第 3 次还不过） */
  acceptanceReturns: number;
  /** 用量超过预算的几倍让维护者说明进展（默认 1：预算用完） */
  budgetExplainTimes: number;
  /** 用量超过预算的几倍找用户（默认 2） */
  budgetAskTimes: number;
  /** 管不管预算（93 号票，默认 false）：打开时超了预算照上面两个倍数说明进展、停下找用户；关着时只记用量 */
  budgetControl: boolean;
  /** 同一任务累计被用户拒绝几次就暂停整个任务（默认 5） */
  rejections: number;
  /** 授权项到期前多久放续期事项（毫秒，默认一天；配置写 renewalLeadHours） */
  renewalLeadMs: number;
  /** 结束超过几天、还没归档的任务进每周的归档清单（默认 7，19 号票） */
  archiveAfterDays: number;
}

export const DEFAULT_TASK_THRESHOLDS: Readonly<TaskThresholds> = Object.freeze({
  pullBacks: 3,
  nudges: 3,
  stallMs: 20 * 60_000,
  acceptanceReturns: 2,
  budgetExplainTimes: 1,
  budgetAskTimes: 2,
  budgetControl: false,
  rejections: 5,
  renewalLeadMs: DAY_MS,
  archiveAfterDays: 7,
});

/** 一个阶段的用量（这一份预算里的）：token、工具调用次数 */
export interface StageSpend {
  tokens: number;
  toolCalls: number;
}

/**
 * 一个阶段的用量相当于预算的几倍：token 和工具调用次数各算各的，取大的；预算里写 0 的那一项不算（没有给预算）。
 * 两项都没给预算时是 0
 */
export function budgetRatio(used: StageSpend, budget: StageSpend): number {
  const ratios = [...(budget.tokens > 0 ? [used.tokens / budget.tokens] : []), ...(budget.toolCalls > 0 ? [used.toolCalls / budget.toolCalls] : [])];
  return ratios.length === 0 ? 0 : Math.max(...ratios);
}
