// 快照保留多少份（规格第 18 节）：
// - 本机备份区：最近 7 份；
// - 同步目录：每日 7 份（最近 7 份）加每周 4 份——比这 7 份更早的快照里，最近 4 个周日的。
//   每周留的那份取周日的快照（第 21 节）；哪个周日没有快照（那天关机），就往前多取一个周日。
// 纯函数：输入日期目录名（YYYY-MM-DD），给出要留下的。

export const LOCAL_KEEP = 7;
export const SYNC_DAILY_KEEP = 7;
export const SYNC_WEEKLY_KEEP = 4;

const newestFirst = (dates: readonly string[]) => [...new Set(dates)].toSorted().toReversed();

/** YYYY-MM-DD 是不是周日（本地日历，和时区无关） */
export function isSunday(date: string): boolean {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d).getDay() === 0;
}

/** 本机备份区留下的快照 */
export function keepLocal(dates: readonly string[]): Set<string> {
  return new Set(newestFirst(dates).slice(0, LOCAL_KEEP));
}

/** 同步目录留下的快照 */
export function keepSync(dates: readonly string[]): Set<string> {
  const sorted = newestFirst(dates);
  const daily = sorted.slice(0, SYNC_DAILY_KEEP);
  const weekly = sorted.slice(SYNC_DAILY_KEEP).filter(isSunday).slice(0, SYNC_WEEKLY_KEEP);
  return new Set([...daily, ...weekly]);
}
