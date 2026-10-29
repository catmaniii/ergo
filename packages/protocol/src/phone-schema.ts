// 手机上的二狗 App 交来的（299 号票）：POST /api/data-sources/<id>/push 的 data（DataSourcePushBody），守护进程的"手机"插件按这里查。
// 名字和上限在 phone.ts。App 只交要的几样：联系人只有称呼、电话、生日、地址；日程只有标题、开始结束、全天、地点、哪个日历；
// 照片只有编号、拍摄时间、经纬度（300 号票，不传照片本身）；位置点只有时间、经纬度、精度。308 号票起照片、位置点可以多带系统转出来的地名。
import { type Static, Type } from "typebox";
import { PHONE_ADDRESS_PART_MAX, PHONE_CALENDAR_EVENTS_MAX, PHONE_CONTACTS_MAX, PHONE_LOCATION_POINTS_MAX, PHONE_PHOTOS_MAX } from "./phone.ts";

/** 交来的是哪台设备（给人看的型号，"HUAWEI Pura 90"；数据源页写"来自 …"） */
const Device = Type.String({ minLength: 1, maxLength: 60 });

/** 通讯录里挑的一个人：称呼、电话（可能几个）、生日（通讯录里写的，"1962-03-02"）、地址（可能几个） */
export const PhoneContact = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 60 }),
    phones: Type.Array(Type.String({ minLength: 1, maxLength: 40 }), { maxItems: 5 }),
    birthday: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
    addresses: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 3 }),
  },
  { additionalProperties: false },
);
export type PhoneContact = Static<typeof PhoneContact>;

/** 通讯录选人（数据源 phone-contacts）：用户在系统选人界面里挑的几个人 */
export const PhoneContactsPush = Type.Object(
  { device: Type.Optional(Device), contacts: Type.Array(PhoneContact, { minItems: 1, maxItems: PHONE_CONTACTS_MAX }) },
  { additionalProperties: false },
);
export type PhoneContactsPush = Static<typeof PhoneContactsPush>;

/** 通讯录选人交回的：交给档案候选的几个人、候选核对卡（没有能上卡的——都和档案里一样——没有） */
export interface PhoneContactsReply {
  names: string[];
  cardId?: string;
}

/**
 * 手机日历里的一条日程（重复的日程每一次一条）：key 是 App 给的编号（日程编号加这一次的开始，同一次不变），开始、结束是协议时间
 * （全天的是那几天本地的 0 点）
 */
export const PhoneCalendarEvent = Type.Object(
  {
    key: Type.String({ minLength: 1, maxLength: 200 }),
    title: Type.String({ maxLength: 300 }),
    start: Type.String({ minLength: 1, maxLength: 40 }),
    end: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
    allDay: Type.Boolean(),
    location: Type.Optional(Type.String({ maxLength: 300 })),
    /** 手机里的哪个日历（账户的名字） */
    calendar: Type.Optional(Type.String({ maxLength: 100 })),
  },
  { additionalProperties: false },
);
export type PhoneCalendarEvent = Static<typeof PhoneCalendarEvent>;

/**
 * 手机日历（数据源 phone-calendar）一次交来的：授权给了的交范围（from、to）里的全部日程（范围里没交的就是删了）；link 为真是用户刚在
 * App 里点了"连上手机日历"（没连着时只认这种）。没授权、撤回了、读不了的交状态和原因（数据源页写明）
 */
export const PhoneCalendarPush = Type.Union([
  Type.Object(
    {
      device: Type.Optional(Device),
      state: Type.Literal("granted"),
      link: Type.Optional(Type.Boolean()),
      from: Type.String({ minLength: 1, maxLength: 40 }),
      to: Type.String({ minLength: 1, maxLength: 40 }),
      events: Type.Array(PhoneCalendarEvent, { maxItems: PHONE_CALENDAR_EVENTS_MAX }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      device: Type.Optional(Device),
      state: Type.Union([Type.Literal("denied"), Type.Literal("revoked"), Type.Literal("unavailable")]),
      reason: Type.Optional(Type.String({ maxLength: 300 })),
    },
    { additionalProperties: false },
  ),
]);
export type PhoneCalendarPush = Static<typeof PhoneCalendarPush>;

/** 交来的授权没给、撤回了、读不了的那一种（300 号票：照片、位置同手机日历） */
const LostState = Type.Union([Type.Literal("denied"), Type.Literal("revoked"), Type.Literal("unavailable")]);
/** 纬度、经度（WGS-84，鸿蒙定位和照片 EXIF 给的） */
const Latitude = Type.Number({ minimum: -90, maximum: 90 });
const Longitude = Type.Number({ minimum: -180, maximum: 180 });

const AddressPart = Type.String({ minLength: 1, maxLength: PHONE_ADDRESS_PART_MAX });
/**
 * 系统转出来的地名（308 号票）：手机系统的坐标转地址（鸿蒙 geoLocationManager.getAddressesFromLocation）给的街道或地标（spot）、
 * 区县（district）、城市（city），有哪段给哪段；转不了的整个不带（守护进程照旧写坐标）
 */
export const PhoneAddress = Type.Object(
  { spot: Type.Optional(AddressPart), district: Type.Optional(AddressPart), city: Type.Optional(AddressPart) },
  { additionalProperties: false },
);
export type PhoneAddress = Static<typeof PhoneAddress>;

/**
 * 相册里的一张照片（300 号票）：key 是 App 给的编号（相册里这张照片的地址，守护进程只存它的哈希）、拍摄时间（协议时间）、
 * 拍摄地点（照片里记着、App 又有读照片位置的授权才有）、地点的系统地名（308 号票，转得了才有）。不带照片本身、文件名、相册名
 */
export const PhonePhoto = Type.Object(
  {
    key: Type.String({ minLength: 1, maxLength: 300 }),
    takenAt: Type.String({ minLength: 1, maxLength: 40 }),
    lat: Type.Optional(Latitude),
    lon: Type.Optional(Longitude),
    address: Type.Optional(PhoneAddress),
  },
  { additionalProperties: false },
);
export type PhonePhoto = Static<typeof PhonePhoto>;

/**
 * 照片的时间地点（数据源 phone-photos，300 号票）一次交来的：授权给了的交 [from, to) 里拍的照片（读重了不要紧，守护进程按 key 只收一次）；
 * location 是有没有读照片位置的授权（没有时照片都不带地点）；link 为真是用户刚在 App 里点了"连上相册"。没授权、撤回了、读不了的交状态和原因
 */
export const PhonePhotosPush = Type.Union([
  Type.Object(
    {
      device: Type.Optional(Device),
      state: Type.Literal("granted"),
      link: Type.Optional(Type.Boolean()),
      location: Type.Boolean(),
      from: Type.String({ minLength: 1, maxLength: 40 }),
      to: Type.String({ minLength: 1, maxLength: 40 }),
      photos: Type.Array(PhonePhoto, { maxItems: PHONE_PHOTOS_MAX }),
    },
    { additionalProperties: false },
  ),
  Type.Object({ device: Type.Optional(Device), state: LostState, reason: Type.Optional(Type.String({ maxLength: 300 })) }, { additionalProperties: false }),
]);
export type PhonePhotosPush = Static<typeof PhonePhotosPush>;

/** App 记下的一个位置点（300 号票）：什么时候（协议时间）、经纬度、精度（米，定位给的半径）、系统地名（308 号票，转得了才有） */
export const PhoneLocationPoint = Type.Object(
  {
    at: Type.String({ minLength: 1, maxLength: 40 }),
    lat: Latitude,
    lon: Longitude,
    accuracy: Type.Optional(Type.Number({ minimum: 0, maximum: 100_000 })),
    address: Type.Optional(PhoneAddress),
  },
  { additionalProperties: false },
);
export type PhoneLocationPoint = Static<typeof PhoneLocationPoint>;

/**
 * 位置（数据源 phone-location，300 号票）一次交来的：授权给了的交 App 记下、还没交过的点（按时间先后；交重了不要紧，守护进程按时间只收一次）；
 * background 是 App 在后台也记没有（长时任务）；link 为真是用户刚在 App 里点了"开始记位置"。没授权、撤回了、读不了的交状态和原因
 */
export const PhoneLocationPush = Type.Union([
  Type.Object(
    {
      device: Type.Optional(Device),
      state: Type.Literal("granted"),
      link: Type.Optional(Type.Boolean()),
      background: Type.Boolean(),
      points: Type.Array(PhoneLocationPoint, { maxItems: PHONE_LOCATION_POINTS_MAX }),
    },
    { additionalProperties: false },
  ),
  Type.Object({ device: Type.Optional(Device), state: LostState, reason: Type.Optional(Type.String({ maxLength: 300 })) }, { additionalProperties: false }),
]);
export type PhoneLocationPush = Static<typeof PhoneLocationPush>;
