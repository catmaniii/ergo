// 项目模块在事件日志里的事件（规格第 4、11 节）。
// - 项目列表频道（projects，前端订阅）：project 事件 = 项目的最新状态 + 这次的变化 + 谁改的（负载 ProjectEventPayload 在共享协议包）；
// - 守护进程内部的 charters 频道（前端不订阅）：维护者交出的立项书、用户在立项书卡上的确认。立项书是业务状态，存在这里，
//   不在 pi 会话里；前端看到的是立项书卡（由代码从结构化的立项书生成）。
import { type Charter, EVENT_TYPES, type PlanToolkit } from "@ergou/protocol";

export const CHARTERS_CHANNEL = "charters";

export const CHARTER_EVENTS = {
  /** 维护者交出了一版立项书（同一事务建立项书卡、放进待我处理、旧的那张过期） */
  submitted: "charter_submitted",
  /** 用户在立项书卡上确认（和卡片更新同一事务）；"用户对产出的反应"素材的来源，事件类型登记在共享协议包 */
  decided: EVENT_TYPES.charterDecided,
} as const;

export interface CharterSubmittedPayload {
  projectId: string;
  /** 第几版立项书 */
  revision: number;
  charter: Charter;
  /** 维护者提议的工具包（开发类默认带 bash，已补上） */
  toolkit: PlanToolkit;
  cardId: string;
  maintainerId: string;
  time: string;
}

export interface CharterDecidedPayload {
  projectId: string;
  projectName: string;
  revision: number;
  cardId: string;
  /** 确认并开工（start），还是只确认、稍后开工（later） */
  decision: "start" | "later";
  charter: Charter;
  toolkit: PlanToolkit;
  /** 开工时建出的首个建设任务 */
  buildTaskId?: string;
  /** 用户确认时附的说明（用户自己的话） */
  note?: string;
  by: "user";
  time: string;
}
