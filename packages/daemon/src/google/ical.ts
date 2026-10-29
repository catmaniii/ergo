// iCal（.ics，RFC 5545）解析（297 号票）：Google 日历私密地址拉回来的那一份，只读出够用的部分，不加 npm 依赖。
// - 续行（以空格或 Tab 开头的行接到上一行）、属性的参数（;TZID=…、带引号的值）、文字里的转义（\n \, \; \\）；
// - 日历本身：名字（X-WR-CALNAME）、默认时区（X-WR-TIMEZONE）；
// - 每个 VEVENT：UID、RECURRENCE-ID（改期的那一次）、标题、地点、说明（截到 1000 字）、状态（取消的）、开始、结束或时长、
//   重复规则（RRULE 原样留着，展开在 recurrence.ts）、额外的日子（RDATE）、去掉的日子（EXDATE）。
//   VALARM 之类嵌在里面的不看；VTIMEZONE 不看（时区用 Intl 按名字算，time-zone.ts）；没有 UID、没有开始的跳过。
// 时间原样留着写法（"20261026"全天、"20261026T090000Z" UTC、"20261026T090000"加上 TZID 或者不带时区），重复规则按本地时间展开才不会
// 被夏令时打乱。解析出的样子（IcalEvent）就是 Google 插件存进事件的那一份（events.ts），所以只有 JSON 能存的字段、不写 undefined。

/** 说明最多留多少字 */
export const DESCRIPTION_MAX = 1000;

/** iCal 里的一个时刻：写法原样（全天 8 位数字、UTC 以 Z 结尾、本地时间不带 Z），本地时间可以带时区名 */
export interface IcalTime {
  readonly value: string;
  readonly tz?: string;
}

/** 一个 VEVENT（解析后、存进事件的样子） */
export interface IcalEvent {
  readonly uid: string;
  /** 改期、取消的那一次：原本是哪一次 */
  readonly recurrenceId?: IcalTime;
  readonly summary: string;
  readonly location?: string;
  readonly description?: string;
  readonly status?: "tentative" | "confirmed" | "cancelled";
  readonly start: IcalTime;
  readonly end?: IcalTime;
  /** DURATION 原样（没有 DTEND 时） */
  readonly duration?: string;
  /** RRULE 原样 */
  readonly rrule?: string;
  readonly rdates?: readonly IcalTime[];
  readonly exdates?: readonly IcalTime[];
}

/** 一份日历 */
export interface IcalCalendar {
  readonly name?: string;
  readonly timeZone?: string;
  readonly events: readonly IcalEvent[];
}

/** 不是日历（拿到的是网页、空的……） */
export class NotIcalError extends Error {
  constructor() {
    super("not an iCalendar document"); // @i18n-ignore log：调用方换成给人看的原因
    this.name = "NotIcalError";
  }
}

interface Property {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** 拆行、接上续行 */
function unfold(text: string): string[] {
  const out: string[] = [];
  for (const line of text.replace(/^﻿/, "").split(/\r\n|\n|\r/)) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length > 0) out[out.length - 1] += line.slice(1);
    else if (line.trim() !== "") out.push(line);
  }
  return out;
}

/** 按分隔符拆开，引号里的不拆 */
function splitOutsideQuotes(text: string, sep: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (const c of text) {
    if (c === '"') quoted = !quoted;
    if (c === sep && !quoted) {
      parts.push(current);
      current = "";
    } else current += c;
  }
  parts.push(current);
  return parts;
}

/** 一行 → 属性名、参数、值；不是"名字:值"的返回 undefined */
function parseLine(line: string): Property | undefined {
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ":" && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon <= 0) return undefined;
  const [name, ...rest] = splitOutsideQuotes(line.slice(0, colon), ";");
  const params: Record<string, string> = {};
  for (const seg of rest) {
    const eq = seg.indexOf("=");
    if (eq <= 0) continue;
    params[seg.slice(0, eq).trim().toUpperCase()] = seg
      .slice(eq + 1)
      .trim()
      .replace(/^"(.*)"$/, "$1");
  }
  return { name: name!.trim().toUpperCase(), params, value: line.slice(colon + 1) };
}

/** 文字的转义 */
export function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

const DATE_RE = /^\d{8}$/;
const DATE_TIME_RE = /^\d{8}T\d{6}Z?$/;

/** 一个时间值（带着它的参数）；写法不对的返回 undefined */
function timeOf(value: string, params: Record<string, string>): IcalTime | undefined {
  const v = value.trim().toUpperCase();
  if (params.VALUE === "DATE" || DATE_RE.test(v)) return DATE_RE.test(v) ? { value: v } : DATE_TIME_RE.test(v) ? { value: v.slice(0, 8) } : undefined;
  if (!DATE_TIME_RE.test(v)) return undefined;
  if (v.endsWith("Z")) return { value: v };
  const tz = params.TZID?.replace(/^\/+/, "").trim();
  return tz ? { value: v, tz } : { value: v };
}

/** 一串时间值（EXDATE、RDATE 一行里可以写好几个，用逗号分开） */
function timesOf(prop: Property): IcalTime[] {
  if (prop.params.VALUE === "PERIOD") return [];
  return prop.value.split(",").flatMap((v) => {
    const time = timeOf(v, prop.params);
    return time ? [time] : [];
  });
}

const STATUSES = { TENTATIVE: "tentative", CONFIRMED: "confirmed", CANCELLED: "cancelled" } as const;

/** 一个 VEVENT 的属性 → 解析后的样子；没有 UID、没有开始的不要 */
function eventOf(props: readonly Property[]): IcalEvent | undefined {
  const one = (name: string) => props.find((p) => p.name === name);
  const uid = one("UID")?.value.trim();
  const startProp = one("DTSTART");
  const start = startProp && timeOf(startProp.value, startProp.params);
  if (!uid || !start) return undefined;
  const endProp = one("DTEND");
  const end = endProp && timeOf(endProp.value, endProp.params);
  const recurrenceProp = one("RECURRENCE-ID");
  const recurrenceId = recurrenceProp && timeOf(recurrenceProp.value, recurrenceProp.params);
  const text = (name: string) => {
    const p = one(name);
    const v = p === undefined ? "" : unescapeText(p.value).trim();
    return v === "" ? undefined : v;
  };
  const description = text("DESCRIPTION");
  const location = text("LOCATION");
  const status = STATUSES[(one("STATUS")?.value.trim().toUpperCase() ?? "") as keyof typeof STATUSES];
  const duration = one("DURATION")?.value.trim();
  const rrule = one("RRULE")?.value.trim();
  const rdates = props.filter((p) => p.name === "RDATE").flatMap(timesOf);
  const exdates = props.filter((p) => p.name === "EXDATE").flatMap(timesOf);
  return {
    uid,
    ...(recurrenceId ? { recurrenceId } : {}),
    summary: text("SUMMARY") ?? "",
    ...(location === undefined ? {} : { location }),
    ...(description === undefined ? {} : { description: description.length > DESCRIPTION_MAX ? `${description.slice(0, DESCRIPTION_MAX)}…` : description }),
    ...(status === undefined ? {} : { status }),
    start,
    ...(end ? { end } : {}),
    ...(!end && duration ? { duration } : {}),
    ...(rrule && !recurrenceId ? { rrule } : {}),
    ...(rdates.length > 0 && !recurrenceId ? { rdates } : {}),
    ...(exdates.length > 0 && !recurrenceId ? { exdates } : {}),
  };
}

/** 解析一份 .ics；开头不是 BEGIN:VCALENDAR 的抛 NotIcalError */
export function parseIcal(text: string): IcalCalendar {
  const lines = unfold(text);
  if (lines.length === 0 || lines[0]!.trim().toUpperCase() !== "BEGIN:VCALENDAR") throw new NotIcalError();
  const stack: string[] = [];
  const events: IcalEvent[] = [];
  let name: string | undefined;
  let timeZone: string | undefined;
  let current: Property[] | undefined;
  for (const line of lines) {
    const prop = parseLine(line);
    if (!prop) continue;
    if (prop.name === "BEGIN") {
      const component = prop.value.trim().toUpperCase();
      stack.push(component);
      if (component === "VEVENT" && stack.length === 2) current = [];
      continue;
    }
    if (prop.name === "END") {
      const component = stack.pop();
      if (component === "VEVENT" && current) {
        const event = eventOf(current);
        if (event) events.push(event);
        current = undefined;
      }
      continue;
    }
    const top = stack.at(-1);
    if (top === "VEVENT" && current && stack.length === 2) current.push(prop);
    else if (top === "VCALENDAR" && stack.length === 1) {
      if (prop.name === "X-WR-CALNAME") name = unescapeText(prop.value).trim() || undefined;
      else if (prop.name === "X-WR-TIMEZONE") timeZone = prop.value.trim() || undefined;
    }
  }
  return { ...(name === undefined ? {} : { name }), ...(timeZone === undefined ? {} : { timeZone }), events };
}

/** 一个 VEVENT 在一份日历里的键：UID，改期的那一次再加上原本是哪一次 */
export function eventKey(event: Pick<IcalEvent, "uid" | "recurrenceId">): string {
  return event.recurrenceId ? `${event.uid}#${event.recurrenceId.value}` : event.uid;
}
