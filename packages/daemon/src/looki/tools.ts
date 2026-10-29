// @i18n-ignore-file model：给秘书的工具（说明、参数说明、结果）只给模型看，只写中文
// Looki 的按需查（296 号票）：给秘书一个工具"查 Looki"，被问"我昨天下午在干嘛""上周三中午在哪吃的饭"时现查——
// 按日期（最多 7 天，可加时间段）列出时刻，或者按关键词（Looki 按意思搜）找；只读、现查不存（导入的另走定期导入）。
// 由内核替数据源登记给秘书（按需查开着、插件在运行时才有）。照片视频不下载、不交链接（Looki 的下载链接一小时就失效），要看请用户去 Looki App。
import { clockLabel, parseLocalDate, Type } from "@ergo/protocol";
import { defineHostTool, type HostTool } from "../agent-manager/host-tools.ts";
import type { DataSourceSecrets } from "../data-sources/api.ts";
import { LOOKI_QUERY_TOOL, type LookiJournalPayload, type LookiMediaKind, type LookiMomentPayload } from "./api.ts";
import { LookiError } from "./client.ts";
import { daysBetween } from "./records.ts";
import { type LookiQuery, QUERY_MAX_DAYS, type LookiService } from "./service.ts";

/** 一次最多列几个时刻 */
const MAX_LISTED = 30;
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const MEDIA_NAMES: Readonly<Record<LookiMediaKind, string>> = { photo: "照片", video: "视频", audio: "录音" };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^([01]?\d|2[0-3]):[0-5]\d$/;

const Params = Type.Object({
  date: Type.Optional(Type.String({ description: "哪一天，YYYY-MM-DD（用户消息前标着今天的日期，\"昨天\"就是今天减一天）。不给：按关键词搜时不限日子，按日期列出时是今天" })),
  end_date: Type.Optional(Type.String({ description: "查一段日子时的最后一天（含），YYYY-MM-DD；按日期列出时最多 7 天" })),
  from: Type.Optional(Type.String({ description: "只要这个钟点之后的，HH:mm（\"下午\"可以给 12:00）" })),
  to: Type.Optional(Type.String({ description: "只要这个钟点之前的，HH:mm（\"下午\"可以给 18:00）" })),
  keyword: Type.Optional(Type.String({ description: "关键词（Looki 按意思搜，1–100 字），比如\"火锅\"\"跑步\"\"开会\"；不给就按日期列出" })),
});

/** 一个日期的写法：10-24（周六） */
const dayLabel = (date: string) => {
  try {
    return `${date.slice(5)}（${WEEKDAYS[parseLocalDate(date).weekday]}）`;
  } catch {
    return date;
  }
};

/** 一个时刻一行：14:00–16:30 · 地点 · 标题：描述（有照片、视频） */
function momentLine(m: LookiMomentPayload, withDate: boolean): string {
  const span = m.end === undefined ? clockLabel(m.start) : `${clockLabel(m.start)}–${clockLabel(m.end)}`;
  const head = [withDate ? `${dayLabel(m.date)} ${span}` : span, ...(m.place ? [m.place] : [])].join(" · ");
  const body = m.title && m.description ? `${m.title}：${m.description}` : m.title || m.description;
  const media = m.media && m.media.length > 0 ? `（有${m.media.map((k) => MEDIA_NAMES[k]).join("、")}）` : "";
  return `- ${head} · ${body}${media}`;
}

/** 钟点补成两位（9:00 → 09:00） */
const padClock = (s: string) => s.padStart(5, "0");

/** 时刻在不在时间段里（和 [after, before] 有重叠；按时刻自己那个时区的钟点比） */
function within(m: LookiMomentPayload, after: string | undefined, before: string | undefined): boolean {
  const start = clockLabel(m.start);
  const end = m.end === undefined ? start : clockLabel(m.end);
  if (after !== undefined && end < padClock(after)) return false;
  if (before !== undefined && start > padClock(before)) return false;
  return true;
}

/** 日记一段 */
const journalLine = (j: LookiJournalPayload) => `那天 Looki 的 AI 替用户写的日记《${j.title || j.date}》：${j.summary || j.content.slice(0, 300)}`;

const FOOTER = "（时刻是 Looki 按拍到的照片视频自动整理的，不一定准，转述时说是 Looki 记的。照片、视频二狗不下载——Looki 的下载链接一小时就失效，要看请用户在 Looki App 里打开那个时刻。）";

/** 出错给模型看的 */
function errorText(err: unknown): string {
  if (err instanceof LookiError) {
    switch (err.failure) {
      case "no_key":
        return "还没连上 Looki（用户没在设置 · 数据源里填 API Key），现在查不了。如实告诉用户，要用的话请他去填。";
      case "key":
        return "Looki 不认现在存的 API Key（可能被删了、过期了，或者区域选错了），现在查不了。如实告诉用户，请他在设置 · 数据源 · Looki 里重新填 Key。";
      case "rate_limit":
        return "Looki 限速了（每个 Key 每分钟最多 60 次），现在查不了：过一分钟再查，别马上重试。";
      case "network":
        return `连不上 Looki：${err.message}。如实告诉用户，过一会儿再查。`;
      default:
        return `Looki 那边没查成：${err.message}`;
    }
  }
  return `查 Looki 出错了：${err instanceof Error ? err.message : String(err)}`;
}

/** 参数 → 查询；不对的交回一句给模型的 */
function queryOf(args: { date?: string; end_date?: string; from?: string; to?: string; keyword?: string }): LookiQuery | string {
  for (const [name, value] of [
    ["date", args.date],
    ["end_date", args.end_date],
  ] as const) {
    if (value === undefined) continue;
    if (!DATE.test(value)) return `${name} 要写成 YYYY-MM-DD：${value}`;
    try {
      parseLocalDate(value);
    } catch {
      return `${name} 不是日历上有的日子：${value}`;
    }
  }
  for (const [name, value] of [
    ["from", args.from],
    ["to", args.to],
  ] as const) {
    if (value !== undefined && !CLOCK.test(value)) return `${name} 要写成 HH:mm：${value}`;
  }
  if (args.end_date !== undefined && args.date === undefined) return "给了 end_date 就要给 date（从哪天起）";
  if (args.date !== undefined && args.end_date !== undefined && args.end_date < args.date) return "end_date 不能早于 date";
  const keyword = args.keyword?.trim();
  if (keyword !== undefined && keyword !== "") {
    if ([...keyword].length > 100) return "关键词最多 100 个字";
    return { keyword, ...(args.date ? { from: args.date } : {}), ...(args.end_date ? { to: args.end_date } : args.date ? { to: args.date } : {}), ...(args.from ? { after: args.from } : {}), ...(args.to ? { before: args.to } : {}) };
  }
  if (args.date !== undefined && args.end_date !== undefined && daysBetween(args.date, args.end_date).length > QUERY_MAX_DAYS) return `按日期列出一次最多 ${QUERY_MAX_DAYS} 天；要找更早的事给关键词`;
  return { ...(args.date ? { from: args.date } : {}), ...(args.end_date ? { to: args.end_date } : {}), ...(args.from ? { after: args.from } : {}), ...(args.to ? { before: args.to } : {}) };
}

/** 这次查的是什么（给模型看的开头） */
function rangeText(query: LookiQuery, today: string): string {
  const from = query.from ?? (query.keyword === undefined ? today : undefined);
  const to = query.to ?? from;
  const days = from === undefined ? "" : from === to ? from : `${from} 到 ${to}`;
  const span = query.after !== undefined || query.before !== undefined ? ` ${query.after ?? "00:00"}–${query.before ?? "24:00"}` : "";
  return `${days}${span}`.trim();
}

/** 给秘书的"查 Looki" */
export function lookiQueryTool(service: () => LookiService, secrets: DataSourceSecrets, title: string, today: () => string): HostTool {
  return defineHostTool({
    name: LOOKI_QUERY_TOOL,
    title,
    description:
      "查 Looki（用户戴的挂脖相机）记下的时刻：每个时刻有时间段、地点、标题和描述（Looki 按拍到的照片视频自动整理）。用户问\"我昨天下午在干嘛\"\"上周三中午在哪吃的饭\"\"我最近一次去健身房是哪天\"时现查。按日期列出（date，可加 end_date 查几天、from / to 限定钟点），或者按关键词搜（keyword，可加日期范围）。只读，查到的是 Looki 的自动整理，不一定准，转述时说是 Looki 记的；查不到可能是那段时间没戴、没拍，或者还没从手机同步上去。",
    parameters: Params,
    readOnlyOrIdempotent: true,
    nature: "look",
    async run(args, call) {
      const query = queryOf(args);
      if (typeof query === "string") return { text: query, isError: true };
      let result;
      try {
        result = await service().query(query, secrets, call.signal);
      } catch (err) {
        return { text: errorText(err), isError: true };
      }
      const range = rangeText(query, today());
      const moments = result.moments.filter((m) => within(m, query.after, query.before)).toSorted((a, b) => Date.parse(a.start) - Date.parse(b.start));
      const multiDay = new Set(moments.map((m) => m.date)).size > 1 || query.keyword !== undefined;
      const what = query.keyword === undefined ? `Looki 里 ${range} 的时刻` : `Looki 里和「${query.keyword}」有关的时刻${range ? `（${range}）` : ""}`;
      const journals = result.journals.map(journalLine);
      if (moments.length === 0 && journals.length === 0) return { text: `${what}：一个都没有（可能那段时间没戴、没拍，或者还没从手机同步上去）。` };
      const listed = moments.slice(0, MAX_LISTED).map((m) => momentLine(m, multiDay));
      const more = moments.length > MAX_LISTED ? [`……还有 ${moments.length - MAX_LISTED} 个没列出，缩小日期或时间段再查。`] : [];
      return { text: [`${what}（${moments.length} 个）：`, ...listed, ...more, ...journals, FOOTER].join("\n") };
    },
  });
}
