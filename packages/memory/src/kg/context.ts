// 场景（情境标签）：判断两条事实的场景重不重叠，按场景过滤查询，从一句话里补出场景。
// 标签按维度分：一天是哪种（周末、工作日、假期）、在哪方面（社交、工作、家里、旅行……）、出行是哪种（出差、度假）。
// 两组标签"不重叠"= 有一个维度上两边都写了、但写的没有交集（周末 vs 工作日；社交 vs 工作）；
// 不认得的标签合成一个维度比（两边都有不认得的、又没有交集才算不重叠）；任何一边没写场景 = 不限场景，和谁都重叠。

export const CONTEXT_DIMENSIONS: Readonly<Record<string, readonly string[]>> = {
  daytype: ["weekend", "workday", "holiday"],
  domain: ["social", "work", "family", "travel", "study", "health", "leisure"],
  trip: ["business_trip", "vacation"],
};

const KNOWN = new Set(Object.values(CONTEXT_DIMENSIONS).flat());

/** 是不是认得的场景标签（各维度合起来的；不认得的两边合成一个维度比，见 contextsCompatible、rg/lift.ts 的 scenesDiffer） */
export function isKnownContextTag(tag: string): boolean {
  return KNOWN.has(tag);
}

/** 一句话里出现这些词就补上对应的标签 */
export const CONTEXT_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  weekend: ["周末", "周六", "周日", "周天", "星期六", "星期天", "星期日", "礼拜六", "礼拜天", "双休"],
  workday: ["工作日", "周一", "周二", "周三", "周四", "周五", "星期一", "星期二", "星期三", "星期四", "星期五", "礼拜一", "礼拜二", "礼拜三", "礼拜四", "礼拜五", "平日"],
  holiday: ["假期", "节假日", "放假", "长假", "国庆", "春节", "年假", "五一", "中秋"],
  social: ["聚会", "朋友", "社交", "饭局", "聚餐", "派对"],
  work: ["工作", "上班", "公司", "同事", "项目", "加班", "老板", "领导"],
  family: ["家人", "爸妈", "父母", "孩子", "老婆", "老公"],
  travel: ["旅行", "旅游", "度假", "出游", "出差"],
  study: ["学习", "上课", "考试"],
  health: ["健身", "跑步", "体检", "生病"],
  business_trip: ["出差"],
  vacation: ["度假", "休假"],
};

/** 标签的中文说法（精炼陈述里用） */
export const CONTEXT_LABELS: Readonly<Record<string, string>> = {
  weekend: "周末",
  workday: "工作日",
  holiday: "假期",
  social: "社交场合",
  work: "工作中",
  family: "家里",
  travel: "旅行时",
  study: "学习时",
  health: "健康方面",
  leisure: "休闲时",
  business_trip: "出差时",
  vacation: "度假时",
};

/** 两组场景重不重叠（重叠 = 可能是同一个场景） */
export function contextsCompatible(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return true;
  for (const tags of Object.values(CONTEXT_DIMENSIONS)) {
    const left = a.filter((t) => tags.includes(t));
    const right = b.filter((t) => tags.includes(t));
    if (left.length > 0 && right.length > 0 && !left.some((t) => right.includes(t))) return false;
  }
  const otherLeft = a.filter((t) => !KNOWN.has(t));
  const otherRight = b.filter((t) => !KNOWN.has(t));
  return !(otherLeft.length > 0 && otherRight.length > 0 && !otherLeft.some((t) => otherRight.includes(t)));
}

/** 星期几的说法：周一、星期三、礼拜天……（"周末"不算，它不会和后面的字连成别的词） */
const WEEKDAY_WORD = /^(?:周|星期|礼拜)[一二三四五六日天]$/;
/** "周"前面是数目时说的是几周（两周一次、一周五天、几个星期） */
const COUNT_BEFORE = /[一二两三四五六七八九十几半百0-9０-９]$/;
/** 星期几的那个字和后面的字连成了别的词（194 号票："那周一点都不忙""这周一般""这周天天加班""这周天气"） */
const JOINED_AFTER: Readonly<Record<string, RegExp>> = {
  一: /^[点般直起样次下些切定致共旦向边同半会阵遍口整律道块番再]/,
  天: /^[天气]/,
};
/** 星期几的那个字后面跟着量词：说的是几次、几天（每周三次、一周五天班；"周五天气好"不算） */
const MEASURE_AFTER = /^(?:[次个趟回遍]|天(?!气))/;

/** 一句话里有没有说到这个场景词。星期几要看前后的字（194 号票）：前面是数目、后面和那个字连成别的词或跟着量词的都不算 */
export function mentions(text: string, word: string): boolean {
  if (!WEEKDAY_WORD.test(word)) return text.includes(word);
  const day = word.at(-1)!;
  for (let i = text.indexOf(word); i >= 0; i = text.indexOf(word, i + 1)) {
    const after = text.slice(i + word.length);
    if (COUNT_BEFORE.test(text.slice(0, i))) continue;
    if (JOINED_AFTER[day]?.test(after) || MEASURE_AFTER.test(after)) continue;
    return true;
  }
  return false;
}

function tagsIn(text: string, dimension: readonly string[]): string[] {
  return dimension.filter((tag) => (CONTEXT_KEYWORDS[tag] ?? []).some((w) => mentions(text, w)));
}

/**
 * 一个分句的场景：证据的标签为底；分句里明说了周末、工作日这类的，以分句为准（一句话里"工作日愿意、周末不想"各算各的）；
 * 证据没有标签时，再从分句里补出在哪方面、出行是哪种。
 */
export function clauseContext(evidenceContext: readonly string[], clause: string): string[] {
  const result = [...evidenceContext];
  const daytype = CONTEXT_DIMENSIONS.daytype!;
  const said = tagsIn(clause, daytype);
  if (said.length > 0) {
    const kept = result.filter((t) => !daytype.includes(t));
    result.length = 0;
    result.push(...kept, ...said);
  }
  if (evidenceContext.length === 0) {
    for (const dim of ["domain", "trip"]) for (const tag of tagsIn(clause, CONTEXT_DIMENSIONS[dim]!)) if (!result.includes(tag)) result.push(tag);
  }
  return result;
}

/** 两组标签一样（不管顺序） */
export function sameContext(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((t) => b.includes(t));
}
