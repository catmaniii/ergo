// 地图页上盖在别家底图上面的自己那一层（453）：高德、谷歌只出底图（引擎不收足迹、点、线，也就不交给它们的接口），
// 引擎每动一下报一次此刻画着哪一片（MapSurfaceView：中心、级别、宽高、坐标），这一层照它在本机投影、画点、线、圈和点旁边的字。
// - 投影：Web 墨卡托、256 像素一张瓦片，级别可以带小数；那家是 gcj02 的大陆里的点和中心都先转 GCJ-02（和 446、451 一样），
//   横着取离中心最近的那一份；
// - 画法和 OpenStreetMap 那一种一样（点是按钮、线和圈是 SVG，map.css 的样子），报来一次就当场重摆（不再等下一帧：
//   原型量过，等一帧要慢一帧，当场摆和底图同一帧）；
// - 手势穿透：这一层整块 pointer-events: none，拖、捏、滚轮都落到底图上；只有点能点（出详情）。按住一个点拖时，
//   这一层把挪了多少转给底图（onPan），不卡住；拖过了就不算点了一下；
// - 还没报过视野（底图还在加载）时整层藏着；
// - 点旁边的字不互相盖住（451 补，label-place.ts）：每次摆完点排一次（只是拖时用上一次的，每帧最多排一次），挪开了的画引线。
import { type LatLon, wgsToGcj } from "../../state/index.ts";
import type { MapSurfaceView } from "./engine.ts";
import { createLabelPlacer, type PlacedMark } from "./label-place.ts";
import { fillMark, type MarkParts } from "./osm-engine.ts";
import type { MapScene } from "./scene.ts";
import { metersPerPixel, screenPoint } from "./tiles.ts";

const SVG_NS = "http://www.w3.org/2000/svg";
/** 手指、鼠标动了多少像素才算拖（不到算点） */
const DRAG_THRESHOLD = 4;

/** 一个点（WGS-84）在底图上的位置（CSS 像素，相对底图左上角） */
export function surfacePoint(p: LatLon, v: MapSurfaceView): { x: number; y: number } {
  const conv = (q: LatLon) => (v.datum === "gcj02" ? wgsToGcj(q) : q);
  return screenPoint(conv(p), { lat: v.lat, lon: v.lon }, v.zoom, v.width, v.height);
}

export interface MapOverlay {
  /** 画什么（整份换掉） */
  setScene(scene: MapScene): void;
  /** 底图此刻画着哪一片（报一次摆一次）；undefined 是还没有（藏起来） */
  setView(view: MapSurfaceView | undefined): void;
  destroy(): void;
}

export interface MapOverlayOptions {
  /** 点了一个点 */
  onMarkClick?(id: string): void;
  /** 按住一个点拖：这一下挪了多少像素（转给底图） */
  onPan?(dx: number, dy: number): void;
}

/** 在 container 里建这一层（container 和底图一样大、盖在它上面） */
export function createMapOverlay(container: HTMLElement, options: MapOverlayOptions = {}): MapOverlay {
  const doc = container.ownerDocument;
  const root = doc.createElement("div");
  root.className = "map-overlay map-page-overlay";
  root.hidden = true;
  const shapes = doc.createElementNS(SVG_NS, "svg");
  shapes.setAttribute("class", "map-shapes");
  const markPane = doc.createElement("div");
  markPane.className = "map-marks";
  root.append(shapes, markPane);
  container.append(root);
  // 引线那一层（在点下面）、排字
  const labels = createLabelPlacer(root);

  let scene: MapScene = { marks: [], lines: [], circles: [] };
  let view: MapSurfaceView | undefined;
  const markEls = new Map<string, HTMLButtonElement>();
  /** 每个点的针和字（排字用） */
  const markParts = new Map<string, MarkParts>();

  const placeShapes = (v: MapSurfaceView) => {
    shapes.setAttribute("width", String(v.width));
    shapes.setAttribute("height", String(v.height));
    shapes.setAttribute("viewBox", `0 0 ${v.width} ${v.height}`);
    const parts: Element[] = [];
    for (const c of scene.circles) {
      const p = surfacePoint(c, v);
      const el = doc.createElementNS(SVG_NS, "circle");
      el.setAttribute("class", c.kind ? `map-circle map-circle-${c.kind}` : "map-circle");
      el.setAttribute("cx", p.x.toFixed(1));
      el.setAttribute("cy", p.y.toFixed(1));
      el.setAttribute("r", (c.radius / metersPerPixel(c.lat, v.zoom)).toFixed(1));
      el.setAttribute("data-id", c.id);
      parts.push(el);
    }
    for (const line of scene.lines) {
      if (line.points.length < 2) continue;
      const el = doc.createElementNS(SVG_NS, "polyline");
      el.setAttribute("class", `map-line${line.kind ? ` map-line-${line.kind}` : ""}`);
      el.setAttribute("points", line.points.map((pt) => surfacePoint(pt, v)).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" "));
      el.setAttribute("data-id", line.id);
      parts.push(el);
    }
    shapes.replaceChildren(...parts);
  };

  const placeMarks = (v: MapSurfaceView) => {
    const placed: PlacedMark[] = [];
    for (const m of scene.marks) {
      const el = markEls.get(m.id);
      if (!el) continue;
      const p = surfacePoint(m, v);
      el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
      el.hidden = p.x < -200 || p.y < -200 || p.x > v.width + 200 || p.y > v.height + 200;
      const parts = markParts.get(m.id);
      // 不取整：只是拖时彼此的相对位置一点不变（排字用上一次的），各自取整会差一像素、每帧都重排
      placed.push({ id: m.id, kind: m.kind ?? "place", el, pin: parts?.pin, label: parts?.label, x: p.x, y: p.y });
    }
    labels.update(placed, { left: 0, top: 0, right: v.width, bottom: v.height });
  };

  const render = () => {
    root.hidden = view === undefined;
    if (view === undefined) return;
    placeShapes(view);
    placeMarks(view);
  };

  /** 一个点：按钮（能点）；按住拖时转给底图 */
  const makeMark = (id: string): HTMLButtonElement => {
    const el = doc.createElement("button");
    el.type = "button";
    el.className = "map-mark";
    el.dataset.id = id;
    let down: { x: number; y: number; id: number } | undefined;
    let dragged = false;
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      down = { x: e.clientX, y: e.clientY, id: e.pointerId };
      dragged = false;
    });
    el.addEventListener("pointermove", (e) => {
      if (!down || e.pointerId !== down.id) return;
      const dx = e.clientX - down.x;
      const dy = e.clientY - down.y;
      if (!dragged && Math.hypot(dx, dy) <= DRAG_THRESHOLD) return;
      if (!dragged) {
        dragged = true;
        if (!el.hasPointerCapture(e.pointerId)) el.setPointerCapture(e.pointerId);
      }
      options.onPan?.(dx, dy);
      down = { ...down, x: e.clientX, y: e.clientY };
    });
    const up = (e: PointerEvent) => {
      if (down && e.pointerId === down.id && el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      down = undefined;
    };
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("click", (e) => {
      if (dragged) {
        dragged = false;
        e.preventDefault();
        return;
      }
      options.onMarkClick?.(id);
    });
    return el;
  };

  return {
    setScene(next) {
      scene = next;
      const ids = new Set(next.marks.map((m) => m.id));
      for (const [id, el] of markEls) {
        if (!ids.has(id)) {
          el.remove();
          markEls.delete(id);
          markParts.delete(id);
        }
      }
      for (const m of next.marks) {
        let el = markEls.get(m.id);
        if (!el) {
          el = makeMark(m.id);
          markEls.set(m.id, el);
        }
        el.dataset.kind = m.kind ?? "place";
        markParts.set(m.id, fillMark(el, m.label));
      }
      // 照给的先后叠（后画的在上面；"我现在的位置"放最后）
      markPane.replaceChildren(...next.marks.toSorted((a, b) => Number(a.kind === "me") - Number(b.kind === "me")).map((m) => markEls.get(m.id)!));
      render();
    },
    setView(next) {
      view = next;
      render();
    },
    destroy() {
      labels.destroy();
      root.remove();
      markEls.clear();
      markParts.clear();
    },
  };
}
