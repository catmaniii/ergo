// 记忆简报（216 号票）：给大模型回答器（llm/answerer.ts）看的上下文——二狗上线时秘书读着记忆回答，评测里拿它模拟秘书。
// memoryBrief(engine, question, { at, context, group, hits? })，按组不同：
// - A、B、C：这一组检索出的记录（前 10 条，同评测的检索设置）：原话、时间、谁说的（本人说的、做的；别人转述的标"不当依据"）、
//   场景、精炼陈述（本人有效的记录才带）；被本人纠正过的标出来、写明以哪条为准；
// - D：C 的记录（一字不差），加上和问题相关的用户画像：
//   - 对用户的理解：196 号票三条路找到的结论，先放过了相关门槛、直接说到这件事的（relevance.ts 的 gated，direct），
//     任务题再放 adviseTask 调出的明确的偏好、推断的需求和价值观，再放三条路每层最相关的（每层 2 条，需求、价值观在前），
//     最后是只有领域对上的（"同一方面"）；后两种标"不一定直接说到这件事"。候选按和问题的相关程度排（222 号票）：
//     先看它的支持证据在 C 组检索里的最好名次（同下面挑原话的名次），direct 的往前挪 BRIEF_DIRECT_BONUS 名，名次相同按
//     三条路合并的分、再按层级（需求、价值观、偏好、状态）和把握；同一组、或者陈述几乎一样的两条只留一条（把握高、
//     组里占上风的、支持证据多的）；只差否定词的两条（喜欢 / 不喜欢）算极性相反，任何情况下都不合并（228 号票）。每条写清层级、谁说的（用户说的、推断的、确认过的）、
//     状态、把握、支持和反对的证据各几条；组里胜出的那条写明占上风，被排除的跟在后面；
//     每条结论下面带上和问题最相关的几条支持证据（最多 3 条）、反对证据（最多 2 条）的原话：时间、谁说的、原话（219 号票）——
//     按 C 组检索（记录那节的设置，往深里搜 BRIEF_RANK_DEPTH 条）的名次挑，搜不到的排在后面；记录那节已经有的、上面的结论带过的只写编号；
//   - 还没分出胜负的竞争解释：上面这些结论、三条路"还拿不准的"所在的组，组里没有成立且把握不低的那条（同模板回答的判法），
//     列出几种解释（各自的状态、支持、反对）、已经排除的和一个能区分的问题；
//   - 明说过的要求和禁忌：任务题的"这次明说的要求"（adviseTask 第 ① 层，原样）、硬约束（第 ② 层，用户明说的禁忌，总带上）、
//     任务题能用的交互策略（第 ⑤ 层）。
// 简报要短：记录那节、用户画像那几节各有字数上限（BRIEF_LIMITS），按优先级整条整条地放（明说的要求和禁忌 > 结论连原话 > 竞争解释），
// 放不下时先砍竞争解释、再砍结论的条数，原话最后砍（一条结论连原话都放不下才减它的原话）；放不下的记条数（omitted，
// 同一组、近乎同文去掉的也算在这里），不把整个推理图谱塞进去。回答器只认简报正文里出现的证据、结论编号（evidenceIds、claimIds）。
import { createHash } from "node:crypto";
import type { Claim, ClaimTier, Evidence } from "../domain/types.ts";
import type { MemoryEngine } from "../engine.ts";
import { CONTEXT_LABELS } from "../kg/context.ts";
import { planQuery } from "../retrieval/plan.ts";
import type { Hit, SearchMode, SearchOptions } from "../retrieval/types.ts";
import { hardConstraintClaims } from "../rg/advice.ts";
import { classifyQuestion } from "../rg/question.ts";
import { type GatedClaim, relevantForQuestion } from "../rg/relevance.ts";
import type { RgView } from "../rg/types.ts";
import { isThin, type RouteName, ROUTES, UPWARD_HITS } from "../rg/value-retrieval.ts";

export interface BriefLimits {
  /** 记录最多几条 */
  records: number;
  /** 一条原话最多几个字（多了截断加"…"） */
  quoteChars: number;
  /** 一条记录带几句精炼陈述 */
  statementsPerRecord: number;
  /** 记录那一节最多多少字 */
  recordChars: number;
  /** D："对用户的理解"最多几条结论 */
  claims: number;
  /** D：还没分出胜负的解释最多几组 */
  groups: number;
  /** D：每组最多列几种解释 */
  membersPerGroup: number;
  /** D：用户画像那几节一共最多多少字 */
  profileChars: number;
  /** D：每条结论下面带几条支持证据的原话（219） */
  supportQuotes: number;
  /** D：每条结论下面带几条反对证据的原话（219） */
  refuteQuotes: number;
}

/**
 * 默认上限：记录 10 条（同评测的检索条数）、2000 字；用户画像 10 条结论（每条带 3 条支持、2 条反对的原话）、3 组竞争解释、4800 字
 * （216 是 2400 字，219 带了原话放宽一倍）。一共约 6800 字（约 4200 token）
 */
export const BRIEF_LIMITS: Readonly<BriefLimits> = { records: 10, quoteChars: 80, statementsPerRecord: 2, recordChars: 2000, claims: 10, groups: 3, membersPerGroup: 4, profileChars: 4800, supportQuotes: 3, refuteQuotes: 2 };

/** 简报的记录那节用几条检索结果（同评测，eval/run.ts 的 LIMIT） */
export const BRIEF_SEARCH_LIMIT = 10;

/** D：给结论的证据按和问题的相关程度排时，看 C 组检索（记录那节的设置）的前多少条；不在里面的排在后面（219） */
export const BRIEF_RANK_DEPTH = 200;

/**
 * D：挑结论时 direct（直接说到这件事）的加成——相当于在 C 组检索里往前挪多少名（222 号票）。
 * 名次差得不多时 direct 的排前面；差得多时照样排后面，一长串 direct 占不住名额
 */
export const BRIEF_DIRECT_BONUS = Math.round(BRIEF_RANK_DEPTH / 4);

export interface BriefRecord {
  evidenceId: string;
  text: string;
  /** 发生的时间（不知道时是记下的时间），"2026-10-03 10:00" */
  time: string;
  /** 本人说的、本人做的、本人纠正、别人转述（不当依据）…… */
  label: string;
  context: string[];
  /** 能当关于用户的依据（本人、有效） */
  usable: boolean;
  status: Evidence["status"];
  /** 被本人纠正时，纠正它的那条 */
  correctedBy: string | null;
  /** 精炼陈述（本人有效的记录才带） */
  statements: string[];
}

/** 结论下面带的一条证据的原话（219） */
export interface BriefQuote {
  evidenceId: string;
  /** 支持还是反对这条结论 */
  polarity: "supports" | "refutes";
  /** 发生的时间（不知道时是记下的时间），"2026-10-03 10:00" */
  time: string;
  /** 谁说的：本人说的、本人做的、本人纠正 */
  label: string;
  /** 原话全文（写进简报时超过 quoteChars 截断） */
  text: string;
}

/** 结论为什么进了简报：直接说到这件事、任务调出来的、三条路每层最相关的、只是同一方面 */
export type BriefClaimReason = "direct" | "task" | "related" | "area";

export interface BriefClaim {
  claimId: string;
  statement: string;
  tier: ClaimTier;
  status: Claim["status"];
  confidence: Claim["confidence"];
  epistemic: Claim["epistemic"];
  /** 能当依据的支持证据、反对证据 */
  supportIds: string[];
  refuteIds: string[];
  reason: BriefClaimReason;
  groupKey: string | null;
  /** 330 号票：标着复核（依据刚变了，等下一次整理重判）——照真值状态给，标出来 */
  needsReview?: boolean;
  /**
   * 结论下面带的原话（219，只有"对用户的理解"那节的结论有）：和问题最相关的支持证据（最多 supportQuotes 条）在前、
   * 反对证据（最多 refuteQuotes 条）在后，各按检索的相关程度排。放进简报的是实际写出来的那些（编号总写；原话在记录那节或上面的结论里有了就只写编号）
   */
  quotes?: BriefQuote[];
}

export interface BriefGroup {
  key: string;
  description: string;
  /** 还没排除的几种解释 */
  members: BriefClaim[];
  /** 已经排除的：断言、撤回它的证据 */
  excluded: { claimId: string; statement: string; evidenceIds: string[] }[];
  /** 能区分的问题 */
  probe: string | null;
}

export interface BriefProfile {
  /** 对用户的理解 */
  claims: BriefClaim[];
  /** 还没分出胜负的竞争解释 */
  groups: BriefGroup[];
  /** 这次明说的要求（任务题） */
  requirements: string[];
  /** 硬约束（用户明说的禁忌） */
  hardConstraints: BriefClaim[];
  /** 任务题能用的交互策略 */
  strategies: { strategyId: string; use: "apply" | "confirm_first"; text: string; onGuess?: boolean; basisGone?: boolean }[];
}

export interface MemoryBrief {
  question: string;
  /** 问的时间 */
  at: string;
  /** 按哪个时间看记忆（问题里说了"去年九月"就是那时，同模板回答） */
  viewAt: string;
  context: string[];
  group: SearchMode;
  records: BriefRecord[];
  /** D 组的用户画像；A、B、C 是 null */
  profile: BriefProfile | null;
  /** 渲染好的两节：记录、用户画像（A、B、C 是空串） */
  sections: { records: string; profile: string };
  /** 整份简报（记录 + 空行 + 用户画像） */
  text: string;
  /** 正文里出现的证据编号、结论编号：回答器只认这些 */
  evidenceIds: string[];
  claimIds: string[];
  /** 因为条数、字数上限没放进来的；claims 里也算上同一组、近乎同文去掉的那几条（222 号票） */
  omitted: { records: number; claims: number; groups: number };
  /** 记录那节用的检索结果（D 组是 C 组的） */
  hits: Hit[];
}

export interface MemoryBriefOptions {
  /** 问的时间，默认现在 */
  at?: string;
  context?: string[];
  /** 哪一组：vector（A）、hybrid（B）、hybrid_kg（C）、hybrid_kg_rg（D = C 的记录 + 用户画像） */
  group: SearchMode;
  /** 已经做过的这组检索（评测交进来，免得再搜一遍）；D 组要给 C 组的。不给就按 briefSearchOptions 自己搜 */
  hits?: readonly Hit[];
  limits?: Partial<BriefLimits>;
}

/** 记录那节的检索设置：同评测（eval/run.ts 的 searchOptionsFor，两层、不另加过滤）——A 只按余弦，B、C、D 按问题规划时间 */
export function briefSearchOptions(group: SearchMode, question: string, at: string, context?: string[]): SearchOptions {
  if (group === "vector") return { mode: "vector", layers: "both", limit: BRIEF_SEARCH_LIMIT };
  const plan = planQuery(question, at);
  return { mode: group, layers: "both", limit: BRIEF_SEARCH_LIMIT, at: plan.at ?? at, eventRange: plan.eventRange, context };
}

const TIER: Record<ClaimTier, string> = { state: "近期状态", preference: "偏好", need: "需求", value: "价值观" };
const EPISTEMIC: Record<Claim["epistemic"], string> = { explicit: "用户说的", inferred: "推断的", user_confirmed: "用户确认过" };
// 330 号票（R5）：真值状态照原始推理图谱说"已验证 / 猜测"（329 号票起 active 是已验证、contested 是猜测）
const STATUS: Record<Claim["status"], string> = { active: "已验证", contested: "猜测", retracted: "已撤回", superseded: "已被新的说法取代" };
const CONFIDENCE: Record<Claim["confidence"], string> = { low: "低", medium: "中", high: "高" };

/** "2026-10-03T10:00:00+08:00" → "2026-10-03 10:00"（合成数据都是 +08:00，原样取） */
export const briefTime = (iso: string) => iso.slice(0, 16).replace("T", " ");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const trimEnd = (s: string) => s.replace(/[。.；;，,\s]+$/, "");
const uniq = (xs: readonly string[]) => [...new Set(xs)];
const scene = (context: readonly string[]) => context.map((t) => CONTEXT_LABELS[t] ?? t).join("、");

/** 一条证据是谁说的、怎么来的 */
function sourceLabel(e: Evidence): string {
  if (e.sourceLevel === "self") return e.kind === "correction" ? "本人纠正" : e.mode === "do" ? "本人做的" : "本人说的";
  if (e.sourceLevel === "untrusted") return "别人转述（不当依据）";
  if (e.sourceLevel === "agent") return "助理记的（不当依据）";
  return "系统记的（不当依据）";
}

/** 纠正这条证据的那条（修订日志里把它改成 corrected 的原因） */
function correctorOf(engine: MemoryEngine, evidenceId: string): string | null {
  const r = engine.store.revisions(evidenceId, "evidence").find((x) => (x.changes.status as { to?: unknown } | undefined)?.to === "corrected");
  return r?.causeEvidenceId ?? null;
}

function recordOf(engine: MemoryEngine, evidenceId: string, view: RgView, limits: BriefLimits): BriefRecord | undefined {
  const e = engine.store.getEvidence(evidenceId);
  if (!e || e.status === "forgotten") return undefined;
  const usable = view.usableEvidence(e.id);
  return {
    evidenceId: e.id,
    text: e.text,
    time: briefTime(e.eventTime ?? e.observedAt),
    label: sourceLabel(e),
    context: e.context,
    usable,
    status: e.status,
    correctedBy: e.status === "corrected" ? correctorOf(engine, e.id) : null,
    statements: usable ? [...new Set(view.factsOfEvidence(e.id).map((f) => f.statement))].slice(0, limits.statementsPerRecord) : [],
  };
}

/** 渲染好的一条：文字和它里面出现的编号 */
interface Item {
  text: string;
  evidenceIds: string[];
  claimIds: string[];
}

function renderRecord(r: BriefRecord, n: number, limits: BriefLimits): Item {
  const head = [`[${r.evidenceId}] ${r.time}`, r.label, r.context.length > 0 ? scene(r.context) : ""].filter((x) => x).join(" · ");
  const corrected = r.status === "corrected" ? (r.correctedBy ? ` · 已被本人纠正，以 ${r.correctedBy} 为准（不再当依据）` : " · 已被本人纠正（不再当依据）") : "";
  const lines = [`${n}. ${head}${corrected}`, `   原话：「${clip(r.text, limits.quoteChars)}」`];
  if (r.statements.length > 0) lines.push(`   精炼：${r.statements.join("；")}`);
  return { text: lines.join("\n"), evidenceIds: [r.evidenceId, ...(r.correctedBy ? [r.correctedBy] : [])], claimIds: [] };
}

/** 能当依据的支持、反对证据 */
function evidenceOf(engine: MemoryEngine, claimId: string, view: RgView, polarity: "supports" | "refutes"): string[] {
  const ids: string[] = [];
  for (const l of engine.store.linksOf(claimId)) if (l.polarity === polarity) for (const id of engine.rg.evidenceOfTarget(l.target, view)) if (!ids.includes(id)) ids.push(id);
  return ids;
}

function briefClaim(engine: MemoryEngine, claim: Claim, view: RgView, reason: BriefClaimReason): BriefClaim {
  return {
    claimId: claim.id,
    statement: claim.statement,
    tier: claim.tier,
    status: claim.status,
    confidence: claim.confidence,
    epistemic: claim.epistemic,
    supportIds: evidenceOf(engine, claim.id, view, "supports"),
    refuteIds: evidenceOf(engine, claim.id, view, "refutes"),
    reason,
    groupKey: engine.rg.registry.memberOf(claim.id)?.groupKey ?? null,
    ...(claim.needsReview ? { needsReview: true } : {}),
  };
}

/** 结论之间的层级先后（同 brief 挑的先后：需求、价值观在前）和把握高低的数 */
const TIER_ORDER: Readonly<Record<ClaimTier, number>> = { need: 0, value: 1, preference: 2, state: 3 };
const CONFIDENCE_ORDER: Readonly<Record<Claim["confidence"], number>> = { low: 0, medium: 1, high: 2 };

/**
 * 222 号票：结论之间按和问题的相关程度排，候选来源不变。先看它的支持证据在 C 组检索里的最好名次（rank，越小越相关；
 * 一条都不在前 BRIEF_RANK_DEPTH 条里的算最差）；direct 的往前挪 BRIEF_DIRECT_BONUS 名——名次差得不多时压得过去，
 * 差得多时压不过（一长串 direct 占不满名额）。名次相同按三条路合并的分（score，model.needs 等里的分），再按层级和把握；
 * 都一样时保持传进来的顺序（direct、任务调出来的、每层、同一方面）。
 */
export function orderClaims(claims: readonly BriefClaim[], rank: ReadonlyMap<string, number>, score: ReadonlyMap<string, number>): BriefClaim[] {
  const strength = (c: BriefClaim): number => {
    let best = Number.POSITIVE_INFINITY;
    for (const id of c.supportIds) {
      const r = rank.get(id);
      if (r !== undefined && r < best) best = r;
    }
    return best === Number.POSITIVE_INFINITY ? best : c.reason === "direct" ? best - BRIEF_DIRECT_BONUS : best;
  };
  return claims
    .map((claim, i) => ({ claim, i, strength: strength(claim), score: score.get(claim.claimId) ?? 0 }))
    .toSorted(
      (a, b) =>
        (a.strength < b.strength ? -1 : a.strength > b.strength ? 1 : 0) ||
        b.score - a.score ||
        TIER_ORDER[a.claim.tier] - TIER_ORDER[b.claim.tier] ||
        CONFIDENCE_ORDER[b.claim.confidence] - CONFIDENCE_ORDER[a.claim.confidence] ||
        a.i - b.i,
    )
    .map((x) => x.claim);
}

/** 去掉标点、符号和空白后再比（"去掉标点后互相包含"） */
const NOISE = /[\s\p{P}\p{S}]/gu;
const plainStatement = (s: string) => s.replace(NOISE, "");
const NEAR_DUPLICATE = 0.8;

/** 两段文字的字符二元组重合度（Dice）：0 是完全不一样，1 是只差标点 */
function overlap(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i + 1 < a.length; i += 1) {
    const g = a.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let shared = 0;
  for (let i = 0; i + 1 < b.length; i += 1) {
    const g = b.slice(i, i + 2);
    const n = grams.get(g) ?? 0;
    if (n > 0) {
      shared += 1;
      grams.set(g, n - 1);
    }
  }
  return (2 * shared) / (a.length - 1 + b.length - 1);
}

/** 判断极性时先护住的词：里面有否定字，但不是否定（"非常喜欢"不是"常喜欢"的反面） */
const NON_NEGATIONS = ["非常", "非但", "非得", "特别", "别的", "别人", "告别", "分别", "区别", "级别", "类别", "性别", "无论", "无聊", "无比", "无奈", "不错", "不少", "不但", "不管"];

/** 否定词：长的在前（"没有"算一个否定，不算"没"+"有"）。"有"单独拿掉，好让"没有朋友 / 无朋友"和"有朋友"对得上 */
const NEGATED = /没有|不|没|别|未|无|非/g;
const HAVING = /有/g;

/** 一条陈述去掉否定词之后的骨架、否定词的个数（先去掉标点，护住不是否定的词） */
function polarityOf(statement: string): { base: string; negations: number } {
  let text = plainStatement(statement);
  NON_NEGATIONS.forEach((word, i) => {
    text = text.split(word).join(String.fromCharCode(0xe000 + i));
  });
  const negations = (text.match(NEGATED) ?? []).length;
  return { base: text.replace(NEGATED, "").replace(HAVING, ""), negations };
}

/**
 * 228 号票：两条陈述只差否定词（不、没、没有、别、未、无、非）时算极性相反——去掉标点、否定词以后逐字相同，
 * 否定词的个数一个奇数、一个偶数（双否定当肯定，当同一边）。不剥的话，222 的"去掉标点后互相包含、重合度到 0.8"
 * 会把"喜欢 X / 不喜欢 X"这种只差一个字的并成一条，少列一种说法；同组里相反的两条正是竞争解释，也不能并。
 * 正常陈述只要不是逐字只差否定词（"非常"这类含否定字却不是否定的词先护住），就不会被碰。
 */
function oppositePolarity(a: string, b: string): boolean {
  const x = polarityOf(a);
  const y = polarityOf(b);
  return x.base.length > 0 && x.base === y.base && x.negations % 2 !== y.negations % 2;
}

/** 两条陈述几乎一样：去掉标点后一条包含另一条，或者字面上的重合度到 0.8（222 号票）；极性相反的不算（228 号票） */
export function similarStatements(a: string, b: string): boolean {
  if (oppositePolarity(a, b)) return false;
  const x = plainStatement(a);
  const y = plainStatement(b);
  if (x.length === 0 || y.length === 0) return x === y;
  return x.includes(y) || y.includes(x) || overlap(x, y) >= NEAR_DUPLICATE;
}

/**
 * 222 号票：同一组里已经出现过的、或者陈述几乎一样的两条只留一条。留哪个：把握高的 > 组里占上风的 > 支持证据多的 >
 * 传进来在前面的（传进来之前已按 orderClaims 排过，所以最后一条是更贴题的）。交回留下的和去掉的条数
 * （去掉的照旧记进 claims 的 omitted 总条数，不另立一种）。228 号票：极性相反的两条（只差否定词）同一组里也不合并，
 * 那是两种竞争的解释，并掉就少列一种。
 */
export function dedupeClaims(claims: readonly BriefClaim[], winners: ReadonlySet<string> = new Set()): { claims: BriefClaim[]; dropped: number } {
  const kept: BriefClaim[] = [];
  const same = (a: BriefClaim, b: BriefClaim): boolean => !oppositePolarity(a.statement, b.statement) && ((a.groupKey !== null && a.groupKey === b.groupKey) || similarStatements(a.statement, b.statement));
  const better = (a: BriefClaim, b: BriefClaim): number =>
    CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence] || Number(winners.has(a.claimId)) - Number(winners.has(b.claimId)) || a.supportIds.length - b.supportIds.length;
  for (const c of claims) {
    const i = kept.findIndex((k) => same(k, c));
    if (i < 0) kept.push(c);
    else if (better(c, kept[i]!) > 0) kept[i] = c;
  }
  return { claims: kept, dropped: claims.length - kept.length };
}

/** 结论的开头：[编号] 层级 · 谁说的 · 状态 · 把握：陈述。 */
function claimHead(c: BriefClaim): string {
  const status = c.status === "active" && isThin({ confidence: c.confidence, tier: c.tier } as Claim) ? "证据还不够" : STATUS[c.status];
  return `[${c.claimId}] ${TIER[c.tier]} · ${EPISTEMIC[c.epistemic]} · ${status}${c.needsReview ? " · 复核中" : ""} · 把握${CONFIDENCE[c.confidence]}：${trimEnd(c.statement)}。`;
}

/** 竞争解释里的一种：开头 + 支持 n 条［前 4 个］；反对 m 条：编号「原话」（前 2 条） */
function claimLine(engine: MemoryEngine, c: BriefClaim, quoteChars: number, note = ""): Item {
  const shown = c.supportIds.slice(0, 4);
  const support = `支持 ${c.supportIds.length} 条${shown.length > 0 ? `［${shown.join("、")}${c.supportIds.length > shown.length ? " 等" : ""}］` : ""}`;
  const quoted = c.refuteIds.slice(0, 2);
  const quotes = quoted.map((id) => `${id}「${clip(engine.store.getEvidence(id)?.text ?? "", quoteChars)}」`);
  const refute = `反对 ${c.refuteIds.length} 条${quotes.length > 0 ? `：${quotes.join("；")}${c.refuteIds.length > quoted.length ? " 等" : ""}` : ""}`;
  return {
    text: `${claimHead(c)}${support}；${refute}${note}`,
    evidenceIds: [...shown, ...quoted],
    claimIds: [c.claimId],
  };
}

/**
 * "对用户的理解"里的一条（219）：开头 + 支持 n 条、反对 m 条 + 说明，下面一行一条原话（· 支持 [编号] 时间 · 谁说的：「原话」）。
 * 记录那节已经有的写"原话见记录"、上面的结论带过的（shown 里有）写"原话见上"，只写编号；写了原话的记进 shown
 */
function claimWithQuotes(c: BriefClaim, quotes: readonly BriefQuote[], note: string, quoteChars: number, inRecords: ReadonlySet<string>, shown: Set<string>): Item {
  const lines = [`- ${claimHead(c)}支持 ${c.supportIds.length} 条、反对 ${c.refuteIds.length} 条${note}`];
  for (const q of quotes) {
    const kind = q.polarity === "supports" ? "支持" : "反对";
    if (inRecords.has(q.evidenceId)) lines.push(`  · ${kind} [${q.evidenceId}]（原话见记录）`);
    else if (shown.has(q.evidenceId)) lines.push(`  · ${kind} [${q.evidenceId}]（原话见上）`);
    else {
      lines.push(`  · ${kind} [${q.evidenceId}] ${q.time} · ${q.label}：「${clip(q.text, quoteChars)}」`);
      shown.add(q.evidenceId);
    }
  }
  return { text: lines.join("\n"), evidenceIds: quotes.map((q) => q.evidenceId), claimIds: [c.claimId] };
}

/** 和问题最相关的支持、反对证据：按检索名次（rank，没有的排在后面、按原来的顺序），各取前几条 */
function quotesOf(engine: MemoryEngine, c: BriefClaim, rank: ReadonlyMap<string, number>, limits: BriefLimits): BriefQuote[] {
  const byRank = (ids: readonly string[]) =>
    ids
      .map((id, i) => ({ id, i, r: rank.get(id) ?? Number.MAX_SAFE_INTEGER }))
      .toSorted((a, b) => a.r - b.r || a.i - b.i)
      .map((x) => x.id);
  const quote = (id: string, polarity: BriefQuote["polarity"]): BriefQuote[] => {
    const e = engine.store.getEvidence(id);
    return e ? [{ evidenceId: id, polarity, time: briefTime(e.eventTime ?? e.observedAt), label: sourceLabel(e), text: e.text }] : [];
  };
  return [...byRank(c.supportIds).slice(0, limits.supportQuotes).flatMap((id) => quote(id, "supports")), ...byRank(c.refuteIds).slice(0, limits.refuteQuotes).flatMap((id) => quote(id, "refutes"))];
}

/** 原话一条条减（支持的比反对的多时先减支持的，各自先减不太相关的）：3+2 → 2+2 → 2+1 → 1+1 → 1+0 → 0+0 */
function trimmedQuotes(quotes: readonly BriefQuote[]): BriefQuote[][] {
  let s = quotes.filter((q) => q.polarity === "supports");
  let r = quotes.filter((q) => q.polarity === "refutes");
  const out: BriefQuote[][] = [];
  while (s.length + r.length > 0) {
    if (s.length > r.length) s = s.slice(0, -1);
    else r = r.slice(0, -1);
    out.push([...s, ...r]);
  }
  return out;
}

/** 一组里比较站得住的那条：成立、把握不低（同模板回答 rg/answer.ts 的判法）；没有就是还没分出来 */
const winnerOf = (members: readonly Claim[]) => members.find((c) => c.status === "active" && c.confidence !== "low");

/** 一组的成员（不含被取代的） */
function membersOf(engine: MemoryEngine, key: string): Claim[] {
  const g = engine.rg.groupView(key);
  if (!g) return [];
  return g.members.map((m) => engine.store.getClaim(m.claim.id)!).filter((c) => c !== undefined && c.status !== "superseded");
}

/** 组里能区分的问题：还没找到结果的追问在前 */
function probeOf(engine: MemoryEngine, key: string): string | null {
  const probes = engine.rg.registry
    .probesOf(key)
    .map((p) => engine.store.getProbe(p.probeId))
    .filter((p) => p !== undefined)
    .toSorted((a, b) => Number(a.outcome === "found") - Number(b.outcome === "found"));
  return probes[0]?.ask ?? null;
}

/**
 * 候选结论从哪来（266 号票）：all 是 D 组的全部（过了门槛的、任务调出来的、三条路每层最相关的、同一方面的）；
 * relevant 只要过了相关门槛的（直接说到这件事的、同一方面的）——每条消息的记忆简报用它，"有没有相关"只看本机检索和相关门槛
 */
export type BriefScope = "all" | "relevant";

async function buildProfile(
  engine: MemoryEngine,
  question: string,
  viewAt: string,
  context: string[] | undefined,
  rank: ReadonlyMap<string, number>,
  limits: BriefLimits,
  scope: BriefScope = "all",
): Promise<{ profile: BriefProfile; duplicates: number; gated: readonly GatedClaim[] }> {
  const rg = engine.rg;
  const store = engine.store;
  const view = rg.view(viewAt);
  // 同模板回答的推理那条路：C 组的检索（前 20 条）当往上走的起点，三条路找结论、过相关门槛
  const base = await rg.baseSearch(question, { at: viewAt, context, limit: UPWARD_HITS });
  const relevance = await relevantForQuestion(rg, question, { at: viewAt, context }, base);
  const isTask = classifyQuestion(question) === "task";
  const advice = isTask ? await engine.adviseTask(question, { at: viewAt, context }) : undefined;
  const hard = advice ? advice.hardConstraints.map((h) => store.getClaim(h.claimId)!).filter((c) => c !== undefined) : hardConstraintClaims(rg, viewAt, relevance.model.context);
  const hardIds = new Set(hard.map((c) => c.id));

  // 候选结论，按优先级
  const candidates: { claim: Claim; reason: BriefClaimReason }[] = [];
  const seen = new Set<string>();
  const add = (id: string, reason: BriefClaimReason) => {
    if (seen.has(id) || hardIds.has(id)) return;
    const claim = store.getClaim(id);
    if (!claim || claim.status === "retracted") return;
    seen.add(id);
    candidates.push({ claim, reason });
  };
  const m = relevance.model;
  for (const g of relevance.gated) if (g.direct) add(g.claimId, "direct");
  if (scope === "all") {
    if (advice) for (const i of [...advice.preferences, ...advice.motives]) add(i.claimId, "task");
    for (const e of [...m.needs, ...m.values, ...m.preferences, ...m.state]) add(e.claimId, "related");
  }
  for (const g of relevance.gated) if (!g.direct) add(g.claimId, "area");
  if (scope === "all") for (const u of [...m.uncertain, ...(advice?.uncertain ?? [])]) add(u.claimId, "related");

  // 组：还没分出胜负的单列；分出来了的，胜出的那条留在结论里（写明占上风），排除的跟在后面
  const groupKeys: string[] = [];
  for (const { claim } of candidates) {
    const key = rg.registry.memberOf(claim.id)?.groupKey;
    if (key && !groupKeys.includes(key)) groupKeys.push(key);
  }
  const undecided = new Set(groupKeys.filter((k) => winnerOf(membersOf(engine, k)) === undefined));
  const claims = candidates.filter(({ claim }) => {
    const key = rg.registry.memberOf(claim.id)?.groupKey;
    // 330 号票（R5）：猜测照样给（标明是猜测、把握多少）；标着复核的照真值状态给、标"复核中"
    return !(key && undecided.has(key));
  });
  const groups: BriefGroup[] = [...undecided].map((key) => {
    const members = membersOf(engine, key);
    return {
      key,
      description: rg.groupView(key)?.description ?? key,
      members: members.filter((c) => c.status !== "retracted").map((c) => briefClaim(engine, c, view, candidates.find((x) => x.claim.id === c.id)?.reason ?? "related")),
      excluded: members.filter((c) => c.status === "retracted").map((c) => ({ claimId: c.id, statement: c.statement, evidenceIds: c.retractedBy ? rg.evidenceOfTarget(c.retractedBy, view) : [] })),
      probe: probeOf(engine, key),
    };
  });

  // 222：结论之间按和问题的相关程度排，再同一组、近乎同文的去重；去掉的照旧记进 claims 的 omitted 总条数
  const scores = new Map<string, number>();
  for (const e of [...m.needs, ...m.values, ...m.preferences, ...m.state, ...m.uncertain]) scores.set(e.claimId, e.score);
  const winners = new Set<string>();
  for (const key of groupKeys) {
    const winner = winnerOf(membersOf(engine, key));
    if (winner) winners.add(winner.id);
  }
  const picked = dedupeClaims(orderClaims(claims.map(({ claim, reason }) => briefClaim(engine, claim, view, reason)), rank, scores), winners);

  return {
    profile: {
      claims: picked.claims.map((c) => ({ ...c, quotes: quotesOf(engine, c, rank, limits) })),
      groups,
      requirements: advice ? [...advice.explicit.requirements] : [],
      hardConstraints: hard.map((c) => briefClaim(engine, c, view, "direct")),
      strategies: (advice?.strategies ?? []).map((s) => ({ strategyId: s.strategyId, use: s.use, text: s.text, onGuess: s.onGuess, basisGone: s.basisGone })),
    },
    duplicates: picked.dropped,
    gated: relevance.gated,
  };
}

/** 组胜出、组里排除了几条的说明（结论那一行后面） */
function decidedNote(engine: MemoryEngine, c: BriefClaim, view: RgView): Item {
  if (!c.groupKey) return { text: "", evidenceIds: [], claimIds: [] };
  const members = membersOf(engine, c.groupKey);
  if (winnerOf(members)?.id !== c.claimId) return { text: "", evidenceIds: [], claimIds: [] };
  const excluded = members.filter((x) => x.status === "retracted").slice(0, 2);
  const others = members.filter((x) => x.id !== c.claimId && x.status !== "retracted").length;
  const parts = [`（同组 ${members.length} 种解释里占上风`];
  const ev: string[] = [];
  const cl: string[] = [];
  if (excluded.length > 0) {
    parts.push(
      `；已排除：${excluded
        .map((x) => {
          const ids = x.retractedBy ? engine.rg.evidenceOfTarget(x.retractedBy, view).slice(0, 2) : [];
          ev.push(...ids);
          cl.push(x.id);
          return `[${x.id}] ${trimEnd(x.statement)}${ids.length > 0 ? `（被 ${ids.join("、")} 推翻）` : ""}`;
        })
        .join("；")}`,
    );
  }
  if (others > 0) parts.push(`；还有 ${others} 种没完全排除`);
  return { text: `${parts.join("")}）`, evidenceIds: ev, claimIds: cl };
}

function renderGroup(engine: MemoryEngine, g: BriefGroup, limits: BriefLimits, quoteChars: number): Item {
  const lines = [`- 「${trimEnd(g.description)}」，几种说得通的解释还没分出来：`];
  const ev: string[] = [];
  const cl: string[] = [];
  for (const m of g.members.slice(0, limits.membersPerGroup)) {
    const it = claimLine(engine, m, quoteChars);
    lines.push(`  · 可能是：${it.text}`);
    ev.push(...it.evidenceIds);
    cl.push(...it.claimIds);
  }
  for (const x of g.excluded.slice(0, 2)) {
    const ids = x.evidenceIds.slice(0, 2);
    lines.push(`  · 已排除：[${x.claimId}] ${trimEnd(x.statement)}${ids.length > 0 ? `（被 ${ids.join("、")} 推翻）` : ""}`);
    ev.push(...ids);
    cl.push(x.claimId);
  }
  if (g.probe) lines.push(`  能区分的问题：${g.probe}`);
  return { text: lines.join("\n"), evidenceIds: ev, claimIds: cl };
}

/** 按顺序一条条放，放不下就跳过（整条），记下没放的条数 */
function fit(header: string, items: readonly Item[], maxChars: number): { kept: Item[]; dropped: number } {
  const kept: Item[] = [];
  let text = header;
  let dropped = 0;
  for (const it of items) {
    const next = `${text}\n${it.text}`;
    if (next.length > maxChars) {
      dropped += 1;
      continue;
    }
    text = next;
    kept.push(it);
  }
  return { kept, dropped };
}

const RECORDS_HEADER = "【记录】（检索到的、可能和问题有关的原话，按相关程度排；只有本人的能当依据）";
const PROFILE_HEADER =
  "【对用户的理解】（推理图谱里和这个问题相关的结论；\"推断的\"是二狗推出来的，不是用户说的；\"已验证\"是证据够了的，\"猜测\"是还没证实的——可以照着说、拿来推荐，说清是猜测，把握低的留余地（\"可能\"\"我猜\"），别说成用户说过的；每条下面是和问题最相关的支持、反对它的原话）";
const GROUPS_HEADER = "【还没分出胜负的解释】";
const EXPLICIT_HEADER = "【明说过的要求和禁忌】";
const NO_PROFILE = `${PROFILE_HEADER}\n推理图谱里没有和这个问题相关的结论。`;

/** 一条候选：渲染好的文字和编号，加上它是画像里的哪一条（放进去了才留在 profile 里） */
type ProfileItem = Item & { ref: { kind: "requirements" } | { kind: "hard"; claimId: string } | { kind: "strategy"; strategyId: string } | { kind: "claim"; claimId: string } | { kind: "group"; key: string } };

/**
 * 用户画像那几节：按优先级放（明说的要求和禁忌 > 结论连原话 > 竞争解释），一共不超过 profileChars，再按节的顺序排。
 * 放不下时先砍竞争解释、再砍结论的条数（整条连原话），原话最后砍：一条结论连原话都放不下时，才按优先级找第一条减原话减到放得下的（219）。
 * inRecords 是记录那节的证据（结论下面只写编号）；duplicates 是同一组、近乎同文去掉的条数（222，也算没放进来的）。
 * 交回放进去了的那几条（profile 只留它们，结论的 quotes 是实际写出来的）和没放进去的条数
 */
function renderProfile(
  engine: MemoryEngine,
  p: BriefProfile,
  view: RgView,
  limits: BriefLimits,
  inRecords: ReadonlySet<string>,
  duplicates = 0,
  noClaims = "（没有直接相关的结论）",
): { text: string; items: Item[]; profile: BriefProfile; omitted: { claims: number; groups: number } } {
  const explicit: ProfileItem[] = [];
  if (p.requirements.length > 0) explicit.push({ text: `- 这次明说的要求：${p.requirements.map((r) => `「${r}」`).join("")}——以这些为准，下面的偏好、需求、做法都不能推翻它`, evidenceIds: [], claimIds: [], ref: { kind: "requirements" } });
  for (const h of p.hardConstraints.slice(0, 3)) {
    const ids = h.supportIds.slice(0, 2);
    explicit.push({ text: `- 禁忌：[${h.claimId}] ${trimEnd(h.statement)}（${EPISTEMIC[h.epistemic]}）${ids.length > 0 ? `［${ids.join("、")}］` : ""}`, evidenceIds: ids, claimIds: [h.claimId], ref: { kind: "hard", claimId: h.claimId } });
  }
  for (const s of p.strategies.slice(0, 2))
    explicit.push({
      text: `- 交互策略（${s.use === "apply" ? "用户确认过，直接用" : "还没经用户确认"}${s.onGuess ? "；建在猜测上" : ""}${s.basisGone ? "；理由没了，等用户说还要不要" : ""}）：${s.text}`,
      evidenceIds: [],
      claimIds: [],
      ref: { kind: "strategy", strategyId: s.strategyId },
    });
  // 结论：说明（组里占上风、同一方面）先算好；原话写全还是只写编号要看前面放了哪些，每次重新渲染
  const entries = p.claims.slice(0, limits.claims).map((c) => {
    const note = decidedNote(engine, c, view);
    const extra = c.reason === "related" || c.reason === "area" ? "（同一方面，不一定直接说到这件事）" : "";
    return { claim: c, note, suffix: note.text + extra };
  });
  type ClaimPick = { entry: (typeof entries)[number]; quotes: BriefQuote[] };
  const claimItems = (picks: readonly ClaimPick[]): ProfileItem[] => {
    const shown = new Set<string>();
    return picks.map(({ entry, quotes }) => {
      const it = claimWithQuotes(entry.claim, quotes, entry.suffix, limits.quoteChars, inRecords, shown);
      return { text: it.text, evidenceIds: [...it.evidenceIds, ...entry.note.evidenceIds], claimIds: [...it.claimIds, ...entry.note.claimIds], ref: { kind: "claim", claimId: entry.claim.claimId } };
    });
  };
  const groupItems: ProfileItem[] = p.groups.slice(0, limits.groups).map((g) => ({ ...renderGroup(engine, g, limits, limits.quoteChars), ref: { kind: "group", key: g.key } }));
  // 按优先级试着放：每放一条重新算整段多长（节标题在那节有第一条时才算）
  const chosen = { explicit: [] as ProfileItem[], claims: [] as ClaimPick[], groups: [] as ProfileItem[] };
  const render = (c: typeof chosen) => {
    const claims = claimItems(c.claims);
    const parts: string[] = [];
    parts.push(claims.length > 0 ? [PROFILE_HEADER, ...claims.map((i) => i.text)].join("\n") : c.explicit.length + c.groups.length > 0 ? `${PROFILE_HEADER}\n${noClaims}` : NO_PROFILE);
    if (c.groups.length > 0) parts.push([GROUPS_HEADER, ...c.groups.map((i) => i.text)].join("\n"));
    if (c.explicit.length > 0) parts.push([EXPLICIT_HEADER, ...c.explicit.map((i) => i.text)].join("\n"));
    return parts.join("\n");
  };
  const tryAdd = <T>(list: T[], item: T) => {
    list.push(item);
    if (render(chosen).length <= limits.profileChars) return true;
    list.pop();
    return false;
  };
  for (const it of explicit) tryAdd(chosen.explicit, it);
  for (const entry of entries) tryAdd(chosen.claims, { entry, quotes: entry.claim.quotes ?? [] });
  if (chosen.claims.length === 0) {
    // 原话最后砍：一条结论都放不下时，按优先级找第一条，原话一条条减到放得下
    search: for (const entry of entries) for (const quotes of trimmedQuotes(entry.claim.quotes ?? [])) if (tryAdd(chosen.claims, { entry, quotes })) break search;
  }
  for (const it of groupItems) tryAdd(chosen.groups, it);

  const claimsKept = claimItems(chosen.claims);
  const kept = [...chosen.explicit, ...claimsKept, ...chosen.groups];
  const has = (pred: (r: ProfileItem["ref"]) => boolean) => kept.some((i) => pred(i.ref));
  const profile: BriefProfile = {
    claims: chosen.claims.map(({ entry, quotes }) => ({ ...entry.claim, quotes })),
    groups: p.groups.filter((g) => has((r) => r.kind === "group" && r.key === g.key)),
    requirements: has((r) => r.kind === "requirements") ? p.requirements : [],
    hardConstraints: p.hardConstraints.filter((h) => has((r) => r.kind === "hard" && r.claimId === h.claimId)),
    strategies: p.strategies.filter((s) => has((r) => r.kind === "strategy" && r.strategyId === s.strategyId)),
  };
  return {
    text: render(chosen),
    items: [...claimsKept, ...chosen.groups, ...chosen.explicit],
    profile,
    omitted: { claims: p.claims.length + duplicates - profile.claims.length, groups: p.groups.length - profile.groups.length },
  };
}

/**
 * 给回答器的记忆简报（见文件开头）。A、B、C：这组的记录；D：C 的记录 + 用户画像。
 * hits 不给就按 briefSearchOptions 自己搜（D 组搜 C 组的）；at 是问的时间，看记忆按问题里规划出的时间（同模板回答）。
 */
export async function memoryBrief(engine: MemoryEngine, question: string, options: MemoryBriefOptions): Promise<MemoryBrief> {
  const limits: BriefLimits = { ...BRIEF_LIMITS, ...options.limits };
  const at = options.at ?? engine.store.now();
  const viewAt = planQuery(question, at).at ?? at;
  const view = engine.rg.view(viewAt);
  const recordGroup: SearchMode = options.group === "hybrid_kg_rg" ? "hybrid_kg" : options.group;
  const hits = [...(options.hits ?? (await engine.search(question, briefSearchOptions(recordGroup, question, at, options.context))))];

  const candidates = hits
    .slice(0, limits.records)
    .map((h) => recordOf(engine, h.evidenceId, view, limits))
    .filter((r): r is BriefRecord => r !== undefined);
  const recordItems = candidates.map((r, i) => ({ record: r, item: renderRecord(r, i + 1, limits) }));
  const fitted = fit(RECORDS_HEADER, recordItems.map((x) => x.item), limits.recordChars);
  const records = recordItems.filter((x) => fitted.kept.includes(x.item)).map((x) => x.record);
  // 跳过了中间的条目时序号重排
  const recordsText = records.length === 0 ? `${RECORDS_HEADER}\n（没有检索到相关的记录）` : [RECORDS_HEADER, ...records.map((r, i) => renderRecord(r, i + 1, limits).text)].join("\n");
  const items: Item[] = [...fitted.kept];

  let profile: BriefProfile | null = null;
  let profileText = "";
  let omitted = { records: Math.max(0, hits.length - limits.records) + fitted.dropped, claims: 0, groups: 0 };
  if (options.group === "hybrid_kg_rg") {
    // 219：结论下面的原话按和问题的相关程度挑——C 组检索（记录那节的设置）往深里搜的名次
    const ranked = await engine.search(question, { ...briefSearchOptions("hybrid_kg", question, at, options.context), limit: BRIEF_RANK_DEPTH });
    const rank = new Map(ranked.map((h, i) => [h.evidenceId, i]));
    const built = await buildProfile(engine, question, viewAt, options.context, rank, limits);
    const rendered = renderProfile(engine, built.profile, view, limits, new Set(records.map((r) => r.evidenceId)), built.duplicates);
    profile = rendered.profile;
    profileText = rendered.text;
    items.push(...rendered.items);
    omitted = { ...omitted, ...rendered.omitted };
  }
  return {
    question,
    at,
    viewAt,
    context: options.context ?? [],
    group: options.group,
    records,
    profile,
    sections: { records: recordsText, profile: profileText },
    text: profileText ? `${recordsText}\n\n${profileText}` : recordsText,
    evidenceIds: uniq(items.flatMap((i) => i.evidenceIds)),
    claimIds: uniq(items.flatMap((i) => i.claimIds)),
    omitted,
    hits,
  };
}

// ───────────────────────── 每条消息的记忆简报（266 号票） ─────────────────────────
// 用户发来一句话时给秘书的那一份（守护进程追加在这一轮输入的尾部）：
// - 有没有相关只看本机检索和相关门槛（202、206 号票，relevance.ts），不调模型：三条路找到的结论里有"直接说到这件事"的才带；
//   只有"同一方面"的、什么都没过门槛的都不带；
// - 带什么：D 组"对用户的理解"那几节（renderProfile：结论连支撑它的原话、还没分出胜负的解释、明说过的要求和禁忌、交互策略），
//   候选只要过了门槛的（直接说到这件事的、同一方面的，BriefScope 的 relevant）——三条路每层最相关、没过门槛的不带，
//   记录那节（检索到的原话，总有 10 条）也不带；上限照 BRIEF_LIMITS（D 组那档，用户 2026-10-25 定）；
// - 同一段对话里带过、没变的不再带（known：键 → 指纹），只补新的；带过的在末尾写一句编号，秘书知道它们也相关。
//   指纹只有编号和哈希（结论的状态、把握、谁说的、说法；组的几种解释和能区分的问题；策略的说法），不带原话，可以存进事件。

/** 为什么带它：直接说到这件事、同一方面（只有领域对上）、明说过的禁忌、还没分出胜负的一组、任务能用的交互策略 */
export type MessageBriefReason = "direct" | "area" | "hard" | "undecided" | "strategy";

/** 简报里的一条：记带过没有的键、种类、为什么带、说到的结论、经哪几条路过的门槛 */
export interface MessageBriefItem {
  /** claim:<结论编号>（结论和禁忌）、group:<组>、strategy:<策略编号> */
  key: string;
  kind: "claim" | "hard" | "group" | "strategy";
  reason: MessageBriefReason;
  /** 说到的结论：结论、禁忌是它自己；组是还没排除的几种解释；策略没有 */
  claimIds: string[];
  /** 过门槛经的路（往上走、结论索引、领域）：结论是它自己的，组是几种解释的合起来；禁忌、策略没有 */
  routes: RouteName[];
}

export interface MessageBriefOptions {
  /** 现在，默认引擎的"现在" */
  at?: string;
  context?: string[];
  limits?: Partial<BriefLimits>;
  /** 这段对话里已经带过的：键 → 指纹（上一次 MessageBrief.brought 攒起来的）；指纹没变的不再带 */
  known?: ReadonlyMap<string, string>;
}

export interface MessageBrief {
  /** 交给秘书的正文；不带（不相关、都带过了）是空串 */
  text: string;
  /** 过了相关门槛（有直接说到这件事的结论）；都带过了时也是 true */
  relevant: boolean;
  /** 放进正文的那些 */
  profile: BriefProfile;
  items: MessageBriefItem[];
  /** 这次带上的：键 → 指纹（并进 known，下一条用） */
  brought: Record<string, string>;
  /** 相关、但这段对话里带过又没变、这次没带的结论 */
  repeated: string[];
  /** 正文里出现的证据编号、结论编号 */
  evidenceIds: string[];
  claimIds: string[];
  /** 因为条数、字数上限没放进来的 */
  omitted: { claims: number; groups: number };
}

const digest = (parts: readonly string[]) => createHash("sha1").update(parts.join("\u0000")).digest("hex").slice(0, 12);
/** 结论的指纹：状态、把握、谁说的、说法变了就算变了（多了几条证据不算） */
const claimPrint = (c: BriefClaim) => digest(["claim", c.status, c.confidence, c.epistemic, c.statement]);
const groupPrint = (g: BriefGroup) => digest(["group", g.description, ...g.members.map((m) => `${m.claimId}:${m.status}:${m.confidence}:${m.statement}`), ...g.excluded.map((x) => `-${x.claimId}`), g.probe ?? ""]);
const strategyPrint = (s: BriefProfile["strategies"][number]) => digest(["strategy", s.use, s.text]);

/** 带过、没变的在末尾最多列几个编号（多了写"等 N 条"）：秘书知道它们也相关，又不占地方 */
export const MESSAGE_BRIEF_REPEATED_SHOWN = 8;

const EMPTY_PROFILE: BriefProfile = { claims: [], groups: [], requirements: [], hardConstraints: [], strategies: [] };

/** 不带的那一份：不相关（relevant false），或者相关的都带过了（repeated 是带过的） */
const nothing = (relevant: boolean, repeated: string[] = []): MessageBrief => ({
  text: "",
  relevant,
  profile: EMPTY_PROFILE,
  items: [],
  brought: {},
  repeated,
  evidenceIds: [],
  claimIds: [],
  omitted: { claims: 0, groups: 0 },
});

/** 每条消息的记忆简报（见上面）。不调模型，只查询和检索 */
export async function messageBrief(engine: MemoryEngine, text: string, options: MessageBriefOptions = {}): Promise<MessageBrief> {
  const limits: BriefLimits = { ...BRIEF_LIMITS, ...options.limits };
  const at = options.at ?? engine.store.now();
  const viewAt = planQuery(text, at).at ?? at;
  const view = engine.rg.view(viewAt);
  // 原话按和这句话的相关程度挑：C 组检索往深里搜的名次（同 memoryBrief 的 D 组）
  const ranked = await engine.search(text, { ...briefSearchOptions("hybrid_kg", text, at, options.context), limit: BRIEF_RANK_DEPTH });
  const rank = new Map(ranked.map((h, i) => [h.evidenceId, i]));
  const built = await buildProfile(engine, text, viewAt, options.context, rank, limits, "relevant");
  if (!built.gated.some((g) => g.direct)) return nothing(false);

  // 带过、没变的不再带
  const known = options.known ?? new Map<string, string>();
  const repeated = new Set<string>();
  const fresh = <T>(list: readonly T[], key: (x: T) => string, print: (x: T) => string, ids: (x: T) => readonly string[]) =>
    list.filter((x) => {
      if (known.get(key(x)) !== print(x)) return true;
      for (const id of ids(x)) repeated.add(id);
      return false;
    });
  const p = built.profile;
  const claims = fresh(p.claims, (c) => `claim:${c.claimId}`, claimPrint, (c) => [c.claimId]);
  const hard = fresh(p.hardConstraints, (c) => `claim:${c.claimId}`, claimPrint, (c) => [c.claimId]);
  const groups = fresh(p.groups, (g) => `group:${g.key}`, groupPrint, (g) => g.members.map((m) => m.claimId));
  const strategies = fresh(p.strategies, (s) => `strategy:${s.strategyId}`, strategyPrint, () => []);
  if (claims.length + hard.length + groups.length + strategies.length === 0) return nothing(true, [...repeated]);

  const again = [...repeated];
  const note =
    again.length === 0 ? "" : `（前面带过、没变的不再重复：${again.slice(0, MESSAGE_BRIEF_REPEATED_SHOWN).join("、")}${again.length > MESSAGE_BRIEF_REPEATED_SHOWN ? ` 等 ${again.length} 条` : ""}）`;
  const rendered = renderProfile(
    engine,
    { claims, groups, requirements: p.requirements, hardConstraints: hard, strategies },
    view,
    { ...limits, profileChars: limits.profileChars - (note === "" ? 0 : note.length + 1) },
    new Set(),
    built.duplicates,
    repeated.size > 0 ? "（相关的结论前面带过了，没变）" : undefined,
  );
  const kept = rendered.profile;
  const routesOf = (ids: readonly string[]): RouteName[] => {
    const routes = new Set(built.gated.filter((g) => ids.includes(g.claimId)).flatMap((g) => g.via.map((v) => v.route)));
    return ROUTES.filter((r) => routes.has(r));
  };
  const items: MessageBriefItem[] = [
    ...kept.claims.map((c): MessageBriefItem => ({ key: `claim:${c.claimId}`, kind: "claim", reason: c.reason === "direct" ? "direct" : "area", claimIds: [c.claimId], routes: routesOf([c.claimId]) })),
    ...kept.groups.map((g): MessageBriefItem => ({ key: `group:${g.key}`, kind: "group", reason: "undecided", claimIds: g.members.map((m) => m.claimId), routes: routesOf(g.members.map((m) => m.claimId)) })),
    ...kept.hardConstraints.map((c): MessageBriefItem => ({ key: `claim:${c.claimId}`, kind: "hard", reason: "hard", claimIds: [c.claimId], routes: [] })),
    ...kept.strategies.map((s): MessageBriefItem => ({ key: `strategy:${s.strategyId}`, kind: "strategy", reason: "strategy", claimIds: [], routes: [] })),
  ];
  const brought: Record<string, string> = {};
  for (const c of kept.claims) brought[`claim:${c.claimId}`] = claimPrint(c);
  for (const g of kept.groups) brought[`group:${g.key}`] = groupPrint(g);
  for (const c of kept.hardConstraints) brought[`claim:${c.claimId}`] = claimPrint(c);
  for (const s of kept.strategies) brought[`strategy:${s.strategyId}`] = strategyPrint(s);
  return {
    text: note === "" ? rendered.text : `${rendered.text}\n${note}`,
    relevant: true,
    profile: kept,
    items,
    brought,
    repeated: [...repeated],
    evidenceIds: uniq(rendered.items.flatMap((i) => i.evidenceIds)),
    claimIds: uniq([...rendered.items.flatMap((i) => i.claimIds), ...again.slice(0, MESSAGE_BRIEF_REPEATED_SHOWN)]),
    omitted: rendered.omitted,
  };
}
