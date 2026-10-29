// 规则版推理用的几组概念词和说法（不针对哪条数据，只是常见说法）：被别人安排、休息、近期状态、各方面的活动。
// 认事实的宾语属于哪一类时用；认不出就不算（规则版只证明机制跑得通）。
import { CONTEXT_DIMENSIONS, CONTEXT_LABELS } from "../kg/context.ts";
import type { Entity, Fact } from "../domain/types.ts";

/** 时间被别人定、被排满（"不喜欢被提前排满""不想被安排"） */
export const ARRANGEMENT_TERMS: readonly string[] = ["排满", "排得满", "被安排", "安排", "计划", "行程", "日程", "集合", "被约", "约好", "定好", "固定时间", "统一"];

/** 休息、待着（"想好好休息""宅家"） */
export const REST_TERMS: readonly string[] = ["休息", "宅家", "补觉", "放松", "躺平", "歇", "睡懒觉", "待在家", "在家待着"];

/** 说自己的近期状态（词表 states 的规范名，kg/lexicon.ts） */
export const STATE_TOPICS: readonly string[] = ["忙", "累", "焦虑", "不舒服"];

/** 各方面常见的活动说法（宾语里出现就算这方面的活动） */
export const DOMAIN_TERMS: Readonly<Record<string, readonly string[]>> = {
  social: ["聚会", "聚餐", "生日会", "见朋友", "社交", "饭局", "派对", "朋友", "唱K", "KTV", "剧本杀", "桌游", "团建", "年会", "约饭"],
  work: ["技术交流", "分享会", "讲座", "开会", "会议", "加班", "出差", "站会", "评审", "项目"],
  family: ["家人", "爸妈", "父母", "回家", "孩子"],
  travel: ["旅行", "旅游", "度假", "出游", "周边游", "郊游"],
  study: ["学习", "上课", "考试", "读书会", "课程"],
  health: ["健身", "跑步", "体检", "游泳", "骑行"],
  leisure: ["看电影", "演唱会", "音乐节", "看展", "逛街", "露营", "徒步", "爬山"],
};

/** 各方面的短说法（"不喜欢社交这类活动"） */
export const DOMAIN_SHORT: Readonly<Record<string, string>> = {
  social: "社交",
  work: "工作上的",
  family: "家里的",
  travel: "出游",
  study: "学习",
  health: "运动健身",
  leisure: "休闲娱乐",
};

/** 一天是哪种的短说法 */
export const DAYTYPE_SHORT: Readonly<Record<string, string>> = { weekend: "周末", workday: "工作日", holiday: "假期" };

const contains = (name: string, terms: readonly string[]) => terms.some((t) => name.includes(t));

export const isArrangement = (name: string): boolean => contains(name, ARRANGEMENT_TERMS);
export const isRest = (name: string): boolean => contains(name, REST_TERMS);
export const isStateTopic = (name: string): boolean => STATE_TOPICS.includes(name);

/** 事实的"一天是哪种"（周末、工作日、假期）：只认第一个，没有是 null */
export function daytypeOf(context: readonly string[]): string | null {
  return context.find((t) => CONTEXT_DIMENSIONS.daytype!.includes(t)) ?? null;
}

/** 事实场景里"在哪方面"的标签 */
export function domainsOf(context: readonly string[]): string[] {
  return context.filter((t) => CONTEXT_DIMENSIONS.domain!.includes(t));
}

/**
 * 宾语是不是某方面的活动：宾语名字里有这方面的说法；或者事实场景标着这方面、宾语是个活动（不是"被安排""休息"这类）。
 * "不喜欢被提前排满"标着社交场合，但宾语不是社交活动，不算。
 */
export function inDomain(fact: Fact, entity: Entity | undefined, domain: string): boolean {
  const name = entity?.name ?? (fact.object.type === "value" ? fact.object.value : "");
  if (contains(name, DOMAIN_TERMS[domain] ?? [])) return true;
  if (!fact.context.includes(domain)) return false;
  if (isArrangement(name) || isRest(name) || isStateTopic(name)) return false;
  return entity?.type === "activity" || entity?.type === "event";
}

/** 场景标签按维度排好、换成中文（"在周末、社交场合"）；没有标签是空串 */
export function contextPhrase(context: readonly string[]): string {
  if (context.length === 0) return "";
  const order = Object.values(CONTEXT_DIMENSIONS).flat();
  const rank = (t: string) => (order.includes(t) ? order.indexOf(t) : order.length);
  return `在${context.toSorted((a, b) => rank(a) - rank(b)).map((t) => CONTEXT_LABELS[t] ?? t).join("、")}`;
}

/** 证据 id 的引用：［ev-1、ev-2］ */
export function cite(ids: readonly string[]): string {
  return ids.length === 0 ? "" : `［${[...new Set(ids)].join("、")}］`;
}

/** 近期的说法（说的是一阵子的事，不是长期的） */
export const RECENT_MARKERS: readonly string[] = ["最近", "这阵子", "这段时间", "这几天", "这两天", "近来", "近期", "这周", "这礼拜"];
