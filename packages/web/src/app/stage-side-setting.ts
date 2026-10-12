// 宽屏长程任务的阶段栏开着还是藏掉（88 号票）在浏览器里的那一半：读写这台设备记住的值（localStorage），改了马上告诉界面。
// 默认开着；只在藏掉时留一个记号，打开就擦掉（回到默认）。存储用不了时按默认，改了只在这次打开里生效。写法照"自动播放 agent 的语音"
// （voice-autoplay-setting.ts）。认不认记住的值在 state/task-page.ts（stageSidePrefOf）。页面上用的那一个在 app/page-stage-side.ts。
// 104 号票宽屏项目的档案栏开合同一个做法、另一个键（PROJECT_SIDE_KEY，页面上那一个在 app/page-project-wall.ts）。
import { type StageSidePref, stageSidePrefOf } from "../state/index.ts";
import type { DeviceStorage } from "./device-storage.ts";

/** 记在 localStorage 里的键 */
const STAGE_SIDE_KEY = "ergou-stage-side";

/** 宽屏项目的档案栏（104 号票）：和长程任务的阶段栏分开记 */
export const PROJECT_SIDE_KEY = "ergou-project-side";

export interface StageSideSetting {
  pref(): StageSidePref;
  /** 改了马上生效，并记在这台设备上 */
  set(pref: StageSidePref): void;
  /** 改了时通知界面；返回退订 */
  subscribe(listener: () => void): () => void;
}

/** storage 取不到（隐私模式、禁用了站点数据）时抛错；key 不给是长程任务的阶段栏 */
export function stageSideSettingIn(storage: () => DeviceStorage, key = STAGE_SIDE_KEY): StageSideSetting {
  let pref: StageSidePref;
  try {
    pref = stageSidePrefOf(storage().getItem(key));
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
        if (next === "open") storage().removeItem(key);
        else storage().setItem(key, next);
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
