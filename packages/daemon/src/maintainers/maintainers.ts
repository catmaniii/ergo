// 维护者（规格第 3、7、8 节）：12 号票是任务自己的维护者（涉及多个项目或不涉及项目的任务在建卡时产生，id 是 tm-<n>），
// 会话频道是 maintainer:<维护者 id>，里面的消息都带上所属的任务（素材的"任务或项目"取自这里）。
//
// 维护者平时不跑：交给它一条输入 = 往它的会话里追加一条带 taskId 的系统通知（任务书、用户打回计划的意见……），
// 这里看到它的会话里来了消息，就为这个维护者建一个 AgentSession（conversation/agent-session.ts，和秘书共用）：
// 经 agent 管家唤起子进程（名额满了就排队）、接着它会话目录里最近的那个会话（第一次是新会话）、一次处理一条输入；
// 闲置到设定时间子进程退出，再来输入时重新唤起；意外退出时正在处理的那条以"中断"结束、不重送。
// 维护者会话里有消息被彻底删除（21 号票的 messages_purged）时同样建好它的会话，由会话改写会话文件里的原话。
//
// 起草计划时的维护者只能读（read、ls、grep、find）、联网搜索和读网页（70 号票）和"提交计划"（tools.ts）：确认之前不动手不能只靠提示词。
// 工作目录是数据目录输出区里任务自己的一格（outputs/<任务 id>），能联网（只有联网搜索、读网页会联网）；每次工具调用都经守卫（07 号票的接入），
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
// 27 号票：工具包（skill、MCP、bash、联网）变了立即生效——维护者正在干活时等它做完手头这一步（当前的工具调用结束、下一次模型调用之前）
// 就按新工具包重新拉起、接着原会话干，并告诉它"工具包已变更"（AgentSession.reassemble）；闲着、休眠时下次唤起按新工具包；
// 运行时无进展的催促在维护者干活时以插话送达；系统提示里的阈值照配置。
// 范围审视（18 号票，scope-review/ 的 sessionScopeReview）：装配里带审视用的模型、对照物（任务书、计划、审批卡上的批准、
// 用户说的话）和近期范围记录；压缩会话时子进程自己审视，结果存成范围记录（不属于项目的任务：写进任务的产出区）。
// 任务自己的维护者没有工单，只在压缩时审视。
// 涉及多个项目的任务（17 号票）的维护者工具包固定为三样（读项目档案、派工单、汇总回执），起草和执行都是：multi-project.ts。
// 流程（58 号票）：系统提示是流程的那一段（照 AgentSense 固定计划的工作方式）；起草时的工具是 propose_plan（步骤和条件，
// 先审查修补再交给用户授权），执行时推进它的工具是 report_step、转为等我、任务失败（assembly.ts 的 executionSetup）。
// 普通任务（75 号票，tasks/plain.ts）：不涉及项目或涉及多个项目的普通任务的 agent 也在这里（tm-<n>）。一种装配到底（assembly.ts 的
// plainTaskSetup）：读写文件、bash、联网搜索和读网页、助理用的那份 skill（plainToolkit），系统提示是 plain-task.md；
// 调用不属于任务（守卫按普通对话判，受对话审批的开关管），效果日志按"<维护者 id>:plain"这一段划范围。什么时候处理输入同样看任务状态
// （执行中、等我时处理，排队中、做完了的留在队里：做完之后用户接着说，执行控制器先把任务拉回执行中）。
// 定时触发的任务（76 号票，ADR 0025）：运营中时每次运行是触发底座（scheduled-jobs/）交给它的一条通知，各次运行接着同一段会话
// （后面的运行知道前几次做了什么、结果如何；会话长了靠 pi 的压缩）。每次运行是一段：按这一次拉起（守卫的效果日志、时序规则、
// 授权项的次数按"<维护者>:<这次运行>"划范围），换了一次运行就重新拉起，会话照样接着。普通任务照普通任务的装配，多一个
// "报告这次运行失败"；流程按授权的计划装配（jobRunSetup：计划的工具包，守卫按授权的计划逐步核对，不交计划、不推进阶段）。
// 102 号票：工具包里"给秘书发消息"开着的（默认开），起草计划、执行、普通任务、每次运行都多一个 tell_secretary（信上写"长程任务 t-3「…」
// 的维护者"，定时触发的写第几次运行时）；涉及多个项目的任务的维护者工具包固定，只有这一项跟着计划里的开关。
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
  type PlanToolkit,
  sameToolkit,
  taskKind,
  isPlainTask,
  isTriggered,
  type ScheduledJob,
  toolkitChangedNotice,
  canTellSecretary,
  tellSecretaryField,
} from "@ergou/protocol";
import type { AgentManager } from "../agent-manager/agent-manager.ts";
import type { HostTool } from "../agent-manager/host-tools.ts";
import { AgentSession, type QueuedAgentInput } from "../conversation/agent-session.ts";
import { conversationTools, type SessionTools, sessionVoiceReplies } from "../conversation/session-tools.ts";
import type { StreamHub } from "../conversation/stream-hub.ts";
import type { MessageScope } from "../conversation/messages.ts";
import { pendingInputs, startedInputs } from "../conversation/views.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore } from "../events/event-store.ts";
import { BUILTIN_TOOL_REGISTRY, TOOL } from "../guard/index.ts";
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
import { proposePlanTool, type WorkflowExecutor, type WorkflowReviewer } from "../tasks/workflow-tools.ts";
import {
  EXECUTION_PI_TOOLS,
  type ExecutionSetup,
  executionSetup,
  followExecutingTask,
  type MaintainerAssembly,
  maintainerGuardAgent,
  narrowedGuardAgent,
  PLANNING_TOOLKIT,
  plainTaskSetup,
  letterTools,
  skillCommandsOf,
  type ToolkitResources,
  toolkitPiTools,
} from "./assembly.ts";
import type { ConversationApprovals } from "../guard/index.ts";
import { plainToolkit } from "../tasks/plain.ts";
import { type MultiProjectMaintainerTools, multiProjectSetup, multiProjectToolkit } from "./multi-project.ts";
import type { JobRunAssembly } from "./assembly.ts";
import type { PromptRenderer } from "../prompts/index.ts";
import { plainTaskSystemPrompt, taskMaintainerSystemPrompt, workflowMaintainerSystemPrompt } from "./system-prompt.ts";
import { jobRunSetup } from "./assembly.ts";
import { DEFAULT_SCHEDULED_JOB_THRESHOLDS } from "../scheduled-jobs/index.ts";
import { submitPlanTool } from "./tools.ts";
import { type SecretaryLetters, taskSender } from "../secretary/letters.ts";
import { runLabel } from "../scheduled-jobs/texts.ts";

/** 起草计划时维护者的 pi 内置工具：只能读、搜索（70 号票起 grep、find 照给；加上代为执行的"提交计划"、联网搜索和读网页） */
export const PLANNING_PI_TOOLS: readonly string[] = [TOOL.read, TOOL.ls, TOOL.grep, TOOL.find];

export { EXECUTION_PI_TOOLS, PLANNING_TOOLKIT };

/** 任务在执行（有了阶段）：按确认的计划装配 */
const executing = (task: Task | undefined) => task?.stages?.list !== undefined;

/** 定时触发的任务登记好了（运营中）：每次运行按这一次装配（76 号票） */
const operating = (task: Task | undefined) => task !== undefined && task.state === "operating" && isTriggered(task);

/** 装配换不换的依据：起草计划、执行、运营中（定时触发的每次运行） */
const modeOf = (task: Task): "planning" | "executing" | "operating" => (operating(task) ? "operating" : executing(task) ? "executing" : "planning");

/** 定时触发的任务的触发底座（76 号票，scheduled-jobs/）：任务的触发登记、正在运行的那一次、一次运行的装配 */
export interface MaintainerTriggers {
  jobOf(taskId: string): ScheduledJob | undefined;
  currentRun(jobId: string): string | undefined;
  /** 一次运行交给 agent 的那条通知的消息 id：换模型只在一次运行的开头换（83 号票） */
  runNoticeId(runId: string): string | undefined;
  runAssembly(jobId: string, maintainerId: string): JobRunAssembly | undefined;
}

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
  /** 配置里写明的看图能力（79 号票；73 号票起设置页改的优先），键是「provider/模型 id」；没写的按模型目录（实际生效的由子进程报回）。拉起时现取 */
  configuredVision: () => Readonly<Record<string, boolean>>;
  credentials: Record<string, string>;
  timeZone: string;
  /** 带类型的 bash 工具（28）：会话的工具包开了 bash 时随之出现 */
  typedShell: TypedShell;
  /** 阈值（14 号票，配置 tasks.thresholds）：系统提示里照它讲 */
  thresholds: TaskThresholds;
  /** 系统提示的文件（71 号票）：每次唤起时现读 */
  prompts: PromptRenderer;
  /**
   * 测试用：起草计划时维护者会话的工具包（bash、联网开关）；不给时是 PLANNING_TOOLKIT（没有 bash，70 号票起联网开着）。执行时一律照确认的计划（13 号票）。
   * 28 号票的测试靠它给起草中的维护者一个开了 bash 的会话（StartDaemonOptions.maintainerToolkit）
   */
  toolkit?: (maintainerId: string) => ShellToolkit;
  /** 彻底删除之后会话文件要改写哪些原话（记忆模块从删除事件生成） */
  sessionRewriteFor?: (purges: readonly MessagesPurgedEventPayload[]) => Omit<SessionRewriteRequest, "sessionDir">;
  /** 不归这里管的维护者（15 号票：项目的维护者，含任务转为项目后原任务的维护者，由项目模块接） */
  excluded?: (maintainerId: string) => boolean;
  /** 执行时另给维护者的工具（20 号票：提议并行），绑定在它执行的任务上 */
  subAgentTools?: (scope: MaintainerScope) => HostTool[];
  /**
   * 每个会话都配的工具（conversation/session-tools.ts）：联网搜索、读网页（70 号票，起草和执行的每一段都有，联网开关关着时守卫拒绝），
   * 语音回复（32 号票：每一段的装配里多一个口语总结工具，用户发语音时输入后面跟一条说明，回复长又没写总结时追问一句）
   */
  sessionTools?: SessionTools;
  /** 工具包里的 skill、MCP 怎么落进会话，执行时增减 skill 的工具（27 号票） */
  toolkits?: ToolkitResources;
  /** 给秘书发消息（102 号票，secretary/letters.ts）：工具包里开着时动手干活的装配里有 tell_secretary；不给就没有 */
  letters?: SecretaryLetters;
  /** 涉及多个项目的任务（17 号票）：维护者的工具包固定为三样（派单器给），不写文件、不跑 bash、不联网；不给就没有这样的任务 */
  multiProject?: MultiProjectMaintainerTools;
  /**
   * 流程（58 号票）：审查修补流程的维护者交来的计划（daemon.ts 接上守卫的各区、关注类别设置；cwd 是执行它的维护者的工作目录）。
   * 不给就没有 propose_plan 工具（流程起草不了）
   */
  workflowReview?: (task: Task, executor: WorkflowExecutor) => WorkflowReviewer;
  /**
   * 普通任务（75 号票）的 agent 用哪些 skill：助理用的那一份（设置里的 skill 库页勾的，每次唤起现取）；不给就没有 skill
   */
  plainSkills?: () => readonly string[];
  /** 对话审批的开关（70 号票，配置 guard.conversationApprovals）：普通任务的系统提示里工作目录外的说法跟着它；不给按默认（关着） */
  conversationApprovals?: ConversationApprovals;
  /** 定时触发的任务（76 号票）：触发底座在维护者模块之后建，现取；不给就没有定时触发的任务 */
  triggers?: () => MaintainerTriggers | undefined;
  /** 连续失败几次自动暂停（配置 scheduledJobs.jobFailures）：定时触发的任务的系统提示里讲 */
  runFailureLimit?: number;
  /**
   * 换模型时交接摘要的写法（83 号票）：定时触发的任务（76 号票）下一次运行开头新开会话、附交接摘要（和以前定时作业的维护者一样）；
   * 一次运行做到一半、不是定时触发的任务都不换（一个任务一个会话）。不给就不换
   */
  handoffInstructions?: () => string;
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
  /**
   * 这个任务维护者现在的工具包里的 skill 名（82 号票：输入框里打 / 弹出的候选，和装配时一样现取；起草计划时没有）；
   * 不是这里的任务维护者（项目的维护者由项目模块管）时 undefined
   */
  skillsOf(maintainerId: string): readonly string[] | undefined;
  /**
   * 停稳执行这个任务的维护者手头这一轮（84 号票：从某个阶段重做之前，见 AgentSession.stopTurn）：返回放开的函数；
   * 不是这里的任务维护者（项目的维护者由项目模块管）、会话还没建起来时 undefined
   */
  stopTaskTurn(task: Task, how: { timeoutMs: number; reason: string }): Promise<(() => void) | undefined>;
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
          const { task, from, change } = event.payload as TaskEventPayload;
          sessions.get(task.maintainerId)?.taskChanged(task, from, change);
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
    skillsOf(maintainerId) {
      if (options.excluded?.(maintainerId)) return undefined;
      const task = options.tasks.ofMaintainer(maintainerId);
      return task && taskToolkit(options, task).skills;
    },
    async stopTaskTurn(task, how) {
      const session = sessions.get(task.maintainerId);
      if (!session) return undefined;
      const { release } = await session.session.stopTurn(how.timeoutMs, how.reason);
      return release;
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


/**
 * 任务维护者此刻的装配：会话每次唤起算一次（拉起参数、代为执行的工具、守卫都取这一份）；子 agent 从 assemblyOf 现算的一份收窄（20 号票）。
 * cwd 是维护者的工作目录（数据目录输出区里任务自己的一格，真实路径）；任务自己的维护者没有项目档案，
 * 工作目录是 git 仓库时按开发类算。
 * - 执行时：照确认的计划的工具包，装配和项目的维护者共用（assembly.ts 的 executionSetup）；
 * - 起草计划时：只能读（read、ls）和"提交计划"，工具包都关着（测试可以经 options.toolkit 给，开了 bash 时带类型的 bash 工具一起出现）；
 *   调用不属于任务（按对话里的处置判），效果日志和时序规则按"<维护者>:planning"这一段划范围
 */
/**
 * 维护者现在的工具包：执行时照现在生效的计划（14 号票：计划变更确认之前提出的那一版不算；27 号票起含 skill、MCP），
 * 起草计划时是 PLANNING_TOOLKIT（没有 bash、skill、MCP，联网开着）（测试可以经 options.toolkit 给 bash、联网开关）
 */
function taskToolkit(options: MaintainersOptions, task: Task): PlanToolkit {
  // 普通任务（75 号票）：一种装配到底，读写、bash、联网都开着，skill 用助理的那一份（涉及几个项目都一样：它不动项目）
  if (isPlainTask(task)) return plainToolkit(options.plainSkills?.() ?? []);
  // 定时触发的流程（76 号票）：每次运行照授权的计划里的工具包
  if (operating(task)) {
    const planned = options.tasks.confirmedPlan(task.id)?.plan.toolkit;
    return { skills: [...(planned?.skills ?? [])], mcp: [...(planned?.mcp ?? [])], bash: planned?.bash === true, network: planned?.network === true, ...tellSecretaryField(planned === undefined || canTellSecretary(planned)) };
  }
  // 涉及多个项目的任务（17 号票）：固定的那一份，起草和执行都是（计划里的工具包是给各项目维护者做工单的授权，不是它的）
  const fixed = options.multiProject ? multiProjectToolkit(task) : undefined;
  // 给秘书发消息（102 号票）这一项跟着计划里的开关（起草时还没有计划：开着）
  if (fixed) return { ...fixed, skills: [...fixed.skills], mcp: [...fixed.mcp], ...tellSecretaryField(canTellSecretary(options.tasks.confirmedPlan(task.id)?.plan.toolkit ?? {})) };
  if (!executing(task)) return { skills: [], mcp: [], ...(options.toolkit?.(task.maintainerId) ?? PLANNING_TOOLKIT) };
  const planned = options.tasks.confirmedPlan(task.id)?.plan.toolkit;
  return { skills: [...(planned?.skills ?? [])], mcp: [...(planned?.mcp ?? [])], bash: planned?.bash === true, network: planned?.network === true, ...tellSecretaryField(planned === undefined || canTellSecretary(planned)) };
}

/** 定时触发的任务现在正在运行的那一次（没有在运行的是 undefined） */
function runNow(options: MaintainersOptions, task: Task): { jobId: string; runId: string | undefined } | undefined {
  const job = operating(task) ? options.triggers?.()?.jobOf(task.id) : undefined;
  return job && { jobId: job.id, runId: options.triggers?.()?.currentRun(job.id) };
}

function taskSetup(options: MaintainersOptions, task: Task, cwd: string): ExecutionSetup {
  // 定时触发的任务（76 号票）：每次运行一段（"<维护者>:<这次运行>"；不在运行里的——用户在详情里说的——算"<维护者>:operating"）
  const run = runNow(options, task);
  const segmentId = run ? `${task.maintainerId}:${run.runId ?? "operating"}` : undefined;
  const runAssembly = run ? options.triggers?.()?.runAssembly(run.jobId, task.maintainerId) : undefined;
  const failureLimit = options.runFailureLimit ?? DEFAULT_SCHEDULED_JOB_THRESHOLDS.jobFailures;
  // 给秘书发消息时信上写的（102 号票）：哪个任务的维护者，定时触发的写第几次运行时
  const sender = taskSender(task, taskKind(task), maintainerChannel(task.maintainerId), run?.runId === undefined ? undefined : runLabel({ runId: run.runId }));
  // 普通任务（75 号票）：调用不属于任务（守卫看不到计划，按普通对话判），没有推进任务的工具、重注入块；定时触发的多一个"报告这次运行失败"
  if (isPlainTask(task)) {
    return {
      ...plainTaskSetup(options, {
        maintainerId: task.maintainerId,
        cwd,
        toolkit: taskToolkit(options, task),
        source: `普通任务「${task.title}」`,
        segmentId: segmentId ?? `${task.maintainerId}:plain`,
        projectRecords: [],
        development: fs.existsSync(path.join(cwd, ".git")),
        tools: runAssembly?.tools ?? [],
        sender,
        // 临时文件（111 号票）：普通任务、它的每次运行都按这个任务认（项目里的在 projects/maintainers.ts 按项目）
        ownWork: () => options.execution.ownWork(task.id),
      }),
      systemPrompt: plainTaskSystemPrompt(options.prompts, options.conversationApprovals, isTriggered(task) ? { failureLimit } : undefined),
    };
  }
  // 定时触发的流程（76 号票）：授权一次，每次运行按授权的计划装配；守卫按授权的计划逐步核对（每次运行一段），不交计划、不推进阶段
  if (operating(task)) {
    return {
      ...jobRunSetup(options, {
        maintainerId: task.maintainerId,
        cwd,
        toolkit: taskToolkit(options, task),
        source: runAssembly?.source ?? `流程「${task.title}」`,
        segmentId: segmentId ?? `${task.maintainerId}:operating`,
        projectRecords: [],
        development: fs.existsSync(path.join(cwd, ".git")),
        tools: runAssembly?.tools ?? [],
        ...(runAssembly ? { guardTask: runAssembly.guardTask, shellEnv: runAssembly.shellEnv } : {}),
        sender,
        ownWork: () => options.execution.ownWork(task.id),
      }),
      systemPrompt: workflowMaintainerSystemPrompt(options.prompts, options.thresholds, { failureLimit }),
    };
  }
  // 涉及多个项目的任务（17 号票）：工具包固定为三样，起草和执行都是
  if (options.multiProject && multiProjectToolkit(task)) {
    return multiProjectSetup(
      { tasks: options.tasks, execution: options.execution, multiProject: options.multiProject, thresholds: options.thresholds, prompts: options.prompts, sessionTools: options.sessionTools, letters: options.letters },
      { taskId: task.id, maintainerId: task.maintainerId, title: task.title, cwd, executing: executing(task), toolkit: taskToolkit(options, task), sender },
    );
  }
  const development = fs.existsSync(path.join(cwd, ".git"));
  const source = `任务「${task.title}」`;
  const toolkit = taskToolkit(options, task);
  const workflow = taskKind(task) === "workflow";
  if (executing(task)) {
    return executionSetup(options, { taskId: task.id, maintainerId: task.maintainerId, cwd, toolkit, source, projectRecords: [], development, workflow, sender });
  }
  const shell: ShellToolkit = { bash: toolkit.bash, network: toolkit.network };
  // 起草计划的工具：流程是 propose_plan（步骤和条件，先审查修补，58 号票），长程任务是 submit_plan
  const scope = { taskId: task.id, maintainerId: task.maintainerId };
  const planning = workflow
    ? options.workflowReview
      ? [proposePlanTool({ tasks: options.tasks, tools: BUILTIN_TOOL_REGISTRY, review: options.workflowReview(task, { cwd }) }, scope)]
      : []
    : [submitPlanTool(options.tasks, scope)];
  const hostTools = [...planning, ...options.typedShell.toolsFor({ cwd, toolkit: shell }), ...conversationTools(options.sessionTools), ...letterTools(options.letters, toolkit, sender)];
  const assembly: MaintainerAssembly = {
    cwd,
    toolkit: shell,
    skillPaths: [],
    piTools: toolkitPiTools(PLANNING_PI_TOOLS, toolkit),
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
  taskChanged(task: Task, from: Task["state"] | null, change?: TaskEventPayload["change"]): void;
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
  let spawned: ExecutionSetup | undefined;
  const setup = () => spawned ?? taskSetup(options, current(), cwd);
  /** 当前的装配是哪一套（起草、执行、运营中）、按哪个工具包装配的（换的时候 refresh） */
  let assembled = modeOf(first);
  let assembledToolkit = taskToolkit(options, first);
  /** 范围审视的归属：任务（执行时带上当时的阶段） */
  const owner = (): ScopeOwner => ({ ownership: ownershipOf({ maintainerId, taskId }), scope: taskMessageScope(current()) });

  /** 定时触发的任务（76 号票）：这次唤起是按哪一次运行拉起的；换了一次运行就重新拉起（守卫的这一段跟着换），会话照样接着 */
  let spawnedRun: string | undefined;
  /** 第几次唤起（换模型时设置里此刻给它的模型按它取，83 号票） */
  let spawns = 0;
  const runKey = () => {
    const run = runNow(options, current());
    return run ? (run.runId ?? "") : undefined;
  };

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
      spawns = n;
      spawnedRun = runKey();
      spawned = taskSetup(options, current(), cwd);
      const { assembly, contextBlock: block } = spawned;
      return {
        model: options.model(maintainerId, n),
        tools: [...assembly.piTools],
        cwd,
        // 流程的维护者另有一段（58 号票，照 AgentSense 固定计划的工作方式）
        // 定时触发的流程（76 号票）起草时也知道它会按时间表反复运行（triggered-runs 那一段）
        systemPrompt:
          spawned.systemPrompt ??
          (taskKind(current()) === "workflow"
            ? workflowMaintainerSystemPrompt(options.prompts, options.thresholds, isTriggered(current()) ? { failureLimit: options.runFailureLimit ?? DEFAULT_SCHEDULED_JOB_THRESHOLDS.jobFailures } : undefined)
            : taskMaintainerSystemPrompt(options.prompts, options.thresholds)),
        // 第一次唤起是新会话；闲置退出、意外退出、换装配之后再唤起接着原会话
        continueSession: true,
        credentials: options.credentials,
        // 联网开关照计划显式给（起草计划时开着，70 号票）；只加载工具包里的 skill（27 号票）
        network: assembly.toolkit.network,
        skillPaths: [...assembly.skillPaths],
        // 事件触发的流程这次运行的事件的值（77 号票）：只给 bash 起的进程
        ...(assembly.shellEnv ? { shellEnv: assembly.shellEnv } : {}),
        ...(block === undefined ? {} : { contextBlock: block }),
      };
    },
    // 定时触发的任务换了一次运行：按这一次重新拉起（76 号票）
    outdated: () => spawned !== undefined && operating(current()) && spawnedRun !== runKey(),
    hostTools: () => setup().hostTools,
    guard: () => setup().guard,
    // 守卫每次判定按任务此刻的工具包收窄（27 号票）
    guardNow: (agent) => narrowedGuardAgent(agent, taskToolkit(options, current())),
    // 范围审视（18 号票）：装配里带上审视的那一份，压缩时子进程自己做的存成范围记录（写进任务的产出区）
    scopeReview: sessionScopeReview(options.scopeReview, maintainerId, owner),
    canProcess: () => availableTaskActions(current(), "maintainer").includes("work"),
    interject: true,
    configuredVision: options.configuredVision,
    interruptedNote: (quoted) => `上一条输入${quoted ? `「${quoted}」` : ""}处理时中断了，维护者没有接着处理。`,
    ...(options.sessionRewriteFor ? { sessionRewriteFor: options.sessionRewriteFor } : {}),
    ...sessionVoiceReplies(options.sessionTools),
    ...skillCommandsOf(options.toolkits),
    // 任务的会话里没有 /流程、/任务（82 号票：同名的 skill 直接 /目录名 就展开）
    slashConversation: "task",
    // 换模型就新开会话、附交接摘要（83 号票）：只有定时触发的任务、只在一次运行的开头（这次运行的通知交给它之前）换
    ...(options.handoffInstructions
      ? {
          modelSwitch: {
            instructions: options.handoffInstructions,
            allowed: (input: QueuedAgentInput) => {
              const runId = runNow(options, current())?.runId;
              return runId !== undefined && options.triggers?.()?.runNoticeId(runId) === input.messageId;
            },
            wanted: () => options.model(maintainerId, spawns),
          },
        }
      : {}),
  });

  return {
    session,
    taskChanged(task, from, change) {
      if (task.id !== taskId) return;
      // 起草和执行之间：手头这一条处理完换装配；执行中工具包变了（14 号票的计划变更、27 号票的直接改和增减 skill）：
      // 等它做完手头这一步就按新工具包重新拉起、接着干（子 agent 的由执行控制器叫 subAgents.reassemble）
      const toolkit = taskToolkit(options, task);
      if (modeOf(task) !== assembled) {
        assembled = modeOf(task);
        assembledToolkit = toolkit;
        session.refresh();
      } else if (!sameToolkit(toolkit, assembledToolkit)) {
        const before = assembledToolkit;
        assembledToolkit = toolkit;
        session.reassemble(toolkitChangedNotice(before, toolkit, "任务的工具包改了"));
      }
      // 用户暂停、取消、从某个阶段重做（84 号票）：中止手头这一轮（排着的输入留在队里）；执行时换上最新的重注入块
      if (executing(task) && !operating(task)) followExecutingTask(session, execution, task, from, change);
      else if ((task.state === "paused" || task.state === "cancelled") && from !== task.state) session.abortTurn();
      session.poke();
    },
  };
}
