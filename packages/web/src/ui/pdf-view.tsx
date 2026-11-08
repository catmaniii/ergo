// 报告页里的 PDF（pages/ReportPage.tsx 的 PDF 那一种）：pdf.js 一页页往下排着画，能选字复制，能放大缩小。
// - 打开：pdf.js（按需加载，app/pdfjs.ts）和 PDF 的字节（媒体接口，DaemonHttp.mediaBytes）同时取，取的时候说"正在打开"，
//   大文件写取了多少；加了密码的、坏的、没加载上的各说一句，旁边"下载"；
// - 排版、该画哪几页、画多清楚：state/pdf-view.ts。每页按框宽排，清晰度按 devicePixelRatio；只画离看得到的地方一屏以内的页，
//   滚远了的页放掉（图、文字层、pdf.js 那边这一页的缓存），很长的 PDF 也不会一次全画；
// - 选字：每页叠一层 pdf.js 的文字层（透明的字，和页上的字对齐），拖选、长按选中后照常复制；
// - 放大缩小（算术在 state/pdf-view.ts，照搬图片查看器的 state/image-zoom.ts）：
//   - 手机：双指捏合，以两指中点为中心（1–5 倍，捏小松手弹回 1 倍）；单指照常滚动（放大后横竖都能滚）；双击以点的位置
//     放大到 2.5 倍，放大着时双击以点的位置回 1 倍；
//   - 电脑：按住 Ctrl 滚滚轮（触控板的捏合在浏览器里也是这样送来的）以鼠标位置为中心放大缩小；不按 Ctrl 的滚轮照常滚动——
//     缩放只认 Ctrl + 滚轮，和滚动不打架；双击同手机（双击不再选中一个词，选字用拖选）。
//   手势途中只给整份文档写 CSS transform（不重排、不重画），停下来（松手、滚轮停 0.25 秒）才按新倍数重排、按新清晰度重画；
//   新的画好之前旧的拉伸着顶着，画好了换上，不闪白。放大很多时整页画成一张图会太大（PDF_PAGE_MAX_PIXELS），
//   另把看得到的那一块按屏幕清晰度补画一张盖在上面，不糊。
import { type CSSProperties, memo, type MouseEvent as ReactMouseEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { loadPdfJs, openPdf, type PdfDocument, type PdfJsLib, type PdfLoadingTask, type PdfPage } from "../app/pdfjs.ts";
import { useStore } from "../app/store.tsx";
import {
  docBox,
  docDoubleTap,
  docOffset,
  docPreview,
  docScrollOf,
  docSettle,
  docViewOf,
  isDoubleTap,
  PDF_MEASURE_ALL_MAX,
  pdfDetailRect,
  pdfFacts,
  type PdfFrame,
  type PdfLayout,
  pdfLayout,
  pdfNeedsDetail,
  type PdfOpenProblem,
  pdfOpenProblemOf,
  pdfOutputScale,
  type PdfPageBox,
  pdfPagesNear,
  type PdfPageSize,
  type PdfRect,
  pinchStep,
  sizeLabel,
  t,
  TAP_SLOP,
  type Tap,
  wheelFactor,
  zoomAt,
  type ZoomPoint,
  type ZoomView,
} from "../state/index.ts";

/** 打开到哪一步了 */
type Opened =
  | { kind: "loading"; loaded: number; total: number | undefined }
  /** 原型里没有这个文件的内容 */
  | { kind: "noContent" }
  | { kind: "problem"; problem: PdfOpenProblem }
  | { kind: "ready"; lib: PdfJsLib; doc: PdfDocument; sizes: readonly PdfPageSize[] };

/** 打不开时说的话（按当前语言现取） */
const PROBLEM_TEXT: Readonly<Record<PdfOpenProblem, () => string>> = {
  encrypted: () => t("pages.report.pdfEncrypted"),
  broken: () => t("pages.report.pdfBroken"),
  failed: () => t("pages.report.pdfFailed"),
};

/** 取得超过这么多时写"取了多少"（小文件一闪就过，不写） */
const SHOW_PROGRESS_FROM = 2 * 1024 * 1024;

/** 量每一页的大小：不多的一页页量；太多的先都按第一页的大小占位（画的时候每页按自己的比例放进位置里） */
async function measurePages(doc: PdfDocument): Promise<PdfPageSize[]> {
  const sizeOf = async (n: number): Promise<PdfPageSize> => {
    const v = (await doc.getPage(n)).getViewport({ scale: 1 });
    return { width: v.width, height: v.height };
  };
  if (doc.numPages <= PDF_MEASURE_ALL_MAX) return Promise.all(Array.from({ length: doc.numPages }, (_, i) => sizeOf(i + 1)));
  const first = await sizeOf(1);
  return Array.from({ length: doc.numPages }, () => first);
}

/**
 * PDF 的正文：上面一行"PDF · 几页 · 大小 · 什么时候发的"（页数打开了才有），下面是能滚动、能缩放的一页页。
 * facts 是报告页推好的大小、发出时间；download 是下载地址（打不开时提示旁边给一个）。换了文件由调用方换 key 重新挂
 */
export function PdfBody({ mediaId, name, facts, download }: { mediaId: string; name: string; facts: { size: string; sent: string | undefined }; download: string | undefined }) {
  const { http } = useStore();
  const [opened, setOpened] = useState<Opened>({ kind: "loading", loaded: 0, total: undefined });
  useEffect(() => {
    const abort = new AbortController();
    let task: PdfLoadingTask | undefined;
    let reported = 0;
    const onProgress = (loaded: number, total: number | undefined) => {
      const now = performance.now();
      if (now - reported < 200 || abort.signal.aborted) return;
      reported = now;
      setOpened({ kind: "loading", loaded, total });
    };
    let loaded: PdfJsLib | undefined;
    void (async () => {
      const [lib, bytes] = await Promise.all([loadPdfJs(), http.mediaBytes(mediaId, name, { signal: abort.signal, onProgress })]);
      loaded = lib;
      if (abort.signal.aborted) return;
      if (!bytes) return setOpened({ kind: "noContent" });
      task = openPdf(lib, bytes);
      const doc = await task.promise;
      const sizes = await measurePages(doc);
      if (!abort.signal.aborted) setOpened({ kind: "ready", lib, doc, sizes });
    })().catch((err: unknown) => {
      if (abort.signal.aborted) return;
      setOpened({ kind: "problem", problem: pdfOpenProblemOf(err instanceof Error ? err.name : undefined) });
    });
    return () => {
      abort.abort();
      // 关掉这份文档和它的 worker；文字层量字用的画布（挂在 body 上）没有别的页在用就拿掉
      void task?.destroy().then(() => loaded?.TextLayer.cleanup());
    };
  }, [http, mediaId, name]);

  const pages = opened.kind === "ready" ? opened.doc.numPages : undefined;
  return (
    <>
      <div className="report-facts muted report-pdf-facts">{pdfFacts(facts, pages)}</div>
      {opened.kind === "loading" && (
        <div className="page-placeholder" role="status">
          {opened.total !== undefined && opened.total >= SHOW_PROGRESS_FROM
            ? t("pages.report.pdfFetching", { loaded: sizeLabel(opened.loaded), total: sizeLabel(opened.total) })
            : t("pages.report.pdfOpening")}
        </div>
      )}
      {opened.kind === "noContent" && <div className="page-placeholder">{t("pages.report.noPrototypeContent")}</div>}
      {opened.kind === "problem" && (
        <div className="report-notice report-media-failed report-pdf-problem" role="alert" data-problem={opened.problem}>
          <span>{PROBLEM_TEXT[opened.problem]()}</span>
          {download && (
            <a className="btn ghost small report-dl" href={download} download={name}>
              {t("pages.report.download")}
            </a>
          )}
        </div>
      )}
      {opened.kind === "ready" && <PdfPages lib={opened.lib} doc={opened.doc} sizes={opened.sizes} />}
    </>
  );
}

/** 框现在的样子：可见部分的大小、滚到哪 */
function frameOf(el: HTMLElement): PdfFrame {
  return { width: el.clientWidth, height: el.clientHeight, left: el.scrollLeft, top: el.scrollTop };
}

/** 视口坐标的一点换成相对框中心（缩放算术的原点） */
function toFramePoint(el: HTMLElement, x: number, y: number): ZoomPoint {
  const r = el.getBoundingClientRect();
  return { x: x - r.left - el.clientLeft - el.clientWidth / 2, y: y - r.top - el.clientTop - el.clientHeight / 2 };
}

/** 一次缩放手势：开始时定下的样子（倍数、滚动位置），和现在要看起来的样子 */
interface Gesture {
  from: PdfFrame & { zoom: number };
  view: ZoomView;
}

/** 两指捏合：最先按下的两根手指（按编号认），和它们上一次的位置（相对框中心） */
interface Pinch {
  ids: readonly [number, number];
  points: readonly [ZoomPoint, ZoomPoint];
}

/** 单指按下时：在哪、什么时候，挪没挪过（挪过是滚动，不算点） */
interface TouchTap {
  at: number;
  x: number;
  y: number;
  moved: boolean;
}

/** 双击、捏合松手后动画到位要多久（毫秒）；系统要求少动画时不动画 */
const SETTLE_MS = 200;
/** 滚轮停了这么久（毫秒）算缩放停下了 */
const WHEEL_IDLE_MS = 250;
/** 滚动停了这么久（毫秒）才补画看得到的那一块 */
const SCROLL_IDLE_MS = 150;
/** 手指碰过之后这么久（毫秒）里来的 dblclick 是触屏补发的，不算 */
const TOUCH_MOUSE_GAP_MS = 800;

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** 两指在这次事件里的位置；有一根已经不在了是 undefined */
function pinchPoints(el: HTMLElement, touches: TouchList, ids: readonly [number, number]): [ZoomPoint, ZoomPoint] | undefined {
  const find = (id: number) => Array.from(touches).find((touch) => touch.identifier === id);
  const a = find(ids[0]);
  const b = find(ids[1]);
  return a && b ? [toFramePoint(el, a.clientX, a.clientY), toFramePoint(el, b.clientX, b.clientY)] : undefined;
}

/** 第二下按下时不让浏览器去选中一个词（双击是缩放；选字用拖选） */
function onMouseDown(e: ReactMouseEvent<HTMLDivElement>): void {
  if (e.detail >= 2) e.preventDefault();
}

/** 放大了的一页：1 倍的位置乘倍数 */
const scaled = (box: PdfPageBox, zoom: number): PdfPageBox => ({ left: box.left * zoom, top: box.top * zoom, width: box.width * zoom, height: box.height * zoom });

/** 能滚动、能缩放的一页页 */
function PdfPages({ lib, doc, sizes }: { lib: PdfJsLib; doc: PdfDocument; sizes: readonly PdfPageSize[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<HTMLDivElement>(null);
  /** 框的大小（变了重排） */
  const [frame, setFrame] = useState<{ width: number; height: number }>();
  /** 定下来的倍数（手势途中不变，停下来才改） */
  const [zoom, setZoom] = useState(1);
  /** 离看得到的地方够近、要画的页 */
  const [near, setNear] = useState<{ first: number; last: number }>();
  /** 滚动停下来时框的样子：放大后补画看得到的那一块按它算 */
  const [settled, setSettled] = useState<PdfFrame>();
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  const layout = useMemo(() => (frame ? pdfLayout(sizes, frame.width) : undefined), [sizes, frame]);

  /** 事件里读的最新值（state 要等下一次渲染才是新的） */
  const live = useRef<{ zoom: number; layout: PdfLayout | undefined }>({ zoom: 1, layout: undefined });
  /** 改了倍数之后要滚到的位置（重排完再滚） */
  const pendingScroll = useRef<{ left: number; top: number }>(undefined);
  const prevLayout = useRef<PdfLayout>(undefined);
  const gesture = useRef<Gesture>(undefined);
  /** 双击、松手后正在动画到位（到了才定下来）；途中又开始新的手势就不等了，接着从目标的样子往下算 */
  const settleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  /** 量框的大小（窗口变了、转屏、出现滚动条都会变）；顺带看屏幕清晰度变了没有（窗口拖到另一块屏幕上） */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      setFrame((prev) => (prev && prev.width === el.clientWidth && prev.height === el.clientHeight ? prev : { width: el.clientWidth, height: el.clientHeight }));
      setDpr(window.devicePixelRatio || 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const updateNear = useCallback(() => {
    const el = scrollRef.current;
    const lay = live.current.layout;
    if (!el || !lay) return;
    const next = pdfPagesNear(lay, live.current.zoom, frameOf(el));
    setNear((prev) => (prev && next && prev.first === next.first && prev.last === next.last ? prev : next));
  }, []);

  // 重排了（框变了、倍数变了）：滚到该在的位置，撤掉手势途中的 transform，重算要画的页
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !layout) return;
    live.current = { zoom, layout };
    const pending = pendingScroll.current;
    if (pending) {
      el.scrollLeft = pending.left;
      el.scrollTop = pending.top;
      pendingScroll.current = undefined;
    } else if (prevLayout.current && prevLayout.current !== layout && prevLayout.current.height > 0) {
      // 框变宽变窄了：按比例留在原来看的地方
      el.scrollTop *= layout.height / prevLayout.current.height;
    }
    prevLayout.current = layout;
    if (docRef.current) docRef.current.style.transform = "";
    updateNear();
    setSettled(frameOf(el));
  }, [layout, zoom, updateNear]);

  // 滚动：每一帧看一次要画哪些页；停下来再补画看得到的那一块
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let frameId = 0;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      if (!frameId) {
        frameId = requestAnimationFrame(() => {
          frameId = 0;
          updateNear();
        });
      }
      clearTimeout(idle);
      idle = setTimeout(() => setSettled(frameOf(el)), SCROLL_IDLE_MS);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frameId);
      clearTimeout(idle);
    };
  }, [updateNear]);

  /** 手势途中：文档还按定下的倍数排着，写 transform 让它看起来像 view */
  const preview = useCallback((view: ZoomView) => {
    const g = gesture.current;
    const lay = live.current.layout;
    const d = docRef.current;
    if (!g || !lay || !d) return;
    const { dx, dy, k } = docPreview(lay, g.from, view);
    d.style.transform = `translate(${dx}px, ${dy}px) scale(${k})`;
  }, []);

  /** 停下来：收好边（比 1 倍小的弹回），按新倍数重排、滚到对应的位置，重画 */
  const commit = useCallback((view: ZoomView) => {
    const el = scrollRef.current;
    const lay = live.current.layout;
    if (!el || !lay) return;
    const box = docBox(lay, frameOf(el));
    const final = docSettle(view, box);
    const scroll = docScrollOf(lay, final, box);
    if (Math.abs(final.scale - live.current.zoom) < 1e-6) {
      // 倍数没变：直接滚到位、撤掉 transform
      if (docRef.current) docRef.current.style.transform = "";
      el.scrollLeft = scroll.left;
      el.scrollTop = scroll.top;
      return;
    }
    pendingScroll.current = scroll;
    setZoom(final.scale);
  }, []);

  /** 带一点过渡地到 target，到了再定下来（双击、捏合松手后弹回） */
  const settleTo = useCallback(
    (target: ZoomView) => {
      const d = docRef.current;
      const g = gesture.current;
      if (!d || !g) return;
      g.view = target;
      const done = () => {
        settleTimer.current = undefined;
        d.classList.remove("settling");
        if (gesture.current !== g) return;
        gesture.current = undefined;
        commit(g.view);
      };
      if (reducedMotion()) return done();
      d.classList.add("settling");
      preview(target);
      clearTimeout(settleTimer.current);
      settleTimer.current = setTimeout(done, SETTLE_MS);
    },
    [commit, preview],
  );

  /** 开始一次手势：记下定下的样子（正在动画到位的那一次不等了，从它的目标接着算） */
  const begin = useCallback((): Gesture | undefined => {
    const el = scrollRef.current;
    const lay = live.current.layout;
    if (!el || !lay) return undefined;
    clearTimeout(settleTimer.current);
    settleTimer.current = undefined;
    docRef.current?.classList.remove("settling");
    if (gesture.current) return gesture.current;
    const from = { ...frameOf(el), zoom: live.current.zoom };
    gesture.current = { from, view: docViewOf(lay, from.zoom, from) };
    return gesture.current;
  }, []);

  /** 双击（手指或鼠标）：1 倍时放大到 2.5 倍，放大着时回 1 倍，点下面那一处不动 */
  const doubleTap = useCallback(
    (at: { x: number; y: number }) => {
      const el = scrollRef.current;
      const lay = live.current.layout;
      if (!el || !lay) return;
      // 捏着、滚轮缩放着的时候不算
      if (gesture.current && settleTimer.current === undefined) return;
      const g = begin();
      if (!g) return;
      settleTo(docDoubleTap(g.view, toFramePoint(el, at.x, at.y), docBox(lay, g.from)));
      // 双击时浏览器选中的词清掉
      window.getSelection()?.removeAllRanges();
    },
    [begin, settleTo],
  );

  // 触屏：两指捏合（自己管，单指的滚动交给浏览器）、双击；鼠标：Ctrl + 滚轮缩放。都要 passive: false 才拦得下浏览器自己的处理
  const lastTouch = useRef(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let pinch: Pinch | undefined;
    let tap: TouchTap | undefined;
    let lastTap: Tap | undefined;
    let wheelTimer: ReturnType<typeof setTimeout> | undefined;

    const onTouchStart = (e: TouchEvent) => {
      lastTouch.current = Date.now();
      if (e.touches.length >= 2) {
        tap = undefined;
        lastTap = undefined;
        if (pinch) return;
        const a = e.touches[0]!;
        const b = e.touches[1]!;
        if (!begin()) return;
        if (e.cancelable) e.preventDefault();
        pinch = { ids: [a.identifier, b.identifier], points: [toFramePoint(el, a.clientX, a.clientY), toFramePoint(el, b.clientX, b.clientY)] };
        return;
      }
      const one = e.touches[0];
      if (one && !pinch) tap = { at: e.timeStamp, x: one.clientX, y: one.clientY, moved: false };
    };

    const onTouchMove = (e: TouchEvent) => {
      if (pinch) {
        const now = pinchPoints(el, e.touches, pinch.ids);
        const g = gesture.current;
        if (!now || !g) return;
        if (e.cancelable) e.preventDefault();
        g.view = pinchStep(g.view, pinch.points, now);
        pinch = { ids: pinch.ids, points: now };
        preview(g.view);
        return;
      }
      const one = e.touches[0];
      if (tap && one && Math.hypot(one.clientX - tap.x, one.clientY - tap.y) > TAP_SLOP) tap.moved = true;
    };

    const onTouchEnd = (e: TouchEvent) => {
      lastTouch.current = Date.now();
      if (pinch) {
        // 两根里还都按着（松的是第三根）：接着捏
        if (pinchPoints(el, e.touches, pinch.ids)) return;
        pinch = undefined;
        tap = undefined;
        const g = gesture.current;
        const lay = live.current.layout;
        if (g && lay) settleTo(docSettle(g.view, docBox(lay, g.from)));
        return;
      }
      const start = tap;
      tap = undefined;
      const one = e.changedTouches[0];
      if (!start || start.moved || e.touches.length > 0 || !one) return;
      const now: Tap = { at: e.timeStamp, x: one.clientX, y: one.clientY };
      if (isDoubleTap(lastTap, now)) {
        lastTap = undefined;
        // 不让浏览器再把这一下当成点击、双击
        if (e.cancelable) e.preventDefault();
        doubleTap(now);
      } else {
        lastTap = now;
      }
    };

    const onWheel = (e: WheelEvent) => {
      // 不按 Ctrl 的滚轮照常滚动；缩放途中滚了就先把缩放定下来
      if (!e.ctrlKey) {
        if (wheelTimer !== undefined) {
          clearTimeout(wheelTimer);
          wheelTimer = undefined;
          const g = gesture.current;
          gesture.current = undefined;
          if (g) commit(g.view);
        }
        return;
      }
      // Ctrl + 滚轮（触控板捏合）：缩放，拦下浏览器的整页缩放
      e.preventDefault();
      const lay = live.current.layout;
      const g = begin();
      if (!g || !lay) return;
      // 触控板捏合一下的量小（几个像素、带小数）；鼠标滚轮一格是一百像素上下（高分屏上按缩放比例小一些，3 倍屏三十多）：分开换算
      const pinching = e.deltaMode === 0 && Math.abs(e.deltaY) < 20;
      g.view = zoomAt(g.view, wheelFactor(e.deltaY, e.deltaMode, pinching), toFramePoint(el, e.clientX, e.clientY), docBox(lay, g.from));
      preview(g.view);
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => {
        wheelTimer = undefined;
        const done = gesture.current;
        gesture.current = undefined;
        if (done) commit(done.view);
      }, WHEEL_IDLE_MS);
    };

    el.addEventListener("touchstart", onTouchStart, { passive: false });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: false });
    el.addEventListener("touchcancel", onTouchEnd, { passive: false });
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
      el.removeEventListener("wheel", onWheel);
      clearTimeout(wheelTimer);
      clearTimeout(settleTimer.current);
    };
  }, [begin, commit, doubleTap, preview, settleTo]);

  // 选字时（按在文字层上拖）给文字层挂 selecting：pdf.js 的样式据此把"文末"铺满整页，拖到字和字的空隙里选区不乱跳
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onDown = (e: PointerEvent) => {
      const layer = e.target instanceof Element ? e.target.closest(".textLayer") : null;
      layer?.classList.add("selecting");
    };
    const onUp = () => {
      for (const layer of el.querySelectorAll(".textLayer.selecting")) layer.classList.remove("selecting");
    };
    el.addEventListener("pointerdown", onDown);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, []);

  /** 鼠标双击：缩放（手指的双击自己算，浏览器补发的 dblclick 不算） */
  const onDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (Date.now() - lastTouch.current < TOUCH_MOUSE_GAP_MS) return;
    e.preventDefault();
    doubleTap({ x: e.clientX, y: e.clientY });
  };

  const offset = layout && frame ? docOffset(layout, zoom, frame) : { x: 0, y: 0 };
  const docStyle: CSSProperties | undefined = layout && { left: offset.x, top: offset.y, width: layout.width * zoom, height: layout.height * zoom };
  const sizerStyle: CSSProperties | undefined = layout && frame && { width: Math.max(frame.width, layout.width * zoom), height: Math.max(frame.height, layout.height * zoom) };
  const shown = near && layout ? Array.from({ length: near.last - near.first + 1 }, (_, i) => near.first + i) : [];
  return (
    <div ref={scrollRef} className="pdf-view" onDoubleClick={onDoubleClick} onMouseDown={onMouseDown}>
      {layout && (
        <div className="pdf-sizer" style={sizerStyle}>
          <div ref={docRef} className="pdf-doc" style={docStyle}>
            <PageBacks layout={layout} zoom={zoom} />
            {shown.map((i) => {
              const box = scaled(layout.pages[i]!, zoom);
              const detail = settled && pdfNeedsDetail(box.width, box.height, dpr) ? pdfDetailRect(layout.pages[i]!, zoom, settled, offset) : undefined;
              return <PdfPageView key={i} lib={lib} doc={doc} index={i} box={box} dpr={dpr} detail={detail} />;
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** 每一页的白底（还没画、滚远了放掉的页也占着位置）：只在重排、换倍数时重画 */
const PageBacks = memo(function PageBacks({ layout, zoom }: { layout: PdfLayout; zoom: number }) {
  return (
    <>
      {layout.pages.map((p, i) => (
        <div key={i} className="pdf-page-back" style={{ left: p.left * zoom, top: p.top * zoom, width: p.width * zoom, height: p.height * zoom }} />
      ))}
    </>
  );
});

/** 页在位置里实际画多大：按这一页自己的比例放进位置里、居中（量过大小的页正好占满） */
function fitIn(box: PdfPageBox, page: PdfPageSize): PdfPageBox {
  const s = Math.min(box.width / page.width, box.height / page.height);
  const width = page.width * s;
  const height = page.height * s;
  return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
}

/** 一页的一张图画完再换上去（旧的拉伸着顶到那时，不闪白）；画不了的报出来 */
function renderInto(page: PdfPage, lib: PdfJsLib, target: HTMLElement, canvas: HTMLCanvasElement, scale: number, onFailed: () => void, transform?: number[]): () => void {
  const viewport = page.getViewport({ scale });
  const task = page.render({ canvas, viewport, annotationMode: lib.AnnotationMode.ENABLE, ...(transform ? { transform } : {}) });
  task.promise.then(
    () => target.replaceChildren(canvas),
    (err: unknown) => {
      if (err instanceof Error && err.name === "RenderingCancelledException") return;
      onFailed();
    },
  );
  return () => task.cancel();
}

/**
 * 一页：整页画成一张图（清晰度按屏幕，太大时按上限降），放大很多时另把看得到的那一块（detail，相对这一页）按屏幕清晰度补画一张
 * 盖在上面；再叠一层文字层。滚远了卸掉时放掉 pdf.js 那边这一页的缓存
 */
const PdfPageView = memo(function PdfPageView({ lib, doc, index, box, dpr, detail }: { lib: PdfJsLib; doc: PdfDocument; index: number; box: PdfPageBox; dpr: number; detail: PdfRect | undefined }) {
  const [page, setPage] = useState<PdfPage>();
  const [failed, setFailed] = useState(false);
  const baseRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    doc.getPage(index + 1).then(
      (p) => {
        if (alive) setPage(p);
      },
      () => {
        if (alive) setFailed(true);
      },
    );
    return () => {
      alive = false;
    };
  }, [doc, index]);

  const natural = page?.getViewport({ scale: 1 });
  const inner = natural ? fitIn(box, natural) : box;
  /** 每个 PDF 单位画成几个 CSS 像素 */
  const cssScale = natural ? inner.width / natural.width : 1;

  // 整页那张：倍数、大小、屏幕清晰度变了就重画
  useEffect(() => {
    const target = baseRef.current;
    if (!page || !target) return;
    const canvas = document.createElement("canvas");
    const out = pdfOutputScale(inner.width, inner.height, dpr);
    const viewport = page.getViewport({ scale: cssScale * out });
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    return renderInto(page, lib, target, canvas, cssScale * out, () => setFailed(true));
  }, [page, lib, inner.width, inner.height, cssScale, dpr]);

  // 补画的那一块：位置按百分比写（倍数变了旧的跟着页一起缩放，不错位，等新的换上）
  const dx = detail?.x;
  const dy = detail?.y;
  const dw = detail?.width;
  const dh = detail?.height;
  useEffect(() => {
    const target = detailRef.current;
    if (!target) return;
    if (!page || dx === undefined || dy === undefined || dw === undefined || dh === undefined) {
      target.replaceChildren();
      return;
    }
    // detail 是相对位置框的；页按比例放进框里时去掉两边空出的
    const x0 = Math.max(0, dx - (inner.left - box.left));
    const y0 = Math.max(0, dy - (inner.top - box.top));
    const x1 = Math.min(inner.width, dx + dw - (inner.left - box.left));
    const y1 = Math.min(inner.height, dy + dh - (inner.top - box.top));
    if (x1 <= x0 || y1 <= y0) {
      target.replaceChildren();
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round((x1 - x0) * dpr));
    canvas.height = Math.max(1, Math.round((y1 - y0) * dpr));
    Object.assign(canvas.style, {
      left: `${(x0 / inner.width) * 100}%`,
      top: `${(y0 / inner.height) * 100}%`,
      width: `${((x1 - x0) / inner.width) * 100}%`,
      height: `${((y1 - y0) / inner.height) * 100}%`,
    });
    return renderInto(page, lib, target, canvas, cssScale * dpr, () => target.replaceChildren(), [1, 0, 0, 1, -x0 * dpr, -y0 * dpr]);
  }, [page, lib, dx, dy, dw, dh, inner.left, inner.top, inner.width, inner.height, box.left, box.top, cssScale, dpr]);

  // 文字层：挂上时画一次（位置是百分比、字号跟着 --total-scale-factor，倍数变了不用重画）
  useEffect(() => {
    const container = textRef.current;
    if (!page || !container) return;
    container.replaceChildren();
    const layer = new lib.TextLayer({ textContentSource: page.streamTextContent(), container, viewport: page.getViewport({ scale: 1 }) });
    layer.render().then(
      () => {
        const end = document.createElement("div");
        end.className = "endOfContent";
        container.append(end);
      },
      () => {},
    );
    return () => layer.cancel();
  }, [page, lib]);

  // 卸掉时（滚远了、关了报告页）放掉 pdf.js 那边这一页的缓存；放在最后：先取消上面的画图。
  // 关报告页时文档可能已经先关掉了，那时不用放，出错也不管
  useEffect(
    () => () => {
      try {
        void page?.cleanup();
      } catch {
        // 文档已经关了
      }
    },
    [page],
  );

  const style = { left: inner.left, top: inner.top, width: inner.width, height: inner.height, "--total-scale-factor": String(cssScale) } as CSSProperties;
  return (
    <div className="pdf-page" style={style} data-page={index + 1}>
      <div ref={baseRef} className="pdf-page-base" />
      <div ref={detailRef} className="pdf-page-detail" />
      <div ref={textRef} className="textLayer" />
      {failed && <div className="pdf-page-failed muted">{t("pages.report.pdfPageFailed", { page: index + 1 })}</div>}
    </div>
  );
});
