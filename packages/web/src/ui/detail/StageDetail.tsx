/**
 * 长程任务的阶段详情（60 号票）：照搬 AgentSense web/src/ui/milestone.tsx 的 MilestoneDetail（D:\code\claudecode\user_agent_sense_of_security，
 * bedf5a5）——头上"第 N 阶段"、状态、第几轮，标题旁边要你留意的小标记（MarkBadges）；"回到会话里这一段""⟲ 从这里重做…"；
 * 这一步出过的状况（incidents.tsx 的图标和说法）；交付件；验收标准（逐条带核对结果、怎么验收）；尝试记录（每次交上来的结论和备注、
 * 每次重开）；要你留意的（MarkRows：本机授权、对外的动作、会问你的，授权写"已用 N/M"，下面是图例）；执行方式（理由、步骤或初步思路）；
 * 这一阶段的规则（PolicyRows：一条一行，点进去看它的详情）。
 * "从这里重做"照 AgentSense 的 ReopenDialog：写这次要怎么改、列出要一起重做的阶段（它和依赖它的、开始过的）、这几个阶段这一轮已经做了的事，
 * 确认了才动——落到 task_action 的 rework（连同下游；13 号票，84 号票起照 AgentSense 开始过的阶段就有这个按钮）。
 * 计划里写的（交付件、验收、模式和理由、授权、规则、预算）取阶段抽屉用的那份；从会话、看板推出来的（状况、尝试记录、第几轮、
 * 这一段的第一条、重做的范围、工具调用用了几次）由状态层给（state/stage-detail.ts），按这个任务的整段会话算；
 * 守护进程那边才有的（授权已用几次、这一段已经做了的事）每次打开现取（GET /api/tasks/<任务>/stages/<阶段>，84 号票）。
 * 和 AgentSense 不一样的（84 号票，用户 2026-10-11 都接受了）：
 * - 重做不撤回（真撤回在 85 号票）：已经做了的事只分"本机""对外"列出来、写明收不回，没有"能撤回""能补救"和补偿里程碑；
 * - 要你留意的没有"敏"（计划里还没有会用到的敏感数据，85 号票），图例只列"权""外""问"，说明按电脑上的事改写，
 *   "权"叫"本机授权"（领域里授权项不叫"权限"）、只读的授权也算在里面（85 号票再分）；多一行预算（60 号票就有）；
 * - 尝试记录的备注：维护者宣布完成时写的那句和你退回时写的说明各一行（AgentSense 有你的说明时只显示你的）；
 * - 规则一条一行（AgentSense 按规则集），违反了怎么办多一级退回；
 * - 交上来的原始数据、凭据核对、认领时审查、执行轨迹与规则核对、重开后复验范围外已验收的阶段二狗没有（85 号票）。
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
  type TaskStageView,
} from "../../state/index.ts";
import { clockLabel } from "../../util/time.ts";
import { Sheet } from "../common.tsx";
import { budgetText, STAGE_STATUS } from "../conversation/StageDrawer.tsx";
import { IncidentIcon } from "./incidents.tsx";
import { RuleRow } from "./RuleBook.tsx";
import { Section } from "./section.tsx";

/** 任务详情页给阶段详情的：哪个任务、它的各阶段（阶段抽屉用的那份），能不能从某个阶段重做、怎么重做 */
export interface StageDetailSource {
  readonly taskId: string;
  readonly stages: readonly Stage[];
  /** 现在能从这个阶段重做（开始过的阶段，建好了阶段的长程任务，84 号票） */
  canRework(stageId: string): boolean;
  /** 从这个阶段重做（连同它的下游），note 是这次要怎么改（交给维护者） */
  rework(stageId: string, note: string | undefined): void;
}

// ───────────────────────── 要你留意的（AgentSense planMarks / MarkBadges / MarkRows） ─────────────────────────

/**
 * 要你留意的几样：字、名字、说明（AgentSense MARK_META，"敏"在 85 号票）。说明里的例子 AgentSense 写的是手机上的事，
 * 二狗是电脑上的，换成写文件、删改、推送、发消息这类
 */
const MARK_META = [
  { key: "perm", glyph: "权", name: "本机授权", hint: "授权它动你电脑里的东西（写文件、删改、越出项目目录、装软件），不给别人" },
  { key: "out", glyph: "外", name: "对外动作", hint: "做了，电脑以外的人或平台就会收到、记下：推送、发布、发消息、带数据的请求……" },
  { key: "ask", glyph: "问", name: "停下来问你", hint: "到这一步会停下来等你点头、等你验收" },
] as const;

/** 一个阶段的小标记：每样一个圆字 + 个数；只查看的写"只查看"（quiet 时不写字） */
export function MarkBadges({ marks, quiet }: { marks: StageMarks | undefined; quiet?: boolean }) {
  const items = marks ? MARK_META.filter((x) => marks[x.key].length > 0) : [];
  if (!marks) return null;
  if (!items.length) return quiet ? null : <span className="mg-bds mg-bds-none">只查看</span>;
  return (
    <span className="mg-bds">
      {items.map((x) => (
        <span key={x.key} className={`mg-bd mg-bd-${x.key}`} title={`${x.name}：${marks[x.key].map((v) => v.text).join("；")}`}>
          <i>{x.glyph}</i>
          {marks[x.key].length}
        </span>
      ))}
    </span>
  );
}

/** 要你留意的几样，一样一行，逐条写出是什么；used 是授权项 id → 用了几次（详情里写"已用 N/M"） */
function MarkRows({ marks, used }: { marks: StageMarks; used?: ReadonlyMap<string, number> | undefined }) {
  const rows = MARK_META.filter((x) => marks[x.key].length > 0);
  if (!rows.length)
    return (
      <div className="mp-node-row">
        <span className="mp-node-k">要留意的</span>
        <span className="muted">没有：这一步只查看</span>
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
            {x.key === "ask" ? "会问你" : x.name}
          </span>
          <ul className="mp-node-list">
            {marks[x.key].map((v) => {
              const n = v.grantId === undefined ? undefined : used?.get(v.grantId);
              return (
                <li key={v.text}>
                  {v.text}
                  {v.limit !== undefined && n !== undefined && <span className={`ms-used ${n >= v.limit ? "full" : ""}`}> 已用 {n}/{v.limit}</span>}
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
  if (!source || !stage) return <div className="muted">这个阶段已经不在当前计划里了。</div>;
  // 91 号票：第几阶段按依赖图的编号（并行的写 4a、4b，AgentSense 详情头上写的是里程碑编号 M4a）
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
        <span className="tag tag-mplan">第 {n} 阶段</span>
        <span className={`dt-status ms-st st-${stage.status}`}>
          {st.icon} {st.text}
          {stage.status === "waiting" && stage.waitReason ? `（${WAIT_REASON_LABEL[stage.waitReason]}）` : ""}
        </span>
        {facts.rounds > 1 && <span className="dt-status">第 {facts.rounds} 轮</span>}
      </div>
      <div className="dt-title">
        {stage.title} <MarkBadges marks={stage.marks} quiet />
      </div>
      {stage.status === "waiting" && stage.waitNote && <div className="muted dt-note">{stage.waitNote}</div>}
      <div className="ms-actions">
        {facts.firstItemId && onReveal && (
          <button type="button" className="btn ghost" onClick={() => onReveal(facts.firstItemId)}>
            回到会话里这一段
          </button>
        )}
        {canReopen && (
          <button type="button" className="btn ghost" onClick={() => setReopening(true)}>
            ⟲ 从这里重做…
          </button>
        )}
        {canReopen && <div className="muted dt-note ms-reopen-hint">点了先列出这一步之后做过的事（本机的、对外的，都收不回），你确认了才动</div>}
      </div>
      {facts.incidents.length > 0 && (
        <Section title="这一步出过的状况">
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
      <Section title="交付件">
        <div className="dt-note">{stage.deliverable}</div>
      </Section>
      <Section title="验收标准">
        <ul className="ms-criteria">
          {stage.acceptance.map((c) => {
            const mark = !c.result ? "○" : c.result === "pass" ? "✓" : "✕";
            return (
              <li key={c.text} className={`mc-${c.result ?? "none"}`}>
                <span className="mc-mark">{mark}</span>
                <span>
                  {c.text}
                  <span className={c.method === "user" ? "mp-tag mp-user" : "mp-tag mp-auto"}>{c.method === "user" ? "由你验收" : c.method === "script" ? "自动核对" : ACCEPTANCE_METHOD_LABEL[c.method]}</span>
                  {c.method === "user" && c.result && <span className="muted">（你判的）</span>}
                  {c.note && <div className="muted">{c.note}</div>}
                </span>
              </li>
            );
          })}
        </ul>
        <div className="muted dt-note">验收对照的是真实世界的状态，不看维护者怎么说。</div>
      </Section>
      <Section title={`尝试记录（${facts.submissions} 次提交${facts.reopens ? `，重开过 ${facts.reopens} 次` : ""}）`}>
        {facts.attempts.length === 0 && <div className="muted">还没提交过。</div>}
        <ol className="ms-attempts">
          {facts.attempts.map((x, i) =>
            x.kind === "attempt" ? (
              <li key={`a${x.at}${i}`} className={x.passed ? "ok" : "no"}>
                <b>{x.passed ? "✓ 通过" : "✕ 没通过"}</b> {clockLabel(x.at)}
                {!x.passed && x.failed.length > 0 && <span className="muted"> · 不满足：{x.failed.join("；")}</span>}
                {x.note && <div className="muted">备注：{x.note}</div>}
                {x.userNote && <div className="muted">你写的说明：「{x.userNote}」</div>}
              </li>
            ) : (
              <li key={`r${x.at}${i}`} className="re">
                <b>⟲ 重开</b> {clockLabel(x.at)} · 范围 {x.scope.map((id) => stageCodeLabel(codes, id)).join("、")}
              </li>
            ),
          )}
        </ol>
      </Section>
      <Section title="要你留意的">
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
          <div className="muted">没有授权项：这一阶段要动手的事到时候照常按处置问你</div>
        )}
        <ul className="muted dt-note ms-mark-hints">
          {MARK_META.map((x) => (
            <li key={x.key}>
              <span className={`mg-bd mg-bd-${x.key}`}>
                <i>{x.glyph}</i>
                {x.name}
              </span>
              ：{x.hint}
            </li>
          ))}
        </ul>
        <div className={`dt-note ms-budget${over ? " over" : ""}`}>
          预算：{budgetText(stage.budget)}
          {over && " · 超出预算"}
        </div>
      </Section>
      <Section title="执行方式">
        <div className="dt-note">
          {stage.mode === "steps" ? "按定好的步骤做" : "路怎么走由维护者自己找"}
          {stage.modeReason ? `：${stage.modeReason}` : ""}
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
          : stage.roughIdea && <div className="muted dt-note">初步思路：{stage.roughIdea}</div>}
      </Section>
      {(stage.ruleDocs?.length ?? stage.rules.length) > 0 && (
        <Section title="这一阶段的规则">
          {stage.ruleDocs ? (
            <PolicyRows rules={stage.ruleDocs} onRule={onRule} />
          ) : (
            <ul className="ms-policy">
              {stage.rules.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
          <div className="muted dt-note">执行这一阶段时，每次调用之前守卫照这些规则核对一遍；点一条看它的表达式和修法。</div>
        </Section>
      )}
      {reopening && (
        <ReopenDialog
          stages={stages}
          stageId={stageId}
          taskId={taskId}
          onCancel={() => setReopening(false)}
          onConfirm={(note) => {
            setReopening(false);
            source.rework(stageId, note);
          }}
        />
      )}
    </>
  );
}

/** 违反了怎么办的图标、颜色（AgentSense PolicyRows：红线 ⛔、拦截 ✋、确认 ❓；二狗多一种按规则退回 ↩），说法在协议包的 ON_VIOLATION_TEXT */
const LEVEL_ICON = { block: "✋", pull_back: "↩", confirm: "❓" } as const;
const LEVEL_CLS = { block: "lv-block", pull_back: "lv-pull", confirm: "lv-ask" } as const;

/** 一个阶段的规则：一条一行（名字、违反了怎么办、公式），点开进它的详情（AgentSense PolicyRows） */
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
                <span className="mp-origin">{ON_VIOLATION_TEXT[level]} · 为这一阶段定的</span>
              </span>
              <code className="fm-formula fm-small">{formulaOf(r).formula}</code>
              <code className="fm-api fm-small">
                <span className="fm-api-k">接口</span>
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
 * 一个阶段的一条规则（84 号票：阶段详情里点一条钻进来，AgentSense 点规则集进 RuleSetDetail）：复用 60 号票检测项全览的那一条
 * （形式化写法、接口、修法、规则原文）；长程任务的阶段规则没有规划时的审查，生效阶段是执行时
 */
export function StageRuleDetail({ source, taskId, stageId, ruleId }: { source: StageDetailSource | undefined; taskId: string; stageId: string; ruleId: string }) {
  const [open, setOpen] = useState(true);
  const stages = source?.taskId === taskId ? source.stages : [];
  const stage = stages.find((s) => s.id === stageId);
  const rule = stage?.ruleDocs?.find((r) => r.id === ruleId);
  if (!stage || !rule) return <div className="muted">这条规则已经不在当前计划里了。</div>;
  const level = onViolationOf(rule);
  const label = stageCodeLabel(stageCodes(stages), stage.id);
  return (
    <>
      <div className="dt-head">
        <span className="tag tag-mplan">{label}的规则</span>
        <span className={`dt-status rule-lv ${LEVEL_CLS[level]}`}>{ON_VIOLATION_TEXT[level]}</span>
      </div>
      <div className="dt-title">{rule.title ?? rule.id}</div>
      <section className="dt-section">
        <h4>检测项全览</h4>
        <RuleRow rule={ruleBookEntry(rule, undefined, ["runtime"])} open={open} onToggle={() => setOpen(!open)} />
        <div className="muted dt-note">执行{label}「{stage.title}」时，每次调用之前守卫照它核对一遍。</div>
      </section>
    </>
  );
}

// ───────────────────────── 从这里重做（AgentSense ReopenDialog） ─────────────────────────

/** 页面上的阶段开始过没有：真任务带着（协议包的 stageStarted 算的），原型的假阶段按状态 */
export const stageStartedOf = (s: Stage) => s.started ?? s.status !== "pending";

/** 页面上的一个阶段算重做范围时的样子（协议包的 reopenScope 要的 stageId、dependsOn，加上开始过没有） */
const reopenRef = (s: Stage) => ({ stageId: s.id, dependsOn: s.after, started: stageStartedOf(s) });

/** 一件事在哪儿生效（AgentSense 的 CAT_LABEL 是能撤回、能补救、收不回；二狗不撤回，按本机、对外分） */
const REACH_LABEL: Readonly<Record<StageEffect["reach"], string>> = { local: "本机", external: "对外" };

/** 说成人话（和会话里的工具调用一样） */
const effectTitle = (e: StageEffect) => describeCall(e.tool, e.argsSummary) ?? fallbackLine(e.tool, e.argsSummary);

/**
 * 从某个阶段重做（AgentSense milestone.tsx 的 ReopenDialog）：写这次要怎么改（会转告维护者），列出要一起重做的阶段、
 * 这几个阶段这一轮已经做了的事（守护进程现取：本机的、对外的，都不撤回，维护者会知道它们做过），注意里写要重做的已验收阶段
 */
export function ReopenDialog({ stages, stageId, taskId, onCancel, onConfirm }: { stages: readonly Stage[]; stageId: string; taskId: string; onCancel(): void; onConfirm(note: string | undefined): void }) {
  const [note, setNote] = useState("");
  const view = useStageView(taskId, stageId, "reopen");
  const ready = view.state === "ready" ? view.view : undefined;
  // 守护进程还没回来（或者没取到）时按手上的阶段算（协议包同一个函数）
  const scope = ready?.reopenScope ?? reopenScope(stages.map(reopenRef), stageId, (s) => s.started);
  const effects = ready ? [...ready.effects.filter((e) => e.reach === "local"), ...ready.effects.filter((e) => e.reach === "external")] : [];
  const title = (id: string) => stages.find((s) => s.id === id)?.title ?? id;
  const codes = stageCodes(stages);
  const accepted = scope.filter((id) => stages.find((s) => s.id === id)?.status === "accepted");
  return (
    <Sheet title={`从「${title(stageId)}」重做`} onClose={onCancel} center>
      <div className="muted dt-note">验收只核对计划里写下的标准；标准没写到的（比如你其实想留某一张），用重做来改。只重做这一阶段和依赖它的阶段，不相干的照常保留；原来那段记录留在原处，标为已废弃。</div>
      <label className="field rp-note">
        <span>这次要怎么改（会转告维护者）</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="比如：这次换一种分法；那几张要留着" />
      </label>
      <div className="rp-sec">要重做的（{scope.length} 个）</div>
      <ul className="rp-scope">
        {scope.map((id) => (
          <li key={id}>
            <b>{stageCodeLabel(codes, id)}</b> {title(id)}
          </li>
        ))}
      </ul>
      <div className="rp-sec">这几步已经做了的事{ready ? `（${effects.length} 件）` : ""}，重做前不会撤回</div>
      {view.state === "loading" ? (
        <div className="muted">正在列出这一段做过的事…</div>
      ) : view.state === "failed" ? (
        <div className="muted">没取到这一段做过的事（{view.error}）；重做照样不撤回，维护者会自己查。</div>
      ) : effects.length === 0 ? (
        <div className="muted">这一段还没有对世界产生效果。</div>
      ) : (
        <ul className="eff-list">
          {effects.map((e) => (
            <li key={`${e.stageId}:${e.tool}:${e.argsSummary}`} className={e.reach === "external" ? "eff-stuck" : "eff-local"}>
              <span className="eff-scope">{REACH_LABEL[e.reach]}</span>
              <span className="eff-title">{effectTitle(e)}</span>
              <span className="muted eff-why">
                {e.reach === "external" ? "已经对外生效，收不回来。维护者重做时会知道它已经发生过" : "本机的改动不会自动恢复。维护者重做时会知道它已经做过"}
              </span>
            </li>
          ))}
        </ul>
      )}
      {accepted.length > 0 && (
        <>
          <div className="rp-sec">注意</div>
          <ul className="rp-risks">
            <li>已经验收通过的 {accepted.map((id) => stageCodeLabel(codes, id)).join("、")} 要重做。</li>
          </ul>
        </>
      )}
      <div className="auth-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>
          取消
        </button>
        <button type="button" className="btn danger" onClick={() => onConfirm(note.trim() || undefined)}>
          重开并让维护者接着做
        </button>
      </div>
    </Sheet>
  );
}
