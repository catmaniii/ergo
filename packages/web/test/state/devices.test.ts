// 前端状态层：已配对设备（设置里的"已配对设备"）和配对等待页的开场。主线流程回放主切面录下的 device-revoke 和
// device-revoked-here、device-batch（recorded.test.ts）；这里是手写的边角：凭证过期的设备、领到之后一直没用过的设备、
// 延期和删除（123 号票）、重新同步、连接被告知凭证失效、浏览器里"本设备已被吊销"的记号。
// 137 号票：配对页是哪一页（说明页、等批准、领凭证、已配对）、说明页上说哪一句——点了"请求配对"才发请求。
import { describe, expect, test } from "vitest";
import {
  type PairedDevice,
  pairedDevices,
  type PairingRequestView,
  pairingIntroNote,
  pairingOpening,
  pairingStage,
  replay,
  revokedMarkAfter,
} from "../../src/state/index.ts";
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

  test("延期（123 号票）：过期、作废了的延期后回到有效的一组；同一台的新状态换掉旧的", () => {
    const gone = device("d-gone", { expiresAt: "2026-10-08T08:59:59.000+08:00" });
    const lost = device("d-lost", { activated: false, expiresAt: "2026-10-08T08:00:00.000+08:00" });
    const state = replay([frame("devices", 1, "device", { device: gone, change: "used" }), frame("devices", 2, "device", { device: lost, change: "paired" })]);
    expect(pairedDevices(state, NOW).inactive.map((d) => d.reason)).toEqual(["expired", "never_used"]);
    const extendedAt = "2026-10-08T09:00:00.000+08:00";
    const later = replay(
      [
        frame("devices", 3, "device", { device: { ...gone, expiresAt: "2026-11-07T09:00:00.000+08:00", extendedAt }, change: "extended" }),
        frame("devices", 4, "device", { device: { ...lost, expiresAt: "2026-11-07T09:00:00.000+08:00", extendedAt }, change: "extended" }),
      ].map((f) => ({ kind: "frame" as const, frame: f })),
      state,
    );
    expect(pairedDevices(later, NOW)).toEqual({
      active: [
        { ...gone, expiresAt: "2026-11-07T09:00:00.000+08:00", extendedAt },
        { ...lost, expiresAt: "2026-11-07T09:00:00.000+08:00", extendedAt },
      ],
      inactive: [],
    });
  });

  test("删除（123 号票）：删了的不出现，有效的、失效的都一样", () => {
    const deletedAt = "2026-10-08T08:30:00.000+08:00";
    const state = replay([
      frame("devices", 1, "device", { device: device("d1"), change: "used" }),
      frame("devices", 2, "device", { device: device("d2"), change: "used" }),
      frame("devices", 3, "device", { device: device("d3", { revoked: true, revokedAt: deletedAt }), change: "revoked" }),
      frame("devices", 4, "device", { device: device("d2", { revoked: true, revokedAt: deletedAt }), change: "revoked" }),
      frame("devices", 5, "device", { device: device("d2", { revoked: true, revokedAt: deletedAt, deletedAt }), change: "deleted" }),
      frame("devices", 6, "device", { device: device("d3", { revoked: true, revokedAt: deletedAt, deletedAt }), change: "deleted" }),
    ]);
    expect(pairedDevices(state, NOW)).toEqual({ active: [device("d1")], inactive: [] });
    expect(Object.keys(state.devices)).toEqual(["d1"]);
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
  test("新设备（没有原因、没有记号）是新设备的说明页；知道被吊销了、或者浏览器里有记号，说明页上写\"此设备已被吊销\"", () => {
    expect(pairingOpening(undefined, false)).toBe("new");
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

/** 新设备这一侧看到的配对请求（5 分钟后过期） */
const request = (overrides: Partial<PairingRequestView> = {}): PairingRequestView => ({
  id: "pr-1",
  status: "pending",
  deviceName: "Chrome · Linux",
  shortCode: "482913",
  fingerprint: "9f3ac21e",
  expiresAt: new Date(NOW + 5 * 60_000).toISOString(),
  ...overrides,
});

describe("配对页是哪一页（137 号票：点了\"请求配对\"才发请求）", () => {
  test("还没有请求：说明页（不自动发）；有在等的请求（刷新了页面）：接着等；已批准：领凭证；已配对", () => {
    expect(pairingStage(undefined, NOW)).toBe("intro");
    expect(pairingStage(request(), NOW)).toBe("waiting");
    expect(pairingStage(request({ status: "approved" }), NOW)).toBe("claiming");
    expect(pairingStage(request({ status: "paired" }), NOW)).toBe("paired");
  });

  test("过期、被拒：回到说明页，等再点一次；按时间算已经过期的（计时器还没落事件）也一样", () => {
    expect(pairingStage(request({ status: "expired" }), NOW)).toBe("intro");
    expect(pairingStage(request({ status: "denied" }), NOW)).toBe("intro");
    expect(pairingStage(request(), NOW + 5 * 60_000)).toBe("intro");
  });

  test("说明页上说哪一句：上一个请求被拒、过期优先；没有请求时按开场（被吊销、凭证过期）；新设备不多说", () => {
    expect(pairingIntroNote("new", undefined, NOW)).toBeUndefined();
    expect(pairingIntroNote("revoked", undefined, NOW)).toBe("revoked");
    expect(pairingIntroNote("expired", undefined, NOW)).toBe("credential_expired");
    expect(pairingIntroNote("revoked", request({ status: "denied" }), NOW)).toBe("denied");
    expect(pairingIntroNote("new", request({ status: "expired" }), NOW)).toBe("expired");
    expect(pairingIntroNote("new", request(), NOW + 5 * 60_000)).toBe("expired");
  });
});
