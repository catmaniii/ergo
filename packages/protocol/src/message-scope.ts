// 消息归属（schema.ts 的 MessageScope：任务、项目、阶段、agent，284 号票起还有了解你访谈）的取值，不引用 TypeBox（Web 也用）。
// 消息事件、历史分页里的一条、时间线记录都把归属的几个字段摊开带着；守护进程写事件、Web 状态层读事件都经这里取，
// 只留有值的字段（事件负载里不写 undefined）。
import type { MessageScope } from "./schema.ts";

/** 归属的几个字段（MessageScope 的键） */
export const MESSAGE_SCOPE_KEYS = ["taskId", "projectId", "stageId", "scheduledJobId", "agentId", "interviewId", "interviewQuestion"] as const satisfies readonly (keyof MessageScope)[];

/** 从带着归属字段的东西（消息事件、历史分页里的一条、时间线记录、守护进程的消息范围）里取出归属：只留有值的字段 */
export function pickMessageScope(source: { readonly [K in keyof MessageScope]?: string | undefined }): MessageScope {
  const scope: MessageScope = {};
  for (const key of MESSAGE_SCOPE_KEYS) {
    const value = source[key];
    if (value !== undefined) scope[key] = value;
  }
  return scope;
}
