// 前端协议里状态层要用到的形状，按规格第 5 节先在这里手写一份。
// 04 号票在共享协议包里用 TypeBox 定义正式的 schema 后，这个文件改成从 @ergou/protocol 取生成的类型，
// 状态层的函数和回放测试都不用改。

/** 事件帧：守护进程在某个频道上推给前端的一条事件 `{频道, 序号, 类型, 负载}`。序号在频道内从 1 递增。 */
export interface EventFrame {
  channel: string;
  seq: number;
  type: string;
  payload: unknown;
}

/**
 * 频道名。会话频道的名字就是会话 id：秘书会话是 `secretary`，某个维护者的会话是 `maintainer:<维护者 id>`。
 * 其余是全局频道：任务看板、项目列表、待我处理、卡片、活动状态。
 */
export const CHANNELS = {
  secretary: "secretary",
  board: "board",
  projects: "projects",
  inbox: "inbox",
  cards: "cards",
  activity: "activity",
} as const;

export function maintainerChannel(maintainerId: string): string {
  return `maintainer:${maintainerId}`;
}

/** 事件类型。状态层目前认识这两种，后面的票往这里加（看板、待我处理、活动状态……）。 */
export const EVENT_TYPES = {
  /** 会话频道：一条定稿的消息 */
  message: "message",
  /** 卡片频道：一张卡片的最新版本 */
  card: "card",
} as const;

/** 发言方：用户本人、agent（秘书或维护者）、系统（运行时追加的说明，比如"工具包已变更"）。 */
export type Speaker = "user" | "agent" | "system";

/** 消息信封：一条消息由若干 part 组成。 */
export interface MessageEnvelope {
  id: string;
  /** 所属会话，同时也是它所在的频道名 */
  conversation: string;
  speaker: Speaker;
  /** ISO 时间 */
  time: string;
  parts: MessagePart[];
}

/** 守卫对一次工具调用的处置（六档）。 */
export type Disposition = "do" | "do_then_tell" | "planned_only" | "ask_first" | "hand_to_me" | "never";

/** 工具调用的结果：放行执行完、正在执行、被拦下、问过用户后被拒、出错。 */
export type ToolCallOutcome = "running" | "done" | "blocked" | "denied" | "error";

/**
 * 消息的 part：形状对齐 AI SDK 的 UIMessage parts，但类型自己定义。
 * 语音、TTS 音频、视频第一阶段只预留，界面上显示为"第二阶段"的占位。
 */
export type MessagePart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "image"; mediaId: string; name: string; mime: string; width?: number; height?: number }
  | { type: "file"; mediaId: string; name: string; mime: string; size: number; asMaterial?: boolean }
  | { type: "voice"; mediaId: string; transcript: string }
  | { type: "tts_audio"; mediaId: string }
  | { type: "video"; mediaId: string }
  | {
      type: "tool_call";
      callId: string;
      /** 工具名（真实工具或从 bash 拆出的伪工具） */
      tool: string;
      /** 参数摘要（一行） */
      argsSummary: string;
      /** 命中的关注类别 id */
      watchCategories: string[];
      disposition: Disposition;
      /** 是否属于授权内 */
      withinGrant: boolean;
      /** 是否通用 bash（没有事先规定类型的 bash 调用） */
      genericBash: boolean;
      outcome: ToolCallOutcome;
      /** 结果摘要 */
      resultSummary?: string;
    }
  | { type: "card_ref"; cardId: string }
  /** 维护者会话的分段线：工单段带工单号；用户直接对话（含立项问答）开的"对话段"工单号为空 */
  | { type: "work_order_divider"; workOrderId: string; title: string; from: string };

/**
 * 第一阶段的 14 种卡片（规格第 5 节）。06 号票的卡片类型注册表建在这张表上。
 * 卡片实体的 type 仍是 string：服务端可能发来前端还不认识的类型，用 isCardType 收窄。
 */
export const CARD_TYPES = [
  "plan",
  "approval",
  "questions",
  "progress",
  "quick_action",
  "suggest_task",
  "suggest_project",
  "reminder",
  "charter",
  "work_order",
  "plan_change",
  "parallel",
  "memory_delete",
  "pairing",
] as const;

export type CardType = (typeof CARD_TYPES)[number];

export function isCardType(t: string): t is CardType {
  return (CARD_TYPES as readonly string[]).includes(t);
}

/** 卡片上的按钮动作（"对卡片做动作"请求里的动作名） */
export const CARD_ACTIONS = [
  "confirm",
  "reject",
  "approve",
  "deny",
  "answer",
  "ack",
  "execute",
  "cancel",
  "start_task",
  "kickoff",
  "dismiss",
  "save",
  "cancel_reminder",
  "confirm_start",
  "confirm_later",
  "dispatch",
  "return",
  "parallel",
  "sequential",
  "delete",
] as const;

export type CardAction = (typeof CARD_ACTIONS)[number];

/** 卡片状态：待处理、已处理、已关闭（用户关掉不处理）、已过期。 */
export type CardStatus = "pending" | "handled" | "dismissed" | "expired";

/** 紧急度三档：卡住任务且有时限、卡住任务、不卡任务。 */
export type Urgency = "blocking_deadline" | "blocking" | "non_blocking";

/** 卡片实体：消息里只放引用，状态只有一份，在聊天、待我处理、时间线里同步。 */
export interface Card {
  id: string;
  type: string;
  /** 每次状态变化加 1；按钮动作带上期望版本，服务端按版本条件更新 */
  version: number;
  status: CardStatus;
  payload: unknown;
  urgency?: Urgency;
  createdAt: string;
  handledAt?: string;
  /** 处理结果：点了哪个动作，附带的说明（打回意见、勾掉了哪几项授权……） */
  outcome?: { action: CardAction; note?: string };
}
