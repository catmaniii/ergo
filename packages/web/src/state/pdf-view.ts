// 报告页预览 PDF（ui/pdf-view.tsx）的算术，纯函数，不碰 DOM：一页页往下排、该画哪几页、画多清楚、放大后补画的那一块、
// 缩放和滚动位置怎么互换、打不开时是哪种情况。
//
// 排版：按"放 PDF 的框"（报告页里能滚动的那块）的宽度排，最宽 PDF_MAX_WIDTH，比框小的方向居中；每一页都撑满排版宽度
// （减去两边的留白），高按这一页自己的比例。排出来的是 1 倍时的大小（CSS 像素），放大 zoom 倍就整个乘 zoom，留白、页间距一起变。
//
// 缩放：把整份文档（1 倍时排好的那一长条）当成图片查看器里的"图"、把框当成"放图的框"，缩放的算术照搬
// state/image-zoom.ts（405）：两指一帧用 pinchStep，滚轮用 zoomAt，以某点为中心用 scaleAround，拖不出边用 clampPan。
// 视图 { scale, x, y } 是文档中心离框中心的位移，和框的滚动位置一一对应（docViewOf / docScrollOf）。
// 和图片不同的两处：松手比 1 倍小时以框的中心弹回 1 倍、双击已放大时以点的位置回 1 倍——都不跳回文档正中
// （长文档的"居中"是第几十页），见 docSettle、docDoubleTap。
import { clampPan, isZoomed, scaleAround, ZOOM_DOUBLE_TAP, ZOOM_MAX, type ZoomBox, type ZoomPoint, type ZoomView } from "./image-zoom.ts";

/** 网页带的 pdf.js 是哪一版（package.json 里 pdfjs-dist 写死的版本；构建时核对，升级时一起改） */
export const PDFJS_VERSION = "6.5.438";
/** pdf.js 的文件在网页构建产物里放在哪（相对页面）：目录带着版本，同一个地址内容不变，守护进程让浏览器长期缓存 */
export const PDFJS_DIR = `pdfjs/${PDFJS_VERSION}/`;

/** 1 倍时文档最宽多少（CSS 像素）：电脑上不撑满整个宽窗口，和报告页的正文一样宽 */
export const PDF_MAX_WIDTH = 860;
/** 文档四周的留白、页和页之间的距离（1 倍时，CSS 像素） */
export const PDF_PAD = 10;
export const PDF_GAP = 10;
/** 一页画成一张图最多多少像素：再大按比例降清晰度（放大后看得到的那一块另外补画清楚的，见 pdfDetailRect） */
export const PDF_PAGE_MAX_PIXELS = 4_194_304;
/** 一张图一边最多多少像素（有的手机的显卡只认到这么大） */
export const PDF_CANVAS_MAX_SIDE = 8192;
/** 离看得到的地方多远（按框高的几倍算）以内的页才画；更远的只占位置，滚近了再画 */
export const PDF_NEAR_SCREENS = 1;
/** 补画清楚的那一块比看得到的地方四边各多出多少（按框宽、框高的比例） */
export const PDF_DETAIL_OVERSCAN = 0.25;
/** 页数不超过这么多时一打开就量出每一页的大小；更多的先按第一页的大小占位，画到哪页再按它自己的大小改 */
export const PDF_MEASURE_ALL_MAX = 300;

/** 一页的大小（pdf.js 按 1 倍取的视口：PDF 的单位，1/72 英寸，算 1 个 CSS 像素） */
export interface PdfPageSize {
  readonly width: number;
  readonly height: number;
}

/** 排好的一页：1 倍时在文档里的位置和大小（CSS 像素，相对文档的左上角） */
export interface PdfPageBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** 1 倍时整份文档排出来的样子 */
export interface PdfLayout {
  readonly width: number;
  readonly height: number;
  readonly pages: readonly PdfPageBox[];
}

/** 框（能滚动的那块）：可见部分的大小和现在滚到哪 */
export interface PdfFrame {
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly top: number;
}

/** 按框的宽度排：文档宽 min(框宽, PDF_MAX_WIDTH)，每页撑满（减两边留白）、高按自己的比例，从上往下排 */
export function pdfLayout(sizes: readonly PdfPageSize[], frameWidth: number): PdfLayout {
  const width = Math.max(2 * PDF_PAD + 1, Math.min(frameWidth, PDF_MAX_WIDTH));
  const pageWidth = width - 2 * PDF_PAD;
  let top = PDF_PAD;
  const pages = sizes.map((size) => {
    const ratio = size.width > 0 && size.height > 0 ? size.height / size.width : Math.SQRT2;
    const box = { left: PDF_PAD, top, width: pageWidth, height: pageWidth * ratio };
    top += box.height + PDF_GAP;
    return box;
  });
  return { width, height: pages.length > 0 ? top - PDF_GAP + PDF_PAD : 2 * PDF_PAD, pages };
}

/**
 * 文档放大 zoom 倍后比框小的方向居中：左边、上边空出多少（CSS 像素）。和图片查看器一样（比框小的方向居中），
 * 缩放的算术不用另外分情况；一页的短 PDF 在高的框里上下居中
 */
export function docOffset(layout: PdfLayout, zoom: number, frame: Pick<PdfFrame, "width" | "height">): ZoomPoint {
  return { x: Math.max(0, (frame.width - layout.width * zoom) / 2), y: Math.max(0, (frame.height - layout.height * zoom) / 2) };
}

/** 放大 zoom 倍时，离框里看得到的地方（上下各多 PDF_NEAR_SCREENS 个框高）够近的页：第一页、最后一页（从 0 数）；一页都没有是 undefined */
export function pdfPagesNear(layout: PdfLayout, zoom: number, frame: Pick<PdfFrame, "top" | "height">): { first: number; last: number } | undefined {
  const { pages } = layout;
  if (pages.length === 0) return undefined;
  const margin = frame.height * PDF_NEAR_SCREENS;
  const from = (frame.top - margin) / zoom;
  const to = (frame.top + frame.height + margin) / zoom;
  // 页是从上往下排的：二分找第一页底边在 from 下面的
  let lo = 0;
  let hi = pages.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const p = pages[mid]!;
    if (p.top + p.height < from) lo = mid + 1;
    else hi = mid;
  }
  // 找不到挨着的（滚到了文档外面）时至少给最近的一页
  let last = lo;
  while (last + 1 < pages.length && pages[last + 1]!.top <= to) last++;
  return { first: lo, last };
}

/**
 * 一页画成图时每个 CSS 像素用几个像素：按屏幕的清晰度（devicePixelRatio），但整张不超过 PDF_PAGE_MAX_PIXELS、
 * 一边不超过 PDF_CANVAS_MAX_SIDE（放大很多时降下来，看得到的那一块另外补画）
 */
export function pdfOutputScale(cssWidth: number, cssHeight: number, dpr: number): number {
  if (cssWidth <= 0 || cssHeight <= 0) return dpr;
  return Math.min(dpr, Math.sqrt(PDF_PAGE_MAX_PIXELS / (cssWidth * cssHeight)), PDF_CANVAS_MAX_SIDE / Math.max(cssWidth, cssHeight));
}

/** 这一页整张画的够不够清楚（没被上限降下来）：不够的放大后要补画看得到的那一块 */
export function pdfNeedsDetail(cssWidth: number, cssHeight: number, dpr: number): boolean {
  return pdfOutputScale(cssWidth, cssHeight, dpr) < dpr * 0.999;
}

/** 页上的一块（CSS 像素，相对这一页的左上角） */
export interface PdfRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * 放大后补画清楚的那一块：这一页和框里看得到的地方（四边各多 PDF_DETAIL_OVERSCAN）相交的部分，取整到像素；不相交是 undefined。
 * page 是 1 倍时排好的这一页，zoom 是现在的倍数，offset 是文档比框小时空出的（docOffset）
 */
export function pdfDetailRect(page: PdfPageBox, zoom: number, frame: PdfFrame, offset: ZoomPoint): PdfRect | undefined {
  const px = offset.x + page.left * zoom;
  const py = offset.y + page.top * zoom;
  const pw = page.width * zoom;
  const ph = page.height * zoom;
  const mx = frame.width * PDF_DETAIL_OVERSCAN;
  const my = frame.height * PDF_DETAIL_OVERSCAN;
  const x0 = Math.max(px, frame.left - mx);
  const y0 = Math.max(py, frame.top - my);
  const x1 = Math.min(px + pw, frame.left + frame.width + mx);
  const y1 = Math.min(py + ph, frame.top + frame.height + my);
  if (x1 <= x0 || y1 <= y0) return undefined;
  const x = Math.floor(x0 - px);
  const y = Math.floor(y0 - py);
  return { x, y, width: Math.ceil(x1 - px) - x, height: Math.ceil(y1 - py) - y };
}

/** 文档在缩放算术里的"框"和"图"：框是看得到的那块，图是 1 倍时排好的整份文档 */
export function docBox(layout: PdfLayout, frame: Pick<PdfFrame, "width" | "height">): ZoomBox {
  return { width: frame.width, height: frame.height, imageWidth: layout.width, imageHeight: layout.height };
}

/** 文档放大 zoom 倍、框滚到 (left, top) 时，文档左上角画在框里的哪（相对框的左上角） */
function docOrigin(layout: PdfLayout, zoom: number, frame: PdfFrame): ZoomPoint {
  const offset = docOffset(layout, zoom, frame);
  return { x: offset.x - frame.left, y: offset.y - frame.top };
}

/** 现在的样子（放大 zoom 倍、框滚到 frame.left、frame.top）换成缩放算术里的视图：文档中心离框中心多远 */
export function docViewOf(layout: PdfLayout, zoom: number, frame: PdfFrame): ZoomView {
  const o = docOrigin(layout, zoom, frame);
  return { scale: zoom, x: o.x + (layout.width * zoom) / 2 - frame.width / 2, y: o.y + (layout.height * zoom) / 2 - frame.height / 2 };
}

/** 视图（收好边的）换回框该滚到哪；比框小的那个方向是 0（由 docOffset 居中） */
export function docScrollOf(layout: PdfLayout, view: ZoomView, frame: Pick<PdfFrame, "width" | "height">): { left: number; top: number } {
  return {
    left: Math.max(0, (layout.width * view.scale) / 2 - frame.width / 2 - view.x),
    top: Math.max(0, (layout.height * view.scale) / 2 - frame.height / 2 - view.y),
  };
}

/**
 * 手势途中先用 CSS 缩放顶着（停下来再按新比例重排、重画）：文档还按 committed（上次定下的倍数和滚动位置）排着，
 * 要看起来像 view 那样，给文档写 transform: translate(dx, dy) scale(k)（以文档左上角为原点）
 */
export function docPreview(layout: PdfLayout, committed: PdfFrame & { zoom: number }, view: ZoomView): { dx: number; dy: number; k: number } {
  const from = docOrigin(layout, committed.zoom, committed);
  const to = { x: committed.width / 2 + view.x - (layout.width * view.scale) / 2, y: committed.height / 2 + view.y - (layout.height * view.scale) / 2 };
  return { dx: to.x - from.x, dy: to.y - from.y, k: view.scale / committed.zoom };
}

/** 手都松开了：不比 1 倍大的以框的中心弹回 1 倍（不跳回文档正中），放大着的收到文档的边；最大 ZOOM_MAX */
export function docSettle(view: ZoomView, box: ZoomBox): ZoomView {
  if (!isZoomed(view)) return clampPan(scaleAround(view, 1, { x: 0, y: 0 }), box);
  return clampPan(view.scale > ZOOM_MAX ? scaleAround(view, ZOOM_MAX, { x: 0, y: 0 }) : view, box);
}

/** 双击：1 倍时以点的位置放大到 ZOOM_DOUBLE_TAP 倍；放大着时以点的位置回到 1 倍（点下面那一处不动，碰到边时除外） */
export function docDoubleTap(view: ZoomView, point: ZoomPoint, box: ZoomBox): ZoomView {
  return clampPan(scaleAround(view, isZoomed(view) ? 1 : ZOOM_DOUBLE_TAP, point), box);
}

/** 打不开的几种情况：加了密码、坏的（不是 PDF、不完整）、别的（pdf.js 没加载上、连不上、读不出来） */
export type PdfOpenProblem = "encrypted" | "broken" | "failed";

/** pdf.js 报的错（按错误的名字）是哪种情况 */
export function pdfOpenProblemOf(errorName: string | undefined): PdfOpenProblem {
  switch (errorName) {
    case "PasswordException":
      return "encrypted";
    case "InvalidPDFException":
    case "FormatError":
    case "UnknownErrorException":
      return "broken";
    default:
      return "failed";
  }
}
