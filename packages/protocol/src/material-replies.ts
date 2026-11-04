// 素材的"回的是什么"（取值表和上限；schema 在 material-replies-schema.ts）：
// 用户在会话里接着对方（秘书、负责人、记忆管理员、通知、卡片）的话说的一句，素材上挂一两句前文意思的总结；
// 自己开的新话题、会话的第一句不挂。每晚整理之前由记忆管理员批量判（模型），结果是素材频道上的一条 material_replies 事件，
// 素材库照它在素材上标（同"别推断"由记忆命令事件派生：不进原文副本，materials.db 重建时照样标回来）。

/**
 * 一条素材判出来是哪种：
 * - reply：在接着回前文，挂上前文意思的总结；
 * - new_topic：前面有对方的话，但这句是自己开的新话题，不挂；
 * - first：会话的第一句、前面没有对方的话（不问模型），不挂；
 * - cleared：前文所在的会话整个删了（删任务、删项目时连会话一起删），前文的总结跟着删，不再挂
 */
export const MATERIAL_REPLY_VERDICTS = ["reply", "new_topic", "first", "cleared"] as const;
export type MaterialReplyVerdict = (typeof MATERIAL_REPLY_VERDICTS)[number];

/** 前文意思的总结最多多少字（模型写长了截到这么长） */
export const MATERIAL_REPLY_SUMMARY_MAX = 80;
