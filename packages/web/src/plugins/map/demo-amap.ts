// 假的高德（429）：演示页和页面测试里不连真的高德，拿自己写的瓦片地图（osm-engine.ts）扮高德 JS API 用到的那几样，
// 底图是编的占位图。只有地图页 import.meta.env.MODE === "demo" 的分支、测试引它（安装版的产物里没有）。
// 它收到的坐标是 amap-engine.ts 转过的 GCJ-02，原样当成画的位置（占位底图对不上任何真实的地方，偏几百米看不出来）。
import type { AmapLngLat, AmapLoader, AmapMap, AmapNamespace, AmapOverlay } from "./amap-engine.ts";
import { createOsmEngine } from "./osm-engine.ts";
import type { MapMark, MapScene } from "./scene.ts";

/** 每样东西收到的参数（加进地图时照它画） */
interface FakeOverlay extends AmapOverlay {
  readonly kind: "marker" | "polyline" | "circle";
  readonly options: Record<string, unknown>;
}

/** 一种假的地图上的东西：只记下参数 */
function overlay(kind: FakeOverlay["kind"]) {
  return class implements FakeOverlay {
    readonly kind = kind;
    readonly options: Record<string, unknown>;
    constructor(options: object) {
      this.options = options as Record<string, unknown>;
    }
  };
}

/** 假的高德命名空间：瓦片地址由外面给（演示页的占位图） */
export function fakeAmap(tileUrl: (z: number, x: number, y: number) => string): AmapNamespace {
  class FakeMap implements AmapMap {
    private readonly handlers: Array<() => void> = [];
    private readonly overlays = new Set<FakeOverlay>();
    private readonly engine;
    constructor(container: HTMLElement, options: Record<string, unknown>) {
      const [lon, lat] = options.center as [number, number];
      this.engine = createOsmEngine(container, {
        view: { lat, lon, zoom: options.zoom as number },
        tileUrl,
        maxTileZoom: 19,
        engineName: "amap-demo",
        onMoveEnd: () => {
          for (const h of this.handlers) h();
        },
        onMarkClick: (id) => {
          for (const o of this.overlays) if (o.kind === "marker" && (o.options.content as HTMLElement).dataset.id === id) (o.options.content as HTMLElement).click();
        },
      });
      this.engine.setDark(String(options.mapStyle).includes("dark"));
    }
    getCenter(): AmapLngLat {
      const v = this.engine.view();
      return { getLng: () => v.lon, getLat: () => v.lat };
    }
    getZoom() {
      return this.engine.view().zoom;
    }
    setZoomAndCenter(zoom: number, center: [number, number]) {
      this.engine.setView({ lat: center[1], lon: center[0], zoom });
      for (const h of this.handlers) h();
    }
    setZoom(zoom: number) {
      this.engine.setView({ ...this.engine.view(), zoom });
      for (const h of this.handlers) h();
    }
    setMapStyle(style: string) {
      this.engine.setDark(style.includes("dark"));
    }
    on(_event: "moveend" | "zoomend", handler: () => void) {
      this.handlers.push(handler);
    }
    add(list: AmapOverlay[]) {
      for (const o of list) this.overlays.add(o as FakeOverlay);
      this.redraw();
    }
    remove(list: AmapOverlay[]) {
      for (const o of list) this.overlays.delete(o as FakeOverlay);
      this.redraw();
    }
    destroy() {
      this.engine.destroy();
    }
    private redraw() {
      const scene: { marks: MapMark[]; lines: MapScene["lines"][number][]; circles: MapScene["circles"][number][] } = { marks: [], lines: [], circles: [] };
      for (const o of this.overlays) {
        if (o.kind === "marker") {
          const [lon, lat] = o.options.position as [number, number];
          const el = o.options.content as HTMLElement;
          scene.marks.push({ id: el.dataset.id ?? "", lat, lon, ...(el.textContent ? { label: el.textContent } : {}), kind: (el.dataset.kind as MapMark["kind"]) ?? "place" });
        } else if (o.kind === "polyline") {
          scene.lines.push({ id: `l${scene.lines.length}`, points: (o.options.path as [number, number][]).map(([lon, lat]) => ({ lat, lon })) });
        } else {
          const [lon, lat] = o.options.center as [number, number];
          // 精度圈（442）照它的种类画样式（高德的 extData 原样带着）
          const kind = (o.options.extData as { kind?: string } | undefined)?.kind === "accuracy" ? ("accuracy" as const) : undefined;
          scene.circles.push({ id: `c${scene.circles.length}`, lat, lon, radius: o.options.radius as number, ...(kind ? { kind } : {}) });
        }
      }
      this.engine.setScene(scene);
    }
  }
  return { Map: FakeMap, Marker: overlay("marker"), Polyline: overlay("polyline"), Circle: overlay("circle") } as unknown as AmapNamespace;
}

/** 演示页、测试用的加载办法：马上交回假的高德（不加载任何脚本） */
export function fakeAmapLoader(tileUrl: (z: number, x: number, y: number) => string): AmapLoader {
  const ns = fakeAmap(tileUrl);
  return () => Promise.resolve(ns);
}
