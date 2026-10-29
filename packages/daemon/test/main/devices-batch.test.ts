// 主切面：已配对设备的多选管理（123 号票）——设置里勾几台，一次延期、吊销或删除（device_batch_action）。
// - 延期：从原到期日和现在里晚的那个起算；有效的、等待首次使用的、过期的、作废的都能延期，后两种延期后重新有效
//   （服务端还留着凭证的哈希，设备手里的凭证又能用了）；吊销了的跳过；之后每次使用的续期不把延期缩回去；
// - 吊销：一次吊几台，开着的页面立刻断开；吊了的不能再延期；
// - 删除：从列表里去掉、凭证一律不认；还没吊销的先吊销再删；事件日志里的记录留着；
// - 结果逐台说做了还是跳过、为什么；同一个幂等键重发不再做一遍。
// 时钟可注入。前端状态层回放用的事件流 device-batch（设置页看到的）在这里录（packages/web/test/state/devices.test.ts 回放）。
import {
  CHANNELS,
  DEVICE_CREDENTIAL_TTL_MS,
  type DeviceBatchActionResult,
  type DeviceEventPayload,
  EVENT_TYPES,
  METHODS,
  type PairedDevice,
  type ResponseFrame,
  WS_CLOSE_UNPAIRED,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { DEVICE_COOKIE } from "../../src/pairing/credentials.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { pairDevice, TestDevice } from "../helpers/device.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { saveOrCheckRecording } from "../helpers/recording.ts";

const { cards: CARDS, devices: DEVICES, inbox: INBOX } = CHANNELS;
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const START = new Date(2026, 9, 8, 9, 0);

/** 守护进程、本机前端（批准配对用）、一个只看"已配对设备"的设置页 */
async function setup(clock = new ManualClock(START)) {
  const test = await startTestDaemon({ clock });
  const pc = await TestFrontend.connect(test.url);
  await pc.subscribe({ [CARDS]: 0, [INBOX]: 0 });
  const settings = await TestFrontend.connect(test.url);
  await settings.subscribe({ [DEVICES]: 0 });
  /** 按名字找设备（列表里的，删了的不在） */
  const deviceNamed = (name: string): PairedDevice => {
    const found = test.daemon.pairing.list().find((d) => d.name === name);
    if (!found) throw new Error(`列表里没有 ${name}`);
    return found;
  };
  /** 设置页发一次多选请求，拿到逐台的结果 */
  const batch = async (params: { action: "extend" | "revoke" | "delete"; deviceIds: string[]; days?: number }, key: string, from: TestFrontend = settings) =>
    expectOk(await from.request(METHODS.deviceBatchAction, params, key));
  // 设置页收设备事件：next 从上一次命中的位置往后找，记着收了几条
  let seen = 0;
  /** 等设置页收到接下来的几条设备事件 */
  const deviceEvents = async (n: number): Promise<DeviceEventPayload[]> => {
    const got: DeviceEventPayload[] = [];
    for (let i = 0; i < n; i++) got.push((await settings.next(DEVICES, EVENT_TYPES.device)).payload as DeviceEventPayload);
    seen += n;
    return got;
  };
  /** 设置页把到目前为止落下的设备事件都收完（之后 deviceEvents 拿到的就是新的） */
  const catchUp = () => deviceEvents(test.daemon.store.lastSeq(DEVICES) - seen);
  return { ...test, clock, pc, settings, deviceNamed, batch, deviceEvents, catchUp };
}

function expectOk(response: ResponseFrame): DeviceBatchActionResult {
  expect(response).toMatchObject({ ok: true });
  return (response as Extract<ResponseFrame, { ok: true }>).result as DeviceBatchActionResult;
}

/** 带着某个凭证（不经设备自己的 cookie 罐）问一次"我有没有被信任" */
const accessWith = async (externalUrl: string, credential: string) =>
  (await new TestDevice(externalUrl).request("/api/access", { headers: { cookie: `${DEVICE_COOKIE}=${credential}` } })).json<{ access: string; reason?: string }>();

describe("延期", () => {
  it("从原到期日和现在里晚的那个起算：有效的往后推，作废的、等待首次使用的从现在或原到期日起算；吊销了的跳过；作废的延期后带原凭证能进来", async () => {
    const { externalUrl, pc, settings, clock, deviceNamed, batch, daemon, deviceEvents, catchUp } = await setup();
    await pairDevice(externalUrl, pc, { name: "手机", realIp: "203.0.113.1" });
    const lost = await pairDevice(externalUrl, pc, { name: "丢了响应的平板", realIp: "203.0.113.2", firstUse: false });
    const lostCredential = lost.credential!;
    // 两天后：平板 24 小时里一次也没用过，作废了；再配一台还在等首次使用的，再配一台然后吊销掉
    clock.advance(2 * DAY);
    await pairDevice(externalUrl, pc, { name: "新电脑", realIp: "203.0.113.3", firstUse: false });
    await pairDevice(externalUrl, pc, { name: "旧电脑", realIp: "203.0.113.4" });
    const ids = ["手机", "丢了响应的平板", "新电脑", "旧电脑"].map((n) => deviceNamed(n).id) as [string, string, string, string];
    await batch({ action: "revoke", deviceIds: [ids[3]] }, "k-revoke-old");
    expect(await accessWith(externalUrl, lostCredential)).toEqual({ access: "none", reason: "expired" });
    await catchUp();

    const now = clock.now();
    const { results } = await batch({ action: "extend", deviceIds: ids, days: 90 }, "k-extend");
    expect(results.map((r) => (r.ok ? `${r.deviceId}:做了` : `${r.deviceId}:${r.skip}`))).toEqual([`${ids[0]}:做了`, `${ids[1]}:做了`, `${ids[2]}:做了`, `${ids[3]}:revoked`]);
    const [phone, tablet, desktop] = results.map((r) => (r.ok ? r.device : undefined));
    // 手机：原到期日（启用时起算 365 天）往后推 90 天
    expect(Date.parse(phone!.expiresAt)).toBe(START.getTime() + DEVICE_CREDENTIAL_TTL_MS + 90 * DAY);
    // 平板：原到期日早过了，从现在起算
    expect(Date.parse(tablet!.expiresAt)).toBe(now + 90 * DAY);
    // 新电脑：还在等首次使用（原到期日是领到后 24 小时），从原到期日起算
    expect(Date.parse(desktop!.expiresAt)).toBe(now + DAY + 90 * DAY);
    expect(phone).toMatchObject({ extendedAt: expect.any(String), revoked: false });
    expect(results[3]).toEqual({ deviceId: ids[3], ok: false, skip: "revoked", message: "这台设备已经吊销了，不能延期" });

    // 设置页收到三条"延期"
    const extended = await deviceEvents(3);
    expect(extended.map((e) => `${e.device.name}:${e.change}`)).toEqual(["手机:extended", "丢了响应的平板:extended", "新电脑:extended"]);

    // 作废了的平板重新有效：带着当初领到的凭证就能进来（这一次算它第一次用，启用）
    expect(await accessWith(externalUrl, lostCredential)).toEqual({ access: "device", device: { id: ids[1], name: "丢了响应的平板" } });
    expect(daemon.pairing.list().find((d) => d.id === ids[1])).toMatchObject({ activated: true, revoked: false });
    expect((await deviceEvents(1)).map((e) => `${e.device.name}:${e.change}`)).toEqual(["丢了响应的平板:activated"]);
    // 吊销了的旧电脑还是吊销的
    expect(deviceNamed("旧电脑")).toMatchObject({ revoked: true });
    expect(deviceNamed("旧电脑").extendedAt).toBeUndefined();

    // 接着删掉两台（录给前端回放：删了的从列表里消失，延期复活的回到"已配对"）
    await batch({ action: "delete", deviceIds: [ids[2], ids[3]] }, "k-delete");
    expect((await deviceEvents(3)).map((e) => `${e.device.name}:${e.change}`)).toEqual(["新电脑:revoked", "新电脑:deleted", "旧电脑:deleted"]);
    saveOrCheckRecording("device-batch", settings.recording);
  });

  it("过期了（连续 365 天没用）的延期后重新有效，带原凭证能进来；cookie 跟着服务端的到期日活更久", async () => {
    const { externalUrl, pc, clock, deviceNamed, batch } = await setup();
    const phone = await pairDevice(externalUrl, pc, { name: "抽屉里的手机" });
    const credential = phone.credential!;
    clock.jumpTo(START.getTime() + 400 * DAY);
    const id = deviceNamed("抽屉里的手机").id;

    const { results } = await batch({ action: "extend", deviceIds: [id], days: 365 }, "k-1");
    expect(results).toMatchObject([{ deviceId: id, ok: true }]);
    expect(Date.parse(deviceNamed("抽屉里的手机").expiresAt)).toBe(clock.now() + 365 * DAY);
    const res = await new TestDevice(externalUrl).request("/healthz", { headers: { cookie: `${DEVICE_COOKIE}=${credential}` } });
    expect(res.status).toBe(200);
    // 用了一次：续期到"现在 + 365 天"，和延期到的一样远
    expect(Date.parse(deviceNamed("抽屉里的手机").expiresAt)).toBe(clock.now() + 365 * DAY);

    // 再延期一年：服务端的到期日在两年后，浏览器里的 cookie 也跟着活两年（不是固定的 365 天，免得它先在浏览器里过期）
    await batch({ action: "extend", deviceIds: [id], days: 365 }, "k-2");
    const again = await new TestDevice(externalUrl).request("/healthz", { headers: { cookie: `${DEVICE_COOKIE}=${credential}` } });
    expect(again.setCookies.find((c) => c.name === DEVICE_COOKIE)?.attributes["max-age"]).toBe(String((2 * 365 * DAY) / 1000));
  });

  it("每次使用的续期不把延期缩回去：延期到两年后的，用一次还是两年后", async () => {
    const { externalUrl, pc, clock, deviceNamed, batch } = await setup();
    const phone = await pairDevice(externalUrl, pc, { name: "手机" });
    const id = deviceNamed("手机").id;
    await batch({ action: "extend", deviceIds: [id], days: 365 }, "k-1");
    const extendedTo = Date.parse(deviceNamed("手机").expiresAt);
    expect(extendedTo).toBe(START.getTime() + 2 * 365 * DAY);

    // 过了两小时用一次（离上一条使用记录超过一小时，会落一条"使用"）：到期日不变
    clock.advance(2 * HOUR);
    expect((await phone.request("/healthz")).status).toBe(200);
    expect(deviceNamed("手机")).toMatchObject({ lastUsedAt: expect.any(String) });
    expect(Date.parse(deviceNamed("手机").lastUsedAt)).toBe(clock.now());
    expect(Date.parse(deviceNamed("手机").expiresAt)).toBe(extendedTo);
    // 一年半之后再用：现在 + 365 天比延期到的更远，往后推
    clock.jumpTo(START.getTime() + 540 * DAY);
    expect((await phone.request("/healthz")).status).toBe(200);
    expect(Date.parse(deviceNamed("手机").expiresAt)).toBe(clock.now() + 365 * DAY);
  });

  it("延期要给天数", async () => {
    const { externalUrl, pc, settings, deviceNamed } = await setup();
    await pairDevice(externalUrl, pc, { name: "手机" });
    expect(await settings.request(METHODS.deviceBatchAction, { action: "extend", deviceIds: [deviceNamed("手机").id] }, "k-1")).toMatchObject({ ok: false, error: { code: "bad_params" } });
  });
});

describe("吊销", () => {
  it("一次吊几台：它们开着的页面立刻断开，另一台照常；吊了的不能再延期，再吊销就跳过", async () => {
    const { externalUrl, pc, deviceNamed, batch } = await setup();
    const phone = await pairDevice(externalUrl, pc, { name: "手机", realIp: "203.0.113.1" });
    const tablet = await pairDevice(externalUrl, pc, { name: "平板", realIp: "203.0.113.2" });
    const desktop = await pairDevice(externalUrl, pc, { name: "电脑", realIp: "203.0.113.3" });
    const [onPhone, onTablet, onDesktop] = await Promise.all([phone.connect(), tablet.connect(), desktop.connect()]);
    for (const f of [onPhone, onTablet, onDesktop]) await f.subscribe({ [CARDS]: 0 });
    const [phoneId, tabletId] = [deviceNamed("手机").id, deviceNamed("平板").id];

    const { results } = await batch({ action: "revoke", deviceIds: [phoneId, tabletId] }, "k-revoke");
    expect(results).toMatchObject([
      { deviceId: phoneId, ok: true, device: { revoked: true, revokedAt: expect.any(String) } },
      { deviceId: tabletId, ok: true, device: { revoked: true } },
    ]);
    expect(await onPhone.closed(2000)).toEqual({ code: WS_CLOSE_UNPAIRED, reason: "这台设备已被吊销" });
    expect((await onTablet.closed(2000)).code).toBe(WS_CLOSE_UNPAIRED);
    expect(onDesktop.isOpen).toBe(true);
    expect(await phone.access()).toEqual({ access: "none", reason: "revoked" });
    expect((await desktop.access()).access).toBe("device");

    expect((await batch({ action: "extend", deviceIds: [phoneId], days: 30 }, "k-extend")).results).toEqual([{ deviceId: phoneId, ok: false, skip: "revoked", message: "这台设备已经吊销了，不能延期" }]);
    expect((await batch({ action: "revoke", deviceIds: [tabletId, "d-nope"] }, "k-again")).results).toEqual([
      { deviceId: tabletId, ok: false, skip: "revoked", message: "这台设备已经吊销了" },
      { deviceId: "d-nope", ok: false, skip: "not_found", message: "这台设备找不到了" },
    ]);
  });

  it("包括正在用的这台：先收到结果，然后这台的连接被关掉，之后问\"我有没有被信任\"得到被吊销", async () => {
    const { externalUrl, pc, deviceNamed, batch } = await setup();
    const phone = await pairDevice(externalUrl, pc, { name: "手机", realIp: "203.0.113.1" });
    await pairDevice(externalUrl, pc, { name: "平板", realIp: "203.0.113.2" });
    const onPhone = await phone.connect();
    await onPhone.subscribe({ [DEVICES]: 0 });
    const ids = [deviceNamed("手机").id, deviceNamed("平板").id];
    expect((await batch({ action: "revoke", deviceIds: ids }, "k-self", onPhone)).results.every((r) => r.ok)).toBe(true);
    expect((await onPhone.closed(2000)).code).toBe(WS_CLOSE_UNPAIRED);
    expect(await phone.access()).toEqual({ access: "none", reason: "revoked" });
  });
});

describe("删除", () => {
  it("从列表里去掉、凭证不再认；还有效的先吊销再删（开着的页面断开）；事件日志里的记录留着，删除本身也记一笔", async () => {
    const { externalUrl, pc, settings, deviceNamed, batch, daemon, deviceEvents, catchUp } = await setup();
    const phone = await pairDevice(externalUrl, pc, { name: "手机", realIp: "203.0.113.1" });
    await pairDevice(externalUrl, pc, { name: "平板", realIp: "203.0.113.2" });
    await pairDevice(externalUrl, pc, { name: "电脑", realIp: "203.0.113.3" });
    const onPhone = await phone.connect();
    await onPhone.subscribe({ [CARDS]: 0 });
    const [phoneId, tabletId] = [deviceNamed("手机").id, deviceNamed("平板").id];
    await batch({ action: "revoke", deviceIds: [tabletId] }, "k-revoke");
    await catchUp();

    const { results } = await batch({ action: "delete", deviceIds: [phoneId, tabletId] }, "k-delete");
    expect(results).toMatchObject([
      { deviceId: phoneId, ok: true, device: { revoked: true, deletedAt: expect.any(String) } },
      { deviceId: tabletId, ok: true, device: { revoked: true, deletedAt: expect.any(String) } },
    ]);
    // 手机还有效：先吊销（同一事务里），再删除；平板早就吊销了，只删除
    expect((await deviceEvents(3)).map((e) => `${e.device.name}:${e.change}`)).toEqual(["手机:revoked", "手机:deleted", "平板:deleted"]);
    expect((await onPhone.closed(2000)).code).toBe(WS_CLOSE_UNPAIRED);
    expect(daemon.pairing.list().map((d) => d.name)).toEqual(["电脑"]);
    // 凭证一律不认（和吊销一样，页面走"本设备已被吊销"）
    expect(await phone.access()).toEqual({ access: "none", reason: "revoked" });
    // 事件日志：这两台从配对到删除的每一条都还在
    const log = daemon.store.read(DEVICES, 0).map((e) => e.payload as DeviceEventPayload);
    expect(log.filter((e) => e.device.id === phoneId).map((e) => e.change)).toEqual(["paired", "activated", "revoked", "deleted"]);
    expect(log.filter((e) => e.device.id === tabletId).map((e) => e.change)).toEqual(["paired", "activated", "revoked", "deleted"]);

    // 删了的再做什么都跳过
    for (const action of ["extend", "revoke", "delete"] as const) {
      expect((await batch({ action, deviceIds: [phoneId], days: 30 }, `k-${action}-again`)).results).toEqual([{ deviceId: phoneId, ok: false, skip: "deleted", message: "这台设备已经删除了" }]);
    }
    // 原来单台吊销的方法也认得它删了
    expect(await settings.request(METHODS.revokeDevice, { deviceId: phoneId }, "k-old")).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});

describe("结果和幂等", () => {
  it("一次请求里能做的都做、不能做的逐台说为什么；同一个幂等键重发拿到同一个结果，不再做一遍（不多落事件）", async () => {
    const { externalUrl, pc, deviceNamed, batch, daemon, clock } = await setup();
    await pairDevice(externalUrl, pc, { name: "手机", realIp: "203.0.113.1" });
    await pairDevice(externalUrl, pc, { name: "平板", realIp: "203.0.113.2" });
    const [phoneId, tabletId] = [deviceNamed("手机").id, deviceNamed("平板").id];
    await batch({ action: "revoke", deviceIds: [tabletId] }, "k-revoke");

    const first = await batch({ action: "extend", deviceIds: [phoneId, tabletId, "d-nope"], days: 30 }, "k-extend");
    expect(first.results.map((r) => (r.ok ? "做了" : r.skip))).toEqual(["做了", "revoked", "not_found"]);
    const seq = daemon.store.lastSeq(DEVICES);
    // 过了一会儿重发（比如响应丢了）：拿到同一个结果，到期日没有再推 30 天
    clock.advance(HOUR);
    expect(await batch({ action: "extend", deviceIds: [phoneId, tabletId, "d-nope"], days: 30 }, "k-extend")).toEqual(first);
    expect(daemon.store.lastSeq(DEVICES)).toBe(seq);
    expect(deviceNamed("手机").expiresAt).toBe((first.results[0] as { device: PairedDevice }).device.expiresAt);

    // 删除一台还有效的（先吊销再删）也一样：重发不多落事件
    const deleted = await batch({ action: "delete", deviceIds: [phoneId] }, "k-delete");
    const afterDelete = daemon.store.lastSeq(DEVICES);
    expect(await batch({ action: "delete", deviceIds: [phoneId] }, "k-delete")).toEqual(deleted);
    expect(daemon.store.lastSeq(DEVICES)).toBe(afterDelete);
  });
});
