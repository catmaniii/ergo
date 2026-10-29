/**
 * 运营方案（130 号票，ADR-0028）：项目的维护者用 propose_operations 交的"项目转入使用后怎么运转"。
 * - "首版做完了"卡上的一节（OperationsPlanSection）：标题"转入使用后会开起来的"，每一条写叫什么、什么时候（触发）、怎么做（普通任务
 *   或流程）、每次做什么、要的能力、失败时怎样；二狗现在还做不了的（公网入口）标"这一项二狗现在还做不了，需要你手动：……"；
 *   流程的那几条能展开步骤，审查要你逐项确认的事项勾完才能"确认并转入使用"；确认之后每一条后面写结局（已开起来、没生效及原因）；
 * - "运营方案变更"卡（OperationsChangeCard）：使用中的项目交的新方案和现在生效的比出的差异——加上、改了（改了哪几处，只改了时间的
 *   就地改）、去掉、重新开起来，照旧的另列一行；附上运行时核实过的你的原话；确认一次就照差异生效，拒绝什么都不动。
 * 每一条的样子两处一样（OperationItemView）；项目页"运营方案"一节列现在生效的每一条和状态（ProjectsPage）。
 * 133 号票：服务那一条（means: service）写"上线服务「X」（端口 …，开机自启）"，下面一项项列启动命令、工作目录、端口、环境变量（密钥只写
 * 引用）、健康检查、开机自启、网页；生效之后不写"已开起来"，换成项目的服务的入口"打开「X」"和在不在线（ui/service-entry.tsx）。
 * 改了的服务确认后是"更新 LSM 里的登记、重启服务"
 */
import { Fragment, type ReactNode, useState } from "react";
import {
  capabilitiesText,
  OPERATION_APPROACH_LABEL,
  OPERATION_CHANGE_LABEL,
  OPERATION_OUTCOME_LABEL,
  operationChangedFields,
  OPERATIONS_GRANT_TEXT,
  OPERATIONS_MANUAL_PREFIX,
  OPERATIONS_SECTION_TITLE,
  operationsChangeGroups,
  operationsConfirmationItems,
  type OperationItem,
  type OperationResult,
  type OperationsChangeCardPayload,
  type OperationsPlanView,
  serviceByApp,
  type ServiceEntryCardPayload,
  serviceOfItem,
  serviceSpecRows,
  t,
} from "../../state/index.ts";
import { useStore } from "../../app/store.tsx";
import { CARD_TYPE_LABEL } from "../../model/cards.ts";
import { NamedText } from "../assistant-name.tsx";
import { T } from "../i18n.tsx";
import { ServiceEntry } from "../service-entry.tsx";
import { UserWordsBlock } from "../user-words.tsx";
import { type CardProps, CardShell } from "./CardShell.tsx";
import { WorkflowSteps } from "./WorkflowPlanCard.tsx";

/** 一条结局的小签：没生效的红、要你手动的提醒色、别的绿 */
function OutcomeChip({ result }: { result: OperationResult }) {
  const kind = result.outcome === "failed" ? "chip-no" : result.outcome === "manual" ? "chip-op" : result.outcome === "cancelled" ? "" : "chip-ok";
  return (
    <span className={`chip ${kind}`}>
      {OPERATION_OUTCOME_LABEL[result.outcome]}
      {result.reason ? t("ui.operationsCards.reason", { reason: result.reason }) : ""}
    </span>
  );
}

/** 服务那一条生效之后：项目的服务的入口和在不在线（还没收到项目的服务时照常写结局） */
function ServiceOutcome({ projectId, item, result }: { projectId: string; item: OperationItem; result: OperationResult }) {
  const { ui } = useStore();
  const view = serviceOfItem(ui, projectId, item.key);
  if (!view || result.outcome === "failed" || result.outcome === "cancelled") return <OutcomeChip result={result} />;
  return <ServiceEntry view={view} />;
}

/** 运营方案里的一条；projectId 给了的（卡上）服务那一条生效之后带入口 */
export function OperationItemView({ item, result, projectId, children }: { item: OperationItem; result?: OperationResult | undefined; projectId?: string | undefined; children?: ReactNode }) {
  const service = item.service;
  return (
    <li className={`ops-item${item.automatic ? "" : " ops-item-manual"}`}>
      <div className="ops-item-head">
        <b>{item.name}</b>
        <span className="chip">{item.meansLabel}</span>
        {result && !(service && projectId) && <OutcomeChip result={result} />}
      </div>
      {service && result && projectId && (
        <div className="svc-entries">
          <ServiceOutcome projectId={projectId} item={item} result={result} />
        </div>
      )}
      <div className="ops-item-when">
        {service ? (
          <>{item.triggerText}</>
        ) : item.automatic ? (
          <T
            k="ui.operationsCards.when"
            params={{
              trigger: item.triggerText,
              approach: OPERATION_APPROACH_LABEL[item.approach],
              steps: item.workflow ? t("ui.operationsCards.steps", { count: item.workflow.steps.length }) : "",
              caps: <NamedText text={capabilitiesText(item.capabilities)} />,
            }}
          />
        ) : (
          <T k="ui.operationsCards.caps" params={{ caps: <NamedText text={capabilitiesText(item.capabilities)} /> }} />
        )}
      </div>
      <div className="ops-item-do">{item.instructions}</div>
      {service && (
        <dl className="svc-spec">
          {serviceSpecRows(service).map((r) => (
            <Fragment key={r.label}>
              <dt>{r.label}</dt>
              <dd>{r.value}</dd>
            </Fragment>
          ))}
        </dl>
      )}
      {!item.automatic && (
        <div className="ops-manual-note">
          {OPERATIONS_MANUAL_PREFIX}
          {item.manual}
        </div>
      )}
      {item.onFailure && <div className="muted">{t("ui.operationsCards.onFailure", { text: item.onFailure })}</div>}
      {children}
      {item.workflow && (
        <details className="ops-steps">
          <summary>{t("ui.operationsCards.workflowSteps", { count: item.workflow.steps.length })}</summary>
          <WorkflowSteps plan={item.workflow} progress={{}} />
        </details>
      )}
    </li>
  );
}

/** 流程审查要你逐项确认的事项（照流程计划卡：一次确认不等于默认同意它们） */
function ConfirmList({ asks, agreed, setAgreed }: { asks: Array<{ key: string; text: string }>; agreed: Record<string, boolean>; setAgreed: (f: (a: Record<string, boolean>) => Record<string, boolean>) => void }) {
  if (asks.length === 0) return null;
  return (
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
  );
}

/** 卡上要你逐项确认的事项和勾了哪几项（"首版做完了"卡、"运营方案变更"卡共用） */
export function useOperationConfirmations(items: readonly OperationItem[]) {
  const [agreed, setAgreed] = useState<Record<string, boolean>>({});
  const asks = operationsConfirmationItems(items);
  return {
    asks,
    agreed,
    setAgreed,
    missing: asks.filter((i) => !agreed[i.key]).length,
    input: { confirmations: asks.filter((i) => agreed[i.key]).map((i) => i.key) },
  };
}

/** "首版做完了"卡上的一节：转入使用后会开起来的（projectId：服务那一条生效之后带入口） */
export function OperationsPlanSection({
  plan,
  results,
  pending,
  confirm,
  projectId,
}: {
  plan: OperationsPlanView;
  results?: readonly OperationResult[] | undefined;
  pending: boolean;
  confirm: ReturnType<typeof useOperationConfirmations>;
  projectId?: string | undefined;
}) {
  return (
    <div className="ops-plan">
      <div className="ops-plan-h">{OPERATIONS_SECTION_TITLE}</div>
      {plan.why && <div className="agent-says">{plan.why}</div>}
      <UserWordsBlock words={plan.userWords} />
      <ul className="ops-list">
        {plan.items.map((item) => (
          <OperationItemView key={item.key} item={item} result={results?.find((r) => r.key === item.key)} projectId={projectId} />
        ))}
      </ul>
      {pending && (
        <div className="auth">
          <div className="auth-summary">{t("ui.operationsCards.grantText", { grant: OPERATIONS_GRANT_TEXT })}</div>
          <ConfirmList asks={confirm.asks} agreed={confirm.agreed} setAgreed={confirm.setAgreed} />
        </div>
      )}
    </div>
  );
}

/** "运营方案变更"卡 */
export function OperationsChangeCard({ state, payload: p, done, act }: CardProps<OperationsChangeCardPayload>) {
  const [rejecting, setRejecting] = useState(false);
  const [comment, setComment] = useState("");
  const outcome = state.card.outcome;
  const groups = operationsChangeGroups(p);
  // 要建的那几条（加上的、改了要重建的、重新开起来的）里流程审查要你逐项确认的事项
  const confirm = useOperationConfirmations([...p.added, ...p.changed.filter((c) => !c.inPlace).map((c) => c.after), ...p.restored]);
  const results = p.decided?.results;
  return (
    <CardShell
      state={state}
      title={t("ui.operationsCards.changeTitle", { project: p.projectName, revision: p.revision })}
      doneLabel={
        outcome?.action === "reject"
          ? outcome.note
            ? t("ui.operationsCards.rejectedNote", { note: outcome.note })
            : t("ui.operationsCards.rejected")
          : outcome?.action === "confirm"
            ? t("ui.operationsCards.confirmed")
            : undefined
      }
      actions={
        rejecting ? (
          <div className="plan-reject">
            <textarea className="input" value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t("ui.operationsCards.reasonPlaceholder")} rows={2} />
            <div className="auth-actions">
              <button type="button" className="btn ghost" onClick={() => setRejecting(false)}>
                {t("ui.operationsCards.cancel")}
              </button>
              <button type="button" className="btn danger" onClick={() => act("reject", comment.trim() || undefined)}>
                {t("ui.operationsCards.reject")}
              </button>
            </div>
          </div>
        ) : (
          <>
            <button type="button" className="btn ghost" onClick={() => setRejecting(true)}>
              {t("ui.operationsCards.reject")}
            </button>
            <button type="button" className="btn primary" disabled={confirm.missing > 0} onClick={() => act("confirm", undefined, confirm.asks.length > 0 ? confirm.input : undefined)}>
              {confirm.missing > 0 ? t("ui.operationsCards.missing", { count: confirm.missing }) : t("ui.operationsCards.confirm")}
            </button>
          </>
        )
      }
    >
      {p.why && <div className="agent-says">{p.why}</div>}
      <UserWordsBlock words={p.userWords} />
      {groups.map((g) => (
        <div key={g.kind} className={`ops-group ops-group-${g.kind}`}>
          <div className="ops-group-h">{OPERATION_CHANGE_LABEL[g.kind]}</div>
          <ul className="ops-list">
            {g.items.map((i) => (
              <OperationItemView key={i.key} item={i.after} result={results?.find((r) => r.key === i.key)} projectId={p.projectId}>
                {i.before && (
                  <div className="ops-changed">
                    {operationChangedFields(i.before, i.after).map((f) => (
                      <div key={f}>{f}</div>
                    ))}
                    <div className="muted">{i.after.service ? t("ui.operationsCards.serviceChanged") : i.inPlace ? t("ui.operationsCards.inPlace") : t("ui.operationsCards.rebuild")}</div>
                  </div>
                )}
              </OperationItemView>
            ))}
          </ul>
        </div>
      ))}
      {p.kept.length > 0 && (
        <div className="muted">
          {t("ui.operationsCards.kept", { list: p.kept.map((k) => t("ui.operationsCards.keptItem", { name: k.name, trigger: k.triggerText })).join(t("ui.common.listSep")) })}
        </div>
      )}
      {!done && (
        <div className="auth">
          <div className="auth-summary">{t("ui.operationsCards.changeGrant", { grant: OPERATIONS_GRANT_TEXT })}</div>
          <ConfirmList asks={confirm.asks} agreed={confirm.agreed} setAgreed={confirm.setAgreed} />
        </div>
      )}
    </CardShell>
  );
}

/**
 * 服务入口卡（133 号票）：秘书给出的某个项目的服务的入口（用户说"打开简报站"），出来就是已处理（没有要选的），不画"已处理"那一行；
 * 在不在线按手里的项目的服务现画，点"打开「X」"在内置浏览器里打开
 */
export function ServiceEntryCard({ state, payload: p }: CardProps<ServiceEntryCardPayload>) {
  const { ui } = useStore();
  const view = serviceByApp(ui, p.app);
  return (
    <div className={`card xcard xcard-${state.card.type}`}>
      <div className="xcard-head">
        <span className={`xcard-tag xt-${state.card.type}`}>{CARD_TYPE_LABEL.service_entry}</span>
        <span className="xcard-title">
          {p.projectName} · {p.title}
        </span>
      </div>
      <div className="xcard-body">{view ? <ServiceEntry view={view} /> : <span className="muted">{t("ui.operationsCards.serviceGone", { title: p.title })}</span>}</div>
    </div>
  );
}
