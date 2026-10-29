// 适用领域（196 号票）：断言、任务、策略都归到几个通用的领域，用来"为任务调出相关的用户模型"的第三条路（领域对上）。
// 领域先定 8 个：时间安排、社交、工作发展、家庭、健康、消费、学习、出行。一张通用的"场景和活动 → 领域"词表：
// - 情境标签（kg/context.ts 的维度）：周末、工作日、假期 → 时间安排；社交 → 社交；工作 → 工作发展；家里 → 家庭；
//   旅行、出差、度假 → 出行；学习 → 学习；健康 → 健康（休闲不单列领域）；
// - 说法（活动、话题的名字，任务里的词）：各领域的常见说法，含 rg/concepts.ts 的"被安排、休息、近期状态、各方面的活动"。
// 断言的领域由它的证据和下层断言算：支持它的事实（场景、宾语的名字）、支持它的证据（场景）、它自己的场景、推出它的下层断言的领域（往下递归）。
// 任务的领域：任务文字里的场景词（周六 → 周末 → 时间安排）和说法，加上调用的人给的场景。只认词表，认不出就没有，不猜。
// 201 号票：模型版往上抽的断言，再加上模型给它写的适用领域。
import type { Claim } from "../domain/types.ts";
import { CONTEXT_KEYWORDS, mentions } from "../kg/context.ts";
import { HELD_STATUSES, type MemoryStore } from "../store/store.ts";
import { ARRANGEMENT_TERMS, DOMAIN_TERMS, REST_TERMS } from "./concepts.ts";

export const DOMAINS = ["schedule", "social", "career", "family", "health", "spending", "study", "travel"] as const;
export type Domain = (typeof DOMAINS)[number];

export const DOMAIN_LABELS: Readonly<Record<Domain, string>> = {
  schedule: "时间安排",
  social: "社交",
  career: "工作发展",
  family: "家庭",
  health: "健康",
  spending: "消费",
  study: "学习",
  travel: "出行",
};

/** 情境标签 → 领域 */
export const TAG_DOMAINS: Readonly<Record<string, readonly Domain[]>> = {
  weekend: ["schedule"],
  workday: ["schedule"],
  holiday: ["schedule"],
  social: ["social"],
  work: ["career"],
  family: ["family"],
  travel: ["travel"],
  business_trip: ["travel", "career"],
  vacation: ["travel"],
  study: ["study"],
  health: ["health"],
};

/** 各领域的说法（名字或任务文字里出现就算）。通用词，不对着哪条数据写 */
export const DOMAIN_WORDS: Readonly<Record<Domain, readonly string[]>> = {
  schedule: [...ARRANGEMENT_TERMS, ...REST_TERMS, "时间", "空闲", "空档", "有空", "没空", "日历", "改期", "推迟", "挪到", "腾出", "约个时间", "忙"],
  social: [...DOMAIN_TERMS.social!, "约人", "请客", "同学会", "婚礼"],
  career: [...DOMAIN_TERMS.work!, "升职", "晋升", "转岗", "调薪", "涨薪", "跳槽", "面试", "绩效", "小组长", "远程办公", "在家办公", "坐班", "混合办公", "上班", "同事", "老板", "领导", "工作"],
  family: [...DOMAIN_TERMS.family!, "家里", "老婆", "老公", "亲戚", "带娃"],
  health: [...DOMAIN_TERMS.health!, "爬山", "徒步", "运动", "睡觉", "失眠", "累", "疲惫", "焦虑", "不舒服", "生病", "医院", "看病", "过敏", "忌口", "饮食", "香菜", "吃辣", "减肥"],
  spending: ["买", "购物", "逛街", "花钱", "价格", "预算", "省钱", "便宜", "消费", "餐厅", "订餐", "外卖", "门票", "会员", "月卡", "账单"],
  study: [...DOMAIN_TERMS.study!, "夜校", "培训", "读书", "看书", "讲座"],
  travel: [...DOMAIN_TERMS.travel!, "出差", "机票", "酒店", "民宿", "高铁", "火车", "地铁", "公交", "通勤", "出行", "自驾", "打车"],
};

const ORDER = new Map<string, number>(DOMAINS.map((d, i) => [d, i]));

/** 按固定顺序去重排好 */
export function sortDomains(domains: Iterable<string>): Domain[] {
  return [...new Set(domains)].filter((d): d is Domain => ORDER.has(d)).toSorted((a, b) => ORDER.get(a)! - ORDER.get(b)!);
}

export function domainLabels(domains: readonly string[]): string {
  return domains.map((d) => DOMAIN_LABELS[d as Domain] ?? d).join("、");
}

/** 情境标签对应的领域 */
export function domainsOfTags(tags: readonly string[]): Domain[] {
  return sortDomains(tags.flatMap((t) => TAG_DOMAINS[t] ?? []));
}

/** 一段文字（名字、任务）里的说法对应的领域 */
export function domainsOfText(text: string): Domain[] {
  return sortDomains(DOMAINS.filter((d) => DOMAIN_WORDS[d].some((w) => text.includes(w))));
}

/** 一段文字里提到的场景标签（周六 → weekend）；星期几按 kg/context.ts 的规矩看前后字 */
export function tagsInText(text: string): string[] {
  return Object.entries(CONTEXT_KEYWORDS)
    .filter(([, words]) => words.some((w) => mentions(text, w)))
    .map(([tag]) => tag);
}

/** 任务归到哪些领域：任务文字里的场景词和说法，加上给的场景 */
export function taskDomains(task: string, context: readonly string[] = []): Domain[] {
  return sortDomains([...domainsOfTags([...tagsInText(task), ...context]), ...domainsOfText(task)]);
}

/** 递归往下的深度上限（断言 ← 下层断言 ← …） */
const MAX_DEPTH = 6;

/**
 * 断言的适用领域：它自己的场景；支持它的事实（场景、宾语名字）和证据（场景）；推出它的下层断言的领域（往下递归）。
 * 只看成立过的事实、没撤回的下层断言；memo 让一次同步里每条只算一遍。
 */
export function claimDomains(store: MemoryStore, claim: Claim, memo: Map<string, Domain[]> = new Map(), depth = 0, visiting: Set<string> = new Set()): Domain[] {
  const cached = memo.get(claim.id);
  if (cached) return cached;
  visiting.add(claim.id);
  const out = new Set<Domain>(domainsOfTags(claim.context));
  for (const link of store.linksOf(claim.id)) {
    if (link.polarity !== "supports") continue;
    const fact = store.getFact(link.target);
    if (fact) {
      if (!(HELD_STATUSES as readonly string[]).includes(fact.status)) continue;
      for (const d of domainsOfTags(fact.context)) out.add(d);
      const name = fact.object.type === "entity" ? store.getEntity(fact.object.id) : undefined;
      for (const n of name ? [name.name, ...name.aliases] : fact.object.type === "value" ? [fact.object.value] : []) for (const d of domainsOfText(n)) out.add(d);
      continue;
    }
    const evidence = store.getEvidence(link.target);
    if (evidence && evidence.status !== "forgotten") for (const d of domainsOfTags(evidence.context)) out.add(d);
  }
  // 模型版往上抽时模型给的适用领域（201 号票）
  for (const d of modelDomains(store, claim.id)) out.add(d);
  if (depth < MAX_DEPTH) {
    for (const inf of store.inferencesOf(claim.id)) {
      if (inf.status === "retracted") continue;
      for (const premise of inf.premiseIds) {
        if (visiting.has(premise)) continue;
        const lower = store.getClaim(premise);
        if (!lower || lower.status === "retracted") continue;
        for (const d of claimDomains(store, lower, memo, depth + 1, visiting)) out.add(d);
      }
    }
  }
  visiting.delete(claim.id);
  const result = sortDomains(out);
  memo.set(claim.id, result);
  return result;
}

/** 模型版往上抽的组里，模型给这条断言写的适用领域（rg/llm-lift.ts 的 ModelLiftParams.model.hypotheses） */
function modelDomains(store: MemoryStore, claimId: string): Domain[] {
  const row = store.db.get<{ group_key: string; template: string }>("SELECT group_key, template FROM rg_members WHERE claim_id = ?", claimId);
  if (!row) return [];
  const group = store.db.get<{ params: string }>("SELECT params FROM rg_groups WHERE key = ?", row.group_key);
  if (!group) return [];
  const params = JSON.parse(group.params) as { model?: { hypotheses?: { template: string; domains?: string[] }[] } };
  return sortDomains(params.model?.hypotheses?.find((h) => h.template === row.template)?.domains ?? []);
}
