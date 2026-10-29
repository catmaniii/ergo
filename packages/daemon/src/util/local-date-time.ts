// 具体的本地日期时间的写法（秘书在工具里写的 "YYYY-MM-DD HH:mm"，也认 YYYY-MM-DDTHH:mm）→ Date。
// 简单提醒（reminders/schedule.ts）和秘书交给后台、某个时间做一次（tasks/secretary-tools.ts）共用。
// 126 号票从提醒模块挪到这里：提醒成了插件，内核的模块不 import 插件的内部。
import { parseClockTime, t } from "@ergo/protocol";
import { RequestRejected } from "../errors.ts";

/**
 * "YYYY-MM-DD HH:mm"（本地时间）：写法不对、日期不存在的抛 fail 给的错（不给是 bad_params 的 RequestRejected，
 * 说明交回秘书让它改了再试）
 */
export function parseLocalDateTime(value: string, fail: (message: string) => Error = (message) => new RequestRejected("bad_params", message)): Date {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}:\d{2})$/.exec(value.trim());
  const time = m ? parseClockTime(m[4]!) : undefined;
  if (!m || time === undefined) throw fail(t("util.localDateTime.badAt", { value }));
  const [hh, mm] = time.split(":").map(Number) as [number, number];
  const [year, month, day] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const at = new Date(year, month, day, hh, mm);
  if (at.getMonth() !== month || at.getDate() !== day) throw fail(t("util.localDateTime.noSuchDate", { value }));
  return at;
}
