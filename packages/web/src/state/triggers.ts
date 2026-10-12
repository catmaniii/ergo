// 定时触发的任务的视图（纯函数，76 号票，ADR 0025）：任务的触发登记是看板频道上的 scheduled_job（ownerTaskId 指向任务；19 号票的
// 定时作业迁移成定时触发的普通任务后也是这样）。看板"运营中"一组的任务卡、任务详情上的时间表、下一次、最近一次运行的结果、
// 能做的动作（暂停、恢复、取消，和守护进程用同一份规则：协议包的 scheduledJobActions），以及任务详情里按运行分段的运行列表。
// 发起对话框里"什么时候做"的几种（现在做一次、定时、事件发生时、只提醒我）和长程任务选不了定时、事件，也在这里。
// 77 号票：事件触发的任务——在等什么事件、最近一次触发是什么事件；每次运行的这一批事件连同事件里的值；对话框里"事件发生时"的编辑
// （选来源、选事件、填过滤条件，按事件来源登记表画）。
// 97 号票：写的话里说了几点，对话框里没动过的几栏按它填（fillWhenFromText），下面那一行怎么写（whenTextHint）；认时间在 text-time.ts。
import {
  describeSchedule,
  describeTime,
  EVENT_SOURCES,
  eventRecord,
  eventSourceOf,
  type EventTrigger,
  eventTriggerProblems,
  JOB_RUN_STATE_LABEL,
  type JobRun,
  type JobRunState,
  nextClockTime,
  nowIso,
  type ReminderSchedule,
  runEvents,
  type ScheduledJob,
  scheduleClockTime,
  type TaskKind,
  TIME_TRIGGER_SOURCE,
  triggerFields,
  triggerKindsOf,
  withClockTime,
} from "./protocol.ts";
import { jobRuns, type ScheduledJobView, scheduledJobView } from "./scheduled-jobs.ts";
import type { TextTime } from "./text-time.ts";
import type { UiState } from "./ui-state.ts";
import { stepsDone } from "./workflow-card.ts";

/** 某个任务的触发登记（不是定时触发的、还没登记好的是 undefined） */
export function taskTriggerJob(state: UiState, taskId: string): ScheduledJob | undefined {
  return Object.values(state.scheduledJobs).find((j) => j.ownerTaskId === taskId);
}

/** 某个任务的触发登记在卡上、详情上的样子（状态、时间表、下一次、最近一次、能做的动作） */
export function taskTriggerView(state: UiState, taskId: string): ScheduledJobView | undefined {
  const job = taskTriggerJob(state, taskId);
  return job && scheduledJobView(state, job);
}

/** 运行号里的第几次（j-1-r3 → 3） */
export const runNo = (runId: string): number => Number(/-r(\d+)$/.exec(runId)?.[1] ?? 0);

/** 这次运行处理的触发（排队合并成一批的每一次；76 号票之前的运行只有它自己那一次到点，补法在协议包的 runEvents） */
const runTriggers = (run: JobRun): string[] => runEvents(run).map((e) => e.summary);

/** 一次运行里的一个事件（77 号票）：一句话、时刻、事件里的值（字段的中文名 → 值，和交给 agent 的一样） */
export interface RunEventView {
  summary: string;
  at: string;
  values: Array<[string, string]>;
}

/** 这次运行的这一批事件（时间到了的不算） */
function runEventViews(run: JobRun): RunEventView[] {
  return runEvents(run)
    .filter((e) => e.source !== TIME_TRIGGER_SOURCE)
    .map((e) => {
      const { 来源: _s, 事件: _e, 时间: _t, ...values } = eventRecord(e);
      return { summary: e.summary, at: e.at, values: Object.entries(values).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)] as [string, string]) };
    });
}


/** 任务详情"运行"一栏里的一次运行 */
export interface RunView {
  runId: string;
  /** 第几次 */
  no: number;
  /** 怎么触发的：一次到点，或者合并了几次（"合并了 3 次触发"） */
  trigger: string;
  /** 这一批触发的每一次（合并了几次时逐条列出） */
  triggers: string[];
  /** 事件触发的（77 号票）：这一批事件，连同事件里的值 */
  events: RunEventView[];
  state: JobRunState;
  /** 成功、失败、运行中、排队、中断、没运行 */
  stateText: string;
  /** 失败、中断、没运行的原因 */
  reason?: string;
  /** 这次运行最后说的那一两句（做成了什么） */
  summary?: string;
  /** 定时触发的流程：这次运行做完几步（跳过的不算，stepsDone）、共几步，和各步的状态 */
  steps?: { done: number; total: number };
  stepList?: NonNullable<JobRun["steps"]>;
  /** 开始、结束的时刻（还没开始的没有） */
  startedAt?: string;
  endedAt?: string;
}

/** 一次运行在"运行"一栏里的样子 */
export function runView(run: JobRun): RunView {
  const triggers = runTriggers(run);
  const steps = run.steps;
  return {
    runId: run.runId,
    no: runNo(run.runId),
    trigger: triggers.length > 1 ? `合并了 ${triggers.length} 次触发` : (triggers[0] ?? ""),
    triggers,
    events: runEventViews(run),
    state: run.state,
    stateText: JOB_RUN_STATE_LABEL[run.state],
    ...(run.reason === undefined ? {} : { reason: run.reason }),
    ...(run.summary === undefined ? {} : { summary: run.summary }),
    ...(steps && steps.length > 0 ? { steps: { done: stepsDone(steps), total: steps.length }, stepList: steps } : {}),
    ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
    ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
  };
}

/** 任务详情"运行"一栏：这个任务的每一次运行，新的在前 */
export function taskRunViews(state: UiState, taskId: string): RunView[] {
  const job = taskTriggerJob(state, taskId);
  if (!job) return [];
  return jobRuns(state, job.id).map(runView).toReversed();
}

/** 卡上"最近一次"的写法：成功 · 10 月 9 日（周五）09:00；还没运行过是 undefined */
export function lastRunText(run: JobRun | undefined): { text: string; ok: boolean } | undefined {
  if (!run) return undefined;
  const at = run.endedAt ?? run.startedAt ?? run.queuedAt;
  const failed = run.state === "failed" || run.state === "interrupted";
  return { text: `最近一次：${JOB_RUN_STATE_LABEL[run.state]} · ${describeTime(new Date(at))}`, ok: !failed };
}

// ───────────────────────── 发起对话框里的"什么时候做" ─────────────────────────

/**
 * 发起对话框里"什么时候做"的四种：现在做一次、定时（按时间表反复运行，或者某个时间做一次）、事件发生时（77 号票：某个事件推送过来时，
 * 比如文件夹里来了新文件、某个任务完成了）、只提醒我（简单提醒，不用 agent；到点或者事件发生时）
 */
export const START_WHEN = ["once", "schedule", "event", "remind"] as const;
export type StartWhen = (typeof START_WHEN)[number];
export const START_WHEN_LABEL: Readonly<Record<StartWhen, string>> = { once: "现在做一次", schedule: "定时", event: "事件发生时", remind: "只提醒我" };
export const START_WHEN_HINT: Readonly<Record<StartWhen, string>> = {
  once: "发起后就去做，做完就结束",
  schedule: "定个时间再做：按时间表反复运行，或者某个时间做一次",
  event: "等某件事发生了再做：每来一次事件运行一次（比如文件夹里来了新文件、某个任务完成了）",
  remind: "不用 agent，只发一条通知（简单提醒）：到点，或者事件发生时",
};

/** "只提醒我"的两种（77 号票）：到点提醒、事件发生时提醒 */
export const REMIND_MODES = ["time", "event"] as const;
export type RemindMode = (typeof REMIND_MODES)[number];
export const REMIND_MODE_LABEL: Readonly<Record<RemindMode, string>> = { time: "到点提醒", event: "事件发生时提醒" };

/** 选"事件发生时"时一开始的样子：这个来源的第一种事件，必填的过滤条件空着 */
export function defaultEventTrigger(sourceId: string = EVENT_SOURCES[0]!.id): EventTrigger {
  const source = eventSourceOf(sourceId) ?? EVENT_SOURCES[0]!;
  return { kind: "event", source: source.id, events: [source.events[0]!.id] };
}

/** 对话框里改过滤条件：空的去掉，开关关上的去掉 */
export function withFilter(trigger: EventTrigger, key: string, value: string | boolean | undefined): EventTrigger {
  const filter = { ...trigger.filter };
  if (value === undefined || value === "" || value === false) delete filter[key];
  else filter[key] = value;
  const { filter: _f, ...rest } = trigger;
  return Object.keys(filter).length > 0 ? { ...rest, filter } : rest;
}

/** 对话框里勾选、取消一种事件 */
export function toggleEvent(trigger: EventTrigger, eventId: string): EventTrigger {
  const events = trigger.events.includes(eventId) ? trigger.events.filter((e) => e !== eventId) : [...trigger.events, eventId];
  // 按登记表的先后
  const order = eventSourceOf(trigger.source)?.events.map((e) => e.id) ?? [];
  return { ...trigger, events: events.toSorted((a, b) => order.indexOf(a) - order.indexOf(b)) };
}

/** 对话框里的事件触发方式还缺什么（文件夹能不能监视要守护进程现查，建的时候它会说） */
export const eventTriggerMissing = (trigger: EventTrigger): string[] => eventTriggerProblems(trigger);

/** 流程的步骤参数里能写的占位（对话框里给流程看的说明）："{{事件.文件路径}}、{{事件.文件名}}…" */
export const eventPlaceholderHint = (trigger: EventTrigger): string => triggerFields(trigger).map((f) => `{{事件.${f.label}}}`).join("、");

/**
 * 选了"定时"之后的两种（用户 2026-10-10 定）：按时间表反复做（每次一次运行，任务一直在运营中）；某个时间做一次（等到那个时间做一次，
 * 做完就算完成，和现在做一次的一样）
 */
export const TIMED_MODES = ["repeat", "at"] as const;
export type TimedMode = (typeof TIMED_MODES)[number];
export const TIMED_MODE_LABEL: Readonly<Record<TimedMode, string>> = { repeat: "按时间表反复做", at: "某个时间做一次" };
export const TIMED_MODE_HINT: Readonly<Record<TimedMode, string>> = {
  repeat: "按时间表反复运行，每次是一次运行；各次运行接着同一段会话，后面的知道前几次做了什么；上一次还没跑完又到点：排队合并，只多跑一次",
  at: "等到那个时间做一次，做完就算完成；还没到点时在看板的进行中一组（等时间），能取消。守护进程停着错过了的，开机后补做一次",
};

/** 某个时间做一次：那个时间要在将来（nowMs 是此刻的毫秒数） */
export const onceAtInFuture = (schedule: ReminderSchedule, nowMs: number): boolean => schedule.kind === "once" && Date.parse(schedule.at) > nowMs;

/** 这种做法能不能选这种"什么时候做"：长程任务只能现在做一次（ADR 0025）；只提醒我和做法无关 */
export function startWhenAllowed(kind: TaskKind, when: StartWhen): boolean {
  if (when === "remind") return true;
  return triggerKindsOf(kind).includes(when);
}

/** 选"定时"时一开始的时间表：每天 09:00 */
export const DEFAULT_TRIGGER_SCHEDULE: ReminderSchedule = { kind: "daily", time: "09:00" };

// ───────────────────────── 写的话里说了几点，就按几点定（97 号票） ─────────────────────────
// 用户 2026-10-12：写"明天早上8点调研一下……"、选了"定时"没动时间，建出的是每天 09:00。改成：写的话变了就重认一遍
// （text-time.ts 的 timeFromText），认出来了而用户还没自己动过的几栏按它填；动过的不再改，和写的不一样时标出来（照样能发起）。

/** 对话框里"什么时候做"这几栏的值 */
export interface WhenFields {
  when: StartWhen;
  timedMode: TimedMode;
  /** 定时 · 按时间表反复做的时间表 */
  schedule: ReminderSchedule;
  /** 定时 · 某个时间做一次的时间 */
  doAt: ReminderSchedule;
  /** 只提醒我 · 到点提醒的时间 */
  remindAt: ReminderSchedule;
}

/** 用户自己动过哪几栏（动过的不再按写的话自动改）："什么时候做"、定时那几栏（反复还是一次、时间）、提醒时间 */
export interface WhenTouched {
  when: boolean;
  timed: boolean;
  remind: boolean;
}
export const NOT_TOUCHED: WhenTouched = { when: false, timed: false, remind: false };

/** 用户动了某一栏；动了定时那几栏、提醒时间也算动过"什么时候做"（之后写的话里的时间删掉了也不切回现在做一次） */
export function touchWhen(touched: WhenTouched, part: keyof WhenTouched): WhenTouched {
  return { ...touched, [part]: true, when: true };
}

/** 一开始：现在做一次；定时默认按时间表每天 09:00，做一次、提醒默认下一个 09:00 */
export function initialWhenFields(now: Date): WhenFields {
  const nine: ReminderSchedule = { kind: "once", at: nowIso(nextClockTime("09:00", now)) };
  return { when: "once", timedMode: "repeat", schedule: DEFAULT_TRIGGER_SCHEDULE, doAt: nine, remindAt: nine };
}

/**
 * 写的话变了（或者换了做法）之后这几栏的样子：没动过的按认出的时间填——切到"定时"（做法不能定时的不切）、选好反复还是一次、
 * 填好时间（另一种填同一个钟点，切过去也对得上），提醒时间也填上；话里没有时间了，没动过的回到一开始的样子。
 * 动过的不改。做法不能选的"什么时候做"换成现在做一次（长程任务）。
 */
export function fillWhenFromText(fields: WhenFields, touched: WhenTouched, found: TextTime | undefined, kind: TaskKind, now: Date): WhenFields {
  const start = initialWhenFields(now);
  const next = { ...fields };
  if (!touched.timed) {
    if (found) {
      const time = scheduleClockTime(found.schedule);
      next.timedMode = found.mode;
      next.schedule = found.mode === "repeat" ? found.schedule : withClockTime(DEFAULT_TRIGGER_SCHEDULE, time);
      next.doAt = found.mode === "at" ? found.schedule : { kind: "once", at: nowIso(nextClockTime(time, now)) };
    } else {
      next.timedMode = start.timedMode;
      next.schedule = start.schedule;
      next.doAt = start.doAt;
    }
  }
  if (!touched.remind) next.remindAt = found?.schedule ?? start.remindAt;
  if (!touched.when) next.when = found && startWhenAllowed(kind, "schedule") ? "schedule" : start.when;
  if (!startWhenAllowed(kind, next.when)) next.when = "once";
  return next;
}

/** 写的话里的时间和这几栏对照的那一行：auto 是按写的定好了，warn 是不一样（或者这种做法不能定时） */
export interface WhenTextHint {
  tone: "auto" | "warn";
  text: string;
}

/**
 * 对话框里写在"什么时候做"下面的那一行：没动过、按写的定好了——"按你写的「明天早上8点」定在 10 月 13 日（周二）08:00"；
 * 动过而不一样——"你写的是「明天早上8点」，这里定的是每天 09:00"；动过而一样不写。长程任务不能定时："长程任务只能现在做"。
 * 事件发生时提醒不比时间。
 */
export function whenTextHint({
  found,
  fields,
  touched,
  kind,
  remindMode,
}: {
  found: TextTime | undefined;
  fields: WhenFields;
  touched: WhenTouched;
  kind: TaskKind;
  remindMode: RemindMode;
}): WhenTextHint | undefined {
  if (!found) return undefined;
  const quoted = `「${found.quote}」`;
  if (fields.when !== "remind" && !startWhenAllowed(kind, "schedule")) return { tone: "warn", text: `你写了${quoted}：长程任务只能现在做；要按时间做选普通任务或流程` };
  const compare = (set: ReminderSchedule, mine: boolean): WhenTextHint | undefined => {
    const described = describeSchedule(set);
    if (!sameSchedule(set, found.schedule)) return { tone: "warn", text: `你写的是${quoted}，这里定的是${/^\d/.test(described) ? " " : ""}${described}` };
    return mine ? undefined : { tone: "auto", text: `按你写的${quoted}${set.kind === "once" ? "定在 " : "定成"}${described}` };
  };
  switch (fields.when) {
    case "schedule":
      return compare(fields.timedMode === "at" ? fields.doAt : fields.schedule, touched.timed);
    case "remind":
      return remindMode === "time" ? compare(fields.remindAt, touched.remind) : undefined;
    case "once":
    case "event":
      return { tone: "warn", text: `你写的是${quoted}，这里选的是${START_WHEN_LABEL[fields.when]}` };
  }
}

/** 两个时间表是不是同一个：一次的比时刻，反复的比写法（周几、几号都是排好的） */
function sameSchedule(a: ReminderSchedule, b: ReminderSchedule): boolean {
  if (a.kind === "once" || b.kind === "once") return a.kind === "once" && b.kind === "once" && Date.parse(a.at) === Date.parse(b.at);
  return describeSchedule(a) === describeSchedule(b);
}
