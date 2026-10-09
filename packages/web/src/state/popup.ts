// 弹出菜单放在哪（纯函数）：语音气泡的长按菜单这类贴着某个元素弹出的菜单。界面那一半在 ui/popup.tsx：
// 菜单经 portal 画在应用框最上面的一层，position: fixed，所以这里一律按屏幕坐标（getBoundingClientRect）算。
// 规矩（用户 2026-10-10 的反馈）：位置跟着按住的那个元素走；默认在它下方（原来的样子），下方到屏幕底放不下就翻到上方；
// 上下都放不下（元素比屏幕还高）放在空多的那一边；左右和元素的一边对齐；无论怎样都整个推回屏幕里，离屏幕边留一点。
// 输入栏、标题栏、底部导航不算障碍：菜单浮在它们上面，盖住也不让开。

/** 屏幕坐标里的一个矩形 */
export interface PopupRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 菜单自己的大小 */
export interface PopupSize {
  width: number;
  height: number;
}

/** 和按住的元素哪一边对齐：start 左边对齐（agent 发的），end 右边对齐（自己发的，靠右） */
export type PopupAlign = "start" | "end";

export interface PopupPlacement {
  /** 放在元素的下方还是上方 */
  side: "below" | "above";
  left: number;
  top: number;
}

/** 菜单离按住的元素多远（像素；原来写在样式里的 calc(100% + 4px)） */
export const POPUP_GAP = 4;
/** 菜单离屏幕边至少多远（像素） */
export const POPUP_MARGIN = 8;

/** 推回 [min, max] 里；放不下（max < min）时贴着 min */
function clampInto(x: number, min: number, max: number): number {
  return Math.max(min, Math.min(x, max));
}

/** 菜单的左上角放在哪：anchor 是按住的元素，bounds 是屏幕（都按屏幕坐标） */
export function popupPlacement(anchor: PopupRect, size: PopupSize, bounds: PopupRect, align: PopupAlign): PopupPlacement {
  const below = anchor.bottom + POPUP_GAP;
  const above = anchor.top - POPUP_GAP - size.height;
  const fitsBelow = below + size.height <= bounds.bottom - POPUP_MARGIN;
  const fitsAbove = above >= bounds.top + POPUP_MARGIN;
  const roomBelow = bounds.bottom - anchor.bottom;
  const roomAbove = anchor.top - bounds.top;
  const side = fitsBelow || (!fitsAbove && roomBelow >= roomAbove) ? "below" : "above";
  const top = clampInto(side === "below" ? below : above, bounds.top + POPUP_MARGIN, bounds.bottom - POPUP_MARGIN - size.height);
  const left = clampInto(align === "start" ? anchor.left : anchor.right - size.width, bounds.left + POPUP_MARGIN, bounds.right - POPUP_MARGIN - size.width);
  return { side, left, top };
}
