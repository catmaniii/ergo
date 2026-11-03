// 存下的外部信息（取值表和上限在 ingested-materials.ts）的 schema：
// - 素材频道上 material_ingested 事件的负载（MaterialIngestedEventPayload）：守护进程内部的，前端不订阅；
// - 设置里点开这条素材时多给的一块（IngestedInfoView，MaterialDetailView.ingested）。
import { type Static, Type } from "typebox";
import { INGESTED_INFO_KINDS, INGESTED_TTL_MAX_DAYS } from "./ingested-materials.ts";

/**
 * 素材频道上的 material_ingested 事件的负载：秘书存下的一条外部信息。
 * - 正文（text）是外部数据：只在这条事件里，素材里只记标题（引用的说明）和哈希，正文只进检索的索引；
 * - 出处（sourceRef）必有：邮件的 message-id、网址、日程的事件 id、Looki 时刻的 id……；
 * - capturedAt 是这条信息本身的时间（邮件的发送时间、日程的开始时间、读到网页的时间），time 是存下的时间，ttlDays 从 time 起算；
 * - 存它的会话、用户的那条消息、那次工具调用：彻底删除时连同那次调用一起改写（调用的参数里就是正文）。
 * 彻底删除时标题、正文、出处换成删除标记，别的不变（采集规则不再采它）
 */
export const MaterialIngestedEventPayload = Type.Object({
  id: Type.String(),
  time: Type.String(),
  kind: Type.Enum(INGESTED_INFO_KINDS),
  title: Type.String(),
  text: Type.String(),
  sourceRef: Type.String(),
  capturedAt: Type.String(),
  ttlDays: Type.Optional(Type.Integer({ minimum: 1, maximum: INGESTED_TTL_MAX_DAYS })),
  conversation: Type.String(),
  inputMessageId: Type.Optional(Type.String()),
  toolCallId: Type.Optional(Type.String()),
});
export type MaterialIngestedEventPayload = Static<typeof MaterialIngestedEventPayload>;

/**
 * 设置里点开一条存下的外部信息时多给的：哪种、标题、出处、信息本身的时间；给了建议几天后清理的，另给建议清理的时间
 * （存的时间加 ttlDays 天）和到了没有。正文在素材那一段的 quoted 里（事件还在、没被彻底删除时从事件里补上）
 */
export const IngestedInfoView = Type.Object({
  kind: Type.Enum(INGESTED_INFO_KINDS),
  title: Type.String(),
  sourceRef: Type.String(),
  capturedAt: Type.String(),
  ttlDays: Type.Optional(Type.Integer({ minimum: 1 })),
  cleanupAt: Type.Optional(Type.String()),
  cleanupDue: Type.Optional(Type.Literal(true)),
});
export type IngestedInfoView = Static<typeof IngestedInfoView>;
