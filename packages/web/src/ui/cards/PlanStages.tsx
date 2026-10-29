/**
 * 计划里的阶段一块一块列出来（计划卡的"细节"、计划变更卡详情里"变更后的阶段"共用）：第几阶段 · 名字、做法、前置、阶段组、预算、
 * 交付、步骤、初步思路、验收。
 * 91 号票：第几阶段按依赖图的编号（并行的写 4a、4b，"在第 2 阶段之后"同样按编号）；和计划栏联动（StageFocus）——
 * - 计划还没确认时点左边图上的一个阶段，打开这张卡的详情、定位到这一阶段（focus：细节展开，这一块高亮并滚到看得见的地方）；
 * - 聊天里点一个阶段的名字，左边图上那一阶段高亮（onStep → 图上的 mg-focus）。
 */
import { createContext, useContext, useEffect, useRef } from "react";
import { ACCEPTANCE_METHOD_LABEL, tokensLabel } from "../../model/labels.ts";
import { type Plan, planStageCodes, stageCodeLabel, t } from "../../state/index.ts";

/**
 * 计划卡和计划栏的联动：定位到哪一阶段（详情里）、点阶段名字时告诉计划栏（会话里）；93 号票的提纲还要：打开一个阶段的阶段详情
 * （onStage，计划确认了、在执行的）、打开这张卡的计划详情并定位到某一阶段（openPlan，还没确认的；不给阶段就是整张卡的详情）
 */
export interface StageFocusValue {
  readonly focus?: string | undefined;
  readonly onStep?: ((stageId: string) => void) | undefined;
  readonly onStage?: ((stageId: string) => void) | undefined;
  readonly openPlan?: ((cardId: string, stageId?: string) => void) | undefined;
}

export const StageFocus = createContext<StageFocusValue>({});

/** 定位的那一阶段：要不要一打开就展开细节 */
export function useStageFocus(): StageFocusValue {
  return useContext(StageFocus);
}

/** 一份计划里的各阶段 */
export function PlanStageList({ plan }: { plan: Pick<Plan, "stages" | "stageGroups"> }) {
  const { focus, onStep } = useStageFocus();
  // 93 号票：编号照计划里存的（之前的计划没存，按依赖图现算）
  const codes = planStageCodes(plan);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focus !== undefined) box.current?.querySelector(".plan-stage-focus")?.scrollIntoView({ block: "center" });
  }, [focus]);
  return (
    <div ref={box} className="plan-stages">
      {plan.stages.map((s) => {
        const group = plan.stageGroups.find((g) => g.groupId === s.groupId);
        const name = `${stageCodeLabel(codes, s.stageId)} · ${s.title}`;
        return (
          <div key={s.stageId} className={`plan-stage${focus === s.stageId ? " plan-stage-focus" : ""}`}>
            <div>
              {onStep ? (
                <button type="button" className="link plan-stage-name" onClick={() => onStep(s.stageId)} title={t("ui.planStages.showOnGraph")}>
                  {name}
                </button>
              ) : (
                <b>{name}</b>
              )}
              <span className="muted">
                {" "}
                · {s.mode === "steps" ? t("ui.planStages.modeSteps") : t("ui.planStages.modeOpen")}
                {/* 84 号票：为什么选这种模式（"做法"后面括号里那句） */}
                {s.modeReason ? t("ui.planStages.modeReason", { reason: s.modeReason }) : ""}
                {s.dependsOn.length ? t("ui.planStages.after", { stages: s.dependsOn.map((d) => stageCodeLabel(codes, d)).join(t("ui.common.listSep")) }) : ""}
                {group ? t("ui.planStages.group", { title: group.title }) : ""}
                {t("ui.planStages.budget", { tokens: tokensLabel(s.budget.tokens), count: s.budget.toolCalls })}
              </span>
            </div>
            <div className="muted">{t("ui.planStages.deliverables", { list: s.deliverables.join(t("ui.planStages.itemSep")) })}</div>
            {s.steps && <div className="muted">{t("ui.planStages.steps", { steps: s.steps.join(" → ") })}</div>}
            {s.mode === "open" && s.roughIdea && <div className="muted">{t("ui.planStages.roughIdea", { idea: s.roughIdea })}</div>}
            <ul className="plain-list">
              {s.acceptance.map((a) => (
                <li key={a.criterion}>
                  {t("ui.planStages.acceptance", { method: ACCEPTANCE_METHOD_LABEL[a.method], criterion: a.criterion })}
                  {a.script && <code> {a.script}</code>}
                  {a.expectOutput?.contains !== undefined && <span className="muted">{t("ui.planStages.expectContains", { text: a.expectOutput.contains })}</span>}
                  {a.expectOutput?.matches !== undefined && <span className="muted">{t("ui.planStages.expectMatches", { pattern: a.expectOutput.matches })}</span>}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
