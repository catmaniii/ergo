// 了解你问题从哪来（198 号票，架构文档第 7.6 节）：每日整理时从推理图谱里找"还拿不准、问一句就能分清"的地方，出问题的草稿。
// 来源：追问检索以后还分不清的竞争假设，另外照调研 11 的六个来源（规则版，都是通用的规矩，不看哪条数据）：
// - unresolved（竞争假设分不清）：一组里某条判别性追问已经检索过了，它要区分的两条还都活着、谁也没以至少 medium 成立 → 用追问的问法；
// - contradiction（矛盾）：事实这一层真冲突、两条都还 contested → 问"现在更接近后一种吗"（334 号票起前后两句意思相反、
//   后说的没自己说变了的也落到这里：问法带上两句各是哪天说的）；
// - low_confidence_high_value（低置信但高价值）：一条假设算成立、把握却还低，又影响常做的决定 → 用能支持它的那条追问来确认；
// - tension（张力：说的和做的不一样）：用户说过喜欢（不喜欢）某样活动，后来又推掉（去了）它 → 问下次还想不想去；
// - normative（规范性判断）：推断的断言里带"太忙、应该、有害"这类评判 → 评判不能说出口，只能问"要不要我帮你……"；
// - prediction_violation（预测落空）：一条假设成立以后，又来了和它对不上的本人记录 → 问以后还会不会这样，不静默改写；
// - out_of_character（反常输入）：用户没头没尾地说了和以前相反的话（事实层已经按观点变化接上了）→ 先问一句再当真。
//   334 号票起没说变了的相反说法事实层当矛盾、不再接上，新数据走上面的"矛盾"；这里只剩老库里以前按日子先后接上的。
// 330 号票（R10）：演绎预测落空、判不出是哪条前提错了（没验证的不止一条，Duhem-Quine），或者前提都已验证（只能是漏了条件或反证有误）
// → 每条嫌疑一个问题（也记成 prediction_violation）："这一条现在还对吗"——还对：嫌疑落到别的上；不对了：就是它错了，撤回。
// 每个草稿写明：问法（中性、问具体的事、不问动机）、为什么问、区分哪几个假设、什么回答支持哪边（AnswerEffect）、领域和场景（拿来和对话对上）、
// 优先级里的几项。措辞过不了 leadingPhrases 的不出（任务书第 12 节：不通过诱导、隐蔽影响来验证假设）。
// 去重、"别问这个"、冷却、过期在 questions.ts（QuestionBook.refresh）。
//
// 207 号票：
// - 优先级的主项改成"回答能不能直接分出胜负"（answerSeparation：要弄清的几条假设对这个回答的预期差得多不多），
//   再乘上分数接近的程度、近 30 天这类事出现得多不多（还没问过、跳过一次减半照旧）。198 的"范围""回答的分量"不再单独乘：
//   只能记弱的那种回答在"分得出胜负"里打对折。
// - 334b（用户 10-27）：同一处矛盾只留一个问题——矛盾根源组的两边正是"矛盾"那一路要问的一对（事实层还拿不准）时，根源的追问不另出问题。
// - 199 的对比模式、矛盾根源（知识图谱联动的组）也从这里出问题：分不出（组里没有一条成立）时，每条能区分的追问一个问题，
//   问法、回答各支持哪边由 rg/joint.ts 的 questionFor 给（"会去 / 不会去"能回答的具体的事）；分出来了就不出。
//   reflect 里联动经 QuestionSink 交给问题箱（questions.ts），每日整理照样从这里出、按 key 对上。
import { USER_ENTITY_ID } from "../domain/ids.ts";
import { addDays, localDate, sameLocalDay, toMs } from "../domain/time.ts";
import type { Claim, Confidence, Fact, LinkWeight } from "../domain/types.ts";
import { CONTEXT_DIMENSIONS, contextsCompatible } from "../kg/context.ts";
import { changeSignals, correctionSignals } from "../kg/signals.ts";
import { factPhrase } from "../kg/statement.ts";
import { HELD_STATUSES } from "../store/store.ts";
import { contextPhrase, STATE_TOPICS } from "./concepts.ts";
import { claimDomains, domainsOfTags, domainsOfText, sortDomains } from "./domains.ts";
import { isJointGroup, isRootGroup } from "./joint.ts";
import type { ReasoningGraph } from "./reasoning-graph.ts";
import { LEAD_DB, tally } from "./scoring.ts";
import type { GroupRecord } from "./registry.ts";
import type { RgView } from "./types.ts";
import { basisQuestionDue, strategyText } from "./strategies.ts";
import { relayedEligible, relayedGuessOf, selfCounterparts } from "./relayed.ts";

export const QUESTION_SOURCES = ["unresolved", "contradiction", "low_confidence_high_value", "tension", "normative", "prediction_violation", "out_of_character", "strategy_basis", "relayed", "counterexample"] as const;
export type QuestionSource = (typeof QUESTION_SOURCES)[number];

export const QUESTION_SOURCE_LABELS: Readonly<Record<QuestionSource, string>> = {
  unresolved: "竞争假设分不清",
  contradiction: "矛盾",
  low_confidence_high_value: "低置信但高价值",
  tension: "张力（说的和做的不一样）",
  normative: "规范性判断",
  prediction_violation: "预测落空",
  out_of_character: "反常输入",
  strategy_basis: "做法的理由没了",
  relayed: "别人转述的",
  counterexample: "已验证的碰上反例",
};

/** 一种回答说明什么：支持哪几条、反驳哪几条（断言 id），最多记多重；回答得很明确时事实这一层怎么改 */
export interface AnswerEffect {
  supports: string[];
  refutes: string[];
  /** 这种回答最多记多重：一般 decisive（回答得很明确时）；规范性判断的问题只记 weak（愿意少排一些不等于就是太累） */
  maxWeight: LinkWeight;
  /** 一句话：这样回答说明什么 */
  note: string;
  /** 回答得很明确时事实这一层的改动（矛盾、张力、反常）：定下来的事实、到期的事实、当成被纠正的证据 */
  facts?: { activate?: string[]; supersede?: string[]; correctEvidence?: string[] };
  /** 330 号票（R6）：回答得很明确时交互策略怎么办——keep 还要（记成重新确认）、retract 不要了（撤回） */
  strategies?: { keep?: string[]; retract?: string[] };
}

export interface QuestionAnswers {
  yes: AnswerEffect;
  no: AnswerEffect;
}

/** 问题要弄清的对象：断言（推断的、明说的）或事实（矛盾时没有明说的断言）；330 号票：或者一条交互策略（做法的理由没了，还要不要） */
export interface QuestionTarget {
  id: string;
  kind: "claim" | "fact" | "strategy";
  statement: string;
}

/** 优先级的几项（207 号票）：优先级 = 回答能不能分出胜负 × 分数接近的程度 × 常不常遇到 × 还没问过 */
export interface PriorityDetail {
  /**
   * 回答能不能直接分出胜负（answerSeparation）：要弄清的几条假设对"是""不是"两种回答的预期差得多不多，两种回答取平均。
   * 一边支持、一边反驳是 1；只动一边是 0.5；只有一条的（和"它不对"比）支持或反驳它是 1；只能记弱的打对折
   */
  separation: number;
  /** 几个假设分数有多接近（分数差 0 是 1，差 6 分贝是 0.5）；单条的按把握（low 1、medium 0.6、high 0.3） */
  closeness: number;
  /** 这方面的事常不常遇到：近 30 天本人记录里落在这几个领域的占比，0.5 + 0.5 × 占比 */
  frequency: number;
  /** 还没问过：1；跳过一次减半 */
  fresh: number;
}

export interface QuestionDraft {
  /** 去重用：同一个 key 是同一个问题 */
  key: string;
  /** "别问这个"挡住的那一类：同一组假设（组的 key）、同一样东西（object:<实体>）、同一条断言（claim:<id>） */
  topic: string;
  kind: QuestionSource;
  sources: QuestionSource[];
  text: string;
  why: string;
  targets: QuestionTarget[];
  answers: QuestionAnswers;
  domains: string[];
  scenes: string[];
  /** 和对话对上时另看的说法（追问的检索短语、活动名、近期状态的词） */
  terms: string[];
  probeId: string | null;
  /** 跟着假设一起过期：目标里近期状态的到期时间（最早的那个）；没有是 null */
  validUntil: string | null;
  separation: number;
  closeness: number;
  frequency: number;
}

export interface DroppedQuestion {
  key: string;
  reason: string;
  text?: string;
}

export interface GenerateResult {
  drafts: QuestionDraft[];
  dropped: DroppedQuestion[];
}

// ---------- 措辞 ----------

/** 诱导、问动机、带评判的说法（问题里出现就不出这个问题） */
const LEADING: readonly (readonly [RegExp, string])[] = [
  [/因为你.{0,24}所以/, "诱导：因为你……所以"],
  [/是不是因为/, "诱导：你是不是因为"],
  [/是因为.{0,16}吗/, "诱导：是因为……吗"],
  [/为什么|为啥|怎么会|干嘛不/, "问动机：为什么"],
  [/难道/, "诱导：难道"],
  [/不觉得/, "诱导：你不觉得"],
  [/其实你/, "诱导：其实你"],
  [/说明你/, "诱导：说明你"],
  [/你(?:不)?应该|你该/, "评判：你应该"],
  [/(?:对吧|是吧|对不对)[？?。]?$/, "诱导：……对吧"],
  [/肯定是/, "诱导：肯定是"],
  [/太(?:忙|累)了|有害|不健康|不快乐/, "评判：带评判的说法"],
];

/** 问题措辞里的诱导、问动机、带评判的说法（命中的说明）；空数组 = 过关 */
export function leadingPhrases(text: string): string[] {
  return LEADING.filter(([re]) => re.test(text)).map(([, why]) => why);
}

/** 断言陈述里的评判词（规范性判断：只能以问题出现） */
export const NORMATIVE_WORDS: readonly string[] = ["太忙", "太累", "应该", "不该", "有害", "不健康", "不快乐", "过度", "沉迷", "压力太大", "影响了"];

// ---------- 规则版追问的回答怎么读 ----------

/** 规则版追问模板：回答"是""不是"各支持、反驳哪几个模板（templates.ts、lift.ts 的追问模板；问法见那里） */
const PROBE_ANSWERS: Readonly<Record<string, { yes: { supports: string[]; refutes: string[] }; no: { supports: string[]; refutes: string[] } }>> = {
  // 周末以外的时候，你会去参加或者自己约社交的活动吗？
  elsewhere_social: { yes: { supports: ["scene_autonomy"], refutes: ["dislike_domain"] }, no: { supports: ["dislike_domain"], refutes: [] } },
  // 上次推掉的周末活动，要是时间由你自己定，你会去吗？
  own_schedule: { yes: { supports: ["scene_autonomy"], refutes: ["dislike_content"] }, no: { supports: ["dislike_content"], refutes: ["scene_autonomy"] } },
  // 这阵子工作或者身体上是不是特别忙、特别累？
  busy_lately: { yes: { supports: ["recent_state"], refutes: [] }, no: { supports: [], refutes: ["recent_state"] } },
  // 以前社交的活动里，有你自己挺想去的吗？
  liked_before: { yes: { supports: ["dislike_content"], refutes: ["dislike_domain"] }, no: { supports: ["dislike_domain"], refutes: [] } },
  // 除了这几样，这方面别的活动你也会去吗？
  other_kinds: { yes: { supports: ["likes_domain"], refutes: [] }, no: { supports: ["likes_content"], refutes: ["likes_domain"] } },
  // 不是工作安排的时候，你也会去吗？
  off_duty: { yes: { supports: ["likes_content"], refutes: ["obligation"] }, no: { supports: ["obligation"], refutes: [] } },
  // 是公司或者领导要求的吗？
  required: { yes: { supports: ["obligation"], refutes: [] }, no: { supports: [], refutes: ["obligation"] } },
  // 这几个月里，有没有哪段时间特别多事、特别累？
  lift_busy: { yes: { supports: ["overall_load"], refutes: [] }, no: { supports: [], refutes: ["overall_load"] } },
  // 同样的活动，要是由你自己定时间、自己张罗，你会去吗？
  lift_own_terms: { yes: { supports: ["need_autonomy"], refutes: ["no_interest"] }, no: { supports: ["no_interest"], refutes: ["need_autonomy"] } },
  // 这几样里，有你一直都不爱去的吗？
  lift_never_liked: { yes: { supports: ["no_interest"], refutes: [] }, no: { supports: [], refutes: ["no_interest"] } },
  // 忙过一阵以后，有没有轻松下来、不觉得累的时候？
  lift_relaxed: { yes: { supports: ["episodic_busy"], refutes: ["need_recovery"] }, no: { supports: ["need_recovery"], refutes: ["episodic_busy"] } },
  // 不是工作要求、也没人带的时候，你会自己去吗？
  lift_self_driven: { yes: { supports: ["stable_interest"], refutes: ["situational"] }, no: { supports: ["situational"], refutes: ["stable_interest"] } },
  // 很早以前你也是这样吗？
  lift_long_ago: { yes: { supports: ["value_enduring"], refutes: ["value_phase"] }, no: { supports: ["value_phase"], refutes: ["value_enduring"] } },
};

// ---------- 回答能不能分出胜负（207 号票） ----------

/** 一种回答对一条目标的预期：支持（或事实这一层定下来）+1，反驳（或到期）−1，不涉及 0 */
function expectationOf(effect: AnswerEffect, id: string): number {
  if (effect.supports.includes(id) || (effect.facts?.activate ?? []).includes(id) || (effect.strategies?.keep ?? []).includes(id)) return 1;
  if (effect.refutes.includes(id) || (effect.facts?.supersede ?? []).includes(id) || (effect.strategies?.retract ?? []).includes(id)) return -1;
  return 0;
}

/**
 * 回答能不能直接分出胜负：要弄清的几条假设对这个回答的预期差得多不多（两种回答取平均）。
 * 两条以上的：(最大的预期 − 最小的预期) / 2——一边支持、一边反驳是 1，只动一边是 0.5，都不动是 0；
 * 只有一条的，另一边是"它不对"（预期正好相反）：支持或反驳它就是 1。最多只能记弱的（规范性判断）打对折。
 */
export function answerSeparation(answers: QuestionAnswers, targetIds: readonly string[]): number {
  const one = (effect: AnswerEffect): number => {
    const e = targetIds.map((id) => expectationOf(effect, id));
    const spread = e.length <= 1 ? Math.abs(e[0] ?? 0) : (Math.max(...e) - Math.min(...e)) / 2;
    return spread * (effect.maxWeight === "weak" ? 0.5 : 1);
  };
  return round3((one(answers.yes) + one(answers.no)) / 2);
}

// ---------- 小工具 ----------

const ACTIVE_HELD = new Set<string>(HELD_STATUSES);
/** 新的观察要在这么多天以内（张力、预测落空、反常输入只看新的） */
const RECENT_DAYS = 30;
/** 低置信但高价值：影响面（范围 × 常不常遇到）至少这么多才算高价值 */
export const HIGH_VALUE_MIN = 0.5;

const alive = (c: Claim) => c.status === "active" || c.status === "contested";
const firm = (c: Claim) => c.status === "active" && c.confidence !== "low";
const gone = (c: Claim) => c.status === "retracted" || c.status === "superseded";
const factTime = (f: Fact) => f.eventTime ?? f.validFrom ?? f.observedAt;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const short = (s: string, n = 24) => (s.length > n ? `${s.slice(0, n)}…` : s);
const ref = (c: { id: string; statement: string }) => `${c.id}「${short(c.statement)}」`;

const STATUS_LABEL: Readonly<Record<string, string>> = { active: "成立", contested: "还拿不准", retracted: "已撤回", superseded: "已被取代" };
export const claimStatusLabel = (s: string): string => STATUS_LABEL[s] ?? s;

/** 月 日（"10 月 17 日"） */
/** 330 号票：结论陈述是第三人称（"用户……"），问用户时换成"你……" */
function youOf(statement: string): string {
  return statement.replace(/^用户/, "你");
}

function monthDay(iso: string): string {
  const [, m, d] = localDate(iso).split("-");
  return `${Number(m)} 月 ${Number(d)} 日`;
}

/** 场景限了几个维度（周末、社交……各算一个；不认得的标签合起来算一个） */
function restrictedDims(context: readonly string[]): number {
  const known = Object.values(CONTEXT_DIMENSIONS);
  const dims = known.filter((tags) => context.some((t) => tags.includes(t))).length;
  const other = context.some((t) => !known.some((tags) => tags.includes(t))) ? 1 : 0;
  return dims + other;
}

/** 影响多大范围的决定：不限场景的是 1，每限一个维度打一折。207 号票起不进优先级，只用来判"低置信但高价值"的"高价值" */
const breadthOf = (context: readonly string[]): number => round3(1 / (1 + 0.5 * restrictedDims(context)));

const CONFIDENCE_CLOSENESS: Readonly<Record<Confidence, number>> = { low: 1, medium: 0.6, high: 0.3 };
const FIXED_CLOSENESS: Partial<Record<QuestionSource, number>> = { contradiction: 1, out_of_character: 0.8, tension: 0.6, prediction_violation: 0.6, relayed: 0.8, counterexample: 0.8 };

/** 对用户说的事实（"喜欢爬山""推掉了徒步"）：比精炼陈述口语一点，不带"用户" */
function userPhrase(f: Fact, name: string): string {
  switch (f.predicate) {
    case "prefers":
      return f.negated ? `不想要${name}` : `喜欢${name}`;
    case "dislikes":
      return f.negated ? `不反感${name}` : `不喜欢${name}`;
    case "declined":
      return `推掉了${name}`;
    default:
      return factPhrase(f.predicate, f.negated, name);
  }
}

const likes = (f: Fact) => (f.predicate === "prefers" && !f.negated) || (f.predicate === "dislikes" && f.negated);
const dislikes = (f: Fact) => (f.predicate === "dislikes" && !f.negated) || (f.predicate === "prefers" && f.negated);

// ---------- 生成 ----------

interface RawDraft {
  key: string;
  topic: string;
  kind: QuestionSource;
  sources: QuestionSource[];
  text: string;
  why: string;
  targets: QuestionTarget[];
  answers: QuestionAnswers;
  probeId: string | null;
  /** 不按断言算领域、场景时另给的（事实的场景、宾语名字） */
  extraDomains: string[];
  scenes: string[];
  terms: string[];
  closeness: number;
  /** 给了就用它（联动的组：问的是以前的矛盾，不跟着假设里近期状态的到期时间走）；不给按目标里的近期状态算 */
  validUntil?: string | null;
}

/**
 * 从推理图谱现在的样子出了解你问题的草稿（按"现在" at 算）。只读，不写库。
 * 同一个 key 的合并来源；措辞过不了检查的、回答什么都改变不了的丢掉，写明原因。
 */
export function generateQuestions(rg: ReasoningGraph, at: string, options: GenerateOptions = {}): GenerateResult {
  const gen = new Generator(rg, at, options);
  return gen.run();
}

export interface GenerateOptions {
  /** 只出这几组的（竞争假设分不清那一路；别的来源不跑）。199 的联动在 reflect 里用它给自己的组出问题 */
  groups?: readonly string[];
}

class Generator {
  private readonly rg: ReasoningGraph;
  private readonly at: string;
  private readonly view: RgView;
  private readonly raw: RawDraft[] = [];
  private readonly dropped: DroppedQuestion[] = [];
  private readonly recentEvidence: { domains: Set<string> }[];
  private readonly groups: ReadonlySet<string> | undefined;
  /** 334b：事实这一层还拿不准的矛盾对（算一次） */
  private pairs: [Fact, Fact][] | undefined;

  constructor(rg: ReasoningGraph, at: string, options: GenerateOptions = {}) {
    this.rg = rg;
    this.at = at;
    this.groups = options.groups ? new Set(options.groups) : undefined;
    this.view = rg.view(at);
    const from = toMs(addDays(at, -RECENT_DAYS));
    this.recentEvidence = rg.store
      .listEvidence({ status: "active", sourceLevel: "self" })
      .filter((e) => toMs(e.observedAt) > from && toMs(e.observedAt) <= toMs(at))
      .map((e) => ({ domains: new Set<string>([...domainsOfTags(e.context), ...domainsOfText(e.text)]) }));
  }

  private get store() {
    return this.rg.store;
  }

  run(): GenerateResult {
    this.fromProbes();
    if (!this.groups) {
      this.fromContradictions();
      this.fromTensions();
      this.fromNormative();
      this.fromPredictions();
      this.fromFalsified();
      this.fromStrategies();
      this.fromRelayed();
      this.fromCounterexamples();
      this.fromVerifiedConflicts();
      this.fromOutOfCharacter();
    }
    const merged = new Map<string, RawDraft>();
    for (const d of this.raw) {
      const prev = merged.get(d.key);
      if (prev) {
        for (const s of d.sources) if (!prev.sources.includes(s)) prev.sources.push(s);
        continue;
      }
      merged.set(d.key, d);
    }
    const drafts: QuestionDraft[] = [];
    for (const d of merged.values()) {
      const hits = leadingPhrases(d.text);
      if (hits.length > 0) {
        this.dropped.push({ key: d.key, reason: `措辞不过关（${hits.join("；")}）`, text: d.text });
        continue;
      }
      const effects = [d.answers.yes, d.answers.no];
      if (effects.every((e) => e.supports.length === 0 && e.refutes.length === 0 && !e.facts && !e.strategies)) {
        this.dropped.push({ key: d.key, reason: "怎么回答都改变不了要弄清的假设", text: d.text });
        continue;
      }
      drafts.push(this.finish(d));
    }
    return { drafts, dropped: this.dropped };
  }

  private finish(d: RawDraft): QuestionDraft {
    const claims = d.targets.filter((t) => t.kind === "claim").map((t) => this.store.getClaim(t.id)!);
    const domains = sortDomains([...claims.flatMap((c) => claimDomains(this.store, c)), ...d.extraDomains]);
    const inDomains = this.recentEvidence.filter((e) => domains.some((x) => e.domains.has(x))).length;
    const frequency = round3(0.5 + 0.5 * (this.recentEvidence.length === 0 ? 0 : inDomains / this.recentEvidence.length));
    const separation = answerSeparation(d.answers, d.targets.map((t) => t.id));
    const states = claims.filter((c) => c.tier === "state" && c.validTo !== null).map((c) => c.validTo!);
    const validUntil = d.validUntil !== undefined ? d.validUntil : states.length === 0 ? null : states.reduce((a, b) => (toMs(a) <= toMs(b) ? a : b));
    const stateTerms = claims.some((c) => c.tier === "state") ? STATE_TOPICS.filter((w) => claims.some((c) => c.statement.includes(w))) : [];
    return {
      key: d.key,
      topic: d.topic,
      kind: d.kind,
      sources: d.sources,
      text: d.text,
      why: d.why,
      targets: d.targets,
      answers: d.answers,
      domains,
      scenes: [...new Set(d.scenes)],
      terms: [...new Set([...d.terms.filter((t) => t.length >= 2), ...stateTerms])],
      probeId: d.probeId,
      validUntil,
      separation,
      closeness: round3(d.closeness),
      frequency,
    };
  }

  private claimTarget(c: Claim): QuestionTarget {
    return { id: c.id, kind: "claim", statement: c.statement };
  }

  private net(c: Claim): number {
    return tally(c.id, this.store.linksOf(c.id), this.view).net;
  }

  private topicOfClaim(c: Claim): string {
    return this.rg.registry.memberOf(c.id)?.groupKey ?? `claim:${c.id}`;
  }

  /** 断言的场景，加上它那组观察所在的那类日子（问题出自哪个场景的观察，就在那个场景的对话里问） */
  private scenesOfClaim(c: Claim): string[] {
    const key = this.rg.registry.memberOf(c.id)?.groupKey;
    const daytype = key ? (this.rg.registry.getGroup(key)?.params as { daytype?: unknown } | undefined)?.daytype : undefined;
    return [...c.context, ...(typeof daytype === "string" ? [daytype] : [])];
  }

  private entityName(f: Fact): string {
    return f.object.type === "entity" ? this.view.entityName(f.object.id) : f.object.value;
  }

  private objectTopic(f: Fact): string {
    return `object:${f.object.type === "entity" ? f.object.id : f.object.value}`;
  }

  private note(supports: readonly string[], refutes: readonly string[]): string {
    const parts: string[] = [];
    const show = (id: string) => {
      const c = this.store.getClaim(id);
      return c ? ref(c) : id;
    };
    if (supports.length > 0) parts.push(`更支持 ${supports.map(show).join("、")}`);
    if (refutes.length > 0) parts.push(`${refutes.map(show).join("、")} 站不住`);
    return parts.length > 0 ? parts.join("；") : "不判输赢";
  }

  private effect(supports: string[], refutes: string[], maxWeight: LinkWeight = "decisive", facts?: AnswerEffect["facts"]): AnswerEffect {
    const ok = (id: string) => {
      const c = this.store.getClaim(id);
      return c !== undefined && !gone(c);
    };
    const s = [...new Set(supports.filter(ok))];
    const r = [...new Set(refutes.filter(ok))];
    return { supports: s, refutes: r, maxWeight, note: this.note(s, r), ...(facts ? { facts } : {}) };
  }

  private answerNotes(answers: QuestionAnswers): string {
    return `回答"是"：${answers.yes.note}；回答"不是"：${answers.no.note}。`;
  }

  // ---------- 竞争假设分不清、低置信但高价值 ----------

  private fromProbes(): void {
    const registry = this.rg.registry;
    for (const g of registry.listGroups({ live: true })) {
      if (this.groups && !this.groups.has(g.key)) continue;
      // 199 的联动出的组：分不出（组里没有一条成立）才问，问法、判法由 joint.questionFor 给
      const joint = isJointGroup(g) ? this.rg.joint : undefined;
      if (isJointGroup(g) && (!joint || !joint.undecided(g.key))) continue;
      if (this.askedAsContradiction(g)) {
        for (const { probeId } of registry.probesOf(g.key)) this.dropped.push({ key: `probe:${probeId}`, reason: `矛盾根源 ${g.key} 的两边已经问"现在更接近哪个"了，同一处矛盾只留那一个问题` });
        continue;
      }
      const members = new Map(registry.members(g.key).map((m) => [m.template, m.claimId]));
      const params = g.params as { daytype?: unknown; activities?: { name: string }[] };
      const daytype = typeof params.daytype === "string" ? [params.daytype] : [];
      const activities = Array.isArray(params.activities) ? params.activities.map((a) => a.name) : [];
      for (const { probeId, template } of registry.probesOf(g.key)) {
        const probe = this.store.getProbe(probeId);
        // "追问检索后还是分不清"：没检索过的先不问
        if (!probe || probe.outcome === "open" || probe.discriminates.length < 2) continue;
        const pair = probe.discriminates.map((id) => this.store.getClaim(id));
        if (pair.some((c) => c === undefined)) continue;
        const [a, b] = pair as [Claim, Claim];
        // 329 号票："待复核"是复核标记：标着的（依据在重推）先不问
        if (a.needsReview || b.needsReview) continue;
        const jq = joint?.questionFor(g.key, template);
        if (joint && !jq) {
          this.dropped.push({ key: `probe:${probeId}`, reason: `联动的组 ${g.key} 的追问 ${template} 问不出能用"是 / 不是"回答的具体的事` });
          continue;
        }
        const table = jq?.answers ?? PROBE_ANSWERS[template];
        const byTemplate = (ts: readonly string[]) => ts.map((t) => members.get(t)).filter((id): id is string => id !== undefined);
        const yes = table ? { supports: byTemplate(table.yes.supports), refutes: byTemplate(table.yes.refutes) } : { supports: probe.ifFound ? [probe.ifFound] : [], refutes: [] };
        const no = table ? { supports: byTemplate(table.no.supports), refutes: byTemplate(table.no.refutes) } : { supports: [], refutes: probe.ifFound ? [probe.ifFound] : [] };
        const base = {
          key: `probe:${probeId}`,
          topic: jq?.topic ?? g.key,
          text: jq?.text ?? probe.ask,
          probeId,
          extraDomains: jq?.extraDomains ?? [],
          scenes: [...a.context, ...b.context, ...daytype],
          terms: [...probe.queries, ...activities, ...(jq?.terms ?? [])],
          ...(jq ? { validUntil: null } : {}),
        };
        const outcome = probe.outcome === "found" ? `找到了 ${probe.foundEvidenceIds.join("、")}` : "没找到";
        if (alive(a) && alive(b) && !firm(a) && !firm(b)) {
          const only = (ids: string[]) => ids.filter((id) => id === a.id || id === b.id);
          const answers = { yes: this.effect(only(yes.supports), only(yes.refutes)), no: this.effect(only(no.supports), only(no.refutes)) };
          const gap = Math.abs(this.net(a) - this.net(b));
          const sources: QuestionSource[] = ["unresolved", ...(jq?.sources ?? [])];
          if ([a, b].some((c) => this.lowButValuable(c))) sources.push("low_confidence_high_value");
          this.raw.push({
            ...base,
            kind: "unresolved",
            sources,
            targets: [this.claimTarget(a), this.claimTarget(b)],
            answers,
            closeness: 1 / (1 + gap / LEAD_DB),
            why: `${jq ? `${jq.why}` : ""}想分清 ${ref(a)} 和 ${ref(b)}：两条现在${a.status === b.status ? `都${claimStatusLabel(a.status)}` : `一条${claimStatusLabel(a.status)}、一条${claimStatusLabel(b.status)}`}，分数差 ${gap} 分贝，追问检索（${outcome}）以后还是分不清。${this.answerNotes(answers)}`,
          });
          continue;
        }
        // 低置信但高价值：只剩它一条（别的都排除了），算成立、把握还低
        for (const [c, other] of [
          [a, b],
          [b, a],
        ] as const) {
          if (!this.lowButValuable(c) || !gone(other)) continue;
          const mine = (ids: string[]) => ids.filter((id) => id === c.id);
          const answers = { yes: this.effect(mine(yes.supports), mine(yes.refutes)), no: this.effect(mine(no.supports), mine(no.refutes)) };
          this.raw.push({
            ...base,
            kind: "low_confidence_high_value",
            sources: ["low_confidence_high_value"],
            targets: [this.claimTarget(c)],
            answers,
            closeness: CONFIDENCE_CLOSENESS[c.confidence],
            why: `${ref(c)} 现在算成立，但把握还低（${c.confidence}），又会影响常做的安排，问一句确认。${this.answerNotes(answers)}`,
          });
        }
      }
    }
  }

  /** 推断的假设算成立、把握却低，又影响常做的决定 */
  private lowButValuable(c: Claim): boolean {
    if (c.status !== "active" || c.confidence !== "low" || c.kind !== "hypothesis" || c.tier === "state") return false;
    const domains = claimDomains(this.store, c);
    const inDomains = this.recentEvidence.filter((e) => domains.some((x) => e.domains.has(x))).length;
    const frequency = 0.5 + 0.5 * (this.recentEvidence.length === 0 ? 0 : inDomains / this.recentEvidence.length);
    return breadthOf(c.context) * frequency >= HIGH_VALUE_MIN;
  }

  // ---------- 矛盾 ----------

  /** 事实这一层真冲突、两条都还 contested、都能当依据的每一对（先说的在前）：每对出一个"现在更接近哪个" */
  private contestedPairs(): [Fact, Fact][] {
    const pairs: [Fact, Fact][] = [];
    for (const f of this.store.listFacts({ status: ["contested"], subjectId: USER_ENTITY_ID })) {
      for (const otherId of f.contestedWith) {
        if (otherId <= f.id) continue;
        const g = this.store.getFact(otherId);
        if (!g || g.status !== "contested" || !this.view.usableFact(f) || !this.view.usableFact(g)) continue;
        pairs.push(toMs(f.observedAt) <= toMs(g.observedAt) ? [f, g] : [g, f]);
      }
    }
    return pairs;
  }

  /**
   * 334b（用户 2026-10-27）：同一处矛盾只留一个问题——矛盾根源那组（199）的两边里有一对正是"矛盾"那一路要问的（事实层真冲突、
   * 两条都还拿不准），它的追问不再另出问题（R15 少问；R13 只说"分不清再问你"）。说的和做的不一样、别的根源组照旧
   */
  private askedAsContradiction(g: GroupRecord): boolean {
    if (!isRootGroup(g)) return false;
    const p = g.params as { sideA?: unknown; sideB?: unknown };
    const a = new Set(Array.isArray(p.sideA) ? (p.sideA as string[]) : []);
    const b = new Set(Array.isArray(p.sideB) ? (p.sideB as string[]) : []);
    this.pairs ??= this.contestedPairs();
    return this.pairs.some(([x, y]) => (a.has(x.id) && b.has(y.id)) || (a.has(y.id) && b.has(x.id)));
  }

  private fromContradictions(): void {
    for (const [older, newer] of this.contestedPairs()) {
      const name = this.entityName(newer);
      const claimA = this.rg.registry.explicitClaimOf(older.id);
      const claimB = this.rg.registry.explicitClaimOf(newer.id);
      const claimTargets = [claimA, claimB].map((id) => (id ? this.store.getClaim(id) : undefined)).filter((c): c is Claim => c !== undefined);
      const targets: QuestionTarget[] =
        claimTargets.length === 2 ? claimTargets.map((c) => this.claimTarget(c)) : [older, newer].map((x) => ({ id: x.id, kind: "fact" as const, statement: x.statement }));
      const pa = userPhrase(older, this.entityName(older));
      const pb = userPhrase(newer, name);
      const answers = {
        yes: this.effect(claimB ? [claimB] : [], claimA ? [claimA] : [], "decisive", { activate: [newer.id], supersede: [older.id] }),
        no: this.effect(claimA ? [claimA] : [], claimB ? [claimB] : [], "decisive", { activate: [older.id], supersede: [newer.id] }),
      };
      answers.yes.note = `现在是"${pb}"：${older.id} 到期、${newer.id} 定下来`;
      answers.no.note = `现在还是"${pa}"：${newer.id} 到期、${older.id} 定下来`;
      this.raw.push({
        key: `contradiction:${older.id}|${newer.id}`,
        topic: this.objectTopic(newer),
        kind: "contradiction",
        sources: ["contradiction"],
        text: `关于${name}：你${monthDay(factTime(older))}说过"${pa}"，${sameLocalDay(factTime(older), factTime(newer)) ? "后来" : `${monthDay(factTime(newer))}`}又说"${pb}"。现在更接近后一种吗？`,
        why: `你说过的两句话对不上：${older.id}「${older.statement}」和 ${newer.id}「${newer.statement}」，有效期重叠、场景对得上，后说的那句又没自己说"变了"（不再、改成、以前…现在…这类），哪边都不自动赢（334 号票），事实这一层两条都还拿不准。${this.answerNotes(answers)}`,
        targets,
        answers,
        probeId: null,
        extraDomains: [...domainsOfTags([...older.context, ...newer.context]), ...domainsOfText(name)],
        scenes: [...older.context, ...newer.context],
        terms: [name],
        closeness: FIXED_CLOSENESS.contradiction!,
      });
    }
  }

  // ---------- 张力：说的和做的不一样 ----------

  private fromTensions(): void {
    const from = toMs(addDays(this.at, -RECENT_DAYS));
    for (const { factId, claimId } of this.rg.registry.listExplicit()) {
      const said = this.store.getFact(factId);
      const claim = this.store.getClaim(claimId);
      if (!said || !claim || claim.status !== "active" || said.status !== "active" || said.object.type !== "entity") continue;
      if (!likes(said) && !dislikes(said)) continue;
      const opposite = this.store
        .listFacts({ subjectId: USER_ENTITY_ID, objectId: said.object.id })
        .filter((g) => ACTIVE_HELD.has(g.status) && g.assertion === "observed" && !g.negated && this.view.usableFact(g))
        .filter((g) => (likes(said) ? g.predicate === "declined" : g.predicate === "participated_in" || g.predicate === "initiated"))
        .filter((g) => toMs(factTime(g)) > toMs(factTime(said)) && toMs(factTime(g)) > from && toMs(factTime(g)) <= toMs(this.at) && contextsCompatible(said.context, g.context))
        .toSorted((x, y) => toMs(factTime(y)) - toMs(factTime(x)));
      const did = opposite[0];
      if (!did) continue;
      const name = this.entityName(said);
      const answers = likes(said)
        ? { yes: this.effect([claim.id], []), no: this.effect([], [claim.id], "decisive", { supersede: [said.id] }) }
        : { yes: this.effect([], [claim.id], "decisive", { supersede: [said.id] }), no: this.effect([claim.id], []) };
      this.raw.push({
        key: `tension:${claim.id}|${did.id}`,
        topic: this.objectTopic(said),
        kind: "tension",
        sources: ["tension"],
        text: `下次再有${name}的机会，你想去吗？`,
        why: `你说过${userPhrase(said, name)}（${said.id}），${monthDay(factTime(did))}又${userPhrase(did, name)}（${did.id}）：说的和做的不太一样，不知道哪个更接近现在。${this.answerNotes(answers)}`,
        targets: [this.claimTarget(claim)],
        answers,
        probeId: null,
        extraDomains: [...domainsOfTags([...said.context, ...did.context]), ...domainsOfText(name)],
        scenes: [...said.context],
        terms: [name],
        closeness: FIXED_CLOSENESS.tension!,
      });
    }
  }

  // ---------- 规范性判断 ----------

  private fromNormative(): void {
    for (const claim of this.store.listClaims({ status: ["active", "contested"] })) {
      if (claim.epistemic !== "inferred" || claim.kind !== "hypothesis") continue;
      const word = NORMATIVE_WORDS.find((w) => claim.statement.includes(w));
      if (!word) continue;
      const domains = claimDomains(this.store, claim);
      const text = offerFor(claim, domains);
      const key = `normative:${claim.id}`;
      if (!text) {
        this.dropped.push({ key, reason: `${claim.id} 带评判（${word}），但没有合适的、只问要不要帮忙的问法` });
        continue;
      }
      const answers = { yes: this.effect([claim.id], [], "weak"), no: this.effect([], [], "weak") };
      answers.yes.note = `只算一条弱的旁证：愿意${claim.tier === "state" ? "少排一些" : "让我帮忙"}不等于 ${claim.id} 就对`;
      answers.no.note = "不判（不要帮忙不说明什么）";
      this.raw.push({
        key,
        topic: this.topicOfClaim(claim),
        kind: "normative",
        sources: ["normative"],
        text,
        why: `${ref(claim)} 里带着"${word}"这样的评判。评判不能直接说给你听，只能问要不要帮忙（规范性判断只能以问题出现）。${this.answerNotes(answers)}`,
        targets: [this.claimTarget(claim)],
        answers,
        probeId: null,
        extraDomains: [],
        scenes: this.scenesOfClaim(claim),
        terms: [],
        closeness: CONFIDENCE_CLOSENESS[claim.confidence],
      });
    }
  }

  // ---------- 预测落空 ----------

  private fromPredictions(): void {
    const from = toMs(addDays(this.at, -RECENT_DAYS));
    for (const claim of this.store.listClaims({ status: "active" })) {
      if (claim.kind !== "hypothesis" || claim.confidence === "low" || claim.epistemic === "explicit") continue;
      const since = this.store
        .revisions(claim.id, "claim")
        .toReversed()
        .find((r) => r.changes.status?.to === "active")?.at ?? claim.inferredAt;
      const misses = this.store
        .linksOf(claim.id)
        .filter((l) => l.polarity === "refutes")
        .map((l) => ({ link: l, fact: this.store.getFact(l.target) }))
        .filter((x): x is { link: typeof x.link; fact: Fact } => x.fact !== undefined && ACTIVE_HELD.has(x.fact.status) && this.view.usableFact(x.fact))
        .filter(({ fact }) => toMs(factTime(fact)) > toMs(since) && toMs(factTime(fact)) > from && toMs(factTime(fact)) <= toMs(this.at))
        .toSorted((x, y) => toMs(factTime(y.fact)) - toMs(factTime(x.fact)));
      const miss = misses[0];
      if (!miss) continue;
      const { fact, link } = miss;
      const name = this.entityName(fact);
      const answers = { yes: this.effect([], [claim.id]), no: this.effect([claim.id], []) };
      answers.yes.note = `以后也会这样：${ref(claim)} 站不住`;
      answers.no.note = `那次是例外：更支持 ${ref(claim)}`;
      this.raw.push({
        key: `prediction:${claim.id}|${fact.id}`,
        topic: this.topicOfClaim(claim),
        kind: "prediction_violation",
        sources: ["prediction_violation"],
        text: `${monthDay(factTime(fact))}你${contextPhrase(fact.context)}${userPhrase(fact, name)}。以后遇到类似的情况，你还会这样吗？`,
        why: `按 ${ref(claim)}（${localDate(since)} 起成立）预想不到 ${fact.id}「${fact.statement}」（${link.rationale}）：预测落空，问一句，不静默改写。${this.answerNotes(answers)}`,
        targets: [this.claimTarget(claim)],
        answers,
        probeId: null,
        extraDomains: [...domainsOfTags(fact.context), ...domainsOfText(name)],
        scenes: this.scenesOfClaim(claim),
        terms: [name],
        closeness: FIXED_CLOSENESS.prediction_violation!,
      });
    }
  }

  // ---------- 330 号票：演绎预测落空、判不出撤哪条 ----------

  private fromFalsified(): void {
    for (const p of this.store.listPredictions({ status: "miss" })) {
      const mode = p.blame?.mode;
      if (mode !== "undetermined" && mode !== "counterexample") continue;
      const evidence = p.retractedBy ? this.store.getEvidence(p.retractedBy) : undefined;
      if (!evidence || !this.view.usableEvidence(evidence.id)) continue;
      const when = toMs(evidence.observedAt);
      // 落空以后用户已经确认过的不再问（"还对"已经答了）
      const confirmedSince = (c: Claim) =>
        this.store.linksOf(c.id).some((l) => l.polarity === "supports" && l.weight === "decisive" && toMs(this.store.getEvidence(l.target)?.observedAt ?? "1970-01-01T00:00:00Z") > when);
      const suspects = p.blame!.claimIds
        .map((id) => this.store.getClaim(id))
        .filter((c): c is Claim => c !== undefined && !gone(c) && (mode === "counterexample" || c.status !== "active") && !confirmedSince(c));
      if (suspects.length === 0) continue;
      const others = p.premiseIds.filter((id) => !suspects.some((c) => c.id === id));
      for (const c of suspects) {
        const answers = { yes: this.effect([c.id], []), no: this.effect([], [c.id]) };
        answers.yes.note = `还对：这次落空不怪 ${ref(c)}`;
        answers.no.note = `不对了：${ref(c)} 就是错的那条，撤回`;
        this.raw.push({
          key: `falsified:${p.id}|${c.id}`,
          topic: this.topicOfClaim(c),
          kind: "prediction_violation",
          sources: ["prediction_violation"],
          text: `之前估计「${p.predicts}」，${monthDay(evidence.eventTime ?? evidence.observedAt)}没这样。「${youOf(c.statement)}」这一条现在还对吗？`,
          why: `从 ${p.premiseIds.map((id) => this.store.getClaim(id)).filter((x): x is Claim => x !== undefined).map(ref).join("、")} 演绎出的预测 ${p.id} 落空了（${evidence.id}「${evidence.text}」）。${
            mode === "undetermined"
              ? `没验证的前提不止一条，判不出是哪条错了（Duhem-Quine），不乱撤，一条一条问`
              : `前提都已验证，只能是漏了条件或这条反证有误，问一句弄清`
          }${others.length > 0 ? `（${others.join("、")} 也在嫌疑里或已验证）` : ""}。${this.answerNotes(answers)}`,
          targets: [this.claimTarget(c)],
          answers,
          probeId: null,
          extraDomains: [...domainsOfTags(evidence.context)],
          scenes: this.scenesOfClaim(c),
          terms: [],
          closeness: FIXED_CLOSENESS.prediction_violation!,
        });
      }
    }
  }

  // ---------- 330 号票（R12）：已验证碰上有分量的反例 ----------

  /** 降回猜测、标着复核、碰上还没弄清的有分量的反例的：问是不是例外（是：你确认过，照旧已验证；不是：撤回） */
  private fromCounterexamples(): void {
    for (const c of this.store.listClaims({ status: "contested" })) {
      if (!c.needsReview || c.epistemic === "explicit") continue;
      const ce = this.rg.openCounterexample(c.id, this.view);
      if (!ce) continue;
      const fact = this.store.getFact(ce.target);
      const evidence = (fact ? fact.evidenceIds : [ce.target]).map((id) => this.store.getEvidence(id)).find((e) => e !== undefined && this.view.usableEvidence(e.id));
      if (!evidence) continue;
      const answers = { yes: this.effect([c.id], []), no: this.effect([], [c.id]) };
      answers.yes.note = `是例外：${ref(c)} 照旧已验证（你确认过）`;
      answers.no.note = `不是例外，其实不对了：${ref(c)} 撤回`;
      this.raw.push({
        key: `counterexample:${c.id}|${ce.target}`,
        topic: this.topicOfClaim(c),
        kind: "counterexample",
        sources: ["counterexample"],
        text: `「${youOf(c.statement)}」平时还对吗？${monthDay(evidence.eventTime ?? evidence.observedAt)}那次（${short(evidence.text)}）算例外？`,
        why: `${ref(c)} 证据够已验证，但碰上有分量的反例 ${ce.target}（${ce.rationale}），先降回猜测、标着复核（R12），问一句弄清。${this.answerNotes(answers)}`,
        targets: [this.claimTarget(c)],
        answers,
        probeId: null,
        extraDomains: [...domainsOfTags([...c.context, ...evidence.context])],
        scenes: this.scenesOfClaim(c),
        terms: [],
        closeness: FIXED_CLOSENESS.counterexample!,
      });
    }
  }

  // ---------- 330 号票（R13）：两条打架都已验证 ----------

  /** 跨组互相矛盾、都够已验证、场合对得上的（按场合分不开的）：问现在更接近哪一条 */
  private fromVerifiedConflicts(): void {
    for (const [a, b] of this.rg.verifiedConflicts(this.view)) {
      const answers = { yes: this.effect([a.id], [b.id]), no: this.effect([b.id], [a.id]) };
      answers.yes.note = `更接近前一条：${ref(a)} 你确认过，${ref(b)} 撤回`;
      answers.no.note = `更接近后一条：${ref(b)} 你确认过，${ref(a)} 撤回`;
      this.raw.push({
        key: `verified-conflict:${[a.id, b.id].toSorted().join("|")}`,
        topic: this.topicOfClaim(a),
        kind: "contradiction",
        sources: ["contradiction"],
        text: `「${youOf(a.statement)}」和「${youOf(b.statement)}」对不上，现在更接近前一个吗？`,
        why: `${ref(a)} 和 ${ref(b)} 互相矛盾、证据都够已验证，场合也分不开：两条都降回猜测、标着复核（R13），问一句弄清。${this.answerNotes(answers)}`,
        targets: [this.claimTarget(a), this.claimTarget(b)],
        answers,
        probeId: null,
        extraDomains: [...domainsOfTags([...a.context, ...b.context])],
        scenes: [...this.scenesOfClaim(a), ...this.scenesOfClaim(b)],
        terms: [],
        closeness: FIXED_CLOSENESS.contradiction!,
      });
    }
  }

  // ---------- 330 号票（R3）：别人转述的 ----------

  /**
   * 转述起的猜测（还是猜测的）问一句"是这样吗"：是 → 你确认过（直接证实、已验证），不是 → 撤回。
   * 转述和你自己说过的（已验证的明说结论）对着干的：不起猜测、不记反证，只问一句"现在还是你说的那样吗"（每条转述的事实最多一个）：
   * 是 → 那条记成你确认过，不是 → 你那条事实到期（明说的结论跟着走）
   */
  private fromRelayed(): void {
    for (const f of this.store.listFacts({ subjectId: USER_ENTITY_ID })) {
      if (f.assertion !== "third_party_reported") continue;
      const said = f.evidenceIds.map((id) => this.store.getEvidence(id)).find((e) => e?.status === "active");
      if (!said) continue;
      const name = this.entityName(f);
      const guessId = relayedGuessOf(this.store, f.id);
      if (guessId !== undefined) {
        const c = this.store.getClaim(guessId);
        if (!c || c.status !== "contested") continue;
        const answers = { yes: this.effect([c.id], []), no: this.effect([], [c.id]) };
        answers.yes.note = `是：你确认了，${ref(c)} 已验证`;
        answers.no.note = `不是：${ref(c)} 撤回`;
        this.raw.push({
          key: `relayed:${c.id}`,
          topic: this.topicOfClaim(c),
          kind: "relayed",
          sources: ["relayed"],
          text: `听别人说${youOf(c.statement)}，是这样吗？`,
          why: `别人转述的（${said.id}「${said.text}」）：只是转述、你没说过，先当猜测 ${ref(c)}，问你确认（转述永远到不了已验证）。${this.answerNotes(answers)}`,
          targets: [this.claimTarget(c)],
          answers,
          probeId: null,
          extraDomains: [...domainsOfTags(f.context), ...domainsOfText(name)],
          scenes: [...f.context],
          terms: [name],
          closeness: FIXED_CLOSENESS.relayed!,
        });
        continue;
      }
      if (!relayedEligible(this.store, f)) continue;
      const own = selfCounterparts(this.store, f)
        .conflicts.map((x) => ({ fact: x, claim: this.rg.registry.explicitClaimOf(x.id) }))
        .map((x) => ({ fact: x.fact, claim: x.claim === undefined ? undefined : this.store.getClaim(x.claim) }))
        .find((x): x is { fact: Fact; claim: Claim } => x.claim !== undefined && x.claim.status === "active");
      if (!own) continue;
      const answers = { yes: this.effect([own.claim.id], []), no: this.effect([], [], "decisive", { supersede: [own.fact.id] }) };
      answers.yes.note = `还是你说的那样：${ref(own.claim)} 记成你确认过`;
      answers.no.note = `现在不是了：${own.fact.id} 到期（${ref(own.claim)} 跟着事实走）`;
      this.raw.push({
        key: `relayed:${f.id}`,
        topic: this.objectTopic(f),
        kind: "relayed",
        sources: ["relayed"],
        text: `有人说你${userPhrase(f, name)}，你之前说过${userPhrase(own.fact, this.entityName(own.fact))}。现在还是你说的那样吗？`,
        why: `别人转述的（${said.id}「${said.text}」）和你自己说过的 ${own.fact.id}「${own.fact.statement}」对不上。转述打不下你说过的（${ref(own.claim)} 照旧已验证，不记反证），只问一句。${this.answerNotes(answers)}`,
        targets: [this.claimTarget(own.claim), { id: f.id, kind: "fact", statement: f.statement }],
        answers,
        probeId: null,
        extraDomains: [...domainsOfTags([...f.context, ...own.fact.context]), ...domainsOfText(name)],
        scenes: [...f.context, ...own.fact.context],
        terms: [name],
        closeness: FIXED_CLOSENESS.relayed!,
      });
    }
  }

  // ---------- 330 号票（R6）：做法的理由没了，还要不要 ----------

  private fromStrategies(): void {
    for (const s of this.store.listStrategies({ status: ["active", "paused"] })) {
      if (!basisQuestionDue(this.store, s)) continue;
      const basis = s.basisClaimIds.map((id) => this.store.getClaim(id)).filter((c): c is Claim => c !== undefined);
      const text = strategyText(s);
      const answers: QuestionAnswers = {
        yes: { supports: [], refutes: [], maxWeight: "decisive", note: `还要：照旧这么做（记成重新确认）`, strategies: { keep: [s.id] } },
        no: { supports: [], refutes: [], maxWeight: "decisive", note: `不要了：撤掉这条做法`, strategies: { retract: [s.id] } },
      };
      this.raw.push({
        key: `strategy:${s.id}`,
        topic: `strategy:${s.id}`,
        kind: "strategy_basis",
        sources: ["strategy_basis"],
        text: `之前说好「${text}」。当时的理由现在不成立了，这条还要照旧吗？`,
        why: `做法 ${s.id} 是你点过头的，当时的理由 ${basis.map((c) => `${c.id}「${c.statement}」（${claimStatusLabel(c.status)}）`).join("、") || s.basisClaimIds.join("、")} 现在都不在了。不自动停、不自动撤，问一句（R6）。${this.answerNotes(answers)}`,
        targets: [{ id: s.id, kind: "strategy", statement: text }],
        answers,
        probeId: null,
        extraDomains: [...s.trigger.domains],
        scenes: s.trigger.scenes.flat(),
        terms: s.trigger.activities.map((a) => a.name),
        closeness: 1,
      });
    }
  }

  // ---------- 反常输入 ----------

  private fromOutOfCharacter(): void {
    const from = toMs(addDays(this.at, -RECENT_DAYS));
    for (const old of this.store.listFacts({ status: ["superseded"], subjectId: USER_ENTITY_ID })) {
      if (!old.supersededBy || old.assertion !== "user_stated") continue;
      const flip = this.store.getFact(old.supersededBy);
      if (!flip || flip.status !== "active" || flip.assertion !== "user_stated" || !this.view.usableFact(flip)) continue;
      if (!((likes(old) && dislikes(flip)) || (dislikes(old) && likes(flip)))) continue;
      if (toMs(flip.observedAt) <= from || toMs(flip.observedAt) > toMs(this.at)) continue;
      // 说了"现在、开始、不再"或者是纠正的，是有交代的变化，不算反常
      const texts = flip.evidenceIds.map((id) => this.store.getEvidence(id)).filter((e) => e !== undefined);
      if (texts.some((e) => e.kind === "correction" || changeSignals(e.text).length > 0 || correctionSignals(e.text).length > 0)) continue;
      const claimId = this.rg.registry.explicitClaimOf(flip.id);
      const claim = claimId ? this.store.getClaim(claimId) : undefined;
      if (!claim || gone(claim)) continue;
      const name = this.entityName(flip);
      const pNew = userPhrase(flip, name);
      const pOld = userPhrase(old, this.entityName(old));
      const answers = { yes: this.effect([claim.id], []), no: this.effect([], [claim.id], "decisive", { correctEvidence: [...flip.evidenceIds] }) };
      answers.yes.note = `现在确实是"${pNew}"：更支持 ${ref(claim)}`;
      answers.no.note = `不是这样：${flip.evidenceIds.join("、")} 当成说错了（纠正），"${pOld}"恢复`;
      this.raw.push({
        key: `ooc:${flip.id}`,
        topic: this.objectTopic(flip),
        kind: "out_of_character",
        sources: ["out_of_character"],
        text: `你${monthDay(factTime(flip))}说${pNew}，之前说过${pOld}。现在是${pNew}了吗？`,
        why: `${flip.id}「${flip.statement}」和以前的 ${old.id}「${old.statement}」正好相反，又没有"现在、开始、不再"这类说法，事实这一层已经按观点变化接上了；先问一句再当真（反常输入）。${this.answerNotes(answers)}`,
        targets: [this.claimTarget(claim)],
        answers,
        probeId: null,
        extraDomains: [...domainsOfTags(flip.context), ...domainsOfText(name)],
        scenes: [...flip.context],
        terms: [name],
        closeness: FIXED_CLOSENESS.out_of_character!,
      });
    }
  }
}

/** 规范性判断只能问"要不要我帮你……"：按断言的层和领域挑一个具体的问法；挑不出就不问 */
function offerFor(claim: Claim, domains: readonly string[]): string | undefined {
  if (claim.tier === "state" || domains.includes("schedule") || domains.includes("health")) return "接下来安排事情的时候，要不要我多留几段空白、少排一些？";
  if (domains.includes("social")) return "以后有人约你的时候，要不要我先帮你看看那几天排得满不满再答复？";
  if (domains.includes("career")) return "要不要我帮你把手上的事按轻重缓急理一理？";
  return undefined;
}
