// 网关（规格第 5、6 节）：两个监听端口，都只监听 127.0.0.1。
// - 本机端口：自动信任，校验 Host 和 Origin（local-origin.ts）；
// - 外网端口：隧道的唯一目标，永远不享受本机信任，每个 HTTP 请求和 WebSocket 握手都要带有效的设备凭证；
//   没有凭证只能拿到页面本身、查"我有没有被信任"、发配对请求（external.ts）。本机信任只看从哪个端口进来，不看来源 IP。
// 两个端口提供同样的东西：
// - Web UI 的静态文件（单文件构建产物 index.html，每次请求重新读，重新构建后不用重启；原样发出，不往页面里塞任何密钥或令牌）；
//   视觉风格的字体在构建产物的 fonts/ 下，按 /fonts/ 提供（fonts.ts，39 号票）；
//   网页是哪一版（116 号票，web-version.ts）：订阅的响应里带着，index.html 换了一版时在活动状态频道上推一条临时的 web_version，
//   GET /api/web-version 现问；开着的页面和自己的对不上就提示刷新；
// - 健康探针 /healthz（LSM 用）：秘书和 Web UI 构建产物的状况，不健康时回 503 并写明原因；启用着的插件没装上算降级
//   （status 是 degraded、写明原因，照旧回 200，126 号票）；
// - /api/access：这个请求被信任吗（本机、已配对设备、都不是）；
// - /api/：别的 HTTP 接口（媒体的分片续传上传、下载，会话历史分页），见 http-api.ts；
// - /apps/<应用名>/…（132 号票，apps/proxy.ts）：按转发登记表把本机服务的页面转发过去（普通请求、流式、WebSocket 升级），
//   鉴权和二狗自己的页面一样（外网端口要设备凭证），没登记的 404；
// - /ws：每个前端一条 WebSocket，帧分请求、响应、事件三种（共享协议包定义）。服务端定时 ping，
//   一个心跳周期里没回 pong 的连接（半开的：对方已经没了、连接没正常关掉）直接断掉；
//   已配对设备的连接在心跳时复查凭证，被吊销时立即关掉（关闭码 WS_CLOSE_UNPAIRED）。
//   浏览侧边栏（147 号票）：连接报的浏览器（browser_status）、回的结果（browser_reply）交给 browsing/browser-links.ts，
//   秘书的网页工具要这台设备办的事（browser_request）只推给报过那个浏览器的连接；连接断了告诉它。
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import {
  type AccessInfo,
  type BrowserRequest,
  CHANNELS,
  EVENT_TYPES,
  type CardActionParams,
  type CardActionResult,
  type ConversationId,
  type ConvertTaskParams,
  type ConvertTaskResult,
  type DeviceBatchActionParams,
  type DeviceBatchActionResult,
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
  type QueuedMessageActionResult,
  type RequestEffectUndoParams,
  type RequestEffectUndoResult,
  type RollbackSessionParams,
  type RollbackSessionResult,
  type SwitchBranchParams,
  type SwitchBranchResult,
  type StopReplyParams,
  type StopReplyResult,
  type MarkReadResult,
  METHODS,
  type NewProjectParams,
  type NewProjectResult,
  type PairedDevice,
  type ParsedRequest,
  parseRequest,
  type ProjectActionParams,
  type ProjectActionResult,
  type ProjectServicesActionParams,
  type ProjectServicesActionResult,
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
  type ReminderActionParams,
  type ReminderActionResult,
  type DaemonInfo,
  type ScheduledJobActionParams,
  type ScheduledJobActionResult,
  type RescheduleJobParams,
  type RescheduleJobResult,
  type RunJobNowParams,
  type RunJobNowResult,
  type SetVoiceAnnounceParams,
  type SetVoiceAnnounceResult,
  type WebVersionEventPayload,
  type WebVersionView,
  WS_CLOSE_UNPAIRED,
  t,
} from "@ergo/protocol";
import { WebSocket, WebSocketServer } from "ws";
import type { AppProxy, AppRequestContext } from "../apps/proxy.ts";
import { type BrowserLinks, type BrowserPeer, browsingOff } from "../browsing/api.ts";
import { firstReplayAfter, replayPins } from "../conversation/history.ts";
import { type AttachmentLookup, type MessageScope, postUserMessage, type VoiceIntake } from "../conversation/messages.ts";
import { removeQueued, reorderQueued } from "../conversation/message-queue.ts";
import type { StreamHub } from "../conversation/stream-hub.ts";
import { RequestRejected } from "../errors.ts";
import type { EphemeralSource } from "../events/ephemeral.ts";
import type { EventStore, NewEvent, StoredEvent } from "../events/event-store.ts";
import { DEVICE_COOKIE, oldCookieClears, readCookieOrOld } from "../pairing/credentials.ts";
import { checkExternalOrigin, clearDeviceCookie, deviceCookie, type DevicePairing, handlePairingRoute, requestSource } from "./external.ts";
import { FONTS_PREFIX, serveFont } from "./fonts.ts";
import { type HttpApi, sendError, sendJson } from "./http-api.ts";
import { checkLocalRequest } from "./local-origin.ts";
import { DEFAULT_WEB_VERSION_POLL_MS, watchWebVersion } from "./web-version.ts";

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
  /**
   * 降级的原因（126 号票：启用着的插件没装上）：服务照常能用，只是有东西没起来。不空时整体状态是 degraded，
   * 原因并进 reasons；HTTP 照旧 200（LSM 的 health 档按状态码判死活，503 会被当成挂了）
   */
  degraded?: string[];
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
  /** 设置里多选的延期、吊销、删除（pairing/pairing.ts，123 号票）；吊销、删除的设备开着的 WebSocket 由网关随后关掉 */
  deviceBatchAction(params: DeviceBatchActionParams, idempotencyKey: string): DeviceBatchActionResult;
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
  /**
   * 项目卡片、项目页上的"启动""关闭"（project-services/，257 号票）：经 LSM 把使用中的项目的服务全部拉起、全部关掉；
   * 做不了的（LSM 没连上、项目不是使用中、没有服务）抛 RequestRejected 说清原因。不给就不能启停
   */
  projectServicesAction?(params: ProjectServicesActionParams, idempotencyKey: string): ProjectServicesActionResult;
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
  /** 看板菜单、提醒卡上的按钮、看板多选（185 号票）：对一条或几条简单提醒取消、归档、删除，各自成败、逐条回报 */
  reminderAction?(params: ReminderActionParams, idempotencyKey: string): ReminderActionResult;
  /** 记下会话看到哪一条了（conversation/read-marks.ts，109 号票）：秘书页上的已读位置，几台设备同步 */
  markRead?(params: MarkReadParams, idempotencyKey: string): MarkReadResult;
  /** 守护进程是哪一版、什么时候起来的、它此刻的时间（124 号票：设置里的关于二狗、Debug 工具集）；只读 */
  daemonInfo?(): DaemonInfo;
  /** 输入框旁的"停止"（144 号票）：停下这个会话的 agent 正在回复的这一轮；不给就不能停 */
  stopReply?(params: StopReplyParams, idempotencyKey: string): StopReplyResult;
  /** 会话回退（150 号票）：缩小视图里点 ↶、确认之后回到某条之前；做完才回响应。不给就不能回退 */
  rollbackSession?(params: RollbackSessionParams, idempotencyKey: string): Promise<RollbackSessionResult>;
  /** 切换分支（151 号票）：展开的 ⑂ 预览上点"切换到这条分支"；做完才回响应。不给就不能切换 */
  switchBranch?(params: SwitchBranchParams, idempotencyKey: string): Promise<SwitchBranchResult>;
  /** 废弃分支详情里一件遗留效果的「申请撤回」（151 号票）：记一笔、调撤销接口。不给就不能申请 */
  requestEffectUndo?(params: RequestEffectUndoParams, idempotencyKey: string): Promise<RequestEffectUndoResult>;
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
  /**
   * 订阅某个频道时补推的临时状态（133 号票：项目列表频道的 project_services，项目的服务现在的样子）：临时事件不补发，
   * 连上、重连时靠它拿到现在的全量；不给就没有
   */
  snapshot?: (channel: string) => EventFrame[];
  requests: RequestHandlers;
  /** Web UI 构建产物所在的目录（里面有 index.html） */
  webRoot: string;
  /** 多久看一眼 index.html 换没换（毫秒，116 号票），默认 2 秒 */
  webVersionPollMs?: number;
  /** 守护进程其他部分的健康状况，合进 /healthz */
  health: () => HealthReport;
  /** /api/ 下的 HTTP 接口（媒体上传下载、历史分页） */
  api: HttpApi;
  /** 发消息时核对附件（媒体库） */
  attachments: AttachmentLookup;
  /** 转发本机服务的页面（132 号票）：/apps/<应用名>/… 交给它（apps/proxy.ts） */
  apps: AppProxy;
  /**
   * 浏览侧边栏（147 号票）：设备报的浏览器、秘书的网页工具转给设备的事；不给就不认 browser_status、browser_reply。
   * 212 号票起是浏览插件的，现取：插件没启用时回 undefined，这两个请求回"内置浏览器插件没启用"
   */
  browsers?: () => BrowserLinks | undefined;
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
/**
 * 转发给本机服务时写明的（132 号票）：浏览器连二狗用的协议（本机端口 http；外网端口按 nginx 覆盖写的 X-Forwarded-Proto，
 * 只在外网端口上信任它，没有就是直连的 http）、来源（外网端口同配对限频，以 X-Real-IP 为准）、哪台设备
 */
const appContext = (req: http.IncomingMessage, trust: Trust): AppRequestContext => {
  if (trust.kind === "local") return { proto: "http", source: req.socket.remoteAddress ?? LOCAL_HOST };
  const proto = req.headers["x-forwarded-proto"];
  return { proto: proto === "https" ? "https" : "http", source: requestSource(req).source, deviceId: trust.device.id };
};
const isPage = (pathname: string) => pathname === "/" || pathname === "/index.html";
/**
 * 这是不是浏览器的一次页面导航（254 号票）：Accept 里有 text/html，或者 Sec-Fetch-Dest 是 document / iframe / frame。
 * 外网端口上没凭证时，这类请求一律给页面（前端显示配对页），不回 JSON 错误——原来只认首页，手机主屏上的快捷方式、
 * 收藏的旧地址（前端用 hash 路由，地址本该是 /#/…）、项目服务的入口链接（/apps/…）都会撞上一个 JSON；
 * 认不出的地址在已信任的请求里也一样给页面（旧书签照样进得了二狗），脚本、程序发的请求（Accept 里没有 text/html、
 * 也没有 Sec-Fetch-Dest）照旧 404 / 401
 */
const isNavigation = (headers: http.IncomingHttpHeaders): boolean => {
  const dest = headers["sec-fetch-dest"];
  if (dest === "document" || dest === "iframe" || dest === "frame") return true;
  const accept = headers.accept;
  return typeof accept === "string" && accept.includes("text/html");
};
/** 拒绝一次 WebSocket 握手 */
const refuse = (socket: Duplex, status: string) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);

export async function startGateway(options: GatewayOptions): Promise<Gateway> {
  const { store, streams, log, pairing } = options;
  const indexFile = path.join(options.webRoot, "index.html");
  const connections = new Set<FrontendConnection>();
  let localPort = options.port;
  // 网页换了一版（116 号票）：推给订阅了活动状态频道的前端（临时事件，序号沿用这个频道最后一条落盘事件的）
  const webVersion = watchWebVersion(indexFile, {
    pollMs: options.webVersionPollMs ?? DEFAULT_WEB_VERSION_POLL_MS,
    onChange: (version) => {
      const payload: WebVersionEventPayload = { version };
      for (const c of connections) c.pushEphemeral({ channel: CHANNELS.activity, seq: store.lastSeq(CHANNELS.activity), type: EVENT_TYPES.webVersion, payload });
    },
  });

  // 整体状态 status：不健康（回 503）是 unhealthy；健康但有降级的原因（启用着的插件没装上，126 号票）是 degraded，照旧回 200；都没有是 ok
  const health = (): { status: number; body: Record<string, unknown> } => {
    const webUi = fs.existsSync(indexFile);
    const rest = options.health();
    const degraded = rest.degraded ?? [];
    const reasons = [...rest.reasons, ...degraded, ...(webUi ? [] : ["Web UI 还没构建：在仓库根目录运行 npm run build:web"])]; // @i18n-ignore log：健康检查的说明（LSM 里看）
    const ok = rest.ok && webUi;
    const status = !ok ? "unhealthy" : degraded.length > 0 ? "degraded" : "ok";
    return { status: ok ? 200 : 503, body: { ok, status, ...rest.details, webUi, reasons } };
  };

  const servePage = (res: http.ServerResponse) => {
    let page: Buffer;
    try {
      page = fs.readFileSync(indexFile);
    } catch {
      return reply(res, 503, "text/plain; charset=utf-8", "Web UI 还没构建：在仓库根目录运行 npm run build:web\n"); // @i18n-ignore log：开发时才见得到
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
        return sendError(res, "not_found", t("gateway.noPairingLocal"));
      }
      return handlePairingRoute(req, res, pairing, log);
    }
    // 网页现在是哪一版（116 号票）：页面切回前台时问一次
    if (pathname === HTTP_PATHS.webVersion) {
      const version = webVersion.current();
      return sendJson(res, 200, (version === undefined ? {} : { version }) satisfies WebVersionView);
    }
    // 媒体上传下载、历史分页（09）
    if (pathname.startsWith(HTTP_API_PREFIX)) return options.api(req, res, url);
    // 转发本机服务的页面（132 号票）：登记过的才转（任何方法都转），没登记的回 404 说明页
    if (options.apps.handles(pathname)) return options.apps.serve(req, res, appContext(req, trust));
    if (req.method !== "GET" && req.method !== "HEAD") return reply(res, 405, "text/plain; charset=utf-8", `${t("gateway.getOnly")}\n`);
    if (pathname === "/healthz") {
      const { status, body } = health();
      return reply(res, status, "application/json; charset=utf-8", JSON.stringify(body));
    }
    if (isPage(pathname)) return servePage(res);
    // 视觉风格的字体（39 号票）：构建产物 fonts/ 下的样式表、woff2、许可证
    if (pathname.startsWith(FONTS_PREFIX)) return serveFont(req, res, options.webRoot, pathname);
    // 认不出的地址（254 号票）：浏览器打开的给页面（旧地址、主屏快捷方式照样进得了二狗，前端按 hash 显示默认页），
    // 脚本、程序发的请求照旧 404
    if (isNavigation(req.headers)) return servePage(res);
    return reply(res, 404, "text/plain; charset=utf-8", `${t("gateway.noSuchPath")}\n`);
  };

  const local = http.createServer((req, res) => {
    const check = checkLocalRequest(req.headers, localPort);
    if (!check.ok) {
      req.resume();
      return sendError(res, "forbidden", t("gateway.refused", { reason: check.reason }));
    }
    route(req, res, { kind: "local" });
  });

  // 外网端口：不看来源 IP、不看 Host，只看凭证
  const external = http.createServer((req, res) => {
    const check = checkExternalOrigin(req.headers);
    if (!check.ok) {
      req.resume();
      return sendError(res, "forbidden", t("gateway.refused", { reason: check.reason }));
    }
    // 312 号票：旧名字的 cookie 也认，回应时写成新名字、把旧的清掉
    const credential = readCookieOrOld(req.headers.cookie, DEVICE_COOKIE);
    const oldClears = oldCookieClears(req.headers.cookie, [DEVICE_COOKIE]);
    const device = pairing.authenticate(credential);
    if (device && credential !== undefined) {
      // 每次使用都续期：浏览器里的 cookie 跟着服务端一起延长（延期到更远的，活到那时）
      res.setHeader("Set-Cookie", [deviceCookie(credential, pairing.cookieMaxAgeMs(device)), ...oldClears]);
      return route(req, res, { kind: "device", device });
    }
    // 带着失效的凭证（吊销了、过期了）：让浏览器删掉它；查"我有没有被信任"时顺带告诉它为什么不认
    // （页面据此在浏览器里留个"本设备已被吊销"的记号，刷新后不会自动重新申请）
    const rejection = pairing.rejectionOf(credential);
    if (credential !== undefined) res.setHeader("Set-Cookie", [clearDeviceCookie(), ...oldClears]);
    const pathname = pathnameOf(req);
    if (pathname === HTTP_PATHS.pairing) return handlePairingRoute(req, res, pairing, log);
    if (pathname === HTTP_PATHS.access) return sendJson(res, 200, { access: "none", ...(rejection === undefined ? {} : { reason: rejection }) } satisfies AccessInfo);
    // 页面本身：前端看到自己没被信任，显示配对等待页（首页以外的地址也给，见 isNavigation）
    if ((req.method === "GET" || req.method === "HEAD") && (isPage(pathname) || isNavigation(req.headers))) return servePage(res);
    // 别的一律要凭证（健康探针、历史分页、媒体上传下载……）；没读的请求体丢掉
    req.resume();
    return sendError(res, "unauthorized", t("gateway.unpaired"));
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const accept = (req: http.IncomingMessage, socket: Duplex, head: Buffer, deviceId: string | undefined) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      const device: DeviceSession | undefined = deviceId === undefined ? undefined : { deviceId, refresh: () => pairing.refresh(deviceId) };
      const connection = new FrontendConnection(ws, store, options.requests, options.attachments, webVersion.current, options.snapshot ?? (() => []), log, device, options.browsers);
      connections.add(connection);
      ws.on("close", () => {
        connections.delete(connection);
        // 它报过的浏览器都当关了，正等着它回的事回"断开了"（147 号票）
        options.browsers?.()?.drop(connection);
      });
    });
  };
  // 握手：/ws 是前端协议；/apps/ 下面的是转发给本机服务的 WebSocket（132 号票），校验和 /ws 一样
  local.on("upgrade", (req, socket, head) => {
    if (!checkLocalRequest(req.headers, localPort).ok) return refuse(socket, "403 Forbidden");
    const pathname = pathnameOf(req);
    if (options.apps.handles(pathname)) return options.apps.upgrade(req, socket, head, appContext(req, { kind: "local" }));
    if (pathname !== "/ws") return refuse(socket, "404 Not Found");
    accept(req, socket, head, undefined);
  });
  external.on("upgrade", (req, socket, head) => {
    if (!checkExternalOrigin(req.headers).ok) return refuse(socket, "403 Forbidden");
    const device = pairing.authenticate(readCookieOrOld(req.headers.cookie, DEVICE_COOKIE));
    if (!device) return refuse(socket, "401 Unauthorized");
    const pathname = pathnameOf(req);
    if (options.apps.handles(pathname)) return options.apps.upgrade(req, socket, head, appContext(req, { kind: "device", device }));
    if (pathname !== "/ws") return refuse(socket, "404 Not Found");
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
  // 吊销：这台设备开着的 WebSocket 立即关掉（连同转发给本机服务的，132 号票）
  const offRevoked = pairing.onRevoked((deviceId) => {
    for (const c of connections) if (c.deviceId === deviceId) c.closeUnpaired(t("gateway.revoked"));
    options.apps.dropDevice(deviceId);
  });
  // 心跳：上一轮 ping 没回 pong 的（半开连接）断掉
  const heartbeat = setInterval(() => {
    for (const c of connections) c.heartbeat();
  }, options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  const listening: http.Server[] = [];
  const close = async () => {
    clearInterval(heartbeat);
    webVersion.close();
    offAppend();
    offStream();
    offNotifications();
    offRevoked();
    for (const c of connections) c.terminate();
    // 转发给本机服务的管道和还在流的响应（132 号票）：不断开的话流式响应会一直挡着端口关不掉
    options.apps.close();
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
class FrontendConnection implements BrowserPeer {
  /** 订阅的频道 → 已经推给这个前端的最后一个落盘事件序号 */
  private readonly subscriptions = new Map<string, number>();
  private readonly ws: WebSocket;
  private readonly store: EventStore;
  private readonly requests: RequestHandlers;
  private readonly attachments: AttachmentLookup;
  /** 网页现在是哪一版（116 号票）：订阅的响应里带上 */
  private readonly webVersion: () => string | undefined;
  /** 订阅某个频道时补推的临时状态（133 号票） */
  private readonly snapshot: (channel: string) => EventFrame[];
  private readonly log: (line: string) => void;
  /** 外网端口上的已配对设备：心跳时复查凭证（吊销了、过期了就关掉），还有效就算用了一次 */
  private readonly device: DeviceSession | undefined;
  /** 浏览侧边栏（147 号票）：这条连接报的浏览器、回的结果交给它（212 号票起现取，浏览插件没启用时是 undefined） */
  private readonly browsers: (() => BrowserLinks | undefined) | undefined;
  /** 上一次 ping 之后收到过 pong */
  private alive = true;

  constructor(
    ws: WebSocket,
    store: EventStore,
    requests: RequestHandlers,
    attachments: AttachmentLookup,
    webVersion: () => string | undefined,
    snapshot: (channel: string) => EventFrame[],
    log: (line: string) => void,
    device?: DeviceSession,
    browsers?: () => BrowserLinks | undefined,
  ) {
    this.ws = ws;
    this.store = store;
    this.requests = requests;
    this.attachments = attachments;
    this.webVersion = webVersion;
    this.snapshot = snapshot;
    this.log = log;
    this.device = device;
    this.browsers = browsers;
    ws.on("pong", () => {
      this.alive = true;
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) return this.respond({ id: null, ok: false, error: { code: "bad_frame", message: t("gateway.textOnly") } });
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

  /** 秘书的网页工具要这台设备办的一件事（147 号票）：秘书会话频道上的临时事件，只推给这条连接（不看订阅、不广播） */
  sendBrowserRequest(request: BrowserRequest): void {
    this.send({ channel: CHANNELS.secretary, seq: this.store.lastSeq(CHANNELS.secretary), type: EVENT_TYPES.browserRequest, payload: request });
  }

  /** 心跳：上一轮没回 pong 的断掉；已配对设备复查凭证 */
  heartbeat(): void {
    if (!this.alive) return this.terminate();
    if (this.device && !this.device.refresh()) return this.closeUnpaired(t("gateway.credentialExpired"));
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
    this.fail(request.id, { code: "internal", message: t("gateway.internal") });
  }

  private dispatch(request: ParsedRequest): void {
    switch (request.method) {
      case METHODS.subscribe: {
        const { protocolVersion, cursors } = request.params;
        if (protocolVersion !== FRONTEND_PROTOCOL_VERSION) {
          return this.fail(request.id, { code: "protocol_mismatch", message: t("gateway.protocolMismatch", { frontend: protocolVersion, daemon: FRONTEND_PROTOCOL_VERSION }) });
        }
        const unknown = Object.keys(cursors).filter((c) => !isChannel(c));
        if (unknown.length > 0) return this.fail(request.id, { code: "bad_params", message: t("gateway.unknownChannels", { channels: unknown.join(t("gateway.listSep")) }) });
        // 前端带来的序号比这个频道的最后序号还大（比如数据目录恢复成了旧快照）：让前端清掉这个频道，从头补发
        const resync = Object.entries(cursors)
          .filter(([channel, cursor]) => cursor > this.store.lastSeq(channel))
          .map(([channel]) => channel);
        // 网页现在是哪一版（116 号票）：连上、重连时页面据此看自己是不是旧的
        const webVersion = this.webVersion();
        const result: SubscribeResult = { protocolVersion: FRONTEND_PROTOCOL_VERSION, resync, ...(webVersion === undefined ? {} : { webVersion }) };
        this.respond({ id: request.id, ok: true, result });
        // 补发：每个频道序号大于前端游标的落盘事件；之后的新事件由 pushStored 接着推。
        // 前端手里什么都没有（游标为 0、或者要重新同步）时，会话频道只补发最近一页，更早的经 HTTP 往上翻（09）
        for (const [channel, cursor] of Object.entries(cursors)) {
          const known = resync.includes(channel) ? 0 : Math.max(cursor, this.subscriptions.get(channel) ?? 0);
          const from = known === 0 ? firstReplayAfter(this.store, channel) : known;
          const replay = this.store.read(channel, from);
          // 只补发了最近一页的，这一页之前有几条要先补发（history.ts 的 replayPins）：会话回退过（150 号票），最新那条 session_branch
          // （前端据此认出哪些在废弃分支上、分叉在哪）；这一页里的消息引用的语音对象最新那一版的事件（179 号票，不然气泡一直"识别中…"）
          const pinned = known === 0 ? replayPins(this.store, channel, from, replay) : [];
          this.subscriptions.set(channel, pinned.length > 0 ? pinned[0]!.seq - 1 : from);
          for (const event of pinned) this.pushStored(event);
          this.subscriptions.set(channel, Math.max(from, this.subscriptions.get(channel) ?? from));
          for (const event of replay) this.pushStored(event);
          // 补发完了再补推这个频道现在的临时状态（序号是补发到的最后一条：前端不会当成迟到的丢掉）
          for (const frame of this.snapshot(channel)) this.pushEphemeral(frame);
        }
        return;
      }
      case METHODS.sendMessage: {
        const result = postUserMessage(
          this.store,
          // 从哪台设备发来的（125 号票：运行时核实用户原话时写明）：本机端口的连接，或者外网端口上的已配对设备
          { ...request.params, idempotencyKey: request.idempotencyKey, sentFrom: this.deviceId === undefined ? { kind: "local" } : { kind: "device", deviceId: this.deviceId } },
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
      case METHODS.deviceBatchAction:
        return this.respond({ id: request.id, ok: true, result: this.requests.deviceBatchAction(request.params, request.idempotencyKey) });
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
      case METHODS.projectServicesAction:
        if (!this.requests.projectServicesAction) return this.fail(request.id, { code: "not_implemented", message: t("gateway.ws.projectServicesAction") });
        return this.respond({ id: request.id, ok: true, result: this.requests.projectServicesAction(request.params, request.idempotencyKey) });
      case METHODS.resetMaintainer:
        if (!this.requests.resetMaintainer) return this.fail(request.id, { code: "not_implemented", message: t("gateway.ws.resetMaintainer") });
        return this.respond({ id: request.id, ok: true, result: this.requests.resetMaintainer(request.params, request.idempotencyKey) });
      case METHODS.taskAction:
        if (!this.requests.taskAction) return this.fail(request.id, { code: "not_implemented", message: t("gateway.ws.taskAction") });
        return this.respondWhenDone(request, this.requests.taskAction(request.params, request.idempotencyKey));
      case METHODS.taskBatchAction:
        if (!this.requests.taskBatchAction) return this.fail(request.id, { code: "not_implemented", message: t("gateway.ws.taskBatchAction") });
        return this.respondWhenDone(request, this.requests.taskBatchAction(request.params, request.idempotencyKey));
      case METHODS.setToolkit:
        if (!this.requests.setToolkit) return this.fail(request.id, { code: "not_implemented", message: t("gateway.ws.setToolkit") });
        return this.respond({ id: request.id, ok: true, result: this.requests.setToolkit(request.params, request.idempotencyKey) });
      case METHODS.retryVoice:
        if (!this.requests.retryVoice) return this.fail(request.id, { code: "not_implemented", message: t("gateway.ws.retryVoice") });
        return this.respond({ id: request.id, ok: true, result: this.requests.retryVoice(request.params, request.idempotencyKey) });
      case METHODS.scheduledJobAction:
        if (!this.requests.scheduledJobAction) return this.fail(request.id, { code: "not_implemented", message: t("gateway.ws.scheduledJobAction") });
        return this.respond({ id: request.id, ok: true, result: this.requests.scheduledJobAction(request.params, request.idempotencyKey) });
      case METHODS.rescheduleJob:
        if (!this.requests.rescheduleJob) return this.fail(request.id, { code: "not_implemented", message: t("gateway.ws.rescheduleJob") });
        return this.respond({ id: request.id, ok: true, result: this.requests.rescheduleJob(request.params, request.idempotencyKey) });
      case METHODS.runJobNow:
        if (!this.requests.runJobNow) return this.fail(request.id, { code: "not_implemented", message: t("gateway.ws.runJobNow") });
        return this.respond({ id: request.id, ok: true, result: this.requests.runJobNow(request.params, request.idempotencyKey) });
      case METHODS.setVoiceAnnounce:
        if (!this.requests.setVoiceAnnounce) return this.fail(request.id, { code: "not_implemented", message: t("gateway.ws.setVoiceAnnounce") });
        return this.respond({ id: request.id, ok: true, result: this.requests.setVoiceAnnounce(request.params, request.idempotencyKey) });
      case METHODS.createReminder:
        if (!this.requests.createReminder) return this.fail(request.id, { code: "not_implemented", message: t("gateway.ws.createReminder") });
        return this.respond({ id: request.id, ok: true, result: this.requests.createReminder(request.params, request.idempotencyKey) });
      case METHODS.reminderAction:
        if (!this.requests.reminderAction) return this.fail(request.id, { code: "not_implemented", message: t("gateway.ws.reminderAction") });
        return this.respond({ id: request.id, ok: true, result: this.requests.reminderAction(request.params, request.idempotencyKey) });
      case METHODS.markRead:
        if (!this.requests.markRead) return this.fail(request.id, { code: "not_implemented", message: t("gateway.ws.markRead") });
        return this.respond({ id: request.id, ok: true, result: this.requests.markRead(request.params, request.idempotencyKey) });
      case METHODS.rollbackSession:
        if (!this.requests.rollbackSession) return this.fail(request.id, { code: "not_implemented", message: t("gateway.ws.rollbackSession") });
        return this.respondWhenDone(request, this.requests.rollbackSession(request.params, request.idempotencyKey));
      case METHODS.switchBranch:
        if (!this.requests.switchBranch) return this.fail(request.id, { code: "not_implemented", message: t("gateway.ws.switchBranch") });
        return this.respondWhenDone(request, this.requests.switchBranch(request.params, request.idempotencyKey));
      case METHODS.requestEffectUndo:
        if (!this.requests.requestEffectUndo) return this.fail(request.id, { code: "not_implemented", message: t("gateway.ws.requestEffectUndo") });
        return this.respondWhenDone(request, this.requests.requestEffectUndo(request.params, request.idempotencyKey));
      case METHODS.stopReply:
        if (!this.requests.stopReply) return this.fail(request.id, { code: "not_implemented", message: t("gateway.ws.stopReply") });
        return this.respond({ id: request.id, ok: true, result: this.requests.stopReply(request.params, request.idempotencyKey) });
      case METHODS.queuedMessageAction: {
        // 聊天区里排队的消息（144 号票）：叉掉一条、拖完换个顺序，都只动这个会话的队列（message-queue.ts）
        const { params } = request;
        const result: QueuedMessageActionResult =
          params.action === "remove"
            ? removeQueued(this.store, params.conversation, params.messageId, request.idempotencyKey)
            : reorderQueued(this.store, params.conversation, params.messageIds, request.idempotencyKey);
        return this.respond({ id: request.id, ok: true, result });
      }
      case METHODS.browserStatus: {
        if (!this.browsers) return this.fail(request.id, { code: "not_implemented", message: t("gateway.ws.browsers") });
        const links = this.browsers();
        if (!links) return this.fail(request.id, { code: "not_allowed", message: browsingOff() });
        links.report(this, request.params);
        return this.respond({ id: request.id, ok: true, result: {} });
      }
      case METHODS.browserReply: {
        if (!this.browsers) return this.fail(request.id, { code: "not_implemented", message: t("gateway.ws.browsers") });
        const links = this.browsers();
        if (!links) return this.fail(request.id, { code: "not_allowed", message: browsingOff() });
        links.reply(this, request.params);
        return this.respond({ id: request.id, ok: true, result: {} });
      }
      case METHODS.daemonInfo:
        if (!this.requests.daemonInfo) return this.fail(request.id, { code: "not_implemented", message: t("gateway.ws.daemonInfo") });
        return this.respond({ id: request.id, ok: true, result: this.requests.daemonInfo() });
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
