// 除计划确认卡、计划变更卡以外的 13 种卡片。负载形状见 model/cards.ts。
import { type ReactNode, useState } from "react";
import { toHash } from "../../app/route.ts";
import {
  type ApprovalPayload,
  CARD_ACTION_LABEL,
  type CharterPayload,
  type PairingPayload,
  type ParallelPayload,
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
  jobTriggerText,
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
  quickActionFieldLabels,
  REMINDER_STATUS_LABEL,
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
  type ToolkitChangeCardPayload,
  toolkitText,
  TASK_KIND_HINT,
  internalScopeLabel,
  TASK_KIND_LABEL,
  stageLabelIn,
  TELL_SECRETARY_LABEL,
  tellSecretaryOn,
} from "../../state/index.ts";
import { useStore } from "../../app/store.tsx";
import { AssistantName, NamedText } from "../assistant-name.tsx";
import { type CardProps, CardShell } from "./CardShell.tsx";

export function toolkitLabel(t: Toolkit): string {
  return [
    `skill：${t.skills.length ? t.skills.join("、") : "无"}`,
    `MCP：${t.mcps.length ? t.mcps.join("、") : "无"}`,
    `bash：${t.bash ? "开" : "关"}`,
    `联网：${t.network ? "开" : "关"}`,
    // 给秘书发消息（102 号票）默认开着，只在关掉时写
    ...(tellSecretaryOn(t) ? [] : [`${TELL_SECRETARY_LABEL}：关`]),
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
      title={<NamedText text={p.source} />}
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
        {/* tool-title：经典不认，给视觉风格下样式（夜航仪表把工具名排成参数上面一行灰字，39 号票的规矩：补 class，不改结构） */}
        <b className="tool-title">{p.toolTitle}</b> <code>{p.argsSummary}</code>
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
 * 工具包变更卡（27 号票）：项目维护者不在任务里时要开 bash、加 MCP、开联网，提交它进待我处理。
 * 卡上的"工具包变更"一栏列出要加的能力；批准后加进项目的工具包、维护者按新工具包重新装配，拒绝则不变（可以附一句原因）
 */
export function ToolkitChangeCard({ state, payload: p, done, act }: CardProps<ToolkitChangeCardPayload>) {
  const [note, setNote] = useState("");
  const said = note.trim() ? note.trim() : undefined;
  return (
    <CardShell
      state={state}
      title={`项目「${p.projectName}」的维护者要加能力`}
      actions={
        <>
          <Btn onClick={() => act("deny", said)}>{CARD_ACTION_LABEL.deny}</Btn>
          <Btn kind="primary" onClick={() => act("approve", said)}>
            {CARD_ACTION_LABEL.approve}
          </Btn>
        </>
      }
    >
      <div className="sys-note">{p.why}</div>
      <div className="tool-line">
        <b>工具包变更</b>：加上 {p.additions.join("、")}
      </div>
      <div className="muted">提交时：{toolkitText(p.before)}</div>
      <div className="muted">
        {p.applied ? "批准后" : "批准后会是"}：{toolkitText(p.applied ?? p.after)}
      </div>
      {!done && <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="附一句话给维护者（可不写）" aria-label="附一句话给维护者" />}
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
  // 91 号票：第几阶段按依赖图的编号（并行的写 4a、4b，和计划图一致）；认不出这个阶段时用卡上带的编号（93 号票起），
  // 再之前的卡只有计划里的第几个 / 共几个
  const stage = stageLabelIn(useStore().ui, p.taskId, p.stageId, `第 ${p.stageCode ?? `${p.stageIndex}/${p.stageTotal}`} 阶段`);
  return (
    <CardShell state={state} title={`${p.taskTitle} · ${stage}「${p.stageTitle}」`} actions={<Btn onClick={() => act("ack")}>知道了</Btn>}>
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
  // 秘书转达（103 号票）写"发给""转达的话"，别的动作照旧"对象""内容"
  const labels = quickActionFieldLabels(p.action.type);
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
          <span className="muted">{labels.target}：</span>
          {p.target}
        </div>
      )}
      {p.content && (
        <div>
          <span className="muted">{labels.content}：</span>
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
          <div className="muted">
            这是<AssistantName />推断的{state.card.status === "pending" ? "，你确认了才执行。" : "。"}
          </div>
        </>
      )}
    </CardShell>
  );
}

/** "建议发起任务"卡（58 号票）：秘书觉得该发起、用户没点明的事；两个按钮"作为流程""作为长程任务"，点了哪个建哪种 */
export function SuggestTaskCard({ state, payload: p, act }: CardProps<SuggestTaskPayload>) {
  return (
    <CardShell
      state={state}
      title={p.title}
      actions={
        <>
          <Btn onClick={() => act("dismiss")}>不用了</Btn>
          <Btn onClick={() => act("start_workflow")}>作为{TASK_KIND_LABEL.workflow}</Btn>
          <Btn kind="primary" onClick={() => act("start_task")}>
            作为{TASK_KIND_LABEL.long_running}
          </Btn>
        </>
      }
    >
      <div className="agent-says">{p.why}</div>
      {p.projects && p.projects.length > 0 && <div className="muted">涉及的项目：{p.projects.join("、")}</div>}
      {/* 只写了一个项目（64 号票）：点了建成这个项目的内部任务 */}
      {p.projects?.length === 1 && !p.internal && <div className="muted">点了建在{internalScopeLabel(p.projects[0]!)}：由项目的维护者执行，只在项目里看得到</div>}
      {/* 项目的维护者给的建议卡（64 号票）：点了建出的是这个项目的内部任务 */}
      {p.internal && <div className="muted">建在{internalScopeLabel(p.internal.projectName)}：由项目的维护者起草、执行，只在项目里看得到</div>}
      {state.card.status === "pending" && (
        <div className="muted">
          {TASK_KIND_LABEL.workflow}：{TASK_KIND_HINT.workflow}。{TASK_KIND_LABEL.long_running}：{TASK_KIND_HINT.long_running}。
        </div>
      )}
      {p.taskId && (
        <a className="link" href={toHash({ tab: "tasks", taskId: p.taskId })}>
          去看{p.kind ? TASK_KIND_LABEL[p.kind] : "任务"} {p.taskId} ▸
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
  const doneLabel = p.status === "fired" ? `${REMINDER_STATUS_LABEL.fired}${p.lastFiredAt ? ` · ${timeLabel(p.lastFiredAt)}` : ""}` : undefined;
  // 事件发生时提醒的（77 号票）：没有时间表，卡上写在等什么事件，不能改时间（要按时间提醒就取消了另建）
  if (!p.schedule) {
    return (
      <CardShell state={state} title={p.text} doneLabel={doneLabel} actions={<Btn onClick={() => act("cancel_reminder")}>取消提醒</Btn>}>
        <div>
          <b>{jobTriggerText(p)}</b>
        </div>
        {p.lastFiredAt && <div className="muted">上一次：{timeLabel(p.lastFiredAt)}</div>}
      </CardShell>
    );
  }
  const schedule = p.schedule;
  const repeating = isRepeating(schedule);
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
            <Btn kind="primary" onClick={() => setEdit({ version: state.card.version, schedule })}>
              改
            </Btn>
          </>
        )
      }
    >
      <div>
        <b>{describeSchedule(schedule)}</b>
      </div>
      {repeating && p.nextAt && p.status === "pending" && <div className="muted">下一次：{timeLabel(p.nextAt)}</div>}
      {repeating && p.lastFiredAt && <div className="muted">上一次：{timeLabel(p.lastFiredAt)}</div>}
      {editing && !done && <ScheduleEditor value={edit.schedule} onChange={(next) => setEdit({ version: state.card.version, schedule: next })} />}
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

/**
 * 改提醒的时间：一次性（哪天几点），或者几点加重复规则（种类和名字取自 REPEAT_KINDS；"按我的工作日"在 29 号票加进去）。
 * repeatOnly（76 号票）：发起对话框里"定时"的时间表只能是重复的（一次性的提醒用"只提醒我"），没有"一次性"这一项；
 * label 换掉最后那行的前缀（默认"改成："）
 */
export function ScheduleEditor({
  value,
  onChange,
  repeatOnly,
  onceOnly,
  label = "改成：",
}: {
  value: ReminderSchedule;
  onChange(s: ReminderSchedule): void;
  repeatOnly?: boolean;
  /** 只选某个时间（日期和时间），不选重复（发起对话框里"定时 · 某个时间做一次"，76 号票） */
  onceOnly?: boolean;
  label?: string;
}) {
  const time = scheduleClockTime(value);
  const rule = repeatRuleOf(value);
  /** 换重复规则或钟点；规则不全（比如周几全取消了）就不换 */
  const setRepeat = (next: RepeatRule, t: string) => {
    const result = repeatSchedule(next, t);
    if ("schedule" in result) onChange(result.schedule);
  };
  return (
    <fieldset className="repeat">
      {!onceOnly && (
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
            {!repeatOnly && <option value="once">一次性</option>}
            {REPEAT_KINDS.map((k) => (
              <option key={k} value={k}>
                {REPEAT_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
      )}
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
      <div className="muted">
        {label}
        {describeSchedule(value)}
      </div>
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

/**
 * 工单卡（17 号票）：涉及多个项目的任务的维护者执行中派出计划外的工单，命中"计划外工单"类别，工单待你确认。
 * "确认派出"之后才进项目维护者的队列，"拒绝"则不派（任务维护者会收到）
 */
export function WorkOrderCard({ state, payload: p, act }: CardProps<WorkOrderPayload>) {
  return (
    <CardShell
      state={state}
      title={`${p.workOrderId} → ${p.projectName}`}
      tag={<span className="chip chip-op">计划外工单</span>}
      actions={
        <>
          <Btn onClick={() => act("deny")}>拒绝</Btn>
          <Btn kind="primary" onClick={() => act("dispatch")}>
            {WORK_ORDER_CARD_ACTION_LABEL.dispatch}
          </Btn>
        </>
      }
    >
      <div>
        <b>{p.title}</b>
      </div>
      <div className="muted">
        来自任务
        <a className="link" href={toHash({ tab: "tasks", taskId: p.taskId })}>
          「{p.taskTitle}」
        </a>
        的维护者 · 阶段 {p.stageId}「{p.stageTitle}」（计划里这个阶段没有这个项目的一行）
      </div>
      {p.instructions !== p.title && <div className="sys-note">{p.instructions}</div>}
      <div className="muted">验收：{p.acceptance.join("；")}</div>
      <div className="chips">
        {p.categories.map((c) => (
          <span key={c} className="chip chip-op">
            {c}
          </span>
        ))}
      </div>
    </CardShell>
  );
}

/** 工单卡上按钮的字 */
const WORK_ORDER_CARD_ACTION_LABEL = { dispatch: "确认派出", deny: "拒绝" } as const;

/**
 * 并行确认卡（20 号票）：维护者提议派子 agent 同时做几个阶段（或几步），写明各做什么、在哪个目录里做。
 * 同意了才真正拉起子 agent；不同意（或还没处理）维护者照常一件一件做。
 */
export function ParallelCard({ state, payload: p, act }: CardProps<ParallelPayload>) {
  return (
    <CardShell
      state={state}
      title={`${p.taskTitle} · 派 ${p.agents.length} 个子 agent 同时做`}
      actions={
        <>
          <Btn onClick={() => act("sequential")}>{CARD_ACTION_LABEL.sequential}</Btn>
          <Btn kind="primary" onClick={() => act("parallel")}>
            {CARD_ACTION_LABEL.parallel}
          </Btn>
        </>
      }
    >
      <div className="sys-note">{p.reason}</div>
      <ul className="plain-list">
        {p.agents.map((a) => (
          <li key={a.agentId}>
            <b>{a.agentId}</b> · 阶段 {a.stageId}「{a.stageTitle}」{a.step ? `的「${a.step}」` : ""}：{a.instructions}
            <div className="muted">{a.ownWorkDir ? `在自己的目录里做：${a.workDir}` : "和维护者在同一个工作目录里做"}</div>
          </li>
        ))}
      </ul>
      <div className="muted">子 agent 的工具包和授权不超过维护者，不能写项目档案，不占任务的执行名额；做完即解散，结果回到维护者的会话。</div>
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
                {m.conversation ? <NamedText text={` · ${conversationLabel(m.conversation)}`} /> : ""} · {timeLabel(m.time)}
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
            <div className="muted">
              <NamedText text={MEMORY_DELETE_MODE_INFO[mode].note} />
            </div>
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
