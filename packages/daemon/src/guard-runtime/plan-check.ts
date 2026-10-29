// 流程执行时的计划检查接进运行时（59 号票，固定计划的调用前 / 调用后两个钩子）：
// - 每次调用在现有的守卫判定之后和授权的那份计划比对（guard/plan-monitor.ts 的 evaluatePlanCall），两道都要过；
//   推进流程的工具（report_step、wait_for_user……，守护进程代为执行的）不是步骤，不比；
// - 执行成功的调用对上了哪一步记成 plan_call_committed（after_tool 里的 monitor.commit），下次判定时按序重放；
// - 用户点过头的判定、每个"工具|步骤"已经自动修过几次只在内存里，按任务和计划的版本记（守护进程重启
//   就清零）；
// - 每次修回在维护者的会话里记一笔偏离（timeline_record，口径同 14 号票）。
// 153 号票（回退、切换分支之后，授权的计划和已执行的调用都按保留的分支重新算）：
// - 比对的历史只算执行它的会话当前分支上的（planHistory 带上会话：plan_call_committed 前面最后一条会话事件在当前路径上的；那次调用的
//   工具调用记录就在它前面）——会话回退、切换分支之后按保留的分支重建、重放，被放弃那段里做过的不算做过；
// - 撤回、切换时换回了同样内容的那一版（session-follow 的 plan_revised，新的编号）：那一版之前对上的照样算（按实际执行的那版重放）；
// - 用户点过头的、修过几次也跟着分支重来（每次回退、切换都清空）：
//   按会话最新那条 session_branch 的序号分开记。授权项的次数不在这里，照旧从效果日志现算、不随回退清零（用户 2026-10-18 定）。
import { t } from "@ergo/protocol";
import type { ConversationId } from "@ergo/protocol";
import { buildTimelineRecord, type MessageScope } from "../conversation/messages.ts";
import { foreignOnPath, latestBranchSeq } from "../conversation/session-branches.ts";
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
import { TASK_EVENTS, TASKS_CHANNEL, type PlanRevisedPayload } from "../tasks/events.ts";
import { GUARD_CHANNEL, GUARD_EVENTS, type PlanCallCommittedPayload } from "./events.ts";

/** 审批卡上计划检查要问的那一项叫什么 */
export const planDeviationTitle = () => t("guardRuntime.plan.deviation");
/** 审批记下的类别里，计划检查要问的那几条的 id 前缀（后面是 findingKey）：事后批准的一次性授权照样按它对上 */
export const PLAN_CATEGORY_PREFIX = "plan:";

/** 被计划检查直接拦下时模型收到的话（说清楚这是硬性拦截：实测模型看到"被拦截"会原样再调一次） */
export const planBlockedText = (reason: string) => `计划检查拦截：${reason}。这一条不会因为重试而通过；改为向用户说明（执行中不能改步骤，要改由用户重新发起）。`; // @i18n-ignore model
/** 被计划检查直接拦下时工具调用记录上给用户看的（173 号票） */
export const planBlockedSummary = (reason: string) => t("guardRuntime.plan.blocked", { reason });

/** 按计划改回参数时，工具结果前面加的话（让模型知道实际执行的是哪一版） */
export const rewriteResultPrefix = (c: PlanCorrection) => `${CORRECTION_PREFIX}${c.text}。以下是按计划参数执行的结果：`; // @i18n-ignore model

/**
 * 这一版计划和撤回、切换时换回它的各版（plan_revised 的 basePlanId 一路往前）：内容一样，之前对上的照样算（153 号票）。
 * 流程执行中不能改步骤（59 号票），流程的 plan_revised 只有撤回、切换换回的那种
 */
function planLineage(store: EventStore, planId: string): Set<string> {
  const base = new Map(store.read(TASKS_CHANNEL, 0, TASK_EVENTS.planRevised).map((e) => [(e.payload as PlanRevisedPayload).planId, (e.payload as PlanRevisedPayload).basePlanId]));
  const out = new Set<string>();
  for (let id: string | undefined = planId; id !== undefined && !out.has(id); id = base.get(id)) out.add(id);
  return out;
}

/**
 * 这个流程里已经执行成功的调用（按执行先后）：对上了哪一步。给了会话（执行它的维护者的会话频道）就只算这个会话当前分支上的
 * （153 号票：会话回退、切换分支之后按保留的分支重建）
 */
export function planHistory(store: EventStore, taskId: string, planId: string, conversation?: string): PlanExecutedCall[] {
  const plans = planLineage(store, planId);
  const onPath = conversation === undefined ? () => true : foreignOnPath(store, conversation);
  return store
    .read(GUARD_CHANNEL, 0, GUARD_EVENTS.planCallCommitted)
    .filter((e) => {
      const p = e.payload as PlanCallCommittedPayload;
      return p.taskId === taskId && plans.has(p.planId) && onPath(e.globalSeq);
    })
    .map((e) => {
      const p = e.payload as PlanCallCommittedPayload;
      return { tool: p.tool, step: p.stepId };
    });
}

/** 用户点过头的判定、每个"工具|步骤"已经修过几次：按任务记，换了计划的版本、会话回退或切换了分支就清零 */
export interface PlanMemory {
  confirmed: Set<string>;
  corrections: Map<string, number>;
}

/** epoch：执行它的会话最新那条 session_branch 的序号（没回退过是 0；153 号票：回退、切换时重新算） */
export function createPlanMemories(): (taskId: string, planId: string, epoch: number) => PlanMemory {
  const byTask = new Map<string, PlanMemory & { planId: string; epoch: number }>();
  return (taskId, planId, epoch) => {
    let memory = byTask.get(taskId);
    if (!memory || memory.planId !== planId || memory.epoch !== epoch) byTask.set(taskId, (memory = { planId, epoch, confirmed: new Set(), corrections: new Map() }));
    return memory;
  };
}

/** 判定之后和计划比对的结论：哪个任务、哪一版计划、执行它的会话在哪一段分支上（epoch） */
export interface PlanChecked {
  taskId: string;
  planId: string;
  epoch: number;
  outcome: PlanCheckOutcome;
}

const argsOf = (args: unknown): Record<string, unknown> => (typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {});

/**
 * 第一道判完之后：这次调用在执行中的流程里、又是步骤能用的工具（不是代为执行的推进工具），就和计划比对；不用比的是 undefined。
 * 定时触发的流程的每次运行（76 号票）是带着授权的会话段（不算任务的调用），照样比：计划编号按这次运行分开（scheduled-jobs 的 runPlanId），
 * 比对的历史、修过几次都只看这一次
 */
export function checkAgainstPlan(
  input: GuardInput,
  judgement: GuardJudgement,
  store: EventStore,
  memories: (taskId: string, planId: string, epoch: number) => PlanMemory,
  conversation: string | null,
): PlanChecked | undefined {
  const task = input.task ?? null;
  const workflow = task?.plan.workflow;
  if (!task || !workflow) return undefined;
  const toolName = input.call.toolName;
  // 推进流程的工具（代为执行的）、运行时自带的会话里的工具（288 号票：Claude Code 的待办清单、子代理、提问……）不是计划里的步骤，不比
  const source = findTool(input.tools, toolName)?.source;
  if (source === "host" || source === "runtime") return undefined;
  const epoch = conversation === null ? 0 : (latestBranchSeq(store.reader, conversation) ?? 0);
  const memory = memories(task.taskId, workflow.planId, epoch);
  // 这次调用里路径的真实路径：判定前现取的环境事实（第一道用的同一份）
  const files = new Map(Object.entries(input.facts.files ?? {}).map(([k, v]) => [comparable(k), v]));
  const outcome = evaluatePlanCall({
    workflow,
    history: planHistory(store, task.taskId, workflow.planId, conversation ?? undefined),
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
  return { taskId: task.taskId, planId: workflow.planId, epoch, outcome };
}

/** 计划检查要问用户的那几条，记进审批的类别（id 带着判定的身份，事后批准的一次性授权照样对得上） */
export function planCategories(findings: readonly PlanFinding[]): Array<{ id: string; title: string }> {
  return findings.map((f) => ({ id: `${PLAN_CATEGORY_PREFIX}${findingKey(f)}`, title: planDeviationTitle() }));
}

/** 审批卡上计划检查要问的原因 */
export const planAskReason = (findings: readonly PlanFinding[]) => t("guardRuntime.plan.askReason", { title: planDeviationTitle(), findings: findings.map((f) => f.message).join(t("guard.sep")) });

/** 一次自动纠偏在维护者会话的时间线上记一笔偏离：说法是纠偏那一句，详细说明是纠偏前查出的问题 */
export function correctionRecord(conversation: ConversationId, correction: PlanCorrection, scope: MessageScope): NewEvent {
  const detail = correction.findings.map((f) => f.message).join(t("guard.sep"));
  return buildTimelineRecord(conversation, { kind: "deviation", summary: t("guardRuntime.plan.correction", { text: correction.text }), ...(detail ? { detail } : {}) }, scope).event;
}
