// 流程执行时的计划检查接进运行时（59 号票，照搬 AgentSense runtime.ts 里固定计划的 before_tool / after_tool 钩子）：
// - 每次调用在现有的守卫判定之后和授权的那份计划比对（guard/plan-monitor.ts 的 evaluatePlanCall），两道都要过；
//   推进流程的工具（report_step、wait_for_user……，守护进程代为执行的）不是步骤，不比（AgentSense 的 PLANNING_TOOLS）；
// - 执行成功的调用对上了哪一步记成 plan_call_committed（after_tool 里的 monitor.commit），下次判定时按序重放；
// - 用户点过头的判定、每个"工具|步骤"已经自动修过几次只在内存里，按任务和计划的版本记（AgentSense 也一样：
//   approvedState 重建就清零，二狗是守护进程重启）；
// - 每次修回在维护者的会话里记一笔偏离（timeline_record，口径同 14 号票）。
import type { ConversationId } from "@ergou/protocol";
import { buildTimelineRecord, type MessageScope } from "../conversation/messages.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import {
  agentShellEnv,
  comparable,
  CORRECTION_PREFIX,
  evaluatePlanCall,
  findingKey,
  findTool,
  type GuardInput,
  type GuardJudgement,
  judgeToolCall,
  type PlanCheckOutcome,
  type PlanCorrection,
  type PlanExecutedCall,
  type PlanFinding,
  rulesInEffect,
  type TemporalRule,
} from "../guard/index.ts";
import { GUARD_CHANNEL, GUARD_EVENTS, type PlanCallCommittedPayload } from "./events.ts";

/** 审批卡上计划检查要问的那一项叫什么（AgentSense components.tsx 的 REASON_TEXT.deviation） */
export const PLAN_DEVIATION_TITLE = "与已授权的计划不一致";
/** 审批记下的类别里，计划检查要问的那几条的 id 前缀（后面是 findingKey）：事后批准的一次性授权照样按它对上 */
export const PLAN_CATEGORY_PREFIX = "plan:";

/** 被计划检查直接拦下时模型收到的话（AgentSense：说清楚这是硬性拦截，实测模型看到"被拦截"会原样再调一次） */
export const planBlockedText = (reason: string) => `计划检查拦截：${reason}。这一条不会因为重试而通过；改为向用户说明（执行中不能改步骤，要改由用户重新发起）。`;

/** 按计划改回参数时，工具结果前面加的话（AgentSense after_tool：让模型知道实际执行的是哪一版） */
export const rewriteResultPrefix = (c: PlanCorrection) => `${CORRECTION_PREFIX}${c.text}。以下是按计划参数执行的结果：`;

/** 这个流程里已经执行成功的调用（按执行先后）：对上了哪一步 */
export function planHistory(store: EventStore, taskId: string, planId: string): PlanExecutedCall[] {
  return store
    .read(GUARD_CHANNEL, 0, GUARD_EVENTS.planCallCommitted)
    .map((e) => e.payload as PlanCallCommittedPayload)
    .filter((p) => p.taskId === taskId && p.planId === planId)
    .map((p) => ({ tool: p.tool, step: p.stepId }));
}

/** 用户点过头的判定、每个"工具|步骤"已经修过几次：按任务记，换了计划的版本就清零 */
export interface PlanMemory {
  confirmed: Set<string>;
  corrections: Map<string, number>;
}

export function createPlanMemories(): (taskId: string, planId: string) => PlanMemory {
  const byTask = new Map<string, PlanMemory & { planId: string }>();
  return (taskId, planId) => {
    let memory = byTask.get(taskId);
    if (!memory || memory.planId !== planId) byTask.set(taskId, (memory = { planId, confirmed: new Set(), corrections: new Map() }));
    return memory;
  };
}

/** 判定之后和计划比对的结论：哪个任务、哪一版计划 */
export interface PlanChecked {
  taskId: string;
  planId: string;
  outcome: PlanCheckOutcome;
}

const argsOf = (args: unknown): Record<string, unknown> => (typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {});

/**
 * 第一道判完之后：这次调用在执行中的流程里、又是步骤能用的工具（不是代为执行的推进工具），就和计划比对；不用比的是 undefined。
 * 定时触发的流程的每次运行（76 号票）是带着授权的会话段（不算任务的调用），照样比：计划编号按这次运行分开（scheduled-jobs 的 runPlanId），
 * 比对的历史、修过几次都只看这一次
 */
export function checkAgainstPlan(input: GuardInput, judgement: GuardJudgement, store: EventStore, memories: (taskId: string, planId: string) => PlanMemory): PlanChecked | undefined {
  const task = input.task ?? null;
  const workflow = task?.plan.workflow;
  if (!task || !workflow) return undefined;
  const toolName = input.call.toolName;
  if (findTool(input.tools, toolName)?.source === "host") return undefined;
  const memory = memories(task.taskId, workflow.planId);
  // 这次调用里路径的真实路径：判定前现取的环境事实（第一道用的同一份）
  const files = new Map(Object.entries(input.facts.files ?? {}).map(([k, v]) => [comparable(k), v]));
  const outcome = evaluatePlanCall({
    workflow,
    history: planHistory(store, task.taskId, workflow.planId),
    confirmed: memory.confirmed,
    corrections: memory.corrections,
    call: { toolName, args: argsOf(input.call.args) },
    judgement,
    tools: input.tools,
    env: agentShellEnv(input.agent, input.places.homeDir),
    realPathOf: (p) => files.get(comparable(p))?.realPath,
    // 和第一道判的同一批规则（temporal-rules.ts 的 rulesInEffect）
    rules: rulesInEffect({ rules: input.temporalRules ?? [], task, tools: input.tools }) as TemporalRule[],
    // 改了参数重判第一道：同样的环境事实（改的只有不认对象的参数）
    rejudge: (args) => judgeToolCall({ ...input, call: { toolName, args } }),
  });
  return { taskId: task.taskId, planId: workflow.planId, outcome };
}

/** 计划检查要问用户的那几条，记进审批的类别（id 带着判定的身份，事后批准的一次性授权照样对得上） */
export function planCategories(findings: readonly PlanFinding[]): Array<{ id: string; title: string }> {
  return findings.map((f) => ({ id: `${PLAN_CATEGORY_PREFIX}${findingKey(f)}`, title: PLAN_DEVIATION_TITLE }));
}

/** 审批卡上计划检查要问的原因 */
export const planAskReason = (findings: readonly PlanFinding[]) => `${PLAN_DEVIATION_TITLE}：${findings.map((f) => f.message).join("；")}`;

/** 一次自动纠偏在维护者会话的时间线上记一笔偏离：说法是纠偏那一句，详细说明是纠偏前查出的问题 */
export function correctionRecord(conversation: ConversationId, correction: PlanCorrection, scope: MessageScope): NewEvent {
  const detail = correction.findings.map((f) => f.message).join("；");
  return buildTimelineRecord(conversation, { kind: "deviation", summary: `自动纠偏：${correction.text}`, ...(detail ? { detail } : {}) }, scope).event;
}
