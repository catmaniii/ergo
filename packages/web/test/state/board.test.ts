// 前端状态层：任务看板（12 号票）。看板频道上的 task 事件是任务的最新状态，按规格的五组显示：
// 等我（等我、待确认）、进行中（规划中、排队中、执行中、已暂停）、运营中（简单提醒、定时作业）、
// 最近结束（已完成、失败、已取消，以及已触发的一次性简单提醒）、已归档。全部任务状态到分组的对应用构造的事件流逐一验证。
import { describe, expect, test } from "vitest";
import { type BoardGroup, boardGroups, type Reminder, replay, type Task, TASK_STATES, type TaskState } from "../../src/state/index.ts";
import { frame } from "./events.ts";

function task(id: string, state: TaskState, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    summary: "",
    state,
    origin: "button",
    maintainerId: `tm-${id}`,
    projects: [],
    createdAt: "2026-10-08T09:00:00.000+08:00",
    updatedAt: "2026-10-08T09:00:00.000+08:00",
    ...overrides,
  };
}

function reminder(id: string, status: Reminder["status"], nextAt?: string): Reminder {
  return {
    id,
    text: id,
    schedule: { kind: "once", at: "2026-10-09T09:00:00.000+08:00" },
    status,
    ...(nextAt === undefined ? {} : { nextAt }),
    cardId: `c-${id}`,
    createdAt: "2026-10-08T09:00:00.000+08:00",
    updatedAt: "2026-10-08T09:00:00.000+08:00",
  };
}

/** 每组里的条目（任务是 id，提醒是 r:id） */
function groupsOf(state: ReturnType<typeof replay>): Record<BoardGroup, string[]> {
  return Object.fromEntries(boardGroups(state).map((g) => [g.group, g.items.map((i) => (i.kind === "task" ? i.task.id : `r:${i.reminder.id}`))])) as Record<BoardGroup, string[]>;
}

describe("任务状态到看板分组", () => {
  test.each([
    ["planning", "active"],
    ["awaiting_confirm", "waiting"],
    ["queued", "active"],
    ["running", "active"],
    ["waiting_for_user", "waiting"],
    ["paused", "active"],
    ["done", "ended"],
    ["failed", "ended"],
    ["cancelled", "ended"],
    ["archived", "archived"],
  ] as const)("%s → %s", (state, group) => {
    const ui = replay([frame("board", 1, "task", { task: task("t-1", state), change: "created", from: null, by: "user" })]);
    expect(groupsOf(ui)[group]).toEqual(["t-1"]);
  });

  test("十种状态都有归属；五组按规格的顺序", () => {
    expect(TASK_STATES).toHaveLength(10);
    const ui = replay(TASK_STATES.map((s, i) => frame("board", i + 1, "task", { task: task(`t-${i + 1}`, s), change: "created", from: null, by: "user" })));
    expect(boardGroups(ui).map((g) => [g.group, g.title, g.items.length])).toEqual([
      ["waiting", "等我", 2],
      ["active", "进行中", 4],
      ["ops", "运营中", 0],
      ["ended", "最近结束", 3],
      ["archived", "已归档", 1],
    ]);
  });

  test("同一个任务的新事件替换旧状态：规划中 → 待确认 → 排队中，从进行中挪到等我再回到进行中", () => {
    const events = [
      frame("board", 1, "task", { task: task("t-1", "planning"), change: "created", from: null, by: "secretary" }),
      frame("board", 2, "task", { task: task("t-1", "awaiting_confirm", { stages: { total: 3 }, planCardId: "c-plan" }), change: "plan_submitted", from: "planning", by: "maintainer" }),
    ];
    expect(groupsOf(replay(events)).waiting).toEqual(["t-1"]);
    const queued = replay([...events, frame("board", 3, "task", { task: task("t-1", "queued", { stages: { total: 3 } }), change: "plan_confirmed", from: "awaiting_confirm", by: "user" })]);
    expect(groupsOf(queued)).toMatchObject({ waiting: [], active: ["t-1"] });
    expect(boardGroups(queued)[1]!.items[0]).toMatchObject({ kind: "task", task: { state: "queued", stages: { total: 3 } } });
  });

  test("同一组里新近有变化的任务在前", () => {
    const ui = replay([
      frame("board", 1, "task", { task: task("t-old", "planning", { updatedAt: "2026-10-08T08:00:00.000+08:00" }), change: "created", from: null, by: "user" }),
      frame("board", 2, "task", { task: task("t-new", "queued", { updatedAt: "2026-10-08T10:00:00.000+08:00" }), change: "created", from: null, by: "user" }),
    ]);
    expect(groupsOf(ui).active).toEqual(["t-new", "t-old"]);
  });
});

describe("简单提醒和活动状态", () => {
  test("待触发的提醒在运营中，已触发的一次性提醒在最近结束，已取消的不上看板", () => {
    const ui = replay([
      frame("board", 1, "reminder", { reminder: reminder("r-1", "pending", "2026-10-09T09:00:00.000+08:00"), change: "created", by: "agent" }),
      frame("board", 2, "reminder", { reminder: reminder("r-2", "fired"), change: "fired", by: "system" }),
      frame("board", 3, "reminder", { reminder: reminder("r-3", "cancelled"), change: "cancelled", by: "user" }),
    ]);
    expect(groupsOf(ui)).toMatchObject({ ops: ["r:r-1"], ended: ["r:r-2"] });
  });

  test("任务卡带上它的维护者的活动状态（排队）；重新同步看板频道清掉任务和提醒", () => {
    const ui = replay([
      frame("board", 1, "task", { task: task("t-1", "planning"), change: "created", from: null, by: "user" }),
      frame("activity", 1, "activity", { agentId: "tm-t-1", state: "queued", since: "2026-10-08T09:00:01.000+08:00" }),
    ]);
    expect(boardGroups(ui)[1]!.items[0]).toMatchObject({ kind: "task", activity: { state: "queued" } });
    const cleared = replay([{ kind: "resync", channel: "board" }], ui);
    expect(boardGroups(cleared).flatMap((g) => g.items)).toEqual([]);
    expect(cleared.activity["tm-t-1"]?.state).toBe("queued");
  });
});
