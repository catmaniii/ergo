// 生日、纪念日的日子（449）：个人档案里每年要记着的日子（isAnnualField 认的那几类字段）读、写、显示都经这里，纯函数。
// - 存成统一的样子：公历 "1990-03-02"、不记得哪年 "--03-02"；农历 "lunar:1990-08-15"、"lunar:--08-15"，闰月 "lunar:--L04-15"；
// - 认得出的各种写法（"1990年3月2日""3月2号""1990/3/2""03-02""March 2, 1990""农历八月十五""正月初一""腊月廿三"……）
//   规范成上面的样子（checkPersonalValue 对这几类字段就用它；认不出的拒绝）；
// - 显示成好读的样子（按当前语言："1990 年 3 月 2 日""农历八月十五""Mar 2, 1990""Lunar 8th month, day 15"）；
// - 档案页的选择器用的：某年某月最多几号（公历按年月，"不记得哪年"时 2 月有 29 日；农历一律到三十）。
// 不做农历和公历的换算（农历的每年提醒另开票），所以农历的闰月不查那一年有没有。不引用 TypeBox。
import { t, tTable } from "./i18n/runtime.ts";
import { daysInMonth, monthName, pad2 } from "./local-date.ts";

/** 公历、农历 */
export const ANNUAL_CALENDARS = ["solar", "lunar"] as const;
export type AnnualCalendar = (typeof ANNUAL_CALENDARS)[number];

/** 一个每年要记着的日子：年可以不记得；农历的月可以是闰月 */
export interface AnnualDate {
  calendar: AnnualCalendar;
  /** 哪一年（不记得哪年没有） */
  year?: number;
  /** 1–12 */
  month: number;
  /** 公历 1–31（按年月），农历 1–30 */
  day: number;
  /** 农历闰月 */
  leap?: boolean;
}

/** 档案页选年份最早到哪年（往下是今年到这一年） */
export const ANNUAL_YEAR_MIN = 1900;
/** 认得出的年份范围（四位数；早于选择器的老人的年份也认，选择器上另外列出来） */
const YEAR_MIN = 1000;
/** 农历一个月最多几天 */
export const LUNAR_MONTH_DAYS = 30;
/** 农历存的时候的前缀 */
const LUNAR_PREFIX = "lunar:";
/** 平年、闰年：公历"不记得哪年"时 2 月按闰年算（2 月 29 日算有） */
const LEAP_YEAR = 2000;

/** 公历某年某月（不记得哪年的按闰年）、农历某月最多几号 */
export function annualDayMax(calendar: AnnualCalendar, year: number | undefined, month: number): number {
  if (calendar === "lunar") return LUNAR_MONTH_DAYS;
  return daysInMonth(year ?? LEAP_YEAR, month);
}

/** 是不是日历上有的日子（公历 2023-02-29 不是；农历只查到三十） */
export function isAnnualDate(date: AnnualDate): boolean {
  const { year, month, day } = date;
  if (year !== undefined && (!Number.isInteger(year) || year < YEAR_MIN || year > 9999)) return false;
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  if (date.leap === true && date.calendar !== "lunar") return false;
  return Number.isInteger(day) && day >= 1 && day <= annualDayMax(date.calendar, year, month);
}

/** 存的样子："1990-03-02""--03-02""lunar:1990-08-15""lunar:--L04-15" */
export function formatAnnualDate(date: AnnualDate): string {
  const year = date.year === undefined ? "--" : `${String(date.year).padStart(4, "0")}-`;
  const body = `${year}${date.calendar === "lunar" && date.leap === true ? "L" : ""}${pad2(date.month)}-${pad2(date.day)}`;
  return date.calendar === "lunar" ? `${LUNAR_PREFIX}${body}` : body;
}

// ---------- 认各种写法 ----------

/** 存的样子（formatAnnualDate 写的） */
const CANONICAL = /^(lunar:)?(?:(\d{4})-|--)(L)?(\d{2})-(\d{2})$/u;

// @i18n-ignore-start data：认用户、秘书、通讯录写的中文日子（农历、公历的说法，月份、日子的中文写法）
/** 写明是农历 */
const LUNAR_MARK = /农历|阴历|旧历|夏历|lunar/giu;
/** 写明是公历 */
const SOLAR_MARK = /公历|阳历|新历|西历|gregorian|solar/giu;
/** 不影响意思的字：每年、出生、括号、句末的标点 */
const NOISE = /每年|出生|[()[\]【】]|[。．，、,.;；]+$/gu;
/** 中文的数字 */
const CN_DIGITS: Readonly<Record<string, number>> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
/** 中文写的月份（"正月""冬月""腊月"只在农历里说） */
const CN_MONTHS: Readonly<Record<string, number>> = { 正: 1, ...CN_DIGITS, 十一: 11, 十二: 12, 冬: 11, 腊: 12 };
/** 年（可有）、闰（可有）、月、日、日号（可有）：月日可以是数字或者中文 */
const CN_FORM =
  /^(?:(\d{4})年)?(闰)?(\d{1,2}|正|十一|十二|一|二|三|四|五|六|七|八|九|十|冬|腊)月份?(\d{1,2}|初[一二三四五六七八九十]|二十[一二三四五六七八九]?|廿[一二三四五六七八九]|三十|卅|十[一二三四五六七八九]?|[一二三四五六七八九])([日号])?$/u;
// @i18n-ignore-end
/** 英文的月份（前三个字母） */
const EN_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** "March 2, 1990""Mar 2"（空白已经去掉） */
const EN_MONTH_FIRST = /^([a-z]{3,9})\.?(\d{1,2})(?:st|nd|rd|th)?(?:,?(\d{4}))?$/u;
/** "2 March 1990""2nd of March" */
const EN_DAY_FIRST = /^(\d{1,2})(?:st|nd|rd|th)?(?:of)?([a-z]{3,9})\.?(?:,?(\d{4}))?$/u;

/** 中文写的日子 → 几号："初一" 1、"十五" 15、"廿三" 23、"三十" 30；数字照数字 */
function cnDay(text: string): number {
  if (/^\d+$/u.test(text)) return Number(text);
  // @i18n-ignore-start data：认中文写的日子
  if (text === "三十" || text === "卅") return 30;
  if (text.startsWith("初")) return CN_DIGITS[text.slice(1)] ?? 0;
  if (text.startsWith("廿")) return 20 + (CN_DIGITS[text.slice(1)] ?? 0);
  if (text.startsWith("二十")) return 20 + (CN_DIGITS[text.slice(2)] ?? 0);
  if (text.startsWith("十")) return 10 + (CN_DIGITS[text.slice(1)] ?? 0);
  // @i18n-ignore-end
  return CN_DIGITS[text] ?? 0;
}

const englishMonth = (word: string): number | undefined => {
  const at = EN_MONTHS.indexOf(word.slice(0, 3));
  return at < 0 ? undefined : at + 1;
};

/** 拆出来的年月日，加上"这种写法只在农历里说"（正月、初一、廿三、"八月十五"这样没写日号的中文） */
interface Pieces {
  year?: number;
  month: number;
  day: number;
  leap?: boolean;
  lunarish?: boolean;
}

/** 拆出来的年份（没写是空的） */
const yearOf = (s: string | undefined): { year?: number } => (s === undefined ? {} : { year: Number(s) });

/** 去掉农历、公历这几个字以后剩下的写法拆成年月日；认不出是 undefined */
function piecesOf(text: string): Pieces | undefined {
  // @i18n-ignore-next data：认中文写的年月日
  let m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})[日号]?$/u.exec(text) ?? /^(\d{4})(\d{2})(\d{2})$/u.exec(text);
  if (m) return { ...yearOf(m[1]), month: Number(m[2]), day: Number(m[3]) };
  m = /^(?:--)?(\d{1,2})[-/.](\d{1,2})$/u.exec(text) ?? /^--(\d{2})(\d{2})$/u.exec(text);
  if (m) return { month: Number(m[1]), day: Number(m[2]) };
  m = CN_FORM.exec(text);
  if (m) {
    const [, y, leap, monthText = "", dayText = "", suffix] = m;
    const month = /^\d+$/u.test(monthText) ? Number(monthText) : (CN_MONTHS[monthText] ?? 0);
    const cnMonth = !/^\d+$/u.test(monthText);
    const cnDayText = !/^\d+$/u.test(dayText);
    // @i18n-ignore-next data：只在农历里说的月份、日子
    const lunarWords = /^[正冬腊]$/u.test(monthText) || /^[初廿卅]/u.test(dayText);
    return { ...yearOf(y), month, day: cnDay(dayText), ...(leap === undefined ? {} : { leap: true }), lunarish: lunarWords || (cnMonth && cnDayText && suffix === undefined) };
  }
  m = EN_MONTH_FIRST.exec(text);
  if (m) {
    const month = englishMonth(m[1]!);
    return month === undefined ? undefined : { ...yearOf(m[3]), month, day: Number(m[2]) };
  }
  m = EN_DAY_FIRST.exec(text);
  if (m) {
    const month = englishMonth(m[2]!);
    return month === undefined ? undefined : { ...yearOf(m[3]), month, day: Number(m[1]) };
  }
  return undefined;
}

/**
 * 认一个日子：存的样子，或者认得出的写法（中文、数字、英文月份；写了"农历"、说的是正月腊月初一廿三这种的算农历，
 * 写了闰月的算农历闰月）。认不出、日历上没有这一天（公历 2 月 30 日、平年 2 月 29 日）是 undefined
 */
export function parseAnnualDate(raw: string): AnnualDate | undefined {
  const text = raw.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
  if (text === "") return undefined;
  const canonical = CANONICAL.exec(raw.trim());
  if (canonical) {
    const [, lunar, y, leap, month, day] = canonical;
    const date: AnnualDate = {
      calendar: lunar === undefined ? "solar" : "lunar",
      ...(y === undefined ? {} : { year: Number(y) }),
      month: Number(month),
      day: Number(day),
      ...(leap === undefined ? {} : { leap: true }),
    };
    return isAnnualDate(date) ? date : undefined;
  }
  const lunarMarked = new RegExp(LUNAR_MARK.source, "iu").test(text);
  const solarMarked = new RegExp(SOLAR_MARK.source, "iu").test(text);
  if (lunarMarked && solarMarked) return undefined;
  const rest = text.replace(LUNAR_MARK, "").replace(SOLAR_MARK, "").replace(NOISE, "").replace(/^:/u, "");
  const pieces = piecesOf(rest);
  if (!pieces) return undefined;
  const lunar = lunarMarked || (!solarMarked && (pieces.leap === true || pieces.lunarish === true));
  if (pieces.leap === true && !lunar) return undefined;
  const date: AnnualDate = {
    calendar: lunar ? "lunar" : "solar",
    ...(pieces.year === undefined ? {} : { year: pieces.year }),
    month: pieces.month,
    day: pieces.day,
    ...(pieces.leap === true ? { leap: true } : {}),
  };
  return isAnnualDate(date) ? date : undefined;
}

/** 规范成存的样子；认不出是 undefined */
export function normalizeAnnualDate(raw: string): string | undefined {
  const date = parseAnnualDate(raw);
  return date === undefined ? undefined : formatAnnualDate(date);
}

// ---------- 显示 ----------

/** 农历的月份（"正月""冬月""腊月"；英文 "8th month"） */
const LUNAR_MONTH_NAMES: Readonly<Record<string, string>> = tTable(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [String(i + 1), `protocol.annualDate.lunarMonth.${i + 1}`])));
/** 农历的日子（"初一""十五""廿三""三十"；英文就是数字） */
const LUNAR_DAY_NAMES: Readonly<Record<string, string>> = tTable(Object.fromEntries(Array.from({ length: LUNAR_MONTH_DAYS }, (_, i) => [String(i + 1), `protocol.annualDate.lunarDay.${i + 1}`])));

/** 农历的月份怎么写：8 → "八月"（英文 "8th month"） */
export function lunarMonthName(month: number): string {
  return Object.hasOwn(LUNAR_MONTH_NAMES, String(month)) ? LUNAR_MONTH_NAMES[String(month)]! : String(month);
}

/** 农历的日子怎么写：15 → "十五"（英文 "15"） */
export function lunarDayName(day: number): string {
  return Object.hasOwn(LUNAR_DAY_NAMES, String(day)) ? LUNAR_DAY_NAMES[String(day)]! : String(day);
}

/** 好读的样子（按当前语言）："1990 年 3 月 2 日""3 月 2 日""农历八月十五""农历 1990 年闰四月十五" */
export function annualDateLabel(date: AnnualDate): string {
  if (date.calendar === "solar") {
    const params = { month: monthName(date.month), day: date.day };
    return date.year === undefined ? t("protocol.annualDate.solar", params) : t("protocol.annualDate.solarYear", { ...params, year: date.year });
  }
  const params = { month: lunarMonthName(date.month), day: lunarDayName(date.day) };
  const leap = date.leap === true;
  if (date.year === undefined) return t(leap ? "protocol.annualDate.lunarLeap" : "protocol.annualDate.lunar", params);
  return t(leap ? "protocol.annualDate.lunarLeapYear" : "protocol.annualDate.lunarYear", { ...params, year: date.year });
}

/** 一个存着的值好读的样子：认得出的照新样子写，认不出的是 undefined（调用方原样显示、提示重新选） */
export function annualDateText(value: string): string | undefined {
  const date = parseAnnualDate(value);
  return date === undefined ? undefined : annualDateLabel(date);
}
