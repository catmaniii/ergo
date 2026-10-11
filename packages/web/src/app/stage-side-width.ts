// 宽屏长程任务的阶段栏拖到多宽（91 号票）在浏览器里的那一半：读写这台设备记住的宽度（localStorage），改了马上告诉界面。
// 默认 320；拖回 320 就擦掉记号（回到默认）。存储用不了时按默认，改了只在这次打开里生效。写法照阶段栏开合（stage-side-setting.ts）。
// 认不认记住的值、拖的范围在 state/task-page.ts（stageSideWidthOf、dragStageSideWidth）。页面上用的那一个在 app/page-stage-side.ts。
// AgentSense 不记（刷新回 320），这是主会话建议的偏离，合并前要用户点头（91 号票"取舍"）。
import { STAGE_SIDE_WIDTH_INITIAL, stageSideWidthOf } from "../state/index.ts";
import type { DeviceStorage } from "./device-storage.ts";

/** 记在 localStorage 里的键 */
const STAGE_SIDE_WIDTH_KEY = "ergou-stage-side-width";

export interface StageSideWidthSetting {
  width(): number;
  /** 改了马上生效，并记在这台设备上（记整数） */
  set(width: number): void;
  /** 改了时通知界面；返回退订 */
  subscribe(listener: () => void): () => void;
}

/** storage 取不到（隐私模式、禁用了站点数据）时抛错 */
export function stageSideWidthSettingIn(storage: () => DeviceStorage): StageSideWidthSetting {
  let width: number;
  try {
    width = stageSideWidthOf(storage().getItem(STAGE_SIDE_WIDTH_KEY));
  } catch {
    width = STAGE_SIDE_WIDTH_INITIAL;
  }
  const listeners = new Set<() => void>();
  return {
    width: () => width,
    set(next) {
      if (next === width) return;
      width = next;
      try {
        const kept = Math.round(next);
        if (kept === STAGE_SIDE_WIDTH_INITIAL) storage().removeItem(STAGE_SIDE_WIDTH_KEY);
        else storage().setItem(STAGE_SIDE_WIDTH_KEY, String(kept));
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
