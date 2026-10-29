// "手机"插件（299 号票，issue 25 生活数据源第一波；用户 2026-10-25："手机上接二狗 App 本机也放到第一批"）：手机上的二狗 App
// 读本机，经网页交给守护进程。网页那一半是 packages/web/src/plugins/phone/（同名，一起启停：数据源页上的"从通讯录挑人""连上手机日历"
// "连上相册""开始记位置"、App 开着时定时同步的后台部件）；App 的原生那一层在 frontend/harmony（phone/ 下几个文件，原生桥 phone* 几个方法）。
// - 数据契约：登记四个数据源（数据源贡献点，295 号票），插件停用也认得——
//   - "手机 · 通讯录选人"（phone-contacts）：手动的（没有连接这回事）；App 交来用户在系统选人界面里挑的人（push），写成
//     phone_contact_picked，交给个人档案的候选核对卡（逐条确认才写进档案，号码逐位核对）；不进记忆素材；
//   - "手机 · 日历"（phone-calendar）：用户在 App 里点"连上手机日历"、系统弹窗授权后连着；App 开着时每隔一会儿交一次同步范围里的
//     全部日程（push），写成增量 phone_calendar_event，交给日历插件当外部日历显示（calendar，标出来自手机）；不进记忆素材；
//     授权被撤回时 App 交来原因，连接状态写明；断开时插件记下没连着（App 不再交）；
//   - "手机 · 照片的时间地点"（phone-photos，300 号票）：用户在 App 里点"连上相册"、系统弹窗授权后连着；App 开着时交最近几天拍的照片的
//     拍摄时间和地点（push，不传照片本身），原始的时间地点存在插件自己的存储里（按天、能清掉，raw），按天整理成一条摘要写成
//     phone_photos_day，采成素材（观察到的本人行为；地点放场景、不算整条是位置：sensitive 写空，位置没打开推断时证据里去掉地点）；
//   - "手机 · 位置"（phone-location，300 号票）：用户在 App 里点"开始记位置"、系统弹窗授权后 App 定时记位置，App 开着时把记下的点交过来
//     （push）；原始坐标点存在插件自己的存储里（按天、能清掉，raw），按天整理成"去过哪、待了多久"一条摘要写成 phone_location_day，
//     采成素材（观察到的本人行为，整条是位置：sensitive ["location"]，记忆的敏感类别"位置"没打开推断时不拿来推断）。
//     308 号票：照片、位置点可以带 App 在手机上转好的系统地名；"手机 · 位置"下面有"常去的地方"（连接状态的 panel，起名、改名、删、
//     手动加一处经 configure 交来，存在插件自己的存储 phone/places.json）；摘要和场景里的地点按"起了名的 > 系统地名 > 坐标"写。
//   四个都只有"导入"这种用法（没有按需查），导入关着时不收；断开并连已导入的一起删：记录整条换成标记（摘要采成的素材跟着彻底删除），
//   档案候选里从通讯录来的、还没写进档案的跟着删（个人档案登记的删除参与方），照片、位置插件自己存储里的那一份整个删掉。
// - 移除时"连数据删"：phone 频道上的全部记录（挑的人、日程、照片和位置的摘要、连接状况）和插件自己的存储（数据目录的 phone/）；
//   已经写进档案的、还没处理的候选，摘要采成的素材不在这里删（写明了）。
// - 依赖：内核的事件存储、时钟、数据目录（KERNEL.layout：插件自己的存储放在 phone/）、个人档案的收候选（KERNEL.personalFiles）；
//   日历插件是可选依赖（wants：不在时"手机 · 日历"写明日历插件没启用，照常收）。没有给 agent 的工具、上下文块。
import {
  type EventType,
  PHONE_CALENDAR_SOURCE,
  PHONE_CONTACTS_SOURCE,
  PHONE_LOCATION_SOURCE,
  PHONE_PHOTOS_SOURCE,
  PhoneCalendarPush,
  PhoneContactsPush,
  PhoneLocationPush,
  PhonePhotosPush,
  PURGED_TEXT,
  t,
} from "@ergo/protocol";
import { CALENDAR } from "../calendar/api.ts";
import type { DataSource } from "../data-sources/api.ts";
import { dataSourceMaterial } from "../data-sources/material.ts";
import type { PluginDefinition } from "../plugins/host.ts";
import { KERNEL } from "../plugins/kernel.ts";
import type { PluginDataRemoval } from "../plugins/removal.ts";
import { clockIso } from "../scheduler/clock.ts";
import { PHONE } from "./api.ts";
import {
  PHONE_CALENDAR_EVENT,
  PHONE_CALENDAR_STATUS,
  PHONE_CHANNEL,
  PHONE_CONTACT_PICKED,
  PHONE_LOCATION_DAY,
  PHONE_LOCATION_STATUS,
  PHONE_PHOTOS_DAY,
  PHONE_PHOTOS_STATUS,
  type PhoneDaySummaryPayload,
} from "./events.ts";
import { createPhoneService } from "./phone.ts";
import { PHONE_DATA_DIR } from "./photos-location.ts";

/** 移除时连数据删：phone 频道上的全部记录、插件自己的存储 */
const phoneRemoval: PluginDataRemoval = {
  get deletes() {
    return [t("phone.plugin.purge.contacts"), t("phone.plugin.purge.calendar"), t("phone.plugin.purge.photosLocation")];
  },
  get keeps() {
    return [t("phone.plugin.keep.files"), t("phone.plugin.keep.materials"), t("phone.plugin.keep.backup")];
  },
  events: [
    { channel: PHONE_CHANNEL, type: PHONE_CONTACT_PICKED },
    { channel: PHONE_CHANNEL, type: PHONE_CALENDAR_EVENT },
    { channel: PHONE_CHANNEL, type: PHONE_CALENDAR_STATUS },
    { channel: PHONE_CHANNEL, type: PHONE_PHOTOS_DAY },
    { channel: PHONE_CHANNEL, type: PHONE_PHOTOS_STATUS },
    { channel: PHONE_CHANNEL, type: PHONE_LOCATION_DAY },
    { channel: PHONE_CHANNEL, type: PHONE_LOCATION_STATUS },
  ],
  files: [PHONE_DATA_DIR],
};

export const phonePlugin: PluginDefinition = {
  name: "phone",
  get title() {
    return t("phone.plugin.title");
  },
  get summary() {
    return t("phone.plugin.summary");
  },
  needs: [KERNEL.store, KERNEL.clock, KERNEL.layout, KERNEL.personalFiles],
  wants: [CALENDAR],
  provides: [PHONE],
  contracts(ctx) {
    const contacts: DataSource = {
      id: PHONE_CONTACTS_SOURCE,
      get title() {
        return t("phone.contacts.title");
      },
      get summary() {
        return t("phone.contacts.summary");
      },
      usages: { import: { default: true } },
      records: [{ channel: PHONE_CHANNEL, type: PHONE_CONTACT_PICKED }],
      push: { body: PhoneContactsPush, receive: (data) => ctx.active(PHONE).receiveContacts(data as PhoneContactsPush) },
      // 306：删除已导入的时实际会删什么（没有密钥、不进素材，确认框不说通用的那几句）
      get disconnectNote() {
        return t("phone.contacts.disconnectNote");
      },
    };
    const calendar: DataSource = {
      id: PHONE_CALENDAR_SOURCE,
      get title() {
        return t("phone.calendar.title");
      },
      get summary() {
        return t("phone.calendar.summary");
      },
      usages: { import: { default: true } },
      records: [{ channel: PHONE_CHANNEL, type: PHONE_CALENDAR_EVENT }],
      status: () => ctx.active(PHONE).calendarStatus(),
      push: { body: PhoneCalendarPush, receive: (data) => ctx.active(PHONE).receiveCalendar(data as PhoneCalendarPush) },
      count: () => ctx.active(PHONE).calendarCount(),
      calendar: (range) => ctx.active(PHONE).calendarEvents(range),
      disconnect: () => ctx.active(PHONE).unlinkCalendar(),
      // 306：断开时实际会怎样（没有密钥、不进素材，确认框不说通用的那几句）
      get disconnectNote() {
        return t("phone.calendar.disconnectNote");
      },
    };
    const photos: DataSource = {
      id: PHONE_PHOTOS_SOURCE,
      get title() {
        return t("phone.photos.title");
      },
      get summary() {
        return t("phone.photos.summary");
      },
      sensitive: ["location"],
      usages: { import: { default: true } },
      records: [{ channel: PHONE_CHANNEL, type: PHONE_PHOTOS_DAY }],
      status: () => ctx.active(PHONE).photosStatus(),
      push: { body: PhonePhotosPush, receive: (data) => ctx.active(PHONE).receivePhotos(data as PhonePhotosPush) },
      disconnect: (c) => ctx.active(PHONE).unlinkPhotos(c.purge),
      raw: {
        get title() {
          return t("phone.photos.rawTitle");
        },
        days: () => ctx.active(PHONE).photosRawDays(),
        clear: (dates) => ctx.active(PHONE).clearPhotosRaw(dates),
      },
    };
    const location: DataSource = {
      id: PHONE_LOCATION_SOURCE,
      get title() {
        return t("phone.location.title");
      },
      get summary() {
        return t("phone.location.summary");
      },
      sensitive: ["location"],
      usages: { import: { default: true } },
      records: [{ channel: PHONE_CHANNEL, type: PHONE_LOCATION_DAY }],
      status: () => ctx.active(PHONE).locationStatus(),
      // 常去的地方（308 号票）：起名、改名、删、手动加一处，网页插件在"手机 · 位置"那一块里经填设置交来（values.places）
      configure: (values) => Promise.resolve(ctx.active(PHONE).configurePlaces(values)),
      push: { body: PhoneLocationPush, receive: (data) => ctx.active(PHONE).receiveLocation(data as PhoneLocationPush) },
      disconnect: (c) => ctx.active(PHONE).unlinkLocation(c.purge),
      raw: {
        get title() {
          return t("phone.location.rawTitle");
        },
        days: () => ctx.active(PHONE).locationRawDays(),
        clear: (dates) => ctx.active(PHONE).clearLocationRaw(dates),
      },
    };
    ctx.dataSources.register(contacts);
    ctx.dataSources.register(calendar);
    ctx.dataSources.register(photos);
    ctx.dataSources.register(location);
    // 照片、位置一天一条的摘要采成素材（303 号票的写法；确定性：只看事件本身）：观察到的本人行为，场景带从几点到几点、地点。
    // 照片那条地点只在场景里（sensitive 写空：位置没打开推断时证据里去掉地点、这条照读）；位置那条整条是位置
    for (const [type, source, sensitive] of [
      [PHONE_PHOTOS_DAY, photos, []],
      [PHONE_LOCATION_DAY, location, ["location"]],
    ] as const) {
      ctx.materialSources.register({
        name: `phone-${type}`,
        eventType: type as EventType,
        capture: (event) => {
          const p = event.payload as PhoneDaySummaryPayload;
          if (typeof p.text !== "string" || p.text === PURGED_TEXT) return [];
          return [
            dataSourceMaterial(source, {
              kind: "observed_behavior",
              text: p.text,
              time: p.at,
              scene: { end: p.end, ...(p.place === undefined ? {} : { place: p.place }) },
              sensitive,
              recordId: p.id,
            }),
          ];
        },
      });
      // 彻底删除：摘要正文、地点都是用户的数据，一起换掉
      ctx.purge.register({
        eventType: type,
        rewrite: (event) => {
          const { place: _place, ...rest } = event.payload as PhoneDaySummaryPayload;
          return { ...rest, text: PURGED_TEXT } satisfies PhoneDaySummaryPayload;
        },
      });
    }
    ctx.removal.declare(phoneRemoval);
  },
  setup(ctx) {
    const clock = ctx.use(KERNEL.clock);
    ctx.provide(
      PHONE,
      createPhoneService({
        store: ctx.use(KERNEL.store),
        now: () => clockIso(clock),
        personalFiles: ctx.use(KERNEL.personalFiles),
        // 可选依赖：现取（日历插件没装、运行中停了是 undefined）
        calendarOn: () => ctx.optional(CALENDAR) !== undefined,
        nowMs: () => clock.now(),
        dataDir: ctx.use(KERNEL.layout).root,
        log: (line) => ctx.log(line),
      }),
    );
  },
};
