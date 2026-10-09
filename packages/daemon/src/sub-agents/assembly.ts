// 子 agent 的装配（规格第 11 节"子 agent"、第 9 节，20 号票）：从派它的维护者此刻的装配收窄，纯函数。
// - 工具包是维护者的子集，在这里保证（不靠调用方守约）：pi 工具照维护者的；代为执行的工具是调用方给的候选
//   （带类型的 bash 工具，工作目录是子 agent 自己的）和维护者的取交集，再去掉维护者推进任务、起草计划、提议并行的工具；
//   bash 和联网开关照维护者的；
// - 守卫看到的是子 agent（kind sub_agent：写项目档案一律拒绝），工作目录是它自己的（worktree，或维护者的工作目录），
//   围栏（项目档案、工作目录）还是维护者的；
// - 守卫看到的任务就是维护者的任务（计划、授权项、效果日志都是任务的），当前阶段换成子 agent 被派去做的那个阶段。
import type { ExecutingAgent, GuardTask } from "../guard/index.ts";
import type { MaintainerAssembly } from "../maintainers/assembly.ts";
import { SUBMIT_PLAN_TOOL } from "../maintainers/tools.ts";
import { EXECUTION_TOOL, PROPOSE_PARALLEL_TOOL, WORKFLOW_TOOL } from "../tasks/tool-names.ts";
import type { ShellToolkit } from "../typed-shell/index.ts";

/** 维护者推进任务、起草计划、提议并行的工具：子 agent 一律没有 */
export const MAINTAINER_ONLY_TOOLS: readonly string[] = [...Object.values(EXECUTION_TOOL), PROPOSE_PARALLEL_TOOL, SUBMIT_PLAN_TOOL, ...Object.values(WORKFLOW_TOOL)];

export interface SubAgentAssembly {
  piTools: string[];
  /** 代为执行的工具的名字：候选里维护者也有、又不是维护者专用的 */
  hostTools: string[];
  toolkit: ShellToolkit;
  /** 守卫看到的子 agent */
  guardAgent: ExecutingAgent;
}

/** 子 agent 的装配。hostTools 是调用方给的候选（开了 bash 时的带类型 bash 工具），收窄到维护者也有的 */
export function subAgentAssembly(maintainer: MaintainerAssembly, sub: { agentId: string; cwd: string; hostTools: readonly string[] }): SubAgentAssembly {
  const piTools = [...maintainer.piTools];
  const hostTools = sub.hostTools.filter((t) => maintainer.hostTools.includes(t) && !MAINTAINER_ONLY_TOOLS.includes(t));
  const toolkit: ShellToolkit = { bash: maintainer.toolkit.bash, network: maintainer.toolkit.network };
  return {
    piTools,
    hostTools,
    toolkit,
    guardAgent: {
      kind: "sub_agent",
      agentId: sub.agentId,
      cwd: sub.cwd,
      toolkit: { ...toolkit, tools: [...piTools, ...hostTools] },
      projectRecords: [...maintainer.projectRecords],
      workingDirs: [...maintainer.workingDirs],
    },
  };
}

/** 子 agent 的调用所属的任务：维护者的任务，当前阶段是子 agent 被派去做的那个（授权只在所属阶段内有效） */
export function subAgentGuardTask(task: GuardTask | null, stageId: string): GuardTask | null {
  return task ? { ...task, currentStageId: stageId } : null;
}
