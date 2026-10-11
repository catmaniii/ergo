/**
 * 流程的计划详情（60 号票）：照搬 AgentSense web/src/ui/DetailPane.tsx 的 PlanDetail（D:\code\claudecode\user_agent_sense_of_security，
 * bedf5a5）——头上"计划 vN"和这份计划现在怎样，目标；涉及的敏感信息；步骤（这份正在执行时带着各步的状态，定时触发的流程按这一次运行）；
 * 改过几版时相对上一版多了哪几步、少了哪几步；计划审查（完整版的审查面板）；检测项全览（RuleBook.tsx）。
 * 数据由状态层的 workflowPlanDetail 给（state/workflow-view.ts）。步骤、审查面板用流程计划卡上的同一套（58 号票照搬的 PlanSteps、ReviewPanel）。
 * 敏感信息的小签按二狗的说法（关注类别、处置、计划授权了没有，和计划卡上每一步的标注一样）。
 */
import { useStore } from "../../app/store.tsx";
import { workflowMarkView, workflowPlanDetail } from "../../state/index.ts";
import { ReviewPanel, WorkflowSteps } from "../cards/WorkflowPlanCard.tsx";
import { RuleBook } from "./RuleBook.tsx";
import { Section } from "./section.tsx";

export function WorkflowPlanDetail({ cardId }: { cardId: string }) {
  const { ui } = useStore();
  const d = workflowPlanDetail(ui, cardId);
  if (!d) return <div className="page-placeholder">这份计划不在了</div>;
  const { plan } = d.payload;
  return (
    <>
      <div className="dt-head">
        <span className="tag tag-plan">计划 v{d.version}</span>
        <span className={`dt-status${d.tone ? ` ${d.tone}` : ""}`}>{d.state}</span>
      </div>
      <div className="dt-title">{plan.goal}</div>
      <Section title="涉及的敏感信息">
        <div className="chips">
          {d.marks.length ? (
            d.marks.map((m) => {
              const view = workflowMarkView(m);
              return (
                <span key={m.category} className={`chip chip-${view.tone}`}>
                  {view.text}
                </span>
              );
            })
          ) : (
            <span className="muted">无</span>
          )}
        </div>
      </Section>
      <Section title="步骤">
        <WorkflowSteps plan={plan} progress={d.progress ?? {}} />
      </Section>
      {d.versions > 1 && (
        <Section title={`版本（共 ${d.versions} 版）`}>
          {d.diff ? (
            <div className="dt-diff">
              <div className="muted">相对 v{d.diff.from} 的变化：</div>
              {d.diff.added.map((t) => (
                <div key={`+${t}`} className="diff-add">
                  + {t}
                </div>
              ))}
              {d.diff.removed.map((t) => (
                <div key={`-${t}`} className="diff-del">
                  − {t}
                </div>
              ))}
              {!d.diff.added.length && !d.diff.removed.length && <div className="muted">步骤标题未变化，参数有调整</div>}
            </div>
          ) : (
            <div className="muted">这是第一版</div>
          )}
        </Section>
      )}
      <Section title="计划审查">
        <ReviewPanel plan={plan} full />
      </Section>
      <RuleBook review={plan.review} />
    </>
  );
}
