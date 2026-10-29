// 日期里的词（170 号票）：几处手写的日期（"10 月 8 日"）共用的月份说法。中文是数字本身（"10"，日期的模板照原来手写的
// 格式，中文和原来一字不差），英文是简写（"Oct"，模板写"{month} {day}"）。放在语言文件里，加别的语言时一起译。
import { tTable } from "./protocol.ts";

const MONTH = tTable({
  m1: "state.dateWords.month.m1",
  m2: "state.dateWords.month.m2",
  m3: "state.dateWords.month.m3",
  m4: "state.dateWords.month.m4",
  m5: "state.dateWords.month.m5",
  m6: "state.dateWords.month.m6",
  m7: "state.dateWords.month.m7",
  m8: "state.dateWords.month.m8",
  m9: "state.dateWords.month.m9",
  m10: "state.dateWords.month.m10",
  m11: "state.dateWords.month.m11",
  m12: "state.dateWords.month.m12",
});

/** 月份的说法（month 是 1–12）：中文 "10"，英文 "Oct"；不在范围里的写数字 */
export function monthWord(month: number): string {
  const key = `m${month}`;
  return Object.hasOwn(MONTH, key) ? MONTH[key as keyof typeof MONTH] : String(month);
}
