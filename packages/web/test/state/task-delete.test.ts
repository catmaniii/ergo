// 前端状态层：删除任务、没结束的任务先取消再归档（186 号票）。
// - 看板频道上推来带 deleted 的任务：任务、它的计划、它自己的维护者会话从界面上拿掉（看板、详情、消耗页都不再有，编号写"已删除"）；
//   由项目的维护者做的（项目删掉了才能删）不动别的会话；
// - 能不能删和守护进程同一份规则（taskMenuSubject 的 deleteRefusal）：转为项目了的、项目内部的写明原因；
// - 看板多选：删除对任务和提醒都生效，确认写清几个任务、几条提醒，没结束的先停下，不能删的为什么；归档里有没结束的任务先确认，写明其中几个会先取消。
import { describe, expect, test } from "vitest";
import {
  type BoardBatchEntry,
  boardBatchArchiveConfirm,
  boardBatchBlocked,
  boardBatchDeleteConfirm,
  boardGroups,
  CHANNELS,
  maintainerChannel,
  type Project,
  readableId,
  replay,
  type Task,
  taskMenu,
  taskMenuSubject,
} from "../../src/state/index.ts";
import { frame, textMessage } from "./events.ts";

const T = "2026-10-20T09:00:00.000+08:00";
const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  title: `任务 ${id}`,
  summary: "",
  state: "done",
  kind: "plain",
  origin: "button",
  maintainerId: `tm-${id.slice(2)}`,
  projects: [],
  createdAt: T,
  updatedAt: T,
  ...extra,
});
const project: Project = { id: "p-1", name: "记账本", goal: "记账", state: "preparing", origin: "task", fromTaskId: "t-2", maintainerId: "tm-2", workdir: { external: false }, charterConfirmed: false, createdAt: T, updatedAt: T };

describe("删掉的任务从界面上拿掉", () => {
  test("任务、它的维护者会话拿掉；别的任务、会话不动；编号写成“已删除”", () => {
    const TM1 = maintainerChannel("tm-1");
    const TM3 = maintainerChannel("tm-3");
    const before = [
      frame(CHANNELS.board, 1, "task", { task: task("t-1"), change: "created", from: null, by: "user" }),
      frame(CHANNELS.board, 2, "task", { task: task("t-3"), change: "created", from: null, by: "user" }),
      frame(TM1, 1, "message", { message: textMessage("m-1", "agent", "截图整理好了", TM1) }),
      frame(TM3, 1, "message", { message: textMessage("m-2", "agent", "别的任务", TM3) }),
    ];
    const state = replay([...before, frame(CHANNELS.board, 3, "task", { task: { ...task("t-1"), title: "（这条内容已彻底删除）", deleted: true }, change: "deleted", from: "done", by: "user" })]);
    expect(Object.keys(state.tasks)).toEqual(["t-3"]);
    expect(state.conversations[TM1]).toBeUndefined();
    expect(state.conversations[TM3]).toBeDefined();
    expect(boardGroups(state).flatMap((g) => g.items.flatMap((i) => (i.kind === "task" ? [i.task.id] : [])))).toEqual(["t-3"]);
    expect(readableId({ ...state, caughtUp: true }, "t-1")).toBe("t-1（已删除）");
    expect(readableId({ ...state, caughtUp: true }, "tm-1")).toBe("tm-1（已删除）");
  });

  test("由项目的维护者做的（项目删掉了才能删）：不动维护者的会话", () => {
    const PM1 = maintainerChannel("pm-1");
    const state = replay([
      frame(CHANNELS.board, 1, "task", { task: task("t-4", { maintainerId: "pm-1" }), change: "created", from: null, by: "user" }),
      frame(PM1, 1, "message", { message: textMessage("m-1", "agent", "项目的话", PM1) }),
      frame(CHANNELS.board, 2, "task", { task: { ...task("t-4", { maintainerId: "pm-1" }), deleted: true }, change: "deleted", from: "done", by: "user" }),
    ]);
    expect(state.tasks["t-4"]).toBeUndefined();
    expect(state.conversations[PM1]).toBeDefined();
  });
});

describe("能不能删：和守护进程同一份规则", () => {
  test("转为项目了的（项目还在）写明原因；项目删掉了就能删；项目内部的写明随项目删", () => {
    const converted = task("t-2", { endKind: "converted_to_project" });
    const live = replay([frame(CHANNELS.board, 1, "task", { task: converted, change: "converted_to_project", from: "running", by: "user" }), frame(CHANNELS.projects, 1, "project", { project, change: "created", by: "user" })]);
    expect(taskMenuSubject(live, converted).deleteRefusal).toBe("任务已转为项目「记账本」，会话和工作目录跟着项目走：项目还在时由项目管，删项目时一起删");
    expect(taskMenu(taskMenuSubject(live, converted), "detail").at(-1)).toEqual({
      kind: "delete_note",
      label: "不能删除：任务已转为项目「记账本」，会话和工作目录跟着项目走：项目还在时由项目管，删项目时一起删",
    });
    const gone = replay([frame(CHANNELS.board, 1, "task", { task: converted, change: "converted_to_project", from: "running", by: "user" })]);
    expect(taskMenuSubject(gone, converted).deleteRefusal).toBeUndefined();
    const internal = task("t-5", { maintainerId: "pm-1", internal: { projectId: "p-9", projectName: "资讯站" } });
    expect(taskMenuSubject(gone, internal).deleteRefusal).toBe("这是项目「资讯站」的内部任务，项目还在时由项目管：删项目时它一起删掉");
  });
});

describe("看板多选：删除对任务和提醒都生效，归档里没结束的先取消", () => {
  const run: BoardBatchEntry = { kind: "task", id: "t-run", title: "跑着的", subject: { state: "running" } };
  const done: BoardBatchEntry = { kind: "task", id: "t-done", title: "做完的", subject: { state: "done" } };
  const internal: BoardBatchEntry = { kind: "task", id: "t-in", title: "内部的", subject: { state: "done", deleteRefusal: "项目内部任务，随项目删" } };
  const locked: BoardBatchEntry = {
    kind: "task",
    id: "t-ops",
    title: "日报",
    subject: { state: "operating", triggerActions: ["pause", "cancel"], operationsLock: { projectId: "p-1", note: "这是项目「AI 简报站」运营方案里的一条，要去掉请让项目维护者改运营方案" } },
  };
  const rent: BoardBatchEntry = { kind: "reminder", id: "r-rent", title: "交房租", reminder: { status: "pending" } };

  test("删除的确认：几个任务、几条提醒，没结束的先停下，不能删的写明为什么", () => {
    expect(boardBatchBlocked([run, done, internal, locked, rent], "delete")).toEqual([
      { title: "内部的", why: "项目内部任务，随项目删" },
      { title: "日报", why: "这是项目「AI 简报站」运营方案里的一条，要去掉请让项目维护者改运营方案" },
    ]);
    expect(boardBatchDeleteConfirm({ tasks: 2, running: 1, reminders: 1, blocked: boardBatchBlocked([run, done, internal, rent], "delete") })).toEqual({
      title: "删除 2 个任务、1 条提醒？",
      body: "2 个任务会连同维护者的会话、工作目录和产出一起删掉（其中 1 个还没结束，会先停下再删）；你在里面说过的话作为素材保留，要彻底删在“记忆 · 素材”里删。1 条提醒会删除：还没响的不再提醒，看板、日历、待办里都不再有它们。1 个不能删：「内部的」：项目内部任务，随项目删。删了收不回；只是不想在看板上看到可以“归档”。",
    });
    expect(boardBatchDeleteConfirm({ tasks: 1, reminders: 0 }).title).toBe("删除 1 个任务？");
  });

  test("归档：都结束了的不用确认；有没结束的写明其中几个会先取消，运营方案里的那条写明为什么不能", () => {
    expect(boardBatchArchiveConfirm([done])).toBeUndefined();
    expect(boardBatchArchiveConfirm([run, done, locked, rent])).toEqual({
      title: "归档 2 个？",
      body: "其中 1 个还没结束，会先取消再归档（定时、事件触发的连同触发一起取消）；取消不了的不归档。1 个不能归档：「日报」：这是项目「AI 简报站」运营方案里的一条，要去掉请让项目维护者改运营方案。1 个跳过（现在不能归档）。",
    });
  });
});
