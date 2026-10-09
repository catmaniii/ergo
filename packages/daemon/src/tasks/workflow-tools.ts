// 流程的维护者的两个工具（58 号票，照搬 AgentSense runtime.ts 的 propose_plan、report_step；守护进程代为执行）：
// - propose_plan（起草时）：交出完整计划（目标、步骤、条件）。先检查（workflow-plan.ts 的 checkWorkflowDraft），再审查修补：
//   审查要求先补充的退回维护者，判定不可执行的让维护者把原因告诉用户；这两种照 AgentSense 也把这版计划显示出来——
//   一张不能授权的流程计划卡（refused）放进待我处理，写明原因和下一步（退回的不卡任务，不可执行的卡着任务等用户决定）；
//   其余的（通过、已修补、要你逐项确认）出流程计划卡放进待我处理，任务转待确认。修补后的计划才是授权对象。
//   和 AgentSense 的差别：AgentSense 在这次工具调用里等用户当场授权，二狗的任务是授权之后排队、有名额才开始执行
//   （规格第 8 节），所以工具结果只说"已交给用户授权"，授权之后执行开始时的通知里再说"按这份执行"；
// - report_step（执行时）：汇报某一步的状态，完成时附一句话要点。步骤都做完或说明跳过时流程完成。
// 被拒时原因以出错的工具结果交回维护者。
import { REPORTED_STEP_STATES, Type, type WorkflowPlanDraft, WorkflowPlanDraft as WorkflowPlanDraftSchema, WORKFLOW_REVIEW_STATUS_LABEL } from "@ergou/protocol";
import { defineHostTool, type HostTool, type HostToolOutput } from "../agent-manager/host-tools.ts";
import { RequestRejected } from "../errors.ts";
import type { ToolRegistry } from "../guard/index.ts";
import type { MaintainerScope, TaskExecution } from "./execution.ts";
import { executionTools } from "./execution-tools.ts";
import type { TaskService } from "./tasks.ts";
import { EXECUTION_TOOL, WORKFLOW_TOOL } from "./tool-names.ts";
import { checkWorkflowDraft, type ReviewedWorkflow, workflowPlanText } from "./workflow-plan.ts";

/** 审查修补一份交来的计划（daemon.ts 接上：守卫的各区、关注类别设置、执行它的维护者的工作目录） */
export type WorkflowReviewer = (draft: WorkflowPlanDraft, version: number) => Promise<ReviewedWorkflow>;

/** 控制器拒绝的（RequestRejected）作为出错的结果交回维护者，别的错照常抛 */
async function guarded(run: () => HostToolOutput | Promise<HostToolOutput>): Promise<HostToolOutput> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof RequestRejected) return { text: err.message, isError: true };
    throw err;
  }
}

/** 起草时：提交（或重新提交）完整计划 */
export function proposePlanTool(deps: { tasks: TaskService; tools: ToolRegistry; review: WorkflowReviewer }, scope: MaintainerScope): HostTool {
  return defineHostTool({
    name: WORKFLOW_TOOL.proposePlan,
    title: "提交计划",
    description: "在执行前提交（或修订）完整计划，等待用户一次性授权。运行时先审查修补（可能插入步骤、改写参数、调整顺序），修补后的计划交给用户授权。",
    parameters: WorkflowPlanDraftSchema,
    // 每提交一次可能多一版计划、一张流程计划卡
    readOnlyOrIdempotent: false,
    run: (draft) =>
      guarded(async () => {
        const problems = checkWorkflowDraft(draft, deps.tools);
        if (problems.length > 0) throw new RequestRejected("bad_params", `计划没通过检查，改好再提交：\n- ${problems.join("\n- ")}`);
        const version = deps.tasks.nextPlanRevision(scope.taskId);
        const reviewed = await deps.review(draft, version);
        const { review } = reviewed.plan;
        // 退回维护者自己改：不请求授权（用户在待我处理里看得到这版和退回的原因）
        if (review.status === "needs_replan") {
          const asks = review.replans.map((r) => `- ${r}`).join("\n");
          const { cardId } = deps.tasks.refuseWorkflowPlan(scope.taskId, scope.maintainerId, reviewed, "needs_replan");
          return { text: `计划 v${version} 没有提交给用户：审查要求先补充下面几点，改好后重新调用 ${WORKFLOW_TOOL.proposePlan}。\n${asks}`, cardIds: [cardId] };
        }
        // 修不了：不请求授权，让维护者把原因讲给用户（卡上写明原因，用户可以让你改或者取消任务）
        if (review.status === "blocked") {
          const why = review.violations.map((v) => `- ${v.message}`).join("\n") || review.note || "无法修补";
          const { cardId } = deps.tasks.refuseWorkflowPlan(scope.taskId, scope.maintainerId, reviewed, "blocked");
          return { text: `计划 v${version} 不能执行，审查给出的原因：\n${why}\n请把这件事告诉用户，不要再提交同样的计划。`, cardIds: [cardId] };
        }
        const { cardId } = deps.tasks.submitWorkflowPlan(scope.taskId, scope.maintainerId, reviewed);
        const status = review.status ? WORKFLOW_REVIEW_STATUS_LABEL[review.status].label : "没审查";
        const changed =
          review.actions.length > 0
            ? `\n计划审查改过这份计划（${status}），用户授权的是改过之后的版本：\n${workflowPlanText(reviewed.plan)}`
            : "";
        return {
          text: `计划 v${version} 已交给用户授权（流程计划卡放进了用户的待我处理，任务转为待确认）。用户授权之前不要动手；用户拒绝时你会收到说明。${changed}`,
          cardIds: [cardId],
        };
      }),
  });
}

/** 执行时：汇报某一步的状态 */
export function reportStepTool(execution: TaskExecution, scope: MaintainerScope): HostTool {
  return defineHostTool({
    name: WORKFLOW_TOOL.reportStep,
    title: "汇报步骤",
    description: "汇报某个计划步骤的状态；完成时附一句话要点。",
    parameters: Type.Object(
      {
        stepId: Type.String({ minLength: 1 }),
        status: Type.Enum(REPORTED_STEP_STATES),
        gist: Type.Optional(Type.String({ maxLength: 1000, description: "一句话要点" })),
      },
      { additionalProperties: false },
    ),
    // 只改步骤的状态：同样的汇报再来一次结果一样
    readOnlyOrIdempotent: true,
    run: ({ stepId, status, gist }) =>
      guarded(() => {
        const r = execution.reportStep(scope, { stepId, state: status, ...(gist === undefined ? {} : { gist }) });
        return { text: r.completed ? `ok。全部 ${r.total} 步都做完了（或说明跳过），流程完成：用简短中文汇报结果。` : "ok" };
      }),
  });
}

/** 流程执行时维护者的工具：汇报步骤、转为等我、任务失败（没有阶段、计划变更、并行的工具：执行中不能改步骤，59 号票） */
export function workflowExecutionTools(execution: TaskExecution, scope: MaintainerScope): HostTool[] {
  const keep = new Set<string>([EXECUTION_TOOL.waitForUser, EXECUTION_TOOL.failTask]);
  return [reportStepTool(execution, scope), ...executionTools(execution, scope).filter((t) => keep.has(t.spec.name))];
}
