// 二狗的悬浮按钮本身（样子、图标、听 / 忙的样子），不管它摆在哪、点了做什么：页面桥里文本框旁边、右下角常驻的那一个和长按元素的圆钮
// 都用它，地图右下角的二狗按钮也照这一个（样式表 FAB_STYLE 放进自己的 shadow root，createFab 建按钮）。
// 白圈 + 外面一道深色细线 + 阴影：白底、深底、图片上都看得清；按钮上是二狗的图标（fab-icon.ts，解成位图画进 canvas），
// 解不出来退回 SVG（蓝底上一个对话气泡里一颗星，在听时红底上是话筒）。
// 在听：图标不换，白圈外面一道红圈，再往外是红色的脉动（圈一直在，定格也看得出）；
// 在忙：图标不换，外面一圈白底上转蓝色的弧（深色细线描边，白底上也看得出那圈）。
// 显示、位置由用的人管：加 class on 显示，left、top 写在 style 上（position: fixed）。
import { paintFabIcon } from "./fab-icon.ts";
import type { PickTools } from "./pick.ts";
import type { PageBridgeMark } from "./protocol.ts";
import { BUTTON_SIZE } from "./rules.ts";

/** 图标解不出来时退回这两个 */
export const ICON_IDLE =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 12a8 8 0 0 1-8 8H8l-4 3v-5.2A8 8 0 0 1 11.5 4h1a8 8 0 0 1 8 8z"/><path d="M12 8.2l1 2.3 2.3 1-2.3 1-1 2.3-1-2.3-2.3-1 2.3-1z" fill="currentColor" stroke-width="1.2"/></svg>';
export const ICON_MIC =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>';

export const FAB_STYLE = `
.fab {
  position: fixed; left: 0; top: 0; width: ${BUTTON_SIZE}px; height: ${BUTTON_SIZE}px; box-sizing: border-box;
  display: none; align-items: center; justify-content: center;
  border-radius: 50%; background: linear-gradient(145deg, #5b8cff, #3a5bd9); color: #fff;
  box-shadow: 0 0 0 2px #fff, 0 0 0 3px rgba(20, 30, 70, .4), 0 3px 10px 2px rgba(0, 0, 0, .35);
  cursor: pointer; touch-action: none; user-select: none; -webkit-user-select: none; -webkit-tap-highlight-color: transparent;
  transition: transform .12s ease;
}
.fab.on { display: flex; }
.fab:active { transform: scale(.92); }
.fab.has-icon { background: none; }
.fab canvas { display: block; width: 100%; height: 100%; border-radius: 50%; pointer-events: none; }
.fab.listening { animation: ergo-pulse 1s ease-out infinite; }
.fab.listening:not(.has-icon) { background: linear-gradient(145deg, #ff6b6b, #e03131); }
.fab.busy::before, .fab.busy::after { content: ""; position: absolute; inset: -6px; border-radius: 50%; pointer-events: none; }
.fab.busy::before { border: 3px solid #fff; box-shadow: 0 0 0 1px rgba(20, 30, 70, .4), inset 0 0 0 1px rgba(20, 30, 70, .4); }
.fab.busy::after { border: 3px solid transparent; border-top-color: #3a5bd9; border-right-color: #3a5bd9; animation: ergo-spin .8s linear infinite; }
@keyframes ergo-pulse { 0% { box-shadow: 0 0 0 2px #fff, 0 0 0 5px #e03131, 0 0 0 5px rgba(224, 49, 49, .6); } 100% { box-shadow: 0 0 0 2px #fff, 0 0 0 5px #e03131, 0 0 0 18px rgba(224, 49, 49, 0); } }
@keyframes ergo-spin { to { transform: rotate(360deg); } }`;

export interface Fab {
  readonly el: HTMLElement;
  /** 听、忙、平常的样子（图标不换，看外面的圈；退回 SVG 的按钮在听时换成话筒） */
  setMark(mark: PageBridgeMark): void;
  /** 读屏说明 */
  setLabel(text: string): void;
}

/** 建一个按钮（先是 SVG，图标解好了换上；解不出来一直是 SVG，不会是空白的按钮） */
export function createFab(doc: Document, tools: Pick<PickTools, "decode" | "makeBitmap" | "BlobCtor">, label: string): Fab {
  const el = doc.createElement("div");
  el.className = "fab";
  el.setAttribute("role", "button");
  el.setAttribute("aria-label", label);
  el.innerHTML = ICON_IDLE;
  let hasIcon = false;
  let mark: PageBridgeMark = "idle";
  void paintFabIcon(doc, tools).then((canvas) => {
    if (!canvas) return;
    hasIcon = true;
    el.classList.add("has-icon");
    el.replaceChildren(canvas);
  });
  return {
    el,
    setMark(next) {
      mark = next;
      el.classList.toggle("listening", next === "listening");
      el.classList.toggle("busy", next === "busy");
      if (!hasIcon) el.innerHTML = mark === "listening" ? ICON_MIC : ICON_IDLE;
    },
    setLabel: (text) => el.setAttribute("aria-label", text),
  };
}
