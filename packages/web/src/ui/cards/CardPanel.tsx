// 按卡片类型选组件。卡片状态只有一份（前端状态层里），聊天、待我处理、任务详情里显示的是同一张。
// 正式的卡片类型注册表（schema、版本、纯文本降级）和"不认识的卡片显示纯文本加去 Web 处理链接"在 06 号票，
// 建在状态层的 CARD_TYPES 上。
import type { ComponentType } from "react";
import { useCard } from "../../app/store.tsx";
import { type CardState, type CardType, isCardType } from "../../state/index.ts";
import { type CardProps, CardShell, useCardActions } from "./CardShell.tsx";
import {
  ApprovalCard,
  CharterCard,
  MemoryDeleteCard,
  PairingCard,
  ParallelCard,
  PlanChangeCard,
  ProgressCard,
  QuestionsCard,
  QuickActionCard,
  ReminderCard,
  SuggestProjectCard,
  SuggestTaskCard,
  WorkOrderCard,
} from "./cards.tsx";
import { PlanCard } from "./PlanCard.tsx";

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

/** 一张卡片：按 id 从前端状态层取，按类型选组件 */
export function CardPanel({ cardId }: { cardId: string }) {
  const state = useCard(cardId);
  if (!state) return <div className="card muted">卡片 {cardId} 还没收到</div>;
  return <TypedCard state={state} />;
}

function TypedCard({ state }: { state: CardState }) {
  const { done, act } = useCardActions(state);
  const type = state.card.type;
  if (!isCardType(type)) return <CardShell state={state} title="这种卡片还不认识" />;
  const Comp = BY_TYPE[type];
  // 负载按类型的 schema 校验是 06 号票的事；这里相信服务端给的负载和类型对得上
  return <Comp state={state} payload={state.card.payload as never} done={done} act={act} />;
}
