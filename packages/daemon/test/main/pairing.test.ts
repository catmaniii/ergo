// 主切面：设备配对（规格第 6 节、第 21 节）。新设备在外网端口上发起配对请求 → 本机（或已配对设备）的待我处理里
// 出现配对请求卡 → 核对设备名、短码、短指纹后批准 → 新设备领到凭证（HttpOnly cookie），之后外网端口上的 HTTP 和
// WebSocket 都接受它。时钟可注入：待批的请求 5 分钟过期，同一来源 10 分钟内最多 5 个请求，凭证 365 天、每次使用续期；
// 领到凭证后 24 小时里一次也没用过（领取的响应丢了）就自动作废。
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type AccessInfo,
  type Card,
  type CardEventPayload,
  CHANNELS,
  type DeviceEventPayload,
  EVENT_TYPES,
  HTTP_PATHS,
  type HttpErrorBody,
  type InboxItemEventPayload,
  type PairingCardPayload,
  type PairingRequestView,
  type ResponseFrame,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import type { StoredEvent } from "../../src/events/event-store.ts";
import { DEVICE_COOKIE, PAIRING_COOKIE } from "../../src/pairing/credentials.ts";
import { unidentifiedSourceLabel } from "../../src/pairing/pairing.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon, TEST_PAGE } from "../helpers/daemon.ts";
import { IPHONE_UA, pairDevice, TestDevice, waitForPairingCard } from "../helpers/device.ts";
import { TestFrontend } from "../helpers/frontend.ts";

const { cards: CARDS, devices: DEVICES, inbox: INBOX } = CHANNELS;
const MIN = 60_000;
const DAY = 24 * 3600_000;
const START = new Date(2026, 9, 8, 9, 0);

/** 守护进程 + 一个订阅了卡片和待我处理的本机前端（PC 本机直接用，不用配对） */
async function setup(options: { clock?: ManualClock } = {}) {
  const test = await startTestDaemon(options.clock ? { clock: options.clock } : {});
  const pc = await TestFrontend.connect(test.url);
  await pc.subscribe({ [CARDS]: 0, [INBOX]: 0 });
  return { ...test, pc };
}

const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);

/** 等前端收到某张卡的某个版本 */
async function cardVersion(frontend: TestFrontend, version: number): Promise<Card> {
  for (;;) {
    const card = ((await frontend.next(CARDS, EVENT_TYPES.card)).payload as CardEventPayload).card;
    if (card.version === version) return card;
  }
}

/** 数据目录里全部文件的内容 */
function readAllFiles(dir: string): Buffer[] {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).flatMap((e) => (e.isFile() ? [fs.readFileSync(path.join(e.parentPath, e.name))] : []));
}

describe("发起配对请求", () => {
  it("新设备拿到设备名（默认由浏览器和系统信息生成）、6 位数字短码、8 位十六进制短指纹；本机的待我处理里出现同样内容的配对请求卡", async () => {
    const clock = new ManualClock(START);
    const { externalUrl, pc } = await setup({ clock });
    const device = new TestDevice(externalUrl, { userAgent: IPHONE_UA, realIp: "203.0.113.24" });

    const res = await device.requestPairing();
    expect(res.status).toBe(201);
    const request = res.json<{ request: PairingRequestView }>().request;
    expect(request).toEqual({
      id: expect.any(String),
      status: "pending",
      deviceName: "Safari · iPhone",
      shortCode: expect.stringMatching(/^[0-9]{6}$/),
      fingerprint: expect.stringMatching(/^[0-9a-f]{8}$/),
      expiresAt: expect.any(String),
    });
    expect(Date.parse(request.expiresAt) - START.getTime()).toBe(5 * MIN);
    // 认出这个请求的配对 cookie：HttpOnly，页面脚本看不到；这时还没有设备凭证
    const pairingCookie = res.setCookies.find((c) => c.name === PAIRING_COOKIE);
    expect(pairingCookie?.attributes).toMatchObject({ httponly: "", secure: "", samesite: "Strict", path: "/" });
    expect(res.body).not.toContain(pairingCookie!.value);
    expect(device.credential).toBeUndefined();

    // 本机：待我处理里是一张配对请求卡，设备名、短码、短指纹和新设备上显示的一样
    const card = ((await pc.next(CARDS, EVENT_TYPES.card)).payload as CardEventPayload).card;
    expect(card).toMatchObject({ type: "pairing", status: "pending", version: 1 });
    expect(card.payload).toEqual({
      requestId: request.id,
      deviceName: "Safari · iPhone",
      shortCode: request.shortCode,
      fingerprint: request.fingerprint,
      from: "经隧道 · 203.0.113.24",
      expiresAt: request.expiresAt,
    } satisfies PairingCardPayload);
    const item = ((await pc.next(INBOX, EVENT_TYPES.inboxItem)).payload as InboxItemEventPayload).item;
    expect(item).toMatchObject({ kind: "card", cardId: card.id, title: "新设备请求配对：Safari · iPhone", urgency: "non_blocking" });
    // 卡片的纯文本降级里也能核对
    expect(card.text).toContain(request.shortCode);
    expect(card.text).toContain(request.fingerprint);
  });

  it("新设备上改了设备名：本机待我处理里那张卡显示改过的设备名，短码和短指纹不变；拿旧版本去批准得到冲突", async () => {
    const { externalUrl, pc } = await setup();
    const device = new TestDevice(externalUrl);
    const request = (await device.requestPairing()).json<{ request: PairingRequestView }>().request;
    const v1 = await cardVersion(pc, 1);

    const renamed = await device.renamePairing("  小王的 iPhone  ");
    expect(renamed.status).toBe(200);
    expect(renamed.json<{ request: PairingRequestView }>().request).toMatchObject({ deviceName: "小王的 iPhone", shortCode: request.shortCode, fingerprint: request.fingerprint });
    expect(await device.pollPairing()).toMatchObject({ status: "pending", deviceName: "小王的 iPhone" });

    const v2 = await cardVersion(pc, 2);
    expect(v2.payload).toMatchObject({ deviceName: "小王的 iPhone", shortCode: request.shortCode, fingerprint: request.fingerprint });
    // 待我处理里那一项的标题也跟着改
    await pc.next(INBOX, EVENT_TYPES.inboxItem);
    expect(pc.events({ channel: INBOX, type: EVENT_TYPES.inboxItem }).map((f) => (f.payload as InboxItemEventPayload).item.title)).toEqual([
      "新设备请求配对：Safari · iPhone",
      "新设备请求配对：小王的 iPhone",
    ]);

    // 用户看到的还是旧名字时点了批准：不生效，要看最新的内容再操作
    expect(await pc.cardAction({ cardId: v1.id, action: "approve", expectedVersion: 1 })).toMatchObject({ ok: false, error: { code: "conflict" } });
    // 设备名不能是空的
    expect((await device.renamePairing("   ")).status).toBe(400);
  });
});

describe("来源", () => {
  it("来源是本机地址（隧道的 VPS 一端经按 SNI 分流的前门转发，nginx 只看得到 127.0.0.1）：卡片上写\"经前门转发，无法识别\"，限频照样按它算", async () => {
    const { externalUrl, pc } = await setup();
    for (const realIp of ["127.0.0.1", "::1", undefined]) {
      // undefined：没有 X-Real-IP，用 TCP 对端（测试里就是本机）
      const device = new TestDevice(externalUrl, realIp === undefined ? {} : { realIp });
      const { id } = (await device.requestPairing()).json<{ request: PairingRequestView }>().request;
      expect((await waitForPairingCard(pc, id)).payload).toMatchObject({ from: unidentifiedSourceLabel() });
    }
    expect(unidentifiedSourceLabel()).toBe("经前门转发，无法识别");
  });
});

describe("像网络上的自动访问（137 号票）", () => {
  const HEADLESS_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/134.0.0.0 Safari/537.36";
  const LINUX_CHROME_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

  it("无界面浏览器发来的请求：卡上带着判断和原因，纯文本降级里也有那句提示；批准照样能批，新设备领到凭证", async () => {
    const { externalUrl, pc } = await setup();
    const device = new TestDevice(externalUrl, { userAgent: HEADLESS_UA, realIp: "203.0.113.9" });
    const { id } = (await device.requestPairing()).json<{ request: PairingRequestView }>().request;
    const card = await waitForPairingCard(pc, id);
    expect(card.typeVersion).toBe(2);
    expect((card.payload as PairingCardPayload).automated).toEqual({ reason: "浏览器标识带「HeadlessChrome」，是无界面浏览器" });
    expect(card.text).toContain("看起来像网络上的自动访问（浏览器标识带「HeadlessChrome」，是无界面浏览器），不是你的设备就拒绝");
    // 新设备上改了设备名：判断留在卡上
    expect((await device.renamePairing("我的服务器")).status).toBe(200);
    const renamed = await cardVersion(pc, 2);
    expect(renamed.payload).toMatchObject({ deviceName: "我的服务器", automated: { reason: expect.stringContaining("HeadlessChrome") } });
    // 不拦：批准照样能批
    expect(await pc.cardAction({ cardId: renamed.id, action: "approve", expectedVersion: 2 })).toMatchObject({ ok: true });
    expect((await device.pollPairing()).status).toBe("paired");
    expect(device.credential).toBeDefined();
  });

  it("普通的 Linux 桌面 Chrome、没有浏览器标识：前者不带判断，后者带", async () => {
    const { externalUrl, pc } = await setup();
    const linux = new TestDevice(externalUrl, { userAgent: LINUX_CHROME_UA, realIp: "203.0.113.10" });
    const first = (await linux.requestPairing()).json<{ request: PairingRequestView }>().request;
    const plain = await waitForPairingCard(pc, first.id);
    expect(plain.payload).not.toHaveProperty("automated");
    expect(plain.text).not.toContain("自动访问");

    const blank = new TestDevice(externalUrl, { userAgent: "", realIp: "203.0.113.11" });
    const second = (await blank.requestPairing()).json<{ request: PairingRequestView }>().request;
    expect((await waitForPairingCard(pc, second.id)).payload).toMatchObject({ automated: { reason: "没有浏览器标识" } });
  });
});

describe("批准与凭证", () => {
  it("批准后新设备领到 cookie：HttpOnly、Secure、SameSite=Strict，值是 256 位随机数；ergo.db 里只有它的哈希，数据目录里搜不到原值", async () => {
    const { externalUrl, pc, dataDir } = await setup();
    const device = new TestDevice(externalUrl);
    await device.requestPairing();
    const card = await cardVersion(pc, 1);
    // 还没批准：问多少次都只是等着
    expect(await device.pollPairing()).toMatchObject({ status: "pending" });
    expect(device.credential).toBeUndefined();

    expect(await pc.cardAction({ cardId: card.id, action: "approve", expectedVersion: 1 })).toMatchObject({ ok: true, result: { cardId: card.id, version: 2 } });
    expect((await cardVersion(pc, 2)).status).toBe("handled");

    const pairingSecret = device.cookies.get(PAIRING_COOKIE)!;
    const res = await device.request("/api/pairing");
    expect(res.json<{ request: PairingRequestView }>().request.status).toBe("paired");
    const cookie = res.setCookies.find((c) => c.name === DEVICE_COOKIE)!;
    expect(cookie.attributes).toEqual({ "max-age": String(400 * 24 * 3600), path: "/", httponly: "", secure: "", samesite: "Strict" });
    expect(Buffer.from(cookie.value, "base64url")).toHaveLength(32);
    expect(res.body).not.toContain(cookie.value);
    // 配对 cookie 用完删掉
    expect(res.setCookies.find((c) => c.name === PAIRING_COOKIE)?.attributes["max-age"]).toBe("0");
    // 拿着那个配对 cookie 再问一次（比如上一个响应丢了）：已配对，不会再发一个凭证
    const again = await new TestDevice(externalUrl).request("/api/pairing", { headers: { cookie: `${PAIRING_COOKIE}=${pairingSecret}` } });
    expect(again.json<{ request: PairingRequestView }>().request.status).toBe("paired");
    expect(again.setCookies.filter((c) => c.name === DEVICE_COOKIE)).toEqual([]);

    // 数据目录：凭证原值（以及它的原始字节）哪儿都没有，ergo.db（连同 WAL）里有它的哈希
    const credential = cookie.value;
    const raw = Buffer.from(credential, "base64url");
    for (const content of readAllFiles(dataDir)) {
      expect(content.includes(credential)).toBe(false);
      expect(content.includes(raw)).toBe(false);
      expect(content.includes(raw.toString("hex"))).toBe(false);
    }
    const hash = createHash("sha256").update(credential).digest("hex");
    expect(readAllFiles(path.join(dataDir, "db")).some((content) => content.includes(hash))).toBe(true);
  });

  it("之后这台设备在外网端口上的 HTTP 请求和 WebSocket 连接都被接受", async () => {
    const { externalUrl, pc } = await setup();
    const device = await pairDevice(externalUrl, pc, { name: "家里的平板" });

    expect(await device.access()).toEqual({ access: "device", device: { id: expect.any(String), name: "家里的平板" } } satisfies AccessInfo);
    const health = await device.request("/healthz");
    expect(health.status).toBe(200);
    // 每次使用都续期：浏览器里的 cookie 跟着延长
    expect(health.setCookies.find((c) => c.name === DEVICE_COOKIE)).toMatchObject({ value: device.credential, attributes: { "max-age": String(400 * 24 * 3600) } });

    // 历史分页、媒体上传（09 的接口）照常能用
    expect((await device.request(HTTP_PATHS.history("secretary"))).status).toBe(200);
    expect((await device.request(HTTP_PATHS.uploads, { method: "POST", body: { name: "a.txt", mime: "text/plain", size: 3 } })).status).toBe(201);

    const phone = await device.connect();
    expect(await phone.subscribe({ [CARDS]: 0, [INBOX]: 0 })).toMatchObject({ ok: true });
    // 已配对的设备看得到本机看到的东西：刚才那张（已处理的）配对请求卡
    expect(cardsOf(await waitForCards(phone, 2)).at(-1)).toMatchObject({ type: "pairing", status: "handled" });
  });

  it("两台已信任的设备同时批准同一张卡：后到的得到\"已被处理\"；批准不产生素材，只有请求状态和卡片的变化", async () => {
    const { externalUrl, pc, daemon } = await setup();
    const tablet = await pairDevice(externalUrl, pc);
    const onTablet = await tablet.connect();
    await onTablet.subscribe({ [CARDS]: 0 });

    const newcomer = new TestDevice(externalUrl, { realIp: "192.0.2.50" });
    const { id } = (await newcomer.requestPairing("新手机")).json<{ request: PairingRequestView }>().request;
    const card = await waitForPairingCard(pc, id);
    await waitForPairingCard(onTablet, id);

    const appended: StoredEvent[] = [];
    const off = daemon.store.onAppend((e) => appended.push(e));
    const responses = await Promise.all([
      pc.cardAction({ cardId: card.id, action: "approve", expectedVersion: 1 }),
      onTablet.cardAction({ cardId: card.id, action: "approve", expectedVersion: 1 }),
    ]);
    off();
    expect(responses.filter((r) => r.ok)).toHaveLength(1);
    expect((responses.find((r) => !r.ok) as Extract<ResponseFrame, { ok: false }>).error).toEqual({ code: "conflict", message: "已被处理" });
    // 批准这一下只有两条事件：请求变成已批准（守护进程内部的频道，不推给前端）、卡片变成已处理。没有素材、没有"卡片被关闭"
    expect(appended.map((e) => `${e.channel}:${e.type}`)).toEqual(["pairing:pairing_request", `${CARDS}:${EVENT_TYPES.card}`]);
    expect((await newcomer.pollPairing()).status).toBe("paired");
  });

  it("拒绝：新设备看到被拒绝，拿不到凭证", async () => {
    const { externalUrl, pc } = await setup();
    const device = new TestDevice(externalUrl);
    await device.requestPairing();
    const card = await cardVersion(pc, 1);
    expect(await pc.cardAction({ cardId: card.id, action: "deny", expectedVersion: 1 })).toMatchObject({ ok: true });
    expect(await device.pollPairing()).toMatchObject({ status: "denied" });
    expect(device.credential).toBeUndefined();
    expect(await device.access()).toEqual({ access: "none" });
    expect(cardsOf(pc).at(-1)).toMatchObject({ status: "handled", outcome: { action: "deny" } });
  });

  it("配对请求的哈希和凭证的哈希不推给任何前端：前端订阅不了守护进程内部的频道", async () => {
    const { url } = await startTestDaemon();
    const frontend = await TestFrontend.connect(url);
    expect(await frontend.subscribe({ pairing: 0 })).toMatchObject({ ok: false, error: { code: "bad_params" } });
  });
});

describe("过期与限频（可注入时钟）", () => {
  it("待批的配对请求 5 分钟后过期：卡片变成已过期、不能再处理，新设备拿不到凭证", async () => {
    const clock = new ManualClock(START);
    const { externalUrl, pc } = await setup({ clock });
    const device = new TestDevice(externalUrl);
    await device.requestPairing();
    const card = await cardVersion(pc, 1);

    clock.advance(5 * MIN - 1);
    expect(await device.pollPairing()).toMatchObject({ status: "pending" });
    clock.advance(1);
    expect((await cardVersion(pc, 2)).status).toBe("expired");
    expect(await device.pollPairing()).toMatchObject({ status: "expired" });
    expect(await pc.cardAction({ cardId: card.id, action: "approve", expectedVersion: 2 })).toMatchObject({ ok: false, error: { code: "conflict", message: "已被处理" } });
    expect(await device.pollPairing()).toMatchObject({ status: "expired" });
    expect(device.credential).toBeUndefined();
    // 过期的请求也不能再改名
    expect((await device.renamePairing("迟到的名字")).status).toBe(403);
  });

  it("同一来源（X-Real-IP）10 分钟内的第 6 个配对请求被拒，换一个 X-Real-IP 的不受影响；过了 10 分钟又能请求", async () => {
    const clock = new ManualClock(START);
    const { externalUrl } = await setup({ clock });
    const a = new TestDevice(externalUrl, { realIp: "203.0.113.24" });
    for (let i = 0; i < 5; i++) {
      expect((await a.requestPairing()).status).toBe(201);
      clock.advance(MIN);
    }
    const sixth = await a.requestPairing();
    expect(sixth.status).toBe(429);
    expect(sixth.json<HttpErrorBody>().code).toBe("too_many_requests");
    // TCP 对端都是本机（隧道），来源只认 X-Real-IP：另一个 X-Real-IP 不受影响
    expect((await new TestDevice(externalUrl, { realIp: "198.51.100.99" }).requestPairing()).status).toBe(201);
    // 第一个请求满 10 分钟之后，窗口里只剩 4 个
    clock.advanceTo(START.getTime() + 10 * MIN);
    expect((await a.requestPairing()).status).toBe(201);
    expect((await a.requestPairing()).status).toBe(429);
  });
});

describe("凭证有效期（可注入时钟）", () => {
  it("有效期 365 天、每次使用都续期：第 300 天用过的凭证到第 400 天仍然有效；连续 365 天没用过就失效，再访问回到配对页", async () => {
    const clock = new ManualClock(START);
    const { externalUrl, pc } = await setup({ clock });
    const device = await pairDevice(externalUrl, pc);

    clock.jumpTo(START.getTime() + 300 * DAY);
    expect((await device.access()).access).toBe("device");
    clock.jumpTo(START.getTime() + 400 * DAY);
    expect((await device.access()).access).toBe("device");
    expect((await device.request("/healthz")).status).toBe(200);

    // 第 400 天之后再没用过：满 365 天的那一刻失效
    clock.jumpTo(START.getTime() + (400 + 365) * DAY);
    const credential = device.credential;
    await expect(device.connect()).rejects.toThrow("HTTP 401");
    expect(await device.access()).toEqual({ access: "none", reason: "expired" });
    // 失效的凭证：浏览器被告知删掉它，再访问只有配对页
    expect(device.credential).toBeUndefined();
    expect((await new TestDevice(externalUrl).request("/healthz", { headers: { cookie: `${DEVICE_COOKIE}=${credential}` } })).status).toBe(401);
    expect((await device.request("/")).status).toBe(200);
  });
});

/** 等前端收到下一条已配对设备的事件 */
const nextDeviceEvent = async (frontend: TestFrontend) => (await frontend.next(DEVICES, EVENT_TYPES.device)).payload as DeviceEventPayload;

describe("领到凭证之后的第一次使用（可注入时钟）", () => {
  it("领到凭证时设备记录是\"等待首次使用\"（24 小时后到期）；第一次带着凭证来就启用，有效期从这时起算 365 天", async () => {
    const clock = new ManualClock(START);
    const { url, externalUrl, pc } = await setup({ clock });
    const settings = await TestFrontend.connect(url);
    await settings.subscribe({ [DEVICES]: 0 });
    const device = await pairDevice(externalUrl, pc, { firstUse: false });

    const paired = await nextDeviceEvent(settings);
    expect(paired).toMatchObject({ change: "paired", device: { activated: false, revoked: false } });
    expect(Date.parse(paired.device.pairedAt)).toBe(START.getTime());
    expect(Date.parse(paired.device.expiresAt)).toBe(START.getTime() + DAY);

    clock.advance(DAY - 1);
    expect((await device.access()).access).toBe("device");
    const activated = await nextDeviceEvent(settings);
    expect(activated).toMatchObject({ change: "activated", device: { id: paired.device.id, activated: true, pairedAt: paired.device.pairedAt } });
    expect(Date.parse(activated.device.lastUsedAt)).toBe(START.getTime() + DAY - 1);
    expect(Date.parse(activated.device.expiresAt)).toBe(START.getTime() + DAY - 1 + 365 * DAY);
    // 启用之后过了原来的 24 小时也照常有效
    clock.advance(2 * DAY);
    expect((await device.request("/healthz")).status).toBe(200);
  });

  it("领取的响应丢了（凭证没到设备手里）：这条记录 24 小时里一次也没用过就自动作废，那个凭证再也进不来", async () => {
    const clock = new ManualClock(START);
    const { externalUrl, pc, daemon } = await setup({ clock });
    const lost = await pairDevice(externalUrl, pc, { firstUse: false, realIp: "203.0.113.24" });
    const credential = lost.credential!;

    clock.advance(DAY);
    const holder = new TestDevice(externalUrl, { realIp: "203.0.113.24" });
    expect((await holder.request("/healthz", { headers: { cookie: `${DEVICE_COOKIE}=${credential}` } })).status).toBe(401);
    expect(await lost.access()).toEqual({ access: "none", reason: "expired" });
    await expect(new TestDevice(externalUrl).connect({ headers: { cookie: `${DEVICE_COOKIE}=${credential}` } })).rejects.toThrow("HTTP 401");
    // 设置里它是失效的（从没启用过）；不会因为这次被拒而被启用
    expect(daemon.pairing.list()).toMatchObject([{ activated: false, revoked: false }]);
    expect(Date.parse(daemon.pairing.list()[0]!.expiresAt)).toBe(START.getTime() + DAY);
  });
});

/** 浏览器打开一个地址时带的头（254 号票：Chrome 的一次页面导航长这样） */
const NAVIGATION = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
};

describe("浏览器打开哪个地址都给页面（254 号票）", () => {
  it("没配上对的浏览器打开首页以外的地址：给的是页面本身（前端显示配对页），不是\"这台设备还没配对\"的 JSON", async () => {
    const { externalUrl } = await setup();
    const device = new TestDevice(externalUrl);
    // 收藏的旧地址、手机主屏上的快捷方式、项目服务入口、附件直链——原来全撞在 401 的 JSON 上
    const paths = ["/", "/index.html", "/memory", "/more/about", "/apps/p-1-reports/", "/api/media/deadbeef"];
    const seen: string[] = [];
    for (const pathname of paths) {
      const res = await device.request(pathname, { headers: NAVIGATION });
      seen.push(`${pathname} → ${res.status} ${res.headers["content-type"]} ${res.body === TEST_PAGE ? "页面" : res.body.slice(0, 80)}`);
    }
    expect(seen).toEqual(paths.map((pathname) => `${pathname} → 200 text/html; charset=utf-8 页面`));
    // 页面原样发出，没往上塞凭证（这台设备还没有）
    expect(device.cookieHeader).toBeUndefined();
  });

  it("不是浏览器导航的请求（脚本、程序）照旧要凭证：401 的 JSON", async () => {
    const { externalUrl } = await setup();
    const seen: string[] = [];
    for (const headers of [{}, { accept: "application/json" }, { accept: "*/*" }]) {
      const res = await new TestDevice(externalUrl).request("/memory", { headers });
      seen.push(`${res.status} ${res.json<HttpErrorBody>().code} ${headers.accept ?? "没有 Accept"}`);
    }
    expect(seen).toEqual(["401 unauthorized 没有 Accept", "401 unauthorized application/json", "401 unauthorized */*"]);
  });

  it("已配对设备打开认不出的地址：导航给页面（旧书签还能进二狗），程序请求照旧 404；认得的东西不受影响", async () => {
    const { externalUrl, pc } = await setup();
    const device = await pairDevice(externalUrl, pc);
    const nav = await device.request("/memory", { headers: NAVIGATION });
    expect(nav.status).toBe(200);
    expect(nav.body).toBe(TEST_PAGE);
    expect((await device.request("/memory")).status).toBe(404);
    // 健康探针照旧 JSON，配对接口照旧只在外网端口的没凭证分支上认（这里是已信任的请求）
    expect((await device.request("/healthz")).json<{ ok: boolean }>().ok).toBe(true);
    expect((await device.request(HTTP_PATHS.access)).json<AccessInfo>().access).toBe("device");
  });
});

async function waitForCards(frontend: TestFrontend, n: number): Promise<TestFrontend> {
  for (let i = 0; i < n; i++) await frontend.next(CARDS, EVENT_TYPES.card);
  return frontend;
}
