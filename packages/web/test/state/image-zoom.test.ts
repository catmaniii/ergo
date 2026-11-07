// 图片查看器的缩放算术（state/image-zoom.ts）：以点为中心缩放后那一点在屏幕上不动、两指捏合、范围限制（1–5 倍，
// 捏合途中最小 0.5 倍）、拖不出图的边、1 倍时居中、松手小于 1 倍弹回、双击切换、滚轮换算。
// 手势怎么接到这些函数上、松手不算点，由真页面上的 test/image-viewer-page.test.ts 查。
import { describe, expect, test } from "vitest";
import {
  clampPan,
  doubleTapZoom,
  isZoomed,
  panBy,
  pinchStep,
  scaleAround,
  settle,
  wheelFactor,
  ZOOM_DOUBLE_TAP,
  ZOOM_FIT,
  ZOOM_MAX,
  ZOOM_PINCH_FLOOR,
  zoomAt,
  type ZoomBox,
  type ZoomPoint,
  type ZoomView,
} from "../../src/state/index.ts";

/** 手机竖屏：放图的框 366×724，一张横图 1 倍时按宽放进去 366×229 */
const PHONE: ZoomBox = { width: 366, height: 724, imageWidth: 366, imageHeight: 229 };

/** 屏幕上的一点 p（相对框中心）下面是图上的哪一点（相对图中心、按 1 倍的像素） */
const imageAt = (v: ZoomView, p: ZoomPoint): ZoomPoint => ({ x: (p.x - v.x) / v.scale, y: (p.y - v.y) / v.scale });
/** 图上的一点 u 画在屏幕上的哪里 */
const screenOf = (v: ZoomView, u: ZoomPoint): ZoomPoint => ({ x: v.x + v.scale * u.x, y: v.y + v.scale * u.y });

function expectPoint(got: ZoomPoint, want: ZoomPoint) {
  expect(got.x).toBeCloseTo(want.x, 6);
  expect(got.y).toBeCloseTo(want.y, 6);
}

/**
 * 一个方向上"不对劲"的量：图比框大时是露出来的深色底有多宽（图边离开了框边），图比框小时是离居中差多少。
 * 两个方向都是 0 才对
 */
function offness(center: number, size: number, box: number): number {
  const half = size / 2;
  const gap = size >= box ? Math.max(0, center - half + box / 2, box / 2 - (center + half)) : Math.abs(center);
  return Math.round(gap * 1e6) / 1e6;
}
function expectCovers(v: ZoomView, box: ZoomBox) {
  expect({ x: offness(v.x, box.imageWidth * v.scale, box.width), y: offness(v.y, box.imageHeight * v.scale, box.height) }).toEqual({ x: 0, y: 0 });
}

describe("以点为中心缩放：那一点下面的图在屏幕上不动", () => {
  test.each<[ZoomView, number, ZoomPoint]>([
    [ZOOM_FIT, 2.5, { x: 100, y: 40 }],
    [ZOOM_FIT, 5, { x: -150, y: -90 }],
    [{ scale: 3, x: 120, y: -60 }, 1.5, { x: 10, y: 10 }],
    [{ scale: 2, x: -50, y: 30 }, 4, { x: -170, y: 200 }],
  ])("从 %o 缩放到 %f 倍，中心 %o", (view, scale, point) => {
    const u = imageAt(view, point);
    const next = scaleAround(view, scale, point);
    expect(next.scale).toBe(scale);
    expectPoint(screenOf(next, u), point);
  });

  test("滚轮：在图中间放大，鼠标下面那一点不动；比例乘上 factor", () => {
    const point = { x: 60, y: 20 };
    const u = imageAt(ZOOM_FIT, point);
    const next = zoomAt(ZOOM_FIT, 1.5, point, PHONE);
    expect(next.scale).toBeCloseTo(1.5, 9);
    // 1.5 倍时图高 343.5，还比框矮：竖着居中（y 收回 0），横着那一点不动
    expect(next.y).toBe(0);
    expect(screenOf(next, u).x).toBeCloseTo(point.x, 6);
  });

  test("滚轮：比例在 1 到 5 倍之间，到头了再滚不动", () => {
    const max = zoomAt({ scale: 4, x: 0, y: 0 }, 3, { x: 0, y: 0 }, PHONE);
    expect(max.scale).toBe(ZOOM_MAX);
    expect(zoomAt(max, 1.2, { x: 30, y: 30 }, PHONE)).toBe(max);
    expect(zoomAt({ scale: 1.2, x: 10, y: 0 }, 0.5, { x: 0, y: 0 }, PHONE)).toEqual(ZOOM_FIT);
    expect(zoomAt(ZOOM_FIT, 0.8, { x: 50, y: 50 }, PHONE)).toBe(ZOOM_FIT);
  });
});

describe("两指捏合", () => {
  test("两指拉开一倍：比例翻倍，两指中点下面那一点图不动", () => {
    const before: [ZoomPoint, ZoomPoint] = [
      { x: 40, y: 20 },
      { x: 100, y: 20 },
    ];
    const after: [ZoomPoint, ZoomPoint] = [
      { x: 10, y: 20 },
      { x: 130, y: 20 },
    ];
    const u = imageAt(ZOOM_FIT, { x: 70, y: 20 });
    const next = pinchStep(ZOOM_FIT, before, after);
    expect(next.scale).toBeCloseTo(2, 9);
    expectPoint(screenOf(next, u), { x: 70, y: 20 });
  });

  test("一边捏一边挪：开始时中点下面那一点图，跟到了新的中点下面", () => {
    const view = { scale: 2, x: 30, y: -40 };
    const before: [ZoomPoint, ZoomPoint] = [
      { x: -20, y: 0 },
      { x: 20, y: 30 },
    ];
    const after: [ZoomPoint, ZoomPoint] = [
      { x: 10, y: 60 },
      { x: 90, y: 120 },
    ];
    const u = imageAt(view, { x: 0, y: 15 });
    const next = pinchStep(view, before, after);
    expect(next.scale).toBeCloseTo(4, 9);
    expectPoint(screenOf(next, u), { x: 50, y: 90 });
  });

  test("最大 5 倍；捏小途中最小到 0.5 倍", () => {
    const wide: [ZoomPoint, ZoomPoint] = [
      { x: -150, y: 0 },
      { x: 150, y: 0 },
    ];
    const narrow: [ZoomPoint, ZoomPoint] = [
      { x: -5, y: 0 },
      { x: 5, y: 0 },
    ];
    expect(pinchStep({ scale: 3, x: 0, y: 0 }, narrow, wide).scale).toBe(ZOOM_MAX);
    expect(pinchStep(ZOOM_FIT, wide, narrow).scale).toBe(ZOOM_PINCH_FLOOR);
    expect(ZOOM_PINCH_FLOOR).toBeLessThan(1);
  });

  test("两指叠在一起（距离 0）不改比例，只跟着挪", () => {
    const same: [ZoomPoint, ZoomPoint] = [
      { x: 5, y: 5 },
      { x: 5, y: 5 },
    ];
    const moved: [ZoomPoint, ZoomPoint] = [
      { x: 25, y: 5 },
      { x: 25, y: 5 },
    ];
    const next = pinchStep({ scale: 2, x: 0, y: 0 }, same, moved);
    expect(next).toEqual({ scale: 2, x: 20, y: 0 });
  });
});

describe("拖动和范围：拖不出图的边，图比框小的方向居中", () => {
  test("1 倍时单指拖动不动图，永远居中", () => {
    expect(panBy(ZOOM_FIT, 80, -120, PHONE)).toBe(ZOOM_FIT);
    expect(clampPan({ scale: 1, x: 40, y: -30 }, PHONE)).toEqual(ZOOM_FIT);
  });

  test("放大到 3 倍：横着最远拖到图边贴着框边，竖着图比框矮、保持居中", () => {
    // 3 倍时图 1098×687：横着最远离中心 (1098 − 366) / 2 = 366，竖着 687 < 724 居中
    const right = panBy({ scale: 3, x: 0, y: 0 }, 1000, 500, PHONE);
    expect(right).toEqual({ scale: 3, x: 366, y: 0 });
    const left = panBy(right, -2000, -500, PHONE);
    expect(left).toEqual({ scale: 3, x: -366, y: 0 });
    expectCovers(left, PHONE);
    const mid = panBy(left, 100, 0, PHONE);
    expect(mid).toEqual({ scale: 3, x: -266, y: 0 });
  });

  test("放大到 5 倍：两个方向都比框大，都拖不出边", () => {
    // 5 倍时图 1830×1145：横着最远 732，竖着最远 (1145 − 724) / 2 = 210.5
    const v = panBy({ scale: 5, x: 0, y: 0 }, -5000, 5000, PHONE);
    expect(v.x).toBeCloseTo(-732, 9);
    expect(v.y).toBeCloseTo(210.5, 9);
    expectCovers(v, PHONE);
  });

  test("没超出范围的不换对象（不白白重画）", () => {
    const v = { scale: 3, x: 100, y: 0 };
    expect(clampPan(v, PHONE)).toBe(v);
  });
});

describe("松手", () => {
  test("小于 1 倍弹回 1 倍、居中", () => {
    expect(settle({ scale: 0.6, x: 40, y: -12 }, PHONE)).toEqual(ZOOM_FIT);
    expect(settle({ scale: 1, x: 3, y: 0 }, PHONE)).toEqual(ZOOM_FIT);
    expect(settle(ZOOM_FIT, PHONE)).toBe(ZOOM_FIT);
  });

  test("放大着的：捏合途中挪出边的位移收回来，比例不变", () => {
    const v = settle({ scale: 2, x: 900, y: -300 }, PHONE);
    // 2 倍时图 732×458：横着最远 183，竖着居中
    expect(v).toEqual({ scale: 2, x: 183, y: 0 });
    // 本来就在范围里的不换对象（拖完松手不白白重画）
    expect(settle(v, PHONE)).toBe(v);
  });
});

describe("双击", () => {
  test("1 倍时以点的位置放大到 2.5 倍，那一点不动（没碰到图边时）", () => {
    const point = { x: 50, y: 30 };
    const u = imageAt(ZOOM_FIT, point);
    const next = doubleTapZoom(ZOOM_FIT, point, PHONE);
    expect(next.scale).toBe(ZOOM_DOUBLE_TAP);
    // 2.5 倍时图 915×572.5，比框矮：竖着居中；横着点下面那一点不动
    expect(next.y).toBe(0);
    expect(screenOf(next, u).x).toBeCloseTo(point.x, 6);
  });

  test("点在图边附近：放大后图边贴着框边，不露出深色底", () => {
    // 一张小图 1 倍时原大 200×300（不放大到框）：2.5 倍时 500×750，横着最远离中心 67
    const small: ZoomBox = { width: 366, height: 724, imageWidth: 200, imageHeight: 300 };
    const next = doubleTapZoom(ZOOM_FIT, { x: -95, y: 0 }, small);
    expect(next.scale).toBe(ZOOM_DOUBLE_TAP);
    expect(next.x).toBe(67);
    expectCovers(next, small);
  });

  test("已放大时回到 1 倍", () => {
    expect(doubleTapZoom({ scale: 2.5, x: 100, y: 0 }, { x: 0, y: 0 }, PHONE)).toBe(ZOOM_FIT);
    expect(doubleTapZoom({ scale: 4.2, x: -30, y: 10 }, { x: 70, y: 70 }, PHONE)).toBe(ZOOM_FIT);
  });

  test("isZoomed：比 1 倍大才算放大着", () => {
    expect(isZoomed(ZOOM_FIT)).toBe(false);
    expect(isZoomed({ scale: 0.7, x: 0, y: 0 })).toBe(false);
    expect(isZoomed({ scale: 1.2, x: 0, y: 0 })).toBe(true);
  });
});

describe("滚轮换算", () => {
  test("往上滚放大、往下滚缩小，来回一样多抵消", () => {
    expect(wheelFactor(-100, 0)).toBeGreaterThan(1);
    expect(wheelFactor(100, 0)).toBeLessThan(1);
    expect(wheelFactor(-100, 0) * wheelFactor(100, 0)).toBeCloseTo(1, 9);
  });

  test("一格鼠标滚轮（100 像素）约 1.2 倍；按行滚的换成像素", () => {
    expect(wheelFactor(-100, 0)).toBeCloseTo(Math.exp(0.2), 9);
    expect(wheelFactor(-3, 1)).toBeCloseTo(wheelFactor(-48, 0), 9);
  });

  test("一下最多按 300 像素算；触控板捏合（Ctrl + 滚轮）一下的量小，系数大一些", () => {
    expect(wheelFactor(-5000, 0)).toBeCloseTo(wheelFactor(-300, 0), 9);
    expect(wheelFactor(-1, 2)).toBeCloseTo(wheelFactor(-300, 0), 9);
    expect(wheelFactor(-10, 0, true)).toBeGreaterThan(wheelFactor(-10, 0));
  });
});
