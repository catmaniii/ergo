// 长程任务的阶段详情要的、守护进程这边才有的几样（84 号票，照 AgentSense web/src/ui/milestone.tsx 的 MilestoneDetail、ReopenDialog
// 和 web/src/agent/milestone/controller.ts 的 reopenPreview；D:\code\claudecode\user_agent_sense_of_security，bedf5a5）：
// - 授权已用几次（AgentSense 的 grantUsage）：和守卫计次同一个口径（guard/grants.ts 的 grantUses：效果日志里本任务、这个阶段、
//   授予之后、同一工具、对象范围之内的）；阶段组的授权项守卫按阶段各算一份（toGuardPlan 的 "<id>@<阶段>"），这里换回计划里的 id；
// - 从这里重做会重开哪些阶段（stages.ts 的 reopenScope）；
// - 这几个阶段这一轮已经做了的事（AgentSense reopenPreview 的 effects）：效果日志里执行成功的、不是只看的，同一件只列一次，
//   分"本机""对外"。AgentSense 按场景的规则把每件事分成能撤回、能补救、收不回；二狗不撤回（真撤回在 85 号票），只按在哪儿生效分：
//   往外送（守卫的 sendsOut，和计划卡授权说法的 outward 同一个口径）是对外，别的动了东西的是本机。"这一轮"是这个阶段上次重开之后
//   判定的调用（效果日志的 reworkNo 不小于阶段的 reopenNo；AgentSense 按 round 只算当前这一轮）：重做之前判定、结束得晚的不算。
//   认不出的工具（守护进程代为执行的二狗自己的工具）不列。
// 纯函数，执行控制器（execution.ts 的 stageView、rework）调用。
import type { StageEffect, Task, TaskStageView } from "@ergou/protocol";
import { nowIso } from "@ergou/protocol";
import { type EffectRecord, findTool, grantUses, type GuardTask, isReadOnlyRequest, READ_ONLY_COMMANDS, sendsOut, type ShellEnv, TOOL, type ToolRegistry } from "../guard/index.ts";
import { summarizeArgs } from "../guard-runtime/describe.ts";
import { findStage, reopenScope, stageStarted } from "./stages.ts";

/** 一件事在哪儿生效：只看（不列）、本机、对外 */
export type EffectReach = "look" | StageEffect["reach"];

const hasValue = (v: unknown) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);

/**
 * 效果日志里的一条在哪儿生效（没登记的工具是 undefined）：
 * - 对外：往外送（sendsOut：会联网，带了请求数据，或者不是只往下拉的——推送、发消息、建远端仓库、非 GET 的请求……）；
 * - 只看：工具登记成只看的、只读的请求、通用 bash 里只看的命令，而且没有写或删的路径；
 * - 本机：别的（写文件、建目录、提交、装依赖、跑脚本……）
 */
export function effectReach(record: Pick<EffectRecord, "tool" | "args">, tools: ToolRegistry): EffectReach | undefined {
  const tool = findTool(tools, record.tool);
  if (!tool) return undefined;
  const args = record.args;
  if (sendsOut(tool, args)) return "external";
  if (record.tool === TOOL.shell_command) return typeof args.program === "string" && READ_ONLY_COMMANDS.includes(args.program) ? "look" : "local";
  const writes = Object.entries(tool.args).some(([name, rule]) => rule.kind === "path" && rule.access !== "read" && hasValue(args[name]));
  if (writes || tool.nature === "modify") return "local";
  return tool.nature === "look" || isReadOnlyRequest(tool, args) ? "look" : "local";
}

/** 这几个阶段这一轮已经做了的事（按先后，同一件只列一次） */
export function stageEffects(task: Task, stageIds: readonly string[], effects: readonly EffectRecord[], tools: ToolRegistry): StageEffect[] {
  const list = task.stages?.list ?? [];
  const since = new Map(stageIds.map((id) => [id, findStage(list, id)?.reopenNo ?? 0]));
  const seen = new Set<string>();
  const out: StageEffect[] = [];
  for (const e of effects) {
    if (e.taskId !== task.id || e.stageId === null || !since.has(e.stageId) || (e.reworkNo ?? 0) < since.get(e.stageId)!) continue;
    const reach = effectReach(e, tools);
    if (reach === undefined || reach === "look") continue;
    const argsSummary = summarizeArgs(e.tool, e.args);
    const key = `${e.tool}\u0000${argsSummary}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const title = findTool(tools, e.tool)?.title;
    out.push({ stageId: e.stageId, tool: e.tool, ...(title === undefined ? {} : { toolTitle: title }), argsSummary, reach, at: nowIso(new Date(e.at)) });
  }
  return out;
}

/** 守卫眼里的授权项 id 换回计划里的：阶段组的授权项按阶段各一份，写成 "<id>@<阶段>" */
const planGrantId = (grantId: string, stageId: string) => (grantId.endsWith(`@${stageId}`) ? grantId.slice(0, -`@${stageId}`.length) : grantId);

/** 阶段详情从守护进程现取的：授权已用几次、从这里重做的范围、这一段已经做了的事 */
export function taskStageView(input: {
  task: Task;
  stageId: string;
  /** 守卫看到的任务（确认的计划、授权的授予时间）；还没开始执行的是 null */
  guardTask: GuardTask | null;
  effects: readonly EffectRecord[];
  tools: ToolRegistry;
  env: ShellEnv;
}): TaskStageView | undefined {
  const { task, stageId, guardTask } = input;
  const list = task.stages?.list ?? [];
  if (!findStage(list, stageId)) return undefined;
  const grants = guardTask ? guardTask.plan.grants.filter((g) => g.stageId === stageId) : [];
  const ctx = guardTask ? { task: guardTask, effectLog: input.effects, tools: input.tools, env: input.env } : undefined;
  const scope = reopenScope(list, stageId, stageStarted);
  return {
    taskId: task.id,
    stageId,
    grantUses: ctx ? grants.map((g) => ({ grantId: planGrantId(g.grantId, stageId), used: grantUses(g, ctx) })) : [],
    reopenScope: scope,
    effects: stageEffects(task, scope, input.effects, input.tools),
  };
}
