// 这个页面上的换行键（composer-keys-setting.ts）和"这是不是触屏设备"。单独一个文件，那个模块就不碰浏览器的全局变量，能在 Node 里测。
import { type NewlineKeySetting, newlineKeySettingIn } from "./composer-keys-setting.ts";

let setting: NewlineKeySetting | undefined;

/** 整个页面共用的一份（所有输入框都按它） */
export function pageNewlineKey(): NewlineKeySetting {
  setting ??= newlineKeySettingIn(() => window.localStorage);
  return setting;
}

/** 手机、平板和二狗的 App 都算（和 ui/zoom/hint.ts 同一个判断）；带触屏的笔记本主指针还是鼠标，算电脑 */
export function isTouchDevice(): boolean {
  return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
}
