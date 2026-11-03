// 提醒卡、改时间对话框、发起对话框"定时"里的时间表编辑（ui/cards/cards.tsx 的 ScheduleEditor）多了"每 N 天"：
// 选了出"每几天"（2–365 的数字）和"从哪天起"（日期）两栏；下面一行写成"每 2 天 20:00，从 11 月 3 日起"。
// 发起对话框的"定时"只能选重复的（repeatOnly），里面也有它。用 React 在 Node 里渲染出来查。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { ReminderSchedule } from "../../src/state/index.ts";
import { ScheduleEditor } from "../../src/ui/cards/cards.tsx";

const render = (value: ReminderSchedule, repeatOnly = false) => renderToStaticMarkup(createElement(ScheduleEditor, { value, onChange: () => undefined, repeatOnly }));
/** 某个输入框（按类型找）的属性 */
const inputOf = (html: string, type: string): string => new RegExp(`<input[^>]*type="${type}"[^>]*>`).exec(html)?.[0] ?? "";

describe("时间表编辑里的每 N 天", () => {
  const everyOther: ReminderSchedule = { kind: "everyNDays", time: "20:00", interval: 2, anchor: "2026-11-03" };

  test("重复规则的下拉里有每 N 天（排在每天后面）；没选它时不出那两栏", () => {
    const html = render({ kind: "daily", time: "20:00" });
    expect(html).toContain('<option value="everyNDays">每 N 天</option>');
    expect(html).not.toContain("每几天");
    expect(html).not.toContain('type="date"');
  });

  test("选了每 N 天：每几天（2–365）、从哪天起两栏，填的是规则里的；下面一行写成每 2 天 20:00，从 11 月 3 日起", () => {
    const html = render(everyOther);
    expect(html).toContain('<option value="everyNDays" selected="">每 N 天</option>');
    expect(html).toContain("<span>每几天</span>");
    const interval = inputOf(html, "number");
    expect(interval).toContain('value="2"');
    expect(interval).toContain('min="2"');
    expect(interval).toContain('max="365"');
    expect(html).toContain("<span>从哪天起</span>");
    expect(inputOf(html, "date")).toContain('value="2026-11-03"');
    expect(inputOf(html, "time")).toContain('value="20:00"');
    expect(html).toContain("改成：每 2 天 20:00，从 11 月 3 日起");
  });

  test("发起对话框的定时（只能选重复的）也能选每 N 天，没有一次性", () => {
    const html = render(everyOther, true);
    expect([...html.matchAll(/<option value="(\w+)"/g)].map((m) => m[1])).toEqual(["daily", "everyNDays", "weekly", "monthly", "yearly", "workdays"]);
    expect(html).toContain("每 2 天 20:00，从 11 月 3 日起");
  });
});
