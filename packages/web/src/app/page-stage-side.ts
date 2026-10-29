// 这个页面上的阶段栏收起 / 展开（88 号票）、拖到多宽（91 号票）：把 stage-side-setting.ts、stage-side-width.ts 接到 localStorage 上，
// 给界面 hook。单独一个文件，那两个模块就不碰浏览器的全局变量，能在 Node 里测（写法照 page-voice.ts 的自动播放开关）。
import { useSyncExternalStore } from "react";
import type { StageSidePref } from "../state/index.ts";
import { type StageSideSetting, stageSideSettingIn } from "./stage-side-setting.ts";
import { type StageSideWidthSetting, stageSideWidthSettingIn } from "./stage-side-width.ts";

let setting: StageSideSetting | undefined;
let widthSetting: StageSideWidthSetting | undefined;

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

/** 阶段栏的宽度：整个页面共用的一份 */
export function pageStageSideWidth(): StageSideWidthSetting {
  widthSetting ??= stageSideWidthSettingIn(() => window.localStorage);
  return widthSetting;
}

/** 这台设备记住的阶段栏宽度，改了跟着变 */
export function useStageSideWidth(): number {
  const s = pageStageSideWidth();
  return useSyncExternalStore(s.subscribe, s.width);
}
