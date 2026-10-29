// 问题分流（202 号票）：answer() 先看问的是哪一类，各走各的。规则版靠句式和关键词，认不出的当事实回忆：
// - 事实回忆（什么时候、在哪、跟谁、做了什么）：只走检索；
// - 关于自己的判断（"我是不是……""我到底喜不喜欢……""我是什么样的人"）：查用户模型和推理图谱（196 号票的三条路）；
// - 为什么（"为什么……""图啥"）：同上；
// - 任务和建议（"帮我……"）：走 adviseTask。
// 先认任务，再认为什么（"是不是因为"是问原因，不是问判断），再认关于自己的判断，剩下的是事实回忆。
//
// 问法里的词（喜欢、是不是、为什么、看重……）只说明"怎么问"，不说明"问什么"：拿它们去配原话、断言，会配上所有说过"喜欢"的话。
// 相关门槛（relevance.ts）判"命中"时先把这些词去掉，只看剩下的话题词（topicTerms）。
import { queryTerms } from "../retrieval/terms.ts";

export const QUESTION_KINDS = ["recall", "self", "why", "task"] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

export const QUESTION_KIND_LABELS: Readonly<Record<QuestionKind, string>> = {
  recall: "事实回忆",
  self: "关于自己的判断",
  why: "为什么",
  task: "任务和建议",
};

/** 任务和建议："帮我……""替我……""给我安排……" */
export const TASK_PATTERN = /帮我|替我|帮忙|麻烦你|给我(?:安排|订|约|推荐|找|挑|定|排|列|想|规划)|^请/;

/** 为什么：问原因、动机 */
export const WHY_PATTERN = /为什么|为啥|怎么(?:老|总|一直|又|都)|什么原因|原因|是不是因为|干嘛|凭什么|图啥|图什么|动机|出于什么/;

/** 关于自己的判断：是不是、到底、什么样的人，和问喜好、在乎什么的说法 */
export const SELF_PATTERN =
  /是不是|是否|到底|究竟|算不算|什么样的人|哪种人|哪类人|性格|喜欢|讨厌|偏好|想不想|愿不愿|愿意|合不合|适合|会不会想|在乎|看重|习惯|乐意|更想|更愿意|宁愿|宁可|共同点/;

export function isWhyQuestion(q: string): boolean {
  return WHY_PATTERN.test(q);
}

export function classifyQuestion(question: string): QuestionKind {
  const q = question.trim();
  if (TASK_PATTERN.test(q)) return "task";
  if (WHY_PATTERN.test(q)) return "why";
  if (SELF_PATTERN.test(q)) return "self";
  return "recall";
}

/** 问法里的词：分流用的说法，加几个只表示语气、程度的词。只说明怎么问，不算话题 */
export const FRAME_WORDS: readonly string[] = [
  "喜不喜欢",
  "爱不爱",
  "想不想",
  "愿不愿意",
  "愿不愿",
  "合不合适",
  "合不合",
  "适不适合",
  "会不会想",
  "是不是因为",
  "是不是",
  "是否",
  "到底",
  "究竟",
  "算不算",
  "算是",
  "什么样的人",
  "哪种人",
  "哪类人",
  "为什么",
  "为啥",
  "什么原因",
  "原因",
  "干嘛",
  "凭什么",
  "图啥",
  "图什么",
  "动机",
  "出于什么",
  "喜欢",
  "讨厌",
  "偏好",
  "愿意",
  "适合",
  "在乎",
  "看重",
  "习惯",
  "乐意",
  "更想",
  "更愿意",
  "宁愿",
  "宁可",
  "共同点",
  "特别",
  "真的",
  "其实",
  "比较",
  "觉得",
  "认为",
  "有点",
];

const FRAME_SORTED = FRAME_WORDS.toSorted((a, b) => b.length - a.length);

/** 去掉问法里的词以后剩下的文字（问法的词换成空格，免得前后两段粘成一个词） */
export function stripFrame(question: string): string {
  let s = question;
  for (const w of FRAME_SORTED) s = s.replaceAll(w, " ");
  return s;
}

/** 话题词：去掉问法里的词以后，照检索的拆词（retrieval/terms.ts）拆出的三字词、两字词、说状态的单字 */
export function topicTerms(question: string): string[] {
  const t = queryTerms(stripFrame(question));
  return [...new Set([...t.fts, ...t.short, ...t.single])];
}
