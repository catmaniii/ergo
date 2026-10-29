// 测试用的假 Google 日历（297 号票）：编的 .ics 内容，和两种"远端"——假内核里直接注入的假 fetch、主切面里本机起的假 HTTP 服务。
// 不连真的 Google：地址长得像私密 iCal 地址，主切面里换成本机回环地址。
import http from "node:http";
import type { AddressInfo } from "node:net";
import { onTestFinished } from "vitest";

/** 拼一份 .ics（CRLF） */
export function icsOf(options: { name?: string; timeZone?: string; events: readonly (readonly string[])[] }): string {
  return [
    "BEGIN:VCALENDAR",
    "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    ...(options.name ? [`X-WR-CALNAME:${options.name}`] : []),
    ...(options.timeZone ? [`X-WR-TIMEZONE:${options.timeZone}`] : []),
    ...options.events.flatMap((lines) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"]),
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

/** 私密地址里的那一段（地址就是密钥：出现在日志、事件、页面里就是漏了） */
export const PRIVATE_TOKEN = "private-0123456789abcdef0123456789abcdef";

/** 长得像 Google 的私密 iCal 地址 */
export const googleAddress = (id: string, token = PRIVATE_TOKEN) => `https://calendar.google.com/calendar/ical/${encodeURIComponent(id)}/${token}/basic.ics`;

/**
 * 编的"我的日历"（新加坡时间；2026-10-24 是周六）：
 * - 站会：每周一、三 09:00–09:15，从 10-12 起；10-28（周三）那次改到 14:00；11-02（周一）那次取消；
 * - 看牙：10-25（周日）10:00–11:00（写成 UTC）；
 * - 出差：10-27 到 10-29 全天（DTEND 10-30）；
 * - 小王生日：每年 10-25 全天；
 * - 纽约周会：每周二 09:00 纽约时间（跨时区）
 */
export function myCalendar(overrides: { name?: string; extra?: readonly (readonly string[])[]; drop?: readonly string[] } = {}): string {
  const events: Array<readonly string[]> = [
    ["UID:standup@google.com", "DTSTART;TZID=Asia/Singapore:20261012T090000", "DTEND;TZID=Asia/Singapore:20261012T091500", "RRULE:FREQ=WEEKLY;BYDAY=MO,WE", "EXDATE;TZID=Asia/Singapore:20261102T090000", "SUMMARY:站会", "LOCATION:3 楼"],
    ["UID:standup@google.com", "RECURRENCE-ID;TZID=Asia/Singapore:20261028T090000", "DTSTART;TZID=Asia/Singapore:20261028T140000", "DTEND;TZID=Asia/Singapore:20261028T141500", "SUMMARY:站会（改到下午）"],
    ["UID:dentist@google.com", "DTSTART:20261025T020000Z", "DTEND:20261025T030000Z", "SUMMARY:看牙", "DESCRIPTION:带上医保卡"],
    ["UID:trip@google.com", "DTSTART;VALUE=DATE:20261027", "DTEND;VALUE=DATE:20261030", "SUMMARY:出差"],
    ["UID:bday@google.com", "DTSTART;VALUE=DATE:19951025", "DTEND;VALUE=DATE:19951026", "RRULE:FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=25", "SUMMARY:小王生日"],
    ["UID:ny@google.com", "DTSTART;TZID=America/New_York:20261006T090000", "DTEND;TZID=America/New_York:20261006T093000", "RRULE:FREQ=WEEKLY;BYDAY=TU", "SUMMARY:纽约周会"],
  ];
  return icsOf({
    name: overrides.name ?? "chenxiao@gmail.com",
    timeZone: "Asia/Singapore",
    events: [...events.filter((e) => !overrides.drop?.includes(e[0]!.slice(4))), ...(overrides.extra ?? [])],
  });
}

/** 假的远端：地址 → 回什么（状态码、内容）；没有的当连不上 */
export interface FakeCalendarRemote {
  readonly routes: Map<string, { status: number; body: string }>;
  /** 被拉过的地址（按先后） */
  readonly fetched: string[];
}

/** 假内核里注入的假 fetch */
export function fakeCalendarFetch(): FakeCalendarRemote & { fetch: typeof fetch } {
  const routes = new Map<string, { status: number; body: string }>();
  const fetched: string[] = [];
  const fakeFetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    fetched.push(url);
    const route = routes.get(url);
    if (!route) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    return new Response(route.body, { status: route.status, headers: { "content-type": "text/calendar; charset=utf-8" } });
  }) as typeof fetch;
  return { routes, fetched, fetch: fakeFetch };
}

/** 本机起的假日历服务（主切面）：路径 → 回什么；交回地址的前缀。用例结束时关掉 */
export async function startFakeCalendarServer(): Promise<FakeCalendarRemote & { base: string; address(path: string): string }> {
  const routes = new Map<string, { status: number; body: string }>();
  const fetched: string[] = [];
  const server = http.createServer((req, res) => {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${req.url ?? "/"}`;
    fetched.push(url);
    const route = routes.get(url);
    if (!route) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(route.status, { "content-type": "text/calendar; charset=utf-8" });
    res.end(route.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { routes, fetched, base, address: (path) => `${base}${path}` };
}
