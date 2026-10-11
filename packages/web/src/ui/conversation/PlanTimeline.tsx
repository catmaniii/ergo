/**
 * 流程会话标题栏上的进度条和点开的计划台账（60 号票）：照搬 AgentSense（D:\code\claudecode\user_agent_sense_of_security，bedf5a5）
 * web/src/App.tsx 标题栏里的 button.progress（做完的步骤 / 总步数，点开是计划台账）和 web/src/ui/PlanTimeline.tsx。
 * 台账：这个任务提过的每一份计划，按先后——哪一版被审查退回、哪一版是修补后授权的、哪一版被你拒了，都能翻回去看；当前那份写
 * "做完几步/共几步"，点一行打开那份计划的详情（会话里翻到了那张卡的打开那一条，没翻到的按卡打开）。
 * 数据由状态层给（state/workflow-view.ts 的 workflowProgress、workflowPlanLedger）。
 * 定时触发的流程按这一次运行算（二狗多的：标题、按钮的说明里写是第几次运行）。
 * 弹窗用二狗的 Sheet（居中，多一个 ×，鸿蒙的返回键能关；55 号票的任务卡弹窗同样这样），经 portal 放到 body 下。
 */
import { useMemo } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../../app/store.tsx";
import { chatItems, type ConversationId, type WorkflowProgress, workflowPlanLedger } from "../../state/index.ts";
import { Sheet } from "../common.tsx";

/** 标题栏上的进度条（AgentSense App.tsx 的 button.progress）：点开是计划台账 */
export function PlanProgress({ progress, onOpen }: { progress: WorkflowProgress; onOpen(): void }) {
  const { done, total, run } = progress;
  const what = `${run ? `第 ${run.no} 次运行，` : ""}做完 ${done}/${total} 步`;
  return (
    <button type="button" className="progress" onClick={onOpen} aria-label={`${what}，查看计划台账`} title={what}>
      <div className="progress-bar">
        <div style={{ width: `${total > 0 ? (done / total) * 100 : 0}%` }} />
      </div>
      <span>
        {done}/{total}
      </span>
      <span className="progress-caret">›</span>
    </button>
  );
}

/** 计划台账（AgentSense PlanTimeline）：onOpen 给的是会话里那一条的 id（翻到了的）或卡片 id */
export function PlanTimeline({
  taskId,
  conversation,
  onOpen,
  onClose,
}: {
  taskId: string;
  conversation: ConversationId;
  onOpen(target: { itemId: string } | { cardId: string }): void;
  onClose(): void;
}) {
  const { ui } = useStore();
  const items = useMemo(() => chatItems(ui, conversation), [ui, conversation]);
  const rows = workflowPlanLedger(ui, taskId, items);
  return createPortal(
    <Sheet title={`计划台账（${rows.length} 份）`} onClose={onClose} center>
      <div className="pt">
        {rows.length === 0 && <div className="muted">这个任务还没有提交过计划。</div>}
        <div className="pt-list">
          {rows.map((r) => (
            <button
              type="button"
              key={r.cardId}
              className={`pt-row ${r.live ? "pt-live" : ""}`}
              onClick={() => {
                onOpen(r.itemId !== undefined ? { itemId: r.itemId } : { cardId: r.cardId });
                onClose();
              }}
            >
              <div className="pt-row-head">
                <span className="tag tag-plan">v{r.version}</span>
                <span className="pt-state">{r.state}</span>
                {r.live && <span className="pt-now">当前</span>}
                <span className="pt-steps">{r.steps}</span>
              </div>
              <div className="pt-goal">{r.goal}</div>
              <div className="pt-meta">{r.meta}</div>
            </button>
          ))}
        </div>
        <div className="auth-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </Sheet>,
    document.body,
  );
}
