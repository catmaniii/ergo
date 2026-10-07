// 除计划确认卡以外的 13 种卡片。负载形状见 model/cards.ts。
import { type ReactNode, useState } from "react";
import { toHash } from "../../app/route.ts";
import {
  type ApprovalPayload,
  type CharterPayload,
  type MemoryDeletePayload,
  type PairingPayload,
  type ParallelPayload,
  PLAN_CHANGE_KIND_LABEL,
  type PlanChangePayload,
  type ProgressPayload,
  type QuestionsPayload,
  type QuickActionPayload,
  type SuggestProjectPayload,
  type SuggestTaskPayload,
  type WorkOrderPayload,
} from "../../model/cards.ts";
import { MONDAY_FIRST, tokensLabel, weekdayLabel } from "../../model/labels.ts";
import { nowIso, timeLabel } from "../../util/time.ts";
import type { Toolkit } from "../../model/types.ts";
import {
  describeSchedule,
  isRepeating,
  nextOccurrence,
  REPEAT_KIND_LABEL,
  REPEAT_KINDS,
  type ReminderCardPayload,
  type ReminderEditInput,
  type ReminderSchedule,
  type RepeatKind,
  type RepeatRule,
  repeatRuleOf,
  repeatSchedule,
  scheduleClockTime,
} from "../../state/index.ts";
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

export function ApprovalCard({ state, payload: p, act }: CardProps<ApprovalPayload>) {
  return (
    <CardShell
      state={state}
      title={p.source}
      actions={
        <>
          <Btn onClick={() => act("deny")}>拒绝</Btn>
          <Btn kind="primary" onClick={() => act("approve")}>
            批准这一次
          </Btn>
        </>
      }
    >
      <div className="tool-line">
        <b>{p.toolTitle}</b> <code>{p.argsSummary}</code>
      </div>
      <div className="chips">
        {p.categoryTitles.map((c) => (
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

export function QuestionsCard({ state, payload: p, done, act }: CardProps<QuestionsPayload>) {
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const all = p.questions.every((q) => answers[q.id] !== undefined);
  const note = () => p.questions.map((q) => `${q.text.replace(/？$/, "")}：${q.options[answers[q.id]!]}`).join("；");
  return (
    <CardShell
      state={state}
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

export function ProgressCard({ state, payload: p, act }: CardProps<ProgressPayload>) {
  return (
    <CardShell state={state} title={`${p.task} · ${p.stage}`} actions={<Btn onClick={() => act("ack")}>知道了</Btn>}>
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

export function QuickActionCard({ state, payload: p, act }: CardProps<QuickActionPayload>) {
  return (
    <CardShell
      state={state}
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

export function SuggestTaskCard({ state, payload: p, act }: CardProps<SuggestTaskPayload>) {
  return (
    <CardShell
      state={state}
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

export function SuggestProjectCard({ state, payload: p, act }: CardProps<SuggestProjectPayload>) {
  return (
    <CardShell
      state={state}
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

/**
 * 简单提醒卡：时间或重复规则和内容，可以"改"（新的时间或重复规则，动作 save 带输入）和"取消提醒"。
 * 一次性的到点后卡片变成已触发（不能再改）；重复的到点后仍可以改，显示下一次的时间。
 * 时间的写法、钟点、换规则都用共享协议包的 reminder-schedule.ts，这里不按规则种类分支。
 */
export function ReminderCard({ state, payload: p, done, act }: CardProps<ReminderCardPayload>) {
  // 正在改的草稿；卡片有了新版本（别处改了、到点了）草稿就作废
  const [edit, setEdit] = useState<{ version: number; schedule: ReminderSchedule }>();
  const editing = edit?.version === state.card.version;
  const doneLabel = p.status === "fired" ? `已触发${p.lastFiredAt ? ` · ${timeLabel(p.lastFiredAt)}` : ""}` : undefined;
  const repeating = isRepeating(p.schedule);
  return (
    <CardShell
      state={state}
      title={p.text}
      doneLabel={doneLabel}
      actions={
        editing ? (
          <>
            <Btn onClick={() => setEdit(undefined)}>不改了</Btn>
            <Btn kind="primary" onClick={() => act("save", undefined, { schedule: edit.schedule } satisfies ReminderEditInput)}>
              保存
            </Btn>
          </>
        ) : (
          <>
            <Btn onClick={() => act("cancel_reminder")}>取消提醒</Btn>
            <Btn kind="primary" onClick={() => setEdit({ version: state.card.version, schedule: p.schedule })}>
              改
            </Btn>
          </>
        )
      }
    >
      <div>
        <b>{describeSchedule(p.schedule)}</b>
      </div>
      {repeating && p.nextAt && p.status === "pending" && <div className="muted">下一次：{timeLabel(p.nextAt)}</div>}
      {repeating && p.lastFiredAt && <div className="muted">上一次：{timeLabel(p.lastFiredAt)}</div>}
      {editing && !done && <ScheduleEditor value={edit.schedule} onChange={(schedule) => setEdit({ version: state.card.version, schedule })} />}
    </CardShell>
  );
}

/** datetime-local 输入框的值（本地时间，到分钟） */
function localInputValue(iso: string): string {
  return nowIso(new Date(iso)).slice(0, 16);
}

/** 换成一次性：这个钟点下一次出现的那一刻（今天没到就是今天，过了就是明天） */
function onceAt(time: string): ReminderSchedule {
  const at = nextOccurrence({ kind: "daily", time }, new Date());
  return { kind: "once", at: nowIso(at ?? new Date()) };
}

/** 改提醒的时间：一次性（哪天几点），或者几点加重复规则（种类和名字取自 REPEAT_KINDS；"按我的工作日"在 29 号票加进去） */
export function ScheduleEditor({ value, onChange }: { value: ReminderSchedule; onChange(s: ReminderSchedule): void }) {
  const time = scheduleClockTime(value);
  const rule = repeatRuleOf(value);
  /** 换重复规则或钟点；规则不全（比如周几全取消了）就不换 */
  const setRepeat = (next: RepeatRule, t: string) => {
    const result = repeatSchedule(next, t);
    if ("schedule" in result) onChange(result.schedule);
  };
  return (
    <fieldset className="repeat">
      <label className="repeat-row">
        <span>重复</span>
        <select
          className="input"
          value={rule?.kind ?? "once"}
          onChange={(e) => {
            const kind = e.target.value as RepeatKind | "once";
            if (kind === "once") onChange(onceAt(time));
            else setRepeat({ kind, weekdays: rule?.weekdays ?? [1], days: rule?.days ?? [1] }, time);
          }}
        >
          <option value="once">一次性</option>
          {REPEAT_KINDS.map((k) => (
            <option key={k} value={k}>
              {REPEAT_KIND_LABEL[k]}
            </option>
          ))}
        </select>
      </label>
      {value.kind === "once" ? (
        <label className="repeat-row">
          <span>时间</span>
          <input
            className="input"
            type="datetime-local"
            value={localInputValue(value.at)}
            onChange={(e) => {
              const at = new Date(e.target.value);
              if (!Number.isNaN(at.getTime())) onChange({ kind: "once", at: nowIso(at) });
            }}
          />
        </label>
      ) : (
        <label className="repeat-row">
          <span>几点</span>
          <input className="input" type="time" value={time} onChange={(e) => e.target.value && rule && setRepeat(rule, e.target.value)} />
        </label>
      )}
      {rule?.kind === "weekly" && (
        <div className="day-picks">
          {MONDAY_FIRST.map((d) => {
            const weekdays = rule.weekdays ?? [];
            const on = weekdays.includes(d);
            return (
              <button
                key={d}
                type="button"
                className={`day-pick${on ? " on" : ""}`}
                aria-pressed={on}
                onClick={() => setRepeat({ kind: "weekly", weekdays: on ? weekdays.filter((x) => x !== d) : [...weekdays, d] }, time)}
              >
                {weekdayLabel(d, true)}
              </button>
            );
          })}
        </div>
      )}
      {rule?.kind === "monthly" && (
        <label className="repeat-row">
          <span>几号</span>
          <input
            className="input"
            defaultValue={(rule.days ?? []).join(", ")}
            placeholder="比如 1, 15"
            onChange={(e) =>
              setRepeat(
                {
                  kind: "monthly",
                  days: e.target.value
                    .split(/[,，\s]+/)
                    .map(Number)
                    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 31),
                },
                time,
              )
            }
          />
        </label>
      )}
      <div className="muted">改成：{describeSchedule(value)}</div>
    </fieldset>
  );
}

export function CharterCard({ state, payload: p, act }: CardProps<CharterPayload>) {
  return (
    <CardShell
      state={state}
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

export function WorkOrderCard({ state, payload: p, act }: CardProps<WorkOrderPayload>) {
  return (
    <CardShell
      state={state}
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

export function PlanChangeCard({ state, payload: p, act }: CardProps<PlanChangePayload>) {
  // 工具包变更是计划变更的一种：维护者不在任务里时要加能力才用它，类型标签直接写"工具包变更"
  const toolkit = p.kind === "toolkit";
  return (
    <CardShell
      state={state}
      label={toolkit ? PLAN_CHANGE_KIND_LABEL.toolkit : undefined}
      title={p.summary}
      tag={toolkit ? undefined : <span className="chip chip-data">{PLAN_CHANGE_KIND_LABEL[p.kind]}</span>}
      actions={
        <>
          <Btn onClick={() => act("deny")}>拒绝</Btn>
          <Btn kind="primary" onClick={() => act("approve")}>
            批准
          </Btn>
        </>
      }
    >
      <div className="muted">{p.scope}</div>
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
      {toolkit ? (
        <div className="muted">批准后等它做完手头这一步，按新工具包重启子进程，接着干。</div>
      ) : (
        <div className="muted">只有这些阶段停下来等：{p.affectedStages.join("、")}；其余照常推进。</div>
      )}
      <div className="agent-says">{p.reason}</div>
    </CardShell>
  );
}

export function ParallelCard({ state, payload: p, act }: CardProps<ParallelPayload>) {
  return (
    <CardShell
      state={state}
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

export function MemoryDeleteCard({ state, payload: p, done, act }: CardProps<MemoryDeletePayload>) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(p.matches.map((m) => m.id)));
  const [mode, setMode] = useState<keyof typeof DELETE_MODES>("forget");
  return (
    <CardShell
      state={state}
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

export function PairingCard({ state, payload: p, act }: CardProps<PairingPayload>) {
  return (
    <CardShell
      state={state}
      title={p.deviceName}
      actions={
        <>
          <Btn onClick={() => act("deny")}>拒绝</Btn>
          <Btn kind="primary" onClick={() => (window.location.hash = toHash({ tab: "pair-approve", cardId: state.card.id }))}>
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
