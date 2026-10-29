// 时序规则求值的环境：$facts、$agent、$task、$now（$current、$prior 是"一步"，见 rule-steps.ts）。
// 每一项能有哪些字段在这里定义一次，构造环境和规则校验共用。
import type { Env } from "./planguard/expr.ts";
import { agentScope } from "./paths.ts";
import type { EnvironmentFacts, GuardAgent, GuardTask } from "./types.ts";

/** $agent 的字段：kind、agentId、cwd、scope（能碰的范围：项目档案和工作目录，秘书是草稿区） */
export const AGENT_FIELDS = ["kind", "agentId", "cwd", "scope"] as const;
/** $task 的字段（对话里没有 $task） */
export const TASK_FIELDS = ["taskId", "stageId"] as const;
/** $facts 自带的三种事实，每种是一个列表（每行带 path 或 repo）；调用方另给的事实（extra）原样放进去 */
export const FACT_KINDS = ["files", "git", "scripts"] as const;

type RuleAgent = Record<(typeof AGENT_FIELDS)[number], unknown>;
type RuleTask = Record<(typeof TASK_FIELDS)[number], unknown>;
type RuleFacts = Record<(typeof FACT_KINDS)[number], unknown[]>;

export function ruleEnv(agent: GuardAgent, task: GuardTask | null, facts: EnvironmentFacts, now: number): Env {
  const env: Env = { facts: { ...facts.extra, ...ruleFacts(facts) }, agent: ruleAgent(agent), now };
  if (task) env.task = ruleTask(task);
  return env;
}

function ruleFacts(facts: EnvironmentFacts): RuleFacts {
  return {
    files: Object.entries(facts.files ?? {}).map(([path, fact]) => ({ path, ...fact })),
    git: Object.entries(facts.git ?? {}).map(([repo, fact]) => ({ repo, repository: true, ...fact })),
    scripts: Object.entries(facts.scripts ?? {}).map(([path, fact]) => ({ path, ...fact })),
  };
}

function ruleAgent(agent: GuardAgent): RuleAgent {
  return { kind: agent.kind, agentId: agent.agentId, cwd: agent.cwd, scope: agentScope(agent) };
}

function ruleTask(task: GuardTask): RuleTask {
  return { taskId: task.taskId, stageId: task.currentStageId };
}
