// 会话缩放的数学部分（54 号票，ui/zoom/zoom.ts）：档位（levelOf，对数空间里最近的一档）、
// 三层的不透明度（layerOpacity，交叉淡入淡出）、松手吸附（snap）、锚点公式（缩放时焦点下面那一点内容不动）、
// 对数空间插值的动画、写给 CSS 的变量。手势和观感靠用户评审，这里不测。
// 缩放控制器要的几个元素换成假的（只留它读写的那几个属性），requestAnimationFrame 换成手动推进的。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { layerOpacity, levelOf, MIN_SCALE, PRESETS, ZoomController, type ZoomLevel } from "../../src/ui/zoom/zoom.ts";

describe("档位：在对数空间里落到最近的一档（1 对话层、0.45 要点层、0.15 全局层）", () => {
  // 分界是相邻两档的几何平均：√(1 × 0.45) ≈ 0.6708，√(0.45 × 0.15) ≈ 0.2598
  test.each<[number, ZoomLevel]>([
    [1, 0],
    [0.9, 0],
    [0.672, 0],
    [0.67, 1],
    [0.6, 1],
    [0.45, 1],
    [0.3, 1],
    [0.26, 1],
    [0.259, 2],
    [0.2, 2],
    [0.15, 2],
  ])("s = %f → 第 %i 档", (s, level) => {
    expect(levelOf(s)).toBe(level);
  });

  test("捏合只到全局层：最小比例是 0.15（计划层那一档 0.06 留在数组里，到不了）", () => {
    expect(PRESETS).toEqual([1, 0.45, 0.15, 0.06]);
    expect(MIN_SCALE).toBe(0.15);
    expect(levelOf(MIN_SCALE)).toBe(2);
  });
});

describe("三层的不透明度：随比例交叉淡入淡出", () => {
  test.each<[number, { o0: number; o1: number; o2: number }]>([
    // 对话层：0.85 以上全显
    [1, { o0: 1, o1: 0, o2: 0 }],
    [0.85, { o0: 1, o1: 0, o2: 0 }],
    // 0.55–0.75 之间对话层和要点层交叉
    [0.75, { o0: 0.6, o1: 0, o2: 0 }],
    [0.65, { o0: 0.2, o1: 0.5, o2: 0 }],
    [0.6, { o0: 0, o1: 0.75, o2: 0 }],
    // 要点层：0.35–0.55 全显
    [0.55, { o0: 0, o1: 1, o2: 0 }],
    [0.45, { o0: 0, o1: 1, o2: 0 }],
    [0.35, { o0: 0, o1: 1, o2: 0 }],
    // 0.22–0.35 之间要点层和全局层交叉
    [0.3, { o0: 0, o1: 0.615, o2: 0 }],
    [0.25, { o0: 0, o1: 0.231, o2: 0.5 }],
    // 全局层：0.2 以下全显
    [0.2, { o0: 0, o1: 0, o2: 1 }],
    [0.15, { o0: 0, o1: 0, o2: 1 }],
  ])("s = %f", (s, want) => {
    const got = layerOpacity(s);
    expect(got.o0).toBeCloseTo(want.o0, 3);
    expect(got.o1).toBeCloseTo(want.o1, 3);
    expect(got.o2).toBeCloseTo(want.o2, 3);
  });

  test("每一档停稳时只显示那一层", () => {
    for (const [level, s] of PRESETS.slice(0, 3).entries()) {
      const o = layerOpacity(s);
      expect([o.o0, o.o1, o.o2]).toEqual([0, 1, 2].map((i) => (i === level ? 1 : 0)));
    }
  });
});

/** 缩放控制器读写的几个元素：视口（宽、滚动位置）、撑高度的 sizer、整体缩放的内容、写 CSS 变量的根 */
function fakeDom(width = 400) {
  const vars = new Map<string, string>();
  const viewport = { clientWidth: width, scrollTop: 0 };
  const sizer = { style: { height: "" } };
  const content = { clientWidth: width, style: { transform: "" } };
  const root = { style: { setProperty: (k: string, v: string) => vars.set(k, v) }, dataset: {} as Record<string, string> };
  const ctl = new ZoomController(viewport as unknown as HTMLElement, sizer as unknown as HTMLElement, content as unknown as HTMLElement, root as unknown as HTMLElement);
  return { ctl, viewport, sizer, content, root, vars };
}

/** 手动推进的 requestAnimationFrame：frame(t) 把排着的回调按时刻 t 跑一遍 */
let queue: Array<(t: number) => void> = [];
beforeEach(() => {
  queue = [];
  vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
    queue.push(cb);
    return queue.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    queue = [];
  });
  vi.spyOn(performance, "now").mockReturnValue(0);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function frame(t: number): void {
  const run = queue;
  queue = [];
  for (const cb of run) cb(t);
}
/** 动画一直跑到停（每 16 毫秒一帧） */
function runToEnd(): number {
  let t = 0;
  while (queue.length > 0 && t < 5000) frame((t += 16));
  return t;
}

describe("锚点：缩放时焦点（双指中点、鼠标、视口中心）下面那一点内容不动", () => {
  test("scrollTop = 内容坐标 × s − 焦点在视口里的高度；contentYAt 反过来算回同一点", () => {
    const { ctl, viewport } = fakeDom();
    ctl.setContentHeight(5000, 0);
    viewport.scrollTop = 1000;
    const focalY = 300;
    const contentY = ctl.contentYAt(focalY);
    expect(contentY).toBe(1300);
    for (const s of [0.8, 0.45, 0.2, 0.15]) {
      ctl.set(s, focalY, contentY);
      expect(viewport.scrollTop).toBeCloseTo(contentY * s - focalY, 6);
      expect(ctl.contentYAt(focalY)).toBeCloseTo(contentY, 6);
    }
  });

  test("双指边捏边平移：每一帧按当前中点算，内容跟着中点走", () => {
    const { ctl, viewport } = fakeDom();
    ctl.setContentHeight(5000, 0);
    viewport.scrollTop = 1000;
    const contentY = ctl.contentYAt(300);
    ctl.set(0.5, 200, contentY);
    expect(ctl.contentYAt(200)).toBeCloseTo(contentY, 6);
    ctl.set(0.4, 420, contentY);
    expect(ctl.contentYAt(420)).toBeCloseTo(contentY, 6);
  });

  test("跟手缩放夹在 [0.15, 1] 之间", () => {
    const { ctl } = fakeDom();
    ctl.set(0.05, 0, 0);
    expect(ctl.s).toBe(MIN_SCALE);
    ctl.set(3, 0, 0);
    expect(ctl.s).toBe(1);
  });

  test("滚动范围（sizer 的高度）= 内容高 × s", () => {
    const { ctl, sizer } = fakeDom();
    ctl.setContentHeight(4000, 0);
    expect(sizer.style.height).toBe("4000px");
    ctl.set(0.45, 0, 0);
    expect(sizer.style.height).toBe("1800px");
  });

  test("只在缩小时出现的尾部区域（extra）：缩小后算进滚动范围，对话层不算（108 号票：缩小后伸到最后一条下面的标注靠它）", () => {
    const { ctl, sizer } = fakeDom();
    ctl.setContentHeight(4000, 300);
    expect(sizer.style.height).toBe("4000px");
    ctl.set(0.45, 0, 0);
    expect(sizer.style.height).toBe(`${(4000 + 300) * 0.45}px`);
    ctl.set(0.95, 0, 0);
    expect(sizer.style.height).toBe(`${4000 * 0.95}px`);
  });
});

describe("松手吸附：动画到最近的一档，焦点下面的内容不动", () => {
  test.each<[number, number]>([
    [0.9, 1],
    [0.6, 0.45],
    [0.3, 0.45],
    [0.25, 0.15],
    [0.17, 0.15],
  ])("从 %f 吸到 %f，用 260 毫秒，停稳时回调一次", (from, to) => {
    const { ctl, viewport } = fakeDom();
    ctl.setContentHeight(8000, 0);
    viewport.scrollTop = 2000;
    const focalY = 250;
    const contentY = ctl.contentYAt(focalY);
    ctl.set(from, focalY, contentY);
    const settled = vi.fn<() => void>();
    ctl.onSettle = settled;
    ctl.snap(focalY, contentY);
    const took = runToEnd();
    expect(ctl.s).toBeCloseTo(to, 9);
    expect(ctl.contentYAt(focalY)).toBeCloseTo(contentY, 6);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(took).toBeGreaterThanOrEqual(260);
    expect(took).toBeLessThan(260 + 16 * 2);
  });

  test("动画在对数空间插值（ease-out 三次）：走到一半时间，比例是两端在对数上 7/8 处", () => {
    const { ctl } = fakeDom();
    ctl.setContentHeight(8000, 0);
    ctl.animateTo(0.15, 0, 0, 0, 400);
    frame(200);
    // e = 1 − (1 − 0.5)³ = 0.875
    expect(ctl.s).toBeCloseTo(Math.exp(Math.log(1) + (Math.log(0.15) - Math.log(1)) * 0.875), 9);
  });

  test("点缩小的条放大回去：焦点那一点从点击处滑到目标高度，比例回到 1", () => {
    const { ctl, viewport } = fakeDom();
    ctl.setContentHeight(8000, 0);
    ctl.set(0.15, 0, 0);
    viewport.scrollTop = 300;
    const tapY = 500;
    const contentY = ctl.contentYAt(tapY);
    ctl.animateTo(1, contentY, tapY, 320);
    runToEnd();
    expect(ctl.s).toBeCloseTo(1, 9);
    expect(viewport.scrollTop).toBeCloseTo(contentY - 320, 6);
  });
});

describe("跨档改了布局时换算焦点（二狗，57 号票：工具调用组对话层一行、缩小后逐次画）", () => {
  test("跨档那一帧：先用旧的内容坐标记下，换档后用换算后的坐标放焦点；set 返回换算后的，同一档里不换算", () => {
    const { ctl, viewport, root } = fakeDom();
    ctl.setContentHeight(5000, 0);
    const seen: Array<[number, string | undefined]> = [];
    ctl.onLevelLayout = (contentY) => {
      seen.push([contentY, root.dataset.level]);
      return () => contentY + 700;
    };
    const focalY = 300;
    expect(ctl.set(0.8, focalY, 1000)).toBe(1000);
    expect(seen).toEqual([]);
    // 0.8 → 0.6 跨到要点层：记下时还是对话层的布局（data-level 还是 0），放焦点用 1700
    expect(ctl.set(0.6, focalY, 1000)).toBe(1700);
    expect(seen).toEqual([[1000, "0"]]);
    expect(viewport.scrollTop).toBeCloseTo(1700 * 0.6 - focalY, 6);
    // 要点层里接着捏：不再换算
    expect(ctl.set(0.5, focalY, 1700)).toBe(1700);
    expect(seen).toHaveLength(1);
  });

  test("动画跨档：换算之后的帧接着用换算后的坐标，停稳时焦点落在换算后的那一点", () => {
    const { ctl, viewport } = fakeDom();
    ctl.setContentHeight(8000, 0);
    ctl.set(0.45, 0, 0);
    ctl.onLevelLayout = (contentY) => () => contentY - 400;
    viewport.scrollTop = 600;
    const tapY = 400;
    const contentY = ctl.contentYAt(tapY);
    ctl.animateTo(1, contentY, tapY, 320);
    runToEnd();
    expect(ctl.s).toBeCloseTo(1, 9);
    expect(viewport.scrollTop).toBeCloseTo(contentY - 400 - 320, 6);
  });
});

describe("写给 CSS 的变量", () => {
  test("比例、三层不透明度、这一档的预设比例、档位；内容按自身宽度回推居中", () => {
    const { ctl, vars, root, content } = fakeDom(400);
    expect(vars.get("--s")).toBe("1.0000");
    expect(vars.get("--o0")).toBe("1.000");
    expect(root.dataset.level).toBe("0");
    ctl.set(0.45, 0, 0);
    expect(vars.get("--o1")).toBe("1.000");
    expect(vars.get("--sl")).toBe("0.45");
    expect(vars.get("--colw")).toBe("400px");
    expect(root.dataset.level).toBe("1");
    expect(content.style.transform).toBe("translateX(110.00px) scale(0.4500)");
  });

  test("跨档时通知一次（同一档里来回不通知）", () => {
    const { ctl } = fakeDom();
    const levels: ZoomLevel[] = [];
    ctl.onLevelChange((l) => levels.push(l));
    for (const s of [0.9, 0.8, 0.6, 0.5, 0.4, 0.2, 0.18, 0.5, 1]) ctl.set(s, 0, 0);
    expect(levels).toEqual([1, 2, 1, 0]);
  });
});
