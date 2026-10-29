// 了解你访谈（284 号票）：记忆管理员和用户约的访谈，一次一个主题，用来冷启动对用户的了解（CONTEXT.md"了解你访谈"）。
// 本文件只是取值表和纯函数（不引用 TypeBox）：主题有哪几个、先后、五个都聊过以后的"最近有什么变化"、素材上"来自访谈"的情境标签。
// 卡片、接口的 schema 在 memory-interview-schema.ts。给人看的主题名跟着当前语言（tTable，取值时现查）；给模型看的问法在守护进程里。
import { tTable } from "./i18n/runtime.ts";

/**
 * 五个主题，按先后：家里的人和基本情况（顺手填档案）、工作和一天怎么过、人生里几次重要的选择、在意什么和烦什么、想让二狗怎么帮你。
 * 一次聊一个；聊过的记下来，下次约下一个
 */
export const INTERVIEW_TOPICS = ["family", "work_day", "choices", "cares", "help"] as const;
export type InterviewMainTopic = (typeof INTERVIEW_TOPICS)[number];

/** 五个主题都聊过以后每月一次的那个："最近有什么变化想聊聊吗" */
export const INTERVIEW_CHANGES_TOPIC = "changes" as const;

/** 访谈能聊的全部主题（五个，加上每月一次的"最近有什么变化"） */
export const INTERVIEW_ALL_TOPICS = [...INTERVIEW_TOPICS, INTERVIEW_CHANGES_TOPIC] as const;
export type InterviewTopic = (typeof INTERVIEW_ALL_TOPICS)[number];

/** 主题的名字（卡片、记忆页、待办里写） */
export const INTERVIEW_TOPIC_LABEL: Readonly<Record<InterviewTopic, string>> = tTable({
  family: "protocol.interview.topic.family",
  work_day: "protocol.interview.topic.workDay",
  choices: "protocol.interview.topic.choices",
  cares: "protocol.interview.topic.cares",
  help: "protocol.interview.topic.help",
  changes: "protocol.interview.topic.changes",
});

/** 约访的频率：五个主题没聊完时每周一次，都聊过以后每月一次 */
export const INTERVIEW_CADENCES = ["weekly", "monthly"] as const;
export type InterviewCadence = (typeof INTERVIEW_CADENCES)[number];

/** 访谈是从哪开的：待办里的约访卡、记忆页的"找管理员聊聊"、跟秘书说、在管理员的会话里直接说 */
export const INTERVIEW_STARTERS = ["card", "page", "secretary", "curator"] as const;
export type InterviewStarter = (typeof INTERVIEW_STARTERS)[number];

/** 约访卡上的三个选择的结局：开始了、下次再说、不想做了（以后不再约，设置 · 记忆里能重新打开） */
export const INTERVIEW_INVITE_RESULTS = ["started", "later", "declined"] as const;
export type InterviewInviteResult = (typeof INTERVIEW_INVITE_RESULTS)[number];

/**
 * 素材信封上表示"来自访谈"的情境标签：访谈开着时用户在记忆管理员的会话里说的话（打的字、语音转写）带上它。
 * 消息事件、语音对象的归属里带着访谈的编号（MessageScope.interviewId），采集规则据此打标签（确定性的，只看事件本身）
 */
export const INTERVIEW_CONTEXT = "interview";

/**
 * 访谈里一句话的素材上，管理员问的那一句放在哪（切段的 locator.field）：一段 agent 的产出（只记说明"记忆管理员问：……"，不算本人的话），
 * 排在用户的话前面——"是第二种"这种短答单看没意思，连着问的那句才读得懂。问的那句从消息的归属 MessageScope.interviewQuestion 来
 */
export const INTERVIEW_QUESTION_FIELD = "interviewQuestion";

/** 访谈里管理员问的那一句最多记多长（取末尾：问题一般在一段话的最后） */
export const INTERVIEW_QUESTION_MAX = 200;

/** 访谈的档案核对卡上一条的状态：待确认、写进去了、不记、档案里已经是这个值（没再写） */
export const INTERVIEW_FILE_STATES = ["pending", "written", "skipped", "unchanged"] as const;
export type InterviewFileState = (typeof INTERVIEW_FILE_STATES)[number];

export function isInterviewTopic(value: string): value is InterviewTopic {
  return (INTERVIEW_ALL_TOPICS as readonly string[]).includes(value);
}

export function isInterviewMainTopic(value: string): value is InterviewMainTopic {
  return (INTERVIEW_TOPICS as readonly string[]).includes(value);
}

/** 下次聊哪个：五个里第一个还没聊过的；都聊过了是"最近有什么变化" */
export function nextInterviewTopic(covered: readonly string[]): InterviewTopic {
  return INTERVIEW_TOPICS.find((topic) => !covered.includes(topic)) ?? INTERVIEW_CHANGES_TOPIC;
}

/** 约访的频率：五个都聊过了每月一次，否则每周一次 */
export function interviewCadence(covered: readonly string[]): InterviewCadence {
  return INTERVIEW_TOPICS.every((topic) => covered.includes(topic)) ? "monthly" : "weekly";
}
