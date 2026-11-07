// "手机"插件的体检项（414，src/phone/doctor.ts）：
// - 手机 App（app）：日历、相册、位置都没连不适用；最近一次交来东西超过 3 天是注意（"手机 App 很久没打开"，从那时起），别的正常；
//   设备交来的同步记录看四个数据源里最晚的一条；
// - 手机日历交来 0 条（calendar-empty）：日历没连不适用；交来 0 条、一下删了不少于 20 条是注意（跟着删了），手机又交来日程就过去了；
//   425 记下的 phone_calendar_held（先留着没删）有就用它（写"先留着、没删"）；只删了几条的不算；
// - 授权被撤回由二狗替数据源生成的那一项报坏了，手机插件不另报。
// 假内核；插件登记的检查按插件自己的时钟算，要"几天后"就拨假内核的时钟。
import { PHONE_CALENDAR_SOURCE, PHONE_PHOTOS_SOURCE, type PhoneCalendarEvent } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import type { CandidateInput } from "../../src/personal-files/index.ts";
import { appFinding, calendarEmptyFinding, PHONE_APP_QUIET_MS, PHONE_CALENDAR_HELD_EVENT } from "../../src/phone/doctor.ts";
import { PHONE_CHANNEL } from "../../src/phone/events.ts";
import { PHONE_CALENDAR_DROP_MIN } from "../../src/phone/phone.ts";
import { phonePlugin } from "../../src/phone/plugin.ts";
import { KERNEL } from "../../src/plugins/kernel.ts";
import { blockOf, itemOf, kernelDoctor } from "../helpers/plugin-doctor.ts";
import { extraService, type PluginKernel, startPluginKernel } from "../helpers/plugin-kernel.ts";

const DAY = 86_400_000;
const AT = new Date("2026-11-07T10:00:00+08:00");

let seq = 0;
const key = () => `pd-${++seq}`;

async function start() {
  const files = {
    people: () => [],
    background: () => "",
    withheld: () => [],
    onFieldReplaced: () => () => {},
    replacedValues: () => [],
    addCandidates: (_origin: string, inputs: readonly CandidateInput[]) => inputs.length,
    composeCandidates: () => "card-1",
  };
  return startPluginKernel({ plugins: [phonePlugin], at: AT, services: [extraService(KERNEL.personalFiles, () => files), extraService(KERNEL.layout, ({ dir }) => dataDirLayout(dir))] });
}

const pushTo = (k: PluginKernel, id: string, data: unknown) => k.dataSources.push(id, { data, idempotencyKey: key() });
const WINDOW = { from: new Date(2026, 9, 1).toISOString(), to: new Date(2027, 4, 1).toISOString() };
const events = (n: number): PhoneCalendarEvent[] => Array.from({ length: n }, (_, i) => ({ key: `e${i}`, title: `日程 ${i}`, start: new Date(2026, 10, 1 + (i % 28), 9).toISOString(), allDay: false }));

describe("手机 App 那一项（判法）", () => {
  it("没连：不适用；超过 3 天没交来：注意，写几天前、从那时起；3 天以内正常", () => {
    const now = Date.parse("2026-11-07T10:00:00+08:00");
    expect(appFinding({ linked: false }, now)).toEqual({ level: "na", fact: { key: "phone.doctor.app.notLinked" } });
    expect(appFinding({ linked: true }, now)).toMatchObject({ level: "na" });
    const old = new Date(now - PHONE_APP_QUIET_MS - DAY).toISOString();
    expect(appFinding({ linked: true, lastPushAt: old }, now)).toMatchObject({ level: "warn", fact: { key: "phone.doctor.app.quiet", params: { count: 4 } }, fix: { key: "phone.doctor.app.fixQuiet" }, since: old });
    expect(appFinding({ linked: true, lastPushAt: new Date(now - 2 * DAY).toISOString() }, now)).toMatchObject({ level: "ok", fact: { key: "phone.doctor.app.ok" } });
  });
});

describe("手机日历交来 0 条那一项（判法）", () => {
  it("日历没连：不适用；没有这一段：正常；跟着删了 / 先留着：注意，各一句，动作跳到手机日历", () => {
    expect(calendarEmptyFinding({ linked: false })).toMatchObject({ level: "na" });
    expect(calendarEmptyFinding({ linked: true })).toEqual({ level: "ok", fact: { key: "phone.doctor.calendarEmpty.ok" } });
    const since = "2026-11-06T21:05:00+08:00";
    expect(calendarEmptyFinding({ linked: true, empty: { since, times: 2, count: 773, kept: false } })).toMatchObject({
      level: "warn",
      fact: { key: "phone.doctor.calendarEmpty.dropped", params: { times: 2, count: 773 } },
      fix: { key: "phone.doctor.calendarEmpty.fixDropped" },
      since,
      action: { kind: "open", route: `#/more/data-sources/${PHONE_CALENDAR_SOURCE}` },
    });
    expect(calendarEmptyFinding({ linked: true, empty: { since, times: 3, count: 773, kept: true } })).toMatchObject({ fact: { key: "phone.doctor.calendarEmpty.kept" }, fix: { key: "phone.doctor.calendarEmpty.fixKept" } });
  });
});

describe("体检页上的手机一块", () => {
  it("连上日历：App 那一项按最近一次交来的算（4 天后注意）；交来 0 条删了不少：注意，又交来日程就过去了；只删几条的不算", async () => {
    const k = await start();
    expect(k.doctorChecks.list().map((c) => `${c.plugin}:${c.id}`)).toEqual(["phone:app", "phone:calendar-empty"]);
    const before = await kernelDoctor(k).view();
    expect(itemOf(before, "phone", "app")).toMatchObject({ level: "na" });
    expect(itemOf(before, "phone", "calendar-empty")).toMatchObject({ level: "na" });

    await pushTo(k, PHONE_CALENDAR_SOURCE, { device: "Pura 90", state: "granted", link: true, ...WINDOW, events: events(30) });
    const fresh = await kernelDoctor(k).view();
    expect(itemOf(fresh, "phone", "app")).toMatchObject({ level: "ok" });
    expect(itemOf(fresh, "phone", "calendar-empty")).toMatchObject({ level: "ok" });
    // 插件登记的检查按插件自己的时钟算：拨假内核的时钟（手机插件没有定时的事）
    k.clock.advanceTo(AT.getTime() + 4 * DAY);
    const quiet = await kernelDoctor(k).view();
    expect(itemOf(quiet, "phone", "app")).toMatchObject({ level: "warn" });
    expect(itemOf(quiet, "phone", "app")!.text.fact).toContain("手机 App 很久没打开了：最近一次交来东西是 4 天前");

    // 交来 0 条：30 条全删了（没有 425 的时候）
    await pushTo(k, PHONE_CALENDAR_SOURCE, { device: "Pura 90", state: "granted", ...WINDOW, events: [] });
    await pushTo(k, PHONE_CALENDAR_SOURCE, { device: "Pura 90", state: "granted", ...WINDOW, events: [] });
    const empty = await kernelDoctor(k).view();
    expect(itemOf(empty, "phone", "calendar-empty")).toMatchObject({ level: "warn", fact: { key: "phone.doctor.calendarEmpty.dropped", params: { times: 2, count: 30 } } });
    expect(itemOf(empty, "phone", "calendar-empty")!.text.fact).toContain("原来的 30 条跟着删了");

    // 又交来了：过去了
    await pushTo(k, PHONE_CALENDAR_SOURCE, { device: "Pura 90", state: "granted", ...WINDOW, events: events(3) });
    expect(itemOf(await kernelDoctor(k).view(), "phone", "calendar-empty")).toMatchObject({ level: "ok" });
    // 只有几条、删光了：不算（门槛 20）
    expect(PHONE_CALENDAR_DROP_MIN).toBe(20);
    await pushTo(k, PHONE_CALENDAR_SOURCE, { device: "Pura 90", state: "granted", ...WINDOW, events: [] });
    expect(itemOf(await kernelDoctor(k).view(), "phone", "calendar-empty")).toMatchObject({ level: "ok" });
  });

  it("425 记下的 phone_calendar_held 有就用它（先留着、没删）；这一段过去了（不带 held）就正常", async () => {
    const k = await start();
    await pushTo(k, PHONE_CALENDAR_SOURCE, { device: "Pura 90", state: "granted", link: true, ...WINDOW, events: events(3) });
    const since = "2026-11-06T21:05:00+08:00";
    k.store.append({ channel: PHONE_CHANNEL, type: PHONE_CALENDAR_HELD_EVENT, payload: { at: since, held: { since, times: 3, count: 773, from: WINDOW.from, to: WINDOW.to } } });
    const held = await kernelDoctor(k).view();
    expect(itemOf(held, "phone", "calendar-empty")).toMatchObject({ level: "warn", fact: { key: "phone.doctor.calendarEmpty.kept", params: { times: 3, count: 773 } }, since });
    expect(itemOf(held, "phone", "calendar-empty")!.text.fact).toContain("原来的 773 条先留着、没删");
    k.store.append({ channel: PHONE_CHANNEL, type: PHONE_CALENDAR_HELD_EVENT, payload: { at: "2026-11-07T09:00:00+08:00" } });
    expect(itemOf(await kernelDoctor(k).view(), "phone", "calendar-empty")).toMatchObject({ level: "ok" });
  });

  it("授权被撤回：数据源那一项坏了（二狗替它生成的），手机插件自己的两项不另报红；相册连着也算 App 那一项", async () => {
    const k = await start();
    await pushTo(k, PHONE_CALENDAR_SOURCE, { device: "Pura 90", state: "granted", link: true, ...WINDOW, events: events(3) });
    await pushTo(k, PHONE_CALENDAR_SOURCE, { state: "revoked", reason: "关掉了" });
    const view = await kernelDoctor(k).view();
    expect(blockOf(view, "phone")!.items.filter((i) => i.level === "error").map((i) => i.id)).toEqual([`source:${PHONE_CALENDAR_SOURCE}`]);
    expect(itemOf(view, "phone", "app")).toMatchObject({ level: "ok" });
    // 只连了相册：App 那一项照样看
    const other = await start();
    await pushTo(other, PHONE_PHOTOS_SOURCE, { state: "granted", link: true, location: false, ...WINDOW, photos: [] });
    expect(itemOf(await kernelDoctor(other).view(), "phone", "app")).toMatchObject({ level: "ok" });
  });
});
