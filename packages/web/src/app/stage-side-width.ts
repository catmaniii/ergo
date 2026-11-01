// 宽屏一条侧栏拖到多宽（做长程任务的阶段栏时写的，阶段栏没了）在浏览器里的那一半：读写这台设备记住的宽度（localStorage），改了马上告诉界面。
// 拖回初值就擦掉记号（回到默认）。存储用不了时按默认，改了只在这次打开里生效。写法照栏的开合（stage-side-setting.ts）。
// 宽屏的档案栏（PROJECT_SIDE_WIDTH，页面上那一个在 app/page-project-wall.ts）。
// 宽屏浏览侧边栏拖到多宽也是这个做法、自己的键和初值（BROWSE_SIDE_WIDTH，在浏览插件的 plugins/browsing/browse-side.ts，
// 页面上那一个在 plugins/browsing/page-browse.ts）。
import { PROJECT_SIDE_WIDTH_INITIAL, projectSideWidthOf } from "../state/index.ts";
import type { DeviceStorage } from "./device-storage.ts";

/** 一条栏的宽度记在哪个键、初值多少（拖回初值就擦掉）、记住的值怎么认 */
export interface SideWidthSpec {
  readonly key: string;
  readonly initial: number;
  parse(raw: string | null): number;
}

/** 宽屏项目的档案栏 */
export const PROJECT_SIDE_WIDTH: SideWidthSpec = { key: "ergo-project-side-width", initial: PROJECT_SIDE_WIDTH_INITIAL, parse: projectSideWidthOf };

export interface StageSideWidthSetting {
  width(): number;
  /** 改了马上生效，并记在这台设备上（记整数） */
  set(width: number): void;
  /** 改了时通知界面；返回退订 */
  subscribe(listener: () => void): () => void;
}

/** storage 取不到（隐私模式、禁用了站点数据）时抛错 */
export function stageSideWidthSettingIn(storage: () => DeviceStorage, spec: SideWidthSpec): StageSideWidthSetting {
  let width: number;
  try {
    width = spec.parse(storage().getItem(spec.key));
  } catch {
    width = spec.initial;
  }
  const listeners = new Set<() => void>();
  return {
    width: () => width,
    set(next) {
      if (next === width) return;
      width = next;
      try {
        const kept = Math.round(next);
        if (kept === spec.initial) storage().removeItem(spec.key);
        else storage().setItem(spec.key, String(kept));
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
