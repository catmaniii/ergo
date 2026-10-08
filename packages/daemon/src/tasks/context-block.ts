// 重注入块（规格第 8 节"重注入块"，13 号票）：每次唤起维护者、每次压缩之后，运行时作为一条上下文消息注入的固定内容——
// 计划摘要 + 当前阶段 + 授权 + 边界。系统提示不变；计划、授权、阶段只存在二狗自己的存储里，这一块每次由它现生成。
// 一个阶段的交代（交付件、验收标准、模式）、授权和时序规则、边界也用在阶段变化时交给维护者的通知里（execution-tools.ts）。
// 纯函数：同样的任务、计划、授权说法，生成同样的文字。
import {
  ACCEPTANCE_METHOD_LABEL,
  type AcceptanceCriterion,
  type GrantInfo,
  grantAuthorizes,
  grantNotAuthorizedLabel,
  grantText,
  type Plan,
  STAGE_STATE_LABEL,
  stagePolicies,
  type Task,
  TASK_STATE_LABEL,
  TASK_WAIT_REASON_LABEL,
  type TaskStage,
  temporalRuleText,
} from "@ergou/protocol";
import { stagePosition } from "./stages.ts";
import { EXECUTION_TOOL } from "./tool-names.ts";

export interface ContextBlockInput {
  task: Task;
  plan: Plan;
  /** 任务书里的目标（计划变更改了目标的，是确认后的新目标，14 号票） */
  goal: string;
  /** 任务书里的验收标准（没有的不写；计划变更改了的是新的） */
  criteria?: readonly string[];
  /** 维护者的工作目录（任务的产出区） */
  cwd: string;
  /** 每项授权在守卫眼里的样子（和计划卡上的说法一样） */
  grantInfo: Readonly<Record<string, GrantInfo>>;
  /** 有子 agent 在做的阶段（20 号票）：当前阶段按维护者最后一次开始的阶段定，这几个不算它手头的 */
  busy?: ReadonlySet<string>;
  /** 当前阶段另写的几行交代（17 号票：涉及多个项目的任务里本阶段发往各项目的工单） */
  notes?: (stageId: string) => readonly string[];
}

/** 一个阶段的状态写法："已验收"、"等我（由我验收）" */
function stageStateText(s: TaskStage): string {
  if (s.state === "waiting" && s.waitReason) return `${STAGE_STATE_LABEL.waiting}（${TASK_WAIT_REASON_LABEL[s.waitReason]}）`;
  return STAGE_STATE_LABEL[s.state];
}

/** 一条验收标准："报告结构完整（评审）"、"测试通过（脚本：npm test，输出里要有「0 failed」）" */
function criterionText(a: AcceptanceCriterion): string {
  if (a.method !== "script" || !a.script) return `${a.criterion}（${ACCEPTANCE_METHOD_LABEL[a.method]}）`;
  const expect = [
    ...(a.expectOutput?.contains === undefined ? [] : [`输出里要有「${a.expectOutput.contains}」`]),
    ...(a.expectOutput?.matches === undefined ? [] : [`输出要匹配 /${a.expectOutput.matches}/`]),
  ];
  return `${a.criterion}（${ACCEPTANCE_METHOD_LABEL[a.method]}：${a.script}${expect.length > 0 ? `，${expect.join("，")}` : ""}）`;
}

/** 一个阶段要交代清楚的：交付件、验收标准、模式 */
export function stageBrief(plan: Plan, stageId: string): string[] {
  const stage = plan.stages.find((s) => s.stageId === stageId);
  if (!stage) return [];
  return [
    `- 交付件：${stage.deliverables.join("；")}`,
    `- 验收标准：${stage.acceptance.map(criterionText).join("；")}`,
    `- 模式：${stage.mode === "steps" ? `定步：${(stage.steps ?? []).join(" → ")}` : "开放"}`,
  ];
}

/** 一个阶段（加上所属阶段组）的授权行和时序规则；不算授权的注明 */
export function stageAuthorization(plan: Plan, stageId: string, grantInfo: Readonly<Record<string, GrantInfo>>): { grants: string[]; rules: string[] } {
  const policies = stagePolicies(plan, stageId);
  return {
    grants: policies.flatMap((p) =>
      p.grants.map((g) => {
        const info = grantInfo[g.id];
        return `${g.title}：${grantText(g, info)}${info && !grantAuthorizes(info) ? `（${grantNotAuthorizedLabel(info)}）` : ""}`;
      }),
    ),
    rules: policies.flatMap((p) => p.temporalRules.map((r) => `${r.title ?? r.id}：${temporalRuleText(r)}`)),
  };
}

/** 工具包的两个开关写成一句："bash 开，联网关"（维护者的边界、交给子 agent 的工作说明共用） */
export function toolkitText(toolkit: { bash: boolean; network: boolean }): string {
  return `bash ${toolkit.bash ? "开" : "关"}，联网${toolkit.network ? "开" : "关"}`;
}

/** 边界：工作目录和工具包、授权和阶段的规矩、怎么推进 */
export function boundaryLines(plan: Plan, cwd: string): string[] {
  return [
    `- 工作目录 ${cwd}：文件工具只能写这里；工具包：${toolkitText(plan.toolkit)}`,
    "- 授权项只在所属阶段内有效，用到别的阶段的授权会被拉回；前置阶段没验收的阶段不能开始；“先问我”类的操作列进了授权项，执行时也照样问用户",
    `- 一个阶段做完调用 ${EXECUTION_TOOL.completeStage} 宣布完成，由运行时验收（脚本、评审、用户），你自检不算验收；进展用 ${EXECUTION_TOOL.reportProgress} 报告；` +
      `卡住要用户拍板用 ${EXECUTION_TOOL.waitForUser}；做不下去用 ${EXECUTION_TOOL.failTask} 写明原因；要换去做另一个能开始的阶段用 ${EXECUTION_TOOL.startStage}`,
    `- 要扩大授权、加能力、加项目、改目标或验收：用 ${EXECUTION_TOOL.proposePlanChange} 提交计划变更（用户确认后生效，只有受影响的阶段停下等）；不扩大授权的调整（拆阶段、调顺序）用 ${EXECUTION_TOOL.revisePlan} 自行调整计划（直接生效）`,
  ];
}

/** 授权、时序规则、边界写成几段（重注入块和阶段变化的通知共用） */
export function authorizationSection(auth: { grants: readonly string[]; rules: readonly string[] }, boundaries: readonly string[]): string[] {
  return [
    "授权（只在当前阶段内有效）：",
    ...(auth.grants.length === 0 ? ["- （没有）"] : auth.grants.map((g) => `- ${g}`)),
    "时序规则：",
    ...(auth.rules.length === 0 ? ["- （没有）"] : auth.rules.map((r) => `- ${r}`)),
    "边界：",
    ...boundaries,
  ];
}

export function contextBlockText(input: ContextBlockInput): string {
  const { task, plan } = input;
  const list = task.stages?.list ?? [];
  const total = plan.stages.length;
  const n = list.length > 0 ? stagePosition(list, task.stages?.focus, input.busy) : 1;
  const focus = list[n - 1] ?? list[0];
  const stage = plan.stages.find((s) => s.stageId === focus?.stageId);
  const lines = [
    "【运行时注入】计划摘要、当前阶段、授权、边界：每次唤起和每次压缩之后重新给出；计划、授权、阶段以这里为准，不靠会话记忆。",
    `任务 ${task.id}「${task.title}」：${TASK_STATE_LABEL[task.state]}${task.waitReason ? `（${TASK_WAIT_REASON_LABEL[task.waitReason]}）` : ""}，第 ${n}/${total} 阶段`,
    `目标：${input.goal}`,
    ...(input.criteria && input.criteria.length > 0 ? [`任务的验收标准：${input.criteria.join("；")}`] : []),
    "阶段：",
    ...list.map((s) => `- ${s.stageId}「${s.title}」：${stageStateText(s)}${s.dependsOn.length > 0 ? `（前置 ${s.dependsOn.join("、")}）` : ""}`),
  ];
  if (stage && focus) lines.push(`当前阶段 ${stage.stageId}「${stage.title}」（${stageStateText(focus)}）`, ...stageBrief(plan, stage.stageId), ...(input.notes?.(stage.stageId) ?? []));
  const auth = stage ? stageAuthorization(plan, stage.stageId, input.grantInfo) : { grants: [], rules: [] };
  lines.push(...authorizationSection(auth, boundaryLines(plan, input.cwd)));
  return lines.join("\n");
}
