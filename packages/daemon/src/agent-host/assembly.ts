// agent 宿主的装配（127 号票起从 maintainers/assembly.ts 搬来，纯函数；agent-host/host.ts 绑好依赖交给三种维护者）：
// 维护者一次唤起的装配只在这里定——哪种会话（起草计划、执行、普通任务、一次运行、对话段、固定工具包）各一个函数，
// 入口是 assemble(deps, request)：请求只说哪种维护者、哪个 agent、在哪个工作目录、用哪个工具包、哪种会话，加上这种会话自己要的几样。
// 13 号票起执行时按确认的计划；20 号票：子 agent 的装配从它收窄（MaintainerAssembly）。
// 维护者执行一个任务时怎么装配只在这里定一次（executionSetup）：任务自己的维护者（maintainers/maintainers.ts）和项目的维护者
// （projects/maintainers.ts，16 号票：执行的工单段）共用，27 号票改工具包时只改这里。
// 两边的差异由调用方给：工作目录、工具包（项目的任务是任务授权和项目工具包的交集）、围栏、开发类、另加的工具。
// 27 号票：工具包的四样都在这里落进会话——skill 名单经 skill 库解析成目录（宿主协议的 skillPaths：只加载这些，pi 的 noSkills），
// MCP 名单变成守护进程代为执行的 MCP 工具（联网关着时没有要联网的那些），bash 开关决定 bash 和带类型的 bash 工具，
// 联网开关照给；有 skill 时工具白名单一定含 read（skill 靠它读 SKILL.md）。执行时另有"增减 skill"的工具。
// 17 号票：项目维护者做别的任务的维护者派来的改动，也走这里（part：做的是任务的一部分，不推进任务的阶段）；
// 涉及多个项目的任务的维护者是固定工具包（fixedSetup，起草和执行都是）。
// 102 号票：动手干活时（执行任务、做任务的一部分、普通任务、定时运行）工具包里"给秘书发消息"开着的，多一个 tell_secretary
// （secretary/letters.ts），信上写着调用方给的"谁、在做什么"（sender）。
// 117 号票：工具包里"发附件"开着的（默认开）多一个 send_attachment（media/attachment-tools.ts 的 maintainerAttachmentTools），
// 能发工作目录里的文件；tell_secretary 也带上附件参数（同样只在"发附件"开着时）。
// 143 号票：每种会话都有 read_attachment（读本会话里用户发来的附件全文，和秘书的同一个工具，只读、不看工具包），
// 只能读这个维护者自己的会话（maintainerChannel(agentId)）里的附件。
// 128 号票的 agent 贡献：每种会话里"每个会话都配的工具"都经 sessionTools 这一处（联网搜索、读网页和口语总结、发语音），
// 插件给维护者的工具（agent-host/contributions.ts）按请求里的哪种维护者（maintainer）、哪种会话（session）、工具包筛好接在它们后面；
// 每次装配都写明这份装配给谁（ExecutionSetup.target），会话按它取插件的上下文块、钩子订阅（host.ts）。
import { canSendAttachment, canTellSecretary, internalMark, isMcpToolOutside, maintainerChannel, type PlanToolkit, type ProjectInternal, type Task, type TaskChange, taskKind } from "@ergo/protocol";
import type { HostTool } from "../agent-manager/host-tools.ts";
import { workTempDir, workTempVars } from "../agent-manager/work-temp.ts";
import type { AgentContributions, ContributionTarget } from "./contributions.ts";
import type { AgentSession, AgentSessionGuard } from "../conversation/agent-session.ts";
import { conversationTools, type SessionTools } from "../conversation/session-tools.ts";
import type { EventStore } from "../events/event-store.ts";
import { BUILTIN_TOOL_REGISTRY, type GuardAgent, type GuardOwnWork, type GuardTask, type GuardTaskContext, TOOL } from "../guard/index.ts";
import { submitPlanTool } from "../maintainers/tools.ts";
import { maintainerAttachmentTools, readAttachmentTool } from "../media/attachment-tools.ts";
import type { MediaStore } from "../media/media-store.ts";
import { SEND_ATTACHMENT_TOOL } from "../media/tool-names.ts";
import type { LetterSender, SecretaryLetters } from "../secretary/letters.ts";
import { TELL_SECRETARY_TOOL } from "../secretary/letter-texts.ts";
import type { MaintainerScope, TaskExecution } from "../tasks/execution.ts";
import { executionTools } from "../tasks/execution-tools.ts";
import type { TaskService } from "../tasks/tasks.ts";
import { proposePlanTool, type WorkflowExecutor, type WorkflowReviewer, workflowExecutionTools } from "../tasks/workflow-tools.ts";
import type { ShellToolkit, TypedShell } from "../typed-shell/index.ts";
import type { SkillCommand } from "../skills/skill-command.ts";

/** 执行时维护者的 pi 内置工具（不算 bash：工具包开了才给） */
export const EXECUTION_PI_TOOLS: readonly string[] = [TOOL.read, TOOL.write, TOOL.edit, TOOL.ls, TOOL.grep, TOOL.find];

/** 起草计划时维护者的 pi 内置工具：只能读、搜索（70 号票起 grep、find 照给；加上代为执行的"提交计划"、联网搜索和读网页） */
export const PLANNING_PI_TOOLS: readonly string[] = [TOOL.read, TOOL.ls, TOOL.grep, TOOL.find];

/** 项目维护者对话段的 pi 内置工具：读写、搜索项目档案和工作目录（70 号票起 grep、find 照给）；工具包带 bash 时加上 bash */
export const CHAT_PI_TOOLS: readonly string[] = [TOOL.read, TOOL.write, TOOL.edit, TOOL.ls, TOOL.grep, TOOL.find];

/**
 * 起草计划时的工具包：没有 bash；70 号票起能联网（用户 2026-10-10 定"先把功能跑通"：起草时也能查资料——没有 bash、MCP，
 * 会联网的只有联网搜索、读网页）。17 号票：涉及多个项目的任务的维护者一直是它；项目维护者起草计划的工单段、立项书确认之前的对话段也是它
 */
export const PLANNING_TOOLKIT: Readonly<ShellToolkit> = Object.freeze({ bash: false, network: true });

export interface MaintainerAssembly {
  /** 维护者的工作目录（真实路径）：子 agent 没给自己的目录时就在这里干活 */
  cwd: string;
  /** bash、联网开关（子 agent 照它收窄） */
  toolkit: ShellToolkit;
  /** 工具包里的 skill 的目录（经 skillPaths 交给子进程，27 号票） */
  skillPaths: readonly string[];
  /** pi 的内置工具（开了 bash 的含 bash） */
  piTools: readonly string[];
  /** 守护进程代为执行的工具的名字（推进任务的、提议并行、带类型的 bash 工具……）：子 agent 的只能是它们的子集 */
  hostTools: readonly string[];
  /** 守卫的围栏：项目档案（子 agent 写它一律拒绝）、工作目录（含绑定的外部路径） */
  projectRecords: readonly string[];
  workingDirs: readonly string[];
  /**
   * 开发类：并行时每个子 agent 必须有自己的、建在工作目录里的 git worktree。任务自己的维护者没有项目类型，
   * 工作目录是 git 仓库时按开发类算；项目维护者按立项书的项目类型（16 号票）
   */
  development: boolean;
  /**
   * bash 起的进程另带的环境变量（77 号票：事件触发的流程这次运行的事件的值，命令里只引用变量）：经拉起请求交给子进程，
   * 守卫拆命令时按同一份值展开（GuardAgent.shellVars）
   */
  shellEnv?: Readonly<Record<string, string>>;
  /**
   * bash 的临时目录（177 号票，agent-manager/work-temp.ts）：工具包开了 bash 时是工作目录里的 .ergo-tmp。拉起时建好，
   * bash 每条命令前面把 TMPDIR、TEMP、TMP 指到它；守卫拆命令时按同样的值展开
   */
  tempDir?: string;
  /** Git Bash 里 /tmp 挂到的 Windows 目录（守护进程按自己的 TMP / TEMP 算，GuardAgent.bashTmp）：守卫按它解析 /tmp */
  bashTmp?: string;
}

/** bash 的临时目录和 /tmp 挂到哪（177 号票）：工具包开了 bash 才有 */
function shellTemp(deps: Pick<AssemblyDeps, "bashTmp">, cwd: string, bash: boolean): Pick<MaintainerAssembly, "tempDir" | "bashTmp"> {
  return bash ? { tempDir: workTempDir(cwd), ...(deps.bashTmp === undefined ? {} : { bashTmp: deps.bashTmp }) } : {};
}

/** 维护者这次真正能用的工具：装配给 pi 的加上代为执行的；守卫和固定上下文都用这一份 */
export function assembledTools(assembly: MaintainerAssembly): string[] {
  return [...assembly.piTools, ...assembly.hostTools];
}

/**
 * 守卫看到的维护者：工具清单是 assembledTools；bash 带着的已知环境变量是事件的值（77 号票）加上指到临时目录的 TMPDIR、TEMP、TMP
 * （177 号票：命令前面 export 的，盖过进程环境里的），/tmp 挂到哪
 */
export function maintainerGuardAgent(agentId: string, assembly: MaintainerAssembly): GuardAgent {
  const shellVars = { ...assembly.shellEnv, ...(assembly.tempDir === undefined ? {} : workTempVars(assembly.tempDir)) };
  return {
    kind: "maintainer",
    agentId,
    cwd: assembly.cwd,
    toolkit: { ...assembly.toolkit, tools: assembledTools(assembly) },
    projectRecords: [...assembly.projectRecords],
    workingDirs: [...assembly.workingDirs],
    ...(Object.keys(shellVars).length > 0 ? { shellVars } : {}),
    ...(assembly.bashTmp === undefined ? {} : { bashTmp: assembly.bashTmp }),
  };
}

/**
 * 守卫按此刻的工具包判（27 号票）：拉起时的视角收窄到现在的工具包——之后去掉的 bash、联网、MCP、给秘书发消息（102 号票）、
 * 发附件（117 号票），子进程重新装配之前的下一次判定就用不到（正在等审批的调用被批准时也重判）；之后加上的要等重新装配、
 * 会话里有了才算。skill 不是权限，不影响判定
 */
export function narrowedGuardAgent(agent: GuardAgent, now: Pick<PlanToolkit, "bash" | "network" | "mcp" | "tellSecretary" | "sendAttachment">): GuardAgent {
  const tools = agent.toolkit.tools?.filter(
    (name) => !isMcpToolOutside(name, now.mcp) && (name !== TELL_SECRETARY_TOOL || canTellSecretary(now)) && (name !== SEND_ATTACHMENT_TOOL || canSendAttachment(now)),
  );
  return { ...agent, toolkit: { ...agent.toolkit, bash: agent.toolkit.bash && now.bash, network: agent.toolkit.network && now.network, ...(tools ? { tools } : {}) } };
}

/** 工具包里的 skill、MCP 怎么落进会话（27 号票，toolkit/ 给） */
export interface ToolkitResources {
  /** skill 名 → 目录（skill 库里没有的不在里面） */
  skillPaths(names: readonly string[]): string[];
  /** 会话里的 MCP 工具（工具包列了的，联网关着时去掉要联网的） */
  mcpTools(toolkit: Pick<PlanToolkit, "mcp" | "network">): HostTool[];
  /** 执行时维护者增减 skill 的工具（绑定在它执行的任务上） */
  skillTool?(scope: MaintainerScope): HostTool;
  /** 执行时维护者登记 MCP 的工具（加、改、删一条登记，出卡等用户确认，239 号票；绑定在它执行的任务上） */
  mcpChangeTool?(scope: MaintainerScope): HostTool;
  /** 库里每个 skill 的斜杠命令（82 号票）：用户打 /目录名 时展开会话装配了的那个；不给就按装配的目录自己算 */
  skillCommands?(): readonly SkillCommand[];
}

/** 交给会话（AgentSession）的斜杠命令（82 号票）：工具包给了 skillCommands 时带上 */
export function skillCommandsOf(toolkits: Pick<ToolkitResources, "skillCommands"> | undefined): { skillCommands?: () => readonly SkillCommand[] } {
  const table = toolkits?.skillCommands;
  return table ? { skillCommands: () => table.call(toolkits) } : {};
}

/** 装配要用的几个模块（agent 宿主建一次、绑好，各种会话的装配都从这里取） */
export interface AssemblyDeps {
  /** 任务（起草计划时交计划的工具、固定工具包起草时的"提交计划"） */
  tasks: TaskService;
  execution: TaskExecution;
  typedShell: TypedShell;
  /** 执行时另给维护者的工具（20 号票：提议并行），绑定在它执行的任务上 */
  subAgentTools?: ((scope: MaintainerScope) => HostTool[]) | undefined;
  /** 每个会话都配的工具（联网搜索、读网页 70 号票，口语总结 32 号票）：每一段都有；不给就没有 */
  sessionTools?: SessionTools | undefined;
  /** agent 贡献（128 号票）：插件给维护者的工具，按这份装配给谁筛好接在每个会话都配的工具后面；不给就没有 */
  contributions?: Pick<AgentContributions, "toolsFor"> | undefined;
  /** 工具包里的 skill、MCP（27 号票）；不给就当工具包里没有 skill 和 MCP */
  toolkits?: ToolkitResources | undefined;
  /** 给秘书发消息的工具（102 号票）：工具包里开着、调用方给了 sender 时才有；不给就没有 */
  letters?: SecretaryLetters | undefined;
  /** 媒体库（117 号票）：工具包里"发附件"开着时有 send_attachment、tell_secretary 带附件参数；不给就没有 */
  media?: MediaStore | undefined;
  /** 事件存储（143 号票）：和媒体库一起给了，每种会话都有 read_attachment（按会话里出现过的附件找）；不给就没有 */
  store?: EventStore | undefined;
  /**
   * 流程（58 号票；64 号票起项目的维护者也起草流程）：审查修补维护者交来的流程计划（daemon.ts 接上守卫的各区、关注类别设置）。
   * 不给就没有 propose_plan（流程起草不了）
   */
  workflowReview?: ((task: Task, executor: WorkflowExecutor) => WorkflowReviewer) | undefined;
  /** Git Bash 里 /tmp 挂到的 Windows 目录（177 号票，agent-manager/work-temp.ts 的 bashTmpMount）：不给时守卫照旧按没法确定判 /tmp */
  bashTmp?: string | undefined;
}

/** 三种维护者（agent 宿主的三种配置）：任务自己的（tm-<n>）、项目的、定时作业自己的（jm-<n>，76 号票之前的作业） */
export type MaintainerKind = "task" | "project" | "job";

/**
 * 哪种会话（装配按它分；128 号票的 agent 贡献也按它筛）：
 * - planning 起草计划：任务自己的维护者起草时、项目维护者起草计划的工单段——只读，交计划；
 * - execution 执行：照确认的计划动手——任务自己的维护者执行时、项目维护者执行的工单段和别的任务的维护者派来的改动（part）、流程；
 * - plain 普通任务（75 号票）：一种装配到底，调用不属于任务；
 * - run 一次运行（19、76 号票）：定时触发的流程、迁移来的定时作业、项目维护者定时运行的工单段；
 * - chat 对话段（16 号票）：项目维护者直接和用户说话（含立项问答）；
 * - fixed 固定工具包（17 号票）：涉及多个项目的任务的维护者，起草和执行都是
 */
export type HostedSessionKind = "planning" | "execution" | "plain" | "run" | "chat" | "fixed";

/** 每种会话都要说的：哪种维护者、哪个 agent、在哪个工作目录、用哪个工具包，审批卡上的来源 */
interface AssemblyBase {
  /** 哪种维护者 */
  maintainer: MaintainerKind;
  /** 哪个 agent（维护者 id） */
  agentId: string;
  /** 在哪个工作目录（真实路径） */
  cwd: string;
  /** 用哪个工具包（这一段现在生效的） */
  toolkit: PlanToolkit;
  /** 审批卡、"交给我做"事项上的来源 */
  source: string;
  /** 项目内部任务（64 号票）：这些事项带上标记 */
  internal?: ProjectInternal | undefined;
  /** 给秘书发消息时信上写的谁、在做什么（102 号票）；不给就没有这个工具 */
  sender?: LetterSender | undefined;
  /**
   * 守卫认任务、项目自己的临时文件要的（111 号票）；不给的：执行时按执行的任务认，别的没有。
   * 项目的维护者每一段都按项目认（projects/maintainers.ts）
   */
  ownWork?: (() => GuardOwnWork | null) | undefined;
}

/** 有工作目录要守的会话：围栏里的项目档案、是不是开发类 */
interface FencedAssembly extends AssemblyBase {
  projectRecords: readonly string[];
  development: boolean;
}

/** 起草计划：交计划的工具按任务的做法（流程是 propose_plan，长程任务是 submit_plan），调用不属于任务 */
export interface PlanningRequest extends FencedAssembly {
  session: "planning";
  taskId: string;
  /** 效果日志、时序规则按这一段划范围 */
  segmentId: string;
  /** 流程计划审查时执行它的维护者在守卫眼里的样子（58、64 号票） */
  executor: WorkflowExecutor;
  /** 交计划的工具后面另加的（项目的维护者：写回进展、向派单方提问、写这一段的摘要） */
  extraTools?: readonly HostTool[];
}

/** 执行：照确认的计划，见 executionSetup */
export interface ExecutionRequest extends FencedAssembly {
  session: "execution";
  taskId: string;
  extraTools?: readonly HostTool[];
  /** 做的只是任务的一部分（17 号票）：所属阶段 */
  part?: { stageId: string };
  /** 执行的是流程（58 号票）：推进它的工具是汇报步骤、转为等我、任务失败，没有阶段、计划变更、并行、增减 skill 的工具 */
  workflow?: boolean;
}

/** 普通任务：见 plainTaskSetup */
export interface PlainRequest extends FencedAssembly {
  session: "plain";
  segmentId: string;
  tools: readonly HostTool[];
}

/** 一次运行：见 jobRunSetup */
export interface RunRequest extends FencedAssembly {
  session: "run";
  segmentId: string;
  tools: readonly HostTool[];
  guardTask?: ((ctx?: GuardTaskContext) => GuardTask | null) | undefined;
  /** 这次运行 bash 另带的环境变量（77 号票） */
  shellEnv?: Readonly<Record<string, string>> | undefined;
}

/** 对话段：见 chatSetup */
export interface ChatRequest extends FencedAssembly {
  session: "chat";
  segmentId: string;
  /** 对话段自己的工具（提交立项书、改立项要求、写这一段的摘要、发起项目内部任务） */
  tools: readonly HostTool[];
  /** 排在 MCP 工具后面的（立项书确认之后：增减 skill、申请工具包变更） */
  after: readonly HostTool[];
}

/** 固定工具包的几样（17 号票：派单器给，绑定在任务上） */
export interface FixedTools {
  /** 固定工具包：读项目档案、派工单、汇总回执 */
  tools(scope: MaintainerScope): HostTool[];
  /** 执行时另加的：回答项目维护者（算"派工单"那一样的工单往来）、转问用户（运行时控制） */
  executionTools(scope: MaintainerScope): HostTool[];
}

/** 固定工具包：见 fixedSetup */
export interface FixedRequest extends AssemblyBase {
  session: "fixed";
  taskId: string;
  /** 任务在执行（有了阶段）：调用属于任务、带重注入块 */
  executing: boolean;
  fixed: FixedTools;
}

/** agent 宿主的装配请求（小接口）：哪种会话决定还要哪几样 */
export type AssemblyRequest = PlanningRequest | ExecutionRequest | PlainRequest | RunRequest | ChatRequest | FixedRequest;

/** pi 的内置工具：给的这些，开了 bash 加 bash，有 skill 时一定含 read（skill 靠它读 SKILL.md） */
function toolkitPiTools(base: readonly string[], toolkit: Pick<PlanToolkit, "bash" | "skills">): string[] {
  return [...new Set([...base, ...(toolkit.bash ? [TOOL.bash] : []), ...(toolkit.skills.length > 0 ? [TOOL.read] : [])])];
}

/** 工具包里的 skill 和 MCP 落进会话的样子：skill 的目录（库里有的）、MCP 工具 */
function toolkitParts(resources: ToolkitResources | undefined, toolkit: PlanToolkit): { skillPaths: string[]; mcpTools: HostTool[] } {
  if (!resources) return { skillPaths: [], mcpTools: [] };
  return { skillPaths: resources.skillPaths(toolkit.skills), mcpTools: resources.mcpTools(toolkit) };
}

/** 维护者一次唤起的装配：子 agent 收窄用的那一份、代为执行的工具、守卫看到的会话、重注入块（执行时才有） */
export interface ExecutionSetup {
  assembly: MaintainerAssembly;
  hostTools: HostTool[];
  guard: AgentSessionGuard;
  contextBlock: string | undefined;
  /** 这份装配给谁（128 号票）：哪种维护者、哪个 agent、哪种会话、工具包——插件的工具已按它筛进 hostTools，上下文块、钩子订阅也按它取 */
  target: ContributionTarget;
}

/** 一次装配给谁（128 号票）：插件的贡献按它筛 */
export function contributionTarget(request: Pick<AssemblyBase, "maintainer" | "agentId" | "toolkit"> & { session: HostedSessionKind }): ContributionTarget {
  return { agent: request.maintainer, agentId: request.agentId, session: request.session, toolkit: request.toolkit };
}

/** 按哪种会话装配（agent 宿主的 assemble 绑好 deps 后就是它） */
export function assemble(deps: AssemblyDeps, request: AssemblyRequest): ExecutionSetup {
  switch (request.session) {
    case "planning":
      return planningSetup(deps, request);
    case "execution":
      return executionSetup(deps, request);
    case "plain":
      return plainTaskSetup(deps, request);
    case "run":
      return jobRunSetup(deps, request);
    case "chat":
      return chatSetup(deps, request);
    case "fixed":
      return fixedSetup(deps, request);
  }
}

/**
 * 每个会话都配的工具（联网搜索、读网页 70 号票，口语总结、发语音 32、86 号票）：各种会话的装配都经这一处。
 * 插件给维护者的工具（128 号票）按这份装配给谁（哪种维护者、哪种会话、工具包）筛好接在它们后面。
 * bash：这份装配有没有 bash（162 号票：联网工具的说明据此提不提 agent-browser）
 */
function sessionTools(deps: Pick<AssemblyDeps, "sessionTools" | "contributions">, target: ContributionTarget, bash: boolean): HostTool[] {
  return [...conversationTools(deps.sessionTools, { bash }), ...(deps.contributions?.toolsFor(target) ?? []), ...(deps.contributions?.toolsFor(target, "end") ?? [])];
}

/**
 * 维护者执行一个任务时的装配：
 * - pi 工具：读写、搜索（EXECUTION_PI_TOOLS），工具包开了 bash 时加 bash；
 * - skill：工具包里列的（经 skillPaths，27）；
 * - 代为执行的工具：推进任务的（宣布阶段完成、报告进展……）、提议并行（20），调用方另加的（项目的维护者：向派单方提问、
 *   写这一段的摘要），工具包开了 bash 时的带类型的 bash 工具（28），联网搜索和读网页（70），工具包里 MCP 的工具和增减 skill 的工具（27），口语总结（32）；
 * - 守卫：调用属于任务（看计划、当前阶段，效果日志和时序规则按任务划范围）；
 * - 重注入块：计划摘要、当前阶段、授权和边界（执行控制器给）。
 * 做的只是任务的一部分时（part，17 号票：别的任务的维护者派来的改动）：不推进任务的阶段（没有推进任务的工具、提议并行、
 * 增减 skill、重注入块，要做的改动在固定上下文里），守卫看到的当前阶段是这一部分所属的阶段（授权项只在所属阶段内有效）。
 */
function executionSetup(deps: AssemblyDeps, input: ExecutionRequest): ExecutionSetup {
  const scope: MaintainerScope = { taskId: input.taskId, maintainerId: input.agentId };
  const { part } = input;
  const workflow = input.workflow === true && !part;
  const advancing = part ? [] : workflow ? workflowExecutionTools(deps.execution, scope) : [...executionTools(deps.execution, scope), ...(deps.subAgentTools?.(scope) ?? [])];
  const extra = input.extraTools ?? [];
  // 调用方自己带来的同名工具就不再补一份（239 号票）：项目维护者执行工单时，`request_mcp_change` 是项目那一份
  // （提的是项目名下的登记，见 projects/maintainers.ts），这里再补一个任务那一份，工具注册表里就重名了
  const provided = new Set(extra.map((tool) => tool.spec.name));
  const { assembly, hostTools } = workAssembly(
    deps,
    input,
    [...advancing, ...extra],
    // 增减 skill 改的是任务的工具包：做的只是任务的一部分时没有（17 号票）；流程的工具包按步骤定，也没有（58 号票）。
    // 登记 MCP（239 号票）同样只给不是一部分、不是流程的执行会话
    !part && !workflow && deps.toolkits
      ? [...(deps.toolkits.skillTool ? [deps.toolkits.skillTool(scope)] : []), ...(deps.toolkits.mcpChangeTool ? [deps.toolkits.mcpChangeTool(scope)] : [])].filter(
          (tool) => !provided.has(tool.spec.name),
        )
      : [],
  );
  /** 守卫看到的任务：做一部分时当前阶段换成所属的阶段 */
  const guardTask = () => {
    const task = deps.execution.guardTask(input.taskId);
    return task && part ? { ...task, currentStageId: part.stageId } : task;
  };
  return {
    assembly,
    hostTools,
    guard: {
      agent: maintainerGuardAgent(input.agentId, assembly),
      source: input.source,
      ...internalMark(input.internal),
      segmentId: `${input.agentId}:${input.taskId}`,
      task: guardTask,
      // 临时文件（111 号票）：按这个任务认（项目的维护者执行的按项目，调用方给 ownWork）
      ownWork: input.ownWork ?? (() => deps.execution.ownWork(input.taskId)),
    },
    contextBlock: part ? undefined : deps.execution.contextBlock(input.taskId),
    target: contributionTarget(input),
  };
}

/**
 * 给秘书发消息的工具（102 号票）：工具包里开着、给了 sender 才有。给了 cwd、工具包里"发附件"也开着的（117 号票），
 * 能带上工作目录里的文件作为附件
 */
function letterTools(letters: SecretaryLetters | undefined, toolkit: Pick<PlanToolkit, "tellSecretary" | "sendAttachment">, sender: LetterSender | undefined, cwd?: string): HostTool[] {
  if (!letters || !sender || !canTellSecretary(toolkit)) return [];
  return [letters.tool(sender, cwd !== undefined && canSendAttachment(toolkit) ? cwd : undefined)];
}

/**
 * 读附件（143 号票）：和秘书的同一个工具（只读、幂等，不落入任何关注类别），只能读这个维护者自己的会话里的附件；
 * 不看工具包（读的是用户发进来的东西，没有对外效果）。给了媒体库和事件存储才有
 */
function readAttachmentTools(deps: Pick<AssemblyDeps, "media" | "store">, agentId: string): HostTool[] {
  return deps.media && deps.store ? [readAttachmentTool({ store: deps.store, media: deps.media, conversation: maintainerChannel(agentId) })] : [];
}

/**
 * 维护者每一段都有的三样：给秘书发消息（102 号票，带附件 117 号票；工具包里开着时）、读附件（143 号票）、
 * 发附件（117 号票；工具包里开着时）
 */
function fixedMaintainerTools(deps: Pick<AssemblyDeps, "letters" | "media" | "store">, input: Pick<AssemblyBase, "agentId" | "toolkit" | "sender" | "cwd">): HostTool[] {
  return [...letterTools(deps.letters, input.toolkit, input.sender, input.cwd), ...readAttachmentTools(deps, input.agentId), ...maintainerAttachmentTools(deps.media, input.toolkit, input.cwd)];
}

/** 守卫看到的会话（不属于任务的那几种）：agent、来源、项目内部的标记、这一段、自己的临时文件 */
function segmentGuard(input: Pick<AssemblyBase, "agentId" | "source" | "internal" | "ownWork"> & { segmentId: string }, assembly: MaintainerAssembly): AgentSessionGuard {
  return {
    agent: maintainerGuardAgent(input.agentId, assembly),
    source: input.source,
    ...internalMark(input.internal),
    segmentId: input.segmentId,
    ...(input.ownWork ? { ownWork: input.ownWork } : {}),
  };
}

/**
 * 动手干活时的装配（执行任务、做任务的一部分、定时作业的一次运行共用）：pi 工具是读写、搜索（EXECUTION_PI_TOOLS），
 * 工具包开了 bash 时加 bash、有 skill 时一定含 read；skill 经 skillPaths（27）；代为执行的工具是调用方给的（tools 在前、
 * after 在后），中间是带类型的 bash 工具（工具包开了 bash 时）、联网搜索和读网页（70）、口语总结（32）、工具包里 MCP 的工具（27）、
 * 给秘书发消息（102，工具包里开着的）、读附件（143）、发附件（117，工具包里开着的）
 */
function workAssembly(
  deps: Pick<AssemblyDeps, "typedShell" | "sessionTools" | "contributions" | "toolkits" | "letters" | "media" | "store" | "bashTmp">,
  input: FencedAssembly & { session: HostedSessionKind },
  tools: readonly HostTool[],
  after: readonly HostTool[] = [],
): { assembly: MaintainerAssembly; hostTools: HostTool[] } {
  const toolkit: ShellToolkit = { bash: input.toolkit.bash, network: input.toolkit.network };
  const parts = toolkitParts(deps.toolkits, input.toolkit);
  const hostTools = [
    ...tools,
    ...deps.typedShell.toolsFor({ cwd: input.cwd, toolkit }),
    ...sessionTools(deps, contributionTarget(input), toolkit.bash),
    ...parts.mcpTools,
    ...fixedMaintainerTools(deps, input),
    ...after,
  ];
  const assembly: MaintainerAssembly = {
    cwd: input.cwd,
    toolkit,
    skillPaths: parts.skillPaths,
    piTools: toolkitPiTools(EXECUTION_PI_TOOLS, input.toolkit),
    hostTools: hostTools.map((t) => t.spec.name),
    projectRecords: [...input.projectRecords],
    workingDirs: [input.cwd],
    development: input.development,
    ...shellTemp(deps, input.cwd, toolkit.bash),
  };
  return { assembly, hostTools };
}

/**
 * 一次运行要的（19 号票的定时作业，76 号票起是定时触发的任务的每次运行；触发底座给）：工具包、给执行它的 agent 的工具（报告这次运行失败）、
 * 审批卡上的来源、守卫看到的授权（迁移来的作业：授权项、时序规则、本任务的关注类别；定时触发的流程：授权的计划，逐步核对；
 * 普通任务：没有，按普通对话判；暂停、取消了没有授权项）
 */
export interface JobRunAssembly {
  /**
   * 工具包：迁移来的作业是建它的任务的计划里的，定时触发的流程是授权的计划里的（属于项目的再和项目的取交集）；
   * 定时触发的普通任务不给——任务自己的 agent 用普通任务的那一份，项目的维护者用项目的
   */
  toolkit?: PlanToolkit;
  tools: HostTool[];
  source: string;
  /** 项目内部任务的计划里定的作业（64 号票）：审批卡这些事项带上标记 */
  internal?: ProjectInternal | undefined;
  /** 守卫看到的这次运行的授权：判定时运行时交给它发起调用的 agent（77 号票：事件触发的流程按它推出这次运行的授权） */
  guardTask: (ctx?: GuardTaskContext) => GuardTask | null;
  /** 这次运行 bash 另带的环境变量（77 号票：事件触发的流程这一批事件的值，见 tasks/workflow-events.ts 的 eventShellEnv） */
  shellEnv?: Readonly<Record<string, string>>;
}

/**
 * 定时作业的一次运行的装配（19 号票）：属于项目的作业的工单段、作业自己的维护者共用。和执行任务时同一套动手的装配
 * （workAssembly：工具包里的 skill、MCP 照样落进会话），工具包是作业所在计划的（属于项目的再和项目的取交集，调用方算好），
 * 另加调用方给的工具（报告这次运行失败、项目维护者写这一段的摘要）。没有阶段的工具、增减 skill 和重注入块；调用不属于任务，
 * 守卫按作业的授权判（guardTask，带着授权的会话段：效果日志、时序规则、授权项的次数按 segmentId 划范围，也就是每次运行一段）
 */
function jobRunSetup(deps: AssemblyDeps, input: RunRequest): ExecutionSetup {
  const work = workAssembly(deps, input, input.tools);
  const assembly: MaintainerAssembly = input.shellEnv && Object.keys(input.shellEnv).length > 0 ? { ...work.assembly, shellEnv: input.shellEnv } : work.assembly;
  const { hostTools } = work;
  const guard = {
    agent: maintainerGuardAgent(input.agentId, assembly),
    source: input.source,
    ...internalMark(input.internal),
    segmentId: input.segmentId,
    ...(input.guardTask ? { task: input.guardTask } : {}),
    ...(input.ownWork ? { ownWork: input.ownWork } : {}),
  };
  return { assembly, hostTools, guard, contextBlock: undefined, target: contributionTarget(input) };
}

/**
 * 普通任务（75 号票）的装配：任务自己的 agent、项目的维护者做项目内部的普通任务的工单段共用。和执行任务时同一套动手的装配
 * （workAssembly：读写文件，工具包开了 bash 的有 bash 和带类型的 bash 工具，联网搜索和读网页，工具包里的 skill、MCP，口语总结），
 * 工具包由调用方给（任务自己的 agent 是 tasks/plain.ts 的 plainToolkit，项目的维护者是项目的工具包）。没有推进任务的工具、计划、
 * 重注入块；调用不属于任务——守卫看不到计划和授权（不给 task），按普通对话那一套判，受对话审批的开关管（ADR 0026），
 * 硬拒绝、永不照旧；效果日志、时序规则按 segmentId 划范围
 */
function plainTaskSetup(deps: AssemblyDeps, input: PlainRequest): ExecutionSetup {
  const { assembly, hostTools } = workAssembly(deps, input, input.tools);
  return { assembly, hostTools, guard: segmentGuard(input, assembly), contextBlock: undefined, target: contributionTarget(input) };
}

/**
 * 起草计划时交计划的工具：长程任务是 submit_plan；流程是 propose_plan（步骤和条件，先审查修补，58 号票），
 * 审查时守卫眼里的维护者是执行它的那个（工作目录，项目的维护者另有围栏里的项目档案、项目的工具包）。没有这个任务时按长程任务
 */
function planTools(deps: Pick<AssemblyDeps, "tasks" | "workflowReview">, taskId: string, maintainerId: string, executor: WorkflowExecutor): HostTool[] {
  const task = deps.tasks.get(taskId);
  const scope = { taskId, maintainerId };
  if (!task || taskKind(task) !== "workflow") return [submitPlanTool(deps.tasks, scope)];
  return deps.workflowReview ? [proposePlanTool({ tasks: deps.tasks, tools: BUILTIN_TOOL_REGISTRY, review: deps.workflowReview(task, executor) }, scope)] : [];
}

/**
 * 起草计划时的装配（12 号票；16 号票起项目维护者起草计划的工单段也是它）：只能读（PLANNING_PI_TOOLS：read、ls、grep、find），
 * 代为执行的是交计划的工具、调用方另加的、带类型的 bash 工具（工具包开了 bash 时；测试经 StartDaemonOptions.maintainerToolkit 给）、
 * 每个会话都配的、给秘书发消息和发附件（工具包里开着时）、读附件（143）；没有 skill、MCP。调用不属于任务（按对话里的处置判），
 * 效果日志和时序规则按这一段划范围
 */
function planningSetup(deps: AssemblyDeps, input: PlanningRequest): ExecutionSetup {
  const shell: ShellToolkit = { bash: input.toolkit.bash, network: input.toolkit.network };
  const hostTools = [
    ...planTools(deps, input.taskId, input.agentId, input.executor),
    ...(input.extraTools ?? []),
    ...deps.typedShell.toolsFor({ cwd: input.cwd, toolkit: shell }),
    ...sessionTools(deps, contributionTarget(input), shell.bash),
    ...fixedMaintainerTools(deps, input),
  ];
  const assembly: MaintainerAssembly = {
    cwd: input.cwd,
    toolkit: shell,
    skillPaths: [],
    piTools: toolkitPiTools(PLANNING_PI_TOOLS, input.toolkit),
    hostTools: hostTools.map((t) => t.spec.name),
    projectRecords: [...input.projectRecords],
    workingDirs: [input.cwd],
    development: input.development,
    ...shellTemp(deps, input.cwd, shell.bash),
  };
  return { assembly, hostTools, guard: segmentGuard(input, assembly), contextBlock: undefined, target: contributionTarget(input) };
}

/**
 * 对话段的装配（15、16 号票：项目维护者直接和用户说话，含立项问答）：pi 工具读写、搜索项目档案和工作目录（CHAT_PI_TOOLS），
 * 工具包按项目的（立项书确认之前同起草计划时）；代为执行的依次是对话段自己的（提交立项书、改立项要求、写这一段的摘要、发起项目内部任务）、
 * 带类型的 bash 工具、工具包里 MCP 的工具、调用方排在后面的（增减 skill、申请工具包变更）、每个会话都配的、给秘书发消息、读附件（143）和发附件。
 * 调用不属于任务，效果日志和时序规则按这一段划范围
 */
function chatSetup(deps: AssemblyDeps, input: ChatRequest): ExecutionSetup {
  const shell: ShellToolkit = { bash: input.toolkit.bash, network: input.toolkit.network };
  const parts = toolkitParts(deps.toolkits, input.toolkit);
  const hostTools = [
    ...input.tools,
    ...deps.typedShell.toolsFor({ cwd: input.cwd, toolkit: shell }),
    ...parts.mcpTools,
    ...input.after,
    ...sessionTools(deps, contributionTarget(input), shell.bash),
    ...fixedMaintainerTools(deps, input),
  ];
  const assembly: MaintainerAssembly = {
    cwd: input.cwd,
    toolkit: shell,
    skillPaths: parts.skillPaths,
    piTools: toolkitPiTools(CHAT_PI_TOOLS, input.toolkit),
    hostTools: hostTools.map((t) => t.spec.name),
    projectRecords: [...input.projectRecords],
    workingDirs: [input.cwd],
    development: input.development,
    ...shellTemp(deps, input.cwd, shell.bash),
  };
  return { assembly, hostTools, guard: segmentGuard(input, assembly), contextBlock: undefined, target: contributionTarget(input) };
}

/**
 * 固定工具包的装配（17 号票：涉及多个项目的任务的维护者，起草计划时、执行时）：pi 的内置工具一个都不给，没有 skill、MCP、bash；
 * 代为执行的是固定的三样（读项目档案、派工单、汇总回执），起草时加"提交计划"，执行时加推进阶段的那几个、回答项目维护者、转问用户，
 * 再加每个会话都配的（联网搜索、读网页 70 号票，口语总结 32 号票）、给秘书发消息（102 号票，跟着计划里的开关；不带附件：它不写文件）
 * 和读附件（143 号票：用户在它的会话里发的附件照样读得了全文）。
 * 起草时调用不属于任务（按对话里的处置判）；执行时调用属于任务，带重注入块
 */
function fixedSetup(deps: AssemblyDeps, input: FixedRequest): ExecutionSetup {
  const scope: MaintainerScope = { taskId: input.taskId, maintainerId: input.agentId };
  const runtime = input.executing ? [...executionTools(deps.execution, scope), ...input.fixed.executionTools(scope)] : [submitPlanTool(deps.tasks, scope)];
  const hostTools = [
    ...input.fixed.tools(scope),
    ...runtime,
    // 没有 pi 的内置工具（连 bash 也没有）：用不了 agent-browser
    ...sessionTools(deps, contributionTarget(input), false),
    ...letterTools(deps.letters, input.toolkit, input.sender),
    ...readAttachmentTools(deps, input.agentId),
  ];
  const assembly: MaintainerAssembly = {
    cwd: input.cwd,
    toolkit: { bash: input.toolkit.bash, network: input.toolkit.network },
    // 没有 skill、MCP（27 号票的工具包四样都不开）
    skillPaths: [],
    piTools: [],
    hostTools: hostTools.map((t) => t.spec.name),
    projectRecords: [],
    workingDirs: [input.cwd],
    development: false,
  };
  const agent = maintainerGuardAgent(input.agentId, assembly);
  return {
    assembly,
    hostTools,
    guard: input.executing
      ? { agent, source: input.source, segmentId: `${input.agentId}:${input.taskId}`, task: () => deps.execution.guardTask(input.taskId) }
      : { agent, source: input.source, segmentId: `${input.agentId}:planning` },
    contextBlock: input.executing ? deps.execution.contextBlock(input.taskId) : undefined,
    target: contributionTarget(input),
  };
}

/**
 * 维护者在做的任务变了：暂停、取消时中止手头这一轮（排着的输入留在队里）；从某个阶段重做（84 号票，change 为 rework）之前执行控制器
 * 已经经 stopTaskTurn 停稳了这一轮，到点没停下的这里再中止一次，接着处理重做的通知；换上最新的重注入块
 * （不给 execution 就不换：做的只是任务的一部分，17 号票，没有重注入块）
 */
export function followExecutingTask(
  session: AgentSession,
  execution: Pick<TaskExecution, "contextBlock"> | undefined,
  task: { id: string; state: string },
  from: string | null,
  change?: TaskChange,
): void {
  if (((task.state === "paused" || task.state === "cancelled") && from !== task.state) || change === "rework") session.abortTurn();
  const block = execution?.contextBlock(task.id);
  if (block !== undefined) session.setContextBlock(block);
}
