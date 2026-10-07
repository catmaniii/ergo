// 守卫的写法和前端协议的写法之间的对照（边界）：守卫的六档处置（log_only、notify_after……）是守卫自己的词，
// 前端协议、计划、设置页的请求里是协议的写法（do、do_then_tell……）。守卫接入、任务、关注类别设置都从这里换，
// 守卫本身不引用协议包。
import type { Disposition as WireDisposition } from "@ergou/protocol";
import type { Disposition } from "../guard/index.ts";

/** 守卫的六档处置 → 前端协议里的写法 */
export const WIRE_DISPOSITION: Readonly<Record<Disposition, WireDisposition>> = Object.freeze({
  log_only: "do",
  notify_after: "do_then_tell",
  plan_listed: "planned_only",
  ask_first: "ask_first",
  hand_over: "hand_to_me",
  never: "never",
});

/** 前端协议里的写法 → 守卫的六档处置（计划、设置页的请求里是协议的写法） */
export const GUARD_DISPOSITION: Readonly<Record<WireDisposition, Disposition>> = Object.freeze(
  Object.fromEntries(Object.entries(WIRE_DISPOSITION).map(([guard, wire]) => [wire, guard])) as Record<WireDisposition, Disposition>,
);
