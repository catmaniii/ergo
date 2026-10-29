// 事件触发的分发（77 号票，ADR 0025）：谁在等事件、事件来了交给谁。
// - 订阅：每个事件触发的任务的触发登记（运营中、已暂停的；看板频道的 scheduled_job，event 不空），加上别的订阅方登记的
//   （126 号票：订阅方登记表 EventSubscriberRegistry；提醒插件登记每条事件发生时提醒的简单提醒——待触发的、看板频道的 reminder、
//   event 不空）。它们一变就重新算一遍，按来源分好交给各来源的实现（sync：开始盯新的，停掉不要的）；订阅方登记、撤掉时也重算；
// - 交出：来源推来一次事件，暂停着的不交；事件触发的任务交给触发底座（ScheduledJobs.fire：没在跑的起一次运行，上一次还没跑完的排队合并），
//   别的订阅交给登记它的订阅方（简单提醒发一条通知：ReminderService.fireOnEvent）。去重键是订阅加上来源给的键：同一次事件重推、开机比对补发都只收一次；
// - 检查：建任务、建提醒时事件触发方式对不对——先查登记表（来源、事件、过滤条件的键和类型、必填的），再让来源的实现现查（文件夹在不在、能不能监视）。
// 以后接邮件、webhook：登记表里加一项，sources.ts 里加它的实现，别的不用动。
import { CHANNELS, type EventTrigger, eventTriggerProblems, EVENT_TYPES, isNameOrOld, type TriggerEvent } from "@ergo/protocol";
import type { EventStore, StoredEvent } from "../events/event-store.ts";
import type { ScheduledJobs } from "../scheduled-jobs/index.ts";
import { listJobs } from "../scheduled-jobs/index.ts";
import { errorText, sourceMissingText, triggerText } from "./texts.ts";
import type { EventSourceContext, EventSourceImpl, EventSubscription, SourceEvent } from "./types.ts";

/** 事件触发任务之外的一种订阅方（126 号票：插件经插件宿主登记，停用时撤掉） */
export interface EventSubscriberKind {
  /** 订阅的种类（EventSubscription.kind），比如 reminder；task 是内核的 */
  kind: string;
  /** 现在的订阅（每次都是全量） */
  subscriptions(): EventSubscription[];
  /** 哪些新事件一来就要重算订阅（比如提醒变了） */
  watches(event: StoredEvent): boolean;
  /** 这个订阅等的事件来了（订阅还在、在运营的才交过来）；key 是去重键 */
  deliver(sub: EventSubscription, trigger: TriggerEvent, key: string): void;
}

/** 订阅方登记表：按登记的先后；同一种只能登记一次 */
export class EventSubscriberRegistry {
  private readonly kinds: EventSubscriberKind[] = [];
  private readonly listeners = new Set<() => void>();

  /** 登记一种订阅方；返回撤销函数。登记、撤掉都告诉分发重算订阅 */
  register(kind: EventSubscriberKind): () => void {
    if (kind.kind === "task" || this.kinds.some((k) => k.kind === kind.kind)) throw new Error(`事件触发的订阅方 ${kind.kind} 已经登记过了`); // @i18n-ignore log：编程错误
    this.kinds.push(kind);
    this.changed();
    return () => {
      const at = this.kinds.indexOf(kind);
      if (at < 0) return;
      this.kinds.splice(at, 1);
      this.changed();
    };
  }

  list(): readonly EventSubscriberKind[] {
    return [...this.kinds];
  }

  /** 登记、撤掉时叫 fn；返回取消 */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed() {
    for (const fn of this.listeners) fn();
  }
}

export interface EventTriggersOptions {
  store: EventStore;
  scheduledJobs: Pick<ScheduledJobs, "fire">;
  /** 事件触发任务之外的订阅方（不给是没有） */
  subscribers?: EventSubscriberRegistry;
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
  const subscribers = options.subscribers ?? new EventSubscriberRegistry();
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
    subscribers
      .list()
      .find((k) => k.kind === now.kind)
      ?.deliver(now, trigger, deliverKey(now.id, key));
  };

  const sources = options.sources({ emit, log });

  /** 现在的订阅：事件触发的任务的触发登记（运营中、已暂停的），再是各订阅方的（事件发生时提醒的简单提醒：待触发的） */
  const subscriptionsNow = (): EventSubscription[] => [
    ...listJobs(store.reader, ["active", "paused"]).flatMap((job): EventSubscription[] =>
      job.event && job.ownerTaskId !== undefined
        ? [{ id: job.id, kind: "task", trigger: job.event, taskId: job.ownerTaskId, ...(job.projectId === undefined ? {} : { projectId: job.projectId }), active: job.state === "active" }]
        : [],
    ),
    ...subscribers.list().flatMap((k) => k.subscriptions()),
  ];

  const resync = () => {
    resyncQueued = false;
    if (stopped) return;
    const subs = subscriptionsNow();
    current = new Map(subs.map((s) => [s.id, s]));
    for (const source of sources) {
      try {
        // 312 号票：存着的旧来源编号（ergo 以前的写法）照样交给它
        source.sync(subs.filter((s) => isNameOrOld(s.trigger.source, source.id)));
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
      const source = sources.find((s) => isNameOrOld(trigger.source, s.id));
      return source ? source.check(trigger) : [sourceMissingText(trigger.source)];
    },
    start() {
      // 触发登记、各订阅方的东西一变（登记、暂停、恢复、取消、改成到点提醒……）就重新算订阅（同一轮里的几次合成一次）；
      // 订阅方登记、撤掉（插件停用）时也重算
      const offAppend = store.onAppend((e) => {
        if ((e.channel === CHANNELS.board && e.type === EVENT_TYPES.scheduledJob) || subscribers.list().some((k) => k.watches(e))) scheduleResync();
      });
      const offKinds = subscribers.onChange(scheduleResync);
      unsubscribe = () => {
        offAppend();
        offKinds();
      };
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
