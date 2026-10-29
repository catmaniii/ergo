/**
 * 按卡片 id 打开的计划详情（DetailTarget 的 plan）：流程计划卡是 60 号票的计划详情（WorkflowPlanDetail）；长程任务的计划卡、
 * 计划变更卡（91 号票：计划还没确认时点左边图上的一个阶段进来，定位到那一阶段）
 * 头上一行照会话里卡片的详情（种类、第一行、待处理还是已处理），下面是整张卡，定位到那一阶段（focus：细节展开、这一块高亮）。
 * 计划变更卡上只列改了什么，下面再把变更后的各阶段列出来（定位的那一阶段在这里，画的是调整后的整份计划）。
 * 93 号票：加一张小流程图（"流程（从上往下，一个阶段一行；同一行的可以同时做）"，计划变更的标新 / 改、
 * 去掉的也画上），点图上一个阶段定位到下面那一阶段。计划变更的顺序（用户
 * 2026-10-12 定）：为什么要改、改了什么、流程、变更后的各阶段，最后是整张卡（在这里确认或拒绝）；计划卡是流程、整张卡。
 */
import { useStore } from "../../app/store.tsx";
import { CARD_TYPE_LABEL } from "../../model/cards.ts";
import { useState } from "react";
import { cardHeadOf, isCardType, type PlanChangeCardPayload, planChangeAffectedText, planChangeLines, planDetailGraph, t } from "../../state/index.ts";
import { NamedText } from "../assistant-name.tsx";
import { CardPanel } from "../cards/CardPanel.tsx";
import { PlanStageList, StageFocus } from "../cards/PlanStages.tsx";
import { StageGraphMini } from "../conversation/StageGraph.tsx";
import { Section } from "./section.tsx";
import { WorkflowPlanDetail } from "./WorkflowPlanDetail.tsx";

export function PlanCardDetail({ cardId, focus }: { cardId: string; focus?: string | undefined }) {
  const { ui } = useStore();
  // 图上点中的那一阶段：一打开是左边点进来的那一阶段
  const [sel, setSel] = useState(focus);
  const [opened, setOpened] = useState(focus);
  if (focus !== opened) {
    setOpened(focus);
    setSel(focus);
  }
  const head = cardHeadOf(ui, cardId);
  if (!head) return <div className="page-placeholder">{t("ui.planCardDetail.gone")}</div>;
  if (head.cardType === "workflow_plan") return <WorkflowPlanDetail cardId={cardId} />;
  const card = ui.cards[cardId]!.card;
  const graph = planDetailGraph(ui, card);
  const change = card.type === "plan_change" ? (card.payload as PlanChangeCardPayload) : undefined;
  const flow = graph && graph.nodes.length > 0 && (
    <Section title={t("ui.planCardDetail.flow")}>
      <StageGraphMini graph={graph} focus={sel} onNode={setSel} />
    </Section>
  );
  return (
    <StageFocus.Provider value={{ focus: sel }}>
      <div className="dt-head">
        <span className="tag tag-plan">{isCardType(head.cardType) ? CARD_TYPE_LABEL[head.cardType] : t("ui.planCardDetail.cardTag")}</span>
        <span className={`dt-status${head.pending ? "" : " ok"}`}>{head.status}</span>
      </div>
      <div className="dt-title">
        <NamedText text={head.title} />
      </div>
      {change ? (
        <>
          <Section title={t("ui.planCardDetail.why")}>
            <div className="agent-says">{change.why}</div>
          </Section>
          <Section title={t("ui.planCardDetail.what")}>
            <ul className="mp-changes">
              {planChangeLines(change).map((l) => (
                <li key={l.key}>
                  {l.text}
                  {l.expands && <span className="chip chip-high">{t("ui.planCardDetail.needsConfirm")}</span>}
                </li>
              ))}
            </ul>
            <div className="muted">{planChangeAffectedText(change)}</div>
          </Section>
          {flow}
          <Section title={t("ui.planCardDetail.stagesAfter")}>
            <div className="plan-details">
              <PlanStageList plan={change.plan} />
            </div>
          </Section>
        </>
      ) : (
        flow
      )}
      <Section title={t("ui.planCardDetail.cardSection")}>
        <CardPanel cardId={cardId} />
      </Section>
    </StageFocus.Provider>
  );
}
