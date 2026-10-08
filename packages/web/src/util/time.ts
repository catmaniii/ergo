// 时间的格式化和"现在"。事件里的时间都是带时区偏移的本地 ISO 字符串，格式只有一份，在共享协议包的 nowIso。

/** ISO 时间 → "10-07 09:12" */
export function timeLabel(iso: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  return m ? `${m[1]}-${m[2]} ${m[3]}:${m[4]}` : iso;
}

/** 现在的本地时间（和服务端事件里的时间同一种写法）；ISO 时间 → "09:12"（只此一份，在共享协议包） */
export { clockLabel, nowIso } from "@ergou/protocol";
