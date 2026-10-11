/**
 * 长程任务的阶段详情（60 号票）：照搬 AgentSense web/src/ui/milestone.tsx 的 MilestoneDetail（D:\code\claudecode\user_agent_sense_of_security，
 * bedf5a5）——头上"第 N 阶段"、状态、第几轮；"回到会话里这一段""⟲ 从这里重做…"；这一步出过的状况（incidents.tsx 的图标和说法）；
 * 交付件；验收标准（逐条带核对结果、怎么验收）；尝试记录（每次交上来的结论和备注、每次重开）；授权和用量；执行方式；这一阶段的规则。
 * "从这里重做"照 AgentSense 的 ReopenDialog：写这次要怎么改、列出要一起重做的阶段（它和依赖它的），确认了才动——落到二狗的返工
 * （task_action 的 rework，连同下游；13 号票），所以只在任务做完、能返工的时候有这个按钮。
 * 计划里写的（交付件、验收、模式、授权、规则、预算）取阶段抽屉用的那份；从会话、看板推出来的（状况、尝试记录、第几轮、
 * 这一段的第一条、重做的范围、工具调用用了几次）由状态层给（state/stage-detail.ts），按这个任务的整段会话算。
 * 和 AgentSense 不一样的（没有对应的数据，等用户定）：交上来的原始数据、凭据核对、授权"已用几次"、按授权种类分的敏/权/外/问、
 * 重做前列出"这几步已经做了的事"（哪些能撤回、哪些收不回）、规则集的点进详情和"执行轨迹与规则核对"、选这种执行方式的理由、
 * 初步思路、认领时审查；尝试记录的备注只有维护者宣布完成时写的那句（AgentSense 由你验收时是你写的说明）。
 */
import { useState } from "react";
import { useStore } from "../../app/store.tsx";
import { ACCEPTANCE_METHOD_LABEL, WAIT_REASON_LABEL } from "../../model/labels.ts";
import type { Stage } from "../../model/types.ts";
import { type ChatItem, reworkScope, stageDetailFacts } from "../../state/index.ts";
import { clockLabel } from "../../util/time.ts";
import { Sheet } from "../common.tsx";
import { budgetText, STAGE_STATUS } from "../conversation/StageDrawer.tsx";
import { IncidentIcon } from "./incidents.tsx";
import { Section } from "./section.tsx";

/** 任务详情页给阶段详情的：哪个任务、它的各阶段（阶段抽屉用的那份），能不能从某个阶段重做、怎么重做 */
export interface StageDetailSource {
  readonly taskId: string;
  readonly stages: readonly Stage[];
  /** 现在能从这个阶段返工重做（任务做完了、返工的控制里有它） */
  canRework(stageId: string): boolean;
  /** 返工重做这个阶段和它的下游，note 是这次要怎么改（交给维护者） */
  rework(stageId: string, note: string | undefined): void;
}

export function StageDetail({
  source,
  taskId,
  stageId,
  items,
  onReveal,
}: {
  source: StageDetailSource | undefined;
  taskId: string;
  stageId: string;
  items: readonly ChatItem[];
  onReveal?: ((id?: string) => void) | undefined;
}) {
  const { ui } = useStore();
  const [reopening, setReopening] = useState(false);
  const stages = source?.taskId === taskId ? source.stages : [];
  const stage = stages.find((s) => s.id === stageId);
  if (!source || !stage) return <div className="muted">这个阶段已经不在当前计划里了。</div>;
  const n = stages.indexOf(stage) + 1;
  const facts = stageDetailFacts(ui, items, taskId, stageId);
  const canReopen = source.canRework(stageId);
  const st = STAGE_STATUS[stage.status];
  const over = (stage.budget.usedTokens ?? 0) > stage.budget.tokens;
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
      <div className="dt-title">{stage.title}</div>
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
        {canReopen && <div className="muted dt-note ms-reopen-hint">点了先列出要一起重做的阶段（这一阶段和依赖它的），你确认了才动</div>}
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
              </li>
            ) : (
              <li key={`r${x.at}${i}`} className="re">
                <b>⟲ 重开</b> {clockLabel(x.at)} · 范围 {x.scope.map((id) => `第 ${stages.findIndex((s) => s.id === id) + 1} 阶段`).join("、")}
              </li>
            ),
          )}
        </ol>
      </Section>
      <Section title="授权和用量">
        {stage.grants.length > 0 ? (
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
        <div className={`dt-note ms-budget${over ? " over" : ""}`}>
          预算：{budgetText(stage.budget)}
          {over && " · 超出预算"}
        </div>
      </Section>
      <Section title="执行方式">
        <div className="dt-note">{stage.mode === "steps" ? "按定好的步骤做" : "路怎么走由维护者自己找"}</div>
        {stage.mode === "steps" && stage.steps && stage.steps.length > 0 && (
          <ol className="mp-steps">
            {stage.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        )}
      </Section>
      {stage.rules.length > 0 && (
        <Section title="这一阶段的规则">
          <ul className="ms-policy">
            {stage.rules.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <div className="muted dt-note">执行这一阶段时，每次调用之前守卫照这些规则核对一遍。</div>
        </Section>
      )}
      {reopening && (
        <ReopenDialog
          stages={stages}
          stageId={stageId}
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

/**
 * 从某个阶段重做（AgentSense milestone.tsx 的 ReopenDialog）：写这次要怎么改（会转告维护者），列出要一起重做的阶段；
 * "这几步已经做了的事、重做前怎么处理"二狗没有对应的数据（效果没有撤回、补救），不列
 */
function ReopenDialog({ stages, stageId, onCancel, onConfirm }: { stages: readonly Stage[]; stageId: string; onCancel(): void; onConfirm(note: string | undefined): void }) {
  const [note, setNote] = useState("");
  const scope = reworkScope(stages, stageId);
  const title = stages.find((s) => s.id === stageId)?.title ?? stageId;
  return (
    <Sheet title={`从「${title}」重做`} onClose={onCancel} center>
      <div className="muted dt-note">验收只核对计划里写下的标准；标准没写到的（比如你其实想留某一张），用重做来改。只重做这一阶段和依赖它的阶段，不相干的照常保留；原来那段记录留在原处，标为已废弃。</div>
      <label className="field rp-note">
        <span>这次要怎么改（会转告维护者）</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="比如：这次换一种分法；那几张要留着" />
      </label>
      <div className="rp-sec">要重做的（{scope.length} 个）</div>
      <ul className="rp-scope">
        {scope.map((s) => (
          <li key={s.id}>
            <b>第 {stages.findIndex((x) => x.id === s.id) + 1} 阶段</b> {s.title}
          </li>
        ))}
      </ul>
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
