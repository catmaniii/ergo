// 这个页面上的看板分组收起 / 展开（90 号票）：把 board-fold-setting.ts 接到 localStorage 上，给界面一个 hook。
// 单独一个文件，那个模块就不碰浏览器的全局变量，能在 Node 里测（写法照 page-stage-side.ts）。
import { useSyncExternalStore } from "react";
import type { BoardGroup } from "../state/index.ts";
import { type BoardFoldSetting, boardFoldSettingIn } from "./board-fold-setting.ts";

let setting: BoardFoldSetting | undefined;

/** 整个页面共用的一份 */
export function pageBoardFold(): BoardFoldSetting {
  setting ??= boardFoldSettingIn(() => window.localStorage);
  return setting;
}

/** 现在收起了哪几组，改了跟着变 */
export function useBoardFolded(): ReadonlySet<BoardGroup> {
  const s = pageBoardFold();
  return useSyncExternalStore(s.subscribe, s.folded);
}
