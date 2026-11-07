// Google 插件的体检项（414，src/google/doctor.ts）："每个日历地址"——
// - 这次开机后还没拉过日历：不适用；都拉得到（或者偶尔一两次一时拉不到）：正常；
// - 最近一次是地址失效、没权限（一直不行）：坏了，写哪个日历、连着几次、原因原文；一时拉不到连着 3 次以上：注意；
// - 每个日历都连着几次一直不行时数据源那一项已经是坏了：这里不适用（不重复报）；断开以后清掉；
// - Gmail 有账号的密码被撤：数据源那一项坏了（二狗替它生成的），Google 插件不另报。
// 假内核 + 注入的假 fetch（不连 Google）。
import { describe, expect, it } from "vitest";
import type { FeedTrouble } from "../../src/google/calendar-feeds.ts";
import { calendarFeedsFinding, FEED_FAILURES_WARN } from "../../src/google/doctor.ts";
import { createGooglePlugin } from "../../src/google/plugin.ts";
import { KERNEL } from "../../src/plugins/kernel.ts";
import { fakeCalendarFetch, googleAddress, icsOf, myCalendar } from "../helpers/fake-ical.ts";
import { fakePersonalFiles } from "../helpers/fake-personal-files.ts";
import { blockOf, itemOf, kernelDoctor } from "../helpers/plugin-doctor.ts";
import { extraService, type PluginKernel, startPluginKernel } from "../helpers/plugin-kernel.ts";

const SOURCE = "google-calendar";
const MINE = googleAddress("chenxiao@gmail.com");
const FAMILY = googleAddress("family123@group.calendar.google.com", "private-fedcba9876543210fedcba9876543210");

let seq = 0;
const key = () => `gd-${++seq}`;

async function start() {
  const remote = fakeCalendarFetch();
  remote.routes.set(MINE, { status: 200, body: myCalendar() });
  remote.routes.set(FAMILY, { status: 200, body: icsOf({ name: "家里", events: [] }) });
  const k = await startPluginKernel({
    plugins: [createGooglePlugin({ fetch: remote.fetch })],
    at: new Date("2026-11-07T09:00:00+08:00"),
    services: [extraService(KERNEL.personalFiles, () => fakePersonalFiles().service)],
  });
  return { k, remote };
}
const configure = (k: PluginKernel, values: Record<string, string>) => k.dataSources.act(SOURCE, { action: "configure", values, idempotencyKey: key() });
const sync = (k: PluginKernel) => k.dataSources.act(SOURCE, { action: "sync", idempotencyKey: key() });
const feeds = async (k: PluginKernel) => itemOf(await kernelDoctor(k).view(), "google", "calendar-feeds")!;

const trouble = (extra: Partial<FeedTrouble>): FeedTrouble => ({ id: "g1", name: "工作", problem: "拉日历超时（20 秒没拉完）", failures: 1, lasting: false, streak: 0, since: "2026-11-07T08:00:00+08:00", ...extra });

describe("每个日历地址（判法）", () => {
  it("还没拉过：不适用；都拉得到、一时拉不到不到 3 次：正常；一时拉不到 3 次：注意；地址失效、没权限：坏了（排在前面）", () => {
    expect(calendarFeedsFinding({ tried: 0, failing: [] })).toEqual({ level: "na", fact: { key: "google.doctor.feeds.notTried" } });
    expect(calendarFeedsFinding({ tried: 2, failing: [] })).toEqual({ level: "ok", fact: { key: "google.doctor.feeds.ok", params: { count: 2 } } });
    expect(FEED_FAILURES_WARN).toBe(3);
    expect(calendarFeedsFinding({ tried: 2, failing: [trouble({ failures: 2 })] }).level).toBe("ok");
    const shaky = calendarFeedsFinding({ tried: 2, failing: [trouble({ failures: 3 })] });
    expect(shaky).toMatchObject({ level: "warn", fix: { key: "google.doctor.feeds.fixTransient" }, since: "2026-11-07T08:00:00+08:00", action: { kind: "open", route: `#/more/data-sources/${SOURCE}` } });
    expect(shaky.fact.params!.feeds).toBe("「工作」连着 3 次没拉到：拉日历超时（20 秒没拉完）");
    const broken = calendarFeedsFinding({
      tried: 2,
      failing: [trouble({ failures: 3 }), trouble({ id: "g2", name: "家里", problem: "地址失效了（Google 回了 404）", failures: 1, lasting: true, streak: 1, since: "2026-11-07T08:30:00+08:00" })],
    });
    expect(broken).toMatchObject({ level: "error", fix: { key: "google.doctor.feeds.fixLasting" }, since: "2026-11-07T08:00:00+08:00" });
    expect(broken.fact.params!.feeds).toBe("「家里」连着 1 次没拉到：地址失效了（Google 回了 404）；「工作」连着 3 次没拉到：拉日历超时（20 秒没拉完）");
  });

  it("每个拉过的日历都连着 3 次一直不行：数据源那一项已经坏了，这里不适用", () => {
    const all = calendarFeedsFinding({ tried: 1, failing: [trouble({ lasting: true, streak: 3, failures: 3 })] });
    expect(all).toEqual({ level: "na", fact: { key: "google.doctor.feeds.allBroken" } });
    // 一个一直不行到 3 次、另一个还拉得到：照样报坏了
    expect(calendarFeedsFinding({ tried: 2, failing: [trouble({ lasting: true, streak: 3, failures: 3 })] }).level).toBe("error");
  });
});

describe("体检页上的 Google 一块", () => {
  it("开机还没拉过不适用；填好就正常；一个日历地址失效：坏了（数据源那一项是上次同步出错的注意）；拉到了就好；断开后不适用", async () => {
    const { k, remote } = await start();
    expect(k.doctorChecks.list().map((c) => `${c.plugin}:${c.id}`)).toEqual(["google:calendar-feeds"]);
    expect(await feeds(k)).toMatchObject({ level: "na" });
    await configure(k, { add: MINE, name: "工作" });
    await configure(k, { add: FAMILY, name: "家里" });
    expect(await feeds(k)).toMatchObject({ level: "ok", text: { fact: "2 个日历，最近没有一直拉不到的" } });

    remote.routes.set(MINE, { status: 404, body: "Not Found" });
    await sync(k);
    const view = await kernelDoctor(k).view();
    const item = itemOf(view, "google", "calendar-feeds")!;
    expect(item).toMatchObject({ level: "error", since: expect.any(String) });
    expect(item.text.fact).toBe("「工作」连着 1 次没拉到：地址失效了（Google 回了 404）：可能在 Google 日历里重置过私密地址，去 Google 日历的设置里重新复制「iCal 格式的私密地址」");
    expect(itemOf(view, "google", `source:${SOURCE}`)).toMatchObject({ level: "warn", fact: { key: "doctor.source.lastFailed" } });
    expect(blockOf(view, "google")!.level).toBe("error");

    remote.routes.set(MINE, { status: 200, body: myCalendar() });
    await sync(k);
    expect(await feeds(k)).toMatchObject({ level: "ok" });

    await k.dataSources.act(SOURCE, { action: "disconnect", purge: false, idempotencyKey: key() });
    expect(await feeds(k)).toMatchObject({ level: "na" });
  });

  it("一时拉不到（503）连着 3 次：注意；每个日历都连着 3 次地址失效：数据源那一项坏了，这里不另报", async () => {
    const { k, remote } = await start();
    await configure(k, { add: MINE, name: "工作" });
    remote.routes.set(MINE, { status: 503, body: "" });
    await sync(k);
    await sync(k);
    expect(await feeds(k)).toMatchObject({ level: "ok" });
    await sync(k);
    expect(await feeds(k)).toMatchObject({ level: "warn", fix: { key: "google.doctor.feeds.fixTransient" } });

    remote.routes.set(MINE, { status: 404, body: "Not Found" });
    for (let i = 0; i < 3; i += 1) await sync(k);
    const view = await kernelDoctor(k).view();
    expect(itemOf(view, "google", `source:${SOURCE}`)).toMatchObject({ level: "error" });
    expect(itemOf(view, "google", "calendar-feeds")).toMatchObject({ level: "na", fact: { key: "google.doctor.feeds.allBroken" } });
    expect(blockOf(view, "google")!.items.filter((i) => i.level === "error").map((i) => i.id)).toEqual([`source:${SOURCE}`]);
  });
});
