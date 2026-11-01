// 子 agent 的装配（规格第 11 节"子 agent"、第 9 节，20 号票）：从派它的负责人此刻的装配收窄，纯函数。
// - 工具包是负责人的子集，在这里保证（不靠调用方守约）：pi 工具照负责人的；代为执行的工具是调用方给的候选
//   （带类型的 bash 工具，工作目录是子 agent 自己的；联网搜索、读网页，70 号票；给秘书发消息，102 号票）和负责人的取交集，
//   再去掉负责人推进任务、起草计划、提议并行的工具；
//   bash 和联网开关照负责人的；
// - 守卫看到的是子 agent（kind sub_agent：写项目档案一律拒绝），工作目录是它自己的（worktree，或负责人的工作目录），
//   围栏（项目档案、工作目录）还是负责人的；
// - 守卫看到的任务就是负责人的任务（计划、授权项、效果日志都是任务的），当前阶段换成子 agent 被派去做的那个阶段；
// - 开了 bash 时有自己的临时目录（177 号票）：它工作目录里的 .ergo-tmp，守卫按同样的 TMPDIR、TEMP、TMP 展开，/tmp 照负责人的。
import type { ExecutingAgent, GuardTask } from "../guard/index.ts";
import type { MaintainerAssembly } from "../agent-host/assembly.ts";
import { workTempDir, workTempVars } from "../agent-manager/work-temp.ts";
import { SUBMIT_PLAN_TOOL } from "../maintainers/tools.ts";
import { SEND_ATTACHMENT_TOOL } from "../media/tool-names.ts";
import { REQUEST_SKILL_CHANGE_TOOL } from "../skills/tool-names.ts";
import { EXECUTION_TOOL, PROPOSE_PARALLEL_TOOL, WORKFLOW_TOOL } from "../tasks/tool-names.ts";
import type { ShellToolkit } from "../typed-shell/index.ts";

/**
 * 负责人推进任务、起草计划、提议并行的工具，发附件（117 号票：子 agent 的结果交回负责人，负责人决定发不发），
 * 把 skill 提交进 skill 库（358 号票：要不要沉淀进库由负责人定）：子 agent 一律没有（给秘书发消息有，102 号票：负责人有的它才有）
 */
export const MAINTAINER_ONLY_TOOLS: readonly string[] = [...Object.values(EXECUTION_TOOL), PROPOSE_PARALLEL_TOOL, SUBMIT_PLAN_TOOL, ...Object.values(WORKFLOW_TOOL), SEND_ATTACHMENT_TOOL, REQUEST_SKILL_CHANGE_TOOL];

export interface SubAgentAssembly {
  piTools: string[];
  /** 代为执行的工具的名字：候选里负责人也有、又不是负责人专用的 */
  hostTools: string[];
  toolkit: ShellToolkit;
  /** 守卫看到的子 agent */
  guardAgent: ExecutingAgent;
  /** bash 的临时目录（177 号票）：开了 bash 才有，拉起时交给 agent 管家 */
  tempDir?: string;
}

/** 子 agent 的装配。hostTools 是调用方给的候选（开了 bash 时的带类型 bash 工具、联网搜索和读网页），收窄到负责人也有的 */
export function subAgentAssembly(maintainer: MaintainerAssembly, sub: { agentId: string; cwd: string; hostTools: readonly string[] }): SubAgentAssembly {
  const piTools = [...maintainer.piTools];
  const hostTools = sub.hostTools.filter((t) => maintainer.hostTools.includes(t) && !MAINTAINER_ONLY_TOOLS.includes(t));
  const toolkit: ShellToolkit = { bash: maintainer.toolkit.bash, network: maintainer.toolkit.network };
  const tempDir = toolkit.bash ? workTempDir(sub.cwd) : undefined;
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
      ...(tempDir === undefined ? {} : { shellVars: workTempVars(tempDir) }),
      ...(tempDir === undefined || maintainer.bashTmp === undefined ? {} : { bashTmp: maintainer.bashTmp }),
    },
    ...(tempDir === undefined ? {} : { tempDir }),
  };
}

/** 子 agent 的调用所属的任务：负责人的任务，当前阶段是子 agent 被派去做的那个（授权只在所属阶段内有效） */
export function subAgentGuardTask(task: GuardTask | null, stageId: string): GuardTask | null {
  return task ? { ...task, currentStageId: stageId } : null;
}
