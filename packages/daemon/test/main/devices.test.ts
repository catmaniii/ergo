// 主切面：已配对设备与吊销（规格第 6 节）。设置里列出已配对设备（前端订阅已配对设备频道），可以随时吊销：
// 吊销后它已经打开的 WebSocket 立即被服务端关闭，之后的请求被拒（回到配对页），其他设备不受影响。
// 前端状态层回放用的事件流 device-revoke（设置页看到的）和 device-revoked-here（被吊销的那台设备看到的）在这里录
// （packages/web/test/state/recorded.test.ts 回放）。
import { CHANNELS, type DeviceEventPayload, EVENT_TYPES, METHODS, type PairedDevice, WS_CLOSE_UNPAIRED } from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { startTestDaemon } from "../helpers/daemon.ts";
import { pairDevice } from "../helpers/device.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { saveOrCheckRecording } from "../helpers/recording.ts";

const { cards: CARDS, devices: DEVICES, inbox: INBOX } = CHANNELS;

const devicesOf = (frontend: TestFrontend): DeviceEventPayload[] => frontend.events({ channel: DEVICES, type: EVENT_TYPES.device }).map((f) => f.payload as DeviceEventPayload);

/** 守护进程、本机前端（批准配对用）、两台已配对设备（各开着一条 WebSocket），和一个只看"已配对设备"的设置页 */
async function setup() {
  const test = await startTestDaemon();
  const pc = await TestFrontend.connect(test.url);
  await pc.subscribe({ [CARDS]: 0, [INBOX]: 0 });
  const settings = await TestFrontend.connect(test.url);
  await settings.subscribe({ [DEVICES]: 0 });
  const phone = await pairDevice(test.externalUrl, pc, { name: "我的手机", realIp: "203.0.113.24" });
  const tablet = await pairDevice(test.externalUrl, pc, { name: "家里的平板", realIp: "198.51.100.7" });
  // 每台两条：领到凭证（paired），第一次带着凭证来（activated）
  for (let i = 0; i < 4; i++) await settings.next(DEVICES, EVENT_TYPES.device);
  const [phoneDevice, tabletDevice] = devicesOf(settings)
    .filter((d) => d.change === "activated")
    .map((d) => d.device) as [PairedDevice, PairedDevice];
  const onPhone = await phone.connect();
  await onPhone.subscribe({ [CARDS]: 0 });
  const onTablet = await tablet.connect();
  await onTablet.subscribe({ [CARDS]: 0 });
  return { ...test, pc, settings, phone, tablet, phoneDevice, tabletDevice, onPhone, onTablet };
}

describe("已配对设备", () => {
  it("设置里列出已配对设备：名字、来源、配对和最近使用的时间、凭证到期时间；凭证本身不在里面", async () => {
    const { settings, phone } = await setup();
    const listed = devicesOf(settings);
    expect(listed.map((d) => `${d.device.name}:${d.change}`)).toEqual(["我的手机:paired", "我的手机:activated", "家里的平板:paired", "家里的平板:activated"]);
    const shape = { id: expect.stringMatching(/^d-/), pairedAt: expect.any(String), lastUsedAt: expect.any(String), expiresAt: expect.any(String), revoked: false };
    expect(listed.filter((d) => d.change === "activated").map((d) => d.device)).toEqual([
      { ...shape, name: "我的手机", from: "经隧道 · 203.0.113.24", activated: true },
      { ...shape, name: "家里的平板", from: "经隧道 · 198.51.100.7", activated: true },
    ]);
    // 刚领到凭证时还没启用（设置里显示"等待首次使用"）
    expect(listed.filter((d) => d.change === "paired").map((d) => d.device.activated)).toEqual([false, false]);
    expect(JSON.stringify(settings.events())).not.toContain(phone.credential);
  });

  it("吊销一台：它开着的 WebSocket 立即被服务端关掉，之后的 HTTP 请求和握手都被拒；另一台不受影响", async () => {
    const { settings, phone, tablet, phoneDevice, onPhone, onTablet } = await setup();

    const revoked = await settings.request(METHODS.revokeDevice, { deviceId: phoneDevice.id }, "k-revoke-phone");
    expect(revoked).toMatchObject({ ok: true, result: { deviceId: phoneDevice.id } });
    expect(await onPhone.closed(2000)).toEqual({ code: WS_CLOSE_UNPAIRED, reason: "这台设备已被吊销" });
    // 页面那边断线后先问一下还被信任吗：带着被吊销的凭证问，得到原因（页面据此在浏览器里留"已被吊销"的记号），
    // 同时浏览器里的凭证被删掉
    const access = await phone.access();
    expect(access).toEqual({ access: "none", reason: "revoked" });
    onPhone.recordUnpaired(access);
    expect(phone.credential).toBeUndefined();
    // 刷新页面：凭证已经删了，服务端分不出它是被吊销的设备还是新设备（不自动重新申请靠的是页面留的记号）
    expect(await phone.access()).toEqual({ access: "none" });
    expect((await phone.request("/healthz")).status).toBe(401);
    await expect(phone.connect()).rejects.toThrow("HTTP 401");
    // 回到配对页
    expect((await phone.request("/")).status).toBe(200);

    // 另一台照常
    expect(onTablet.isOpen).toBe(true);
    expect(await onTablet.subscribe({ [DEVICES]: 0 })).toMatchObject({ ok: true });
    expect((await tablet.access()).access).toBe("device");

    // 设置页收到吊销事件
    const last = (await settings.next(DEVICES, EVENT_TYPES.device)).payload as DeviceEventPayload;
    expect(last).toMatchObject({ change: "revoked", device: { id: phoneDevice.id, revoked: true, revokedAt: expect.any(String) } });
    saveOrCheckRecording("device-revoke", settings.recording);
    saveOrCheckRecording("device-revoked-here", onPhone.recording);
  });

  it("同一个幂等键重发拿到同一个结果；已经吊销的再吊销得到\"已被处理\"；没有的设备得到 not_found", async () => {
    const { settings, phoneDevice } = await setup();
    const first = await settings.request(METHODS.revokeDevice, { deviceId: phoneDevice.id }, "k-1");
    expect(await settings.request(METHODS.revokeDevice, { deviceId: phoneDevice.id }, "k-1")).toEqual({ ...first, id: expect.any(String) });
    expect(await settings.request(METHODS.revokeDevice, { deviceId: phoneDevice.id }, "k-2")).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await settings.request(METHODS.revokeDevice, { deviceId: "d-nope" }, "k-3")).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await settings.request(METHODS.revokeDevice, { deviceId: phoneDevice.id })).toMatchObject({ ok: false, error: { code: "idempotency_key_required" } });
  });

  it("已配对的设备也能吊销设备，包括它自己：先收到响应，然后连接被关掉", async () => {
    const { tabletDevice, onTablet, tablet } = await setup();
    expect(await onTablet.request(METHODS.revokeDevice, { deviceId: tabletDevice.id }, "k-self")).toMatchObject({ ok: true });
    expect((await onTablet.closed(2000)).code).toBe(WS_CLOSE_UNPAIRED);
    expect(await tablet.access()).toEqual({ access: "none", reason: "revoked" });
  });
});
