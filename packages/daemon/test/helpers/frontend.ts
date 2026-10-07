// 主切面的模拟前端：经 WebSocket 连上测试守护进程的本机端口，像 Web UI 一样订阅、发请求、收事件。
// 按到达顺序记下收到的每一帧，测试按顺序等待其中某一类；也能把收到的事件流录成前端状态层的输入，
// 供 Web 包的回放测试使用（见 recording.ts）。
import { randomUUID } from "node:crypto";
import {
  type CardActionParams,
  CHANNELS,
  type ConversationId,
  type EventFrame,
  FRONTEND_PROTOCOL_VERSION,
  type InboxActionParams,
  isEphemeralEventType,
  type MessagePart,
  METHODS,
  type Method,
  nowIso,
  type ResponseFrame,
  type SendMessageResult,
  type SubscribeResult,
} from "@ergou/protocol";
import { onTestFinished } from "vitest";
import { WebSocket } from "ws";
// 录下来的就是 Web 前端状态层的输入：类型直接取自 Web 包，两边不会走样
import type { UiInput } from "../../../web/src/state/index.ts";

/** 录下来的前端状态层输入 */
export type RecordedInput = UiInput;

export interface ConnectOptions {
  /** 浏览器带的 Origin；不填就不带（不是浏览器的程序不带） */
  origin?: string;
  /** 覆盖 Host 头（测 DNS 重绑定） */
  host?: string;
}

/** 收到的一帧，带收到时的时间（毫秒） */
type Received = { kind: "event"; frame: EventFrame; at: number } | { kind: "response"; frame: ResponseFrame; at: number };

/** 一个模拟前端（一个浏览器窗口）。断开后可以 reconnect，收到的东西接着往后记。 */
export class TestFrontend {
  readonly received: Received[] = [];
  /** 录下来的状态层输入（含断线前后的全部） */
  readonly recording: RecordedInput[] = [];
  private socket: WebSocket | undefined;
  private cursor = 0;
  private waiters: Array<() => void> = [];
  private requestNo = 0;
  /** 发出去、带幂等键的请求：响应失败时录成 request_failed */
  private readonly keyOfRequest = new Map<string, string>();
  /** 还没收到响应的订阅请求 */
  private readonly subscribeIds = new Set<string>();
  /** 每个频道最后收到的落盘事件序号（重新同步时归零） */
  private readonly lastSeqs: Record<string, number> = {};

  private wsUrl: string;
  private readonly options: ConnectOptions;

  private constructor(wsUrl: string, options: ConnectOptions) {
    this.wsUrl = wsUrl;
    this.options = options;
  }

  /** 连上（失败时抛错，比如被拒的握手）；测试结束时自动断开 */
  static async connect(baseUrl: string, options: ConnectOptions = {}): Promise<TestFrontend> {
    const frontend = new TestFrontend(socketUrl(baseUrl), options);
    await frontend.open();
    onTestFinished(() => frontend.close());
    return frontend;
  }

  /** 每个频道最后收到的序号（只算落盘事件，临时事件不推进序号；服务端要求重新同步的频道归零） */
  get cursors(): Record<string, number> {
    return { ...this.lastSeqs };
  }

  /**
   * 订阅：带上每个频道最后收到的序号（握手兼订阅）。
   * 和 Web 的连接一样，收到订阅的响应时录一条连接状态（"在线"，或者协议版本不对时"页面过旧"），
   * 响应里点名要重新同步的频道，各录一条 resync 并把游标归零。
   */
  async subscribe(cursors: Record<string, number>, protocolVersion = FRONTEND_PROTOCOL_VERSION): Promise<ResponseFrame> {
    return this.request(METHODS.subscribe, { protocolVersion, cursors });
  }

  /** 往会话里发一条文本消息（幂等键不填就新生成一个），等响应 */
  async sendText(text: string, options: { conversation?: ConversationId; idempotencyKey?: string } = {}): Promise<SendMessageResult & { idempotencyKey: string }> {
    const idempotencyKey = options.idempotencyKey ?? randomUUID();
    const conversation = options.conversation ?? CHANNELS.secretary;
    const parts: MessagePart[] = [{ type: "text", text }];
    this.recording.push({ kind: "send_message", conversation, idempotencyKey, parts, time: nowIso() });
    const response = await this.request(METHODS.sendMessage, { conversation, parts }, idempotencyKey);
    if (!response.ok) throw new Error(`发消息失败：${response.error.code} ${response.error.message}`);
    return { ...(response.result as SendMessageResult), idempotencyKey };
  }

  /**
   * 发一条消息，紧接着断开（请求已经送出，但还没收到任何事件和响应）：
   * 模拟"刚发出去网就断了"，重连后由补发的事件替换乐观显示的那条。
   */
  async sendTextThenDrop(text: string, idempotencyKey: string = randomUUID()): Promise<void> {
    const parts: MessagePart[] = [{ type: "text", text }];
    this.recording.push({ kind: "send_message", conversation: CHANNELS.secretary, idempotencyKey, parts, time: nowIso() });
    this.sendRaw(JSON.stringify({ id: `req-${++this.requestNo}`, method: METHODS.sendMessage, params: { conversation: CHANNELS.secretary, parts }, idempotencyKey }));
    await this.disconnect({ graceful: true });
  }

  /**
   * 点卡片上的按钮（"对卡片做动作"），等响应。和 Web 一样先录一条本地动作（界面上先显示"处理中"）。
   * 幂等键不填就新生成一个。
   */
  async cardAction(params: CardActionParams, idempotencyKey: string = randomUUID()): Promise<ResponseFrame> {
    this.recording.push({ kind: "card_action", cardId: params.cardId, action: params.action, idempotencyKey });
    return this.request(METHODS.cardAction, params, idempotencyKey);
  }

  /** 对待我处理事项做动作（标已读、归档、删除、处理通知），等响应 */
  async inboxAction(params: InboxActionParams, idempotencyKey: string = randomUUID()): Promise<ResponseFrame> {
    return this.request(METHODS.inboxAction, params, idempotencyKey);
  }

  /** 发一个请求，等同一 id 的响应（method 可以是不存在的方法名，测错误响应） */
  async request(method: Method | (string & {}), params: unknown, idempotencyKey?: string): Promise<ResponseFrame> {
    const id = `req-${++this.requestNo}`;
    if (idempotencyKey !== undefined) this.keyOfRequest.set(id, idempotencyKey);
    if (method === METHODS.subscribe) this.subscribeIds.add(id);
    this.sendRaw(JSON.stringify({ id, method, params, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) }));
    return this.waitFor((r): r is Extract<Received, { kind: "response" }> => r.kind === "response" && r.frame.id === id, `请求 ${method} 的响应`, { fromStart: true }).then((r) => r.frame);
  }

  /** 原样发一帧（测格式不对的请求） */
  sendRaw(text: string): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("连接没开着");
    this.socket.send(text);
  }

  /** 下一个响应帧（从上一次 next 命中的位置往后找） */
  async nextResponse(timeoutMs?: number): Promise<ResponseFrame> {
    return (await this.waitFor((r): r is Extract<Received, { kind: "response" }> => r.kind === "response", "响应", { timeoutMs })).frame;
  }

  /**
   * 等下一个事件帧（从上一次 next 命中的位置往后找；中间不匹配的跳过）。
   * 连续调用就能断言事件的先后顺序。
   */
  async next(channel: string, type: string, timeoutMs?: number): Promise<EventFrame> {
    return (
      await this.waitFor(
        (r): r is Extract<Received, { kind: "event" }> => r.kind === "event" && r.frame.channel === channel && r.frame.type === type,
        `${channel} 上的 ${type}`,
        { timeoutMs },
      )
    ).frame;
  }

  /** 到目前为止收到的事件帧（可按频道、类型过滤） */
  events(filter: { channel?: string; type?: string; persistedOnly?: boolean } = {}): EventFrame[] {
    return this.received
      .filter((r): r is Extract<Received, { kind: "event" }> => r.kind === "event")
      .map((r) => r.frame)
      .filter((f) => (filter.channel === undefined || f.channel === filter.channel) && (filter.type === undefined || f.type === filter.type))
      .filter((f) => !filter.persistedOnly || !isEphemeralEventType(f.type));
  }

  /** 到目前为止收到的事件帧，连同收到的时间（毫秒） */
  timedEvents(filter: { channel?: string; type?: string } = {}): Array<{ frame: EventFrame; at: number }> {
    return this.received
      .filter((r): r is Extract<Received, { kind: "event" }> => r.kind === "event")
      .filter((r) => (filter.channel === undefined || r.frame.channel === filter.channel) && (filter.type === undefined || r.frame.type === filter.type))
      .map((r) => ({ frame: r.frame, at: r.at }));
  }

  /**
   * 断网：之后这条连接上再到的帧一概不收（和 Web 的连接一样），录一条"断开"；之后可以 reconnect。
   * 默认直接掐断；graceful 时先把已经发出的帧送完再关。
   */
  disconnect(options: { graceful?: boolean } = {}): Promise<void> {
    if (this.socket) this.recording.push({ kind: "connection", status: "offline" });
    return this.dropSocket(options.graceful ?? false);
  }

  /**
   * 重新连上，并带上每个频道最后收到的序号订阅（前端重连的标准动作）。
   * 守护进程重启后端口变了（测试里端口由系统挑）时，给出新的地址。
   */
  async reconnect(channels: string[] = [CHANNELS.secretary], baseUrl?: string): Promise<ResponseFrame> {
    await this.disconnect();
    if (baseUrl !== undefined) this.wsUrl = socketUrl(baseUrl);
    await this.open();
    const cursors = this.cursors;
    return this.subscribe(Object.fromEntries(channels.map((c) => [c, cursors[c] ?? 0])));
  }

  /** 测试结束时关掉（不录"断开"） */
  close(): Promise<void> {
    return this.dropSocket(false);
  }

  private dropSocket(graceful: boolean): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    if (!socket || socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      socket.once("close", () => resolve());
      if (!graceful) return socket.terminate();
      socket.close();
      // 对方迟迟不回关闭帧就掐断
      setTimeout(() => socket.terminate(), 2000).unref();
    });
  }

  private open(): Promise<void> {
    const headers: Record<string, string> = {};
    if (this.options.host !== undefined) headers.host = this.options.host;
    const socket = new WebSocket(this.wsUrl, { ...(this.options.origin === undefined ? {} : { origin: this.options.origin }), headers });
    // 断开之后（this.socket 换了）这条连接上再到的帧不收
    socket.on("message", (data) => {
      if (socket === this.socket) this.onFrame(String(data));
    });
    return new Promise((resolve, reject) => {
      socket.once("open", () => {
        this.socket = socket;
        resolve();
      });
      socket.once("unexpected-response", (_req, res) => reject(new Error(`握手被拒：HTTP ${res.statusCode}`)));
      socket.once("error", reject);
    });
  }

  private onFrame(text: string): void {
    const frame = JSON.parse(text) as EventFrame | ResponseFrame;
    const at = Date.now();
    if ("channel" in frame) {
      this.received.push({ kind: "event", frame, at });
      this.recording.push({ kind: "frame", frame });
      if (!isEphemeralEventType(frame.type)) this.lastSeqs[frame.channel] = Math.max(this.lastSeqs[frame.channel] ?? 0, frame.seq);
    } else {
      this.received.push({ kind: "response", frame, at });
      const key = frame.id === null ? undefined : this.keyOfRequest.get(frame.id);
      if (!frame.ok && key !== undefined) this.recording.push({ kind: "request_failed", idempotencyKey: key, error: frame.error.message });
      if (frame.id !== null && this.subscribeIds.delete(frame.id)) {
        if (frame.ok) {
          this.recording.push({ kind: "connection", status: "online" });
          for (const channel of (frame.result as SubscribeResult).resync) {
            this.lastSeqs[channel] = 0;
            this.recording.push({ kind: "resync", channel });
          }
        } else if (frame.error.code === "protocol_mismatch") this.recording.push({ kind: "connection", status: "outdated" });
      }
    }
    for (const wake of this.waiters.splice(0)) wake();
  }

  private async waitFor<T extends Received>(
    match: (r: Received) => r is T,
    what: string,
    options: { timeoutMs?: number; fromStart?: boolean } = {},
  ): Promise<T> {
    const deadline = Date.now() + (options.timeoutMs ?? 20_000);
    for (;;) {
      const start = options.fromStart ? 0 : this.cursor;
      for (let i = start; i < this.received.length; i++) {
        const r = this.received[i]!;
        if (match(r)) {
          if (!options.fromStart) this.cursor = i + 1;
          return r;
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        const seen = this.received.slice(this.cursor).map((r) => (r.kind === "event" ? `${r.frame.channel}#${r.frame.seq}:${r.frame.type}` : `response:${r.frame.id}`));
        throw new Error(`等${what}超时；之后收到的：${JSON.stringify(seen)}`);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}

function socketUrl(baseUrl: string): string {
  return `${baseUrl.replace(/^http/, "ws")}/ws`;
}
