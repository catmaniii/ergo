// 设置列表四组的收起 / 展开（247 号票）在页面上的那一份：把 board-fold-setting.ts 的 SETTINGS_FOLD 接到 localStorage 上，给界面一个 hook。
// 单独一个文件，那个模块就不碰浏览器的全局变量，能在 Node 里测（写法照 page-board-fold.ts、page-project-wall.ts）。
// 宽屏左栏、窄屏整页、"更多"里收进来的设置画的都是这一个，收起了哪几组一起变。
import { useSyncExternalStore } from "react";
import type { SettingsGroupId } from "../state/index.ts";
import { settingsFoldSettingIn, type SettingsFoldSetting } from "./board-fold-setting.ts";

let setting: SettingsFoldSetting | undefined;

/** 整个页面共用的一份 */
export function pageSettingsFold(): SettingsFoldSetting {
  setting ??= settingsFoldSettingIn(() => window.localStorage);
  return setting;
}

/** 现在收起了哪几组，改了跟着变 */
export function useSettingsFolded(): ReadonlySet<SettingsGroupId> {
  const s = pageSettingsFold();
  return useSyncExternalStore(s.subscribe, s.folded);
}
