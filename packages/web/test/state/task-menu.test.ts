// 90 号票：任务的操作菜单（看板卡的长按 / 右键、任务详情的"⋯"、状态签浮层用同一份）、标题栏的关键按钮、"⋯"的上半，
// 看板多选（每个操作只对能做的生效、按钮上写个数、取消先确认、结果逐条回报）。菜单项照协议包的"谁能改"表，随种类和状态变。
// 表格驱动；超预算的回放 task-over-budget（主切面录下的事件流）。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  batchCancelConfirm,
  batchCounts,
  batchResult,
  batchTargets,
  canBatch,
  groupSelection,
  replay,
  statusChipText,
  type TaskMenuSubject,
  taskKeyItem,
  taskMenu,
  taskPanels,
  taskStatusNote,
  toggleSelected,
  type UiInput,
} from "../../src/state/index.ts";

const stage = (stageId: string, state: string, extra: { waitReason?: "acceptance" | "over_budget" | "approval"; startedAt?: string } = {}) => ({ stageId, state, ...extra });
const labels = (task: TaskMenuSubject, where: "board" | "detail" = "detail") => taskMenu(task, where).map((i) => i.label);

describe("任务现在能做什么：菜单项随种类、状态变（照“谁能改”表）", () => {
  test.each<[string, TaskMenuSubject, string[]]>([
    ["规划中：只能取消", { state: "planning" }, ["取消任务"]],
    ["执行中的长程任务：暂停、取消、从某阶段重做（开始过的阶段）", { state: "running", stages: { list: [stage("s1", "accepted"), stage("s2", "running")] } }, ["暂停", "取消任务", "从某阶段重做…"]],
    ["执行中但阶段都还没开始：没有从某阶段重做", { state: "running", stages: { list: [stage("s1", "pending")] } }, ["暂停", "取消任务"]],
    ["开始过又放下了的阶段也算开始过", { state: "queued", stages: { list: [stage("s1", "pending", { startedAt: "2026-10-11T09:00:00+08:00" })] } }, ["暂停", "取消任务", "从某阶段重做…"]],
    ["执行中的流程：没有重做", { state: "running", kind: "workflow", stages: { list: [stage("run", "running")] } }, ["暂停", "取消任务"]],
    ["等我 · 超预算：追加预算继续", { state: "waiting_for_user", waitReason: "over_budget", stages: { list: [stage("s1", "accepted"), stage("s2", "waiting", { waitReason: "over_budget" })] } }, ["暂停", "追加预算继续", "取消任务", "从某阶段重做…"]],
    ["等我 · 卡住求助：继续执行", { state: "waiting_for_user", waitReason: "stuck", kind: "plain" }, ["暂停", "继续执行", "取消任务"]],
    ["等我 · 审批：先在待办里处理，没有继续", { state: "waiting_for_user", waitReason: "approval", stages: { list: [stage("s1", "waiting", { waitReason: "approval" })] } }, ["暂停", "取消任务", "从某阶段重做…"]],
    [
      "等我 · 由我验收：第 N 阶段验收通过、退回… 放最前",
      { state: "waiting_for_user", waitReason: "acceptance", stages: { list: [stage("s1", "accepted"), stage("s2", "waiting", { waitReason: "acceptance" })] } },
      ["第 2 阶段验收通过", "退回…", "暂停", "取消任务", "从某阶段重做…"],
    ],
    ["已暂停：继续", { state: "paused" }, ["继续", "取消任务"]],
    ["失败：重试、取消、归档", { state: "failed" }, ["重试", "取消任务", "归档"]],
    ["已完成的长程任务：返工…、归档", { state: "done", stages: { list: [stage("s1", "accepted")] } }, ["返工…", "归档"]],
    ["已完成 · 已转为项目：只能归档", { state: "done", endKind: "converted_to_project", stages: { list: [stage("s1", "accepted")] } }, ["归档"]],
    ["已取消：归档", { state: "cancelled" }, ["归档"]],
    ["已归档：什么都没有", { state: "archived" }, []],
    ["运营中的定时任务：落到触发上的暂停、取消任务", { state: "operating", kind: "plain", triggerActions: ["pause", "cancel"] }, ["暂停", "取消任务"]],
    ["运营中、触发暂停着：恢复、取消任务", { state: "operating", kind: "plain", triggerActions: ["resume", "cancel"] }, ["恢复", "取消任务"]],
    ["运营中的定时任务（98 号票）：暂停、改时间、取消任务", { state: "operating", kind: "plain", triggerActions: ["pause", "cancel"], reschedule: { kind: "daily", time: "09:00" } }, ["暂停", "改时间", "取消任务"]],
    ["运营中、触发暂停着也能改时间", { state: "operating", kind: "workflow", triggerActions: ["resume", "cancel"], reschedule: { kind: "workdays", time: "08:00" } }, ["恢复", "改时间", "取消任务"]],
  ])("%s", (_name, task, expected) => {
    expect(labels(task)).toEqual(expected);
  });

  test("看板上：前面“打开”、后面“多选”；任务详情的“⋯”没有这两项", () => {
    expect(labels({ state: "paused" }, "board")).toEqual(["打开", "继续", "取消任务", "多选"]);
    expect(labels({ state: "archived" }, "board")).toEqual(["打开", "多选"]);
    expect(taskMenu({ state: "paused" }, "detail").some((i) => i.kind === "open" || i.kind === "select")).toBe(false);
  });

  test("验收、退回带着是哪个阶段；取消是收不回的（danger）、验收通过最要紧（primary）", () => {
    const items = taskMenu({ state: "running", stages: { list: [stage("s1", "waiting", { waitReason: "acceptance" }), stage("s2", "running")] } }, "detail");
    expect(items.slice(0, 2)).toEqual([
      { kind: "accept", stageId: "s1", label: "第 1 阶段验收通过", tone: "primary" },
      { kind: "back", stageId: "s1", label: "退回…" },
    ]);
    expect(items.find((i) => i.kind === "act" && i.action === "cancel")).toMatchObject({ tone: "danger" });
  });
});

describe("标题栏的关键按钮：只在等我、失败时出一个最要紧的", () => {
  test.each<[string, TaskMenuSubject, string | undefined]>([
    ["由我验收：验收通过", { state: "waiting_for_user", waitReason: "acceptance", stages: { list: [stage("s1", "waiting", { waitReason: "acceptance" })] } }, "第 1 阶段验收通过"],
    ["超预算：追加预算继续", { state: "waiting_for_user", waitReason: "over_budget", stages: { list: [stage("s1", "waiting", { waitReason: "over_budget" })] } }, "追加预算继续"],
    ["卡住求助、中断不确定：继续执行", { state: "waiting_for_user", waitReason: "interrupted" }, "继续执行"],
    ["失败：重试", { state: "failed" }, "重试"],
    ["等我 · 审批（在待办里处理）：没有", { state: "waiting_for_user", waitReason: "approval" }, undefined],
    ["执行中：没有（暂停在“⋯”里）", { state: "running" }, undefined],
    ["已暂停：没有", { state: "paused" }, undefined],
  ])("%s", (_name, task, label) => {
    expect(taskKeyItem(task)?.label).toBe(label);
  });
});

describe("“⋯”的上半：计划、工单 N、工具包、消耗、运行 N", () => {
  test.each([
    ["长程任务、流程：计划、工具包、消耗", { plain: false, timed: false, orders: 0, runs: 0 }, ["计划", "工具包", "消耗"]],
    ["有工单的：工单 N（有才有）", { plain: false, timed: false, orders: 3, runs: 0 }, ["计划", "工单 3", "工具包", "消耗"]],
    ["定时触发的流程：多了运行 N", { plain: false, timed: true, orders: 0, runs: 2 }, ["计划", "工具包", "消耗", "运行 2"]],
    ["定时触发的普通任务：只有运行 N", { plain: true, timed: true, orders: 0, runs: 0 }, ["运行 0"]],
    ["一次性的普通任务：没有（只有会话）", { plain: true, timed: false, orders: 0, runs: 0 }, []],
  ])("%s", (_name, t, expected) => {
    expect(taskPanels(t).map((p) => p.label)).toEqual(expected);
  });
});

describe("状态签浮层：原因说明（守护进程写的）、手机上的短状态", () => {
  test.each([
    ["卡住求助写原因", { state: "waiting_for_user" as const, waitReason: "stuck" as const, waitNote: "连不上 NAS" }, "卡住求助：连不上 NAS"],
    ["中断不确定的说明自己就写着", { state: "waiting_for_user" as const, waitReason: "interrupted" as const, waitNote: "中断：不确定 rsync 是否已执行" }, "中断：不确定 rsync 是否已执行"],
    ["失败的原因", { state: "failed" as const, failReason: "接口一直 500" }, "失败的原因：接口一直 500"],
    ["执行中：没有", { state: "running" as const }, undefined],
  ])("%s", (_name, task, note) => {
    expect(taskStatusNote(task)).toBe(note);
  });

  test("回放超预算（task-over-budget）：原因照守护进程写的那句（用了多少、预算多少）；关键按钮是追加预算继续", () => {
    const inputs = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "recordings", "task-over-budget.json"), "utf8")) as UiInput[];
    // 转等我（超预算）那一刻
    const waiting = inputs.findIndex((i) => i.kind === "frame" && i.frame.type === "task" && (i.frame.payload as { change?: string }).change === "waiting");
    const task = replay(inputs.slice(0, waiting + 1)).tasks["t-1"]!;
    expect(task.waitReason).toBe("over_budget");
    expect(task.waitNote).toBeTruthy();
    expect(taskStatusNote(task)).toBe(`超预算：${task.waitNote}`);
    expect(taskKeyItem(task)?.label).toBe("追加预算继续");
    // 追加预算继续之后：没有了
    expect(taskStatusNote(replay(inputs).tasks["t-1"]!)).toBeUndefined();
  });

  test("状态签：宽屏写全；手机上等我的写在等什么，别的写状态（全称在浮层里）", () => {
    expect(statusChipText("等我 · 超预算", true)).toBe("等我 · 超预算");
    expect(statusChipText("等我 · 超预算", false)).toBe("超预算");
    expect(statusChipText("已暂停 · 累计被拒", false)).toBe("已暂停");
    expect(statusChipText("待确认 · 计划等你确认", false)).toBe("待确认");
    expect(statusChipText("已暂停（连续失败 3 次，自动暂停）", false)).toBe("已暂停");
    expect(statusChipText("执行中", false)).toBe("执行中");
  });
});

describe("看板多选", () => {
  const entries = [
    { id: "t-run", title: "跑着的", subject: { state: "running" } },
    { id: "t-paused", title: "停着的", subject: { state: "paused" } },
    { id: "t-done", title: "做完的", subject: { state: "done", kind: "plain" } },
    { id: "t-timed", title: "定时的", subject: { state: "operating", kind: "plain", triggerActions: ["pause", "cancel"] } },
    { id: "t-timed-paused", title: "停着的定时", subject: { state: "operating", kind: "plain", triggerActions: ["resume", "cancel"] } },
    { id: "t-archived", title: "归档了的", subject: { state: "archived" } },
  ] as const;
  const titleOf = (id: string) => entries.find((e) => e.id === id)?.title ?? id;

  test("每个按钮能做几个：只算能做的（运营中的定时任务看它的触发，归档要先取消）", () => {
    expect(batchCounts(entries)).toEqual({ pause: 2, resume: 2, cancel: 4, archive: 1 });
    expect(canBatch({ state: "operating", triggerActions: ["pause", "cancel"] }, "archive")).toBe(false);
    expect(canBatch({ state: "failed" }, "archive")).toBe(true);
    expect(batchCounts([])).toEqual({ pause: 0, resume: 0, cancel: 0, archive: 0 });
  });

  test("点了一个按钮：只交能做的，其余跳过", () => {
    expect(batchTargets(entries, "cancel")).toEqual({ ids: ["t-run", "t-paused", "t-timed", "t-timed-paused"], skipped: 2 });
    expect(batchTargets(entries, "archive")).toEqual({ ids: ["t-done"], skipped: 5 });
  });

  test("取消先确认一次：写清几个会取消、几个跳过", () => {
    expect(batchCancelConfirm(4, 2)).toEqual({
      title: "取消 4 个任务？",
      body: "4 个会取消，2 个跳过（已经结束了，或者现在不能取消）。取消了的不再执行，会话和记录都留着；定时触发的连同触发一起取消。想先停一停可以用\"暂停\"。",
    });
    expect(batchCancelConfirm(1, 0).body.startsWith("1 个会取消。")).toBe(true);
  });

  test("做完提示结果：成功几个、跳过几个、没成的逐条写为什么", () => {
    expect(batchResult("pause", [{ taskId: "t-run", ok: true }], 0, titleOf)).toEqual({ summary: "已暂停 1 个", failures: [] });
    expect(
      batchResult(
        "cancel",
        [
          { taskId: "t-run", ok: true },
          { taskId: "t-paused", ok: false, message: "任务现在是已完成，不能取消" },
          { taskId: "t-x", ok: false, message: "没有任务 t-x" },
        ],
        2,
        titleOf,
      ),
    ).toEqual({ summary: "已取消 1 个，跳过 2 个（现在不能取消），2 个没成", failures: ["「停着的」：任务现在是已完成，不能取消", "「t-x」：没有任务 t-x"] });
  });

  test("勾选：点一下勾上、再点去掉；一组的全选：没全勾上就全勾上，全勾上了就全去掉", () => {
    const one = toggleSelected(new Set(), "t-run");
    expect([...one]).toEqual(["t-run"]);
    expect([...toggleSelected(one, "t-run")]).toEqual([]);
    const first = groupSelection(new Set(["t-run", "t-x"]), ["t-run", "t-paused"]);
    expect(first.all).toBe(false);
    expect([...first.next].toSorted()).toEqual(["t-paused", "t-run", "t-x"]);
    const second = groupSelection(first.next, ["t-run", "t-paused"]);
    expect(second.all).toBe(true);
    expect([...second.next]).toEqual(["t-x"]);
    expect(groupSelection(new Set(), []).all).toBe(false);
  });
});
