// 高德地图插件对外的接口（455，ADR-0061）：插件目录之外只从这里拿它的东西（插件名、地图服务的编号、服务名和类型）；
// 不 import 别的文件（test/amap/boundary.test.ts 检查，例外只有插件清单列它）。
// 它本身经地图插件的"地图服务"插槽（map/api.ts 的 MAP_PROVIDERS）登记一家 amap，内核、网关都不认得它：
// 地图页的底图、给秘书的查地点和算路线、体检里的用量、卡片的预览图、/_AMapService 的转发都走地图插件；它自己只多一个数据源"高德地图"。
import { serviceKey } from "../plugins/host.ts";
import type { AmapService } from "./service.ts";

export type { AmapService } from "./service.ts";

/** 插件名（配置 plugins.disabled 里写的、网页插件的名字） */
export const AMAP_PLUGIN = "amap";

/** 登记进插槽的那一家的编号（查到的编号前缀 amap-、这台设备的手动选择 ergo-map-choice 里存的都是它，定了别改） */
export const AMAP_PROVIDER = "amap";

/** 高德地图插件提供的服务（插件自己的数据源经它现取） */
export const AMAP = serviceKey<AmapService>("amap");
