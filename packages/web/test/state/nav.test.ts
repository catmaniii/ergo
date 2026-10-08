// 前端状态层：主导航按空间自适应（33 号票）。导航项按固定顺序排——秘书、任务、项目、待我处理、日历（35 号票加）、消耗、记忆、设置——
// 放得下的直接显示，放不下的从末尾起收进"更多"；有收起的才出现"更多"，"更多"自己也要放得下。
// 长度是界面量出来的（横屏是竖栏的高度、竖屏是底部横栏的宽度），这里直接给数。
// 36 号票起秘书在界面上叫"个人助理"（四个字）：竖栏里和"待我处理"一样换成两行，底部横栏里刚好撑满一格的最小宽度。
import { describe, expect, test } from "vitest";
import { fitNav, navHighlight, type NavItem, type NavMeasures } from "../../src/state/index.ts";

/** 横屏竖栏里量出来的样子：每项 54 高，"个人助理""待我处理"换成两行是 70 */
const RAIL: Omit<NavMeasures, "available"> = {
  sizes: { secretary: 70, tasks: 54, projects: 54, inbox: 70, calendar: 54, usage: 54, memory: 54, settings: 54 },
  more: 54,
};
const RAIL_ALL = 54 * 6 + 70 * 2; // 464
/** 最少直接显示的几项（个人助理、任务、项目、待我处理）加"更多" */
const RAIL_MIN = 70 + 54 + 54 + 70 + 54; // 302

const fit = (available: number, measures = RAIL) => fitNav({ ...measures, available });

const ALL: NavItem[] = ["secretary", "tasks", "projects", "inbox", "calendar", "usage", "memory", "settings"];

describe("主导航按空间自适应", () => {
  test.each<[string, number, NavItem[], NavItem[]]>([
    ["全都放得下：不显示更多", 600, ALL, []],
    ["刚好全都放得下", RAIL_ALL, ALL, []],
    // 差 1 放不下全部：收起设置之后还要给"更多"留地方，"更多"和设置一样长，所以记忆也得收起
    ["刚好放不下一个：从末尾起收，给更多留出地方", RAIL_ALL - 1, ["secretary", "tasks", "projects", "inbox", "calendar", "usage"], ["memory", "settings"]],
    ["只放得下最少的几个：个人助理、任务、项目、待我处理加更多（日历收进更多）", RAIL_MIN, ["secretary", "tasks", "projects", "inbox"], ["calendar", "usage", "memory", "settings"]],
    ["比最少的几个多一点也放不下第五个：日历加进来就要 356", RAIL_MIN + 53, ["secretary", "tasks", "projects", "inbox"], ["calendar", "usage", "memory", "settings"]],
    ["日历刚好放得下：日历跟在待我处理后面直接显示", RAIL_MIN + 54, ["secretary", "tasks", "projects", "inbox", "calendar"], ["usage", "memory", "settings"]],
    ["个人助理按原来秘书的高度（54）算的话放得下全部，换成两行（70）之后就放不下了", 54 * 7 + 70, ["secretary", "tasks", "projects", "inbox", "calendar", "usage"], ["memory", "settings"]],
  ])("%s", (_name, available, shown, folded) => {
    expect(fit(available)).toEqual({ shown, folded });
  });

  test("更多比末尾的项短：只收起放不下的那一个", () => {
    const measures = { ...RAIL, more: 30 };
    expect(fit(RAIL_ALL - 1, measures)).toEqual({ shown: ["secretary", "tasks", "projects", "inbox", "calendar", "usage", "memory"], folded: ["settings"] });
  });

  test("竖屏底部横栏按宽度：390 宽的手机上放得下个人助理、任务、项目、待我处理、日历，其余收进更多", () => {
    // 横栏里每格最少 56 宽；"个人助理""待我处理"四个字（11px）加左右内边距刚好 56，不比别的宽
    const bar: Omit<NavMeasures, "available"> = { sizes: { secretary: 56, tasks: 56, projects: 56, inbox: 56, calendar: 56, usage: 56, memory: 56, settings: 56 }, more: 56 };
    expect(fit(390, bar)).toEqual({ shown: ["secretary", "tasks", "projects", "inbox", "calendar"], folded: ["usage", "memory", "settings"] });
    expect(fit(320, bar)).toEqual({ shown: ["secretary", "tasks", "projects", "inbox"], folded: ["calendar", "usage", "memory", "settings"] });
    expect(fit(56 * 8, bar)).toEqual({ shown: ALL, folded: [] });
  });

  test("横栏里个人助理的字更大、比别的格宽（比如系统放大了字号）：按量出来的宽度算，多占的地方从末尾挤掉", () => {
    const bar: Omit<NavMeasures, "available"> = { sizes: { secretary: 72, tasks: 56, projects: 56, inbox: 72, calendar: 56, usage: 56, memory: 56, settings: 56 }, more: 56 };
    // 全部：72 * 2 + 56 * 6 = 480；390 放不下，收起消耗、记忆、设置后 72 * 2 + 56 * 3 + 56 = 368
    expect(fit(390, bar)).toEqual({ shown: ["secretary", "tasks", "projects", "inbox", "calendar"], folded: ["usage", "memory", "settings"] });
    expect(fit(480, bar).folded).toEqual([]);
    expect(fit(367, bar)).toEqual({ shown: ["secretary", "tasks", "projects", "inbox"], folded: ["calendar", "usage", "memory", "settings"] });
  });

  test("比最少的几个还挤：个人助理、任务、项目、待我处理照样直接显示（导航条自己滚动），其余收进更多", () => {
    expect(fit(100)).toEqual({ shown: ["secretary", "tasks", "projects", "inbox"], folded: ["calendar", "usage", "memory", "settings"] });
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
