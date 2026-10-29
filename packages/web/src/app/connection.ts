// 前端和守护进程之间的连接（规格第 5 节）。界面只通过它收发：
// - 收：事件帧，连同失败的请求，一律变成状态层的输入（UiInput）交给 deliver；
// - 发：带幂等键的请求（发消息、对卡片做动作、对待我处理事项做动作、发起任务、控制任务（13 号票）、改关注类别设置；15 号票起还有
//   新建项目、任务转为项目、项目页上的动作）；多数只管发，结果随后在频道上推来、被拒的变成 request_failed。要等结果的（90 号票：一次处理
//   多个任务，逐条回报；123 号票：已配对设备的延期、吊销、删除，逐台回报）返回 Promise，被拒时同样变成 request_failed，Promise 也随之拒绝；
// - 多订阅几个频道（watchChannels，15 号票）：打开某个项目的维护者会话、任务详情（13 号票）时才订阅那个维护者的会话频道。
// 用哪个实现由 App.tsx 注入（StoreProvider 的 connection）：WebSocket 实现（ws-connection.ts），
// 原型的假实现（prototype/fake-connection.ts），过渡期按频道分流（prototype/split-connection.ts）。
import type {
  BrowserOutcome,
  BrowserRequest,
  BrowserStatusParams,
  BrowsingContext,
  CardAction,
  ConversationId,
  DeviceBatchAction,
  DeviceBatchActionResult,
  DaemonInfo,
  InboxAction,
  MessagePart,
  PlanToolkit,
  ProjectAction,
  ProjectServicesAction,
  EventTrigger,
  ReminderSchedule,
  RescheduleJobResult,
  RunJobNowResult,
  ScheduledJobAction,
  SetVoiceAnnounceResult,
  StageEdit,
  TaskAction,
  TaskBatchAction,
  TaskBatchActionResult,
  ReminderAction,
  ReminderActionResult,
  TaskKind,
  TaskTrigger,
  ToolkitTarget,
  UiInput,
  UpdateWatchCategoriesParams,
  RollbackSessionResult,
  RollbackTarget,
  RequestEffectUndoResult,
  SwitchBranchResult,
  WorkFolderChoice,
} from "../state/index.ts";

export interface SendMessageRequest {
  conversation: ConversationId;
  idempotencyKey: string;
  parts: MessagePart[];
  /** 在哪个任务的详情里说的（75 号票：项目内部的普通任务做完了接着说，守护进程据此认出说的是这件事） */
  taskId?: string;
  /** 浏览侧边栏里发的（147 号票）：当时的网页、选中的框、哪个浏览器 */
  browsing?: BrowsingContext;
}

/** 对卡片做动作：`{卡片 id, 动作, 期望版本, 幂等键}`；服务端按版本条件更新，先到先得 */
export interface CardActionRequest {
  cardId: string;
  action: CardAction;
  expectedVersion: number;
  idempotencyKey: string;
  /** 动作附带的说明（打回意见、勾掉了哪几项授权、选了哪些答案） */
  note?: string;
  /** 动作附带的结构化输入（比如改提醒的新时间） */
  input?: unknown;
}

/** 对待我处理事项做动作：标已读 / 未读、归档 / 取消归档、删除、处理通知（choice 是选的动作） */
export interface InboxActionRequest {
  itemIds: string[];
  action: InboxAction;
  choice?: string;
  idempotencyKey: string;
}

/**
 * 设置 · 已配对设备的多选（123 号票，单台的"⋯"菜单也走它）：一次对几台延期（days 天）、吊销或删除，
 * 能做的都做、逐台回报；吊销、删除的设备凭证立即失效，开着的 WebSocket 被服务端关掉
 */
export interface DeviceBatchActionRequest {
  action: DeviceBatchAction;
  deviceIds: string[];
  days?: number;
  idempotencyKey: string;
}

/** 点"发起任务"按钮：写要做什么（第一行当标题），选涉及的项目（不选是不涉及项目）；服务端不经秘书判断直接建出任务（规划中），秘书接着澄清 */
export interface StartTaskRequest {
  request: string;
  projects: string[];
  /** 发起对话框里选的种类（58 号票）：流程或长程任务 */
  kind: TaskKind;
  /** 什么时候做（76 号票）：定时的写时间表；不给是现在做一次 */
  trigger?: TaskTrigger;
  /** 先勾上"跑完自动播报"（100 号票） */
  voiceAnnounce?: boolean;
  /** 选的运行时（289 号票）：不给是 pi */
  runtime?: string;
  /** 在哪个文件夹做（305 号票）：能选工作文件夹的运行时才给 */
  folder?: WorkFolderChoice;
  idempotencyKey: string;
}

/** 发起对话框里选了"只提醒我"（76 号票）：建一条简单提醒（不用 agent，到点只发通知） */
export interface CreateReminderRequest {
  text: string;
  /** 到点提醒：时间表（和 event 二选一） */
  schedule?: ReminderSchedule;
  /** 事件发生时提醒（77 号票）：哪个事件来源、哪几种事件、过滤条件 */
  event?: EventTrigger;
  idempotencyKey: string;
}

/** 设置页改关注类别（26 号票）：调严内置类别、新建 / 改 / 删自定义类别、修复坏了的设置文件、重新读文件；设置随后在关注类别频道推来 */
export interface UpdateWatchCategoriesRequest {
  params: UpdateWatchCategoriesParams;
  idempotencyKey: string;
}

/** 点"新建项目"：写想立个什么项目；秘书不判断"是不是项目"，直接出建议立项卡 */
export interface NewProjectRequest {
  request: string;
  /** 项目的维护者用的运行时（289 号票）：不给是 pi */
  runtime?: string;
  /** 在哪个文件夹做（305 号票）：能选工作文件夹的运行时才给 */
  folder?: WorkFolderChoice;
  idempotencyKey: string;
}

/** 把一个未结束的任务转为项目（原任务的维护者接着做立项问答）：项目名由用户定（预填任务标题） */
export interface ConvertTaskRequest {
  taskId: string;
  name: string;
  idempotencyKey: string;
}

/** 项目页上的动作：开工、放弃、停用、重新启用、归档、取消归档、删除（删除在待我处理里二次确认） */
export interface ResetMaintainerRequest {
  projectId: string;
  idempotencyKey: string;
}

export interface ProjectActionRequest {
  projectId: string;
  action: ProjectAction;
  idempotencyKey: string;
}

/** 项目卡片、项目页上的"启动""关闭"（257 号票）：经 LSM 把使用中的项目的服务全部拉起、全部关掉；做到哪了随后经 project_services 推来 */
export interface ProjectServicesActionRequest {
  projectId: string;
  action: ProjectServicesAction;
  idempotencyKey: string;
}

/** 气泡菜单里的"重新识别"（31 号票）：识别失败的语音重新排队识别；语音对象随后在会话频道推来 */
export interface RetryVoiceRequest {
  voiceId: string;
  idempotencyKey: string;
}

/** 项目页、任务详情的工具包区里直接改工具包（27 号票）：改完即写进工具包，项目、任务随后在各自的频道推来 */
export interface SetToolkitRequest {
  target: ToolkitTarget;
  toolkit: PlanToolkit;
  idempotencyKey: string;
}

/** 控制任务（13 号票）：暂停、继续、取消、重试、返工（指明阶段）、由我验收的验收通过或退回（指明阶段，退回可附原因） */
export interface TaskActionRequest {
  taskId: string;
  action: TaskAction;
  stageId?: string;
  note?: string;
  /** 从这里重做时直接改的这一阶段的验收标准、交付件（125 号票，只给 rework） */
  stageEdit?: StageEdit;
  idempotencyKey: string;
}

/** 看板多选（90 号票）：一次对多个任务做暂停、继续、取消、归档，各自成败、逐条回报 */
export interface TaskBatchActionRequest {
  taskIds: string[];
  action: TaskBatchAction;
  idempotencyKey: string;
}

/** 看板菜单、提醒卡上的按钮、看板多选（185 号票）：对一条或几条简单提醒取消、归档、删除，各自成败、逐条回报 */
export interface ReminderActionRequest {
  reminderIds: string[];
  action: ReminderAction;
  idempotencyKey: string;
}

/** 看板、项目页上对定时作业的动作（19 号票）：暂停、恢复、取消 */
export interface ScheduledJobActionRequest {
  jobId: string;
  action: ScheduledJobAction;
  idempotencyKey: string;
}

/** 改定时触发的任务的时间表（98 号票）：哪个触发登记、新的时间表 */
export interface RescheduleJobRequest {
  jobId: string;
  schedule: ReminderSchedule;
  idempotencyKey: string;
}

/** 定时 / 事件触发的任务立即运行一次（100 号票）：哪个触发登记 */
export interface RunJobNowRequest {
  jobId: string;
  idempotencyKey: string;
}

/** 会话回退（150 号票）：缩小视图里点 ↶、确认之后回到某条之前 */
export interface RollbackSessionRequest {
  conversation: ConversationId;
  before: RollbackTarget;
  idempotencyKey: string;
}

/** 切换分支（151 号票）：展开的 ⑂ 预览上点"切换到这条分支" */
export interface SwitchBranchRequest {
  conversation: ConversationId;
  branchId: string;
  idempotencyKey: string;
}

/** 废弃分支详情里一件遗留效果的「申请撤回」（151 号票） */
export interface RequestEffectUndoRequest {
  conversation: ConversationId;
  branchId: string;
  callId: string;
  idempotencyKey: string;
}

/** 开关任务的"跑完自动播报"（100 号票） */
export interface SetVoiceAnnounceRequest {
  taskId: string;
  on: boolean;
  idempotencyKey: string;
}

/** 记下会话看到哪一条了（109 号票：秘书页上的已读位置） */
export interface MarkReadRequest {
  conversation: ConversationId;
  seq: number;
  idempotencyKey: string;
}

/** 输入框旁的"停止"（144 号票）：停下这个会话的 agent 正在回复的这一轮 */
export interface StopReplyRequest {
  conversation: ConversationId;
  idempotencyKey: string;
}

/** 聊天区里排队的消息（144 号票）：叉掉一条，或者给出拖完的顺序；队列的新样子随后在会话频道推来 */
export type QueuedMessageActionRequest = ({ action: "remove"; messageId: string } | { action: "reorder"; messageIds: string[] }) & { conversation: ConversationId; idempotencyKey: string };

export interface Connection {
  /**
   * 连上服务端：带上每个频道最后收到的序号，服务端补发缺失的事件。
   * 返回断开连接的函数。
   */
  connect(cursors: Record<string, number>, deliver: (input: UiInput) => void): () => void;
  sendMessage(req: SendMessageRequest): void;
  cardAction(req: CardActionRequest): void;
  inboxAction(req: InboxActionRequest): void;
  /** 设备多选（123 号票）：等到逐台的结果（设备的新样子随后在已配对设备频道推来）；整个被拒时拒绝 */
  deviceBatchAction(req: DeviceBatchActionRequest): Promise<DeviceBatchActionResult>;
  startTask(req: StartTaskRequest): void;
  /** 发起对话框里的"只提醒我"（76 号票）：提醒建出后在看板频道推来 */
  createReminder(req: CreateReminderRequest): void;
  updateWatchCategories(req: UpdateWatchCategoriesRequest): void;
  newProject(req: NewProjectRequest): void;
  convertTaskToProject(req: ConvertTaskRequest): void;
  projectAction(req: ProjectActionRequest): void;
  /** 项目卡片、项目页上的"启动""关闭"（257 号票）：只管发，做到哪了随后经 project_services 推来；被拒时原因进 request_failed */
  projectServicesAction(req: ProjectServicesActionRequest): void;
  /** 项目页上的"重置维护者"（16 号票）：不改项目状态 */
  resetMaintainer(req: ResetMaintainerRequest): void;
  /** 多订阅几个频道（比如打开一个项目的维护者会话）：连着就马上订阅，断线重连时一起订阅；已经订阅的不重复 */
  watchChannels(channels: readonly string[]): void;
  taskAction(req: TaskActionRequest): void;
  /** 一次处理多个任务（90 号票）：等到逐条的结果（任务的新状态随后在看板频道推来）；整个被拒时拒绝 */
  taskBatchAction(req: TaskBatchActionRequest): Promise<TaskBatchActionResult>;
  /** 对简单提醒取消、归档、删除（185 号票）：等到逐条的结果（提醒的新样子随后在看板频道推来）；整个被拒时拒绝 */
  reminderAction(req: ReminderActionRequest): Promise<ReminderActionResult>;
  retryVoice(req: RetryVoiceRequest): void;
  /** 工具包区里改工具包（27 号票） */
  setToolkit(req: SetToolkitRequest): void;
  /** 看板、项目页上暂停、恢复、取消定时作业（19 号票）：作业的新状态随后在看板频道推来 */
  scheduledJobAction(req: ScheduledJobActionRequest): void;
  /** 任务操作菜单里的"改时间"（98 号票）：等到守护进程回的结果（状态、新的时间表、下一次），触发登记的新样子随后在看板频道推来；被拒时拒绝 */
  rescheduleJob(req: RescheduleJobRequest): Promise<RescheduleJobResult>;
  /** 任务操作菜单里的"立即运行一次"（100 号票）：等到起了哪一次运行；上一次还在跑之类被拒时拒绝（原因同样进 request_failed） */
  runJobNow(req: RunJobNowRequest): Promise<RunJobNowResult>;
  /** 任务操作菜单里的"跑完自动播报：开 / 关"（100 号票）：等到开关之后的样子；任务的新样子随后在看板频道推来 */
  setVoiceAnnounce(req: SetVoiceAnnounceRequest): Promise<SetVoiceAnnounceResult>;
  /** 秘书页上看到哪一条了（109 号票）：只管发，已读位置随后在已读位置频道推来（几台设备一起） */
  markRead(req: MarkReadRequest): void;
  /** 停下正在回复的这一轮（144 号票）：只管发，这一轮的结束随后在会话频道推来；被拒时原因进 request_failed */
  stopReply(req: StopReplyRequest): void;
  /**
   * 会话回退（150 号票）：等到守护进程做完（秘书停稳、写好分支摘要、长出新分支）；新的会话树、分支摘要随后在会话频道推来。
   * 被拒时拒绝，原因同样进 request_failed
   */
  rollbackSession(req: RollbackSessionRequest): Promise<RollbackSessionResult>;
  /**
   * 切换分支（151 号票）：等到守护进程做完（秘书停稳、会话树切到那条分支的末端）；新的会话树随后在会话频道推来。
   * 被拒时拒绝，原因同样进 request_failed
   */
  switchBranch(req: SwitchBranchRequest): Promise<SwitchBranchResult>;
  /** 申请撤回废弃分支上的一件遗留效果（151 号票）：等到记下了（什么时候提交的）；会话频道随后推来 effect_undo_requested。被拒时拒绝 */
  requestEffectUndo(req: RequestEffectUndoRequest): Promise<RequestEffectUndoResult>;
  /** 叉掉、改顺序（144 号票）：只管发，队列的新样子随后在会话频道推来；被拒时进 request_failed（状态层把先显示的那一步收回） */
  queuedMessageAction(req: QueuedMessageActionRequest): void;
  /**
   * 守护进程是哪一版、什么时候起来的、它此刻的时间（124 号票：设置里的关于二狗、Debug 工具集的"测一次延迟"和测试提醒）。
   * 只读的查询：没连上、问着的时候断了、守护进程太旧（不认）、10 秒没回都拒绝，不进 ui.failures
   */
  daemonInfo(): Promise<DaemonInfo>;
  /** 这次打开以来断线、重连各几次，最近一次断线的时间和原因（124 号票：Debug 工具集的连接一组） */
  stats(): ConnectionStats;
  /** Debug 工具集的"断开重连"（124 号票）：关掉现在的连接，马上重连 */
  reconnect(): void;
  /**
   * 浏览侧边栏（147 号票）：报这台设备上浏览器现在的样子（开着哪个网页、选中了哪个框）。只管发、不重发旧的：连上、重连后自己再报最后一次的。
   * 原型的假连接没有
   */
  browserStatus?(status: BrowserStatusParams): void;
  /** 收守护进程推来的 browser_request（秘书的网页工具要这台设备办的事）；返回退订 */
  onBrowserRequest?(listener: (request: BrowserRequest) => void): () => void;
  /** 回 browser_request 的结果；没连着就不回（守护进程到时会回秘书"没回"） */
  browserReply?(id: string, result: BrowserOutcome): void;
}

/** 这次打开以来的连接情况（124 号票） */
export interface ConnectionStats {
  /** 连着的断了几次 */
  readonly drops: number;
  /** 断了之后又连上几次 */
  readonly reconnects: number;
  /** 最近一次断线：什么时候（协议时间）、为什么（关闭码说的，或者"在 Debug 工具集里点了断开重连"） */
  readonly lastDrop?: { readonly at: string; readonly reason: string };
}
