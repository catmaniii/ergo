// 88 号票：宽屏下任务看板占满内容区、每组排成多列网格，点卡片整页换成任务详情（左上角 ‹、浏览器后退、鸿蒙返回键回到看板，
// 回来时滚回原来的位置，手机上也是）；长程任务宽屏的阶段栏能整栏藏掉（照 AgentSense），按设备记住。窄屏的阶段抽屉照旧。
// 回放：长程任务（task-execution）、流程（workflow）、普通任务（missed-triggers）主切面录下的事件流
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { parseHash } from "../../src/app/route-hash.ts";
import { boardScrollOnReturn, replay, stageChipPlace, stageSideLayout, stageSidePrefOf, taskHasStages, taskKind, taskPageView, taskStages, type UiInput, type UiState } from "../../src/state/index.ts";

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

describe("从任务详情回到看板时的滚动位置（宽窄屏一样，用户 2026-10-11 定手机上也停在原来的位置）", () => {
  test("滚回离开看板时的位置；没离开过（刚打开、从别处直接跳进任务再回来）从顶上开始", () => {
    expect(boardScrollOnReturn({ saved: 640 })).toBe(640);
    expect(boardScrollOnReturn({ saved: undefined })).toBeUndefined();
  });

  test("点名了某张作业卡（日历里点过来）：滚到那张卡，不滚回原来的位置", () => {
    expect(boardScrollOnReturn({ job: "j-1", saved: 640 })).toBeUndefined();
  });
});

describe("长程任务的阶段栏：宽屏能整栏藏掉（照 AgentSense），按设备记住", () => {
  test("记住的值：只认“藏掉”；没记过、认不出的都按开着（默认）", () => {
    expect(stageSidePrefOf("closed")).toBe("closed");
    expect(stageSidePrefOf(null)).toBe("open");
    expect(stageSidePrefOf("open")).toBe("open");
    expect(stageSidePrefOf("collapsed")).toBe("open");
  });

  test("宽屏开着是会话左边的阶段栏、藏掉了什么都不画（会话占满）；窄屏不管记住的是什么，照旧是阶段抽屉；没有阶段的都不显示", () => {
    expect(stageSideLayout({ wide: true, hasStages: true, pref: "open" })).toBe("side");
    expect(stageSideLayout({ wide: true, hasStages: true, pref: "closed" })).toBe("closed");
    expect(stageSideLayout({ wide: false, hasStages: true, pref: "open" })).toBe("drawer");
    expect(stageSideLayout({ wide: false, hasStages: true, pref: "closed" })).toBe("drawer");
    expect(stageSideLayout({ wide: true, hasStages: false, pref: "open" })).toBe("none");
    expect(stageSideLayout({ wide: false, hasStages: false, pref: "closed" })).toBe("none");
  });

  test("阶段标签的位置：宽屏挪到标题栏左边（返回之后、标题之前，正在阶段栏上方，照 AgentSense）；窄屏照旧在标题栏右边", () => {
    expect(stageChipPlace(true)).toBe("lead");
    expect(stageChipPlace(false)).toBe("trail");
  });

  test("回放：长程任务（task-execution）建好了阶段，有阶段栏", () => {
    const state = replay(load("task-execution"));
    const task = onlyTask(state);
    expect(taskKind(task)).toBe("long_running");
    expect(taskHasStages(task, taskStages(state, task.id))).toBe(true);
    expect(stageSideLayout({ wide: true, hasStages: taskHasStages(task, taskStages(state, task.id)), pref: "closed" })).toBe("closed");
  });

  test("回放：流程（workflow）只有一个内部的执行阶段、显示步骤，普通任务（missed-triggers）没有阶段：都没有阶段栏", () => {
    const flow = replay(load("workflow"));
    const flowTask = onlyTask(flow);
    expect(taskKind(flowTask)).toBe("workflow");
    expect(taskHasStages(flowTask, taskStages(flow, flowTask.id))).toBe(false);

    const plain = replay(load("missed-triggers"));
    const plainTask = onlyTask(plain);
    expect(taskKind(plainTask)).toBe("plain");
    expect(taskHasStages(plainTask, taskStages(plain, plainTask.id))).toBe(false);
    expect(stageSideLayout({ wide: true, hasStages: taskHasStages(plainTask, taskStages(plain, plainTask.id)), pref: "open" })).toBe("none");
  });
});
