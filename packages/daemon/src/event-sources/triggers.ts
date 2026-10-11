// 事件触发的分发（77 号票，ADR 0025）：谁在等事件、事件来了交给谁。
// - 订阅：每个事件触发的任务的触发登记（运营中、已暂停的；看板频道的 scheduled_job，event 不空）和每条事件发生时提醒的简单提醒
//   （待触发的；看板频道的 reminder，event 不空）。它们一变就重新算一遍，按来源分好交给各来源的实现（sync：开始盯新的，停掉不要的）；
// - 交出：来源推来一次事件，暂停着的不交；事件触发的任务交给触发底座（ScheduledJobs.fire：没在跑的起一次运行，上一次还没跑完的排队合并），
//   简单提醒发一条通知（ReminderService.fireOnEvent）。去重键是订阅加上来源给的键：同一次事件重推、开机比对补发都只收一次；
// - 检查：建任务、建提醒时事件触发方式对不对——先查登记表（来源、事件、过滤条件的键和类型、必填的），再让来源的实现现查（文件夹在不在、能不能监视）。
// 以后接邮件、webhook：登记表里加一项，sources.ts 里加它的实现，别的不用动。
import { CHANNELS, type EventTrigger, eventTriggerProblems, EVENT_TYPES } from "@ergou/protocol";
import type { EventStore } from "../events/event-store.ts";
import type { ReminderService } from "../reminders/reminders.ts";
import { listReminders } from "../reminders/views.ts";
import type { ScheduledJobs } from "../scheduled-jobs/index.ts";
import { listJobs } from "../scheduled-jobs/index.ts";
import { errorText, triggerText } from "./texts.ts";
import type { EventSourceContext, EventSourceImpl, EventSubscription, SourceEvent } from "./types.ts";

export interface EventTriggersOptions {
  store: EventStore;
  scheduledJobs: Pick<ScheduledJobs, "fire">;
  reminders: Pick<ReminderService, "fireOnEvent">;
  /** 各来源的实现（拿着推事件的口子建出来） */
  sources: (ctx: EventSourceContext) => EventSourceImpl[];
  log: (line: string) => void;
}

export interface EventTriggers {
  /** 事件触发方式对不对：不对的原因（建事件触发的任务、事件发生时提醒的简单提醒时查） */
  check(trigger: EventTrigger): string[];
  /** 触发底座、简单提醒都起来之后：按现在的订阅开始盯，之后跟着订阅的变化 */
  start(): void;
  stop(): void;
  /** 现在的订阅（测试、日志看） */
  subscriptions(): EventSubscription[];
  /** 各来源看到了、还在等安静的变化一共几处（测试等文件夹的变化被看到了再拨时钟） */
  pending(): number;
}

/** 交出去的去重键：订阅加上来源给的键 */
export const deliverKey = (subId: string, key: string) => `event:${subId}:${key}`;

export function createEventTriggers(options: EventTriggersOptions): EventTriggers {
  const { store, log } = options;
  let current = new Map<string, EventSubscription>();
  let resyncQueued = false;
  let unsubscribe: (() => void) | undefined;
  let stopped = false;

  /** 来源推来一次事件：订阅还在、在运营的才交出去 */
  const emit = (sub: EventSubscription, event: SourceEvent) => {
    const now = current.get(sub.id);
    if (!now?.active) return;
    const { key, ...trigger } = event;
    if (now.kind === "task" && now.taskId !== undefined) {
      const outcome = options.scheduledJobs.fire(now.taskId, trigger, deliverKey(now.id, key));
      if (outcome.outcome === "ignored") log(triggerText.notDelivered(trigger.summary, now.id, outcome.reason));
      return;
    }
    if (now.kind === "reminder") options.reminders.fireOnEvent(now.id, trigger, deliverKey(now.id, key));
  };

  const sources = options.sources({ emit, log });

  /** 现在的订阅：事件触发的任务的触发登记（运营中、已暂停的）、事件发生时提醒的简单提醒（待触发的） */
  const subscriptionsNow = (): EventSubscription[] => [
    ...listJobs(store.reader, ["active", "paused"]).flatMap((job): EventSubscription[] =>
      job.event && job.ownerTaskId !== undefined
        ? [{ id: job.id, kind: "task", trigger: job.event, taskId: job.ownerTaskId, ...(job.projectId === undefined ? {} : { projectId: job.projectId }), active: job.state === "active" }]
        : [],
    ),
    ...listReminders(store.reader, "pending").flatMap((r): EventSubscription[] => (r.event ? [{ id: r.id, kind: "reminder", trigger: r.event, active: true }] : [])),
  ];

  const resync = () => {
    resyncQueued = false;
    if (stopped) return;
    const subs = subscriptionsNow();
    current = new Map(subs.map((s) => [s.id, s]));
    for (const source of sources) {
      try {
        source.sync(subs.filter((s) => s.trigger.source === source.id));
      } catch (err) {
        log(triggerText.syncError(source.id, errorText(err)));
      }
    }
  };

  const scheduleResync = () => {
    if (resyncQueued || stopped) return;
    resyncQueued = true;
    queueMicrotask(resync);
  };

  return {
    check(trigger) {
      const problems = eventTriggerProblems(trigger);
      if (problems.length > 0) return problems;
      const source = sources.find((s) => s.id === trigger.source);
      return source ? source.check(trigger) : [triggerText.sourceMissing(trigger.source)];
    },
    start() {
      // 触发登记、简单提醒一变（登记、暂停、恢复、取消、改成到点提醒……）就重新算订阅（同一轮里的几次合成一次）
      unsubscribe = store.onAppend((e) => {
        if (e.channel === CHANNELS.board && (e.type === EVENT_TYPES.scheduledJob || e.type === EVENT_TYPES.reminder)) scheduleResync();
      });
      resync();
    },
    stop() {
      stopped = true;
      unsubscribe?.();
      for (const source of sources) source.stop();
    },
    subscriptions: () => [...current.values()],
    pending: () => sources.reduce((n, s) => n + (s.pending?.() ?? 0), 0),
  };
}
