// 已配对设备的多选管理（纯函数，123 号票）：设置 · 已配对设备里勾几台（"已配对""已失效"两组都能勾，全选按组来），
// 底部操作栏"已选 N 台 · 延期 · 吊销 · 删除 · 完成"；不进多选时每一行的"⋯"菜单单独做这三件事，走的是同一套。
// - 能对哪几台做照协议包的 deviceBatchSkip（守护进程判断用的同一份）：有效的、等待首次使用的、过期的、作废的三样都能做，
//   吊销了的只能删除。按钮上写个数，一台都不能做时灰掉；
// - 交上去的只有能做的（守护进程的 device_batch_action 能做的都做、逐台回报），这边先剔掉的和守护进程回来说跳过的
//   合在一起，在页面底部说跳过了几台、为什么（照待办的写法：都做了不说，列表上看得到）；
// - 确认弹窗（延期是选时长的弹窗）上的话：延期写延期到哪天、其中几台已失效（延期后会重新能用），删除写其中几台还有效
//   （会先吊销、马上断开），吊销、删除的选中里有"就是这台"时单独写一句。
import { type DeviceBatchAction, type DeviceBatchItemResult, type DeviceBatchSkip, deviceBatchSkip, DEVICE_EXTEND_DAYS, deviceSkipPhrase, extendedExpiry, localDate, type PairedDevice, t, tTable } from "./protocol.ts";

/** 动作的名字（按钮、菜单、提示） */
export const DEVICE_ACTION_LABEL: Readonly<Record<DeviceBatchAction, string>> = tTable({ extend: "state.deviceSelect.action.extend", revoke: "state.deviceSelect.action.revoke", delete: "state.deviceSelect.action.delete" });

/** 延期弹窗里能选的时长（label 取值时按当前语言现取） */
export const DEVICE_EXTEND_CHOICES: readonly { days: number; label: string }[] = DEVICE_EXTEND_DAYS.map((days) => ({
  days,
  get label() {
    return days === 365 ? t("state.deviceSelect.oneYear") : t("state.deviceSelect.days", { count: days });
  },
}));

/** 跳过的台数，按原因 */
export type DeviceSkips = Partial<Record<DeviceBatchSkip, number>>;

/** 还有效（没吊销、没到期）：显示在"已配对"一组里的 */
const isActive = (d: PairedDevice, now: number) => !d.revoked && Date.parse(d.expiresAt) > now;

/** 每个按钮能对几台做 */
export function deviceBatchCounts(devices: readonly PairedDevice[]): Record<DeviceBatchAction, number> {
  const count = (action: DeviceBatchAction) => devices.filter((d) => deviceBatchSkip(d, action) === undefined).length;
  return { extend: count("extend"), revoke: count("revoke"), delete: count("delete") };
}

/** 点了一个动作：交上去的（能做的那几台）和这边先跳过的（按原因数） */
export function deviceBatchTargets(devices: readonly PairedDevice[], action: DeviceBatchAction): { ids: string[]; skips: DeviceSkips } {
  const ids: string[] = [];
  const skips: DeviceSkips = {};
  for (const d of devices) {
    const skip = deviceBatchSkip(d, action);
    if (skip === undefined) ids.push(d.id);
    else skips[skip] = (skips[skip] ?? 0) + 1;
  }
  return { ids, skips };
}

/** 确认弹窗（延期弹窗）上的话：标题、几行说明、确认按钮上的字 */
export interface DeviceActPrompt {
  title: string;
  lines: string[];
  confirm: string;
}

/** 正在用的这台要断开的那一句（确认弹窗上单独标出来；170 号票起是函数，按当前语言现取） */
export function deviceSelfLine(): string {
  return t("state.deviceSelect.selfLine");
}

/** 确认框的标题写成问句（"吊销「手机」？"） */
const askTitle = (title: string) => t("state.deviceSelect.ask", { title });

/**
 * 做之前的确认：devices 是选中的（单台的"⋯"菜单就是那一台），now 是现在（毫秒），selfId 是正在用的这台（本机打开时没有），
 * days 是延期弹窗里选着的时长（延期时给）
 */
export function deviceActPrompt(devices: readonly PairedDevice[], action: DeviceBatchAction, now: number, selfId: string | undefined, days?: number): DeviceActPrompt {
  const { ids, skips } = deviceBatchTargets(devices, action);
  const targets = devices.filter((d) => ids.includes(d.id));
  const one = targets.length === 1 && devices.length === 1 ? targets[0] : undefined;
  const label = DEVICE_ACTION_LABEL[action];
  const title = one ? t("state.deviceSelect.titleOne", { action: label, name: one.name }) : t("state.deviceSelect.titleMany", { action: label, count: targets.length });
  const skipLines = Object.entries(skips).map(([skip, n]) => t("state.deviceSelect.skipLine", { count: n, phrase: deviceSkipPhrase(action, skip as DeviceBatchSkip) }));
  const self = selfId !== undefined && ids.includes(selfId) ? [deviceSelfLine()] : [];
  switch (action) {
    case "extend": {
      const revived = targets.filter((d) => !isActive(d, now)).length;
      const when = one ? t("state.deviceSelect.extendTo", { date: localDate(new Date(extendedExpiry(one.expiresAt, now, days ?? 0))) }) : t("state.deviceSelect.extendEach");
      const revive = revived === 0 ? [] : [one ? t("state.deviceSelect.reviveOne") : t("state.deviceSelect.reviveMany", { count: revived })];
      return { title, lines: [when, ...revive, ...skipLines], confirm: label };
    }
    case "revoke":
      return { title: askTitle(title), lines: [t("state.deviceSelect.revokeLine"), ...self, ...skipLines], confirm: label };
    case "delete": {
      const stillValid = targets.filter((d) => isActive(d, now)).length;
      const revokeFirst = stillValid === 0 ? [] : [one ? t("state.deviceSelect.revokeFirstOne") : t("state.deviceSelect.revokeFirstMany", { count: stillValid })];
      return { title: askTitle(title), lines: [t("state.deviceSelect.deleteLine"), ...revokeFirst, ...self, ...skipLines], confirm: label };
    }
  }
}

/**
 * 做完之后页面底部的一句：有跳过的（这边先剔掉的 localSkips，加上守护进程回来说跳过的）才说做了几台、跳过几台、各为什么；
 * 都做了不说（列表上看得到）
 */
export function deviceBatchToast(action: DeviceBatchAction, localSkips: DeviceSkips, results: readonly DeviceBatchItemResult[]): string | undefined {
  const skips: DeviceSkips = { ...localSkips };
  for (const r of results) if (!r.ok) skips[r.skip] = (skips[r.skip] ?? 0) + 1;
  const entries = Object.entries(skips) as [DeviceBatchSkip, number][];
  const skipped = entries.reduce((sum, [, n]) => sum + n, 0);
  if (skipped === 0) return undefined;
  const done = results.filter((r) => r.ok).length;
  const reasons = entries.map(([skip, n]) => t("state.deviceSelect.toastReason", { count: n, phrase: deviceSkipPhrase(action, skip) })).join(t("state.deviceSelect.toastSep"));
  return t("state.deviceSelect.toast", { action: DEVICE_ACTION_LABEL[action], done, skipped, reasons });
}
