// 阶段自动验收（112 号票，用户 2026-10-13 定：先是项目里的任务，同日扩到所有长程任务；哪些任务算见协议包的 stagesAutoAccepted）：
// 纯函数和说法。
// - userCriteriaProblems：计划检查（plan-projects.ts）拒收长程任务里没验收的阶段写的由你验收（user），提交计划、计划变更、
//   自行调整都过它（已验收的阶段不管：升级前由你验收过的不能再改，也不用改；重做重开了的，执行控制器重开时就改成评审了）；
// - autoAcceptedPlan：升级前确认的计划里，没验收的阶段写着由你验收的标准改由评审验收（照这条标准的原文判），执行控制器
//   （execution.ts 的 autoAcceptStages）据此记一版运行时调整的计划；
// - convertedCriteria：现在生效的计划里哪几条是原定由你验收、按新规矩改由评审的（看确认过的各版计划），验收结论卡上写明；
// - 说法：退回的原因、事项记成处理过的说明、结论卡上的说明、时间线上的一笔。
// 172 号票：退回维护者的照旧中文；事项的处理结果（handed）按字认，不跟着语言变（显示时 inboxActionText 换）；别的按当时的语言写
import { type Plan, t } from "@ergo/protocol";

export const AUTO_ACCEPTANCE_TEXT = {
  // @i18n-ignore-start model：计划检查的问题交回维护者
  /** 计划检查退回时说明改成什么 */
  refusal: "阶段自动验收，改成 script 或 review",
  /** 涉及多个项目的任务退回时（它的阶段不用脚本：交付件在各项目那边） */
  refusalMulti: "阶段自动验收，改成 review",
  // @i18n-ignore-end
  /** 在等你验收的事项交给评审后记成处理过（事项的处理结果，按字认） */
  handed: "阶段改成自动验收，交给评审了", // @i18n-ignore fixed
  /** 事项上的说明：选的和再点旧按钮回的都是这句 */
  get handedNote(): string {
    return t("tasks.autoAcceptance.handed");
  },
  /** 验收结论卡上这一条的备注开头 */
  get converted(): string {
    return t("tasks.autoAcceptance.converted");
  },
  /** 运行时调整的那一版计划为什么改 */
  get why(): string {
    return t("tasks.autoAcceptance.why");
  },
};

/**
 * 长程任务的计划里，没验收的阶段写的由你验收：一个阶段一条原因。multi：涉及多个项目的任务（阶段不用脚本，只能改成评审）
 */
// @i18n-ignore-start model：交回维护者
export function userCriteriaProblems(plan: Plan, accepted: ReadonlySet<string> = new Set(), options: { multi?: boolean } = {}): string[] {
  const how = options.multi ? `${AUTO_ACCEPTANCE_TEXT.refusalMulti}（评审读得到回执和各项目的交付件）` : `${AUTO_ACCEPTANCE_TEXT.refusal}（能脚本查的先脚本查，再加一条评审综合看）`;
  return plan.stages.flatMap((stage) => {
    if (accepted.has(stage.stageId)) return [];
    const user = stage.acceptance.filter((a) => a.method === "user").map((a) => `「${a.criterion}」`);
    return user.length === 0 ? [] : [`阶段 ${stage.stageId} 的验收标准${user.join("、")}写的是由用户验收（user）：${how}`];
  });
}
// @i18n-ignore-end

/** 改由评审的一个阶段：哪几条原定由你验收 */
export interface ConvertedStage {
  stageId: string;
  title: string;
  criteria: string[];
}

/**
 * 没验收的阶段里由你验收的标准改由评审（照原文），别的标准、别的字段不动；已验收的阶段不动。
 * 没有要改的原样返回同一份计划（converted 是空的）：再做一遍什么也不改
 */
export function autoAcceptedPlan(plan: Plan, accepted: ReadonlySet<string>): { plan: Plan; converted: ConvertedStage[] } {
  const converted: ConvertedStage[] = [];
  const stages = plan.stages.map((stage) => {
    const user = stage.acceptance.filter((a) => a.method === "user");
    if (accepted.has(stage.stageId) || user.length === 0) return stage;
    converted.push({ stageId: stage.stageId, title: stage.title, criteria: user.map((a) => a.criterion) });
    return { ...stage, acceptance: stage.acceptance.map((a) => (a.method === "user" ? { criterion: a.criterion, method: "review" as const } : a)) };
  });
  return converted.length === 0 ? { plan, converted } : { plan: { ...plan, stages }, converted };
}

/** 这个阶段现在由评审验收、在之前确认过的某一版计划里是由你验收的那几条（history：确认过的各版计划） */
export function convertedCriteria(history: readonly Plan[], current: Plan, stageId: string): Set<string> {
  const wasUser = new Set(history.flatMap((p) => p.stages.filter((s) => s.stageId === stageId).flatMap((s) => s.acceptance.filter((a) => a.method === "user").map((a) => a.criterion))));
  const review = current.stages.find((s) => s.stageId === stageId)?.acceptance.filter((a) => a.method === "review") ?? [];
  return new Set(review.map((a) => a.criterion).filter((c) => wasUser.has(c)));
}
