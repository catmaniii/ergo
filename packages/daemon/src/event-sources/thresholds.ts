// 事件来源的阈值（77 号票）：默认值只在这里，配置里写 eventSources 改（照"阈值各归各的模块"的规矩，见 docs/dev.md）。
// - 本机文件夹变化：同一个文件安静 folderSettleMs 毫秒才算一次变化（连续变化合成一次）；
// - 本机文件夹变化：文件夹不在、监视出错时，每隔 folderRetryMs 毫秒再看一次，回来了接着监视；
// - 事件触发的任务一次运行最多照 maxRunSteps 步：一批事件数 × 流程的步骤数（普通任务每个事件算一步），再多的事件另起一次运行排着。

export interface EventSourceThresholds {
  /** 本机文件夹变化：同一个文件安静多久（毫秒）才算一次变化（默认 2000） */
  folderSettleMs: number;
  /** 本机文件夹变化：文件夹不在、监视出错时隔多久（毫秒）再看一次（默认 30000） */
  folderRetryMs: number;
  /** 事件触发的任务一次运行最多照多少步（一批事件数 × 步骤数；默认 100） */
  maxRunSteps: number;
}

export const DEFAULT_EVENT_SOURCE_THRESHOLDS: Readonly<EventSourceThresholds> = Object.freeze({ folderSettleMs: 2000, folderRetryMs: 30_000, maxRunSteps: 100 });
