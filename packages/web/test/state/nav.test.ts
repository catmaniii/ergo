// 前端状态层：主导航按空间自适应（33 号票）。导航项按固定顺序排——秘书、任务、项目、待我处理、消耗、记忆、设置——
// 放得下的直接显示，放不下的从末尾起收进"更多"；有收起的才出现"更多"，"更多"自己也要放得下。
// 长度是界面量出来的（横屏是竖栏的高度、竖屏是底部横栏的宽度），这里直接给数。
import { describe, expect, test } from "vitest";
import { fitNav, navHighlight, type NavItem, type NavMeasures } from "../../src/state/index.ts";

/** 横屏竖栏里量出来的样子：每项 54 高，"待我处理"换成两行是 70 */
const RAIL: Omit<NavMeasures, "available"> = {
  sizes: { secretary: 54, tasks: 54, projects: 54, inbox: 70, usage: 54, memory: 54, settings: 54 },
  more: 54,
};
const RAIL_ALL = 54 * 6 + 70; // 394

const fit = (available: number, measures = RAIL) => fitNav({ ...measures, available });

describe("主导航按空间自适应", () => {
  test.each<[string, number, NavItem[], NavItem[]]>([
    ["全都放得下：不显示更多", 600, ["secretary", "tasks", "projects", "inbox", "usage", "memory", "settings"], []],
    ["刚好全都放得下", RAIL_ALL, ["secretary", "tasks", "projects", "inbox", "usage", "memory", "settings"], []],
    // 差 1 放不下全部：收起设置之后还要给"更多"留地方，"更多"和设置一样长，所以记忆也得收起
    ["刚好放不下一个：从末尾起收，给更多留出地方", RAIL_ALL - 1, ["secretary", "tasks", "projects", "inbox", "usage"], ["memory", "settings"]],
    ["只放得下最少的几个：秘书、任务、项目、待我处理加更多", 54 * 4 + 70, ["secretary", "tasks", "projects", "inbox"], ["usage", "memory", "settings"]],
  ])("%s", (_name, available, shown, folded) => {
    expect(fit(available)).toEqual({ shown, folded });
  });

  test("更多比末尾的项短：只收起放不下的那一个", () => {
    const measures = { ...RAIL, more: 30 };
    expect(fit(RAIL_ALL - 1, measures)).toEqual({ shown: ["secretary", "tasks", "projects", "inbox", "usage", "memory"], folded: ["settings"] });
  });

  test("竖屏底部横栏按宽度：390 宽的手机上放得下秘书、任务、项目、待我处理、消耗，其余收进更多", () => {
    const bar: Omit<NavMeasures, "available"> = { sizes: { secretary: 56, tasks: 56, projects: 56, inbox: 56, usage: 56, memory: 56, settings: 56 }, more: 56 };
    expect(fit(390, bar)).toEqual({ shown: ["secretary", "tasks", "projects", "inbox", "usage"], folded: ["memory", "settings"] });
    expect(fit(320, bar)).toEqual({ shown: ["secretary", "tasks", "projects", "inbox"], folded: ["usage", "memory", "settings"] });
    expect(fit(56 * 7, bar)).toEqual({ shown: ["secretary", "tasks", "projects", "inbox", "usage", "memory", "settings"], folded: [] });
  });

  test("比最少的几个还挤：秘书、任务、项目、待我处理照样直接显示（导航条自己滚动），其余收进更多", () => {
    expect(fit(100)).toEqual({ shown: ["secretary", "tasks", "projects", "inbox"], folded: ["usage", "memory", "settings"] });
  });
});

describe("当前页高亮", () => {
  const roomy = fit(RAIL_ALL);
  const tight = fit(54 * 4 + 70);

  test("当前页的项直接显示着：高亮它自己", () => {
    expect(navHighlight(roomy, "settings")).toBe("settings");
    expect(navHighlight(tight, "inbox")).toBe("inbox");
  });

  test("当前页的项收进了更多：高亮更多", () => {
    expect(navHighlight(tight, "settings")).toBe("more");
    expect(navHighlight(tight, "usage")).toBe("more");
  });

  test("就在更多页上：高亮更多；全都放得下、没有更多时谁也不高亮", () => {
    expect(navHighlight(tight, "more")).toBe("more");
    expect(navHighlight(roomy, "more")).toBeUndefined();
  });
});
