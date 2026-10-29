// 前端协议里的名字：频道、事件类型、请求方法、错误码、卡片类型和动作。
// 只有常量，不引用 TypeBox：Web 只用到这些常量和类型，打包时 schema 和 TypeBox 会被摇掉。
// 别处不写这些名字的字面量，一律从这里取。
import { ASSISTANT_NAME_MARK } from "./assistant-name.ts";
import { followLocale, t, tTable } from "./i18n/runtime.ts";

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
  /**
   * 个人工作日历（设置里的工作日历页）：个人规则和手动标记、节假日数据的最新样子（29 号票）。306 号票起还有临时事件 external_calendar：
   * 数据源交给日历的外部日程变了（订阅时补推一条现在的版本），日历页据此重新取
   */
  workdayCalendar: "workday_calendar",
  /** 关注类别设置（设置里的"关注类别"）：每次修改、从设置文件读到的变化都是一条 watch_category_settings 事件（26 号票） */
  watchCategories: "watch_categories",
  /** 个人助理的名字（设置里的"个人助理的名字"）：每次改名、从配置文件读到的变化都是一条 assistant_name 事件（43 号票）；界面上处处用名字，前端一打开就订阅 */
  assistantName: "assistant_name",
  /**
   * 已读位置（109 号票）：用户在会话里看到哪一条了（现在只记秘书会话），每次往后挪是一条 read_mark 事件；手机、平板、电脑几台设备同步
   * （一台上看过，别的设备上"秘书"页签的红点也消失），前端一打开就订阅
   */
  readMarks: "read_marks",
  /**
   * 语言（168 号票，设置里的"语言 / Language"）：每次换语言、从配置文件读到的变化都是一条 language 事件；实际在用哪种、词典的版本
   * 是这个频道上的临时事件 locale（订阅时补推一条）。前端一打开就订阅
   */
  language: "language",
  /**
   * 插件（193 号票，ADR-0027 的网页插槽）：守护进程清单里每个插件现在的状况（在运行、停用了、移除了、没装上），临时事件
   * plugin_status（订阅时补推一条，变了再推）。网页按它装、停自己的网页插件；前端一打开就订阅。
   * 211 号票起还有落盘的 plugin_data_purged：移除插件时连它的数据一起彻底删除的记录
   */
  plugins: "plugins",
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
  /**
   * 素材频道（守护进程内部，前端不订阅）：用户在"浏览"的 ⋮ 菜单里点了"存进二狗的素材"，存下的一页网页——标题、地址、正文（165 号票）。
   * 产生一条"用户主动投喂的材料"素材（情境 saved_web_page），正文是网页上的外部数据，只在这条事件里，不进素材、不进索引
   */
  webPageSaved: "web_page_saved",
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
   * 守护进程内部的 mcp 频道（前端不订阅）：用户在"MCP 登记变更"卡上批准（运行时已经按卡写进配置区的 mcp.json）
   * 或拒绝（239 号票）。"审批决定"素材的来源
   */
  mcpDecided: "mcp_decided",
  /**
   * 守护进程内部的 mcp 频道（前端不订阅）：一次秘书带参调 MCP 的结局（240 号票）——只读直接做的、出了卡等你的、
   * 你批准之后真的调了（带服务进程的结果摘要）、你拒绝的、命中底线没执行的。审计和排查用；参数里的密钥类已经脱敏
   */
  mcpCalled: "mcp_called",
  /**
   * 守护进程内部的 charters 频道（前端不订阅）：用户在"立项要求变更"卡上确认或拒绝（和卡片更新同一事务，125 号票）；
   * 确认的立项书改写。"审批决定"素材的来源
   */
  charterChangeDecided: "charter_change_decided",
  /**
   * 守护进程内部的 standards 频道（前端不订阅）：用户在"规范改写"卡上确认或拒绝（和卡片更新同一事务，261 号票）；
   * 确认的改写生效（本项目的规范改写、跟新版规范）。"审批决定"素材的来源
   */
  standardChangeDecided: "standard_change_decided",
  /**
   * 守护进程内部的 operations 频道（前端不订阅）：用户确认、拒绝了运营方案（130 号票：在"首版做完了"卡上确认并转入使用、
   * 在"运营方案变更"卡上确认或拒绝；和卡片更新同一事务）。"审批决定"素材的来源
   */
  operationsDecided: "operations_decided",
  /**
   * 守护进程内部的 work_orders 频道（前端不订阅）：用户在工单卡上确认派出或拒绝计划外的工单（和卡片更新同一事务，17 号票）。
   * "审批决定"素材的来源
   */
  workOrderDecided: "work_order_decided",
  /**
   * 任务看板频道：一份触发登记（19 号票时叫定时作业；76 号票起属于一个定时触发的任务）的最新状态，以及这次的变化和说到的那一次运行
   * （登记、暂停、恢复、到点、合并、运行开始和结束、迁移）
   */
  scheduledJob: "scheduled_job",
  /**
   * 活动状态频道（临时）：语音识别模型、合成模型的状态变了（加载中、已就绪、没开、出错……），负载是两个模型的最新状态
   * （VoiceModelsView，和本机接口 GET /api/voice-models 的一样；45 号票：模型预热）
   */
  voiceModels: "voice_models",
  /**
   * 已读位置频道：某个会话已读到的序号往后挪了（用户在哪台设备上滚到了那条消息、或者停在最底部；109 号票）。
   * 启动时还没有秘书会话的记录（刚升级上来、新装的）也记一条，位置是秘书会话那时的最后一条：当作全部看过
   */
  readMark: "read_mark",
  /**
   * 活动状态频道（临时）：守护进程提供的网页换了一版（116 号票：npm run build:web 换了 index.html），负载是新的版本号
   * （WebVersionEventPayload，web-version.ts）。开着的页面和自己的对不上就提示"有新版本 · 刷新"；连上时的版本号在订阅的响应里
   */
  webVersion: "web_version",
  /**
   * 项目列表频道（临时）：项目的服务（133 号票：运营手段"服务"生效之后，二狗替它做到哪了、LSM 推来的在不在线、有网页的入口）变了，
   * 整份推一次（ProjectServicesEventPayload，project-services.ts）；订阅项目列表频道时补推一次全量
   */
  projectServices: "project_services",
  /**
   * 会话频道：会话里排队的消息（144 号票：二狗正在回复时用户又发的话）的最新样子（整队），以及这次的变化——排进来、拿掉、改顺序、
   * 交出去（这一轮做完、或者用户点了停止，排队的一起交给 agent 作为下一轮的输入，同一事务里追加成普通的用户消息）
   */
  messageQueue: "message_queue",
  /**
   * 秘书会话频道（临时，147 号票）：秘书的网页工具要发消息的那台设备办的一件事（BrowserRequest，browsing.ts）。不广播：只推给报过
   * 这个浏览器（browser_status）的那条连接；设备办完回 browser_reply
   */
  browserRequest: "browser_request",
  /**
   * 会话频道：会话回退（150 号票）、切换分支（151 号票）之后这个会话的会话树（整棵，SessionBranchEventPayload，session-branches.ts）。
   * 会话视图、往上翻历史、前端都按最新的一条推导当前分支和废弃分支；第一次订阅时最新那条落在补发的一页之前也补发它
   */
  sessionBranch: "session_branch",
  /**
   * 维护者会话频道：长程任务的一个阶段在这个会话里开始了（152 号票，StageStartEventPayload，stage-starts.ts）。界面上不显示成一条，
   * 缩小视图据它在那一处画"撤回到阶段「…」开始前"的回退点；守护进程撤回时据它找到会话树上回到哪
   */
  stageStart: "stage_start",
  /**
   * 会话频道：用户在废弃分支的详情里对一件遗留效果点了「申请撤回」（151 号票，废弃分支的遗留效果清单；
   * EffectUndoRequestedEventPayload，session-branches.ts）。只记一笔"已提交撤销请求"、调撤销接口，真正的撤销以后接（85 号票）
   */
  effectUndoRequested: "effect_undo_requested",
  /** 语言频道：设置里选的语言（设置页改的，或者启动时发现配置文件和上次不一样）（168 号票，LanguageEventPayload，i18n-schema.ts） */
  language: "language",
  /**
   * 语言频道（临时，168 号票）：实际在用的语言和词典的版本（LocaleEventPayload）——换了语言、~/.ergo/locales 里的语言文件变了就推一条，
   * 订阅语言频道时补推一条现在的；网页按版本判断要不要重取词典（GET /api/locale）
   */
  locale: "locale",
  /**
   * 插件频道（临时，193 号票）：守护进程清单里每个插件现在的状况（PluginStatusEventPayload，plugins.ts）——订阅插件频道时补推一条，
   * 运行中停用、启用、移除（211 号票：设置 · 插件）、换了语言（插件的名字跟着变）再推一条；网页按它装、停自己的网页插件
   */
  pluginStatus: "plugin_status",
  /**
   * 插件频道（211 号票）：移除插件时连它的数据一起彻底删除的记录（PluginDataPurgedEventPayload，plugins.ts）——只写插件名、什么时候、
   * 删了几条和它拥有的事件类型、卡片类型，不带内容；删除本身和它在同一个事务里（ADR-0008 的口子）
   */
  pluginDataPurged: "plugin_data_purged",
  /**
   * 工作日历频道（临时，306 号票）：数据源交给日历的外部日程（手机日历、Google 日历……）变了（ExternalCalendarEventPayload，
   * calendar-schema.ts）——同步、设备交来写进了新的、断开了、插件起停了就推一条带新版本的，订阅工作日历频道时补推一条现在的；
   * 日历按月给的 asOf.external 比它小，手里这份就旧了，开着的日历页重新取
   */
  externalCalendar: "external_calendar",
} as const;

/** 事件类型的名字（EVENT_TYPES 里的值） */
export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

export const EPHEMERAL_EVENT_TYPES: readonly string[] = [EVENT_TYPES.stream, EVENT_TYPES.notify, EVENT_TYPES.activityProgress, EVENT_TYPES.voiceModels, EVENT_TYPES.webVersion, EVENT_TYPES.projectServices, EVENT_TYPES.browserRequest, EVENT_TYPES.locale, EVENT_TYPES.pluginStatus, EVENT_TYPES.externalCalendar];

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
  /** 吊销一台已配对设备：凭证立即失效，它开着的 WebSocket 被服务端关掉（123 号票起设置页改用 device_batch_action，这个留着给还没刷新的旧页面） */
  revokeDevice: "revoke_device",
  /** 设置 · 已配对设备的多选（123 号票）：一次对几台延期、吊销或删除，各自做了或跳过、逐台回报 */
  deviceBatchAction: "device_batch_action",
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
  /** 项目卡片、项目页上的"启动""关闭"（257 号票）：经 LSM 把使用中的项目的服务全部拉起、全部关掉（关了一直关着，直到再启动） */
  projectServicesAction: "project_services_action",
  /** 对任务的控制：暂停、继续、取消、失败后重试、返工、由我验收的阶段验收通过或退回（13 号票） */
  taskAction: "task_action",
  /** 一次对多个任务做同一个控制（90 号票：看板多选的暂停、继续、取消、归档）：各自成败，逐条回报 */
  taskBatchAction: "task_batch_action",
  /** 气泡菜单里的"重新识别"：识别失败的语音重新排队识别（31 号票） */
  retryVoice: "retry_voice",
  /** 项目页、任务详情里直接改工具包（扩大、减少都直接写进工具包，不出计划变更卡，27 号票） */
  setToolkit: "set_toolkit",
  /** 看板上对定时触发的任务的动作：暂停、恢复、取消（19 号票的定时作业；76 号票起是定时触发的任务的触发登记） */
  scheduledJobAction: "scheduled_job_action",
  /** 改定时触发的任务的时间表（98 号票）：任务操作菜单里的"改时间"，不用取消重建；只认定时的、没取消的触发登记 */
  rescheduleJob: "reschedule_job",
  /** 定时 / 事件触发的任务立即运行一次（100 号票）：任务操作菜单里的"立即运行一次"；触发记成手动，不改时间表，上一次还没跑完的拒绝 */
  runJobNow: "run_job_now",
  /** 开关任务的"跑完自动播报"（100 号票）：开着时做完秘书直接把要点念成语音气泡，不问 */
  setVoiceAnnounce: "set_voice_announce",
  /** 发起对话框里选了"只提醒我"：建一条简单提醒（不用 agent，到点只发通知），时间表和定时触发的任务同一套（76 号票） */
  createReminder: "create_reminder",
  /**
   * 对一条或几条简单提醒做同一件事（185 号票）：取消（还没触发的）、归档（已经结束的：一次性的已触发、已取消）、删除（任何提醒）。
   * 看板卡的菜单、提醒卡上的按钮、看板多选都交它；各自成败，逐条回报
   */
  reminderAction: "reminder_action",
  /** 记下会话看到哪一条了（109 号票）：秘书页上滚到了那条消息、或者停在最底部；只往后挪，几台设备同步 */
  markRead: "mark_read",
  /**
   * 守护进程是哪一版、什么时候起来的、它此刻的时间（124 号票：设置里的"关于二狗"、Debug 工具集的"测一次延迟"和测试提醒）。
   * 只读、没有副作用，不带幂等键
   */
  daemonInfo: "daemon_info",
  /** 输入框旁的"停止"（144 号票）：停下这个会话的 agent 正在回复的这一轮；没在回复时什么都不做 */
  stopReply: "stop_reply",
  /** 聊天区里排队的消息（144 号票）：叉掉一条（remove）、长按拖动改顺序（reorder） */
  queuedMessageAction: "queued_message_action",
  /**
   * 浏览侧边栏（147 号票）：设备报它的浏览器现在的样子（开着哪个网页、选中了哪个框），变了就报、连上后再报；连接断了就当浏览器关了。
   * 不带幂等键（覆盖"现在的样子"）
   */
  browserStatus: "browser_status",
  /** 浏览侧边栏（147 号票）：设备办完了守护进程推来的 browser_request（秘书的网页工具：读网页、填字、交文件、开网址），回结果。不带幂等键 */
  browserReply: "browser_reply",
  /**
   * 会话回退（150 号票）：缩小视图里点 ↶、确认之后回到某条之前——停稳 agent、给被放弃的那段写摘要、会话树长出新分支。
   * 做完（或没做成）才回响应
   */
  rollbackSession: "rollback_session",
  /**
   * 切换分支（151 号票）：展开的 ⑂ 预览上点"切换到这条分支"——停稳 agent、会话树切到那条分支的末端
   * （不写摘要）、原来的当前分支成为废弃分支。做完（或没做成）才回响应
   */
  switchBranch: "switch_branch",
  /** 废弃分支的详情里一件遗留效果的「申请撤回」（151 号票）：记一笔"已提交撤销请求"、调撤销接口（默认什么都不做） */
  requestEffectUndo: "request_effect_undo",
} as const;

export type Method = (typeof METHODS)[keyof typeof METHODS];

/** 这些方法有副作用，请求必须带幂等键 */
export const METHODS_REQUIRING_IDEMPOTENCY_KEY = [
  METHODS.sendMessage,
  METHODS.cardAction,
  METHODS.inboxAction,
  METHODS.revokeDevice,
  METHODS.deviceBatchAction,
  METHODS.startTask,
  METHODS.updateWatchCategories,
  METHODS.newProject,
  METHODS.convertTaskToProject,
  METHODS.projectAction,
  METHODS.resetMaintainer,
  METHODS.projectServicesAction,
  METHODS.taskAction,
  METHODS.taskBatchAction,
  METHODS.retryVoice,
  METHODS.setToolkit,
  METHODS.scheduledJobAction,
  METHODS.rescheduleJob,
  METHODS.runJobNow,
  METHODS.setVoiceAnnounce,
  METHODS.createReminder,
  METHODS.reminderAction,
  METHODS.markRead,
  METHODS.stopReply,
  METHODS.queuedMessageAction,
  METHODS.rollbackSession,
  METHODS.switchBranch,
  METHODS.requestEffectUndo,
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
export const DISPOSITION_LABEL: Readonly<Record<(typeof DISPOSITIONS)[number], string>> = tTable({
  do: "protocol.disposition.do",
  do_then_tell: "protocol.disposition.doThenTell",
  planned_only: "protocol.disposition.plannedOnly",
  ask_first: "protocol.disposition.askFirst",
  hand_to_me: "protocol.disposition.handToMe",
  never: "protocol.disposition.never",
});

/**
 * 一次工具调用做了什么性质的事（54 号票）：只看（什么都不改）、动手（只新增、不碰已有的）、
 * 删改（改了或去掉了原有的东西：局部改或整个覆盖已有的文件、删除、移动或改名、丢弃 git 改动、强推……）。
 * 守护进程按守卫的工具注册表和这次判定实际要判的调用定（daemon/src/guard/nature.ts），会话缩小后工具色块按它分深浅
 */
export const TOOL_NATURES = ["look", "act", "modify"] as const;

/** 性质的中文名（图例） */
export const TOOL_NATURE_LABEL: Readonly<Record<(typeof TOOL_NATURES)[number], string>> = tTable({
  look: "protocol.toolNature.look",
  act: "protocol.toolNature.act",
  modify: "protocol.toolNature.modify",
});

/**
 * 一次工具调用要动的是对外的事还是本机的敏感权限（93 号票：每次调用的策略标记里有敏感操作
 * （op）的，按工具的权限种类分"外"（对外动作）、"权"（敏感权限））。二狗的"敏感操作"是命中了关注类别的调用，"对外"只有一个口径：
 * 守卫的 sendsOut（会联网，带了请求数据或者不是只往下拉的，和计划卡授权说法的 outward 同一个）。守护进程记在工具调用 part 的 mark 上，
 * 收着的阶段框条外照它标（放行执行完的才标）
 */
export const TOOL_CALL_MARKS = ["out", "perm"] as const;

/** 工具调用的结果：正在执行、放行执行完、被拦下、问过用户后被拒、出错。 */
export const TOOL_CALL_OUTCOMES = ["running", "done", "blocked", "denied", "error"] as const;

/**
 * 工具调用被拦下的原因不是处置时（规格第 9 节）：硬拒绝（越出能力或边界）、按规则退回（时序规则的前提没满足、
 * 要跑的脚本执行前没法检查），以及守卫判定出错（没判出结果，这次调用不执行）。
 */
export const TOOL_CALL_BLOCKS = ["hard_refusal", "pull_back", "judge_error", "plan_redirect", "plan_check", "superseded"] as const;

/**
 * 被拦下的原因的中文名（会话里的工具调用、时间线的要点共用；25 号票从 Web 挪到这里）。
 * 59 号票加了流程执行时的两种：前置步骤没做、先引回计划里的那一步（plan_redirect，自动纠偏，不打扰用户）；
 * 和授权的计划比对后直接拦下（plan_check：只许做一次的又做了一次、审查时剔除的对象）
 */
export const TOOL_CALL_BLOCK_LABEL: Readonly<Record<(typeof TOOL_CALL_BLOCKS)[number], string>> = tTable({
  hard_refusal: "protocol.toolCallBlock.hardRefusal",
  pull_back: "protocol.toolCallBlock.pullBack",
  judge_error: "protocol.toolCallBlock.judgeError",
  plan_redirect: "protocol.toolCallBlock.planRedirect",
  plan_check: "protocol.toolCallBlock.planCheck",
  // 84 号票：从某个阶段重做时手头那一轮没停下来，那一轮之后的调用不再放行（重开时的 generation）
  superseded: "protocol.toolCallBlock.superseded",
});

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
  /** "首版做完了"卡（112 号票）：项目的建设任务做完了，做成了什么、每个阶段的验收结果；你选转入使用、继续建设或放弃并归档 */
  "build_done",
  /**
   * "转入使用"确认卡（259 号票）：建设中的项目要转入使用（用户在项目页点的、维护者提的、秘书代办的），卡上列转运营检查清单；
   * 你确认了才转
   */
  "go_live",
  /** "立项要求变更"卡（125 号票）：立项书确认之后改目标、范围、首版，逐条对照新旧，附运行时核实过的用户原话；你确认了才改写立项书 */
  "charter_change",
  /** "运营方案变更"卡（130 号票）：使用中的项目交了新的运营方案，和现在生效的比出加了、改了、去掉哪几条；你确认了才照差异生效 */
  "operations_change",
  /** 服务入口卡（133 号票）：秘书给出某个项目的服务的入口，"打开「X」"点了在内置浏览器里打开；出来就是已处理 */
  "service_entry",
  /** 网页候选卡（147 号票）：秘书在浏览侧边栏里替选中的上传框找文件、拿不准时给用户挑的候选；单张的框单选、多张的框多选，"交"或"都不要" */
  "browse_pick",
  /**
   * "MCP 登记变更"卡（239 号票）：维护者提的加、改、删一条 MCP 登记，卡上列出启动命令、args、env（密钥只写"来自环境变量 X"）、
   * 暴露的工具和只读/联网标注、快速动作；你确认之后由运行时按 name 合并写进配置区的 mcp.json，顺手真拉起一次做自检
   */
  "mcp_change",
  /**
   * "规范改写"卡（261 号票）：维护者提的本项目的规范改写（不要某一份、某一份换写法、多一份、恢复照默认）或跟新版规范，
   * 逐条对照、附运行时核实过的用户原话；你确认了才生效（记进项目档案的 standard-overrides.md）
   */
  "standard_change",
  /**
   * "补齐规范文档"卡（262 号票）：规范上线之前建的项目，按它的类型和本项目的规范改写还缺哪几份；你选"补齐"才改用现在的规范、
   * 建任务交给维护者补，选"不补"就不补；一个项目只出一次
   */
  "standard_backfill",
  /**
   * 个人档案的核对卡（281 号票）：秘书提议写档案、要用户核对的——写给谁、哪些字段（号码逐位列出）、记下哪件事；
   * 你确认了才写进档案（原话里明说了的非号码类不出这张卡，直接写、留快速动作的"已执行"卡）
   */
  "personal_file",
  /**
   * 个人档案的候选核对卡（283 号票）：每晚整理把白天听到的人物信息攒成候选、提到够几次的人提议建档，第二天合成一张逐条勾；
   * 秘书直接写进档案的生日问一句要不要每年提醒也用它。推断出来的只当候选，你勾了才写
   */
  "personal_file_suggest",
  /**
   * 约访卡（284 号票）：记忆管理员每周在待办里约一次了解你访谈（五个主题都聊过以后每月一次"最近有什么变化"），不卡事；
   * "开始"开一次访谈（在管理员的会话里一问一答）、"下次再说"、"不想做了"（以后不再约，设置 · 记忆里能重新打开）
   */
  "interview",
  /**
   * 访谈的档案核对卡（284 号票）：一次了解你访谈收尾时，这次听到的档案信息（生日、电话、单位……）合成一张，逐条"确认""不记"；
   * 确认的经个人档案（281 号票）的同一个写入口写进去
   */
  "interview_files",
  /**
   * 运行时的提问卡（288 号票）：维护者的运行时自己要问你的——Claude Code 的 AskUserQuestion（选择题，可多选、可自己写）、
   * 退出计划模式时的批准；答案交回那次调用，这一轮结束了还没答的作废
   */
  "runtime_question",
] as const;

export type CardType = (typeof CARD_TYPES)[number];

export function isCardType(value: string): value is CardType {
  return (CARD_TYPES as readonly string[]).includes(value);
}

/**
 * 每种卡片负载的版本（卡片类型注册表登记的版本）。负载的形状改了就把版本加 1：
 * 前端只认识自己构建时的版本，遇到更高版本的卡片和不认识的类型一样，显示纯文本降级版本加"去 Web 处理"的链接。
 * reminder 2、plan 2：时间表（提醒的、计划里定时作业的）多了"按我的工作日"（29 号票）。
 * questions 2（16 号票）：项目维护者为工单提问时，卡上记着是谁在问（askedBy），回答交回它。
 * plan 5、plan_change 2（76 号票）：计划里不再有定时作业（scheduledJobs）。
 * reminder 4、workflow_plan 3（282 号票）：时间表多了"每年某月某日"（yearly）。
 */
export const CARD_TYPE_VERSIONS: Readonly<Record<CardType, number>> = {
  /**
   * 3（26 号票）：计划里有用户的限制（userLimits），确认时可以加本任务的关注类别（addedCategories）；
   * 4（17 号票）：涉及的项目每一行可以写所属阶段和这张工单的验收标准（涉及多个项目的任务确认后变成工单）；
   * 5（76 号票）：计划里不再有定时作业（要定时做的事建成定时触发的普通任务或流程）
   */
  plan: 5,
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
  /** 3（185 号票）：提醒能归档（archived）、删除（状态多了 deleted）；4（282 号票）：时间表多了每年某月某日 */
  reminder: 4,
  charter: 1,
  work_order: 1,
  /** 2（76 号票）：卡上的整份计划里不再有定时作业 */
  plan_change: 2,
  parallel: 1,
  memory_delete: 1,
  /** 2（137 号票）：看起来像网络上的自动访问的请求，卡上带着判断和原因（automated） */
  pairing: 2,
  /** 27 号票：项目维护者不在任务里时要开 bash、加 MCP、开联网 */
  toolkit_change: 1,
  archive_list: 1,
  /** 2（76 号票）：定时触发的流程带着时间表（schedule），卡上写明授权一直有效，直到暂停或取消；3（282 号票）：时间表多了每年某月某日 */
  workflow_plan: 3,
  /**
   * 2（130 号票）：卡上带着维护者建设期间交的运营方案（operations），选了以后记着每一条的结局；
   * 3（133 号票）：方案里的一条可以是服务（service：命令、工作目录、端口、开机自启、网页……）；
   * 4（259 号票）：卡上带着转运营检查清单（checklist），确认时还缺的几项记在决定里
   */
  build_done: 4,
  /** 259 号票：转入使用的确认（谁发起的、为什么、检查清单、运营方案） */
  go_live: 1,
  charter_change: 1,
  /** 2（133 号票）：方案里的一条可以是服务（service） */
  operations_change: 2,
  service_entry: 1,
  browse_pick: 1,
  /** 239 号票：维护者提的 MCP 登记变更（加、改、删），确认后由运行时写配置区的 mcp.json */
  mcp_change: 1,
  /** 261 号票：本项目的规范改写、跟新版规范，确认了才生效 */
  standard_change: 1,
  /** 262 号票：规范上线之前建的项目补齐规范文档，选补齐才建任务 */
  standard_backfill: 1,
  /** 281 号票：个人档案的核对卡；2（283 号票）：生日、纪念日带着每年提醒的勾（remind） */
  personal_file: 2,
  /** 283 号票：个人档案的候选核对卡 */
  personal_file_suggest: 1,
  /** 284 号票：了解你访谈的约访卡 */
  interview: 1,
  /** 284 号票：访谈的档案核对卡 */
  interview_files: 1,
  /** 288 号票：运行时的提问卡 */
  runtime_question: 1,
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
  /** "首版做完了"卡上的三个选择（112 号票）：转入使用、继续建设（附一句这一轮要做什么）、放弃并归档 */
  "put_in_use",
  "keep_building",
  "abandon",
  /** 约访卡上的三个选择（284 号票）：开始访谈、下次再说、不想做了 */
  "start",
  "later",
  "decline",
] as const;

/** 卡片状态：待处理、已处理、已关闭（用户关掉不处理）、已过期。 */
export const CARD_STATUSES = ["pending", "handled", "dismissed", "expired"] as const;

/** 紧急度三档：卡住任务且有时限、卡住任务、不卡任务。 */
export const URGENCIES = ["blocking_deadline", "blocking", "non_blocking"] as const;

/** 紧急度的中文名（待我处理页、秘书列出待我处理时共用）；URGENCIES 的先后就是排序（紧的在前） */
export const URGENCY_LABEL: Readonly<Record<(typeof URGENCIES)[number], string>> = tTable({
  blocking_deadline: "protocol.urgency.blockingDeadline",
  blocking: "protocol.urgency.blocking",
  non_blocking: "protocol.urgency.nonBlocking",
});

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
export const QUICK_ACTION_BASIS_LABEL: Readonly<Record<QuickActionBasis, string>> = tTable({
  explicit: "protocol.quickAction.basis.explicit",
  within_grant: "protocol.quickAction.basis.withinGrant",
  confirmed: "protocol.quickAction.basis.confirmed",
});

/** 记忆命令的中文名 */
export const MEMORY_COMMAND_LABEL: Readonly<Record<MemoryCommandKind, string>> = tTable({
  remember: "protocol.memoryCommand.remember",
  forget: "protocol.memoryCommand.forget",
  purge: "protocol.memoryCommand.purge",
  no_infer: "protocol.memoryCommand.noInfer",
});

/**
 * 彻底删除删不掉的东西，如实告诉用户（设置页、记忆删除卡上都写）；秘书写名字占位，界面按用户起的名字显示（43 号票）。
 * 确认计划时在卡上改的假设栏、加的关注类别（80 号票）成了确认的计划的一部分，维护者照它做、守卫照它判，不改写；
 * 秘书转达进任务、项目维护者会话的那一句（103 号票）不是用户本人的素材，不随用户在秘书会话里的原话一起改写
 */
export let PURGE_LIMITS = "";

/**
 * 删除项目删不掉的东西，如实写在删除项目的二次确认上（66 号票，照 PURGE_LIMITS 的写法）：项目之外读过这个项目的调用按碰到的
 * 路径认，认不出路径的（环境变量拼出的、看不透的命令）不改写；pi 的 bash 输出太长时另存的临时文件不在二狗的记录里；
 * 据此说过的话、备份同彻底删除
 */
export let PROJECT_DELETE_LIMITS = "";

followLocale(() => {
  PURGE_LIMITS = t("protocol.memoryDelete.purgeLimits", { assistant: ASSISTANT_NAME_MARK });
  PROJECT_DELETE_LIMITS = t("protocol.memoryDelete.projectDeleteLimits", { assistant: ASSISTANT_NAME_MARK });
});

/**
 * 三种删法各自的说法（守护进程、Web 共用这一张表，分支都收在这里）：
 * - done：做完以后怎么说（"已忘掉 3 条素材"）；
 * - note：给用户看的说明（设置页、记忆删除卡）；
 * - usage：给秘书看的用法（写进"提议快速动作"工具的说明，照旧中文）。
 * done、note 跟着当前语言（取值时现查）
 */
export const MEMORY_DELETE_MODE_INFO: Readonly<Record<(typeof MEMORY_DELETE_MODES)[number], { done: string; note: string; usage: string }>> = {
  forget: {
    get done() {
      return t("protocol.memoryDelete.forget.done");
    },
    get note() {
      return t("protocol.memoryDelete.forget.note");
    },
    usage: "用户说\"忘掉……\"：从素材库删掉（聊天记录里仍看得到原话）", // @i18n-ignore model
  },
  purge: {
    get done() {
      return t("protocol.memoryDelete.purge.done");
    },
    get note() {
      return t("protocol.memoryDelete.purge.note", { limits: PURGE_LIMITS });
    },
    usage: "用户说\"彻底删除……\"：连会话原文一起删，原文改写成删除标记", // @i18n-ignore model
  },
  no_infer: {
    get done() {
      return t("protocol.memoryDelete.noInfer.done");
    },
    get note() {
      return t("protocol.memoryDelete.noInfer.note");
    },
    usage: "用户说\"别推断……\"：素材保留，标记为不参与推断", // @i18n-ignore model
  },
};

/** 一张记忆删除卡、一次删除最多多少条素材（卡片上列得下、用户核对得过来；协议的 schema 和守护进程用同一个值） */
export const MAX_MEMORY_DELETE_MATERIALS = 50;

// ───────────────────────── 设置里看素材（158 号票） ─────────────────────────
// 素材的切段词汇原来只在守护进程里（08 号票：第一阶段没有素材的页面）；设置里能看每条素材的内容之后，前端也要认，挪到这里，
// 守护进程的 materials/types.ts 直接用这几个。

/**
 * 切段的形态：用户打的字、判断不了来历的纯文本、引用块、附件、网页、语音转写、用户接受的 agent 提议、agent 的产出
 */
export const MATERIAL_SEGMENT_FORMS = ["typed", "text", "quote", "attachment", "web_page", "voice", "choice", "agent_output"] as const;
export type MaterialSegmentForm = (typeof MATERIAL_SEGMENT_FORMS)[number];

/** 来源等级：本人、agent、外部（不可信）、系统。只有"本人"的内容另存原文副本 */
export const MATERIAL_SOURCE_LEVELS = ["self", "agent", "external_untrusted", "system"] as const;
export type MaterialSourceLevel = (typeof MATERIAL_SOURCE_LEVELS)[number];

/** 切段的注明：agent 先提出（用户接受了 agent 的提议）、转写（语音转写） */
export const MATERIAL_SEGMENT_NOTES = ["agent_proposed", "transcribed"] as const;
export type MaterialSegmentNote = (typeof MATERIAL_SEGMENT_NOTES)[number];

/** 设置里的素材列表一页最多多少条 */
export const MATERIAL_LIST_MAX = 100;

// ───────────────────────── 记忆 · 素材的筛选（167 号票） ─────────────────────────

/**
 * 记忆 · 素材按种类筛（给用户看的分法，不是素材的八种 kind）：说过的话、做过的（对产出的反应、审批、点卡片、关掉或一直没处理的卡、任务结局）、
 * 附件、语音、存的网页（"浏览"里存进素材的）、数据源导入的（303 号票：观察到的本人行为、别人写给你的、本人写的）、记忆命令。
 * 一条素材可以同时算几种：发了附件还说了话的，既是说过的话、也是附件。怎么认在守护进程的 materials/facets.ts（materialFacets）
 */
export const MATERIAL_FACETS = ["said", "did", "attachment", "voice", "web_page", "data_source", "memory_command"] as const;
export type MaterialFacet = (typeof MATERIAL_FACETS)[number];

export const MATERIAL_FACET_LABEL: Readonly<Record<MaterialFacet, string>> = tTable({
  said: "protocol.materialFacet.said",
  did: "protocol.materialFacet.did",
  attachment: "protocol.materialFacet.attachment",
  voice: "protocol.materialFacet.voice",
  web_page: "protocol.materialFacet.webPage",
  data_source: "protocol.materialFacet.dataSource",
  memory_command: "protocol.materialFacet.memoryCommand",
});

/** 每种再说细一点（筛选的小签上的提示） */
export const MATERIAL_FACET_HINT: Readonly<Record<MaterialFacet, string>> = tTable({
  said: "protocol.materialFacet.hint.said",
  did: "protocol.materialFacet.hint.did",
  attachment: "protocol.materialFacet.hint.attachment",
  voice: "protocol.materialFacet.hint.voice",
  web_page: "protocol.materialFacet.hint.webPage",
  data_source: "protocol.materialFacet.hint.dataSource",
  memory_command: "protocol.materialFacet.hint.memoryCommand",
});

/** 记忆 · 素材的关键词最长多少字 */
export const MATERIAL_QUERY_MAX = 200;

// ───────────────────────── 回话时调用记忆（187 号票） ─────────────────────────

/**
 * 一次"调用记忆"从哪来：检索素材（search_materials）、读一条素材的全文（read_material）、问记忆（ask_memory，263 号票：
 * 查推理图谱，命中是简报里引用的证据背后的素材）、记忆简报（brief，266 号票：用户这句话有相关的记忆时自动带给秘书的，
 * 命中同样是简报里引用的证据背后的素材，挂在秘书这一轮回话的 MemoryBriefPart 上）。网页都画成"回忆了 N 条记忆 ›"那一行
 */
export const MEMORY_RECALL_SOURCES = ["search", "read", "ask", "brief"] as const;

/**
 * 记忆简报里一条为什么带（266 号票，@ergo/memory 的 MessageBriefReason）：直接说到这件事（过了相关门槛的往上走、结论索引）、
 * 同一方面（只有领域对上）、明说过的禁忌、还没分出胜负的一组解释、任务能用的交互策略
 */
export const MEMORY_BRIEF_REASONS = ["direct", "area", "hard", "undecided", "strategy"] as const;
export type MemoryBriefReason = (typeof MEMORY_BRIEF_REASONS)[number];

/** 记忆简报里"直接说到这件事"的结论是经哪条路过的相关门槛（@ergo/memory 的 RouteName）：从用户说过的话往上走、结论索引、领域 */
export const MEMORY_BRIEF_ROUTES = ["upward", "index", "domain"] as const;
export type MemoryBriefRoute = (typeof MEMORY_BRIEF_ROUTES)[number];
export type MemoryRecallSource = (typeof MEMORY_RECALL_SOURCES)[number];

/** 检索素材时"为什么查"最长多少字（search_materials 的 why，一句话） */
export const MEMORY_RECALL_WHY_MAX = 120;

/** 一次调用记忆最多带几条命中（检索素材的 limit 最多 30） */
export const MEMORY_RECALL_HITS_MAX = 30;

/**
 * "记住"的内容是从哪里来的（素材的来源标记跟着它）：
 * - typed：用户这条消息里自己打的字；
 * - voice：用户这条消息里的语音识别出的文字（31 号票：语音转写和打的字一样参与点明判定，素材注明"转写"）；
 * - quote：只在用户消息的引用块里（外部、不可信）；
 * - card：只在用户引用的卡片里（agent 先提出、用户选的）；
 * - proposed：秘书推断出来、用户在卡上确认的（用户的选择，agent 先提出）。
 */
export const REMEMBER_SOURCES = ["typed", "voice", "quote", "card", "proposed"] as const;

/**
 * 被彻底删除的内容换成这句：事件里带原话的文本字段、卡片上的摘录、会话文件里的消息和工具结果。
 * 它是删除标记（好几处按 === 认），不跟着语言变（172 号票）
 */
export const PURGED_TEXT = "（这条内容已彻底删除）"; // @i18n-ignore fixed：删除标记，按字认

/** 会话文件里覆盖了被删内容的压缩摘要、分支摘要整段换成这句（删除标记，不跟着语言变） */
export const PURGED_SUMMARY_TEXT = "（这段摘要含已彻底删除的内容，已移除）"; // @i18n-ignore fixed：删除标记

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
  /**
   * 备份交给外部定时器（backup.schedule 是 external，335 号票）以后连着两天没人备份过（调 npm run backup 的定时任务可能被暂停、删掉了）：
   * 不卡任务，动作"立即备份"（守护进程马上做一次）、"知道了"；还没处理的那条在，就不再放新的
   */
  "backup_overdue",
  /** 定时触发的任务连续失败到次数自动暂停（19 号票；76 号票起作业并进定时触发的任务）：动作"恢复""保持暂停"，data 是 JobAutoPausedNoticeData */
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
  /**
   * 流程撤回之后在等你（155 号票）：撤回会话（切换分支）之后流程停在那里，等你在任务里说一句再接着做；一分钟内你没在这个任务里说话，
   * 提醒你一次（卡着这个流程、推送；来源是这个任务，点了进任务会话）。你说了话、流程不在执行中了，系统替你记成处理过。
   * 动作"知道了"（ROLLBACK_WAIT_ACK，只是收起这条，流程照旧等你说话），data 是 RollbackWaitNoticeData
   */
  "rollback_wait",
  /**
   * 重做之后复验没过（274 号票，"重开之后复验没过"）：从某个阶段重做之后，
   * 范围外已经验收过的阶段按各自的验收标准再核一遍，有标准不满足了。不卡任务（维护者照常重做重开的那几个），不自动重做；
   * 动作"先不管""把没过的阶段也重做"（REVERIFY_ACTIONS，界面上写"把第 N 阶段也重做…"，先出重做对话框），data 是 ReverifyNoticeData
   */
  "reverify_failed",
] as const;

// 待我处理事项的动作按字认（存进事件、点了按字找处理的），不跟着语言变（172 号票）；界面上显示时用 inboxActionText 换成当前语言
/** "没有参考音色"事项的动作：去设置里的语音页导入参考音色 */
export const VOICE_REFERENCE_IMPORT_ACTION = "去导入参考音色"; // @i18n-ignore fixed：事项的动作按字认

/** "向量模型还没下载"事项的动作（323 号票）：去设置里的组件页装上（不算处理；装好后自动归档） */
export const COMPONENTS_INSTALL_ACTION = "去装组件"; // @i18n-ignore fixed：事项的动作按字认

/** "关注类别设置文件有问题"事项的动作：去设置里的关注类别页修复 */
export const WATCH_CATEGORIES_REPAIR_ACTION = "去设置页修复"; // @i18n-ignore fixed：事项的动作按字认

/** "节假日数据缺失"事项的动作：发起一个联网任务去更新 */
export const HOLIDAY_UPDATE_ACTION = "发起更新任务"; // @i18n-ignore fixed：事项的动作按字认

/** "交给我做"事项的处理动作 */
export const HAND_OVER_DONE = "已完成"; // @i18n-ignore fixed：事项的动作按字认

export type NoticeType = (typeof NOTICE_TYPES)[number];

/** 对待我处理事项的动作：标已读、标未读、归档、取消归档、删除、处理通知类事项（选它的一个动作） */
export const INBOX_ACTIONS = ["read", "unread", "archive", "unarchive", "delete", "handle"] as const;

/** 一次 inbox_action 最多对几项做（Web 多于这些时分批交，90 号票） */
export const INBOX_ACTION_MAX = 500;

/** 紧急度为这两档（卡着任务）的事项，处理之前不能归档或删除 */
export const BLOCKING_URGENCIES = ["blocking_deadline", "blocking"] as const;

// ───────────────────────── 简单提醒 ─────────────────────────

/**
 * 简单提醒的状态：待触发、已触发（只有一次性的会到这里；重复的一直待触发）、已取消、已删除（185 号票：任何提醒都能删，
 * 删了看板、日历、待办里都不再有它；编号不收回，事件日志里照旧有它的每一次变化）
 */
export const REMINDER_STATUSES = ["pending", "fired", "cancelled", "deleted"] as const;

/** 简单提醒状态的中文名（看板、提醒卡、秘书看的看板共用） */
export const REMINDER_STATUS_LABEL: Readonly<Record<(typeof REMINDER_STATUSES)[number], string>> = tTable({
  pending: "protocol.reminder.status.pending",
  fired: "protocol.reminder.status.fired",
  cancelled: "protocol.reminder.status.cancelled",
  deleted: "protocol.reminder.status.deleted",
});

/**
 * 一条提醒的变化：秘书或用户建、改、取消，调度器到点触发；
 * missed 是到点时守护进程没在运行、晚了超过 60 分钟，没有照发，改放进待我处理（错过的提醒）；
 * archived、deleted（185 号票）：用户（在看板、提醒卡上，或者让秘书）归档、删除。删除只追加这一条，不改写以前的事件
 */
export const REMINDER_CHANGES = ["created", "updated", "cancelled", "fired", "missed", "archived", "deleted"] as const;

export type ReminderChangeKind = (typeof REMINDER_CHANGES)[number];

/**
 * 对简单提醒的动作（185 号票，reminder_action）：取消（还没触发的：待触发的一次性、重复、事件发生时提醒的）、
 * 归档（已经结束的：一次性的已触发、已取消；进看板的"已归档"）、删除（任何没删过的提醒）。任务没有取消归档，提醒也没有
 */
export const REMINDER_ACTIONS = ["cancel", "archive", "delete"] as const;
export type ReminderAction = (typeof REMINDER_ACTIONS)[number];

/** reminder_action 一次最多几条（和任务的批量一样） */
export const REMINDER_ACTION_MAX = 200;

// ───────────────────────── 已配对设备 ─────────────────────────

/**
 * 一台已配对设备的变化：批准配对后领到凭证（还没用过）、第一次带着凭证来（启用）、使用（续期）、被吊销；
 * 123 号票起还有延期（到期日往后推，过期、作废了的因此重新有效）和删除（从列表里去掉、凭证一律不认；还没吊销的
 * 同一事务里先落一条吊销）
 */
export const DEVICE_CHANGES = ["paired", "activated", "used", "revoked", "extended", "deleted"] as const;

/** 设置 · 已配对设备多选能做的（123 号票）：延期、吊销、删除 */
export const DEVICE_BATCH_ACTIONS = ["extend", "revoke", "delete"] as const;
export type DeviceBatchAction = (typeof DEVICE_BATCH_ACTIONS)[number];

/** 多选里一台设备为什么跳过：没有这台、已经吊销了（不能延期、不用再吊销）、已经删除了 */
export const DEVICE_BATCH_SKIPS = ["not_found", "revoked", "deleted"] as const;
export type DeviceBatchSkip = (typeof DEVICE_BATCH_SKIPS)[number];

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
