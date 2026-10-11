// 定时作业的阈值（规格第 13 节，19 号票）：默认值只在这里，配置里写 scheduledJobs 改（照 14 号票 tasks/thresholds.ts 的规矩）。
// - 连续失败 jobFailures 次自动暂停，待我处理里一条"定时作业被自动暂停"（中断的不算进去）。
// 事件来源的阈值（77 号票，本机文件夹的合成一次、重试，一次运行最多几步）在 event-sources/thresholds.ts。

export interface ScheduledJobThresholds {
  /** 连续失败几次自动暂停（默认 3） */
  jobFailures: number;
}

export const DEFAULT_SCHEDULED_JOB_THRESHOLDS: Readonly<ScheduledJobThresholds> = Object.freeze({ jobFailures: 3 });
