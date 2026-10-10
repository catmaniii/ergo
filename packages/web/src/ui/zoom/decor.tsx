// 缩小后条左边的任务卡、工单卡，和点开看到的完整情况（55 号票，照搬 AgentSense ZoomHistory.tsx 的 TaskHead、TaskDialog）。
// 数据由状态层给（state/zoom-decor.ts 的 zoomLeftCards、zoomTaskFacts、zoomWorkOrderFacts）。
// 任务卡照原样：只放一句总结（计划的目标，没有就是任务），最多两行、放不下用省略号，右边一道计划色的竖线，还没结束的字是计划色；
// 点开弹出这件事的完整情况，能直接进计划详情。工单卡（二狗的项目维护者会话）用同一个样子，点开看工单的情况。
// 弹窗用二狗的 Sheet（居中，带关闭按钮，鸿蒙的返回键能关），经 portal 放到 body 下：缩放内容带着 transform，里面的 fixed 定位会跟着缩
// （AgentSense 同样放到 body 下）。
import { createPortal } from "react-dom";
import { useStore } from "../../app/store.tsx";
import { type ChatItem, type ZoomLeftCard, zoomTaskFacts, zoomWorkOrderFacts } from "../../state/index.ts";
import { Sheet } from "../common.tsx";

/** 条左边的一张卡（AgentSense 的 TaskHead）：只放一句总结，点开弹出完整情况 */
export function LeftCardHead({ card, onOpen }: { card: ZoomLeftCard; onOpen(card: ZoomLeftCard): void }) {
  return (
    <button
      type="button"
      className={`zd-task ${card.live ? "zd-task-live" : ""}`}
      title={card.summary}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(card);
      }}
    >
      <span className="zd-task-title">{card.summary}</span>
    </button>
  );
}

/** 卡的完整情况（AgentSense 的 TaskDialog）：标题（"任务 3 · 进行中"）、一行行事实；任务的能直接进计划详情 */
export function LeftCardDialog({ card, items, onPlan, onClose }: { card: ZoomLeftCard; items: readonly ChatItem[]; onPlan?: ((itemId: string) => void) | undefined; onClose(): void }) {
  const { ui } = useStore();
  const facts = card.kind === "task" ? zoomTaskFacts(ui, card.taskId, items, card.no) : zoomWorkOrderFacts(ui, card.workOrderId, card.summary);
  const { planItemId } = facts;
  return createPortal(
    <Sheet
      center
      title={
        <>
          {facts.title}
          {facts.live && <span className="zd-live"> · 进行中</span>}
        </>
      }
      onClose={onClose}
    >
      <dl className="task-facts">
        {facts.rows.map(([k, v]) => (
          <div key={k} className="task-fact">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <div className="auth-actions">
        {planItemId !== undefined && onPlan && (
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              onClose();
              onPlan(planItemId);
            }}
          >
            看计划详情
          </button>
        )}
        <button type="button" className="btn primary" onClick={onClose}>
          知道了
        </button>
      </div>
    </Sheet>,
    document.body,
  );
}
