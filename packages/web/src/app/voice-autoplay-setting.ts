// 设置里的"自动播放 agent 的语音"开关（36 号票）在浏览器里的那一半：读写这台设备记住的值（localStorage），改了马上告诉界面。
// 默认开；只在关掉时留一个记号，打开就擦掉（回到默认）。存储用不了时按默认，改了只在这次打开里生效。
// 认不认记住的值在 state/voice-autoplay.ts（autoplaySettingOf）。页面上用的那一个在 app/page-voice.ts。
import { autoplaySettingOf } from "../state/index.ts";
import type { DeviceStorage } from "./device-storage.ts";

/** 记在 localStorage 里的键 */
const AUTOPLAY_KEY = "ergo-voice-autoplay";

export interface AutoplaySetting {
  enabled(): boolean;
  /** 改了马上生效，并记在这台设备上 */
  set(enabled: boolean): void;
  /** 改了时通知界面；返回退订 */
  subscribe(listener: () => void): () => void;
}

/** storage 取不到（隐私模式、禁用了站点数据）时抛错 */
export function autoplaySettingIn(storage: () => DeviceStorage): AutoplaySetting {
  let enabled: boolean;
  try {
    enabled = autoplaySettingOf(storage().getItem(AUTOPLAY_KEY));
  } catch {
    enabled = true;
  }
  const listeners = new Set<() => void>();
  return {
    enabled: () => enabled,
    set(next) {
      enabled = next;
      try {
        if (next) storage().removeItem(AUTOPLAY_KEY);
        else storage().setItem(AUTOPLAY_KEY, "off");
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
