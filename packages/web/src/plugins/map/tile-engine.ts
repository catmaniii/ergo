// 自己写的瓦片地图（429，不加依赖）：地图插件自己画的那种底图——瓦片底图（455 起谁家的瓦片由登记的插件给：OpenStreetMap 插件给
// 经守护进程 /tiles/osm 转发的瓦片），聊天卡片的缩略图也是它；演示页的假高德也借它扮（经插槽的 kit.tileEngine）。
// 只做看地图要的那几样：
// - 拖动平移（一个手指、鼠标），双指捏合缩放、滚轮缩放（以手指、鼠标所在的点为中心），双击放大一级；
// - 瓦片按需取：只取这一屏看得见的（不预取），换级别时上一级的瓦片先垫着，新的都到了再拿掉；
// - 地图上的点（按钮，能点）、线和圈（SVG），坐标 WGS-84；点旁边的字不互相盖住（451 补，label-place.ts：每帧最多排一次）；
// - 深色：瓦片那一层加 CSS 滤镜（styles/map.css 的 .map-tiles），点、线、圈不受影响；
// - 署名角标由地图页画（MapView.tsx），这里不管。
// 瓦片的地址由外面给（tileUrl）：登记瓦片底图的插件给的（真的页面是守护进程的 /tiles/<编号>/<z>/<x>/<y>，演示页是编的占位图）。
import type { SceneEngine, TileEngineOptions } from "./engine.ts";
import { createLabelPlacer, type LabelPlacer, type PlacedMark } from "./label-place.ts";
import { clampZoom, EMPTY_SCENE, type MapScene, type MapView } from "./scene.ts";
import { metersPerPixel, pointAt, pointOnScreen, screenPoint, TILE_SIZE, tilesFor, worldPoint } from "./tiles.ts";


const SVG_NS = "http://www.w3.org/2000/svg";
/** 手指、鼠标动了多少像素才算拖（不到算点） */
const DRAG_THRESHOLD = 4;
/** 滚轮停下多久算缩放完 */
const WHEEL_SETTLE_MS = 250;

export function createTileEngine(host: HTMLElement, options: TileEngineOptions): SceneEngine {
  const doc = host.ownerDocument;
  const root = doc.createElement("div");
  root.className = "map-tiled";
  root.dataset.engine = options.engineName ?? "tiles";
  const tilePane = doc.createElement("div");
  tilePane.className = "map-tiles";
  const shapes = doc.createElementNS(SVG_NS, "svg");
  shapes.setAttribute("class", "map-shapes");
  const markPane = doc.createElement("div");
  markPane.className = "map-marks";
  root.append(tilePane, shapes, markPane);
  host.append(root);
  // 引线那一层（在点下面）、排字
  const labels: LabelPlacer | undefined = options.labelLayout === false ? undefined : createLabelPlacer(root);

  let center = { lat: options.view.lat, lon: options.view.lon };
  let zoom = clampZoom(options.view.zoom);
  let scene: MapScene = EMPTY_SCENE;
  let frame = 0;
  let destroyed = false;
  /** 摆着的瓦片：键是 z/x/y（x 没取模） */
  const tiles = new Map<string, { img: HTMLImageElement; z: number; x: number; y: number; loaded: boolean }>();
  const markEls = new Map<string, HTMLButtonElement>();
  /** 每个点的针和字（排字用） */
  const markParts = new Map<string, MarkParts>();

  const size = () => ({ w: root.clientWidth || host.clientWidth || 1, h: root.clientHeight || host.clientHeight || 1 });

  const placeTiles = (w: number, h: number) => {
    const { z, tiles: wanted } = tilesFor(center, zoom, w, h, options.maxTileZoom);
    const keep = new Set<string>();
    for (const t of wanted) {
      keep.add(t.key);
      if (tiles.has(t.key)) continue;
      const img = doc.createElement("img");
      img.alt = "";
      img.draggable = false;
      img.decoding = "async";
      const entry = { img, z: t.z, x: t.x, y: t.y, loaded: false };
      img.addEventListener("load", () => {
        entry.loaded = true;
        schedule();
      });
      img.addEventListener("error", () => {
        entry.loaded = true;
        img.classList.add("broken");
        schedule();
      });
      img.src = options.tileUrl(t.z, t.wrappedX, t.y);
      // 哪一张（z/x/y，x 没取模）：页面测试照它算底图此刻把一个点画在哪（458）
      img.dataset.tile = t.key;
      tiles.set(t.key, entry);
      tilePane.append(img);
    }
    // 这一级的都到了：别的级别的拿掉；没到之前垫着（只留相差一级的，再远的直接拿掉）
    const ready = wanted.every((t) => tiles.get(t.key)?.loaded);
    for (const [key, entry] of tiles) {
      if (keep.has(key)) continue;
      if (entry.z === z || ready || Math.abs(entry.z - z) > 1) {
        entry.img.remove();
        tiles.delete(key);
      }
    }
    // 摆位置：每张按它自己的级别算（垫着的上一级也对得上）
    for (const entry of tiles.values()) {
      const scale = 2 ** (zoom - entry.z);
      const c = worldPoint(center, entry.z);
      const left = w / 2 + (entry.x * TILE_SIZE - c.x) * scale;
      const top = h / 2 + (entry.y * TILE_SIZE - c.y) * scale;
      const l = Math.round(left);
      const tp = Math.round(top);
      const s = entry.img.style;
      s.left = `${l}px`;
      s.top = `${tp}px`;
      s.width = `${Math.round(left + TILE_SIZE * scale) - l}px`;
      s.height = `${Math.round(top + TILE_SIZE * scale) - tp}px`;
      s.zIndex = entry.z === z ? "2" : "1";
    }
  };

  const placeShapes = (w: number, h: number) => {
    shapes.setAttribute("width", String(w));
    shapes.setAttribute("height", String(h));
    shapes.setAttribute("viewBox", `0 0 ${w} ${h}`);
    const parts: Element[] = [];
    for (const c of scene.circles) {
      const p = screenPoint(c, center, zoom, w, h);
      const el = doc.createElementNS(SVG_NS, "circle");
      el.setAttribute("class", c.kind ? `map-circle map-circle-${c.kind}` : "map-circle");
      el.setAttribute("cx", p.x.toFixed(1));
      el.setAttribute("cy", p.y.toFixed(1));
      el.setAttribute("r", (c.radius / metersPerPixel(c.lat, zoom)).toFixed(1));
      el.setAttribute("data-id", c.id);
      parts.push(el);
    }
    for (const line of scene.lines) {
      if (line.points.length < 2) continue;
      const el = doc.createElementNS(SVG_NS, "polyline");
      el.setAttribute("class", `map-line${line.kind ? ` map-line-${line.kind}` : ""}`);
      el.setAttribute("points", line.points.map((pt) => screenPoint(pt, center, zoom, w, h)).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" "));
      el.setAttribute("data-id", line.id);
      parts.push(el);
    }
    shapes.replaceChildren(...parts);
  };

  const placeMarks = (w: number, h: number) => {
    const placed: PlacedMark[] = [];
    for (const m of scene.marks) {
      const el = markEls.get(m.id);
      if (!el) continue;
      const p = screenPoint(m, center, zoom, w, h);
      el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
      el.hidden = p.x < -200 || p.y < -200 || p.x > w + 200 || p.y > h + 200;
      const parts = markParts.get(m.id);
      // 不取整：只是拖时彼此的相对位置一点不变（排字用上一次的），各自取整会差一像素、每帧都重排
      placed.push({ id: m.id, kind: m.kind ?? "place", el, pin: parts?.pin, label: parts?.label, x: p.x, y: p.y });
    }
    labels?.update(placed, { left: 0, top: 0, right: w, bottom: h });
  };

  const render = () => {
    frame = 0;
    if (destroyed) return;
    const { w, h } = size();
    placeTiles(w, h);
    placeShapes(w, h);
    placeMarks(w, h);
  };
  function schedule() {
    if (frame === 0 && !destroyed) frame = (doc.defaultView ?? globalThis).requestAnimationFrame(render);
  }

  const view = (): MapView => ({ lat: center.lat, lon: center.lon, zoom });
  const moved = () => options.onMoveEnd(view());

  /** 换级别，屏幕上 (x, y) 那一点不动 */
  const zoomAround = (next: number, x: number, y: number) => {
    const { w, h } = size();
    const anchor = pointOnScreen(x, y, center, zoom, w, h);
    zoom = clampZoom(next);
    const a = worldPoint(anchor, zoom);
    center = pointAt(a.x - (x - w / 2), a.y - (y - h / 2), zoom);
    schedule();
  };

  const panBy = (dx: number, dy: number) => {
    const { w, h } = size();
    center = pointOnScreen(w / 2 - dx, h / 2 - dy, center, zoom, w, h);
    schedule();
  };

  // ---- 手指、鼠标 ----
  const pointers = new Map<number, { x: number; y: number }>();
  let gesture: { dist: number; zoom: number; mid: { x: number; y: number } } | undefined;
  let travelled = 0;
  let suppressClick = false;
  const local = (e: PointerEvent | WheelEvent | MouseEvent) => {
    const r = root.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const twoFinger = () => {
    const [a, b] = [...pointers.values()];
    return { dist: Math.hypot(a!.x - b!.x, a!.y - b!.y), mid: { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 } };
  };
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    pointers.set(e.pointerId, local(e));
    travelled = 0;
    if (pointers.size === 2) {
      const g = twoFinger();
      gesture = { dist: g.dist, zoom, mid: g.mid };
    }
  };
  const onMove = (e: PointerEvent) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const now = local(e);
    if (pointers.size === 1) {
      travelled += Math.hypot(now.x - prev.x, now.y - prev.y);
      if (travelled > DRAG_THRESHOLD) {
        // 真的在拖了才抓住指针（一开始就抓，点在地图上的点就收不到 click）
        if (!root.hasPointerCapture(e.pointerId)) root.setPointerCapture(e.pointerId);
        root.classList.add("dragging");
        panBy(now.x - prev.x, now.y - prev.y);
      }
      pointers.set(e.pointerId, now);
      return;
    }
    pointers.set(e.pointerId, now);
    if (pointers.size === 2 && gesture) {
      travelled = DRAG_THRESHOLD + 1;
      const g = twoFinger();
      panBy(g.mid.x - gesture.mid.x, g.mid.y - gesture.mid.y);
      gesture.mid = g.mid;
      if (gesture.dist > 0) zoomAround(gesture.zoom + Math.log2(g.dist / gesture.dist), g.mid.x, g.mid.y);
    }
  };
  const onUp = (e: PointerEvent) => {
    if (!pointers.delete(e.pointerId)) return;
    if (root.hasPointerCapture(e.pointerId)) root.releasePointerCapture(e.pointerId);
    if (pointers.size < 2) gesture = undefined;
    if (pointers.size === 0) {
      root.classList.remove("dragging");
      if (travelled > DRAG_THRESHOLD) {
        suppressClick = true;
        moved();
      }
    }
  };
  const onClickCapture = (e: MouseEvent) => {
    if (!suppressClick) return;
    suppressClick = false;
    e.stopPropagation();
    e.preventDefault();
  };
  let wheelTimer: ReturnType<typeof setTimeout> | undefined;
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const step = e.deltaMode === 1 ? e.deltaY * 0.05 : e.deltaY / 300;
    const p = local(e);
    zoomAround(zoom - Math.max(-1, Math.min(1, step)), p.x, p.y);
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(moved, WHEEL_SETTLE_MS);
  };
  const onDblClick = (e: MouseEvent) => {
    if ((e.target as Element | null)?.closest?.(".map-mark")) return;
    const p = local(e);
    zoomAround(Math.round(zoom) + 1, p.x, p.y);
    moved();
  };
  root.addEventListener("pointerdown", onDown);
  root.addEventListener("pointermove", onMove);
  root.addEventListener("pointerup", onUp);
  root.addEventListener("pointercancel", onUp);
  root.addEventListener("click", onClickCapture, true);
  root.addEventListener("wheel", onWheel, { passive: false });
  root.addEventListener("dblclick", onDblClick);
  const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => schedule());
  resize?.observe(root);

  schedule();

  return {
    kind: options.engineName ?? "tiles",
    view,
    setView(v) {
      center = { lat: v.lat, lon: v.lon };
      zoom = clampZoom(v.zoom);
      schedule();
      // 和拖完一样报一声（底图按新的地方再挑）；不在调用的那一刻报，免得调用方正在渲染
      queueMicrotask(() => {
        if (!destroyed) moved();
      });
    },
    zoomBy(delta) {
      const { w, h } = size();
      zoomAround(Math.round(zoom) + delta, w / 2, h / 2);
      moved();
    },
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
          el = doc.createElement("button");
          el.type = "button";
          el.className = "map-mark";
          el.dataset.id = m.id;
          el.addEventListener("click", () => options.onMarkClick?.(m.id));
          markEls.set(m.id, el);
          markPane.append(el);
        }
        el.dataset.kind = m.kind ?? "place";
        markParts.set(m.id, fillMark(el, m.label));
      }
      schedule();
    },
    setDark(dark) {
      root.classList.toggle("dark", dark);
    },
    destroy() {
      destroyed = true;
      if (frame !== 0) (doc.defaultView ?? globalThis).cancelAnimationFrame(frame);
      clearTimeout(wheelTimer);
      resize?.disconnect();
      labels?.destroy();
      root.remove();
      tiles.clear();
      markEls.clear();
      markParts.clear();
    },
  };
}

/** 一个点里的针和字（排字时要量它们） */
export interface MarkParts {
  readonly pin: HTMLElement;
  readonly label: HTMLElement | undefined;
}

/** 一个点的样子：一枚定位针，旁边写字（OpenStreetMap 和盖在高德、谷歌上面的那一层共用）；交回针和字 */
export function fillMark(el: HTMLElement, label: string | undefined): MarkParts {
  const doc = el.ownerDocument;
  const pin = doc.createElement("span");
  pin.className = "map-pin";
  pin.setAttribute("aria-hidden", "true");
  el.replaceChildren(pin);
  if (label) {
    const text = doc.createElement("span");
    text.className = "map-mark-label";
    text.textContent = label;
    el.append(text);
    el.setAttribute("aria-label", label);
    return { pin, label: text };
  }
  el.removeAttribute("aria-label");
  return { pin, label: undefined };
}
