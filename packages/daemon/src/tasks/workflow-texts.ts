// 流程（58 号票）交给维护者的话：开始执行的说明（照搬 AgentSense runtime.ts 授权之后的那段：审查改过计划的，
// 要照改过之后的版本做，插进来的步骤也要做）、完成时的说明、重注入块（每次唤起和每次压缩之后注入：计划的步骤、
// 每一步的状态和条件、边界）。纯函数。
import { type PlanToolkit, type Task, TASK_STATE_LABEL, TASK_WAIT_REASON_LABEL, WORKFLOW_STEP_ICON, WORKFLOW_STEP_STATE_LABEL, type WorkflowPlan } from "@ergou/protocol";
import { toolkitText } from "./context-block.ts";
import { EXECUTION_TOOL, WORKFLOW_TOOL } from "./tool-names.ts";
import { plainArgs } from "../guard/index.ts";
import { stepConditionLines, workflowPlanText } from "./workflow-plan.ts";

/** 每开始一步、做完一步怎么汇报（AgentSense 系统提示第 3 条） */
export const REPORT_STEP_RULE = `每开始一个步骤调用 ${WORKFLOW_TOOL.reportStep}(status="in_progress")，完成后调用 ${WORKFLOW_TOOL.reportStep}(status="done", gist=一句话要点)。一个步骤可包含多次同类工具调用（如删多个文件、给多人发消息）。明说不做的步骤用 ${WORKFLOW_TOOL.reportStep}(status="skipped", gist=原因)。`;

/** 每一步要满足的条件（交给维护者的说明里列出来；没有条件的步骤不列） */
function conditionsText(plan: WorkflowPlan): string[] {
  const lines = plan.steps.flatMap((s) => stepConditionLines(s).map((c) => `- ${s.id}：${c}`));
  return lines.length === 0 ? [] : ["每一步要满足的条件（执行时守卫照样检查）：", ...lines];
}

export const workflowNoticeText = {
  /** 授权之后第一次开始执行 */
  started: (task: Pick<Task, "id" | "title">, plan: WorkflowPlan, where: { cwd: string }) => {
    const changed = plan.review.actions.length > 0;
    return [
      `用户已授权计划 v${plan.version}，开始执行流程 ${task.id}「${task.title}」，请按计划执行。工作目录是 ${where.cwd}。`,
      ...(changed
        ? ["计划审查改过这份计划，用户授权的是改过之后的版本，必须照它执行——插进来的步骤即使你认为之前做过也要再做一遍。审查修补后的计划是：", workflowPlanText(plan), "请按这份执行。"]
        : ["计划是：", workflowPlanText(plan)]),
      ...conditionsText(plan),
      REPORT_STEP_RULE,
    ].join("\n");
  },
  /** 步骤都做完或说明跳过了（会话里的一条系统说明） */
  completed: "全部步骤都做完了（或说明跳过），流程完成。",
};

export interface WorkflowContextInput {
  task: Task;
  plan: WorkflowPlan;
  cwd: string;
  /** 执行时真正的工具包 */
  toolkit: PlanToolkit;
}

/** 流程的重注入块：计划的步骤、每一步的状态和条件、边界（计划、进度只在二狗自己的存储里，每次现生成） */
export function workflowContextText(input: WorkflowContextInput): string {
  const { task, plan } = input;
  const states = new Map((task.steps?.list ?? []).map((s) => [s.stepId, s]));
  const done = task.steps?.done ?? 0;
  const lines = [
    "【运行时注入】流程的计划、步骤的进度和条件、边界：每次唤起和每次压缩之后重新给出；计划和进度以这里为准，不靠会话记忆。",
    `流程 ${task.id}「${task.title}」：${TASK_STATE_LABEL[task.state]}${task.waitReason ? `（${TASK_WAIT_REASON_LABEL[task.waitReason]}）` : ""}，已做完 ${done}/${plan.steps.length} 步（计划 v${plan.version}）`,
    `目标：${plan.goal}`,
    "步骤：",
  ];
  for (const s of plan.steps) {
    const state = states.get(s.id);
    const now = state?.state ?? "pending";
    lines.push(
      `- ${WORKFLOW_STEP_ICON[now]} ${s.id}「${s.title}」（${s.tool} ${JSON.stringify(plainArgs(s.args))}）${s.after.length > 0 ? `，在 ${s.after.join("、")} 之后` : ""}：${WORKFLOW_STEP_STATE_LABEL[now]}${state?.gist ? `：${state.gist}` : ""}`,
      ...stepConditionLines(s).map((c) => `  条件：${c}`),
    );
  }
  lines.push(
    "边界：",
    `- 工作目录 ${input.cwd}：文件工具只能写这里；工具包：${toolkitText(input.toolkit)}`,
    `- 按计划的步骤做。${REPORT_STEP_RULE}`,
    `- 执行中不能改步骤：执行中获得的信息使计划需要变化（新增操作、预期之外的情况），用 ${EXECUTION_TOOL.waitForUser} 说明，由用户决定（要改就重新发起）；做不下去用 ${EXECUTION_TOOL.failTask} 写明原因`,
    "- 计划里列了的步骤已经授权，只限步骤里写的参数（不能多带别的参数；通用 bash 只限那条命令；路径按真实路径），次数按步骤数；超出的、对象不确定的、“先问我”类的操作执行时照样问用户。被用户拒绝的操作不要重试，说明之后接着做后面还能做的步骤",
  );
  return lines.join("\n");
}
