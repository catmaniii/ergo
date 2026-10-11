/**
 * 按卡片 id 打开的计划详情（DetailTarget 的 plan）：流程计划卡是 60 号票的计划详情（WorkflowPlanDetail）；长程任务的计划卡、
 * 计划变更卡（91 号票：计划还没确认时点左边图上的一个阶段进来，AgentSense openStage → MilestonePlanDetail 的 focus）
 * 头上一行照会话里卡片的详情（种类、第一行、待处理还是已处理），下面是整张卡，定位到那一阶段（focus：细节展开、这一块高亮）。
 * 计划变更卡上只列改了什么，下面再把变更后的各阶段列出来（定位的那一阶段在这里，AgentSense 画的也是调整后的整份计划）。
 */
import { useStore } from "../../app/store.tsx";
import { CARD_TYPE_LABEL } from "../../model/cards.ts";
import { cardHeadOf, isCardType, type PlanChangeCardPayload } from "../../state/index.ts";
import { NamedText } from "../assistant-name.tsx";
import { CardPanel } from "../cards/CardPanel.tsx";
import { PlanStageList, StageFocus } from "../cards/PlanStages.tsx";
import { Section } from "./section.tsx";
import { WorkflowPlanDetail } from "./WorkflowPlanDetail.tsx";

export function PlanCardDetail({ cardId, focus }: { cardId: string; focus?: string | undefined }) {
  const { ui } = useStore();
  const head = cardHeadOf(ui, cardId);
  if (!head) return <div className="page-placeholder">这份计划不在了</div>;
  if (head.cardType === "workflow_plan") return <WorkflowPlanDetail cardId={cardId} />;
  const card = ui.cards[cardId]!.card;
  return (
    <StageFocus.Provider value={{ focus }}>
      <div className="dt-head">
        <span className="tag tag-plan">{isCardType(head.cardType) ? CARD_TYPE_LABEL[head.cardType] : "卡片"}</span>
        <span className={`dt-status${head.pending ? "" : " ok"}`}>{head.status}</span>
      </div>
      <div className="dt-title">
        <NamedText text={head.title} />
      </div>
      <Section title="卡片">
        <CardPanel cardId={cardId} />
      </Section>
      {card.type === "plan_change" && (
        <Section title="变更后的各阶段">
          <div className="plan-details">
            <PlanStageList plan={(card.payload as PlanChangeCardPayload).plan} />
          </div>
        </Section>
      )}
    </StageFocus.Provider>
  );
}
