// 任务模块在事件日志里的事件（规格第 4、8 节）。
// - 任务看板频道（board，前端订阅）：task 事件 = 任务的最新状态 + 这次的变化 + 谁改的（负载 TaskEventPayload 在共享协议包）；
// - 守护进程内部的 tasks 频道（前端不订阅）：任务书、维护者提交的计划、用户对计划的决定。计划是业务状态，存在这里，
//   不在 pi 会话里；前端看到的是计划卡（由代码从结构化计划生成）。
import { EVENT_TYPES, type GrantInfo, type Plan, type PlanGrant, type PlanWatchCategory, type TaskBrief } from "@ergou/protocol";

export type { TaskBrief };

export const TASKS_CHANNEL = "tasks";

export const TASK_EVENTS = {
  /** 秘书写了（或改了）任务书：运行时同一事务把它交给执行的维护者 */
  briefWritten: "task_brief",
  /** 执行的维护者提交了一版计划（同一事务建计划卡、放进待我处理、任务转待确认） */
  planSubmitted: "plan_submitted",
  /** 用户在计划卡上确认或打回（和卡片更新同一事务）；"审批决定"素材的来源，事件类型登记在共享协议包 */
  planDecided: EVENT_TYPES.planDecided,
} as const;

export interface TaskBriefPayload {
  taskId: string;
  brief: TaskBrief;
  /** 第几版任务书（秘书改了就加 1） */
  revision: number;
  time: string;
}

export interface PlanSubmittedPayload {
  taskId: string;
  planId: string;
  /** 第几版计划（打回后重新提交加 1） */
  revision: number;
  /** 检查过、补全了的计划（全局关注类别的名字由运行时补上） */
  plan: Plan;
  /** 由它生成的计划卡 */
  cardId: string;
  /** 起草它的维护者 */
  maintainerId: string;
  time: string;
}

export type PlanDecision = "confirmed" | "rejected";

export interface PlanDecidedPayload {
  taskId: string;
  taskTitle: string;
  planId: string;
  revision: number;
  cardId: string;
  decision: PlanDecision;
  /** 确认的那份计划（勾掉、收窄之后）；打回时没有 */
  plan?: Plan;
  /** 确认时勾掉的授权项（原样，和计划卡负载里的同名同形） */
  removedGrants: PlanGrant[];
  /** 确认时收窄了的授权项 id（收窄后的样子在 plan 里） */
  narrowedGrants: string[];
  /** 每项授权在守卫眼里的样子（素材里的说法和计划卡上一样，由它生成） */
  grantInfo: Record<string, GrantInfo>;
  /** 确认时改了假设栏：改之前和改之后 */
  assumptions?: { before: string[]; after: string[] };
  /** 确认时在卡上给这个任务加的关注类别（确定的规则和处置，用户自己写的；26 号票） */
  addedCategories?: PlanWatchCategory[];
  /** 打回的意见（用户自己的话） */
  note?: string;
  /** 做决定的是用户 */
  by: "user";
  time: string;
}
