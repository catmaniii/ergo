// Claude Code 自带、二狗没装配的工具在守卫工具登记表里的登记（288 号票，AgentRuntime.guardTools，来源 runtime）。
// 用 Claude Code 的维护者的会话：守卫的登记表加上这些、工具包标上 runtimeTools（agent-host/host.ts 的 runtimeGuard），这些不按工具白名单硬拒绝、
// 照这里的登记判；没登记的（用户自己配的 MCP、mcp__*、Claude Code 以后加的工具，还有这里故意没登记的 MCP 资源、定时、worktree 这些）
// 照"未登记的写操作"判。
// 能对上二狗工具的不在这里：Bash、PowerShell、Read、Write、Edit、MultiEdit、NotebookEdit、Glob、Grep、LS、WebFetch、WebSearch 由子进程在
// guard_request 里映射到 bash、read、write、edit、find、grep、ls、web_fetch、web_search（child/guard.ts 的 toGuardCall），守卫照二狗自己的工具判
// （路径围栏、bash 拆开逐条判、联网开关、工具白名单……）。
// 这里登记的都是会话里的事：待办清单、派子代理（子代理里的每次调用另外过守卫）、用技能（技能里跑的命令另外过守卫）、问你（变成二狗的提问卡）、
// 进出计划模式、找工具、看后台任务的输出、停掉它自己起的后台任务——不落入任何关注类别。工具名、参数名照 SDK 0.3.296 的 sdk-tools.d.ts。
import { t } from "@ergo/protocol";
import type { ArgRule, ToolDescriptor } from "../guard/index.ts";

const other: ArgRule = { kind: "other" };
const content: ArgRule = { kind: "content" };

type Untitled = Omit<ToolDescriptor, "title" | "source">;

/** 只看的会话内工具（被打断后可以直接重跑、不改任何东西、不往外送） */
const look = (name: string, args: ToolDescriptor["args"]): Untitled => ({ name, categories: [], args, readOnlyOrIdempotent: true, nature: "look" });

const CLAUDE_TOOLS: Untitled[] = [
  look("TodoWrite", { todos: other }),
  look("TaskCreate", { subject: other, description: other, activeForm: other }),
  look("TaskGet", { taskId: other }),
  look("TaskList", {}),
  look("TaskUpdate", { taskId: other, status: other, subject: other, description: other }),
  // 子代理（它里面的每次调用另外过守卫、另外记录）；Task 是以前的名字
  { name: "Agent", categories: [], args: { description: other, prompt: content, subagent_type: other, model: other, run_in_background: other, name: other, isolation: other } },
  { name: "Task", categories: [], args: { description: other, prompt: content, subagent_type: other } },
  look("Skill", { skill: other, args: other }),
  look("AskUserQuestion", { questions: other }),
  look("ExitPlanMode", { plan: content, allowedPrompts: other }),
  look("EnterPlanMode", {}),
  look("ToolSearch", { query: other, max_results: other }),
  look("TaskOutput", { task_id: other, block: other, timeout: other }),
  look("BashOutput", { bash_id: other, filter: other }),
  // 停掉它自己起的后台任务、后台命令
  { name: "TaskStop", categories: [], args: { task_id: other, shell_id: other }, nature: "modify" },
  { name: "KillShell", categories: [], args: { shell_id: other }, nature: "modify" },
];

/** 登记：名字（给人看的，审批卡、工具调用记录里用）按当前语言现取（key 是 claudeCode.tools.<工具名>） */
export const CLAUDE_GUARD_TOOLS: readonly ToolDescriptor[] = CLAUDE_TOOLS.map(
  (tool) => Object.defineProperty({ ...tool, source: "runtime" }, "title", { enumerable: true, get: () => t(`claudeCode.tools.${tool.name}`) }) as ToolDescriptor,
);
