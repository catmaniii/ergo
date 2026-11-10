// 地图页底下的"画地图的那一层"（429）：每一家底图一种，地图页只经这个接口用它们，换底图时整个换掉。
// - tile-engine.ts：自己写的瓦片地图（不加依赖），画登记了瓦片的那一家（455 起瓦片地址由 OpenStreetMap 插件给，经守护进程的 /tiles/osm 转发）；
// - 别家插件自己的（高德插件的 amap-engine.ts：高德 JS API；谷歌地图插件的 google-engine.ts：隔离框里的谷歌）。
// 坐标一律 WGS-84 进出，要转的（高德）自己转。
// 445：接口挪到核心（model/map.ts），别的插件经地图服务插槽 mapBasemaps 登记的底图也照它写；这里原样转出。
export type { MapEngine, MapEngineEvents, MapEngineFactory, MapEngineOptions, MapSurfaceView, SceneEngine, TileEngineOptions } from "../../model/map.ts";
