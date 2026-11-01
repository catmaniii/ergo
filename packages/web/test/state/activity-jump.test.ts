// 369 号票：标题上的"等你……"点了去哪。去要处理的那张卡（和待办里这一项的"去看看 ›"同一个去处）；这之前记下的事件没有卡片编号：退回待办；
// 不是在等某张卡的不能点。
import { activityDetailText } from "@ergo/protocol";
import { describe, expect, test } from "vitest";
import { activityJumpRoute, toHash } from "../../src/app/route-hash.ts";
import { type ActivityDetail, activityJump, initialUiState, inboxBarEntries, inboxJump, type Project, type Task, type UiState } from "../../src/state/index.ts";
import { card, cardInboxItem } from "./events.ts";

const world: UiState = {
  ...initialUiState,
  tasks: { "t-1": { id: "t-1", maintainerId: "tm-1" } as Task, "t-4": { id: "t-4", maintainerId: "pm-1" } as Task },
  projects: { "p-1": { id: "p-1", maintainerId: "pm-1" } as Project },
};

/** agent 在等你，说明是 detail */
function waiting(agentId: string, detail: ActivityDetail | undefined, base: UiState = world): UiState {
  return { ...base, activity: { ...base.activity, [agentId]: { agentId, state: "waiting_for_user", since: "2026-11-01T09:00:00.000+08:00", ...(detail ? { detail } : {}) } } };
}
const withItem = (state: UiState, cardId: string, origin: NonNullable<Parameters<typeof cardInboxItem>[2]>["origin"]): UiState => ({
  ...state,
  cards: { ...state.cards, [cardId]: { card: card(cardId, 1) } },
  inbox: { ...state.inbox, [`i-${cardId}`]: cardInboxItem(`i-${cardId}`, cardId, origin ? { origin } : {}) },
});

/** 放久了的提问：事项降到不卡任务、算看过、标上 stale */
const stale = (origin: { conversation?: string; taskId?: string }) => {
  const state = withItem(world, "c-q", origin);
  return { ...state, inbox: { "i-c-q": { ...state.inbox["i-c-q"]!, urgency: "non_blocking" as const, read: true, stale: true } } };
};

describe("去处", () => {
  test("秘书的提问卡：秘书会话，定位到卡；和待办的去看看同一个地方", () => {
    const state = withItem(waiting("secretary", { kind: "clarification", cardId: "c-q" }), "c-q", { conversation: "secretary" });
    expect(activityJump(state, "secretary")).toEqual({ kind: "secretary", at: "c-q" });
    expect(activityJump(state, "secretary")).toEqual(inboxJump(state, state.inbox["i-c-q"]!));
    expect(toHash(activityJumpRoute(activityJump(state, "secretary")!))).toBe("#/secretary/at/c-q");
  });

  test("任务里的审批卡：去任务；项目负责人的卡在内部任务的会话里：跳到那个任务；项目自己的：去项目的会话", () => {
    const own = withItem(waiting("tm-1", { kind: "approval", tool: "读文件", cardId: "c-a" }), "c-a", { taskId: "t-1", conversation: "maintainer:tm-1" });
    expect(activityJump(own, "tm-1")).toEqual({ kind: "task", taskId: "t-1", at: "c-a" });
    const internal = withItem(waiting("pm-1", { kind: "approval", cardId: "c-b" }), "c-b", { taskId: "t-4", projectId: "p-1", conversation: "maintainer:pm-1" });
    expect(toHash(activityJumpRoute(activityJump(internal, "pm-1")!))).toBe("#/tasks/t-4/at/c-b");
    const project = withItem(waiting("pm-1", { kind: "clarification", cardId: "c-c" }), "c-c", { projectId: "p-1" });
    expect(toHash(activityJumpRoute(activityJump(project, "pm-1")!))).toBe("#/projects/p-1/chat/at/c-c");
  });

  test("待办里没有这一项（运行时的提问这类、还没收到）：卡就在这个 agent 自己的会话里", () => {
    expect(activityJump(waiting("secretary", { kind: "clarification", cardId: "c-q" }), "secretary")).toEqual({ kind: "secretary", at: "c-q" });
    expect(activityJump(waiting("tm-1", { kind: "approval", cardId: "c-a" }), "tm-1")).toEqual({ kind: "task", taskId: "t-1", at: "c-a" });
  });

  test("这之前记下的事件没有卡片编号、没有说明、认不出是谁的：不报错，去待办", () => {
    expect(activityJump(waiting("secretary", { kind: "clarification" }), "secretary")).toEqual({ kind: "inbox" });
    expect(activityJump(waiting("secretary", undefined), "secretary")).toEqual({ kind: "inbox" });
    expect(activityJump(waiting("tm-gone", { kind: "approval", cardId: "c-x" }), "tm-gone")).toEqual({ kind: "inbox" });
    expect(toHash(activityJumpRoute({ kind: "inbox" }))).toBe("#/inbox");
  });

  test("不在等你、等的不是卡：不能点", () => {
    expect(activityJump(world, "secretary")).toBeUndefined();
    expect(activityJump({ ...world, activity: { "tm-1": { agentId: "tm-1", state: "working", since: "x" } } }, "tm-1")).toBeUndefined();
    for (const kind of ["runtime_off", "handed_back", "in_remote"] as const) expect(activityJump(waiting("tm-1", { kind }), "tm-1")).toBeUndefined();
  });
});

describe("说法", () => {
  test("有几张在等时写一共几张", () => {
    expect(activityDetailText({ kind: "clarification", cardId: "c-1" })).toBe("等你回答提问");
    expect(activityDetailText({ kind: "clarification", cardId: "c-1", cardCount: 3 })).toBe("等你回答提问（共 3 张）");
    expect(activityDetailText({ kind: "approval", tool: "读文件", cardId: "c-1", cardCount: 2 })).toBe("等你批准：读文件（共 2 张）");
  });
});

describe("放久了的提问", () => {
  test("秘书的不再挂在秘书会话的等你处理栏里；负责人的还卡着工作，任务页照样列", () => {
    expect(inboxBarEntries(stale({ conversation: "secretary" }), { kind: "secretary" })).toEqual([]);
    expect(inboxBarEntries(stale({ taskId: "t-1" }), { kind: "task", taskId: "t-1" }).map((e) => e.at)).toEqual(["c-q"]);
  });
});
