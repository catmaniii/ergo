// 连到守护进程的 WebSocket（规格第 5 节）。
// - 连上就发"订阅"：带协议版本和每个频道最后收到的序号，服务端补发缺失的落盘事件，之后推送新的；
// - 收到的事件帧原样交给状态层；游标只按落盘事件推进（临时事件不占序号）；
// - 断线自动重连（间隔逐步拉长），没得到响应的请求在重新订阅之后带同一个幂等键重发，服务端不会做两次；
// - 协议版本对不上就报"页面过旧"，不再重连，等用户刷新；
// - 订阅的响应里点名要重新同步的频道（前端的序号比服务端还大），交给状态层清掉，服务端接着从头补发；
// - 外网端口上（经隧道的已配对设备）：断线后先问一下这台设备还被信任吗（checkAccess）。凭证失效了（被吊销、太久没用）
//   就报 unpaired、不再重连，界面回到配对等待页；问不到（网断了）照常重连。
import type {
  CardActionRequest,
  Connection,
  ConvertTaskRequest,
  InboxActionRequest,
  NewProjectRequest,
  ProjectActionRequest,
  ResetMaintainerRequest,
  RetryVoiceRequest,
  RevokeDeviceRequest,
  SendMessageRequest,
  StartTaskRequest,
  TaskActionRequest,
  UpdateWatchCategoriesRequest,
} from "./connection.ts";
import {
  type AccessInfo,
  type CardActionParams,
  type ConvertTaskParams,
  type EventFrame,
  FRONTEND_PROTOCOL_VERSION,
  type InboxActionParams,
  isEphemeralEventType,
  type Method,
  METHODS,
  type NewProjectParams,
  type ProjectActionParams,
  type ResetMaintainerParams,
  type RequestFrame,
  type ResponseFrame,
  type RetryVoiceParams,
  type RevokeDeviceParams,
  type StartTaskParams,
  type SendMessageParams,
  type SubscribeParams,
  type SubscribeResult,
  type TaskActionParams,
  type UiInput,
} from "../state/index.ts";

/** 浏览器 WebSocket 里用到的那部分（测试换成假的） */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "close" | "error", listener: () => void): void;
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
    const params: SendMessageParams = { conversation: req.conversation, parts: req.parts };
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

  revokeDevice(req: RevokeDeviceRequest): void {
    const params: RevokeDeviceParams = { deviceId: req.deviceId };
    this.request(METHODS.revokeDevice, params, req.idempotencyKey);
  }

  startTask(req: StartTaskRequest): void {
    const params: StartTaskParams = { request: req.request, ...(req.projects.length === 0 ? {} : { projects: req.projects }) };
    this.request(METHODS.startTask, params, req.idempotencyKey);
  }

  updateWatchCategories(req: UpdateWatchCategoriesRequest): void {
    this.request(METHODS.updateWatchCategories, req.params, req.idempotencyKey);
  }

  newProject(req: NewProjectRequest): void {
    const params: NewProjectParams = { request: req.request };
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
    };
    this.request(METHODS.taskAction, params, req.idempotencyKey);
  }

  retryVoice(req: RetryVoiceRequest): void {
    const params: RetryVoiceParams = { voiceId: req.voiceId };
    this.request(METHODS.retryVoice, params, req.idempotencyKey);
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
  }

  private request(method: Method, params: unknown, idempotencyKey: string): void {
    const frame: RequestFrame = { id: this.nextId(), method, params, idempotencyKey };
    this.outbox.set(frame.id, frame);
    if (this.online) this.socket?.send(JSON.stringify(frame));
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
    });
    socket.addEventListener("message", (ev) => {
      if (socket === this.socket) this.onFrame(String(ev.data));
    });
    // 出错之后总会跟着 close，在那里处理
    socket.addEventListener("close", () => {
      if (socket !== this.socket) return;
      this.socket = undefined;
      this.online = false;
      if (this.stopped) return;
      this.deliver?.({ kind: "connection", status: "offline" });
      const check = this.options.checkAccess;
      if (!check) return this.scheduleReconnect();
      check().then(
        (info) => {
          if (this.stopped) return;
          if (info.access !== "none") return this.scheduleReconnect();
          this.stopped = true;
          this.deliver?.({ kind: "connection", status: "unpaired", ...(info.reason === undefined ? {} : { reason: info.reason }) });
        },
        () => {
          if (!this.stopped) this.scheduleReconnect();
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
      if (!this.stopped) this.open();
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
      if (!isEphemeralEventType(frame.type)) this.cursors[frame.channel] = Math.max(this.cursors[frame.channel] ?? 0, frame.seq);
      this.deliver?.({ kind: "frame", frame });
      return;
    }
    if (frame.id !== null && frame.id === this.subscribeId) return this.onSubscribed(frame);
    if (frame.id !== null && this.watchRequests.delete(frame.id)) {
      if (frame.ok) this.resync(frame);
      return;
    }
    const request = frame.id === null ? undefined : this.outbox.get(frame.id);
    if (!request) return;
    this.outbox.delete(request.id);
    if (!frame.ok && request.idempotencyKey !== undefined) this.deliver?.({ kind: "request_failed", idempotencyKey: request.idempotencyKey, error: frame.error.message });
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
    this.deliver?.({ kind: "connection", status: "online" });
    this.resync(frame);
    for (const request of this.outbox.values()) this.socket?.send(JSON.stringify(request));
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
