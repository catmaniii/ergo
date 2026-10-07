// 前端协议里的名字：频道、事件类型、请求方法、错误码、卡片类型和动作。
// 只有常量，不引用 TypeBox：Web 只用到这些常量和类型，打包时 schema 和 TypeBox 会被摇掉。
// 别处不写这些名字的字面量，一律从这里取。

/** 前端协议的版本号。前端订阅时带上，和守护进程的不一致就提示刷新页面。 */
export const FRONTEND_PROTOCOL_VERSION = 1;

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

export const MAINTAINER_CHANNEL_PREFIX = "maintainer:";

/** 某个维护者的会话 id（也是它的会话频道名）；类型和 schema 里的 ConversationId 一致 */
export function maintainerChannel(maintainerId: string): `${typeof MAINTAINER_CHANNEL_PREFIX}${string}` {
  return `${MAINTAINER_CHANNEL_PREFIX}${maintainerId}`;
}

/**
 * 事件类型。
 * - 落盘事件占频道内的序号，重连时补发；
 * - 临时事件（`EPHEMERAL_EVENT_TYPES`）只推送、不落盘、不补发，序号沿用它所在频道当时最后一条落盘事件的序号。
 */
export const EVENT_TYPES = {
  /** 会话频道：一条定稿的消息 */
  message: "message",
  /** 会话频道：agent 开始处理一条用户消息（守护进程重启或子进程崩溃后，据此认出处理到一半的那条） */
  turnStart: "turn_start",
  /** 会话频道：agent 处理完一条输入（回合结束），带结局 */
  turnEnd: "turn_end",
  /** 会话频道（临时）：agent 回复的流式增量，每 100 毫秒最多一帧 */
  stream: "stream",
  /** 卡片频道：一张卡片的最新版本 */
  card: "card",
} as const;

export const EPHEMERAL_EVENT_TYPES: readonly string[] = [EVENT_TYPES.stream];

export function isEphemeralEventType(type: string): boolean {
  return EPHEMERAL_EVENT_TYPES.includes(type);
}

/** 请求方法 */
export const METHODS = {
  /** 握手兼订阅：带协议版本和每个频道最后收到的序号，服务端补发缺失的落盘事件，之后推送新的 */
  subscribe: "subscribe",
  /** 往某个会话发一条消息（带幂等键） */
  sendMessage: "send_message",
  /** 对卡片做动作（带幂等键和期望版本；06 号票实现） */
  cardAction: "card_action",
} as const;

export type Method = (typeof METHODS)[keyof typeof METHODS];

/** 这些方法有副作用，请求必须带幂等键 */
export const METHODS_REQUIRING_IDEMPOTENCY_KEY = [METHODS.sendMessage, METHODS.cardAction] as const satisfies readonly Method[];

export type IdempotentMethod = (typeof METHODS_REQUIRING_IDEMPOTENCY_KEY)[number];

export function requiresIdempotencyKey(method: Method): method is IdempotentMethod {
  return (METHODS_REQUIRING_IDEMPOTENCY_KEY as readonly Method[]).includes(method);
}

/** 错误响应里的错误码 */
export const ERROR_CODES = [
  /** 帧本身不对：不是 JSON、不是对象、缺 id 或方法 */
  "bad_frame",
  "unknown_method",
  /** 参数不符合这个方法的 schema */
  "bad_params",
  "idempotency_key_required",
  /** 前端的协议版本和守护进程的不一致：提示刷新页面 */
  "protocol_mismatch",
  /** 协议里有、但守护进程这个版本还没实现 */
  "not_implemented",
  /** 卡片已被处理（版本对不上，先到先得） */
  "conflict",
  "internal",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** 发言方：用户本人、agent（秘书或维护者）、系统（运行时追加的说明，比如"工具包已变更"）。 */
export const SPEAKERS = ["user", "agent", "system"] as const;

/** 守卫对一次工具调用的处置（六档）。 */
export const DISPOSITIONS = ["do", "do_then_tell", "planned_only", "ask_first", "hand_to_me", "never"] as const;

/** 工具调用的结果：正在执行、放行执行完、被拦下、问过用户后被拒、出错。 */
export const TOOL_CALL_OUTCOMES = ["running", "done", "blocked", "denied", "error"] as const;

/**
 * agent 处理一条输入的结局：做完了、被中止、出错、中断（守护进程重启或子进程崩溃时正在处理，
 * 不会自动重送，会话里另有一条系统说明请用户需要时重发）。
 */
export const TURN_OUTCOMES = ["completed", "aborted", "error", "interrupted"] as const;

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

/** 卡片状态：待处理、已处理、已关闭（用户关掉不处理）、已过期。 */
export const CARD_STATUSES = ["pending", "handled", "dismissed", "expired"] as const;

/** 紧急度三档：卡住任务且有时限、卡住任务、不卡任务。 */
export const URGENCIES = ["blocking_deadline", "blocking", "non_blocking"] as const;
