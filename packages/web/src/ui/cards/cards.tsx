// 除计划确认卡以外的 13 种卡片。负载形状见 model/cards.ts。
import { type ReactNode, useState } from "react";
import { toHash } from "../../app/route.ts";
import {
  type ApprovalPayload,
  type CharterPayload,
  type PairingPayload,
  type ParallelPayload,
  PLAN_CHANGE_KIND_LABEL,
  type PlanChangePayload,
  type ProgressPayload,
  type QuestionsPayload,
  type SuggestProjectPayload,
  type SuggestTaskPayload,
  type WorkOrderPayload,
} from "../../model/cards.ts";
import { conversationLabel, DISPOSITION_LABEL, MONDAY_FIRST, weekdayLabel } from "../../model/labels.ts";
import { nowIso, timeLabel } from "../../util/time.ts";
import type { Toolkit } from "../../model/types.ts";
import {
  ACCEPTANCE_VERDICT_LABEL,
  describeSchedule,
  isRepeating,
  MEMORY_COMMAND_LABEL,
  MEMORY_DELETE_MODE_INFO,
  MEMORY_DELETE_MODES,
  type MemoryDeleteCardPayload,
  type MemoryDeleteInput,
  type MemoryDeleteMode,
  nextClockTime,
  CHARTER_DECISION_LABEL,
  PROJECT_KIND_LABEL,
  PURGED_TEXT,
  type QuickActionCardPayload,
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

/**
 * 提问卡（12 号票）：成批提问，每题带推荐答案。点选项、或者自己写；"全按推荐"一次提交全部答案（每题都取推荐的）。
 * 回答过的卡上显示每题的答案。
 */
export function QuestionsCard({ state, payload: p, done, act }: CardProps<QuestionsPayload>) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const all = p.questions.every((q) => answers[q.id]?.trim());
  const given = Object.fromEntries((p.answers ?? []).map((a) => [a.questionId, a.answer]));
  const submit = (chosen: Record<string, string>) => act("answer", undefined, { answers: p.questions.map((q) => ({ questionId: q.id, answer: chosen[q.id]!.trim() })) });
  return (
    <CardShell
      state={state}
      title={`${p.questions.length} 个问题`}
      actions={
        <>
          <Btn onClick={() => submit(Object.fromEntries(p.questions.map((q) => [q.id, q.recommended])))}>全按推荐</Btn>
          <Btn kind="primary" disabled={!all} onClick={() => submit(answers)}>
            提交回答
          </Btn>
        </>
      }
    >
      {p.intro && <div className="agent-says">{p.intro}</div>}
      {p.questions.map((q, qi) => {
        // 推荐的答案不在选项里时也给一个按钮
        const options = q.options.includes(q.recommended) ? q.options : [q.recommended, ...q.options];
        const answer = done ? given[q.id] : answers[q.id];
        return (
          <fieldset key={q.id} className="qa" disabled={done}>
            <legend>
              {qi + 1}. {q.question}
            </legend>
            {q.why && <div className="muted">{q.why}</div>}
            <div className="qa-opts">
              {options.map((o) => (
                <button key={o} type="button" className={`qa-opt${answer === o ? " on" : ""}`} aria-pressed={answer === o} onClick={() => setAnswers({ ...answers, [q.id]: o })}>
                  {o}
                  {o === q.recommended && <span className="qa-rec">推荐</span>}
                </button>
              ))}
            </div>
            {done ? (
              answer !== undefined && !options.includes(answer) && <div className="muted">你写的：{answer}</div>
            ) : (
              <input
                className="input"
                value={answer !== undefined && !options.includes(answer) ? answer : ""}
                onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
                placeholder="都不合适？自己写"
                aria-label={`自己写第 ${qi + 1} 题的答案`}
              />
            )}
          </fieldset>
        );
      })}
    </CardShell>
  );
}

/**
 * 进度卡（13 号票）：所属任务、第 N/M 阶段；维护者报告的进展，或者一个阶段的验收结论——每条标准的方式和结果，
 * 谁判的（评审方式的标"评审判定"）。只是告诉你，唯一的动作是"知道了"
 */
export function ProgressCard({ state, payload: p, act }: CardProps<ProgressPayload>) {
  const verdict = p.kind === "acceptance" ? p.acceptance : undefined;
  return (
    <CardShell state={state} title={`${p.taskTitle} · 第 ${p.stageIndex}/${p.stageTotal} 阶段「${p.stageTitle}」`} actions={<Btn onClick={() => act("ack")}>知道了</Btn>}>
      {verdict && (
        <div>
          <span className={verdict.passed ? "chip chip-ok" : "chip chip-no"}>{verdict.passed ? "验收通过" : "验收没通过"}</span> <span className="muted">{ACCEPTANCE_VERDICT_LABEL[verdict.judgedBy]}</span>
          <ul className="plain-list">
            {verdict.results.map((r) => (
              <li key={`${r.method}:${r.criterion}`} className={r.passed ? "sys-line" : undefined}>
                {r.passed ? "✓" : "✕"} {r.criterion}
                <span className="muted">（{ACCEPTANCE_VERDICT_LABEL[r.method]}）</span>
                {r.note && <div className="muted">{r.note}</div>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>{p.text}</div>
    </CardShell>
  );
}

/**
 * 快速动作卡（21 号票）：规范化后的动作（对谁做、做什么）。你这一句话里点明了对象和内容的，出来就是"已执行"；
 * 秘书推断出来、要先问的，带"执行"和"取消"。执行之后写上结果。
 */
export function QuickActionCard({ state, payload: p, act }: CardProps<QuickActionCardPayload>) {
  return (
    <CardShell
      state={state}
      title={p.title}
      doneLabel={state.card.status === "handled" && p.result ? `已执行：${p.result}` : undefined}
      actions={
        <>
          <Btn onClick={() => act("cancel")}>取消</Btn>
          <Btn kind="primary" onClick={() => act("execute")}>
            执行
          </Btn>
        </>
      }
    >
      {p.target && (
        <div>
          <span className="muted">对象：</span>
          {p.target}
        </div>
      )}
      {p.content && (
        <div>
          <span className="muted">内容：</span>
          {p.content}
        </div>
      )}
      {p.explicit ? (
        <div className="muted">你这一句话里点明了对象和内容，直接执行，不再确认。</div>
      ) : (
        <>
          {p.categories.length > 0 && (
            <div className="chips">
              {p.categories.map((c) => (
                <span key={c} className="chip chip-op">
                  {c}
                </span>
              ))}
              <span className="chip">{DISPOSITION_LABEL[p.disposition]}</span>
            </div>
          )}
          <div className="muted">{state.card.status === "pending" ? "这是秘书推断的，你确认了才执行。" : "这是秘书推断的。"}</div>
        </>
      )}
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
      {p.taskId && (
        <a className="link" href={toHash({ tab: "tasks", taskId: p.taskId })}>
          去看任务 {p.taskId} ▸
        </a>
      )}
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
      {p.projectId ? (
        <a className="link" href={toHash({ tab: "projects", projectId: p.projectId, chat: true })}>
          和维护者做立项问答 ▸
        </a>
      ) : (
        <div className="muted">点"立项"后项目立刻诞生（筹备中），维护者随之产生，和你做立项问答。</div>
      )}
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
  return { kind: "once", at: nowIso(nextClockTime(time, new Date())) };
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

/**
 * 立项书卡：由维护者交出的结构化立项书生成。项目类型、外部工作目录绑定和工具包在确认时就生效（两个按钮都是）；
 * "确认并开工"同时建出首个建设任务，"只确认，稍后开工"项目留在筹备中
 */
export function CharterCard({ state, payload: p, act }: CardProps<CharterPayload>) {
  const { charter } = p;
  return (
    <CardShell
      state={state}
      title={`${p.projectName}${p.revision > 1 ? `（第 ${p.revision} 版）` : ""}`}
      actions={
        <>
          <Btn onClick={() => act("confirm_later")}>{CHARTER_DECISION_LABEL.later}</Btn>
          <Btn kind="primary" onClick={() => act("confirm_start")}>
            {CHARTER_DECISION_LABEL.start}
          </Btn>
        </>
      }
    >
      <dl className="kv">
        <dt>类型</dt>
        <dd>{PROJECT_KIND_LABEL[charter.kind]}</dd>
        <dt>目标</dt>
        <dd>{charter.goal}</dd>
        <dt>范围</dt>
        <dd>
          <ul className="plain-list">
            {charter.scope.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </dd>
        <dt>首版</dt>
        <dd>{charter.firstVersion}</dd>
        <dt>工作目录</dt>
        <dd>{charter.bindExternal ? `绑定外部路径：${charter.externalPath ?? ""}（不随二狗备份，靠项目自己的 git 远端）` : "项目档案里（默认）"}</dd>
        <dt>工具包</dt>
        <dd>{toolkitLabel({ skills: p.toolkit.skills, mcps: p.toolkit.mcp, bash: p.toolkit.bash, network: p.toolkit.network })}</dd>
      </dl>
      <div className="muted">确认之后项目类型、工作目录和工具包就生效；“{CHARTER_DECISION_LABEL.start}”同时发起首个建设任务。</div>
      {p.confirmed?.buildTaskId && (
        <a className="link" href={toHash({ tab: "tasks", taskId: p.confirmed.buildTaskId })}>
          去看首个建设任务 {p.confirmed.buildTaskId} ▸
        </a>
      )}
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

/**
 * 记忆删除卡（21 号票）：秘书检索出的匹配素材和要执行的删法；你核对后（可以去掉几条、换一种删法）确认才执行。
 * 彻底删除之后，卡上的摘录也去掉了。
 */
export function MemoryDeleteCard({ state, payload: p, done, act }: CardProps<MemoryDeleteCardPayload>) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(p.matches.map((m) => m.materialId)));
  const [mode, setMode] = useState<MemoryDeleteMode>(p.mode);
  const label = MEMORY_COMMAND_LABEL[mode];
  const chosen = p.matches.filter((m) => picked.has(m.materialId)).map((m) => m.materialId);
  return (
    <CardShell
      state={state}
      title={`${MEMORY_COMMAND_LABEL[p.mode]}：核对匹配到的 ${p.matches.length} 条素材`}
      doneLabel={p.result ? `已${MEMORY_COMMAND_LABEL[p.result.mode]} ${p.result.count} 条素材` : undefined}
      actions={
        <>
          <Btn onClick={() => act("cancel")}>不删了</Btn>
          <Btn kind={mode === "purge" ? "danger" : "primary"} disabled={chosen.length === 0} onClick={() => act("delete", undefined, { mode, materialIds: chosen } satisfies MemoryDeleteInput)}>
            {label}这 {chosen.length} 条
          </Btn>
        </>
      }
    >
      <fieldset className="md-list" disabled={done}>
        {p.matches.map((m) => (
          <label key={m.materialId} className="check-row">
            <input
              type="checkbox"
              checked={picked.has(m.materialId)}
              onChange={() => {
                const next = new Set(picked);
                if (next.has(m.materialId)) next.delete(m.materialId);
                else next.add(m.materialId);
                setPicked(next);
              }}
            />
            <span>
              {m.purged ? <span className="muted">{PURGED_TEXT}</span> : m.excerpt}
              <span className="muted">
                {" "}
                · {m.kind}
                {m.conversation ? ` · ${conversationLabel(m.conversation)}` : ""} · {timeLabel(m.time)}
              </span>
            </span>
          </label>
        ))}
        {!done && (
          <>
            <label className="repeat-row">
              <span>删法</span>
              <select className="input" value={mode} onChange={(e) => setMode(e.target.value as MemoryDeleteMode)}>
                {MEMORY_DELETE_MODES.map((k) => (
                  <option key={k} value={k}>
                    {MEMORY_COMMAND_LABEL[k]}
                  </option>
                ))}
              </select>
            </label>
            <div className="muted">{MEMORY_DELETE_MODE_INFO[mode].note}</div>
          </>
        )}
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
