// 地图页怎么摆（444）记在这台设备上的那几样（localStorage，只是方便）：
// - 右边的二狗聊天窗开着没有（CHAT_KEY："open"；收起不留记号）——下次进地图照上次的样子；
// - 聊天窗拖到多宽（MAP_CHAT_WIDTH：初值、最窄、最宽和浏览侧边栏同一套，app/stage-side-width.ts 的 chatSideWidth*，各记各的键）；
// - 宽的时候左边那一栏（这一天的列表、停留详情）：开着、收成一个小按钮（folded）、关掉（closed）——收起、关掉都记着，
//   点标题栏上这一天的概况、小按钮再打开；
// - 窄的时候下面的抽屉（详情卡、列表卡）：平常的高度还是拖低了只露一条（low）——记着，下次打开的卡照这个高度。
// 存储用不了（隐私模式）时按默认，改了只在这次打开里生效。不碰 DOM：存储由参数给，测试在 Node 里跑；页面上那一份是 pageMapLayout。
import type { DeviceStorage } from "../../app/device-storage.ts";
import { chatSideWidthSpec, type SideWidthSpec, type StageSideWidthSetting, stageSideWidthSettingIn } from "../../app/stage-side-width.ts";

const CHAT_KEY = "ergo-map-chat";
const PANEL_KEY = "ergo-map-panel";
const DRAWER_KEY = "ergo-map-drawer";

/** 宽屏聊天窗的宽度记在哪个键（初值、怎么认和浏览侧边栏共用） */
export const MAP_CHAT_WIDTH: SideWidthSpec = chatSideWidthSpec("ergo-map-chat-width");

/** 宽的时候左边那一栏：开着、收成一个小按钮、关掉 */
export type MapPanelState = "open" | "folded" | "closed";
/** 窄的时候下面的抽屉：平常的高度、拖低了只露一条 */
export type MapDrawerState = "normal" | "low";

export interface MapLayoutView {
  readonly chatOpen: boolean;
  readonly panel: MapPanelState;
  readonly drawer: MapDrawerState;
}

export interface MapLayout {
  snapshot(): MapLayoutView;
  subscribe(listener: () => void): () => void;
  setChatOpen(open: boolean): void;
  setPanel(panel: MapPanelState): void;
  setDrawer(drawer: MapDrawerState): void;
}

function read(storage: () => DeviceStorage, key: string): string | null {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}

/** 记下（默认值不留记号）；存不了就算了 */
function write(storage: () => DeviceStorage, key: string, value: string | undefined): void {
  try {
    if (value === undefined) storage().removeItem(key);
    else storage().setItem(key, value);
  } catch {
    // 存不了：这次打开里照样生效，下次打开回到默认
  }
}

export function mapLayoutIn(storage: () => DeviceStorage): MapLayout {
  const panelRaw = read(storage, PANEL_KEY);
  let view: MapLayoutView = {
    chatOpen: read(storage, CHAT_KEY) === "open",
    panel: panelRaw === "folded" || panelRaw === "closed" ? panelRaw : "open",
    drawer: read(storage, DRAWER_KEY) === "low" ? "low" : "normal",
  };
  const listeners = new Set<() => void>();
  const set = (next: MapLayoutView) => {
    view = next;
    for (const listener of listeners) listener();
  };
  return {
    snapshot: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    setChatOpen(open) {
      if (open === view.chatOpen) return;
      write(storage, CHAT_KEY, open ? "open" : undefined);
      set({ ...view, chatOpen: open });
    },
    setPanel(panel) {
      if (panel === view.panel) return;
      write(storage, PANEL_KEY, panel === "open" ? undefined : panel);
      set({ ...view, panel });
    },
    setDrawer(drawer) {
      if (drawer === view.drawer) return;
      write(storage, DRAWER_KEY, drawer === "low" ? "low" : undefined);
      set({ ...view, drawer });
    },
  };
}

let layout: MapLayout | undefined;
let chatWidth: StageSideWidthSetting | undefined;

/** 页面上那一份（整个页面共用） */
export function pageMapLayout(): MapLayout {
  layout ??= mapLayoutIn(() => window.localStorage);
  return layout;
}

/** 宽屏聊天窗拖到的宽度：整个页面共用的一份，这台设备记住 */
export function pageMapChatWidth(): StageSideWidthSetting {
  chatWidth ??= stageSideWidthSettingIn(() => window.localStorage, MAP_CHAT_WIDTH);
  return chatWidth;
}
