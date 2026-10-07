// 按卡片类型选组件。卡片状态只有一份（前端状态层里），聊天、待我处理、任务详情里显示的是同一张。
// 正式的卡片类型注册表和"不认识的卡片显示纯文本加去 Web 处理链接"在 06 号票。
import type { ComponentType } from "react";
import { useCard } from "../../app/store.tsx";
import type { CardType } from "../../model/cards.ts";
import type { CardProps } from "./CardShell.tsx";
import { CardShell, useCardActions } from "./CardShell.tsx";
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

// 每种卡片的负载形状不同，这里只按类型分派
// oxlint-disable-next-line typescript/no-explicit-any
const BY_TYPE: Record<CardType, ComponentType<CardProps<any>>> = {
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

export function CardView({ cardId }: { cardId: string }) {
  const view = useCard(cardId);
  if (!view) return <div className="card muted">卡片 {cardId} 还没收到</div>;
  return <KnownCard view={view} />;
}

function KnownCard({ view }: { view: NonNullable<ReturnType<typeof useCard>> }) {
  const { done, act } = useCardActions(view);
  const Comp = BY_TYPE[view.card.type as CardType];
  if (!Comp) return <CardShell view={view} title="这种卡片还不认识" />;
  return <Comp view={view} payload={view.card.payload} done={done} act={act} />;
}
