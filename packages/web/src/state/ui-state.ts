// 前端状态层：把事件流归并成界面状态。全部是纯函数，不依赖 React 和 DOM。
//
// 两类输入：
// - 事件帧：服务端在某个频道上推来的权威事件。按频道记下最后收到的序号，重复或更旧的直接丢掉。
//   临时事件（流式增量）不占序号，只归并成"正在生成的回复"，定稿消息到了就被它替换。
// - 本地动作：用户刚做、服务端还没确认的事（发消息）。先乐观显示在会话末尾，
//   收到带同一个幂等键的权威事件后被替换；请求失败就标成失败，留着原文好重发。
// - 连接状态：连接告诉状态层的（连接中、在线、断开、页面版本过旧）；以及"重新同步某个频道"
//   （前端的序号比服务端还大，比如数据目录恢复成了旧快照：清掉这个频道，服务端从头补发）。
// - 往上翻取回的一页历史（HTTP）：会话频道第一次只补发最近一页，更早的消息按序号并进来，不推进游标。
// 06 号票起还有：待我处理事项（inbox_item）、简单提醒（看板频道上的 reminder）、到点的通知（临时的 notify，
// 界面显示过就用 alert_seen 去掉）、和消息与卡片对不上的被拒请求（比如卡着任务的事项不能删，界面提示过就用 failure_seen 去掉）。
// 待我处理的排序和 tab 上的提示见 inbox.ts，卡片的纯文本降级见 cards.ts。
// 12 号票起还有：任务（看板频道上的 task 事件，看板的五组见 board.ts）、agent 的活动状态（活动状态频道上的 activity 事件）。
// 10 号票起还有：已配对设备（devices 频道上的 device 事件，列表和分组见 devices.ts；123 号票起删了的去掉）；连接状态多了 unpaired
// （外网端口上这台设备的凭证失效了：被吊销或过期，界面回到配对等待页，开场方式见 pairing-gate.ts）。
// 21 号票起：被彻底删除的消息（事件改写成"已删除"标记，或者 messages_purged 说手里的哪几条被删了）在原来的位置只剩一条
// "已删除"，原话不留；带原话的工具调用记录换成改写后的样子（messages_purged 里的 replacement）。
// 输入框里引用的卡片（quote_card / unquote_card）也在这里：发消息时带上，发出去就清掉。
// 29 号票起：个人工作日历（calendar 频道上的节假日数据和个人设置的最新样子），每天的结果见 workday.ts。
// 15 号票起：项目（项目列表频道上的 project 事件，列表和项目页的入口见 projects.ts）；删掉的项目连同它的维护者会话一起拿掉。
// 24 号票起：任务和定时作业名下的 token 用量合计（看板频道上的 token_totals，每次记账后一条最新的），任务卡、作业卡、
// 任务详情的细分见 usage.ts。
// 25 号票起：会话里除了消息还有时间线上的记录（timeline_record：偏离、范围变更、越界；quick_action_executed：快速动作的操作记录），
// 和消息一起按序号排进时间线（timelineItems；要点层、全局层见 timeline.ts）；往上翻取回的一页里也带着落在那一页里的记录。
// 消息、记录都记下归属（共享协议包的 MessageScope：任务、项目、阶段；全局层按它聚色块）。操作记录跟着它的快速动作卡：
// 卡片来了新版本（彻底删除时换成去掉原话的），操作记录的标题、参数、结果一起换。
// 活动状态多了说明（落盘的 activity 事件里）和干活中的进度（临时的 activity_progress，状态变了就作废），agentActivity 取两者，
// 没收到过的是休眠。
// 31 号票起：语音对象（会话频道上的 voice 事件，按版本留最新的；往上翻取回的一页也带着它们），气泡要的东西见 voice.ts。
// 16 号票起：工单（项目列表频道上的 work_order 事件，项目页的工单流水线和看板上的"等项目 X"见 work-orders.ts）；
// 删掉的项目连同它的工单一起拿掉。维护者会话的分段（segment 事件）界面不用：分隔线是会话里的工单分隔 part。
// 32 号票起：agent 发的语音（会话频道上的 agent_voice 事件，按版本留最新的；往上翻取回的一页也带着它们），气泡和"转文字"见
// agent-voice.ts。用语音回复的那一轮不流式显示回复；整段合成的回复文字收进语音里（时间线上不显示，长按"转文字"展开）。
// 35 号票起：日历（calendar.ts）。经 HTTP 取回的一个月（calendar_month）按月份留着；任务看板频道上的提醒、定时作业事件和工作日历
// 频道上的事件记下最新的序号，比取回的那一份记着的大就算旧了，页面重新取；306 号票起工作日历频道上的临时事件 external_calendar
// 带来外部日程（数据源交给日历的）的版本，同样比一比。
// 43 号票起：个人助理的名字（名字频道上 assistant_name 事件里的最新名字，没收到过是默认的，见 assistant-name.ts）。
// 249 号票起：用户自己的名字（"我的名字"）：经 HTTP 取回、改过的整份进状态层（不走事件），没设是 undefined（界面照旧），
// 秘书页、待办页的副标题和设置里那一项用它，见 user-name.ts。
// 36 号票起：事件帧带着"是不是订阅之后补发的"（catchUp，连接标的）；实时推来的帧把 agent 语音变成合成完成时记成新到的
// （agentVoiceArrivals），界面据此决定自动播不播（voice-autoplay.ts），决定过了用 agent_voice_arrival_seen 去掉。
// 109 号票起：已读位置（已读位置频道上的 read_mark，守护进程记的、几台设备同步；本机刚看到的先记上，read_seen）；补发推完了没有
// （caughtUp：连接报 synced 才是，断开、重连时回到没有）；实时收到的秘书回合结束（secretaryTurns，界面决定提不提醒之后用
// secretary_turn_seen 去掉）；顶上的通知除了守护进程推来的，还有界面自己出的秘书新消息（alert，PageAlert 带着"查看"去秘书会话的哪一条）。
// 秘书新消息怎么算没看过、提醒怎么出见 secretary-unread.ts。
// 116 号票起：服务端现在提供的网页是哪一版（webVersion：订阅的响应、活动状态频道上推来的临时事件 web_version、切回前台时问到的，
// 都是 web_version 输入；连同"等会儿"update_later，切到后台 page_hidden、切回前台 page_foreground、切回前台后问完了服务端 page_settled），
// 和页面自己的对不上就提示刷新、在后台时来的回到前台直接刷新，见 page-update.ts。
import {
  type ActivityDetail,
  activityDetailText,
  isInternalTo,
  hasOwnMaintainer,
  type ActivityEventPayload,
  type AssistantNameEventPayload,
  type LanguageEventPayload,
  type LocaleEventPayload,
  type PluginDataPurgedEventPayload,
  type PluginStatusEventPayload,
  type ExternalCalendarEventPayload,
  type Card,
  type CardAction,
  type CardEventPayload,
  CHANNELS,
  type ConversationBranches,
  type ConversationId,
  type CredentialRejection,
  type DeletedEventPayload,
  type DeviceEventPayload,
  EVENT_TYPES,
  type HolidayDataEventPayload,
  type HolidayYear,
  type EventFrame,
  type HistoryPage,
  type HistoryRecord,
  maintainerChannel,
  type Project,
  type ProjectEventPayload,
  type InboxItem,
  type InboxItemEventPayload,
  isDeletedEventPayload,
  isEphemeralEventType,
  type BrowsingMark,
  type MessageEnvelope,
  type MessageEventPayload,
  type MessagePart,
  type MessageScope,
  type MessagesPurgedEventPayload,
  type NotifyEventPayload,
  type PairedDevice,
  type Reminder,
  type ReminderEventPayload,
  type ReadMarkEventPayload,
  type StreamDelta,
  type StreamEventPayload,
  type ActivityProgressEventPayload,
  type ActivityState,
  pickMessageScope,
  type QuickActionCardPayload,
  type QuickActionExecutedEventPayload,
  type TimelineRecord,
  type TimelineRecordEventPayload,
  type Task,
  type TaskEventPayload,
  type TaskPlanEventPayload,
  type TokenTotalsEventPayload,
  ledgerOwnerKey,
  type WorkdaySettings,
  type WorkdaySettingsEventPayload,
  type WatchCategorySettingsEventPayload,
  type VoiceEventPayload,
  type VoiceRecord,
  type WorkOrder,
  type WorkOrderEventPayload,
  type AgentVoiceEventPayload,
  type AgentVoiceRecord,
  type ScopeRecord,
  type ScopeRecordEventPayload,
  scopeRecordChannel,
  type JobRun,
  type ScheduledJob,
  type ScheduledJobEventPayload,
  type CalendarMonthView,
  type VoiceModelsView,
  type AgentRolesView,
  type WebVersionEventPayload,
  type ProjectServicesEventPayload,
  type ProjectServiceView,
  type MessageQueueEventPayload,
  type QueuedMessage,
  type TurnEndEventPayload,
  type TurnStartEventPayload,
  onBranchPath,
  type SessionBranchEventPayload,
  type StageStartEventPayload,
  type SegmentEventPayload,
  type BranchEffect,
  branchOwnRanges,
  type BranchView,
  type EffectUndoRequestedEventPayload,
  inRanges,
} from "./protocol.ts";
import { agentVoiceAudible, agentVoiceHoldsReplies, replyCoverage } from "./agent-voice.ts";
import { type CalendarState, initialCalendarState } from "./calendar.ts";
import { newerVoiceModels } from "./voice-models.ts";
import {
  initialWebVersionState,
  type WebVersionState,
  webVersionForeground,
  webVersionHidden,
  webVersionLater,
  webVersionSettled,
  withServerWebVersion,
} from "./page-update.ts";

/** 任务的一次返工（55 号票）：什么时候（任务事件里的 updatedAt）、重开了哪几个阶段 */
export interface TaskReopen {
  readonly time: string;
  readonly stageIds: readonly string[];
}

/**
 * 顶上的一条通知：守护进程推来的（临时的 notify 事件，到点的提醒这类），或者界面自己出的秘书新消息（109 号票）。
 * 秘书的带着 secretary："查看"去秘书会话里的 at（会话条目层的条目 id 或卡片 id，地址 #/secretary/at/<at>）；
 * 已读位置到了 through（这条提醒说到的最后一条的序号）就拿掉（别的设备上看过了）
 */
export type PageAlert = NotifyEventPayload & { readonly secretary?: { readonly at: string; readonly through: number } };

export interface UiState {
  /** 每个频道最后收到的序号 */
  readonly cursors: Readonly<Record<string, number>>;
  /** 会话（键是会话 id，也就是频道名） */
  readonly conversations: Readonly<Record<string, ConversationState>>;
  /** 卡片（键是卡片 id） */
  readonly cards: Readonly<Record<string, CardState>>;
  /** 每个会话里正在生成的回复（键是会话 id）：由流式增量拼成，定稿消息到了就去掉 */
  readonly streams: Readonly<Record<string, StreamingMessage>>;
  /** 待我处理事项（键是事项 id；删掉的不在这里） */
  readonly inbox: Readonly<Record<string, InboxItem>>;
  /** 简单提醒（键是提醒 id） */
  readonly reminders: Readonly<Record<string, Reminder>>;
  /** 任务（键是任务 id）：看板频道上 task 事件里的最新状态 */
  readonly tasks: Readonly<Record<string, Task>>;
  /**
   * 任务的返工（键是任务 id，55 号票）：看板频道上 change 为 rework 的 task 事件，按先后——什么时候、重开了哪几个阶段
   * （84 号票起事件上写着 reopened：阶段开始过就能从它重做；之前的只对已完成的任务，这一刻没验收的就是重开的）。
   * 缩小后的书脊据此把重开之前的那几轮标成"已重开"（zoom-decor.ts），阶段详情的尝试记录、第几轮也按它
   */
  readonly taskReopens: Readonly<Record<string, readonly TaskReopen[]>>;
  /** agent 的活动状态（键是 agent id）：休眠、干活中、等你、排队，连同说明 */
  readonly activity: Readonly<Record<string, ActivityEventPayload>>;
  /** 干活中的 agent 此刻在做什么（键是 agent id；临时事件 activity_progress，下一条 activity 事件到了就作废） */
  readonly activityProgress: Readonly<Record<string, ActivityDetail>>;
  /** 已配对设备（键是设备 id；吊销了的也在，标着 revoked） */
  readonly devices: Readonly<Record<string, PairedDevice>>;
  /** 关注类别设置：关注类别频道上最后一条设置事件（26 号票）；还没收到是 undefined */
  readonly watchCategories: WatchCategorySettingsEventPayload | undefined;
  /** 项目（键是项目 id）：项目列表频道上 project 事件里的最新状态；删掉的不在这里 */
  readonly projects: Readonly<Record<string, Project>>;
  /** 任务、定时作业名下的 token 用量合计（键是 ledgerOwnerKey：task:t-1、job:j-1）：看板频道上最新的 token_totals（24 号票） */
  readonly tokenTotals: Readonly<Record<string, TokenTotalsEventPayload>>;
  /** 工单（键是工单 id，16 号票）：项目列表频道上 work_order 事件里的最新状态；删掉的项目的不在这里 */
  readonly workOrders: Readonly<Record<string, WorkOrder>>;
  /** 定时作业（键是作业 id，19 号票）：看板频道上 scheduled_job 事件里的最新状态 */
  readonly scheduledJobs: Readonly<Record<string, ScheduledJob>>;
  /** 定时作业的运行记录（键是运行号，19 号票）：scheduled_job 事件里带着的运行，留最新的 */
  readonly jobRuns: Readonly<Record<string, JobRun>>;
  /**
   * 执行中的任务现在生效的计划（键是任务 id）：看板频道上最新的 task_plan（14 号票：计划变更确认、维护者自行调整计划之后推来）。
   * 没换过版的任务没有，阶段抽屉取计划卡上的
   */
  readonly taskPlans: Readonly<Record<string, TaskPlanEventPayload>>;
  /**
   * 范围记录（键是记录 id，18 号票）：项目列表频道（项目维护者的）、任务看板频道（不属于项目的任务的）上的 scope_record 事件；
   * 删掉的项目的不在这里
   */
  readonly scopeRecords: Readonly<Record<string, ScopeRecord>>;
  /** 要马上告诉用户的通知（到点的提醒；109 号票起还有秘书新消息）：界面在任意页面提示，显示过就去掉 */
  readonly alerts: readonly PageAlert[];
  /** 被拒的请求里和消息、卡片对不上的那些（比如卡着任务的事项不能删）：界面提示原因，提示过就去掉 */
  readonly failures: readonly RequestFailure[];
  readonly connection: ConnectionStatus;
  /** 连接报 unpaired 时知道的原因（被吊销、过期）；不知道或者不是 unpaired 时没有 */
  readonly unpairedReason: CredentialRejection | undefined;
  /** 输入框里引用的卡片（键是会话 id）：发消息时作为卡片引用带上，发出去就清掉（21 号票） */
  readonly quotes: Readonly<Record<string, readonly string[]>>;
  /** 个人工作日历（29 号票）：工作日历频道上节假日数据和个人设置的最新样子；还没收到的是 undefined */
  readonly workday: { readonly holidays: readonly HolidayYear[] | undefined; readonly settings: WorkdaySettings | undefined };
  /** 语音对象（键是语音 id，31 号票）：会话频道上 voice 事件里的最新版本 */
  readonly voices: Readonly<Record<string, VoiceRecord>>;
  /** agent 发的语音（键是 agent 语音 id，32 号票）：会话频道上 agent_voice 事件里的最新版本 */
  readonly agentVoices: Readonly<Record<string, AgentVoiceRecord>>;
  /**
   * 会话频道上实时收到的回合开始（turn_start）的序号（键是会话 id，按先后，只留最近 TURN_STARTS_KEPT 个）：agent 语音"收着"
   * 这一轮的文字到下一轮开始为止（86 号票，agent-voice.ts）。历史分页里没有回合事件，只有实时收到、补发的
   */
  readonly turnStarts: Readonly<Record<string, readonly number[]>>;
  /**
   * 会话频道上收到的回合结束（键是会话 id，按先后，只留最近 TURN_STARTS_KEPT 个）：序号、这一轮交给 agent 的几条输入、结局。
   * 悬浮按钮（149 号票，state/page-button.ts）据此认出它发的那句处理完了没有、秘书这一轮回了什么
   */
  readonly turnEnds: Readonly<Record<string, readonly TurnEndMark[]>>;
  /** 日历（35 号票）：取回的每个月，和最近一条会让日历变的事件的序号 */
  readonly calendar: CalendarState;
  /**
   * 新到的 agent 语音（36 号票，语音 id，按到的先后）：合成完成的那一版是实时推来的（不是打开页面、重连时补发的，
   * 也不是往上翻取回的）。界面决定自动播不播之后用 agent_voice_arrival_seen 去掉；判断见 voice-autoplay.ts
   */
  readonly agentVoiceArrivals: readonly string[];
  /** 用户给个人助理起的名字（43 号票）：名字频道上最新的 assistant_name 事件；还没收到是 undefined（按默认的名字显示） */
  readonly assistantName: string | undefined;
  /**
   * 用户自己的名字（249 号票，"我的名字"）：经 HTTP 取回（GET /api/user-name）或者设置里改完（PUT 回的）那个；
   * 没取过、没设都是 undefined——界面上那几个地方一个字都不多（照旧）
   */
  readonly userName: string | undefined;
  /** 设置里选的语言（168 号票）：语言频道上最新的 language 事件；还没收到是 undefined（没选过，中文） */
  readonly language: string | undefined;
  /**
   * 实际在用的语言和词典的版本（168 号票）：语言频道上的临时事件 locale（订阅时补推一条）。版本变了网页重取词典（app/locale.ts）；
   * 还没收到是 undefined
   */
  readonly locale: LocaleEventPayload | undefined;
  /**
   * 守护进程清单里每个插件现在的状况（193 号票）：插件频道上的临时事件 plugin_status（订阅时补推一条，变了再推），整份换掉。
   * 网页按它装、停自己的网页插件（plugins/host.ts 的 apply）；还没收到（原型、旧的守护进程）是 undefined——当作全开
   */
  readonly pluginStatus: PluginStatusEventPayload | undefined;
  /**
   * 两个语音模型的状态（45 号票：模型预热）：打开设置 · 语音时经本机接口取回的，和活动状态频道上推来的临时事件 voice_models，
   * 留新的（voice-models.ts）；还没取过、没收到过是 undefined
   */
  readonly voiceModels: VoiceModelsView | undefined;
  /**
   * 角色（248 号票，经 HTTP 取回的 GET /api/agent-roles）：默认角色、角色表（连同谁在用）、每个 agent 用哪个角色和它现在的名字音色。
   * 界面上凡是要名字和音色的地方现取它，改了不用刷新（存的、改的都在返回里）；还没取过（原型、旧守护进程）是 undefined——按默认显示
   */
  readonly agentRoles: AgentRolesView | undefined;
  /**
   * 项目的服务（133 号票：运营手段"服务"上线到哪了、LSM 推来的在不在线、有网页的入口）：项目列表频道上的临时事件 project_services
   * 整份换掉（订阅时守护进程补推一次全量）；还没收到是空的
   */
  readonly projectServices: readonly ProjectServiceView[];
  /**
   * 已读位置（109 号票，键是会话 id，现在只有秘书会话）：已读位置频道上的 read_mark（守护进程记的，几台设备同步），
   * 和这台设备刚看到、已经报给守护进程的（read_seen），取靠后的；还没收到过是没有
   */
  readonly readMarks: Readonly<Record<string, number>>;
  /**
   * 补发推完了（109 号票）：连接报 synced（打开、重连上之后补发的帧都到了）时是；连接状态一变（断开、重新连上）就回到不是。
   * 补发完之前不报已读位置（还没补齐的会话看着像停在最底部）；补发完的那一刻界面看一眼有没有没看过的秘书消息
   */
  readonly caughtUp: boolean;
  /**
   * 实时收到的秘书回合结束（109 号票，这一轮开始的序号，按先后）：秘书说完一轮，界面决定要不要在顶上提醒（secretary-unread.ts），
   * 决定过了用 secretary_turn_seen 去掉。打开页面、重连时补发的回合结束不算（不在时来的另有"秘书有 N 条新消息"）
   */
  readonly secretaryTurns: readonly number[];
  /** 服务端现在提供的网页是哪一版、"等会儿"时是哪一版、是不是在后台时来的（116 号票，page-update.ts） */
  readonly webVersion: WebVersionState;
}

/** 一个被拒的请求：幂等键和原因 */
export interface RequestFailure {
  readonly idempotencyKey: string;
  readonly error: string;
}

/**
 * 和服务端的连接：连接中、在线、断开（正在重连）、页面版本过旧（要刷新）、
 * 这台设备的凭证失效了（外网端口上被吊销或太久没用：不再重连，回到配对等待页）
 */
export type ConnectionStatus = "connecting" | "online" | "offline" | "outdated" | "unpaired";

/** 正在生成的一条回复 */
interface StreamingMessage {
  readonly messageId: string;
  readonly parts: readonly { readonly type: StreamDelta["type"]; readonly text: string }[];
  /** 漏掉了中间的增量（断线重连、或者说到一半才打开页面）：不再拼文字，等定稿消息 */
  readonly broken: boolean;
}

/** 一个已发出、还没得到结果的请求：在路上，或者失败了（带错误说明） */
export type RequestStatus = { readonly status: "sending" } | { readonly status: "failed"; readonly error: string };

/** 会话里的一条权威消息（连同归属：任务、项目、阶段）；被彻底删除的只剩"已删除"标记（消息 id 和时间） */
type ConversationEntry =
  | {
      readonly seq: number;
      readonly message: MessageEnvelope;
      readonly idempotencyKey?: string;
      readonly scope: MessageScope;
      /** 排队交出的那一批（144 号票，消息事件里的 queueDelivery）：150 号票起同一批里第一条之后的不是回退点 */
      readonly delivery?: string;
    }
  | { readonly seq: number; readonly deleted: DeletedEventPayload };

/**
 * 时间线上消息之外的一条记录：偏离、范围变更、越界这类（timeline_record，种类见协议包 timeline.ts，可能有前端还不认识的种类，
 * 连同归属），或者快速动作的执行（操作记录，quick_action_executed）
 */
export type ConversationRecord =
  | { readonly type: "timeline"; readonly timeline: TimelineRecord; readonly scope: MessageScope }
  | { readonly type: "operation"; readonly operation: QuickActionExecutedEventPayload };

interface ConversationState {
  /** 权威消息，按序号从早到晚（往上翻取回的更早消息插在前面）；用户自己发的带着发送请求的幂等键 */
  readonly messages: readonly ConversationEntry[];
  /** 排队的消息（144 号票：二狗回复时发的话）：会话频道上最新的 message_queue 里的整队，先交的在前 */
  readonly queue: readonly QueuedMessage[];
  /** 自己先做了、还没等到守护进程那条 message_queue 的一步（叉掉、拖完的顺序），按发出的先后 */
  readonly queueEdits: readonly QueueEdit[];
  /**
   * 正在回复的这一轮（这一轮交给 agent 的第一条输入，144 号票）：会话频道上 turn_start 之后还没有它的 turn_end。
   * 这时输入框上有"停止"、发的话排队；没在回复是 undefined
   */
  readonly openTurn: string | undefined;
  /** 时间线上的记录，按序号从早到晚（往上翻取回的更早的插在前面） */
  readonly records: readonly { readonly seq: number; readonly record: ConversationRecord }[];
  /** 乐观显示的尾巴：已发出、还没收到权威事件的消息，按发出顺序 */
  readonly tail: readonly PendingMessage[];
  /** 往上翻已经翻到头了（服务端说更早没有了） */
  readonly olderExhausted: boolean;
  /**
   * 会话树（150 号票：会话回退之后会话频道上最新的 session_branch 带的整棵树）：会话视图、未读、缩小视图只看当前分支上的，
   * 废弃分支上的消息留在手里（151 号票的预览用）。没回退过是 undefined
   */
  readonly branches?: ConversationBranches;
  /**
   * 长程任务阶段开始的记号（152 号票：维护者会话频道上的 stage_start，往上翻取回的更早的插在前面），按序号从早到晚：缩小视图据它在那一处
   * 画"撤回到阶段「…」开始前"的回退点
   */
  readonly stageStarts?: readonly { readonly seq: number; readonly mark: StageStartEventPayload }[];
  /** 项目维护者的会话最新的那一段还开着没有（152 号票：segment 事件；回退点只在当前这一段里）。没收到过 segment 事件是 undefined */
  readonly segmentOpen?: boolean;
  /**
   * 经 HTTP 取回的废弃分支的样子（151 号票：⑂ 预览、分支详情要的分支摘要、遗留效果），按分支 id；against 是取的时候和哪条比的
   * （当前分支）。会话树一变就清掉（各条分支自己那一段可能变了），用到时重新取；消息、记录照常并进 messages、records
   */
  readonly branchViews?: Readonly<Record<string, BranchViewState>>;
  /** 申请撤回过的遗留效果（151 号票，会话频道上的 effect_undo_requested）：工具调用 id → 什么时候提交的 */
  readonly undoRequests?: Readonly<Record<string, string>>;
  /**
   * 切换分支之后手里缺的那一段（151 号票）：别的设备切的（或者断线时切的），新的当前分支上不在原来那条路径上的消息手里可能没有，
   * 要经 HTTP 取一条分支的样子（branch 和 against 比的那一段）补进来；取回来就没有了。刚打开页面、手里还没有消息时不用补
   * （补发、往上翻本来就沿当前分支），切过去之前已经取回过那一段的（自己点的切换）也不用
   */
  readonly branchGap?: { readonly branch: string; readonly against: string };
}

/** 取回的一条分支的样子里状态层留下的（151 号票）：和哪条比的、分支摘要、遗留效果 */
export interface BranchViewState {
  readonly against: string;
  readonly summary: string | undefined;
  readonly effects: readonly BranchEffect[];
}

type PendingMessage = { readonly idempotencyKey: string; readonly message: MessageEnvelope } & RequestStatus;

/** 自己先做了的一步（144 号票）：叉掉一条排队的消息、拖完换个顺序；守护进程那条 message_queue 带着同一个幂等键回来就收掉 */
export type QueueEdit = { readonly key: string; readonly kind: "remove"; readonly messageId: string } | { readonly key: string; readonly kind: "reorder"; readonly messageIds: readonly string[] };

/** 一张卡片的状态：权威版本，加上本地点了按钮、还没得到结果的动作。 */
export interface CardState {
  readonly card: Card;
  readonly pending?: { readonly action: CardAction; readonly idempotencyKey: string } & RequestStatus;
}

/**
 * 会话视图里的一条：权威消息，或者本地乐观显示、还没得到确认的消息。
 * 乐观显示的那条被权威消息替换后，权威消息带着同一个幂等键，界面可以拿它当 key，原地换掉不闪。
 */
export type ConversationItem =
  | { kind: "message"; message: MessageEnvelope; idempotencyKey?: string }
  /** 被彻底删除的消息：原来的位置只显示"已删除"；key 是消息 id（没有时用序号） */
  | { kind: "deleted"; key: string; time: string | undefined; idempotencyKey?: undefined }
  /** 正在生成的回复：message.id 就是定稿后那条消息的 id，界面拿它当 key，定稿时原地换掉；broken 时只显示"正在回复" */
  | { kind: "streaming"; message: MessageEnvelope; broken: boolean; idempotencyKey?: undefined }
  | ({ kind: "pending"; idempotencyKey: string; message: MessageEnvelope } & RequestStatus)
  /** 排队的消息（144 号票）：key 是发送请求的幂等键，交出去之后换成的那条权威消息带着同一个，界面原地换掉 */
  | { kind: "queued"; idempotencyKey: string; message: MessageEnvelope };

/** 状态层的输入。 */
export type UiInput =
  /** 服务端推来的事件帧 */
  | {
      kind: "frame";
      frame: EventFrame;
      /** 这一帧是订阅之后补发的（打开页面、断线重连、多订阅一个频道时），不是实时推来的（36 号票：补发的语音不自动播） */
      catchUp?: boolean;
    }
  /** 用户发出一条消息（请求已发出，等权威事件） */
  /** browsing：浏览侧边栏里发的（147 号票），乐观显示的那条也带上"在网页「X」上说" */
  | { kind: "send_message"; conversation: ConversationId; idempotencyKey: string; parts: MessagePart[]; time: string; browsing?: BrowsingMark }
  /** 用户点了卡片上的按钮（"对卡片做动作"的请求已发出，等卡片更新事件） */
  | { kind: "card_action"; cardId: string; action: CardAction; idempotencyKey: string }
  /** 用户叉掉了一条排队的消息、拖完换了顺序（144 号票，请求已发出）：先照着显示，等守护进程的 message_queue */
  | { kind: "queue_edit"; conversation: ConversationId; edit: QueueEdit }
  /** 某个带幂等键的请求失败了（响应帧里的错误，或者连接断了没发出去） */
  | { kind: "request_failed"; idempotencyKey: string; error: string }
  /** 连接状态变了 */
  | { kind: "connection"; status: ConnectionStatus; reason?: CredentialRejection }
  /** 重新同步一个频道：清掉它的序号和归并出来的状态（还没确认的乐观显示留着），接下来服务端从头补发 */
  | { kind: "resync"; channel: string }
  /** 补发推完了（109 号票）：打开、重连上之后，这次订阅的频道补发的帧都到了 */
  | { kind: "synced" }
  /** 这台设备上看到了会话的哪一条（109 号票）：已经报给守护进程，先记上（守护进程的 read_mark 随后推来） */
  | { kind: "read_seen"; conversation: ConversationId; seq: number }
  /** 界面自己出的一条顶上的通知（109 号票：秘书新消息）；同一个 id 的不重复出 */
  | { kind: "alert"; alert: PageAlert }
  /** 界面对秘书的这一轮（这一轮开始的序号）决定过了要不要提醒（109 号票） */
  | { kind: "secretary_turn_seen"; since: number }
  /** 界面已经提示过这条通知 */
  | { kind: "alert_seen"; id: string }
  /** 界面对这条新到的 agent 语音决定过了（自动播了，或者不播） */
  | { kind: "agent_voice_arrival_seen"; voiceId: string }
  /** 界面已经提示过这个被拒的请求 */
  | { kind: "failure_seen"; idempotencyKey: string }
  /** 经 HTTP 取回的一页更早的历史（往上翻时） */
  | { kind: "history_page"; conversation: ConversationId; page: HistoryPage }
  /** 经 HTTP 取回的一条分支的样子（151 号票）：它自己那一段的消息、记录并进来，分支摘要、遗留效果记下 */
  | { kind: "branch_view"; conversation: ConversationId; view: BranchView }
  /** 经 HTTP 取回的一个月的日历（35 号票） */
  | { kind: "calendar_month"; view: CalendarMonthView }
  /** 经 HTTP 取回的两个语音模型的状态（45 号票） */
  | { kind: "voice_models"; view: VoiceModelsView }
  /** 经 HTTP 取回、改过的角色表（248 号票，整份换掉：接口回的就是全量） */
  | { kind: "agent_roles"; view: AgentRolesView }
  /** 经 HTTP 取回、改过的"我的名字"（249 号票）：没设是 undefined（界面上那几个地方一个字都不多） */
  | { kind: "user_name"; name: string | undefined }
  /** 聊天里的一张卡片"引用"到输入框（同一张只引用一次） */
  | { kind: "quote_card"; conversation: ConversationId; cardId: string }
  /** 去掉输入框里引用的一张卡片 */
  | { kind: "unquote_card"; conversation: ConversationId; cardId: string }
  /** 服务端现在提供的网页是哪一版（116 号票：订阅的响应里带的、切回前台时经 HTTP 问到的）；undefined 是不知道 */
  | { kind: "web_version"; version: string | undefined }
  /** 有新版本的提示上点了"等会儿"（116 号票） */
  | { kind: "update_later" }
  /** 页面切到后台（116 号票）：这时来的新版本，回到前台时页面上没有会丢的东西就直接刷新 */
  | { kind: "page_hidden" }
  /** 页面切回前台（116 号票）：之前的"等会儿"不算了；问完服务端之前来的新版本还算在后台时来的 */
  | { kind: "page_foreground" }
  /** 切回前台后问完了服务端是哪一版（116 号票；问不到也算） */
  | { kind: "page_settled" };

export const initialUiState: UiState = {
  cursors: {},
  conversations: {},
  cards: {},
  streams: {},
  inbox: {},
  reminders: {},
  tasks: {},
  taskReopens: {},
  activity: {},
  activityProgress: {},
  devices: {},
  watchCategories: undefined,
  projects: {},
  tokenTotals: {},
  workOrders: {},
  scheduledJobs: {},
  jobRuns: {},
  taskPlans: {},
  scopeRecords: {},
  alerts: [],
  failures: [],
  connection: "connecting",
  quotes: {},
  unpairedReason: undefined,
  workday: { holidays: undefined, settings: undefined },
  voices: {},
  agentVoices: {},
  turnStarts: {},
  turnEnds: {},
  calendar: initialCalendarState,
  agentVoiceArrivals: [],
  assistantName: undefined,
  userName: undefined,
  language: undefined,
  locale: undefined,
  pluginStatus: undefined,
  voiceModels: undefined,
  agentRoles: undefined,
  projectServices: [],
  readMarks: {},
  caughtUp: false,
  secretaryTurns: [],
  webVersion: initialWebVersionState,
};

/** 每个会话记最近几个回合开始的序号（86 号票）：收着文字的 agent 语音只在最近的一两轮里；回合结束（149 号票）也记这么多 */
const TURN_STARTS_KEPT = 20;

/** 一个回合的结束（149 号票）：序号、这一轮交给 agent 的输入（第一条在前，144 号票起一批几条）、结局和出错的原因 */
export interface TurnEndMark {
  readonly seq: number;
  readonly inputIds: readonly string[];
  readonly outcome: TurnEndEventPayload["outcome"];
  readonly error?: string;
}

const emptyConversation: ConversationState = { messages: [], queue: [], queueEdits: [], openTurn: undefined, records: [], tail: [], olderExhausted: false };

/** 这个序号的事件在不在会话的当前分支上（150 号票；没回退过的都在） */
function onPath(conv: ConversationState): (seq: number) => boolean {
  const tree = conv.branches;
  return tree === undefined || tree.branches.length <= 1 ? () => true : (seq) => onBranchPath(tree, seq);
}

/** 这个序号的事件在不在一条分支自己那一段里（151 号票：它的路径上、不在当前路径上的；没回退过的会话没有） */
function ownPart(conv: ConversationState, branch: string): (seq: number) => boolean {
  const tree = conv.branches;
  if (tree === undefined || tree.branches.length <= 1) return () => false;
  const ranges = branchOwnRanges(tree, branch);
  return (seq) => inRanges(ranges, seq);
}

/** 会话频道上一条时间线记录的事件（WebSocket 上的、历史分页里的）→ 状态层里的记录；不是记录的是 undefined */
function recordOf(type: string, payload: unknown): ConversationRecord | undefined {
  if (type === EVENT_TYPES.timelineRecord) {
    const p = payload as TimelineRecordEventPayload;
    return { type: "timeline", timeline: p.record, scope: pickMessageScope(p) };
  }
  if (type === EVENT_TYPES.quickActionExecuted) return { type: "operation", operation: payload as QuickActionExecutedEventPayload };
  return undefined;
}

function withRecord(state: UiState, frame: EventFrame): UiState {
  const record = recordOf(frame.type, frame.payload);
  if (!record) return state;
  return updateConversation(state, frame.channel, (conv) => ({ ...conv, records: [...conv.records, { seq: frame.seq, record }] }));
}

/** 快速动作卡来了新版本：它的操作记录跟着换标题、参数、结果（彻底删除时卡片换成去掉原话的，操作记录也不留原话） */
function withOperationsOf(state: UiState, card: Card): UiState {
  if (card.type !== "quick_action") return state;
  const p = card.payload as QuickActionCardPayload;
  const conv = state.conversations[p.conversation];
  if (!conv?.records.some(({ record }) => record.type === "operation" && record.operation.cardId === card.id)) return state;
  return updateConversation(state, p.conversation, (c) => ({
    ...c,
    records: c.records.map((r) => {
      if (r.record.type !== "operation" || r.record.operation.cardId !== card.id) return r;
      const op = r.record.operation;
      return { seq: r.seq, record: { type: "operation", operation: { ...op, title: p.title, action: p.action, result: { ...op.result, summary: p.result ?? op.result.summary } } } };
    }),
  }));
}

/** 各事件类型的归并函数。后面的票往这张表里加；不认识的类型只推进序号。 */
const eventHandlers: Record<string, (state: UiState, frame: EventFrame) => UiState> = {
  [EVENT_TYPES.message]: (state, frame) => {
    if (isDeletedEventPayload(frame.payload)) {
      const deleted = frame.payload;
      return updateConversation(state, frame.channel, (conv) => ({ ...conv, messages: [...conv.messages, { seq: frame.seq, deleted }] }));
    }
    const payload = frame.payload as MessageEventPayload;
    const { message, idempotencyKey } = payload;
    const next = updateConversation(state, frame.channel, (conv) => ({
      ...conv,
      messages: [...conv.messages, { seq: frame.seq, message, idempotencyKey, scope: pickMessageScope(payload), ...(payload.queueDelivery === undefined ? {} : { delivery: payload.queueDelivery }) }],
      tail: idempotencyKey === undefined ? conv.tail : conv.tail.filter((p) => p.idempotencyKey !== idempotencyKey),
    }));
    // 正在生成的那条定稿了：换成这条权威消息
    return next.streams[frame.channel]?.messageId === message.id ? withoutStream(next, frame.channel) : next;
  },
  // 这些消息被彻底删除了：手里的原话换成"已删除"（语音消息的语音对象也拿掉，文字不留在前端）
  [EVENT_TYPES.messagesPurged]: (state, frame) => {
    const { messages, deletedAt } = frame.payload as MessagesPurgedEventPayload;
    const purged = new Map(messages.map((m) => [m.messageId, m.replacement]));
    const voices = filterVoices(state.voices, (v) => !purged.has(v.messageId) || purged.get(v.messageId) !== undefined);
    return updateConversation({ ...state, voices }, frame.channel, (conv) => ({
      ...conv,
      messages: conv.messages.map((m): ConversationEntry => {
        if (!("message" in m) || !purged.has(m.message.id)) return m;
        const replacement = purged.get(m.message.id);
        // 字段级改写过的（工具调用记录）：换成改写后的样子；整条删掉的：只留"已删除"
        if (replacement) return { ...m, message: replacement };
        return { seq: m.seq, deleted: { deleted: true, deletedAt, messageId: m.message.id, messageTime: m.message.time } };
      }),
    }));
  },
  // 会话回退、切换分支（150、151 号票）：换成最新的会话树
  [EVENT_TYPES.sessionBranch]: (state, frame) => {
    if (isDeletedEventPayload(frame.payload)) return state;
    const { branches, change, from, to } = frame.payload as SessionBranchEventPayload;
    // 取回过的分支的样子作废（151 号票：切换之后各条自己那一段变了），用到时重新取
    return updateConversation(state, frame.channel, ({ branchViews, ...conv }) => {
      // 切换分支：切过去的那条上不在原来那条路径上的，手里可能没有（取回过它和原来那条比的样子的除外）
      const gap = change === "switch" && conv.messages.length > 0 && branchViews?.[to]?.against !== from ? { branch: to, against: from } : conv.branchGap;
      return { ...conv, branches, ...(gap ? { branchGap: gap } : {}) };
    });
  },
  // 申请撤回（151 号票）：记下这一件提交过了（同一件只认第一次）
  [EVENT_TYPES.effectUndoRequested]: (state, frame) => {
    if (isDeletedEventPayload(frame.payload)) return state;
    const { callId, time } = frame.payload as EffectUndoRequestedEventPayload;
    return updateConversation(state, frame.channel, (conv) => (conv.undoRequests?.[callId] !== undefined ? conv : { ...conv, undoRequests: { ...conv.undoRequests, [callId]: time } }));
  },
  // 长程任务阶段开始的记号（152 号票）：缩小视图据它画阶段开始的回退点
  [EVENT_TYPES.stageStart]: (state, frame) => {
    const mark = frame.payload as StageStartEventPayload;
    return updateConversation(state, frame.channel, (conv) => ({ ...conv, stageStarts: [...(conv.stageStarts ?? []), { seq: frame.seq, mark }] }));
  },
  // 项目维护者的会话分段（16 号票）：最新那一段还开着没有（152 号票：结束了就没有回退点）
  [EVENT_TYPES.segment]: (state, frame) => {
    const { segment } = frame.payload as SegmentEventPayload;
    return updateConversation(state, frame.channel, (conv) => ({ ...conv, segmentOpen: segment.state !== "closed" }));
  },
  // 时间线上的记录（25 号票）：偏离、范围变更、越界……；快速动作的操作记录（21 号票）
  [EVENT_TYPES.timelineRecord]: withRecord,
  [EVENT_TYPES.quickActionExecuted]: withRecord,
  // 回合开始：记下序号（agent 语音收着一轮的文字到下一轮开始为止，86 号票）；这一轮在回复（144 号票，插进来的催促不另算一轮）
  [EVENT_TYPES.turnStart]: (state, frame) => {
    const { inputMessageId } = frame.payload as TurnStartEventPayload;
    const opened = updateConversation(state, frame.channel, (conv) => (conv.openTurn === undefined ? { ...conv, openTurn: inputMessageId } : conv));
    const starts = opened.turnStarts[frame.channel] ?? [];
    if (starts.length > 0 && starts.at(-1)! >= frame.seq) return opened;
    return { ...opened, turnStarts: { ...opened.turnStarts, [frame.channel]: [...starts, frame.seq].slice(-TURN_STARTS_KEPT) } };
  },
  // 回合结束：不管有没有定稿消息（出错、中止），正在生成的都收起；这一轮的结束（144 号票）不再在回复
  [EVENT_TYPES.turnEnd]: (state, frame) => {
    const { inputMessageId, moreInputMessageIds, outcome, error } = frame.payload as TurnEndEventPayload;
    const stopped = withoutStream(state, frame.channel);
    // 记下这一轮的结束（149 号票：悬浮按钮发的那句处理完了没有）
    const ends = stopped.turnEnds[frame.channel] ?? [];
    const mark: TurnEndMark = { seq: frame.seq, inputIds: [inputMessageId, ...(moreInputMessageIds ?? [])], outcome, ...(error ? { error } : {}) };
    const ended = ends.some((e) => e.seq === frame.seq) ? stopped : { ...stopped, turnEnds: { ...stopped.turnEnds, [frame.channel]: [...ends, mark].slice(-TURN_STARTS_KEPT) } };
    return ended.conversations[frame.channel]?.openTurn === inputMessageId ? updateConversation(ended, frame.channel, (conv) => ({ ...conv, openTurn: undefined })) : ended;
  },
  // 排队的消息（144 号票）：整队换成最新的；自己先做的那一步回来了就收掉；乐观显示的那条排进了队就从尾巴上拿掉（换成排队的气泡）
  [EVENT_TYPES.messageQueue]: (state, frame) => {
    if (isDeletedEventPayload(frame.payload)) return state;
    const { queue, requestKey } = frame.payload as MessageQueueEventPayload;
    const keys = new Set(queue.map((q) => q.idempotencyKey));
    return updateConversation(state, frame.channel, (conv) => ({
      ...conv,
      queue,
      queueEdits: requestKey === undefined ? conv.queueEdits : conv.queueEdits.filter((e) => e.key !== requestKey),
      tail: conv.tail.some((p) => keys.has(p.idempotencyKey)) ? conv.tail.filter((p) => !keys.has(p.idempotencyKey)) : conv.tail,
    }));
  },
  [EVENT_TYPES.card]: (state, frame) => {
    // 彻底删除改写过的旧版本卡片：忽略（之后有去掉原话的新版本）
    if (isDeletedEventPayload(frame.payload)) return state;
    const { card } = frame.payload as CardEventPayload;
    const old = state.cards[card.id];
    if (old && old.card.version >= card.version) return state;
    // 卡片有了新的权威版本：不管是自己点的生效了还是别处先处理了，处理中的标记都结束
    return withOperationsOf({ ...state, cards: { ...state.cards, [card.id]: { card } } }, card);
  },
  [EVENT_TYPES.inboxItem]: (state, frame) => {
    const { item } = frame.payload as InboxItemEventPayload;
    const inbox = { ...state.inbox };
    if (item.deleted) delete inbox[item.id];
    else inbox[item.id] = item;
    return { ...state, inbox };
  },
  [EVENT_TYPES.reminder]: (state, frame) => {
    // 移除提醒插件时连数据删了（211 号票）：改写成了"已删除"标记，不要
    if (isDeletedEventPayload(frame.payload)) return state;
    const { reminder } = frame.payload as ReminderEventPayload;
    return { ...state, reminders: { ...state.reminders, [reminder.id]: reminder } };
  },
  // 移除插件时连它的数据一起彻底删除了（211 号票）：手里那时之前的这几类卡片拿掉；删了提醒的，那时之前的提醒也拿掉
  // （按时间比，不按到达的先后：重新打开页面时插件频道和卡片频道的补发谁先到都一样）
  [EVENT_TYPES.pluginDataPurged]: (state, frame) => {
    const { at, cardTypes, eventTypes } = frame.payload as PluginDataPurgedEventPayload;
    const until = Date.parse(at);
    const gone = (createdAt: string) => Date.parse(createdAt) <= until;
    const types = new Set(cardTypes);
    const cards = Object.fromEntries(Object.entries(state.cards).filter(([, c]) => !(types.has(c.card.type) && gone(c.card.createdAt))));
    const reminders = eventTypes.includes(EVENT_TYPES.reminder) ? Object.fromEntries(Object.entries(state.reminders).filter(([, r]) => !gone(r.createdAt))) : state.reminders;
    return { ...state, cards, reminders };
  },
  [EVENT_TYPES.task]: (state, frame) => {
    const { task, change, reopened } = frame.payload as TaskEventPayload;
    // 用户删掉了的任务（186 号票）：任务和它的维护者会话都删了（会话频道上只剩"已删除"标记），界面上一起拿掉
    if (task.deleted) return withoutTask(state, task);
    const tasks = { ...state.tasks, [task.id]: task };
    if (change !== "rework") return { ...state, tasks };
    // 返工（55 号票）：记下什么时候、重开了哪几个阶段，书脊据此把重开之前的那几轮标成"已重开"
    const reopen: TaskReopen = { time: task.updatedAt, stageIds: reopened ?? (task.stages?.list ?? []).filter((s) => s.state !== "accepted").map((s) => s.stageId) };
    return { ...state, tasks, taskReopens: { ...state.taskReopens, [task.id]: [...(state.taskReopens[task.id] ?? []), reopen] } };
  },
  // 定时作业（19 号票）：作业的最新样子，连同这次说到的那一次运行
  [EVENT_TYPES.scheduledJob]: (state, frame) => {
    const { job, run } = frame.payload as ScheduledJobEventPayload;
    return { ...state, scheduledJobs: { ...state.scheduledJobs, [job.id]: job }, ...(run ? { jobRuns: { ...state.jobRuns, [run.runId]: run } } : {}) };
  },
  [EVENT_TYPES.tokenTotals]: (state, frame) => {
    const payload = frame.payload as TokenTotalsEventPayload;
    return { ...state, tokenTotals: { ...state.tokenTotals, [ledgerOwnerKey(payload.owner)]: payload } };
  },
  [EVENT_TYPES.taskPlan]: (state, frame) => {
    // 删掉的任务的计划（186 号票）改写成了"已删除"标记：不要
    if (isDeletedEventPayload(frame.payload)) return state;
    const payload = frame.payload as TaskPlanEventPayload;
    return { ...state, taskPlans: { ...state.taskPlans, [payload.taskId]: payload } };
  },
  [EVENT_TYPES.activity]: (state, frame) => {
    const payload = frame.payload as ActivityEventPayload;
    // 状态变了：之前推来的进度作废
    return { ...state, activity: { ...state.activity, [payload.agentId]: payload }, activityProgress: withoutKey(state.activityProgress, payload.agentId) };
  },
  [EVENT_TYPES.device]: (state, frame) => {
    const { device } = frame.payload as DeviceEventPayload;
    // 删了的（123 号票）从列表里去掉：设置里再也看不到它
    if (device.deletedAt !== undefined) return { ...state, devices: withoutKey(state.devices, device.id) };
    return { ...state, devices: { ...state.devices, [device.id]: device } };
  },
  [EVENT_TYPES.holidayData]: (state, frame) => ({ ...state, workday: { ...state.workday, holidays: (frame.payload as HolidayDataEventPayload).years } }),
  [EVENT_TYPES.workdaySettings]: (state, frame) => ({ ...state, workday: { ...state.workday, settings: (frame.payload as WorkdaySettingsEventPayload).settings } }),
  // 关注类别设置：每条事件带着设置的最新样子，留最后一条（26 号票）
  [EVENT_TYPES.watchCategorySettings]: (state, frame) => ({ ...state, watchCategories: frame.payload as WatchCategorySettingsEventPayload }),
  // 个人助理的名字：留最后一条（43 号票）
  [EVENT_TYPES.assistantName]: (state, frame) => ({ ...state, assistantName: (frame.payload as AssistantNameEventPayload).name }),
  [EVENT_TYPES.language]: (state, frame) => ({ ...state, language: (frame.payload as LanguageEventPayload).language }),
  // 已读位置（109 号票）：只往后挪；秘书的提醒里说到的都看过了的（别的设备上看过了）从顶上拿掉
  [EVENT_TYPES.readMark]: (state, frame) => {
    const { conversation, seq } = frame.payload as ReadMarkEventPayload;
    return withReadMark(state, conversation, seq);
  },
  // 一条语音的最新状态：旧版本（比如往上翻取回的一页里带的）不覆盖新的
  [EVENT_TYPES.voice]: (state, frame) => mergeVoices(state, "voices", [(frame.payload as VoiceEventPayload).voice]),
  // agent 发的一条语音的最新状态（32 号票）：同样按版本
  [EVENT_TYPES.agentVoice]: (state, frame) => mergeVoices(state, "agentVoices", [(frame.payload as AgentVoiceEventPayload).voice]),
  [EVENT_TYPES.project]: (state, frame) => {
    const { project, change } = frame.payload as ProjectEventPayload;
    if (change !== "deleted") return { ...state, projects: { ...state.projects, [project.id]: project } };
    // 删掉的项目：项目档案和维护者会话都删了（会话频道上只剩"已删除"标记），界面上一起拿掉
    const conversation = maintainerChannel(project.maintainerId);
    return withoutStream(
      {
        ...state,
        projects: withoutKey(state.projects, project.id),
        // 项目内部任务（64 号票）随项目一起删掉
        tasks: Object.fromEntries(Object.entries(state.tasks).filter(([, t]) => !isInternalTo(t, project.id))),
        workOrders: Object.fromEntries(Object.entries(state.workOrders).filter(([, w]) => w.projectId !== project.id)),
        scopeRecords: Object.fromEntries(Object.entries(state.scopeRecords).filter(([, r]) => r.projectId !== project.id)),
        conversations: withoutKey(state.conversations, conversation),
        cursors: withoutKey(state.cursors, conversation),
        quotes: withoutKey(state.quotes, conversation),
        voices: filterVoices(state.voices, (v) => v.conversation !== conversation),
        agentVoices: filterVoices(state.agentVoices, (v) => v.conversation !== conversation),
        turnStarts: withoutKey(state.turnStarts, conversation),
        turnEnds: withoutKey(state.turnEnds, conversation),
      },
      conversation,
    );
  },
  // 工单（16 号票）：每条事件带着工单的最新样子（删掉的项目的工单在它的 deleted 那里一起拿掉）
  [EVENT_TYPES.workOrder]: (state, frame) => {
    const { workOrder } = frame.payload as WorkOrderEventPayload;
    return { ...state, workOrders: { ...state.workOrders, [workOrder.id]: workOrder } };
  },
  // 范围记录（18 号票）：项目列表频道上的是项目维护者的，任务看板频道上的是不属于项目的任务的；删掉的项目的在它的 deleted 那里一起拿掉
  [EVENT_TYPES.scopeRecord]: (state, frame) => {
    if (isDeletedEventPayload(frame.payload)) return state;
    const { record } = frame.payload as ScopeRecordEventPayload;
    return { ...state, scopeRecords: { ...state.scopeRecords, [record.id]: record } };
  },
};

/**
 * 删掉的任务（186 号票）：任务、它的计划和返工记录拿掉；会话是它自己的（任务自己的维护者、迁移来的定时任务的作业维护者）也一起拿掉，
 * 由项目的维护者做的（项目删掉了才能删）不动别的会话
 */
function withoutTask(state: UiState, task: Task): UiState {
  const base = { ...state, tasks: withoutKey(state.tasks, task.id), taskPlans: withoutKey(state.taskPlans, task.id), taskReopens: withoutKey(state.taskReopens, task.id) };
  if (!hasOwnMaintainer(task) && !task.maintainerId.startsWith("jm-")) return base;
  const conversation = maintainerChannel(task.maintainerId);
  return withoutStream(
    {
      ...base,
      conversations: withoutKey(state.conversations, conversation),
      cursors: withoutKey(state.cursors, conversation),
      quotes: withoutKey(state.quotes, conversation),
      voices: filterVoices(state.voices, (v) => v.conversation !== conversation),
      agentVoices: filterVoices(state.agentVoices, (v) => v.conversation !== conversation),
      turnStarts: withoutKey(state.turnStarts, conversation),
      turnEnds: withoutKey(state.turnEnds, conversation),
    },
    conversation,
  );
}

/** 会话的已读位置往后挪到 seq（不往回）；秘书会话的，说到的都看过了的秘书提醒拿掉 */
function withReadMark(state: UiState, conversation: string, seq: number): UiState {
  if (seq <= (state.readMarks[conversation] ?? -1)) return state;
  const readMarks = { ...state.readMarks, [conversation]: seq };
  if (conversation !== CHANNELS.secretary) return { ...state, readMarks };
  const alerts = state.alerts.filter((a) => a.secretary === undefined || a.secretary.through > seq);
  return { ...state, readMarks, alerts: alerts.length === state.alerts.length ? state.alerts : alerts };
}

/** "<名字>有 N 条新消息"的 id 开头（后面接它说到的最后一条的序号；secretary-unread.ts 出它） */
export const SECRETARY_UNREAD_ALERT = "secretary-unread:";

/** 界面自己出的一条通知：同一个 id 的不重复出。"<名字>有 N 条新消息"说到了所有没看过的，之前的秘书提醒都拿掉 */
function withAlert(state: UiState, alert: PageAlert): UiState {
  if (state.alerts.some((a) => a.id === alert.id)) return state;
  const rest = alert.id.startsWith(SECRETARY_UNREAD_ALERT) ? state.alerts.filter((a) => a.secretary === undefined) : state.alerts;
  return { ...state, alerts: [...rest, alert] };
}

/** 并进语音对象：每条留版本最高的 */
function mergeVoices<K extends "voices" | "agentVoices">(state: UiState, key: K, voices: ReadonlyArray<UiState[K][string]>): UiState {
  const known: Readonly<Record<string, { version: number }>> = state[key];
  const fresh = voices.filter((v) => (known[v.id]?.version ?? 0) < v.version);
  if (fresh.length === 0) return state;
  return { ...state, [key]: { ...state[key], ...Object.fromEntries(fresh.map((v) => [v.id, v])) } };
}

function filterVoices<V extends { conversation: string }>(voices: Readonly<Record<string, V>>, keep: (voice: V) => boolean): Readonly<Record<string, V>> {
  const kept = Object.entries(voices).filter(([, v]) => keep(v));
  return kept.length === Object.keys(voices).length ? voices : Object.fromEntries(kept);
}

function updateConversation(state: UiState, id: string, f: (conv: ConversationState) => ConversationState): UiState {
  const conv = f(state.conversations[id] ?? emptyConversation);
  return { ...state, conversations: { ...state.conversations, [id]: conv } };
}

function resyncChannel(state: UiState, channel: string): UiState {
  const cursors = { ...state.cursors };
  delete cursors[channel];
  const conv = state.conversations[channel];
  const conversations = conv ? { ...state.conversations, [channel]: { ...emptyConversation, tail: conv.tail, queueEdits: conv.queueEdits } } : state.conversations;
  const cards = channel === CHANNELS.cards ? {} : state.cards;
  const inbox = channel === CHANNELS.inbox ? {} : state.inbox;
  const reminders = channel === CHANNELS.board ? {} : state.reminders;
  const tasks = channel === CHANNELS.board ? {} : state.tasks;
  const taskReopens = channel === CHANNELS.board ? {} : state.taskReopens;
  const tokenTotals = channel === CHANNELS.board ? {} : state.tokenTotals;
  const scheduledJobs = channel === CHANNELS.board ? {} : state.scheduledJobs;
  const jobRuns = channel === CHANNELS.board ? {} : state.jobRuns;
  const taskPlans = channel === CHANNELS.board ? {} : state.taskPlans;
  const activity = channel === CHANNELS.activity ? {} : state.activity;
  const activityProgress = channel === CHANNELS.activity ? {} : state.activityProgress;
  const devices = channel === CHANNELS.devices ? {} : state.devices;
  const workday = channel === CHANNELS.workdayCalendar ? initialUiState.workday : state.workday;
  const watchCategories = channel === CHANNELS.watchCategories ? undefined : state.watchCategories;
  const assistantName = channel === CHANNELS.assistantName ? undefined : state.assistantName;
  const language = channel === CHANNELS.language ? undefined : state.language;
  const projects = channel === CHANNELS.projects ? {} : state.projects;
  // 会话频道上的语音对象跟着这个会话清掉（服务端从头补发它的 voice 事件）
  const voices = filterVoices(state.voices, (v) => v.conversation !== channel);
  const agentVoices = filterVoices(state.agentVoices, (v) => v.conversation !== channel);
  const agentVoiceArrivals = state.agentVoiceArrivals.filter((id) => id in agentVoices);
  // 已读位置频道从头补发；秘书会话从头补发时，还没决定的回合结束不再提醒（序号对不上了）
  const readMarks = channel === CHANNELS.readMarks ? {} : state.readMarks;
  const secretaryTurns = channel === CHANNELS.secretary ? [] : state.secretaryTurns;
  const turnStarts = withoutKey(state.turnStarts, channel);
  const turnEnds = withoutKey(state.turnEnds, channel);
  const workOrders = channel === CHANNELS.projects ? {} : state.workOrders;
  // 范围记录跟着它所在的频道清掉（落在哪个频道：协议包的 scopeRecordChannel）
  const scopeRecords = Object.fromEntries(Object.entries(state.scopeRecords).filter(([, r]) => scopeRecordChannel(r) !== channel));
  // 取回的日历记着的序号是这两个频道的：从头补发之后对不上了，清掉重新取
  const calendar = channel === CHANNELS.board || channel === CHANNELS.workdayCalendar ? initialCalendarState : state.calendar;
  return withoutStream(
    { ...state, cursors, conversations, cards, inbox, reminders, tasks, taskReopens, tokenTotals, taskPlans, activity, activityProgress, devices, workday, watchCategories, assistantName, language, projects, voices, agentVoices, turnStarts, turnEnds, agentVoiceArrivals, workOrders, scopeRecords, scheduledJobs, jobRuns, calendar, readMarks, secretaryTurns },
    channel,
  );
}

/**
 * 新到的 agent 语音（36 号票）：实时推来（不是补发）的这一帧让一条 agent 语音有了能播的音频，记下它，界面决定自动播不播。
 * 38 号票起分段合成：第一段到了就算（只有一段的是合成完成那一版）；之后的段、合成完成都不再算
 */
function noteAgentVoiceArrival(before: UiState, after: UiState, input: Extract<UiInput, { kind: "frame" }>): UiState {
  if (input.catchUp || input.frame.type !== EVENT_TYPES.agentVoice) return after;
  const { id } = (input.frame.payload as AgentVoiceEventPayload).voice;
  if (!agentVoiceAudible(after.agentVoices[id]) || agentVoiceAudible(before.agentVoices[id]) || after.agentVoiceArrivals.includes(id)) return after;
  return { ...after, agentVoiceArrivals: [...after.agentVoiceArrivals, id] };
}

/**
 * 秘书说完一轮（109 号票）：实时收到（不是补发）的秘书会话回合结束，记下这一轮开始的序号（没收到这一轮开始的从 0 算），
 * 界面决定要不要在顶上提醒
 */
function noteSecretaryTurn(after: UiState, input: Extract<UiInput, { kind: "frame" }>): UiState {
  const { frame } = input;
  if (input.catchUp || frame.type !== EVENT_TYPES.turnEnd || frame.channel !== CHANNELS.secretary) return after;
  const since = (after.turnStarts[CHANNELS.secretary] ?? []).findLast((seq) => seq < frame.seq) ?? 0;
  return after.secretaryTurns.includes(since) ? after : { ...after, secretaryTurns: [...after.secretaryTurns, since] };
}

function withoutStream(state: UiState, channel: string): UiState {
  if (!state.streams[channel]) return state;
  const streams = { ...state.streams };
  delete streams[channel];
  return { ...state, streams };
}

/** 临时事件：不占序号。比已收到的落盘事件还旧的（迟到的增量、迟到的通知）丢掉 */
function reduceEphemeral(state: UiState, frame: EventFrame): UiState {
  if (frame.seq < (state.cursors[frame.channel] ?? 0)) return state;
  if (frame.type === EVENT_TYPES.notify) {
    const alert = frame.payload as NotifyEventPayload;
    return state.alerts.some((a) => a.id === alert.id) ? state : { ...state, alerts: [...state.alerts, alert] };
  }
  // 两个语音模型的状态（45 号票）：留新的
  if (frame.type === EVENT_TYPES.voiceModels) return { ...state, voiceModels: newerVoiceModels(state.voiceModels, frame.payload as VoiceModelsView) };
  // 项目的服务（133 号票）：整份换掉
  if (frame.type === EVENT_TYPES.projectServices) return { ...state, projectServices: (frame.payload as ProjectServicesEventPayload).services };
  // 实际在用的语言和词典的版本（168 号票）：整份换掉
  if (frame.type === EVENT_TYPES.locale) return { ...state, locale: frame.payload as LocaleEventPayload };
  // 插件的状况（193 号票）：整份换掉
  if (frame.type === EVENT_TYPES.pluginStatus) return { ...state, pluginStatus: frame.payload as PluginStatusEventPayload };
  // 外部日程变了（306 号票）：记下新的版本（只增不减），比取回的日历记着的大就算旧了
  if (frame.type === EVENT_TYPES.externalCalendar) {
    const { version } = frame.payload as ExternalCalendarEventPayload;
    const { changedAt } = state.calendar;
    return version > changedAt.external ? { ...state, calendar: { ...state.calendar, changedAt: { ...changedAt, external: version } } } : state;
  }
  // 服务端的网页换了一版（116 号票）
  if (frame.type === EVENT_TYPES.webVersion) return withWebVersion(state, withServerWebVersion(state.webVersion, (frame.payload as WebVersionEventPayload).version));
  // 干活中的进度：只认正在干活的 agent（等你、休眠时来的不算）
  if (frame.type === EVENT_TYPES.activityProgress) {
    const { agentId, detail } = frame.payload as ActivityProgressEventPayload;
    if (state.activity[agentId]?.state !== "working") return state;
    return { ...state, activityProgress: { ...state.activityProgress, [agentId]: detail } };
  }
  if (frame.type !== EVENT_TYPES.stream) return state;
  const { messageId, deltas } = frame.payload as StreamEventPayload;
  const old = state.streams[frame.channel];
  let stream: StreamingMessage = old?.messageId === messageId ? old : { messageId, parts: [], broken: false };
  for (const d of deltas) stream = appendDelta(stream, d);
  return { ...state, streams: { ...state.streams, [frame.channel]: stream } };
}

/** 接上一段增量；位置对不上（漏了中间的）就标成残缺，不再拼 */
function appendDelta(stream: StreamingMessage, d: StreamDelta): StreamingMessage {
  if (stream.broken) return stream;
  const part = stream.parts[d.part];
  if (part && part.text.length === d.offset) {
    return { ...stream, parts: stream.parts.map((p, i) => (i === d.part ? { type: p.type, text: p.text + d.text } : p)) };
  }
  if (!part && d.part === stream.parts.length && d.offset === 0) return { ...stream, parts: [...stream.parts, { type: d.type, text: d.text }] };
  return { ...stream, broken: true };
}

function reduceFrame(state: UiState, frame: EventFrame): UiState {
  if (isEphemeralEventType(frame.type)) return reduceEphemeral(state, frame);
  // 重复或更旧的序号：重连补发、或者同一事件收到两次，直接丢掉
  if (frame.seq <= (state.cursors[frame.channel] ?? 0)) return state;
  const next = withCalendarChange({ ...state, cursors: { ...state.cursors, [frame.channel]: frame.seq } }, frame);
  const handler = eventHandlers[frame.type];
  return handler ? handler(next, frame) : next;
}

/** 会让日历变的事件（任务看板上的提醒、定时作业，工作日历频道上的）：记下序号，比取回的日历记着的大就算旧了 */
function withCalendarChange(state: UiState, frame: EventFrame): UiState {
  const { changedAt } = state.calendar;
  if (frame.channel === CHANNELS.board && (frame.type === EVENT_TYPES.reminder || frame.type === EVENT_TYPES.scheduledJob)) {
    return { ...state, calendar: { ...state.calendar, changedAt: { ...changedAt, board: frame.seq } } };
  }
  if (frame.channel === CHANNELS.workdayCalendar) return { ...state, calendar: { ...state.calendar, changedAt: { ...changedAt, workdayCalendar: frame.seq } } };
  return state;
}

/** 取回的一个月：晚到的旧响应不盖掉手里更新的（两个序号只增不减，手里那份哪个序号更大就是后算的） */
function withCalendarMonth(state: UiState, view: CalendarMonthView): UiState {
  const old = state.calendar.months[view.month];
  if (old && (old.asOf.board > view.asOf.board || old.asOf.workdayCalendar > view.asOf.workdayCalendar || old.asOf.external > view.asOf.external)) return state;
  return { ...state, calendar: { ...state.calendar, months: { ...state.calendar.months, [view.month]: view } } };
}

export function reduce(state: UiState, input: UiInput): UiState {
  switch (input.kind) {
    case "frame": {
      const next = reduceFrame(state, input.frame);
      // 重复、更旧的帧（重连补发）不算新到的
      if (next === state) return state;
      return noteSecretaryTurn(noteAgentVoiceArrival(state, next, input), input);
    }
    case "send_message": {
      const message: MessageEnvelope = {
        id: `pending:${input.idempotencyKey}`,
        conversation: input.conversation,
        speaker: "user",
        time: input.time,
        parts: input.parts,
        ...(input.browsing ? { browsing: input.browsing } : {}),
      };
      const sent = updateConversation(state, input.conversation, (conv) => ({
        ...conv,
        tail: [...conv.tail, { idempotencyKey: input.idempotencyKey, message, status: "sending" }],
      }));
      // 输入框里引用的卡片随这条消息发出去了
      return input.conversation in sent.quotes ? { ...sent, quotes: withoutKey(sent.quotes, input.conversation) } : sent;
    }
    case "quote_card": {
      const quoted = state.quotes[input.conversation] ?? [];
      if (quoted.includes(input.cardId)) return state;
      return { ...state, quotes: { ...state.quotes, [input.conversation]: [...quoted, input.cardId] } };
    }
    case "unquote_card": {
      const rest = (state.quotes[input.conversation] ?? []).filter((id) => id !== input.cardId);
      return { ...state, quotes: rest.length > 0 ? { ...state.quotes, [input.conversation]: rest } : withoutKey(state.quotes, input.conversation) };
    }
    case "queue_edit":
      return updateConversation(state, input.conversation, (conv) => ({ ...conv, queueEdits: [...conv.queueEdits, input.edit] }));
    case "card_action": {
      const view = state.cards[input.cardId];
      if (!view) return state;
      const pending: CardState["pending"] = { action: input.action, idempotencyKey: input.idempotencyKey, status: "sending" };
      return { ...state, cards: { ...state.cards, [input.cardId]: { ...view, pending } } };
    }
    case "request_failed": {
      // 叉掉、改顺序没成（144 号票）：自己先显示的那一步收回去，照常提示原因
      const edited = Object.entries(state.conversations).find(([, conv]) => conv.queueEdits.some((e) => e.key === input.idempotencyKey));
      if (edited) {
        const reverted = updateConversation(state, edited[0], (conv) => ({ ...conv, queueEdits: conv.queueEdits.filter((e) => e.key !== input.idempotencyKey) }));
        return { ...reverted, failures: [...reverted.failures, { idempotencyKey: input.idempotencyKey, error: input.error }] };
      }
      const matched =
        Object.values(state.cards).some((view) => view.pending?.idempotencyKey === input.idempotencyKey) ||
        Object.values(state.conversations).some((conv) => conv.tail.some((p) => p.idempotencyKey === input.idempotencyKey));
      // 不是消息也不是卡片按钮（比如待我处理的动作）：记下原因，界面提示
      if (!matched) return { ...state, failures: [...state.failures, { idempotencyKey: input.idempotencyKey, error: input.error }] };
      let next = state;
      for (const [id, view] of Object.entries(state.cards)) {
        if (view.pending?.idempotencyKey !== input.idempotencyKey) continue;
        const pending: CardState["pending"] = { action: view.pending.action, idempotencyKey: view.pending.idempotencyKey, status: "failed", error: input.error };
        next = { ...next, cards: { ...next.cards, [id]: { ...view, pending } } };
      }
      for (const [id, conv] of Object.entries(state.conversations)) {
        if (!conv.tail.some((p) => p.idempotencyKey === input.idempotencyKey)) continue;
        next = updateConversation(next, id, (c) => ({
          ...c,
          tail: c.tail.map((p): PendingMessage => (p.idempotencyKey === input.idempotencyKey ? { idempotencyKey: p.idempotencyKey, message: p.message, status: "failed", error: input.error } : p)),
        }));
      }
      return next;
    }
    case "connection": {
      const unpairedReason = input.status === "unpaired" ? input.reason : undefined;
      if (state.connection === input.status && state.unpairedReason === unpairedReason) return state;
      // 断开、重新连上：要等这次的补发推完
      return { ...state, connection: input.status, unpairedReason, caughtUp: state.connection === input.status && state.caughtUp };
    }
    case "synced":
      return state.caughtUp ? state : { ...state, caughtUp: true };
    case "read_seen":
      return withReadMark(state, input.conversation, input.seq);
    case "alert":
      return withAlert(state, input.alert);
    case "secretary_turn_seen":
      return state.secretaryTurns.includes(input.since) ? { ...state, secretaryTurns: state.secretaryTurns.filter((s) => s !== input.since) } : state;
    case "resync":
      return resyncChannel(state, input.channel);
    case "alert_seen":
      return { ...state, alerts: state.alerts.filter((a) => a.id !== input.id) };
    case "agent_voice_arrival_seen":
      return state.agentVoiceArrivals.includes(input.voiceId) ? { ...state, agentVoiceArrivals: state.agentVoiceArrivals.filter((id) => id !== input.voiceId) } : state;
    case "failure_seen":
      return { ...state, failures: state.failures.filter((f) => f.idempotencyKey !== input.idempotencyKey) };
    case "history_page":
      return mergeHistoryPage(state, input.conversation, input.page);
    case "branch_view":
      return withBranchView(state, input.conversation, input.view);
    case "calendar_month":
      return withCalendarMonth(state, input.view);
    case "voice_models":
      return { ...state, voiceModels: newerVoiceModels(state.voiceModels, input.view) };
    case "agent_roles":
      // 角色（248 号票）：接口回的是全量，整份换掉（改了哪个角色、哪个 agent 换了角色都在这份里）
      return { ...state, agentRoles: input.view };
    case "user_name":
      // 我的名字（249 号票）：接口回的那个（清除之后是 undefined）
      return { ...state, userName: input.name };
    case "web_version":
      return withWebVersion(state, withServerWebVersion(state.webVersion, input.version));
    case "update_later":
      return withWebVersion(state, webVersionLater(state.webVersion));
    case "page_hidden":
      return withWebVersion(state, webVersionHidden(state.webVersion));
    case "page_foreground":
      return withWebVersion(state, webVersionForeground(state.webVersion));
    case "page_settled":
      return withWebVersion(state, webVersionSettled(state.webVersion));
  }
}

/** 网页的版本变了才换一份状态（没变时原样交回，界面不重画） */
function withWebVersion(state: UiState, webVersion: WebVersionState): UiState {
  return webVersion === state.webVersion ? state : { ...state, webVersion };
}

/**
 * 往上翻取回的一页更早的消息：按序号并进权威消息（手里已有的同一条不重复），落在这一页里的时间线记录同样并进来；
 * 不推进游标（游标只跟 WebSocket 上的落盘事件走）。服务端说更早没有了，就记下翻到头了。
 */
function mergeHistoryPage(state: UiState, conversation: ConversationId, page: HistoryPage): UiState {
  // 这一页的语音消息引用的语音对象（31 号票）：它们的 voice 事件可能早于第一次补发的那一页
  // 这一页里 agent 的语音消息引用的 agent 语音对象（32 号票）：送进 TTS 的原文在这里
  return updateConversation(mergeVoices(mergeVoices(state, "voices", page.voices ?? []), "agentVoices", page.agentVoices ?? []), conversation, (conv) => {
    const known = new Set(conv.messages.map((m) => m.seq));
    const older = page.messages
      .filter((m) => !known.has(m.seq))
      .map((m): ConversationEntry => {
        if ("deleted" in m) return { seq: m.seq, deleted: m.deleted };
        return {
          seq: m.seq,
          message: m.message,
          ...(m.idempotencyKey === undefined ? {} : { idempotencyKey: m.idempotencyKey }),
          scope: pickMessageScope(m),
          ...(m.queueDelivery === undefined ? {} : { delivery: m.queueDelivery }),
        };
      });
    const messages = [...older, ...conv.messages].toSorted((a, b) => a.seq - b.seq);
    const knownRecords = new Set(conv.records.map((r) => r.seq));
    const olderRecords = page.records.filter((r) => !knownRecords.has(r.seq)).flatMap(({ seq, type, payload }: HistoryRecord) => {
      const record = recordOf(type, payload);
      return record ? [{ seq, record }] : [];
    });
    const records = [...olderRecords, ...conv.records].toSorted((a, b) => a.seq - b.seq);
    // 长程任务阶段开始的记号（152 号票）：和记录一样插在前面
    const knownStarts = new Set((conv.stageStarts ?? []).map((m) => m.seq));
    const olderStarts = (page.stageStarts ?? []).filter((m) => !knownStarts.has(m.seq)).map((m) => ({ seq: m.seq, mark: m.payload as StageStartEventPayload }));
    const stageStarts = olderStarts.length > 0 ? [...olderStarts, ...(conv.stageStarts ?? [])].toSorted((a, b) => a.seq - b.seq) : conv.stageStarts;
    return { ...conv, messages, records, ...(stageStarts === undefined ? {} : { stageStarts }), olderExhausted: conv.olderExhausted || !page.hasMore };
  });
}

/**
 * 取回的一条分支的样子（151 号票）：它自己那一段的消息、记录按序号并进来（和往上翻的一页一样，不改"翻到头了没有"）；
 * 和当前分支比的（废弃分支的预览、详情）记下分支摘要、遗留效果
 */
function withBranchView(state: UiState, conversation: ConversationId, view: BranchView): UiState {
  const { branchId, against, summary, effects, ...page } = view;
  // 补的是切换之后缺的那一段：补上了就不缺了
  const merged = updateConversation(mergeHistoryPage(state, conversation, { ...page, hasMore: true }), conversation, ({ branchGap, ...conv }) =>
    branchGap && (branchGap.branch !== branchId || branchGap.against !== against) ? { ...conv, branchGap } : conv,
  );
  const tree = merged.conversations[conversation]?.branches;
  if (tree === undefined || against !== tree.current) return merged;
  return updateConversation(merged, conversation, (conv) => ({ ...conv, branchViews: { ...conv.branchViews, [branchId]: { against, summary, effects } } }));
}

/** 回放：把一串输入依次归并。直接给事件帧也行。 */
export function replay(inputs: readonly (EventFrame | UiInput)[], from: UiState = initialUiState): UiState {
  return inputs.reduce<UiState>((s, x) => reduce(s, "kind" in x ? x : { kind: "frame", frame: x }), from);
}

/** 重连时带给服务端的"每个频道最后收到的序号"。 */
export function resumeCursors(state: UiState): Record<string, number> {
  return { ...state.cursors };
}

/**
 * 某个会话还能不能往上翻：before 是手里最早那条消息的序号（取更早的一页时带给服务端）。
 * 手里没有消息、最早那条就是序号 1、或者服务端说过更早没有了，就不能再翻。
 */
export function olderHistory(state: UiState, conversation: ConversationId): { canLoadOlder: boolean; before: number | undefined } {
  const conv = state.conversations[conversation] ?? emptyConversation;
  // 当前分支上最早那条（151 号票：手里还有取回来预览的废弃分支上更早的消息，往上翻沿当前分支接着翻，不从它们那里跳过去）
  const shown = onPath(conv);
  const before = conv.messages.find((m) => shown(m.seq))?.seq;
  return { canLoadOlder: before !== undefined && before > 1 && !conv.olderExhausted, before };
}

/** 某张卡片的状态；没收到过这张卡就是 undefined。 */
export function selectCard(state: UiState, cardId: string): CardState | undefined {
  return state.cards[cardId];
}

/** 某条简单提醒的最新状态 */
export function selectReminder(state: UiState, reminderId: string): Reminder | undefined {
  return state.reminders[reminderId];
}

/** 一条权威消息（或"已删除"标记）在会话视图里的样子 */
function entryItem(m: ConversationEntry): ConversationItem {
  return "deleted" in m
    ? { kind: "deleted", key: m.deleted.messageId ?? `deleted:${m.seq}`, time: m.deleted.messageTime }
    : { kind: "message", message: m.message, idempotencyKey: m.idempotencyKey };
}

/** 权威消息之后的条目：正在生成的回复，排队的消息（144 号票），乐观显示的尾巴在最后 */
function liveItems(state: UiState, conversation: ConversationId): ConversationItem[] {
  const conv = state.conversations[conversation] ?? emptyConversation;
  const stream = state.streams[conversation];
  return [
    ...(stream ? [streamingItem(conversation, stream)] : []),
    ...queuedMessages(state, conversation).map((q): ConversationItem => ({ kind: "queued", idempotencyKey: q.idempotencyKey, message: q.message })),
    ...conv.tail.map((p): ConversationItem => ({ kind: "pending", ...p })),
  ];
}

/**
 * 这个会话排队的消息（144 号票），先交的在前：守护进程最新的那一队，照自己先做了的叉掉、改顺序显示；已经交出去、成了权威消息的不再算
 * （交出去的那一刻消息先到、队列后到，同一条不显示两遍）
 */
export function queuedMessages(state: UiState, conversation: ConversationId): readonly QueuedMessage[] {
  const conv = state.conversations[conversation];
  if (!conv || conv.queue.length === 0) return [];
  const delivered = new Set(conv.messages.flatMap((m) => ("message" in m ? [m.message.id] : [])));
  let queue = conv.queue.filter((q) => !delivered.has(q.message.id));
  for (const edit of conv.queueEdits) {
    if (edit.kind === "remove") queue = queue.filter((q) => q.message.id !== edit.messageId);
    else {
      const named = edit.messageIds.flatMap((id) => queue.find((q) => q.message.id === id) ?? []);
      queue = [...named, ...queue.filter((q) => !named.includes(q))];
    }
  }
  return queue;
}

/** 这个会话的 agent 正在回复（144 号票）：输入框上有"停止"，发送钮写"追加"（发的话排队，回完再给它） */
export function replyingIn(state: UiState, conversation: ConversationId): boolean {
  return state.conversations[conversation]?.openTurn !== undefined;
}

/** 某个会话要显示的条目：权威消息在前，然后是正在生成的回复，乐观显示的尾巴在最后。 */
export function conversationView(state: UiState, conversation: ConversationId): ConversationItem[] {
  const conv = state.conversations[conversation] ?? emptyConversation;
  const shown = onPath(conv);
  return [...conv.messages.filter((m) => shown(m.seq)).map(entryItem), ...liveItems(state, conversation)];
}

/** 分支摘要替它说清楚了的通知（152 号票：撤回之后运行时交给维护者接着做的那句，BranchSummaryPart.notice） */
function continuedNotices(conv: ConversationState): string[] {
  return conv.messages.flatMap((m) => ("message" in m ? m.message.parts.flatMap((p) => (p.type === "branch_summary" && p.notice !== undefined ? [p.notice] : [])) : []));
}

/** 当前分支上长程任务阶段开始的记号（152 号票），按序号从早到晚 */
export function pathStageStarts(state: UiState, conversation: ConversationId): readonly { readonly seq: number; readonly mark: StageStartEventPayload }[] {
  const conv = state.conversations[conversation] ?? emptyConversation;
  const shown = onPath(conv);
  return (conv.stageStarts ?? []).filter((m) => shown(m.seq));
}

/** 项目维护者的会话最新那一段还开着没有（152 号票）；不知道（没收到过分段事件）是 undefined */
export function segmentOpen(state: UiState, conversation: ConversationId): boolean | undefined {
  return state.conversations[conversation]?.segmentOpen;
}

/** 这个会话的会话树（150 号票）；没回退过是 undefined */
export function conversationBranches(state: UiState, conversation: ConversationId): ConversationBranches | undefined {
  return state.conversations[conversation]?.branches;
}

/** 当前分支上的权威消息（150 号票：废弃分支上的不算），按序号从早到晚；带着排队交出的那一批的标记 */
export function pathMessages(state: UiState, conversation: ConversationId): readonly Extract<ConversationEntry, { message: MessageEnvelope }>[] {
  const conv = state.conversations[conversation] ?? emptyConversation;
  const shown = onPath(conv);
  return conv.messages.filter((m): m is Extract<ConversationEntry, { message: MessageEnvelope }> => "message" in m && shown(m.seq));
}

/**
 * 时间线上的一条：会话视图里的条目（权威消息带上序号和归属：任务、项目、阶段），或者消息之外的一条记录（偏离、范围变更、越界、操作记录）。
 * 记录的时间：时间线记录自带；操作记录取对应卡片处理的时间（还没收到卡片时没有）
 */
export type TimelineItem =
  | (ConversationItem & { readonly seq?: number; readonly scope?: MessageScope })
  | { kind: "record"; key: string; seq: number; time: string | undefined; record: ConversationRecord; idempotencyKey?: undefined };

/**
 * 某个会话的时间线（完整视图）：权威消息和记录按序号排，然后是正在生成的回复，乐观显示的尾巴在最后（和 conversationView 同一套映射）。
 * 用语音回复的（32 号票，见 agent-voice.ts）：还在回复的那一轮不显示正在生成的回复，这一轮的消息不显示文字；整段合成的回复
 * 文字收进语音（长按"转文字"展开）。只剩文字的那条整条不显示。86 号票起 agent 用"发语音"工具发的语音同一套（发了之后到这一轮结束
 * 不显示这一轮的文字和正在生成的回复，回合结束时定了收进去的收进气泡）
 */
export function timelineItems(state: UiState, conversation: ConversationId, branch?: string): TimelineItem[] {
  const conv = state.conversations[conversation] ?? emptyConversation;
  // 会话回退过（150 号票）：只要当前分支上的消息和记录；给了一条废弃分支（151 号票的预览、详情）只要它自己那一段，没有正在生成的这些
  const shown = branch === undefined ? onPath(conv) : ownPart(conv, branch);
  const covered = replyCoverage(state, conversation);
  // 记录替它说清楚了的交给 agent 的通知（84 号票：重做记录后面交给维护者接着做的那句）不再重复显示；
  // 152 号票：分支摘要替它说清楚了的（撤回之后运行时交给维护者接着做的那句）也一样
  const noticesInRecords = new Set([
    ...conv.records.flatMap(({ record }) => (record.type === "timeline" && record.timeline.noticeId !== undefined ? [record.timeline.noticeId] : [])),
    ...continuedNotices(conv),
  ]);
  const entries = conv.messages.flatMap((m): TimelineItem[] => {
    if (!shown(m.seq)) return [];
    const item = entryItem(m);
    if (item.kind === "message" && noticesInRecords.has(item.message.id)) return [];
    if (item.kind === "message" && covered({ seq: m.seq, message: item.message })) {
      const parts = item.message.parts.filter((p) => p.type !== "text");
      if (!parts.some((p) => p.type !== "reasoning")) return [];
      return [{ ...item, message: { ...item.message, parts }, seq: m.seq, ...("scope" in m ? { scope: m.scope } : {}) }];
    }
    return [{ ...item, seq: m.seq, ...("scope" in m ? { scope: m.scope } : {}) }];
  });
  const records = conv.records.filter(({ seq }) => shown(seq)).map(
    ({ seq, record }): TimelineItem => ({
      kind: "record",
      key: record.type === "timeline" ? `record:${record.timeline.id}` : `operation:${record.operation.actionId}`,
      seq,
      time: record.type === "timeline" ? record.timeline.time : state.cards[record.operation.cardId]?.card.handledAt,
      record,
    }),
  );
  const held = agentVoiceHoldsReplies(state, conversation);
  const live = branch !== undefined ? [] : liveItems(state, conversation).filter((it) => !(held && it.kind === "streaming"));
  return [...[...entries, ...records].toSorted((a, b) => (a.seq ?? 0) - (b.seq ?? 0)), ...live];
}

/** 一个 agent 的活动状态和说明（说明的文字用协议包的 activityDetailText） */
export interface AgentActivity {
  readonly state: ActivityState;
  readonly detail?: ActivityDetail;
}

/** 活动状态说明的文字（小圆点旁边写的；没有说明的是 undefined） */
export function activityNote(activity: AgentActivity): string | undefined {
  return activity.detail ? activityDetailText(activity.detail) || undefined : undefined;
}

/**
 * 一个 agent 现在的活动状态：落盘的状态和说明，干活中时说明换成最新的进度。
 * 没收到过的是休眠（还没被唤起过的维护者；默认值只在这里）
 */
export function agentActivity(state: UiState, agentId: string): AgentActivity {
  const latest = state.activity[agentId];
  if (!latest) return { state: "sleeping" };
  const detail = (latest.state === "working" ? state.activityProgress[agentId] : undefined) ?? latest.detail;
  return { state: latest.state, ...(detail === undefined ? {} : { detail }) };
}

function streamingItem(conversation: ConversationId, stream: StreamingMessage): ConversationItem {
  // 时间留空：定稿消息带着服务端的时间到来
  const parts: MessagePart[] = stream.parts.map((p) => ({ type: p.type, text: p.text }));
  return { kind: "streaming", broken: stream.broken, message: { id: stream.messageId, conversation, speaker: "agent", time: "", parts } };
}

/** 输入框里引用的卡片（按引用的先后） */
export function quotedCards(state: UiState, conversation: ConversationId): readonly string[] {
  return state.quotes[conversation] ?? [];
}

function withoutKey<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}
