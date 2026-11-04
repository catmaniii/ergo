// 素材的"回的是什么"（取值表和上限在 material-replies.ts）的 schema：
// - 素材频道上 material_replies 事件的负载（MaterialRepliesEventPayload）：守护进程内部的，前端不订阅；
// - 设置里点开这条素材时多给的一块（MaterialReplyView，MaterialDetailView.reply）。
import { type Static, Type } from "typebox";
import { MATERIAL_REPLY_SUMMARY_MAX, MATERIAL_REPLY_VERDICTS } from "./material-replies.ts";

/**
 * 一条素材判的结果。同一条素材后来的覆盖先前的（删任务、删项目时追加 cleared 把前文的总结撤掉）。
 * 彻底删除这条素材、或者前文所在的会话整个删了时，summary 换成删除标记（素材库见到标记就不挂）
 */
export const MaterialReplyItem = Type.Object({
  materialId: Type.String(),
  /** 素材所在的会话 */
  conversation: Type.String(),
  verdict: Type.Enum(MATERIAL_REPLY_VERDICTS),
  /** reply 才有：前文意思的一两句总结（谁说的、问了什么 / 提议了什么 / 汇报了什么），给模型和页面看 */
  summary: Type.Optional(Type.String({ maxLength: MATERIAL_REPLY_SUMMARY_MAX + 1 })),
  /** reply、new_topic 才有：前文是会话里的哪条消息（最近的那条不是用户说的） */
  fromMessageId: Type.Optional(Type.String()),
});
export type MaterialReplyItem = Static<typeof MaterialReplyItem>;

/** 素材频道上的 material_replies 事件：这一批判的结果（每晚整理之前判一批；删任务、删项目时追加的 cleared 也是这个事件） */
export const MaterialRepliesEventPayload = Type.Object({
  /** 哪一夜判的（本地日期 YYYY-MM-DD）：每晚上限按它数 */
  night: Type.String(),
  /** 判的模型（没问模型的——会话第一句、cleared——不写） */
  model: Type.Optional(Type.String()),
  /** 这一批交给模型几句（没判出来的也算：每晚上限按它数）；没问模型的不写 */
  asked: Type.Optional(Type.Integer({ minimum: 0 })),
  items: Type.Array(MaterialReplyItem),
});
export type MaterialRepliesEventPayload = Static<typeof MaterialRepliesEventPayload>;

/** 设置里点开一条素材时多给的：这句回的是什么（前文意思的总结；不是用户说的） */
export const MaterialReplyView = Type.Object({ summary: Type.String() });
export type MaterialReplyView = Static<typeof MaterialReplyView>;
