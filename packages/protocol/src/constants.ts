// 前端协议里的名字：频道、事件类型、请求方法、错误码、卡片类型和动作。
// 只有常量，不引用 TypeBox：Web 只用到这些常量和类型，打包时 schema 和 TypeBox 会被摇掉。
// 别处不写这些名字的字面量，一律从这里取。
import { ASSISTANT_NAME_MARK } from "./assistant-name.ts";

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
  /** 关注类别设置（设置里的"关注类别"）：每次修改、从设置文件读到的变化都是一条 watch_category_settings 事件（26 号票） */
  watchCategories: "watch_categories",
  /** 个人助理的名字（设置里的"个人助理的名字"）：每次改名、从配置文件读到的变化都是一条 assistant_name 事件（43 号票）；界面上处处用名字，前端一打开就订阅 */
  assistantName: "assistant_name",
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
  /** 会话频道：时间线上的一条记录（偏离 14、范围变更和越界 18），负载见 timeline.ts（25 号票定形状） */
  timelineRecord: "timeline_record",
  /** 会话频道：这些消息被彻底删除了，原来的事件已改写成"已删除"标记；前端据此把手里的原话换成标记（21 号票） */
  messagesPurged: "messages_purged",
  /** 素材频道（守护进程内部，前端不订阅）：一条显式记忆命令（记住、忘掉、彻底删除、别推断）；素材模块据此产生、删除、标记素材（21 号票） */
  memoryCommand: "memory_command",
  /** 任务看板频道：一个任务的最新状态，以及这次的变化和谁改的（12 号票） */
  task: "task",
  /** 活动状态频道：某个 agent 的活动状态变了（休眠、干活中、等你、排队；12 号票起有"排队"） */
  activity: "activity",
  /** 活动状态频道（临时）：干活中的 agent 此刻在做什么，每个 agent 每 100 毫秒最多一条（25 号票） */
  activityProgress: "activity_progress",
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
  /** 关注类别频道：关注类别设置的最新样子，以及这次的变化和谁改的（26 号票） */
  watchCategorySettings: "watch_category_settings",
  /** 名字频道：用户给个人助理起的名字的最新样子（设置页改的，或者启动时发现配置文件和上次不一样）（43 号票） */
  assistantName: "assistant_name",
  /** 项目列表频道：一个项目的最新状态，以及这次的变化和谁改的（15 号票） */
  project: "project",
  /**
   * 守护进程内部的 charters 频道（前端不订阅）：用户在立项书卡上确认（确认并开工 / 只确认，稍后开工）（15 号票）。
   * "用户对产出的反应"素材的来源
   */
  charterDecided: "charter_decided",
  /**
   * 守护进程内部的 tasks 频道（前端不订阅）：用户对产出的反应——"由我验收"的阶段验收通过或退回、对已完成的任务要求返工（13 号票）。
   * "用户对产出的反应"素材的来源
   */
  outputReaction: "output_reaction",
  /**
   * 任务看板频道：一个任务（或定时作业）名下的 token 用量合计，每次新的模型调用记账后推一条最新的（24 号票）。
   * 任务卡、作业卡上的总量和任务详情里按 agent 的细分都来自它
   */
  tokenTotals: "token_totals",
  /**
   * 守护进程内部的 sub_agents 频道（前端不订阅）：用户在并行确认卡上同意并行或不同意（照常按顺序做）（20 号票）。
   * "审批决定"素材的来源
   */
  parallelDecided: "parallel_decided",
  /** 会话频道：一条语音的最新状态（建出、识别中、识别完成或失败、重新识别）（31 号票） */
  voice: "voice",
  /** 项目列表频道：一张工单的最新状态，以及这次的变化（派出、开始、等澄清、有了回答、结束）（16 号票） */
  workOrder: "work_order",
  /** 维护者会话频道：会话分段的最新状态（开了一段、写了摘要、开始收尾、结束）（16 号票） */
  segment: "segment",
  /** 任务看板频道：执行中任务现在生效的计划换了一版（计划变更确认、维护者自行调整计划，14 号票）。阶段抽屉按它显示 */
  taskPlan: "task_plan",
  /**
   * 守护进程内部的 tasks 频道（前端不订阅）：用户在"授权到期续期"事项上续期或不续（14 号票）。"审批决定"素材的来源
   */
  grantRenewalDecided: "grant_renewal_decided",
  /** 会话频道：agent 发的一条语音（语音回复）的最新状态（开始合成、合成完成或失败）（32 号票） */
  agentVoice: "agent_voice",
  /**
   * 项目列表频道（项目维护者的）、任务看板频道（不属于项目的任务的）：一条范围记录（范围变更或越界，18 号票）。
   * 同一事务里维护者会话频道上另有一条 timeline_record 供时间线标出
   */
  scopeRecord: "scope_record",
  /**
   * 守护进程内部的 toolkits 频道（前端不订阅）：用户批准或拒绝了"工具包变更"卡，或者在项目页、任务详情里直接改了工具包（27 号票）。
   * "审批决定"素材的来源
   */
  toolkitDecided: "toolkit_decided",
  /**
   * 守护进程内部的 work_orders 频道（前端不订阅）：用户在工单卡上确认派出或拒绝计划外的工单（和卡片更新同一事务，17 号票）。
   * "审批决定"素材的来源
   */
  workOrderDecided: "work_order_decided",
  /** 任务看板频道：一个定时作业的最新状态，以及这次的变化和说到的那一次运行（登记、暂停、恢复、到点、运行开始和结束）（19 号票） */
  scheduledJob: "scheduled_job",
  /**
   * 活动状态频道（临时）：语音识别模型、合成模型的状态变了（加载中、已就绪、没开、出错……），负载是两个模型的最新状态
   * （VoiceModelsView，和本机接口 GET /api/voice-models 的一样；45 号票：模型预热）
   */
  voiceModels: "voice_models",
} as const;

/** 事件类型的名字（EVENT_TYPES 里的值） */
export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

export const EPHEMERAL_EVENT_TYPES: readonly string[] = [EVENT_TYPES.stream, EVENT_TYPES.notify, EVENT_TYPES.activityProgress, EVENT_TYPES.voiceModels];

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
  /** 设置页改关注类别：调严内置类别、新建 / 改 / 删自定义类别、修复坏了的设置文件、重新读文件（26 号票） */
  updateWatchCategories: "update_watch_categories",
  /** 点"新建项目"：不经"是不是项目"的判断，秘书直接收口出"建议立项"卡（15 号票） */
  newProject: "new_project",
  /** 把一个未结束的任务转为项目：原任务的维护者接着做立项问答，任务以"已完成 · 已转为项目"结束（15 号票） */
  convertTaskToProject: "convert_task_to_project",
  /** 项目页上的动作：开工、放弃、停用、重新启用、归档、取消归档、删除（删除要在待我处理里二次确认）（15 号票） */
  projectAction: "project_action",
  /** 项目页上的"重置维护者"：项目状态不变，维护者新开一段会话、只凭项目档案重建理解（16 号票） */
  resetMaintainer: "reset_maintainer",
  /** 对任务的控制：暂停、继续、取消、失败后重试、返工、由我验收的阶段验收通过或退回（13 号票） */
  taskAction: "task_action",
  /** 气泡菜单里的"重新识别"：识别失败的语音重新排队识别（31 号票） */
  retryVoice: "retry_voice",
  /** 项目页、任务详情里直接改工具包（扩大、减少都直接写进工具包，不出计划变更卡，27 号票） */
  setToolkit: "set_toolkit",
  /** 看板上对定时作业的动作：暂停、恢复、取消（19 号票） */
  scheduledJobAction: "scheduled_job_action",
} as const;

export type Method = (typeof METHODS)[keyof typeof METHODS];

/** 这些方法有副作用，请求必须带幂等键 */
export const METHODS_REQUIRING_IDEMPOTENCY_KEY = [
  METHODS.sendMessage,
  METHODS.cardAction,
  METHODS.inboxAction,
  METHODS.revokeDevice,
  METHODS.startTask,
  METHODS.updateWatchCategories,
  METHODS.newProject,
  METHODS.convertTaskToProject,
  METHODS.projectAction,
  METHODS.resetMaintainer,
  METHODS.taskAction,
  METHODS.retryVoice,
  METHODS.setToolkit,
  METHODS.scheduledJobAction,
] as const satisfies readonly Method[];

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

/**
 * 一次工具调用做了什么性质的事（54 号票，出处是 AgentSense 的 natureOf）：只看（什么都不改）、动手（只新增、不碰已有的）、
 * 删改（改了或去掉了原有的东西：局部改或整个覆盖已有的文件、删除、移动或改名、丢弃 git 改动、强推……）。
 * 守护进程按守卫的工具注册表和这次判定实际要判的调用定（daemon/src/guard/nature.ts），会话缩小后工具色块按它分深浅
 */
export const TOOL_NATURES = ["look", "act", "modify"] as const;

/** 性质的中文名（图例） */
export const TOOL_NATURE_LABEL: Readonly<Record<(typeof TOOL_NATURES)[number], string>> = { look: "只看", act: "动手", modify: "删改" };

/** 工具调用的结果：正在执行、放行执行完、被拦下、问过用户后被拒、出错。 */
export const TOOL_CALL_OUTCOMES = ["running", "done", "blocked", "denied", "error"] as const;

/**
 * 工具调用被拦下的原因不是处置时（规格第 9 节）：硬拒绝（越出能力或边界）、按规则退回（时序规则的前提没满足、
 * 要跑的脚本执行前没法检查），以及守卫判定出错（没判出结果，这次调用不执行）。
 */
export const TOOL_CALL_BLOCKS = ["hard_refusal", "pull_back", "judge_error", "plan_redirect", "plan_check"] as const;

/**
 * 被拦下的原因的中文名（会话里的工具调用、时间线的要点共用；25 号票从 Web 挪到这里）。
 * 59 号票加了流程执行时的两种：前置步骤没做、先引回计划里的那一步（plan_redirect，自动纠偏，不打扰用户）；
 * 和授权的计划比对后直接拦下（plan_check：只许做一次的又做了一次、审查时剔除的对象）
 */
export const TOOL_CALL_BLOCK_LABEL: Readonly<Record<(typeof TOOL_CALL_BLOCKS)[number], string>> = {
  hard_refusal: "硬拒绝",
  pull_back: "按规则退回",
  judge_error: "判定出错",
  plan_redirect: "按计划引回",
  plan_check: "计划检查拦下",
};

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
  "toolkit_change",
  /** 归档清单（19 号票）：每周一次，结束超过 7 天、还没归档的任务，每项选归档、继续改、先留着 */
  "archive_list",
  /** 流程计划卡（58 号票）：审查结果、步骤和每一步的条件、需要你确认的事项，一次授权 */
  "workflow_plan",
] as const;

export type CardType = (typeof CARD_TYPES)[number];

export function isCardType(t: string): t is CardType {
  return (CARD_TYPES as readonly string[]).includes(t);
}

/**
 * 每种卡片负载的版本（卡片类型注册表登记的版本）。负载的形状改了就把版本加 1：
 * 前端只认识自己构建时的版本，遇到更高版本的卡片和不认识的类型一样，显示纯文本降级版本加"去 Web 处理"的链接。
 * reminder 2、plan 2：时间表（提醒的、计划里定时作业的）多了"按我的工作日"（29 号票）。
 * questions 2（16 号票）：项目维护者为工单提问时，卡上记着是谁在问（askedBy），回答交回它。
 */
export const CARD_TYPE_VERSIONS: Readonly<Record<CardType, number>> = {
  /**
   * 3（26 号票）：计划里有用户的限制（userLimits），确认时可以加本任务的关注类别（addedCategories）；
   * 4（17 号票）：涉及的项目每一行可以写所属阶段和这张工单的验收标准（涉及多个项目的任务确认后变成工单）
   */
  plan: 4,
  approval: 1,
  questions: 2,
  progress: 1,
  quick_action: 1,
  /**
   * 2（16 号票）：卡上可以带涉及的项目（只涉及一个项目的任务由这个项目的维护者执行）；
   * 3（58 号票）：两个按钮"作为流程""作为长程任务"，建出后记着种类；
   * 4（64 号票）：项目的维护者给的建议卡带着项目（internal），点了建出的是这个项目的内部任务
   */
  suggest_task: 4,
  suggest_project: 1,
  reminder: 2,
  charter: 1,
  work_order: 1,
  plan_change: 1,
  parallel: 1,
  memory_delete: 1,
  pairing: 1,
  /** 27 号票：项目维护者不在任务里时要开 bash、加 MCP、开联网 */
  toolkit_change: 1,
  archive_list: 1,
  workflow_plan: 1,
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
  /** "建议发起任务"卡上的"作为流程"（58 号票；"作为长程任务"是 start_task） */
  "start_workflow",
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
  /** 归档清单上对一项的选择（19 号票） */
  "decide",
] as const;

/** 卡片状态：待处理、已处理、已关闭（用户关掉不处理）、已过期。 */
export const CARD_STATUSES = ["pending", "handled", "dismissed", "expired"] as const;

/** 紧急度三档：卡住任务且有时限、卡住任务、不卡任务。 */
export const URGENCIES = ["blocking_deadline", "blocking", "non_blocking"] as const;

/** 紧急度的中文名（待我处理页、秘书列出待我处理时共用）；URGENCIES 的先后就是排序（紧的在前） */
export const URGENCY_LABEL: Readonly<Record<(typeof URGENCIES)[number], string>> = {
  blocking_deadline: "卡住任务 · 有时限",
  blocking: "卡住任务",
  non_blocking: "不卡任务",
};

// ───────────────────────── 快速动作与记忆命令（21 号票） ─────────────────────────

/** 显式记忆命令：记住、忘掉、彻底删除、别推断（规格第 14、15 节） */
export const MEMORY_COMMANDS = ["remember", "forget", "purge", "no_infer"] as const;

export type MemoryCommandKind = (typeof MEMORY_COMMANDS)[number];

/** 删除素材的三种方式：忘掉（默认，聊天里仍看得到原话）、彻底删除（连会话原文一起改写成删除标记）、别推断（素材保留，不参与推断） */
export const MEMORY_DELETE_MODES = ["forget", "purge", "no_infer"] as const satisfies readonly MemoryCommandKind[];

/**
 * 一次快速动作凭什么执行的（操作记录上写明，25 号票）：用户这一轮点明了的、推断出来但在已有授权内直接执行的
 * （处置是直接做、做完告诉我）、推断出来先问、用户在卡上确认后执行的
 */
export const QUICK_ACTION_BASES = ["explicit", "within_grant", "confirmed"] as const;
export type QuickActionBasis = (typeof QUICK_ACTION_BASES)[number];
export const QUICK_ACTION_BASIS_LABEL: Readonly<Record<QuickActionBasis, string>> = { explicit: "你点明的", within_grant: "授权内", confirmed: "你确认后" };

/** 记忆命令的中文名 */
export const MEMORY_COMMAND_LABEL: Readonly<Record<MemoryCommandKind, string>> = {
  remember: "记住",
  forget: "忘掉",
  purge: "彻底删除",
  no_infer: "别推断",
};

/**
 * 彻底删除删不掉的东西，如实告诉用户（设置页、记忆删除卡上都写）；秘书写名字占位，界面按用户起的名字显示（43 号票）。
 * 确认计划时在卡上改的假设栏、加的关注类别（80 号票）成了确认的计划的一部分，维护者照它做、守卫照它判，不改写
 */
export const PURGE_LIMITS = `删不掉的：${ASSISTANT_NAME_MARK}回复里转述过的话，${ASSISTANT_NAME_MARK}看任务看板时看到过的等我原因，交给项目维护者的工单内容里转述的话，和确认计划时改的假设栏、加的关注类别（已是计划的一部分）；备份快照里仍有一份，随快照轮换消失（本机约 7 天，同步目录最长约 5 周）。`;

/**
 * 删除项目删不掉的东西，如实写在删除项目的二次确认上（66 号票，照 PURGE_LIMITS 的写法）：项目之外读过这个项目的调用按碰到的
 * 路径认，认不出路径的（环境变量拼出的、看不透的命令）不改写；pi 的 bash 输出太长时另存的临时文件不在二狗的记录里；
 * 据此说过的话、备份同彻底删除
 */
export const PROJECT_DELETE_LIMITS = `删不掉的：认不出读的是这个项目的调用里读到的内容（命令里用环境变量拼出的路径、python -c 这类看不透的命令），命令输出太长时另存的临时文件（pi-bash 开头的 .log），${ASSISTANT_NAME_MARK}和别的 agent 据此说过的话；备份快照里仍有一份，随快照轮换消失（本机约 7 天，同步目录最长约 5 周）。`;

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
 * - voice：用户这条消息里的语音识别出的文字（31 号票：语音转写和打的字一样参与点明判定，素材注明"转写"）；
 * - quote：只在用户消息的引用块里（外部、不可信）；
 * - card：只在用户引用的卡片里（agent 先提出、用户选的）；
 * - proposed：秘书推断出来、用户在卡上确认的（用户的选择，agent 先提出）。
 */
export const REMEMBER_SOURCES = ["typed", "voice", "quote", "card", "proposed"] as const;

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
  /**
   * 中断不确定（23 号票）：守护进程被杀（或子进程意外退出）时一次有副作用的调用正在执行，说不清做没做完；标题是
   * "中断：不确定 X 是否已执行"。任务里的卡着任务（动作 INTERRUPTED_ACTIONS），秘书会话里的不卡任务（动作"知道了"）
   */
  "interrupted",
  /**
   * 越界通知（18 号票）：范围审视发现维护者做了没授权的范围外工作。不推送、不卡任务（维护者照常继续），照常算未读；
   * 动作"知道了"（OUT_OF_SCOPE_ACK），数据见 scope-records.ts 的 OutOfScopeNoticeData
   */
  "out_of_scope",
  "backup_failed",
  "snapshot_check_failed",
  /** 定时作业连续失败到次数自动暂停（19 号票）：动作"恢复""保持暂停"，data 是 JobAutoPausedNoticeData */
  "scheduled_job_auto_paused",
  /** 预留的名字：19 号票的归档清单做成了卡片（卡片类型 archive_list，每项单独选），不用这个通知类型 */
  "archive_list",
  "grant_renewal",
  /** 维护者"转为等我"（卡住求助，13 号票）：写明原因；用户回过话、做完要做的事后点"继续执行" */
  "stuck_help",
  /** 维护者判任务失败（13 号票）：写明原因，用户选"重试"或"取消任务" */
  "failure_choice",
  /** 计划里标明"由你验收"的阶段等用户验收（13 号票）：动作"验收通过""退回" */
  "stage_acceptance",
  /** 语义检索用的向量模型文件不在（08 号票）：写明运行哪条命令下载 */
  "embedding_model_missing",
  /** 守卫判定"交给我做"的一次调用：agent 准备好的内容在 body 和 data 里，用户亲手完成后点"已完成"，agent 收到通知 */
  "hand_over",
  /** 某一年的节假日数据缺失（29 号票）：内部作业每月检查（12 月起查下一年），data 里写明年份和哪一边，动作"发起更新任务" */
  "holiday_data_missing",
  /**
   * 关注类别的设置文件坏了（26 号票）：守卫判定一律出错，所有 agent 的工具调用都会被拦下。动作"去设置页修复"由前端带到设置页
   * （不算处理）；修好（或用户手改好、重新读到）后自动归档
   */
  "watch_categories_broken",
  /** 删除项目的二次确认（15 号票）：项目页上点了"删除"（只能从已归档发起），用户在这里选"确认删除"才真的删 */
  "project_delete",
  /** 节假日数据的更新任务完成了，但交付件没交全或不对（13 号票接上 29 号票的导入）：写明哪个文件、什么问题，不卡任务 */
  "holiday_import_problem",
  /** 语音识别进程不可用（没装、Python 路径不对、模型加载失败）（31 号票）：语音照常收下、识别状态为失败，写明怎么修好；修好后重新识别 */
  "voice_recognizer_unavailable",
  /**
   * 任务的一个阶段用量超过预算的 2 倍（14 号票，配置 tasks.thresholds.budgetAskTimes）：这一支停下等用户（原因"超预算"），写明用了多少、预算多少；
   * 用户点"追加预算继续"后这个阶段再有一份预算，接着执行
   */
  "over_budget",
  /** 用户发了语音，但还没有导入任何参考音色（32 号票）：语音回复退回只发文字，动作"去导入参考音色"由前端带到设置里的语音页（不算处理）；导入后自动归档 */
  "voice_reference_missing",
] as const;

/** "没有参考音色"事项的动作：去设置里的语音页导入参考音色 */
export const VOICE_REFERENCE_IMPORT_ACTION = "去导入参考音色";

/** "关注类别设置文件有问题"事项的动作：去设置里的关注类别页修复 */
export const WATCH_CATEGORIES_REPAIR_ACTION = "去设置页修复";

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

/** 简单提醒状态的中文名（看板、提醒卡、秘书看的看板共用） */
export const REMINDER_STATUS_LABEL: Readonly<Record<(typeof REMINDER_STATUSES)[number], string>> = { pending: "待触发", fired: "已触发", cancelled: "已取消" };

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
