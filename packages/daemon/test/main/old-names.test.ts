// 主切面：312 号票（ergou 换成 ergo）之前的东西照样能用——
// - 数据目录里还是旧名字的事件库、配置文件：守护进程照样打开、事件接着记，不另建新名字的，启动日志里提示一次；
// - 已配对的设备浏览器里的设备凭证 cookie 还是旧名字：照样认（不用重新配对），回应时写成新名字、把旧的清掉；WebSocket 握手也认；
// - 发起配对时拿的是旧名字的配对 cookie、切换之后来领凭证：照样领得到，旧的配对 cookie 清掉。
// 这里刻意写着旧名字（ergou），是兼容的测试。
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, EVENT_TYPES, oldNameOf, type PairingRequestView } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { DEVICE_COOKIE, PAIRING_COOKIE } from "../../src/pairing/credentials.ts";
import { openDatabase } from "../../src/storage/sqlite.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { pairDevice, TestDevice, waitForPairingCard } from "../helpers/device.ts";
import { TestFrontend } from "../helpers/frontend.ts";

const OLD_DEVICE_COOKIE = oldNameOf(DEVICE_COOKIE);
const OLD_PAIRING_COOKIE = oldNameOf(PAIRING_COOKIE);

/** 事件库里有几条事件 */
function eventCount(file: string): number {
  const db = openDatabase(file);
  try {
    return db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events")!.n;
  } finally {
    db.close();
  }
}

describe("312 号票之前的东西照样能用", () => {
  it("数据目录里还是旧名字的事件库（连同 -wal）、配置文件：照样打开、事件接着记，不另建新名字的；启动日志提示一次", async () => {
    const first = await startTestDaemon();
    const db = path.join(first.dataDir, "db");
    const pc = await TestFrontend.connect(first.url);
    await pc.subscribe({ [CHANNELS.secretary]: 0 });
    await pc.sendText("切换之前说的一句");
    await pc.close();
    await first.daemon.stop();
    const before = eventCount(path.join(db, "ergo.db"));
    expect(before).toBeGreaterThan(0);
    // 换回旧名字（312 号票之前的数据目录的样子）
    for (const suffix of ["", "-wal", "-shm"]) {
      if (fs.existsSync(path.join(db, `ergo.db${suffix}`))) fs.renameSync(path.join(db, `ergo.db${suffix}`), path.join(db, `ergou.db${suffix}`));
    }
    fs.renameSync(path.join(first.dataDir, "config", "ergo.json"), path.join(first.dataDir, "config", "ergou.json"));

    const logs: string[] = [];
    const second = await startTestDaemon({ reuse: { dataDir: first.dataDir, homeDir: first.homeDir }, log: (line) => logs.push(line) });
    expect(second.daemon.layout.eventsDb).toBe(path.join(db, "ergou.db"));
    expect(second.daemon.layout.configFile).toBe(path.join(first.dataDir, "config", "ergou.json"));
    // 之前记下的照样读得到，新的接着记在旧名字的库里
    const again = await TestFrontend.connect(second.url);
    await again.subscribe({ [CHANNELS.secretary]: 0 });
    expect(JSON.stringify((await again.next(CHANNELS.secretary, EVENT_TYPES.message)).payload)).toContain("切换之前说的一句");
    await again.sendText("切换之后又说一句");
    await again.close();
    await second.daemon.stop();
    expect(fs.existsSync(path.join(db, "ergo.db"))).toBe(false);
    expect(fs.existsSync(path.join(first.dataDir, "config", "ergo.json"))).toBe(false);
    expect(eventCount(path.join(db, "ergou.db"))).toBeGreaterThan(before);
    expect(logs.filter((l) => l.includes("还是旧名字") && l.includes("npm run migrate:ergo"))).toHaveLength(2);
  });

  it("已配对设备的设备凭证 cookie 还是旧名字：照样认，回应时写成新名字、清掉旧的；WebSocket 握手也认", async () => {
    const test = await startTestDaemon();
    const pc = await TestFrontend.connect(test.url);
    await pc.subscribe({ [CHANNELS.cards]: 0, [CHANNELS.inbox]: 0 });
    const device = await pairDevice(test.externalUrl, pc, { name: "旧手机" });
    const credential = device.credential!;
    // 浏览器里只有旧名字的（312 号票之前配对的）
    device.cookies.delete(DEVICE_COOKIE);
    device.cookies.set(OLD_DEVICE_COOKIE, credential);

    const res = await device.request("/healthz");
    expect(res.status).toBe(200);
    expect(res.setCookies.find((c) => c.name === DEVICE_COOKIE)).toMatchObject({ value: credential });
    expect(res.setCookies.find((c) => c.name === OLD_DEVICE_COOKIE)).toMatchObject({ attributes: { "max-age": "0" } });
    expect([...device.cookies.keys()]).toEqual([DEVICE_COOKIE]);
    expect((await device.access()).access).toBe("device");

    device.cookies.delete(DEVICE_COOKIE);
    device.cookies.set(OLD_DEVICE_COOKIE, credential);
    const phone = await device.connect();
    expect(await phone.subscribe({ [CHANNELS.cards]: 0 })).toMatchObject({ ok: true });
    await phone.close();
  });

  it("发起配对时拿的是旧名字的配对 cookie：切换之后照样领得到凭证，旧的配对 cookie 清掉", async () => {
    const test = await startTestDaemon();
    const pc = await TestFrontend.connect(test.url);
    await pc.subscribe({ [CHANNELS.cards]: 0, [CHANNELS.inbox]: 0 });
    const device = new TestDevice(test.externalUrl, { realIp: "198.51.100.7" });
    const created = await device.requestPairing("旧平板");
    expect(created.status).toBe(201);
    const secret = device.cookies.get(PAIRING_COOKIE)!;
    device.cookies.delete(PAIRING_COOKIE);
    device.cookies.set(OLD_PAIRING_COOKIE, secret);

    const { id } = created.json<{ request: PairingRequestView }>().request;
    const card = await waitForPairingCard(pc, id);
    expect(await pc.cardAction({ cardId: card.id, action: "approve", expectedVersion: card.version })).toMatchObject({ ok: true });
    expect((await device.pollPairing()).status).toBe("paired");
    expect(device.credential).toBeDefined();
    expect(device.cookies.has(OLD_PAIRING_COOKIE)).toBe(false);
    expect((await device.access()).access).toBe("device");
  });
});
