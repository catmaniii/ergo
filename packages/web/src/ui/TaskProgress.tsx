/**
 * 任务的进度（60 号票）：AgentSense 会话列表（SessionList.tsx）的小进度条（sl-progress）加"几/几"，没有计划的写"尚无计划"；
 * 定时触发的流程前面多写这是第几次运行（二狗多的，76 号票：按这一次运行算，用户 2026-10-11 定保留）。
 * 看板卡、项目页的内部任务一行都用它；数据是状态层的 taskBoardProgress。
 * 进度条上挂着一共几格（--progress-total，49 号票：像素小屋按它画 HP 格，见 progress-cells.ts）
 */
import type { BoardProgress } from "../state/index.ts";
import { progressCells } from "./progress-cells.ts";

export function TaskProgress({ progress: p }: { progress: BoardProgress }) {
  if (p.total === 0) return <span className="muted">尚无计划</span>;
  return (
    <span className="bcard-progress" title={p.unit === "step" ? `做完 ${p.done}/${p.total} 步` : `已验收 ${p.done} 个阶段，共 ${p.total} 个`}>
      {p.run !== undefined && <span>第 {p.run} 次运行</span>}
      <span className="sl-progress" style={progressCells(p.total)}>
        <i style={{ width: `${(p.done / p.total) * 100}%` }} />
      </span>
      <span>
        {p.done}/{p.total}
      </span>
    </span>
  );
}
