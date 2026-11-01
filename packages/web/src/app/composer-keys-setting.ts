// 设置里的"发送和换行"在浏览器里的那一半：读写这台设备上记住的换行键。
// 默认 Ctrl；只在选了 Shift 时留一个记号，选回 Ctrl 就擦掉。存储用不了时按默认，改了只在这次打开里生效。
// 认不认记住的值在 state/composer-keys.ts（newlineKeyOf）。页面上用的那一个在 app/page-composer-keys.ts。
import { type NewlineKey, newlineKeyOf } from "../state/index.ts";
import type { DeviceStorage } from "./device-storage.ts";

/** 记在 localStorage 里的键 */
const NEWLINE_KEY = "ergo-composer-newline";

export interface NewlineKeySetting {
  key(): NewlineKey;
  /** 改了马上生效，并记在这台设备上 */
  set(next: NewlineKey): void;
  /** 改了时通知界面；返回退订 */
  subscribe(listener: () => void): () => void;
}

/** storage 取不到（隐私模式、禁用了站点数据）时抛错 */
export function newlineKeySettingIn(storage: () => DeviceStorage): NewlineKeySetting {
  let current: NewlineKey;
  try {
    current = newlineKeyOf(storage().getItem(NEWLINE_KEY));
  } catch {
    current = "ctrl";
  }
  const listeners = new Set<() => void>();
  return {
    key: () => current,
    set(next) {
      current = next;
      try {
        if (next === "ctrl") storage().removeItem(NEWLINE_KEY);
        else storage().setItem(NEWLINE_KEY, next);
      } catch {
        // 存不了：这次打开里照样生效，下次打开回到默认
      }
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
