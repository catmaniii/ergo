// 地图卡片（卡片类型 map，431）：秘书的"画在地图上"（show-on-map.ts）放进聊天的一张缩略地图。出来就是已处理（没有要你选的），没有动作；
// 点开进地图页看大的（网页那一半 plugins/map/MapCard.tsx）；461 起地图页开着时新出的直接画上去（叠加，卡上写了 replace 的替掉之前画的）。卡上存什么见协议包 map-card.ts：足迹只存日期、查地点和路线的结果只存编号，
// 秘书自己给的点和路线存坐标。
// 彻底删除时：秘书写的标题、点旁边的字换成删除标记（可能是用户说过的地名），坐标、日期、编号照旧。
import { MapCardPayload as MapCardSchema, type MapCardPayload, mapCardTitle, PURGED_TEXT, t } from "@ergo/protocol";
import { defineCardType } from "../cards/registry.ts";

/** 纯文本降级（不认识这种卡的前端、缩放的要点层显示它；生成时按当时的语言写） */
export const mapCardText = (p: MapCardPayload): string => t("map.card.text", { title: mapCardTitle(p) });

/** 点旁边的字换成删除标记 */
const purgedMarks = <M extends { label?: string }>(list: readonly M[]): M[] => list.map((m) => (m.label === undefined ? m : { ...m, label: PURGED_TEXT }));

/** 彻底删除：标题、点旁边的字换成删除标记（替不替掉之前画的照旧，461） */
export function purgedMapCard(p: MapCardPayload): MapCardPayload {
  const show = p.show.kind === "points" ? { ...p.show, marks: purgedMarks(p.show.marks) } : p.show.kind === "route" ? { ...p.show, marks: purgedMarks(p.show.marks) } : p.show;
  return { ...(p.title === undefined ? {} : { title: PURGED_TEXT }), show, ...(p.replace === true ? { replace: true as const } : {}) };
}

export function mapCardType() {
  return defineCardType({
    type: "map",
    version: 1,
    payload: MapCardSchema,
    actions: {},
    toText: mapCardText,
    purge: purgedMapCard,
  });
}
