// 地图页底下的"画地图的那一层"（429）：两种底图各一种，地图页只经这个接口用它们，换底图时整个换掉。
// - osm-engine.ts：自己写的瓦片地图（不加依赖），画 OpenStreetMap 的瓦片（经守护进程的 /tiles/osm 转发）；
// - amap-engine.ts：高德 JS API（运行时从高德加载的脚本）。
// 坐标一律 WGS-84 进出，高德那一种自己转。
import type { MapScene, MapView } from "./scene.ts";

export interface MapEngineEvents {
  /** 拖完、缩放完（停下来）：现在看的是哪里 */
  onMoveEnd(view: MapView): void;
  /** 点了地图上的一个点 */
  onMarkClick?(id: string): void;
}

export interface MapEngine {
  readonly kind: "amap" | "osm";
  /** 现在看的是哪里 */
  view(): MapView;
  /** 跳到哪里（不带动画）；跳完和拖完一样报 onMoveEnd */
  setView(view: MapView): void;
  /** 放大缩小几级（正的放大） */
  zoomBy(delta: number): void;
  /** 地图上画什么（整份换掉） */
  setScene(scene: MapScene): void;
  /** 深色：OSM 的瓦片加滤镜，高德换深色样式 */
  setDark(dark: boolean): void;
  /** 停用：拆掉自己加的元素和监听 */
  destroy(): void;
}
