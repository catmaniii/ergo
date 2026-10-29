// 简单提醒（规格第 7、8、13 节）：到点只发一条通知、不需要 agent 干活。秘书负责建、改、取消（工具在 tools.ts），
// 用户也能在提醒卡上改、取消（卡片类型在 card.ts，动作的结果由这里给出）；76 号票起用户在发起对话框里选"只提醒我"也能直接建
// （create_reminder，createFromUser），时间表和定时触发的任务同一套。
// - 状态：一次性的 待触发 → 已触发；重复的（每天、每周几、每月几号、每年某月某日、按我的工作日）一直待触发；任何时候可以取消。
// - 每条提醒有一张提醒卡；提醒变了，卡片跟着变（同一事务）。
// - 存储：任务看板频道上的 reminder 事件（最新状态 + 这次的变化 + 谁做的），派生视图 reminders（views.ts）。
// - "按我的工作日"（29 号票）：下一次按当时的个人工作日历算（scheduleContext）。工作日历改了（比如明天标成休息），
//   recalculate 按新的工作日历重算跟着它变的提醒（dependsOnWorkdayCalendar），下一次变了就追加一条 updated（by system），
//   提醒卡跟着变，不用重建提醒。
// - 到点：调度器（时钟可注入）直接通知前端，不拉起任何 agent：待我处理里放一条置顶的提醒事项、推一条临时的 notify。
//   同一个提醒在待我处理里最多一条置顶：新的一次到点时，上一次的置顶事项取消置顶（还没处理的顺手归档）。
// - 晚了才到点（守护进程那时没在运行、机器睡着了）：晚了 60 分钟以内照发，标明晚了多久；更晚的不弹提示，
//   改放进待我处理（错过的提醒）。重复提醒错过多次只按最近一次处理（规格第 13 节）。19 号票把同一套规则扩到定时作业。
// - 调度：启动时把待触发的提醒登记进调度器（已经过了点的马上按上面的规则处理）；之后每条 reminder 事件
//   （不论是秘书、用户还是到点引起的）都按它的新状态重新登记。所以守护进程正常重启后，还没到点的提醒照常触发。
// - 日历（35 号票）：calendar 给出一段时间里每条没取消的提醒的时间表展开（按当前的工作日历）、现在的时间表从哪一刻起生效、
//   这段时间里的触发记录（照发的、错过的，按触发时间：reminder 事件里的 lastFiredAt 就是那一次该响的时刻）。
// - 事件发生时提醒（77 号票）：提醒不写时间表，写在等什么事件（event，和事件触发的任务同一套登记表）；一直待触发，
//   事件来源推来一次（event-sources/ 的分发调 fireOnEvent），就像到点一样发一条通知（待我处理里置顶一条、推一条 notify），
//   reminder 事件记下这次事件的时刻和一句话（去重键由事件来源给，同一次事件只提醒一次）。日历上不列它们。
// - 归档、删除（185 号票）：已经结束的（一次性的已触发、已取消）能归档（archived，看板上进"已归档"；没有取消归档，照任务）；
//   任何提醒都能删——状态变成已删除（编号不收回），调度器跟着 reminder 事件取消计时器（还没触发的不再响），提醒卡写"已删除"
//   （卡片作废，再点旧按钮回"提醒已经删了"），待我处理里它的到点、错过的事项删掉，日历上不再列它；事件日志只追加一条 deleted，
//   原来的事件不改写（这不是"彻底删除素材"）。用户在看板、提醒卡上做的交 reminder_action（act，各自成败、逐条回报；卡片动作只收
//   待处理的卡，已触发、已取消的提醒卡已经不是），秘书归档用工具（archive），删除走快速动作（delete-action.ts，总要用户在卡上确认）。
import {
  jobTriggerText,
  ASSISTANT_NAME_MARK,
  CHANNELS,
  dependsOnWorkdayCalendar,
  describeDuration,
  describeTime,
  EVENT_TYPES,
  isDeletedEventPayload,
  isRepeating,
  latestOccurrence,
  nextOccurrence,
  type NoticeInboxItem,
  nowIso,
  occurrencesBetween,
  type Reminder,
  type ReminderActionItemResult,
  type ReminderActionParams,
  type ReminderActionResult,
  type ReminderCardPayload,
  type ReminderChangeKind,
  type ReminderEventPayload,
  type ReminderSchedule,
  type EventTrigger,
  type ScheduleContext,
  type Speaker,
  type TriggerEvent,
  t,
} from "@ergo/protocol";
import type { CardChange, CardService } from "../cards/cards.ts";
import { newCardId } from "../cards/cards.ts";
import type { CardActionEffect } from "../cards/registry.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import type { InboxService } from "../inbox/inbox.ts";
import type { Clock } from "../scheduler/clock.ts";
import type { Scheduler } from "../scheduler/scheduler.ts";
import { RequestRejected } from "../errors.ts";

/** 事项的动作"知道了"（按字认，不翻） */
const GOT_IT = "知道了"; // @i18n-ignore fixed：事项的动作按字认
import { nextAtOf, ReminderInputError } from "./schedule.ts";
import { DEFAULT_REMINDER_THRESHOLDS } from "./thresholds.ts";
import { countReminders, getReminder, listReminders } from "./views.ts";
import { reminderText } from "./texts.ts";


/** 提醒的一次触发记录：该响的时刻，照发了还是错过了（晚了太久改放进待我处理），晚了几分钟 */
export interface ReminderFiring {
  dueAt: string;
  change: "fired" | "missed";
  lateMinutes?: number;
}

/** 日历上的一条提醒（35 号票） */
export interface ReminderCalendarEntry {
  /** 到点提醒的（事件发生时提醒的不上日历） */
  reminder: Reminder & { schedule: ReminderSchedule };
  /** 现在的时间表从哪一刻起生效：建的时候，或者最后一次改时间表的时候 */
  since: string;
  /** 时间表在这段时间里的每一次（协议时间，先到的在前；不管生效没有，按当前的工作日历展开） */
  occurrences: string[];
  /** 该响的时刻落在这段时间里的触发记录，先到的在前 */
  firings: ReminderFiring[];
}

/** 建一条提醒：提醒什么，到点提醒的时间表或者事件发生时提醒的事件（二选一） */
export interface NewReminder {
  text: string;
  schedule?: ReminderSchedule | undefined;
  event?: EventTrigger | undefined;
}

/** 改一条提醒：新的内容、新的时间表（不给的不变；事件发生时提醒的给了时间表就改成到点提醒） */
export interface ReminderEdit {
  text?: string;
  schedule?: ReminderSchedule;
}

export interface ReminderService {
  /** 建一条提醒（连同它的提醒卡）；时间不对时抛 ReminderInputError */
  create(input: NewReminder, by: Speaker): { reminder: Reminder; cardId: string };
  /**
   * 用户在发起对话框里选了"只提醒我"（create_reminder，76 号票）：建一条提醒，同一幂等键重发拿到同一条；时间不对的抛 RequestRejected
   */
  createFromUser(input: NewReminder, idempotencyKey: string): { reminderId: string };
  /**
   * 事件发生时提醒的（77 号票）：等的事件来了（事件来源经 event-sources/ 的分发推来），发一条通知。不在待触发、不是等事件的不响；
   * 同一个去重键只响一次
   */
  fireOnEvent(reminderId: string, event: TriggerEvent, idempotencyKey: string): void;
  /** 秘书按用户的话改时间或内容；提醒卡跟着变 */
  update(reminderId: string, edit: ReminderEdit, by: Speaker): { reminder: Reminder; cardId: string };
  /** 秘书按用户的话取消；提醒卡变成已处理 */
  cancel(reminderId: string, by: Speaker): { reminder: Reminder; cardId: string };
  /** 用户在提醒卡上"改"的结果（卡片动作 save）：卡片仍待处理，负载换成新的，提醒事件随卡片一起追加 */
  editFromCard(reminderId: string, edit: ReminderEdit): CardActionEffect<ReminderCardPayload>;
  /** 用户在提醒卡上"取消提醒"的结果（卡片动作 cancel_reminder）：卡片已处理 */
  cancelFromCard(reminderId: string): CardActionEffect<ReminderCardPayload>;
  /** 归档一条已经结束的提醒（185 号票）：一次性的已触发、已取消；还没结束、归档过、删过的抛 RequestRejected（not_allowed） */
  archive(reminderId: string, by: Speaker): { reminder: Reminder; cardId: string };
  /** 删一条提醒（185 号票）：任何没删过的；还没触发的停掉时间表，提醒卡写已删除，待我处理里它的事项删掉 */
  remove(reminderId: string, by: Speaker): { reminder: Reminder; cardId: string };
  /** 删一条提醒的事件（不追加）：快速动作"删除简单提醒"和卡片更新、操作记录同一事务追加；不存在、删过的抛 RequestRejected */
  buildRemove(reminderId: string, by: Speaker): { reminder: Reminder; events: NewEvent[] };
  /** 用户在看板、提醒卡上对一条或几条提醒做同一件事（reminder_action，185 号票）：取消、归档、删除，各自成败、逐条回报 */
  act(params: ReminderActionParams, idempotencyKey: string): ReminderActionResult;
  get(reminderId: string): Reminder | undefined;
  /** 待触发的提醒（给秘书看，比如它给错了编号时） */
  pending(): Reminder[];
  /** 没删过的提醒（先建的在前；秘书给错了要删的编号时列出来） */
  list(): Reminder[];
  /** 日历（35 号票）：[from, to) 之间每条没取消的提醒的时间表展开、现在的时间表从哪一刻起生效、这段时间的触发记录 */
  calendar(from: Date, to: Date): ReminderCalendarEntry[];
  /** 工作日历变了：按新的工作日历重算跟着它变的提醒的下一次（变了才追加事件） */
  recalculate(): void;
  /** 把待触发的提醒登记进调度器，之后跟着提醒的变化重新登记 */
  start(): void;
  stop(): void;
}

export interface ReminderServiceOptions {
  store: EventStore;
  cards: CardService;
  inbox: InboxService;
  scheduler: Scheduler;
  clock: Clock;
  /** 算下一次时要的东西：当前的个人工作日历（"按我的工作日"的下一次按它算） */
  scheduleContext: () => ScheduleContext;
  /** 晚了这么多分钟以内照发；更晚的改放进待我处理（规格第 13 节；默认见 thresholds.ts，配置 reminders.lateLimitMinutes） */
  lateLimitMinutes?: number;
  /** 事件发生时提醒的（77 号票）：事件触发方式对不对（登记表和来源的实现现查）；不给就不收事件发生时提醒的 */
  checkEvent?: (trigger: EventTrigger) => string[];
  /** reminder_action 里没想到的错记日志（185 号票）；不给就不记 */
  log?: (line: string) => void;
}

const schedulerKey = (reminderId: string) => `reminder:${reminderId}`;
const MINUTE = 60_000;

/** 提醒卡的负载 */
function cardPayloadOf(r: Reminder): ReminderCardPayload {
  return {
    reminderId: r.id,
    text: r.text,
    ...(r.schedule === undefined ? {} : { schedule: r.schedule }),
    ...(r.event === undefined ? {} : { event: r.event }),
    status: r.status,
    ...(r.nextAt === undefined ? {} : { nextAt: r.nextAt }),
    ...(r.lastFiredAt === undefined ? {} : { lastFiredAt: r.lastFiredAt }),
    ...(r.archived ? { archived: true } : {}),
  };
}

/** 删过的提醒不能再动（185 号票） */
const deletedError = (reminder: Reminder) => new RequestRejected("not_allowed", t("reminders.alreadyDeleted", { id: reminder.id, text: reminder.text }));

/** 编号对不上：说明没有，再列出能做这件事的那几条（秘书给错了编号时照着改） */
function noSuch(reminderId: string, candidates: readonly Reminder[], kind: "archivable" | "any"): RequestRejected {
  const list = candidates.map((r) => t("reminders.listItem", { id: r.id, text: r.text, when: jobTriggerText(r) })).join(t("reminders.listSep"));
  const key = kind === "archivable" ? (list ? "reminders.noSuchArchivable" : "reminders.noSuchArchivableNone") : list ? "reminders.noSuchAny" : "reminders.noSuchAnyNone";
  return new RequestRejected("not_found", t(key, { id: reminderId, list }));
}

/** reminder_action 里这一条用的幂等键（和任务的批量一样由这次的键派生） */
const actionItemKey = (idempotencyKey: string, reminderId: string) => `${idempotencyKey}#${reminderId}`;

/** reminder_action 里做成了的一条：之后的状态、归没归档 */
const doneItem = (r: Reminder): ReminderActionItemResult => ({ reminderId: r.id, ok: true, status: r.status, ...(r.archived ? { archived: true } : {}) });

/** 提醒的 reminder 事件 */
function reminderEvent(reminder: Reminder, change: ReminderChangeKind, by: Speaker, lateMinutes?: number): NewEvent {
  const payload: ReminderEventPayload = { reminder, change, by, ...(lateMinutes === undefined ? {} : { lateMinutes }) };
  return { channel: CHANNELS.board, type: EVENT_TYPES.reminder, payload };
}

/** 去掉下一次的时间（已触发、已取消的提醒没有） */
function withoutNextAt(reminder: Reminder): Reminder {
  const { nextAt: _dropped, ...rest } = reminder;
  return rest;
}

export function createReminderService(options: ReminderServiceOptions): ReminderService {
  const { store, cards, inbox, scheduler, clock, scheduleContext } = options;
  let unsubscribe: (() => void) | undefined;

  /** 一条新提醒和它的事件（提醒、提醒卡；不追加）：编号接着往下排（r-1、r-2……，短，秘书好引用）；时间不对时抛 ReminderInputError */
  const built = (input: NewReminder, by: Speaker): { reminder: Reminder; events: NewEvent[] } => {
    const text = input.text.trim();
    if (!text) throw new ReminderInputError(t("reminders.emptyText"));
    if ((input.schedule === undefined) === (input.event === undefined)) throw new ReminderInputError(reminderText.scheduleOrEvent());
    if (input.event) {
      const problems = options.checkEvent ? options.checkEvent(input.event) : [reminderText.noEventSources()];
      if (problems.length > 0) throw new ReminderInputError(reminderText.badEvent(problems));
    }
    const now = new Date(clock.now());
    const reminder: Reminder = {
      id: `r-${countReminders(store.reader) + 1}`,
      text,
      ...(input.schedule ? { schedule: input.schedule, nextAt: nextAtOf(input.schedule, now, scheduleContext()) } : {}),
      ...(input.event ? { event: input.event } : {}),
      status: "pending",
      cardId: newCardId(),
      createdAt: nowIso(now),
      updatedAt: nowIso(now),
    };
    const card = cards.buildCreate({ id: reminder.cardId, type: "reminder", payload: cardPayloadOf(reminder) });
    return { reminder, events: [reminderEvent(reminder, "created", by), card.event] };
  };

  const nowDate = () => new Date(clock.now());

  /** 还能改、能取消的提醒；不存在或已经结束时说明原因 */
  const pendingReminder = (reminderId: string): Reminder => {
    const reminder = getReminder(store.reader, reminderId);
    if (reminder?.status === "deleted") throw deletedError(reminder);
    if (!reminder) {
      const list = listReminders(store.reader, "pending")
        .map((r) => t("reminders.listItem", { id: r.id, text: r.text, when: jobTriggerText(r) }))
        .join(t("reminders.listSep"));
      throw new RequestRejected("not_found", list ? t("reminders.noSuchPending", { id: reminderId, list }) : t("reminders.noSuchNone", { id: reminderId }));
    }
    // 185 号票起是 not_allowed（原来是 bad_params：提醒卡上点不到这里，秘书只看原因，reminder_action 逐条回报时码要对）
    if (reminder.status === "fired") throw new RequestRejected("not_allowed", t("reminders.alreadyFired", { id: reminderId, text: reminder.text }));
    if (reminder.status === "cancelled") throw new RequestRejected("not_allowed", t("reminders.alreadyCancelled", { id: reminderId, text: reminder.text }));
    return reminder;
  };

  /** 没删过的提醒 */
  const living = () => listReminders(store.reader).filter((r) => r.status !== "deleted");

  /** 能归档的提醒（已经结束、还没归档的）；不存在、还没结束、归档过、删过的说明原因 */
  const archivable = (reminderId: string): Reminder => {
    const reminder = getReminder(store.reader, reminderId);
    if (!reminder) throw noSuch(reminderId, living().filter((r) => r.status !== "pending" && !r.archived), "archivable");
    if (reminder.status === "deleted") throw deletedError(reminder);
    if (reminder.status === "pending") throw new RequestRejected("not_allowed", t("reminders.notEnded", { id: reminder.id, text: reminder.text }));
    if (reminder.archived) throw new RequestRejected("not_allowed", t("reminders.alreadyArchived", { id: reminder.id, text: reminder.text }));
    return reminder;
  };

  /** 能删的提醒（没删过的）；不存在、删过的说明原因 */
  const deletable = (reminderId: string): Reminder => {
    const reminder = getReminder(store.reader, reminderId);
    if (!reminder) throw noSuch(reminderId, living(), "any");
    if (reminder.status === "deleted") throw deletedError(reminder);
    return reminder;
  };

  /** 归档的事件（提醒、提醒卡跟着写已归档；卡片的状态不变） */
  const archiveEvents = (reminderId: string, by: Speaker): { reminder: Reminder; events: NewEvent[] } => {
    const reminder: Reminder = { ...archivable(reminderId), archived: true, updatedAt: nowIso(nowDate()) };
    return { reminder, events: [reminderEvent(reminder, "archived", by), cardEvent(reminder)] };
  };

  /**
   * 删除的事件：提醒变成已删除（没有下一次：调度器跟着取消计时器）；提醒卡写已删除、作废（再点旧按钮回"提醒已经删了"）；
   * 待我处理里它的事项（到点的、错过的）删掉
   */
  const removeEvents = (reminderId: string, by: Speaker): { reminder: Reminder; events: NewEvent[] } => {
    const current = deletable(reminderId);
    const reminder: Reminder = { ...withoutNextAt(current), status: "deleted", updatedAt: nowIso(nowDate()) };
    return {
      reminder,
      events: [
        reminderEvent(reminder, "deleted", by),
        cardEvent(reminder, { status: "expired", expiredNote: t("reminders.deletedNote") }),
        ...inbox.itemsForCard(reminder.cardId).map((item) => inbox.buildUpdate(item, { deleted: true }).event),
      ],
    };
  };

  /** 改了之后的提醒（还没追加） */
  const edited = (reminderId: string, edit: ReminderEdit): Reminder => {
    const current = pendingReminder(reminderId);
    const text = edit.text?.trim() || current.text;
    // 事件发生时提醒的：只改内容时照旧等事件；给了时间表就改成到点提醒
    const schedule = edit.schedule ?? current.schedule;
    if (!schedule) return { ...current, text, updatedAt: nowIso(nowDate()) };
    const { event: _e, lastEvent: _l, ...rest } = current;
    return { ...rest, text, schedule, nextAt: nextAtOf(schedule, nowDate(), scheduleContext()), updatedAt: nowIso(nowDate()) };
  };

  /** 取消之后的提醒（还没追加） */
  const cancelled = (reminderId: string): Reminder => ({ ...withoutNextAt(pendingReminder(reminderId)), status: "cancelled", updatedAt: nowIso(nowDate()) });

  /** 取消的事件（秘书的工具、reminder_action）：提醒卡已处理，结果是"取消提醒"；秘书取消的写明是按你的话 */
  const cancelEvents = (reminder: Reminder, by: Speaker): { reminder: Reminder; events: NewEvent[] } => {
    // 名字写占位，前端按用户起的名字显示（43 号票）
    const note = by === "agent" ? t("reminders.cancelledByAssistant", { assistant: ASSISTANT_NAME_MARK }) : undefined;
    return {
      reminder,
      events: [reminderEvent(reminder, "cancelled", by), cardEvent(reminder, { status: "handled", outcome: { action: "cancel_reminder", ...(note === undefined ? {} : { note }) } })],
    };
  };

  /** 提醒变了，提醒卡跟着变的那条 card 事件 */
  const cardEvent = (reminder: Reminder, change: CardChange = {}): NewEvent => cards.buildUpdate(reminder.cardId, { payload: cardPayloadOf(reminder), ...change }).event;

  /** 这个提醒以前到点时放进待我处理、现在还置顶着的事项：取消置顶，还没处理的顺手归档 */
  const retirePinned = (reminder: Reminder): NewEvent[] =>
    inbox
      .itemsForCard(reminder.cardId)
      .filter((item): item is NoticeInboxItem => item.kind === "notice" && item.notice === "reminder_due" && item.pinned)
      .map((item) => inbox.buildUpdate(item, inbox.isProcessed(item) ? { pinned: false } : { pinned: false, archived: true }).event);

  /** 到点（或者晚了才到点） */
  const fire = (reminderId: string) => {
    const reminder = getReminder(store.reader, reminderId);
    const now = nowDate();
    // 已经取消、或者改到了更晚（调度器里的旧计时器）、不是到点提醒的：不响
    if (!reminder || reminder.status !== "pending" || !reminder.schedule || reminder.nextAt === undefined || new Date(reminder.nextAt).getTime() > now.getTime()) return;
    // 重复提醒错过多次只按最近一次
    const { due } = latestOccurrence(reminder.schedule, new Date(reminder.nextAt), now, scheduleContext());
    const lateMinutes = Math.floor((now.getTime() - due.getTime()) / MINUTE);
    const missed = lateMinutes > (options.lateLimitMinutes ?? DEFAULT_REMINDER_THRESHOLDS.lateLimitMinutes);
    const repeating = isRepeating(reminder.schedule);
    const next = repeating ? nextOccurrence(reminder.schedule, now, scheduleContext()) : undefined;
    const at = nowIso(now);
    const after: Reminder = {
      ...withoutNextAt(reminder),
      status: repeating ? "pending" : "fired",
      ...(next ? { nextAt: nowIso(next) } : {}),
      lastFiredAt: nowIso(due),
      updatedAt: at,
    };
    const when = describeTime(due);
    const late = lateMinutes >= 1 ? lateMinutes : undefined;
    const item = missed
      ? inbox.buildAdd({
          kind: "notice",
          notice: "missed_reminder",
          title: t("reminders.missed.title", { text: reminder.text }),
          body: t("reminders.missed.body", { when, late: describeDuration(lateMinutes) }),
          source: t("reminders.source"),
          urgency: "non_blocking",
          actions: [GOT_IT],
          cardId: reminder.cardId,
        })
      : inbox.buildAdd({
          kind: "notice",
          notice: "reminder_due",
          title: t("reminders.due.title", { text: reminder.text }),
          body: late === undefined ? t("reminders.due.body", { when }) : t("reminders.due.bodyLate", { when, late: describeDuration(late) }),
          source: t("reminders.source"),
          urgency: "non_blocking",
          pinned: true,
          actions: [GOT_IT],
          cardId: reminder.cardId,
        });
    store.appendBatch([
      reminderEvent(after, missed ? "missed" : "fired", "system", late),
      cardEvent(after, repeating ? {} : { status: "expired" }),
      ...retirePinned(reminder),
      item.event,
    ]);
    // 错过的不弹页面提示和浏览器通知，只放进待我处理
    if (!missed) inbox.alert(item.item);
  };

  /** 事件发生时提醒的：这次事件来了，发一条通知（和到点一样：待我处理里置顶一条、推一条 notify；提醒一直待触发） */
  const fireOnEvent = (reminderId: string, event: TriggerEvent, idempotencyKey: string) => {
    const reminder = getReminder(store.reader, reminderId);
    if (!reminder || reminder.status !== "pending" || !reminder.event || store.eventByIdempotencyKey(idempotencyKey)) return;
    const at = nowIso(nowDate());
    const after: Reminder = { ...reminder, lastFiredAt: event.at, lastEvent: event.summary, updatedAt: at };
    const item = inbox.buildAdd({
      kind: "notice",
      notice: "reminder_due",
      title: t("reminders.due.title", { text: reminder.text }),
      body: reminderText.eventBody(event.summary, event.at),
      source: t("reminders.source"),
      urgency: "non_blocking",
      pinned: true,
      actions: [GOT_IT],
      cardId: reminder.cardId,
    });
    store.appendBatch([{ ...reminderEvent(after, "fired", "system"), idempotencyKey }, cardEvent(after), ...retirePinned(reminder), item.event]);
    inbox.alert(item.item);
  };

  /** 按提醒的最新状态登记或取消调度 */
  const reschedule = (reminder: Reminder) => {
    if (reminder.status === "pending" && reminder.nextAt !== undefined) {
      scheduler.schedule(schedulerKey(reminder.id), new Date(reminder.nextAt).getTime(), () => fire(reminder.id));
    } else {
      scheduler.cancel(schedulerKey(reminder.id));
    }
  };

  return {
    create(input, by) {
      const { reminder, events } = built(input, by);
      store.appendBatch(events);
      return { reminder, cardId: reminder.cardId };
    },
    createFromUser(input, idempotencyKey) {
      const done = store.eventByIdempotencyKey(idempotencyKey);
      if (done) return { reminderId: (done.payload as ReminderEventPayload).reminder.id };
      try {
        const { reminder, events } = built(input, "user");
        store.appendBatch([{ ...events[0]!, idempotencyKey }, ...events.slice(1)]);
        return { reminderId: reminder.id };
      } catch (err) {
        if (err instanceof ReminderInputError) throw new RequestRejected("bad_params", err.message);
        throw err;
      }
    },
    update(reminderId, edit, by) {
      const reminder = edited(reminderId, edit);
      store.appendBatch([reminderEvent(reminder, "updated", by), cardEvent(reminder)]);
      return { reminder, cardId: reminder.cardId };
    },
    cancel(reminderId, by) {
      const { reminder, events } = cancelEvents(cancelled(reminderId), by);
      store.appendBatch(events);
      return { reminder, cardId: reminder.cardId };
    },
    editFromCard(reminderId, edit) {
      const reminder = edited(reminderId, edit);
      return { status: "pending", payload: cardPayloadOf(reminder), events: [reminderEvent(reminder, "updated", "user")] };
    },
    cancelFromCard(reminderId) {
      const reminder = cancelled(reminderId);
      return { status: "handled", payload: cardPayloadOf(reminder), events: [reminderEvent(reminder, "cancelled", "user")] };
    },
    archive(reminderId, by) {
      const { reminder, events } = archiveEvents(reminderId, by);
      store.appendBatch(events);
      return { reminder, cardId: reminder.cardId };
    },
    remove(reminderId, by) {
      const { reminder, events } = removeEvents(reminderId, by);
      store.appendBatch(events);
      return { reminder, cardId: reminder.cardId };
    },
    buildRemove: removeEvents,
    act(params, idempotencyKey) {
      const results = params.reminderIds.map((reminderId): ReminderActionItemResult => {
        const key = actionItemKey(idempotencyKey, reminderId);
        // 同一个键重发：做成了的拿到同一个结果，没做成的再试一次
        const done = store.eventByIdempotencyKey(key);
        if (done) return doneItem((done.payload as ReminderEventPayload).reminder);
        try {
          const made =
            params.action === "archive" ? archiveEvents(reminderId, "user") : params.action === "delete" ? removeEvents(reminderId, "user") : cancelEvents(cancelled(reminderId), "user");
          const [first, ...rest] = made.events;
          store.appendBatch([{ ...first!, idempotencyKey: key }, ...rest]);
          return doneItem(made.reminder);
        } catch (err) {
          if (err instanceof RequestRejected) return { reminderId, ok: false, code: err.code, message: err.message };
          options.log?.(`对提醒 ${reminderId} 做 ${params.action} 时出错：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`); // @i18n-ignore log
          return { reminderId, ok: false, code: "internal", message: t("reminders.actionInternal") };
        }
      });
      return { results };
    },
    fireOnEvent,
    get: (reminderId) => getReminder(store.reader, reminderId),
    pending: () => listReminders(store.reader, "pending"),
    list: living,
    calendar(from, to) {
      const since = new Map<string, string>();
      const schedules = new Map<string, string>();
      const firings = new Map<string, ReminderFiring[]>();
      // 触发记录和时间表的改动只在事件里（视图只留最新的样子）：按先后走一遍这些提醒的事件
      for (const event of store.read(CHANNELS.board, 0, EVENT_TYPES.reminder)) {
        if (isDeletedEventPayload(event.payload)) continue;
        const { reminder, change, lateMinutes } = event.payload as ReminderEventPayload;
        // 事件发生时提醒的不上日历
        if (!reminder.schedule) continue;
        const schedule = JSON.stringify(reminder.schedule);
        if (schedules.get(reminder.id) !== schedule) since.set(reminder.id, change === "created" ? reminder.createdAt : reminder.updatedAt);
        schedules.set(reminder.id, schedule);
        if ((change !== "fired" && change !== "missed") || reminder.lastFiredAt === undefined) continue;
        const due = Date.parse(reminder.lastFiredAt);
        if (due < from.getTime() || due >= to.getTime()) continue;
        firings.set(reminder.id, [...(firings.get(reminder.id) ?? []), { dueAt: reminder.lastFiredAt, change, ...(lateMinutes === undefined ? {} : { lateMinutes }) }]);
      }
      return listReminders(store.reader)
        // 取消了的、删了的（185 号票）不上日历
        .filter((r): r is Reminder & { schedule: ReminderSchedule } => r.status !== "cancelled" && r.status !== "deleted" && r.schedule !== undefined)
        .map((reminder) => ({
          reminder,
          since: since.get(reminder.id) ?? reminder.createdAt,
          occurrences: occurrencesBetween(reminder.schedule, from, to, scheduleContext()).map((d) => nowIso(d)),
          firings: firings.get(reminder.id) ?? [],
        }));
    },
    recalculate() {
      const now = nowDate();
      for (const reminder of listReminders(store.reader, "pending")) {
        // 只有跟着工作日历变的才重算；已经到点、正等着触发的不动（触发时按当时的工作日历算下一次）
        if (!reminder.schedule || !dependsOnWorkdayCalendar(reminder.schedule) || reminder.nextAt === undefined || new Date(reminder.nextAt).getTime() <= now.getTime()) continue;
        const next = nextOccurrence(reminder.schedule, now, scheduleContext());
        const nextAt = next ? nowIso(next) : undefined;
        if (nextAt === reminder.nextAt) continue;
        const after: Reminder = { ...withoutNextAt(reminder), ...(nextAt === undefined ? {} : { nextAt }), updatedAt: nowIso(now) };
        store.appendBatch([reminderEvent(after, "updated", "system"), cardEvent(after)]);
      }
    },
    start() {
      unsubscribe = store.onAppend((e) => {
        if (e.channel === CHANNELS.board && e.type === EVENT_TYPES.reminder) reschedule((e.payload as ReminderEventPayload).reminder);
      });
      for (const reminder of listReminders(store.reader, "pending")) reschedule(reminder);
    },
    stop() {
      unsubscribe?.();
      for (const reminder of listReminders(store.reader, "pending")) scheduler.cancel(schedulerKey(reminder.id));
    },
  };
}
