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
// 运行时（286 号票）：拉起哪个子进程入口按请求里的运行时（runtime，不写是 pi），经运行时的登记表解析（runtime/runtimes.ts）；
// 登记它的插件没在运行时不拉起，抛"X插件没启用"（拉起它的模块先经运行时闸门问过，正常走不到这里）。宿主协议照旧，名额、Job 对象、
// 超时、闲置退出、孤儿回收不分运行时；运行时自带的工具可以声明自己的单次调用超时（288 号票：Claude Code 的子代理不按单次超时算）。
import fs from "node:fs";
import path from "node:path";
import { type ActivityDetail, type ActivityState, activeLanguage, type ModelCustomProvider, modelKeyOf, PI_RUNTIME_ID, t } from "@ergo/protocol";
import { RequestRejected } from "../errors.ts";
import type { DataDirLayout } from "../config/data-dir.ts";
import { modelConfigKey } from "../config/model-key.ts";
import { BUILTIN_TOOL_REGISTRY } from "../guard/index.ts";
import { buildChildEnv, COMPONENTS_DIR_ENV, OFFLINE_SHELL_ENV } from "../process/child-env.ts";
import { AGENT_BROWSER_ENV } from "../web/index.ts";
import type { AgentUsage, UsageAttribution } from "../ledger/index.ts";
import type { JobObject } from "../process/job-object.ts";
import {
  type AgentContributions,
  type AgentExit,
  type AgentProcess,
  type AgentReport,
  COMPACTION_HOOK_ID,
  type ContextBlockSpec,
  type HookSubscription,
  type HostCommand,
  type HostToolSpec,
  CHILD_LANGUAGE_ENV,
  type InterruptedToolResult,
  type ModelSpec,
  type ModelProbeRequest,
  type ModelProbeResult,
  type RecordedGenerationRequest,
  type RecordedGenerationResult,
  type RuntimeCatalogReport,
  type RuntimeOptionsSetup,
  type AgentRuntime,
  type RuntimeRegistry,
  type ThumbnailRequest,
  type ThumbnailResult,
  REINJECTION_BLOCK_ID,
  runModelProbe,
  runRecordedGeneration,
  runThumbnails,
  runSessionRewrite,
  type ScopeReviewSetup,
  type SessionContextInfo,
  type SessionRewriteRequest,
  type SessionRewriteResult,
  spawnAgentProcess,
} from "../runtime/index.ts";
import { runOneShotChild } from "../runtime/one-shot-child.ts";
import { type SweepScope, sweepOrphans } from "./orphans.ts";
import { ensureWorkTempDir } from "./work-temp.ts";

export interface SpawnAgentRequest {
  /** agent 的标识，也是它在会话区里的子目录名 */
  agentId: string;
  /**
   * 用哪个 agent 运行时（286 号票：维护者的运行时属性）：拉起它登记的子进程入口；不写是 pi（秘书、子 agent、评审都是）。
   * 宿主协议不分运行时，下面这些装配参数原样交给它
   */
  runtime?: string;
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
  /**
   * 清空当前对话之后新开的那一段会话的名字（114 号票，见宿主协议的 freshSession）：还没有这个名字的会话就马上用它新开，有了照常接着
   */
  freshSession?: string;
  /** 显式给子进程的额外环境变量 */
  env?: Record<string, string>;
  /**
   * 只给 bash 起的进程另加的环境变量（77 号票：事件触发的流程这次运行的事件的值）：并进宿主协议的 shellEnv（联网关着时的无效代理、浏览器路径之外）
   */
  shellEnv?: Readonly<Record<string, string>>;
  /**
   * bash 的临时目录（177 号票，work-temp.ts）：拉起时建好、清掉 7 天没动过的；bash 每条命令前面把 TMPDIR、TEMP、TMP 指到它
   * （宿主协议的 shellTempDir）。不给就不设（秘书的工作目录就是草稿区，本来就是临时区）
   */
  tempDir?: string;
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
  /**
   * 重注入块（13 号票）：拉起后第一条输入之前作为上下文消息加进会话，压缩之后再注入最新的（宿主协议 18 起是通用贡献清单里
   * id 为 REINJECTION_BLOCK_ID 的那块上下文）
   */
  contextBlock?: string;
  /**
   * 自定义的压缩指令（22 号票：秘书专用的那一份）：自动和手动压缩写摘要都按它（宿主协议 18 起是通用贡献清单里 id 为 COMPACTION_HOOK_ID
   * 的 compaction_instructions 钩子订阅）
   */
  compactionInstructions?: string;
  /**
   * 插件经 agent 贡献缝给的上下文块、钩子订阅（128 号票，agent-host/contributions.ts 筛好的）：排在上面内核的那一块、那一条后面，
   * 一起放进通用贡献清单（见宿主协议的 AgentContributions）
   */
  contributions?: { contextBlocks: readonly ContextBlockSpec[]; hooks: readonly HookSubscription[] };
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
  /** 维护者给运行时选的值（289 号票，见宿主协议的 runtimeOptions）：原样交给子进程，不给是都跟运行时自己的默认 */
  runtimeOptions?: RuntimeOptionsSetup;
  /** 接管的运行时会话 id（290 号票，见宿主协议的 resumeRuntimeSession）：原样交给子进程 */
  resumeRuntimeSession?: string;
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
  /**
   * agent-browser 闲置多久回收（毫秒，178 号票）：它的守护进程和 Chrome 跟着开它的 agent 走，这个 agent 这么久没调用过工具就不再留；
   * 同样的时长也交给 agent-browser 自己（AGENT_BROWSER_IDLE_TIMEOUT_MS：这么久没有命令就自己存好状态、关浏览器退出）
   */
  browserIdleMs: number;
}

export const DEFAULT_AGENT_LIMITS: Readonly<AgentLimits> = Object.freeze({
  maxLive: 8,
  idleMs: 10 * 60_000,
  modelCallMs: 5 * 60_000,
  toolCallMs: 10 * 60_000,
  orphanSweepMs: 60_000,
  browserIdleMs: 30 * 60_000,
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
  /**
   * 工具包当场换了（291 号票，宿主协议 toolkit：能力清单 live_toolkit 的运行时）：守护进程代为执行的工具的超时、中文名换成新的
   * （拉起时的 toolTimeouts、toolTitles；之后开始的调用按新的计时、活动状态里按新的说）
   */
  retool(tools: { toolTimeouts: Readonly<Record<string, number>>; toolTitles: Readonly<Record<string, string>> }): void;
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
  /**
   * 缩小成小图（145 号票的 view_files，149 号票起是秘书在用）：用 pi 自带的图片缩放，一次性子进程做（pi 只在子进程里），不占 agent 的名额；
   * 单张读不了、解不开写在结果里，子进程出错、超时抛错
   */
  thumbnails(request: ThumbnailRequest): Promise<ThumbnailResult>;
  /**
   * 插件的一次性子进程（290 号票：Claude Code 插件列本机会话、读前情、分叉，SDK 只在子进程里）：拉起 entry、送一行请求、等一行结果，
   * 和别的一次性子进程一样放进 Job 对象、只给白名单里的环境，不占 agent 的名额；子进程出错、超时（timeoutMs）抛错，label 写进出错的说明
   */
  runOneShot<T>(entry: string, request: unknown, label: string, timeoutMs: number): Promise<T>;
  /**
   * 按二狗自己的事件记录另起一次生成（293 号票：Claude Code 撤回时给被放弃的那段写分支摘要；309 号票的范围审视照同一套）：一次性子进程
   * （runtime/recorded-generation.ts，pi 只在子进程里），不占 agent 的名额；那次模型调用的用量记在 ledger.agentId 名下（归属 ledger.attribution，
   * purpose 照结果里报的）。子进程出错（模型出错、没写成）、超时（单次模型调用的超时）抛错
   */
  recordedGeneration(request: RecordedGenerationRequest, ledger: { agentId: string; sessionId?: string; attribution: UsageAttribution | undefined }): Promise<RecordedGenerationResult>;
  /**
   * 某个模型（记账用的模型键：「provider/模型 id」，faux 是 faux）的上下文窗口和 pi 的压缩设置（114 号票，⚙ 里的上下文用量）：
   * 守护进程这次起来以后用这个模型的 agent 就绪时报的；还没有过是 undefined
   */
  contextOf(modelKey: string): SessionContextInfo | undefined;
  /**
   * 某个 agent 此刻的用量归属（154 号票：联网工具按次计费的调用记在发起调用的 agent 名下，和它的 token 用量同一套归属）：
   * 拉起时给的 ledger 现取；不在管家手里（已经退出）或拉起时没给是 undefined（账本按未归属记）
   */
  attributionOf(agentId: string): UsageAttribution | undefined;
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
  /**
   * 设置里选的自定义（OpenAI 兼容）服务商（现取）：选了才有。它是全局一个（和 credentials 一样，不按 agent 分），所以由管家在
   * 每个会话的装配、每次模型探查、每次另起的生成里带上——子进程据此 registerProvider，模型目录里才认得它。
   * key 不在这里（照旧只走 credentials）；不给就是没选自定义
   */
  customProvider?: () => ModelCustomProvider | undefined;
  /**
   * agent 运行时的登记表（286 号票）：请求里写了运行时的按它解析子进程入口（不能用的抛"X插件没启用"）。
   * 不给时只认 pi（测试里直接建管家的）
   */
  runtimes?: Pick<RuntimeRegistry, "resolve"> & Partial<Pick<RuntimeRegistry, "noteCatalog">>;
  log?: (line: string) => void;
}

const DEFAULT_HEARTBEAT_MS = 10_000;
/** 按需的 agent 就绪后这么久还没交来输入，才从"被唤起"算成"空闲" */
const READY_HOLD_MS = 2_000;
/** 送了"中止"（超时）或"退出"（闲置）之后，这么久还不结束就直接结束子进程 */
const GRACE_MS = 15_000;

/**
 * 拉起请求里的工具、上下文块、钩子订阅合成宿主协议的通用贡献清单（128 号票）：内核的（重注入块、秘书的压缩指令）在前，
 * 插件经 agent 贡献缝给的接在后面
 */
export function contributionsOf(request: Pick<SpawnAgentRequest, "hostTools" | "contextBlock" | "compactionInstructions" | "contributions">): AgentContributions {
  return {
    tools: request.hostTools ?? [],
    contextBlocks: [...(request.contextBlock === undefined ? [] : [{ id: REINJECTION_BLOCK_ID, text: request.contextBlock }]), ...(request.contributions?.contextBlocks ?? [])],
    hooks: [
      ...(request.compactionInstructions === undefined ? [] : [{ id: COMPACTION_HOOK_ID, kind: "compaction_instructions" as const, text: request.compactionInstructions }]),
      ...(request.contributions?.hooks ?? []),
    ],
  };
}

/** agent-browser 的守护进程在哪个目录写 `<会话>.pid`、`.port`（178 号票：每个 agent 一个，孤儿回收据此认出是谁开的） */
export const AGENT_BROWSER_SOCKET_DIR_ENV = "AGENT_BROWSER_SOCKET_DIR";
/** agent-browser 的守护进程多久没有命令就自己退出（毫秒） */
export const AGENT_BROWSER_IDLE_ENV = "AGENT_BROWSER_IDLE_TIMEOUT_MS";

/**
 * bash 起的进程额外的环境变量（宿主协议的 shellEnv）：联网开关关着时的无效代理（OFFLINE_SHELL_ENV），
 * 加上浏览器的路径（70 号票：agent-browser 靠 AGENT_BROWSER_EXECUTABLE_PATH 找浏览器），
 * 以及这个 agent 自己的 agent-browser socket 目录和闲置时长（178 号票）
 */
export function shellEnvFor(
  network: boolean,
  browserPath: string | undefined,
  agentBrowser?: { socketDir: string; idleMs: number },
): Record<string, string> {
  return {
    ...(network ? {} : OFFLINE_SHELL_ENV),
    ...(browserPath ? { [AGENT_BROWSER_ENV]: browserPath } : {}),
    ...(agentBrowser ? { [AGENT_BROWSER_SOCKET_DIR_ENV]: agentBrowser.socketDir, [AGENT_BROWSER_IDLE_ENV]: String(Math.round(agentBrowser.idleMs)) } : {}),
  };
}

/** agent 的 agent-browser socket 目录：临时区下的 agent-browser/<agentId>（agent-browser 自己会建） */
export function agentBrowserSocketDir(layout: DataDirLayout, agentId: string): string {
  return path.join(layout.tmp, "agent-browser", agentId);
}

/** agent 的会话目录（pi 的会话文件放在这里）：会话区下的 <agentId> */
export function agentSessionDir(layout: DataDirLayout, agentId: string): string {
  return path.join(layout.sessions, agentId);
}

/**
 * 插件运行时自己的目录（291 号票，宿主协议 runtimeDir）：缓存区下的 runtimes/<agentId>——随时能重新做出来、不进备份。
 * Claude Code 在里面拼工具包 skill 的本地插件；pi 不用（不建）
 */
export function agentRuntimeDir(layout: DataDirLayout, agentId: string): string {
  return path.join(layout.cache, "runtimes", agentId);
}

/** agent 没指定工作目录时用的：临时区下的 agents/<agentId>（秘书的工作目录是草稿区 DataDirLayout.scratch，不用它） */
export function defaultAgentCwd(layout: DataDirLayout, agentId: string): string {
  return path.join(layout.tmp, "agents", agentId);
}
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** 指定的会话的名字（会话目录里的一个会话；文件怎么存由子进程定） */
const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 时长的说法：一分钟以上按分钟，以下按秒（测试里把超时配得很小） */
const duration = (ms: number) => (ms >= 60_000 ? t("agentManager.minutes", { n: Math.round((ms / 60_000) * 10) / 10 }) : t("agentManager.seconds", { n: Math.round(ms / 100) / 10 }));

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
  /** 这一轮在等哪些工具调用结束（等完了就是下一次模型调用）；不按单次超时算的（288 号票）也在里面，没有计时器 */
  private readonly toolTimers = new Map<string, NodeJS.Timeout | undefined>();
  /** 它的运行时自带的工具声明的超时（288 号票，AgentRuntime.toolTimeouts）：拉起时按运行时的登记取 */
  runtimeToolTimeouts: Readonly<Record<string, number | null>> | undefined;
  /** 工具包当场换过（291 号票）：代为执行的工具的超时、中文名换成这一份（没换过按拉起时的） */
  private retooled: { toolTimeouts: Readonly<Record<string, number>>; toolTitles: Readonly<Record<string, string>> } | undefined;
  /** 还没结束的工具调用和它们开始的时刻（178 号票：孤儿回收不杀这之后起的进程） */
  private readonly toolStarts = new Map<string, number>();
  /** 最近一次工具调用开始或结束的时刻（178 号票：agent-browser 闲置多久按它算）；拉起时算起 */
  private lastToolActivity = Date.now();
  private modelTimer: NodeJS.Timeout | undefined;
  /** 手动压缩（compact 命令）在等 compacted：到点还没压完就结束子进程（114 号票） */
  private compactTimer: NodeJS.Timeout | undefined;
  /** 会话树上挪（navigate_session，150 号票）在等 session_navigated：写分支摘要卡住时到点结束子进程 */
  private navigateTimer: NodeJS.Timeout | undefined;
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

  /** 还没结束的工具调用里最早的开始时刻；没有在跑的调用是 undefined */
  get busySince(): number | undefined {
    return this.toolStarts.size === 0 ? undefined : Math.min(...this.toolStarts.values());
  }

  /** 它开的 agent-browser 还留不留：有调用在跑，或者最近一次工具调用离现在不到 idleMs */
  browserInUse(now: number, idleMs: number): boolean {
    return this.toolStarts.size > 0 || now - this.lastToolActivity < idleMs;
  }

  onReport(listener: (report: AgentReport) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(command: Exclude<HostCommand, { type: "start" }>): void {
    if (!this.proc || this.state !== "running") throw new Error(`agent ${this.agentId} 现在${STATE_LABEL[this.state]}，不能送 ${command.type}`); // @i18n-ignore log：编程错误
    if (command.type === "user_input") {
      this.turnOpen = true;
      this.clearIdle();
      this.clearHold();
      this.armModel();
      this.reportActivity();
    }
    if (command.type === "compact") this.armCompact();
    if (command.type === "navigate_session") this.armNavigate();
    // 拉起它的模块让它退出：算被结束，不是意外退出
    if (command.type === "exit") this.exitReason ??= "killed";
    if ((command.type === "scope_review" || command.type === "scope_context") && command.model) this.scopeReviewModel = command.model;
    this.proc.send(command);
  }

  retool(tools: { toolTimeouts: Readonly<Record<string, number>>; toolTitles: Readonly<Record<string, string>> }): void {
    this.retooled = { toolTimeouts: { ...tools.toolTimeouts }, toolTitles: { ...tools.toolTitles } };
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
    const titles = this.retooled?.toolTitles ?? this.request.toolTitles;
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
        // 这个模型的上下文窗口（114 号票）：记账的模型键和用量的一样（目录里的模型按会话实际用的，faux 是 faux）
        this.manager.context(this.request.model.kind === "catalog" ? modelKeyOf(report.model.provider, report.model.modelId) : modelConfigKey(this.request.model), report.context);
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
        this.toolStarts.set(report.toolCallId, Date.now());
        this.lastToolActivity = Date.now();
        if (this.turnOpen) this.armTool(report.toolCallId, report.toolName);
        this.progress({ kind: "calling_tool", tool: this.toolTitle(report.toolName) });
        break;
      case "tool_call_end": {
        this.toolStarts.delete(report.toolCallId);
        this.lastToolActivity = Date.now();
        const timer = this.toolTimers.get(report.toolCallId);
        if (timer) clearTimeout(timer);
        this.toolTimers.delete(report.toolCallId);
        if (this.turnOpen && this.toolTimers.size === 0 && !this.timedOut) this.armModel();
        break;
      }
      case "turn_end":
        this.turnOpen = false;
        this.toolStarts.clear();
        this.userWaits.clear();
        this.clearTurnTimers();
        if (this.timedOut) {
          forwarded = { type: "turn_end", outcome: "error", errorMessage: this.timedOut };
          this.timedOut = undefined;
        }
        if (this.state === "running") this.armIdle();
        this.reportActivity();
        break;
      case "compacted":
        this.clearCompact();
        break;
      case "session_navigated":
        this.clearNavigate();
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
      case "runtime_catalog":
        // 运行时自己的模型列表、斜杠命令（289 号票）：记进登记表（⚙ 的模型列表、输入框的候选用）
        this.manager.catalog(this.request.runtime ?? PI_RUNTIME_ID, this.agentId, report);
        break;
      default:
        break;
    }
    for (const listener of this.listeners) listener(forwarded);
  }

  private armModel(): void {
    this.clearModel();
    const ms = this.manager.limits.modelCallMs;
    this.modelTimer = setTimeout(() => this.timeout(t("agentManager.modelTimeout", { duration: duration(ms) })), ms);
    this.modelTimer.unref();
  }

  private clearModel(): void {
    if (this.modelTimer) clearTimeout(this.modelTimer);
    this.modelTimer = undefined;
  }

  /**
   * 手动压缩的超时（114 号票）：压缩不在一轮里，轮的计时管不到它，压缩那次模型调用卡住时会话会一直"忙"着。按单次模型调用的超时计时
   * （装配了范围审视的维护者压缩前先审视一次，是两次调用，给两倍），到点还没报 compacted 就结束子进程；拉起它的模块在退出时按"没压成"收尾
   */
  private armCompact(): void {
    this.clearCompact();
    const ms = this.manager.limits.modelCallMs * (this.request.scopeReview ? 2 : 1);
    this.compactTimer = setTimeout(() => {
      this.compactTimer = undefined;
      if (this.state === "exited" || !this.proc) return;
      this.exitReason ??= "unresponsive";
      this.manager.log(`agent ${this.agentId}：压缩超过 ${duration(ms)}没有结束，结束子进程`);
      this.proc.kill();
    }, ms);
    this.compactTimer.unref();
  }

  private clearCompact(): void {
    if (this.compactTimer) clearTimeout(this.compactTimer);
    this.compactTimer = undefined;
  }

  /**
   * 会话树上挪的超时（150 号票）：回退时要写分支摘要（一次模型调用），不在一轮里，轮的计时管不到它。按单次模型调用的超时计时，
   * 到点还没报 session_navigated 就结束子进程；拉起它的模块在退出时按"没撤回成"收尾（会话文件还没动：摘要写好之前不改）
   */
  private armNavigate(): void {
    this.clearNavigate();
    const ms = this.manager.limits.modelCallMs;
    this.navigateTimer = setTimeout(() => {
      this.navigateTimer = undefined;
      if (this.state === "exited" || !this.proc) return;
      this.exitReason ??= "unresponsive";
      this.manager.log(`agent ${this.agentId}：会话回退写分支摘要超过 ${duration(ms)}没有结束，结束子进程`);
      this.proc.kill();
    }, ms);
    this.navigateTimer.unref();
  }

  private clearNavigate(): void {
    if (this.navigateTimer) clearTimeout(this.navigateTimer);
    this.navigateTimer = undefined;
  }

  /**
   * 这次工具调用的超时：拉起时声明的（代为执行的工具）、运行时自带的工具声明的（288 号票：Claude Code 的子代理不按单次超时算，null），
   * 都没有按默认。不按单次超时算的照样记着"在等它结束"（期间不算在等下一次模型调用：子代理里的调用结束了也不开始计模型的时）
   */
  private armTool(toolCallId: string, toolName: string): void {
    const own = (this.retooled?.toolTimeouts ?? this.request.toolTimeouts)?.[toolName];
    const runtime = this.runtimeToolTimeouts && Object.hasOwn(this.runtimeToolTimeouts, toolName) ? this.runtimeToolTimeouts[toolName] : undefined;
    const ms = own ?? (runtime === undefined ? this.manager.limits.toolCallMs : runtime);
    if (ms === null) {
      this.toolTimers.set(toolCallId, undefined);
      return;
    }
    const timer = setTimeout(() => this.timeout(t("agentManager.toolTimeout", { tool: toolName, duration: duration(ms) })), ms);
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
    this.toolStarts.clear();
    this.userWaits.clear();
    this.clearTurnTimers();
    this.clearCompact();
    this.clearNavigate();
    this.clearIdle();
    this.clearHold();
    this.manager.released(this);
    this.reportActivity();
    this.resolveExit({ ...exit, reason });
  }
}

// @i18n-ignore-next log：只用在编程错误里
const STATE_LABEL: Readonly<Record<ManagedAgentState, string>> = { queued: "在排队", starting: "还在拉起", running: "在运行", exiting: "正在闲置退出", exited: "已经退出" };

/** 管家的内部：名额、排队、活动状态 */
interface Manager {
  readonly limits: AgentLimits;
  log(line: string): void;
  activity(agentId: string, state: ActivityState, detail: ActivityDetail | undefined): void;
  progress(agentId: string, detail: ActivityDetail): void;
  /** 某个模型的上下文窗口和压缩设置（就绪时报的，114 号票） */
  context(modelKey: string, info: SessionContextInfo): void;
  /** 记一次用量（归属现取，出错只记日志） */
  usage(usage: () => AgentUsage): void;
  /** 运行时的子进程报回了它自己的模型列表、斜杠命令（289 号票）：记进运行时的登记表 */
  catalog(runtime: string, agentId: string, report: RuntimeCatalogReport): void;
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
  /** 各模型的上下文窗口和压缩设置（就绪时报的，114 号票） */
  const contexts = new Map<string, SessionContextInfo>();
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

  /** 这个请求用哪个运行时（286 号票）：pi 的不经登记表也认得（没给登记表时是 undefined）；别的按登记表，不能用的抛 RequestRejected */
  const runtimeOf = (request: SpawnAgentRequest): AgentRuntime | undefined => {
    const runtime = request.runtime ?? PI_RUNTIME_ID;
    if (options.runtimes) return options.runtimes.resolve(runtime);
    if (runtime !== PI_RUNTIME_ID) throw new RequestRejected("not_allowed", t("runtime.registry.unknown", { id: runtime }));
    return undefined;
  };

  const launch = (entry: Entry) => {
    const { request } = entry;
    // 先解析子进程入口：登记它的插件没在运行时不建目录、不拉起
    const runtime = runtimeOf(request);
    const custom = options.customProvider?.();
    const childEntry = runtime?.entry;
    entry.runtimeToolTimeouts = runtime?.toolTimeouts;
    const sessionDir = agentSessionDir(layout, request.agentId);
    const cwd = request.cwd ?? defaultAgentCwd(layout, request.agentId);
    // 插件的运行时（291 号票）：它自己的目录（Claude Code 拼工具包 skill 的本地插件）；pi 的不建
    const runtimeDir = runtime === undefined || runtime.id === PI_RUNTIME_ID ? undefined : agentRuntimeDir(layout, request.agentId);
    for (const dir of [sessionDir, cwd, piAgentDir, ...(runtimeDir === undefined ? [] : [runtimeDir])]) fs.mkdirSync(dir, { recursive: true });
    if (request.tempDir !== undefined) ensureWorkTempDir(request.tempDir, Date.now(), (line) => log(`[agent ${request.agentId}] ${line}`));
    const proc = spawnAgentProcess({
      ...(childEntry === undefined ? {} : { entry: childEntry }),
      session: {
        agentId: request.agentId,
        cwd,
        sessionDir,
        piAgentDir,
        model: request.model,
        ...(request.vision === undefined ? {} : { vision: request.vision }),
        credentials: request.credentials ?? {},
        // 自定义（OpenAI 兼容）服务商（和 credentials 一样是全局一个）：子进程按它登记 provider，模型目录里才认得
        ...(custom === undefined ? {} : { custom }),
        tools: [...request.tools],
        contributions: contributionsOf(request),
        skillPaths: request.skillPaths ?? [],
        ...(request.systemPrompt === undefined ? {} : { systemPrompt: options.systemPromptPrefix ? options.systemPromptPrefix(request.systemPrompt) : request.systemPrompt }),
        continueSession: request.continueSession ?? false,
        ...(request.session === undefined ? {} : { session: request.session }),
        ...(request.freshSession === undefined ? {} : { freshSession: request.freshSession }),
        forwardToolCalls: request.forwardToolCalls ?? false,
        shellEnv: {
          ...request.shellEnv,
          ...shellEnvFor(request.network === true, options.browserPath?.(), {
            socketDir: agentBrowserSocketDir(layout, request.agentId),
            idleMs: limits.browserIdleMs,
          }),
        },
        ...(request.tempDir === undefined ? {} : { shellTempDir: request.tempDir }),
        heartbeatIntervalMs: request.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS,
        ...(request.scopeReview === undefined ? {} : { scopeReview: request.scopeReview }),
        // 写交接摘要也是一次模型调用：最多等单次模型调用的超时（83 号票）
        ...(request.handoff === undefined ? {} : { handoff: { instructions: request.handoff.instructions, timeoutMs: limits.modelCallMs } }),
        ...(request.runtimeOptions === undefined ? {} : { runtimeOptions: request.runtimeOptions }),
        ...(request.resumeRuntimeSession === undefined ? {} : { resumeRuntimeSession: request.resumeRuntimeSession }),
        ...(runtimeDir === undefined ? {} : { runtimeDir }),
        ...interruptedResults(request),
      },
      // 子进程里给用户看的几句按现在的语言写（174 号票）
      // 组件区（318 号票）：运行时的子进程要用装在那里的东西（Claude Code 的 Agent SDK）
      env: buildChildEnv(options.parentEnv, { ...request.env, [CHILD_LANGUAGE_ENV]: activeLanguage(), [COMPONENTS_DIR_ENV]: layout.components }),
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
    context(modelKey, info) {
      contexts.set(modelKey, info);
    },
    usage(usage) {
      try {
        options.onUsage?.(usage());
      } catch (err) {
        log(`记用量出错：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      }
    },
    catalog(runtime, agentId, report) {
      const { type: _type, ...catalog } = report;
      options.runtimes?.noteCatalog?.(runtime, agentId, catalog);
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

  // 孤儿回收：只在有 Job 对象（Windows）时。还在跑的工具调用期间起的进程先不杀，活着、没闲置太久的 agent 开的
  // agent-browser 留着（178 号票，见 orphans.ts）
  const job = options.job;
  const sweepScope = (): SweepScope => {
    const now = Date.now();
    const entries = [...live].filter((e) => e.pid !== undefined);
    const busy = entries.flatMap((e) => (e.busySince === undefined ? [] : [e.busySince]));
    return {
      roots: new Set(entries.map((e) => e.pid!)),
      ...(busy.length === 0 ? {} : { busySince: Math.min(...busy) }),
      browserSocketDirs: entries.filter((e) => e.browserInUse(now, limits.browserIdleMs)).map((e) => agentBrowserSocketDir(layout, e.agentId)),
    };
  };
  const sweeper = job
    ? setInterval(() => {
        try {
          sweepOrphans(job, sweepScope(), log);
        } catch (err) {
          log(`回收孤儿进程出错：${err instanceof Error ? err.message : String(err)}`);
        }
      }, limits.orphanSweepMs)
    : undefined;
  sweeper?.unref();

  return {
    spawn(request) {
      // @i18n-ignore-start log：编程错误
      if (!AGENT_ID.test(request.agentId)) throw new Error(`agent 标识不合法：${request.agentId}`);
      // 会话的名字只是会话目录里的一个名字：不能带目录，跑不出这个 agent 的会话目录
      if (request.session !== undefined && !SESSION_NAME.test(request.session)) throw new Error(`会话的名字不合法：${request.session}`);
      if (request.freshSession !== undefined && !SESSION_NAME.test(request.freshSession)) throw new Error(`会话的名字不合法：${request.freshSession}`);
      // @i18n-ignore-end
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
      // @i18n-ignore-start log：编程错误
      if (!AGENT_ID.test(agentId)) return Promise.reject(new Error(`agent 标识不合法：${agentId}`));
      if ([...live, ...queue].some((e) => e.agentId === agentId)) return Promise.reject(new Error(`agent ${agentId} 还在运行：先停掉它再改写会话文件`));
      // @i18n-ignore-end
      return runSessionRewrite(
        { ...request, sessionDir: agentSessionDir(layout, agentId) },
        { env: buildChildEnv(options.parentEnv, {}), job: options.job, onLog: (line) => log(`[改写会话 ${agentId}] ${line}`) },
      );
    },
    contextOf: (modelKey) => contexts.get(modelKey),
    attributionOf: (agentId) => [...live, ...queue].find((e) => e.agentId === agentId)?.request.ledger?.(),
    probeModels(request) {
      // 自定义（OpenAI 兼容）服务商：列它的模型、测它的连通性都得先让子进程登记这个 provider
      const custom = options.customProvider?.();
      const probe = custom === undefined || request.custom !== undefined ? request : { ...request, custom };
      return runModelProbe(probe, { env: buildChildEnv(options.parentEnv, { [CHILD_LANGUAGE_ENV]: activeLanguage() }), job: options.job, onLog: (line) => log(`[模型探查] ${line}`) });
    },
    thumbnails(request) {
      return runThumbnails(request, { env: buildChildEnv(options.parentEnv, {}), job: options.job, onLog: (line) => log(`[缩小图片] ${line}`) });
    },
    runOneShot(entry, request, label, timeoutMs) {
      return runOneShotChild(entry, request, label, timeoutMs, {
        // 组件区（318 号票）：插件的一次性子进程（Claude Code 列会话）要用装在那里的 SDK
        env: buildChildEnv(options.parentEnv, { [CHILD_LANGUAGE_ENV]: activeLanguage(), [COMPONENTS_DIR_ENV]: layout.components }),
        job: options.job,
        onLog: (line) => log(`[${label}] ${line}`),
      });
    },
    async recordedGeneration(request, ledger) {
      // 自定义（OpenAI 兼容）服务商：一次性子进程里的 ModelRuntime 也要先登记它
      const custom = options.customProvider?.();
      const generation = custom === undefined || request.custom !== undefined ? request : { ...request, custom };
      const result = await runRecordedGeneration(generation, {
        // 没写成的原因按现在的语言写（174 号票）
        env: buildChildEnv(options.parentEnv, { [CHILD_LANGUAGE_ENV]: activeLanguage() }),
        job: options.job,
        onLog: (line) => log(`[另起生成 ${ledger.agentId}] ${line}`),
        timeoutMs: limits.modelCallMs,
      });
      const report = result.usage;
      if (report) {
        // 目录里的模型按这次调用实际用的记，faux 记成 faux（同子进程报的用量）
        const model = request.model.kind === "catalog" ? modelKeyOf(report.provider, report.modelId) : modelConfigKey(request.model);
        manager.usage(() => ({ agentId: ledger.agentId, sessionId: ledger.sessionId ?? "", model, attribution: ledger.attribution, report }));
      }
      return result;
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
