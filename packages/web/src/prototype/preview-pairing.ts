// 原型：配对等待页的预览用的假配对接口（设置 · 已配对设备里的"预览"，以及 file:// 打开时）。
// 不连守护进程：短码、短指纹本地随机生成，"原型：模拟已批准"直接把状态改成已配对。
import type { PairingApi } from "../app/pairing-flow.ts";
import {
  DEVICE_NAME_MAX_LENGTH,
  defaultDeviceName,
  normalizeDeviceName,
  PAIRING_FINGERPRINT_HEX_DIGITS,
  PAIRING_REQUEST_TTL_MS,
  PAIRING_SHORT_CODE_DIGITS,
  type PairingRequestView,
} from "../state/index.ts";
import { nowIso } from "../util/time.ts";

function randomDigits(n: number): string {
  const a = new Uint32Array(n);
  globalThis.crypto?.getRandomValues?.(a);
  return Array.from(a, (x, i) => String((x || Math.floor(Math.random() * 1e9) + i) % 10)).join("");
}

function randomHex(n: number): string {
  const a = new Uint8Array(Math.ceil(n / 2));
  globalThis.crypto?.getRandomValues?.(a);
  return Array.from(a, (x) => (x || Math.floor(Math.random() * 256)).toString(16).padStart(2, "0"))
    .join("")
    .slice(0, n);
}

export function previewPairingApi(userAgent: string): PairingApi {
  let request: PairingRequestView | undefined;
  return {
    current: async () => request,
    create: async (deviceName) => {
      request = {
        id: `pr-preview-${randomHex(6)}`,
        status: "pending",
        deviceName: (deviceName === undefined ? undefined : normalizeDeviceName(deviceName)) ?? defaultDeviceName(userAgent).slice(0, DEVICE_NAME_MAX_LENGTH),
        shortCode: randomDigits(PAIRING_SHORT_CODE_DIGITS),
        fingerprint: randomHex(PAIRING_FINGERPRINT_HEX_DIGITS),
        expiresAt: nowIso(new Date(Date.now() + PAIRING_REQUEST_TTL_MS)),
      };
      return request;
    },
    rename: async (deviceName) => {
      const name = normalizeDeviceName(deviceName);
      if (!request || name === undefined) throw new Error("设备名不能为空，也不能太长");
      request = { ...request, deviceName: name };
      return request;
    },
    simulateApproval: () => {
      if (request) request = { ...request, status: "paired" };
    },
  };
}
