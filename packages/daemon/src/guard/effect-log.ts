// 效果日志的记录（规格第 9 节）：只有执行成功的调用才追加。时序规则和授权项计次都只看它。
import { toJson } from "./planguard/expr.ts";
import { normalizeArgs } from "./rule-steps.ts";
import { findTool } from "./tool-registry.ts";
import type { EffectRecord, GuardInput, GuardJudgement, JudgedCall } from "./types.ts";

/**
 * 一次判定放行、执行成功之后，要追加进效果日志的记录。
 * 真实工具调用记它自己；通用 bash 记拆出来的每条伪工具调用。参数是规范化之后、能直接存成 JSON 的形式
 * （推送补上当时的 headCommit）。被拦下或执行失败的调用不追加——由调用方（07 号票的运行时）保证只在执行成功后调用。
 */
export function effectRecordsFor(
  input: Pick<GuardInput, "agent" | "task" | "segmentId" | "tools" | "places" | "facts">,
  judgement: Pick<GuardJudgement, "calls">,
  options: { firstSeq: number; at: number; summary?: (call: JudgedCall) => string },
): EffectRecord[] {
  const env = { cwd: input.agent.cwd, homeDir: input.places.homeDir };
  return judgement.calls.map((call, i) => ({
    seq: options.firstSeq + i,
    taskId: input.task?.taskId ?? null,
    stageId: input.task?.currentStageId ?? null,
    agentId: input.agent.agentId,
    ...(input.segmentId !== undefined ? { segmentId: input.segmentId } : {}),
    tool: call.tool,
    args: toJson(normalizeArgs(call.tool, call.args, input.tools, env, input.facts)) as Record<string, unknown>,
    summary: options.summary?.(call) ?? call.text ?? findTool(input.tools, call.tool)?.title ?? call.tool,
    at: options.at,
  }));
}
