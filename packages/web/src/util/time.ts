// 时间的格式化和"现在"。事件里的时间都是带时区偏移的 ISO 字符串。

/** ISO 时间 → "10-07 09:12" */
export function timeLabel(iso: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  return m ? `${m[1]}-${m[2]} ${m[3]}:${m[4]}` : iso;
}

/** ISO 时间 → "09:12" */
export function clockLabel(iso: string): string {
  const m = /T(\d{2}):(\d{2})/.exec(iso);
  return m ? `${m[1]}:${m[2]}` : iso;
}

const pad2 = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");

/** 现在的本地时间，带时区偏移的 ISO 格式（和服务端事件里的时间同一种写法） */
export function nowIso(): string {
  const d = new Date();
  const off = -d.getTimezoneOffset();
  const local = new Date(d.getTime() + off * 60_000).toISOString().slice(0, 19);
  return `${local}${off >= 0 ? "+" : "-"}${pad2(off / 60)}:${pad2(off % 60)}`;
}
