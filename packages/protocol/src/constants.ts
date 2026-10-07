// 前端协议里的名字：频道、事件类型、请求方法、错误码、卡片类型和动作。
// 只有常量，不引用 TypeBox：Web 只用到这些常量和类型，打包时 schema 和 TypeBox 会被摇掉。
// 别处不写这些名字的字面量，一律从这里取。

/** 前端协议的版本号。前端订阅时带上，和守护进程的不一致就提示刷新页面。 */
export const FRONTEND_PROTOCOL_VERSION = 1;

/**
 * 频道名。会话频道的名字就是会话 id：秘书会话是 `secretary`，某个维护者的会话是 `maintainer:<维护者 id>`。
 * 其余是全局频道：任务看板、项目列表、待我处理、卡片、活动状态、已配对设备。
 */
export const CHANNELS = {
  secretary: "secretary",
  board: "board",
  projects: "projects",
  inbox: "inbox",
  cards: "cards",
  activity: "activity",
  /** 已配对设备（设置里的"已配对设备"）：批准、使用、吊销都是这台设备的一条 device 事件（10 号票） */
  devices: "devices",
  /** 个人工作日历（设置里的工作日历页）：个人规则和手动标记、节假日数据的最新样子（29 号票） */
  workdayCalendar: "workday_calendar",
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
  /** 卡片频道：用户关掉了一张卡（不处理）。回避信号的素材，08 号票采集 */
  cardDismissed: "card_dismissed",
  /** 卡片频道：建议卡、提问卡长期（默认 7 天）没处理。回避信号的素材；计时在 08 号票 */
  cardStale: "card_stale",
  /** 待我处理频道：一条事项的最新状态（删除也是一次更新，deleted 为 true） */
  inboxItem: "inbox_item",
  /** 待我处理频道（临时）：要马上告诉用户的事（到点的提醒）：页面内提示，用户允许时再发浏览器通知 */
  notify: "notify",
  /** 任务看板频道：一条简单提醒的最新状态 */
  reminder: "reminder",
  /** 已配对设备频道：一台设备的最新状态（批准配对、使用续期、吊销） */
  device: "device",
  /**
   * 守护进程内部的 guard 频道（前端不订阅）：用户在审批卡上批准或拒绝了一次调用（07 号票）。
   * "审批决定"素材的来源（08 号票的采集按事件类型登记，所以放在这里）
   */
  approvalDecided: "approval_decided",
  /** 会话频道：一次快速动作的执行，也就是"操作记录"：动作类型、规范化后的动作、结果、对应的卡片（21 号票） */
  quickActionExecuted: "quick_action_executed",
  /** 会话频道：这些消息被彻底删除了，原来的事件已改写成"已删除"标记；前端据此把手里的原话换成标记（21 号票） */
  messagesPurged: "messages_purged",
  /** 素材频道（守护进程内部，前端不订阅）：一条显式记忆命令（记住、忘掉、彻底删除、别推断）；素材模块据此产生、删除、标记素材（21 号票） */
  memoryCommand: "memory_command",
  /** 任务看板频道：一个任务的最新状态，以及这次的变化和谁改的（12 号票） */
  task: "task",
  /** 活动状态频道：某个 agent 的活动状态变了（休眠、干活中、等你、排队；12 号票起有"排队"） */
  activity: "activity",
  /** 卡片频道：用户回答了提问卡。"澄清问题的回答"素材的来源（12 号票） */
  questionsAnswered: "questions_answered",
  /**
   * 守护进程内部的 tasks 频道（前端不订阅）：用户在计划卡上确认（连同勾掉、收窄的授权项）或打回了计划（12 号票）。
   * "审批决定"素材的来源
   */
  planDecided: "plan_decided",
  /** 工作日历频道：个人规则和手动标记的最新样子（设置页、快速动作改的，或者启动时发现配置文件和上次不一样）（29 号票） */
  workdaySettings: "workday_settings",
  /** 工作日历频道：工作日历用的节假日数据（框架自带的加上导入的）的最新样子（启动时有变化、导入新一年的数据时）（29 号票） */
  holidayData: "holiday_data",
} as const;

/** 事件类型的名字（EVENT_TYPES 里的值） */
export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

export const EPHEMERAL_EVENT_TYPES: readonly string[] = [EVENT_TYPES.stream, EVENT_TYPES.notify];

export function isEphemeralEventType(type: string): boolean {
  return EPHEMERAL_EVENT_TYPES.includes(type);
}

/** 请求方法 */
export const METHODS = {
  /** 握手兼订阅：带协议版本和每个频道最后收到的序号，服务端补发缺失的落盘事件，之后推送新的 */
  subscribe: "subscribe",
  /** 往某个会话发一条消息（带幂等键） */
  sendMessage: "send_message",
  /** 对卡片做动作（带幂等键和期望版本）：服务端按版本条件更新，先到先得 */
  cardAction: "card_action",
  /** 待我处理事项：标已读 / 未读、归档 / 取消归档、删除、处理通知类事项 */
  inboxAction: "inbox_action",
  /** 吊销一台已配对设备：凭证立即失效，它开着的 WebSocket 被服务端关掉 */
  revokeDevice: "revoke_device",
  /** 点"发起任务"按钮：不经秘书判断直接建出任务（规划中），秘书接着和用户对齐意图（12 号票） */
  startTask: "start_task",
} as const;

export type Method = (typeof METHODS)[keyof typeof METHODS];

/** 这些方法有副作用，请求必须带幂等键 */
export const METHODS_REQUIRING_IDEMPOTENCY_KEY = [METHODS.sendMessage, METHODS.cardAction, METHODS.inboxAction, METHODS.revokeDevice, METHODS.startTask] as const satisfies readonly Method[];

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
  /** 要操作的东西（卡片、待我处理事项、提醒）不存在 */
  "not_found",
  /** 不允许这样做，message 里写明原因（比如卡着任务的事项处理之前不能归档或删除） */
  "not_allowed",
  /** 太频繁了（同一来源 10 分钟内的配对请求超过上限），稍后再试。HTTP 接口回成 too_many_requests */
  "rate_limited",
  "internal",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** 发言方：用户本人、agent（秘书或维护者）、系统（运行时追加的说明，比如"工具包已变更"）。 */
export const SPEAKERS = ["user", "agent", "system"] as const;

/** 守卫对一次工具调用的处置（六档）。 */
export const DISPOSITIONS = ["do", "do_then_tell", "planned_only", "ask_first", "hand_to_me", "never"] as const;

/** 处置的中文名（规格第 9 节；守护进程的说明、Web 共用） */
export const DISPOSITION_LABEL: Readonly<Record<(typeof DISPOSITIONS)[number], string>> = {
  do: "直接做只记录",
  do_then_tell: "做完告诉我",
  planned_only: "计划里列了才做",
  ask_first: "先问我",
  hand_to_me: "交给我做",
  never: "永不",
};

/** 工具调用的结果：正在执行、放行执行完、被拦下、问过用户后被拒、出错。 */
export const TOOL_CALL_OUTCOMES = ["running", "done", "blocked", "denied", "error"] as const;

/**
 * 工具调用被拦下的原因不是处置时（规格第 9 节）：硬拒绝（越出能力或边界）、按规则退回（时序规则的前提没满足、
 * 要跑的脚本执行前没法检查），以及守卫判定出错（没判出结果，这次调用不执行）。
 */
export const TOOL_CALL_BLOCKS = ["hard_refusal", "pull_back", "judge_error"] as const;

/**
 * agent 处理一条输入的结局：做完了、被中止、出错、中断（守护进程重启或子进程崩溃时正在处理，
 * 不会自动重送，会话里另有一条系统说明请用户需要时重发）。
 */
export const TURN_OUTCOMES = ["completed", "aborted", "error", "interrupted"] as const;

/**
 * 第一阶段的 14 种卡片（规格第 5 节）。守护进程的卡片类型注册表（cards/registry.ts）建在这张表上。
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

/**
 * 每种卡片负载的版本（卡片类型注册表登记的版本）。负载的形状改了就把版本加 1：
 * 前端只认识自己构建时的版本，遇到更高版本的卡片和不认识的类型一样，显示纯文本降级版本加"去 Web 处理"的链接。
 * reminder 2、plan 2：时间表（提醒的、计划里定时作业的）多了"按我的工作日"（29 号票）。
 */
export const CARD_TYPE_VERSIONS: Readonly<Record<CardType, number>> = {
  plan: 2,
  approval: 1,
  questions: 1,
  progress: 1,
  quick_action: 1,
  suggest_task: 1,
  suggest_project: 1,
  reminder: 2,
  charter: 1,
  work_order: 1,
  plan_change: 1,
  parallel: 1,
  memory_delete: 1,
  pairing: 1,
};

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

// ───────────────────────── 快速动作与记忆命令（21 号票） ─────────────────────────

/** 显式记忆命令：记住、忘掉、彻底删除、别推断（规格第 14、15 节） */
export const MEMORY_COMMANDS = ["remember", "forget", "purge", "no_infer"] as const;

export type MemoryCommandKind = (typeof MEMORY_COMMANDS)[number];

/** 删除素材的三种方式：忘掉（默认，聊天里仍看得到原话）、彻底删除（连会话原文一起改写成删除标记）、别推断（素材保留，不参与推断） */
export const MEMORY_DELETE_MODES = ["forget", "purge", "no_infer"] as const satisfies readonly MemoryCommandKind[];

/** 记忆命令的中文名 */
export const MEMORY_COMMAND_LABEL: Readonly<Record<MemoryCommandKind, string>> = {
  remember: "记住",
  forget: "忘掉",
  purge: "彻底删除",
  no_infer: "别推断",
};

/** 彻底删除删不掉的东西，如实告诉用户（设置页、记忆删除卡上都写） */
export const PURGE_LIMITS =
  "删不掉的：秘书回复里转述过的话；备份快照里仍有一份，随快照轮换消失（本机约 7 天，同步目录最长约 5 周）。";

/**
 * 三种删法各自的说法（守护进程、Web 共用这一张表，分支都收在这里）：
 * - done：做完以后怎么说（"已忘掉 3 条素材"）；
 * - note：给用户看的说明（设置页、记忆删除卡）；
 * - usage：给秘书看的用法（写进"提议快速动作"工具的说明）。
 */
export const MEMORY_DELETE_MODE_INFO: Readonly<Record<(typeof MEMORY_DELETE_MODES)[number], { done: string; note: string; usage: string }>> = {
  forget: {
    done: "忘掉",
    note: "从素材库删掉；聊天记录里仍看得到原话。",
    usage: "用户说\"忘掉……\"：从素材库删掉（聊天记录里仍看得到原话）",
  },
  purge: {
    done: "彻底删除",
    note: `连会话原文一起删：事件日志、会话文件里的原话换成删除标记，没有别的消息引用的附件一起删，不可恢复。${PURGE_LIMITS}`,
    usage: "用户说\"彻底删除……\"：连会话原文一起删，原文改写成删除标记",
  },
  no_infer: {
    done: "标记为不参与推断",
    note: "素材保留，但不参与推断。",
    usage: "用户说\"别推断……\"：素材保留，标记为不参与推断",
  },
};

/** 一张记忆删除卡、一次删除最多多少条素材（卡片上列得下、用户核对得过来；协议的 schema 和守护进程用同一个值） */
export const MAX_MEMORY_DELETE_MATERIALS = 50;

/**
 * "记住"的内容是从哪里来的（素材的来源标记跟着它）：
 * - typed：用户这条消息里自己打的字；
 * - quote：只在用户消息的引用块里（外部、不可信）；
 * - card：只在用户引用的卡片里（agent 先提出、用户选的）；
 * - proposed：秘书推断出来、用户在卡上确认的（用户的选择，agent 先提出）。
 */
export const REMEMBER_SOURCES = ["typed", "quote", "card", "proposed"] as const;

/** 被彻底删除的内容换成这句：事件里带原话的文本字段、卡片上的摘录、会话文件里的消息和工具结果 */
export const PURGED_TEXT = "（这条内容已彻底删除）";

/** 会话文件里覆盖了被删内容的压缩摘要、分支摘要整段换成这句 */
export const PURGED_SUMMARY_TEXT = "（这段摘要含已彻底删除的内容，已移除）";

// ───────────────────────── 待我处理 ─────────────────────────

/**
 * 通知类事项的种类（规格第 5 节）。本票只用到"到点的提醒"，其余由产生它们的票加进来时使用。
 * 事项上的 notice 仍是 string：前端可能遇到还不认识的种类。
 */
export const NOTICE_TYPES = [
  /** 到点的简单提醒（置顶） */
  "reminder_due",
  "missed_reminder",
  "interrupted",
  "out_of_scope",
  "backup_failed",
  "snapshot_check_failed",
  "scheduled_job_auto_paused",
  "archive_list",
  "grant_renewal",
  "stuck_help",
  "failure_choice",
  /** 语义检索用的向量模型文件不在（08 号票）：写明运行哪条命令下载 */
  "embedding_model_missing",
  /** 守卫判定"交给我做"的一次调用：agent 准备好的内容在 body 和 data 里，用户亲手完成后点"已完成"，agent 收到通知 */
  "hand_over",
  /** 某一年的节假日数据缺失（29 号票）：内部作业每月检查（12 月起查下一年），data 里写明年份和哪一边，动作"发起更新任务" */
  "holiday_data_missing",
] as const;

/** "节假日数据缺失"事项的动作：发起一个联网任务去更新（秘书不能联网） */
export const HOLIDAY_UPDATE_ACTION = "发起更新任务";

/** "交给我做"事项的处理动作 */
export const HAND_OVER_DONE = "已完成";

export type NoticeType = (typeof NOTICE_TYPES)[number];

/** 对待我处理事项的动作：标已读、标未读、归档、取消归档、删除、处理通知类事项（选它的一个动作） */
export const INBOX_ACTIONS = ["read", "unread", "archive", "unarchive", "delete", "handle"] as const;

/** 紧急度为这两档（卡着任务）的事项，处理之前不能归档或删除 */
export const BLOCKING_URGENCIES = ["blocking_deadline", "blocking"] as const;

// ───────────────────────── 简单提醒 ─────────────────────────

/** 简单提醒的状态：待触发、已触发（只有一次性的会到这里；重复的一直待触发）、已取消 */
export const REMINDER_STATUSES = ["pending", "fired", "cancelled"] as const;

/**
 * 一条提醒的变化：秘书或用户建、改、取消，调度器到点触发；
 * missed 是到点时守护进程没在运行、晚了超过 60 分钟，没有照发，改放进待我处理（错过的提醒）。
 */
export const REMINDER_CHANGES = ["created", "updated", "cancelled", "fired", "missed"] as const;

export type ReminderChangeKind = (typeof REMINDER_CHANGES)[number];

// ───────────────────────── 已配对设备 ─────────────────────────

/** 一台已配对设备的变化：批准配对后领到凭证（还没用过）、第一次带着凭证来（启用）、使用（续期）、被吊销 */
export const DEVICE_CHANGES = ["paired", "activated", "used", "revoked"] as const;

/** 带来的设备凭证为什么不认：被吊销了，或者过期了（连续 365 天没用，或者领到之后 24 小时里一次也没用过） */
export const CREDENTIAL_REJECTIONS = ["revoked", "expired"] as const;
export type CredentialRejection = (typeof CREDENTIAL_REJECTIONS)[number];

export type DeviceChangeKind = (typeof DEVICE_CHANGES)[number];

/**
 * 配对请求（新设备这一侧看到的）状态：等批准、已批准（下一次来问就领到凭证）、已配对（凭证已领走）、
 * 被拒绝、已过期（5 分钟没批，或者批准后没来领）。
 */
export const PAIRING_REQUEST_STATUSES = ["pending", "approved", "paired", "denied", "expired"] as const;

export type PairingRequestStatus = (typeof PAIRING_REQUEST_STATUSES)[number];
