// 前端状态层：主导航按空间自适应（33 号票）。导航项按固定顺序排——秘书、任务、项目、待我处理、日历（35 号票加）、消耗、记忆、设置——
// 放得下的直接显示，放不下的从末尾起收进"更多"；有收起的才出现"更多"，"更多"自己也要放得下。
// 长度是界面量出来的（横屏是竖栏的高度、竖屏是底部横栏的宽度），这里直接给数。
// 43 号票起导航上每一项的名字都是两个字（待我处理叫"待办"；秘书那一项 89 号票起固定写"秘书"，不随起的名字变），图标在上、字在下，
// 竖栏按"图标 + 两个字"收窄：竖栏里每项一样高（一行字），横栏里每格一样宽（两个字不到一格的最小宽度）。
import { describe, expect, test } from "vitest";
import { fitNav, NAV_LABELS, navBadgeCount, navHighlight, nextNavFit, type NavItem, type NavMeasures } from "../../src/state/index.ts";

/** 横屏竖栏里量出来的样子：图标在上、一行字在下，每项 51 高（"更多"一样） */
const RAIL: Omit<NavMeasures, "available"> = {
  sizes: { secretary: 51, tasks: 51, projects: 51, inbox: 51, calendar: 51, usage: 51, memory: 51, settings: 51 },
  more: 51,
};
const RAIL_ALL = 51 * 8; // 408
/** 最少直接显示的几项（秘书、任务、项目、待办）加"更多" */
const RAIL_MIN = 51 * 5; // 255

const fit = (available: number, measures = RAIL) => fitNav({ ...measures, available });

const ALL: NavItem[] = ["secretary", "tasks", "projects", "inbox", "calendar", "usage", "memory", "settings"];

describe("主导航按空间自适应", () => {
  test.each<[string, number, NavItem[], NavItem[]]>([
    ["全都放得下：不显示更多", 600, ALL, []],
    ["刚好全都放得下", RAIL_ALL, ALL, []],
    // 差 1 放不下全部：收起设置之后还要给"更多"留地方，"更多"和设置一样长，所以记忆也得收起
    ["刚好放不下一个：从末尾起收，给更多留出地方", RAIL_ALL - 1, ["secretary", "tasks", "projects", "inbox", "calendar", "usage"], ["memory", "settings"]],
    ["只放得下最少的几个：秘书、任务、项目、待办加更多（日历收进更多）", RAIL_MIN, ["secretary", "tasks", "projects", "inbox"], ["calendar", "usage", "memory", "settings"]],
    ["比最少的几个多一点也放不下第五个：日历加进来就要 306", RAIL_MIN + 50, ["secretary", "tasks", "projects", "inbox"], ["calendar", "usage", "memory", "settings"]],
    ["日历刚好放得下：日历跟在待办后面直接显示", RAIL_MIN + 51, ["secretary", "tasks", "projects", "inbox", "calendar"], ["usage", "memory", "settings"]],
    // 43 号票之前"个人助理""待我处理"在竖栏里折成两行（70 高），全部要 464；现在每项一行，408 就放得下
    ["名字都是两个字以后：原来要 464 才放得下全部，现在 408", 408, ALL, []],
  ])("%s", (_name, available, shown, folded) => {
    expect(fit(available)).toEqual({ shown, folded });
  });

  test("更多比末尾的项短：只收起放不下的那一个", () => {
    const measures = { ...RAIL, more: 30 };
    expect(fit(RAIL_ALL - 1, measures)).toEqual({ shown: ["secretary", "tasks", "projects", "inbox", "calendar", "usage", "memory"], folded: ["settings"] });
  });

  test("竖屏底部横栏按宽度：每格最少 56 宽（两个字加内边距不到 56）；390 宽的手机上放得下秘书、任务、项目、待办、日历，其余收进更多", () => {
    const bar: Omit<NavMeasures, "available"> = { sizes: { secretary: 56, tasks: 56, projects: 56, inbox: 56, calendar: 56, usage: 56, memory: 56, settings: 56 }, more: 56 };
    expect(fit(390, bar)).toEqual({ shown: ["secretary", "tasks", "projects", "inbox", "calendar"], folded: ["usage", "memory", "settings"] });
    expect(fit(320, bar)).toEqual({ shown: ["secretary", "tasks", "projects", "inbox"], folded: ["calendar", "usage", "memory", "settings"] });
    expect(fit(56 * 8, bar)).toEqual({ shown: ALL, folded: [] });
  });

  test("横栏里秘书那一格比别的宽（比如系统放大了字号）：按量出来的宽度算，多占的地方从末尾挤掉", () => {
    const bar: Omit<NavMeasures, "available"> = { sizes: { secretary: 72, tasks: 56, projects: 56, inbox: 72, calendar: 56, usage: 56, memory: 56, settings: 56 }, more: 56 };
    // 全部：72 * 2 + 56 * 6 = 480；390 放不下，收起消耗、记忆、设置后 72 * 2 + 56 * 3 + 56 = 368
    expect(fit(390, bar)).toEqual({ shown: ["secretary", "tasks", "projects", "inbox", "calendar"], folded: ["usage", "memory", "settings"] });
    expect(fit(480, bar).folded).toEqual([]);
    expect(fit(367, bar)).toEqual({ shown: ["secretary", "tasks", "projects", "inbox"], folded: ["calendar", "usage", "memory", "settings"] });
  });

  test("比最少的几个还挤：秘书、任务、项目、待办照样直接显示（导航条自己滚动），其余收进更多", () => {
    expect(fit(100)).toEqual({ shown: ["secretary", "tasks", "projects", "inbox"], folded: ["calendar", "usage", "memory", "settings"] });
  });
});

describe("打字时不往更多里收（2026-10-12：平板上一点输入框，输入法让竖栏矮了一半）", () => {
  const roomy = fit(RAIL_ALL);
  const squeezed = fit(RAIL_MIN);

  test("打着字、量出来要收起：保持原样，设置不会忽然收进更多", () => {
    expect(nextNavFit(roomy, squeezed, true)).toBe(roomy);
  });

  test("没在打字时照常收起；放得下更多时打着字也照常放出", () => {
    expect(nextNavFit(roomy, squeezed, false)).toBe(squeezed);
    expect(nextNavFit(squeezed, roomy, true)).toBe(roomy);
  });

  test("直接显示的个数没变：沿用原来的，不触发重画", () => {
    expect(nextNavFit(roomy, fit(RAIL_ALL + 10), false)).toBe(roomy);
  });
});

describe("导航上每一项写的字（43 号票：一律两个字）", () => {
  test("秘书那一项固定写“秘书”（89 号票：不再写起的名字或“助理”），待我处理写“待办”，别的照旧", () => {
    expect(NAV_LABELS).toEqual({
      secretary: "秘书",
      tasks: "任务",
      projects: "项目",
      inbox: "待办",
      calendar: "日历",
      usage: "消耗",
      memory: "记忆",
      settings: "设置",
      more: "更多",
    });
  });

  test.each<[number, string]>([
    [1, "1"],
    [12, "12"],
    [99, "99"],
    [100, "99+"],
    [1234, "99+"],
  ])("图标右上角的数字：%i 件写「%s」（太大时 99+，不撑宽）", (count, text) => {
    expect(navBadgeCount(count)).toBe(text);
  });
});

describe("当前页高亮", () => {
  const roomy = fit(RAIL_ALL);
  const tight = fit(RAIL_MIN);

  test("当前页的项直接显示着：高亮它自己", () => {
    expect(navHighlight(roomy, "settings")).toBe("settings");
    expect(navHighlight(roomy, "calendar")).toBe("calendar");
    expect(navHighlight(tight, "inbox")).toBe("inbox");
  });

  test("当前页的项收进了更多：高亮更多", () => {
    expect(navHighlight(tight, "settings")).toBe("more");
    expect(navHighlight(tight, "usage")).toBe("more");
    expect(navHighlight(tight, "calendar")).toBe("more");
  });

  test("就在更多页上：高亮更多；全都放得下、没有更多时谁也不高亮", () => {
    expect(navHighlight(tight, "more")).toBe("more");
    expect(navHighlight(roomy, "more")).toBeUndefined();
  });
});
