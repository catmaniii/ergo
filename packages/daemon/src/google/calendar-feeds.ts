// Google 日历订阅（297 号票）：Google 插件的服务里日历这一块。用户在设置 · 数据源填一个或几个"iCal 格式的私密地址"，
// 这里负责：
// - 地址存密钥区（DataSourceSecrets：feeds 是几个日历的 id，feed.<id> 是那个日历的地址；id 是地址的哈希前 10 位，同一个地址删了再加还是它）；
//   事件、日志、页面上只有 id、名字和打了码的地址（feed-fetch.ts 的 maskAddress）；
// - 填设置时测试连接（拉一遍、认得出是日历才存），删掉一个日历（它的事件各写一条 removed）；
// - 同步：每个日历拉一遍、和现在的比（events.ts 的 foldCalendars），只写新的、变了的、没了的，交回"新进来几条"（新的加上变了的）；
//   哪个日历拉不到记下原因（页面上那个日历下面写着），有拉不到的整次算出错（数据源页"上次同步出错：「工作」地址失效了……"），拉到的照样写；
// - 外部日历（数据源的 calendar()，299 号票定的路：日历插件按月取时经内核现取）：把还配着的几个日历在那一段时间里展开（recurrence.ts），
//   标上哪个日历（用户起的名字，没有用日历自己的）；断开以后没有地址了就不给（和手机日历一样）；
// - 按需查（calendar-tool.ts）现拉一遍再展开，拉不到的用同步来的那份；
// - 306 号票：每个日历都**连着 3 次**"一直不行"（地址失效、没权限：FeedProblem.lasting；偶尔一次 404 不算）时连接状态是出错
//   （原因写哪几个日历怎么了），内核就不把"查 Google 日历"给秘书、定期导入到点也不拉，每小时替它再试一次（recheck：每个地址拉一遍、
//   不写事件），拉到了就回到连着；重新填一遍地址（或者删掉坏的、加新的）也好。一时拉不到（超时、连不上）的照样连着、也把"连着几次"
//   清零。同步、按需查现拉、再试时都记下（拉到了就清掉）；
// - "共几条"（数据源的 count()）：同步来的事件按最后一版数。
// 事件不采成素材（日历的事件给日历插件显示）。
import { createHash } from "node:crypto";
import { nowIso, t } from "@ergo/protocol";
import type {
  DataSourceCalendarEvent,
  DataSourceContext,
  DataSourceItem,
  DataSourceRecheckContext,
  DataSourceSecrets,
  DataSourceStatus,
  DataSourceSyncContext,
  DataSourceSyncResult,
} from "../data-sources/api.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import type { Clock } from "../scheduler/clock.ts";
import { type FeedState, foldCalendars, GOOGLE_CALENDAR_FEED, GOOGLE_CALENDAR_ITEM, GOOGLE_CHANNEL, type GoogleCalendarFeedPayload, type GoogleCalendarItemPayload } from "./events.ts";
import { calendarIdOf, checkAddress, FeedProblem, fetchFeed, maskAddress, maskId } from "./feed-fetch.ts";
import { eventKey, type IcalCalendar, type IcalEvent } from "./ical.ts";
import { expandEvents, type Occurrence } from "./recurrence.ts";

/** 日历订阅这个数据源的 id（定了别改：用法开关、密钥区、同步记录按它记） */
export const GOOGLE_CALENDAR_SOURCE = "google-calendar";

/** 密钥区里：几个日历的 id（逗号分开）、每个日历的地址 */
const FEEDS_KEY = "feeds";
const feedKey = (id: string) => `feed.${id}`;

/** 地址 → 日历的 id（哈希前 10 位：同一个地址删了再加还是它，事件对得上；从 id 推不回地址） */
export const feedIdOf = (address: string) => `g${createHash("sha256").update(address).digest("hex").slice(0, 10)}`;

/** 密钥区里配着的几个日历（按加的先后）：id 和地址 */
export function configuredFeeds(secrets: Pick<DataSourceSecrets, "get">): Array<{ id: string; address: string }> {
  return (secrets.get(FEEDS_KEY) ?? "")
    .split(",")
    .filter(Boolean)
    .flatMap((id) => {
      const address = secrets.get(feedKey(id));
      return address ? [{ id, address }] : [];
    });
}

/** 一次展开出的日程（日历的哪一个、哪一次） */
export interface CalendarOccurrence {
  readonly feed: FeedState;
  /** 日历的名字（用户起的、日历自己的、"日历 1"） */
  readonly name: string;
  /** 给人看的"Google · 名字" */
  readonly calendar: string;
  readonly occurrence: Occurrence;
}

export interface GoogleCalendarOptions {
  store: EventStore;
  clock: Pick<Clock, "now">;
  /** 日历插件在不在运行（不在时数据源页上写"日历插件没启用"） */
  calendarOn: () => boolean;
  fetch?: typeof fetch;
  timeoutMs?: number;
  log: (line: string) => void;
}

/** 一个日历连着几次"一直不行"（地址失效、没权限）才算它坏了（306 号票：偶尔一次 404 不该让日历停下） */
export const FEED_LASTING_AFTER = 3;

export interface GoogleCalendarService {
  /** 今天（本地日期 YYYY-MM-DD，按守护进程的时钟） */
  today(): string;
  /** 现在的几个日历（事件里折出来的，删掉了的不在） */
  feeds(): Map<string, FeedState>;
  /** 给人看的日历名字："工作"（用户起的）、日历自己的名字、"日历 1" */
  nameOf(feed: FeedState | undefined, index: number): string;
  /** 连接状态：配了日历的算连着；带着几个日历（打了码的地址、拉不到的原因）和"日历插件没启用"的提示 */
  status(ctx: DataSourceContext): DataSourceStatus;
  /** 填设置：add（一个或几个地址，空白分开）加上 name（只加一个时它的名字）；remove（日历的 id）删掉一个 */
  configure(values: Readonly<Record<string, string>>, ctx: DataSourceContext): Promise<DataSourceStatus>;
  /** 同步一次 */
  sync(ctx: DataSourceSyncContext): Promise<DataSourceSyncResult>;
  /** 出错后再试（306 号票，内核每小时叫）：每个地址拉一遍，拉到的清掉原因、拉不到的记下，不写事件 */
  recheck(ctx: DataSourceRecheckContext): Promise<void>;
  /** 断开时的清理：记着的拉不到的原因清掉（密钥区那一格、事件由内核删） */
  disconnect(): void;
  /** 同步来的那几个日历在 [from, to) 里展开（日历插件、按需查拉不到时用） */
  occurrences(from: Date, to: Date, only?: ReadonlySet<string>): CalendarOccurrence[];
  /** 现拉几个日历在 [from, to) 里展开（按需查）：拉不到的用同步来的那份，交回哪几个拉不到、原因 */
  live(ctx: DataSourceContext, from: Date, to: Date, signal?: AbortSignal): Promise<{ occurrences: CalendarOccurrence[]; failed: Array<{ name: string; reason: string; fallback: boolean }>; configured: number }>;
  /** 交给日历插件显示的日程（数据源的 calendar()）：还配着地址的几个日历 */
  calendarEvents(ctx: DataSourceContext, from: Date, to: Date): DataSourceCalendarEvent[];
  /** 同步来的事件现在有几个（按最后一版：改过的算一个、删掉的不算） */
  count(): number;
}

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));
/** 两版一样不一样（解析出的样子字段顺序固定，按 JSON 比） */
const same = (a: IcalEvent, b: IcalEvent) => JSON.stringify(a) === JSON.stringify(b);
const pad = (n: number) => String(n).padStart(2, "0");
const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** 给人看的日历名字：用户起的、日历自己的、"日历 1" */
const nameOf = (feed: FeedState | undefined, index: number) => feed?.label ?? feed?.name ?? t("google.calendar.unnamed", { n: index + 1 });
/** 填设置没过 */
const failed = (problem: string): DataSourceStatus => ({ connection: "error", problem });

export function createGoogleCalendar(options: GoogleCalendarOptions): GoogleCalendarService {
  const { store, log } = options;
  const now = () => nowIso(new Date(options.clock.now()));
  /** 哪个日历上次拉不到、原因、连着几次"一直不行"（地址失效、没权限：306 号票；一时拉不到的是 0）（重启就没了；页面上那个日历下面写着） */
  const problems = new Map<string, { text: string; streak: number }>();
  const noteProblem = (id: string, err: unknown) => {
    const lasting = err instanceof FeedProblem && err.lasting;
    problems.set(id, { text: err instanceof FeedProblem ? err.message : describe(err), streak: lasting ? (problems.get(id)?.streak ?? 0) + 1 : 0 });
  };
  /** 重复规则认不得、只给了第一次的事件：每个只记一次日志 */
  const approximateLogged = new Set<string>();
  let cache: { at: number; feeds: Map<string, FeedState> } | undefined;

  const feeds = (): Map<string, FeedState> => {
    const at = store.lastGlobalSeq();
    if (!cache || cache.at !== at) cache = { at, feeds: foldCalendars(store.read(GOOGLE_CHANNEL)) };
    return cache.feeds;
  };

  /** 一个日历的事件在 [from, to) 里展开 */
  const expandFeed = (feed: FeedState, events: readonly IcalEvent[], index: number, from: Date, to: Date): CalendarOccurrence[] => {
    const { occurrences, approximate } = expandEvents(events, { from: from.getTime(), to: to.getTime() }, feed.timeZone === undefined ? {} : { timeZone: feed.timeZone });
    for (const uid of approximate) {
      if (approximateLogged.has(`${feed.id}:${uid}`)) continue;
      approximateLogged.add(`${feed.id}:${uid}`);
      log(`Google 日历 ${feed.id} 里有一个事件的重复规则认不得，只显示第一次`);
    }
    const name = nameOf(feed, index);
    const calendar = t("google.calendar.calendarLabel", { name });
    return occurrences.map((occurrence) => ({ feed, name, calendar, occurrence }));
  };

  const occurrences = (from: Date, to: Date, only?: ReadonlySet<string>): CalendarOccurrence[] =>
    [...feeds().values()].flatMap((feed, index) => (only && !only.has(feed.id) ? [] : expandFeed(feed, [...feed.items.values()], index, from, to)));

  /** 写一个日历的元信息（名字、时区）——没变的不写 */
  const feedEvent = (id: string, calendar: IcalCalendar | undefined, label: string | undefined): NewEvent | undefined => {
    const current = feeds().get(id);
    const next: GoogleCalendarFeedPayload = {
      feed: id,
      at: now(),
      ...((label ?? current?.label) === undefined ? {} : { label: (label ?? current?.label)! }),
      ...((calendar ? calendar.name : current?.name) === undefined ? {} : { name: (calendar ? calendar.name : current?.name)! }),
      ...((calendar ? calendar.timeZone : current?.timeZone) === undefined ? {} : { timeZone: (calendar ? calendar.timeZone : current?.timeZone)! }),
    };
    if (current && current.label === next.label && current.name === next.name && current.timeZone === next.timeZone) return undefined;
    return { channel: GOOGLE_CHANNEL, type: GOOGLE_CALENDAR_FEED, payload: next };
  };

  /** 把拉到的一个日历写进事件：只写新的、变了的、没了的；交回新的加上变了的有几条 */
  const apply = (id: string, calendar: IcalCalendar): number => {
    const current = feeds().get(id);
    const at = now();
    const events: NewEvent[] = [];
    const meta = feedEvent(id, calendar, undefined);
    if (meta) events.push(meta);
    const next = new Map<string, IcalEvent>();
    for (const event of calendar.events) next.set(eventKey(event), event);
    let added = 0;
    for (const [key, event] of next) {
      const old = current?.items.get(key);
      if (old && same(old, event)) continue;
      added += 1;
      events.push({ channel: GOOGLE_CHANNEL, type: GOOGLE_CALENDAR_ITEM, payload: { feed: id, key, at, event } satisfies GoogleCalendarItemPayload });
    }
    for (const key of current?.items.keys() ?? []) {
      if (!next.has(key)) events.push({ channel: GOOGLE_CHANNEL, type: GOOGLE_CALENDAR_ITEM, payload: { feed: id, key, at, removed: true } satisfies GoogleCalendarItemPayload });
    }
    if (events.length > 0) store.appendBatch(events);
    return added;
  };

  /** 删掉一个日历：它的每一个事件写一条 removed，再写日历的 removed */
  const removeFeed = (id: string) => {
    const current = feeds().get(id);
    const at = now();
    const events: NewEvent[] = [...(current?.items.keys() ?? [])].map((key) => ({ channel: GOOGLE_CHANNEL, type: GOOGLE_CALENDAR_ITEM, payload: { feed: id, key, at, removed: true } satisfies GoogleCalendarItemPayload }));
    if (current) events.push({ channel: GOOGLE_CHANNEL, type: GOOGLE_CALENDAR_FEED, payload: { feed: id, at, removed: true } satisfies GoogleCalendarFeedPayload });
    if (events.length > 0) store.appendBatch(events);
  };

  const fetchOne = (address: string, signal?: AbortSignal) =>
    fetchFeed(address, { ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }), ...(signal ? { signal } : {}) });

  const status = (ctx: DataSourceContext): DataSourceStatus => {
    const configured = configuredFeeds(ctx.secrets);
    const state = feeds();
    const note = options.calendarOn() ? undefined : t("google.calendar.calendarOff", { reason: t("plugins.notEnabled", { title: t("calendar.plugin.title") }) });
    if (configured.length === 0) return { connection: "not_connected", ...(note === undefined ? {} : { note }) };
    const items: DataSourceItem[] = configured.map(({ id, address }, index) => {
      const problem = problems.get(id)?.text;
      const count = state.get(id)?.items.size ?? 0;
      return {
        id,
        title: nameOf(state.get(id), index),
        detail: t("google.calendar.itemDetail", { address: maskAddress(address), count, n: count }),
        ...(problem === undefined ? {} : { problem }),
      };
    });
    // 每个日历都连着几次一直不行（地址失效、没权限）：出错（306 号票：按需查的工具不给、定期导入不拉、每小时再试），原因写哪个日历怎么了
    const lasting = configured.every(({ id }) => (problems.get(id)?.streak ?? 0) >= FEED_LASTING_AFTER);
    // 账号：私密地址里的个人日历 id（邮箱，打了码）；共享的、订阅的日历（…@group.calendar.google.com）不算
    const accounts = [...new Set(configured.flatMap(({ address }) => {
      const id = calendarIdOf(address);
      return id && id.includes("@") && !id.includes("calendar.google.com") ? [maskId(id)] : [];
    }))];
    const account = accounts.length > 0 ? { account: accounts.join(t("google.calendar.listSep")) } : {};
    const disconnectNote = { disconnectNote: t("google.calendar.disconnectNote") };
    if (lasting) {
      const problem = configured.length === 1 ? items[0]!.problem! : items.map((item) => t("google.calendar.feedFailed", { name: item.title, reason: item.problem! })).join(t("google.calendar.problemSep"));
      return { connection: "error", problem, ...account, ...(note === undefined ? {} : { note }), items, ...disconnectNote };
    }
    return { connection: "connected", ...account, ...(note === undefined ? {} : { note }), items, ...disconnectNote };
  };

  const configure = async (values: Readonly<Record<string, string>>, ctx: DataSourceContext): Promise<DataSourceStatus> => {
    const configured = configuredFeeds(ctx.secrets);
    if (values.remove !== undefined) {
      const id = values.remove.trim();
      if (!configured.some((f) => f.id === id)) return failed(t("google.calendar.noSuchFeed"));
      ctx.secrets.delete(feedKey(id));
      const rest = configured.filter((f) => f.id !== id).map((f) => f.id);
      if (rest.length > 0) ctx.secrets.set(FEEDS_KEY, rest.join(","));
      else ctx.secrets.delete(FEEDS_KEY);
      problems.delete(id);
      removeFeed(id);
      ctx.log(`删掉了一个日历 ${id}`);
      return status(ctx);
    }
    const raw = (values.add ?? "").split(/\s+/).filter(Boolean);
    if (raw.length === 0) return failed(t("google.calendar.address.empty"));
    // 先都检查、拉一遍：有一个不行就都不存
    const fetched: Array<{ id: string; address: string; calendar: IcalCalendar }> = [];
    for (const [index, text] of raw.entries()) {
      const which = raw.length > 1 ? t("google.calendar.address.which", { n: index + 1 }) : "";
      try {
        const address = checkAddress(text);
        fetched.push({ id: feedIdOf(address), address, calendar: await fetchOne(address) });
      } catch (err) {
        return failed(`${which}${err instanceof FeedProblem ? err.message : describe(err)}`);
      }
    }
    const label = raw.length === 1 ? values.name?.trim() || undefined : undefined;
    const ids = configured.map((f) => f.id);
    const events: NewEvent[] = [];
    for (const { id, address, calendar } of fetched) {
      ctx.secrets.set(feedKey(id), address);
      if (!ids.includes(id)) ids.push(id);
      problems.delete(id);
      // 日历的名字、时区、用户起的名字（事件等同步时写）
      const meta = feedEvent(id, calendar, label);
      if (meta) events.push(meta);
    }
    ctx.secrets.set(FEEDS_KEY, ids.join(","));
    if (events.length > 0) store.appendBatch(events);
    ctx.log(`加了 ${fetched.length} 个日历：${fetched.map((f) => f.id).join("、")}`);
    return status(ctx);
  };

  const sync = async (ctx: DataSourceSyncContext): Promise<DataSourceSyncResult> => {
    const configured = configuredFeeds(ctx.secrets);
    const results = await Promise.all(
      configured.map(async ({ id, address }) => {
        try {
          return { id, calendar: await fetchOne(address, ctx.signal) };
        } catch (err) {
          if (ctx.signal.aborted) throw err;
          return { id, error: err };
        }
      }),
    );
    let added = 0;
    const failures: string[] = [];
    const state = feeds();
    for (const [index, result] of results.entries()) {
      if (result.calendar) {
        problems.delete(result.id);
        added += apply(result.id, result.calendar);
      } else {
        noteProblem(result.id, result.error);
        failures.push(t("google.calendar.feedFailed", { name: nameOf(state.get(result.id), index), reason: problems.get(result.id)!.text }));
      }
    }
    if (failures.length > 0) throw new Error(failures.join(t("google.calendar.problemSep")));
    return { added };
  };

  const live = async (ctx: DataSourceContext, from: Date, to: Date, signal?: AbortSignal) => {
    const configured = configuredFeeds(ctx.secrets);
    const state = feeds();
    const got = await Promise.all(
      configured.map(async ({ id, address }, index) => {
        const synced = state.get(id);
        try {
          const calendar = await fetchOne(address, signal);
          problems.delete(id);
          const feed: FeedState = { id, ...(synced?.label === undefined ? {} : { label: synced.label }), ...(calendar.name === undefined ? {} : { name: calendar.name }), ...(calendar.timeZone === undefined ? {} : { timeZone: calendar.timeZone }), items: new Map() };
          return { occurrences: expandFeed(feed, calendar.events, index, from, to) };
        } catch (err) {
          if (signal?.aborted) throw err;
          // 按需查现拉时发现地址失效也记下（306 号票：查完内核比一比，都不行了就不再给秘书这个工具）
          noteProblem(id, err);
          const reason = err instanceof FeedProblem ? err.message : describe(err);
          return { failed: { name: nameOf(synced, index), reason, fallback: synced !== undefined }, occurrences: synced ? expandFeed(synced, [...synced.items.values()], index, from, to) : [] };
        }
      }),
    );
    return {
      occurrences: got.flatMap((g) => g.occurrences).toSorted((a, b) => a.occurrence.start - b.occurrence.start || Number(b.occurrence.allDay) - Number(a.occurrence.allDay)),
      failed: got.flatMap((g) => (g.failed ? [g.failed] : [])),
      configured: configured.length,
    };
  };

  /** 交给日历插件显示的（外部日历）：还配着地址的几个日历在 [from, to) 里展开；全天的从那天本地零点到结束那天零点 */
  const calendarEvents = (ctx: DataSourceContext, from: Date, to: Date): DataSourceCalendarEvent[] => {
    const only = new Set(configuredFeeds(ctx.secrets).map((f) => f.id));
    if (only.size === 0) return [];
    return occurrences(from, to, only).map(({ feed, name, occurrence: o }) => ({
      calendar: name,
      id: `${feed.id}:${o.key}`,
      title: o.event.summary,
      at: nowIso(o.allDay ? startOfDate(o.startDate!) : new Date(o.start)),
      end: nowIso(o.allDay ? startOfDate(o.endDate!) : new Date(o.end)),
      allDay: o.allDay,
      ...(o.event.location === undefined ? {} : { location: o.event.location }),
    }));
  };

  const recheck = async (ctx: DataSourceRecheckContext): Promise<void> => {
    for (const { id, address } of configuredFeeds(ctx.secrets)) {
      try {
        await fetchOne(address, ctx.signal);
        problems.delete(id);
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        noteProblem(id, err);
      }
    }
  };

  return {
    today: () => isoDate(new Date(options.clock.now())),
    feeds,
    nameOf,
    status,
    configure,
    sync,
    recheck,
    disconnect: () => problems.clear(),
    occurrences,
    live,
    calendarEvents,
    count: () => [...feeds().values()].reduce((n, feed) => n + feed.items.size, 0),
  };
}

/** 本地日期（YYYY-MM-DD）那天的零点 */
export function startOfDate(date: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}
