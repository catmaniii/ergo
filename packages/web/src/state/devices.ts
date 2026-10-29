// 已配对设备的视图（纯函数）：设置里的"已配对设备"。
// - 有效的（没吊销、凭证没过期）按最近使用排，新的在前；其中还没启用的（领到凭证后还没带着它来过）界面上标"等待首次使用"；
// - 失效的单列一组：被吊销的；启用之后连续 365 天没用、凭证过期的；领到凭证后 24 小时里一次也没用过、自动作废的
//   （领取的响应丢了，凭证没到设备手里）。过期由服务端判断，这里按 expiresAt 和传进来的"现在"算，只用于显示。
//   PC 本机直接用，不在这里。
// 123 号票：过期、作废的延期后 expiresAt 往后推，回到有效的一组；删了的状态层里就没有（ui-state.ts 收到 deleted 时去掉）。
// 多选管理的个数、确认的话在 device-select.ts。
import type { PairedDevice } from "./protocol.ts";
import type { UiState } from "./ui-state.ts";

/** 失效的原因：被吊销、启用之后太久没用、领到之后一直没用过 */
export type InactiveReason = "revoked" | "expired" | "never_used";

export interface InactiveDevice {
  device: PairedDevice;
  reason: InactiveReason;
}

export interface PairedDevices {
  active: PairedDevice[];
  inactive: InactiveDevice[];
}

/** 新的在前 */
const newestFirst = (a: string, b: string) => Date.parse(b) - Date.parse(a);

/** 已配对设备，分成有效的和失效的；now 是现在（毫秒） */
export function pairedDevices(state: UiState, now: number): PairedDevices {
  const active: PairedDevice[] = [];
  const inactive: InactiveDevice[] = [];
  for (const device of Object.values(state.devices)) {
    if (device.revoked) inactive.push({ device, reason: "revoked" });
    else if (Date.parse(device.expiresAt) <= now) inactive.push({ device, reason: device.activated ? "expired" : "never_used" });
    else active.push(device);
  }
  return {
    active: active.toSorted((a, b) => newestFirst(a.lastUsedAt, b.lastUsedAt)),
    inactive: inactive.toSorted((a, b) => newestFirst(a.device.revokedAt ?? a.device.expiresAt, b.device.revokedAt ?? b.device.expiresAt)),
  };
}
