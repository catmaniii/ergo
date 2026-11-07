// 体检后台盯着（416）：体检要用户自己打开才查，备份失败、夜里整理连着几晚超时用户都不知道——用户 11-07 同意"后台盯着，坏了放进待办"。
//
// - 盯哪几项（DOCTOR_WATCHED）：备份、夜里整理记忆、语音合成和识别、模型近况、对话长度。直接用平时体检登记的那几项检查
//   （doctor.view({ include }) 只挑这几项跑，判法一份，不另写），只跑 passive / local 两档：不联网、不调模型、不改东西。
//   语音"开了的才查"由语音那两项自己判（没开是不适用），这里不管。
// - 多久查一次：每 WATCH_INTERVAL_MS（5 分钟）一轮；刚启动的 WATCH_STARTUP_GRACE_MS（5 分钟）里不查（服务还在起、模型近况是空的）。
// - 防抖：一项连着 WATCH_BAD_STREAK（3）轮都是注意 / 坏了才算；或者连着两轮都不正常、两轮隔了 WATCH_BAD_FOR_MS（15 分钟）以上
//   （电脑睡了一觉，中间的轮没跑）。正常、不适用、这一项不见了（插件停用）就从头数；没查出来（超时、出错）不算好也不算坏，接着数。
// - 放进待办：一项一条（notice doctor_problem）——哪件事（标题"备份有问题""语音合成坏了"）、事实、从什么时候起、怎么修，
//   动作"去体检页看看"（前端带到设置 · 体检，不算处理）和"不再提醒这件事"。同一件事只放一条：还有一条没处理的（归档了也算，
//   用户删了的这次运行里也算）就不再放；产生它的模块自己放的同一件事的通知（备份失败、整理失败、识别用不了……related）还开着，也不放。
// - 修好了自动收：这一项变回正常 / 不适用 / 不见了，没处理的那条系统替你记成处理过（DOCTOR_WATCH_FIXED）并归档。
// - 不再提醒：点了的那一项记进配置区的 doctor-watch.json（块、项、名字、什么时候），以后再坏也不放；体检页上"恢复提醒"拿掉。
// - 服务管家用来判断要不要重启二狗的心跳（lsm/link.ts 的 health）和网关的 /healthz 不看这里：只看二狗自己（秘书、插件装没装上），
//   不掺模型、语音、备份——DeepSeek 一忙不能让二狗被重启。这里只往待办里放东西，不碰健康状态（main/doctor-watch.test.ts 锁着）。
import fs from "node:fs";
import path from "node:path";
import {
  DOCTOR_CORE_GROUP,
  DOCTOR_MUTE_ACTION,
  DOCTOR_OPEN_ACTION,
  DOCTOR_WATCH_FIXED,
  type DoctorItemView,
  type DoctorMessage,
  type DoctorProblemNoticeData,
  type DoctorView,
  type DoctorWatchKey,
  type DoctorWatchView,
  doctorText,
  doctorWatchKey,
  type InboxItem,
  type NoticeInboxItem,
  t,
} from "@ergo/protocol";
import type { EventStore } from "../events/event-store.ts";
import type { InboxService } from "../inbox/inbox.ts";
import type { Clock } from "../scheduler/clock.ts";
import { writeJsonAtomic } from "../util/json-file.ts";
import { doctorTime } from "./auto.ts";
import type { DoctorCost } from "./checks.ts";
import type { DoctorService } from "./doctor.ts";

/** 待办里"体检发现"事项的种类 */
export const DOCTOR_PROBLEM_NOTICE = "doctor_problem";

/** 盯着的一项：哪一块（DOCTOR_CORE_GROUP 或插件名）、哪一项；related：产生它的模块自己放的、说同一件事的通知种类 */
export interface WatchedCheck extends DoctorWatchKey {
  related?: readonly string[];
}

/**
 * 后台盯着的几项（用户 11-07 定的，方案第二节第 6 条）：备份（411）、夜里整理记忆（412）、语音合成和识别（413，没开是不适用）、
 * 模型近况和对话长度（410）
 */
export const DOCTOR_WATCHED: readonly WatchedCheck[] = [
  { group: DOCTOR_CORE_GROUP, id: "backup", related: ["backup_failed", "backup_overdue"] },
  { group: "memory", id: "nightly", related: ["memory_nightly_failed", "memory_nightly_rebuild"] },
  { group: "voice", id: "speech" },
  { group: "voice", id: "recognizer", related: ["voice_recognizer_unavailable"] },
  { group: DOCTOR_CORE_GROUP, id: "model-calls" },
  { group: DOCTOR_CORE_GROUP, id: "context" },
];

/** 多久查一轮（毫秒） */
export const WATCH_INTERVAL_MS = 5 * 60_000;
/** 启动后多久才开始查（毫秒） */
export const WATCH_STARTUP_GRACE_MS = 5 * 60_000;
/** 连着几轮不正常才算 */
export const WATCH_BAD_STREAK = 3;
/** 或者：连着两轮以上不正常、头一轮到这一轮隔了这么久（毫秒） */
export const WATCH_BAD_FOR_MS = 15 * 60_000;

/** 后台只跑这两档：只读本机、连本机端口；不联网、不调模型的那种（以后的深度体检那一档不在这里跑） */
const WATCH_COSTS: readonly DoctorCost[] = ["passive", "local"];

/** 不再提醒的一项（存进 doctor-watch.json） */
interface MutedEntry extends DoctorWatchKey {
  /** 名字：文案键 + 参数（体检页上按当前语言拼） */
  title: DoctorMessage;
  /** 什么时候点的（ISO） */
  at: string;
}

export interface DoctorWatchOptions {
  /** 体检：只挑盯着的几项跑（view 的 include） */
  doctor: Pick<DoctorService, "view">;
  inbox: Pick<InboxService, "add" | "list" | "buildUpdate" | "isProcessed" | "onNoticeHandled">;
  store: Pick<EventStore, "append">;
  clock: Clock;
  /** 不再提醒的几项存在哪（DataDirLayout.doctorWatchFile） */
  file: string;
  /** 盯哪几项；不给是 DOCTOR_WATCHED */
  watched?: readonly WatchedCheck[];
  intervalMs?: number;
  graceMs?: number;
  streak?: number;
  badForMs?: number;
  log?: (line: string) => void;
}

export interface DoctorWatch {
  /** 开始：启动缓冲过了查第一轮，之后每隔一段查一轮；登记"不再提醒这件事"的处理 */
  start(): void;
  stop(): void;
  /** 现在查一轮（定时器到点时调的就是它；正在查时不再起一轮） */
  round(): Promise<void>;
  /** 体检页上"后台盯着"那一段 */
  view(): DoctorWatchView;
  /** 体检页上"恢复提醒"：从不再提醒里拿掉（本来就没有也照常回） */
  unmute(key: DoctorWatchKey): DoctorWatchView;
}

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

const isMessage = (value: unknown): value is DoctorMessage => typeof value === "object" && value !== null && typeof (value as DoctorMessage).key === "string";

/** 事项 data 里的"哪一项"（形状不对是 undefined） */
function keyOfData(data: unknown): DoctorWatchKey | undefined {
  const d = data as Partial<DoctorProblemNoticeData> | undefined;
  return typeof d?.group === "string" && typeof d.id === "string" ? { group: d.group, id: d.id } : undefined;
}

/** 读不再提醒的几项：没有文件是空的；读不了、不像样记一行日志、当空的（下次点了会覆盖） */
function readMuted(file: string, log: (line: string) => void): MutedEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") log(`体检后台盯着：${file} 读不出来，当没有"不再提醒"的：${describe(err)}`); // @i18n-ignore log
    return [];
  }
  const list = (raw as { muted?: unknown } | null)?.muted;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry: unknown): MutedEntry[] => {
    const e = entry as Partial<MutedEntry> | null;
    return e && typeof e.group === "string" && typeof e.id === "string" && isMessage(e.title) && typeof e.at === "string" ? [{ group: e.group, id: e.id, title: e.title, at: e.at }] : [];
  });
}

/** 这一项在这一轮体检里的样子（块没了、项没了是 undefined） */
function itemOf(view: DoctorView, key: DoctorWatchKey): DoctorItemView | undefined {
  return view.groups.find((group) => group.id === key.group)?.items.find((item) => item.id === key.id);
}

/** 这一轮算什么：坏（注意、坏了）、好（正常、不适用、不见了）、不知道（没查出来） */
function verdict(item: DoctorItemView | undefined): "bad" | "fine" | "unknown" {
  if (item === undefined || item.level === "ok" || item.level === "na") return "fine";
  return item.level === "unknown" ? "unknown" : "bad";
}

export function createDoctorWatch(options: DoctorWatchOptions): DoctorWatch {
  const { doctor, inbox, store, clock, file } = options;
  const watched = options.watched ?? DOCTOR_WATCHED;
  const intervalMs = options.intervalMs ?? WATCH_INTERVAL_MS;
  const graceMs = options.graceMs ?? WATCH_STARTUP_GRACE_MS;
  const streakNeeded = options.streak ?? WATCH_BAD_STREAK;
  const badForMs = options.badForMs ?? WATCH_BAD_FOR_MS;
  const log = options.log ?? (() => {});
  const keys = new Set(watched.map(doctorWatchKey));

  let muted = readMuted(file, log);
  /** 每一项连着几轮不正常、头一轮是什么时候 */
  const streaks = new Map<string, { count: number; firstBadAt: number }>();
  /** 这一段坏的时候已经放过一条了（用户删了也算，不再放）；好了就清掉 */
  const told = new Set<string>();
  let running: Promise<void> | undefined;
  let cancelTimer: (() => void) | undefined;
  let offHandled: (() => void) | undefined;
  let stopped = false;

  const saveMuted = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomic(file, { muted });
  };
  const isMuted = (key: string) => muted.some((entry) => doctorWatchKey(entry) === key);

  /** 这一项的"体检发现"事项里还没处理的（归档了的也算） */
  const unhandledOf = (key: string): NoticeInboxItem[] =>
    inbox.list().filter((item): item is NoticeInboxItem => item.kind === "notice" && item.notice === DOCTOR_PROBLEM_NOTICE && item.handled === undefined && keyOfData(item.data) !== undefined && doctorWatchKey(keyOfData(item.data)!) === key);

  /** 产生它的模块自己放的同一件事的通知还开着（没归档、没处理） */
  const relatedOpen = (related: readonly string[] | undefined): boolean =>
    related !== undefined && related.length > 0 && inbox.list().some((item: InboxItem) => item.kind === "notice" && related.includes(item.notice) && !item.archived && !inbox.isProcessed(item));

  /** 修好了：没处理的那几条记成"已经好了"、归档 */
  const close = (key: string, now: number) => {
    for (const item of unhandledOf(key)) {
      store.append(inbox.buildUpdate(item, { archived: true, read: true, handled: DOCTOR_WATCH_FIXED, handledAt: new Date(now).toISOString() }).event);
      log(`体检后台盯着：${key} 好了，收起待办里那一条（${item.id}）`); // @i18n-ignore log
    }
  };

  /** 放进待办一条 */
  const report = (watch: WatchedCheck, item: DoctorItemView, firstBadAt: number) => {
    const key = doctorWatchKey(watch);
    if (isMuted(key) || told.has(key)) return;
    if (unhandledOf(key).length > 0) {
      told.add(key);
      return;
    }
    // 别的模块已经说着这件事：先不放（那条处理了、还是坏的，下一轮再放）
    if (relatedOpen(watch.related)) return;
    const level = item.level === "error" ? "error" : "warn";
    const since = item.since ?? new Date(firstBadAt).toISOString();
    const body = [
      item.text.fact,
      t("doctor.since", { time: doctorTime(since) }),
      ...(item.text.fix === undefined ? [] : [t("doctor.watch.fix", { fix: item.text.fix })]),
      t("doctor.watch.note", { minutes: Math.round(intervalMs / 60_000) }),
    ].join("\n");
    const data: DoctorProblemNoticeData = { group: watch.group, id: watch.id, level, title: item.title, since };
    const added = inbox.add({
      kind: "notice",
      notice: DOCTOR_PROBLEM_NOTICE,
      title: t(`doctor.watch.title.${level}`, { name: item.text.title }),
      body,
      source: t("doctor.watch.source"),
      urgency: "non_blocking",
      // "去体检页看看"由前端带到设置 · 体检（不算处理）
      actions: [DOCTOR_OPEN_ACTION, DOCTOR_MUTE_ACTION],
      data: { ...data },
    });
    told.add(key);
    log(`体检后台盯着：${key} 连着不正常（${level}），放进待办（${added.id}）`); // @i18n-ignore log
  };

  const check = async (): Promise<void> => {
    const view = await doctor.view({ include: (ref) => keys.has(doctorWatchKey(ref)) && WATCH_COSTS.includes(ref.cost) });
    if (stopped) return;
    const now = clock.now();
    for (const watch of watched) {
      const key = doctorWatchKey(watch);
      const item = itemOf(view, watch);
      const seen = verdict(item);
      if (seen === "unknown") continue;
      if (seen === "fine") {
        streaks.delete(key);
        told.delete(key);
        close(key, now);
        continue;
      }
      const streak = streaks.get(key) ?? { count: 0, firstBadAt: now };
      streak.count += 1;
      streaks.set(key, streak);
      if (streak.count >= streakNeeded || (streak.count >= 2 && now - streak.firstBadAt >= badForMs)) report(watch, item!, streak.firstBadAt);
    }
  };

  const round = (): Promise<void> => {
    if (running) return running;
    running = check()
      .catch((err: unknown) => log(`体检后台盯着：这一轮出错，下一轮再查：${describe(err)}`)) // @i18n-ignore log
      .finally(() => {
        running = undefined;
      });
    return running;
  };

  const arm = (at: number) => {
    cancelTimer = clock.setTimer(at, () => {
      if (stopped) return;
      arm(clock.now() + intervalMs);
      void round();
    });
  };

  const view = (): DoctorWatchView => ({
    everyMinutes: Math.round(intervalMs / 60_000),
    muted: muted.map((entry) => {
      let title: string;
      try {
        title = doctorText(entry.title);
      } catch {
        title = entry.id;
      }
      return { group: entry.group, id: entry.id, title, at: entry.at };
    }),
  });

  return {
    start() {
      stopped = false;
      // 点了"不再提醒这件事"：记住这一项（事项本身已经是处理过了）
      offHandled = inbox.onNoticeHandled(DOCTOR_PROBLEM_NOTICE, DOCTOR_MUTE_ACTION, (item) => {
        const key = keyOfData(item.data);
        const title = (item.data as Partial<DoctorProblemNoticeData> | undefined)?.title;
        if (key === undefined || isMuted(doctorWatchKey(key))) return;
        muted = [...muted, { ...key, title: isMessage(title) ? title : { key: key.id }, at: item.handledAt ?? new Date(clock.now()).toISOString() }];
        saveMuted();
        log(`体检后台盯着：${doctorWatchKey(key)} 不再提醒`); // @i18n-ignore log
      });
      arm(clock.now() + graceMs);
    },
    stop() {
      stopped = true;
      cancelTimer?.();
      cancelTimer = undefined;
      offHandled?.();
      offHandled = undefined;
    },
    round,
    view,
    unmute(key) {
      const k = doctorWatchKey(key);
      if (isMuted(k)) {
        muted = muted.filter((entry) => doctorWatchKey(entry) !== k);
        saveMuted();
        // 还是坏的话下一轮照常放
        told.delete(k);
        log(`体检后台盯着：${k} 恢复提醒`); // @i18n-ignore log
      }
      return view();
    },
  };
}
