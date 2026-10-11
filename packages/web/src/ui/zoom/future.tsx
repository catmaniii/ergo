/**
 * 历史底部"接下来的计划"（60 号票）：照搬 AgentSense web/src/ui/ZoomHistory.tsx 的 zh-future（D:\code\claudecode\user_agent_sense_of_security，
 * bedf5a5）——计划里还没执行的步骤仍然留在主线底部，只是画成虚线表示"尚未发生"：没做的虚线，开始做这一步虚线就转成实线，
 * 跳过的划掉、失败的标红；这一格上出现过、没被自动修回的偏差直接标在格里（⚠），被自动修回的另写一行（↺）；
 * 这一步的敏感标注照条右侧的标注那样标在格外右边（zd-right，箭头由 ZoomHistory 的 layoutAnnotations 一起排）。
 * 它在会话内容里、跟着一起缩放：对话层按正常排版画（"还欠几件事"在对话流末尾也看得见），缩小后格子按 --ds 排版，
 * 要点层只剩一行标题，全局层只剩空的虚线块；"接下来的计划"几个字去左边留白。样式在 zoom.css。
 * 数据由状态层的 workflowFuture 给（state/workflow-view.ts）。定时触发的流程按这一次运行算，进度那一行前面写是第几次运行（二狗多的）。
 */
import { slotRiskMarks, type WorkflowFuture, type WorkflowStepMark, workflowMarkView } from "../../state/index.ts";
import type { RiskLevel } from "./marks.tsx";

/** 敏感标注的颜色档（和条右侧的标注同一套 r-high / r-op / r-fix）：永不、交给你做、会被拒绝的是高；执行时仍会问的是 op；计划授权了的是 fix */
function riskLevel(mark: WorkflowStepMark): RiskLevel {
  const tone = workflowMarkView(mark).tone;
  return tone === "high" || tone === "no" ? "high" : tone === "ok" ? "fix" : "op";
}

export function WorkflowFutureBox({ future, run }: { future: WorkflowFuture; run?: number | undefined }) {
  const { slots, done, total, offPlan } = future;
  return (
    <div className="zh-future">
      <div className="zh-future-label">接下来的计划</div>
      <div className="zf-progress">
        {run !== undefined && `第 ${run} 次运行：`}已完成 {done}/{total} 步{offPlan > 0 && <span className="zf-offplan">· 计划外动作 {offPlan} 个</span>}
      </div>
      {slots.map(({ step: s, status, actual, deviations, fixed }) => (
        <div key={s.id} className={`zf-step zf-${status}`} data-actual={actual || undefined}>
          <div className="zf-title">
            {s.title}
            {status === "in_progress" && <span className="zf-tag zf-now">正在执行</span>}
            {status === "skipped" && <span className="zf-tag">已跳过</span>}
            {status === "failed" && <span className="zf-tag zf-bad">失败</span>}
          </div>
          {deviations.length > 0 && <div className="zf-dev">⚠ {deviations.join(" · ")}</div>}
          {fixed.length > 0 && <div className="zf-fixed">↺ {fixed.join(" · ")}</div>}
          <div className="zd-right zf-risks">
            {slotRiskMarks(s).map((m) => {
              const view = workflowMarkView(m);
              return (
                <span key={m.category} className={`zd-risk r-${riskLevel(m)}`}>
                  <svg className="zd-risk-leader" aria-hidden="true">
                    <path />
                  </svg>
                  {view.text}
                </span>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
