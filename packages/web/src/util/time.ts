// 时间的格式化和"现在"。事件里的时间都是带时区偏移的本地 ISO 字符串，格式只有一份，在共享协议包的 nowIso。

/** ISO 时间 → "10-07 09:12" */
export function timeLabel(iso: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  return m ? `${m[1]}-${m[2]} ${m[3]}:${m[4]}` : iso;
}

/**
 * "下一次"的时间（282 号票，提醒卡、看板、任务详情上的"下一次 / 下次"）：在今年的照 timeLabel 写 "10-07 09:12"；
 * 不在今年的（每年的提醒、12 月建的每月提醒落到明年 1 月……所有种类一样）带上年份 "2027-01-08 09:00"
 */
export function nextTimeLabel(iso: string, now: number = Date.now()): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!m || Number(m[1]) === new Date(now).getFullYear()) return timeLabel(iso);
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
}

/** 现在的本地时间（和服务端事件里的时间同一种写法）；ISO 时间 → "09:12"（只此一份，在共享协议包） */
export { clockLabel, nowIso } from "@ergo/protocol";
