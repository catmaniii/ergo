// 协议里的时间格式：事件、消息、卡片里的时间都是带时区偏移的本地 ISO 时间，精确到毫秒，
// 如 2026-10-07T21:05:00.123+08:00。界面按本地日期分天，不会因为和 UTC 差八小时分错。
// 守护进程和 Web 都用这一份。

const pad2 = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");

/** 某一时刻（默认现在）的本地时间，带时区偏移，精确到毫秒 */
export function nowIso(date: Date = new Date()): string {
  const off = -date.getTimezoneOffset();
  const local = new Date(date.getTime() + off * 60_000).toISOString().slice(0, 23);
  return `${local}${off >= 0 ? "+" : "-"}${pad2(off / 60)}:${pad2(off % 60)}`;
}
