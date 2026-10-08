// 维护者（规格第 3、7、8 节）：12 号票是任务自己的维护者（涉及多个项目或不涉及项目的任务在建卡时产生，id 是 tm-<n>），
// 会话频道是 maintainer:<维护者 id>，里面的消息都带上所属的任务（素材的"任务或项目"取自这里）。
//
// 维护者平时不跑：交给它一条输入 = 往它的会话里追加一条带 taskId 的系统通知（任务书、用户打回计划的意见……），
// 这里看到它的会话里来了消息，就为这个维护者建一个 AgentSession（conversation/agent-session.ts，和秘书共用）：
// 经 agent 管家唤起子进程（名额满了就排队）、接着它会话目录里最近的那个会话（第一次是新会话）、一次处理一条输入；
// 闲置到设定时间子进程退出，再来输入时重新唤起；意外退出时正在处理的那条以"中断"结束、不重送。
// 维护者会话里有消息被彻底删除（21 号票的 messages_purged）时同样建好它的会话，由会话改写会话文件里的原话。
//
// 起草计划时的维护者只能读（read、ls）和"提交计划"（tools.ts）：确认之前不动手不能只靠提示词。
// 工作目录是数据目录输出区里任务自己的一格（outputs/<任务 id>），不联网；每次工具调用都经守卫（07 号票的接入），
// 调用不属于任务（task() 不给，按对话里的处置判），会话段是"<维护者 id>:planning"。
// 工具包开了 bash 时，会话里有 pi 的 bash，也有带类型的 bash 工具（28 号票，typed-shell/：git 状态和差异、提交、合并、
// 推送、建远端仓库、跑测试、装依赖、构建）。
//
// 执行（13 号票）：任务开始执行（有了阶段）后按确认的计划重新装配——
// - pi 工具：读写文件（read、write、edit、ls、grep、find），计划的工具包开了 bash 才给 bash；联网开关照计划显式给；
// - 代为执行的工具：开始阶段、宣布阶段完成、报告进展、转为等我、失败（tasks/execution-tools.ts）；
// - 守卫：调用属于任务（task() 给计划和当前阶段），效果日志、时序规则按任务划范围；
// - 重注入块：每次唤起时注入，阶段、状态变了换成最新的（压缩之后注入）；
// - 什么时候处理输入看任务的状态（共享协议包的 availableTaskActions 里维护者的 work）：规划中、待确认、执行中、等我时处理；
//   排队中、已暂停、结束了的输入留在队里；
// - 用户在任务详情里说的话（正在处理一条输入时）作为插话送进去；任务暂停、取消时中止手头这一轮。
// 起草计划和执行之间换装配（refresh）：手头这一条处理完就停掉子进程，下次唤起按新的装配拉起（接着同一个会话）。
// 并行（20 号票）：执行时多一个"提议并行"工具（subAgentTools）；子 agent 的装配从维护者此刻的装配收窄（assemblyOf）。
// 执行时的装配和项目的维护者共用（assembly.ts 的 executionSetup，16 号票）；这里只管起草计划时的装配和任务自己的差异
// （工作目录是输出区里任务的一格，工具包照确认的计划，没有项目档案）。
// 14 号票：计划变更确认、自行调整计划后工具包变了（开 bash、联网……）同样换装配（工具包取现在生效的计划）；
// 运行时无进展的催促在维护者干活时以插话送达；系统提示里的阈值照配置。
// 范围审视（18 号票，scope-review/ 的 sessionScopeReview）：装配里带审视用的模型、对照物（任务书、计划、审批卡上的批准、
// 用户说的话）和近期范围记录；压缩会话时子进程自己审视，结果存成范围记录（不属于项目的任务：写进任务的产出区）。
// 任务自己的维护者没有工单，只在压缩时审视。
import fs from "node:fs";
import path from "node:path";
import {
  availableTaskActions,
  CHANNELS,
  type ConversationId,
  EVENT_TYPES,
  MAINTAINER_CHANNEL_PREFIX,
  maintainerChannel,
  type MessagesPurgedEventPayload,
  type Task,
  taskActRefusal,
  type TaskEventPayload,
  sameToolkit,
} from "@ergou/protocol";
import type { AgentManager } from "../agent-manager/agent-manager.ts";
import type { HostTool } from "../agent-manager/host-tools.ts";
import { AgentSession, type AgentSessionGuard, type AgentVoiceReplies } from "../conversation/agent-session.ts";
import type { StreamHub } from "../conversation/stream-hub.ts";
import type { MessageScope } from "../conversation/messages.ts";
import { pendingInputs, startedInputs } from "../conversation/views.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore } from "../events/event-store.ts";
import { TOOL } from "../guard/index.ts";
import type { GuardRuntime } from "../guard-runtime/guard-runtime.ts";
import type { MediaStore } from "../media/media-store.ts";
import type { ModelSpec, SessionRewriteRequest } from "../runtime/index.ts";
import { type MaintainerScopeReview, ownershipOf, type ScopeOwner, sessionScopeReview } from "../scope-review/index.ts";
import { taskMessageScope } from "../tasks/stages.ts";
import type { MaintainerScope, TaskExecution } from "../tasks/execution.ts";
import type { TaskService } from "../tasks/tasks.ts";
import type { TaskThresholds } from "../tasks/thresholds.ts";
import type { ShellToolkit, TypedShell } from "../typed-shell/index.ts";
import { realPathOf } from "../util/real-path.ts";
import { conversationTools, EXECUTION_PI_TOOLS, executionSetup, followExecutingTask, type MaintainerAssembly, maintainerGuardAgent } from "./assembly.ts";
import { taskMaintainerSystemPrompt } from "./system-prompt.ts";
import { submitPlanTool } from "./tools.ts";

/** 起草计划时维护者的 pi 内置工具：只能读（加上代为执行的"提交计划"） */
export const PLANNING_PI_TOOLS: readonly string[] = [TOOL.read, TOOL.ls];

/** 起草计划时的工具包：没有 bash，不联网 */
export const PLANNING_TOOLKIT: Readonly<ShellToolkit> = Object.freeze({ bash: false, network: false });

export { EXECUTION_PI_TOOLS };

/** 任务在执行（有了阶段）：按确认的计划装配 */
const executing = (task: Task | undefined) => task?.stages?.list !== undefined;

export interface MaintainersOptions {
  agents: AgentManager;
  store: EventStore;
  streams: StreamHub;
  guards: GuardRuntime;
  tasks: TaskService;
  /** 任务执行（13 号票）：执行时的工具、守卫看到的任务、重注入块 */
  execution: TaskExecution;
  media: MediaStore;
  /** 数据目录的输出区（真实路径）：不属于任何项目的任务的产出，每个任务一格 */
  outputsDir: string;
  /** 维护者的模型；spawn 是这是它第几次被唤起（测试按它给 faux 剧本） */
  model: (maintainerId: string, spawn: number) => ModelSpec;
  /** 范围审视（18 号票）：对照物、近期范围记录、存审视的结果，审视用的模型 */
  scopeReview: MaintainerScopeReview;
  /** 这个模型支不支持图片输入 */
  vision: (model: ModelSpec) => boolean;
  credentials: Record<string, string>;
  timeZone: string;
  /** 带类型的 bash 工具（28）：会话的工具包开了 bash 时随之出现 */
  typedShell: TypedShell;
  /** 阈值（14 号票，配置 tasks.thresholds）：系统提示里照它讲 */
  thresholds: TaskThresholds;
  /**
   * 测试用：起草计划时维护者会话的工具包（bash、联网开关）；不给时都关着。执行时一律照确认的计划（13 号票）。
   * 28 号票的测试靠它给起草中的维护者一个开了 bash 的会话（StartDaemonOptions.maintainerToolkit）
   */
  toolkit?: (maintainerId: string) => ShellToolkit;
  /** 彻底删除之后会话文件要改写哪些原话（记忆模块从删除事件生成） */
  sessionRewriteFor?: (purges: readonly MessagesPurgedEventPayload[]) => Omit<SessionRewriteRequest, "sessionDir">;
  /** 不归这里管的维护者（15 号票：项目的维护者，含任务转为项目后原任务的维护者，由项目模块接） */
  excluded?: (maintainerId: string) => boolean;
  /** 执行时另给维护者的工具（20 号票：提议并行），绑定在它执行的任务上 */
  subAgentTools?: (scope: MaintainerScope) => HostTool[];
  /** 语音回复（32 号票）：每一段的装配里多一个口语总结工具，用户发语音时输入后面跟一条说明，回复长又没写总结时追问一句 */
  voiceReplies?: AgentVoiceReplies;
  log: (line: string) => void;
}

export interface Maintainers {
  /** 开始接输入：上次被打断的输入标成中断，还有输入等着的维护者唤起 */
  start(): void;
  /**
   * 放手一个维护者（任务转为项目时，项目模块接过它）：马上不再接它会话里的输入，子进程结束后兑现。
   * 正在处理的那一条按中断处理（接手的会话 start() 时标出）
   */
  release(maintainerId: string): Promise<void>;
  /** 任务的维护者此刻（执行时）的装配：工作目录、工具包、pi 工具、围栏（20 号票：子 agent 从它收窄）；任务不在执行时没有 */
  assemblyOf(taskId: string): MaintainerAssembly | undefined;
  stop(): Promise<void>;
}

export function createMaintainers(options: MaintainersOptions): Maintainers {
  const sessions = new Map<string, MaintainerSession>();
  let unsubscribe: (() => void) | undefined;

  /** 这个维护者的会话（第一次用到时建好并开始接输入）；不是任务的维护者时没有 */
  const sessionFor = (maintainerId: string): MaintainerSession | undefined => {
    const existing = sessions.get(maintainerId);
    if (existing) return existing;
    if (options.excluded?.(maintainerId)) return undefined;
    const task = options.tasks.ofMaintainer(maintainerId);
    if (!task) return undefined;
    const session = taskMaintainerSession(options, task);
    sessions.set(maintainerId, session);
    session.session.start();
    return session;
  };

  return {
    start() {
      // 交给维护者的输入（任务书、打回意见……）进了它的会话，或者它会话里有消息被彻底删除了：建好它的会话
      // （会话自己接着订阅、唤起它，建好时把以前的彻底删除对一遍）
      // 任务变了（开始执行、阶段推进、暂停、取消……）：看要不要换装配、中止手头这一轮、处理排着的输入
      unsubscribe = options.store.onAppend((event) => {
        if (event.channel === CHANNELS.board && event.type === EVENT_TYPES.task) {
          const { task, from } = event.payload as TaskEventPayload;
          sessions.get(task.maintainerId)?.taskChanged(task, from);
          return;
        }
        if (!event.channel.startsWith(MAINTAINER_CHANNEL_PREFIX)) return;
        if (event.type === EVENT_TYPES.message || event.type === EVENT_TYPES.messagesPurged) sessionFor(event.channel.slice(MAINTAINER_CHANNEL_PREFIX.length));
      });
      // 守护进程重启前还有输入没处理完的
      for (const task of options.tasks.list()) {
        const conversation = maintainerChannel(task.maintainerId);
        if (startedInputs(options.store.reader, conversation).length > 0 || pendingInputs(options.store.reader, conversation).length > 0) sessionFor(task.maintainerId);
      }
    },
    assemblyOf(taskId) {
      const task = options.tasks.get(taskId);
      if (!task || !executing(task) || options.excluded?.(task.maintainerId)) return undefined;
      const dir = path.join(options.outputsDir, taskId);
      return taskSetup(options, task, realPathOf(dir) ?? dir).assembly;
    },
    release(maintainerId) {
      const session = sessions.get(maintainerId);
      if (!session) return Promise.resolve();
      sessions.delete(maintainerId);
      return session.session.stop();
    },
    async stop() {
      unsubscribe?.();
      await Promise.all([...sessions.values()].map((s) => s.session.stop()));
    },
  };
}

/**
 * 任务维护者的会话（任务详情里和维护者说话，13 号票）：消息带上所属的任务；任务现在收不收用户的话看
 * availableTaskActions 里用户的 message（已完成、已取消、已归档的不再收）。没有这个维护者时拒绝（not_found），
 * 不是维护者的会话不认（undefined）。项目维护者的会话先由项目模块认（daemon.ts）
 */
export function userMessageScope(tasks: TaskService, conversation: ConversationId): MessageScope | undefined {
  if (!conversation.startsWith(MAINTAINER_CHANNEL_PREFIX)) return undefined;
  const task = tasks.ofMaintainer(conversation.slice(MAINTAINER_CHANNEL_PREFIX.length));
  if (!task) throw new RequestRejected("not_found", `没有这个维护者：${conversation}`);
  if (!availableTaskActions(task, "user").includes("message")) throw new RequestRejected("not_allowed", taskActRefusal(task, "message"));
  // 开始执行之后带上当时的阶段（时间线的全局层按阶段聚色块，25 号票）
  return taskMessageScope(task);
}

/** 任务维护者一次唤起的装配：子 agent 收窄用的那一份、代为执行的工具、守卫看到的会话、重注入块（执行时才有） */
interface TaskSetup {
  assembly: MaintainerAssembly;
  hostTools: HostTool[];
  guard: AgentSessionGuard;
  contextBlock: string | undefined;
}

/**
 * 任务维护者此刻的装配：会话每次唤起算一次（拉起参数、代为执行的工具、守卫都取这一份）；子 agent 从 assemblyOf 现算的一份收窄（20 号票）。
 * cwd 是维护者的工作目录（数据目录输出区里任务自己的一格，真实路径）；任务自己的维护者没有项目档案，
 * 工作目录是 git 仓库时按开发类算。
 * - 执行时：照确认的计划的工具包，装配和项目的维护者共用（assembly.ts 的 executionSetup）；
 * - 起草计划时：只能读（read、ls）和"提交计划"，工具包都关着（测试可以经 options.toolkit 给，开了 bash 时带类型的 bash 工具一起出现）；
 *   调用不属于任务（按对话里的处置判），效果日志和时序规则按"<维护者>:planning"这一段划范围
 */
/** 维护者现在的工具包：执行时照现在生效的计划（14 号票：计划变更确认之前提出的那一版不算），起草计划时都关着（测试可以经 options.toolkit 给） */
function taskToolkit(options: MaintainersOptions, task: Task): ShellToolkit {
  if (!executing(task)) return options.toolkit?.(task.maintainerId) ?? PLANNING_TOOLKIT;
  const planned = options.tasks.confirmedPlan(task.id)?.plan.toolkit;
  return { bash: planned?.bash === true, network: planned?.network === true };
}

function taskSetup(options: MaintainersOptions, task: Task, cwd: string): TaskSetup {
  const development = fs.existsSync(path.join(cwd, ".git"));
  const source = `任务「${task.title}」`;
  const toolkit = taskToolkit(options, task);
  if (executing(task)) {
    return executionSetup(options, { taskId: task.id, maintainerId: task.maintainerId, cwd, toolkit, source, projectRecords: [], development });
  }
  const hostTools = [submitPlanTool(options.tasks, { taskId: task.id, maintainerId: task.maintainerId }), ...options.typedShell.toolsFor({ cwd, toolkit }), ...conversationTools(options)];
  const assembly: MaintainerAssembly = {
    cwd,
    toolkit,
    piTools: [...PLANNING_PI_TOOLS, ...(toolkit.bash ? [TOOL.bash] : [])],
    hostTools: hostTools.map((t) => t.spec.name),
    projectRecords: [],
    workingDirs: [cwd],
    development,
  };
  return { assembly, hostTools, guard: { agent: maintainerGuardAgent(task.maintainerId, assembly), source, segmentId: `${task.maintainerId}:planning` }, contextBlock: undefined };
}

/** 一个任务维护者的会话，和它跟着任务变的地方 */
interface MaintainerSession {
  session: AgentSession;
  /** 任务变了：起草计划和执行之间换装配；暂停、取消时中止手头这一轮；换上最新的重注入块；看一眼排着的输入 */
  taskChanged(task: Task, from: Task["state"] | null): void;
}

/** 任务自己的维护者的会话：起草计划时只能读，执行时按确认的计划装配 */
function taskMaintainerSession(options: MaintainersOptions, first: Task): MaintainerSession {
  const { execution } = options;
  const taskId = first.id;
  const maintainerId = first.maintainerId;
  const dir = path.join(options.outputsDir, taskId);
  fs.mkdirSync(dir, { recursive: true });
  const cwd = realPathOf(dir) ?? dir;
  const current = () => options.tasks.get(taskId) ?? first;
  /** 这次唤起的装配：拉起时（spawn）算一次，代为执行的工具、守卫都取这一份 */
  let spawned: TaskSetup | undefined;
  const setup = () => spawned ?? taskSetup(options, current(), cwd);
  /** 当前的装配是不是执行的那一套、按哪个工具包装配的（换的时候 refresh） */
  let assembled = executing(first);
  let assembledToolkit = taskToolkit(options, first);
  /** 范围审视的归属：任务（执行时带上当时的阶段） */
  const owner = (): ScopeOwner => ({ ownership: ownershipOf({ maintainerId, taskId }), scope: taskMessageScope(current()) });

  const session = new AgentSession({
    agents: options.agents,
    store: options.store,
    streams: options.streams,
    guards: options.guards,
    media: options.media,
    timeZone: options.timeZone,
    log: options.log,
    agentId: maintainerId,
    conversation: maintainerChannel(maintainerId),
    label: "维护者",
    // 执行时的消息带上当时的阶段（时间线的全局层按阶段聚色块，25 号票）；工具调用记录取守卫判定那一刻的
    scope: () => taskMessageScope(current()),
    ledgerRole: "maintainer",
    spawn: (n) => {
      spawned = taskSetup(options, current(), cwd);
      const { assembly, contextBlock: block } = spawned;
      return {
        model: options.model(maintainerId, n),
        tools: [...assembly.piTools],
        cwd,
        systemPrompt: taskMaintainerSystemPrompt(options.thresholds),
        // 第一次唤起是新会话；闲置退出、意外退出、换装配之后再唤起接着原会话
        continueSession: true,
        credentials: options.credentials,
        // 联网开关照计划显式给（起草计划时不联网）
        network: assembly.toolkit.network,
        ...(block === undefined ? {} : { contextBlock: block }),
      };
    },
    hostTools: () => setup().hostTools,
    guard: () => setup().guard,
    // 范围审视（18 号票）：装配里带上审视的那一份，压缩时子进程自己做的存成范围记录（写进任务的产出区）
    scopeReview: sessionScopeReview(options.scopeReview, maintainerId, owner),
    canProcess: () => availableTaskActions(current(), "maintainer").includes("work"),
    interject: true,
    vision: options.vision,
    interruptedNote: (quoted) => `上一条输入${quoted ? `「${quoted}」` : ""}处理时中断了，维护者没有接着处理。`,
    ...(options.sessionRewriteFor ? { sessionRewriteFor: options.sessionRewriteFor } : {}),
    ...(options.voiceReplies ? { voiceReplies: options.voiceReplies } : {}),
  });

  return {
    session,
    taskChanged(task, from) {
      if (task.id !== taskId) return;
      // 起草和执行之间、计划变更后工具包变了（14 号票）：换装配（子 agent 的由执行控制器在确认之后叫 subAgents.reassemble）
      const toolkit = taskToolkit(options, task);
      if (executing(task) !== assembled || !sameToolkit(toolkit, assembledToolkit)) {
        assembled = executing(task);
        assembledToolkit = toolkit;
        session.refresh();
      }
      // 用户暂停、取消：中止手头这一轮（排着的输入留在队里）；执行时换上最新的重注入块
      if (executing(task)) followExecutingTask(session, execution, task, from);
      else if ((task.state === "paused" || task.state === "cancelled") && from !== task.state) session.abortTurn();
      session.poke();
    },
  };
}
