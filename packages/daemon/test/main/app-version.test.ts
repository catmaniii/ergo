// 主切面：手机 App 的版本。页面开在 App 里，连上后把版本报给守护进程，记在这台已配对设备上；低于最低版本出一条待办、马上告诉用户。
// 报同样的不重复，升级后报上来够新了自动撤掉，够新的不出，手机浏览器不报也不出。
import { appOutdatedItemId, type AppOutdatedNoticeData, CHANNELS, type DeviceEventPayload, EVENT_TYPES, type InboxItem, METHODS, MIN_APP_VERSION, type NotifyEventPayload, type PairedDevice } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { startTestDaemon } from "../helpers/daemon.ts";
import { pairDevice } from "../helpers/device.ts";
import { TestFrontend } from "../helpers/frontend.ts";

const { cards: CARDS, devices: DEVICES, inbox: INBOX } = CHANNELS;

/** 比最低版本旧一点的版本号 */
const OLD = "0.0.1";

async function setup() {
  const test = await startTestDaemon();
  const pc = await TestFrontend.connect(test.url);
  await pc.subscribe({ [CARDS]: 0, [INBOX]: 0, [DEVICES]: 0 });
  const phone = await pairDevice(test.externalUrl, pc, { name: "我的手机", realIp: "203.0.113.24" });
  const onPhone = await phone.connect();
  await onPhone.subscribe({ [INBOX]: 0, [DEVICES]: 0 });
  const device = () => test.daemon.pairing.list().find((d: PairedDevice) => d.name === "我的手机")!;
  const notices = () => test.daemon.inbox.list().filter((item: InboxItem) => item.kind === "notice" && item.notice === "app_outdated");
  const report = (version: string, platform?: "android" | "harmony") => onPhone.request(METHODS.reportAppVersion, { version, ...(platform ? { platform } : {}) });
  const notifies = (frontend: TestFrontend) => frontend.events({ channel: INBOX, type: EVENT_TYPES.notify }).map((f) => f.payload as NotifyEventPayload);
  return { ...test, pc, phone, onPhone, device, notices, report, notifies };
}

describe("手机 App 的版本", () => {
  it("旧版本报上来：记在设备上，出一条待办，马上告诉用户；待办和通知写明要升到哪一版", async () => {
    const { pc, onPhone, device, notices, report, notifies } = await setup();
    const answer = await report(OLD, "android");
    expect(answer).toMatchObject({ ok: true });

    expect(device()).toMatchObject({ appVersion: OLD, appPlatform: "android" });
    expect(pc.events({ channel: DEVICES, type: EVENT_TYPES.device }).map((f) => (f.payload as DeviceEventPayload).change)).toContain("app_version");

    const [item, ...rest] = notices();
    expect(rest).toEqual([]);
    expect(item).toMatchObject({
      id: appOutdatedItemId(device().id, MIN_APP_VERSION),
      kind: "notice",
      notice: "app_outdated",
      title: `二狗 App 需要升级到 ${MIN_APP_VERSION}`,
      urgency: "non_blocking",
      source: "设备配对",
      actions: ["去升级", "知道了"],
      data: { deviceId: device().id, deviceName: "我的手机", version: OLD, minVersion: MIN_APP_VERSION, platform: "android" } satisfies AppOutdatedNoticeData,
    });
    expect((item as { body?: string }).body).toContain("我的手机");
    expect((item as { body?: string }).body).toContain(OLD);

    // 手机和电脑开着的页面都收到临时的 notify：App 据此发系统通知，电脑上弹浏览器通知
    await onPhone.next(INBOX, EVENT_TYPES.notify);
    await pc.next(INBOX, EVENT_TYPES.notify);
    expect(notifies(onPhone)).toEqual([expect.objectContaining({ title: `二狗 App 需要升级到 ${MIN_APP_VERSION}`, itemId: item!.id })]);
  });

  it("报同样的：不重复，设备不落事件，也不再通知；重连后再报也一样", async () => {
    const { pc, onPhone, notices, report, notifies } = await setup();
    await report(OLD, "android");
    await onPhone.next(INBOX, EVENT_TYPES.notify);
    const devicesBefore = pc.events({ channel: DEVICES, type: EVENT_TYPES.device }).length;
    await report(OLD, "android");
    await report(OLD, "android");
    expect(notices()).toHaveLength(1);
    expect(notifies(onPhone)).toHaveLength(1);
    await onPhone.disconnect();
    await onPhone.reconnect([INBOX]);
    await report(OLD, "android");
    expect(notices()).toHaveLength(1);
    expect(notifies(onPhone)).toHaveLength(1);
    expect(pc.events({ channel: DEVICES, type: EVENT_TYPES.device }).length).toBe(devicesBefore);
  });

  it("升级后报上来够新了：设备上换成新版本，那条待办自动归档；之后再报不再出", async () => {
    const { device, notices, report } = await setup();
    await report(OLD, "harmony");
    expect(notices()[0]).toMatchObject({ archived: false });
    await report(MIN_APP_VERSION, "harmony");
    expect(device()).toMatchObject({ appVersion: MIN_APP_VERSION, appPlatform: "harmony" });
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({ archived: true, read: true });
    await report(MIN_APP_VERSION, "harmony");
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({ archived: true });
  });

  it("够新的：记下版本，不出待办、不通知", async () => {
    const { onPhone, device, notices, report, notifies } = await setup();
    await report("99.0.0", "android");
    expect(device()).toMatchObject({ appVersion: "99.0.0", appPlatform: "android" });
    expect(notices()).toEqual([]);
    expect(notifies(onPhone)).toEqual([]);
  });

  it("手机浏览器不报：设备上没有版本，不出待办", async () => {
    const { onPhone, device, notices, notifies } = await setup();
    expect(await onPhone.subscribe({ [CARDS]: 0 })).toMatchObject({ ok: true });
    expect(device().appVersion).toBeUndefined();
    expect(notices()).toEqual([]);
    expect(notifies(onPhone)).toEqual([]);
  });

  it("读不到版本的 App（报空串）算最旧：出待办，说读不到", async () => {
    const { device, notices, report } = await setup();
    await report("");
    expect(device().appVersion).toBe("");
    expect((notices()[0] as { body?: string }).body).toContain("读不到");
  });

  it("本机端口的连接没有设备：报了回 ok，不记、不出", async () => {
    const { pc, notices, device } = await setup();
    expect(await pc.request(METHODS.reportAppVersion, { version: OLD })).toMatchObject({ ok: true });
    expect(notices()).toEqual([]);
    expect(device().appVersion).toBeUndefined();
  });

  it("用户点了知道了、删了：同一个要求不再出", async () => {
    const { pc, onPhone, notices, report, notifies, daemon } = await setup();
    await report(OLD);
    const id = notices()[0]!.id;
    expect(await pc.inboxAction({ itemIds: [id], action: "delete" })).toMatchObject({ ok: true });
    await report("0.0.2");
    await report(OLD);
    expect(notices()).toEqual([]);
    expect(daemon.inbox.get(id)).toMatchObject({ deleted: true });
    await onPhone.next(INBOX, EVENT_TYPES.notify);
    expect(notifies(onPhone)).toHaveLength(1);
  });

  it("要求变高了：旧要求那条开着的撤掉，换新要求的一条", async () => {
    const { device, notices, report, daemon } = await setup();
    const older = appOutdatedItemId(device().id, "0.0.0");
    daemon.inbox.add({ id: older, kind: "notice", notice: "app_outdated", title: "旧要求", source: "设备配对", urgency: "non_blocking", actions: ["知道了"], data: { deviceId: device().id, deviceName: "我的手机", version: OLD, minVersion: "0.0.0" } satisfies AppOutdatedNoticeData });
    await report(OLD);
    expect(notices().map((i: InboxItem) => [i.id, i.archived])).toEqual([
      [older, true],
      [appOutdatedItemId(device().id, MIN_APP_VERSION), false],
    ]);
  });

  it("版本没变、要求降下来了（退回旧版的二狗）：开着的那条也撤掉", async () => {
    const { device, notices, report, daemon } = await setup();
    await report("99.0.0");
    daemon.inbox.add({ id: appOutdatedItemId(device().id, "100.0.0"), kind: "notice", notice: "app_outdated", title: "新版的要求", source: "设备配对", urgency: "non_blocking", actions: ["知道了"], data: { deviceId: device().id, deviceName: "我的手机", version: "99.0.0", minVersion: "100.0.0" } satisfies AppOutdatedNoticeData });
    await report("99.0.0");
    expect(notices()[0]).toMatchObject({ archived: true });
  });

  it("别的设备的那条不动", async () => {
    const { pc, device, notices, report, daemon, externalUrl } = await setup();
    const other = await pairDevice(externalUrl, pc, { name: "家里的平板", realIp: "198.51.100.7" });
    const onOther = await other.connect();
    await onOther.subscribe({ [INBOX]: 0 });
    await onOther.request(METHODS.reportAppVersion, { version: OLD });
    await report(OLD);
    await report("99.0.0");
    const mine = appOutdatedItemId(device().id, MIN_APP_VERSION);
    expect(daemon.inbox.get(mine)).toMatchObject({ archived: true });
    expect(notices().filter((i: InboxItem) => i.id !== mine)).toEqual([expect.objectContaining({ archived: false })]);
  });

  it("吊销这台设备：开着的那条跟着撤掉", async () => {
    const { pc, device, notices, report } = await setup();
    await report(OLD);
    expect(await pc.request(METHODS.revokeDevice, { deviceId: device().id }, "k-revoke")).toMatchObject({ ok: true });
    expect(notices()[0]).toMatchObject({ archived: true });
  });

  it("续期、延期不丢版本：设备后面的变化带着版本", async () => {
    const { pc, device, report } = await setup();
    await report("99.0.0", "android");
    expect(await pc.request(METHODS.deviceBatchAction, { action: "extend", deviceIds: [device().id], days: 30 }, "k-extend")).toMatchObject({ ok: true });
    expect(device()).toMatchObject({ appVersion: "99.0.0", appPlatform: "android", extendedAt: expect.any(String) });
  });
});
