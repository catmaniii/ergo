// 一次运行里执行它的 agent 的工具（守护进程代为执行；19 号票的定时作业，76 号票起是定时触发的任务的每次运行）：
// - fail_job_run：这次运行做不了，说明原因，这次运行记为失败（卡上标"最近一次失败"，连续失败到配置的次数自动暂停）。
//   不调用它、这一轮正常结束就算成功；这一轮出错、被中止，或者有一步等不到批准被拦下、交给用户亲手做，也算没做成。
// - 定时触发的流程（76 号票）：report_step 汇报这次运行里的某一步（照 58 号票，只记在这次运行上）；propose_plan 只会被拒（运行里不能改步骤）。
// 只改二狗自己的状态，不落入任何关注类别，照样先经守卫。
// @i18n-ignore-file model：工具的说明、参数说明和结果给 agent（模型）看（174 号票）；工具的名字走 t()
import { REPORTED_STEP_STATES, type ReportedStepState, t, Type } from "@ergo/protocol";
import { WORKFLOW_TOOL } from "../tasks/tool-names.ts";
import { defineHostTool, type HostTool } from "../agent-manager/host-tools.ts";
import { RequestRejected } from "../errors.ts";
import { RUN_NO_PLAN_CHANGE_TEXT } from "./texts.ts";
import { JOB_TOOL } from "./tool-names.ts";

const FailParams = Type.Object(
  { reason: Type.String({ minLength: 1, maxLength: 2000, description: "为什么这次做不了（缺什么、哪一步出了错），用户在作业卡和待我处理里看得到" }) },
  { additionalProperties: false },
);

/** 维护者报这次运行失败：报给定时作业模块 */
export interface JobFailureReporter {
  /** 维护者手上正在运行的那一次（属于项目的作业是它手上这张工单的那一次）记下失败的原因；没有在运行的抛 RequestRejected */
  reportFailure(maintainerId: string, reason: string): { runId: string };
}

/** 报告这次运行失败；failureLimit 是连续失败几次自动暂停（配置 scheduledJobs.jobFailures） */
export function failJobRunTool(jobs: JobFailureReporter, maintainerId: string, failureLimit: number): HostTool {
  return defineHostTool({
    name: JOB_TOOL.failRun,
    title: t("scheduledJobs.tool.failRun"),
    description: `定时作业的这次运行做不了：写明原因，这次运行记为失败。做完了就不用调用它，这一轮正常结束就算成功。连续失败 ${failureLimit} 次作业会自动暂停，等用户处理。`,
    parameters: FailParams,
    // 同一次运行再报一次只是换成新的原因
    readOnlyOrIdempotent: true,
    run: ({ reason }) => {
      const text = reason.trim();
      if (!text) return { text: "原因是空的：写明为什么这次做不了", isError: true };
      try {
        const { runId } = jobs.reportFailure(maintainerId, text);
        return { text: `已记下：这次运行（${runId}）失败，原因：${text}。这一轮结束时运行记录记成失败。` };
      } catch (err) {
        if (err instanceof RequestRejected) return { text: err.message, isError: true };
        throw err;
      }
    },
  });
}

/** 定时触发的流程：汇报这次运行里的某一步（报给触发底座） */
export interface RunStepReporter {
  reportStep(maintainerId: string, report: { stepId: string; state: ReportedStepState; gist?: string }): { done: number; total: number };
}

/** 汇报这次运行里的某一步（和执行流程时的 report_step 同名同参数，58 号票） */
export function runReportStepTool(jobs: RunStepReporter, maintainerId: string): HostTool {
  return defineHostTool({
    name: WORKFLOW_TOOL.reportStep,
    title: t("scheduledJobs.tool.reportStep"),
    description: "汇报这次运行里某个计划步骤的状态；完成时附一句话要点。",
    parameters: Type.Object(
      {
        stepId: Type.String({ minLength: 1 }),
        status: Type.Enum(REPORTED_STEP_STATES),
        gist: Type.Optional(Type.String({ maxLength: 1000, description: "一句话要点" })),
      },
      { additionalProperties: false },
    ),
    readOnlyOrIdempotent: true,
    run: ({ stepId, status, gist }) => {
      try {
        const r = jobs.reportStep(maintainerId, { stepId, state: status, ...(gist === undefined ? {} : { gist }) });
        return { text: r.done === r.total ? `ok。这次运行的 ${r.total} 步都做完了（或说明跳过）：用一两句话说这次做成了什么。` : "ok" };
      } catch (err) {
        if (err instanceof RequestRejected) return { text: err.message, isError: true };
        throw err;
      }
    },
  });
}

/** 定时触发的流程的运行里调 propose_plan：一律告诉它不行（照 59 号票，不先过参数校验） */
export function runPlanChangeRefusalTool(): HostTool {
  return defineHostTool({
    name: WORKFLOW_TOOL.proposePlan,
    title: t("scheduledJobs.tool.proposePlan"),
    description: `定时触发的流程每次运行都照授权的计划做，运行里不能改步骤：调用它只会被拒绝。计划需要变化时用 ${JOB_TOOL.failRun} 说明。`,
    parameters: Type.Record(Type.String(), Type.Unknown()),
    readOnlyOrIdempotent: true,
    run: () => ({ text: RUN_NO_PLAN_CHANGE_TEXT, isError: true }),
  });
}
