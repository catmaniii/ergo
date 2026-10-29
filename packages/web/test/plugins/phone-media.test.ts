// 手机插件的照片、位置（300 号票）在网页这一侧：
// - 原生桥上照片、位置这两组方法（native-phone.ts）：各自都在才有 NativePhone.photos / location（旧一点的 App 只有前面四个）；
//   App 回的一律核对——毫秒换成协议时间、没读照片位置的授权时不带地点、经纬度不对或正好 (0, 0) 当没有地点、位置点按时间排；
// - 同步一次（media-sync.ts，假的原生桥和 HTTP）：连上时先要授权、给了带 link 交过去（照片读最近 7 天、上次同步更早时往前挪；
//   位置先让 App 开始记、交了以后让 App 删掉交过的）；平常没连着、导入关着时位置让 App 停下；撤回了交一次状况；交失败的不删；
// - 数据源页上的两块（纯渲染）：不在 App 里写明要到 App 里，耗电和隐私说明在不在 App 里都写；位置连着时有"App 在后台也记"；
// - 后台同步：开场先位置后照片各一次。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { detectNativeApp } from "../../src/app/native-app.ts";
import {
  type NativeLocationRead,
  type NativeLocationState,
  type NativePhoneLocation,
  type NativePhonePhotos,
  type NativePhotosRead,
  type NativePhotosState,
  parseLocationRead,
  parseLocationState,
  parsePhotosRead,
  parsePhotosState,
} from "../../src/app/native-phone.ts";
import { type PhoneMediaSyncDeps, syncPhoneLocation, syncPhonePhotos } from "../../src/plugins/phone/media-sync.ts";
import { LocationPanelView, locationStateText, mediaOutcomeText, PhotosPanelView, startMediaSync, stopIfDisconnected } from "../../src/plugins/phone/PhoneMediaPanels.tsx";
import { type DataSourcePushResult, type DataSourcesView, type DataSourceView, nowIso, PHONE_LOCATION_SOURCE, PHONE_PHOTOS_SOURCE, type PhoneLocationPush, type PhonePhotosPush } from "../../src/state/index.ts";

vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

const BASE = { appVersion: () => "0.2.1", phoneContactsPick: () => Promise.resolve(""), phoneCalendarState: () => "", phoneCalendarPrepare: () => Promise.resolve(""), phoneCalendarRead: () => Promise.resolve("") };
const PHOTOS = { phonePhotosState: () => "", phonePhotosPrepare: () => Promise.resolve(""), phonePhotosRead: () => Promise.resolve("") };
const LOCATION = { phoneLocationState: () => "", phoneLocationPrepare: () => Promise.resolve(""), phoneLocationRecord: () => Promise.resolve(""), phoneLocationRead: () => Promise.resolve(""), phoneLocationAck: () => "ok" };
const ms = (d: number, hh: number, mm = 0) => new Date(2026, 9, d, hh, mm).getTime();
/** 用不到的原生方法 */
const unused = () => Promise.reject(new Error("用不到"));

describe("原生桥上照片、位置这两组方法", () => {
  test("各自都在才有：旧一点的 App 只有前面四个时 phone 在、photos / location 没有；少一个方法也没有", () => {
    expect(detectNativeApp({ ergoNative: BASE })?.phone).toMatchObject({});
    expect(detectNativeApp({ ergoNative: BASE })?.phone?.photos).toBeUndefined();
    const full = detectNativeApp({ ergoNative: { ...BASE, ...PHOTOS, ...LOCATION } })?.phone;
    expect(full?.photos).toBeDefined();
    expect(full?.location).toBeDefined();
    const { phoneLocationAck: _gone, ...partial } = LOCATION;
    expect(detectNativeApp({ ergoNative: { ...BASE, ...PHOTOS, ...partial } })?.phone?.location).toBeUndefined();
  });

  test("读照片：毫秒换成协议时间；没 key、没时间的跳过；没读照片位置的授权时不带地点；经纬度不对、正好 (0, 0) 当没有地点", () => {
    const raw = { ok: true, location: true, photos: [{ key: "u1", takenAt: ms(25, 14, 5), lat: 30.259, lon: 120.13 }, { key: "u2", takenAt: ms(25, 15), lat: 0, lon: 0 }, { key: "u3", takenAt: ms(25, 16), lat: 95, lon: 120 }, { takenAt: ms(25, 17) }, { key: "u5", takenAt: "bad" }] };
    expect(parsePhotosRead(JSON.stringify(raw))).toEqual({
      ok: true,
      location: true,
      photos: [
        { key: "u1", takenAt: nowIso(new Date(ms(25, 14, 5))), lat: 30.259, lon: 120.13 },
        { key: "u2", takenAt: nowIso(new Date(ms(25, 15))) },
        { key: "u3", takenAt: nowIso(new Date(ms(25, 16))) },
      ],
    });
    expect(parsePhotosRead(JSON.stringify({ ...raw, location: false }))).toMatchObject({ location: false, photos: [{ key: "u1" }, { key: "u2" }, { key: "u3" }] });
    expect((parsePhotosRead(JSON.stringify({ ...raw, location: false })) as Extract<NativePhotosRead, { ok: true }>).photos[0]).not.toHaveProperty("lat");
    expect(parsePhotosRead(JSON.stringify({ ok: false, state: "denied", message: "没给" }))).toEqual({ ok: false, state: "denied", message: "没给" });
    expect(parsePhotosRead("")).toEqual({ ok: false, state: "unavailable" });
    expect(parsePhotosState(JSON.stringify({ granted: true, location: false, asked: true, device: "Pura 90" }))).toEqual({ granted: true, location: false, asked: true, device: "Pura 90" });
    expect(parsePhotosState(JSON.stringify({ granted: 1 }))).toBeUndefined();
  });

  test("读位置点：按时间排，时间、经纬度不对的跳过，精度不对的不写；状态核对", () => {
    expect(parseLocationRead(JSON.stringify({ ok: true, points: [{ at: ms(25, 9), lat: 30.28, lon: 120.1, accuracy: 40 }, { at: ms(25, 8), lat: 30.28, lon: 120.1, accuracy: -1 }, { at: ms(25, 10), lat: 200, lon: 1 }, { lat: 1, lon: 1 }] }))).toEqual({
      ok: true,
      points: [
        { at: nowIso(new Date(ms(25, 8))), lat: 30.28, lon: 120.1 },
        { at: nowIso(new Date(ms(25, 9))), lat: 30.28, lon: 120.1, accuracy: 40 },
      ],
    });
    expect(parseLocationState(JSON.stringify({ granted: true, precise: false, asked: true, recording: true, background: true }))).toEqual({ granted: true, precise: false, asked: true, recording: true, background: true });
    expect(parseLocationState("{}")).toBeUndefined();
  });
});

/** 假的读相册：授权可改、要授权时给了（或者还是不给）；记下读了哪段时间 */
function fakePhotos(state: NativePhotosState, options: { grantOnAsk?: boolean; read?: NativePhotosRead } = {}) {
  const calls: string[] = [];
  let current = state;
  const photos: NativePhonePhotos = {
    state: () => current,
    prepare: (userAction) => {
      calls.push(`prepare:${userAction}`);
      if (options.grantOnAsk) current = { ...current, granted: true, location: true, asked: true };
      return Promise.resolve(current);
    },
    read: (from, to) => {
      calls.push(`read:${nowIso(from)}~${nowIso(to)}`);
      return Promise.resolve(options.read ?? { ok: true, location: true, photos: [{ key: "u1", takenAt: nowIso(new Date(ms(25, 14))), lat: 30.26, lon: 120.13 }] });
    },
  };
  return { photos, calls };
}

/** 假的位置：授权、在不在记可改；记下开始停下、交过的删到哪 */
function fakeLocation(state: NativeLocationState, options: { grantOnAsk?: boolean; read?: NativeLocationRead } = {}) {
  const calls: string[] = [];
  let current = state;
  const location: NativePhoneLocation = {
    state: () => current,
    prepare: (userAction) => {
      calls.push(`prepare:${userAction}`);
      if (options.grantOnAsk) current = { ...current, granted: true, precise: true, asked: true };
      return Promise.resolve(current);
    },
    record: (on, background) => {
      calls.push(`record:${on}:${background}`);
      current = { ...current, recording: on, background: on && background };
      return Promise.resolve(current);
    },
    read: () => {
      calls.push("read");
      return Promise.resolve(options.read ?? { ok: true, points: [{ at: nowIso(new Date(ms(25, 9))), lat: 30.28, lon: 120.1 }, { at: nowIso(new Date(ms(25, 9, 5))), lat: 30.28, lon: 120.1 }] });
    },
    ack: (until) => calls.push(`ack:${nowIso(until)}`),
  };
  return { location, calls };
}

/** 假的 HTTP：数据源页里这个数据源的样子，交过去的记下来；error 给了就回出错 */
function fakeHttp(id: string, source: Partial<DataSourceView> | undefined, error?: string) {
  const pushed: Array<PhonePhotosPush | PhoneLocationPush> = [];
  const view = { sources: source ? [{ id, available: true, connection: "connected", usages: [{ usage: "import", on: true }], ...source }] : [], folder: {} } as unknown as DataSourcesView;
  const http: PhoneMediaSyncDeps["http"] = {
    dataSources: () => Promise.resolve(view),
    dataSourcePush: (_id, body) => {
      pushed.push(body.data);
      return Promise.resolve({ view, added: 1, summary: "交过去了", ...(error === undefined ? {} : { error }) } satisfies DataSourcePushResult);
    },
  };
  return { http, pushed };
}

const NOW = new Date(2026, 9, 26, 9);
const deps = (http: PhoneMediaSyncDeps["http"]): PhoneMediaSyncDeps => ({ http, now: () => NOW, newKey: () => "k" });

describe("照片同步一次", () => {
  test("连上：没给授权先弹授权框，给了带 link 交过去（最近 7 天到明天）；还是不给不交", async () => {
    const a = fakePhotos({ granted: false, location: false, asked: false, device: "Pura 90" }, { grantOnAsk: true });
    const http = fakeHttp(PHONE_PHOTOS_SOURCE, undefined);
    const outcome = await syncPhonePhotos({ ...deps(http.http), photos: a.photos }, { link: true });
    expect(outcome).toMatchObject({ kind: "pushed", state: "granted" });
    expect(a.calls).toEqual(["prepare:true", `read:${nowIso(new Date(ms(19, 9)))}~${nowIso(new Date(ms(27, 9)))}`]);
    expect(http.pushed[0]).toMatchObject({ device: "Pura 90", state: "granted", link: true, location: true, from: nowIso(new Date(ms(19, 9))), photos: [{ key: "u1" }] });
    const refused = fakePhotos({ granted: false, location: false, asked: true });
    const b = fakeHttp(PHONE_PHOTOS_SOURCE, undefined);
    expect(await syncPhonePhotos({ ...deps(b.http), photos: refused.photos }, { link: true })).toEqual({ kind: "denied" });
    expect(b.pushed).toEqual([]);
  });

  test("平常：没连着、导入关着不做；上次同步早于 7 天往前读到上次同步的前一天（最多 30 天）；撤回了交一次、写着出错的不再交", async () => {
    const ok = fakePhotos({ granted: true, location: true, asked: true });
    expect(await syncPhonePhotos({ ...deps(fakeHttp(PHONE_PHOTOS_SOURCE, { connection: "not_connected" }).http), photos: ok.photos })).toEqual({ kind: "skipped", why: "not_linked" });
    expect(await syncPhonePhotos({ ...deps(fakeHttp(PHONE_PHOTOS_SOURCE, { usages: [{ usage: "import", on: false }] }).http), photos: ok.photos })).toEqual({ kind: "skipped", why: "import_off" });
    expect(ok.calls).toEqual([]);
    await syncPhonePhotos({ ...deps(fakeHttp(PHONE_PHOTOS_SOURCE, { lastSync: { at: nowIso(new Date(ms(12, 9))), trigger: "device" } }).http), photos: ok.photos });
    await syncPhonePhotos({ ...deps(fakeHttp(PHONE_PHOTOS_SOURCE, { lastSync: { at: nowIso(new Date(2026, 6, 1)), trigger: "device" } }).http), photos: ok.photos });
    expect(ok.calls.map((c) => c.slice(5, 34))).toEqual([nowIso(new Date(ms(11, 9))), nowIso(new Date(2026, 8, 26, 9))]);
    const gone = fakePhotos({ granted: false, location: false, asked: true });
    const revoked = fakeHttp(PHONE_PHOTOS_SOURCE, {});
    expect(await syncPhonePhotos({ ...deps(revoked.http), photos: gone.photos })).toMatchObject({ kind: "pushed", state: "revoked" });
    expect(revoked.pushed).toEqual([{ state: "revoked", reason: "手机的设置里关掉了" }]);
    expect(await syncPhonePhotos({ ...deps(fakeHttp(PHONE_PHOTOS_SOURCE, { connection: "error" }).http), photos: gone.photos })).toEqual({ kind: "skipped", why: "already_reported" });
  });
});

describe("位置同步一次", () => {
  test("开始记位置：要授权、让 App 开始记（不在后台记）、交过去带 link，交好了让 App 删掉交过的", async () => {
    const a = fakeLocation({ granted: false, precise: false, asked: false, recording: false, background: false, device: "Pura 90" }, { grantOnAsk: true });
    const http = fakeHttp(PHONE_LOCATION_SOURCE, undefined);
    expect(await syncPhoneLocation({ ...deps(http.http), location: a.location }, { link: true, background: false })).toMatchObject({ kind: "pushed", state: "granted" });
    expect(a.calls).toEqual(["prepare:true", "record:true:false", "read", `ack:${nowIso(new Date(ms(25, 9, 5)))}`]);
    expect(http.pushed[0]).toMatchObject({ device: "Pura 90", state: "granted", link: true, background: false, points: [{ lat: 30.28 }, { lat: 30.28 }] });
  });

  test("平常：断开了、导入关了让 App 停下；改了后台也记重新开始；守护进程出错时不删；撤回了交一次", async () => {
    const recording = { granted: true, precise: true, asked: true, recording: true, background: false };
    const a = fakeLocation(recording);
    expect(await syncPhoneLocation({ ...deps(fakeHttp(PHONE_LOCATION_SOURCE, { connection: "not_connected" }).http), location: a.location })).toEqual({ kind: "skipped", why: "not_linked" });
    expect(a.calls).toEqual(["record:false:false"]);
    const b = fakeLocation(recording);
    expect(await syncPhoneLocation({ ...deps(fakeHttp(PHONE_LOCATION_SOURCE, { usages: [{ usage: "import", on: false }] }).http), location: b.location })).toEqual({ kind: "skipped", why: "import_off" });
    expect(b.calls).toEqual(["record:false:false"]);
    const c = fakeLocation(recording);
    const http = fakeHttp(PHONE_LOCATION_SOURCE, {});
    await syncPhoneLocation({ ...deps(http.http), location: c.location }, { background: true });
    expect(c.calls.slice(0, 2)).toEqual(["record:true:true", "read"]);
    expect(http.pushed[0]).toMatchObject({ background: true });
    expect(http.pushed[0]).not.toHaveProperty("link");
    const d = fakeLocation(recording);
    const failed = await syncPhoneLocation({ ...deps(fakeHttp(PHONE_LOCATION_SOURCE, {}, "出错了").http), location: d.location });
    expect(d.calls).toEqual(["read"]);
    expect(mediaOutcomeText("location", failed)).toEqual({ text: "没同步成：出错了", error: true });
    const gone = fakeLocation({ ...recording, granted: false });
    const revoked = fakeHttp(PHONE_LOCATION_SOURCE, {});
    expect(await syncPhoneLocation({ ...deps(revoked.http), location: gone.location })).toMatchObject({ kind: "pushed", state: "revoked" });
    expect(revoked.pushed).toEqual([{ state: "revoked", reason: "手机的设置里关掉了" }]);
  });

  test("304 号票在模拟器上碰到的：系统的位置开关关着——手机上写明记不到；没有要交的点时交一次原因，写着出错的不再交；有点照常交；开关打开后照常交", async () => {
    const off = { granted: true, precise: true, asked: true, recording: true, background: false, switchOff: true } as const;
    expect(parseLocationState(JSON.stringify(off))).toEqual(off);
    expect(locationStateText(off)).toBe("允许二狗定位（精确位置），要记，但手机的位置开关关着、记不到：在控制中心或设置里打开「位置」");
    const empty = { ok: true as const, points: [] };
    const a = fakeLocation(off, { read: empty });
    const http = fakeHttp(PHONE_LOCATION_SOURCE, {});
    expect(await syncPhoneLocation({ ...deps(http.http), location: a.location })).toMatchObject({ kind: "pushed", state: "unavailable" });
    expect(http.pushed).toEqual([{ state: "unavailable", reason: "手机的位置开关关着，记不到位置：在手机的控制中心或设置里打开「位置」" }]);
    const reported = fakeHttp(PHONE_LOCATION_SOURCE, { connection: "error" });
    expect(await syncPhoneLocation({ ...deps(reported.http), location: fakeLocation(off, { read: empty }).location })).toEqual({ kind: "skipped", why: "already_reported" });
    // 关之前记下的点照常交；开关打开了（守护进程那边写着出错）照常交，交过去守护进程回到连着
    const withPoints = fakeHttp(PHONE_LOCATION_SOURCE, {});
    await syncPhoneLocation({ ...deps(withPoints.http), location: fakeLocation(off).location });
    expect(withPoints.pushed[0]).toMatchObject({ state: "granted", points: [{ lat: 30.28 }, { lat: 30.28 }] });
    const back = fakeHttp(PHONE_LOCATION_SOURCE, { connection: "error" });
    await syncPhoneLocation({ ...deps(back.http), location: fakeLocation({ ...off, switchOff: undefined } as NativeLocationState, { read: empty }).location });
    expect(back.pushed).toEqual([{ state: "granted", background: false, points: [] }]);
    // 开始记位置（link）时开关关着：照样连上，手机上那一行写明
    const link = fakeHttp(PHONE_LOCATION_SOURCE, undefined);
    await syncPhoneLocation({ ...deps(link.http), location: fakeLocation(off, { read: empty }).location }, { link: true });
    expect(link.pushed).toEqual([{ state: "granted", link: true, background: false, points: [] }]);
  });

  test("304 号票在模拟器上看到的：在数据源页上断开了（没连），App 还在记的马上停下，不等下一次同步；连着的、没在记的不动", async () => {
    const recording = { granted: true, precise: true, asked: true, recording: true, background: true };
    const a = fakeLocation(recording);
    expect(await stopIfDisconnected(a.location, "not_connected")).toMatchObject({ recording: false, background: false });
    expect(a.calls).toEqual(["record:false:false"]);
    const b = fakeLocation(recording);
    expect(await stopIfDisconnected(b.location, "connected")).toEqual(recording);
    expect(await stopIfDisconnected(b.location, "error")).toEqual(recording);
    const c = fakeLocation({ ...recording, recording: false, background: false });
    await stopIfDisconnected(c.location, "not_connected");
    expect([...b.calls, ...c.calls]).toEqual([]);
  });
});

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const noop = () => {};

describe("数据源页上的照片、位置两块", () => {
  test("照片：不在 App 里写明要到 App 里，耗电和隐私都写；在 App 里没连着是连上相册、连着是现在同步，写手机上的授权", () => {
    const outside = html(createElement(PhotosPanelView, { inApp: false, linked: false, state: undefined, busy: false, note: undefined, onLink: noop, onSync: noop }));
    expect(outside).toContain("在手机上的二狗 App 里打开这一页连上相册");
    expect(outside).toContain("耗电：只在 App 开着时读一下相册里照片的时间和地点");
    expect(outside).toContain("隐私：照片本身不离开手机");
    expect(html(createElement(PhotosPanelView, { inApp: true, linked: false, state: { granted: false, location: false, asked: false }, busy: false, note: undefined, onLink: noop, onSync: noop }))).toContain(">连上相册<");
    const linked = html(createElement(PhotosPanelView, { inApp: true, linked: true, state: { granted: true, location: false, asked: true }, busy: false, note: { text: "读到 3 张" }, onLink: noop, onSync: noop }));
    expect(linked).toContain(">现在同步<");
    expect(linked).toContain("这台手机上：允许二狗读相册，但没允许读照片的位置（照片不带地点）");
    expect(linked).toContain("读到 3 张");
    expect(outside + linked).not.toMatch(/秘书|待我处理/);
  });

  test("位置：不在 App 里写明，耗电（App 开着时 5 分钟、后台要长时任务、通知栏常驻）和隐私都写；连着时有后台也记的开关，写授权和在不在记", () => {
    const outside = html(createElement(LocationPanelView, { inApp: false, linked: true, state: undefined, busy: false, note: undefined, onLink: noop, onSync: noop, onBackground: noop }));
    expect(outside).toContain("在手机上的二狗 App 里打开这一页开始记位置");
    expect(outside).toContain("每 5 分钟用低功耗定位");
    expect(outside).toContain("位置类长时任务在后台每 10 分钟记一次");
    expect(outside).toContain("整条算「位置」这类敏感内容");
    expect(outside).not.toContain("location-background");
    const state = { granted: true, precise: false, asked: true, recording: true, background: true };
    const linked = html(createElement(LocationPanelView, { inApp: true, linked: true, state, busy: false, note: undefined, onLink: noop, onSync: noop, onBackground: noop }));
    expect(linked).toContain('data-phone="location-background"');
    expect(linked).toContain("App 在后台也记");
    expect(linked).toContain("checked");
    expect(locationStateText(state)).toBe("允许二狗定位（只有大概位置），正在记（后台也记）");
    expect(html(createElement(LocationPanelView, { inApp: true, linked: false, state: { ...state, granted: false, recording: false }, busy: false, note: undefined, onLink: noop, onSync: noop, onBackground: noop }))).toContain(">开始记位置<");
    expect(outside + linked).not.toMatch(/秘书|待我处理/);
  });
});

describe("后台同步照片、位置", () => {
  test("开场先位置后照片各同步一次；停下后不再听", async () => {
    vi.useFakeTimers();
    try {
      const order: string[] = [];
      const photos = fakePhotos({ granted: true, location: true, asked: true });
      const location = fakeLocation({ granted: true, precise: true, asked: true, recording: true, background: false });
      const view = {
        sources: [PHONE_PHOTOS_SOURCE, PHONE_LOCATION_SOURCE].map((id) => ({ id, available: true, connection: "connected", usages: [{ usage: "import", on: true }] })),
        folder: {},
      } as unknown as DataSourcesView;
      const http: PhoneMediaSyncDeps["http"] = {
        dataSources: () => Promise.resolve(view),
        dataSourcePush: (id) => {
          order.push(id);
          return Promise.resolve({ view });
        },
      };
      const listeners = new Map<string, () => void>();
      const scope = { visibilityState: "visible", addEventListener: (type: string, fn: () => void) => listeners.set(type, fn), removeEventListener: (type: string) => listeners.delete(type) };
      const stop = startMediaSync({ pickContacts: unused, calendarState: () => undefined, prepareCalendar: unused, readCalendar: unused, photos: photos.photos, location: location.location }, { http, now: () => NOW, newKey: () => "k" }, scope as never, () => {});
      await vi.advanceTimersByTimeAsync(0);
      expect(order).toEqual([PHONE_LOCATION_SOURCE, PHONE_PHOTOS_SOURCE]);
      stop();
      expect(listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
