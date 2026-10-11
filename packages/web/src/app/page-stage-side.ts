// 这个页面上的阶段栏收起 / 展开（88 号票）：把 stage-side-setting.ts 接到 localStorage 上，给界面一个 hook。
// 单独一个文件，那个模块就不碰浏览器的全局变量，能在 Node 里测（写法照 page-voice.ts 的自动播放开关）。
import { useSyncExternalStore } from "react";
import type { StageSidePref } from "../state/index.ts";
import { type StageSideSetting, stageSideSettingIn } from "./stage-side-setting.ts";

let setting: StageSideSetting | undefined;

/** 整个页面共用的一份（所有长程任务的详情都按它） */
export function pageStageSide(): StageSideSetting {
  setting ??= stageSideSettingIn(() => window.localStorage);
  return setting;
}

/** 现在是展开还是收起，改了跟着变 */
export function useStageSidePref(): StageSidePref {
  const s = pageStageSide();
  return useSyncExternalStore(s.subscribe, s.pref);
}
