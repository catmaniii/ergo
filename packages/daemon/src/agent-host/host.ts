// agent 宿主（127 号票，架构评审第 5 条；ADR-0027 的 agent 一侧）：三种维护者——任务自己的（maintainers/maintainers.ts）、
// 项目的（projects/maintainers.ts）、定时作业自己的（scheduled-jobs/maintainers.ts）——只是它的三种配置，组合根只建它一次，
// 共用的东西（agent 管家、事件存储、守卫、带类型的 bash 工具、每个会话都配的工具、工具包里的 skill 和 MCP、给秘书发消息、
// 系统提示、阈值、范围审视、流程的审查、按 agent 取模型）在这里交一次，各配置只给自己的差异。
// - 小接口：
//   - assemble(request)：哪种维护者、哪个 agent、在哪个工作目录、用哪个工具包、哪种会话（起草计划、执行、普通任务、一次运行、
//     对话段、固定工具包），给出这次唤起的装配（pi 内置工具白名单、守护进程代为执行的工具、守卫看到的会话、重注入块）；
//   - session(config)：建一个维护者会话（AgentSession）。配置给此刻的装配、每次唤起的系统提示和会话段（接哪个会话）、此刻的工具包、
//     什么时候能换模型；拉起参数（模型按哪种维护者和第几次唤起取、pi 工具、skill、联网、bash 另带的环境、重注入块）、
//     守卫按此刻的工具包收窄（27 号票）、范围审视（18 号票）、换模型和交接摘要（83、120 号票）、语音回复、斜杠命令都在这里配；
//   - attach(...)：三种配置把"此刻的装配""停稳手头这一轮""⚙"登记进来，子 agent（20 号票）要维护者此刻的装配、执行控制器从某个阶段
//     重做前停稳（84 号票）、设置里的 ⚙（114 号票）都只问宿主，不用知道是哪种维护者。
// - 深实现：装配在 assembly.ts（纯函数）；会话的输入队列、唤起、换装配在 conversation/agent-session.ts。
// - 128 号票的 agent 贡献（contributions.ts）挂在这里：插件给维护者的工具在装配里"每个会话都配的工具"那一处（assembly.ts 的 sessionTools）
//   按哪种维护者、哪种会话、工具包筛好接进来；上下文块、钩子订阅按此刻这份装配给谁（ExecutionSetup.target）交给会话（拉起时、交每条输入之前现取）。
// 286 号票的运行时（runtime-gate.ts）也挂在这里：维护者按它的运行时属性拉起哪个子进程入口（宿主协议不变）；运行时插件没在运行时
// 不拉起（会话的 launchBlocked：输入留在队里，有活拉不起时活动状态是"等你"，写明哪个插件没启用），插件运行中停用时手头那一轮做完就停掉
// 子进程，启用后接着（poke）。会话"在做一轮"报给闸门，执行控制器据此等那一轮做完才把执行中的任务转等我。288 号票：运行时自带的工具
// （Claude Code 的 TodoWrite、Agent……）的登记加进守卫、工具包标上 runtimeTools（runtimeGuard）；运行时自己要问用户的建提问卡（questions）。
// 289 号票：拉起时把给运行时选的值（任务、项目上记着的 runtimeOptions）交给子进程；子进程的运行时能转交斜杠命令的（Claude Code），
// 用户打的 /命令 原样交给它（会话的 slashPassthrough）；中途换运行时（会话的 switchRuntime）：交接摘要的写法照换模型那一份，
// 换完由 commitRuntime 把任务、项目上的运行时改成新的，运行时闸门再看一眼（recheck）。
// 290 号票：接管来的会话拉起时把会话 id 交给子进程（闸门的 resumeOf）；交还了的闸门当作不能用（不拉起，手头那一轮做完停掉子进程）。
// 291 号票：子进程的运行时能当场换工具包的（能力清单 live_toolkit，Claude Code），工具包变了时会话现取此刻的装配（retool：config.setup()，
// 记成这次唤起的装配，之后代为执行的工具、守卫都取它），子进程当场换，不重新拉起。
// 293 号票：子进程的运行时不自己写分支摘要的（能力清单 branch_summary 是 false，Claude Code），撤回时会话按自己记下的事件、用维护者的二狗模型
// 另起一次写（会话的 ownBranchSummary）。
// 309 号票：运行时的范围审视由二狗另起的（AgentRuntime.recordedScopeReview，Claude Code），压缩之前、工单结束时会话按自己记下的事件、用审视的模型
// 另起一次（会话的 recordedScopeReview；凭据同拉起时给的）；转交斜杠命令的运行时里，用户打的 /<目录名> 是工具包 skill 的换成运行时里的写法
// （会话的 runtimeSlash：AgentRuntime.toolkitSkillCommands，运行时报过的同名命令优先）。
// 秘书、子 agent、评审不经这里（127 号票的 Comments 写了为什么）：秘书常驻、装配固定，比这里的依赖（执行控制器、带类型的 bash 工具……）
// 起得早，它直接用同一个 agent 贡献模块筛（secretary.ts）；子 agent、评审是一次性的（runOneShotAgent），没有会话、会话段、换模型，
// 也不收插件的贡献（子 agent 的工具从维护者此刻的装配收窄）。
import path from "node:path";
import fs from "node:fs";
import { maintainerChannel, type MessageScope, type MessagesPurgedEventPayload, PI_RUNTIME_ID, type PlanToolkit, type RuntimeChoice, t, type Task } from "@ergo/protocol";
import type { AgentHandle } from "../agent-settings/index.ts";
import type { AgentManager } from "../agent-manager/agent-manager.ts";
import type { HostTool } from "../agent-manager/host-tools.ts";
import { AgentSession, type AgentSessionGuard, type AgentSessionStatus, type QueuedAgentInput } from "../conversation/agent-session.ts";
import type { QueueDelivery } from "../conversation/message-queue.ts";
import type { RuntimeQuestions } from "../conversation/runtime-questions.ts";
import { handoffInstructions } from "../conversation/model-switch.ts";
import { type SessionTools, sessionVoice } from "../conversation/session-tools.ts";
import type { StreamHub } from "../conversation/stream-hub.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import { type ConversationApprovals, TOOL } from "../guard/index.ts";
import type { GuardRuntime } from "../guard-runtime/guard-runtime.ts";
import type { MediaStore } from "../media/media-store.ts";
import type { PromptLibrary } from "../prompts/index.ts";
import type { ModelSpec, SessionRewriteRequest } from "../runtime/index.ts";
import { type MaintainerScopeReview, type ScopeOwner, sessionScopeReview } from "../scope-review/index.ts";
import type { SecretaryLetters } from "../secretary/letters.ts";
import type { SlashConversationKind } from "../slash-commands/commands.ts";
import type { MaintainerScope, TaskExecution } from "../tasks/execution.ts";
import type { TaskService } from "../tasks/tasks.ts";
import type { TaskThresholds } from "../tasks/thresholds.ts";
import type { WorkflowExecutor, WorkflowReviewer } from "../tasks/workflow-tools.ts";
import type { TypedShell } from "../typed-shell/index.ts";
import { realPathOf } from "../util/real-path.ts";
import type { AgentContributions } from "./contributions.ts";
import type { RuntimeGate } from "./runtime-gate.ts";
import type { AgentRuntime, RuntimeUnavailable } from "../runtime/index.ts";
import { assemble, type AssemblyDeps, type AssemblyRequest, type ExecutionSetup, type MaintainerAssembly, type MaintainerKind, narrowedGuardAgent, skillCommandsOf, type ToolkitResources } from "./assembly.ts";

/**
 * 三种维护者在会话上的差异（别的都一样）：会话里的斜杠命令按哪种会话认（82 号票），运行时标了插话送达的通知（14 号票：无进展的催促）、
 * 秘书转达的话（103 号票）插不插进正在干的这一轮、接不接语音回复、用户消息带不带 id。144 号票起用户在会话里直接说的话三种都不插话：
 * 正在回复时排队，这一轮做完再交
 */
const MAINTAINER_SESSIONS: Readonly<Record<MaintainerKind, { slash: SlashConversationKind; interjectNotices: boolean; voiceReplies: boolean; userMessageIds: boolean }>> = {
  // 任务的会话里没有 /workflow、/task（82 号票：同名的 skill 直接 /目录名 就展开）；用户的消息末尾带一行消息 id（125 号票：引用用户原话时照抄，运行时核实）
  task: { slash: "task", interjectNotices: true, voiceReplies: true, userMessageIds: true },
  // 项目的会话里有 /workflow、/task（项目内部任务，64 号票；82 号票：同名的 skill 写 /skill:目录名）
  project: { slash: "project", interjectNotices: true, voiceReplies: true, userMessageIds: true },
  // 作业的会话里没有发起任务的命令（82 号票）；76 号票之前用户不直接和它对话，不接语音回复（32 号票）
  job: { slash: "task", interjectNotices: false, voiceReplies: false, userMessageIds: false },
};

export interface AgentHostOptions {
  agents: AgentManager;
  store: EventStore;
  streams: StreamHub;
  guards: GuardRuntime;
  media: MediaStore;
  /** 任务（起草计划、执行的那些） */
  tasks: TaskService;
  /** 任务执行（13 号票）：执行时的工具、守卫看到的任务、重注入块、任务和项目自己的临时文件 */
  execution: TaskExecution;
  /** 带类型的 bash 工具（28）：会话的工具包开了 bash 时随之出现 */
  typedShell: TypedShell;
  /**
   * 每个会话都配的工具（conversation/session-tools.ts）：联网搜索、读网页（70 号票，每一段都有，联网开关关着时守卫拒绝），
   * 语音回复（32 号票：每一段的装配里多一个口语总结工具，用户发语音时输入后面跟一条说明，回复长又没写总结时追问一句）
   */
  sessionTools?: SessionTools;
  /**
   * agent 贡献（128 号票）：插件给维护者的工具（接在每个会话都配的工具后面）、上下文块、钩子订阅，按哪种维护者、哪种会话、工具包筛；
   * 不给就没有插件的贡献
   */
  contributions?: Pick<AgentContributions, "toolsFor" | "inputContextFor" | "replyPartsFor" | "inputNoteFor" | "manifestFor">;
  /** 工具包里的 skill、MCP 怎么落进会话，执行时增减 skill 的工具（27 号票） */
  toolkits?: ToolkitResources;
  /** 给秘书发消息（102 号票，secretary/letters.ts）：工具包里开着时每一段都有 tell_secretary；不给就没有 */
  letters?: SecretaryLetters;
  /** 执行时另给维护者的工具（20 号票：提议并行），绑定在它执行的任务上 */
  subAgentTools?: (scope: MaintainerScope) => HostTool[];
  /**
   * 流程（58 号票；64 号票起项目的维护者也起草、执行流程）：审查修补维护者交来的流程计划（daemon.ts 接上守卫的各区、关注类别设置；
   * 执行它的维护者的工作目录，项目的维护者另有围栏里的项目档案、项目的工具包）。不给就没有 propose_plan（流程起草不了）
   */
  workflowReview?: (task: Task, executor: WorkflowExecutor) => WorkflowReviewer;
  /** Git Bash 里 /tmp 挂到的 Windows 目录（177 号票，agent-manager/work-temp.ts 的 bashTmpMount）：守卫按它解析 /tmp */
  bashTmp?: string | undefined;
  /** 系统提示的文件（71 号票）：每次唤起时现读；114 号票起维护者单独的提示词改了，从它的下一轮起按新的 */
  prompts: Pick<PromptLibrary, "render" | "onAgentChange">;
  /**
   * 实际在用的语言（168 号票）：拉起时记下，交下一条输入之前和现在的比，换了就按新的系统提示重新拉起
   * （末尾那句"用 <语言> 回答用户"由 agent 管家拉起时加）；不给就不比
   */
  language?: () => string;
  /**
   * 用户自己的名字（249 号票）：拉起时记下，交下一条输入之前和现在的比，改了（设了、改了、清除了）就按新的系统提示重新拉起
   * （最前面那句"用户叫「…」"由 agent 管家拉起时加）；不给就不比
   */
  userName?: () => string | undefined;
  /** 阈值（14 号票，配置 tasks.thresholds）：系统提示里照它讲 */
  thresholds: TaskThresholds;
  /** 连续失败几次自动暂停（配置 scheduledJobs.jobFailures）：定时触发的任务、定时作业的系统提示里讲 */
  runFailureLimit: number;
  /** 对话审批的开关（70 号票，配置 guard.conversationApprovals）：普通任务、定时作业的系统提示里工作目录外的说法跟着它；不给按默认（关着） */
  conversationApprovals?: ConversationApprovals;
  /** 范围审视（18 号票）：对照物、近期范围记录、存审视的结果，审视用的模型，工单结束时等多久 */
  scopeReview: MaintainerScopeReview;
  /** 数据目录的输出区（真实路径）：不属于任何项目的任务的产出，每个任务一格（任务自己的维护者、定时作业的维护者在这里干活） */
  outputsDir: string;
  /**
   * 维护者的模型：哪种维护者、哪个、spawn 是这是它第几次被唤起（测试按它给 faux 剧本）。按设置里的"模型"现取，只用于新开的会话
   * （73 号票；项目、任务的维护者单独配了的按它的，120 号票）
   */
  model(maintainer: MaintainerKind, maintainerId: string, spawn: number): ModelSpec;
  /** 配置里写明的看图能力（79 号票；73 号票起设置页改的优先），键是「provider/模型 id」；没写的按模型目录（实际生效的由子进程报回）。拉起时现取 */
  configuredVision: () => Readonly<Record<string, boolean>>;
  credentials: Record<string, string>;
  timeZone: string;
  /** 彻底删除之后会话文件要改写哪些原话（记忆模块从删除事件生成） */
  sessionRewriteFor?: (purges: readonly MessagesPurgedEventPayload[]) => Omit<SessionRewriteRequest, "sessionDir">;
  /** 回复中用户发的话排的队（144 号票，conversation/message-queue.ts）：每个维护者会话在这一轮结束时一起交出去；不给就没有 */
  queue?: QueueDelivery;
  /**
   * 维护者的运行时闸门（286 号票，runtime-gate.ts）：拉起哪个运行时的子进程入口、现在拉不拉得起；能不能用变了（插件运行中停用、启用）
   * 时跟着停掉、接着。不给就都是 pi
   */
  runtimes?: RuntimeGate;
  /**
   * 维护者有活却因为运行时不能用拉不起来（286 号票：活动状态"等你"，说明写明哪个插件没启用），能用了交 undefined。不给就不报
   */
  onRuntimeWait?(agentId: string, wait: RuntimeUnavailable | undefined): void;
  /**
   * 维护者换运行时换完了（289 号票：原来的写好了交接摘要、停掉了）：把任务、项目上记着的运行时和选的值改成新的。
   * 不给就不能中途换运行时
   */
  commitRuntime?(maintainerId: string, runtime: string, options: RuntimeChoice | undefined): void;
  /** 换运行时时写交接摘要那次模型调用最多等多久（毫秒，289 号票）；不给是 5 分钟 */
  handoffTimeoutMs?: number;
  /**
   * 运行时自己要问用户的（288 号票：Claude Code 的 AskUserQuestion、退出计划模式的批准，conversation/runtime-questions.ts）：每个维护者会话
   * 拉起时接上，卡上写它的运行时的名字。不给就不建提问卡（收到的 ask_user 没人回，子进程等到这一轮结束）
   */
  questions?: RuntimeQuestions;
  log: (line: string) => void;
}

/** 一次唤起：这次的装配，和配置自己定的拉起参数 */
export interface HostedLaunch {
  setup: ExecutionSetup;
  cwd: string;
  systemPrompt: string;
  /** 会话段（16 号票）：接哪个会话（按名字明确指定）；不给就按 continueSession 接最近的那个或新开 */
  session?: string;
  continueSession: boolean;
  /** 重注入块：不给用装配里的（114 号票：清空过对话又没有重注入块的，任务自己的维护者给任务书） */
  contextBlock?: string | undefined;
  /** 模型按第几次唤起取（项目的维护者换段、重新装配、会话重建都接着数）；不给是会话自己数的 */
  spawn?: number;
}

/** 一个维护者会话的配置：只给这种维护者的差异 */
export interface HostedSessionConfig {
  maintainer: MaintainerKind;
  agentId: string;
  /**
   * 会话里的消息带上的归属（任务、项目）；给函数时每条消息现取（任务的维护者带上当时的阶段，25 号票；项目维护者的随当前这一段变，16 号票）
   */
  scope: MessageScope | (() => MessageScope);
  /** 此刻的装配（还没唤起过时代为执行的工具、守卫取它） */
  setup(): ExecutionSetup;
  /** 第 n 次唤起：这次的装配、工作目录、系统提示、接哪个会话 */
  launch(n: number): HostedLaunch;
  /** 此刻的工具包：守卫每次判定按它收窄（27 号票：之后去掉的能力，重新拉起之前也用不到） */
  toolkitNow(): PlanToolkit;
  /** 范围审视（18 号票）：此刻这段工作属于谁；不给就不审视 */
  scopeOwner?: () => ScopeOwner;
  /**
   * 换模型就新开会话、附交接摘要（83 号票）：这条输入之前能不能换（项目维护者是对话段里，定时触发的任务、定时作业是一次运行的开头）。
   * 不给就不换（一个任务一个会话）
   */
  switchModel?(input: QueuedAgentInput): boolean;
  /** 处理到一半被打断的那条输入的系统说明 */
  interruptedNote(quoted: string): string;
  /** 现在的子进程是不是按过时的装配拉起的（换了一段会话、换了一次运行、项目的装配变了） */
  outdated?(): boolean;
  /** 现在能不能处理输入（任务的状态，13 号票） */
  canProcess?(): boolean;
  /** 只处理属于当前这一段的输入（16 号票） */
  accepts?(input: QueuedAgentInput): boolean;
  /** 闲置退出了（16 号票：对话段在维护者闲置退出时结束） */
  onIdleExit?(): void;
  /** 子进程就绪了、打开的是哪个会话（16 号票：第一段对话段接着以前的会话时记进这一段） */
  onReady?(ready: { session: string }): void;
}

/** 一种维护者登记进宿主的（不是它的维护者、任务时回 undefined） */
export interface HostedMaintainers {
  /** 执行这个任务的维护者此刻的装配（20 号票：子 agent 从它收窄） */
  assemblyOf?(taskId: string): MaintainerAssembly | undefined;
  /** 停稳手上是这个任务的维护者手头这一轮（84 号票）：返回放开的函数 */
  stopTaskTurn?(task: Task, how: { timeoutMs: number; reason: string }): Promise<(() => void) | undefined>;
  /** 会话里的 ⚙（114 号票） */
  agentHandle?(maintainerId: string): AgentHandle | undefined;
}

export interface AgentHost {
  readonly store: EventStore;
  readonly tasks: TaskService;
  readonly execution: TaskExecution;
  readonly prompts: Pick<PromptLibrary, "render" | "onAgentChange">;
  /** 系统提示里讲的：阈值、连续失败几次自动暂停、对话审批的开关 */
  readonly thresholds: TaskThresholds;
  readonly runFailureLimit: number;
  readonly conversationApprovals: ConversationApprovals | undefined;
  /** 任务在输出区里的那一格（真实路径；create 时先建好） */
  taskDir(taskId: string, options?: { create?: boolean }): string;
  /** 这次唤起的装配（小接口：哪种维护者、哪个 agent、在哪个工作目录、用哪个工具包、哪种会话） */
  assemble(request: AssemblyRequest): ExecutionSetup;
  /** 建一个维护者会话（还没 start） */
  session(config: HostedSessionConfig): AgentSession;
  /** 工单结束时的范围审视（18 号票）：会话的子进程审视这一段还没审视过的工作，返回要和这一段的结束同一事务追加的事件 */
  reviewSegment(session: AgentSession, owner: ScopeOwner): Promise<NewEvent[]>;
  /** 一种维护者登记进来（建它的时候） */
  attach(maintainers: HostedMaintainers): void;
  /** 执行这个任务的维护者此刻的装配（20 号票）：任务不在执行、不在谁手上时没有 */
  assemblyOf(taskId: string): MaintainerAssembly | undefined;
  /**
   * 停稳手上是这个任务的维护者手头这一轮（84 号票：从某个阶段重做之前）——任务自己的维护者，连同手上是这个任务的工单的项目维护者；
   * 返回放开的函数，谁都没有时 undefined
   */
  stopTaskTurn(task: Task, how: { timeoutMs: number; reason: string }): Promise<(() => void) | undefined>;
  /** 会话里的 ⚙（114 号票）：任务自己的维护者、项目维护者；别的 undefined */
  agentHandle(maintainerId: string): AgentHandle | undefined;
}

/** agent 宿主建的一个维护者会话，运行时闸门变了时要看一眼的（286 号票） */
interface HostedEntry {
  agentId: string;
  session: AgentSession;
  /** 上次看时运行时能不能用 */
  off: boolean;
}

export function createAgentHost(options: AgentHostOptions): AgentHost {
  /** 建过的维护者会话（停了就拿掉）：运行时能不能用变了时各看一眼 */
  const hosted = new Set<HostedEntry>();
  // 运行时能不能用变了（286 号票）：不能用了的，手头那一轮做完就停掉子进程（refresh：之后拉不起）；又能用了的，"等你"清掉、接着处理排着的
  options.runtimes?.onChange(() => {
    for (const entry of hosted) {
      const off = options.runtimes!.off(entry.agentId) !== undefined;
      if (off && !entry.off) entry.session.refresh();
      if (!off && entry.off) {
        options.onRuntimeWait?.(entry.agentId, undefined);
        entry.session.poke();
      }
      entry.off = off;
    }
  });
  const deps: AssemblyDeps = {
    tasks: options.tasks,
    execution: options.execution,
    typedShell: options.typedShell,
    subAgentTools: options.subAgentTools,
    sessionTools: options.sessionTools,
    contributions: options.contributions,
    toolkits: options.toolkits,
    letters: options.letters,
    media: options.media,
    store: options.store,
    workflowReview: options.workflowReview,
    bashTmp: options.bashTmp,
  };
  const attached: HostedMaintainers[] = [];

  return {
    store: options.store,
    tasks: options.tasks,
    execution: options.execution,
    prompts: options.prompts,
    thresholds: options.thresholds,
    runFailureLimit: options.runFailureLimit,
    // 现取（315 号票：组合根交来的是 getter，设置里改了，维护者下次拉起时的系统提示就按新的）
    get conversationApprovals() {
      return options.conversationApprovals;
    },
    taskDir(taskId, opts = {}) {
      const dir = path.join(options.outputsDir, taskId);
      if (opts.create) fs.mkdirSync(dir, { recursive: true });
      return realPathOf(dir) ?? dir;
    },
    assemble: (request) => assemble(deps, request),
    session: (config) => {
      let entry: HostedEntry | undefined;
      const session = hostedSession(options, config, (status) => {
        // 在不在做一轮报给运行时闸门（286 号票）；停了的不再看
        options.runtimes?.setBusy(config.agentId, status === "busy");
        if (status === "stopped" && entry) hosted.delete(entry);
      });
      entry = { agentId: config.agentId, session, off: options.runtimes?.off(config.agentId) !== undefined };
      hosted.add(entry);
      return session;
    },
    async reviewSegment(session, owner) {
      const result = await session.reviewScope(options.scopeReview.timeoutMs);
      return options.scopeReview.service.recordEvents(owner, "work_order_end", result);
    },
    attach(maintainers) {
      attached.push(maintainers);
    },
    assemblyOf(taskId) {
      for (const m of attached) {
        const assembly = m.assemblyOf?.(taskId);
        if (assembly) return assembly;
      }
      return undefined;
    },
    async stopTaskTurn(task, how) {
      const held = (await Promise.all(attached.map((m) => m.stopTaskTurn?.(task, how)))).filter((r) => r !== undefined);
      return held.length > 0 ? () => held.forEach((release) => release()) : undefined;
    },
    agentHandle(maintainerId) {
      for (const m of attached) {
        const handle = m.agentHandle?.(maintainerId);
        if (handle) return handle;
      }
      return undefined;
    },
  };
}

/**
 * 用自带工具的运行时的维护者（288 号票，AgentRuntime.guardTools：Claude Code 的 TodoWrite、Agent……）：守卫的注册表加上这些登记，
 * 工具包标上 runtimeTools（这些和没登记的不按工具白名单硬拒绝，没登记的照未登记的写操作判）。pi、没登记自带工具的运行时原样
 */
function runtimeGuard(guard: AgentSessionGuard, runtime: AgentRuntime | undefined): AgentSessionGuard {
  if (!runtime?.guardTools) return guard;
  const agent = { ...guard.agent, toolkit: { ...guard.agent.toolkit, runtimeTools: true as const } };
  return { ...guard, agent, runtimeTools: runtime.guardTools };
}

/** 一个维护者会话：每次唤起按配置给的装配拉起，代为执行的工具、守卫都取这一份；onStatus 是会话状态变了（286 号票：报给运行时闸门） */
function hostedSession(options: AgentHostOptions, config: HostedSessionConfig, onStatus: (status: AgentSessionStatus) => void): AgentSession {
  const flavor = MAINTAINER_SESSIONS[config.maintainer];
  /** 这次唤起的装配：拉起时（spawn）算一次 */
  let launched: HostedLaunch | undefined;
  /** 模型是按第几次唤起取的（换模型时设置里此刻给它的模型按它取，83 号票） */
  let spawns = 0;
  const current = () => launched?.setup ?? config.setup();
  const model = (spawn: number) => options.model(config.maintainer, config.agentId, spawn);
  const { switchModel } = config;
  const { contributions } = options;
  /** 拉起时在用的语言（168 号票）：换了语言，交下一条输入之前按新的系统提示重新拉起 */
  let spawnedLanguage: string | undefined;
  const languageChanged = () => options.language !== undefined && spawnedLanguage !== undefined && options.language() !== spawnedLanguage;
  /** 拉起时"我的名字"是什么（249 号票）：改了名字，交下一条输入之前按新的系统提示重新拉起（没设过也能从无到有） */
  const userNameKey = options.userName;
  let spawnedUserName: string | undefined;
  let userNameTracked = false;
  const userNameChanged = () => userNameKey !== undefined && userNameTracked && userNameKey() !== spawnedUserName;
  const outdated = config.outdated;
  const gate = options.runtimes;
  return new AgentSession({
    agents: options.agents,
    store: options.store,
    streams: options.streams,
    guards: options.guards,
    media: options.media,
    timeZone: options.timeZone,
    log: options.log,
    agentId: config.agentId,
    conversation: maintainerChannel(config.agentId),
    label: t("agentHost.maintainer"),
    ...(flavor.userMessageIds ? { userMessageIds: true } : {}),
    scope: config.scope,
    ledgerRole: "maintainer",
    spawn: (n) => {
      launched = config.launch(n);
      spawnedLanguage = options.language?.();
      if (userNameKey !== undefined) {
        spawnedUserName = userNameKey();
        userNameTracked = true;
      }
      spawns = launched.spawn ?? n;
      const { setup } = launched;
      const { assembly } = setup;
      const contextBlock = launched.contextBlock ?? setup.contextBlock;
      return {
        // 维护者的运行时（286 号票）：拉起它登记的子进程入口；pi 的不写。289 号票：连同给它选的值（⚙ 里的模型、权限模式、思考档位）
        ...(gate && gate.runtimeOf(config.agentId) !== PI_RUNTIME_ID ? { runtime: gate.runtimeOf(config.agentId), ...runtimeOptionsOf(gate, config.agentId) } : {}),
        // 接管来的会话（290 号票）：二狗管着、没交还的，子进程要新开会话时接着它
        ...(gate?.resumeOf(config.agentId) === undefined ? {} : { resumeRuntimeSession: gate.resumeOf(config.agentId) }),
        model: model(spawns),
        tools: [...assembly.piTools],
        cwd: launched.cwd,
        systemPrompt: launched.systemPrompt,
        // 接哪个会话：任务、定时作业的维护者接着最近的那个（第一次是新会话）；项目维护者按当前这一段明确指定（16 号票）
        ...(launched.session === undefined ? {} : { session: launched.session }),
        continueSession: launched.continueSession,
        credentials: options.credentials,
        // 联网开关照工具包显式给（70 号票）；只加载工具包里的 skill（27 号票）
        network: assembly.toolkit.network,
        skillPaths: [...assembly.skillPaths],
        // 事件触发的流程这次运行的事件的值（77 号票）：只给 bash 起的进程
        ...(assembly.shellEnv ? { shellEnv: assembly.shellEnv } : {}),
        // bash 的临时目录（177 号票）：拉起时建好，bash 每条命令前面把 TMPDIR、TEMP、TMP 指到它
        ...(assembly.tempDir !== undefined && assembly.piTools.includes(TOOL.bash) ? { tempDir: assembly.tempDir } : {}),
        ...(contextBlock === undefined ? {} : { contextBlock }),
      };
    },
    ...(outdated || options.language || userNameKey !== undefined ? { outdated: () => outdated?.() === true || languageChanged() || userNameChanged() } : {}),
    hostTools: () => current().hostTools,
    // 用自带工具的运行时（288 号票，Claude Code）：守卫加上运行时自带的工具的登记，工具包标上 runtimeTools
    guard: () => runtimeGuard(current().guard, gate?.runtime(config.agentId)),
    // 运行时自己要问用户的（288 号票）：提问卡上写它的运行时的名字
    ...(options.questions ? { questions: { service: options.questions, runtimeTitle: () => gate?.runtime(config.agentId)?.title ?? "pi" } } : {}),
    // 守卫每次判定按此刻的工具包收窄（27 号票）
    guardNow: (agent) => narrowedGuardAgent(agent, config.toolkitNow()),
    // 范围审视（18 号票）：装配里带上审视的那一份，压缩时子进程自己做的存成范围记录
    // 309 号票：二狗另起审视时交给一次性子进程的凭据同拉起时给的
    ...(config.scopeOwner ? { scopeReview: { ...sessionScopeReview(options.scopeReview, config.agentId, config.scopeOwner), credentials: () => options.credentials } } : {}),
    ...(config.canProcess ? { canProcess: config.canProcess } : {}),
    ...(config.accepts ? { accepts: config.accepts } : {}),
    ...(flavor.interjectNotices ? { interjectNotices: true } : {}),
    // 回复中用户发的话排的队（144 号票）：这一轮结束时一起交出去
    ...(options.queue ? { queue: options.queue } : {}),
    ...(config.onIdleExit ? { onIdleExit: config.onIdleExit } : {}),
    ...(config.onReady ? { onReady: config.onReady } : {}),
    configuredVision: options.configuredVision,
    interruptedNote: config.interruptedNote,
    ...(options.sessionRewriteFor ? { sessionRewriteFor: options.sessionRewriteFor } : {}),
    // 语音回复（32 号票，接不接看哪种维护者）、输入队列的挡板（214 号票：语音插件在运行时由它回答）
    ...sessionVoice(options.sessionTools, flavor.voiceReplies),
    // 插件给维护者的上下文块、钩子订阅（128 号票）：按此刻这份装配给谁
    // 212 号票：输入附注（现在只有浏览插件给秘书的，维护者没有；按"给谁"筛）
    ...(contributions
      ? {
          contributions: {
            manifest: () => contributions.manifestFor(current().target),
            inputContext: (message) => contributions.inputContextFor(current().target, message),
            replyParts: (message) => contributions.replyPartsFor(current().target, message),
            inputNote: (message) => contributions.inputNoteFor(current().target, message),
          },
        }
      : {}),
    ...skillCommandsOf(options.toolkits),
    slashConversation: flavor.slash,
    onStatus,
    // 运行时不能用（286 号票）：不拉起，有活等着就报"等你"（写明哪个插件没启用）
    ...(gate
      ? {
          launchBlocked: () => {
            const off = gate.off(config.agentId);
            if (off) options.onRuntimeWait?.(config.agentId, off);
            return off?.reason;
          },
        }
      : {}),
    // 换模型就新开会话、附交接摘要（83 号票）：交接摘要的写法照 prompts/handoff-summary.md
    ...(switchModel ? { modelSwitch: { instructions: () => handoffInstructions(options.prompts), allowed: switchModel, wanted: () => model(spawns) } } : {}),
    // 斜杠命令原样转交（289 号票）：子进程的运行时能力清单里 slash_passthrough 是 true 的（Claude Code）
    ...(gate ? { slashPassthrough: (runtime: string) => gate.supports(runtime, "slash_passthrough") } : {}),
    // 撤回时的分支摘要（293 号票）：能力清单里 branch_summary 是 false 的运行时（Claude Code）由二狗按自己记下的事件、用维护者的二狗模型写
    ...(gate ? { ownBranchSummary: (runtime: string) => gate.supports(runtime, "branch_summary") } : {}),
    // 范围审视（309 号票）：运行时自己不审视的（Claude Code）由二狗按自己记下的事件、用审视的模型另起一次
    ...(gate ? { recordedScopeReview: (runtime: string) => gate.recordedScopeReview(runtime) } : {}),
    // 二狗 skill 的斜杠写法（309 号票）：转交的运行时有自己的写法的（Claude Code 的 /ergo:<目录名>），和它报过的命令同名时它的优先
    ...(gate
      ? {
          runtimeSlash: (runtime: string) => {
            const named = gate.runtime(config.agentId);
            if (named?.id !== runtime || !named.toolkitSkillCommands) return undefined;
            const toolkitSkillCommands = named.toolkitSkillCommands.bind(named);
            return { skillCommands: (dirs: readonly string[]) => toolkitSkillCommands(dirs), commands: () => gate.commandsOf(runtime, config.agentId) };
          },
        }
      : {}),
    // 工具包当场换（291 号票）：能力清单里 live_toolkit 是 true 的（Claude Code）；换的时候现取此刻的装配，记成这次唤起的
    ...(gate
      ? {
          liveToolkit: (runtime: string) => gate.supports(runtime, "live_toolkit"),
          retool: () => {
            const setup = config.setup();
            if (launched) launched = { ...launched, setup };
            return { skillPaths: [...setup.assembly.skillPaths] };
          },
        }
      : {}),
    // 中途换运行时（289 号票）：交接摘要的写法和换模型同一份；换完改任务、项目上的运行时，闸门再看一眼
    ...(gate && options.commitRuntime
      ? {
          runtimeSwitch: {
            instructions: () => handoffInstructions(options.prompts),
            timeoutMs: options.handoffTimeoutMs ?? DEFAULT_HANDOFF_TIMEOUT_MS,
            current: () => gate.runtimeOf(config.agentId),
            title: (runtime: string) => gate.title(runtime),
            commit: (to: string, chosen: RuntimeChoice | undefined) => {
              options.commitRuntime!(config.agentId, to, chosen);
              gate.recheck();
            },
          },
        }
      : {}),
  });
}

/** 换运行时时写交接摘要最多等多久（没给 handoffTimeoutMs 时） */
const DEFAULT_HANDOFF_TIMEOUT_MS = 5 * 60_000;

/** 拉起请求里给运行时选的值（289 号票）：选了才写 */
function runtimeOptionsOf(gate: RuntimeGate, agentId: string): { runtimeOptions?: RuntimeChoice } {
  const chosen = gate.optionsOf(agentId);
  return chosen ? { runtimeOptions: { ...chosen } } : {};
}
