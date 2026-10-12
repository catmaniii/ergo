// 页面路由的地址（app/route-hash.ts）：日历的地址（35 号票）。#/calendar 看本月，#/calendar/YYYY-MM 看那个月，#/calendar/YYYY-MM-DD 展开那一天；
// 月份、日期写错了或不存在（2026-13、2026-02-30）当成没带，回到本月——日历页渲染时拆不出来会整页白屏。
// 日历里点作业去看板、项目页上它那一项的地址也在这里；设置里改了名的页认旧地址。
// 74 号票：设置里的"外观与风格"是设置下面的一页（#/more/appearance），点进去才是具体选项。
import { describe, expect, test } from "vitest";
import { inboxJumpRoute, navItemOf, parseHash, type Route, toHash } from "../../src/app/route-hash.ts";
import type { InboxJump } from "../../src/state/index.ts";

describe("日历的地址", () => {
  test.each<[string, Route]>([
    ["#/calendar", { tab: "calendar", month: undefined }],
    ["#/calendar/2026-10", { tab: "calendar", month: "2026-10" }],
    ["#/calendar/2026-10-08", { tab: "calendar", date: "2026-10-08" }],
    ["#/calendar/2026-13", { tab: "calendar", month: undefined }],
    ["#/calendar/2026-00", { tab: "calendar", month: undefined }],
    ["#/calendar/2026-02-30", { tab: "calendar", month: undefined }],
    ["#/calendar/2026-1", { tab: "calendar", month: undefined }],
    ["#/calendar/明天", { tab: "calendar", month: undefined }],
  ])("%s", (hash, route) => {
    expect(parseHash(hash)).toMatchObject(route);
  });

  test("拼出来的地址再拆回去是同一个；日历属于主导航的日历一项", () => {
    for (const route of [{ tab: "calendar" }, { tab: "calendar", month: "2027-01" }, { tab: "calendar", date: "2026-10-12" }] as const) {
      expect(parseHash(toHash(route))).toMatchObject(route);
      expect(navItemOf(route)).toBe("calendar");
    }
  });
});

describe("从日历点作业过去的地址", () => {
  test("不属于项目的去看板上它的作业卡，属于项目的去项目页上它那一行", () => {
    expect(toHash({ tab: "tasks", jobId: "j-1" })).toBe("#/tasks/jobs/j-1");
    expect(parseHash("#/tasks/jobs/j-1")).toEqual({ tab: "tasks", jobId: "j-1" });
    expect(toHash({ tab: "projects", projectId: "p-1", jobId: "j-2" })).toBe("#/projects/p-1/jobs/j-2");
    expect(parseHash("#/projects/p-1/jobs/j-2")).toEqual({ tab: "projects", projectId: "p-1", jobId: "j-2" });
    // 原来的任务、项目地址不变
    expect(parseHash("#/tasks/t-1")).toEqual({ tab: "tasks", taskId: "t-1" });
    expect(parseHash("#/projects/p-1/chat")).toEqual({ tab: "projects", projectId: "p-1", chat: true });
  });
});

test("设置里的工作日历改名为工作日规则：旧地址认作新页", () => {
  expect(parseHash("#/more/workday-calendar")).toEqual({ tab: "more", page: "workday-rules" });
  expect(parseHash("#/more/workday-rules")).toEqual({ tab: "more", page: "workday-rules" });
  expect(navItemOf({ tab: "more", page: "workday-rules" })).toBe("settings");
});

test("外观与风格是设置下面的一页：地址拆得开、拼得回，属于主导航的设置", () => {
  expect(parseHash("#/more/appearance")).toEqual({ tab: "more", page: "appearance" });
  expect(toHash({ tab: "more", page: "appearance" })).toBe("#/more/appearance");
  expect(navItemOf({ tab: "more", page: "appearance" })).toBe("settings");
});

test("系统提示是设置下面的一页，点进某一份是下一级（71 号票）：地址拆得开、拼得回，属于主导航的设置", () => {
  expect(parseHash("#/more/prompts")).toEqual({ tab: "more", page: "prompts" });
  expect(parseHash("#/more/prompts/secretary")).toEqual({ tab: "more", page: "prompts", item: "secretary" });
  expect(toHash({ tab: "more", page: "prompts", item: "multi-project-maintainer" })).toBe("#/more/prompts/multi-project-maintainer");
  expect(parseHash(toHash({ tab: "more", page: "prompts", item: "task-maintainer" }))).toEqual({ tab: "more", page: "prompts", item: "task-maintainer" });
  expect(navItemOf({ tab: "more", page: "prompts", item: "secretary" })).toBe("settings");
  // 别的页没有下一级：多出来的一截不认
  expect(parseHash("#/more/skills/x")).toEqual({ tab: "more", page: "skills" });
});

test("模型是设置下面的一页（73 号票）：地址拆得开、拼得回，属于主导航的设置", () => {
  expect(parseHash("#/more/models")).toEqual({ tab: "more", page: "models" });
  expect(toHash({ tab: "more", page: "models" })).toBe("#/more/models");
  expect(navItemOf({ tab: "more", page: "models" })).toBe("settings");
});

// 105 号票：待办里"去看看 ›"去的地址，会话里要定位的那一条（卡片、调用）写在 /at/ 后面
describe("待办里跳过去的地址", () => {
  test.each<[string, InboxJump, string]>([
    ["任务的整页，定位到卡", { kind: "task", taskId: "t-1", at: "c-1" }, "#/tasks/t-1/at/c-1"],
    ["任务的整页", { kind: "task", taskId: "t-1" }, "#/tasks/t-1"],
    ["项目的维护者会话，定位到卡", { kind: "project", projectId: "p-1", chat: true, at: "c-2" }, "#/projects/p-1/chat/at/c-2"],
    ["项目的维护者会话", { kind: "project", projectId: "p-1", chat: true }, "#/projects/p-1/chat"],
    ["项目页（删除项目的确认）", { kind: "project", projectId: "p-1", chat: false }, "#/projects/p-1"],
    ["项目页上那个作业", { kind: "project", projectId: "p-1", chat: false, jobId: "j-1" }, "#/projects/p-1/jobs/j-1"],
    ["秘书会话，定位到调用", { kind: "secretary", at: "call:1" }, "#/secretary/at/call%3A1"],
    ["秘书会话", { kind: "secretary" }, "#/secretary"],
    ["日历上那一天", { kind: "calendar", date: "2026-10-07" }, "#/calendar/2026-10-07"],
    ["看板", { kind: "board" }, "#/tasks"],
    ["看板上那张作业卡", { kind: "board", jobId: "j-2" }, "#/tasks/jobs/j-2"],
    ["设置里那一页", { kind: "settings", page: "workday-rules" }, "#/more/workday-rules"],
    ["配对批准页", { kind: "pairing", cardId: "c-3" }, "#/pair/approve/c-3"],
  ])("%s", (_what, jump, hash) => {
    const route = inboxJumpRoute(jump);
    expect(toHash(route)).toBe(hash);
    // 拆回来是同一个地方
    expect(parseHash(hash)).toMatchObject(route);
  });

  test("原来的地址不受影响", () => {
    expect(parseHash("#/secretary")).toEqual({ tab: "secretary" });
    expect(parseHash("#/tasks/t-1/at")).toEqual({ tab: "tasks", taskId: "t-1" });
    expect(parseHash("#/projects/p-1/chat/at")).toEqual({ tab: "projects", projectId: "p-1", chat: true });
  });
});
