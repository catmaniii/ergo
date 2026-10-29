// 事件触发方式的 schema（77 号票，ADR 0025），用 TypeBox 定义：任务的触发方式、简单提醒、触发登记里都是这一个。
// 来源、事件、过滤条件有哪些看登记表（event-sources.ts 的 EVENT_SOURCES）；这里只管形状，写得对不对由 eventTriggerProblems 和守护进程查。
import { type Static, Type } from "typebox";

/**
 * 事件发生时（ADR 0025 的事件触发）：哪个来源（登记表里的编号）、要哪几种事件（至少一种）、过滤条件（键是来源登记的过滤条件：
 * 二狗内部事件的 taskId、projectId；本机文件夹的 path、recursive、pattern）
 */
export const EventTrigger = Type.Object({
  kind: Type.Literal("event"),
  source: Type.String({ minLength: 1 }),
  events: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 20 }),
  filter: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String({ maxLength: 1000 }), Type.Boolean()]))),
});
export type EventTrigger = Static<typeof EventTrigger>;
