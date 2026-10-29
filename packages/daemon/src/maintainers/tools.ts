// 维护者的"提交计划"工具（守护进程代为执行）：参数就是共享协议包的计划 schema（PlanSubmission：阶段里没有编号，编号由守护进程定，
// 93 号票；pi 先按它校验，不合就把原因交回模型、不转；守护进程再按同一个 schema 校验一次），检查（tasks/plan.ts）不过时原因交回维护者、不出计划卡。
// 工具绑定在一个任务上：维护者只能给它执行的那个任务提交计划。
// 112 号票：长程任务的阶段自动验收，说明里写明验收方式只能写脚本、评审（写了由你验收的计划检查退回）。
import { PlanSubmission, stagesAutoAccepted, t } from "@ergo/protocol";
import { defineHostTool, type HostTool } from "../agent-manager/host-tools.ts";
import { RequestRejected } from "../errors.ts";
import type { TaskService } from "../tasks/tasks.ts";

/** 工具名（系统提示、给维护者的通知、测试里引用） */
export const SUBMIT_PLAN_TOOL = "submit_plan";

export function submitPlanTool(tasks: TaskService, scope: { taskId: string; maintainerId: string }): HostTool {
  const task = tasks.get(scope.taskId);
  return defineHostTool({
    name: SUBMIT_PLAN_TOOL,
    title: t("maintainers.tool.submitPlan"),
    // @i18n-ignore-start model：工具说明和结果给维护者（模型）看
    description:
      "把起草好的计划以结构化数据交出。运行时检查后生成计划卡放进用户的待我处理，任务转“待确认”；没通过检查时返回原因，改好再提交。" +
      (task && stagesAutoAccepted(task) ? "阶段自动验收：每条验收标准的方式只能写 script（附命令）或 review（涉及多个项目的任务只写 review），写 user 会被退回。" : ""),
    parameters: PlanSubmission,
    // 每提交一次多一版计划、一张计划卡
    readOnlyOrIdempotent: false,
    run(plan) {
      try {
        const { revision, cardId } = tasks.submitPlan(scope.taskId, scope.maintainerId, plan);
        return {
          text: `计划已提交（第 ${revision} 版），计划卡放进了用户的待我处理，任务转为待确认。用户确认之前不要动手；用户打回时你会收到意见。`,
          // @i18n-ignore-end
          cardIds: [cardId],
        };
      } catch (err) {
        if (err instanceof RequestRejected) return { text: err.message, isError: true };
        throw err;
      }
    },
  });
}
