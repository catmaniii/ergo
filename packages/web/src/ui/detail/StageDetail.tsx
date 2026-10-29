/**
 * 长程任务的阶段详情（60 号票）——头上"第 N 阶段"、状态、第几轮，标题旁边要你留意的小标记（MarkBadges）；"回到会话里这一段""⟲ 从这里重做…"；
 * 这一步出过的状况（incidents.tsx 的图标和说法）；交付件；验收标准（逐条带核对结果、怎么验收）；尝试记录（每次交上来的结论和备注、
 * 每次重开）；要你留意的（MarkRows：敏感权限、对外的动作、会问你的，授权写"已用 N/M"，下面是图例）；执行方式（理由、步骤或初步思路）；
 * 这一阶段的规则（PolicyRows：一条一行，点进去看它的详情）。
 * "从这里重做"的对话框：写这次要怎么改、列出要一起重做的阶段（它和依赖它的、开始过的）、这几个阶段这一轮已经做了的事，
 * 确认了才动——落到 task_action 的 rework（连同下游；13 号票，84 号票起开始过的阶段就有这个按钮）。
 * 125 号票：重做对话框里能直接改这一阶段的验收标准原文和交付件（你改的就是你的确认，不出卡，点重做就生效，时间线上记前后对照）；
 * 阶段详情里多一节"评审输入里你的原话"：最近一次宣布完成时维护者引用、运行时核实过的（评审只认这一栏）。
 * 计划里写的（交付件、验收、模式和理由、授权、规则、预算）取阶段抽屉用的那份；从会话、看板推出来的（状况、尝试记录、第几轮、
 * 这一段的第一条、重做的范围、工具调用用了几次）由状态层给（state/stage-detail.ts），按这个任务的整段会话算；
 * 守护进程那边才有的（授权已用几次、这一段已经做了的事）每次打开现取（GET /api/tasks/<任务>/stages/<阶段>，84 号票）。
 * 几处取舍（84 号票，用户 2026-10-11 都接受了）：
 * - 重做不撤回（真撤回在 85 号票）：已经做了的事只分"本机""对外"列出来、写明收不回，不分"能撤回""能补救"，也没有补偿阶段；
 * - 要你留意的没有"敏"（计划里还没有会用到的敏感数据，85 号票），图例只列"权""外""问"，说明按电脑上的事改写，
 *   "权"84 号票起叫"本机授权"，93 号票用户定统一叫"敏感权限"（和收着的阶段框条外的图例同一个名字），只读的授权也算在
 *   里面（85 号票再分）；多一行预算（60 号票就有）；
 * - 尝试记录的备注：维护者宣布完成时写的那句和你退回时写的说明各一行（不是有你的说明时只显示你的）；
 * - 规则一条一行（不按规则集），违反了怎么办多一级退回；
 * - 交上来的原始数据、凭据核对、认领时审查、执行轨迹与规则核对二狗没有（85 号票）。
 * 274 号票加了一节"系统查到的结果"（交付件下面）：本该是每轮结束系统直接查世界写出的结果、验收时系统查到的，
 * 二狗查不了世界，从效果日志汇总这一阶段这一轮发了什么、改了哪些文件（守护进程现取），和维护者自报的那一两句
 * 摆在一起（"两种声音"：系统查到的浅绿底、Agent 说的灰字），自报里提到、系统没查到的文件标出来。
 */
import { useEffect, useState } from "react";
import { useStore } from "../../app/store.tsx";
import { ACCEPTANCE_METHOD_LABEL, WAIT_REASON_LABEL } from "../../model/labels.ts";
import type { Stage } from "../../model/types.ts";
import {
  type ChatItem,
  describeCall,
  fallbackLine,
  formulaOf,
  apiFormulaOf,
  ON_VIOLATION_TEXT,
  onViolationOf,
  type PlanTemporalRule,
  reopenScope,
  ruleBookEntry,
  type StageEffect,
  stageCodeLabel,
  stageCodes,
  type StageMarks,
  stageDetailFacts,
  type StageEdit,
  type StageEditDraft,
  stageEditDraft,
  stageEditOf,
  stageEditProblem,
  type TaskStageView,
  observedRows,
  t,
  tTable,
} from "../../state/index.ts";
import { clockLabel } from "../../util/time.ts";
import { Sheet } from "../common.tsx";
import { budgetText, STAGE_STATUS } from "../conversation/StageDrawer.tsx";
import { T } from "../i18n.tsx";
import { UserWordsBlock } from "../user-words.tsx";
import { IncidentIcon } from "./incidents.tsx";
import { RuleRow } from "./RuleBook.tsx";
import { Section } from "./section.tsx";

/** 任务详情页给阶段详情的：哪个任务、它的各阶段（阶段抽屉用的那份），能不能从某个阶段重做、怎么重做 */
export interface StageDetailSource {
  readonly taskId: string;
  readonly stages: readonly Stage[];
  /** 现在能从这个阶段重做（开始过的阶段，建好了阶段的长程任务，84 号票） */
  canRework(stageId: string): boolean;
  /**
   * 从这个阶段重做（连同它的下游），note 是这次要怎么改（交给维护者）；edit 是在对话框里直接改的这一阶段的验收标准、交付件
   * （125 号票：不出卡，点重做就生效）
   */
  rework(stageId: string, note: string | undefined, edit?: StageEdit): void;
}

// ───────────────────────── 要你留意的 ─────────────────────────

/**
 * 要你留意的几样：字、名字、说明（"敏"在 85 号票）。说明里的例子不写手机上的事，
 * 二狗是电脑上的，换成写文件、删改、推送、发消息这类
 */
const markMeta = () =>
  [
    { key: "perm", glyph: t("ui.stageDetail.mark.permGlyph"), name: t("ui.stageDetail.mark.permName"), hint: t("ui.stageDetail.mark.permHint") },
    { key: "out", glyph: t("ui.stageDetail.mark.outGlyph"), name: t("ui.stageDetail.mark.outName"), hint: t("ui.stageDetail.mark.outHint") },
    { key: "ask", glyph: t("ui.stageDetail.mark.askGlyph"), name: t("ui.stageDetail.mark.askName"), hint: t("ui.stageDetail.mark.askHint") },
  ] as const;

/** 一个阶段的小标记：每样一个圆字 + 个数；只查看的写"只查看"（quiet 时不写字） */
export function MarkBadges({ marks, quiet }: { marks: StageMarks | undefined; quiet?: boolean }) {
  const items = marks ? markMeta().filter((x) => marks[x.key].length > 0) : [];
  if (!marks) return null;
  if (!items.length) return quiet ? null : <span className="mg-bds mg-bds-none">{t("ui.stageDetail.lookOnly")}</span>;
  return (
    <span className="mg-bds">
      {items.map((x) => (
        <span key={x.key} className={`mg-bd mg-bd-${x.key}`} title={t("ui.stageDetail.markBadgeTitle", { name: x.name, list: marks[x.key].map((v) => v.text).join(t("ui.stageDetail.semiSep")) })}>
          <i>{x.glyph}</i>
          {marks[x.key].length}
        </span>
      ))}
    </span>
  );
}

/** 要你留意的几样，一样一行，逐条写出是什么；used 是授权项 id → 用了几次（详情里写"已用 N/M"）。聊天里计划卡的提纲点开也用它（93 号票） */
export function MarkRows({ marks, used }: { marks: StageMarks; used?: ReadonlyMap<string, number> | undefined }) {
  const rows = markMeta().filter((x) => marks[x.key].length > 0);
  if (!rows.length)
    return (
      <div className="mp-node-row">
        <span className="mp-node-k">{t("ui.stageDetail.watchFor")}</span>
        <span className="muted">{t("ui.stageDetail.nothingToWatch")}</span>
      </div>
    );
  return (
    <>
      {rows.map((x) => (
        <div key={x.key} className="mp-node-row mp-mark-row">
          <span className="mp-node-k mp-mark-k">
            <span className={`mg-bd mg-bd-${x.key}`}>
              <i>{x.glyph}</i>
            </span>
            {x.key === "ask" ? t("ui.stageDetail.willAsk") : x.name}
          </span>
          <ul className="mp-node-list">
            {marks[x.key].map((v) => {
              const n = v.grantId === undefined ? undefined : used?.get(v.grantId);
              return (
                <li key={v.text}>
                  {v.text}
                  {v.limit !== undefined && n !== undefined && <span className={`ms-used ${n >= v.limit ? "full" : ""}`}> {t("ui.stageDetail.used", { n, limit: v.limit })}</span>}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </>
  );
}

// ───────────────────────── 守护进程那边才有的 ─────────────────────────

type ViewState = { state: "loading" } | { state: "failed"; error: string } | { state: "ready"; view: TaskStageView | undefined };

/** 这个阶段从守护进程现取的（每次打开现取；refresh 变了再取一次——用量、状态变了） */
function useStageView(taskId: string, stageId: string, refresh: string): ViewState {
  const { http } = useStore();
  const [got, setGot] = useState<{ key: string; view: ViewState }>();
  const key = `${taskId}\u0000${stageId}\u0000${refresh}`;
  useEffect(() => {
    const abort = new AbortController();
    const done = (view: ViewState) => {
      if (!abort.signal.aborted) setGot({ key, view });
    };
    http.taskStage(taskId, stageId, abort.signal).then(
      (view) => done({ state: "ready", view }),
      (err: unknown) => done({ state: "failed", error: err instanceof Error ? err.message : String(err) }),
    );
    return () => abort.abort();
  }, [http, taskId, stageId, key]);
  return got?.key === key ? got.view : { state: "loading" };
}

// ───────────────────────── 系统查到的结果（274 号票） ─────────────────────────

/** 路径显示末尾一段（窄栏里放得下），完整的在 title 里 */
const fileName = (p: string) => p.split(/[\\/]/).filter((x) => x !== "").at(-1) ?? p;

/**
 * 这一阶段这一轮系统查到的结果（守护进程现取，TaskStageView.observed）：维护者自报的那一两句（灰字）、系统查到的（浅绿底：对外发的一件一行、
 * 改了的文件按新建 / 修改 / 删除、本机做的别的事）、自报里提到而系统没查到的（⚠），最后一句说明结果从哪来。还在做的写"到现在为止"
 */
function ObservedSection({ stage, view }: { stage: Stage; view: ViewState }) {
  const observed = view.state === "ready" ? view.view?.observed : undefined;
  // 没开始过的阶段没有（守护进程也不给）
  if (!stageStartedOf(stage) || (view.state === "ready" && !observed)) return null;
  const live = stage.status === "running" || stage.status === "pending";
  const rows = observed ? observedRows(observed) : undefined;
  return (
    <Section title={live ? t("ui.stageDetail.observed.titleLive") : t("ui.stageDetail.observed.title")}>
      {stage.summary && !live && <div className="dt-note agent-says">{t("ui.stageDetail.observed.claimed", { summary: stage.summary })}</div>}
      {view.state === "loading" ? (
        <div className="muted">{t("ui.rollback.loading")}</div>
      ) : view.state === "failed" ? (
        <div className="muted">{t("ui.stageDetail.observed.failed", { error: view.error })}</div>
      ) : (
        rows && (
          <>
            <div className="dt-note sys-note ms-observed">
              <div className="ms-obs-row">
                <span className="ms-obs-k">{t("ui.stageDetail.observed.sent")}</span>
                {rows.sent.length > 0 ? (
                  <ul className="ms-obs-list">
                    {rows.sent.map((s, i) => (
                      <li key={`${i}:${s.text}`}>
                        <span className="ms-obs-tag">{s.kind}</span> {s.text}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span>{t("ui.stageDetail.observed.noSent")}</span>
                )}
              </div>
              <div className="ms-obs-row">
                <span className="ms-obs-k">{t("ui.stageDetail.observed.files")}</span>
                {rows.files.length > 0 ? (
                  <ul className="ms-obs-list">
                    {rows.files.map((f) => (
                      <li key={f.change}>
                        <span className={`ms-obs-tag ms-obs-${f.change}`}>{f.label}</span>{" "}
                        {f.paths.map((p, i) => (
                          <span key={p} className="ms-obs-path" title={p}>
                            {i > 0 ? t("ui.stageDetail.semiSep") : ""}
                            {fileName(p)}
                          </span>
                        ))}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span>{t("ui.stageDetail.observed.noFiles")}</span>
                )}
              </div>
              {rows.other && <div className="ms-obs-other">{t("ui.stageDetail.observed.other", { list: rows.other })}</div>}
            </div>
            {rows.mismatches.length > 0 && (
              <ul className="ms-obs-bad">
                {rows.mismatches.map((m) => (
                  <li key={m}>⚠ {m}</li>
                ))}
              </ul>
            )}
            <div className="muted dt-note">{t("ui.stageDetail.observed.note")}</div>
          </>
        )
      )}
    </Section>
  );
}

// ───────────────────────── 阶段详情 ─────────────────────────

export function StageDetail({
  source,
  taskId,
  stageId,
  items,
  onReveal,
  onRule,
}: {
  source: StageDetailSource | undefined;
  taskId: string;
  stageId: string;
  items: readonly ChatItem[];
  onReveal?: ((id?: string) => void) | undefined;
  /** 点一条规则看它的详情（84 号票） */
  onRule?: ((ruleId: string) => void) | undefined;
}) {
  const { ui } = useStore();
  const [reopening, setReopening] = useState(false);
  const stages = source?.taskId === taskId ? source.stages : [];
  const stage = stages.find((s) => s.id === stageId);
  // 授权已用几次跟着这个阶段的工具调用次数、状态变
  const view = useStageView(taskId, stageId, `${stage?.status ?? ""}:${stage?.budget.usedToolCalls ?? 0}:${stage?.attempts ?? 0}`);
  if (!source || !stage) return <div className="muted">{t("ui.stageDetail.gone")}</div>;
  // 91 号票：第几阶段按依赖图的编号（并行的写 4a、4b）
  const codes = stageCodes(stages);
  const n = codes.get(stage.id);
  const facts = stageDetailFacts(ui, items, taskId, stageId);
  const canReopen = source.canRework(stageId);
  const st = STAGE_STATUS[stage.status];
  const over = (stage.budget.usedTokens ?? 0) > stage.budget.tokens;
  const used = view.state === "ready" && view.view ? new Map(view.view.grantUses.map((g) => [g.grantId, g.used])) : undefined;
  return (
    <>
      <div className="dt-head">
        <span className="tag tag-mplan">{t("ui.stageDetail.stageNo", { n: n ?? "" })}</span>
        <span className={`dt-status ms-st st-${stage.status}`}>
          {st.icon} {st.text}
          {stage.status === "waiting" && stage.waitReason ? t("ui.stageDetail.waitReason", { reason: WAIT_REASON_LABEL[stage.waitReason] }) : ""}
        </span>
        {facts.rounds > 1 && <span className="dt-status">{t("ui.stageDetail.round", { n: facts.rounds })}</span>}
      </div>
      <div className="dt-title">
        {stage.title} <MarkBadges marks={stage.marks} quiet />
      </div>
      {stage.status === "waiting" && stage.waitNote && <div className="muted dt-note">{stage.waitNote}</div>}
      <div className="ms-actions">
        {facts.firstItemId && onReveal && (
          <button type="button" className="btn ghost" onClick={() => onReveal(facts.firstItemId)}>
            {t("ui.stageDetail.reveal")}
          </button>
        )}
        {canReopen && (
          <button type="button" className="btn ghost" onClick={() => setReopening(true)}>
            ⟲ {t("ui.stageDetail.redoFromHere")}
          </button>
        )}
        {canReopen && <div className="muted dt-note ms-reopen-hint">{t("ui.stageDetail.redoHint")}</div>}
      </div>
      {facts.incidents.length > 0 && (
        <Section title={t("ui.stageDetail.incidents")}>
          <ul className="ms-incidents">
            {facts.incidents.map((e, i) => (
              <li key={`${e.itemId}${i}`} className="ms-inc">
                <IncidentIcon kind={e.kind} attention={e.attention} />
                <span>{e.text}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title={t("ui.stageDetail.deliverables")}>
        <div className="dt-note">{stage.deliverable}</div>
      </Section>
      <ObservedSection stage={stage} view={view} />
      <Section title={t("ui.stageDetail.acceptance")}>
        <ul className="ms-criteria">
          {stage.acceptance.map((c) => {
            const mark = !c.result ? "○" : c.result === "pass" ? "✓" : "✕";
            return (
              <li key={c.text} className={`mc-${c.result ?? "none"}`}>
                <span className="mc-mark">{mark}</span>
                <span>
                  {c.text}
                  <span className={c.method === "user" ? "mp-tag mp-user" : "mp-tag mp-auto"}>{c.method === "user" ? t("ui.stageDetail.byYou") : c.method === "script" ? t("ui.stageDetail.autoCheck") : ACCEPTANCE_METHOD_LABEL[c.method]}</span>
                  {c.method === "user" && c.result && <span className="muted">{t("ui.stageDetail.yourCall")}</span>}
                  {c.note && <div className="muted">{c.note}</div>}
                </span>
              </li>
            );
          })}
        </ul>
        <div className="muted dt-note">{t("ui.stageDetail.acceptanceNote")}</div>
      </Section>
      {stage.userWords && stage.userWords.length > 0 && (
        <Section title={t("ui.stageDetail.userWords")}>
          <UserWordsBlock words={stage.userWords} note={t("ui.stageDetail.userWordsNote")} />
        </Section>
      )}
      <Section
        title={facts.reopens ? t("ui.stageDetail.attemptsReopened", { submissions: facts.submissions, reopens: facts.reopens }) : t("ui.stageDetail.attempts", { submissions: facts.submissions })}
      >
        {facts.attempts.length === 0 && <div className="muted">{t("ui.stageDetail.noAttempts")}</div>}
        <ol className="ms-attempts">
          {facts.attempts.map((x, i) =>
            x.kind === "attempt" ? (
              <li key={`a${x.at}${i}`} className={x.passed ? "ok" : "no"}>
                <b>{x.passed ? `✓ ${t("ui.stageDetail.passed")}` : `✕ ${t("ui.stageDetail.notPassed")}`}</b> {clockLabel(x.at)}
                {!x.passed && x.failed.length > 0 && <span className="muted"> · {t("ui.stageDetail.unmet", { list: x.failed.join(t("ui.stageDetail.semiSep")) })}</span>}
                {x.note && <div className="muted">{t("ui.stageDetail.note", { note: x.note })}</div>}
                {x.userNote && <div className="muted">{t("ui.stageDetail.userNote", { note: x.userNote })}</div>}
              </li>
            ) : (
              <li key={`r${x.at}${i}`} className="re">
                <b>⟲ {t("ui.stageDetail.reopened")}</b> {clockLabel(x.at)} · {t("ui.stageDetail.reopenScope", { list: x.scope.map((id) => stageCodeLabel(codes, id)).join(t("ui.common.listSep")) })}
              </li>
            ),
          )}
        </ol>
      </Section>
      <Section title={t("ui.stageDetail.attention")}>
        {stage.marks ? (
          <div className="ms-marks">
            <MarkRows marks={stage.marks} used={used} />
          </div>
        ) : stage.grants.length > 0 ? (
          <ul className="ms-grants">
            {stage.grants.map((g) => (
              <li key={g}>
                <span>{g}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="muted">{t("ui.stageDetail.noGrants")}</div>
        )}
        <ul className="muted dt-note ms-mark-hints">
          {markMeta().map((x) => (
            <li key={x.key}>
              <T
                k="ui.stageDetail.markHint"
                params={{
                  badge: (
                    <span className={`mg-bd mg-bd-${x.key}`}>
                      <i>{x.glyph}</i>
                      {x.name}
                    </span>
                  ),
                  hint: x.hint,
                }}
              />
            </li>
          ))}
        </ul>
        <div className={`dt-note ms-budget${over ? " over" : ""}`}>
          {t("ui.stageDetail.budget", { budget: budgetText(stage.budget) })}
          {over && ` · ${t("ui.stageDetail.overBudget")}`}
        </div>
      </Section>
      <Section title={t("ui.stageDetail.mode")}>
        <div className="dt-note">
          {stage.mode === "steps" ? t("ui.stageDetail.modeSteps") : t("ui.stageDetail.modeExplore")}
          {stage.modeReason ? t("ui.stageDetail.modeReason", { reason: stage.modeReason }) : ""}
        </div>
        {stage.mode === "steps"
          ? stage.steps &&
            stage.steps.length > 0 && (
              <ol className="mp-steps">
                {stage.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
            )
          : stage.roughIdea && <div className="muted dt-note">{t("ui.stageDetail.roughIdea", { idea: stage.roughIdea })}</div>}
      </Section>
      {(stage.ruleDocs?.length ?? stage.rules.length) > 0 && (
        <Section title={t("ui.stageDetail.rules")}>
          {stage.ruleDocs ? (
            <PolicyRows rules={stage.ruleDocs} onRule={onRule} />
          ) : (
            <ul className="ms-policy">
              {stage.rules.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
          <div className="muted dt-note">{t("ui.stageDetail.rulesNote")}</div>
        </Section>
      )}
      {reopening && (
        <ReopenDialog
          stages={stages}
          stageId={stageId}
          taskId={taskId}
          onCancel={() => setReopening(false)}
          onConfirm={(note, edit) => {
            setReopening(false);
            source.rework(stageId, note, edit);
          }}
        />
      )}
    </>
  );
}

/** 违反了怎么办的图标、颜色（红线 ⛔、拦截 ✋、确认 ❓、按规则退回 ↩），说法在协议包的 ON_VIOLATION_TEXT */
const LEVEL_ICON = { block: "✋", pull_back: "↩", confirm: "❓" } as const;
const LEVEL_CLS = { block: "lv-block", pull_back: "lv-pull", confirm: "lv-ask" } as const;

/** 一个阶段的规则：一条一行（名字、违反了怎么办、公式），点开进它的详情 */
function PolicyRows({ rules, onRule }: { rules: readonly PlanTemporalRule[]; onRule?: ((ruleId: string) => void) | undefined }) {
  return (
    <ul className="mp-policy">
      {rules.map((r) => {
        const level = onViolationOf(r);
        return (
          <li key={r.id}>
            <button type="button" className={`mp-policy-row ${LEVEL_CLS[level]}`} onClick={onRule && (() => onRule(r.id))} disabled={!onRule}>
              <span className="mp-policy-name">
                {LEVEL_ICON[level]} {r.title ?? r.id}
                <span className="mp-origin">{ON_VIOLATION_TEXT[level]} · {t("ui.stageDetail.forThisStage")}</span>
              </span>
              <code className="fm-formula fm-small">{formulaOf(r).formula}</code>
              <code className="fm-api fm-small">
                <span className="fm-api-k">{t("ui.stageDetail.api")}</span>
                {apiFormulaOf(r)}
              </code>
              {onRule && <span className="tool-more">›</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * 一个阶段的一条规则（84 号票：阶段详情里点一条钻进来）：复用 60 号票检测项全览的那一条
 * （形式化写法、接口、修法、规则原文）；长程任务的阶段规则没有规划时的审查，生效阶段是执行时
 */
export function StageRuleDetail({ source, taskId, stageId, ruleId }: { source: StageDetailSource | undefined; taskId: string; stageId: string; ruleId: string }) {
  const [open, setOpen] = useState(true);
  const stages = source?.taskId === taskId ? source.stages : [];
  const stage = stages.find((s) => s.id === stageId);
  const rule = stage?.ruleDocs?.find((r) => r.id === ruleId);
  if (!stage || !rule) return <div className="muted">{t("ui.stageDetail.ruleGone")}</div>;
  const level = onViolationOf(rule);
  const label = stageCodeLabel(stageCodes(stages), stage.id);
  return (
    <>
      <div className="dt-head">
        <span className="tag tag-mplan">{t("ui.stageDetail.ruleOf", { label })}</span>
        <span className={`dt-status rule-lv ${LEVEL_CLS[level]}`}>{ON_VIOLATION_TEXT[level]}</span>
      </div>
      <div className="dt-title">{rule.title ?? rule.id}</div>
      <section className="dt-section">
        <h4>{t("ui.stageDetail.checkOverview")}</h4>
        <RuleRow rule={ruleBookEntry(rule, undefined, ["runtime"])} open={open} onToggle={() => setOpen(!open)} />
        <div className="muted dt-note">{t("ui.stageDetail.ruleNote", { label, title: stage.title })}</div>
      </section>
    </>
  );
}

// ───────────────────────── 从这里重做 ─────────────────────────

/** 页面上的阶段开始过没有：真任务带着（协议包的 stageStarted 算的），原型的假阶段按状态 */
export const stageStartedOf = (s: Stage) => s.started ?? s.status !== "pending";

/** 页面上的一个阶段算重做范围时的样子（协议包的 reopenScope 要的 stageId、dependsOn，加上开始过没有） */
const reopenRef = (s: Stage) => ({ stageId: s.id, dependsOn: s.after, started: stageStartedOf(s) });

/** 一件事在哪儿生效（不撤回，所以不分能撤回、能补救、收不回，按本机、对外分） */
const REACH_LABEL: Readonly<Record<StageEffect["reach"], string>> = tTable({ local: "ui.rollback.local", external: "ui.rollback.outside" });

/** 说成人话（和会话里的工具调用一样） */
const effectTitle = (e: StageEffect) => describeCall(e.tool, e.argsSummary) ?? fallbackLine(e.tool, e.argsSummary);

/**
 * 从某个阶段重做：写这次要怎么改（会转告维护者），列出要一起重做的阶段、
 * 这几个阶段这一轮已经做了的事（守护进程现取：本机的、对外的，都不撤回，维护者会知道它们做过），注意里写要重做的已验收阶段
 */
export function ReopenDialog({
  stages,
  stageId,
  taskId,
  onCancel,
  onConfirm,
}: {
  stages: readonly Stage[];
  stageId: string;
  taskId: string;
  onCancel(): void;
  onConfirm(note: string | undefined, edit: StageEdit | undefined): void;
}) {
  const [note, setNote] = useState("");
  // 125 号票：这一阶段原来的验收标准、交付件，和对话框里改着的草稿
  const stage = stages.find((s) => s.id === stageId);
  const criteria = stage?.acceptance.map((a) => a.text) ?? [];
  const deliverables = stage ? stageDeliverables(stage) : [];
  const [draft, setDraft] = useState<StageEditDraft>(() => stageEditDraft(criteria, deliverables));
  const edit = stageEditOf(criteria, deliverables, draft);
  const problem = stageEditProblem(draft);
  const view = useStageView(taskId, stageId, "reopen");
  const ready = view.state === "ready" ? view.view : undefined;
  // 守护进程还没回来（或者没取到）时按手上的阶段算（协议包同一个函数）
  const scope = ready?.reopenScope ?? reopenScope(stages.map(reopenRef), stageId, (s) => s.started);
  const effects = ready ? [...ready.effects.filter((e) => e.reach === "local"), ...ready.effects.filter((e) => e.reach === "external")] : [];
  const title = (id: string) => stages.find((s) => s.id === id)?.title ?? id;
  const codes = stageCodes(stages);
  const accepted = scope.filter((id) => stages.find((s) => s.id === id)?.status === "accepted");
  return (
    <Sheet title={t("ui.stageDetail.reopenTitle", { title: title(stageId) })} onClose={onCancel} center>
      <div className="muted dt-note">{t("ui.stageDetail.reopenNote")}</div>
      <label className="field rp-note">
        <span>{t("ui.stageDetail.changeLabel")}</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder={t("ui.stageDetail.changePlaceholder")} />
      </label>
      {stage && (
        <StageEditFields
          draft={draft}
          methods={stage.acceptance.map((a) => a.method)}
          onChange={setDraft}
          edited={edit !== undefined}
        />
      )}
      <div className="rp-sec">{t("ui.stageDetail.redoScope", { count: scope.length })}</div>
      <ul className="rp-scope">
        {scope.map((id) => (
          <li key={id}>
            <b>{stageCodeLabel(codes, id)}</b> {title(id)}
          </li>
        ))}
      </ul>
      <div className="rp-sec">{ready ? t("ui.stageDetail.doneEffects", { count: effects.length }) : t("ui.stageDetail.doneEffectsPending")}</div>
      {view.state === "loading" ? (
        <div className="muted">{t("ui.rollback.loading")}</div>
      ) : view.state === "failed" ? (
        <div className="muted">{t("ui.stageDetail.effectsFailed", { error: view.error })}</div>
      ) : effects.length === 0 ? (
        <div className="muted">{t("ui.stageDetail.noEffects")}</div>
      ) : (
        <ul className="eff-list">
          {effects.map((e) => (
            <li key={`${e.stageId}:${e.tool}:${e.argsSummary}`} className={e.reach === "external" ? "eff-stuck" : "eff-local"}>
              <span className="eff-scope">{REACH_LABEL[e.reach]}</span>
              <span className="eff-title">{effectTitle(e)}</span>
              <span className="muted eff-why">
                {e.reach === "external" ? t("ui.stageDetail.externalWhy") : t("ui.stageDetail.localWhy")}
              </span>
            </li>
          ))}
        </ul>
      )}
      {accepted.length > 0 && (
        <>
          <div className="rp-sec">{t("ui.stageDetail.heads")}</div>
          <ul className="rp-risks">
            <li>{t("ui.stageDetail.acceptedRedo", { list: accepted.map((id) => stageCodeLabel(codes, id)).join(t("ui.common.listSep")) })}</li>
          </ul>
        </>
      )}
      <div className="auth-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>
          {t("ui.rollback.cancel")}
        </button>
        <button type="button" className="btn danger" disabled={problem !== undefined} title={problem} onClick={() => onConfirm(note.trim() || undefined, edit)}>
          {edit ? t("ui.stageDetail.reopenEdited") : t("ui.stageDetail.reopen")}
        </button>
      </div>
    </Sheet>
  );
}

/** 一个阶段的交付件逐条（真任务带着；原型的假阶段只有一句，按"；"分开） */
const stageDeliverables = (s: Stage): string[] =>
  s.deliverables ??
  s.deliverable
    .split("；") // @i18n-ignore data：原型的假阶段只有一句交付件，按中文分号拆开
    .map((d) => d.trim())
    .filter((d) => d.length > 0);

/** 验收方式的小签（和阶段详情的验收标准一样） */
const methodTag = (method: Stage["acceptance"][number]["method"] | undefined) =>
  method === undefined ? t("ui.stageDetail.reviewNew") : method === "user" ? t("ui.stageDetail.byYou") : method === "script" ? t("ui.stageDetail.autoCheck") : ACCEPTANCE_METHOD_LABEL[method];

/**
 * 重做对话框里直接改这一阶段（125 号票）：验收标准一条一个输入框（改过的沿用原来那条的验收方式，新加的由评审验收），交付件一样；
 * 每条能去掉，各能加一条。改了就是你的确认：不出卡，点重做就换成新一版计划，时间线上记一笔前后对照
 */
function StageEditFields({
  draft,
  methods,
  onChange,
  edited,
}: {
  draft: StageEditDraft;
  methods: ReadonlyArray<Stage["acceptance"][number]["method"]>;
  onChange(next: StageEditDraft): void;
  edited: boolean;
}) {
  const setCriterion = (i: number, text: string) => onChange({ ...draft, acceptance: draft.acceptance.map((a, j) => (j === i ? { ...a, text } : a)) });
  const dropCriterion = (i: number) => onChange({ ...draft, acceptance: draft.acceptance.filter((_, j) => j !== i) });
  const setDeliverable = (i: number, text: string) => onChange({ ...draft, deliverables: draft.deliverables.map((d, j) => (j === i ? text : d)) });
  const dropDeliverable = (i: number) => onChange({ ...draft, deliverables: draft.deliverables.filter((_, j) => j !== i) });
  return (
    <div className="rp-edit">
      <div className="rp-sec">{t("ui.stageDetail.editCriteria")}</div>
      <ul className="rp-edit-list">
        {draft.acceptance.map((a, i) => (
          <li key={i} className="rp-edit-row">
            <textarea className="input" rows={1} value={a.text} onChange={(e) => setCriterion(i, e.target.value)} aria-label={t("ui.stageDetail.criterionN", { n: i + 1 })} />
            <span className="mp-tag mp-auto">{methodTag(a.from === undefined ? undefined : methods[a.from])}</span>
            <button type="button" className="btn ghost rp-edit-drop" onClick={() => dropCriterion(i)} disabled={draft.acceptance.length <= 1} title={t("ui.stageDetail.removeCriterion")}>
              ×
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="btn ghost rp-edit-add" onClick={() => onChange({ ...draft, acceptance: [...draft.acceptance, { text: "" }] })}>
        {t("ui.stageDetail.addCriterion")}
      </button>
      <div className="rp-sec">{t("ui.stageDetail.deliverables")}</div>
      <ul className="rp-edit-list">
        {draft.deliverables.map((d, i) => (
          <li key={i} className="rp-edit-row">
            <input className="input" value={d} onChange={(e) => setDeliverable(i, e.target.value)} aria-label={t("ui.stageDetail.deliverableN", { n: i + 1 })} />
            <button type="button" className="btn ghost rp-edit-drop" onClick={() => dropDeliverable(i)} disabled={draft.deliverables.length <= 1} title={t("ui.stageDetail.removeDeliverable")}>
              ×
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="btn ghost rp-edit-add" onClick={() => onChange({ ...draft, deliverables: [...draft.deliverables, ""] })}>
        {t("ui.stageDetail.addDeliverable")}
      </button>
      <div className={`dt-note ${edited ? "rp-edit-on" : "muted"}`}>
        {edited
          ? t("ui.stageDetail.editedNote")
          : t("ui.stageDetail.uneditedNote")}
      </div>
    </div>
  );
}
