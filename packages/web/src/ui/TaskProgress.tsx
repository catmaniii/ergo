/**
 * 任务的进度（60 号票）：小进度条（sl-progress）加"几/几"，没有计划的写"尚无计划"；
 * 定时触发的流程前面多写这是第几次运行（76 号票：按这一次运行算，用户 2026-10-11 定保留）。
 * 看板卡、项目页的内部任务一行都用它；数据是状态层的 taskBoardProgress。
 * 进度条上挂着一共几格（--progress-total，49 号票：像素小屋按它画 HP 格，见 progress-cells.ts）
 */
import { type BoardProgress, t } from "../state/index.ts";
import { progressCells } from "./progress-cells.ts";

export function TaskProgress({ progress: p }: { progress: BoardProgress }) {
  if (p.total === 0) return <span className="muted">{t("ui.taskProgress.noPlan")}</span>;
  return (
    <span className="bcard-progress" title={p.unit === "step" ? t("ui.taskProgress.steps", { count: p.total, done: p.done, total: p.total }) : t("ui.taskProgress.stages", { count: p.total, done: p.done, total: p.total })}>
      {p.run !== undefined && <span>{t("ui.taskProgress.run", { no: p.run })}</span>}
      <span className="sl-progress" style={progressCells(p.total)}>
        <i style={{ width: `${(p.done / p.total) * 100}%` }} />
      </span>
      <span>
        {p.done}/{p.total}
      </span>
    </span>
  );
}
