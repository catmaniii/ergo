// 假的高德（429）：演示页和页面测试里不连真的高德，拿自己写的瓦片地图（osm-engine.ts）扮高德 JS API 用到的那几样，
// 底图是编的占位图。只有地图页 import.meta.env.MODE === "demo" 的分支、测试引它（安装版的产物里没有）。
// 它收到的坐标是 amap-engine.ts 转过的 GCJ-02，原样当成画的位置（占位底图对不上任何真实的地方，偏几百米看不出来）。
// 453 起高德只出底图：假的这一份也只有 Map（没有 Marker、Polyline、Circle——引擎一个覆盖物都不该建）；
// 拖、缩放时 getCenter、getZoom 跟着变（引擎每一帧读它报给上面那一层），停下来叫 moveend 这几个事件。
import type { AmapEvent, AmapLngLat, AmapLoader, AmapMap, AmapNamespace } from "./amap-engine.ts";
import { createOsmEngine } from "./osm-engine.ts";

/** 假的高德命名空间：瓦片地址由外面给（演示页的占位图） */
export function fakeAmap(tileUrl: (z: number, x: number, y: number) => string): AmapNamespace {
  class FakeMap implements AmapMap {
    private readonly handlers = new Map<AmapEvent, Array<() => void>>();
    private readonly engine;
    constructor(container: HTMLElement, options: Record<string, unknown>) {
      const [lon, lat] = options.center as [number, number];
      this.engine = createOsmEngine(container, {
        view: { lat, lon, zoom: options.zoom as number },
        tileUrl,
        maxTileZoom: 19,
        engineName: "amap-demo",
        onMoveEnd: () => this.emit("moveend"),
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
      this.emit("mapmove");
    }
    setZoom(zoom: number) {
      this.engine.setView({ ...this.engine.view(), zoom });
      this.emit("zoomchange");
    }
    setCenter(center: [number, number]) {
      this.engine.setView({ ...this.engine.view(), lat: center[1], lon: center[0] });
      this.emit("mapmove");
    }
    setMapStyle(style: string) {
      this.engine.setDark(style.includes("dark"));
    }
    on(event: AmapEvent, handler: () => void) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    }
    destroy() {
      this.engine.destroy();
    }
    private emit(event: AmapEvent) {
      for (const h of this.handlers.get(event) ?? []) h();
    }
  }
  return { Map: FakeMap };
}

/** 演示页、测试用的加载办法：马上交回假的高德（不加载任何脚本） */
export function fakeAmapLoader(tileUrl: (z: number, x: number, y: number) => string): AmapLoader {
  const ns = fakeAmap(tileUrl);
  return () => Promise.resolve(ns);
}
