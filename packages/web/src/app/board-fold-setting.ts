// 看板分组收起 / 展开（90 号票）在浏览器里的那一半：读写这台设备记住的值（localStorage），改了马上告诉界面。
// 默认"已归档"收起、其它展开；和默认一样时不留记号。存储用不了时按默认，改了只在这次打开里生效。写法照阶段栏开合（stage-side-setting.ts）。
// 认不认记住的值在 state/board-fold.ts（boardFoldedOf）。页面上用的那一个在 app/page-board-fold.ts。
// 104 号票的项目一览分组同一个做法、另一个键（foldSettingIn + PROJECT_FOLD，页面上那一个在 app/page-project-wall.ts）。
// 247 号票的设置列表四组也是同一个做法、第三个键（SETTINGS_FOLD：四组默认都展开，页面上那一个在 app/page-settings-fold.ts）。
import {
  type BoardGroup,
  boardFoldedOf,
  boardFoldedText,
  type ProjectGroup,
  projectFoldedOf,
  projectFoldedText,
  type SettingsGroupId,
  settingsFoldedOf,
  settingsFoldedText,
  toggleFolded,
} from "../state/index.ts";
import type { DeviceStorage } from "./device-storage.ts";

export interface FoldSetting<G extends string> {
  folded(): ReadonlySet<G>;
  /** 点一下这一组的标题：改了马上生效，并记在这台设备上 */
  toggle(group: G): void;
  /** 改了时通知界面；返回退订 */
  subscribe(listener: () => void): () => void;
}

export type BoardFoldSetting = FoldSetting<BoardGroup>;

/** 设置列表的四组（247 号票）：和任务看板、项目一览分开记 */
export type SettingsFoldSetting = FoldSetting<SettingsGroupId>;

/** 一种分组收起记在哪个键、怎么认、怎么写 */
export interface FoldSpec<G extends string> {
  readonly key: string;
  parse(raw: string | null): ReadonlySet<G>;
  /** 和默认一样时是 undefined（擦掉） */
  text(folded: ReadonlySet<G>): string | undefined;
}

/** 任务看板（90 号票） */
export const BOARD_FOLD: FoldSpec<BoardGroup> = { key: "ergo-board-folded", parse: boardFoldedOf, text: boardFoldedText };

/** 项目一览（104 号票）：和任务看板分开记 */
export const PROJECT_FOLD: FoldSpec<ProjectGroup> = { key: "ergo-project-folded", parse: projectFoldedOf, text: projectFoldedText };

/** 设置列表的四组（247 号票）：和看板、项目一览分开记 */
export const SETTINGS_FOLD: FoldSpec<SettingsGroupId> = { key: "ergo-settings-folded", parse: settingsFoldedOf, text: settingsFoldedText };

/** storage 取不到（隐私模式、禁用了站点数据）时抛错 */
export function foldSettingIn<G extends string>(storage: () => DeviceStorage, spec: FoldSpec<G>): FoldSetting<G> {
  let folded: ReadonlySet<G>;
  try {
    folded = spec.parse(storage().getItem(spec.key));
  } catch {
    folded = spec.parse(null);
  }
  const listeners = new Set<() => void>();
  return {
    folded: () => folded,
    toggle(group) {
      folded = toggleFolded(folded, group);
      const text = spec.text(folded);
      try {
        if (text === undefined) storage().removeItem(spec.key);
        else storage().setItem(spec.key, text);
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

/** 任务看板的那一份 */
export function boardFoldSettingIn(storage: () => DeviceStorage): BoardFoldSetting {
  return foldSettingIn(storage, BOARD_FOLD);
}

/** 设置列表四组的那一份（247 号票，页面上用的见 app/page-settings-fold.ts） */
export function settingsFoldSettingIn(storage: () => DeviceStorage): SettingsFoldSetting {
  return foldSettingIn(storage, SETTINGS_FOLD);
}
