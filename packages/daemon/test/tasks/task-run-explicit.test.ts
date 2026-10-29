// 100 号票：秘书的快速动作 run_task_now、set_voice_announce 的"用户点明了没有"（照任务控制从严）。说法要和这个任务绑在同一个分句里、
// 方向对（打开 / 关掉、再跑一次）；"念"这种宽的说法、这次的结果念一下、问句都不算点明——出卡确认。表格驱动。
// 103 号票评审起认任务从严（暂停、继续、取消也是）：编号或完整标题，子串不算，更长的标题从同一处起时算那个——子串标题出卡、完整标题直接执行。
import type { Task } from "@ergo/protocol";
import { describe, expect, test } from "vitest";
import type { UserTurn } from "../../src/quick-actions/index.ts";
import type { ScheduledJobs } from "../../src/scheduled-jobs/jobs.ts";
import { taskControlActions, taskRunActions } from "../../src/tasks/task-control.ts";
import type { TaskExecution } from "../../src/tasks/execution.ts";
import type { TaskService } from "../../src/tasks/tasks.ts";

const task = (id: string, title: string) => ({ id, title }) as Task;
const T5 = task("t-5", "每天出 AI 新闻日报");
const T6 = task("t-6", "每周整理下载目录");
const DAILY = task("t-7", "日报");
const DAILY_SUM = task("t-8", "日报汇总");
const ALL = [T5, T6, DAILY, DAILY_SUM];
const tasks = { list: () => ALL, get: (id: string) => ALL.find((t) => t.id === id) } as unknown as TaskService;
const [pause, resume, cancel] = taskControlActions({ tasks, execution: () => ({}) as TaskExecution });
const scheduledJobs = () => ({}) as Pick<ScheduledJobs, "ofTask" | "checkRunNow" | "prepareRunNow">;
const [runNow, announce] = taskRunActions({ tasks, scheduledJobs });

const turn = (text: string): UserTurn => ({ typed: [text], spoken: [], quotes: [], cards: [] });
const explicit = (executor: typeof runNow, params: Record<string, unknown>, text: string) => executor!.explicit!({ params: params as never, title: "" }, turn(text));

describe("跑完自动播报：打开要说以后每次念、和这个任务在同一个分句里", () => {
  test.each<[string, string, boolean]>([
    ["以后 t-5 跑完直接念给我", "t-5", true],
    ["打开 t-5 的跑完自动播报", "t-5", true],
    ["每天出 AI 新闻日报以后跑完都播报给我", "t-5", true],
    ["t-5 以后别念了，t-6 以后跑完念给我", "t-6", true],
    // 说法和任务不在同一个分句：t-5 是要关
    ["t-5 以后别念了，t-6 以后跑完念给我", "t-5", false],
    // 这次的结果念一下，不是开开关
    ["把 t-5 这次结果念给我", "t-5", false],
    // 单个"念"不算
    ["t-5 以后念", "t-5", false],
    // 没写编号或完整标题
    ["以后 AI 新闻跑完直接念给我", "t-5", false],
    // 问句
    ["以后 t-5 跑完能直接念给我吗？", "t-5", false],
  ])("“%s” 打开 %s：点明了 %s", (text, taskId, expected) => {
    expect(explicit(announce, { taskId, on: true }, text) !== undefined).toBe(expected);
  });
});

describe("跑完自动播报：关掉要否定词紧挨着念 / 播报，或者关掉和播报在一起", () => {
  test.each<[string, string, boolean]>([
    ["t-5 以后别念了，t-6 以后跑完念给我", "t-5", true],
    ["关掉 t-5 的自动播报", "t-5", true],
    ["t-5 的播报关掉吧", "t-5", true],
    ["t-5 不用再念了", "t-5", true],
    ["以后 t-5 跑完直接念给我", "t-5", false],
    ["t-6 别念了，t-5 照旧", "t-5", false],
    ["那个日报以后别自动念了", "t-5", false],
  ])("“%s” 关掉 %s：点明了 %s", (text, taskId, expected) => {
    expect(explicit(announce, { taskId, on: false }, text) !== undefined).toBe(expected);
  });
});

describe("立即运行一次：说法和这个任务在同一个分句里，前面没有否定词", () => {
  test.each<[string, boolean]>([
    ["把 t-5 再跑一次", true],
    ["t-5 立即运行一次", true],
    ["每天出 AI 新闻日报现在跑一次", true],
    ["t-6 再跑一次，t-5 别动", false],
    ["别再跑 t-5 了", false],
    ["t-5 跑一下看看", false],
    ["t-5 再跑一次吗？", false],
    ["把 t-5 这次结果念给我", false],
  ])("“%s”：点明了 %s", (text, expected) => {
    expect(explicit(runNow, { taskId: "t-5" }, text) !== undefined).toBe(expected);
  });
});

describe("认任务：编号或完整标题，子串不算，更长的标题从同一处起时算那个（103 号票评审）", () => {
  test.each<[string, typeof runNow, string, string, boolean]>([
    // 取消（不可逆）：完整标题直接执行，子串标题出卡
    ["取消日报", cancel!, "cancel", "t-7", true],
    ["取消 t-7", cancel!, "cancel", "t-7", true],
    ["取消 AI 日报", cancel!, "cancel", "t-7", false],
    ["取消AI日报", cancel!, "cancel", "t-7", false],
    ["取消日报汇总", cancel!, "cancel", "t-7", false],
    ["取消日报汇总", cancel!, "cancel", "t-8", true],
    ["把日报汇总取消", cancel!, "cancel", "t-7", false],
    // 暂停、继续
    ["暂停日报", pause!, "pause", "t-7", true],
    ["暂停 AI 日报", pause!, "pause", "t-7", false],
    ["继续日报汇总", resume!, "resume", "t-7", false],
    ["继续日报汇总", resume!, "resume", "t-8", true],
    // 立即运行一次、跑完自动播报
    ["日报再跑一次", runNow!, "run", "t-7", true],
    ["AI 日报再跑一次", runNow!, "run", "t-7", false],
    ["日报汇总再跑一次", runNow!, "run", "t-7", false],
    ["日报汇总再跑一次", runNow!, "run", "t-8", true],
    ["以后日报跑完直接念给我", announce!, "on", "t-7", true],
    ["以后 AI 日报跑完直接念给我", announce!, "on", "t-7", false],
  ])("“%s”（%s %s → %s）：点明了 %s", (text, executor, kind, taskId, expected) => {
    expect(explicit(executor, kind === "on" ? { taskId, on: true } : { taskId }, text) !== undefined).toBe(expected);
  });
});
