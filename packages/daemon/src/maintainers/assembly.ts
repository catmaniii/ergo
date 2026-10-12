// 维护者此刻的装配（13 号票起执行时按确认的计划；20 号票：子 agent 的装配从它收窄）。
// 维护者执行一个任务时怎么装配只在这里定一次（executionSetup）：任务自己的维护者（maintainers.ts）和项目的维护者
// （projects/maintainers.ts，16 号票：执行的工单段）共用，27 号票改工具包时只改这里。
// 两边的差异由调用方给：工作目录、工具包（项目的任务是任务授权和项目工具包的交集）、围栏、开发类、另加的工具。
// 27 号票：工具包的四样都在这里落进会话——skill 名单经 skill 库解析成目录（宿主协议的 skillPaths：只加载这些，pi 的 noSkills），
// MCP 名单变成守护进程代为执行的 MCP 工具（联网关着时没有要联网的那些），bash 开关决定 bash 和带类型的 bash 工具，
// 联网开关照给；有 skill 时工具白名单一定含 read（skill 靠它读 SKILL.md）。执行时另有"增减 skill"的工具。
// 17 号票：项目维护者做别的任务的维护者派来的改动，也走这里（part：做的是任务的一部分，不推进任务的阶段）。
// 102 号票：动手干活时（执行任务、做任务的一部分、普通任务、定时运行）工具包里"给秘书发消息"开着的，多一个 tell_secretary
// （secretary/letters.ts），信上写着调用方给的"谁、在做什么"（sender）。
import { canTellSecretary, internalMark, isMcpToolOutside, type PlanToolkit, type ProjectInternal, type TaskChange } from "@ergou/protocol";
import type { HostTool } from "../agent-manager/host-tools.ts";
import type { AgentSession, AgentSessionGuard } from "../conversation/agent-session.ts";
import { conversationTools, type SessionTools } from "../conversation/session-tools.ts";
import { type GuardAgent, type GuardTask, type GuardTaskContext, TOOL } from "../guard/index.ts";
import type { LetterSender, SecretaryLetters } from "../secretary/letters.ts";
import { TELL_SECRETARY_TOOL } from "../secretary/letter-texts.ts";
import type { MaintainerScope, TaskExecution } from "../tasks/execution.ts";
import { executionTools } from "../tasks/execution-tools.ts";
import { workflowExecutionTools } from "../tasks/workflow-tools.ts";
import type { ShellToolkit, TypedShell } from "../typed-shell/index.ts";
import type { SkillCommand } from "../skills/skill-command.ts";

/** 执行时维护者的 pi 内置工具（不算 bash：工具包开了才给） */
export const EXECUTION_PI_TOOLS: readonly string[] = [TOOL.read, TOOL.write, TOOL.edit, TOOL.ls, TOOL.grep, TOOL.find];

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
}

/** 维护者这次真正能用的工具：装配给 pi 的加上代为执行的；守卫和固定上下文都用这一份 */
export function assembledTools(assembly: MaintainerAssembly): string[] {
  return [...assembly.piTools, ...assembly.hostTools];
}

/** 守卫看到的维护者：工具清单是 assembledTools */
export function maintainerGuardAgent(agentId: string, assembly: MaintainerAssembly): GuardAgent {
  return {
    kind: "maintainer",
    agentId,
    cwd: assembly.cwd,
    toolkit: { ...assembly.toolkit, tools: assembledTools(assembly) },
    projectRecords: [...assembly.projectRecords],
    workingDirs: [...assembly.workingDirs],
    ...(assembly.shellEnv ? { shellVars: assembly.shellEnv } : {}),
  };
}

/**
 * 守卫按此刻的工具包判（27 号票）：拉起时的视角收窄到现在的工具包——之后去掉的 bash、联网、MCP、给秘书发消息（102 号票），
 * 子进程重新装配之前的下一次判定就用不到（正在等审批的调用被批准时也重判）；之后加上的要等重新装配、会话里有了才算。
 * skill 不是权限，不影响判定
 */
export function narrowedGuardAgent(agent: GuardAgent, now: Pick<PlanToolkit, "bash" | "network" | "mcp" | "tellSecretary">): GuardAgent {
  const tools = agent.toolkit.tools?.filter((name) => !isMcpToolOutside(name, now.mcp) && (name !== TELL_SECRETARY_TOOL || canTellSecretary(now)));
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
  /** 库里每个 skill 的斜杠命令（82 号票）：用户打 /目录名 时展开会话装配了的那个；不给就按装配的目录自己算 */
  skillCommands?(): readonly SkillCommand[];
}

/** 交给会话（AgentSession）的斜杠命令（82 号票）：工具包给了 skillCommands 时带上 */
export function skillCommandsOf(toolkits: Pick<ToolkitResources, "skillCommands"> | undefined): { skillCommands?: () => readonly SkillCommand[] } {
  const table = toolkits?.skillCommands;
  return table ? { skillCommands: () => table.call(toolkits) } : {};
}

/** 执行装配要用的几个模块 */
export interface ExecutionSetupDeps {
  execution: TaskExecution;
  typedShell: TypedShell;
  /** 执行时另给维护者的工具（20 号票：提议并行），绑定在它执行的任务上 */
  subAgentTools?: ((scope: MaintainerScope) => HostTool[]) | undefined;
  /** 每个会话都配的工具（联网搜索、读网页 70 号票，口语总结 32 号票）：每一段都有；不给就没有 */
  sessionTools?: SessionTools | undefined;
  /** 工具包里的 skill、MCP（27 号票）；不给就当工具包里没有 skill 和 MCP */
  toolkits?: ToolkitResources | undefined;
  /** 给秘书发消息的工具（102 号票）：工具包里开着、调用方给了 sender 时才有；不给就没有 */
  letters?: SecretaryLetters | undefined;
}

/** pi 的内置工具：给的这些，开了 bash 加 bash，有 skill 时一定含 read（skill 靠它读 SKILL.md） */
export function toolkitPiTools(base: readonly string[], toolkit: Pick<PlanToolkit, "bash" | "skills">): string[] {
  return [...new Set([...base, ...(toolkit.bash ? [TOOL.bash] : []), ...(toolkit.skills.length > 0 ? [TOOL.read] : [])])];
}

/** 工具包里的 skill 和 MCP 落进会话的样子：skill 的目录（库里有的）、MCP 工具 */
export function toolkitParts(resources: ToolkitResources | undefined, toolkit: PlanToolkit): { skillPaths: string[]; mcpTools: HostTool[] } {
  if (!resources) return { skillPaths: [], mcpTools: [] };
  return { skillPaths: resources.skillPaths(toolkit.skills), mcpTools: resources.mcpTools(toolkit) };
}

/** 维护者一次唤起的装配：子 agent 收窄用的那一份、代为执行的工具、守卫看到的会话、重注入块（执行时才有） */
export interface ExecutionSetup {
  assembly: MaintainerAssembly;
  hostTools: HostTool[];
  guard: AgentSessionGuard;
  contextBlock: string | undefined;
  /** 系统提示另有一段时（17 号票：涉及多个项目的任务的维护者）；不给是调用方自己的那一段 */
  systemPrompt?: string;
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
export function executionSetup(
  deps: ExecutionSetupDeps,
  input: {
    taskId: string;
    maintainerId: string;
    cwd: string;
    toolkit: PlanToolkit;
    /** 审批卡、"交给我做"事项上的来源 */
    source: string;
    /** 项目内部任务（64 号票）：这些事项带上标记 */
    internal?: ProjectInternal | undefined;
    projectRecords: readonly string[];
    development: boolean;
    extraTools?: readonly HostTool[];
    /** 做的只是任务的一部分（17 号票）：所属阶段 */
    part?: { stageId: string };
    /** 执行的是流程（58 号票）：推进它的工具是汇报步骤、转为等我、任务失败，没有阶段、计划变更、并行、增减 skill 的工具 */
    workflow?: boolean;
    /** 给秘书发消息时信上写的谁、在做什么（102 号票）；不给就没有这个工具 */
    sender?: LetterSender | undefined;
  },
): ExecutionSetup {
  const scope: MaintainerScope = { taskId: input.taskId, maintainerId: input.maintainerId };
  const { part } = input;
  const workflow = input.workflow === true && !part;
  const advancing = part ? [] : workflow ? workflowExecutionTools(deps.execution, scope) : [...executionTools(deps.execution, scope), ...(deps.subAgentTools?.(scope) ?? [])];
  const { assembly, hostTools } = workAssembly(
    deps,
    input,
    [...advancing, ...(input.extraTools ?? [])],
    // 增减 skill 改的是任务的工具包：做的只是任务的一部分时没有（17 号票）；流程的工具包按步骤定，也没有（58 号票）
    !part && !workflow && deps.toolkits?.skillTool ? [deps.toolkits.skillTool(scope)] : [],
  );
  /** 守卫看到的任务：做一部分时当前阶段换成所属的阶段 */
  const guardTask = () => {
    const task = deps.execution.guardTask(input.taskId);
    return task && part ? { ...task, currentStageId: part.stageId } : task;
  };
  return {
    assembly,
    hostTools,
    guard: { agent: maintainerGuardAgent(input.maintainerId, assembly), source: input.source, ...internalMark(input.internal), segmentId: `${input.maintainerId}:${input.taskId}`, task: guardTask },
    contextBlock: part ? undefined : deps.execution.contextBlock(input.taskId),
  };
}

/** 给秘书发消息的工具（102 号票）：工具包里开着、给了 sender 才有 */
export function letterTools(letters: SecretaryLetters | undefined, toolkit: Pick<PlanToolkit, "tellSecretary">, sender: LetterSender | undefined): HostTool[] {
  return letters && sender && canTellSecretary(toolkit) ? [letters.tool(sender)] : [];
}

/**
 * 动手干活时的装配（执行任务、做任务的一部分、定时作业的一次运行共用）：pi 工具是读写、搜索（EXECUTION_PI_TOOLS），
 * 工具包开了 bash 时加 bash、有 skill 时一定含 read；skill 经 skillPaths（27）；代为执行的工具是调用方给的（tools 在前、
 * after 在后），中间是带类型的 bash 工具（工具包开了 bash 时）、联网搜索和读网页（70）、口语总结（32）、工具包里 MCP 的工具（27）、
 * 给秘书发消息（102，工具包里开着的）
 */
function workAssembly(
  deps: Pick<ExecutionSetupDeps, "typedShell" | "sessionTools" | "toolkits" | "letters">,
  input: { cwd: string; toolkit: PlanToolkit; projectRecords: readonly string[]; development: boolean; sender?: LetterSender | undefined },
  tools: readonly HostTool[],
  after: readonly HostTool[] = [],
): { assembly: MaintainerAssembly; hostTools: HostTool[] } {
  const toolkit: ShellToolkit = { bash: input.toolkit.bash, network: input.toolkit.network };
  const parts = toolkitParts(deps.toolkits, input.toolkit);
  const hostTools = [
    ...tools,
    ...deps.typedShell.toolsFor({ cwd: input.cwd, toolkit }),
    ...conversationTools(deps.sessionTools),
    ...parts.mcpTools,
    ...letterTools(deps.letters, input.toolkit, input.sender),
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
export function jobRunSetup(
  deps: Pick<ExecutionSetupDeps, "typedShell" | "sessionTools" | "toolkits" | "letters">,
  input: {
    maintainerId: string;
    cwd: string;
    toolkit: PlanToolkit;
    source: string;
    internal?: ProjectInternal | undefined;
    segmentId: string;
    projectRecords: readonly string[];
    development: boolean;
    tools: readonly HostTool[];
    guardTask?: (ctx?: GuardTaskContext) => GuardTask | null;
    /** 这次运行 bash 另带的环境变量（77 号票） */
    shellEnv?: Readonly<Record<string, string>> | undefined;
    /** 给秘书发消息时信上写的谁、在做什么（102 号票）；不给就没有这个工具 */
    sender?: LetterSender | undefined;
  },
): ExecutionSetup {
  const work = workAssembly(deps, input, input.tools);
  const assembly: MaintainerAssembly = input.shellEnv && Object.keys(input.shellEnv).length > 0 ? { ...work.assembly, shellEnv: input.shellEnv } : work.assembly;
  const { hostTools } = work;
  const guard = { agent: maintainerGuardAgent(input.maintainerId, assembly), source: input.source, ...internalMark(input.internal), segmentId: input.segmentId, ...(input.guardTask ? { task: input.guardTask } : {}) };
  return { assembly, hostTools, guard, contextBlock: undefined };
}

/**
 * 普通任务（75 号票）的装配：任务自己的 agent、项目的维护者做项目内部的普通任务的工单段共用。和执行任务时同一套动手的装配
 * （workAssembly：读写文件，工具包开了 bash 的有 bash 和带类型的 bash 工具，联网搜索和读网页，工具包里的 skill、MCP，口语总结），
 * 工具包由调用方给（任务自己的 agent 是 tasks/plain.ts 的 plainToolkit，项目的维护者是项目的工具包）。没有推进任务的工具、计划、
 * 重注入块；调用不属于任务——守卫看不到计划和授权（不给 task），按普通对话那一套判，受对话审批的开关管（ADR 0026），
 * 硬拒绝、永不照旧；效果日志、时序规则按 segmentId 划范围
 */
export function plainTaskSetup(
  deps: Pick<ExecutionSetupDeps, "typedShell" | "sessionTools" | "toolkits" | "letters">,
  input: {
    maintainerId: string;
    cwd: string;
    toolkit: PlanToolkit;
    source: string;
    internal?: ProjectInternal | undefined;
    segmentId: string;
    projectRecords: readonly string[];
    development: boolean;
    tools: readonly HostTool[];
    /** 给秘书发消息时信上写的谁、在做什么（102 号票）；不给就没有这个工具 */
    sender?: LetterSender | undefined;
  },
): ExecutionSetup {
  const { assembly, hostTools } = workAssembly(deps, input, input.tools);
  return { assembly, hostTools, guard: { agent: maintainerGuardAgent(input.maintainerId, assembly), source: input.source, ...internalMark(input.internal), segmentId: input.segmentId }, contextBlock: undefined };
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
