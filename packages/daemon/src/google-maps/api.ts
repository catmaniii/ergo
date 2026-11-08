// 谷歌地图插件对外的接口（ADR-0027、ADR-0057）：插件目录之外只从这里拿谷歌地图的东西（插件名、服务名和类型）；
// 不 import 别的文件（test/google-maps/boundary.test.ts 检查，例外只有插件清单列它）。
// 谷歌地图插件本身经地图插件的"地图服务"插槽（map/api.ts 的 MAP_PROVIDERS）登记一家地图服务 google，内核、网关都不认得它：
// 地图页的底图、给秘书的查地点和算路线、体检里的用量都走地图插件；它自己只多一个数据源"谷歌地图"（设置 · 数据源里填两个 Key）。
import { serviceKey } from "../plugins/host.ts";
import type { GoogleMapsService } from "./service.ts";

export type { GoogleMapsService } from "./service.ts";

/** 插件名（配置 plugins.disabled 里写的、网页插件的名字） */
export const GOOGLE_MAPS_PLUGIN = "google-maps";

/** 谷歌地图插件提供的服务（插件自己的数据源经它现取） */
export const GOOGLE_MAPS = serviceKey<GoogleMapsService>("google-maps");
