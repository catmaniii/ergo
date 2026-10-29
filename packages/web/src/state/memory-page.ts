// 记忆页的几句说法（285 号票，纯函数）：顶上"和记忆管理员聊"那张卡的两行——最近一次整理、了解你访谈；记忆管理员整页对话里
// 输入框上面那一行（了解你访谈的进度和"开始访谈"，正在聊时写主题和怎么停）。数据是 GET /api/memory/summary、GET /api/memory/interview。
import { MEMORY_NIGHTLY_STATE_LABEL } from "./memory-graph.ts";
import { INTERVIEW_TOPIC_LABEL, INTERVIEW_TOPICS, type InterviewStatusView, type MemorySummaryView, t } from "./protocol.ts";

/** 卡上第一行：每晚 03:00 整理，最近一次是哪天、新出几条（没跑成写结局）；推理库读不到、还没整理过各写一句 */
export function memoryKeeperNightLine(summary: MemorySummaryView | undefined): string {
  if (summary?.ready !== true) return t("state.memoryPage.nightly");
  const night = summary.lastNight;
  if (night === undefined) return t("state.memoryPage.nightlyNone");
  const date = night.night.slice(5);
  if (night.state !== "ran") return t("state.memoryPage.nightlyState", { date, state: MEMORY_NIGHTLY_STATE_LABEL[night.state] });
  return t("state.memoryPage.nightlyRan", { date, newClaims: night.newClaims, changedClaims: night.changedClaims, needsReview: night.needsReview });
}

/** 卡上第二行：了解你访谈聊过几个、下次聊什么；正在聊写主题；取不到写一句说明 */
export function memoryKeeperInterviewLine(view: InterviewStatusView | undefined): string {
  if (view === undefined) return t("pages.memory.interviewSub");
  if (view.active !== undefined) return t("pages.memory.interviewActive", { topic: INTERVIEW_TOPIC_LABEL[view.active.topic] });
  return t("pages.memory.interviewNext", { done: view.covered.length, total: INTERVIEW_TOPICS.length, topic: INTERVIEW_TOPIC_LABEL[view.next] });
}

/** 记忆管理员对话里输入框上面那一行：加粗的一段、跟着的小字、给不给"开始访谈"（正在聊时不给） */
export interface MemoryInterviewBar {
  title: string;
  detail: string;
  canStart: boolean;
}

export function memoryInterviewBar(view: InterviewStatusView): MemoryInterviewBar {
  if (view.active !== undefined) return { title: t("state.memoryPage.barActive", { topic: INTERVIEW_TOPIC_LABEL[view.active.topic] }), detail: t("state.memoryPage.barStop"), canStart: false };
  return {
    title: t("state.memoryPage.barTitle"),
    detail: t("state.memoryPage.barProgress", { done: view.covered.length, total: INTERVIEW_TOPICS.length, topic: INTERVIEW_TOPIC_LABEL[view.next] }),
    canStart: true,
  };
}
