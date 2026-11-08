// 地图页底下的"画地图的那一层"（429）：两种底图各一种，地图页只经这个接口用它们，换底图时整个换掉。
// - osm-engine.ts：自己写的瓦片地图（不加依赖），画 OpenStreetMap 的瓦片（经守护进程的 /tiles/osm 转发）；
// - amap-engine.ts：高德 JS API（运行时从高德加载的脚本）。
// 坐标一律 WGS-84 进出，高德那一种自己转。
// 445：接口挪到核心（model/map.ts），别的插件经地图服务插槽 mapBasemaps 登记的底图也照它写；这里原样转出。
export type { MapEngine, MapEngineEvents, MapEngineFactory, MapEngineOptions } from "../../model/map.ts";
