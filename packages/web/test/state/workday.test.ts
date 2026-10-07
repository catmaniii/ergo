// 前端状态层：设置里的工作日历（29 号票）。工作日历频道上的两种事件（节假日数据、个人设置的最新样子）归并进状态，
// 页面用共享协议包的同一个纯函数算出每天上班或休息及原因。主线流程回放主切面录下的 workday-calendar（recorded.test.ts）；
// 这里是手写的边角：还没收到节假日数据、个人设置变了、重新同步。
import { describe, expect, test } from "vitest";
import { dayReasonLabel, type HolidayYear, replay, workdayCalendarOf, workdaySettingsOf } from "../../src/state/index.ts";
import { frame } from "./events.ts";

const CN_2026: HolidayYear = {
  format: 1,
  region: "cn",
  year: 2026,
  sources: [{ title: "测试用", url: "https://example.invalid/" }],
  days: [
    { date: "2026-10-01", name: "国庆节", kind: "holiday" },
    { date: "2026-10-10", name: "国庆节调休上班", kind: "makeup_workday" },
  ],
};

const holidayData = (seq: number, years: HolidayYear[]) => frame("calendar", seq, "holiday_data", { years });
const settings = (seq: number, marks: { date: string; mark: "work" | "rest" }[], rules: unknown[] = []) =>
  frame("calendar", seq, "workday_settings", { settings: { rules, marks }, source: "settings" });

const brief = (state: ReturnType<typeof replay>, date: string) => {
  const day = workdayCalendarOf(state)!.day(date);
  return [day.workday ? "上班" : "休息", ...day.reasons.map(dayReasonLabel)];
};

describe("工作日历", () => {
  test("还没收到节假日数据：算不出来（页面显示加载中）；没有个人设置的事件就是空的", () => {
    const state = replay([]);
    expect(workdayCalendarOf(state)).toBeUndefined();
    expect(workdaySettingsOf(state)).toEqual({ rules: [], marks: [] });
  });

  test("节假日数据加个人设置：每天的结果和原因；个人设置以最新的一条为准", () => {
    const state = replay([holidayData(1, [CN_2026]), settings(2, [{ date: "2026-10-08", mark: "rest" }]), settings(3, [{ date: "2026-10-09", mark: "rest" }], [{ kind: "last_weekday", weekday: 6 }])]);
    expect(brief(state, "2026-10-01")).toEqual(["上班", "新加坡工作日"]);
    expect(brief(state, "2026-10-10")).toEqual(["上班", "调休补班"]);
    expect(brief(state, "2026-10-08")).toEqual(["上班", "新加坡工作日", "国内工作日"]);
    expect(brief(state, "2026-10-09")).toEqual(["休息", "手动标记休息"]);
    expect(brief(state, "2026-10-31")).toEqual(["上班", "额外规则：每月最后一个周六"]);
    // 新加坡 2026 的数据这里没给：标明缺了
    expect(workdayCalendarOf(state)!.missing(2026)).toEqual(["sg"]);
    expect(workdaySettingsOf(state).rules).toEqual([{ kind: "last_weekday", weekday: 6 }]);
  });

  test("重新同步工作日历频道：清掉，接下来从头补发", () => {
    const state = replay([holidayData(1, [CN_2026]), settings(2, [{ date: "2026-10-08", mark: "rest" }]), { kind: "resync", channel: "calendar" }]);
    expect(workdayCalendarOf(state)).toBeUndefined();
    expect(workdaySettingsOf(state)).toEqual({ rules: [], marks: [] });
  });
});
