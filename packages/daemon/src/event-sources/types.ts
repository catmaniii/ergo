// 事件来源的实现要守的形状（77 号票）：登记表（协议包 event-sources.ts）里的每个来源在守护进程里有一份实现，
// 由事件触发的分发（triggers.ts）按订阅交给它去盯，它推来的事件再由分发交给触发底座或简单提醒。
import type { EventTrigger, TriggerEvent } from "@ergo/protocol";

/**
 * 一个订阅：一个事件触发的任务（它的触发登记 j-N）或一条事件发生时提醒的简单提醒（r-N）在等的事件。
 * 暂停着的照样盯着（文件夹的比对底子跟着更新，恢复时不会把暂停期间的变化一股脑补上），事件不交出去
 */
export interface EventSubscription {
  /** 订阅的编号：触发登记的 j-N，简单提醒的 r-N */
  id: string;
  /** task 是事件触发的任务；别的是登记的订阅方（126 号票：提醒插件登记的 reminder） */
  kind: string;
  trigger: EventTrigger;
  /** 事件触发的任务：它自己（自己的事不触发自己） */
  taskId?: string;
  /** 项目内部的任务：它所在的项目（项目内部的事只交给同一个项目里的、或者点名要它的订阅） */
  projectId?: string;
  active: boolean;
}

/** 来源推来的一次事件：交给触发底座的那一条，加上来源给的去重键（同一次变化重推、重启后比对补发都只收一次） */
export interface SourceEvent extends TriggerEvent {
  key: string;
}

/** 来源推事件、记日志用的 */
export interface EventSourceContext {
  /** 这个订阅等的事件来了 */
  emit(sub: EventSubscription, event: SourceEvent): void;
  log(line: string): void;
}

/** 登记表里一个来源在守护进程里的实现 */
export interface EventSourceImpl {
  /** 登记表里的编号 */
  readonly id: string;
  /** 过滤条件现查（文件夹在不在、能不能监视……）：不对的原因；登记表能查的（来源、事件、键、类型、必填）分发那边先查过了 */
  check(trigger: EventTrigger): string[];
  /** 现在要盯的订阅（只有这个来源的，每次都是全量）：开始盯新来的，停掉不要了的 */
  sync(subs: readonly EventSubscription[]): void;
  /** 看到了、还在等安静的变化有几处（文件夹变化的合成一次；测试等它看到了再拨时钟） */
  pending?(): number;
  stop(): void;
}
