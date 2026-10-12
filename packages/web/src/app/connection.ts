// 前端和守护进程之间的连接（规格第 5 节）。界面只通过它收发：
// - 收：事件帧，连同失败的请求，一律变成状态层的输入（UiInput）交给 deliver；
// - 发：带幂等键的请求（发消息、对卡片做动作、对待我处理事项做动作、吊销已配对设备、发起任务、控制任务（13 号票）、改关注类别设置；15 号票起还有
//   新建项目、任务转为项目、项目页上的动作）；多数只管发，结果随后在频道上推来、被拒的变成 request_failed。要等结果的（90 号票：一次处理
//   多个任务，逐条回报）返回 Promise，被拒时同样变成 request_failed，Promise 也随之拒绝；
// - 多订阅几个频道（watchChannels，15 号票）：打开某个项目的维护者会话、任务详情（13 号票）时才订阅那个维护者的会话频道。
// 用哪个实现由 App.tsx 注入（StoreProvider 的 connection）：WebSocket 实现（ws-connection.ts），
// 原型的假实现（prototype/fake-connection.ts），过渡期按频道分流（prototype/split-connection.ts）。
import type {
  CardAction,
  ConversationId,
  InboxAction,
  MessagePart,
  PlanToolkit,
  ProjectAction,
  EventTrigger,
  ReminderSchedule,
  RescheduleJobResult,
  RunJobNowResult,
  ScheduledJobAction,
  SetVoiceAnnounceResult,
  TaskAction,
  TaskBatchAction,
  TaskBatchActionResult,
  TaskKind,
  TaskTrigger,
  ToolkitTarget,
  UiInput,
  UpdateWatchCategoriesParams,
} from "../state/index.ts";

export interface SendMessageRequest {
  conversation: ConversationId;
  idempotencyKey: string;
  parts: MessagePart[];
  /** 在哪个任务的详情里说的（75 号票：项目内部的普通任务做完了接着说，守护进程据此认出说的是这件事） */
  taskId?: string;
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

/** 吊销一台已配对设备：它的凭证立即失效，开着的 WebSocket 被服务端关掉 */
export interface RevokeDeviceRequest {
  deviceId: string;
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
  idempotencyKey: string;
}

/** 看板多选（90 号票）：一次对多个任务做暂停、继续、取消、归档，各自成败、逐条回报 */
export interface TaskBatchActionRequest {
  taskIds: string[];
  action: TaskBatchAction;
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

/** 开关任务的"跑完自动播报"（100 号票） */
export interface SetVoiceAnnounceRequest {
  taskId: string;
  on: boolean;
  idempotencyKey: string;
}

export interface Connection {
  /**
   * 连上服务端：带上每个频道最后收到的序号，服务端补发缺失的事件。
   * 返回断开连接的函数。
   */
  connect(cursors: Record<string, number>, deliver: (input: UiInput) => void): () => void;
  sendMessage(req: SendMessageRequest): void;
  cardAction(req: CardActionRequest): void;
  inboxAction(req: InboxActionRequest): void;
  revokeDevice(req: RevokeDeviceRequest): void;
  startTask(req: StartTaskRequest): void;
  /** 发起对话框里的"只提醒我"（76 号票）：提醒建出后在看板频道推来 */
  createReminder(req: CreateReminderRequest): void;
  updateWatchCategories(req: UpdateWatchCategoriesRequest): void;
  newProject(req: NewProjectRequest): void;
  convertTaskToProject(req: ConvertTaskRequest): void;
  projectAction(req: ProjectActionRequest): void;
  /** 项目页上的"重置维护者"（16 号票）：不改项目状态 */
  resetMaintainer(req: ResetMaintainerRequest): void;
  /** 多订阅几个频道（比如打开一个项目的维护者会话）：连着就马上订阅，断线重连时一起订阅；已经订阅的不重复 */
  watchChannels(channels: readonly string[]): void;
  taskAction(req: TaskActionRequest): void;
  /** 一次处理多个任务（90 号票）：等到逐条的结果（任务的新状态随后在看板频道推来）；整个被拒时拒绝 */
  taskBatchAction(req: TaskBatchActionRequest): Promise<TaskBatchActionResult>;
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
}
