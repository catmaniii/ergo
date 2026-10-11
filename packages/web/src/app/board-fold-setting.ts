// 看板分组收起 / 展开（90 号票）在浏览器里的那一半：读写这台设备记住的值（localStorage），改了马上告诉界面。
// 默认"已归档"收起、其它展开；和默认一样时不留记号。存储用不了时按默认，改了只在这次打开里生效。写法照阶段栏开合（stage-side-setting.ts）。
// 认不认记住的值在 state/board-fold.ts（boardFoldedOf）。页面上用的那一个在 app/page-board-fold.ts。
import { type BoardGroup, boardFoldedOf, boardFoldedText, toggleBoardGroup } from "../state/index.ts";
import type { DeviceStorage } from "./device-storage.ts";

/** 记在 localStorage 里的键 */
const BOARD_FOLD_KEY = "ergou-board-folded";

export interface BoardFoldSetting {
  folded(): ReadonlySet<BoardGroup>;
  /** 点一下这一组的标题：改了马上生效，并记在这台设备上 */
  toggle(group: BoardGroup): void;
  /** 改了时通知界面；返回退订 */
  subscribe(listener: () => void): () => void;
}

/** storage 取不到（隐私模式、禁用了站点数据）时抛错 */
export function boardFoldSettingIn(storage: () => DeviceStorage): BoardFoldSetting {
  let folded: ReadonlySet<BoardGroup>;
  try {
    folded = boardFoldedOf(storage().getItem(BOARD_FOLD_KEY));
  } catch {
    folded = boardFoldedOf(null);
  }
  const listeners = new Set<() => void>();
  return {
    folded: () => folded,
    toggle(group) {
      folded = toggleBoardGroup(folded, group);
      const text = boardFoldedText(folded);
      try {
        if (text === undefined) storage().removeItem(BOARD_FOLD_KEY);
        else storage().setItem(BOARD_FOLD_KEY, text);
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
