// 这个页面上的项目一览分组收起、宽屏项目的档案栏开合和宽度（104 号票）：把 board-fold-setting.ts、stage-side-setting.ts、
// stage-side-width.ts 用项目自己的键接到 localStorage 上，给界面 hook（和任务看板、阶段栏分开记）。单独一个文件，那几个模块就不碰
// 浏览器的全局变量，能在 Node 里测（写法照 page-board-fold.ts、page-stage-side.ts）。
import { useSyncExternalStore } from "react";
import type { ProjectGroup, StageSidePref } from "../state/index.ts";
import { type FoldSetting, foldSettingIn, PROJECT_FOLD } from "./board-fold-setting.ts";
import { PROJECT_SIDE_KEY, type StageSideSetting, stageSideSettingIn } from "./stage-side-setting.ts";
import { PROJECT_SIDE_WIDTH, type StageSideWidthSetting, stageSideWidthSettingIn } from "./stage-side-width.ts";

let fold: FoldSetting<ProjectGroup> | undefined;
let side: StageSideSetting | undefined;
let width: StageSideWidthSetting | undefined;

/** 项目一览的分组收起：整个页面共用的一份 */
export function pageProjectFold(): FoldSetting<ProjectGroup> {
  fold ??= foldSettingIn(() => window.localStorage, PROJECT_FOLD);
  return fold;
}

/** 现在收起了哪几组，改了跟着变 */
export function useProjectFolded(): ReadonlySet<ProjectGroup> {
  const s = pageProjectFold();
  return useSyncExternalStore(s.subscribe, s.folded);
}

/** 宽屏项目的档案栏开合：整个页面共用的一份（所有项目一起跟着变） */
export function pageProjectSide(): StageSideSetting {
  side ??= stageSideSettingIn(() => window.localStorage, PROJECT_SIDE_KEY);
  return side;
}

export function useProjectSidePref(): StageSidePref {
  const s = pageProjectSide();
  return useSyncExternalStore(s.subscribe, s.pref);
}

/** 档案栏的宽度：整个页面共用的一份 */
export function pageProjectSideWidth(): StageSideWidthSetting {
  width ??= stageSideWidthSettingIn(() => window.localStorage, PROJECT_SIDE_WIDTH);
  return width;
}

export function useProjectSideWidth(): number {
  const s = pageProjectSideWidth();
  return useSyncExternalStore(s.subscribe, s.width);
}
