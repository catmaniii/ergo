// 地图页的二狗（444）在协议里的那一半：地图页右边的二狗聊天窗、右下角的二狗悬浮按钮里发的消息带上地图的上下文
// （SendMessageParams.map，MapContext），守护进程原样记进消息（MessageEnvelope.map，MapMark），交给秘书时写明（地图插件的输入附注），
// 会话里这条下面一行小字"在地图上说"（map-chat.ts 的 mapLabel）。秘书页签里发的不带。
// 照浏览侧边栏的网页上下文（browsing.ts 的 BrowsingContext）的做法：只认秘书会话。
// 带的是"地图上看的是什么"：现在看的中心（WGS-84）、缩放级别、底图（地图页现在画的那一种：高德、OpenStreetMap……）、
// "足迹"开着时看的是哪一天（选中了哪一处）、看的是聊天里哪张地图卡片；悬浮按钮上发的另带 via: "button"、按住说的 spoken。
// **不带你现在的位置**："回到我现在的位置"定到的点只在页面里（442 的规矩），地图挪到那儿了也只是"看的中心"。
import { type Static, Type } from "typebox";

/** 底图的名字最长多少（amap、osm，以后接进来的地图服务也是一个短名字） */
export const MAP_BASEMAP_MAX = 32;
/** 一处、卡片标题最多多少字 */
export const MAP_CONTEXT_TEXT_MAX = 120;

/** 看的是哪一天的足迹（"足迹"开着时才有）；spot 是选中的那一处的名字（没选中没有） */
export const MapContextFootprints = Type.Object({
  date: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
  spot: Type.Optional(Type.String({ minLength: 1, maxLength: MAP_CONTEXT_TEXT_MAX })),
});
export type MapContextFootprints = Static<typeof MapContextFootprints>;

/** 看的是聊天里哪张地图卡片（431，#/more/map/card/<编号>）：编号、标题 */
export const MapContextCard = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
  title: Type.Optional(Type.String({ minLength: 1, maxLength: MAP_CONTEXT_TEXT_MAX })),
});
export type MapContextCard = Static<typeof MapContextCard>;

/** 地图页右边的聊天窗里、右下角的二狗悬浮按钮上发的消息带的地图上下文（SendMessageParams.map） */
export const MapContext = Type.Object({
  /** 现在看的中心（WGS-84） */
  lat: Type.Number({ minimum: -90, maximum: 90 }),
  lon: Type.Number({ minimum: -180, maximum: 180 }),
  /** 缩放级别（3 看全国、17 看街道） */
  zoom: Type.Number({ minimum: 0, maximum: 22 }),
  /** 底图：地图页现在画的那一种（amap、osm；还没画上是 loading） */
  basemap: Type.String({ minLength: 1, maxLength: MAP_BASEMAP_MAX }),
  footprints: Type.Optional(MapContextFootprints),
  card: Type.Optional(MapContextCard),
  /** 从右下角的二狗悬浮按钮发的；不写是右边的聊天窗 */
  via: Type.Optional(Type.Literal("button")),
  /** 悬浮按钮上按住说的（认出来的字） */
  spoken: Type.Optional(Type.Literal(true)),
});
export type MapContext = Static<typeof MapContext>;

/** 记在消息上的地图上下文（MessageEnvelope.map）：和发来的同一个形状（坐标留 6 位小数、级别留 2 位） */
export const MapMark = MapContext;
export type MapMark = MapContext;
