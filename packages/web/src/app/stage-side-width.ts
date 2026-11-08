// 宽屏一条侧栏拖到多宽（做长程任务的阶段栏时写的，阶段栏没了）在浏览器里的那一半：读写这台设备记住的宽度（localStorage），改了马上告诉界面。
// 拖回初值就擦掉记号（回到默认）。存储用不了时按默认，改了只在这次打开里生效。写法照栏的开合（stage-side-setting.ts）。
// 宽屏的档案栏（PROJECT_SIDE_WIDTH，页面上那一个在 app/page-project-wall.ts）。
// 宽屏浏览侧边栏拖到多宽也是这个做法、自己的键和初值（BROWSE_SIDE_WIDTH，在浏览插件的 plugins/browsing/browse-side.ts，
// 页面上那一个在 plugins/browsing/page-browse.ts）。
// 二狗聊天侧栏（浏览侧边栏、地图页右边的聊天窗，444）的宽度规矩是同一套（初值 400、最窄 320、最宽占内容区六成：chatSideWidth*），
// 从浏览插件挪到这里两边共用，各记各的键（chatSideWidthSpec）。
import { PROJECT_SIDE_WIDTH_INITIAL, projectSideWidthOf } from "../state/index.ts";
import type { DeviceStorage } from "./device-storage.ts";

/** 一条栏的宽度记在哪个键、初值多少（拖回初值就擦掉）、记住的值怎么认 */
export interface SideWidthSpec {
  readonly key: string;
  readonly initial: number;
  parse(raw: string | null): number;
}

/** 二狗聊天侧栏的宽度初值（定的 400，380–420 之间）；拖过的照这台设备记住的 */
export const CHAT_SIDE_WIDTH = 400;

/** 二狗聊天侧栏最窄（里面是一整个会话，再窄输入框那一行的按钮挤不下；内容区窄时的下限也是它） */
export const CHAT_SIDE_WIDTH_MIN = 320;

/** 二狗聊天侧栏最宽占内容区的几成（照"详情"阶段栏的最宽外框宽的 60%，旁边至少留 40%） */
const CHAT_SIDE_WIDTH_SHARE = 0.6;

/**
 * 二狗聊天侧栏能拖到的范围（照"详情"阶段栏 dragStageSideWidth 的口径）：最窄 320，最宽内容区宽的 60%；内容区窄得 60% 不到 320 时就是 320
 */
export function chatSideWidthRange(hostWidth: number): { min: number; max: number } {
  return { min: CHAT_SIDE_WIDTH_MIN, max: Math.max(CHAT_SIDE_WIDTH_MIN, Math.round(hostWidth * CHAT_SIDE_WIDTH_SHARE)) };
}

/** 夹回范围里（记住的宽度、拖到的宽度都经它；转屏、窗口变化时照新的内容区夹） */
export function clampChatSideWidth(width: number, hostWidth: number): number {
  const { min, max } = chatSideWidthRange(hostWidth);
  return Math.round(Math.min(max, Math.max(min, width)));
}

/** 拖分隔条：dx 是这一下往右挪了多少（侧栏在右边：往左拖变宽、往右拖变窄），夹在范围里 */
export function dragChatSideWidth(width: number, dx: number, hostWidth: number): number {
  return clampChatSideWidth(width - dx, hostWidth);
}

/**
 * 这台设备记住的宽度怎么认：认不出、比最窄还窄的按初值。照阶段栏（stageSideWidthOf）不按现在的内容区裁——转屏、窗口变窄时摆的时候夹回，
 * 转回来还是原来拖的宽度
 */
export function chatSideWidthOf(raw: string | null): number {
  const w = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(w) && w >= CHAT_SIDE_WIDTH_MIN ? w : CHAT_SIDE_WIDTH;
}

/** 一条二狗聊天侧栏的宽度记在哪个键（初值、怎么认是共用的） */
export function chatSideWidthSpec(key: string): SideWidthSpec {
  return { key, initial: CHAT_SIDE_WIDTH, parse: chatSideWidthOf };
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
