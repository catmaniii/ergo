// 除计划确认卡以外的 13 种卡片。负载形状见 model/cards.ts。
import { type ReactNode, useState } from "react";
import { toHash } from "../../app/route.ts";
import type {
  ApprovalPayload,
  CharterPayload,
  MemoryDeletePayload,
  PairingPayload,
  ParallelPayload,
  PlanChangePayload,
  ProgressPayload,
  QuestionsPayload,
  QuickActionPayload,
  ReminderPayload,
  SuggestProjectPayload,
  SuggestTaskPayload,
  WorkOrderPayload,
} from "../../model/cards.ts";
import { repeatLabel, timeLabel, tokensLabel, weekdayLabel } from "../../model/labels.ts";
import type { RepeatRule, Toolkit } from "../../model/types.ts";
import { type CardProps, CardShell } from "./CardShell.tsx";

export function toolkitLabel(t: Toolkit): string {
  return [
    `skill：${t.skills.length ? t.skills.join("、") : "无"}`,
    `MCP：${t.mcps.length ? t.mcps.join("、") : "无"}`,
    `bash：${t.bash ? "开" : "关"}`,
    `联网：${t.network ? "开" : "关"}`,
  ].join("；");
}

function Btn({ kind = "ghost", onClick, children, disabled }: { kind?: "primary" | "ghost" | "danger"; onClick(): void; children: ReactNode; disabled?: boolean }) {
  return (
    <button type="button" className={`btn ${kind}`} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

export function ApprovalCard({ view, payload: p, act }: CardProps<ApprovalPayload>) {
  return (
    <CardShell
      view={view}
      title={p.task ? `${p.task}` : "对话里的一次操作"}
      actions={
        <>
          <Btn onClick={() => act("deny")}>拒绝</Btn>
          <Btn kind="primary" onClick={() => act("approve")}>
            批准这一次
          </Btn>
        </>
      }
    >
      {p.stage && <div className="muted">{p.stage}</div>}
      <div className="tool-line">
        <b>{p.tool}</b> <code>{p.argsSummary}</code>
      </div>
      <div className="chips">
        {p.categories.map((c) => (
          <span key={c} className="chip chip-op">
            {c}
          </span>
        ))}
        <span className="chip">先问我</span>
      </div>
      <div className="sys-note">{p.reason}</div>
    </CardShell>
  );
}

export function QuestionsCard({ view, payload: p, done, act }: CardProps<QuestionsPayload>) {
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const all = p.questions.every((q) => answers[q.id] !== undefined);
  const note = () => p.questions.map((q) => `${q.text.replace(/？$/, "")}：${q.options[answers[q.id]!]}`).join("；");
  return (
    <CardShell
      view={view}
      title={`${p.questions.length} 个问题`}
      actions={
        <>
          <Btn onClick={() => setAnswers(Object.fromEntries(p.questions.map((q) => [q.id, q.recommended])))}>全按推荐</Btn>
          <Btn kind="primary" disabled={!all} onClick={() => act("answer", note())}>
            提交回答
          </Btn>
        </>
      }
    >
      <div className="agent-says">{p.intro}</div>
      {p.questions.map((q, qi) => (
        <fieldset key={q.id} className="qa" disabled={done}>
          <legend>
            {qi + 1}. {q.text}
          </legend>
          <div className="qa-opts">
            {q.options.map((o, i) => (
              <button key={o} type="button" className={`qa-opt${answers[q.id] === i ? " on" : ""}`} aria-pressed={answers[q.id] === i} onClick={() => setAnswers({ ...answers, [q.id]: i })}>
                {o}
                {i === q.recommended && <span className="qa-rec">推荐</span>}
              </button>
            ))}
          </div>
        </fieldset>
      ))}
    </CardShell>
  );
}

export function ProgressCard({ view, payload: p, act }: CardProps<ProgressPayload>) {
  return (
    <CardShell view={view} title={`${p.task} · ${p.stage}`} actions={<Btn onClick={() => act("ack")}>知道了</Btn>}>
      <ul className="plain-list">
        {p.done.map((d) => (
          <li key={d} className="sys-line">
            {d}
          </li>
        ))}
      </ul>
      <div className="muted">
        下一步：{p.next} · 已用 {tokensLabel(p.tokens)} token
      </div>
    </CardShell>
  );
}

export function QuickActionCard({ view, payload: p, act }: CardProps<QuickActionPayload>) {
  return (
    <CardShell
      view={view}
      title={`${p.action}：${p.target}`}
      actions={
        <>
          <Btn onClick={() => act("cancel")}>取消</Btn>
          <Btn kind="primary" onClick={() => act("execute")}>
            执行
          </Btn>
        </>
      }
    >
      {p.detail && <div className="muted">{p.detail}</div>}
      {p.explicit ? <div className="muted">你这一句话里明确说了对象和内容，直接执行，不再确认。</div> : <div className="muted">这是秘书推断的，你确认了才执行。</div>}
    </CardShell>
  );
}

export function SuggestTaskCard({ view, payload: p, act }: CardProps<SuggestTaskPayload>) {
  return (
    <CardShell
      view={view}
      title={p.title}
      actions={
        <>
          <Btn onClick={() => act("dismiss")}>不用了</Btn>
          <Btn kind="primary" onClick={() => act("start_task")}>
            发起任务
          </Btn>
        </>
      }
    >
      <div className="agent-says">{p.why}</div>
    </CardShell>
  );
}

export function SuggestProjectCard({ view, payload: p, act }: CardProps<SuggestProjectPayload>) {
  return (
    <CardShell
      view={view}
      title={p.name}
      actions={
        <>
          <Btn onClick={() => act("dismiss")}>不用了</Btn>
          <Btn kind="primary" onClick={() => act("kickoff")}>
            立项
          </Btn>
        </>
      }
    >
      <div className="sp-goal">{p.goal}</div>
      <div className="muted">点"立项"后项目立刻诞生（筹备中），维护者随之产生，和你做立项问答。</div>
    </CardShell>
  );
}

export function ReminderCard({ view, payload: p, done, act }: CardProps<ReminderPayload>) {
  const [repeat, setRepeat] = useState<RepeatRule>(p.repeat);
  return (
    <CardShell
      view={view}
      title={p.text}
      actions={
        <>
          <Btn onClick={() => act("cancel_reminder")}>取消提醒</Btn>
          <Btn kind="primary" onClick={() => act("save", repeatLabel(repeat))}>
            就这样
          </Btn>
        </>
      }
    >
      <div>
        下次：<b>{timeLabel(p.time)}</b>
      </div>
      <RepeatEditor value={repeat} onChange={setRepeat} disabled={done} />
    </CardShell>
  );
}

/** 重复规则：一次性、每天、每周几、每月几号、按我的工作日 */
export function RepeatEditor({ value, onChange, disabled }: { value: RepeatRule; onChange(r: RepeatRule): void; disabled?: boolean }) {
  return (
    <fieldset className="repeat" disabled={disabled}>
      <label className="repeat-row">
        <span>重复</span>
        <select
          className="input"
          value={value.kind}
          onChange={(e) => {
            const k = e.target.value as RepeatRule["kind"];
            onChange(k === "weekly" ? { kind: k, weekdays: [1] } : k === "monthly" ? { kind: k, days: [1] } : { kind: k });
          }}
        >
          <option value="once">一次性</option>
          <option value="daily">每天</option>
          <option value="weekly">每周几</option>
          <option value="monthly">每月几号</option>
          <option value="workdays">按我的工作日</option>
        </select>
      </label>
      {value.kind === "weekly" && (
        <div className="day-picks">
          {[1, 2, 3, 4, 5, 6, 0].map((d) => {
            const on = value.weekdays.includes(d);
            return (
              <button
                key={d}
                type="button"
                className={`day-pick${on ? " on" : ""}`}
                aria-pressed={on}
                onClick={() => {
                  const next = on ? value.weekdays.filter((x) => x !== d) : [...value.weekdays, d].toSorted();
                  if (next.length) onChange({ kind: "weekly", weekdays: next });
                }}
              >
                {weekdayLabel(d).slice(1)}
              </button>
            );
          })}
        </div>
      )}
      {value.kind === "monthly" && (
        <label className="repeat-row">
          <span>几号</span>
          <input
            className="input"
            defaultValue={value.days.join(", ")}
            placeholder="比如 1, 15"
            onChange={(e) => {
              const days = e.target.value
                .split(/[,，\s]+/)
                .map(Number)
                .filter((n) => n >= 1 && n <= 31);
              if (days.length) onChange({ kind: "monthly", days });
            }}
          />
        </label>
      )}
      {value.kind === "workdays" && <div className="muted">按设置里的工作日历：新加坡或国内任一上班就算上班，加上你的额外规则和手动标记。</div>}
      <div className="muted">现在：{repeatLabel(value)}</div>
    </fieldset>
  );
}

export function CharterCard({ view, payload: p, act }: CardProps<CharterPayload>) {
  return (
    <CardShell
      view={view}
      title={p.project}
      actions={
        <>
          <Btn onClick={() => act("confirm_later")}>只确认，稍后开工</Btn>
          <Btn kind="primary" onClick={() => act("confirm_start")}>
            确认并开工
          </Btn>
        </>
      }
    >
      <dl className="kv">
        <dt>类型</dt>
        <dd>{p.kind === "dev" ? "开发类" : "其他"}</dd>
        <dt>目标</dt>
        <dd>{p.goal}</dd>
        <dt>范围</dt>
        <dd>
          <ul className="plain-list">
            {p.scope.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </dd>
        <dt>首版</dt>
        <dd>{p.firstVersion}</dd>
        <dt>工作目录</dt>
        <dd>{p.workdir}</dd>
        <dt>工具包</dt>
        <dd>{toolkitLabel(p.toolkit)}</dd>
      </dl>
    </CardShell>
  );
}

export function WorkOrderCard({ view, payload: p, act }: CardProps<WorkOrderPayload>) {
  return (
    <CardShell
      view={view}
      title={`${p.id} → ${p.project}`}
      tag={<span className="chip chip-op">计划外工单</span>}
      actions={
        <>
          <Btn onClick={() => act("return")}>退回</Btn>
          <Btn kind="primary" onClick={() => act("dispatch")}>
            确认派出
          </Btn>
        </>
      }
    >
      <div>
        <b>{p.title}</b>
      </div>
      <div className="muted">来自{p.from}</div>
      <div className="muted">验收：{p.acceptance.join("；")}</div>
    </CardShell>
  );
}

export function PlanChangeCard({ view, payload: p, act }: CardProps<PlanChangePayload>) {
  return (
    <CardShell
      view={view}
      title={p.summary}
      tag={p.kind === "toolkit" ? <span className="chip chip-data">工具包变更</span> : undefined}
      actions={
        <>
          <Btn onClick={() => act("deny")}>拒绝</Btn>
          <Btn kind="primary" onClick={() => act("approve")}>
            批准
          </Btn>
        </>
      }
    >
      <div className="muted">任务「{p.task}」</div>
      <div className="diff">
        <div className="diff-before">
          <span>原来</span>
          {p.before}
        </div>
        <div className="diff-after">
          <span>改成</span>
          {p.after}
        </div>
      </div>
      <div className="muted">只有这些阶段停下来等：{p.affectedStages.join("、")}；其余照常推进。</div>
      <div className="agent-says">{p.reason}</div>
    </CardShell>
  );
}

export function ParallelCard({ view, payload: p, act }: CardProps<ParallelPayload>) {
  return (
    <CardShell
      view={view}
      title={p.stage}
      actions={
        <>
          <Btn onClick={() => act("sequential")}>不并行，按顺序做</Btn>
          <Btn kind="primary" onClick={() => act("parallel")}>
            同意并行
          </Btn>
        </>
      }
    >
      <ul className="plain-list">
        {p.subagents.map((s) => (
          <li key={s.name}>
            <b>{s.name}</b>：{s.work}
          </li>
        ))}
      </ul>
      <div className="muted">子 agent 权限不超过维护者，不能写项目档案，不占执行名额；结果回到维护者的会话。</div>
    </CardShell>
  );
}

const DELETE_MODES = {
  forget: { label: "忘掉", note: "从素材库删掉；聊天记录里仍看得到原话。" },
  purge: { label: "彻底删除", note: "连会话原文一起删，原文改写成删除标记，不可恢复。" },
  no_infer: { label: "别推断", note: "素材保留，但不参与推断。" },
} as const;

export function MemoryDeleteCard({ view, payload: p, done, act }: CardProps<MemoryDeletePayload>) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(p.matches.map((m) => m.id)));
  const [mode, setMode] = useState<keyof typeof DELETE_MODES>("forget");
  return (
    <CardShell
      view={view}
      title={p.command}
      actions={
        <>
          <Btn onClick={() => act("cancel")}>不删了</Btn>
          <Btn kind={mode === "purge" ? "danger" : "primary"} disabled={picked.size === 0} onClick={() => act("delete", `${DELETE_MODES[mode].label} ${picked.size} 条`)}>
            {DELETE_MODES[mode].label}这 {picked.size} 条
          </Btn>
        </>
      }
    >
      <fieldset className="md-list" disabled={done}>
        {p.matches.map((m) => (
          <label key={m.id} className="check-row">
            <input
              type="checkbox"
              checked={picked.has(m.id)}
              onChange={() => {
                const next = new Set(picked);
                if (next.has(m.id)) next.delete(m.id);
                else next.add(m.id);
                setPicked(next);
              }}
            />
            <span>
              {m.text}
              <span className="muted">
                {" "}
                · {m.source} · {timeLabel(m.at)}
              </span>
            </span>
          </label>
        ))}
        <label className="repeat-row">
          <span>删法</span>
          <select className="input" value={mode} onChange={(e) => setMode(e.target.value as keyof typeof DELETE_MODES)}>
            {Object.entries(DELETE_MODES).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
        <div className="muted">{DELETE_MODES[mode].note}</div>
      </fieldset>
    </CardShell>
  );
}

export function codeLabel(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

export function fingerprintLabel(fp: string): string {
  return `${fp.slice(0, 4)} ${fp.slice(4)}`;
}

export function PairingCard({ view, payload: p, act }: CardProps<PairingPayload>) {
  return (
    <CardShell
      view={view}
      title={p.deviceName}
      actions={
        <>
          <Btn onClick={() => act("deny")}>拒绝</Btn>
          <Btn kind="primary" onClick={() => (window.location.hash = toHash({ tab: "pair-approve", cardId: view.card.id }))}>
            核对并批准
          </Btn>
        </>
      }
    >
      <div className="pair-codes">
        <div>
          <span className="muted">短码</span>
          <b className="mono">{codeLabel(p.shortCode)}</b>
        </div>
        <div>
          <span className="muted">短指纹</span>
          <b className="mono">{fingerprintLabel(p.fingerprint)}</b>
        </div>
      </div>
      <div className="muted">
        {p.from} · {timeLabel(p.expiresAt)} 过期
      </div>
    </CardShell>
  );
}
