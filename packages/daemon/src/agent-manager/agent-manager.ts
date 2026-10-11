// agent 管家（规格第 3 节）：拉起 agent 子进程，替它装配会话参数、显式注入环境、放进 Job 对象；
// 资源限制（12 号票）：
// - 同时存活的子进程有上限（默认 8）。满了以后新的唤起不报错，而是排队，名额空出时按先后拉起；排队期间活动状态是"排队"。
//   常驻的 agent（秘书）占一个预留的名额：它意外退出、等着重新拉起时，这个名额也不让给别人；
// - 非常驻的 agent（维护者）闲置到设定时间（默认 10 分钟）就让子进程正常退出；再来输入时由拉起它的模块重新唤起、接着原会话；
// - 单次模型调用（默认 5 分钟）和单次工具调用（默认 10 分钟，工具可以声明更长）超时：送"中止"，这一轮以出错结束，
//   错误里写明是哪种超时（拉起它的模块据此在会话里说明）；中止之后还不结束就结束子进程；
// - 孤儿进程按周期（默认每分钟）回收（orphans.ts，只在 Windows 上有 Job 对象）。
// 活动状态（规格术语"活动状态"，12、25 号票）每次变化交给 onActivity（守护进程把它记成活动状态频道上的事件）：
// - 排队：名额满了，在等；
// - 干活中：被唤起（拉起了、还没交来输入），处理一条输入；
// - 等你：这一轮里有调用在等用户（审批，守卫接入经 userWaitStarted / userWaitEnded 报来）；
//   这一轮结束以后还有待处理的审批卡、提问卡的"等你"由活动状态模块按卡片推出（activity/activity.ts），不在这里；
// - 休眠：闲着（按需的写"空闲"：子进程还在，没有输入）、闲置退出、别的退出；常驻的（秘书）闲着就是休眠。
// 刚就绪、还没交来输入的按需 agent 先算被唤起，过 READY_HOLD_MS 还没有输入才算空闲（免得唤起时先报一下空闲）。
// 干活中此刻在做什么（思考、写回复、调用某个工具）经 onProgress 报（守护进程节流成临时事件）。
// 说明是带种类的结构化数据（共享协议包的 ActivityDetail），不带用户的原话和工具参数（活动状态事件落盘，彻底删除不改写它）。
// 每次可能变了就报，去重在接收方（活动状态模块）做。
// 用量（24 号票）：子进程每次模型调用报一条 usage，连同拉起时给的归属（ledger，现取）交给 onUsage（守护进程交给 token 账本）。
import fs from "node:fs";
import path from "node:path";
import { type ActivityDetail, type ActivityState, modelKeyOf } from "@ergou/protocol";
import type { DataDirLayout } from "../config/data-dir.ts";
import { modelConfigKey } from "../config/model-key.ts";
import { BUILTIN_TOOL_REGISTRY } from "../guard/index.ts";
import { buildChildEnv, OFFLINE_SHELL_ENV } from "../process/child-env.ts";
import { AGENT_BROWSER_ENV } from "../web/index.ts";
import type { AgentUsage, UsageAttribution } from "../ledger/index.ts";
import type { JobObject } from "../process/job-object.ts";
import {
  type AgentExit,
  type AgentProcess,
  type AgentReport,
  type HostCommand,
  type HostToolSpec,
  type InterruptedToolResult,
  type ModelSpec,
  type ModelProbeRequest,
  type ModelProbeResult,
  runModelProbe,
  runSessionRewrite,
  type ScopeReviewSetup,
  type SessionRewriteRequest,
  type SessionRewriteResult,
  spawnAgentProcess,
} from "../runtime/index.ts";
import { sweepOrphans } from "./orphans.ts";

export interface SpawnAgentRequest {
  /** agent 的标识，也是它在会话区里的子目录名 */
  agentId: string;
  /** 新开的会话用的模型（73 号票：接着已有的会话时子进程照会话开始时的，见宿主协议的 model） */
  model: ModelSpec;
  /**
   * 配置里写明的看图能力（79 号票，见宿主协议的 vision）：键是「provider/模型 id」（faux 是 faux）；不在表里的按模型目录，
   * 实际生效的由子进程在 ready 里报回
   */
  vision?: Readonly<Record<string, boolean>>;
  /**
   * 工具白名单（pi 的内置工具）。70 号票起照给，联网开关不再去掉 grep、find：pi 第一次用它们时找 rg、fd
   * （先找 pi 的 bin 目录、再找 PATH），找不到也不下载——子进程的环境固定带 PI_OFFLINE=1（process/child-env.ts）
   */
  tools: string[];
  /** 守护进程代为执行的工具（调用由拉起它的模块处理 host_tool_call、回 host_tool_result） */
  hostTools?: HostToolSpec[];
  /** 声明了更长超时的工具：工具名 → 单次调用的超时（毫秒）；只有管家看，不交给子进程（host-tools.ts 的 hostToolTimeouts） */
  toolTimeouts?: Readonly<Record<string, number>>;
  /** 代为执行的工具的中文名：工具名 → 中文名；只有管家看（活动状态里"调用：提交计划"），内置工具的取守卫的工具注册表 */
  toolTitles?: Readonly<Record<string, string>>;
  /** 工作目录；不填时用临时区下的 agents/<agentId> */
  cwd?: string;
  /** provider id → API key */
  credentials?: Record<string, string>;
  skillPaths?: string[];
  /** 固定的系统提示（替换 pi 默认的编程助手提示） */
  systemPrompt?: string;
  /** 接着会话目录里最近的会话（秘书的长期主线会话、维护者闲置退出后再唤起）；默认每次新开 */
  continueSession?: boolean;
  /**
   * 接会话目录里这个名字的会话（16 号票：项目维护者的会话分段，每段一个，接哪一段明确指定，不靠修改时间）：
   * 还没有时选了 continueSession 就接着最近的那个，否则新开、用这个名字存（宿主协议的 session，会话怎么存由子进程定）
   */
  session?: string;
  /** 显式给子进程的额外环境变量 */
  env?: Record<string, string>;
  /**
   * 只给 bash 起的进程另加的环境变量（77 号票：事件触发的流程这次运行的事件的值）：并进宿主协议的 shellEnv（联网关着时的无效代理、浏览器路径之外）
   */
  shellEnv?: Readonly<Record<string, string>>;
  /**
   * 每次工具调用先送守护进程做守卫判定。正式的会话都要打开（07 号票起），并用 GuardRuntime.attach 接上守卫；
   * 默认关只为测试里直接拉起、自己回判定的 agent
   */
  forwardToolCalls?: boolean;
  /**
   * 工具包的联网开关。关着（默认）时，bash 起的进程环境里代理地址设成无效值（OFFLINE_SHELL_ENV），让常见的联网方式失败；
   * 守卫另按开关拒绝联网的工具和命令。70 号票起秘书是开着的
   */
  network?: boolean;
  /** 常驻（秘书）：不闲置退出，占一个预留的名额，不排队 */
  resident?: boolean;
  heartbeatIntervalMs?: number;
  /** 重注入块（13 号票）：拉起后第一条输入之前作为上下文消息加进会话，压缩之后再注入最新的（见宿主协议的 contextBlock） */
  contextBlock?: string;
  /** 自定义的压缩指令（22 号票：秘书专用的那一份）：自动和手动压缩写摘要都按它（见宿主协议的 compactionInstructions） */
  compactionInstructions?: string;
  /**
   * 用量记在谁名下（24 号票）：每次模型调用的用量上来时现取（归属会变，比如项目维护者执行任务的工单时记在任务名下）。
   * 拉起 agent 的模块都要给（子 agent 带上它被派去的阶段 stageId）；不给的记成"未归属"（消耗页单列，账本的日志里提醒）
   */
  ledger?: () => UsageAttribution;
  /**
   * 被中断的工具调用补上的结果（23 号票）：接着会话时，会话文件里最后一个回合还没有结果的工具调用按 id 取这里的说法
   * （见宿主协议的 interruptedToolResults）。管家另按 AgentManagerOptions.interruptedToolResults 补上守护进程知道的
   */
  interruptedToolResults?: Record<string, InterruptedToolResult>;
  /**
   * 范围审视（18 号票，维护者才有）：审视用的模型、审视的说明、对照物、近期范围记录（见宿主协议的 scopeReview）。
   * 审视那次调用的用量记账时的模型是这里的 model（审视在做时不闲置退出由拉起它的模块用 holdAwake 拿着）
   */
  scopeReview?: ScopeReviewSetup;
  /**
   * 换模型就新开会话（83 号票，见宿主协议的 handoff）：接着的会话开始时的模型和 model 不一样时，先用原来的模型照这份写法写交接摘要、
   * 再新开会话。写摘要那次最多等多久由管家按单次模型调用的超时给
   */
  handoff?: { instructions: string };
}

/** 资源限制（配置里的 agents，见 config.ts） */
export interface AgentLimits {
  /** 同时存活的子进程最多几个 */
  maxLive: number;
  /** 非常驻的 agent 闲置多久退出（毫秒） */
  idleMs: number;
  /** 单次模型调用超时（毫秒） */
  modelCallMs: number;
  /** 单次工具调用的默认超时（毫秒）；工具可以声明更长（SpawnAgentRequest.toolTimeouts） */
  toolCallMs: number;
  /** 多久回收一次孤儿进程（毫秒） */
  orphanSweepMs: number;
}

export const DEFAULT_AGENT_LIMITS: Readonly<AgentLimits> = Object.freeze({
  maxLive: 8,
  idleMs: 10 * 60_000,
  modelCallMs: 5 * 60_000,
  toolCallMs: 10 * 60_000,
  orphanSweepMs: 60_000,
});

/** 一个 agent 在管家这里的状态：排队、拉起中（还没就绪）、在运行（闲着或在一轮里）、闲置退出中、已退出 */
export type ManagedAgentState = "queued" | "starting" | "running" | "exiting" | "exited";

/**
 * 子进程为什么退出：闲置退出、被结束（拉起它的模块结束它或者送 exit 让它退出、守护进程停止）、
 * 超时中止后还不结束被结束、排队时就被取消（没拉起过）、自己退出了（崩溃）
 */
export type ManagedExitReason = "idle" | "killed" | "unresponsive" | "cancelled" | "unexpected";

export type ManagedExit = AgentExit & { reason: ManagedExitReason };

/** 守卫接入、宿主工具这些只要收发消息、知道它什么时候退出的模块看到的样子 */
export interface AgentLink {
  readonly agentId: string;
  send(command: Exclude<HostCommand, { type: "start" }>): void;
  onReport(listener: (report: AgentReport) => void): () => void;
  readonly exited: Promise<AgentExit>;
}

/** 管家交出的 agent 句柄：可能还在排队（这时没有 pid，不能送命令，但可以先登记监听） */
export interface ManagedAgent extends AgentLink {
  readonly state: ManagedAgentState;
  /** 子进程的 pid；排队时没有 */
  readonly pid: number | undefined;
  /** 只在"在运行"（就绪之后）时能送；拉起中、排队、退出中、已退出时送会抛错 */
  send(command: Exclude<HostCommand, { type: "start" }>): void;
  readonly exited: Promise<ManagedExit>;
  /** 结束子进程（排队中的直接取消） */
  kill(): void;
  /**
   * 拉起它的模块在等子进程做一件不是回合的事（范围审视，18 号票：结果要在子进程退出之前交回来）：拿着时不闲置退出；
   * 返回放开的函数，都放开了、又没有回合在进行时重新计时
   */
  holdAwake(key: string): () => void;
}

/**
 * 子进程里一件在等用户的事（审批：调用停着等批准）开始、结束（守卫接入报来，25 号票）。key 区分同时在等的几件事。
 * 等着的时候活动状态是"等你"，说明是 detail；这一轮结束、子进程退出时一并清掉
 */
export interface UserWaits {
  userWaitStarted(agentId: string, key: string, detail: ActivityDetail): void;
  userWaitEnded(agentId: string, key: string): void;
}

export interface AgentManager extends UserWaits {
  /** 唤起一个 agent：有名额就立即拉起，满了就排队（不报错），名额空出时按先后拉起 */
  spawn(request: SpawnAgentRequest): ManagedAgent;
  /**
   * 改写某个 agent 会话目录里的会话文件（彻底删除，21 号票）：一次性子进程做，会话文件的形状只在子进程那一层认。
   * 这个 agent 的子进程还活着（或在排队）时拒绝（内存里还有原文，调用方先停掉它，改完再拉起）
   */
  rewriteSessions(agentId: string, request: Omit<SessionRewriteRequest, "sessionDir">): Promise<SessionRewriteResult>;
  /**
   * 模型探查（设置里的"模型"，73 号票）：列出模型目录里某个服务商的模型、连通测试。一次性子进程做（模型目录只有子进程查得到），
   * 不占 agent 的名额；子进程出错、超时抛错
   */
  probeModels(request: ModelProbeRequest): Promise<ModelProbeResult>;
  /** 现在活着的子进程 */
  live(): Array<{ agentId: string; pid: number }>;
  /** 结束所有还活着的子进程（排队的取消），等它们退出 */
  shutdown(): Promise<void>;
}

export interface AgentManagerOptions {
  layout: DataDirLayout;
  /** 守护进程自己的环境：只从中挑系统变量给子进程 */
  parentEnv: Readonly<Record<string, string | undefined>>;
  job: JobObject | undefined;
  limits?: Partial<AgentLimits>;
  /** 某个 agent 的活动状态可能变了（同样的也会再报：去重在接收方） */
  onActivity?: (agentId: string, state: ActivityState, detail?: ActivityDetail) => void;
  /** 干活中的 agent 此刻在做什么（思考、写回复、调用某个工具）；变得很频繁，由接收方节流 */
  onProgress?: (agentId: string, detail: ActivityDetail) => void;
  /** 一次模型调用的用量（子进程报的 usage，加上会话和归属） */
  onUsage?: (usage: AgentUsage) => void;
  /**
   * 被杀后的恢复（23 号票）：接着会话拉起一个 agent 时，它被中断的工具调用补上的结果怎么写（工具调用 id → 说法）：
   * 等审批的、有副作用的（做完了、失败了、说不清做没做完）由守卫接入给出；拉起时现取
   */
  interruptedToolResults?: (agentId: string) => Readonly<Record<string, InterruptedToolResult>>;
  /**
   * 浏览器的可执行文件（70 号票，web/browser-path.ts 的探测）：拉起时现取，有就放进 bash 起的进程的环境
   * （AGENT_BROWSER_EXECUTABLE_PATH），agent-browser 这类 skill 靠它找浏览器；没有就不放
   */
  browserPath?: () => string | undefined;
  /**
   * 系统提示的前缀（71 号票，设置 · 系统提示里的"前缀"）：拉起时把请求里的系统提示交给它，加上前缀再交给子进程，每次现取；
   * 没有系统提示的请求不加。不给就原样
   */
  systemPromptPrefix?: (systemPrompt: string) => string;
  log?: (line: string) => void;
}

const DEFAULT_HEARTBEAT_MS = 10_000;
/** 按需的 agent 就绪后这么久还没交来输入，才从"被唤起"算成"空闲" */
const READY_HOLD_MS = 2_000;
/** 送了"中止"（超时）或"退出"（闲置）之后，这么久还不结束就直接结束子进程 */
const GRACE_MS = 15_000;

/**
 * bash 起的进程额外的环境变量（宿主协议的 shellEnv）：联网开关关着时的无效代理（OFFLINE_SHELL_ENV），
 * 加上浏览器的路径（70 号票：agent-browser 靠 AGENT_BROWSER_EXECUTABLE_PATH 找浏览器）
 */
export function shellEnvFor(network: boolean, browserPath: string | undefined): Record<string, string> {
  return { ...(network ? {} : OFFLINE_SHELL_ENV), ...(browserPath ? { [AGENT_BROWSER_ENV]: browserPath } : {}) };
}

/** agent 的会话目录（pi 的会话文件放在这里）：会话区下的 <agentId> */
export function agentSessionDir(layout: DataDirLayout, agentId: string): string {
  return path.join(layout.sessions, agentId);
}

/** agent 没指定工作目录时用的：临时区下的 agents/<agentId>（秘书的工作目录是草稿区 DataDirLayout.scratch，不用它） */
export function defaultAgentCwd(layout: DataDirLayout, agentId: string): string {
  return path.join(layout.tmp, "agents", agentId);
}
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** 指定的会话的名字（会话目录里的一个会话；文件怎么存由子进程定） */
const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 时长的说法：一分钟以上按分钟，以下按秒（测试里把超时配得很小） */
const duration = (ms: number) => (ms >= 60_000 ? `${Math.round((ms / 60_000) * 10) / 10} 分钟` : `${Math.round(ms / 100) / 10} 秒`);

/** 管家这边的一个 agent：排队、拉起、监视它的一轮（超时）、闲置退出 */
class Entry implements ManagedAgent {
  readonly agentId: string;
  readonly request: SpawnAgentRequest;
  state: ManagedAgentState = "queued";
  readonly exited: Promise<ManagedExit>;
  private proc: AgentProcess | undefined;
  private resolveExit!: (exit: ManagedExit) => void;
  private exitReason: ManagedExitReason | undefined;
  private readonly listeners = new Set<(report: AgentReport) => void>();
  /** 一轮在进行（送了输入，还没 turn_end） */
  private turnOpen = false;
  /** 拉起它的模块拿着的不闲置退出（holdAwake 的 key） */
  private readonly holds = new Set<string>();
  /** 范围审视最近交给子进程的模型（73 号票：每次审视时现取，scope_review、scope_context 带来）；没交过按装配里的 */
  private scopeReviewModel: ModelSpec | undefined;
  /** 这一轮在等哪些工具调用结束（等完了就是下一次模型调用） */
  private readonly toolTimers = new Map<string, NodeJS.Timeout>();
  private modelTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private graceTimer: NodeJS.Timeout | undefined;
  /** 这一轮因为超时被中止：turn_end 换成出错，带上这句说明 */
  private timedOut: string | undefined;
  /** pi 会话的 id（就绪时报的），记账用 */
  private sessionId = "";
  /** 这一轮里在等用户的事（key → 说明） */
  private readonly userWaits = new Map<string, ActivityDetail>();
  /** 刚就绪、还在等第一条输入（按需的 agent，READY_HOLD_MS 内）：算被唤起，不算空闲 */
  private holdTimer: NodeJS.Timeout | undefined;
  /** 正在生成的那条消息已经写了多少字（思考、回复分开数），给进度的说明用 */
  private written = { messageId: "", thinking: 0, text: 0 };
  private readonly manager: Manager;

  constructor(manager: Manager, request: SpawnAgentRequest) {
    this.manager = manager;
    this.request = request;
    this.agentId = request.agentId;
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  get resident(): boolean {
    return this.request.resident === true;
  }

  onReport(listener: (report: AgentReport) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(command: Exclude<HostCommand, { type: "start" }>): void {
    if (!this.proc || this.state !== "running") throw new Error(`agent ${this.agentId} 现在${STATE_LABEL[this.state]}，不能送 ${command.type}`);
    if (command.type === "user_input") {
      this.turnOpen = true;
      this.clearIdle();
      this.clearHold();
      this.armModel();
      this.reportActivity();
    }
    // 拉起它的模块让它退出：算被结束，不是意外退出
    if (command.type === "exit") this.exitReason ??= "killed";
    if ((command.type === "scope_review" || command.type === "scope_context") && command.model) this.scopeReviewModel = command.model;
    this.proc.send(command);
  }

  holdAwake(key: string): () => void {
    this.holds.add(key);
    this.clearIdle();
    return () => {
      if (this.holds.delete(key) && this.holds.size === 0 && !this.turnOpen && this.state === "running") this.armIdle();
    };
  }

  kill(): void {
    if (this.state === "exited") return;
    if (!this.proc) {
      this.manager.dequeue(this);
      this.finish({ code: null, signal: null }, "cancelled");
      return;
    }
    this.exitReason ??= "killed";
    this.proc.kill();
  }

  /** 拿到名额，真正拉起子进程 */
  start(proc: AgentProcess): void {
    this.proc = proc;
    this.state = "starting";
    this.reportActivity();
    proc.onReport((report) => this.onChildReport(report));
    void proc.exited.then((exit) => this.finish(exit, this.exitReason ?? "unexpected"));
  }

  /** 这一轮里有一件事开始等用户（这一轮已经结束的不算） */
  userWaitStarted(key: string, detail: ActivityDetail): void {
    if (!this.turnOpen) return;
    this.userWaits.set(key, detail);
    this.reportActivity();
  }

  /** 这件事不等了 */
  userWaitEnded(key: string): void {
    if (this.userWaits.delete(key)) this.reportActivity();
  }

  /** 现在的活动状态和说明；undefined 是不报（常驻的 agent 还在拉起） */
  private activityNow(): { state: ActivityState; detail?: ActivityDetail } | undefined {
    if (this.state === "queued") return { state: "queued" };
    if (this.state === "exited") return this.exitReason === "idle" ? { state: "sleeping", detail: { kind: "idle_exit" } } : { state: "sleeping" };
    const waiting = [...this.userWaits.values()].at(-1);
    if (waiting !== undefined) return { state: "waiting_for_user", detail: waiting };
    if (this.turnOpen) return { state: "working", detail: { kind: "handling_input" } };
    if (this.resident) return this.state === "starting" ? undefined : { state: "sleeping" };
    if (this.state === "starting" || this.holdTimer) return { state: "working", detail: { kind: "woken" } };
    return { state: "sleeping", detail: { kind: "idle" } };
  }

  private reportActivity(): void {
    const now = this.activityNow();
    if (now) this.manager.activity(this.agentId, now.state, now.detail);
  }

  /** 干活中此刻在做什么（在等用户时不报） */
  private progress(detail: ActivityDetail): void {
    if (this.turnOpen && this.userWaits.size === 0) this.manager.progress(this.agentId, detail);
  }

  /** 工具的中文名：代为执行的工具看拉起时给的，内置的看守卫的工具注册表，都没有就用工具名 */
  private toolTitle(name: string): string {
    const titles = this.request.toolTitles;
    if (titles && Object.hasOwn(titles, name)) return titles[name]!;
    return Object.hasOwn(BUILTIN_TOOL_REGISTRY, name) ? BUILTIN_TOOL_REGISTRY[name]!.title : name;
  }

  private clearHold(): void {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = undefined;
  }

  private onChildReport(report: AgentReport): void {
    let forwarded = report;
    switch (report.type) {
      case "ready":
        this.sessionId = report.sessionId;
        if (this.state === "starting") this.state = "running";
        if (!this.turnOpen) {
          this.armIdle();
          // 按需唤起的马上就有输入交来：先接着算被唤起，等一会儿还没有才算空闲
          if (!this.resident) {
            this.clearHold();
            this.holdTimer = setTimeout(() => {
              this.holdTimer = undefined;
              this.reportActivity();
            }, READY_HOLD_MS);
            this.holdTimer.unref();
          }
          this.reportActivity();
        }
        break;
      case "stream_delta": {
        if (this.written.messageId !== report.messageId) this.written = { messageId: report.messageId, thinking: 0, text: 0 };
        if (report.part === "thinking") this.written.thinking += report.delta.length;
        else this.written.text += report.delta.length;
        this.progress(report.part === "thinking" ? { kind: "thinking", chars: this.written.thinking } : { kind: "replying", chars: this.written.text });
        break;
      }
      case "message_final":
        if (!this.turnOpen) break;
        this.clearModel();
        // 要调用工具：等工具调用结束后才是下一次模型调用；一个工具都没列出的，下一次模型调用马上开始
        if (report.message.stopReason === "tool_calls" && !report.message.parts.some((p) => p.type === "tool_call")) this.armModel();
        break;
      case "tool_call_start":
        if (this.turnOpen) this.armTool(report.toolCallId, report.toolName);
        this.progress({ kind: "calling_tool", tool: this.toolTitle(report.toolName) });
        break;
      case "tool_call_end": {
        const timer = this.toolTimers.get(report.toolCallId);
        if (timer) clearTimeout(timer);
        this.toolTimers.delete(report.toolCallId);
        if (this.turnOpen && this.toolTimers.size === 0 && !this.timedOut) this.armModel();
        break;
      }
      case "turn_end":
        this.turnOpen = false;
        this.userWaits.clear();
        this.clearTurnTimers();
        if (this.timedOut) {
          forwarded = { type: "turn_end", outcome: "error", errorMessage: this.timedOut };
          this.timedOut = undefined;
        }
        if (this.state === "running") this.armIdle();
        this.reportActivity();
        break;
      case "usage": {
        // 范围审视那次调用用的是审视的模型（18 号票；73 号票起每次审视时现取，最近交给子进程的那个）。目录里的模型按这次
        // 调用实际用的记（73 号票：接着已有的会话时，子进程照会话开始时的模型，可能不是装配参数里的）；faux 记成 faux
        const model =
          report.purpose === "scope_review" && this.request.scopeReview ? (this.scopeReviewModel ?? this.request.scopeReview.model) : this.request.model;
        const key = model.kind === "catalog" ? modelKeyOf(report.provider, report.modelId) : modelConfigKey(model);
        this.manager.usage(() => ({ agentId: this.agentId, sessionId: this.sessionId, model: key, attribution: this.request.ledger?.(), report }));
        break;
      }
      default:
        break;
    }
    for (const listener of this.listeners) listener(forwarded);
  }

  private armModel(): void {
    this.clearModel();
    const ms = this.manager.limits.modelCallMs;
    this.modelTimer = setTimeout(() => this.timeout(`模型调用超过 ${duration(ms)}没有结束，已中止`), ms);
    this.modelTimer.unref();
  }

  private clearModel(): void {
    if (this.modelTimer) clearTimeout(this.modelTimer);
    this.modelTimer = undefined;
  }

  private armTool(toolCallId: string, toolName: string): void {
    const ms = this.request.toolTimeouts?.[toolName] ?? this.manager.limits.toolCallMs;
    const timer = setTimeout(() => this.timeout(`工具 ${toolName} 的调用超过 ${duration(ms)}没有结束，已中止`), ms);
    timer.unref();
    this.toolTimers.set(toolCallId, timer);
  }

  private clearTurnTimers(): void {
    this.clearModel();
    for (const timer of this.toolTimers.values()) clearTimeout(timer);
    this.toolTimers.clear();
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = undefined;
  }

  /** 超时：中止这一轮；中止之后还不结束就结束子进程 */
  private timeout(message: string): void {
    if (!this.turnOpen || this.timedOut || !this.proc) return;
    this.timedOut = message;
    this.clearTurnTimers();
    this.manager.log(`agent ${this.agentId}：${message}`);
    try {
      this.proc.send({ type: "abort" });
    } catch {
      // 已经退出了
    }
    this.graceTimer = setTimeout(() => {
      if (!this.turnOpen) return;
      this.exitReason ??= "unresponsive";
      this.manager.log(`agent ${this.agentId} 中止后 ${GRACE_MS / 1000} 秒还没结束这一轮，结束子进程`);
      this.proc?.kill();
    }, GRACE_MS);
    this.graceTimer.unref();
  }

  /** 闲着：非常驻的到点让子进程正常退出（之后再来输入由拉起它的模块重新唤起，接着原会话） */
  private armIdle(): void {
    this.clearIdle();
    if (this.resident) return;
    this.idleTimer = setTimeout(() => {
      if (this.turnOpen || this.holds.size > 0 || this.state !== "running" || !this.proc) return;
      this.state = "exiting";
      this.exitReason = "idle";
      try {
        this.proc.send({ type: "exit" });
      } catch {
        this.proc.kill();
      }
      this.graceTimer = setTimeout(() => this.proc?.kill(), GRACE_MS);
      this.graceTimer.unref();
    }, this.manager.limits.idleMs);
    this.idleTimer.unref();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private finish(exit: AgentExit, reason: ManagedExitReason): void {
    if (this.state === "exited") return;
    this.state = "exited";
    this.exitReason = reason;
    this.turnOpen = false;
    this.userWaits.clear();
    this.clearTurnTimers();
    this.clearIdle();
    this.clearHold();
    this.manager.released(this);
    this.reportActivity();
    this.resolveExit({ ...exit, reason });
  }
}

const STATE_LABEL: Readonly<Record<ManagedAgentState, string>> = { queued: "在排队", starting: "还在拉起", running: "在运行", exiting: "正在闲置退出", exited: "已经退出" };

/** 管家的内部：名额、排队、活动状态 */
interface Manager {
  readonly limits: AgentLimits;
  log(line: string): void;
  activity(agentId: string, state: ActivityState, detail: ActivityDetail | undefined): void;
  progress(agentId: string, detail: ActivityDetail): void;
  /** 记一次用量（归属现取，出错只记日志） */
  usage(usage: () => AgentUsage): void;
  dequeue(entry: Entry): void;
  /** 一个 agent 退出了（或排队时被取消）：名额空出来，按先后拉起排队的 */
  released(entry: Entry): void;
}

export function createAgentManager(options: AgentManagerOptions): AgentManager {
  const { layout } = options;
  const log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
  const limits: AgentLimits = { ...DEFAULT_AGENT_LIMITS, ...options.limits };
  // 交给 pi 当"全局配置目录"的空目录：pi 不再去读 ~/.pi/agent
  const piAgentDir = path.join(layout.tmp, "pi-agent");
  const live = new Set<Entry>();
  const queue: Entry[] = [];
  /** 常驻的 agent：各占一个预留的名额 */
  const residents = new Set<string>();

  /** 非常驻的 agent 现在能不能拉起：活着的加上没在运行的常驻 agent 预留的名额，不到上限 */
  const hasRoom = () => {
    const reserved = [...residents].filter((id) => ![...live].some((e) => e.agentId === id)).length;
    return live.size + reserved < limits.maxLive;
  };

  /** 接着会话时被中断的工具调用补上的结果：守护进程知道的，加上请求里给的（请求里的优先） */
  const interruptedResults = (request: SpawnAgentRequest): { interruptedToolResults?: Record<string, InterruptedToolResult> } => {
    if (!request.continueSession) return {};
    const results = { ...options.interruptedToolResults?.(request.agentId), ...request.interruptedToolResults };
    return Object.keys(results).length > 0 ? { interruptedToolResults: results } : {};
  };

  const launch = (entry: Entry) => {
    const { request } = entry;
    const sessionDir = agentSessionDir(layout, request.agentId);
    const cwd = request.cwd ?? defaultAgentCwd(layout, request.agentId);
    for (const dir of [sessionDir, cwd, piAgentDir]) fs.mkdirSync(dir, { recursive: true });
    const proc = spawnAgentProcess({
      session: {
        agentId: request.agentId,
        cwd,
        sessionDir,
        piAgentDir,
        model: request.model,
        ...(request.vision === undefined ? {} : { vision: request.vision }),
        credentials: request.credentials ?? {},
        tools: [...request.tools],
        hostTools: request.hostTools ?? [],
        skillPaths: request.skillPaths ?? [],
        ...(request.systemPrompt === undefined ? {} : { systemPrompt: options.systemPromptPrefix ? options.systemPromptPrefix(request.systemPrompt) : request.systemPrompt }),
        continueSession: request.continueSession ?? false,
        ...(request.session === undefined ? {} : { session: request.session }),
        forwardToolCalls: request.forwardToolCalls ?? false,
        shellEnv: { ...request.shellEnv, ...shellEnvFor(request.network === true, options.browserPath?.()) },
        heartbeatIntervalMs: request.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS,
        ...(request.contextBlock === undefined ? {} : { contextBlock: request.contextBlock }),
        ...(request.compactionInstructions === undefined ? {} : { compactionInstructions: request.compactionInstructions }),
        ...(request.scopeReview === undefined ? {} : { scopeReview: request.scopeReview }),
        // 写交接摘要也是一次模型调用：最多等单次模型调用的超时（83 号票）
        ...(request.handoff === undefined ? {} : { handoff: { instructions: request.handoff.instructions, timeoutMs: limits.modelCallMs } }),
        ...interruptedResults(request),
      },
      env: buildChildEnv(options.parentEnv, request.env),
      job: options.job,
      onLog: (line) => log(`[agent ${request.agentId}] ${line}`),
    });
    live.add(entry);
    entry.start(proc);
  };

  const drain = () => {
    while (queue.length > 0 && hasRoom()) {
      const next = queue.shift()!;
      try {
        launch(next);
      } catch (err) {
        log(`拉起排队的 agent ${next.agentId} 失败：${err instanceof Error ? err.message : String(err)}`);
        next.kill();
      }
    }
  };

  const manager: Manager = {
    limits,
    log,
    activity(agentId, state, detail) {
      options.onActivity?.(agentId, state, detail);
    },
    progress(agentId, detail) {
      options.onProgress?.(agentId, detail);
    },
    usage(usage) {
      try {
        options.onUsage?.(usage());
      } catch (err) {
        log(`记用量出错：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      }
    },
    dequeue(entry) {
      const i = queue.indexOf(entry);
      if (i >= 0) queue.splice(i, 1);
    },
    released(entry) {
      if (!live.delete(entry)) return;
      drain();
    },
  };

  // 孤儿回收：只在有 Job 对象（Windows）时
  const job = options.job;
  const sweeper = job
    ? setInterval(() => {
        try {
          sweepOrphans(job, new Set([...live].flatMap((e) => (e.pid === undefined ? [] : [e.pid]))), log);
        } catch (err) {
          log(`回收孤儿进程出错：${err instanceof Error ? err.message : String(err)}`);
        }
      }, limits.orphanSweepMs)
    : undefined;
  sweeper?.unref();

  return {
    spawn(request) {
      if (!AGENT_ID.test(request.agentId)) throw new Error(`agent 标识不合法：${request.agentId}`);
      // 会话的名字只是会话目录里的一个名字：不能带目录，跑不出这个 agent 的会话目录
      if (request.session !== undefined && !SESSION_NAME.test(request.session)) throw new Error(`会话的名字不合法：${request.session}`);
      const entry = new Entry(manager, request);
      if (request.resident) residents.add(request.agentId);
      if (request.resident || (queue.length === 0 && hasRoom())) {
        launch(entry);
      } else {
        queue.push(entry);
        log(`子进程已满（${limits.maxLive} 个），agent ${request.agentId} 排队`);
        manager.activity(request.agentId, "queued", undefined);
      }
      return entry;
    },
    userWaitStarted(agentId, key, detail) {
      for (const entry of live) if (entry.agentId === agentId) entry.userWaitStarted(key, detail);
    },
    userWaitEnded(agentId, key) {
      for (const entry of live) if (entry.agentId === agentId) entry.userWaitEnded(key);
    },
    live: () => [...live].flatMap((e) => (e.pid === undefined ? [] : [{ agentId: e.agentId, pid: e.pid }])),
    rewriteSessions(agentId, request) {
      if (!AGENT_ID.test(agentId)) return Promise.reject(new Error(`agent 标识不合法：${agentId}`));
      if ([...live, ...queue].some((e) => e.agentId === agentId)) return Promise.reject(new Error(`agent ${agentId} 还在运行：先停掉它再改写会话文件`));
      return runSessionRewrite(
        { ...request, sessionDir: agentSessionDir(layout, agentId) },
        { env: buildChildEnv(options.parentEnv, {}), job: options.job, onLog: (line) => log(`[改写会话 ${agentId}] ${line}`) },
      );
    },
    probeModels(request) {
      return runModelProbe(request, { env: buildChildEnv(options.parentEnv, {}), job: options.job, onLog: (line) => log(`[模型探查] ${line}`) });
    },
    async shutdown() {
      if (sweeper) clearInterval(sweeper);
      // 先整个拿出来：排队的取消时会把自己从队列里摘掉
      for (const entry of queue.splice(0)) entry.kill();
      const exits = [...live].map((entry) => {
        entry.kill();
        return entry.exited;
      });
      await Promise.all(exits);
    },
  };
}
