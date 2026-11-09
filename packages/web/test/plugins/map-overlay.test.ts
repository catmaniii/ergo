// 地图页盖在高德、谷歌上面的自己那一层（453，plugins/map/overlay.ts）：Node 里能测的那部分（一个最小的假 DOM）——
// - 还没报过视野时整层藏着；报来一次就当场把点、线、圈摆到投影出来的位置（gcj02 的那一家大陆里先转）；
// - 点能点（出详情）；按住点拖：挪了多少转给底图（onPan），拖过了就不算点；这一层自己不接别的手势（样式里整层 pointer-events: none）；
// - 换一份画的：没了的点拿掉，"我现在的位置"叠在最上面。
import { describe, expect, test } from "vitest";
import { createMapOverlay, surfacePoint } from "../../src/plugins/map/overlay.ts";
import type { MapSurfaceView } from "../../src/plugins/map/engine.ts";
import { wgsToGcj } from "../../src/state/index.ts";

interface El {
  tag: string;
  className: string;
  hidden: boolean;
  dataset: Record<string, string>;
  style: Record<string, string>;
  attrs: Record<string, string>;
  children: El[];
  listeners: Record<string, Array<(e: unknown) => void>>;
  captured: Set<number>;
  type?: string;
  textContent?: string;
  ownerDocument: unknown;
}

function element(tag: string): El {
  const el = {
    tag,
    className: "",
    hidden: false,
    dataset: {},
    style: {},
    attrs: {},
    children: [] as El[],
    listeners: {} as Record<string, Array<(e: unknown) => void>>,
    captured: new Set<number>(),
    ownerDocument: doc,
    append(...kids: El[]) {
      el.children.push(...kids);
    },
    replaceChildren(...kids: El[]) {
      el.children = kids;
    },
    remove() {},
    setAttribute(name: string, value: string) {
      (el.attrs as Record<string, string>)[name] = value;
    },
    removeAttribute(name: string) {
      delete (el.attrs as Record<string, string>)[name];
    },
    addEventListener(type: string, fn: (e: unknown) => void) {
      (el.listeners[type] ??= []).push(fn);
    },
    hasPointerCapture: (id: number) => el.captured.has(id),
    setPointerCapture: (id: number) => el.captured.add(id),
    releasePointerCapture: (id: number) => el.captured.delete(id),
  };
  return el as unknown as El;
}
const doc = { createElement: element, createElementNS: (_ns: string, tag: string) => element(tag) };
const fire = (el: El, type: string, e: Record<string, unknown> = {}) => {
  let prevented = false;
  for (const fn of el.listeners[type] ?? []) fn({ button: 0, pointerType: "touch", pointerId: 1, preventDefault: () => (prevented = true), ...e });
  return prevented;
};

const HANGZHOU = { lat: 30.2741, lon: 120.1551 };
const gcj = wgsToGcj(HANGZHOU);
const VIEW: MapSurfaceView = { lat: gcj.lat, lon: gcj.lon, zoom: 15, width: 390, height: 700, datum: "gcj02" };

function setup() {
  const container = element("div");
  const clicks: string[] = [];
  const pans: Array<[number, number]> = [];
  const overlay = createMapOverlay(container as unknown as HTMLElement, { onMarkClick: (id) => clicks.push(id), onPan: (dx, dy) => pans.push([dx, dy]) });
  const root = container.children[0]!;
  const [svg, marks] = root.children as [El, El];
  return { overlay, root, svg, marks, clicks, pans };
}

describe("地图页自己那一层", () => {
  test("还没报过视野：整层藏着；报来一次就当场摆好（点在投影出来的位置、线照画）", () => {
    const { overlay, root, svg, marks } = setup();
    expect(root.className).toBe("map-overlay map-page-overlay");
    overlay.setScene({ marks: [{ id: "home", ...HANGZHOU, label: "家", kind: "stay" }], lines: [{ id: "t", points: [HANGZHOU, { lat: 30.28, lon: 120.16 }], kind: "track" }], circles: [] });
    expect(root.hidden).toBe(true);
    overlay.setView(VIEW);
    expect(root.hidden).toBe(false);
    // 高德报的中心就是这一处（GCJ-02）：点在正中
    expect(marks.children[0]!.style.transform).toBe("translate(195px, 350px)");
    const line = svg.children[0]!;
    expect(line.attrs.class).toBe("map-line map-line-track");
    const second = surfacePoint({ lat: 30.28, lon: 120.16 }, VIEW);
    expect(line.attrs.points).toBe(`195.0,350.0 ${second.x.toFixed(1)},${second.y.toFixed(1)}`);
    // 往右拖了一屏宽的底图报来新的中心：点跟着挪
    overlay.setView({ ...VIEW, lon: VIEW.lon + (390 / (256 * 2 ** 15)) * 360 });
    expect(marks.children[0]!.style.transform).toBe("translate(-195px, 350px)");
    overlay.setView(undefined);
    expect(root.hidden).toBe(true);
  });

  test("点一下：出详情；按住拖：挪了多少转给底图，松手后那一下不算点", () => {
    const { overlay, marks, clicks, pans } = setup();
    overlay.setScene({ marks: [{ id: "home", ...HANGZHOU, kind: "stay" }], lines: [], circles: [] });
    overlay.setView(VIEW);
    const pin = marks.children[0]!;
    fire(pin, "pointerdown", { clientX: 100, clientY: 100 });
    fire(pin, "pointerup", { clientX: 100, clientY: 100 });
    fire(pin, "click");
    expect(clicks).toEqual(["home"]);
    // 动了不到 4 像素：还算点
    fire(pin, "pointerdown", { clientX: 100, clientY: 100 });
    fire(pin, "pointermove", { clientX: 102, clientY: 101 });
    expect(pans).toEqual([]);
    // 拖起来：每一下的差转给底图
    fire(pin, "pointermove", { clientX: 120, clientY: 110 });
    fire(pin, "pointermove", { clientX: 130, clientY: 100 });
    expect(pans).toEqual([
      [20, 10],
      [10, -10],
    ]);
    expect(pin.captured.has(1)).toBe(true);
    fire(pin, "pointerup", { clientX: 130, clientY: 100 });
    expect(pin.captured.has(1)).toBe(false);
    expect(fire(pin, "click")).toBe(true);
    expect(clicks).toEqual(["home"]);
  });

  test("换一份画的：没了的点拿掉；\"我现在的位置\"叠在最上面", () => {
    const { overlay, marks } = setup();
    overlay.setScene({ marks: [{ id: "me", ...HANGZHOU, kind: "me" }, { id: "a", ...HANGZHOU }, { id: "b", ...HANGZHOU }], lines: [], circles: [] });
    expect(marks.children.map((c) => c.dataset.id)).toEqual(["a", "b", "me"]);
    overlay.setScene({ marks: [{ id: "b", ...HANGZHOU }], lines: [], circles: [] });
    expect(marks.children.map((c) => c.dataset.id)).toEqual(["b"]);
  });
});
