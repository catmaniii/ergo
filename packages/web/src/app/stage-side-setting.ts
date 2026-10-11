// 宽屏长程任务的阶段栏开着还是藏掉（88 号票）在浏览器里的那一半：读写这台设备记住的值（localStorage），改了马上告诉界面。
// 默认开着；只在藏掉时留一个记号，打开就擦掉（回到默认）。存储用不了时按默认，改了只在这次打开里生效。写法照"自动播放 agent 的语音"
// （voice-autoplay-setting.ts）。认不认记住的值在 state/task-page.ts（stageSidePrefOf）。页面上用的那一个在 app/page-stage-side.ts。
import { type StageSidePref, stageSidePrefOf } from "../state/index.ts";
import type { DeviceStorage } from "./device-storage.ts";

/** 记在 localStorage 里的键 */
const STAGE_SIDE_KEY = "ergou-stage-side";

export interface StageSideSetting {
  pref(): StageSidePref;
  /** 改了马上生效，并记在这台设备上 */
  set(pref: StageSidePref): void;
  /** 改了时通知界面；返回退订 */
  subscribe(listener: () => void): () => void;
}

/** storage 取不到（隐私模式、禁用了站点数据）时抛错 */
export function stageSideSettingIn(storage: () => DeviceStorage): StageSideSetting {
  let pref: StageSidePref;
  try {
    pref = stageSidePrefOf(storage().getItem(STAGE_SIDE_KEY));
  } catch {
    pref = "open";
  }
  const listeners = new Set<() => void>();
  return {
    pref: () => pref,
    set(next) {
      if (next === pref) return;
      pref = next;
      try {
        if (next === "open") storage().removeItem(STAGE_SIDE_KEY);
        else storage().setItem(STAGE_SIDE_KEY, next);
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
