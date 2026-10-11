/**
 * 流程计划卡（58 号票，ADR 0019）：照搬 AgentSense 的 PlanCard（web/src/ui/components.tsx）——
 * - 顶上是计划审查面板（ReviewPanel）：显式走完"扫描 → 识别到的风险 → 自动修复 → 修复结果"四步，用户看得见这道检查确实跑过、
 *   查到了什么、动了什么；
 * - 步骤（PlanSteps）：执行中的状态图标、标题、审查插入的标记、审查改写的说法、做完时的要点、敏感标注；
 *   二狗另外逐步写出工具和参数，以及这一步要满足的条件（时序规则写成人话，连同审查时查出的结果：满足、不满足、执行时再查）——
 *   用户要求每一步连同它的条件都写出来；
 * - 授权（AuthActions）：审查要你逐项确认的事项勾完才能"授权执行"；"拒绝"可以附说明，交回维护者。
 * 审查退回维护者、判定不可执行的那一版（refused）也出这张卡（照 AgentSense 把这版计划显示出来），不能授权：
 * 写明原因和下一步——不可执行的"让维护者改"（可以附说明）或"取消任务"，退回的"知道了"（维护者会改好重新提交）或"取消任务"。
 * 审查面板的"扫描"一步下面可以展开逐条规则的复测（照 AgentSense 的 RuleProbe：每条查了多久、查出几处违反、几处判不了）。
 */
import { useState } from "react";
import { useStore } from "../../app/store.tsx";
import {
  WORKFLOW_CONDITION_SOURCE_LABEL,
  WORKFLOW_CONDITION_STATUS_LABEL,
  WORKFLOW_REPAIR_LABEL,
  WORKFLOW_REVIEW_STATUS_LABEL,
  WORKFLOW_STEP_ICON,
  type CardAction,
  type WorkflowPlan,
  type WorkflowPlanCardPayload,
  type TaskStep,
  workflowAuthFigures,
  workflowMarkView,
  workflowReviewFigures,
  workflowStepPatches,
  workflowStepProgress,
  timedWorkflowLine,
  eventWorkflowLines,
  stepEventValuesText,
} from "../../state/index.ts";
import { type CardProps, CardShell } from "./CardShell.tsx";

/** 处理过的卡上怎么写（各个动作在这张卡上的说法） */
const DONE_LABEL: Partial<Record<CardAction, string>> = { confirm: "已授权执行", reject: "已拒绝", return: "已让维护者改", cancel: "已取消任务", ack: "知道了" };

export function WorkflowPlanCard(props: CardProps<WorkflowPlanCardPayload>) {
  const outcome = props.state.card.outcome;
  const doneLabel = outcome && DONE_LABEL[outcome.action] ? `${DONE_LABEL[outcome.action]}${outcome.note ? `：${outcome.note}` : ""}` : undefined;
  return props.payload.refused ? <RefusedPlanCard {...props} doneLabel={doneLabel} /> : <AuthorizablePlanCard {...props} doneLabel={doneLabel} />;
}

/** 等你授权的那一版：审查面板、步骤、要你逐项确认的事项，授权执行或拒绝 */
function AuthorizablePlanCard({ state, payload: p, done, act, doneLabel }: CardProps<WorkflowPlanCardPayload> & { doneLabel: string | undefined }) {
  const { plan } = p;
  const { ui } = useStore();
  const progress = workflowStepProgress(ui.tasks[p.taskId]);
  const [agreed, setAgreed] = useState<Record<string, boolean>>({});
  const [rejecting, setRejecting] = useState(false);
  const [comment, setComment] = useState("");
  const { asks } = workflowReviewFigures(plan.review, plan.steps);
  const missing = asks.filter((i) => !agreed[i.key]).length;
  const auth = workflowAuthFigures(plan);

  return (
    <CardShell
      state={state}
      tag={<span className="tag tag-plan">计划 v{plan.version}</span>}
      title={p.taskTitle}
      {...(doneLabel ? { doneLabel } : {})}
      actions={
        rejecting ? (
          <div className="plan-reject">
            <textarea className="input" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="可以写下为什么、要怎么改，交回给起草计划的维护者（不写也行）" rows={3} />
            <div className="auth-actions">
              <button type="button" className="btn ghost" onClick={() => setRejecting(false)}>
                算了
              </button>
              <button type="button" className="btn danger" onClick={() => act("reject", comment.trim() || undefined)}>
                拒绝
              </button>
            </div>
          </div>
        ) : (
          <>
            <button type="button" className="btn ghost" onClick={() => setRejecting(true)}>
              拒绝
            </button>
            <button type="button" className="btn primary" disabled={missing > 0} onClick={() => act("confirm", undefined, { confirmations: asks.filter((i) => agreed[i.key]).map((i) => i.key) })}>
              {missing > 0 ? `还有 ${missing} 项待确认` : "授权执行"}
            </button>
          </>
        )
      }
    >
      <div className="plan-goal">{plan.goal}</div>
      <div className="plan-sum">
        <span>{plan.steps.length} 步</span>
        <span>
          bash {plan.toolkit.bash ? "开" : "关"}，联网{plan.toolkit.network ? "开" : "关"}（按步骤定）
        </span>
      </div>
      {p.schedule && <div className="auth-timed">{timedWorkflowLine(p.schedule)}</div>}
      {/* 事件触发的流程（77 号票）：在等什么事件、授权管多久、步骤里的占位怎么代入 */}
      {p.event && (
        <div className="auth-timed">
          {eventWorkflowLines(p.event).map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      )}
      <ReviewPanel plan={plan} />
      <WorkflowSteps plan={plan} progress={progress} />
      {!done && (
        <div className="auth">
          <div className="auth-summary">
            本计划涉及 <b>{auth.sensitive}</b> 项敏感操作{auth.stops > 0 ? `，其中 ${auth.stops} 处执行时仍会问你` : ""}。授权后维护者按计划自主执行，每一步要满足的条件执行时照样检查；执行中不能改步骤，要改就重新发起。
          </div>
          {asks.length > 0 && (
            <ul className="auth-confirms">
              {asks.map((i) => (
                <li key={i.key}>
                  <label>
                    <input type="checkbox" checked={!!agreed[i.key]} onChange={(e) => setAgreed((a) => ({ ...a, [i.key]: e.target.checked }))} />
                    <span>{i.text}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </CardShell>
  );
}

/**
 * 审查没让它交给你授权的那一版（refused）：照 AgentSense 把这版计划显示出来，写明原因和下一步；
 * 不可执行的让维护者改（可以附说明）或者取消任务，退回的知道了（维护者改好会重新提交）或者取消任务
 */
function RefusedPlanCard({ state, payload: p, act, doneLabel }: CardProps<WorkflowPlanCardPayload> & { doneLabel: string | undefined }) {
  const { plan } = p;
  const [revising, setRevising] = useState(false);
  const [comment, setComment] = useState("");
  const blocked = p.refused === "blocked";
  const reasons = blocked ? plan.review.violations.map((v) => v.message).filter(Boolean) : plan.review.replans;
  return (
    <CardShell
      state={state}
      tag={<span className="tag tag-plan">计划 v{plan.version}</span>}
      title={p.taskTitle}
      {...(doneLabel ? { doneLabel } : {})}
      actions={
        revising ? (
          <div className="plan-reject">
            <textarea className="input" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="可以写下要怎么改，交回给起草计划的维护者（不写也行）" rows={3} />
            <div className="auth-actions">
              <button type="button" className="btn ghost" onClick={() => setRevising(false)}>
                算了
              </button>
              <button type="button" className="btn primary" onClick={() => act("return", comment.trim() || undefined)}>
                让维护者改
              </button>
            </div>
          </div>
        ) : (
          <>
            <button type="button" className="btn danger" onClick={() => act("cancel")}>
              取消任务
            </button>
            {blocked ? (
              <button type="button" className="btn primary" onClick={() => setRevising(true)}>
                让维护者改
              </button>
            ) : (
              <button type="button" className="btn primary" onClick={() => act("ack")}>
                知道了
              </button>
            )}
          </>
        )
      }
    >
      <div className="plan-goal">{plan.goal}</div>
      <div className="refused-note">
        {blocked ? "审查判定这版计划不能执行，没有交给你授权" : "审查把这版计划退回维护者补充，没有交给你授权"}
        {reasons.length > 0 && (
          <ul className="plain-list">
            {reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
        <div className="muted">
          {blocked ? "可以让维护者改（可以附上你的说明），或者取消任务。" : "维护者会照审查的要求改好重新提交，到时候再给你一张计划卡；不想做了可以取消任务。"}
        </div>
      </div>
      <ReviewPanel plan={plan} />
      <WorkflowSteps plan={plan} progress={{}} />
    </CardShell>
  );
}

/**
 * 计划审查面板：扫描 → 识别到的风险 → 自动修复 → 修复结果（照 AgentSense ReviewPanel）。
 * full：计划详情里的完整版（60 号票，AgentSense 的 full）——每处风险后面写明被哪个修补动作盖掉了、还是修不掉交给你；
 * 判不了的逐条列出；每个修补动作写明盖掉了哪几条、要不要你点头
 */
export function ReviewPanel({ plan, full = false }: { plan: WorkflowPlan; full?: boolean }) {
  const { review } = plan;
  if (review.verdict === "skipped") {
    return (
      <div className="rp">
        <div className="rp-head">🔍 计划审查</div>
        <div className="rp-skip">未审查{review.note ? `：${review.note}` : ""}</div>
      </div>
    );
  }
  const st = WORKFLOW_REVIEW_STATUS_LABEL[review.status ?? "pass"];
  const { repairs, fixed, left, asks } = workflowReviewFigures(review, plan.steps);
  const { violations, deferred } = review;
  return (
    <div className="rp">
      <div className="rp-head">
        🔍 计划审查
        <span className={`rp-verdict ${st.cls}`}>{st.label}</span>
        <span className="rp-ms">{Math.round(review.ms)}ms</span>
      </div>
      {/* 这句是这个面板存在的理由：检查的不是提计划的那个模型自己 */}
      <div className="rp-claim">这份计划在你点「授权执行」之前，已由一套独立于模型的规则检查过一遍。</div>

      <Stage n={1} title="扫描">
        按 {review.scanned.rules} 条规则（框架自带的和计划里写的条件），逐条比对计划里的 {review.scanned.steps} 个步骤
        {review.rules.length > 0 && (
          <details className="rp-probes">
            <summary>逐条规则查了什么</summary>
            <ul className="rp-list">
              {review.rules.map((r) => (
                <li key={r.id}>
                  <span className="rp-rule">{WORKFLOW_CONDITION_SOURCE_LABEL[r.source]}</span>
                  {r.title}：{ruleProbeText(r)}
                </li>
              ))}
            </ul>
          </details>
        )}
      </Stage>

      <Stage n={2} title={`识别到的风险 ${violations.length} 处`} empty={violations.length === 0 && "没有发现违反规则的地方"}>
        <ul className="rp-list">
          {violations.map((v) => {
            const by = v.key ? review.actions.find((a) => a.covers.includes(v.key!)) : undefined;
            return (
              <li key={v.key ?? `${v.property}${v.stepId}${v.message}`}>
                <span className="rp-rule">{v.property}</span>
                <span className="rp-where">{v.stepId}</span>
                {v.message}
                {full && (
                  <span className={by ? "rp-tag rp-tag-ok" : "rp-tag rp-tag-no"}>{by ? `→ ${WORKFLOW_REPAIR_LABEL[by.kind] ?? by.kind}：${by.title}` : "→ 修不掉，交给你判断"}</span>
                )}
              </li>
            );
          })}
        </ul>
        {deferred.length > 0 &&
          (full ? (
            <>
              <div className="rp-note">另有 {deferred.length} 处现在判不了（要看执行时的文件、git 状态），推迟到执行时再查：</div>
              <ul className="rp-list">
                {deferred.map((d) => (
                  <li key={`${d.property}${d.stepId}${d.message}`}>
                    <span className="rp-rule">{d.property}</span>
                    <span className="rp-where">{d.stepId}</span>
                    {d.message}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <div className="rp-note">另有 {deferred.length} 处现在判不了（要看执行时的文件、git 状态），推迟到执行时再查。</div>
          ))}
      </Stage>

      <Stage n={3} title={`自动修复 ${repairs.length} 项`} empty={repairs.length === 0 && (violations.length > 0 ? "这些风险没法自动修，只能交给你判断" : "无需修复")}>
        <ul className="rp-list">
          {repairs.map((a) => (
            <li key={`${a.kind}${a.title}`}>
              <span className="rp-kind">{WORKFLOW_REPAIR_LABEL[a.kind] ?? a.kind}</span>
              {a.title}
              {a.stepId ? `（${a.stepId}）` : ""}
              {full && a.covers.length > 0 && <span className="rp-tag">盖掉 {a.covers.length} 条：{a.covers.join("、")}</span>}
              {full && (a.costs?.interaction ?? 0) > 0 && <span className="rp-tag rp-tag-ask">要你点头</span>}
            </li>
          ))}
        </ul>
      </Stage>

      <Stage n={4} title="修复结果">
        <div className="rp-result">
          {violations.length > 0 && (
            <span>
              {violations.length} 处风险里，<b>{fixed}</b> 处已自动修好
              {left > 0 ? `，${left} 处修不掉` : ""}。
            </span>
          )}
          <span>
            计划由 {review.scanned.steps} 步变成 <b>{plan.steps.length}</b> 步。
          </span>
          {asks.length > 0 && <span className="rp-ask">还有 {asks.length} 项要你逐条确认，勾完才能授权。</span>}
          {/* 用户最关心的其实是这一句：授权之后我还会不会被反复打断 */}
          {review.status !== "blocked" && review.status !== "needs_replan" && (
            <span className="rp-after">
              授权后按这份计划执行
              {deferred.length > 0 ? `，其中 ${deferred.length} 处要到执行时才能判，到那一步不满足的会拦下` : "，预计不会再打断你"}。
            </span>
          )}
          {review.replans.length > 0 && <span className="rp-ask">已退回维护者补充：{review.replans.join("；")}</span>}
          {review.status === "blocked" && <span className="rp-ask">修不了，这份计划不能执行。</span>}
        </div>
      </Stage>
    </div>
  );
}

function Stage({ n, title, empty, children }: { n: number; title: string; empty?: string | false; children?: React.ReactNode }) {
  return (
    <div className="rp-stage">
      <div className="rp-step">
        <span className="rp-n">{n}</span>
        {title}
      </div>
      <div className="rp-body">{empty ? <span className="muted">{empty}</span> : children}</div>
    </div>
  );
}

/** 一条规则的复测结果写成一句："查了 0.4ms，没有违反"、"违反 1 处，判不了 1 处" */
function ruleProbeText(r: WorkflowPlan["review"]["rules"][number]): string {
  if (r.error) return `规则出错：${r.error}`;
  const found = [r.violated > 0 ? `违反 ${r.violated} 处` : "", r.unknown > 0 ? `判不了 ${r.unknown} 处（执行时再查）` : ""].filter(Boolean);
  return `${found.length > 0 ? found.join("，") : "没有违反"}（${r.ms}ms）`;
}

/** 参数写成一行："path=notes.md content=…" */
function argsText(args: Readonly<Record<string, unknown>>): string {
  const pairs = Object.entries(args).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  return pairs.length === 0 ? "（不带参数）" : pairs.join("  ");
}

/** 步骤（照 AgentSense PlanSteps），另写出每一步的工具和参数、要满足的条件（计划详情里也用它，60 号票） */
export function WorkflowSteps({ plan, progress }: { plan: WorkflowPlan; progress: Record<string, TaskStep> }) {
  return (
    <ol className="plan-steps">
      {plan.steps.map((s) => {
        const p = progress[s.id];
        const status = p?.state ?? "pending";
        return (
          <li key={s.id} className={`step step-${status}`}>
            <span className="step-icon">{WORKFLOW_STEP_ICON[status]}</span>
            <div className="step-body">
              <div className="step-title">
                <span className="step-id">{s.id}</span>
                {s.title}
                {s.inserted && <span className="step-flag">审查插入</span>}
                {stepEventValuesText(s) && <span className="step-flag step-event">{stepEventValuesText(s)}</span>}
              </div>
              <div className="step-call">
                <code>{s.tool}</code> {argsText(s.args)}
                {s.after.length > 0 && <span className="muted">（在 {s.after.join("、")} 之后）</span>}
              </div>
              {workflowStepPatches(plan, s).map((x) => (
                <div key={x} className="step-patch">
                  审查改写：{x}
                </div>
              ))}
              {p?.gist && <div className="step-gist">{p.gist}</div>}
              {s.conditions.length > 0 && (
                <ul className="step-conds">
                  {s.conditions.map((c) => (
                    <li key={c.ruleId} className={`cond cond-${c.status}`}>
                      <span className="cond-status">{WORKFLOW_CONDITION_STATUS_LABEL[c.status]}</span>
                      <span className="cond-text">
                        {c.title}：{c.text}
                      </span>
                      <span className="muted">（{WORKFLOW_CONDITION_SOURCE_LABEL[c.source]}）</span>
                      {c.note && <div className="cond-note muted">{c.note}</div>}
                    </li>
                  ))}
                </ul>
              )}
              {s.outside && s.outside.length > 0 && (
                <ul className="plain-list step-outside">
                  {s.outside.map((o) => (
                    <li key={`${o.arg}${o.path}`}>
                      ⚠ {o.arg} 写的是 {o.path}，真实路径在工作目录之外：{o.realPath}
                    </li>
                  ))}
                </ul>
              )}
              {s.marks.length > 0 && (
                <div className="chips">
                  {s.marks.map((m) => {
                    const view = workflowMarkView(m);
                    return (
                      <span key={m.category} className={`chip chip-${view.tone === "op" ? "op" : view.tone === "quiet" ? "quiet" : view.tone}`}>
                        {view.text}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
