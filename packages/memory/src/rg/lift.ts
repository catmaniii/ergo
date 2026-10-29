// 往上抽一层（195 号票）：规则版推理的需求、价值层通用规则（第 4.3、5 节）。
//
// - 需求层：同一主题的偏好或状态断言（推断的和用户明说的都算，要 active、至少 medium），在两种以上不同的场合
//   （按第 5 节的维度比；229 号票起只看"方面（domain）"维度：方面标签集合不同才算两种，「家里、休闲」和「家里、工作」算两种，
//   只差日型（周末/工作日/假期）或出行（出差/休假）不算）、两个以上月份都成立，支持背后至少 3 条证据 → 出需求层的一组竞争假设
//   （"上位解释"），至少两条，互相登记；推断是"结论 ← 这几条断言"（method = induction）；
// - 价值层：成立的需求断言（active、至少 medium）自己也跨两种以上场合、三个以上月份时才出；置信度最多 medium（confidenceCap）；
//   只有用户确认过（ReasoningGraph.confirmClaim）才标 user_confirmed；
// - 只有一两条证据的不出。
// 主题是通用的："回避被别人安排好的时间"（autonomy）、"反复说忙说累"（load）、"不分场合都去某样活动"（interest:<活动>），
// 不看哪条数据。每条上位解释照旧事先写好支持和反证的预期（带多重），配判别性追问；
// 观察（下层断言的支持事实）对组里每条都是弱支持，下层断言的反证只按预期配。
import { addDays, localDate, toMs } from "../domain/time.ts";
import type { Fact, Predicate } from "../domain/types.ts";
import { CONTEXT_DIMENSIONS, CONTEXT_LABELS, contextsCompatible, isKnownContextTag } from "../kg/context.ts";
import { isArrangement, isRest, isStateTopic } from "./concepts.ts";
import { assessFact, factInfo, HYPOTHESIS_TEMPLATES, PROBE_TEMPLATES, type FactInfo, type HypothesisTemplate, type ProbeTemplate, type SceneParams } from "./templates.ts";
import type { HypothesisDraft, HypothesisGroupDraft, LiftGateStats, LiftInput, LiftLevel, RgView, TargetLink } from "./types.ts";

/** 每层要几个月份 */
export const LIFT_MIN_PERIODS: Readonly<Record<LiftLevel, number>> = { need: 2, value: 3 };
/** 支持背后至少几条证据（一两条的不出） */
export const LIFT_MIN_EVIDENCE = 3;
/**
 * 硬下限（256 号票）：证据少到只有一条时，往上抽没有意义——一条证据推"长期需求"就是编。
 * 两条以上先出结论、标成临时的（见 llm-lift.ts 的 provisional）：置信度由 scoring 的 confidenceCap
 * 按"证据薄、不跨时期、不跨场景"自动压到 low，跨度长起来以后重抽 + rescore 会自己升上去
 */
export const LIFT_MIN_EVIDENCE_HARD = 2;
/** 证据跨了多少天才说得上"长期"（价值层） */
export const VALUE_SPAN_DAYS = 180;
/** 说忙说累跨了多少天才算反复出现（负荷那一族） */
export const LOAD_SPAN_DAYS = 60;

/** 往上抽的一组的参数：SceneParams 加上层、主题、说法、各场景、前提断言、几个月 */
export interface LiftParams extends SceneParams {
  level: LiftLevel;
  theme: string;
  label: string;
  scenes: string[][];
  premiseIds: string[];
  periods: number;
}

type Family = "autonomy" | "load" | "interest" | "value";

interface LiftTemplate extends HypothesisTemplate {
  family: Family;
  /** 226 号票：这条解释要是成立，接下来两周应该看到什么（一句预测，进预测账本）；拼不出就留空 */
  predicts?(p: LiftParams): string;
}

// ---------- 小工具 ----------

const lp = (p: SceneParams) => p as LiftParams;
const pred = (f: FactInfo, ...ps: Predicate[]) => ps.includes(f.fact.predicate);
const pos = (f: FactInfo) => !f.fact.negated;
const dislikesIt = (f: FactInfo) => (pred(f, "dislikes") && pos(f)) || (pred(f, "prefers") && f.fact.negated);
const okWithIt = (f: FactInfo) => (pred(f, "prefers") && pos(f)) || (pred(f, "dislikes") && f.fact.negated);
const isActivity = (f: FactInfo, p: SceneParams) => f.fact.object.type === "entity" && p.activities.some((a) => a.id === (f.fact.object as { id: string }).id);
const activityKind = (f: FactInfo) => f.entity?.type === "activity" || f.entity?.type === "event";
const inWindow = (f: FactInfo, p: SceneParams, days = 14) => toMs(f.time) >= toMs(addDays(p.first, -days)) && toMs(f.time) <= toMs(addDays(p.last, days));
const when = (f: FactInfo) => f.time.slice(0, 10);
const names = (p: SceneParams) => p.activities.map((a) => a.name).join("、");
const sceneLabel = (scene: readonly string[]) => scene.map((t) => CONTEXT_LABELS[t] ?? t).join("、");
const scenesLabel = (p: SceneParams) => lp(p).scenes.map(sceneLabel).join("；");
const earliest = (fs: readonly FactInfo[]) => fs.reduce((a, b) => (toMs(a.time) <= toMs(b.time) ? a : b));
const latest = (fs: readonly FactInfo[]) => fs.reduce((a, b) => (toMs(a.time) >= toMs(b.time) ? a : b));

// ---------- 需求层：三族上位解释 ----------

const needTemplates: LiftTemplate[] = [
  // 回避被别人安排好的时间
  {
    id: "need_autonomy",
    family: "autonomy",
    pattern: "lift:need",
    tier: "need",
    applies: () => true,
    statement: (p) => `用户重视自主安排：在好几种场合（${scenesLabel(p)}）都不愿被别人安排好时间`,
    context: () => [],
    validity: (p) => ({ validFrom: p.first, validTo: null }),
    predicts: () => "接下来两周再遇到类似的安排，他还会想自己定时间",
    expectations: [
      { id: "says_likes_arranged", polarity: "refutes", weight: "decisive", match: (f) => f.stated && pred(f, "prefers") && pos(f) && isArrangement(f.name), why: (f) => `用户明说喜欢${f.name}` },
      { id: "says_dislikes_arranged", polarity: "supports", weight: "strong", match: (f) => f.stated && dislikesIt(f) && isArrangement(f.name), why: (f) => `用户明说不喜欢${f.name}（${sceneLabel(f.fact.context) || "不限场景"}）` },
      { id: "self_arranged", polarity: "supports", weight: "weak", match: (f) => pred(f, "initiated") && pos(f), why: (f) => `用户 ${when(f)} 自己张罗了${f.name}（自己安排的就去）` },
    ],
  },
  {
    id: "overall_load",
    family: "autonomy",
    pattern: "lift:need",
    tier: "state",
    applies: () => true,
    statement: (p) => `用户近期整体负荷高，哪里都不想再被多占时间（${p.first.slice(0, 10)} 到 ${p.last.slice(0, 10)}）`,
    context: () => [],
    validity: (p) => ({ validFrom: p.first, validTo: addDays(p.last, 14) }),
    predicts: () => "接下来两周他还会说忙、不想再被多占时间",
    expectations: [
      { id: "says_not_busy", polarity: "refutes", weight: "strong", match: (f, p) => pred(f, "said_about") && f.fact.negated && isStateTopic(f.name) && inWindow(f, p), why: (f) => `用户 ${when(f)} 说自己不${f.name}` },
      { id: "says_busy", polarity: "supports", weight: "strong", match: (f, p) => pred(f, "said_about") && pos(f) && isStateTopic(f.name) && inWindow(f, p), why: (f) => `用户 ${when(f)} 说自己${f.name}` },
      { id: "working_on", polarity: "supports", weight: "weak", match: (f, p) => pred(f, "works_on") && pos(f) && inWindow(f, p), why: (f) => `用户这段时间在忙${f.name}` },
      { id: "self_arranged", polarity: "refutes", weight: "weak", match: (f, p) => pred(f, "initiated") && pos(f) && inWindow(f, p), why: (f) => `用户 ${when(f)} 还有精力自己张罗${f.name}` },
    ],
    groupChecks: (p, observations) =>
      p.spanDays > 45 && observations.length > 0 ? [{ target: earliest(observations).fact.id, polarity: "refutes", weight: "strong", rationale: `这些分布在 ${p.spanDays} 天里，不像一阵子的负荷` }] : [],
  },
  {
    id: "no_interest",
    family: "autonomy",
    pattern: "lift:need",
    tier: "preference",
    applies: (p) => p.activities.length > 0,
    statement: (p) => `用户对这几类活动（${names(p)}）本身没兴趣，不是时间被安排的问题`,
    context: () => [],
    validity: (p) => ({ validFrom: p.first, validTo: null }),
    predicts: (p) => `接下来两周再约他${names(p)}，他还会推掉`,
    expectations: [
      { id: "says_dislike_it", polarity: "supports", weight: "strong", match: (f, p) => f.stated && dislikesIt(f) && isActivity(f, p), why: (f) => `用户说不喜欢${f.name}` },
      { id: "says_ok", polarity: "refutes", weight: "strong", match: (f) => f.stated && okWithIt(f) && activityKind(f) && !isArrangement(f.name) && !isRest(f.name), why: (f) => `用户明说${f.fact.negated ? "不反感" : "喜欢"}${f.name}` },
      { id: "went", polarity: "refutes", weight: "strong", match: (f, p) => pred(f, "participated_in", "initiated") && pos(f) && isActivity(f, p), why: (f) => `用户 ${when(f)} 去了${f.name}` },
      { id: "blames_arrangement", polarity: "refutes", weight: "weak", match: (f) => f.stated && dislikesIt(f) && isArrangement(f.name), why: (f) => `用户自己说问题在${f.name}，不在活动本身` },
    ],
  },
  // 反复说忙说累
  {
    id: "need_recovery",
    family: "load",
    pattern: "lift:need",
    tier: "need",
    applies: () => true,
    statement: (p) => `用户长期精力紧张，需要留出休息和恢复的时间（${scenesLabel(p)}都出现过）`,
    context: () => [],
    validity: (p) => ({ validFrom: p.first, validTo: null }),
    predicts: () => "接下来两周他还会想留出休息和恢复的时间",
    expectations: [
      { id: "says_relaxed", polarity: "refutes", weight: "strong", match: (f) => pred(f, "said_about") && f.fact.negated && isStateTopic(f.name), why: (f) => `用户 ${when(f)} 说自己不${f.name}` },
      { id: "wants_rest", polarity: "supports", weight: "weak", match: (f) => pred(f, "prefers") && pos(f) && isRest(f.name), why: (f) => `用户 ${when(f)} 说想${f.name}` },
    ],
    groupChecks: (p, observations) =>
      p.spanDays >= LOAD_SPAN_DAYS && observations.length > 0 ? [{ target: latest(observations).fact.id, polarity: "supports", weight: "strong", rationale: `跨了 ${p.spanDays} 天反复出现` }] : [],
  },
  {
    id: "episodic_busy",
    family: "load",
    pattern: "lift:need",
    tier: "state",
    applies: () => true,
    statement: () => "只是这几阵子各自的忙，过去就好，不是长期的需要",
    context: () => [],
    validity: (p) => ({ validFrom: p.first, validTo: addDays(p.last, 14) }),
    predicts: () => "接下来两周他还会说这阵子忙、累",
    expectations: [{ id: "says_relaxed", polarity: "supports", weight: "weak", match: (f) => pred(f, "said_about") && f.fact.negated && isStateTopic(f.name), why: (f) => `中间说过不${f.name}` }],
    groupChecks: (p, observations) => {
      if (observations.length === 0) return [];
      return p.spanDays >= LOAD_SPAN_DAYS
        ? [{ target: earliest(observations).fact.id, polarity: "refutes", weight: "weak", rationale: `跨了 ${p.spanDays} 天，不只是一阵子` }]
        : [{ target: latest(observations).fact.id, polarity: "supports", weight: "weak", rationale: `前后只有 ${p.spanDays} 天` }];
    },
  },
  // 不分场合都去某样活动
  {
    id: "stable_interest",
    family: "interest",
    pattern: "lift:need",
    tier: "need",
    applies: (p) => p.activities.length > 0,
    statement: (p) => `用户对${names(p)}有稳定的兴趣，不分场合都愿意投入`,
    context: () => [],
    validity: (p) => ({ validFrom: p.first, validTo: null }),
    predicts: (p) => `接下来两周有空时他还会主动去${names(p)}`,
    expectations: [
      { id: "says_dislike_it", polarity: "refutes", weight: "decisive", match: (f, p) => f.stated && dislikesIt(f) && isActivity(f, p), why: (f) => `用户明说不喜欢${f.name}` },
      { id: "initiated", polarity: "supports", weight: "strong", match: (f, p) => pred(f, "initiated") && pos(f) && isActivity(f, p), why: (f) => `用户 ${when(f)} 主动发起了${f.name}` },
      { id: "says_like_it", polarity: "supports", weight: "strong", match: (f, p) => f.stated && pred(f, "prefers") && pos(f) && isActivity(f, p), why: (f) => `用户说喜欢${f.name}` },
      { id: "declined", polarity: "refutes", weight: "weak", match: (f, p) => pred(f, "declined") && pos(f) && isActivity(f, p), why: (f) => `用户 ${when(f)} 推掉了${f.name}` },
    ],
  },
  {
    id: "situational",
    family: "interest",
    pattern: "lift:need",
    tier: "preference",
    applies: (p) => p.activities.length > 0,
    statement: (p) => `去${names(p)}是各个场合各自的原因（工作需要、别人带着），不是稳定的兴趣`,
    context: () => [],
    validity: (p) => ({ validFrom: p.first, validTo: null }),
    predicts: (p) => `接下来两周有人约${names(p)}，他还会看场合再定`,
    expectations: [
      { id: "initiated", polarity: "refutes", weight: "strong", match: (f, p) => pred(f, "initiated") && pos(f) && isActivity(f, p), why: (f) => `用户 ${when(f)} 主动发起了${f.name}，不是被带着去的` },
      { id: "declined", polarity: "supports", weight: "weak", match: (f, p) => pred(f, "declined") && pos(f) && isActivity(f, p), why: (f) => `用户 ${when(f)} 也有不去${f.name}的时候` },
      { id: "for_work", polarity: "supports", weight: "weak", match: (f, p) => pred(f, "participated_in") && pos(f) && isActivity(f, p) && f.fact.context.includes("work"), why: (f) => `${when(f)} 那次是工作场合` },
    ],
  },
];

// ---------- 价值层：长期看重 / 只是现阶段 ----------

const valueTemplates: LiftTemplate[] = [
  {
    id: "value_enduring",
    family: "value",
    pattern: "lift:value",
    tier: "value",
    applies: () => true,
    statement: (p) => `用户长期看重${lp(p).label}（长期价值取向）`,
    context: () => [],
    validity: (p) => ({ validFrom: p.first, validTo: null }),
    predicts: (p) => `接下来两周碰到${lp(p).label}的选择，他还会这么选`,
    expectations: [],
    groupChecks: (p, observations) =>
      p.spanDays >= VALUE_SPAN_DAYS && observations.length > 0 ? [{ target: earliest(observations).fact.id, polarity: "supports", weight: "strong", rationale: `证据跨了 ${p.spanDays} 天，不是一阵子的事` }] : [],
  },
  // 证据跨的时间不够长时两条都不动（还说不上长期，但"没看到长期的证据"不算反证）
  {
    id: "value_phase",
    family: "value",
    pattern: "lift:value",
    tier: "need",
    applies: () => true,
    statement: (p) => `${lp(p).label}是用户现阶段的需要，不一定是长期的价值取向`,
    context: () => [],
    validity: (p) => ({ validFrom: p.first, validTo: null }),
    predicts: (p) => `接下来两周${lp(p).label}还会是他的需要`,
    expectations: [],
    groupChecks: (p, observations) =>
      p.spanDays >= VALUE_SPAN_DAYS && observations.length > 0 ? [{ target: earliest(observations).fact.id, polarity: "refutes", weight: "strong", rationale: `证据跨了 ${p.spanDays} 天，不只是现阶段` }] : [],
  },
];

export const LIFT_TEMPLATES: readonly LiftTemplate[] = [...needTemplates, ...valueTemplates];

export const LIFT_PROBE_TEMPLATES: readonly ProbeTemplate[] = [
  {
    id: "lift_busy",
    pattern: "lift:need",
    pair: ["need_autonomy", "overall_load"],
    ifFound: "overall_load",
    ask: () => "这几个月里，有没有哪段时间工作或者家里的事特别多、特别累？",
    queries: () => ["加班", "忙不过来", "事情多", "赶工", "忙碌", "疲惫", "精力", "压力", "累死", "累坏"],
  },
  {
    id: "lift_own_terms",
    pattern: "lift:need",
    pair: ["need_autonomy", "no_interest"],
    ifFound: "need_autonomy",
    ask: () => "同样的活动，要是由你自己定时间、自己张罗，你会去吗？最近一次是什么？",
    queries: () => ["自己定", "主动约", "安排", "排满", "行程", "定好", "不反感"],
  },
  {
    id: "lift_never_liked",
    pattern: "lift:need",
    pair: ["no_interest", "overall_load"],
    ifFound: "no_interest",
    ask: (p) => `${names(p)}里，有你一直都不爱去的吗？`,
    queries: (p) => [...p.activities.map((a) => a.name), "不喜欢", "没兴趣"],
  },
  {
    id: "lift_relaxed",
    pattern: "lift:need",
    pair: ["need_recovery", "episodic_busy"],
    ifFound: "episodic_busy",
    ask: () => "忙过一阵以后，有没有轻松下来、不觉得累的时候？",
    queries: () => ["不忙", "轻松", "闲下来", "不累", "清闲"],
  },
  {
    id: "lift_self_driven",
    pattern: "lift:need",
    pair: ["stable_interest", "situational"],
    ifFound: "stable_interest",
    ask: (p) => `不是工作要求、也没人带的时候，你会自己去${names(p)}吗？`,
    queries: (p) => [...p.activities.map((a) => a.name), "自己去", "主动"],
  },
  {
    id: "lift_long_ago",
    pattern: "lift:value",
    pair: ["value_enduring", "value_phase"],
    ifFound: "value_enduring",
    ask: () => "很早以前（比如一两年前）你也是这样吗？",
    queries: () => ["以前", "一直", "向来", "从小"],
  },
];

/** 规则版全部的假设模板（下层观察模式的 + 往上抽的） */
export function ruleTemplateById(id: string): HypothesisTemplate | undefined {
  return HYPOTHESIS_TEMPLATES.find((t) => t.id === id) ?? LIFT_TEMPLATES.find((t) => t.id === id);
}

/** 规则版全部的追问模板 */
export function ruleProbeTemplates(): readonly ProbeTemplate[] {
  return [...PROBE_TEMPLATES, ...LIFT_PROBE_TEMPLATES];
}

// ---------- 认主题、看条件、出草稿 ----------

/** 一条输入属于哪些主题 */
export function themesOf(input: LiftInput, view: RgView): string[] {
  switch (input.template) {
    case "scene_autonomy":
    case "need_autonomy":
      return ["autonomy"];
    case "recent_state":
    case "need_recovery":
      return ["load"];
    case "likes_content":
      return input.activities.map((a) => `interest:${a.id}`);
    case "stable_interest":
      return input.groupKey ? [input.groupKey.slice(input.groupKey.indexOf("|") + 1)] : [];
    case null:
      break;
    default:
      return [];
  }
  const fact = input.fact;
  if (!fact) return [];
  const f = factInfo(fact, view);
  if (dislikesIt(f) && isArrangement(f.name)) return ["autonomy"];
  if (pred(f, "said_about") && pos(f) && isStateTopic(f.name)) return ["load"];
  if (pred(f, "prefers") && pos(f) && activityKind(f) && !isRest(f.name) && !isArrangement(f.name) && fact.object.type === "entity") return [`interest:${fact.object.id}`];
  return [];
}

function labelOf(theme: string, activities: readonly { name: string }[]): string {
  if (theme === "autonomy") return "自主安排自己的时间";
  if (theme === "load") return "留出休息和恢复的时间";
  return `在${activities.map((a) => a.name).join("、")}上的投入`;
}

/** 两组标签一样（不管顺序、重复） */
const sameTags = (a: readonly string[], b: readonly string[]): boolean => {
  const left = new Set(a);
  return left.size === new Set(b).size && [...left].every((t) => b.includes(t));
};

/**
 * 两组场景是不是两种不同的场合（229 号票收窄只看"方面（domain）"维度）：
 * - 两边都有方面标签、且集合不同 → 算两种（「家里、休闲」和「家里、工作」共享「家里」，也算两种）；
 * - 只差日型（周末/工作日/假期）、只差出行（出差/休假）不算两种；
 * - 两边都没有方面标签、但都有不认得的标签、且集合不同 → 算两种（沿用 223 号票对不认得标签的处理）；
 * - 两边一样、有一边不限场景（没写标签）、或者被包含合并后只剩一组，都不算。
 */
export function scenesDiffer(a: readonly string[], b: readonly string[]): boolean {
  const domain = CONTEXT_DIMENSIONS.domain!;
  const left = a.filter((t) => domain.includes(t));
  const right = b.filter((t) => domain.includes(t));
  if (left.length > 0 && right.length > 0) return !sameTags(left, right);
  const unknownLeft = a.filter((t) => !isKnownContextTag(t));
  const unknownRight = b.filter((t) => !isKnownContextTag(t));
  return unknownLeft.length > 0 && unknownRight.length > 0 && !sameTags(unknownLeft, unknownRight);
}

/** 有没有两种不同的场合（229 号票起按 scenesDiffer 只看方面维度判，门槛用这个；不限场景的和谁都一样，不算） */
export function hasDisjointScenes(scenes: readonly (readonly string[])[]): boolean {
  for (let i = 0; i < scenes.length; i++) for (let j = i + 1; j < scenes.length; j++) if (scenesDiffer(scenes[i]!, scenes[j]!)) return true;
  return false;
}

/** 老口径（223 号票起只用来统计，不卡门槛）：所有双方都写了标签的维度上都无交集才算两种 */
export function hasDisjointScenesStrict(scenes: readonly (readonly string[])[]): boolean {
  for (let i = 0; i < scenes.length; i++) for (let j = i + 1; j < scenes.length; j++) if (!contextsCompatible(scenes[i]!, scenes[j]!)) return true;
  return false;
}

/** 记一组过了门槛（223 号票）：总共几组，另按老严格判定分两桶（passed = passedStrict + passedLoose） */
export function countLiftGatePass(gate: LiftGateStats | undefined, scenes: readonly (readonly string[])[]): void {
  if (!gate) return;
  gate.passed += 1;
  if (hasDisjointScenesStrict(scenes)) gate.passedStrict += 1;
  else gate.passedLoose += 1;
}

/** 这一层能出哪些组：按主题归拢输入，够条件的出一组上位解释（gate 给了就记过了门槛的统计，223 号票） */
export function liftGroups(level: LiftLevel, inputs: readonly LiftInput[], view: RgView, gate?: LiftGateStats): HypothesisGroupDraft[] {
  const byTheme = new Map<string, LiftInput[]>();
  for (const input of inputs) for (const theme of themesOf(input, view)) byTheme.set(theme, [...(byTheme.get(theme) ?? []), input]);
  const out: HypothesisGroupDraft[] = [];
  for (const [theme, premises] of byTheme) {
    const sceneKeys = new Map<string, string[]>();
    for (const s of premises.flatMap((p) => p.scenes)) if (s.length > 0) sceneKeys.set(s.toSorted().join("+"), s);
    // 被别的场景包含的不单列（"周末"在"周末、社交场合"里）
    const scenes = [...sceneKeys.values()].filter((s, _, all) => !all.some((t) => t !== s && t.length > s.length && s.every((tag) => t.includes(tag))));
    if (!hasDisjointScenes(scenes)) continue;
    const evidenceIds = [...new Set(premises.flatMap((p) => p.supportEvidenceIds))];
    if (evidenceIds.length < LIFT_MIN_EVIDENCE) continue;
    const times = evidenceIds
      .map((id) => view.evidence(id))
      .filter((e) => e !== undefined)
      .map((e) => e.eventTime ?? e.observedAt)
      .toSorted((a, b) => toMs(a) - toMs(b));
    const months = new Set(times.map((t) => localDate(t).slice(0, 7)));
    if (months.size < LIFT_MIN_PERIODS[level] || times.length === 0) continue;
    const activityMap = new Map<string, { id: string; name: string }>();
    for (const a of premises.flatMap((p) => p.activities)) activityMap.set(a.id, a);
    const activities = theme.startsWith("interest:") ? [...activityMap.values()].filter((a) => a.id === theme.slice("interest:".length)) : [...activityMap.values()];
    const first = times[0]!;
    const last = times.at(-1)!;
    const params: LiftParams = {
      daytype: null,
      domain: null,
      activities,
      first,
      last,
      spanDays: Math.round((toMs(last) - toMs(first)) / 86_400_000),
      count: premises.length,
      workTagged: false,
      level,
      theme,
      label: labelOf(theme, activities),
      scenes,
      premiseIds: premises.map((p) => p.claim.id),
      periods: months.size,
    };
    const family: Family = level === "value" ? "value" : theme.startsWith("interest:") ? "interest" : (theme as Family);
    const templates = LIFT_TEMPLATES.filter((t) => t.family === family && t.pattern === `lift:${level}` && t.applies(params));
    if (templates.length < 2) continue;

    // 下层断言的支持是观察（对每条都是弱支持），反证只按预期配
    const observedBy = new Map<string, LiftInput>();
    for (const p of premises) for (const f of p.supports) if (!observedBy.has(f.id) && view.usableFact(f)) observedBy.set(f.id, p);
    const candidates = new Map<string, Fact>();
    for (const p of premises) for (const f of [...p.supports, ...p.refutes]) if (view.usableFact(f)) candidates.set(f.id, f);
    const observations = [...observedBy.keys()].map((id) => factInfo(candidates.get(id)!, view));
    const hypotheses: HypothesisDraft[] = templates.map((t) => {
      const links: TargetLink[] = [];
      for (const fact of candidates.values()) {
        const link = assessFact(t, params, factInfo(fact, view));
        if (link) links.push(link);
        else if (observedBy.has(fact.id)) links.push({ target: fact.id, polarity: "supports", weight: "weak", rationale: `观察（${observedBy.get(fact.id)!.claim.statement}）：${fact.statement}` });
      }
      // 组级别的检查和同一个目标的观察合并：同一条只留更重的那条
      for (const g of t.groupChecks?.(params, observations) ?? []) {
        const i = links.findIndex((l) => l.target === g.target && l.polarity === g.polarity);
        if (i >= 0) links[i] = g;
        else links.push(g);
      }
      return { template: t.id, tier: t.tier, statement: t.statement(params), context: t.context(params), ...t.validity(params), method: "induction", predicts: t.predicts?.(params), links };
    });
    countLiftGatePass(gate, scenes);
    out.push({
      key: `lift:${level}|${theme}`,
      pattern: `lift:${level}`,
      params: params as unknown as Record<string, unknown>,
      description: `${params.label}：在 ${scenes.length} 种场景（${scenes.map(sceneLabel).join("；")}）、${months.size} 个月里都成立（${premises.length} 条断言）`,
      observationIds: params.premiseIds,
      hypotheses,
    });
  }
  return out;
}
