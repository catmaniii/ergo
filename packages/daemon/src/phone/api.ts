// "手机"插件对外的接口（299 号票，ADR-0027）：内核和别的插件只从这里拿手机插件的东西——服务名和它的类型；
// 不 import 手机插件的别的文件（test/phone/boundary.test.ts 检查，例外写在那里）。
import { serviceKey } from "../plugins/host.ts";
import type { PhoneService } from "./phone.ts";

export type { PhoneService } from "./phone.ts";

/** 手机插件提供的服务：收 App 交来的通讯录选人、手机日历、照片的时间地点、位置（300 号票），给日历插件的日程 */
export const PHONE = serviceKey<PhoneService>("phone");
