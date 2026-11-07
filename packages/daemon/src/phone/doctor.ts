// "手机"插件自己的体检项（414），在 setup 里经 ctx.doctor.register 登记，都是 passive（读事件、内存里的状态）。
// 二狗已经替它生成的不再重复（doctor/auto.ts）：插件本身；四个数据源各一项——授权被拒、被撤回（needsAuth）是坏了，上次同步的时间、
// 出错的原因。这里只加那几项看不出来的：
// - app（手机 App）：手机日历、相册、位置连着一样，就看手机上的二狗 App 最近一次交来东西（设备交来的同步记录，四个数据源里最晚的
//   那一条，出错的也算：App 开着才交）是什么时候——超过 PHONE_APP_QUIET_MS（3 天）是注意（"手机 App 很久没打开"，从那时起），
//   别的正常；三样都没连是不适用。App 只在开着时交，关着没有别的办法知道它还在不在。
// - calendar-empty（手机日历交来 0 条）：手机日历连着时，最近交来的是 0 条、原来有不少条——
//   · 425 合并后：守护进程不删、记一条 phone_calendar_held（这一段从什么时候起、连着几次、留着几条），这里读最后一条
//     （"事件有就用"：不 import 425 的代码，按事件类型名读；合并后可以换成服务的 calendarHeld()，同一份）；
//   · 没有那条事件时：看插件服务内存里记的（phone.ts 的 calendarEmpty()：交来 0 条、一下删了不少于 PHONE_CALENDAR_DROP_MIN 条），
//     重启就没了；
//   有就是注意（425 留着的写"先留着、没删"，没留的写"跟着删了"），手机又交来日程就过去了；没有是正常；日历没连是不适用。
// 判法都是纯函数（appFinding、calendarEmptyFinding），测试直接喂。
import { isDeletedEventPayload, PHONE_CALENDAR_SOURCE, PHONE_CONTACTS_SOURCE, PHONE_LOCATION_SOURCE, PHONE_PHOTOS_SOURCE } from "@ergo/protocol";
import { dataSourceRecords } from "../data-sources/events.ts";
import { doctorTime } from "../doctor/auto.ts";
import type { DoctorCheck, DoctorFinding } from "../doctor/checks.ts";
import type { EventStore } from "../events/event-store.ts";
import { PHONE_CHANNEL } from "./events.ts";
import type { PhoneCalendarEmpty, PhoneService } from "./phone.ts";

const DAY_MS = 86_400_000;

/** 手机上的二狗 App 多久没交来东西算"很久没打开"（App 开着时日历每 30 分钟交一次） */
export const PHONE_APP_QUIET_MS = 3 * DAY_MS;

/** App 会交来东西的四个数据源（通讯录选人只在用户挑人时交，交了也说明 App 开过） */
const PHONE_SOURCES: readonly string[] = [PHONE_CONTACTS_SOURCE, PHONE_CALENDAR_SOURCE, PHONE_PHOTOS_SOURCE, PHONE_LOCATION_SOURCE];

/**
 * 425 记下的"手机交来 0 条、先留着没删"那一段：phone_calendar_held 事件的负载（按最后一条，不带 held 的是这一段过去了）。
 * 这里只读要用的几样；425 合并后同一份由服务的 calendarHeld() 给
 */
export const PHONE_CALENDAR_HELD_EVENT = "phone_calendar_held";
interface HeldPayload {
  held?: { since?: unknown; times?: unknown; count?: unknown };
}

/** 425 的那一段（没有、已经过去了、认不出来是 undefined） */
export function heldCalendar(store: Pick<EventStore, "read">): PhoneCalendarEmpty | undefined {
  const last = store
    .read(PHONE_CHANNEL, 0, PHONE_CALENDAR_HELD_EVENT)
    .filter((e) => !isDeletedEventPayload(e.payload))
    .at(-1)?.payload as HeldPayload | undefined;
  const held = last?.held;
  if (!held || typeof held.since !== "string" || typeof held.times !== "number" || typeof held.count !== "number") return undefined;
  return { since: held.since, times: held.times, count: held.count, kept: true };
}

/** 手机上的二狗 App 最近一次交来东西的时刻（四个数据源里设备交来的同步记录最晚的那一条；没有是 undefined） */
export function lastPhonePush(store: Pick<EventStore, "read">): string | undefined {
  let last: string | undefined;
  for (const { synced } of dataSourceRecords(store)) {
    if (synced?.trigger === "device" && PHONE_SOURCES.includes(synced.source) && (last === undefined || Date.parse(synced.at) > Date.parse(last))) last = synced.at;
  }
  return last;
}

/** 手机 App 那一项：linked 是手机日历、相册、位置连着哪一样；lastPushAt 是最近一次交来的时刻 */
export function appFinding(input: { linked: boolean; lastPushAt?: string }, now: number): DoctorFinding {
  if (!input.linked) return { level: "na", fact: { key: "phone.doctor.app.notLinked" } };
  if (input.lastPushAt === undefined) return { level: "na", fact: { key: "phone.doctor.app.never" } };
  const quiet = now - Date.parse(input.lastPushAt);
  const time = doctorTime(input.lastPushAt);
  if (quiet > PHONE_APP_QUIET_MS) {
    return { level: "warn", fact: { key: "phone.doctor.app.quiet", params: { count: Math.floor(quiet / DAY_MS), time } }, fix: { key: "phone.doctor.app.fixQuiet" }, since: input.lastPushAt };
  }
  return { level: "ok", fact: { key: "phone.doctor.app.ok", params: { time } } };
}

/** 手机日历交来 0 条那一项：linked 是手机日历连着（出错也算连过）；empty 是这一段（没有是 undefined） */
export function calendarEmptyFinding(input: { linked: boolean; empty?: PhoneCalendarEmpty }): DoctorFinding {
  if (!input.linked) return { level: "na", fact: { key: "phone.doctor.calendarEmpty.notLinked" } };
  const empty = input.empty;
  if (!empty) return { level: "ok", fact: { key: "phone.doctor.calendarEmpty.ok" } };
  const params = { times: empty.times, count: empty.count, time: doctorTime(empty.since) };
  return {
    level: "warn",
    fact: { key: empty.kept ? "phone.doctor.calendarEmpty.kept" : "phone.doctor.calendarEmpty.dropped", params },
    fix: { key: empty.kept ? "phone.doctor.calendarEmpty.fixKept" : "phone.doctor.calendarEmpty.fixDropped" },
    since: empty.since,
    action: { kind: "open", route: `#/more/data-sources/${PHONE_CALENDAR_SOURCE}` },
  };
}

/** 连过（连着、出错都算；没连不算） */
const linked = (status: { connection: string }) => status.connection !== "not_connected";

/** 手机插件登记的两项（service 是插件的服务，store 读同步记录和 425 的事件，now 是毫秒时间） */
export function phoneDoctorChecks(options: { store: Pick<EventStore, "read">; service: Pick<PhoneService, "calendarStatus" | "photosStatus" | "locationStatus" | "calendarEmpty">; now: () => number }): DoctorCheck[] {
  const { store, service } = options;
  return [
    {
      id: "app",
      title: "phone.doctor.app.title",
      cost: "passive",
      run: () => {
        const any = [service.calendarStatus(), service.photosStatus(), service.locationStatus()].some(linked);
        const lastPushAt = lastPhonePush(store);
        return appFinding({ linked: any, ...(lastPushAt === undefined ? {} : { lastPushAt }) }, options.now());
      },
    },
    {
      id: "calendar-empty",
      title: "phone.doctor.calendarEmpty.title",
      cost: "passive",
      run: () => {
        const empty = heldCalendar(store) ?? service.calendarEmpty();
        return calendarEmptyFinding({ linked: linked(service.calendarStatus()), ...(empty === undefined ? {} : { empty }) });
      },
    },
  ];
}
