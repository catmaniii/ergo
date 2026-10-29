// 计划变更卡上显示什么、确认时交出什么（纯函数，14 号票）。
// 卡上只列相对当前计划新增或改动的部分（负载的 changes），每一处的说法由共享协议包的 planChangeItemText 从结构化数据生成，
// 和守护进程给维护者、素材里的说法一样；扩大授权、改目标或验收的那几处标"要你确认"。
// 新增的授权项（落在"先问我""交给我做"类别里的不算授权，不给勾）可以在卡上勾掉，确认时随 removeGrants 交出；
// 别的改动要么整张确认，要么拒绝（拒绝后维护者在现有授权内重排）。
import { grantAuthorizes, planChangeItemText, type PlanChangeCardPayload, type PlanConfirmInput, t } from "./protocol.ts";

/** 卡上的一行改动 */
export interface PlanChangeLine {
  key: string;
  text: string;
  /** 扩大了授权，或者改了目标、验收（要用户确认的那几处） */
  expands: boolean;
  /** 新增的授权项：可以勾掉（勾掉后执行到那一步再问用户） */
  grantId?: string;
}

/** 卡上逐行列出的改动 */
export function planChangeLines(p: Pick<PlanChangeCardPayload, "changes" | "grantInfo">): PlanChangeLine[] {
  return p.changes.map((item, i) => ({
    key: `${i}:${item.kind}`,
    text: planChangeItemText(item, p.grantInfo),
    expands: item.expands,
    ...(item.kind === "grant_added" && grantAuthorizes(p.grantInfo[item.grant.id]) ? { grantId: item.grant.id } : {}),
  }));
}

/** 停下来等确认的阶段，写成一句话 */
export function planChangeAffectedText(p: Pick<PlanChangeCardPayload, "affectedStages">): string {
  if (p.affectedStages.length === 0) return t("state.planChangeCard.noneAffected");
  const stages = p.affectedStages.map((s) => t("state.planChangeCard.stage", { id: s.stageId, title: s.title })).join(t("state.planChangeCard.sep"));
  return t("state.planChangeCard.affected", { stages });
}

/** "确认"的输入：卡上勾掉的新增授权项 */
export function planChangeConfirmInput(removed: ReadonlySet<string>): PlanConfirmInput {
  return removed.size > 0 ? { removeGrants: [...removed] } : {};
}
