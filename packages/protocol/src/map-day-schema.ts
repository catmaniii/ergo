// 地图上的"我的足迹"（GET /api/map/day?date=YYYY-MM-DD 的响应，430）。名字、纯函数在 map-day.ts。
// 坐标一律 WGS-84（手机交来的就是它），时间是协议时间。这些只在二狗里画，不发给任何地图服务。
import { type Static, Type } from "typebox";

/** 一个位置点（精度太差的不给）：轨迹线按它们连 */
export const MapDayPoint = Type.Object({
  at: Type.String(),
  lat: Type.Number(),
  lon: Type.Number(),
});
export type MapDayPoint = Static<typeof MapDayPoint>;

/**
 * 一段停留：一串点都在一处附近（同记忆里那条位置摘要的口径：离第一个点 400 米以内、中间没有一个半小时以上的空档），
 * 前后够 15 分钟。
 * - spot：同一处的几段一样（早上在家、晚上又回家）——落在同一处起了名的地方的范围里的，或者离得 500 米以内的；地图上一处一个点；
 * - 地名按"起了名的 > 系统地名"给：name 是用户起的名字（落在哪一处起了名的地方的范围里，placeId 是它），
 *   address 是手机系统转出来的地名（这一段的点里最多的那个），都没有的页面写坐标；
 * - lat/lon 是这一段的点的中心；minutes 是待了几分钟（from 到 to）；points 是这一段几个点
 */
export const MapDayStay = Type.Object({
  id: Type.String(),
  spot: Type.String(),
  from: Type.String(),
  to: Type.String(),
  minutes: Type.Integer({ minimum: 0 }),
  lat: Type.Number(),
  lon: Type.Number(),
  points: Type.Integer({ minimum: 1 }),
  placeId: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  address: Type.Optional(Type.String()),
});
export type MapDayStay = Static<typeof MapDayStay>;

/** 一张有地点的照片：只有拍摄时间和坐标（不给照片本身、文件名、相册） */
export const MapDayPhoto = Type.Object({
  id: Type.String(),
  at: Type.String(),
  lat: Type.Number(),
  lon: Type.Number(),
});
export type MapDayPhoto = Static<typeof MapDayPhoto>;

/** 起了名的常去的地方：名字、中心、范围（半径，米） */
export const MapDayPlace = Type.Object({
  id: Type.String(),
  name: Type.String(),
  lat: Type.Number(),
  lon: Type.Number(),
  radius: Type.Number(),
});
export type MapDayPlace = Static<typeof MapDayPlace>;

/**
 * 某一天的足迹：
 * - points：这天的位置点（按时间先后，精度太差的去掉）；stays：停留（按时间先后）；photos：有地点的照片（按时间先后）；
 *   unlocatedPhotos：这天拍的、没有地点的照片几张；
 * - places：起了名的常去的地方（全部，不只这天去过的）；
 * - days：有足迹的日子（有位置点或照片的，新的在前，最多 MAP_DAY_DAYS_MAX 天）；
 * - linked：手机上的"位置""照片的时间地点"现在连着没有（没连着、这天又没有东西时页面说怎么连）
 */
export const MapDayView = Type.Object({
  date: Type.String(),
  points: Type.Array(MapDayPoint),
  stays: Type.Array(MapDayStay),
  photos: Type.Array(MapDayPhoto),
  unlocatedPhotos: Type.Integer({ minimum: 0 }),
  places: Type.Array(MapDayPlace),
  days: Type.Array(Type.String()),
  linked: Type.Object({ location: Type.Boolean(), photos: Type.Boolean() }),
});
export type MapDayView = Static<typeof MapDayView>;

/**
 * 手机最近交来的一个位置点（GET /api/map/latest 的响应，442）：地图页"回到我现在的位置"在这台设备定不了位时退一步用它，
 * 写明是多久以前手机交来的。只这一个点（不给轨迹）；at 是手机记下它的时间（协议时间），accuracy 是精度（米，App 报了才有）。
 * 手机还没交来过位置、手机插件没启用时没有 point
 */
export const MapLatestPoint = Type.Object({
  at: Type.String(),
  lat: Type.Number(),
  lon: Type.Number(),
  accuracy: Type.Optional(Type.Number({ minimum: 0 })),
});
export type MapLatestPoint = Static<typeof MapLatestPoint>;

export const MapLatestView = Type.Object({
  point: Type.Optional(MapLatestPoint),
});
export type MapLatestView = Static<typeof MapLatestView>;
