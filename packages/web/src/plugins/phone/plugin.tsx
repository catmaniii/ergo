// 手机插件的网页这一半（299 号票；守护进程那一半是 packages/daemon/src/phone/plugin.ts，同名 phone，一起启停）。登记的：
// - 设置 · 数据源里各数据源下面那一块（dataSources 插槽）："手机 · 通讯录选人"的"从手机通讯录挑人"、"手机 · 日历"的
//   "连上手机日历""现在同步"（PhonePanels.tsx）；300 号票加了"手机 · 照片的时间地点"的"连上相册"、"手机 · 位置"的"开始记位置"
//   "App 在后台也记"，连同耗电、隐私说明（PhoneMediaPanels.tsx）——按钮只在鸿蒙 App 里能用（原生桥的读本机这几组方法），别处写明要到 App 里；
// - 后台部件（background）：在 App 里时开场、回到前台、每 30 分钟同步一次手机日历（连着、导入开着时）；300 号票另一个同步照片、位置。
// 停用时：几块都不画（数据源页那一行写"手机插件没启用"），后台部件不跑；数据源页、日历是核心和日历插件的，照常。
import { PHONE_CALENDAR_SOURCE, PHONE_CONTACTS_SOURCE, PHONE_LOCATION_SOURCE, PHONE_PHOTOS_SOURCE, t } from "../../state/index.ts";
import type { WebPluginDefinition } from "../api.ts";
import { LocationPanel, PhoneMediaSync, PhotosPanel } from "./PhoneMediaPanels.tsx";
import { CalendarPanel, ContactsPanel, PhoneCalendarSync } from "./PhonePanels.tsx";

export const phoneWebPlugin: WebPluginDefinition = {
  name: "phone",
  get title() {
    return t("ui.plugins.phone.title");
  },
  owns: { dataSources: [PHONE_CONTACTS_SOURCE, PHONE_CALENDAR_SOURCE, PHONE_PHOTOS_SOURCE, PHONE_LOCATION_SOURCE], background: ["phone-calendar-sync", "phone-media-sync"] },
  get brings() {
    return [t("ui.plugins.phone.brings.contacts"), t("ui.plugins.phone.brings.calendar"), t("ui.plugins.phone.brings.photosLocation")];
  },
  setup(ctx) {
    ctx.register("dataSources", { id: PHONE_CONTACTS_SOURCE, Panel: ContactsPanel });
    ctx.register("dataSources", { id: PHONE_CALENDAR_SOURCE, Panel: CalendarPanel });
    ctx.register("dataSources", { id: PHONE_PHOTOS_SOURCE, Panel: PhotosPanel });
    ctx.register("dataSources", { id: PHONE_LOCATION_SOURCE, Panel: LocationPanel });
    ctx.register("background", { id: "phone-calendar-sync", Run: PhoneCalendarSync });
    ctx.register("background", { id: "phone-media-sync", Run: PhoneMediaSync });
  },
};
