// 聊天里的地图卡片（卡片类型 map，431）的负载。名字、上限、点开去哪、"查到的能画的那一份"（GET /api/map/drawing 的响应）在 map-card.ts。
// 坐标一律 WGS-84。
import { type Static, Type } from "typebox";
import { MAP_CARD_LABEL_MAX, MAP_CARD_MARKS_MAX, MAP_CARD_ROUTE_POINTS_MAX, MAP_CARD_TITLE_MAX, MAP_DRAWING_KINDS } from "./map-card.ts";

const Lat = Type.Number({ minimum: -85, maximum: 85 });
const Lon = Type.Number({ minimum: -180, maximum: 180 });

/** 卡上标的一个点：编号（卡里不重）、坐标、旁边写的字 */
export const MapCardMark = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 40 }),
  lat: Lat,
  lon: Lon,
  label: Type.Optional(Type.String({ minLength: 1, maxLength: MAP_CARD_LABEL_MAX })),
});
export type MapCardMark = Static<typeof MapCardMark>;

/**
 * 卡上画的是什么（见 map-card.ts 开头）：
 * - day：某一天（YYYY-MM-DD）的足迹，网页按日期现取；
 * - points：一组点；
 * - route：一条路线（按先后连成线的点）和线上标出来的几处（起点、终点、途经，没写字的不标）；
 * - lookup：查地点、算路线的结果（432），只存编号（lookup）、种类（what）、哪家查的（source："amap"），网页按编号现取
 */
export const MapCardShow = Type.Union([
  Type.Object({ kind: Type.Literal("day"), date: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }) }),
  Type.Object({ kind: Type.Literal("points"), marks: Type.Array(MapCardMark, { minItems: 1, maxItems: MAP_CARD_MARKS_MAX }) }),
  Type.Object({
    kind: Type.Literal("route"),
    points: Type.Array(Type.Object({ lat: Lat, lon: Lon }), { minItems: 2, maxItems: MAP_CARD_ROUTE_POINTS_MAX }),
    marks: Type.Array(MapCardMark, { maxItems: MAP_CARD_MARKS_MAX }),
  }),
  Type.Object({
    kind: Type.Literal("lookup"),
    lookup: Type.String({ minLength: 1, maxLength: 40 }),
    what: Type.Enum(MAP_DRAWING_KINDS),
    source: Type.String({ minLength: 1, maxLength: 20 }),
  }),
]);
export type MapCardShow = Static<typeof MapCardShow>;

/**
 * 地图卡片的负载：标题（秘书写的，或者查的时候起的"从家到公司"；不写的网页按种类起）、画什么；
 * replace（461）：地图页开着时新出的卡直接画上去，连着画的叠在一起——秘书填了 true（用户说"换成……""只看……"）的这张
 * 替掉地图上二狗之前画的；不写是叠加。只写 true
 */
export const MapCardPayload = Type.Object({
  title: Type.Optional(Type.String({ minLength: 1, maxLength: MAP_CARD_TITLE_MAX })),
  show: MapCardShow,
  replace: Type.Optional(Type.Literal(true)),
});
export type MapCardPayload = Static<typeof MapCardPayload>;
