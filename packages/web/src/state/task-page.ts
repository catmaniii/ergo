// 任务页的布局（纯函数：宽屏下左边任务列表、中间阶段、右边聊天太窄，阶段也收不起来）：
// - 看板和任务详情二选一（宽窄屏一样）：看板占满内容区，宽屏每组里的卡排成多列网格（列数随宽度，卡片有最小宽度，样式里 auto-fill），
//   窄屏照旧一列；点卡片、从别处跳进来（#/tasks/<任务>：待我处理、聊天里卡片的"去看任务 ▸"、通知、日历）都整页换成任务详情，
//   标题栏左上角的 ‹、浏览器后退、鸿蒙返回键回到看板；
// - 从任务详情回到看板时滚回离开时的位置（看板在详情页时拿掉了，位置记在任务页上；手机上也是）；
// -阶段不再有单独的栏，宽窄屏都是对话框顶部的阶段条（ui/conversation/stage-panel.tsx）；
//   阶段条展开还是收成一行按设备记住，默认展开（读写浏览器存储在 app/stage-side-setting.ts，还是原来那个键）。
import { taskKind, type Task } from "./protocol.ts";

/** 任务页现在显示什么：看板（宽屏多列网格、窄屏一列；job 是日历里点名的那张作业卡），或者一个任务的详情（整页） */
export type TaskPageView = { kind: "board"; layout: "grid" | "list"; job?: string } | { kind: "task"; taskId: string };

/** 地址拆出来的任务、作业（#/tasks/<任务>、#/tasks/jobs/<作业>）加上宽窄，定任务页显示什么 */
export function taskPageView(at: { wide: boolean; taskId?: string | undefined; jobId?: string | undefined }): TaskPageView {
  if (at.taskId) return { kind: "task", taskId: at.taskId };
  return { kind: "board", layout: at.wide ? "grid" : "list", ...(at.jobId ? { job: at.jobId } : {}) };
}

/**
 * 看板挂上时滚到哪（undefined 是不管，从顶上开始）：滚回上次离开看板时的位置（saved，没离开过的没有），宽窄屏一样；
 * 点名了某张作业卡的滚到那张卡（卡自己滚），不滚回原来的位置
 */
export function boardScrollOnReturn(at: { job?: string | undefined; saved: number | undefined }): number | undefined {
  return at.job ? undefined : at.saved;
}

/** 阶段条：展开（open）还是收成一行（closed） */
export type StageSidePref = "open" | "closed";

/** 这台设备记住的值怎么认：只认"藏掉"，没记过、认不出的都按开着（默认） */
export function stageSidePrefOf(raw: string | null): StageSidePref {
  return raw === "closed" ? "closed" : "open";
}

/**
 * 这个任务有没有阶段可画：长程任务、建好了阶段（stages 是 taskStages 算出的那一份，任务详情已经算过，不再算一遍）。
 * 流程只有一个内部的执行阶段，显示步骤；普通任务没有阶段
 */
export function taskHasStages(task: Pick<Task, "kind">, stages: readonly unknown[]): boolean {
  return taskKind(task) === "long_running" && stages.length > 0;
}
