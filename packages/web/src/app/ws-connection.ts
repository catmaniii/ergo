// 连到守护进程的 WebSocket（规格第 5 节）。
// - 连上就发"订阅"：带协议版本和每个频道最后收到的序号，服务端补发缺失的落盘事件，之后推送新的；
// - 收到的事件帧原样交给状态层；游标只按落盘事件推进（临时事件不占序号）；
// - 断线自动重连（间隔逐步拉长），没得到响应的请求在重新订阅之后带同一个幂等键重发，服务端不会做两次；
// - 协议版本对不上就报"页面过旧"，不再重连，等用户刷新；
// - 订阅的响应里点名要重新同步的频道（前端的序号比服务端还大），交给状态层清掉，服务端接着从头补发；
// - 外网端口上（经隧道的已配对设备）：断线后先问一下这台设备还被信任吗（checkAccess）。凭证失效了（被吊销、太久没用）
//   就报 unpaired、不再重连，界面回到配对等待页；问不到（网断了）照常重连。
// - 补发和实时推来的分开标（36 号票：补发的 agent 语音不自动播）：服务端处理订阅时先回响应、再补发；发订阅时紧跟着
//   发一个空订阅（cursors 为空，服务端什么也不补、什么也不改）当回执。服务端按顺序处理同一条连接上的请求，补发在处理订阅时
//   一口气推完，所以回执的响应一定排在补发的帧后面：它到之前，这次订阅的频道上来的帧都标成补发的（catchUp）。多订阅频道时同样。
//   连上时那次订阅的回执到了，告诉状态层补发推完了（synced，109 号票：这时才报已读位置、看一眼有没有没看过的秘书消息）。
// - 要等结果的请求（90 号票：一次处理多个任务）按请求帧的 id 记着，响应到了交回去（重连后重发的是同一帧，id 不变）；被拒的照常
//   变成 request_failed，等着的也随之拒绝。
// - 订阅的响应里带着守护进程现在提供的网页是哪一版（116 号票），连上、重连时报 web_version（页面和自己的对不上就提示刷新）；
//   没带（旧版守护进程、index.html 里没有版本号）不报。之后换了一版是活动状态频道上的临时事件 web_version，照常当事件帧交给状态层。
// - 124 号票（设置里的关于二狗、Debug 工具集）：守护进程的版本（daemon_info）是只读的查询——不带幂等键、不进 outbox：没连上直接拒绝，
//   问着的时候断了也拒绝（重连后不重发），10 秒没回拒绝，被拒的不变成 request_failed（Debug 页自己说）。这次打开以来断线、重连各几次，
//   最近一次断线的时间和原因（WebSocket 的关闭码，stats）；"断开重连"（reconnect）关掉现在的连接马上重连，不等退避、不先问被不被信任。
// - 147 号票（浏览侧边栏）：这台设备上浏览器的样子（browser_status）只记最后一次，连着就发，重新订阅上了再发一次（守护进程按连接认浏览器，
//   连接断了它就当浏览器关了）；守护进程推来的 browser_request（秘书会话频道上的临时事件）不进状态层，交给登记的那一处办，
//   办完的结果（browser_reply）连着才发、不重发。这两种请求都不带幂等键、不进 outbox。
import type {
  CardActionRequest,
  Connection,
  ConnectionStats,
  ConvertTaskRequest,
  InboxActionRequest,
  NewProjectRequest,
  ProjectActionRequest,
  ProjectServicesActionRequest,
  RescheduleJobRequest,
  ResetMaintainerRequest,
  RetryVoiceRequest,
  QueuedMessageActionRequest,
  StopReplyRequest,
  RollbackSessionRequest,
  RequestEffectUndoRequest,
  SwitchBranchRequest,
  RunJobNowRequest,
  SetToolkitRequest,
  SetVoiceAnnounceRequest,
  DeviceBatchActionRequest,
  ScheduledJobActionRequest,
  SendMessageRequest,
  StartTaskRequest,
  CreateReminderRequest,
  MarkReadRequest,
  TaskActionRequest,
  TaskBatchActionRequest,
  ReminderActionRequest,
  UpdateWatchCategoriesRequest,
} from "./connection.ts";
import { type AccessInfo, type BrowserOutcome, type BrowserReplyParams, type BrowserRequest, type BrowserStatusParams, type CardActionParams, closeReasonText, type ConvertTaskParams, type CreateReminderParams, type DaemonInfo, type DaemonInfoParams, type DeviceBatchActionParams, type DeviceBatchActionResult, EVENT_TYPES, type EventFrame, FRONTEND_PROTOCOL_VERSION, type InboxActionParams, isEphemeralEventType, type MarkReadParams, type Method, METHODS, type NewProjectParams, nowIso, type ProjectActionParams, type ProjectServicesActionParams, type QueuedMessageActionParams, type RequestEffectUndoParams, type RequestEffectUndoResult, type RequestFrame, type RescheduleJobParams, type RescheduleJobResult, type ResetMaintainerParams, type ResponseFrame, type RetryVoiceParams, type RollbackSessionParams, type RollbackSessionResult, type RunJobNowParams, type RunJobNowResult, type ScheduledJobActionParams, type SendMessageParams, type SetToolkitParams, type SetVoiceAnnounceParams, type SetVoiceAnnounceResult, type StartTaskParams, type StopReplyParams, type SubscribeParams, type SubscribeResult, type SwitchBranchParams, type SwitchBranchResult, t, type TaskActionParams, type TaskBatchActionParams, type TaskBatchActionResult, type ReminderActionParams, type ReminderActionResult, type UiInput } from "../state/index.ts";

/** 浏览器 WebSocket 里用到的那部分（测试换成假的） */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "error", listener: () => void): void;
  /** 断开：浏览器的 CloseEvent 带关闭码和原因（124 号票的 Debug 工具集显示最近一次断线的原因） */
  addEventListener(type: "close", listener: (ev?: { code?: number; reason?: string }) => void): void;
  addEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
}

export interface WebSocketConnectionOptions {
  url: string;
  /** 订阅哪些频道 */
  channels: readonly string[];
  createSocket?: (url: string) => SocketLike;
  /** 断线后重连前等多久（毫秒）：依次取，取完之后一直用最后一个 */
  retryDelaysMs?: readonly number[];
  /**
   * 断线后、重连之前问一下这台设备还被信任吗；none 就报 unpaired（带上知道的原因），不再重连。
   * 不给就不问（本机端口总是被信任）
   */
  checkAccess?: () => Promise<AccessInfo>;
}

const DEFAULT_RETRY_DELAYS_MS = [500, 1000, 2000, 5000, 10_000];

/** 只读的查询（daemon_info）最多等多久 */
const QUERY_TIMEOUT_MS = 10_000;

/** 在 Debug 工具集里点"断开重连"时，最近一次断线的原因（169 号票起按当时的语言） */
const manualReconnect = (): string => t("app.ws.manualReconnect");

/** 页面所在的守护进程的 WebSocket 地址 */
export function daemonSocketUrl(location: { protocol: string; host: string }): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
}

export class WebSocketConnection implements Connection {
  private readonly options: WebSocketConnectionOptions;
  private socket: SocketLike | undefined;
  private deliver: ((input: UiInput) => void) | undefined;
  private cursors: Record<string, number> = {};
  /** 发出去、还没得到响应的请求（按发出的先后）；断线重连后重发 */
  private readonly outbox = new Map<string, RequestFrame>();
  /** 等结果的请求（一次处理多个任务，90 号票）：按请求帧的 id */
  private readonly waiting = new Map<string, { resolve(result: unknown): void; reject(err: Error): void }>();
  private subscribeId: string | undefined;
  private online = false;
  private stopped = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private requestNo = 0;
  /** 后来多订阅的频道（watchChannels）：重连时和 options.channels 一起订阅 */
  private readonly watched = new Set<string>();
  /** 多订阅时发出去、还没得到响应的订阅请求 */
  private readonly watchRequests = new Set<string>();
  /** 补发还没推完：这条连接上发出去、还没得到响应的回执（空订阅），各是哪次订阅的哪几个频道 */
  private readonly catchUps = new Map<string, readonly string[]>();
  /** 这条连接上主订阅（连上时那一次）的回执：它到了就是打开、重连上之后的补发推完了（109 号票，报 synced） */
  private mainReceipt: string | undefined;
  /** 等结果的只读查询（daemon_info，124 号票）：按请求帧的 id；不重发，断了就拒绝 */
  private readonly queries = new Map<string, { resolve(result: unknown): void; reject(err: Error): void }>();
  /** 这次打开以来断线、重连各几次，最近一次断线（124 号票） */
  private drops = 0;
  private reconnects = 0;
  private lastDrop: { at: string; reason: string } | undefined;
  /** 连上过（之后再订阅成功算重连） */
  private everOnline = false;
  /** 这次断开是 Debug 工具集里点的"断开重连" */
  private manualDrop = false;
  /** 浏览器最后一次的样子（147 号票）：重新订阅上了再报 */
  private browser: BrowserStatusParams | undefined;
  /** 办 browser_request 的（147 号票） */
  private readonly browserListeners = new Set<(request: BrowserRequest) => void>();

  constructor(options: WebSocketConnectionOptions) {
    this.options = options;
  }

  connect(cursors: Record<string, number>, deliver: (input: UiInput) => void): () => void {
    this.stopped = false;
    this.deliver = deliver;
    this.cursors = { ...cursors };
    this.open();
    return () => {
      this.stopped = true;
      this.deliver = undefined;
      if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
      const socket = this.socket;
      this.socket = undefined;
      this.online = false;
      socket?.close();
    };
  }

  sendMessage(req: SendMessageRequest): void {
    const params: SendMessageParams = {
      conversation: req.conversation,
      parts: req.parts,
      ...(req.taskId === undefined ? {} : { taskId: req.taskId }),
      ...(req.browsing === undefined ? {} : { browsing: req.browsing }),
    };
    this.request(METHODS.sendMessage, params, req.idempotencyKey);
  }

  cardAction(req: CardActionRequest): void {
    const params: CardActionParams = {
      cardId: req.cardId,
      action: req.action,
      expectedVersion: req.expectedVersion,
      ...(req.note === undefined ? {} : { note: req.note }),
      ...(req.input === undefined ? {} : { input: req.input }),
    };
    this.request(METHODS.cardAction, params, req.idempotencyKey);
  }

  inboxAction(req: InboxActionRequest): void {
    const params: InboxActionParams = { itemIds: req.itemIds, action: req.action, ...(req.choice === undefined ? {} : { choice: req.choice }) };
    this.request(METHODS.inboxAction, params, req.idempotencyKey);
  }

  deviceBatchAction(req: DeviceBatchActionRequest): Promise<DeviceBatchActionResult> {
    const params: DeviceBatchActionParams = { action: req.action, deviceIds: req.deviceIds, ...(req.days === undefined ? {} : { days: req.days }) };
    return new Promise((resolve, reject) => {
      const id = this.request(METHODS.deviceBatchAction, params, req.idempotencyKey);
      this.waiting.set(id, { resolve: (result) => resolve(result as DeviceBatchActionResult), reject });
    });
  }

  startTask(req: StartTaskRequest): void {
    const params: StartTaskParams = {
      request: req.request,
      ...(req.projects.length === 0 ? {} : { projects: req.projects }),
      kind: req.kind,
      ...(req.trigger ? { trigger: req.trigger } : {}),
      ...(req.voiceAnnounce ? { voiceAnnounce: true } : {}),
      ...(req.runtime === undefined ? {} : { runtime: req.runtime }),
      ...(req.folder === undefined ? {} : { folder: req.folder }),
    };
    this.request(METHODS.startTask, params, req.idempotencyKey);
  }

  createReminder(req: CreateReminderRequest): void {
    const params: CreateReminderParams = { text: req.text, ...(req.schedule ? { schedule: req.schedule } : {}), ...(req.event ? { event: req.event } : {}) };
    this.request(METHODS.createReminder, params, req.idempotencyKey);
  }

  markRead(req: MarkReadRequest): void {
    const params: MarkReadParams = { conversation: req.conversation, seq: req.seq };
    this.request(METHODS.markRead, params, req.idempotencyKey);
  }

  stopReply(req: StopReplyRequest): void {
    const params: StopReplyParams = { conversation: req.conversation };
    this.request(METHODS.stopReply, params, req.idempotencyKey);
  }

  queuedMessageAction(req: QueuedMessageActionRequest): void {
    const params: QueuedMessageActionParams =
      req.action === "remove" ? { conversation: req.conversation, action: "remove", messageId: req.messageId } : { conversation: req.conversation, action: "reorder", messageIds: req.messageIds };
    this.request(METHODS.queuedMessageAction, params, req.idempotencyKey);
  }

  updateWatchCategories(req: UpdateWatchCategoriesRequest): void {
    this.request(METHODS.updateWatchCategories, req.params, req.idempotencyKey);
  }

  newProject(req: NewProjectRequest): void {
    const params: NewProjectParams = { request: req.request, ...(req.runtime === undefined ? {} : { runtime: req.runtime }), ...(req.folder === undefined ? {} : { folder: req.folder }) };
    this.request(METHODS.newProject, params, req.idempotencyKey);
  }

  convertTaskToProject(req: ConvertTaskRequest): void {
    const params: ConvertTaskParams = { taskId: req.taskId, name: req.name };
    this.request(METHODS.convertTaskToProject, params, req.idempotencyKey);
  }

  projectAction(req: ProjectActionRequest): void {
    const params: ProjectActionParams = { projectId: req.projectId, action: req.action };
    this.request(METHODS.projectAction, params, req.idempotencyKey);
  }

  projectServicesAction(req: ProjectServicesActionRequest): void {
    const params: ProjectServicesActionParams = { projectId: req.projectId, action: req.action };
    this.request(METHODS.projectServicesAction, params, req.idempotencyKey);
  }

  resetMaintainer(req: ResetMaintainerRequest): void {
    const params: ResetMaintainerParams = { projectId: req.projectId };
    this.request(METHODS.resetMaintainer, params, req.idempotencyKey);
  }

  taskAction(req: TaskActionRequest): void {
    const params: TaskActionParams = {
      taskId: req.taskId,
      action: req.action,
      ...(req.stageId === undefined ? {} : { stageId: req.stageId }),
      ...(req.note === undefined ? {} : { note: req.note }),
      ...(req.stageEdit === undefined ? {} : { stageEdit: req.stageEdit }),
    };
    this.request(METHODS.taskAction, params, req.idempotencyKey);
  }

  taskBatchAction(req: TaskBatchActionRequest): Promise<TaskBatchActionResult> {
    const params: TaskBatchActionParams = { taskIds: req.taskIds, action: req.action };
    return new Promise((resolve, reject) => {
      const id = this.request(METHODS.taskBatchAction, params, req.idempotencyKey);
      this.waiting.set(id, { resolve: (result) => resolve(result as TaskBatchActionResult), reject });
    });
  }

  reminderAction(req: ReminderActionRequest): Promise<ReminderActionResult> {
    const params: ReminderActionParams = { reminderIds: req.reminderIds, action: req.action };
    return new Promise((resolve, reject) => {
      const id = this.request(METHODS.reminderAction, params, req.idempotencyKey);
      this.waiting.set(id, { resolve: (result) => resolve(result as ReminderActionResult), reject });
    });
  }

  retryVoice(req: RetryVoiceRequest): void {
    const params: RetryVoiceParams = { voiceId: req.voiceId };
    this.request(METHODS.retryVoice, params, req.idempotencyKey);
  }

  setToolkit(req: SetToolkitRequest): void {
    const params: SetToolkitParams = { target: req.target, toolkit: req.toolkit };
    this.request(METHODS.setToolkit, params, req.idempotencyKey);
  }

  scheduledJobAction(req: ScheduledJobActionRequest): void {
    const params: ScheduledJobActionParams = { jobId: req.jobId, action: req.action };
    this.request(METHODS.scheduledJobAction, params, req.idempotencyKey);
  }

  rescheduleJob(req: RescheduleJobRequest): Promise<RescheduleJobResult> {
    const params: RescheduleJobParams = { jobId: req.jobId, schedule: req.schedule };
    return new Promise((resolve, reject) => {
      const id = this.request(METHODS.rescheduleJob, params, req.idempotencyKey);
      this.waiting.set(id, { resolve: (result) => resolve(result as RescheduleJobResult), reject });
    });
  }

  rollbackSession(req: RollbackSessionRequest): Promise<RollbackSessionResult> {
    const params: RollbackSessionParams = { conversation: req.conversation, before: req.before };
    return new Promise((resolve, reject) => {
      const id = this.request(METHODS.rollbackSession, params, req.idempotencyKey);
      this.waiting.set(id, { resolve: (result) => resolve(result as RollbackSessionResult), reject });
    });
  }

  switchBranch(req: SwitchBranchRequest): Promise<SwitchBranchResult> {
    const params: SwitchBranchParams = { conversation: req.conversation, branchId: req.branchId };
    return new Promise((resolve, reject) => {
      const id = this.request(METHODS.switchBranch, params, req.idempotencyKey);
      this.waiting.set(id, { resolve: (result) => resolve(result as SwitchBranchResult), reject });
    });
  }

  requestEffectUndo(req: RequestEffectUndoRequest): Promise<RequestEffectUndoResult> {
    const params: RequestEffectUndoParams = { conversation: req.conversation, branchId: req.branchId, callId: req.callId };
    return new Promise((resolve, reject) => {
      const id = this.request(METHODS.requestEffectUndo, params, req.idempotencyKey);
      this.waiting.set(id, { resolve: (result) => resolve(result as RequestEffectUndoResult), reject });
    });
  }

  runJobNow(req: RunJobNowRequest): Promise<RunJobNowResult> {
    const params: RunJobNowParams = { jobId: req.jobId };
    return new Promise((resolve, reject) => {
      const id = this.request(METHODS.runJobNow, params, req.idempotencyKey);
      this.waiting.set(id, { resolve: (result) => resolve(result as RunJobNowResult), reject });
    });
  }

  setVoiceAnnounce(req: SetVoiceAnnounceRequest): Promise<SetVoiceAnnounceResult> {
    const params: SetVoiceAnnounceParams = { taskId: req.taskId, on: req.on };
    return new Promise((resolve, reject) => {
      const id = this.request(METHODS.setVoiceAnnounce, params, req.idempotencyKey);
      this.waiting.set(id, { resolve: (result) => resolve(result as SetVoiceAnnounceResult), reject });
    });
  }

  daemonInfo(): Promise<DaemonInfo> {
    const params: DaemonInfoParams = {};
    return this.query<DaemonInfo>(METHODS.daemonInfo, params);
  }

  browserStatus(status: BrowserStatusParams): void {
    this.browser = status;
    this.fireAndForget(METHODS.browserStatus, status);
  }

  onBrowserRequest(listener: (request: BrowserRequest) => void): () => void {
    this.browserListeners.add(listener);
    return () => void this.browserListeners.delete(listener);
  }

  browserReply(id: string, result: BrowserOutcome): void {
    const params: BrowserReplyParams = { id, result };
    this.fireAndForget(METHODS.browserReply, params);
  }

  /** 只管发的请求（147 号票）：不带幂等键、不进 outbox、不重发，没连着就算了；响应不看 */
  private fireAndForget(method: Method, params: unknown): void {
    if (!this.online || !this.socket) return;
    this.socket.send(JSON.stringify({ id: this.nextId(), method, params } satisfies RequestFrame));
  }

  stats(): ConnectionStats {
    return { drops: this.drops, reconnects: this.reconnects, ...(this.lastDrop ? { lastDrop: this.lastDrop } : {}) };
  }

  reconnect(): void {
    if (this.stopped) return;
    if (this.socket) {
      // 关掉现在的连接；close 事件里记一次断线、马上重连
      this.manualDrop = true;
      this.socket.close();
      return;
    }
    // 断着、正等着重连：不等了
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (!this.stopped && !this.socket) this.open();
    }, 0);
  }

  /** 只读的查询（124 号票）：连着才发，不进 outbox、不重发；断了、被拒、10 秒没回都拒绝 */
  private query<T>(method: Method, params: unknown): Promise<T> {
    const socket = this.socket;
    if (!this.online || !socket) return Promise.reject(new Error(t("app.ws.offline")));
    const id = this.nextId();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.queries.delete(id);
        reject(new Error(t("app.ws.timeout", { seconds: QUERY_TIMEOUT_MS / 1000 })));
      }, QUERY_TIMEOUT_MS);
      this.queries.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result as T);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      socket.send(JSON.stringify({ id, method, params } satisfies RequestFrame));
    });
  }

  watchChannels(channels: readonly string[]): void {
    const fresh = channels.filter((c) => !this.options.channels.includes(c) && !this.watched.has(c));
    if (fresh.length === 0) return;
    for (const c of fresh) this.watched.add(c);
    if (!this.online || !this.socket) return;
    // 服务端的订阅是叠加的：再发一次订阅，只带这几个频道
    const id = this.nextId();
    this.watchRequests.add(id);
    const params: SubscribeParams = { protocolVersion: FRONTEND_PROTOCOL_VERSION, cursors: Object.fromEntries(fresh.map((c) => [c, this.cursors[c] ?? 0])) };
    this.socket.send(JSON.stringify({ id, method: METHODS.subscribe, params } satisfies RequestFrame));
    this.awaitCatchUp(fresh);
  }

  /** 发一个带幂等键的请求（没连上时先记着，连上后发）；返回请求帧的 id */
  private request(method: Method, params: unknown, idempotencyKey: string): string {
    const frame: RequestFrame = { id: this.nextId(), method, params, idempotencyKey };
    this.outbox.set(frame.id, frame);
    if (this.online) this.socket?.send(JSON.stringify(frame));
    return frame.id;
  }

  private nextId(): string {
    this.requestNo += 1;
    return `r${this.requestNo}`;
  }

  private open(): void {
    const create = this.options.createSocket ?? ((url: string): SocketLike => new WebSocket(url));
    const socket = create(this.options.url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (socket !== this.socket) return;
      const cursors = Object.fromEntries([...this.options.channels, ...this.watched].map((c) => [c, this.cursors[c] ?? 0]));
      const params: SubscribeParams = { protocolVersion: FRONTEND_PROTOCOL_VERSION, cursors };
      this.subscribeId = this.nextId();
      socket.send(JSON.stringify({ id: this.subscribeId, method: METHODS.subscribe, params } satisfies RequestFrame));
      this.mainReceipt = this.awaitCatchUp(Object.keys(cursors));
    });
    socket.addEventListener("message", (ev) => {
      if (socket === this.socket) this.onFrame(String(ev.data));
    });
    // 出错之后总会跟着 close，在那里处理
    socket.addEventListener("close", (ev) => {
      if (socket !== this.socket) return;
      const wasOnline = this.online;
      const manual = this.manualDrop;
      this.manualDrop = false;
      this.socket = undefined;
      this.online = false;
      // 回执是这条连接上的；重连后重新订阅、重新等
      this.catchUps.clear();
      // 只读的查询不重发
      for (const query of this.queries.values()) query.reject(new Error(t("app.ws.dropped")));
      this.queries.clear();
      // 连着的断了才算一次断线（一直连不上的那几次不算）
      if (wasOnline) {
        this.drops += 1;
        this.lastDrop = { at: nowIso(), reason: manual ? manualReconnect() : closeReasonText(ev?.code, ev?.reason) };
      }
      if (this.stopped) return;
      this.deliver?.({ kind: "connection", status: "offline" });
      if (manual) {
        this.attempt = 0;
        this.retryTimer = setTimeout(() => {
          this.retryTimer = undefined;
          if (!this.stopped && !this.socket) this.open();
        }, 0);
        return;
      }
      const check = this.options.checkAccess;
      if (!check) return this.scheduleReconnect();
      check().then(
        (info) => {
          // 已经停了、或者等着问的时候已经连上了（点了"断开重连"）
          if (this.stopped || this.socket) return;
          if (info.access !== "none") return this.scheduleReconnect();
          this.stopped = true;
          this.deliver?.({ kind: "connection", status: "unpaired", ...(info.reason === undefined ? {} : { reason: info.reason }) });
        },
        () => {
          if (!this.stopped && !this.socket) this.scheduleReconnect();
        },
      );
    });
  }

  private scheduleReconnect(): void {
    const delays = this.options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    const delay = delays[Math.min(this.attempt, delays.length - 1)] ?? 1000;
    this.attempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (!this.stopped && !this.socket) this.open();
    }, delay);
  }

  private onFrame(text: string): void {
    let frame: EventFrame | ResponseFrame;
    try {
      frame = JSON.parse(text) as EventFrame | ResponseFrame;
    } catch {
      return;
    }
    if ("channel" in frame) {
      // 秘书的网页工具要这台设备办的事（147 号票）：不进状态层
      if (frame.type === EVENT_TYPES.browserRequest) {
        for (const listener of this.browserListeners) listener(frame.payload as BrowserRequest);
        return;
      }
      if (!isEphemeralEventType(frame.type)) this.cursors[frame.channel] = Math.max(this.cursors[frame.channel] ?? 0, frame.seq);
      const catchUp = [...this.catchUps.values()].some((channels) => channels.includes(frame.channel));
      this.deliver?.(catchUp ? { kind: "frame", frame, catchUp } : { kind: "frame", frame });
      return;
    }
    if (frame.id !== null && frame.id === this.subscribeId) return this.onSubscribed(frame);
    // 回执到了：这次订阅的补发推完了（回执本身不会失败；万一失败了也照样算推完了）。主订阅的告诉状态层（109 号票）
    if (frame.id !== null && this.catchUps.delete(frame.id)) {
      if (frame.id === this.mainReceipt) {
        this.mainReceipt = undefined;
        this.deliver?.({ kind: "synced" });
      }
      return;
    }
    if (frame.id !== null && this.watchRequests.delete(frame.id)) {
      if (frame.ok) this.resync(frame);
      return;
    }
    // 只读的查询（124 号票）：结果交回去；被拒的只交给问的那一处，不进状态层
    const query = frame.id === null ? undefined : this.queries.get(frame.id);
    if (query && frame.id !== null) {
      this.queries.delete(frame.id);
      if (frame.ok) return query.resolve(frame.result);
      return query.reject(new Error(frame.error.code === "unknown_method" ? t("app.ws.daemonTooOld", { message: frame.error.message }) : frame.error.message));
    }
    const request = frame.id === null ? undefined : this.outbox.get(frame.id);
    if (!request) return;
    this.outbox.delete(request.id);
    const waiter = this.waiting.get(request.id);
    this.waiting.delete(request.id);
    if (frame.ok) return waiter?.resolve(frame.result);
    if (request.idempotencyKey !== undefined) this.deliver?.({ kind: "request_failed", idempotencyKey: request.idempotencyKey, error: frame.error.message });
    waiter?.reject(new Error(frame.error.message));
  }

  private onSubscribed(frame: ResponseFrame): void {
    if (!frame.ok) {
      if (frame.error.code === "protocol_mismatch") {
        this.stopped = true;
        this.deliver?.({ kind: "connection", status: "outdated" });
      }
      // 其他错误：断开重来
      this.socket?.close();
      return;
    }
    this.online = true;
    this.attempt = 0;
    // 连上过之后再订阅成功的算一次重连（124 号票：Debug 工具集的连接一组）
    if (this.everOnline) this.reconnects += 1;
    this.everOnline = true;
    this.deliver?.({ kind: "connection", status: "online" });
    const webVersion = (frame.result as Partial<SubscribeResult> | undefined)?.webVersion;
    if (webVersion !== undefined) this.deliver?.({ kind: "web_version", version: webVersion });
    this.resync(frame);
    for (const request of this.outbox.values()) this.socket?.send(JSON.stringify(request));
    // 浏览器的样子（147 号票）：守护进程按连接认，新连接上再报一次
    if (this.browser) this.fireAndForget(METHODS.browserStatus, this.browser);
  }

  /**
   * 刚发出订阅（或多订阅），服务端处理它时会补发这几个频道：紧跟着发一个空订阅当回执，它的响应到之前这几个频道上的帧
   * 都是补发的。紧跟着发（不等订阅的响应），服务端两条挨着处理，误当成补发的实时帧最少
   */
  private awaitCatchUp(channels: readonly string[]): string | undefined {
    if (!this.socket) return undefined;
    const id = this.nextId();
    this.catchUps.set(id, channels);
    const params: SubscribeParams = { protocolVersion: FRONTEND_PROTOCOL_VERSION, cursors: {} };
    this.socket.send(JSON.stringify({ id, method: METHODS.subscribe, params } satisfies RequestFrame));
    return id;
  }

  /** 订阅的响应里点名要重新同步的频道：服务端接着会从头补发，先让状态层把它们清掉 */
  private resync(frame: ResponseFrame): void {
    if (!frame.ok) return;
    for (const channel of (frame.result as Partial<SubscribeResult> | undefined)?.resync ?? []) {
      this.cursors[channel] = 0;
      this.deliver?.({ kind: "resync", channel });
    }
  }
}
