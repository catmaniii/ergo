// 按卡片类型选组件。卡片状态只有一份（前端状态层里），聊天、待我处理、任务详情里显示的是同一张。
// 不认识的类型、或者负载版本比这个页面新的卡（state/cards.ts 的 cardDisplay 判断），显示服务端给的纯文本降级版本，
// 加上"去 Web 处理"的链接：刷新成最新的 Web 页面，在单独显示这张卡的页面里处理。
import type { ComponentType } from "react";
import { useStore } from "../../app/store.tsx";
import { type CardDisplay, cardDisplay, type CardState, type CardType } from "../../state/index.ts";
import { type CardProps, useCardActions } from "./CardShell.tsx";
import {
  ApprovalCard,
  CharterCard,
  MemoryDeleteCard,
  PairingCard,
  ParallelCard,
  ProgressCard,
  QuestionsCard,
  QuickActionCard,
  ReminderCard,
  SuggestProjectCard,
  SuggestTaskCard,
  WorkOrderCard,
} from "./cards.tsx";
import { PlanCard } from "./PlanCard.tsx";
import { PlanChangeCard } from "./PlanChangeCard.tsx";

// 每种卡片的负载形状不同；CardProps<never> 能接住任何一种负载的组件
const BY_TYPE: Record<CardType, ComponentType<CardProps<never>>> = {
  plan: PlanCard,
  approval: ApprovalCard,
  questions: QuestionsCard,
  progress: ProgressCard,
  quick_action: QuickActionCard,
  suggest_task: SuggestTaskCard,
  suggest_project: SuggestProjectCard,
  reminder: ReminderCard,
  charter: CharterCard,
  work_order: WorkOrderCard,
  plan_change: PlanChangeCard,
  parallel: ParallelCard,
  memory_delete: MemoryDeleteCard,
  pairing: PairingCard,
};

/** 一张卡片：按 id 从前端状态层取，按类型选组件；不认识的显示纯文本降级版本 */
export function CardPanel({ cardId }: { cardId: string }) {
  const display = cardDisplay(useStore().ui, cardId);
  if (!display) return <div className="card muted">卡片 {cardId} 还没收到</div>;
  if (display.kind === "fallback") return <FallbackCard display={display} />;
  return <TypedCard state={display.state} type={display.type} />;
}

function TypedCard({ state, type }: { state: CardState; type: CardType }) {
  const { done, act } = useCardActions(state);
  const Comp = BY_TYPE[type];
  // 负载由守护进程按卡片类型注册表里的 schema 校验过
  return <Comp state={state} payload={state.card.payload as never} done={done} act={act} />;
}

function FallbackCard({ display }: { display: Extract<CardDisplay, { kind: "fallback" }> }) {
  return (
    <div className="card xcard card-fallback">
      <div className="xcard-head">
        <span className="xcard-tag">卡片</span>
        <span className="xcard-title">{display.reason === "unknown_type" ? "这个页面还不认识这种卡片" : "这张卡片比这个页面新"}</span>
      </div>
      <div className="xcard-body">
        <div className="fallback-text">{display.text}</div>
        <a
          className="link"
          href={display.webPath}
          onClick={(e) => {
            // 这个页面处理不了：换到这张卡的页面，并刷新成守护进程上最新的 Web
            e.preventDefault();
            window.location.hash = display.webPath;
            window.location.reload();
          }}
        >
          去 Web 处理
        </a>
      </div>
    </div>
  );
}
