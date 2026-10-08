// 维护者此刻的装配（13 号票起执行时按确认的计划；20 号票：子 agent 的装配从它收窄）。
// 维护者执行一个任务时怎么装配只在这里定一次（executionSetup）：任务自己的维护者（maintainers.ts）和项目的维护者
// （projects/maintainers.ts，16 号票：执行的工单段）共用，27 号票改工具包时只改这里。
// 两边的差异由调用方给：工作目录、工具包（项目的任务是任务授权和项目工具包的交集）、围栏、开发类、另加的工具。
import type { HostTool } from "../agent-manager/host-tools.ts";
import { assembledPiTools } from "../agent-manager/agent-manager.ts";
import type { AgentSession, AgentSessionGuard } from "../conversation/agent-session.ts";
import { type GuardAgent, TOOL } from "../guard/index.ts";
import type { MaintainerScope, TaskExecution } from "../tasks/execution.ts";
import { executionTools } from "../tasks/execution-tools.ts";
import type { ShellToolkit, TypedShell } from "../typed-shell/index.ts";

/** 执行时维护者的 pi 内置工具（不算 bash：工具包开了才给） */
export const EXECUTION_PI_TOOLS: readonly string[] = [TOOL.read, TOOL.write, TOOL.edit, TOOL.ls, TOOL.grep, TOOL.find];

export interface MaintainerAssembly {
  /** 维护者的工作目录（真实路径）：子 agent 没给自己的目录时就在这里干活 */
  cwd: string;
  toolkit: ShellToolkit;
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
}

/** 维护者这次真正能用的工具：装配给 pi 的（联网关着时去掉首次使用要下载外部程序的）加上代为执行的；守卫和固定上下文都用这一份 */
export function assembledTools(assembly: MaintainerAssembly): string[] {
  return [...assembledPiTools(assembly.piTools, assembly.toolkit.network), ...assembly.hostTools];
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
  };
}

/** 执行装配要用的几个模块 */
export interface ExecutionSetupDeps {
  execution: TaskExecution;
  typedShell: TypedShell;
  /** 执行时另给维护者的工具（20 号票：提议并行），绑定在它执行的任务上 */
  subAgentTools?: ((scope: MaintainerScope) => HostTool[]) | undefined;
}

/** 维护者执行一个任务时的装配：子 agent 收窄用的那一份、代为执行的工具、守卫看到的会话、重注入块 */
export interface ExecutionSetup {
  assembly: MaintainerAssembly;
  hostTools: HostTool[];
  guard: AgentSessionGuard;
  contextBlock: string | undefined;
}

/**
 * 维护者执行一个任务时的装配：
 * - pi 工具：读写、搜索（EXECUTION_PI_TOOLS），工具包开了 bash 时加 bash；
 * - 代为执行的工具：推进任务的（宣布阶段完成、报告进展……）、提议并行（20），调用方另加的（项目的维护者：向派单方提问、
 *   写这一段的摘要），工具包开了 bash 时的带类型的 bash 工具（28）；
 * - 守卫：调用属于任务（看计划、当前阶段，效果日志和时序规则按任务划范围）；
 * - 重注入块：计划摘要、当前阶段、授权和边界（执行控制器给）。
 */
export function executionSetup(
  deps: ExecutionSetupDeps,
  input: {
    taskId: string;
    maintainerId: string;
    cwd: string;
    toolkit: ShellToolkit;
    /** 审批卡、"交给我做"事项上的来源 */
    source: string;
    projectRecords: readonly string[];
    development: boolean;
    extraTools?: readonly HostTool[];
  },
): ExecutionSetup {
  const scope: MaintainerScope = { taskId: input.taskId, maintainerId: input.maintainerId };
  const toolkit: ShellToolkit = { bash: input.toolkit.bash, network: input.toolkit.network };
  const hostTools = [
    ...executionTools(deps.execution, scope),
    ...(deps.subAgentTools?.(scope) ?? []),
    ...(input.extraTools ?? []),
    ...deps.typedShell.toolsFor({ cwd: input.cwd, toolkit }),
  ];
  const assembly: MaintainerAssembly = {
    cwd: input.cwd,
    toolkit,
    piTools: [...EXECUTION_PI_TOOLS, ...(toolkit.bash ? [TOOL.bash] : [])],
    hostTools: hostTools.map((t) => t.spec.name),
    projectRecords: [...input.projectRecords],
    workingDirs: [input.cwd],
    development: input.development,
  };
  return {
    assembly,
    hostTools,
    guard: { agent: maintainerGuardAgent(input.maintainerId, assembly), source: input.source, segmentId: `${input.maintainerId}:${input.taskId}`, task: () => deps.execution.guardTask(input.taskId) },
    contextBlock: deps.execution.contextBlock(input.taskId),
  };
}

/** 维护者在执行的任务变了：暂停、取消时中止手头这一轮（排着的输入留在队里），换上最新的重注入块 */
export function followExecutingTask(session: AgentSession, execution: Pick<TaskExecution, "contextBlock">, task: { id: string; state: string }, from: string | null): void {
  if ((task.state === "paused" || task.state === "cancelled") && from !== task.state) session.abortTurn();
  const block = execution.contextBlock(task.id);
  if (block !== undefined) session.setContextBlock(block);
}
