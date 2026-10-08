// 定时作业的一次运行里维护者的工具（守护进程代为执行，19 号票）：
// - fail_job_run：这次运行做不了，说明原因，这次运行记为失败（作业卡上标"最近一次失败"，连续失败到配置的次数自动暂停）。
//   不调用它、这一轮正常结束就算成功；这一轮出错、被中止，或者有一步等不到批准被拦下、交给用户亲手做，也算没做成。
// 只改二狗自己的状态，不落入任何关注类别，照样先经守卫。
import { Type } from "@ergou/protocol";
import { defineHostTool, type HostTool } from "../agent-manager/host-tools.ts";
import { RequestRejected } from "../errors.ts";
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
    title: "报告这次运行失败",
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
