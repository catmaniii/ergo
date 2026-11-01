// 宽屏下任务看板占满内容区、每组排成多列网格，点卡片整页换成任务详情（左上角 ‹、浏览器后退、鸿蒙返回键回到看板，
// 回来时滚回原来的位置，手机上也是）。阶段不再有单独的栏，宽窄屏都是对话框顶部的阶段条。
// 回放：长程任务（task-execution）、流程（workflow）、普通任务（missed-triggers）主切面录下的事件流
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { parseHash } from "../../src/app/route-hash.ts";
import { boardScrollOnReturn, replay, stageSidePrefOf, taskHasStages, taskKind, taskPageView, taskStages, type UiInput, type UiState } from "../../src/state/index.ts";

function load(name: string): UiInput[] {
  return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "recordings", `${name}.json`), "utf8")) as UiInput[];
}

/** 回放里唯一的那个任务 */
function onlyTask(state: UiState) {
  const tasks = Object.values(state.tasks);
  expect(tasks).toHaveLength(1);
  return tasks[0]!;
}

/** 地址里的任务页换成显示什么（App 把 #/tasks… 拆成 taskId、jobId 交给任务页） */
function viewAt(hash: string, wide: boolean) {
  const route = parseHash(hash);
  if (route.tab !== "tasks") throw new Error(`不是任务页：${hash}`);
  return taskPageView({ wide, taskId: route.taskId, jobId: route.jobId });
}

describe("任务页显示什么：看板和任务详情二选一", () => {
  test("宽屏没点任务：整页是看板，每组排成多列网格；窄屏照旧一列", () => {
    expect(viewAt("#/tasks", true)).toEqual({ kind: "board", layout: "grid" });
    expect(viewAt("#/tasks", false)).toEqual({ kind: "board", layout: "list" });
  });

  test("点卡片、从别处跳进来（待我处理、聊天里卡片的“去看任务 ▸”、通知都是 #/tasks/<任务>）：宽屏也整页是任务详情，不再左边看板右边详情", () => {
    expect(viewAt("#/tasks/t-1", true)).toEqual({ kind: "task", taskId: "t-1" });
    expect(viewAt("#/tasks/t-1", false)).toEqual({ kind: "task", taskId: "t-1" });
  });

  test("日历里点作业过来（#/tasks/jobs/<作业>）：看板，点名那张作业卡", () => {
    expect(viewAt("#/tasks/jobs/j-1", true)).toEqual({ kind: "board", layout: "grid", job: "j-1" });
    expect(viewAt("#/tasks/jobs/j-1", false)).toEqual({ kind: "board", layout: "list", job: "j-1" });
  });
});

describe("从任务详情回到看板时的滚动位置（宽窄屏一样，手机上也停在原来的位置）", () => {
  test("滚回离开看板时的位置；没离开过（刚打开、从别处直接跳进任务再回来）从顶上开始", () => {
    expect(boardScrollOnReturn({ saved: 640 })).toBe(640);
    expect(boardScrollOnReturn({ saved: undefined })).toBeUndefined();
  });

  test("点名了某张作业卡（日历里点过来）：滚到那张卡，不滚回原来的位置", () => {
    expect(boardScrollOnReturn({ job: "j-1", saved: 640 })).toBeUndefined();
  });
});

describe("对话框顶部的阶段条：展开还是收成一行按设备记住", () => {
  test("记住的值：只认“收起”；没记过、认不出的都按展开（默认）", () => {
    expect(stageSidePrefOf("closed")).toBe("closed");
    expect(stageSidePrefOf(null)).toBe("open");
    expect(stageSidePrefOf("open")).toBe("open");
    expect(stageSidePrefOf("collapsed")).toBe("open");
  });

  test("回放：长程任务（task-execution）建好了阶段，有阶段条", () => {
    const state = replay(load("task-execution"));
    const task = onlyTask(state);
    expect(taskKind(task)).toBe("long_running");
    expect(taskHasStages(task, taskStages(state, task.id))).toBe(true);
  });

  test("回放：流程（workflow）只有一个内部的执行阶段、显示步骤，普通任务（missed-triggers）没有阶段：都没有阶段条", () => {
    const flow = replay(load("workflow"));
    const flowTask = onlyTask(flow);
    expect(taskKind(flowTask)).toBe("workflow");
    expect(taskHasStages(flowTask, taskStages(flow, flowTask.id))).toBe(false);

    const plain = replay(load("missed-triggers"));
    const plainTask = onlyTask(plain);
    expect(taskKind(plainTask)).toBe("plain");
    expect(taskHasStages(plainTask, taskStages(plain, plainTask.id))).toBe(false);
  });
});
