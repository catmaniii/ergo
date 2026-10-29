// 手机插件的网页这一半（299 号票）：
// - 原生桥上读本机这一组方法（native-phone.ts）：四个都在才有 NativeApp.phone；App 回的挑人结果、授权状态、日程一律核对、截到上限，
//   时间（毫秒）换成协议时间，不对的当失败；
// - 同步一次手机日历（calendar-sync.ts，假的原生桥和 HTTP）：连上时先要授权、给了带 link 交过去、没给不交；平常先问守护进程连没连着，
//   授权撤回了交一次状况（已经写着出错的不再交）；
// - 数据源页上的两块（纯渲染）：不在 App 里写明要到 App 里；在 App 里的按钮、挑完的那一句和"去核对"；
// - 后台同步：开场一次、回到前台距上次超过 5 分钟再一次。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { detectNativeApp } from "../../src/app/native-app.ts";
import { type NativeCalendarState, type NativePhone, parseCalendarRead, parseCalendarState, parseContactsPick, wrapNativePhone } from "../../src/app/native-phone.ts";
import { type PhoneCalendarSyncDeps, syncPhoneCalendar } from "../../src/plugins/phone/calendar-sync.ts";
import { CalendarPanelView, calendarOutcomeText, ContactsPanelView, contactsNote, startCalendarSync } from "../../src/plugins/phone/PhonePanels.tsx";
import { type DataSourcePushResult, type DataSourcesView, type DataSourceView, nowIso, PHONE_CALENDAR_SOURCE, type PhoneCalendarPush } from "../../src/state/index.ts";

vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

describe("原生桥上读本机这一组方法", () => {
  test("四个都在才有 NativeApp.phone；少一个是旧版 App", () => {
    const methods = { appVersion: () => "0.2.1", phoneContactsPick: () => Promise.resolve(""), phoneCalendarState: () => "", phoneCalendarPrepare: () => Promise.resolve(""), phoneCalendarRead: () => Promise.resolve("") };
    expect(detectNativeApp({ ergoNative: methods })?.phone).toBeDefined();
    const { phoneCalendarRead: _gone, ...old } = methods;
    expect(detectNativeApp({ ergoNative: old })?.phone).toBeUndefined();
    expect(wrapNativePhone(old)).toBeUndefined();
  });

  test("挑人：核对、去空白、截到上限；取消、出错、形状不对", () => {
    const long = "号".repeat(80);
    expect(parseContactsPick(JSON.stringify({ ok: true, device: "HUAWEI Pura 90", contacts: [{ name: " 王小明 ", phones: ["138 0000 1111", 5, ""], birthday: "1990-03-02", addresses: ["某某路 1 号"] }, { name: "" }, { name: long, phones: [], addresses: [] }] }))).toEqual({
      ok: true,
      device: "HUAWEI Pura 90",
      contacts: [
        { name: "王小明", phones: ["138 0000 1111"], birthday: "1990-03-02", addresses: ["某某路 1 号"] },
        { name: "号".repeat(60), phones: [], addresses: [] },
      ],
    });
    expect(parseContactsPick(JSON.stringify({ ok: false, reason: "cancelled" }))).toEqual({ ok: false, reason: "cancelled" });
    expect(parseContactsPick(JSON.stringify({ ok: true, contacts: [] }))).toEqual({ ok: false, reason: "cancelled" });
    expect(parseContactsPick(JSON.stringify({ ok: false, reason: "boom", message: "选人界面打不开" }))).toEqual({ ok: false, reason: "failed", message: "选人界面打不开" });
    expect(parseContactsPick("not json")).toEqual({ ok: false, reason: "failed" });
  });

  test("授权状态、读日程：毫秒换成协议时间，没 key、没开始的跳过；读不了的带原因", () => {
    expect(parseCalendarState(JSON.stringify({ granted: true, asked: true, device: "Pura 90" }))).toEqual({ granted: true, asked: true, device: "Pura 90" });
    expect(parseCalendarState(JSON.stringify({ granted: "yes" }))).toBeUndefined();
    const start = new Date(2026, 9, 10, 9).getTime();
    expect(parseCalendarRead(JSON.stringify({ ok: true, events: [{ key: "1@1", title: "看牙医", start, end: start + 3_600_000, allDay: false, location: "某某口腔", calendar: "我的日历" }, { title: "没 key", start }, { key: "x", start: "bad" }] }))).toEqual({
      ok: true,
      events: [{ key: "1@1", title: "看牙医", start: nowIso(new Date(start)), end: nowIso(new Date(start + 3_600_000)), allDay: false, location: "某某口腔", calendar: "我的日历" }],
    });
    expect(parseCalendarRead(JSON.stringify({ ok: false, state: "denied" }))).toEqual({ ok: false, state: "denied" });
    expect(parseCalendarRead("")).toEqual({ ok: false, state: "unavailable" });
  });
});

/** 假的原生桥：授权状态可改，要授权时变成给了（或者还是不给） */
function fakePhone(state: NativeCalendarState, options: { grantOnAsk?: boolean; read?: Awaited<ReturnType<NativePhone["readCalendar"]>> } = {}) {
  const calls: string[] = [];
  let current = state;
  const phone: NativePhone = {
    pickContacts: () => Promise.resolve({ ok: false, reason: "cancelled" }),
    calendarState: () => current,
    prepareCalendar: (userAction) => {
      calls.push(`prepare:${userAction}`);
      if (options.grantOnAsk) current = { ...current, granted: true, asked: true };
      return Promise.resolve(current);
    },
    readCalendar: () => {
      calls.push("read");
      return Promise.resolve(options.read ?? { ok: true, events: [{ key: "1@1", title: "看牙医", start: "2026-10-10T09:00:00.000+08:00", allDay: false }] });
    },
  };
  return { phone, calls };
}

/** 假的 HTTP：数据源页里"手机 · 日历"的样子，交过去的记下来 */
function fakeHttp(source: Partial<DataSourceView> | undefined) {
  const pushed: PhoneCalendarPush[] = [];
  const view = { sources: source ? [{ id: PHONE_CALENDAR_SOURCE, available: true, connection: "connected", usages: [{ usage: "import", on: true }], ...source }] : [], folder: {} } as unknown as DataSourcesView;
  const http: PhoneCalendarSyncDeps["http"] = {
    dataSources: () => Promise.resolve(view),
    dataSourcePush: (_id, body) => {
      pushed.push(body.data);
      return Promise.resolve({ view, added: 1, summary: "1 条日程（新 1、改 0、删 0）" } satisfies DataSourcePushResult);
    },
  };
  return { http, pushed };
}

const deps = (phone: NativePhone, http: PhoneCalendarSyncDeps["http"]): PhoneCalendarSyncDeps => ({ phone, http, now: () => new Date(2026, 9, 25, 12), newKey: () => "k" });

describe("同步一次手机日历", () => {
  test("连上：没给授权先弹授权框，给了带 link 交过去（范围是上个月一号到往后半年多）；还是不给就不交", async () => {
    const granted = fakePhone({ granted: false, asked: false, device: "Pura 90" }, { grantOnAsk: true });
    const a = fakeHttp(undefined);
    const outcome = await syncPhoneCalendar(deps(granted.phone, a.http), { link: true });
    expect(outcome).toMatchObject({ kind: "pushed", state: "granted" });
    expect(granted.calls).toEqual(["prepare:true", "read"]);
    expect(a.pushed[0]).toMatchObject({ device: "Pura 90", state: "granted", link: true, from: nowIso(new Date(2026, 8, 1)), to: nowIso(new Date(2027, 4, 1)), events: [{ key: "1@1" }] });
    expect(calendarOutcomeText(outcome)).toEqual({ text: "1 条日程（新 1、改 0、删 0）" });

    const refused = fakePhone({ granted: false, asked: true });
    const b = fakeHttp(undefined);
    const denied = await syncPhoneCalendar(deps(refused.phone, b.http), { link: true });
    expect(denied).toEqual({ kind: "denied" });
    expect(b.pushed).toEqual([]);
    expect(calendarOutcomeText(denied).error).toBe(true);
  });

  test("平常：没连着、插件没启用、导入关着都不做；连着、授权给着就读了交；授权撤回了交一次状况，已经写着出错的不再交", async () => {
    const ok = fakePhone({ granted: true, asked: true });
    expect(await syncPhoneCalendar(deps(ok.phone, fakeHttp({ connection: "not_connected" }).http))).toEqual({ kind: "skipped", why: "not_linked" });
    expect(await syncPhoneCalendar(deps(ok.phone, fakeHttp({ available: false }).http))).toEqual({ kind: "skipped", why: "plugin_off" });
    expect(await syncPhoneCalendar(deps(ok.phone, fakeHttp({ usages: [{ usage: "import", on: false }] }).http))).toEqual({ kind: "skipped", why: "import_off" });
    expect(ok.calls).toEqual([]);

    const linked = fakeHttp({});
    expect(await syncPhoneCalendar(deps(ok.phone, linked.http))).toMatchObject({ kind: "pushed", state: "granted" });
    expect(linked.pushed[0]).not.toHaveProperty("link");

    const gone = fakePhone({ granted: false, asked: true });
    const revoked = fakeHttp({});
    expect(await syncPhoneCalendar(deps(gone.phone, revoked.http))).toMatchObject({ kind: "pushed", state: "revoked" });
    expect(revoked.pushed).toEqual([{ state: "revoked", reason: "手机的设置里关掉了" }]);
    expect(gone.calls).toEqual([]);
    const reported = fakeHttp({ connection: "error" });
    expect(await syncPhoneCalendar(deps(gone.phone, reported.http))).toEqual({ kind: "skipped", why: "already_reported" });
    expect(reported.pushed).toEqual([]);
  });

  test("306：连着但授权没给着，点\"现在同步\"也再要一次（拒过、撤回了的拉起二次授权）——给了照常读、交，回到连着；还是不给照原来交撤回，已经写着出错的说还是没给；后台同步不弹框", async () => {
    // 给了：读、交（守护进程那边原来写着出错）
    const back = fakePhone({ granted: false, asked: true }, { grantOnAsk: true });
    const errored = fakeHttp({ connection: "error" });
    expect(await syncPhoneCalendar(deps(back.phone, errored.http), { userAction: true })).toMatchObject({ kind: "pushed", state: "granted" });
    expect(back.calls).toEqual(["prepare:true", "read"]);
    expect(errored.pushed[0]).toMatchObject({ state: "granted", events: [{ key: "1@1" }] });
    expect(errored.pushed[0]).not.toHaveProperty("link");

    // 还是不给：守护进程那边还没写着出错的，照原来交撤回和原因
    const still = fakePhone({ granted: false, asked: true });
    const fresh = fakeHttp({});
    expect(await syncPhoneCalendar(deps(still.phone, fresh.http), { userAction: true })).toMatchObject({ kind: "pushed", state: "revoked" });
    expect(fresh.pushed).toEqual([{ state: "revoked", reason: "手机的设置里关掉了" }]);
    expect(still.calls).toEqual(["prepare:true"]);
    // 已经写着出错的：不再交，说还是没给（点「现在同步」再允许、或者去手机设置里开）
    const reported = fakeHttp({ connection: "error" });
    const again = await syncPhoneCalendar(deps(still.phone, reported.http), { userAction: true });
    expect(again).toEqual({ kind: "denied", again: true });
    expect(reported.pushed).toEqual([]);
    expect(calendarOutcomeText(again)).toEqual({ text: expect.stringContaining("还是没给读日历的授权，没同步成。可以再点一次「现在同步」"), error: true });

    // 后台同步（没有 userAction）：不弹框
    const quiet = fakePhone({ granted: false, asked: true }, { grantOnAsk: true });
    expect(await syncPhoneCalendar(deps(quiet.phone, fakeHttp({ connection: "error" }).http))).toEqual({ kind: "skipped", why: "already_reported" });
    expect(quiet.calls).toEqual([]);
  });
});

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const noop = () => {};

describe("数据源页上的两块", () => {

  test("通讯录选人：不在 App 里写明要到 App 里；在 App 里一个按钮、说明不读整个通讯录；交过去之后说是谁、有卡的带去核对", () => {
    expect(html(createElement(ContactsPanelView, { inApp: false, busy: false, note: undefined, onPick: noop }))).toContain("在手机上的二狗 App 里打开这一页");
    const inApp = html(createElement(ContactsPanelView, { inApp: true, busy: false, note: contactsNote({ names: ["王小明", "妈妈"], cardId: "c-1" }, []), onPick: noop }));
    expect(inApp).toContain("从手机通讯录挑人");
    expect(inApp).toContain("不读整个通讯录");
    expect(inApp).toContain("交给档案候选了：王小明和妈妈。");
    expect(inApp).toContain('href="#/card/c-1"');
    expect(contactsNote({ names: ["王小明"] }, [])).toEqual({ text: "王小明的电话、生日、地址和档案里一样，没有要核对的。" });
    expect(inApp).not.toMatch(/秘书|待我处理/);
  });

  test("手机日历：不在 App 里写明；没连着是连上、连着是现在同步，写手机上的授权", () => {
    expect(html(createElement(CalendarPanelView, { inApp: false, linked: false, state: undefined, busy: false, note: undefined, onLink: noop, onSync: noop }))).toContain("在手机上的二狗 App 里打开这一页连上手机日历");
    const notLinked = html(createElement(CalendarPanelView, { inApp: true, linked: false, state: { granted: false, asked: false }, busy: false, note: undefined, onLink: noop, onSync: noop }));
    expect(notLinked).toContain("连上手机日历");
    expect(notLinked).toContain("这台手机上：还没问过要不要允许");
    const linked = html(createElement(CalendarPanelView, { inApp: true, linked: true, state: { granted: true, asked: true }, busy: false, note: { text: "同步好了" }, onLink: noop, onSync: noop }));
    expect(linked).toContain("现在同步");
    expect(linked).toContain("这台手机上：允许二狗读日历");
    expect(linked).toContain("同步好了");
    expect(linked).not.toMatch(/秘书|待我处理/);
  });
});

describe("后台同步手机日历", () => {
  test("开场同步一次；回到前台距上次超过 5 分钟再一次，不到 5 分钟不同步；停下后不再听", async () => {
    vi.useFakeTimers();
    try {
      const { phone } = fakePhone({ granted: true, asked: true });
      const { http, pushed } = fakeHttp({});
      let now = new Date(2026, 9, 25, 12).getTime();
      const listeners = new Map<string, () => void>();
      const scope = { visibilityState: "visible", addEventListener: (type: string, fn: () => void) => listeners.set(type, fn), removeEventListener: (type: string) => listeners.delete(type) };
      const stop = startCalendarSync(phone, { http, now: () => new Date(now), newKey: () => "k" }, scope as never, () => {});
      await vi.advanceTimersByTimeAsync(0);
      expect(pushed).toHaveLength(1);
      now += 60_000;
      listeners.get("visibilitychange")!();
      await vi.advanceTimersByTimeAsync(0);
      expect(pushed).toHaveLength(1);
      now += 5 * 60_000;
      listeners.get("visibilitychange")!();
      await vi.advanceTimersByTimeAsync(0);
      expect(pushed).toHaveLength(2);
      stop();
      expect(listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
