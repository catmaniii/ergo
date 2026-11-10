// OpenStreetMap 插件对外的接口（455，ADR-0061）：插件目录之外只从这里拿它的东西（插件名、地图服务的编号）；
// 不 import 别的文件（test/openstreetmap/boundary.test.ts 检查，例外只有插件清单列它）。
// 它本身经地图插件的"地图服务"插槽（map/api.ts 的 MAP_PROVIDERS）登记一家 osm，内核、网关都不认得它。

/** 插件名（配置 plugins.disabled 里写的、网页插件的名字） */
export const OPENSTREETMAP_PLUGIN = "openstreetmap";

/** 登记进插槽的那一家的编号（瓦片地址 /tiles/osm/…、查到的编号前缀 osm-、这台设备的手动选择 ergo-map-choice 里存的都是它，定了别改） */
export const OSM_PROVIDER = "osm";
