// 任务做完告诉秘书（99 号票，规格第 7 节"任务做完告诉秘书"）：任务做完（普通任务、流程、长程任务变成已完成），定时 / 事件触发的任务
// 每运行完一次（看板频道 scheduled_job 的 run_finished，运行成功的），运行时给秘书一条系统通知（开头是 TASK_DONE_TAG），写明哪个任务
// （编号、标题、做法；运行的写第几次、怎么触发的）和做出来的结果（做它的 agent 最后说的那段话、交付的文件名，太长截短并写明截了）。
// 秘书收到后在主线里主动说一声、问用户要不要念出来，要就用发语音（send_voice，86 号票）念；规矩写在它的系统提示里（prompts/secretary.md）。
// - 项目内部的任务、作业不告诉（64、66 号票：秘书看不到项目内部的细节）。项目内部的普通任务做完照旧只说在哪个项目里做完了
//   （tasks/plain.ts 的 internalPlainDoneNotice，75 号票）。失败、等我的照旧走待我处理，不在这里。
// - 并成一条：做完一件先攒着，安静 settleMs（守护进程的 taskDoneSettleMs，默认 2 秒）没有新做完的才交；几件差不多同时做完的并成一条。
// - 等 agent 说完：流程报完最后一步、长程任务最后一个阶段验收通过时，做它的 agent 这一轮多半还没说完（最后那段话还没出来）：
//   等做完那一刻它在处理的那条输入结束再交（最多等 AGENT_WAIT_MS）。结果在交的时候才写，只算做完的那一轮（普通任务做完了
//   用户接着说、还没交就又做完的，各算各的：话和文件按这一轮开始、下一轮开始的那两条看板事件划开）。
// - 秘书忙时排在后面：秘书闲着才交——正在和用户说话的，这一轮完了再说；没起来的（拉起中、意外退出后等着重新拉起），起来闲着了再说。
//   交了就是秘书会话里一条排进输入队列的系统消息（和别的运行时通知一样），秘书处理它的那一轮在主线里说一声。
// - 不丢：通知的幂等键带着并进去的最后一条看板事件的全局序号（TASK_DONE_KEY_PREFIX）。守护进程启动时从事件日志里找最后一条，
//   它之后做完的（攒着还没交就停机了的）补上；一条都没交过的（刚升级上来）不往回翻。
// - 交成功才算交过：秘书处理这条通知到一半被打断（子进程崩溃、守护进程重启），AgentSession 照样把它标成中断出队，但不出
//   "请重发"的说明（redeliveredOnInterrupt，用户没法重发系统通知）；这里等秘书起来闲着了把同一段话再交一次（幂等键后面加 #第几次）。
//   只看每件通知最后交的那一次：那一次处理完了就不再交，不会说两遍。
import fs from "node:fs";
import path from "node:path";
import {
  CHANNELS,
  type ConversationId,
  EVENT_TYPES,
  isDeletedEventPayload,
  isProjectInternal,
  maintainerChannel,
  type MessageEventPayload,
  runEvents,
  type ScheduledJobEventPayload,
  TASK_KIND_LABEL,
  type TaskEventPayload,
  taskKind,
  type MessageEnvelope,
  type JobRun,
  type ScheduledJob,
  type TurnEndEventPayload,
} from "@ergou/protocol";
import { buildAgentNotice } from "../conversation/messages.ts";
import { getMessage, inputOf, startedInputs } from "../conversation/views.ts";
import type { EventStore, StoredEvent } from "../events/event-store.ts";
import type { Clock } from "../scheduler/clock.ts";
import { jobKeys } from "../scheduled-jobs/keys.ts";
import { ownerName, runLabel } from "../scheduled-jobs/texts.ts";
import { TASK_RECORDS_FILE } from "../scope-review/scope-review.ts";
import { getTask } from "../tasks/views.ts";
import { SEND_VOICE_TOOL } from "../voice/texts.ts";
import { TASK_DONE_TAG } from "./notice-tags.ts";

export { TASK_DONE_TAG };

/** 并成一条：做完一件之后安静多久（毫秒）没有新做完的才交给秘书 */
export const TASK_DONE_SETTLE_MS = 2000;

/** 做它的 agent 这一轮还没说完时最多等多久（毫秒）：到了就照现有的写 */
export const AGENT_WAIT_MS = 60_000;

/** 通知的幂等键：后面是并进去的最后一条看板事件的全局序号（启动时从这里接着补）；被打断后重新交的再加 #第几次 */
export const TASK_DONE_KEY_PREFIX = "task-done:";

/** 第几次交这件通知的幂等键（第一次不带 #） */
const noticeKey = (seq: number, attempt: number) => `${TASK_DONE_KEY_PREFIX}${seq}${attempt > 1 ? `#${attempt}` : ""}`;

/** 是不是任务做完的通知（秘书会话里运行时发的、开头是标记的系统消息）：被打断时不出"请重发"的说明，由这里重新交 */
export function isTaskDoneNotice(message: MessageEnvelope): boolean {
  const first = message.parts[0];
  return message.speaker === "system" && first?.type === "text" && first.text.startsWith(TASK_DONE_TAG);
}

/** 最后说的那段话最多带多少字 */
const SAID_MAX = 1000;
/** 交付的文件最多列几个 */
const FILES_MAX = 10;
/** 找交付的文件最多看多少个目录项（产出区里装了一大堆依赖的不全翻） */
const FILES_SCAN_MAX = 500;
/** 找最后说的话时往回最多看多少条消息 */
const SAID_LOOKBACK = 200;

/** 攒着的一件做完的事 */
interface Done {
  /** 看板频道上的那条事件（任务的 completed、运行的 run_finished） */
  event: StoredEvent;
  /**
   * 做完的那一刻做它的 agent 还在处理的输入（流程报完最后一步、长程任务最后一个阶段验收通过时那一轮还没完）：等它们结束再交。
   * 运行结束、普通任务做完时那一轮已经完了，没有；之后又来的新一轮（做完了用户接着说）不等
   */
  waitFor?: { agent: ConversationId; inputs: readonly string[] };
  /** 什么时候攒下的（时钟上的毫秒）：等 agent 说完最多等到 at + agentWaitMs */
  at: number;
}

/**
 * 看板频道上的一条事件是不是一件要告诉秘书的"做完了"：任务变成已完成、一次运行成功（项目内部的都不是）。
 * 定时任务改成某个时间做一次、那一次做成了，任务从运营中算完成（98 号票）：和那次运行的 run_finished 同一事务，
 * 只按那次运行说一件（写明任务随之完成），任务这一条不再另算
 */
export function isTaskDone(e: StoredEvent): boolean {
  if (e.channel !== CHANNELS.board || isDeletedEventPayload(e.payload)) return false;
  if (e.type === EVENT_TYPES.task) {
    const { task, change, from } = e.payload as TaskEventPayload;
    return change === "completed" && task.state === "done" && from !== "operating" && !isProjectInternal(task);
  }
  if (e.type === EVENT_TYPES.scheduledJob) {
    const { job, change, run } = e.payload as ScheduledJobEventPayload;
    return change === "run_finished" && run?.state === "done" && !isProjectInternal(job);
  }
  return false;
}

/** 消息里的文字 */
const textOf = (p: MessageEventPayload) =>
  p.message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();

/**
 * 这个会话里全局序号在 range 之间（after 之后、until 之前，没有 until 是到现在）、属于它的最后一条 agent 说的话（没有是 undefined）
 */
function lastSaid(store: EventStore, channel: ConversationId, range: { after: number; until?: number | undefined }, belongs: (p: MessageEventPayload) => boolean): string | undefined {
  let before = store.lastSeq(channel) + 1;
  let seen = 0;
  while (seen < SAID_LOOKBACK) {
    const page = store.readBefore(channel, before, 50, EVENT_TYPES.message);
    if (page.length === 0) return undefined;
    for (const e of page.toReversed()) {
      if (e.globalSeq <= range.after) return undefined;
      if (range.until !== undefined && e.globalSeq >= range.until) continue;
      seen += 1;
      if (isDeletedEventPayload(e.payload)) continue;
      const p = e.payload as MessageEventPayload;
      if (p.message.speaker !== "agent" || !belongs(p)) continue;
      const text = textOf(p);
      if (text) return text;
    }
    before = page[0]!.seq;
  }
  return undefined;
}

/**
 * 做完的这一轮从哪条看板事件开始（done 之前最后一次开始执行或接着做），下一轮从哪条开始（done 之后第一次接着做：
 * 普通任务做完了用户接着说是新的一轮，还没交就又做完了的，这一轮的话和文件不算上下一轮的）
 */
function roundOf(store: EventStore, taskId: string, done: number): { start?: StoredEvent | undefined; next?: StoredEvent | undefined } {
  let start: StoredEvent | undefined;
  for (const e of store.read(CHANNELS.board, 0, EVENT_TYPES.task)) {
    if (isDeletedEventPayload(e.payload)) continue;
    const p = e.payload as TaskEventPayload;
    if (p.task.id !== taskId || (p.change !== "started" && p.change !== "continued")) continue;
    if (e.globalSeq > done) return { start, next: e };
    start = e;
  }
  return { start };
}

/**
 * 交付的文件：产出区（dir）里这一轮（since 之后，有下一轮的到 until 为止）改过的文件，相对路径、按名字排。不看隐藏的、依赖目录、链接，
 * 也不看运行时自己写的范围记录；目录不在是空的
 */
function deliveredFiles(dir: string, since: string | undefined, until?: string | undefined): string[] {
  // 开始那条事件总在 agent 动手之前落盘（时间到毫秒），不用放宽
  const sinceMs = since === undefined ? 0 : Date.parse(since);
  const untilMs = until === undefined ? Infinity : Date.parse(until);
  const found: string[] = [];
  let scanned = 0;
  const walk = (rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      scanned += 1;
      if (scanned > FILES_SCAN_MAX) return;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && !(rel === "" && entry.name === TASK_RECORDS_FILE)) {
        try {
          const { mtimeMs } = fs.statSync(path.join(dir, child));
          if (mtimeMs >= sinceMs && mtimeMs < untilMs) found.push(child);
        } catch {
          // 刚好被删了：不算
        }
      }
    }
  };
  walk("");
  return found;
}

/** 通知里的一件：哪个任务做完了，它最后说的话（太长截短并写明），交付的文件 */
export function taskDoneItemText(head: string, said: string | undefined, files: readonly string[]): string {
  const lines = [head];
  if (said === undefined) lines.push("它没有留下结果的说明。");
  else if (said.length > SAID_MAX) lines.push(`它最后说（太长，这里只留了前 ${SAID_MAX} 字，原文在任务详情里）：`, `${said.slice(0, SAID_MAX)}……`);
  else lines.push("它最后说：", said);
  if (files.length > 0) lines.push(`交付的文件（在任务的产出区里）：${files.slice(0, FILES_MAX).join("、")}${files.length > FILES_MAX ? ` 等 ${files.length} 个` : ""}`);
  return lines.join("\n");
}

/** 交给秘书的通知：几件差不多同时做完的并在一条里；最后一句照系统提示里的规矩说要它做什么 */
export function taskDoneNoticeText(items: readonly string[]): string {
  const head =
    items.length === 1
      ? `${TASK_DONE_TAG}后台有一件事做完了（运行时发来的，不是用户说的）：`
      : `${TASK_DONE_TAG}后台有 ${items.length} 件事差不多同时做完了，并在这一条里（运行时发来的，不是用户说的）：`;
  const body = items.length === 1 ? items : items.map((text, i) => `${i + 1}. ${text}`);
  const ask =
    `在主线里主动跟用户说一声：用一两句话说${items.length === 1 ? "这件" : "这几件"}做完了、结果大概是什么，然后问“要我念给你听吗？”。` +
    `他说要，就用 ${SEND_VOICE_TOOL} 把结果的口语稿念给他听；说不用就算了。`;
  return [head, ...body, ask].join("\n\n");
}

/** 一件做完的事写成通知里的一段（交的时候才写：agent 最后说的话那时才齐） */
function describeDone(store: EventStore, outputsDir: string, e: StoredEvent): string {
  if (e.type === EVENT_TYPES.task) {
    const { task } = e.payload as TaskEventPayload;
    const { start, next } = roundOf(store, task.id, e.globalSeq);
    const said = lastSaid(store, maintainerChannel(task.maintainerId), { after: start?.globalSeq ?? 0, until: next?.globalSeq }, (p) => p.taskId === undefined || p.taskId === task.id);
    const files = deliveredFiles(path.join(outputsDir, task.id), start?.time, next?.time);
    return taskDoneItemText(`${TASK_KIND_LABEL[taskKind(task)]} ${task.id}「${task.title}」在后台做完了。`, said, files);
  }
  const { job, run } = e.payload as ScheduledJobEventPayload;
  const owner = job.ownerTaskId === undefined ? undefined : getTask(store.reader, job.ownerTaskId);
  const start = store.eventByIdempotencyKey(jobKeys.runStart(run!.runId));
  const events = runEvents(run!);
  const when = events.length === 1 ? events[0]!.summary : `${events[0]!.summary}等 ${events.length} 次触发，合成这一次运行`;
  // 最后说的话：这次运行收工那一轮里它说的（之后催写回的几轮不算；运行记录里存的是压成一行的那一两句，找不到时用它）
  const until = closingTurnEnd(store, job, run!, start) ?? e.globalSeq;
  const said = lastSaid(store, maintainerChannel(job.maintainerId), { after: start?.globalSeq ?? e.globalSeq, until }, (p) => p.scheduledJobId === job.id) ?? run!.summary;
  // 交付的文件：这次运行开始到结束之间改过的（几次运行并在一条里时各算各的）；属于项目的（迁移来的定时作业）在项目的工作目录里做，不列
  const files = job.projectId === undefined ? deliveredFiles(path.join(outputsDir, job.taskId), start?.time, e.time) : [];
  // 改成某个时间做一次的（98 号票）：那一次做成了，任务随之完成
  const closes = job.schedule?.kind === "once" && owner?.state === "done" ? "这是定在那个时间做的一次，做成了，任务随之完成。" : "";
  return taskDoneItemText(`${ownerName(job, owner)}的${runLabel(run!)}做完了（触发：${when}）。${closes}`, said, files);
}

/**
 * 这次运行收工那一轮在哪结束（turn_end 的全局序号），照 scheduled-jobs/jobs.ts 记运行摘要的做法：这次运行开始之后（有收尾提醒的，
 * 提醒之后）执行它的 agent 处理这个作业的系统通知的第一轮。属于项目的要等工单写回才算运行结束，之后催写回的几轮不算；没有是 undefined
 */
function closingTurnEnd(store: EventStore, job: ScheduledJob, run: JobRun, start: StoredEvent | undefined): number | undefined {
  const after = store.eventByIdempotencyKey(jobKeys.runNudge(run.runId))?.globalSeq ?? start?.globalSeq ?? 0;
  for (const t of store.read(maintainerChannel(job.maintainerId), 0, EVENT_TYPES.turnEnd)) {
    if (t.globalSeq <= after || isDeletedEventPayload(t.payload)) continue;
    const id = (t.payload as TurnEndEventPayload).inputMessageId;
    if (inputOf(store.reader, id)?.scope.scheduledJobId === job.id && getMessage(store.reader, id)?.speaker === "system") return t.globalSeq;
  }
  return undefined;
}

/** 秘书会话里交过的一次任务做完的通知：哪件（并进去的最后一条看板事件的全局序号）、第几次交、消息 */
interface NoticeAttempt {
  seq: number;
  attempt: number;
  messageId: string;
  text: string;
}

/** 秘书会话里交过的全部任务做完的通知（按先后） */
function noticeAttempts(store: EventStore): NoticeAttempt[] {
  const out: NoticeAttempt[] = [];
  for (const e of store.mentioning(EVENT_TYPES.message, TASK_DONE_TAG)) {
    const key = e.idempotencyKey;
    if (e.channel !== CHANNELS.secretary || !key?.startsWith(TASK_DONE_KEY_PREFIX) || isDeletedEventPayload(e.payload)) continue;
    const [seq, attempt] = key.slice(TASK_DONE_KEY_PREFIX.length).split("#").map(Number);
    if (seq === undefined || !Number.isInteger(seq)) continue;
    const { message } = e.payload as MessageEventPayload;
    out.push({ seq, attempt: attempt ?? 1, messageId: message.id, text: message.parts.map((p) => (p.type === "text" ? p.text : "")).join("") });
  }
  return out;
}

/** 每件通知最后交的那一次（同一件只看它） */
function latestAttempts(attempts: readonly NoticeAttempt[]): NoticeAttempt[] {
  const latest = new Map<number, NoticeAttempt>();
  for (const a of attempts) if ((latest.get(a.seq)?.attempt ?? 0) < a.attempt) latest.set(a.seq, a);
  return [...latest.values()];
}

/** 秘书处理这条输入的结局（还没处理完是 undefined） */
function outcomeOf(store: EventStore, messageId: string): TurnEndEventPayload["outcome"] | undefined {
  let outcome: TurnEndEventPayload["outcome"] | undefined;
  for (const t of store.read(CHANNELS.secretary, 0, EVENT_TYPES.turnEnd)) {
    const p = t.payload as TurnEndEventPayload;
    if (p.inputMessageId === messageId) outcome = p.outcome;
  }
  return outcome;
}

export interface TaskDoneNoticesOptions {
  store: EventStore;
  /** 安静多久、等 agent 说完都按它算（测试换成手动拨的） */
  clock: Clock;
  /** 做完一件之后安静多久没有新做完的才交（毫秒） */
  settleMs: number;
  /** 任务的产出区（数据目录 outputs/）：交付的文件在 outputs/<任务> 里找 */
  outputsDir: string;
  /** 秘书现在闲着吗（闲着才交） */
  secretaryIdle: () => boolean;
  /** 做它的 agent 这一轮还没说完时最多等多久（毫秒）；不给是 AGENT_WAIT_MS */
  agentWaitMs?: number;
  log: (line: string) => void;
}

export interface TaskDoneNotices {
  /** 秘书闲下来了：攒着的够安静了就交给它 */
  idle(): void;
  stop(): void;
}

export function startTaskDoneNotices(options: TaskDoneNoticesOptions): TaskDoneNotices {
  const { store, clock, settleMs } = options;
  const agentWaitMs = options.agentWaitMs ?? AGENT_WAIT_MS;
  let pending: Done[] = [];
  /** 安静到什么时候（最后攒下的那件的时刻 + settleMs） */
  let quietAt = 0;
  let cancelTimer: (() => void) | undefined;
  let stopped = false;

  /** 做完的那一刻做它的 agent 在处理的输入还没结束（还没到最多等的时候） */
  const talking = (d: Done) =>
    d.waitFor !== undefined && clock.now() < d.at + agentWaitMs && startedInputs(store.reader, d.waitFor.agent).some((q) => d.waitFor!.inputs.includes(q.messageId));

  /** 到点再看一眼：安静够了的时刻；有 agent 还在说的，最多等到它的时限 */
  const arm = () => {
    cancelTimer?.();
    cancelTimer = undefined;
    if (stopped || pending.length === 0) return;
    const limits = pending.filter(talking).map((d) => d.at + agentWaitMs);
    cancelTimer = clock.setTimer(Math.max(quietAt, ...limits), check);
  };

  const flush = () => {
    const items = pending;
    pending = [];
    cancelTimer?.();
    cancelTimer = undefined;
    const last = Math.max(...items.map((d) => d.event.globalSeq));
    try {
      const text = taskDoneNoticeText(items.map((d) => describeDone(store, options.outputsDir, d.event)));
      store.append(buildAgentNotice(CHANNELS.secretary, text, noticeKey(last, 1)).event);
    } catch (err) {
      options.log(`任务做完的通知没交给秘书：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** 被打断了要重新交的（秘书闲着时交，不用等安静） */
  let redeliver: NoticeAttempt[] = [];
  const redeliverNow = () => {
    for (const a of redeliver.splice(0)) {
      try {
        store.append(buildAgentNotice(CHANNELS.secretary, a.text, noticeKey(a.seq, a.attempt + 1)).event);
      } catch (err) {
        options.log(`被打断的任务做完的通知没能重新交给秘书：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  /** 秘书处理到一半被打断的那几件（每件最后交的那一次被标成中断）：等它起来闲着了重新交；only 是只看这一条 */
  const collectInterrupted = (only?: string) => {
    for (const a of latestAttempts(noticeAttempts(store))) {
      if ((only !== undefined && a.messageId !== only) || redeliver.some((r) => r.seq === a.seq)) continue;
      if (outcomeOf(store, a.messageId) === "interrupted") redeliver.push(a);
    }
  };

  /** 能交了就交：安静够了、做它的 agent 都说完了、秘书闲着（不闲着的等它闲下来时再看：idle） */
  const check = () => {
    if (stopped) return;
    // 被打断了要重新交的先交（交了秘书就忙了，新做完的等它下次闲下来）
    if (redeliver.length > 0 && options.secretaryIdle()) return redeliverNow();
    if (pending.length === 0) return;
    // 还没安静够、还有 agent 在说：按现在的样子重新定下次看的时刻（agent 先说完了的，不用再等到它的时限）
    if (clock.now() < quietAt || pending.some(talking)) return arm();
    if (!options.secretaryIdle()) return;
    flush();
  };
  /** 不在别人追加事件、改状态的那段代码里交（交的时候要追加事件） */
  const checkLater = () => {
    if (!stopped && (pending.length > 0 || redeliver.length > 0)) setImmediate(check);
  };

  const add = (event: StoredEvent) => {
    const now = clock.now();
    const agent = event.type === EVENT_TYPES.task ? maintainerChannel((event.payload as TaskEventPayload).task.maintainerId) : undefined;
    const inputs = agent === undefined ? [] : startedInputs(store.reader, agent).map((q) => q.messageId);
    pending.push({ event, at: now, ...(agent !== undefined && inputs.length > 0 ? { waitFor: { agent, inputs } } : {}) });
    quietAt = now + settleMs;
    arm();
  };

  // 停机前攒着还没交的：上一条通知之后做完的补上（一条都没交过的不往回翻）
  const attempts = noticeAttempts(store);
  if (attempts.length > 0) {
    const told = Math.max(...attempts.map((a) => a.seq));
    for (const e of store.read(CHANNELS.board, 0)) if (e.globalSeq > told && isTaskDone(e)) add(e);
  }
  // 停机时秘书正处理到一半的（拉起秘书时已经标成中断）：起来闲着了重新交
  collectInterrupted();

  const unsubscribe = store.onAppend((e) => {
    if (stopped) return;
    if (isTaskDone(e)) add(e);
    else if (e.type !== EVENT_TYPES.turnEnd) return;
    // 秘书处理任务做完的通知到一半被打断了（子进程崩溃）：起来闲着了重新交
    else if (e.channel === CHANNELS.secretary && (e.payload as TurnEndEventPayload).outcome === "interrupted") {
      const id = (e.payload as TurnEndEventPayload).inputMessageId;
      const message = getMessage(store.reader, id);
      if (message && isTaskDoneNotice(message)) collectInterrupted(id);
    }
    // 做完的任务的 agent 这一轮说完了
    else if (pending.some((d) => d.waitFor?.agent === e.channel)) checkLater();
  });

  return {
    idle: checkLater,
    stop() {
      stopped = true;
      unsubscribe();
      cancelTimer?.();
      cancelTimer = undefined;
      pending = [];
      redeliver = [];
    },
  };
}
