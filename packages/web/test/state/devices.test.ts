// 前端状态层：已配对设备（设置里的"已配对设备"）和配对等待页的开场。主线流程回放主切面录下的 device-revoke 和
// device-revoked-here（recorded.test.ts）；这里是手写的边角：凭证过期的设备、领到之后一直没用过的设备、重新同步、
// 连接被告知凭证失效、浏览器里"本设备已被吊销"的记号。
import { describe, expect, test } from "vitest";
import { type PairedDevice, pairedDevices, pairingOpening, replay, revokedMarkAfter } from "../../src/state/index.ts";
import { frame } from "./events.ts";

const NOW = Date.parse("2026-10-08T09:00:00.000+08:00");

function device(id: string, overrides: Partial<PairedDevice> = {}): PairedDevice {
  return {
    id,
    name: id,
    from: "经隧道 · 203.0.113.24",
    pairedAt: "2026-10-01T09:00:00.000+08:00",
    activated: true,
    lastUsedAt: "2026-10-07T09:00:00.000+08:00",
    expiresAt: "2027-10-07T09:00:00.000+08:00",
    revoked: false,
    ...overrides,
  };
}

describe("已配对设备", () => {
  test("有效的按最近使用排在前面；吊销的和凭证过期的放进失效的一组（按失效的时间，新的在前）", () => {
    const state = replay([
      frame("devices", 1, "device", { device: device("d-old", { lastUsedAt: "2026-10-02T09:00:00.000+08:00" }), change: "used" }),
      frame("devices", 2, "device", { device: device("d-new"), change: "used" }),
      frame("devices", 3, "device", { device: device("d-gone", { expiresAt: "2026-10-08T08:59:59.000+08:00" }), change: "used" }),
      frame("devices", 4, "device", { device: device("d-lost", { revoked: true, revokedAt: "2026-10-07T10:00:00.000+08:00" }), change: "revoked" }),
    ]);
    const { active, inactive } = pairedDevices(state, NOW);
    expect(active.map((d) => d.id)).toEqual(["d-new", "d-old"]);
    expect(inactive.map((d) => [d.device.id, d.reason])).toEqual([
      ["d-gone", "expired"],
      ["d-lost", "revoked"],
    ]);
  });

  test("领到凭证、还没用过的设备在有效的一组里（界面标\"等待首次使用\"）；到期还没用过就进失效的一组，原因是一直没用过", () => {
    const waiting = device("d-waiting", { activated: false, pairedAt: "2026-10-08T08:00:00.000+08:00", lastUsedAt: "2026-10-08T08:00:00.000+08:00", expiresAt: "2026-10-09T08:00:00.000+08:00" });
    const lost = device("d-lost", { activated: false, pairedAt: "2026-10-07T08:00:00.000+08:00", lastUsedAt: "2026-10-07T08:00:00.000+08:00", expiresAt: "2026-10-08T08:00:00.000+08:00" });
    const state = replay([frame("devices", 1, "device", { device: waiting, change: "paired" }), frame("devices", 2, "device", { device: lost, change: "paired" })]);
    const { active, inactive } = pairedDevices(state, NOW);
    expect(active).toEqual([waiting]);
    expect(inactive).toEqual([{ device: lost, reason: "never_used" }]);
    // 第一次带着凭证来：启用
    const used = replay([{ kind: "frame", frame: frame("devices", 3, "device", { device: { ...waiting, activated: true }, change: "activated" }) }], state);
    expect(pairedDevices(used, NOW).active).toEqual([{ ...waiting, activated: true }]);
  });

  test("使用（续期）：同一台设备的新状态换掉旧的", () => {
    const state = replay([
      frame("devices", 1, "device", { device: device("d1"), change: "activated" }),
      frame("devices", 2, "device", { device: device("d1", { lastUsedAt: "2026-10-08T08:00:00.000+08:00" }), change: "used" }),
    ]);
    expect(pairedDevices(state, NOW).active).toEqual([device("d1", { lastUsedAt: "2026-10-08T08:00:00.000+08:00" })]);
  });

  test("重新同步已配对设备频道：清掉，等服务端从头补发", () => {
    const state = replay([frame("devices", 1, "device", { device: device("d1"), change: "paired" }), { kind: "resync", channel: "devices" }]);
    expect(pairedDevices(state, NOW)).toEqual({ active: [], inactive: [] });
    expect(state.cursors.devices).toBeUndefined();
  });

  test("连接被告知这台设备的凭证失效了：连接状态是 unpaired，带着知道的原因；重新连上之后原因清掉", () => {
    const revoked = replay([{ kind: "connection", status: "online" }, { kind: "connection", status: "unpaired", reason: "revoked" }]);
    expect([revoked.connection, revoked.unpairedReason]).toEqual(["unpaired", "revoked"]);
    const unknown = replay([{ kind: "connection", status: "unpaired" }]);
    expect([unknown.connection, unknown.unpairedReason]).toEqual(["unpaired", undefined]);
    expect(replay([{ kind: "connection", status: "online" }], revoked).unpairedReason).toBeUndefined();
  });
});

describe("配对等待页的开场", () => {
  test("新设备（没有原因、没有记号）自动发起配对请求；知道被吊销了、或者浏览器里有记号，就不自动申请", () => {
    expect(pairingOpening(undefined, false)).toBe("request");
    expect(pairingOpening("revoked", false)).toBe("revoked");
    expect(pairingOpening(undefined, true)).toBe("revoked");
    expect(pairingOpening("expired", false)).toBe("expired");
    expect(pairingOpening("expired", true)).toBe("revoked");
  });

  test("记号：知道被吊销了就留下，之后只回 none 也留着；重新被信任了就擦掉；过期不留记号", () => {
    expect(revokedMarkAfter({ access: "none", reason: "revoked" }, false)).toBe(true);
    expect(revokedMarkAfter({ access: "none" }, true)).toBe(true);
    expect(revokedMarkAfter({ access: "none" }, false)).toBe(false);
    expect(revokedMarkAfter({ access: "none", reason: "expired" }, false)).toBe(false);
    expect(revokedMarkAfter({ access: "device", device: { id: "d1", name: "我的手机" } }, true)).toBe(false);
    expect(revokedMarkAfter({ access: "local" }, true)).toBe(false);
  });
});
