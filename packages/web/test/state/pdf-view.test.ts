// 报告页预览 PDF 的算术（state/pdf-view.ts）：一页页往下排、只画够近的页、画多清楚、放大后补画的那一块、缩放和滚动位置互换
// （照搬图片查看器 image-zoom.ts 的算术：以点为中心缩放后那一点不动，松手、双击不跳回文档正中）、打不开时是哪种情况。
// 手势怎么接到这些函数上、真的画没画出来，由真页面上的 test/pdf-preview-page.test.ts 查。
import { describe, expect, test } from "vitest";
import {
  DOUBLE_TAP_MS,
  DOUBLE_TAP_SLOP,
  docBox,
  docDoubleTap,
  docOffset,
  docPreview,
  docScrollOf,
  docSettle,
  docViewOf,
  isDoubleTap,
  PDF_CANVAS_MAX_SIDE,
  PDF_GAP,
  PDF_MAX_WIDTH,
  PDF_PAD,
  PDF_PAGE_MAX_PIXELS,
  pdfDetailRect,
  type PdfFrame,
  pdfLayout,
  pdfNeedsDetail,
  pdfOpenProblemOf,
  pdfOutputScale,
  pdfPagesNear,
  pinchStep,
  scaleAround,
  ZOOM_DOUBLE_TAP,
  ZOOM_MAX,
  zoomAt,
  type ZoomPoint,
  type ZoomView,
} from "../../src/state/index.ts";

/** A4 竖版（PDF 的单位，pdf.js 1 倍时按 CSS 像素算） */
const A4 = { width: 595, height: 842 };
/** 横版的一页 */
const LANDSCAPE = { width: 842, height: 595 };

/** 手机竖屏：放 PDF 的框 390×700 */
const PHONE = { width: 390, height: 700 };

const frame = (size: { width: number; height: number }, left = 0, top = 0): PdfFrame => ({ ...size, left, top });

/** 框里的一点（相对框中心）下面是文档上的哪一点（1 倍时排版的 CSS 像素，相对文档左上角）：按"现在的样子"（倍数、滚动位置）算 */
function docPointAt(layout: ReturnType<typeof pdfLayout>, zoom: number, f: PdfFrame, p: ZoomPoint): ZoomPoint {
  const off = docOffset(layout, zoom, f);
  return { x: (p.x + f.width / 2 + f.left - off.x) / zoom, y: (p.y + f.height / 2 + f.top - off.y) / zoom };
}

/** 视图定下来以后（滚到 docScrollOf 给的位置）框里那一点下面是文档上的哪一点 */
function docPointAfter(layout: ReturnType<typeof pdfLayout>, view: ZoomView, size: { width: number; height: number }, p: ZoomPoint): ZoomPoint {
  const scroll = docScrollOf(layout, view, size);
  return docPointAt(layout, view.scale, frame(size, scroll.left, scroll.top), p);
}

function expectPoint(got: ZoomPoint, want: ZoomPoint, digits = 6) {
  expect(got.x).toBeCloseTo(want.x, digits);
  expect(got.y).toBeCloseTo(want.y, digits);
}

describe("排版：按框宽一页页往下排", () => {
  test("每页撑满（减两边留白），高按自己的比例；页和页之间、四周留白；横版的页矮", () => {
    const layout = pdfLayout([A4, LANDSCAPE, A4], 390);
    const w = 390 - 2 * PDF_PAD;
    expect(layout.width).toBe(390);
    expect(layout.pages[0]).toMatchObject({ left: PDF_PAD, top: PDF_PAD, width: w });
    expect(layout.pages[0]!.height).toBeCloseTo((w * 842) / 595, 6);
    expect(layout.pages[1]!.top).toBeCloseTo(PDF_PAD + (w * 842) / 595 + PDF_GAP, 6);
    expect(layout.pages[1]!.height).toBeCloseTo((w * 595) / 842, 6);
    const last = layout.pages[2]!;
    expect(layout.height).toBeCloseTo(last.top + last.height + PDF_PAD, 6);
  });

  test("电脑上的宽框：文档最宽 PDF_MAX_WIDTH，比框窄时左右居中", () => {
    const layout = pdfLayout([A4], 1200);
    expect(layout.width).toBe(PDF_MAX_WIDTH);
    expect(docOffset(layout, 1, { width: 1200, height: 800 }).x).toBe((1200 - PDF_MAX_WIDTH) / 2);
    // 放大到比框宽：不再空出来
    expect(docOffset(layout, 2, { width: 1200, height: 800 }).x).toBe(0);
  });

  test("一页的短 PDF 在高的框里上下居中（和图片查看器一样，缩放的算术不用分情况）", () => {
    const layout = pdfLayout([LANDSCAPE], 390);
    expect(docOffset(layout, 1, PHONE).y).toBeCloseTo((700 - layout.height) / 2, 6);
  });

  test("页的大小量不出来（0）时按 A4 的比例占位", () => {
    expect(pdfLayout([{ width: 0, height: 0 }], 390).pages[0]!.height).toBeCloseTo((390 - 2 * PDF_PAD) * Math.SQRT2, 6);
  });
});

describe("只画离看得到的地方一屏以内的页", () => {
  const layout = pdfLayout(Array.from({ length: 50 }, () => A4), 390);
  const pageH = layout.pages[0]!.height + PDF_GAP;

  test("刚打开：第一页和下面一屏以内的几页；不是全部 50 页", () => {
    const near = pdfPagesNear(layout, 1, { top: 0, height: 700 })!;
    expect(near.first).toBe(0);
    expect(near.last).toBe(Math.floor((700 * 2 - PDF_PAD) / pageH));
    expect(near.last).toBeLessThan(5);
  });

  test("滚到中间：上下各一屏以内的页", () => {
    const top = pageH * 20;
    const near = pdfPagesNear(layout, 1, { top, height: 700 })!;
    for (let i = near.first; i <= near.last; i++) {
      const p = layout.pages[i]!;
      expect(p.top + p.height).toBeGreaterThanOrEqual(top - 700);
      expect(p.top).toBeLessThanOrEqual(top + 1400);
    }
    // 边上的页不在里面
    expect(layout.pages[near.first - 1]!.top + layout.pages[near.first - 1]!.height).toBeLessThan(top - 700);
    expect(layout.pages[near.last + 1]!.top).toBeGreaterThan(top + 1400);
  });

  test("放大了：按放大后的位置算（一屏里的页更少）", () => {
    const top = pageH * 20 * 3;
    const near = pdfPagesNear(layout, 3, { top, height: 700 })!;
    expect(near.last - near.first).toBeLessThanOrEqual(2);
    expect(near.first).toBeGreaterThanOrEqual(19);
  });

  test("没有页：没有要画的", () => {
    expect(pdfPagesNear(pdfLayout([], 390), 1, { top: 0, height: 700 })).toBeUndefined();
  });
});

describe("画多清楚", () => {
  test("1 倍：按屏幕清晰度（手机 3 倍屏、电脑 2 倍屏都不降）", () => {
    expect(pdfOutputScale(370, 523, 3)).toBe(3);
    expect(pdfOutputScale(840, 1188, 2)).toBe(2);
    expect(pdfNeedsDetail(370, 523, 3)).toBe(false);
  });

  test("放大很多：整张不超过 PDF_PAGE_MAX_PIXELS，要补画看得到的那一块", () => {
    const [w, h] = [370 * 5, 523 * 5];
    const s = pdfOutputScale(w, h, 3);
    expect(s).toBeLessThan(3);
    expect(w * s * (h * s)).toBeLessThanOrEqual(PDF_PAGE_MAX_PIXELS + 1);
    expect(pdfNeedsDetail(w, h, 3)).toBe(true);
  });

  test("很长的一页（收据）：一边不超过 PDF_CANVAS_MAX_SIDE", () => {
    const s = pdfOutputScale(300, 9000, 3);
    expect(9000 * s).toBeLessThanOrEqual(PDF_CANVAS_MAX_SIDE);
  });
});

describe("放大后补画的那一块", () => {
  const layout = pdfLayout([A4, A4], 390);
  const page = layout.pages[0]!;

  test("页和看得到的地方（四边多出一些）相交的部分，相对这一页、取整到像素", () => {
    const zoom = 3;
    const f = frame(PHONE, 300, 400);
    const r = pdfDetailRect(page, zoom, f, docOffset(layout, zoom, f))!;
    const px = page.left * zoom;
    const py = page.top * zoom;
    expect(r.x).toBeLessThanOrEqual(f.left - px);
    expect(r.y).toBeLessThanOrEqual(f.top - py);
    expect(r.x + r.width).toBeGreaterThanOrEqual(f.left + f.width - px);
    expect(r.y + r.height).toBeGreaterThanOrEqual(f.top + f.height - py);
    expect(Number.isInteger(r.x) && Number.isInteger(r.width)).toBe(true);
    // 不超出这一页
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.x + r.width).toBeLessThanOrEqual(Math.ceil(page.width * zoom));
  });

  test("看不到的页没有", () => {
    const f = frame(PHONE, 0, 0);
    expect(pdfDetailRect(layout.pages[1]!, 3, f, docOffset(layout, 3, f))).toBeUndefined();
  });
});

describe("缩放和滚动位置互换（照搬 image-zoom 的算术）", () => {
  const layout = pdfLayout(Array.from({ length: 10 }, () => A4), 390);
  const box = docBox(layout, PHONE);

  test("现在的样子换成视图再换回来，滚动位置不变", () => {
    for (const [zoom, left, top] of [
      [1, 0, 0],
      [1, 0, 2345],
      [2.5, 300, 4000],
      [5, 1500, 10000],
    ] as const) {
      const view = docViewOf(layout, zoom, frame(PHONE, left, top));
      expect(view.scale).toBe(zoom);
      expect(docScrollOf(layout, view, PHONE)).toEqual({ left, top });
    }
  });

  test("手势刚开始（视图就是现在的样子）：transform 什么都不动", () => {
    const from = { ...frame(PHONE, 120, 3000), zoom: 2 };
    expect(docPreview(layout, from, docViewOf(layout, 2, from))).toEqual({ dx: 0, dy: 0, k: 1 });
  });

  test("两指捏合（pinchStep）之后定下来：两指中点下面的那一处文档还在中点下面", () => {
    const from = frame(PHONE, 0, 3000);
    const start = docViewOf(layout, 1, from);
    const before: [ZoomPoint, ZoomPoint] = [
      { x: -40, y: 100 },
      { x: 40, y: 100 },
    ];
    const after: [ZoomPoint, ZoomPoint] = [
      { x: -100, y: 100 },
      { x: 100, y: 100 },
    ];
    const under = docPointAt(layout, 1, from, { x: 0, y: 100 });
    const view = docSettle(pinchStep(start, before, after), box);
    expect(view.scale).toBeCloseTo(2.5, 6);
    expectPoint(docPointAfter(layout, view, PHONE, { x: 0, y: 100 }), under);
  });

  test("手势途中的 transform 和定下来以后看起来一样：按 transform 画出来的那一点就在定下来以后的位置上", () => {
    const from = { ...frame(PHONE, 0, 3000), zoom: 1 };
    const view = docSettle(pinchStep(docViewOf(layout, 1, from), [{ x: -40, y: 50 }, { x: 40, y: 50 }], [{ x: -80, y: 50 }, { x: 80, y: 50 }]), box);
    const { dx, dy, k } = docPreview(layout, from, view);
    expect(k).toBeCloseTo(2, 6);
    // 文档上的一点 u：现在画在 offset - scroll + u（1 倍），加上 transform 是 offset - scroll + d + k·u
    const u = { x: 100, y: 3300 };
    const off = docOffset(layout, 1, from);
    const previewed = { x: off.x - from.left + dx + k * u.x, y: off.y - from.top + dy + k * u.y };
    const scroll = docScrollOf(layout, view, PHONE);
    const offAfter = docOffset(layout, view.scale, PHONE);
    const settled = { x: offAfter.x - scroll.left + view.scale * u.x, y: offAfter.y - scroll.top + view.scale * u.y };
    expectPoint(previewed, settled);
  });

  test("捏小了松手：以框的中心弹回 1 倍，留在原来看的那几页（不跳回文档正中）", () => {
    const top = 4000;
    const center = docPointAt(layout, 1, frame(PHONE, 0, top), { x: 0, y: 0 });
    // 以框中心捏到 0.6 倍
    const small = scaleAround(docViewOf(layout, 1, frame(PHONE, 0, top)), 0.6, { x: 0, y: 0 });
    const back = docSettle(small, box);
    expect(back.scale).toBe(1);
    expectPoint(docPointAfter(layout, back, PHONE, { x: 0, y: 0 }), center);
  });

  test("拖不出文档的边：滚动位置在 0 和最远之间", () => {
    const view = docSettle({ scale: 2, x: 99999, y: -99999 }, box);
    const s = docScrollOf(layout, view, PHONE);
    expect(s.left).toBe(0);
    expect(s.top).toBeCloseTo(layout.height * 2 - PHONE.height, 6);
  });

  test("双击：1 倍时以点的位置放大到 2.5 倍、那一处不动；放大着时以点的位置回 1 倍（不跳回文档正中）", () => {
    // 滚到中间（10 页 A4 在手机上最远能滚到 4600 多）
    const f = frame(PHONE, 0, 3000);
    const p = { x: 30, y: -120 };
    const under = docPointAt(layout, 1, f, p);
    const zoomed = docDoubleTap(docViewOf(layout, 1, f), p, box);
    expect(zoomed.scale).toBe(ZOOM_DOUBLE_TAP);
    expectPoint(docPointAfter(layout, zoomed, PHONE, p), under);
    const back = docDoubleTap(zoomed, p, box);
    expect(back.scale).toBe(1);
    // 横向回到 1 倍时文档正好框宽，只能是 0；纵向那一处不动
    expect(docPointAfter(layout, back, PHONE, p).y).toBeCloseTo(under.y, 6);
  });

  test("Ctrl + 滚轮（zoomAt）：1–5 倍，以鼠标位置为中心", () => {
    const f = frame(PHONE, 0, 2000);
    let view = docViewOf(layout, 1, f);
    const p = { x: -50, y: 80 };
    const under = docPointAt(layout, 1, f, p);
    for (let i = 0; i < 30; i++) view = zoomAt(view, 1.3, p, box);
    expect(view.scale).toBe(ZOOM_MAX);
    expectPoint(docPointAfter(layout, view, PHONE, p), under);
    for (let i = 0; i < 30; i++) view = zoomAt(view, 0.7, p, box);
    expect(view.scale).toBe(1);
  });
});

describe("双击的判定（和图片查看器同一份）", () => {
  test("隔得近、离得近才算", () => {
    const first = { at: 1000, x: 100, y: 100 };
    expect(isDoubleTap(undefined, first)).toBe(false);
    expect(isDoubleTap(first, { at: 1000 + DOUBLE_TAP_MS, x: 110, y: 100 })).toBe(true);
    expect(isDoubleTap(first, { at: 1001 + DOUBLE_TAP_MS, x: 100, y: 100 })).toBe(false);
    expect(isDoubleTap(first, { at: 1100, x: 100 + DOUBLE_TAP_SLOP + 1, y: 100 })).toBe(false);
  });
});

describe("打不开时是哪种情况（按 pdf.js 报的错的名字）", () => {
  test("要密码、坏的、别的", () => {
    expect(pdfOpenProblemOf("PasswordException")).toBe("encrypted");
    for (const name of ["InvalidPDFException", "FormatError", "UnknownErrorException"]) expect(pdfOpenProblemOf(name)).toBe("broken");
    // pdf.js 没加载上（import 失败是 TypeError）、连不上、没有名字的
    for (const name of ["TypeError", "Error", "AbortError", undefined]) expect(pdfOpenProblemOf(name)).toBe("failed");
  });
});
