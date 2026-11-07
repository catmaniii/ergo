// 图片查看器（ui/image-viewer.tsx）的缩放和拖动算术，纯函数，不碰 DOM：
// 以某一点为中心缩放（那一点下面的图不动）、两指前后两帧算新比例和位移、拖不出图的边、松手弹回、双击切换、滚轮换算。
//
// 坐标一律以"放图的框"的中心为原点、单位是像素：框是查看器去掉上面 × 那一行、下面文件名那一行留白之后的那块，
// 图在 1 倍时按比例放进框里、居中（"适应屏幕"）。
// 视图 { scale, x, y }：scale 是相对 1 倍的比例，(x, y) 是图中心离框中心的位移。
// 画的时候写 transform: translate(x, y) scale(scale)，以图中心为原点缩放；图上离图中心 u 的一点画在 x + scale·u。

/** 当前怎么画：比例和图中心的位移 */
export interface ZoomView {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

/** 量出来的尺寸：放图的框，和图在 1 倍时画出来的大小 */
export interface ZoomBox {
  readonly width: number;
  readonly height: number;
  readonly imageWidth: number;
  readonly imageHeight: number;
}

/** 一点（相对框中心） */
export interface ZoomPoint {
  readonly x: number;
  readonly y: number;
}

/** 适应屏幕：1 倍、居中。每次打开都从这里开始 */
export const ZOOM_FIT: ZoomView = { scale: 1, x: 0, y: 0 };
/** 最大放到几倍 */
export const ZOOM_MAX = 5;
/** 双击放大到几倍 */
export const ZOOM_DOUBLE_TAP = 2.5;
/** 捏合途中最小能缩到几倍：手指还按着时可以比 1 倍小一点，松手弹回 1 倍 */
export const ZOOM_PINCH_FLOOR = 0.5;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 放大着（比 1 倍大）：能拖、双击回 1 倍 */
export function isZoomed(view: ZoomView): boolean {
  return view.scale > 1 + 1e-3;
}

/** 一个方向上图中心最远能离框中心多远：图比框大时到图边贴着框边为止，不比框大时是 0（居中） */
function reach(size: number, scale: number, box: number): number {
  return Math.max(0, (size * scale - box) / 2);
}

/** 拖不出图的边：位移收到图边贴着框边为止；图比框小的那个方向居中 */
export function clampPan(view: ZoomView, box: ZoomBox): ZoomView {
  const rx = reach(box.imageWidth, view.scale, box.width);
  const ry = reach(box.imageHeight, view.scale, box.height);
  // `|| 0`：收到 -0 时写成 0
  const x = clamp(view.x, -rx, rx) || 0;
  const y = clamp(view.y, -ry, ry) || 0;
  return x === view.x && y === view.y ? view : { scale: view.scale, x, y };
}

/** 以 point 为中心缩放到 scale：point 下面那一点图缩放前后在屏幕上不动（不限位移，调用方自己收） */
export function scaleAround(view: ZoomView, scale: number, point: ZoomPoint): ZoomView {
  const k = scale / view.scale;
  return { scale, x: point.x - k * (point.x - view.x), y: point.y - k * (point.y - view.y) };
}

/** 滚轮：乘上 factor，以 point（鼠标的位置）为中心，比例在 1 到最大之间，位移拖不出图的边 */
export function zoomAt(view: ZoomView, factor: number, point: ZoomPoint, box: ZoomBox): ZoomView {
  const scale = clamp(view.scale * factor, 1, ZOOM_MAX);
  if (scale === view.scale) return view;
  return clampPan(scaleAround(view, scale, point), box);
}

/**
 * 两指的一帧：before、after 是这两根手指移动前后的位置。比例乘两指距离之比（途中最小 ZOOM_PINCH_FLOOR、最大 ZOOM_MAX），
 * 移动前两指中点下面的那一点图，移动后在新的两指中点下面——捏合和两指一起挪同时算。途中不限位移，松手由 settle 收
 */
export function pinchStep(view: ZoomView, before: readonly [ZoomPoint, ZoomPoint], after: readonly [ZoomPoint, ZoomPoint]): ZoomView {
  const d0 = Math.hypot(before[0].x - before[1].x, before[0].y - before[1].y);
  const d1 = Math.hypot(after[0].x - after[1].x, after[0].y - after[1].y);
  const scale = d0 > 0 && d1 > 0 ? clamp(view.scale * (d1 / d0), ZOOM_PINCH_FLOOR, ZOOM_MAX) : view.scale;
  const m0 = { x: (before[0].x + before[1].x) / 2, y: (before[0].y + before[1].y) / 2 };
  const m1 = { x: (after[0].x + after[1].x) / 2, y: (after[0].y + after[1].y) / 2 };
  const k = scale / view.scale;
  return { scale, x: m1.x - k * (m0.x - view.x), y: m1.y - k * (m0.y - view.y) };
}

/** 单指、鼠标拖了 (dx, dy)：拖不出图的边；没放大（1 倍，或捏合途中比 1 倍小）时不动 */
export function panBy(view: ZoomView, dx: number, dy: number, box: ZoomBox): ZoomView {
  if (!isZoomed(view)) return view;
  return clampPan({ scale: view.scale, x: view.x + dx, y: view.y + dy }, box);
}

/** 手都松开了：不比 1 倍大的弹回 1 倍居中，放大着的位移收到图边 */
export function settle(view: ZoomView, box: ZoomBox): ZoomView {
  if (!isZoomed(view)) return view.scale === 1 && view.x === 0 && view.y === 0 ? view : ZOOM_FIT;
  return clampPan(view.scale > ZOOM_MAX ? { scale: ZOOM_MAX, x: view.x, y: view.y } : view, box);
}

/** 双击：1 倍时以点的位置放大到 2.5 倍（拖不出图的边）；放大着时回到 1 倍 */
export function doubleTapZoom(view: ZoomView, point: ZoomPoint, box: ZoomBox): ZoomView {
  if (isZoomed(view)) return ZOOM_FIT;
  return clampPan(scaleAround(ZOOM_FIT, ZOOM_DOUBLE_TAP, point), box);
}

/**
 * 滚轮一下乘多少：往上滚放大、往下滚缩小。deltaY 按像素算（按行、按页滚的换成像素），一格鼠标滚轮（100 像素）约 1.2 倍；
 * 触控板捏合在浏览器里是按住 Ctrl 的滚轮、一下的量小得多，pinch 为真时换一个大一些的系数。一下最多按 300 像素算
 */
export function wheelFactor(deltaY: number, deltaMode: number, pinch = false): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return Math.exp(-clamp(px, -300, 300) * (pinch ? 0.01 : 0.002));
}
