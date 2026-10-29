// 前端状态层：已配对设备的多选管理（123 号票）——按钮上的个数、交上去哪几台、确认弹窗（延期弹窗）上的话、做完之后底部的一句。
import { describe, expect, test } from "vitest";
import {
  type DeviceBatchItemResult,
  deviceActPrompt,
  deviceBatchCounts,
  deviceBatchTargets,
  deviceBatchToast,
  DEVICE_EXTEND_CHOICES,
  type PairedDevice,
} from "../../src/state/index.ts";

const NOW = Date.parse("2026-10-14T09:00:00.000+08:00");
const DAY = 24 * 3600_000;

function device(id: string, overrides: Partial<PairedDevice> = {}): PairedDevice {
  return {
    id,
    name: id,
    from: "经隧道 · 203.0.113.24",
    pairedAt: "2026-10-01T09:00:00.000+08:00",
    activated: true,
    lastUsedAt: "2026-10-13T09:00:00.000+08:00",
    expiresAt: "2027-10-13T09:00:00.000+08:00",
    revoked: false,
    ...overrides,
  };
}

const valid = device("手机");
const waiting = device("新电脑", { activated: false, pairedAt: "2026-10-14T08:00:00.000+08:00", lastUsedAt: "2026-10-14T08:00:00.000+08:00", expiresAt: "2026-10-15T08:00:00.000+08:00" });
const expired = device("抽屉里的平板", { lastUsedAt: "2025-09-01T09:00:00.000+08:00", expiresAt: "2026-09-01T09:00:00.000+08:00" });
const voided = device("丢了响应的笔记本", { activated: false, pairedAt: "2026-10-10T09:00:00.000+08:00", lastUsedAt: "2026-10-10T09:00:00.000+08:00", expiresAt: "2026-10-11T09:00:00.000+08:00" });
const revoked = device("旧电脑", { revoked: true, revokedAt: "2026-10-12T09:00:00.000+08:00" });

describe("按钮上的个数和交上去的", () => {
  test("有效的、等待首次使用的、过期的、作废的三样都能做；吊销了的只能删除", () => {
    expect(deviceBatchCounts([valid, waiting, expired, voided, revoked])).toEqual({ extend: 4, revoke: 4, delete: 5 });
    expect(deviceBatchCounts([revoked])).toEqual({ extend: 0, revoke: 0, delete: 1 });
    expect(deviceBatchCounts([])).toEqual({ extend: 0, revoke: 0, delete: 0 });
  });

  test("交上去的只有能做的，跳过的按原因数", () => {
    expect(deviceBatchTargets([valid, revoked, expired], "extend")).toEqual({ ids: ["手机", "抽屉里的平板"], skips: { revoked: 1 } });
    expect(deviceBatchTargets([valid, revoked], "delete")).toEqual({ ids: ["手机", "旧电脑"], skips: {} });
  });

  test("延期能选 30 天、90 天、1 年", () => {
    expect(DEVICE_EXTEND_CHOICES.map((c) => [c.days, c.label])).toEqual([
      [30, "30 天"],
      [90, "90 天"],
      [365, "1 年"],
    ]);
  });
});

describe("确认弹窗上的话", () => {
  test("延期一台：写延期到哪天（从原到期日和今天里晚的那天起算）", () => {
    expect(deviceActPrompt([valid], "extend", NOW, undefined, 90)).toEqual({ title: "延期「手机」", lines: ["凭证延期到 2028-01-11。"], confirm: "延期" });
    // 过期的从今天起算，延期后重新能用
    expect(deviceActPrompt([expired], "extend", NOW, undefined, 30).lines).toEqual(["凭证延期到 2026-11-13。", "它已经失效了，延期后会重新能用。"]);
  });

  test("延期几台：其中几台已失效、延期后会重新能用；吊销了的跳过", () => {
    expect(deviceActPrompt([valid, expired, voided, revoked], "extend", NOW, undefined, 365)).toEqual({
      title: "延期 3 台",
      lines: ["每台从原到期日和今天里晚的那天往后推。", "其中 2 台已失效，延期后会重新能用。", "另外 1 台已经吊销了，不能延期，跳过。"],
      confirm: "延期",
    });
  });

  test("吊销：凭证立刻失效、页面马上断开；包括正在用的这台时单独写一句", () => {
    expect(deviceActPrompt([valid], "revoke", NOW, undefined)).toEqual({
      title: "吊销「手机」？",
      lines: ["凭证立刻失效，开着的页面马上断开，下次打开要重新配对；吊销了就不能再延期。"],
      confirm: "吊销",
    });
    expect(deviceActPrompt([valid, waiting, revoked], "revoke", NOW, "手机")).toEqual({
      title: "吊销 2 台？",
      lines: [
        "凭证立刻失效，开着的页面马上断开，下次打开要重新配对；吊销了就不能再延期。",
        "包括你正在用的这台，做完这个页面会断开，要重新配对。",
        "另外 1 台已经吊销了，跳过。",
      ],
      confirm: "吊销",
    });
  });

  test("删除：还有效的先吊销、马上断开；过期的、吊销了的直接删", () => {
    expect(deviceActPrompt([valid, waiting, expired, revoked], "delete", NOW, "新电脑")).toEqual({
      title: "删除 4 台？",
      lines: ["从列表里去掉，凭证不再认；事件日志里的记录留着。", "其中 2 台还有效，会先吊销、马上断开。", "包括你正在用的这台，做完这个页面会断开，要重新配对。"],
      confirm: "删除",
    });
    expect(deviceActPrompt([revoked], "delete", NOW, undefined)).toEqual({ title: "删除「旧电脑」？", lines: ["从列表里去掉，凭证不再认；事件日志里的记录留着。"], confirm: "删除" });
    expect(deviceActPrompt([valid], "delete", NOW, undefined).lines).toEqual(["从列表里去掉，凭证不再认；事件日志里的记录留着。", "它还有效，会先吊销、马上断开。"]);
  });
});

/** 做了的一台 */
const done = (id: string): DeviceBatchItemResult => ({ deviceId: id, ok: true, device: device(id, { expiresAt: new Date(NOW + 30 * DAY).toISOString() }) });

describe("做完之后页面底部的一句", () => {
  test("都做了：不说（列表上看得到）", () => {
    expect(deviceBatchToast("extend", {}, [done("手机"), done("平板")])).toBeUndefined();
  });

  test("有跳过的（这边先剔掉的、守护进程回来说跳过的）：说做了几台、跳过几台、各为什么", () => {
    const results: DeviceBatchItemResult[] = [done("手机"), { deviceId: "平板", ok: false, skip: "deleted", message: "这台设备已经删除了" }];
    expect(deviceBatchToast("extend", { revoked: 2 }, results)).toBe("延期 1 台；跳过 3 台：2 台已经吊销了，不能延期；1 台已经删除了");
    expect(deviceBatchToast("revoke", { revoked: 1 }, [])).toBe("吊销 0 台；跳过 1 台：1 台已经吊销了");
  });
});
