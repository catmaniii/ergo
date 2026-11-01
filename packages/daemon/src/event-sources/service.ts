// 项目的服务报的事件（357 号票，来源编号 service，ADR-0043）：项目自己的服务（不用大模型，一直盯着数据）发现要紧的事，经本机接口报一个事件，
// 叫醒等这个事件的任务——只能是运营方案里写了、用户确认过的（这个来源 planOnly，别的入口建不出等它的任务），只认同一个项目的。
// - 这里（"前台"）只管等它的订阅和把事件交出去：谁在报（凭证）、限速、大小上限、最近收到的记录在运营层（project-services/service-events.ts）；
// - 登记表里只算一种事件（reported），事件名写在过滤条件 name 里，一字不差才算等它；一个名字可以有几个任务等；
// - 没人等、等它的任务全暂停着：什么都不交，不叫醒任何 agent（现在能报哪些名字由调用方写进错误）；
// - 交出去走分发的同一个口子（triggers.ts → ScheduledJobs.fire）：排队合并、不并行、连续失败自动暂停都照旧。去重键每次报都是新的：
//   服务连报两次就是两个事件；
// - 没有比对底子、不补发：守护进程停着时服务报不进来（接口连不上），由服务自己处理。
import { type EventTrigger, filterValue, SERVICE_EVENT_NAME_FILTER, SERVICE_EVENT_NAME_MAX, SERVICE_EVENT_SOURCE, SERVICE_REPORTED_EVENT, serviceEventNameOf } from "@ergo/protocol";
import { serviceRefusal, serviceSummary } from "./texts.ts";
import type { DeliveringContext, EventSourceImpl, EventSubscription } from "./types.ts";

/** 一次报事件（已经核过凭证、限速、大小） */
export interface ServiceReport {
  projectId: string;
  /** 负责人写的服务名（事件里的"服务名"） */
  service: string;
  /** 运营方案里这一条的名字（一句话说明里写它） */
  title: string;
  /** 事件名 */
  name: string;
  /** 服务带来的数据（任意 JSON）；没带的不写 */
  data?: unknown;
  /** 收到的时刻（协议时间） */
  at: string;
  /** 这一次报的编号（去重键的一部分：每次报都不一样） */
  key: string;
}

/** 交没交出去 */
export type ServiceDelivery =
  /** 这个项目现在没有等这个名字的任务（names 是现在能报的） */
  | { outcome: "no_waiter"; names: string[] }
  /** 等它的任务全暂停着 */
  | { outcome: "paused"; names: string[] }
  /** 交出去了：每个接了的任务一次运行（并进排着的那一次的算 merged）；一个都没接的 runs 是空的，reasons 写为什么 */
  | { outcome: "delivered"; runs: Array<{ taskId: string; runId: string; merged: boolean }>; reasons: string[] };

export interface ServiceEventDesk {
  /** 接进事件触发的分发（sources.ts 建来源的实现时叫） */
  attach(ctx: DeliveringContext): EventSourceImpl;
  /** 这个项目现在能报哪些名字（运营方案里写了、任务还在的；暂停着的也算：名字没错，只是这会儿不接） */
  names(projectId: string): string[];
  /** 交出一次报的事件 */
  deliver(report: ServiceReport): ServiceDelivery;
}

/** 这个项目里的这个订阅等的名字（简单提醒这类别的订阅方建不出这个来源的订阅，这里再挡一下） */
const waiting = (sub: EventSubscription, projectId: string): string | undefined => (sub.kind === "task" && sub.projectId === projectId ? serviceEventNameOf(sub.trigger) : undefined);

export function createServiceEventDesk(): ServiceEventDesk {
  let subs: readonly EventSubscription[] = [];
  let ctx: DeliveringContext | undefined;

  const names = (projectId: string): string[] => [...new Set(subs.flatMap((s) => waiting(s, projectId) ?? []))].toSorted();

  return {
    attach(context) {
      ctx = context;
      return {
        id: SERVICE_EVENT_SOURCE,
        check(trigger: EventTrigger) {
          const name = filterValue(trigger, SERVICE_EVENT_NAME_FILTER);
          if (typeof name !== "string") return [];
          if (/[\r\n]/.test(name)) return [serviceRefusal.nameOneLine()];
          return name.length > SERVICE_EVENT_NAME_MAX ? [serviceRefusal.nameTooLong(name, SERVICE_EVENT_NAME_MAX)] : [];
        },
        sync(next) {
          subs = next;
        },
        stop() {
          subs = [];
          ctx = undefined;
        },
      };
    },

    names,

    deliver(report) {
      const mine = subs.filter((s) => waiting(s, report.projectId) === report.name);
      if (mine.length === 0 || !ctx) return { outcome: "no_waiter", names: names(report.projectId) };
      const active = mine.filter((s) => s.active);
      if (active.length === 0) return { outcome: "paused", names: names(report.projectId) };
      const event = {
        source: SERVICE_EVENT_SOURCE,
        event: SERVICE_REPORTED_EVENT,
        at: report.at,
        summary: serviceSummary(report.title, report.name),
        data: { name: report.name, service: report.service, ...(report.data === undefined ? {} : { data: report.data }) },
        key: report.key,
      };
      const runs: Array<{ taskId: string; runId: string; merged: boolean }> = [];
      const reasons: string[] = [];
      for (const sub of active) {
        const delivered = ctx.deliver(sub, event);
        if (delivered.outcome === "queued" || delivered.outcome === "merged") runs.push({ taskId: sub.taskId ?? sub.id, runId: delivered.runId, merged: delivered.outcome === "merged" });
        else if (delivered.outcome === "ignored") reasons.push(delivered.reason);
      }
      return { outcome: "delivered", runs, reasons };
    },
  };
}
