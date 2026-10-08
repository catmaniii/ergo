// 浏览器里"本设备已被吊销"的记号（规格第 6 节；什么时候留、什么时候擦，以及它怎么决定配对等待页的开场，见
// state/pairing-gate.ts）。放在 localStorage 里，不敏感：只有一个固定的值，不含设备 id 和凭证。
// 存不了、读不了（隐私模式、禁用了站点数据）就当没有：刷新后按新设备开场，自动发起一个配对请求。
import type { DeviceStorage } from "./device-storage.ts";

const KEY = "ergou-device-revoked";

export interface RevokedMark {
  get(): boolean;
  set(marked: boolean): void;
}

export function revokedMarkIn(storage: () => DeviceStorage): RevokedMark {
  return {
    get() {
      try {
        return storage().getItem(KEY) === "1";
      } catch {
        return false;
      }
    },
    set(marked) {
      try {
        if (marked) storage().setItem(KEY, "1");
        else storage().removeItem(KEY);
      } catch {
        // 存不了：刷新后按新设备开场
      }
    },
  };
}

export const revokedMark: RevokedMark = revokedMarkIn(() => globalThis.localStorage);
