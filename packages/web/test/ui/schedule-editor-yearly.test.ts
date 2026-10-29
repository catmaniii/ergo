// 提醒卡、改时间对话框里的时间表编辑（ui/cards/cards.tsx 的 ScheduleEditor）多了"每年"（282 号票）：重复规则能选每年，
// 选了出几月、几日两个下拉，几日跟着月份最多到月底（2 月能选到 29 日）；下面一行写成"每年 10 月 12 日 09:00"。用 React 在 Node 里渲染出来查。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { ReminderSchedule } from "../../src/state/index.ts";
import { ScheduleEditor } from "../../src/ui/cards/cards.tsx";

const render = (value: ReminderSchedule) => renderToStaticMarkup(createElement(ScheduleEditor, { value, onChange: () => undefined }));
/** 某个下拉（按 aria-label 找）里的选项文字 */
const optionsOf = (html: string, label: string): string[] => {
  const select = new RegExp(`<select[^>]*aria-label="${label}"[^>]*>(.*?)</select>`).exec(html)?.[1] ?? "";
  return [...select.matchAll(/<option[^>]*>(.*?)<\/option>/g)].map((m) => m[1]!);
};

describe("时间表编辑里的每年", () => {
  test("重复规则的下拉里有每年（排在每月几号后面）", () => {
    const html = render({ kind: "once", at: "2026-10-08T09:00:00.000+08:00" });
    expect([...html.matchAll(/<option value="(\w+)"/g)].map((m) => m[1])).toEqual(["once", "daily", "weekly", "monthly", "yearly", "workdays"]);
    expect(html).toContain(">每年</option>");
    expect(html).not.toContain('aria-label="几月"');
  });

  test("选了每年：几月、几日两个下拉，选中的是规则里的那天；下面一行写成每年几月几日几点", () => {
    const html = render({ kind: "yearly", time: "09:00", month: 10, day: 12 });
    expect(html).toContain('<option value="yearly" selected="">每年</option>');
    expect(optionsOf(html, "几月")).toEqual(["1 月", "2 月", "3 月", "4 月", "5 月", "6 月", "7 月", "8 月", "9 月", "10 月", "11 月", "12 月"]);
    expect(html).toContain('<option value="10" selected="">10 月</option>');
    expect(optionsOf(html, "几日")).toHaveLength(31);
    expect(html).toContain('<option value="12" selected="">12 日</option>');
    expect(html).toContain("改成：每年 10 月 12 日 09:00");
  });

  test("几日跟着月份到月底：2 月能选到 29 日（写明平年在 2 月 28 日响），4 月到 30 日", () => {
    const feb = render({ kind: "yearly", time: "09:00", month: 2, day: 29 });
    expect(optionsOf(feb, "几日").at(-1)).toBe("29 日");
    expect(feb).toContain("改成：每年 2 月 29 日 09:00（平年在 2 月 28 日）");
    expect(optionsOf(render({ kind: "yearly", time: "09:00", month: 4, day: 1 }), "几日")).toHaveLength(30);
  });
});
