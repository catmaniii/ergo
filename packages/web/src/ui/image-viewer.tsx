// 图片放大预览：聊天里的图片点开，在页面上盖一层全屏看大图。原来是新窗口打开图片地址，
// 鸿蒙 App 里会整页跳到图片上，没有关闭的地方，返回手势也回不来。
// 外壳（深色底、×、下面一行文件名和"下载"，×、点图片以外的地方、返回手势、Esc 都能关）和视频播放器共用：ui/media-viewer.tsx。
//
// 放大看细节：整页的 viewport 关掉了浏览器自己的捏合缩放（index.html，App 里也一样），查看器自己做缩放和拖动：
// - 触屏：双指捏合，以两指中点为中心（手指落在图外面的深色底上也行），途中可以比 1 倍小、松手弹回，最大 5 倍；
//   放大后单指拖着看别处；双击 1 倍时以点的位置放大到 2.5 倍，放大着时回 1 倍；
// - 鼠标：滚轮以鼠标位置为中心放大缩小，放大后按住拖（显示抓手），双击同上。
// 触屏和鼠标都走 Pointer Events（查看器 touch-action: none，浏览器不自己滚、不自己缩放），滚轮单独听（不是 passive 的，
// 才拦得下 Ctrl + 滚轮的整页缩放）；用 transform 画。算术在 state/image-zoom.ts。
// 拖过、捏过之后松手浏览器照样派 click，这种不算"点"，不关；点图外面的深色底才关。每次打开都从 1 倍开始。
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { doubleTapZoom, isDoubleTap, isZoomed, panBy, pinchStep, settle, TAP_SLOP, type Tap, wheelFactor, ZOOM_FIT, zoomAt, type ZoomBox, type ZoomPoint, type ZoomView } from "../state/index.ts";
import { isViewerControl, MediaViewer } from "./media-viewer.tsx";

/** 视口坐标的一点 */
interface ClientPoint {
  x: number;
  y: number;
}

/** 这一次手势（第一根手指按下到最后一根松开） */
interface Gesture {
  /** 按着的指针（鼠标是一个）：编号 → 最新位置。按下的先后就是 Map 的顺序，捏合用最先按下的两根 */
  pointers: Map<number, ClientPoint>;
  /** 第一根按下的位置 */
  start: ClientPoint;
  /** 第一根按在图上（不是深色底） */
  onImage: boolean;
  /** 挪出了 TAP_SLOP、用过两根手指：松手不算点 */
  moved: boolean;
  multi: boolean;
  /** 上一次在图上的点：等第二下凑成双击 */
  lastTap: Tap | undefined;
}

/** 放图的框（查看器去掉上下留白的那块）、它的中心（视口坐标，算术的原点），和图在 1 倍时画出来的大小 */
interface Frame {
  cx: number;
  cy: number;
  box: ZoomBox;
}

function measure(root: HTMLElement, img: HTMLImageElement): Frame {
  const r = root.getBoundingClientRect();
  const s = getComputedStyle(root);
  const left = parseFloat(s.paddingLeft);
  const right = parseFloat(s.paddingRight);
  const top = parseFloat(s.paddingTop);
  const bottom = parseFloat(s.paddingBottom);
  const width = r.width - left - right;
  const height = r.height - top - bottom;
  // offsetWidth / offsetHeight 是排版的大小，不算 transform：正好是 1 倍时的大小
  return { cx: r.left + left + width / 2, cy: r.top + top + height / 2, box: { width, height, imageWidth: img.offsetWidth, imageHeight: img.offsetHeight } };
}

const toZoom = (f: Frame, p: ClientPoint): ZoomPoint => ({ x: p.x - f.cx, y: p.y - f.cy });

export function ImageViewer({ src, name, onClose }: { src: string; name: string; onClose(): void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [view, setView] = useState<ZoomView>(ZOOM_FIT);
  /** 弹回、双击换比例时带一点过渡；跟着手指、滚轮走的时候不带 */
  const [smooth, setSmooth] = useState(false);
  /** 有指针按着（鼠标拖的时候抓手换成攥紧） */
  const [held, setHeld] = useState(false);
  /** 事件里读的最新视图（state 要等下一次渲染才是新的） */
  const viewRef = useRef<ZoomView>(ZOOM_FIT);
  const gesture = useRef<Gesture>({ pointers: new Map(), start: { x: 0, y: 0 }, onImage: false, moved: false, multi: false, lastTap: undefined });

  // 滚轮缩放、窗口变了（手机转屏、电脑拖窗口）时把位移收回图边
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onWheel = (e: WheelEvent) => {
      // 查看器里滚轮只管缩放：拦下底下页面的滚动和浏览器 Ctrl + 滚轮的整页缩放（触控板捏合也是这样送来的）
      e.preventDefault();
      const img = imgRef.current;
      if (!img) return;
      const f = measure(root, img);
      const next = zoomAt(viewRef.current, wheelFactor(e.deltaY, e.deltaMode, e.ctrlKey), toZoom(f, { x: e.clientX, y: e.clientY }), f.box);
      if (next === viewRef.current) return;
      viewRef.current = next;
      setSmooth(false);
      setView(next);
    };
    const onResize = () => {
      const img = imgRef.current;
      if (!img || gesture.current.pointers.size > 0) return;
      const next = settle(viewRef.current, measure(root, img).box);
      if (next === viewRef.current) return;
      viewRef.current = next;
      setSmooth(false);
      setView(next);
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("resize", onResize);
    return () => {
      root.removeEventListener("wheel", onWheel);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  const show = (next: ZoomView, animate: boolean) => {
    if (next === viewRef.current) return;
    viewRef.current = next;
    setSmooth(animate);
    setView(next);
  };
  const frame = (): Frame | undefined => (rootRef.current && imgRef.current ? measure(rootRef.current, imgRef.current) : undefined);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // 按下不往聊天那边冒由外壳截住
    if (isViewerControl(e.target)) return;
    if (e.pointerType === "mouse") {
      if (e.button !== 0) return;
      // 拖的时候不选中文件名这些字（click 照样派）
      e.preventDefault();
    }
    const g = gesture.current;
    const p = { x: e.clientX, y: e.clientY };
    if (g.pointers.size === 0) {
      g.start = p;
      g.onImage = e.target === imgRef.current;
      g.moved = false;
      g.multi = false;
    } else {
      g.multi = true;
    }
    g.pointers.set(e.pointerId, p);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // 指针已经松开时抓不住，不要紧：松开的事件照样会来
    }
    setSmooth(false);
    setHeld(true);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    const before = g.pointers.get(e.pointerId);
    if (!before) return;
    e.stopPropagation();
    const p = { x: e.clientX, y: e.clientY };
    if (Math.hypot(p.x - g.start.x, p.y - g.start.y) > TAP_SLOP) g.moved = true;
    const [a, b] = g.pointers.keys();
    if (a !== undefined && b !== undefined) {
      // 两根以上：只看最先按下的两根，第三根只记位置
      if (e.pointerId !== a && e.pointerId !== b) {
        g.pointers.set(e.pointerId, p);
        return;
      }
      const pa = g.pointers.get(a)!;
      const pb = g.pointers.get(b)!;
      g.pointers.set(e.pointerId, p);
      const f = frame();
      if (f) show(pinchStep(viewRef.current, [toZoom(f, pa), toZoom(f, pb)], [toZoom(f, g.pointers.get(a)!), toZoom(f, g.pointers.get(b)!)]), false);
      return;
    }
    g.pointers.set(e.pointerId, p);
    const f = frame();
    if (f) show(panBy(viewRef.current, p.x - before.x, p.y - before.y, f.box), false);
  };

  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g.pointers.delete(e.pointerId)) return;
    e.stopPropagation();
    // 还有手指按着：捏合松了一根，剩下那根接着拖
    if (g.pointers.size > 0) return;
    setHeld(false);
    const f = frame();
    if (!f) return;
    show(settle(viewRef.current, f.box), true);
    const tap = e.type === "pointerup" && !g.moved && !g.multi;
    // 点在深色底上的由 click 关掉；点在图上的看是不是双击
    if (!tap || !g.onImage) {
      g.lastTap = undefined;
      return;
    }
    const tapped: Tap = { at: e.timeStamp, x: e.clientX, y: e.clientY };
    if (isDoubleTap(g.lastTap, tapped)) {
      g.lastTap = undefined;
      show(doubleTapZoom(viewRef.current, toZoom(f, tapped), f.box), true);
    } else {
      g.lastTap = tapped;
    }
  };

  /** 拖过、捏过之后松手也会派 click（鼠标按下、松开都在查看器上），不算点；点在图上的不关；点图外面的深色底才关 */
  const closeOnClick = () => {
    const g = gesture.current;
    return !(g.moved || g.multi || g.onImage);
  };

  return (
    <MediaViewer
      rootRef={rootRef}
      className={`image-viewer${isZoomed(view) ? " zoomed" : ""}${held ? " held" : ""}`}
      name={name}
      download={src}
      onClose={onClose}
      closeOnClick={closeOnClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      <img ref={imgRef} src={src} alt={name} draggable={false} className={smooth ? "settling" : undefined} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }} />
    </MediaViewer>
  );
}
