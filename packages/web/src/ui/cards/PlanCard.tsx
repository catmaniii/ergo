/**
 * 计划确认卡（规格第 8 节，12 号票）：由守护进程从维护者提交的结构化计划生成，负载是 PlanCardPayload。
 * - 一个"确认"按钮；授权项可逐行勾掉或收窄（次数改少、对象范围里去掉一些值），可附意见打回；
 * - 授权行和时序规则的主文由代码从结构化数据生成（协议包的 grantText、temporalRuleText），维护者写的标题只作灰字备注；
 *   落在"先问我""交给我做"类别里的授权行不算授权：标"执行时仍会问"（或"交给你做"），不能勾选；
 * - "授权后还会在 N 处停下来"由代码算（planStops）：由你验收的阶段、仍会问的、勾掉的、收窄的，随勾选实时更新；
 *   维护者填的停点预告只作参考；
 * - 假设栏每条可改，确认时随计划一起保存；105 号票起每条是随内容长高的多行框（整段看得全、在任意位置改），清空就是去掉这一条；
 * - 逐行列出涉及的项目和改动、定时作业定义（确认后登记在 19 号票）；涉及多个项目的任务（17 号票）每一行还写着所属阶段和
 *   这张工单的验收标准，确认后每一行建成一张工单，所属阶段开始时派出；
 * - 细节（阶段、验收、工具包、记忆范围）默认折叠；26 号票起细节里还有：
 *   - 本任务要提醒的关注类别：默认取全局（删不掉），标明维护者调严的、为本任务加的；确认前可以用和设置页同一套确定规则
 *     给这个任务加类别（只能加，已有的删不掉；还没确认的可以不加了），随确认交出；
 *   - 你说过的限制：维护者编译成的时序规则和授权收窄（文字由代码从结构化数据生成），和你的原话一起列出。
 */
import { useState } from "react";
import { useStore } from "../../app/store.tsx";
import { tokensLabel } from "../../model/labels.ts";
import {
  type CategoryForm,
  categoryMatchText,
  type Disposition,
  DISPOSITION_LABEL,
  DISPOSITIONS,
  emptyCategoryForm,
  type PlanCategoryAddition,
  type PlanCategoryOrigin,
  planCategoryAdditionOf,
  planCategoryRows,
  userLimitRows,
  grantAuthorizes,
  grantNotAuthorizedLabel,
  type GrantNarrowingDraft,
  grantText,
  narrowedGrantIds,
  type PlanCardPayload,
  planConfirmInput,
  planGrants,
  planPolicies,
  planStageCodes,
  planStops,
  policyOwnerLabel,
  temporalRuleText,
  tellSecretaryField,
  tellSecretaryOn,
  sendAttachmentField,
  sendAttachmentOn,
  t,
  tTable,
} from "../../state/index.ts";
import { NamedText } from "../assistant-name.tsx";
import { AutoGrowText } from "../auto-grow-text.tsx";
import { CategoryRuleFields, DispositionSelect } from "../category-rule.tsx";
import { type CardProps, CardShell } from "./CardShell.tsx";
import { PlanOutline } from "./PlanOutline.tsx";
import { PlanStageList, useStageFocus } from "./PlanStages.tsx";
import { toolkitLabel } from "./cards.tsx";

/** 给本任务加的类别可以选六档里的任何一档（命中时和别的类别取最严） */
const ALL: readonly Disposition[] = DISPOSITIONS;

/** 本任务的关注类别从哪来的说法 */
const ORIGIN_LABEL: Readonly<Record<PlanCategoryOrigin, string>> = tTable({
  global: "ui.planCard.origin.global",
  global_tightened: "ui.planCard.origin.globalTightened",
  maintainer_added: "ui.planCard.origin.maintainerAdded",
  user_added: "ui.planCard.origin.userAdded",
});

export function PlanCard({ state, payload: p, done, act }: CardProps<PlanCardPayload>) {
  const { plan } = p;
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<Record<string, GrantNarrowingDraft>>({});
  /** 改过的假设栏（没动过是 undefined） */
  const [assumptions, setAssumptions] = useState<string[] | undefined>();
  // 91 号票：计划还没确认时点左边图上的一个阶段，打开这张卡的详情、定位到这一阶段（细节一打开就展开）
  const { focus } = useStageFocus();
  const [details, setDetails] = useState(focus !== undefined);
  // 93 号票：详情里点小流程图上的一个阶段，细节跟着展开（定位到那一阶段）
  const [seenFocus, setSeenFocus] = useState(focus);
  if (focus !== seenFocus) {
    setSeenFocus(focus);
    if (focus !== undefined) setDetails(true);
  }
  const [rejecting, setRejecting] = useState(false);
  const [comment, setComment] = useState("");
  /** 确认前在卡上给这个任务加的关注类别（只能加；还没确认的可以不加了） */
  const [added, setAdded] = useState<PlanCategoryAddition[]>([]);
  /** 正在写的那一个（没在写是 undefined） */
  const [adding, setAdding] = useState<{ form: CategoryForm; disposition: Disposition; problems: string[] }>();
  const { ui } = useStore();
  const tools = ui.watchCategories?.state.tools ?? [];

  const choice = { removed, drafts, ...(assumptions === undefined ? {} : { assumptions }), added };
  const stageTitleOf = (stageId: string) => plan.stages.find((s) => s.stageId === stageId)?.title;
  const categoryRows = planCategoryRows(p);
  const limits = userLimitRows(p);
  const addCategory = () => {
    if (!adding) return;
    const result = planCategoryAdditionOf(adding.form, adding.disposition);
    if ("problems" in result) {
      setAdding({ ...adding, problems: result.problems });
      return;
    }
    setAdded([...added, result.addition]);
    setAdding(undefined);
  };
  // 91 号票：第几阶段按依赖图的编号写（并行的写 4a、4b，和左边的计划图一致）
  const codes = planStageCodes(plan);
  const stops = done ? planStops(p, undefined, codes) : planStops(p, { removed, narrowed: narrowedGrantIds(plan, choice) }, codes);
  const global = new Set(p.globalCategories);
  const rules = planPolicies(plan).flatMap(({ owner, policy }) => policy.temporalRules.map((rule) => ({ rule, owner })));
  const narrow = (grantId: string, patch: Partial<GrantNarrowingDraft>) => setDrafts({ ...drafts, [grantId]: { scope: {}, ...drafts[grantId], ...patch } });
  const shownAssumptions = assumptions ?? plan.assumptions;
  const editAssumption = (i: number, text: string) => setAssumptions(shownAssumptions.map((a, j) => (j === i ? text : a)));

  return (
    <CardShell
      state={state}
      title={`${p.taskTitle}${p.revision > 1 ? t("ui.planCard.revision", { revision: p.revision }) : ""}`}
      actions={
        rejecting ? (
          <div className="plan-reject">
            <textarea className="input" value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t("ui.planCard.rejectPlaceholder")} rows={3} />
            <div className="auth-actions">
              <button type="button" className="btn ghost" onClick={() => setRejecting(false)}>
                {t("ui.planCard.cancelReject")}
              </button>
              <button type="button" className="btn danger" disabled={!comment.trim()} onClick={() => act("reject", comment.trim())}>
                {t("ui.planCard.reject")}
              </button>
            </div>
          </div>
        ) : (
          <>
            <button type="button" className="btn ghost" onClick={() => setRejecting(true)}>
              {t("ui.planCard.rejectWithComment")}
            </button>
            <button type="button" className="btn primary" onClick={() => act("confirm", undefined, planConfirmInput(plan, choice))}>
              {t("ui.planCard.confirm")}
            </button>
          </>
        )
      }
    >
      <div className="plan-goal">{p.goal}</div>
      <div className="plan-sum">
        <span>{t("ui.planCard.sum.stages", { count: plan.stages.length })}</span>
        <span className="look-tail-you">{t("ui.planCard.sum.stops", { count: stops.length })}</span>
        <span>{t("ui.planCard.sum.tokens", { tokens: tokensLabel(plan.tokenEstimate) })}</span>
        <span>
          {t("ui.planCard.sum.categories", { count: categoryRows.length + (done ? 0 : added.length) })}
          {limits.length > 0 ? t("ui.planCard.sum.limits", { count: limits.length }) : ""}
          {t("ui.planCard.sum.seeDetails")}
        </span>
      </div>
      {/* 93 号票：一直列着各阶段的提纲，点一项就地展开、左边图上高亮 */}
      <PlanOutline card={state.card} />
      {stops.length > 0 && (
        <ul className="plain-list plan-stops">
          {stops.map((s) => (
            <li key={`${s.kind}:${s.text}`} className="muted">
              {s.text}
            </li>
          ))}
        </ul>
      )}

      <div className="plan-sec">
        <div className="plan-sec-h">{t("ui.planCard.projects.title")}</div>
        {plan.projects.length === 0 && <div className="muted">{t("ui.planCard.projects.none")}</div>}
        {plan.projects.map((pr) => (
          <div key={`${pr.project}@${pr.stageId ?? ""}`} className="plan-proj">
            <b>{pr.project}</b>
            {pr.stageId && (
              <span className="muted">
                {stageTitleOf(pr.stageId) ? t("ui.planCard.projects.dispatchTitled", { stage: pr.stageId, title: stageTitleOf(pr.stageId) }) : t("ui.planCard.projects.dispatch", { stage: pr.stageId })}
              </span>
            )}
            <ul className="plain-list">
              {pr.changes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            {pr.acceptance && pr.acceptance.length > 0 && <div className="muted">{t("ui.planCard.projects.acceptance", { list: pr.acceptance.join(t("ui.planCard.itemSep")) })}</div>}
          </div>
        ))}
      </div>

      <fieldset className="plan-sec" disabled={done}>
        <legend className="plan-sec-h">{t("ui.planCard.grants.title")}</legend>
        {planGrants(plan).length === 0 && <div className="muted">{t("ui.planCard.grants.none")}</div>}
        {planGrants(plan).map(({ grant: g, owner }) => {
          const info = p.grantInfo[g.id];
          const authorizes = grantAuthorizes(info);
          const off = removed.has(g.id);
          const d = drafts[g.id];
          const multi = Object.entries(g.scope).filter((e): e is [string, string[]] => Array.isArray(e[1]) && e[1].length > 1);
          const line = (
            <span>
              <span className="grant-text">{grantText(g, info, owner)}</span>
              <span className="muted">{t("ui.planCard.grants.meta", { owner: policyOwnerLabel(owner, codes), note: g.title })}</span>
              {p.narrowedGrants?.includes(g.id) && <span className="chip">{t("ui.planCard.grants.narrowed")}</span>}
            </span>
          );
          if (!authorizes && info) {
            // 落在"先问我""交给我做""永不"类别里：列进计划也不算授权，不给勾
            return (
              <div key={g.id} className="grant-row grant-asks">
                <span className="chip chip-high" title={t("ui.planCard.grants.inCategory", { disposition: DISPOSITION_LABEL[info.disposition] })}>
                  {grantNotAuthorizedLabel(info)}
                </span>{" "}
                {line}
              </div>
            );
          }
          return (
            <div key={g.id} className={`grant-row${off ? " grant-off" : ""}`}>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={!off}
                  onChange={() => {
                    const next = new Set(removed);
                    if (off) next.delete(g.id);
                    else next.add(g.id);
                    setRemoved(next);
                  }}
                />
                {line}
              </label>
              {!off && !done && (
                <div className="grant-narrow">
                  <label>
                    {t("ui.planCard.grants.uses")}{" "}
                    <input
                      className="input"
                      type="number"
                      min={1}
                      max={g.maxUses}
                      value={d?.maxUses ?? g.maxUses ?? ""}
                      placeholder={t("ui.planCard.grants.noLimit")}
                      onChange={(e) => narrow(g.id, { maxUses: e.target.value === "" ? undefined : Math.max(1, Math.min(Number(e.target.value), g.maxUses ?? Number.MAX_SAFE_INTEGER)) })}
                      aria-label={t("ui.planCard.grants.usesLabel", { title: g.title })}
                    />
                  </label>
                  {multi.map(([key, values]) => {
                    const kept = d?.scope[key] ?? values;
                    return (
                      <span key={key} className="chips">
                        {t("ui.planCard.grants.scopeKey", { key })}
                        {values.map((v) => (
                          <label key={v} className="check-row">
                            <input
                              type="checkbox"
                              checked={kept.includes(v)}
                              // 至少留一个值
                              disabled={kept.length === 1 && kept.includes(v)}
                              onChange={() => narrow(g.id, { scope: { ...d?.scope, [key]: kept.includes(v) ? kept.filter((x) => x !== v) : values.filter((x) => x === v || kept.includes(x)) } })}
                            />
                            {v}
                          </label>
                        ))}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {(p.removedGrants?.length ?? 0) > 0 && (
          <div className="muted">
            {t("ui.planCard.grants.removed")}
            {p.removedGrants!.map((g) => (
              <div key={g.id}>{grantText(g, p.grantInfo[g.id])}</div>
            ))}
          </div>
        )}
        <div className="muted">{t("ui.planCard.grants.note")}</div>
      </fieldset>

      {rules.length > 0 && (
        <div className="plan-sec">
          <div className="plan-sec-h">{t("ui.planCard.rules.title")}</div>
          {rules.map(({ rule, owner }) => (
            <div key={rule.id} className="rule-row">
              <div>{temporalRuleText(rule)}</div>
              <div className="muted">
                {policyOwnerLabel(owner, codes)}
                {rule.title ? t("ui.planCard.rules.note", { note: rule.title }) : ""}
              </div>
            </div>
          ))}
        </div>
      )}

      <fieldset className="plan-sec" disabled={done}>
        <legend className="plan-sec-h">
          {t("ui.planCard.assumptions.title")}
          {done ? (p.assumptionsEdited ? t("ui.planCard.assumptions.edited") : "") : t("ui.planCard.assumptions.hint")}
        </legend>
        {shownAssumptions.length === 0 && <div className="muted">{t("ui.planCard.assumptions.none")}</div>}
        {done ? (
          <ul className="plain-list plan-assumptions">
            {plan.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        ) : (
          <>
            {shownAssumptions.map((a, i) => (
              // 条目没有稳定的 id，按位置
              <AutoGrowText key={i} className="input plan-assumption" value={a} onChange={(text) => editAssumption(i, text)} placeholder={t("ui.planCard.assumptions.placeholder")} aria-label={t("ui.planCard.assumptions.label", { n: i + 1 })} />
            ))}
            <button type="button" className="link" onClick={() => setAssumptions([...shownAssumptions, ""])}>
              {t("ui.planCard.assumptions.add")}
            </button>
          </>
        )}
      </fieldset>

      <button type="button" className="link" onClick={() => setDetails(!details)} aria-expanded={details}>
        {details ? t("ui.planCard.details.hide") : t("ui.planCard.details.show")}
      </button>
      {details && (
        <div className="plan-details fx-open">
          {limits.length > 0 && (
            <div className="plan-stage">
              <b>{t("ui.planCard.limits.title")}</b>
              {limits.map((l) => (
                <div key={l.id} className="rule-row">
                  <div className="muted">{l.verified ? t("ui.planCard.limits.youSaid", { quote: l.quote }) : t("ui.planCard.limits.paraphrase", { quote: l.quote })}</div>
                  <ul className="plain-list">
                    {l.rules.map((r) => (
                      <li key={r}>{t("ui.planCard.limits.rule", { rule: r })}</li>
                    ))}
                    {l.narrowings.map((n) => (
                      <li key={n}>{t("ui.planCard.limits.narrowing", { text: n })}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
          <div className="plan-stage">
            <b>{t("ui.planCard.categories.title")}</b>
            <div className="chips">
              {categoryRows.map((c) => (
                <span key={c.id} className={global.has(c.id) ? "chip chip-locked" : "chip chip-op"} title={ORIGIN_LABEL[c.origin]}>
                  {c.title}
                  {c.disposition && ` · ${DISPOSITION_LABEL[c.disposition]}`}
                  {c.rule && ` · ${c.rule}`}
                  {c.origin === "user_added" && t("ui.planCard.categories.yours")}
                </span>
              ))}
              {!done &&
                added.map((a, i) => (
                  <span key={`${a.title}-${i}`} className="chip chip-op" title={t("ui.planCard.categories.addOnConfirmTip")}>
                    {a.title} · {DISPOSITION_LABEL[a.disposition]} · {categoryMatchText(a.match)}
                    {t("ui.planCard.categories.addOnConfirm")}{" "}
                    <button type="button" className="link" onClick={() => setAdded(added.filter((_, j) => j !== i))}>
                      {t("ui.planCard.categories.undoAdd")}
                    </button>
                  </span>
                ))}
            </div>
            <div className="muted">{t("ui.planCard.categories.note")}</div>
            {!done &&
              (adding ? (
                <div className="plan-add-category">
                  <CategoryRuleFields form={adding.form} onChange={(form) => setAdding({ ...adding, form })} tools={tools} />
                  <label className="field">
                    <span>{t("ui.planCard.categories.inTask")}</span>
                    <DispositionSelect label={t("ui.planCard.categories.dispositionLabel")} value={adding.disposition} options={ALL} onChange={(disposition) => setAdding({ ...adding, disposition })} />
                  </label>
                  {adding.problems.length > 0 && (
                    <ul className="plain-list error">
                      {adding.problems.map((x) => (
                        <li key={x}>{x}</li>
                      ))}
                    </ul>
                  )}
                  <div className="auth-actions">
                    <button type="button" className="btn ghost small" onClick={() => setAdding(undefined)}>
                      {t("ui.planCard.categories.cancel")}
                    </button>
                    <button type="button" className="btn primary small" onClick={addCategory}>
                      {t("ui.planCard.categories.add")}
                    </button>
                  </div>
                </div>
              ) : (
                <button type="button" className="link" onClick={() => setAdding({ form: emptyCategoryForm(), disposition: "ask_first", problems: [] })}>
                  {t("ui.planCard.categories.addNew")}
                </button>
              ))}
          </div>
          <PlanStageList plan={plan} />
          <div className="plan-stage">
            <b>{t("ui.planCard.toolkit")}</b>
            <div className="muted">
              <NamedText text={toolkitLabel({ skills: plan.toolkit.skills, mcps: plan.toolkit.mcp, bash: plan.toolkit.bash, network: plan.toolkit.network, ...tellSecretaryField(tellSecretaryOn(plan.toolkit)), ...sendAttachmentField(sendAttachmentOn(plan.toolkit)) })} />
            </div>
          </div>
          <div className="plan-stage">
            <b>{t("ui.planCard.stops.title")}</b>
            <div className="muted">
              {t("ui.planCard.stops.count", { count: plan.stops.count })}
              {plan.stops.where.length > 0 ? t("ui.planCard.stops.where", { where: plan.stops.where.join(t("ui.planCard.itemSep")) }) : ""}
            </div>
          </div>
          {plan.memoryScope && (
            <div className="plan-stage">
              <b>{t("ui.planCard.memoryScope")}</b>
              <div className="muted">{plan.memoryScope}</div>
            </div>
          )}
        </div>
      )}
    </CardShell>
  );
}
