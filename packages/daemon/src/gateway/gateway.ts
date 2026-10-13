// 网关（规格第 5、6 节）：两个监听端口，都只监听 127.0.0.1。
// - 本机端口：自动信任，校验 Host 和 Origin（local-origin.ts）；
// - 外网端口：隧道的唯一目标，永远不享受本机信任，每个 HTTP 请求和 WebSocket 握手都要带有效的设备凭证；
//   没有凭证只能拿到页面本身、查"我有没有被信任"、发配对请求（external.ts）。本机信任只看从哪个端口进来，不看来源 IP。
// 两个端口提供同样的东西：
// - Web UI 的静态文件（单文件构建产物 index.html，每次请求重新读，重新构建后不用重启；原样发出，不往页面里塞任何密钥或令牌）；
//   视觉风格的字体在构建产物的 fonts/ 下，按 /fonts/ 提供（fonts.ts，39 号票）；
// - 健康探针 /healthz（LSM 用）：秘书和 Web UI 构建产物的状况，不健康时回 503 并写明原因；
// - /api/access：这个请求被信任吗（本机、已配对设备、都不是）；
// - /api/：别的 HTTP 接口（媒体的分片续传上传、下载，会话历史分页），见 http-api.ts；
// - /ws：每个前端一条 WebSocket，帧分请求、响应、事件三种（共享协议包定义）。服务端定时 ping，
//   一个心跳周期里没回 pong 的连接（半开的：对方已经没了、连接没正常关掉）直接断掉；
//   已配对设备的连接在心跳时复查凭证，被吊销时立即关掉（关闭码 WS_CLOSE_UNPAIRED）。
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import {
  type AccessInfo,
  type CardActionParams,
  type CardActionResult,
  type ConversationId,
  type ConvertTaskParams,
  type ConvertTaskResult,
  type ErrorBody,
  type EventFrame,
  FRONTEND_PROTOCOL_VERSION,
  HTTP_API_PREFIX,
  HTTP_PATHS,
  type InboxActionParams,
  type InboxActionResult,
  isChannel,
  isEphemeralEventType,
  type MarkReadParams,
  type MarkReadResult,
  METHODS,
  type NewProjectParams,
  type NewProjectResult,
  type PairedDevice,
  type ParsedRequest,
  parseRequest,
  type ProjectActionParams,
  type ProjectActionResult,
  type ResetMaintainerParams,
  type ResetMaintainerResult,
  type ResponseFrame,
  type RevokeDeviceParams,
  type RevokeDeviceResult,
  type StartTaskParams,
  type StartTaskResult,
  type UpdateWatchCategoriesParams,
  type UpdateWatchCategoriesResult,
  type SubscribeResult,
  type TaskActionParams,
  type TaskActionResult,
  type TaskBatchActionParams,
  type TaskBatchActionResult,
  type RetryVoiceParams,
  type RetryVoiceResult,
  type SetToolkitParams,
  type SetToolkitResult,
  type CreateReminderParams,
  type CreateReminderResult,
  type ScheduledJobActionParams,
  type ScheduledJobActionResult,
  type RescheduleJobParams,
  type RescheduleJobResult,
  type RunJobNowParams,
  type RunJobNowResult,
  type SetVoiceAnnounceParams,
  type SetVoiceAnnounceResult,
  WS_CLOSE_UNPAIRED,
} from "@ergou/protocol";
import { WebSocket, WebSocketServer } from "ws";
import { firstReplayAfter } from "../conversation/history.ts";
import { type AttachmentLookup, type MessageScope, postUserMessage, type VoiceIntake } from "../conversation/messages.ts";
import type { StreamHub } from "../conversation/stream-hub.ts";
import { RequestRejected } from "../errors.ts";
import type { EphemeralSource } from "../events/ephemeral.ts";
import type { EventStore, NewEvent, StoredEvent } from "../events/event-store.ts";
import { DEVICE_COOKIE, readCookie } from "../pairing/credentials.ts";
import { checkExternalOrigin, clearDeviceCookie, deviceCookie, type DevicePairing, handlePairingRoute } from "./external.ts";
import { FONTS_PREFIX, serveFont } from "./fonts.ts";
import { type HttpApi, sendError, sendJson } from "./http-api.ts";
import { checkLocalRequest } from "./local-origin.ts";

export const LOCAL_HOST = "127.0.0.1";
/** 单帧上限：文本消息足够；图片和文件走 HTTP 上传（09） */
const MAX_FRAME_BYTES = 1024 * 1024;
/** WebSocket 心跳的默认间隔（nginx 的 proxy_read_timeout 比它长得多，隧道上不会因为没流量被掐） */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/** 守护进程其他部分报给 /healthz 的健康状况 */
export interface HealthReport {
  ok: boolean;
  /** 原样放进 /healthz 返回里的细节（比如秘书的状态） */
  details: Record<string, unknown>;
  /** 不健康的原因 */
  reasons: string[];
}

/** 网关交给别的模块处理的请求（不满足时抛 RequestRejected，网关回成错误响应） */
export interface RequestHandlers {
  /** 对卡片做动作（cards/cards.ts） */
  /** 要先等一件事的动作（84 号票：归档清单上"继续"返工，先停稳维护者）结果晚一点才有（Promise） */
  cardAction(params: CardActionParams, idempotencyKey: string): CardActionResult | Promise<CardActionResult>;
  /** 对待我处理事项做动作（inbox/inbox.ts） */
  inboxAction(params: InboxActionParams, idempotencyKey: string): InboxActionResult;
  /** 吊销一台已配对设备（pairing/pairing.ts）；它开着的 WebSocket 由网关随后关掉 */
  revokeDevice(params: RevokeDeviceParams, idempotencyKey: string): RevokeDeviceResult;
  /** 点"发起任务"按钮（tasks/tasks.ts）：直接建出任务（规划中） */
  startTask(params: StartTaskParams, idempotencyKey: string): StartTaskResult;
  /** 设置页改关注类别（watch-categories/）：设置随后在关注类别频道推送 */
  updateWatchCategories(params: UpdateWatchCategoriesParams, idempotencyKey: string): UpdateWatchCategoriesResult;
  /** 用户对任务的控制（tasks/execution.ts，13 号票）：暂停、继续、取消、重试、返工、由我验收的验收通过或退回 */
  /** 从某个阶段重做（84 号票）要先停稳维护者手头这一轮，结果晚一点才有（Promise） */
  taskAction?(params: TaskActionParams, idempotencyKey: string): TaskActionResult | Promise<TaskActionResult>;
  /** 一次对多个任务做同一个控制（tasks/batch.ts，90 号票：看板多选）：各自成败、逐条回报 */
  taskBatchAction?(params: TaskBatchActionParams, idempotencyKey: string): Promise<TaskBatchActionResult>;
  /**
   * 发消息：秘书会话之外的会话（维护者会话）能不能发、消息属于哪个任务或项目（15 号票：项目维护者的会话）。
   * 不认识的会话返回 undefined（这个版本还不能往那里发）；不让发就抛 RequestRejected（比如已归档的项目只读）
   */
  messageScope?(conversation: ConversationId, taskId?: string): MessageScope | undefined;
  /**
   * 用户的消息之前、同一事务先追加的事件（16 号票：项目维护者手上没有在进行的会话段时开一个对话段，分隔线排在这句话之前）。
   * 事件要带由请求的幂等键派生的幂等键（重发不多开一段）
   */
  messagePrelude?(conversation: ConversationId, idempotencyKey: string, taskId?: string): NewEvent[];
  /** 点"新建项目"（projects/projects.ts）：秘书直接收口出"建议立项"卡 */
  newProject(params: NewProjectParams, idempotencyKey: string): NewProjectResult;
  /** 把任务转为项目（projects/projects.ts） */
  convertTaskToProject(params: ConvertTaskParams, idempotencyKey: string): ConvertTaskResult;
  /** 项目页上的动作（projects/projects.ts）：删除只放一条二次确认进待我处理 */
  projectAction(params: ProjectActionParams, idempotencyKey: string): ProjectActionResult;
  /** 项目页上的"重置维护者"（projects/projects.ts，16 号票）：不改项目状态，维护者新开一段会话；不给就不能重置 */
  resetMaintainer?(params: ResetMaintainerParams, idempotencyKey: string): ResetMaintainerResult;
  /** 发消息时收下语音 part（voice/，31 号票）；不给就不能发语音 */
  voiceIntake?: VoiceIntake;
  /** 气泡菜单里的"重新识别"（voice/，31 号票） */
  retryVoice?(params: RetryVoiceParams, idempotencyKey: string): RetryVoiceResult;
  /** 项目页、任务详情里直接改工具包（toolkit/，27 号票）；不给就不能改 */
  setToolkit?(params: SetToolkitParams, idempotencyKey: string): SetToolkitResult;
  /** 看板上对定时触发的任务的动作（scheduled-jobs/，19 号票的定时作业；76 号票）：暂停、恢复、取消 */
  scheduledJobAction?(params: ScheduledJobActionParams, idempotencyKey: string): ScheduledJobActionResult;
  /** 任务操作菜单里的"改时间"（scheduled-jobs/，98 号票）：换定时触发的任务的时间表 */
  rescheduleJob?(params: RescheduleJobParams, idempotencyKey: string): RescheduleJobResult;
  /** 任务操作菜单里的"立即运行一次"（scheduled-jobs/，100 号票）：定时 / 事件触发的任务等同被触发一次，触发记成手动 */
  runJobNow?(params: RunJobNowParams, idempotencyKey: string): RunJobNowResult;
  /** 任务操作菜单里的"跑完自动播报：开 / 关"（tasks/，100 号票） */
  setVoiceAnnounce?(params: SetVoiceAnnounceParams, idempotencyKey: string): SetVoiceAnnounceResult;
  /** 发起对话框里的"只提醒我"（76 号票）：建一条简单提醒 */
  createReminder?(params: CreateReminderParams, idempotencyKey: string): CreateReminderResult;
  /** 记下会话看到哪一条了（conversation/read-marks.ts，109 号票）：秘书页上的已读位置，几台设备同步 */
  markRead?(params: MarkReadParams, idempotencyKey: string): MarkReadResult;
}

export interface GatewayOptions {
  /** 本机端口；0 表示由系统挑一个空闲端口（测试用） */
  port: number;
  /** 外网端口（隧道的目标）；0 表示由系统挑一个空闲端口（测试用） */
  externalPort: number;
  /** 设备配对：外网端口上校验凭证、配对接口、吊销时关连接 */
  pairing: DevicePairing;
  /** WebSocket 心跳的间隔（毫秒），默认 30 秒 */
  heartbeatIntervalMs?: number;
  store: EventStore;
  streams: StreamHub;
  /** 别的临时事件（到点的提醒这类通知），和流式增量一样只推给正连着、订阅了那个频道的前端 */
  notifications: EphemeralSource;
  requests: RequestHandlers;
  /** Web UI 构建产物所在的目录（里面有 index.html） */
  webRoot: string;
  /** 守护进程其他部分的健康状况，合进 /healthz */
  health: () => HealthReport;
  /** /api/ 下的 HTTP 接口（媒体上传下载、历史分页） */
  api: HttpApi;
  /** 发消息时核对附件（媒体库） */
  attachments: AttachmentLookup;
  log: (line: string) => void;
}

export interface Gateway {
  /** 本机端口实际监听的端口 */
  readonly port: number;
  /** 本机地址，如 http://127.0.0.1:8810 */
  readonly url: string;
  /** 外网端口实际监听的端口 */
  readonly externalPort: number;
  /** 外网端口的地址（隧道连这里），如 http://127.0.0.1:8811 */
  readonly externalUrl: string;
  close(): Promise<void>;
}

/** 外网端口上一条 WebSocket 背后的已配对设备：心跳时复查凭证，还有效就算用了一次 */
interface DeviceSession {
  deviceId: string;
  refresh(): boolean;
}

/** 一个请求凭什么被信任：从本机端口进来，或者带着有效凭证的已配对设备 */
type Trust = { kind: "local" } | { kind: "device"; device: PairedDevice };

const pathnameOf = (req: http.IncomingMessage) => new URL(req.url ?? "/", `http://${LOCAL_HOST}`).pathname;
const isPage = (pathname: string) => pathname === "/" || pathname === "/index.html";
/** 拒绝一次 WebSocket 握手 */
const refuse = (socket: Duplex, status: string) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);

export async function startGateway(options: GatewayOptions): Promise<Gateway> {
  const { store, streams, log, pairing } = options;
  const indexFile = path.join(options.webRoot, "index.html");
  const connections = new Set<FrontendConnection>();
  let localPort = options.port;

  const health = (): { status: number; body: Record<string, unknown> } => {
    const webUi = fs.existsSync(indexFile);
    const rest = options.health();
    const reasons = [...rest.reasons, ...(webUi ? [] : ["Web UI 还没构建：在仓库根目录运行 npm run build:web"])];
    const ok = rest.ok && webUi;
    return { status: ok ? 200 : 503, body: { ok, ...rest.details, webUi, reasons } };
  };

  const servePage = (res: http.ServerResponse) => {
    let page: Buffer;
    try {
      page = fs.readFileSync(indexFile);
    } catch {
      return reply(res, 503, "text/plain; charset=utf-8", "Web UI 还没构建：在仓库根目录运行 npm run build:web\n");
    }
    reply(res, 200, "text/html; charset=utf-8", page);
  };

  /** 已经被信任的请求（本机端口，或者外网端口上带着有效凭证的设备） */
  const route = (req: http.IncomingMessage, res: http.ServerResponse, trust: Trust) => {
    const url = new URL(req.url ?? "/", `http://${LOCAL_HOST}`);
    const { pathname } = url;
    if (pathname === HTTP_PATHS.access) {
      const access: AccessInfo = trust.kind === "local" ? { access: "local" } : { access: "device", device: { id: trust.device.id, name: trust.device.name } };
      return sendJson(res, 200, access);
    }
    if (pathname === HTTP_PATHS.pairing) {
      if (trust.kind === "local") {
        req.resume();
        return sendError(res, "not_found", "本机不需要配对");
      }
      return handlePairingRoute(req, res, pairing, log);
    }
    // 媒体上传下载、历史分页（09）
    if (pathname.startsWith(HTTP_API_PREFIX)) return options.api(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") return reply(res, 405, "text/plain; charset=utf-8", "只支持 GET\n");
    if (pathname === "/healthz") {
      const { status, body } = health();
      return reply(res, status, "application/json; charset=utf-8", JSON.stringify(body));
    }
    if (isPage(pathname)) return servePage(res);
    // 视觉风格的字体（39 号票）：构建产物 fonts/ 下的样式表、woff2、许可证
    if (pathname.startsWith(FONTS_PREFIX)) return serveFont(req, res, options.webRoot, pathname);
    return reply(res, 404, "text/plain; charset=utf-8", "没有这个地址\n");
  };

  const local = http.createServer((req, res) => {
    const check = checkLocalRequest(req.headers, localPort);
    if (!check.ok) {
      req.resume();
      return sendError(res, "forbidden", `拒绝：${check.reason}`);
    }
    route(req, res, { kind: "local" });
  });

  // 外网端口：不看来源 IP、不看 Host，只看凭证
  const external = http.createServer((req, res) => {
    const check = checkExternalOrigin(req.headers);
    if (!check.ok) {
      req.resume();
      return sendError(res, "forbidden", `拒绝：${check.reason}`);
    }
    const credential = readCookie(req.headers.cookie, DEVICE_COOKIE);
    const device = pairing.authenticate(credential);
    if (device && credential !== undefined) {
      // 每次使用都续期：浏览器里的 cookie 跟着服务端一起延长
      res.setHeader("Set-Cookie", deviceCookie(credential));
      return route(req, res, { kind: "device", device });
    }
    // 带着失效的凭证（吊销了、过期了）：让浏览器删掉它；查"我有没有被信任"时顺带告诉它为什么不认
    // （页面据此在浏览器里留个"本设备已被吊销"的记号，刷新后不会自动重新申请）
    const rejection = pairing.rejectionOf(credential);
    if (credential !== undefined) res.setHeader("Set-Cookie", clearDeviceCookie());
    const pathname = pathnameOf(req);
    if (pathname === HTTP_PATHS.pairing) return handlePairingRoute(req, res, pairing, log);
    if (pathname === HTTP_PATHS.access) return sendJson(res, 200, { access: "none", ...(rejection === undefined ? {} : { reason: rejection }) } satisfies AccessInfo);
    // 页面本身：前端看到自己没被信任，显示配对等待页
    if (isPage(pathname) && (req.method === "GET" || req.method === "HEAD")) return servePage(res);
    // 别的一律要凭证（健康探针、历史分页、媒体上传下载……）；没读的请求体丢掉
    req.resume();
    return sendError(res, "unauthorized", "这台设备还没配对：在浏览器里打开首页，按提示配对");
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const accept = (req: http.IncomingMessage, socket: Duplex, head: Buffer, deviceId: string | undefined) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      const device: DeviceSession | undefined = deviceId === undefined ? undefined : { deviceId, refresh: () => pairing.refresh(deviceId) };
      const connection = new FrontendConnection(ws, store, options.requests, options.attachments, log, device);
      connections.add(connection);
      ws.on("close", () => connections.delete(connection));
    });
  };
  local.on("upgrade", (req, socket, head) => {
    if (!checkLocalRequest(req.headers, localPort).ok) return refuse(socket, "403 Forbidden");
    if (pathnameOf(req) !== "/ws") return refuse(socket, "404 Not Found");
    accept(req, socket, head, undefined);
  });
  external.on("upgrade", (req, socket, head) => {
    if (!checkExternalOrigin(req.headers).ok) return refuse(socket, "403 Forbidden");
    const device = pairing.authenticate(readCookie(req.headers.cookie, DEVICE_COOKIE));
    if (!device) return refuse(socket, "401 Unauthorized");
    if (pathnameOf(req) !== "/ws") return refuse(socket, "404 Not Found");
    accept(req, socket, head, device.id);
  });

  // 落盘事件和临时事件都推给订阅了那个频道的前端
  const offAppend = store.onAppend((event) => {
    for (const c of connections) c.pushStored(event);
  });
  const offStream = streams.onFrame((frame) => {
    for (const c of connections) c.pushEphemeral(frame);
  });
  const offNotifications = options.notifications.onFrame((frame) => {
    for (const c of connections) c.pushEphemeral(frame);
  });
  // 吊销：这台设备开着的 WebSocket 立即关掉
  const offRevoked = pairing.onRevoked((deviceId) => {
    for (const c of connections) if (c.deviceId === deviceId) c.closeUnpaired("这台设备已被吊销");
  });
  // 心跳：上一轮 ping 没回 pong 的（半开连接）断掉
  const heartbeat = setInterval(() => {
    for (const c of connections) c.heartbeat();
  }, options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  const listening: http.Server[] = [];
  const close = async () => {
    clearInterval(heartbeat);
    offAppend();
    offStream();
    offNotifications();
    offRevoked();
    for (const c of connections) c.terminate();
    wss.close();
    await Promise.all(listening.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  };
  try {
    localPort = await listen(local, options.port);
    listening.push(local);
    local.on("error", (err) => log(`本机端口出错：${err.message}`));
    const externalPort = await listen(external, options.externalPort);
    listening.push(external);
    external.on("error", (err) => log(`外网端口出错：${err.message}`));
    return { port: localPort, url: `http://${LOCAL_HOST}:${localPort}`, externalPort, externalUrl: `http://${LOCAL_HOST}:${externalPort}`, close };
  } catch (err) {
    await close();
    throw err;
  }
}

/** 在 127.0.0.1 上监听，返回实际的端口 */
async function listen(server: http.Server, port: number): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, LOCAL_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}

function reply(res: http.ServerResponse, status: number, contentType: string, body: string | Buffer): void {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
  });
  res.end(res.req.method === "HEAD" ? undefined : body);
}

/**
 * 一个前端的 WebSocket。订阅时补发每个频道缺的落盘事件，之后推送新事件；临时事件只推给正连着的。
 * 存储的接口是同步的（node:sqlite），读补发的事件和登记订阅在同一段同步代码里完成，中间不会插进新事件，
 * 所以补发和实时推送之间不重不漏。
 */
class FrontendConnection {
  /** 订阅的频道 → 已经推给这个前端的最后一个落盘事件序号 */
  private readonly subscriptions = new Map<string, number>();
  private readonly ws: WebSocket;
  private readonly store: EventStore;
  private readonly requests: RequestHandlers;
  private readonly attachments: AttachmentLookup;
  private readonly log: (line: string) => void;
  /** 外网端口上的已配对设备：心跳时复查凭证（吊销了、过期了就关掉），还有效就算用了一次 */
  private readonly device: DeviceSession | undefined;
  /** 上一次 ping 之后收到过 pong */
  private alive = true;

  constructor(
    ws: WebSocket,
    store: EventStore,
    requests: RequestHandlers,
    attachments: AttachmentLookup,
    log: (line: string) => void,
    device?: DeviceSession,
  ) {
    this.ws = ws;
    this.store = store;
    this.requests = requests;
    this.attachments = attachments;
    this.log = log;
    this.device = device;
    ws.on("pong", () => {
      this.alive = true;
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) return this.respond({ id: null, ok: false, error: { code: "bad_frame", message: "只收文本帧" } });
      this.onRequest(String(data));
    });
    ws.on("error", (err) => log(`WebSocket 出错：${err.message}`));
  }

  /** 外网端口上的已配对设备的 id（本机端口的连接没有） */
  get deviceId(): string | undefined {
    return this.device?.deviceId;
  }

  pushStored(event: StoredEvent): void {
    const sent = this.subscriptions.get(event.channel);
    if (sent === undefined || event.seq <= sent) return;
    this.subscriptions.set(event.channel, event.seq);
    this.send({ channel: event.channel, seq: event.seq, type: event.type, payload: event.payload });
  }

  pushEphemeral(frame: EventFrame): void {
    if (this.subscriptions.has(frame.channel) && isEphemeralEventType(frame.type)) this.send(frame);
  }

  terminate(): void {
    this.ws.terminate();
  }

  /** 心跳：上一轮没回 pong 的断掉；已配对设备复查凭证 */
  heartbeat(): void {
    if (!this.alive) return this.terminate();
    if (this.device && !this.device.refresh()) return this.closeUnpaired("这台设备的凭证已失效");
    this.alive = false;
    this.ws.ping();
  }

  /** 凭证失效（吊销、过期）：关掉连接，前端据此回到配对页。先让这一轮已经排着的响应发出去 */
  closeUnpaired(reason: string): void {
    setImmediate(() => {
      this.ws.close(WS_CLOSE_UNPAIRED, reason);
      setTimeout(() => this.ws.terminate(), 1000).unref();
    });
  }

  private onRequest(raw: string): void {
    const parsed = parseRequest(raw);
    if (!parsed.ok) return this.respond({ id: parsed.id, ok: false, error: parsed.error });
    const { request } = parsed;
    try {
      this.dispatch(request);
    } catch (err) {
      this.rejected(request, err);
    }
  }

  /** 回结果；晚一点才有的（Promise：从某个阶段重做要先停稳维护者，84 号票）等到了再回，被拒、出错照常回 */
  private respondWhenDone(request: ParsedRequest, result: unknown): void {
    if (!(result instanceof Promise)) return this.respond({ id: request.id, ok: true, result });
    result.then(
      (done: unknown) => this.respond({ id: request.id, ok: true, result: done }),
      (err: unknown) => this.rejected(request, err),
    );
  }

  /** 请求没办成：被拒的回原因，别的记日志、回"内部出错"（晚一点才有结果的请求同样走这里） */
  private rejected(request: ParsedRequest, err: unknown): void {
    if (err instanceof RequestRejected) return this.fail(request.id, { code: err.code, message: err.message });
    this.log(`处理请求 ${request.method} 出错：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    this.fail(request.id, { code: "internal", message: "守护进程内部出错" });
  }

  private dispatch(request: ParsedRequest): void {
    switch (request.method) {
      case METHODS.subscribe: {
        const { protocolVersion, cursors } = request.params;
        if (protocolVersion !== FRONTEND_PROTOCOL_VERSION) {
          return this.fail(request.id, { code: "protocol_mismatch", message: `前端协议版本 ${protocolVersion}，守护进程是 ${FRONTEND_PROTOCOL_VERSION}：请刷新页面` });
        }
        const unknown = Object.keys(cursors).filter((c) => !isChannel(c));
        if (unknown.length > 0) return this.fail(request.id, { code: "bad_params", message: `没有这些频道：${unknown.join("、")}` });
        // 前端带来的序号比这个频道的最后序号还大（比如数据目录恢复成了旧快照）：让前端清掉这个频道，从头补发
        const resync = Object.entries(cursors)
          .filter(([channel, cursor]) => cursor > this.store.lastSeq(channel))
          .map(([channel]) => channel);
        const result: SubscribeResult = { protocolVersion: FRONTEND_PROTOCOL_VERSION, resync };
        this.respond({ id: request.id, ok: true, result });
        // 补发：每个频道序号大于前端游标的落盘事件；之后的新事件由 pushStored 接着推。
        // 前端手里什么都没有（游标为 0、或者要重新同步）时，会话频道只补发最近一页，更早的经 HTTP 往上翻（09）
        for (const [channel, cursor] of Object.entries(cursors)) {
          const known = resync.includes(channel) ? 0 : Math.max(cursor, this.subscriptions.get(channel) ?? 0);
          const from = known === 0 ? firstReplayAfter(this.store, channel) : known;
          this.subscriptions.set(channel, from);
          for (const event of this.store.read(channel, from)) this.pushStored(event);
        }
        return;
      }
      case METHODS.sendMessage: {
        const result = postUserMessage(
          this.store,
          { ...request.params, idempotencyKey: request.idempotencyKey },
          this.attachments,
          // 在哪个任务的详情里说的（75 号票：项目内部的普通任务做完了接着说）：交给认会话的那几处
          (c) => this.requests.messageScope?.(c, request.params.taskId),
          this.requests.voiceIntake,
          (c) => this.requests.messagePrelude?.(c, request.idempotencyKey, request.params.taskId) ?? [],
        );
        return this.respond({ id: request.id, ok: true, result });
      }
      case METHODS.cardAction:
        return this.respondWhenDone(request, this.requests.cardAction(request.params, request.idempotencyKey));
      case METHODS.inboxAction:
        return this.respond({ id: request.id, ok: true, result: this.requests.inboxAction(request.params, request.idempotencyKey) });
      case METHODS.revokeDevice:
        return this.respond({ id: request.id, ok: true, result: this.requests.revokeDevice(request.params, request.idempotencyKey) });
      case METHODS.startTask:
        return this.respond({ id: request.id, ok: true, result: this.requests.startTask(request.params, request.idempotencyKey) });
      case METHODS.updateWatchCategories:
        return this.respond({ id: request.id, ok: true, result: this.requests.updateWatchCategories(request.params, request.idempotencyKey) });
      case METHODS.newProject:
        return this.respond({ id: request.id, ok: true, result: this.requests.newProject(request.params, request.idempotencyKey) });
      case METHODS.convertTaskToProject:
        return this.respond({ id: request.id, ok: true, result: this.requests.convertTaskToProject(request.params, request.idempotencyKey) });
      case METHODS.projectAction:
        return this.respond({ id: request.id, ok: true, result: this.requests.projectAction(request.params, request.idempotencyKey) });
      case METHODS.resetMaintainer:
        if (!this.requests.resetMaintainer) return this.fail(request.id, { code: "not_implemented", message: "这个版本还不能重置维护者" });
        return this.respond({ id: request.id, ok: true, result: this.requests.resetMaintainer(request.params, request.idempotencyKey) });
      case METHODS.taskAction:
        if (!this.requests.taskAction) return this.fail(request.id, { code: "not_implemented", message: "这个版本还不能控制任务" });
        return this.respondWhenDone(request, this.requests.taskAction(request.params, request.idempotencyKey));
      case METHODS.taskBatchAction:
        if (!this.requests.taskBatchAction) return this.fail(request.id, { code: "not_implemented", message: "这个版本还不能一次处理多个任务" });
        return this.respondWhenDone(request, this.requests.taskBatchAction(request.params, request.idempotencyKey));
      case METHODS.setToolkit:
        if (!this.requests.setToolkit) return this.fail(request.id, { code: "not_implemented", message: "这个版本还不能改工具包" });
        return this.respond({ id: request.id, ok: true, result: this.requests.setToolkit(request.params, request.idempotencyKey) });
      case METHODS.retryVoice:
        if (!this.requests.retryVoice) return this.fail(request.id, { code: "not_implemented", message: "这个版本还不能重新识别语音" });
        return this.respond({ id: request.id, ok: true, result: this.requests.retryVoice(request.params, request.idempotencyKey) });
      case METHODS.scheduledJobAction:
        if (!this.requests.scheduledJobAction) return this.fail(request.id, { code: "not_implemented", message: "这个版本还不能管定时触发的任务" });
        return this.respond({ id: request.id, ok: true, result: this.requests.scheduledJobAction(request.params, request.idempotencyKey) });
      case METHODS.rescheduleJob:
        if (!this.requests.rescheduleJob) return this.fail(request.id, { code: "not_implemented", message: "这个版本还不能改定时任务的时间" });
        return this.respond({ id: request.id, ok: true, result: this.requests.rescheduleJob(request.params, request.idempotencyKey) });
      case METHODS.runJobNow:
        if (!this.requests.runJobNow) return this.fail(request.id, { code: "not_implemented", message: "这个版本还不能让定时任务立即运行一次" });
        return this.respond({ id: request.id, ok: true, result: this.requests.runJobNow(request.params, request.idempotencyKey) });
      case METHODS.setVoiceAnnounce:
        if (!this.requests.setVoiceAnnounce) return this.fail(request.id, { code: "not_implemented", message: "这个版本还不能开关跑完自动播报" });
        return this.respond({ id: request.id, ok: true, result: this.requests.setVoiceAnnounce(request.params, request.idempotencyKey) });
      case METHODS.createReminder:
        if (!this.requests.createReminder) return this.fail(request.id, { code: "not_implemented", message: "这个版本还不能在发起对话框里建提醒" });
        return this.respond({ id: request.id, ok: true, result: this.requests.createReminder(request.params, request.idempotencyKey) });
      case METHODS.markRead:
        if (!this.requests.markRead) return this.fail(request.id, { code: "not_implemented", message: "这个版本还不能记已读位置" });
        return this.respond({ id: request.id, ok: true, result: this.requests.markRead(request.params, request.idempotencyKey) });
    }
  }

  private fail(id: string, error: ErrorBody): void {
    this.respond({ id, ok: false, error });
  }

  private respond(frame: ResponseFrame): void {
    this.send(frame);
  }

  private send(frame: EventFrame | ResponseFrame): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }
}
