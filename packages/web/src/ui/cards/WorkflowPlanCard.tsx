/**
 * 流程计划卡（58 号票，ADR 0019）——
 * - 顶上是计划审查面板（ReviewPanel）：显式走完"扫描 → 识别到的风险 → 自动修复 → 修复结果"四步，用户看得见这道检查确实跑过、
 *   查到了什么、动了什么；
 * - 步骤（PlanSteps）：执行中的状态图标、标题、审查插入的标记、审查改写的说法、做完时的要点、敏感标注；
 *   二狗另外逐步写出工具和参数，以及这一步要满足的条件（时序规则写成人话，连同审查时查出的结果：满足、不满足、执行时再查）——
 *   用户要求每一步连同它的条件都写出来；
 * - 授权（AuthActions）：审查要你逐项确认的事项勾完才能"授权执行"；"拒绝"可以附说明，交回维护者。
 * 审查退回维护者、判定不可执行的那一版（refused）也出这张卡（这版计划也显示出来），不能授权：
 * 写明原因和下一步——不可执行的"让维护者改"（可以附说明）或"取消任务"，退回的"知道了"（维护者会改好重新提交）或"取消任务"。
 * 审查面板的"扫描"一步下面可以展开逐条规则的复测（每条查了多久、查出几处违反、几处判不了）。
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
  t,
  tTable,
} from "../../state/index.ts";
import { T } from "../i18n.tsx";
import { type CardProps, CardShell } from "./CardShell.tsx";

/** 处理过的卡上怎么写（各个动作在这张卡上的说法） */
const DONE_LABEL: Readonly<Partial<Record<CardAction, string>>> = tTable({
  confirm: "ui.workflowPlanCard.done.confirm",
  reject: "ui.workflowPlanCard.done.reject",
  return: "ui.workflowPlanCard.done.return",
  cancel: "ui.workflowPlanCard.done.cancel",
  ack: "ui.workflowPlanCard.done.ack",
});

export function WorkflowPlanCard(props: CardProps<WorkflowPlanCardPayload>) {
  const outcome = props.state.card.outcome;
  const doneLabel = outcome && DONE_LABEL[outcome.action] ? `${DONE_LABEL[outcome.action]}${outcome.note ? t("ui.workflowPlanCard.doneNote", { note: outcome.note }) : ""}` : undefined;
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
      tag={<span className="tag tag-plan">{t("ui.workflowPlanCard.version", { version: plan.version })}</span>}
      title={p.taskTitle}
      {...(doneLabel ? { doneLabel } : {})}
      actions={
        rejecting ? (
          <div className="plan-reject">
            <textarea className="input" value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t("ui.workflowPlanCard.rejectPlaceholder")} rows={3} />
            <div className="auth-actions">
              <button type="button" className="btn ghost" onClick={() => setRejecting(false)}>
                {t("ui.workflowPlanCard.cancelReject")}
              </button>
              <button type="button" className="btn danger" onClick={() => act("reject", comment.trim() || undefined)}>
                {t("ui.workflowPlanCard.reject")}
              </button>
            </div>
          </div>
        ) : (
          <>
            <button type="button" className="btn ghost" onClick={() => setRejecting(true)}>
              {t("ui.workflowPlanCard.reject")}
            </button>
            <button type="button" className="btn primary" disabled={missing > 0} onClick={() => act("confirm", undefined, { confirmations: asks.filter((i) => agreed[i.key]).map((i) => i.key) })}>
              {missing > 0 ? t("ui.workflowPlanCard.missing", { count: missing }) : t("ui.workflowPlanCard.authorize")}
            </button>
          </>
        )
      }
    >
      <div className="plan-goal">{plan.goal}</div>
      <div className="plan-sum">
        <span>{t("ui.workflowPlanCard.steps", { count: plan.steps.length })}</span>
        <span>
          {t("ui.workflowPlanCard.toolkit", {
            bash: plan.toolkit.bash ? t("ui.workflowPlanCard.on") : t("ui.workflowPlanCard.off"),
            network: plan.toolkit.network ? t("ui.workflowPlanCard.on") : t("ui.workflowPlanCard.off"),
          })}
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
            <T
              k="ui.workflowPlanCard.authSummary"
              params={{ n: <b>{auth.sensitive}</b>, count: auth.sensitive, stops: auth.stops > 0 ? t("ui.workflowPlanCard.authStops", { count: auth.stops }) : "" }}
            />
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
 * 审查没让它交给你授权的那一版（refused）：也把这版计划显示出来，写明原因和下一步；
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
      tag={<span className="tag tag-plan">{t("ui.workflowPlanCard.version", { version: plan.version })}</span>}
      title={p.taskTitle}
      {...(doneLabel ? { doneLabel } : {})}
      actions={
        revising ? (
          <div className="plan-reject">
            <textarea className="input" value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t("ui.workflowPlanCard.refused.revisePlaceholder")} rows={3} />
            <div className="auth-actions">
              <button type="button" className="btn ghost" onClick={() => setRevising(false)}>
                {t("ui.workflowPlanCard.cancelReject")}
              </button>
              <button type="button" className="btn primary" onClick={() => act("return", comment.trim() || undefined)}>
                {t("ui.workflowPlanCard.refused.revise")}
              </button>
            </div>
          </div>
        ) : (
          <>
            <button type="button" className="btn danger" onClick={() => act("cancel")}>
              {t("ui.workflowPlanCard.refused.cancelTask")}
            </button>
            {blocked ? (
              <button type="button" className="btn primary" onClick={() => setRevising(true)}>
                {t("ui.workflowPlanCard.refused.revise")}
              </button>
            ) : (
              <button type="button" className="btn primary" onClick={() => act("ack")}>
                {t("ui.workflowPlanCard.refused.ack")}
              </button>
            )}
          </>
        )
      }
    >
      <div className="plan-goal">{plan.goal}</div>
      <div className="refused-note">
        {blocked ? t("ui.workflowPlanCard.refused.blocked") : t("ui.workflowPlanCard.refused.replan")}
        {reasons.length > 0 && (
          <ul className="plain-list">
            {reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
        <div className="muted">
          {blocked ? t("ui.workflowPlanCard.refused.blockedNext") : t("ui.workflowPlanCard.refused.replanNext")}
        </div>
      </div>
      <ReviewPanel plan={plan} />
      <WorkflowSteps plan={plan} progress={{}} />
    </CardShell>
  );
}

/**
 * 计划审查面板：扫描 → 识别到的风险 → 自动修复 → 修复结果。
 * full：计划详情里的完整版（60 号票）——每处风险后面写明被哪个修补动作盖掉了、还是修不掉交给你；
 * 判不了的逐条列出；每个修补动作写明盖掉了哪几条、要不要你点头
 */
export function ReviewPanel({ plan, full = false }: { plan: WorkflowPlan; full?: boolean }) {
  const { review } = plan;
  if (review.verdict === "skipped") {
    return (
      <div className="rp">
        <div className="rp-head">🔍 {t("ui.workflowPlanCard.review.title")}</div>
        <div className="rp-skip">{review.note ? t("ui.workflowPlanCard.review.skippedNote", { note: review.note }) : t("ui.workflowPlanCard.review.skipped")}</div>
      </div>
    );
  }
  const st = WORKFLOW_REVIEW_STATUS_LABEL[review.status ?? "pass"];
  const { repairs, fixed, left, asks } = workflowReviewFigures(review, plan.steps);
  const { violations, deferred } = review;
  return (
    <div className="rp">
      <div className="rp-head">
        🔍 {t("ui.workflowPlanCard.review.title")}
        <span className={`rp-verdict ${st.cls}`}>{st.label}</span>
        <span className="rp-ms">{Math.round(review.ms)}ms</span>
      </div>
      {/* 这句是这个面板存在的理由：检查的不是提计划的那个模型自己 */}
      <div className="rp-claim">{t("ui.workflowPlanCard.review.claim")}</div>

      <Stage n={1} title={t("ui.workflowPlanCard.review.scan")}>
        {t("ui.workflowPlanCard.review.scanText", { rules: review.scanned.rules, steps: review.scanned.steps })}
        {review.rules.length > 0 && (
          <details className="rp-probes">
            <summary>{t("ui.workflowPlanCard.review.probes")}</summary>
            <ul className="rp-list">
              {review.rules.map((r) => (
                <li key={r.id}>
                  <span className="rp-rule">{WORKFLOW_CONDITION_SOURCE_LABEL[r.source]}</span>
                  {t("ui.workflowPlanCard.review.ruleLine", { title: r.title, result: ruleProbeText(r) })}
                </li>
              ))}
            </ul>
          </details>
        )}
      </Stage>

      <Stage n={2} title={t("ui.workflowPlanCard.review.risks", { count: violations.length })} empty={violations.length === 0 && t("ui.workflowPlanCard.review.noRisks")}>
        <ul className="rp-list">
          {violations.map((v) => {
            const by = v.key ? review.actions.find((a) => a.covers.includes(v.key!)) : undefined;
            return (
              <li key={v.key ?? `${v.property}${v.stepId}${v.message}`}>
                <span className="rp-rule">{v.property}</span>
                <span className="rp-where">{v.stepId}</span>
                {v.message}
                {full && (
                  <span className={by ? "rp-tag rp-tag-ok" : "rp-tag rp-tag-no"}>{by ? t("ui.workflowPlanCard.review.fixedBy", { kind: WORKFLOW_REPAIR_LABEL[by.kind] ?? by.kind, title: by.title }) : t("ui.workflowPlanCard.review.unfixable")}</span>
                )}
              </li>
            );
          })}
        </ul>
        {deferred.length > 0 &&
          (full ? (
            <>
              <div className="rp-note">{t("ui.workflowPlanCard.review.deferredList", { count: deferred.length })}</div>
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
            <div className="rp-note">{t("ui.workflowPlanCard.review.deferred", { count: deferred.length })}</div>
          ))}
      </Stage>

      <Stage
        n={3}
        title={t("ui.workflowPlanCard.review.repairs", { count: repairs.length })}
        empty={repairs.length === 0 && (violations.length > 0 ? t("ui.workflowPlanCard.review.cantRepair") : t("ui.workflowPlanCard.review.noRepair"))}
      >
        <ul className="rp-list">
          {repairs.map((a) => (
            <li key={`${a.kind}${a.title}`}>
              <span className="rp-kind">{WORKFLOW_REPAIR_LABEL[a.kind] ?? a.kind}</span>
              {a.title}
              {a.stepId ? t("ui.workflowPlanCard.review.repairStep", { step: a.stepId }) : ""}
              {full && a.covers.length > 0 && <span className="rp-tag">{t("ui.workflowPlanCard.review.covers", { count: a.covers.length, list: a.covers.join(t("ui.common.listSep")) })}</span>}
              {full && (a.costs?.interaction ?? 0) > 0 && <span className="rp-tag rp-tag-ask">{t("ui.workflowPlanCard.review.needsOk")}</span>}
            </li>
          ))}
        </ul>
      </Stage>

      <Stage n={4} title={t("ui.workflowPlanCard.review.result")}>
        <div className="rp-result">
          {violations.length > 0 && (
            <span>
              <T
                k="ui.workflowPlanCard.review.fixed"
                params={{ total: violations.length, count: violations.length, fixed: <b>{fixed}</b>, left: left > 0 ? t("ui.workflowPlanCard.review.left", { count: left }) : "" }}
              />
            </span>
          )}
          <span>
            <T k="ui.workflowPlanCard.review.stepsChange" params={{ from: review.scanned.steps, to: <b>{plan.steps.length}</b> }} />
          </span>
          {asks.length > 0 && <span className="rp-ask">{t("ui.workflowPlanCard.review.asks", { count: asks.length })}</span>}
          {/* 用户最关心的其实是这一句：授权之后我还会不会被反复打断 */}
          {review.status !== "blocked" && review.status !== "needs_replan" && (
            <span className="rp-after">
              {t("ui.workflowPlanCard.review.after", {
                rest: deferred.length > 0 ? t("ui.workflowPlanCard.review.afterDeferred", { count: deferred.length }) : t("ui.workflowPlanCard.review.afterQuiet"),
              })}
            </span>
          )}
          {review.replans.length > 0 && <span className="rp-ask">{t("ui.workflowPlanCard.review.replans", { list: review.replans.join(t("ui.workflowPlanCard.itemSep")) })}</span>}
          {review.status === "blocked" && <span className="rp-ask">{t("ui.workflowPlanCard.review.blocked")}</span>}
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
  if (r.error) return t("ui.workflowPlanCard.probe.error", { error: r.error });
  const found = [
    r.violated > 0 ? t("ui.workflowPlanCard.probe.violated", { count: r.violated }) : "",
    r.unknown > 0 ? t("ui.workflowPlanCard.probe.unknown", { count: r.unknown }) : "",
  ].filter(Boolean);
  return t("ui.workflowPlanCard.probe.timed", { result: found.length > 0 ? found.join(t("ui.workflowPlanCard.probe.sep")) : t("ui.workflowPlanCard.probe.clean"), ms: r.ms });
}

/** 参数写成一行："path=notes.md content=…" */
function argsText(args: Readonly<Record<string, unknown>>): string {
  const pairs = Object.entries(args).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  return pairs.length === 0 ? t("ui.workflowPlanCard.noArgs") : pairs.join("  ");
}

/** 步骤，另写出每一步的工具和参数、要满足的条件（计划详情里也用它，60 号票） */
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
                {s.inserted && <span className="step-flag">{t("ui.workflowPlanCard.step.inserted")}</span>}
                {stepEventValuesText(s) && <span className="step-flag step-event">{stepEventValuesText(s)}</span>}
              </div>
              <div className="step-call">
                <code>{s.tool}</code> {argsText(s.args)}
                {s.after.length > 0 && <span className="muted">{t("ui.workflowPlanCard.step.after", { steps: s.after.join(t("ui.common.listSep")) })}</span>}
              </div>
              {workflowStepPatches(plan, s).map((x) => (
                <div key={x} className="step-patch">
                  {t("ui.workflowPlanCard.step.patch", { text: x })}
                </div>
              ))}
              {p?.gist && <div className="step-gist">{p.gist}</div>}
              {s.conditions.length > 0 && (
                <ul className="step-conds">
                  {s.conditions.map((c) => (
                    <li key={c.ruleId} className={`cond cond-${c.status}`}>
                      <span className="cond-status">{WORKFLOW_CONDITION_STATUS_LABEL[c.status]}</span>
                      <span className="cond-text">
                        {t("ui.workflowPlanCard.step.condition", { title: c.title, text: c.text })}
                      </span>
                      <span className="muted">{t("ui.workflowPlanCard.step.conditionSource", { source: WORKFLOW_CONDITION_SOURCE_LABEL[c.source] })}</span>
                      {c.note && <div className="cond-note muted">{c.note}</div>}
                    </li>
                  ))}
                </ul>
              )}
              {s.outside && s.outside.length > 0 && (
                <ul className="plain-list step-outside">
                  {s.outside.map((o) => (
                    <li key={`${o.arg}${o.path}`}>
                      {t("ui.workflowPlanCard.step.outside", { arg: o.arg, path: o.path, real: o.realPath })}
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
