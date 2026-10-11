/**
 * 计划里的阶段一块一块列出来（计划卡的"细节"、计划变更卡详情里"变更后的阶段"共用）：第几阶段 · 名字、做法、前置、阶段组、预算、
 * 交付、步骤、初步思路、验收。
 * 91 号票：第几阶段按依赖图的编号（并行的写 4a、4b，"在第 2 阶段之后"同样按编号）；和计划栏联动（StageFocus）——
 * - 计划还没确认时点左边图上的一个阶段，打开这张卡的详情、定位到这一阶段（focus：细节展开，这一块高亮并滚到看得见的地方，
 *   AgentSense MilestonePlanDetail 的 focus）；
 * - 聊天里点一个阶段的名字，左边图上那一阶段高亮（onStep，AgentSense 计划提纲的 onStep → 图上的 mg-focus）。
 */
import { createContext, useContext, useEffect, useRef } from "react";
import { ACCEPTANCE_METHOD_LABEL, tokensLabel } from "../../model/labels.ts";
import { type Plan, stageCodeLabel, stageCodes } from "../../state/index.ts";

/** 计划卡和计划栏的联动：定位到哪一阶段（详情里）、点阶段名字时告诉计划栏（会话里） */
export interface StageFocusValue {
  readonly focus?: string | undefined;
  readonly onStep?: ((stageId: string) => void) | undefined;
}

export const StageFocus = createContext<StageFocusValue>({});

/** 定位的那一阶段：要不要一打开就展开细节 */
export function useStageFocus(): StageFocusValue {
  return useContext(StageFocus);
}

/** 一份计划里的各阶段 */
export function PlanStageList({ plan }: { plan: Pick<Plan, "stages" | "stageGroups"> }) {
  const { focus, onStep } = useStageFocus();
  const codes = stageCodes(plan.stages.map((s) => ({ id: s.stageId, after: s.dependsOn })));
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
                <button type="button" className="link plan-stage-name" onClick={() => onStep(s.stageId)} title="在左边的计划图上看这一阶段">
                  {name}
                </button>
              ) : (
                <b>{name}</b>
              )}
              <span className="muted">
                {" "}
                · {s.mode === "steps" ? "定步" : "开放"}
                {/* 84 号票：为什么选这种模式（照 AgentSense 计划卡"做法"后面括号里那句） */}
                {s.modeReason ? `（${s.modeReason}）` : ""}
                {s.dependsOn.length ? ` · 在${s.dependsOn.map((d) => stageCodeLabel(codes, d)).join("、")}之后` : ""}
                {group ? ` · 阶段组「${group.title}」` : ""} · 预算 {tokensLabel(s.budget.tokens)} token、{s.budget.toolCalls} 次工具调用
              </span>
            </div>
            <div className="muted">交付：{s.deliverables.join("；")}</div>
            {s.steps && <div className="muted">步骤：{s.steps.join(" → ")}</div>}
            {s.mode === "open" && s.roughIdea && <div className="muted">初步思路（只供参考，不限制执行）：{s.roughIdea}</div>}
            <ul className="plain-list">
              {s.acceptance.map((a) => (
                <li key={a.criterion}>
                  验收（{ACCEPTANCE_METHOD_LABEL[a.method]}）：{a.criterion}
                  {a.script && <code> {a.script}</code>}
                  {a.expectOutput?.contains !== undefined && <span className="muted">，输出里要有「{a.expectOutput.contains}」</span>}
                  {a.expectOutput?.matches !== undefined && <span className="muted">，输出要匹配 /{a.expectOutput.matches}/</span>}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
