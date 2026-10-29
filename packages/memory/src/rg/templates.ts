// 规则版推理的模板表（第 7.1 节）：观察模式 → 竞争假设；每条假设事先写下"看到什么算支持、看到什么算反证"（预期），
// 追问从两条假设预期不同的地方出（预期分离：两边预期一样的问题没有判别力，不出）。
//
// 模板是通用的，不对着哪条数据写：
// - repeated_decline：在同一类日子（周末、工作日、假期）里多次拒绝活动 → 不喜欢这方面的活动 / 重视这类日子的自主安排 /
//   近期忙或累 / 不喜欢那几次活动的内容（任务书 4.5 那四种）；
// - repeated_engage：在同一类日子里多次参加、发起活动 → 喜欢那几样活动本身 / 喜欢这方面的场合 / 只是工作需要。
// 规则版只证明机制跑得通，不代表认知效果。
import { addDays, toMs } from "../domain/time.ts";
import type { ClaimTier, Entity, Fact, LinkWeight, Predicate } from "../domain/types.ts";
import { CONTEXT_DIMENSIONS } from "../kg/context.ts";
import { DAYTYPE_SHORT, DOMAIN_SHORT, DOMAIN_TERMS, daytypeOf, domainsOf, inDomain, isArrangement, isRest, isStateTopic } from "./concepts.ts";
import { upgrade } from "./scoring.ts";
import type { RgView, TargetLink } from "./types.ts";

export const OBSERVATION_PATTERNS = ["repeated_decline", "repeated_engage"] as const;
/** 观察模式，加上往上抽的两层（195 号票，rg/lift.ts） */
export type PatternId = (typeof OBSERVATION_PATTERNS)[number] | "lift:need" | "lift:value";

/** 模板看的一条事实：事实、宾语实体和名字、什么时候、是不是用户明说的、是不是来自纠正 */
export interface FactInfo {
  fact: Fact;
  entity: Entity | undefined;
  name: string;
  /** 发生的时间（没有就用有效期的起点、知道的时间） */
  time: string;
  stated: boolean;
  /** 证据是用户的纠正（种类是 correction，或者事实这一层判定它纠正了旧事实）：多重升一档 */
  correction: boolean;
}

/** 一组的参数：哪类日子、哪方面、哪几样活动、观察的时间范围 */
export interface SceneParams {
  daytype: string | null;
  domain: string | null;
  activities: { id: string; name: string }[];
  first: string;
  last: string;
  spanDays: number;
  count: number;
  /** 观察里有没有标着工作的 */
  workTagged: boolean;
}

export interface Expectation {
  id: string;
  polarity: "supports" | "refutes";
  weight: LinkWeight;
  match(f: FactInfo, p: SceneParams): boolean;
  why(f: FactInfo, p: SceneParams): string;
}

export interface HypothesisTemplate {
  id: string;
  pattern: PatternId;
  tier: ClaimTier;
  applies(p: SceneParams): boolean;
  statement(p: SceneParams): string;
  context(p: SceneParams): string[];
  validity(p: SceneParams): { validFrom: string | null; validTo: string | null };
  /** 按多重从高到低排：一条事实对一条假设只取第一个配上的 */
  expectations: readonly Expectation[];
  /** 组级别的检查（比如观察分布的时间跨度），目标是某条观察 */
  groupChecks?(p: SceneParams, observations: readonly FactInfo[]): TargetLink[];
}

export interface ProbeTemplate {
  id: string;
  pattern: PatternId;
  /** 要区分的两条（模板 id） */
  pair: readonly [string, string];
  /** 找到了算支持哪一条（if_yes）；搜不到判 inconclusive，不判负 */
  ifFound: string;
  ask(p: SceneParams): string;
  queries(p: SceneParams): string[];
}

// ---------- 一条事实怎么配模板 ----------

/** 模板看的那条事实（宾语实体和名字、时间、是不是明说的、是不是纠正） */
export function factInfo(fact: Fact, view: RgView): FactInfo {
  const correction = fact.evidenceIds.some((id) => view.isCorrection(id));
  return {
    fact,
    entity: fact.object.type === "entity" ? view.entity(fact.object.id) : undefined,
    name: fact.object.type === "entity" ? view.entityName(fact.object.id) : fact.object.value,
    time: fact.eventTime ?? fact.validFrom ?? fact.observedAt,
    stated: fact.assertion === "user_stated",
    correction,
  };
}

/** 一条事实按一个模板的预期配：配上的第一个（多重从高到低）；纠正的升一档 */
export function assessFact(template: HypothesisTemplate, params: SceneParams, f: FactInfo): TargetLink | undefined {
  for (const e of template.expectations) {
    if (!e.match(f, params)) continue;
    const weight = f.correction ? upgrade(e.weight) : e.weight;
    const rationale = f.correction ? `${e.why(f, params)}（这是用户的纠正，优先于原来的推断）` : e.why(f, params);
    return { target: f.fact.id, polarity: e.polarity, weight, rationale };
  }
  return undefined;
}

// ---------- 认事实的小工具 ----------

const ENGAGE: ReadonlySet<Predicate> = new Set<Predicate>(["participated_in", "initiated"]);
const has = (f: FactInfo, tag: string | null) => tag !== null && f.fact.context.includes(tag);
const pred = (f: FactInfo, ...ps: Predicate[]) => ps.includes(f.fact.predicate);
const pos = (f: FactInfo) => !f.fact.negated;
/** 在这类日子里（组不分日子时都算）：要明写着这个标签 */
const inScene = (f: FactInfo, p: SceneParams) => p.daytype === null || has(f, p.daytype);
/** 明写着别的日子 */
const otherScene = (f: FactInfo, p: SceneParams) => {
  const d = daytypeOf(f.fact.context);
  return p.daytype !== null && d !== null && d !== p.daytype;
};
/** 宾语是组里那几样活动之一 */
const isActivity = (f: FactInfo, p: SceneParams) => f.fact.object.type === "entity" && p.activities.some((a) => a.id === (f.fact.object as { id: string }).id);
const inDom = (f: FactInfo, domain: string | null) => domain !== null && inDomain(f.fact, f.entity, domain);
/** 在观察的时间范围前后 days 天里 */
const inWindow = (f: FactInfo, p: SceneParams, days = 14) => {
  const t = toMs(f.time);
  return t >= toMs(addDays(p.first, -days)) && t <= toMs(addDays(p.last, days));
};
/** 不喜欢 X 或者不想要 X（否定的偏好） */
const dislikesIt = (f: FactInfo) => (pred(f, "dislikes") && pos(f)) || (pred(f, "prefers") && f.fact.negated);
/** 喜欢 X 或者不反感 X */
const okWithIt = (f: FactInfo) => (pred(f, "prefers") && pos(f)) || (pred(f, "dislikes") && f.fact.negated);

const D = (p: SceneParams) => (p.daytype ? (DAYTYPE_SHORT[p.daytype] ?? p.daytype) : "这些场合");
const M = (p: SceneParams) => (p.domain ? (DOMAIN_SHORT[p.domain] ?? p.domain) : "这类");
const names = (p: SceneParams) => p.activities.map((a) => a.name).join("、");
const when = (f: FactInfo) => f.time.slice(0, 10);

// ---------- repeated_decline ----------

const declineTemplates: HypothesisTemplate[] = [
  {
    id: "dislike_domain",
    pattern: "repeated_decline",
    tier: "preference",
    applies: (p) => p.domain !== null,
    statement: (p) => `用户不喜欢${M(p)}这类活动，不只是在${D(p)}`,
    context: (p) => [p.domain!],
    validity: (p) => ({ validFrom: p.first, validTo: null }),
    expectations: [
      { id: "says_ok", polarity: "refutes", weight: "decisive", match: (f, p) => f.stated && okWithIt(f) && inDom(f, p.domain), why: (f) => `用户明说${f.fact.negated ? "不反感" : "喜欢"}${f.name}` },
      { id: "initiated", polarity: "refutes", weight: "strong", match: (f, p) => pred(f, "initiated") && pos(f) && inDom(f, p.domain), why: (f) => `用户 ${when(f)} 主动约了${f.name}` },
      { id: "says_dislike", polarity: "supports", weight: "strong", match: (f, p) => f.stated && dislikesIt(f) && inDom(f, p.domain), why: (f) => `用户说不喜欢${f.name}` },
      { id: "participated", polarity: "refutes", weight: "weak", match: (f, p) => pred(f, "participated_in") && pos(f) && inDom(f, p.domain), why: (f) => `用户 ${when(f)} 参加了${f.name}` },
      { id: "declined_elsewhere", polarity: "supports", weight: "weak", match: (f, p) => pred(f, "declined") && pos(f) && inDom(f, p.domain) && otherScene(f, p), why: (f) => `在别的日子（${f.fact.context.join("、")}）也拒绝了${f.name}` },
    ],
  },
  {
    id: "scene_autonomy",
    pattern: "repeated_decline",
    tier: "preference",
    applies: (p) => p.daytype !== null,
    statement: (p) => `用户重视${D(p)}的自主安排：${D(p)}想自己安排时间，不愿被别人提前排定`,
    context: (p) => [p.daytype!],
    validity: (p) => ({ validFrom: p.first, validTo: null }),
    expectations: [
      {
        id: "says_likes_arranged",
        polarity: "refutes",
        weight: "decisive",
        match: (f, p) => f.stated && pred(f, "prefers") && pos(f) && isArrangement(f.name) && inScene(f, p),
        why: (f, p) => `用户明说喜欢${D(p)}${f.name}`,
      },
      {
        id: "says_dislikes_arranged",
        polarity: "supports",
        weight: "strong",
        match: (f, p) => f.stated && dislikesIt(f) && isArrangement(f.name) && (inScene(f, p) || daytypeOf(f.fact.context) === null),
        why: (f, p) => `用户明说不喜欢${D(p)}${f.name}，和"想自己安排"一致`,
      },
      { id: "initiated_in_scene", polarity: "supports", weight: "weak", match: (f, p) => pred(f, "initiated") && pos(f) && inScene(f, p), why: (f, p) => `用户${D(p)}自己主动约了${f.name}（自己安排的就去）` },
      { id: "rest_in_scene", polarity: "supports", weight: "weak", match: (f, p) => pred(f, "prefers") && pos(f) && isRest(f.name) && inScene(f, p), why: (f, p) => `用户说${D(p)}想${f.name}` },
      { id: "joined_in_scene", polarity: "refutes", weight: "weak", match: (f, p) => pred(f, "participated_in") && pos(f) && inScene(f, p), why: (f, p) => `用户${D(p)}也去参加了${f.name}` },
    ],
  },
  {
    id: "recent_state",
    pattern: "repeated_decline",
    tier: "state",
    applies: () => true,
    statement: (p) => `用户近期太忙或太累，没精力参加活动（${p.first.slice(0, 10)} 前后）`,
    context: () => [],
    validity: (p) => ({ validFrom: p.first, validTo: addDays(p.last, 14) }),
    expectations: [
      { id: "says_not_busy", polarity: "refutes", weight: "strong", match: (f, p) => pred(f, "said_about") && f.fact.negated && isStateTopic(f.name) && inWindow(f, p), why: (f) => `用户 ${when(f)} 说自己不${f.name}` },
      { id: "says_busy", polarity: "supports", weight: "strong", match: (f, p) => pred(f, "said_about") && pos(f) && isStateTopic(f.name) && inWindow(f, p), why: (f) => `用户 ${when(f)} 说自己${f.name}` },
      { id: "working_on", polarity: "supports", weight: "weak", match: (f, p) => pred(f, "works_on") && pos(f) && inWindow(f, p), why: (f) => `用户这段时间在忙${f.name}` },
      { id: "rest_recently", polarity: "supports", weight: "weak", match: (f, p) => pred(f, "prefers") && pos(f) && isRest(f.name) && inWindow(f, p), why: (f) => `用户 ${when(f)} 说想${f.name}` },
      { id: "active_meanwhile", polarity: "refutes", weight: "weak", match: (f, p) => ENGAGE.has(f.fact.predicate) && pos(f) && inWindow(f, p), why: (f) => `同一段时间（${when(f)}）用户还去了${f.name}，有精力参加别的` },
    ],
    groupChecks: (p, observations) => {
      if (p.spanDays <= 45) return [];
      const earliest = observations.reduce((a, b) => (toMs(a.time) <= toMs(b.time) ? a : b));
      return [{ target: earliest.fact.id, polarity: "refutes", weight: "strong", rationale: `这些拒绝分布在 ${p.spanDays} 天里，不像一阵子的状态` }];
    },
  },
  {
    id: "dislike_content",
    pattern: "repeated_decline",
    tier: "preference",
    applies: (p) => p.activities.length > 0,
    statement: (p) => `用户不喜欢这几次的活动本身（${names(p)}），不是别的原因`,
    context: (p) => [p.daytype, p.domain].filter((t): t is string => t !== null),
    validity: (p) => ({ validFrom: p.first, validTo: null }),
    expectations: [
      { id: "says_dislike_it", polarity: "supports", weight: "strong", match: (f, p) => f.stated && dislikesIt(f) && isActivity(f, p), why: (f) => `用户说不喜欢${f.name}` },
      { id: "likes_it", polarity: "refutes", weight: "strong", match: (f, p) => ((ENGAGE.has(f.fact.predicate) && pos(f)) || okWithIt(f)) && isActivity(f, p), why: (f) => `用户参加过、或者说过不反感${f.name}` },
      {
        id: "says_ok_similar",
        polarity: "refutes",
        weight: "strong",
        match: (f, p) => f.stated && okWithIt(f) && inDom(f, p.domain) && (inScene(f, p) || daytypeOf(f.fact.context) === null),
        why: (f) => `用户明说${f.fact.negated ? "不反感" : "喜欢"}${f.name}（同一类活动）`,
      },
      { id: "declined_it_elsewhere", polarity: "supports", weight: "weak", match: (f, p) => pred(f, "declined") && pos(f) && isActivity(f, p) && otherScene(f, p), why: (f) => `在别的日子也拒绝了${f.name}` },
    ],
  },
];

// ---------- repeated_engage ----------

const engageTemplates: HypothesisTemplate[] = [
  {
    id: "likes_content",
    pattern: "repeated_engage",
    tier: "preference",
    applies: (p) => p.activities.length > 0,
    statement: (p) => `用户喜欢${names(p)}这类活动本身`,
    context: () => [],
    validity: (p) => ({ validFrom: p.first, validTo: null }),
    expectations: [
      { id: "says_dislike_it", polarity: "refutes", weight: "decisive", match: (f, p) => f.stated && dislikesIt(f) && isActivity(f, p), why: (f) => `用户明说不喜欢${f.name}` },
      { id: "says_like_it", polarity: "supports", weight: "strong", match: (f, p) => f.stated && pred(f, "prefers") && pos(f) && isActivity(f, p), why: (f) => `用户说喜欢${f.name}` },
      { id: "engaged_elsewhere", polarity: "supports", weight: "weak", match: (f, p) => ENGAGE.has(f.fact.predicate) && pos(f) && isActivity(f, p) && otherScene(f, p), why: (f) => `别的日子也去了${f.name}` },
      { id: "declined_it", polarity: "refutes", weight: "weak", match: (f, p) => pred(f, "declined") && pos(f) && isActivity(f, p), why: (f) => `用户 ${when(f)} 拒绝了${f.name}` },
    ],
  },
  {
    id: "likes_domain",
    pattern: "repeated_engage",
    tier: "preference",
    applies: (p) => p.domain !== null,
    statement: (p) => `用户喜欢${M(p)}这类场合，不只是这几次的内容`,
    context: (p) => [p.domain!],
    validity: (p) => ({ validFrom: p.first, validTo: null }),
    expectations: [
      { id: "says_dislike_domain", polarity: "refutes", weight: "decisive", match: (f, p) => f.stated && dislikesIt(f) && inDom(f, p.domain), why: (f) => `用户明说不喜欢${f.name}` },
      { id: "says_like_domain", polarity: "supports", weight: "strong", match: (f, p) => f.stated && pred(f, "prefers") && pos(f) && inDom(f, p.domain) && !isActivity(f, p), why: (f) => `用户说喜欢${f.name}` },
      { id: "engaged_other", polarity: "supports", weight: "weak", match: (f, p) => ENGAGE.has(f.fact.predicate) && pos(f) && inDom(f, p.domain) && !isActivity(f, p), why: (f) => `用户还去了${f.name}（同一方面的别的活动）` },
      { id: "declined_domain", polarity: "refutes", weight: "weak", match: (f, p) => pred(f, "declined") && pos(f) && inDom(f, p.domain), why: (f) => `用户 ${when(f)} 拒绝了${f.name}` },
    ],
  },
  {
    id: "obligation",
    pattern: "repeated_engage",
    tier: "preference",
    applies: (p) => p.workTagged,
    statement: (p) => `用户去${names(p) || "这些活动"}主要是工作需要，不一定是自己想去`,
    context: () => ["work"],
    validity: (p) => ({ validFrom: p.first, validTo: null }),
    expectations: [
      { id: "initiated", polarity: "refutes", weight: "strong", match: (f, p) => pred(f, "initiated") && pos(f) && (isActivity(f, p) || inDom(f, p.domain)), why: (f) => `用户主动发起了${f.name}，不是被要求的` },
      { id: "off_work", polarity: "refutes", weight: "strong", match: (f, p) => ENGAGE.has(f.fact.predicate) && pos(f) && isActivity(f, p) && !has(f, "work"), why: (f) => `不是工作场合用户也去了${f.name}` },
      { id: "work_again", polarity: "supports", weight: "weak", match: (f, p) => ENGAGE.has(f.fact.predicate) && pos(f) && has(f, "work") && !isActivity(f, p), why: (f) => `用户在工作场合还去了${f.name}` },
    ],
  },
];

export const HYPOTHESIS_TEMPLATES: readonly HypothesisTemplate[] = [...declineTemplates, ...engageTemplates];

export function templateById(id: string): HypothesisTemplate | undefined {
  return HYPOTHESIS_TEMPLATES.find((t) => t.id === id);
}

export const PROBE_TEMPLATES: readonly ProbeTemplate[] = [
  {
    id: "elsewhere_social",
    pattern: "repeated_decline",
    pair: ["dislike_domain", "scene_autonomy"],
    ifFound: "scene_autonomy",
    ask: (p) => `${D(p)}以外的时候（比如工作日），你会去参加或者自己约${M(p)}的活动吗？最近一次是什么？`,
    queries: () => ["参加", "报名", "主动约", "约朋友", "不反感"],
  },
  {
    id: "own_schedule",
    pattern: "repeated_decline",
    pair: ["scene_autonomy", "dislike_content"],
    ifFound: "scene_autonomy",
    ask: (p) => `上次推掉的${D(p)}活动，要是时间由你自己定，你会去吗？`,
    queries: () => ["排满", "安排", "计划", "提前", "不反感"],
  },
  {
    id: "busy_lately",
    pattern: "repeated_decline",
    pair: ["scene_autonomy", "recent_state"],
    ifFound: "recent_state",
    ask: () => "这阵子工作或者身体上是不是特别忙、特别累？",
    // 两个字以上、不带虚词的说法：混合检索把单字和"很、太、了"这类当分隔，"忙""累"这种一个字的实体名也认不出
    queries: () => ["加班", "忙不过来", "事情多", "赶工", "忙碌", "疲惫", "精力", "压力", "累死", "累坏"],
  },
  {
    id: "liked_before",
    pattern: "repeated_decline",
    pair: ["dislike_domain", "dislike_content"],
    ifFound: "dislike_content",
    ask: (p) => `以前${M(p)}的活动里，有你自己挺想去的吗？是哪一次？`,
    queries: (p) => [...p.activities.map((a) => a.name), "喜欢", "讨厌"],
  },
  {
    id: "other_kinds",
    pattern: "repeated_engage",
    pair: ["likes_content", "likes_domain"],
    ifFound: "likes_domain",
    ask: (p) => `除了${names(p)}，${M(p)}的别的活动你也会去吗？`,
    queries: (p) => [...(p.domain ? (DOMAIN_TERMS[p.domain] ?? []).slice(0, 4) : []), "参加", "报名"],
  },
  {
    id: "off_duty",
    pattern: "repeated_engage",
    pair: ["obligation", "likes_content"],
    ifFound: "likes_content",
    ask: (p) => `不是工作安排的时候（比如周末），你也会去${names(p)}吗？`,
    queries: (p) => [...p.activities.map((a) => a.name), "周末", "自己去"],
  },
  {
    id: "required",
    pattern: "repeated_engage",
    pair: ["obligation", "likes_domain"],
    ifFound: "obligation",
    ask: (p) => `去${names(p)}是公司或者领导要求的吗？`,
    queries: () => ["要求", "领导", "公司安排", "必须"],
  },
];

// ---------- 认观察模式 ----------

const PATTERN_PREDICATES: Readonly<Record<(typeof OBSERVATION_PATTERNS)[number], ReadonlySet<Predicate>>> = {
  repeated_decline: new Set<Predicate>(["declined"]),
  repeated_engage: ENGAGE,
};

export interface PatternInstance {
  pattern: PatternId;
  key: string;
  params: SceneParams;
  description: string;
  observations: FactInfo[];
}

/** 出现最多的"在哪方面"标签（至少两条观察都有才算；一样多按维度里的顺序） */
function commonDomain(infos: readonly FactInfo[]): string | null {
  const counts = new Map<string, number>();
  for (const f of infos) for (const d of domainsOf(f.fact.context)) counts.set(d, (counts.get(d) ?? 0) + 1);
  const order = CONTEXT_DIMENSIONS.domain!;
  const best = [...counts.entries()].filter(([, n]) => n >= 2).toSorted((a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0]))[0];
  return best ? best[0] : null;
}

/**
 * 在能当依据的事实里找观察模式：同一个模式、同一类日子（不标日子的另算一组）至少两条，就是一组。
 * key = 模式|日子|方面，同样的观察得到同样的 key。
 */
export function detectPatterns(infos: readonly FactInfo[]): PatternInstance[] {
  const out: PatternInstance[] = [];
  for (const pattern of OBSERVATION_PATTERNS) {
    const byDay = new Map<string | null, FactInfo[]>();
    for (const f of infos) {
      if (!PATTERN_PREDICATES[pattern].has(f.fact.predicate) || f.fact.negated) continue;
      const d = daytypeOf(f.fact.context);
      byDay.set(d, [...(byDay.get(d) ?? []), f]);
    }
    for (const [daytype, observations] of byDay) {
      if (observations.length < 2) continue;
      const sorted = observations.toSorted((a, b) => toMs(a.time) - toMs(b.time));
      const domain = commonDomain(sorted);
      const activities: { id: string; name: string }[] = [];
      for (const f of sorted) if (f.fact.object.type === "entity" && !activities.some((a) => a.id === (f.fact.object as { id: string }).id)) activities.push({ id: f.fact.object.id, name: f.name });
      const first = sorted[0]!.time;
      const last = sorted.at(-1)!.time;
      const params: SceneParams = {
        daytype,
        domain,
        activities,
        first,
        last,
        spanDays: Math.round((toMs(last) - toMs(first)) / 86_400_000),
        count: sorted.length,
        workTagged: sorted.some((f) => f.fact.context.includes("work")),
      };
      const verb = pattern === "repeated_decline" ? "拒绝" : "参加或发起";
      out.push({
        pattern,
        key: `${pattern}|${daytype ?? "any"}|${domain ?? "any"}`,
        params,
        description: `${daytype ? `${DAYTYPE_SHORT[daytype] ?? daytype}` : "不分日子"}${domain ? `、${DOMAIN_SHORT[domain] ?? domain}方面` : ""}${verb}了 ${sorted.length} 次活动（${names(params)}，${first.slice(0, 10)} 到 ${last.slice(0, 10)}）`,
        observations: sorted,
      });
    }
  }
  return out;
}
