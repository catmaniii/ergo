// 按编号或名字找一样东西（秘书的工具里写的任务、项目……，22 号票）：编号不分大小写；名字去掉首尾空白后完全相同；
// 同名的有好几个时报歧义（要用编号）。找不到、有歧义都抛 RequestRejected，说明里带上怎么查编号（hint）。
// @i18n-ignore-file model：秘书的工具里用，出错说明交回秘书（what、hint 也是调用方给的中文）
import { RequestRejected } from "../errors.ts";

export function findByIdOrName<T extends { id: string }>(items: readonly T[], ref: string, options: { nameOf(item: T): string; what: string; hint: string }): T {
  const wanted = ref.trim();
  const byId = items.find((item) => item.id.toLowerCase() === wanted.toLowerCase());
  if (byId) return byId;
  const named = items.filter((item) => options.nameOf(item).trim() === wanted);
  if (named.length === 1) return named[0]!;
  if (named.length > 1) throw new RequestRejected("bad_params", `叫「${wanted}」的${options.what}有 ${named.length} 个（${named.map((i) => i.id).join("、")}），写编号`);
  throw new RequestRejected("not_found", `没有${options.what}「${wanted}」：${options.hint}`);
}
