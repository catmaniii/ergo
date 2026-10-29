// iCal 解析和重复事件展开（297 号票，Google 插件的日历）：只用编的 .ics 内容，不连 Google。
// - 解析：续行、转义、带引号的参数、日历的名字和默认时区、嵌着的 VALARM 不算、没有 UID 的跳过、说明截短、不是日历的认出来；
// - 展开：单次（UTC、全天、跨几天）、按 TZID 的本地时间重复（跨夏令时还是 09:00）、DAILY / WEEKLY / MONTHLY / YEARLY 加
//   INTERVAL / COUNT / UNTIL / BYDAY（带序号）/ BYMONTHDAY / BYSETPOS、EXDATE、RECURRENCE-ID 改期和取消、整个取消、
//   认不得的规则只给第一次、认不得的时区退回日历的默认时区、很早开始的重复事件只展开要看的那一段。
import { describe, expect, it } from "vitest";
import { DESCRIPTION_MAX, eventKey, type IcalEvent, NotIcalError, parseIcal } from "../../src/google/ical.ts";
import { expandEvents } from "../../src/google/recurrence.ts";
import { wallToUtc } from "../../src/google/time-zone.ts";

/** 拼一份 .ics（CRLF） */
const ics = (...lines: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Google Inc//Google Calendar 70.9054//EN", ...lines, "END:VCALENDAR", ""].join("\r\n");
const vevent = (...lines: string[]) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"];

/** 一段时间：UTC 的起止 */
const span = (from: string, to: string) => ({ from: Date.parse(from), to: Date.parse(to) });
/** 展开后压成一行一次：带时刻的写 UTC 的 ISO，全天的写日期 */
function expand(events: readonly IcalEvent[], from: string, to: string, timeZone?: string): string[] {
  return expandEvents(events, span(from, to), timeZone === undefined ? {} : { timeZone }).occurrences.map((o) =>
    o.allDay ? `${o.startDate}..${o.endDate} ${o.event.summary}` : `${new Date(o.start).toISOString()}..${new Date(o.end).toISOString()} ${o.event.summary}`,
  );
}
const one = (...lines: string[]) => parseIcal(ics(...vevent(...lines))).events;

describe("解析 .ics", () => {
  it("续行、转义、带引号的参数、日历的名字和默认时区；嵌着的 VALARM 不算；没有 UID、没有开始的跳过", () => {
    const text = ics(
      "X-WR-CALNAME:工作\\, 家里",
      "X-WR-TIMEZONE:Asia/Singapore",
      "BEGIN:VTIMEZONE",
      "TZID:Asia/Singapore",
      "END:VTIMEZONE",
      ...vevent(
        "UID:a1@google.com",
        "DTSTART;TZID=\"Asia/Singapore\":20261026T090000",
        "DTEND;TZID=Asia/Singapore:20261026T100000",
        "SUMMARY:周会：讨论 Q4\\; 带上",
        "  电脑",
        "LOCATION:3 楼\\, 大会议室",
        "DESCRIPTION:第一行\\n第二行\\\\结束",
        "STATUS:CONFIRMED",
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        "DESCRIPTION:提醒的说明不算",
        "TRIGGER:-PT10M",
        "END:VALARM",
      ),
      ...vevent("SUMMARY:没有 UID", "DTSTART:20261026T010000Z"),
      ...vevent("UID:no-start@google.com", "SUMMARY:没有开始"),
    );
    const calendar = parseIcal(text);
    expect(calendar.name).toBe("工作, 家里");
    expect(calendar.timeZone).toBe("Asia/Singapore");
    expect(calendar.events).toEqual([
      {
        uid: "a1@google.com",
        summary: "周会：讨论 Q4; 带上 电脑",
        location: "3 楼, 大会议室",
        description: "第一行\n第二行\\结束",
        status: "confirmed",
        start: { value: "20261026T090000", tz: "Asia/Singapore" },
        end: { value: "20261026T100000", tz: "Asia/Singapore" },
      },
    ]);
  });

  it("全天、UTC、时长、重复规则、EXDATE（一行几个、几行）、RECURRENCE-ID；说明太长截到 1000 字", () => {
    const [allDay, weekly, moved] = parseIcal(
      ics(
        ...vevent("UID:b@google.com", "DTSTART;VALUE=DATE:20261026", "DTEND;VALUE=DATE:20261028", "SUMMARY:出差", `DESCRIPTION:${"长".repeat(1500)}`),
        ...vevent(
          "UID:w@google.com",
          "DTSTART:20261026T010000Z",
          "DURATION:PT45M",
          "RRULE:FREQ=WEEKLY;BYDAY=MO,WE",
          "EXDATE:20261028T010000Z,20261102T010000Z",
          "EXDATE;TZID=Asia/Singapore:20261104T090000",
          "SUMMARY:站会",
        ),
        ...vevent("UID:w@google.com", "RECURRENCE-ID:20261109T010000Z", "DTSTART:20261110T020000Z", "DTEND:20261110T024500Z", "SUMMARY:站会（改到周二）"),
      ),
    ).events as [IcalEvent, IcalEvent, IcalEvent];
    expect(allDay).toMatchObject({ start: { value: "20261026" }, end: { value: "20261028" } });
    expect(allDay.description).toHaveLength(DESCRIPTION_MAX + 1);
    expect(weekly).toMatchObject({
      start: { value: "20261026T010000Z" },
      duration: "PT45M",
      rrule: "FREQ=WEEKLY;BYDAY=MO,WE",
      exdates: [{ value: "20261028T010000Z" }, { value: "20261102T010000Z" }, { value: "20261104T090000", tz: "Asia/Singapore" }],
    });
    expect(moved).toMatchObject({ recurrenceId: { value: "20261109T010000Z" }, start: { value: "20261110T020000Z" } });
    expect([weekly, moved].map(eventKey)).toEqual(["w@google.com", "w@google.com#20261109T010000Z"]);
  });

  it("不是日历（网页、空的）抛 NotIcalError", () => {
    expect(() => parseIcal("<!doctype html><html>登录</html>")).toThrow(NotIcalError);
    expect(() => parseIcal("")).toThrow(NotIcalError);
  });
});

describe("展开成一段时间里的每一次", () => {
  it("单次：UTC 的、全天跨几天的；只给和这段时间有交集的", () => {
    const events = parseIcal(
      ics(
        ...vevent("UID:1", "DTSTART:20261026T010000Z", "DTEND:20261026T020000Z", "SUMMARY:看牙"),
        ...vevent("UID:2", "DTSTART;VALUE=DATE:20261030", "DTEND;VALUE=DATE:20261102", "SUMMARY:出差"),
        ...vevent("UID:3", "DTSTART:20261201T010000Z", "SUMMARY:下个月的"),
      ),
    ).events;
    expect(expand(events, "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z")).toEqual(["2026-10-26T01:00:00.000Z..2026-10-26T02:00:00.000Z 看牙", "2026-10-30..2026-11-02 出差"]);
  });

  it("按 TZID 的本地时间重复：每周一 09:00 纽约时间，跨过夏令时（3 月 8 日）还是 09:00", () => {
    const events = one("UID:ny", "DTSTART;TZID=America/New_York:20260223T090000", "DTEND;TZID=America/New_York:20260223T093000", "RRULE:FREQ=WEEKLY;BYDAY=MO", "SUMMARY:纽约周会");
    expect(expand(events, "2026-03-01T00:00:00Z", "2026-03-17T00:00:00Z")).toEqual([
      "2026-03-02T14:00:00.000Z..2026-03-02T14:30:00.000Z 纽约周会",
      "2026-03-09T13:00:00.000Z..2026-03-09T13:30:00.000Z 纽约周会",
      "2026-03-16T13:00:00.000Z..2026-03-16T13:30:00.000Z 纽约周会",
    ]);
  });

  it("DAILY 加 COUNT：数到第几次就停（DTSTART 算第一次）", () => {
    const events = one("UID:d", "DTSTART:20261026T230000Z", "DTEND:20261026T233000Z", "RRULE:FREQ=DAILY;COUNT=3", "SUMMARY:吃药");
    expect(expand(events, "2026-10-01T00:00:00Z", "2026-11-30T00:00:00Z")).toEqual([
      "2026-10-26T23:00:00.000Z..2026-10-26T23:30:00.000Z 吃药",
      "2026-10-27T23:00:00.000Z..2026-10-27T23:30:00.000Z 吃药",
      "2026-10-28T23:00:00.000Z..2026-10-28T23:30:00.000Z 吃药",
    ]);
  });

  it("WEEKLY 加 INTERVAL、UNTIL、几个 BYDAY：隔周的周二、周四，到 UNTIL 那一刻为止（含）", () => {
    const events = one("UID:w", "DTSTART;TZID=Asia/Singapore:20261006T190000", "DTEND;TZID=Asia/Singapore:20261006T200000", "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;UNTIL=20261020T110000Z", "SUMMARY:羽毛球");
    expect(expand(events, "2026-10-01T00:00:00Z", "2026-11-30T00:00:00Z").map((s) => s.slice(0, 16))).toEqual(["2026-10-06T11:00", "2026-10-08T11:00", "2026-10-20T11:00"]);
  });

  it("MONTHLY：最后一个周五、每月 31 号（没有 31 号的月份跳过）、第二个周二", () => {
    const lastFriday = one("UID:m1", "DTSTART;VALUE=DATE:20260130", "RRULE:FREQ=MONTHLY;BYDAY=-1FR", "SUMMARY:月底复盘");
    expect(expand(lastFriday, "2026-01-01T00:00:00Z", "2026-05-01T00:00:00Z").map((s) => s.slice(0, 10))).toEqual(["2026-01-30", "2026-02-27", "2026-03-27", "2026-04-24"]);
    const day31 = one("UID:m2", "DTSTART;VALUE=DATE:20260131", "RRULE:FREQ=MONTHLY", "SUMMARY:交房租");
    expect(expand(day31, "2026-01-01T00:00:00Z", "2026-08-01T00:00:00Z").map((s) => s.slice(0, 10))).toEqual(["2026-01-31", "2026-03-31", "2026-05-31", "2026-07-31"]);
    const secondTuesday = one("UID:m3", "DTSTART:20261013T020000Z", "RRULE:FREQ=MONTHLY;BYDAY=2TU;COUNT=3", "SUMMARY:读书会");
    expect(expand(secondTuesday, "2026-10-01T00:00:00Z", "2027-06-01T00:00:00Z").map((s) => s.slice(0, 10))).toEqual(["2026-10-13", "2026-11-10", "2026-12-08"]);
  });

  it("MONTHLY 加 BYSETPOS：每月最后一个工作日", () => {
    const events = one("UID:sp", "DTSTART;VALUE=DATE:20261030", "RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1", "SUMMARY:报销");
    expect(expand(events, "2026-10-01T00:00:00Z", "2027-01-01T00:00:00Z").map((s) => s.slice(0, 10))).toEqual(["2026-10-30", "2026-11-30", "2026-12-31"]);
  });

  it("YEARLY 全天的生日：2 月 29 日只在闰年；DTSTART 很早，只展开要看的那几年", () => {
    const events = one("UID:y", "DTSTART;VALUE=DATE:19960229", "DTEND;VALUE=DATE:19960301", "RRULE:FREQ=YEARLY", "SUMMARY:小王生日");
    expect(expand(events, "2026-01-01T00:00:00Z", "2030-01-01T00:00:00Z")).toEqual(["2028-02-29..2028-03-01 小王生日"]);
    const birthday = one("UID:y2", "DTSTART;VALUE=DATE:19900315", "RRULE:FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15", "SUMMARY:妈妈生日");
    expect(expand(birthday, "2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z")).toEqual(["2026-03-15..2026-03-16 妈妈生日"]);
  });

  it("很早开始、没有 COUNT 的每天：直接跳到要看的那一段，结果照样对", () => {
    const events = one("UID:old", "DTSTART;TZID=Asia/Singapore:20100101T073000", "DTEND;TZID=Asia/Singapore:20100101T080000", "RRULE:FREQ=DAILY;INTERVAL=3", "SUMMARY:晨跑");
    // 2010-01-01 起每 3 天（新加坡时间 07:30 = 前一天 23:30Z）：6144 天后是 2026-10-28，再往后是 10-31
    expect(expand(events, "2026-10-26T00:00:00Z", "2026-11-02T00:00:00Z")).toEqual([
      "2026-10-27T23:30:00.000Z..2026-10-28T00:00:00.000Z 晨跑",
      "2026-10-30T23:30:00.000Z..2026-10-31T00:00:00.000Z 晨跑",
    ]);
  });

  it("EXDATE 去掉那几次；RECURRENCE-ID 改期的按改后的放、原本那次没了；改成取消的那一次没了；整个取消的不出现", () => {
    const events = parseIcal(
      ics(
        ...vevent("UID:s", "DTSTART;TZID=Asia/Singapore:20261026T090000", "DTEND;TZID=Asia/Singapore:20261026T091500", "RRULE:FREQ=DAILY;COUNT=6", "EXDATE;TZID=Asia/Singapore:20261027T090000", "SUMMARY:站会"),
        ...vevent("UID:s", "RECURRENCE-ID;TZID=Asia/Singapore:20261028T090000", "DTSTART;TZID=Asia/Singapore:20261028T140000", "DTEND;TZID=Asia/Singapore:20261028T141500", "SUMMARY:站会（改到下午）"),
        ...vevent("UID:s", "RECURRENCE-ID;TZID=Asia/Singapore:20261029T090000", "DTSTART;TZID=Asia/Singapore:20261029T090000", "STATUS:CANCELLED", "SUMMARY:站会"),
        ...vevent("UID:gone", "DTSTART:20261027T050000Z", "STATUS:CANCELLED", "SUMMARY:取消了的会"),
      ),
    ).events;
    expect(expand(events, "2026-10-25T00:00:00Z", "2026-11-05T00:00:00Z")).toEqual([
      "2026-10-26T01:00:00.000Z..2026-10-26T01:15:00.000Z 站会",
      "2026-10-28T06:00:00.000Z..2026-10-28T06:15:00.000Z 站会（改到下午）",
      "2026-10-30T01:00:00.000Z..2026-10-30T01:15:00.000Z 站会",
      "2026-10-31T01:00:00.000Z..2026-10-31T01:15:00.000Z 站会",
    ]);
  });

  it("改期挪进这段时间（原本在外面）也看得到；没有主事件的改期当一次单独的", () => {
    const events = parseIcal(
      ics(
        ...vevent("UID:mv", "DTSTART:20261001T010000Z", "RRULE:FREQ=MONTHLY", "SUMMARY:月会"),
        ...vevent("UID:mv", "RECURRENCE-ID:20261101T010000Z", "DTSTART:20261030T010000Z", "SUMMARY:月会（提前）"),
        ...vevent("UID:orphan", "RECURRENCE-ID:20261028T020000Z", "DTSTART:20261028T030000Z", "SUMMARY:只邀请了这一次"),
      ),
    ).events;
    expect(expand(events, "2026-10-25T00:00:00Z", "2026-11-01T00:00:00Z").map((s) => s.split(" ").slice(1).join(" "))).toEqual(["只邀请了这一次", "月会（提前）"]);
    expect(expand(events, "2026-11-01T00:00:00Z", "2026-11-30T00:00:00Z")).toEqual([]);
  });

  it("认不得的重复规则只给第一次、记下来；认不得的时区退回日历的默认时区；不带时区的按这台电脑的时区", () => {
    const hourly = one("UID:h", "DTSTART:20261026T010000Z", "RRULE:FREQ=HOURLY;COUNT=5", "SUMMARY:每小时");
    const result = expandEvents(hourly, span("2026-10-26T00:00:00Z", "2026-10-27T00:00:00Z"));
    expect(result.occurrences.map((o) => o.event.summary)).toEqual(["每小时"]);
    expect(result.approximate).toEqual(["h"]);

    const windowsZone = one("UID:wz", "DTSTART;TZID=China Standard Time:20261026T090000", "SUMMARY:Outlook 的会");
    expect(expand(windowsZone, "2026-10-25T00:00:00Z", "2026-10-27T00:00:00Z", "America/Los_Angeles")).toEqual(["2026-10-26T16:00:00.000Z..2026-10-26T16:00:00.000Z Outlook 的会"]);

    const floating = one("UID:fl", "DTSTART:20261026T090000", "SUMMARY:浮动时间");
    expect(expandEvents(floating, span("2026-10-25T00:00:00Z", "2026-10-27T00:00:00Z")).occurrences[0]!.start).toBe(new Date(2026, 9, 26, 9, 0, 0).getTime());
  });
});

describe("时区换算", () => {
  it("夏令时跳过去的本地时间按跳之前的偏移；回拨重复的取第一次", () => {
    // 纽约 2026-03-08 02:30 不存在：按 EST（-5）→ 07:30Z
    expect(new Date(wallToUtc({ y: 2026, m: 3, d: 8, hh: 2, mi: 30, ss: 0 }, "America/New_York")).toISOString()).toBe("2026-03-08T07:30:00.000Z");
    // 柏林 2026-10-25 02:30 出现两次：取第一次（CEST，+2）→ 00:30Z
    expect(new Date(wallToUtc({ y: 2026, m: 10, d: 25, hh: 2, mi: 30, ss: 0 }, "Europe/Berlin")).toISOString()).toBe("2026-10-25T00:30:00.000Z");
    expect(new Date(wallToUtc({ y: 2026, m: 10, d: 26, hh: 9, mi: 0, ss: 0 }, "UTC")).toISOString()).toBe("2026-10-26T09:00:00.000Z");
  });
});
