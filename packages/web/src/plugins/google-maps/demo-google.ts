// 假的谷歌（446）：演示页和页面测试里不连真的谷歌，扮 Maps JavaScript API 用到的那几样（google-engine.ts 的 GoogleMapsLibrary）。
// 自己画一张瓦片地图（Web 墨卡托，瓦片是外面给的编的占位图）：能拖、能缩放、能跳；线和圈画在一层 SVG 里；
// OverlayView 照真的那样给 overlayMouseTarget 层和投影（经纬度 → 这一层里的像素），点由谷歌那一种引擎自己摆。
// 它收到的坐标是 google-engine.ts 转过的（大陆里 GCJ-02），原样当成画的位置（占位底图对不上任何真实的地方）。
// 只有 basemap.ts 里 import.meta.env.MODE === "demo" 的分支、测试引它（安装版的产物里没有）。
import type { GoogleLatLngLiteral, GoogleListener, GoogleMap, GoogleMapsLibrary, GoogleOverlayView, GoogleProjection, GoogleShape } from "./google-engine.ts";

const TILE = 256;
const SVG_NS = "http://www.w3.org/2000/svg";
const MAX_LAT = 85.05112878;

/** 经纬度 → 这一级的世界像素 */
function world(p: GoogleLatLngLiteral, zoom: number): { x: number; y: number } {
  const scale = TILE * 2 ** zoom;
  const lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, p.lat));
  const s = Math.sin((lat * Math.PI) / 180);
  return { x: ((p.lng + 180) / 360) * scale, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale };
}

/** 这一级的世界像素 → 经纬度 */
function unworld(x: number, y: number, zoom: number): GoogleLatLngLiteral {
  const scale = TILE * 2 ** zoom;
  const lng = (x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  return { lat: (180 / Math.PI) * Math.atan(Math.sinh(n)), lng };
}

interface FakeShape extends GoogleShape {
  readonly kind: "line" | "circle";
  readonly options: Record<string, unknown>;
}

/** 假的谷歌：瓦片地址由外面给（演示页的占位图） */
export function fakeGoogleMaps(tileUrl: (z: number, x: number, y: number) => string): GoogleMapsLibrary {
  class FakeMap implements GoogleMap {
    private center: GoogleLatLngLiteral;
    private zoom: number;
    private readonly listeners = new Set<() => void>();
    readonly shapes = new Set<FakeShape>();
    readonly overlays = new Set<FakeOverlayView>();
    private readonly container: HTMLElement;
    private readonly tiles: HTMLElement;
    private readonly svg: SVGSVGElement;
    readonly pane: HTMLElement;
    private settle: ReturnType<typeof setTimeout> | undefined;
    constructor(container: HTMLElement, options: Record<string, unknown>) {
      this.container = container;
      this.center = options.center as GoogleLatLngLiteral;
      this.zoom = options.zoom as number;
      const doc = container.ownerDocument;
      container.classList.add("map-google-demo");
      if (options.colorScheme === "DARK") container.classList.add("dark");
      this.tiles = doc.createElement("div");
      this.tiles.className = "map-google-demo-tiles";
      this.svg = doc.createElementNS(SVG_NS, "svg");
      this.svg.setAttribute("class", "map-google-demo-shapes");
      this.pane = doc.createElement("div");
      this.pane.className = "map-google-demo-pane";
      // 谷歌的标志和版权行（演示页是编的：写明"演示"）
      const logo = doc.createElement("div");
      logo.className = "map-google-demo-logo";
      logo.textContent = "Google";
      container.append(this.tiles, this.svg, this.pane, logo);
      this.drag();
      this.render();
      this.idleSoon();
    }
    getCenter() {
      const c = this.center;
      return { lat: () => c.lat, lng: () => c.lng };
    }
    getZoom() {
      return this.zoom;
    }
    setCenter(center: GoogleLatLngLiteral) {
      this.center = center;
      this.render();
      this.idleSoon();
    }
    setZoom(zoom: number) {
      this.zoom = Math.max(3, Math.min(20, zoom));
      this.render();
      this.idleSoon();
    }
    addListener(_event: "idle", handler: () => void): GoogleListener {
      this.listeners.add(handler);
      return { remove: () => this.listeners.delete(handler) };
    }
    /** 这一层里的像素（中心在容器正中） */
    pixel(p: GoogleLatLngLiteral): { x: number; y: number } {
      const w = this.container.clientWidth;
      const h = this.container.clientHeight;
      const z = Math.round(this.zoom);
      const c = world(this.center, z);
      const q = world(p, z);
      return { x: q.x - c.x + w / 2, y: q.y - c.y + h / 2 };
    }
    /** 停下来了：叫 idle（真的谷歌拖完、缩放完也是这样） */
    private idleSoon() {
      clearTimeout(this.settle);
      this.settle = setTimeout(() => {
        for (const fn of this.listeners) fn();
      }, 60);
    }
    /** 拖：按下、移动、松开 */
    private drag() {
      let start: { x: number; y: number; center: { x: number; y: number } } | undefined;
      this.container.addEventListener("pointerdown", (e) => {
        if ((e.target as Element | null)?.closest?.(".map-mark")) return;
        start = { x: e.clientX, y: e.clientY, center: world(this.center, Math.round(this.zoom)) };
        this.container.setPointerCapture?.(e.pointerId);
      });
      this.container.addEventListener("pointermove", (e) => {
        if (!start) return;
        const z = Math.round(this.zoom);
        this.center = unworld(start.center.x - (e.clientX - start.x), start.center.y - (e.clientY - start.y), z);
        this.render();
      });
      const end = () => {
        if (!start) return;
        start = undefined;
        this.idleSoon();
      };
      this.container.addEventListener("pointerup", end);
      this.container.addEventListener("pointercancel", end);
    }
    /** 画瓦片、线和圈，叫覆盖层重摆 */
    render() {
      const doc = this.container.ownerDocument;
      const w = this.container.clientWidth;
      const h = this.container.clientHeight;
      const z = Math.round(this.zoom);
      const c = world(this.center, z);
      const span = 2 ** z;
      const imgs: HTMLImageElement[] = [];
      for (let tx = Math.floor((c.x - w / 2) / TILE); tx <= Math.floor((c.x + w / 2) / TILE); tx++) {
        for (let ty = Math.max(0, Math.floor((c.y - h / 2) / TILE)); ty <= Math.min(span - 1, Math.floor((c.y + h / 2) / TILE)); ty++) {
          const img = doc.createElement("img");
          img.alt = "";
          img.src = tileUrl(z, ((tx % span) + span) % span, ty);
          img.style.transform = `translate(${Math.round(tx * TILE - c.x + w / 2)}px, ${Math.round(ty * TILE - c.y + h / 2)}px)`;
          imgs.push(img);
        }
      }
      this.tiles.replaceChildren(...imgs);
      const parts: SVGElement[] = [];
      for (const s of this.shapes) {
        if (s.kind === "line") {
          const el = doc.createElementNS(SVG_NS, "polyline");
          el.setAttribute("class", "map-google-demo-line");
          el.setAttribute("stroke", String(s.options.strokeColor));
          el.setAttribute("stroke-width", String(s.options.strokeWeight));
          el.setAttribute("points", (s.options.path as GoogleLatLngLiteral[]).map((p) => this.pixel(p)).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" "));
          parts.push(el);
        } else {
          const center = this.pixel(s.options.center as GoogleLatLngLiteral);
          const metersPerPixel = (156543.03392 * Math.cos(((s.options.center as GoogleLatLngLiteral).lat * Math.PI) / 180)) / 2 ** z;
          const el = doc.createElementNS(SVG_NS, "circle");
          el.setAttribute("class", "map-google-demo-circle");
          el.setAttribute("cx", center.x.toFixed(1));
          el.setAttribute("cy", center.y.toFixed(1));
          el.setAttribute("r", ((s.options.radius as number) / metersPerPixel).toFixed(1));
          el.setAttribute("fill", String(s.options.fillColor));
          el.setAttribute("fill-opacity", String(s.options.fillOpacity));
          el.setAttribute("stroke", String(s.options.strokeColor));
          parts.push(el);
        }
      }
      this.svg.replaceChildren(...parts);
      for (const o of this.overlays) o.draw?.();
    }
  }

  /** 假的线、圈：记下参数，放上地图时重画 */
  const shape = (kind: FakeShape["kind"]) =>
    class implements FakeShape {
      readonly kind = kind;
      readonly options: Record<string, unknown>;
      private map: FakeMap | null = null;
      constructor(options: object) {
        this.options = options as Record<string, unknown>;
        const map = this.options.map as FakeMap | undefined;
        if (map) this.setMap(map);
      }
      setMap(map: GoogleMap | null) {
        this.map?.shapes.delete(this);
        this.map?.render();
        this.map = map as FakeMap | null;
        this.map?.shapes.add(this);
        this.map?.render();
      }
    };

  /** 假的 OverlayView：子类写 onAdd、draw、onRemove，照真的那样给层和投影 */
  class FakeOverlayView implements GoogleOverlayView {
    private map: FakeMap | null = null;
    onAdd?(): void;
    draw?(): void;
    onRemove?(): void;
    setMap(map: GoogleMap | null) {
      if (this.map) {
        this.map.overlays.delete(this);
        this.onRemove?.();
      }
      this.map = map as FakeMap | null;
      if (this.map) {
        this.map.overlays.add(this);
        this.onAdd?.();
        this.draw?.();
      }
    }
    getPanes() {
      return this.map ? { overlayMouseTarget: this.map.pane } : null;
    }
    getProjection(): GoogleProjection | null {
      const map = this.map;
      return map ? { fromLatLngToDivPixel: (p) => map.pixel(p) } : null;
    }
  }

  return { Map: FakeMap, Polyline: shape("line"), Circle: shape("circle"), OverlayView: FakeOverlayView } as unknown as GoogleMapsLibrary;
}
