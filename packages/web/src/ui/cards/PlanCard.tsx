/**
 * 计划确认卡（规格第 8 节，12 号票）：由守护进程从维护者提交的结构化计划生成，负载是 PlanCardPayload。
 * - 一个"确认"按钮；授权项可逐行勾掉或收窄（次数改少、对象范围里去掉一些值），可附意见打回；
 * - 授权行和时序规则的主文由代码从结构化数据生成（协议包的 grantText、temporalRuleText），维护者写的标题只作灰字备注；
 *   落在"先问我""交给我做"类别里的授权行不算授权：标"执行时仍会问"（或"交给你做"），不能勾选；
 * - "授权后还会在 N 处停下来"由代码算（planStops）：由你验收的阶段、仍会问的、勾掉的、收窄的，随勾选实时更新；
 *   维护者填的停点预告只作参考；
 * - 假设栏每条可改，确认时随计划一起保存；
 * - 逐行列出涉及的项目和改动、定时作业定义（确认后登记在 19 号票）；
 * - 细节（阶段、验收、工具包、记忆范围）默认折叠；26 号票起细节里还有：
 *   - 本任务要提醒的关注类别：默认取全局（删不掉），标明维护者调严的、为本任务加的；确认前可以用和设置页同一套确定规则
 *     给这个任务加类别（只能加，已有的删不掉；还没确认的可以不加了），随确认交出；
 *   - 你说过的限制：维护者编译成的时序规则和授权收窄（文字由代码从结构化数据生成），和你的原话一起列出。
 */
import { useState } from "react";
import { useStore } from "../../app/store.tsx";
import { ACCEPTANCE_METHOD_LABEL, tokensLabel } from "../../model/labels.ts";
import {
  type CategoryForm,
  categoryMatchOf,
  categoryMatchText,
  type Disposition,
  DISPOSITION_LABEL,
  emptyCategoryForm,
  type PlanCategoryAddition,
  type PlanCategoryOrigin,
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
  planStops,
  policyOwnerLabel,
  scheduledJobLines,
  temporalRuleText,
} from "../../state/index.ts";
import { CategoryRuleFields, DispositionSelect } from "../category-rule.tsx";
import { type CardProps, CardShell } from "./CardShell.tsx";
import { toolkitLabel } from "./cards.tsx";

/** 六档，由松到严（给本任务加的类别可以选任何一档：命中时和别的类别取最严） */
const ALL: Disposition[] = ["do", "do_then_tell", "planned_only", "ask_first", "hand_to_me", "never"];

/** 本任务的关注类别从哪来的说法 */
const ORIGIN_LABEL: Record<PlanCategoryOrigin, string> = {
  global: "全局设置里的，删不掉",
  global_tightened: "全局的，维护者在本任务里调严了",
  maintainer_added: "维护者为本任务加的",
  user_added: "你确认时加的",
};

export function PlanCard({ state, payload: p, done, act }: CardProps<PlanCardPayload>) {
  const { plan } = p;
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<Record<string, GrantNarrowingDraft>>({});
  /** 改过的假设栏（没动过是 undefined） */
  const [assumptions, setAssumptions] = useState<string[] | undefined>();
  const [details, setDetails] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [comment, setComment] = useState("");
  /** 确认前在卡上给这个任务加的关注类别（只能加；还没确认的可以不加了） */
  const [added, setAdded] = useState<PlanCategoryAddition[]>([]);
  /** 正在写的那一个（没在写是 undefined） */
  const [adding, setAdding] = useState<{ form: CategoryForm; disposition: Disposition; problems: string[] }>();
  const { ui } = useStore();
  const tools = ui.watchCategories?.state.tools ?? [];

  const choice = { removed, drafts, ...(assumptions === undefined ? {} : { assumptions }), added };
  const categoryRows = planCategoryRows(p);
  const limits = userLimitRows(plan);
  const addCategory = () => {
    if (!adding) return;
    const title = adding.form.title.trim();
    const { match, problems } = categoryMatchOf(adding.form);
    const all = [...(title === "" ? ["写个名字"] : []), ...(Object.keys(match).length === 0 && problems.length === 0 ? ["规则至少写一条"] : []), ...problems];
    if (all.length > 0) {
      setAdding({ ...adding, problems: all });
      return;
    }
    setAdded([...added, { title, match, disposition: adding.disposition }]);
    setAdding(undefined);
  };
  const stops = done ? planStops(p) : planStops(p, { removed, narrowed: narrowedGrantIds(plan, choice) });
  const stageNo = (id: string) => plan.stages.findIndex((s) => s.stageId === id) + 1;
  const global = new Set(p.globalCategories);
  const rules = planPolicies(plan).flatMap(({ owner, policy }) => policy.temporalRules.map((rule) => ({ rule, owner })));
  const narrow = (grantId: string, patch: Partial<GrantNarrowingDraft>) => setDrafts({ ...drafts, [grantId]: { scope: {}, ...drafts[grantId], ...patch } });
  const shownAssumptions = assumptions ?? plan.assumptions;
  const editAssumption = (i: number, text: string) => setAssumptions(shownAssumptions.map((a, j) => (j === i ? text : a)));

  return (
    <CardShell
      state={state}
      title={`${p.taskTitle}${p.revision > 1 ? `（第 ${p.revision} 版）` : ""}`}
      actions={
        rejecting ? (
          <div className="plan-reject">
            <textarea className="input" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="写下要改的地方，交回给起草计划的维护者" rows={3} />
            <div className="auth-actions">
              <button type="button" className="btn ghost" onClick={() => setRejecting(false)}>
                算了
              </button>
              <button type="button" className="btn danger" disabled={!comment.trim()} onClick={() => act("reject", comment.trim())}>
                打回
              </button>
            </div>
          </div>
        ) : (
          <>
            <button type="button" className="btn ghost" onClick={() => setRejecting(true)}>
              附意见打回
            </button>
            <button type="button" className="btn primary" onClick={() => act("confirm", undefined, planConfirmInput(plan, choice))}>
              确认
            </button>
          </>
        )
      }
    >
      <div className="plan-goal">{p.goal}</div>
      <div className="plan-sum">
        <span>{plan.stages.length} 个阶段</span>
        <span className="look-tail-you">授权后还会在 {stops.length} 处停下来</span>
        <span>约 {tokensLabel(plan.tokenEstimate)} token（粗估）</span>
        <span>
          要提醒的关注类别 {categoryRows.length + (done ? 0 : added.length)} 个{limits.length > 0 ? `；按你说过的话加了 ${limits.length} 条限制` : ""}（见细节）
        </span>
      </div>
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
        <div className="plan-sec-h">涉及的项目和改动</div>
        {plan.projects.length === 0 && <div className="muted">不涉及项目</div>}
        {plan.projects.map((pr) => (
          <div key={pr.project} className="plan-proj">
            <b>{pr.project}</b>
            <ul className="plain-list">
              {pr.changes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <fieldset className="plan-sec" disabled={done}>
        <legend className="plan-sec-h">授权（可以勾掉或收窄）</legend>
        {planGrants(plan).length === 0 && <div className="muted">没有预先授权的操作</div>}
        {planGrants(plan).map(({ grant: g, owner }) => {
          const info = p.grantInfo[g.id];
          const authorizes = grantAuthorizes(info);
          const off = removed.has(g.id);
          const d = drafts[g.id];
          const multi = Object.entries(g.scope).filter((e): e is [string, string[]] => Array.isArray(e[1]) && e[1].length > 1);
          const line = (
            <span>
              <span className="grant-text">{grantText(g, info)}</span>
              <span className="muted"> · {policyOwnerLabel(owner)} · 维护者的说明：{g.title}</span>
              {p.narrowedGrants?.includes(g.id) && <span className="chip">已收窄</span>}
            </span>
          );
          if (!authorizes && info) {
            // 落在"先问我""交给我做""永不"类别里：列进计划也不算授权，不给勾
            return (
              <div key={g.id} className="grant-row grant-asks">
                <span className="chip chip-high" title={`落在「${DISPOSITION_LABEL[info.disposition]}」类别里`}>
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
                    次数{" "}
                    <input
                      className="input"
                      type="number"
                      min={1}
                      max={g.maxUses}
                      value={d?.maxUses ?? g.maxUses ?? ""}
                      placeholder="不限"
                      onChange={(e) => narrow(g.id, { maxUses: e.target.value === "" ? undefined : Math.max(1, Math.min(Number(e.target.value), g.maxUses ?? Number.MAX_SAFE_INTEGER)) })}
                      aria-label={`收窄这一项的次数：${g.title}`}
                    />
                  </label>
                  {multi.map(([key, values]) => {
                    const kept = d?.scope[key] ?? values;
                    return (
                      <span key={key} className="chips">
                        {key}：
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
            确认时勾掉的：
            {p.removedGrants!.map((g) => (
              <div key={g.id}>{grantText(g, p.grantInfo[g.id])}</div>
            ))}
          </div>
        )}
        <div className="muted">没勾的操作，执行到那一步再问你；“先问我”类的操作列进来也照样问。</div>
      </fieldset>

      {rules.length > 0 && (
        <div className="plan-sec">
          <div className="plan-sec-h">时序规则</div>
          {rules.map(({ rule, owner }) => (
            <div key={rule.id} className="rule-row">
              <div>{temporalRuleText(rule)}</div>
              <div className="muted">
                {policyOwnerLabel(owner)}
                {rule.title ? ` · 维护者的说明：${rule.title}` : ""}
              </div>
            </div>
          ))}
        </div>
      )}

      {plan.scheduledJobs.length > 0 && (
        <div className="plan-sec">
          <div className="plan-sec-h">定时作业（确认后登记）</div>
          {scheduledJobLines(plan).map((j) => (
            <div key={j.title} className="rule-row">
              <div>
                <b>{j.title}</b> · {j.schedule}
                {j.project && <span className="chip">{j.project}</span>}
              </div>
              <div className="muted">每次：{j.each}</div>
            </div>
          ))}
        </div>
      )}

      <fieldset className="plan-sec" disabled={done}>
        <legend className="plan-sec-h">假设{done ? (p.assumptionsEdited ? "（确认时改过）" : "") : "（拿不准的地方，可以直接改）"}</legend>
        {shownAssumptions.length === 0 && <div className="muted">没有</div>}
        {done ? (
          <ul className="plain-list">
            {plan.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        ) : (
          <>
            {shownAssumptions.map((a, i) => (
              // 条目没有稳定的 id，按位置
              <input key={i} className="input" value={a} onChange={(e) => editAssumption(i, e.target.value)} placeholder="清空就是去掉这一条" aria-label={`假设 ${i + 1}`} />
            ))}
            <button type="button" className="link" onClick={() => setAssumptions([...shownAssumptions, ""])}>
              ＋ 加一条
            </button>
          </>
        )}
      </fieldset>

      <button type="button" className="link" onClick={() => setDetails(!details)} aria-expanded={details}>
        {details ? "收起细节 ▾" : "细节：阶段、验收、工具包、关注类别、你说过的限制 ▸"}
      </button>
      {details && (
        <div className="plan-details fx-open">
          {limits.length > 0 && (
            <div className="plan-stage">
              <b>按你说过的话加的限制</b>
              {limits.map((l) => (
                <div key={l.id} className="rule-row">
                  <div className="muted">你说：「{l.quote}」</div>
                  <ul className="plain-list">
                    {l.rules.map((r) => (
                      <li key={r}>规则：{r}</li>
                    ))}
                    {l.narrowings.map((n) => (
                      <li key={n}>收窄授权：{n}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
          <div className="plan-stage">
            <b>本任务要提醒的关注类别</b>
            <div className="chips">
              {categoryRows.map((c) => (
                <span key={c.id} className={global.has(c.id) ? "chip chip-locked" : "chip chip-op"} title={ORIGIN_LABEL[c.origin]}>
                  {c.title}
                  {c.disposition && ` · ${DISPOSITION_LABEL[c.disposition]}`}
                  {c.rule && ` · ${c.rule}`}
                  {c.origin === "user_added" && "（你加的）"}
                </span>
              ))}
              {!done &&
                added.map((a, i) => (
                  <span key={`${a.title}-${i}`} className="chip chip-op" title="确认时加上">
                    {a.title} · {DISPOSITION_LABEL[a.disposition]} · {categoryMatchText(a.match)}（确认时加上）{" "}
                    <button type="button" className="link" onClick={() => setAdded(added.filter((_, j) => j !== i))}>
                      不加了
                    </button>
                  </span>
                ))}
            </div>
            <div className="muted">默认取全局，只能加不能删；想少停几次，就在上面给对应操作预先授权（只对"计划里列了才做"那一档有效）。</div>
            {!done &&
              (adding ? (
                <div className="plan-add-category">
                  <CategoryRuleFields form={adding.form} onChange={(form) => setAdding({ ...adding, form })} tools={tools} />
                  <label className="field">
                    <span>这个任务里</span>
                    <DispositionSelect label="这个任务里的处置" value={adding.disposition} options={ALL} onChange={(disposition) => setAdding({ ...adding, disposition })} />
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
                      取消
                    </button>
                    <button type="button" className="btn primary small" onClick={addCategory}>
                      加上
                    </button>
                  </div>
                </div>
              ) : (
                <button type="button" className="link" onClick={() => setAdding({ form: emptyCategoryForm(), disposition: "ask_first", problems: [] })}>
                  ＋ 给这个任务加一个关注类别（只对这个任务生效）
                </button>
              ))}
          </div>
          {plan.stages.map((s, i) => {
            const group = plan.stageGroups.find((g) => g.groupId === s.groupId);
            return (
              <div key={s.stageId} className="plan-stage">
                <div>
                  <b>
                    第 {i + 1} 阶段 · {s.title}
                  </b>
                  <span className="muted">
                    {" "}
                    · {s.mode === "steps" ? "定步" : "开放"}
                    {s.dependsOn.length ? ` · 在第 ${s.dependsOn.map(stageNo).join("、")} 阶段之后` : ""}
                    {group ? ` · 阶段组「${group.title}」` : ""} · 预算 {tokensLabel(s.budget.tokens)} token、{s.budget.toolCalls} 次工具调用
                  </span>
                </div>
                <div className="muted">交付：{s.deliverables.join("；")}</div>
                {s.steps && <div className="muted">步骤：{s.steps.join(" → ")}</div>}
                <ul className="plain-list">
                  {s.acceptance.map((a) => (
                    <li key={a.criterion}>
                      验收（{ACCEPTANCE_METHOD_LABEL[a.method]}）：{a.criterion}
                      {a.script && <code> {a.script}</code>}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          <div className="plan-stage">
            <b>工具包</b>
            <div className="muted">{toolkitLabel({ skills: plan.toolkit.skills, mcps: plan.toolkit.mcp, bash: plan.toolkit.bash, network: plan.toolkit.network })}</div>
          </div>
          <div className="plan-stage">
            <b>维护者的停点预告（仅供参考）</b>
            <div className="muted">
              {plan.stops.count} 处{plan.stops.where.length > 0 ? `：${plan.stops.where.join("；")}` : ""}
            </div>
          </div>
          {plan.memoryScope && (
            <div className="plan-stage">
              <b>记忆范围（还不生效）</b>
              <div className="muted">{plan.memoryScope}</div>
            </div>
          )}
        </div>
      )}
    </CardShell>
  );
}
