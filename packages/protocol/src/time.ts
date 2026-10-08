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

/** 协议时间写着的几点几分：…T09:12:00.000+08:00 → "09:12"（写的就是守护进程那边的本地时间，按它分天的日历也取这个）；写法不对原样返回 */
export function clockLabel(iso: string): string {
  const m = /T(\d{2}):(\d{2})/.exec(iso);
  return m ? `${m[1]}:${m[2]}` : iso;
}

/** 一段时间的中文写法：25 分钟 / 3 小时 5 分钟 / 2 天 3 小时（提醒晚了多久：待我处理的事项、日历的详情） */
export function describeDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} 小时 ${minutes % 60} 分钟` : `${hours} 小时`;
  return hours % 24 ? `${Math.floor(hours / 24)} 天 ${hours % 24} 小时` : `${Math.floor(hours / 24)} 天`;
}
