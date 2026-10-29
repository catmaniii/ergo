// 每晚整理的预算按道花（270 号票）。线上 10-22 到 10-25 连着四夜"新证据 0 条"、积压到 87 条，查下来是三处叠在一起：
// 1. 模型版每夜把全部活着的组的全部追问按建组先后重判一遍（判证据一夜 139–169 次），而检索结果里大多没有新东西；
// 2. 新证据出的新组排在最后，前段（总数的 3/4，150 次）用光时轮不到，预算用完的追问还被写成"没找到"；
// 3. 记"整理过"是全有或全无：这一次预算被挡过一回，新证据一条都不记，下一夜从头再来，报告写"新证据 0 条"。
//
// 改成按道花（只管推理实现明确写了 exhaustive: false 的——模型版；规则版每次全部重来，照旧）：
//
//   道            用哪份预算                     做什么
//   newEvidence   前段（总数 × 3/4）减掉判回答     抽事实（新证据按时间先后）、给新的观察出假设、新组出追问；
//                 保底的那份，排第一              判证据：没问过的追问（新组的）先，再按检索结果里最早那条新证据的先后问旧追问
//   replies       保底一小份（271 号票）+ 新证据   每晚整理时判顺口问以后用户有没有在答（rg/reply-judge.ts）：一个问题一次调用；
//                 剩下的前段                      保底 = min(10, 这一夜要问模型的问题数)，从前段里划出来，新证据抢不走，
//                                                积压几夜也轮得到；新证据没用完的前段先给它，再给重跑旧追问
//   rejudge       前段里新证据、判回答剩下的       重跑旧追问：跑之前待复核的组、有到期复评结论的组（最久没复核的先）；
//                                                别的旧追问检索结果里没有新东西，不重判
//   lift          后 1/4 + 前段剩下的，减掉        往上抽和往上抽的组的追问（同样按道选：没问过的、有新证据的、待复核和到期的）
//                 给编策略留的那几次
//   predictions   剩下的（同样减掉编策略那几次）   判到期预测（每夜最多 10 条）
//   strategies    后 1/4 里先留的 4 次             编交互策略（引擎在 reflect 末尾）。334 号票：R4 让往上抽的组多了，判它们的证据
//                 （STRATEGY_RESERVE_CALLS，不到     把预算吃光、策略一条都编不出来；改成后 1/4 里先给它留几次，抽事实、判回答、
//                 4 次全留）+ 别的道剩下的          往上抽、判预测都用不到这几次（reasoning-graph.ts 的 usable）
//   对抗复核另算（227 / 263：每次 reflect 5 次，不占这份）。
//
// 新证据没有别的道排在它前面，所以前段（减掉判回答那一小份保底）就是它的保底：重跑旧追问一次也抢不走它的。
// 271 号票：夜里批量判回答排在新证据之后、重跑旧追问之前（上表 replies 一行）；reflect 在新证据那一道问完追问、重跑旧追问之前跑它
// （ReflectOptions.replies），报告和整理记录照样分道记。
//
// 一条新证据算"整理过"（rg_reflected）要这一夜它的那几步都做完了：抽事实没被预算挡住、出假设没被挡住、它进的新组出了追问，
// 欠它的追问都问过了（检索结果里有它的、它是观察的组里还没问过的）。整理完一条记一条，没轮到的留着下一夜按时间先后接着做。
//
// 272 号票：整理里还有两处每夜重复花钱——一直没进组的新观察每夜再拿去出一次假设、往上抽每夜把同一批没被用上的下层断言再问一遍
// （线上 10-25 一夜 9 次，试跑每夜 7 次）。模型版问过一次、模型回了话、又没进组的记在账上（rg_asked：签名是它当时的陈述、状态、
// 证据拼起来的散列），下一夜签名没变就不再当这一批问（照样作为别的观察、下层断言给摘要，可以和新的一起归组），有了新证据才再问。
import { createHash } from "node:crypto";
import { addDays, toMs } from "../domain/time.ts";
import type { Claim, Fact } from "../domain/types.ts";
import type { LiftInput, ModelBudget } from "./types.ts";

/** 复评水位：多少天没复核过算到期（227 号票定的；整理报告的"到期待复评"和重跑旧追问那一道都按它） */
export const REVIEW_DUE_DAYS = 30;

/**
 * 到期复评：成立的、从没复核过或者上一次复核在 30 天以前。
 * 272 号票：用户明说的（epistemic explicit）不算——它跟着用户的那句话走（那句话被纠正、忘掉、事实变了时由"明说的结论跟着事实走"那一步动它），
 * 不需要按时间复评；线上"到期待复评 106 条"全是明说的偏好，重跑旧追问那一道本来也管不到它们（不在组里、没有追问）
 */
export function isReviewDue(claim: Pick<Claim, "status" | "reviewedAt" | "epistemic">, at: string): boolean {
  if (claim.epistemic === "explicit") return false;
  return claim.status === "active" && (claim.reviewedAt === null || toMs(claim.reviewedAt) < toMs(addDays(at, -REVIEW_DUE_DAYS)));
}

/** 272 号票：问的那条现在的样子拼成的签名（散列：账上不存原文、证据 id）。变了才再问 */
export function askSignature(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

/** 出假设的一条观察的签名：陈述、肯定否定、状态、场景、背后的证据（同一条观察多了证据就变） */
export const observationSignature = (f: Pick<Fact, "predicate" | "statement" | "assertion" | "negated" | "status" | "context" | "evidenceIds">): string =>
  askSignature(["propose", f.predicate, f.statement, f.assertion, f.negated, f.status, f.context.toSorted(), f.evidenceIds.toSorted()]);

/** 往上抽的一条下层断言的签名：陈述、层、状态、把握、场景、支持它的证据和事实、反驳它的事实 */
export const premiseSignature = (i: Pick<LiftInput, "claim" | "scenes" | "supportEvidenceIds" | "supports" | "refutes">): string =>
  askSignature([
    "lift",
    i.claim.statement,
    i.claim.tier,
    i.claim.status,
    i.claim.confidence,
    i.scenes,
    i.supportEvidenceIds.toSorted(),
    i.supports.map((f) => f.id).toSorted(),
    i.refutes.map((f) => f.id).toSorted(),
  ]);

/** 一次整理里预算的几道（按先后） */
export const REFLECT_LANES = ["newEvidence", "replies", "rejudge", "lift", "predictions", "strategies"] as const;
export type ReflectLane = (typeof REFLECT_LANES)[number];

/** 一次整理按道花了几次模型调用（limit 是这次的上限；对抗复核另算，在 review.modelCalls） */
export type ReflectSpend = { limit: number } & Record<ReflectLane, number>;

export const emptySpend = (limit: number): ReflectSpend => ({ limit, newEvidence: 0, replies: 0, rejudge: 0, lift: 0, predictions: 0, strategies: 0 });

/** 两次整理合起来（每晚整理判完回答以后可能再整理一次）：上限、各道都相加 */
export function addSpend(a: ReflectSpend, b: ReflectSpend | undefined): ReflectSpend {
  if (!b) return { ...a };
  const out = emptySpend(a.limit + b.limit);
  for (const lane of REFLECT_LANES) out[lane] = a[lane] + b[lane];
  return out;
}

/** 按道记账：一段做完以后把这段用掉的次数记到某一道上（看的是同一份预算的 used） */
export function spendMeter(budget: Pick<ModelBudget, "used">, spend: ReflectSpend): <T>(lane: ReflectLane, fn: () => Promise<T>) => Promise<T> {
  return async (lane, fn) => {
    const before = budget.used;
    try {
      return await fn();
    } finally {
      spend[lane] += budget.used - before;
    }
  };
}

/** 这一夜一条追问的样子（选道用） */
export interface ProbeSlot {
  probeId: string;
  groupKey: string;
  /** 从来没问过（outcome 还是 open：新组的，或者上一次预算用完没轮到） */
  never: boolean;
  /** 第一轮检索结果里还没整理的新证据 */
  pendingHits: readonly string[];
  /** 这组的观察背后的证据（没问过的追问欠它们一次） */
  groupEvidence: readonly string[];
}

/**
 * 新证据这一道的追问（按先后）：没问过的先（照组、追问的先后）；再是检索结果里有新证据的旧追问，按其中最早那条新证据的先后
 * （order：新证据 id → 先后，越小越早），一样早的照原来的先后。别的不在这一道
 */
export function newEvidenceQueue(slots: readonly ProbeSlot[], order: ReadonlyMap<string, number>): ProbeSlot[] {
  const never = slots.filter((s) => s.never);
  const earliest = (s: ProbeSlot) => Math.min(...s.pendingHits.map((id) => order.get(id) ?? Number.POSITIVE_INFINITY));
  const touched = slots
    .map((s, i) => ({ s, i, at: earliest(s) }))
    .filter((x) => !x.s.never && x.s.pendingHits.length > 0)
    .toSorted((a, b) => a.at - b.at || a.i - b.i)
    .map((x) => x.s);
  return [...never, ...touched];
}

/** 一组在重跑旧追问那一道里排第几（越小越先）；不该重跑的是 undefined */
export interface RejudgeGroup {
  key: string;
  /** 组里有待复核的结论（跑之前标的） */
  needsReview: boolean;
  /** 组里到期复评的结论里最久没复核的那个时间（毫秒；从没复核过的按推出来的时间）；没有到期的是 null */
  dueSince: number | null;
}

/** 重跑旧追问这一道的组（按先后）：待复核的组（照原来的先后），再是有到期复评结论的组（最久没复核的先）；别的组不重跑 */
export function rejudgeOrder(groups: readonly RejudgeGroup[]): string[] {
  const review = groups.filter((g) => g.needsReview).map((g) => g.key);
  const due = groups
    .map((g, i) => ({ g, i }))
    .filter((x) => !x.g.needsReview && x.g.dueSince !== null)
    .toSorted((a, b) => a.g.dueSince! - b.g.dueSince! || a.i - b.i)
    .map((x) => x.g.key);
  return [...review, ...due];
}

/** 每条新证据欠哪几条追问：检索结果里有它的，加上它是观察的组里还没问过的 */
export function owedProbes(slots: readonly ProbeSlot[], pending: ReadonlySet<string>): Map<string, Set<string>> {
  const owed = new Map<string, Set<string>>();
  const owe = (evidenceId: string, probeId: string) => {
    if (!pending.has(evidenceId)) return;
    const set = owed.get(evidenceId) ?? new Set<string>();
    set.add(probeId);
    owed.set(evidenceId, set);
  };
  for (const s of slots) {
    for (const id of s.pendingHits) owe(id, s.probeId);
    if (s.never) for (const id of s.groupEvidence) owe(id, s.probeId);
  }
  return owed;
}

/** 这一夜整理完的新证据（照 pending 的先后）：没被挡住（blocked），欠的追问都问过了（asked） */
export function settledEvidence(pending: readonly string[], owed: ReadonlyMap<string, ReadonlySet<string>>, asked: ReadonlySet<string>, blocked: ReadonlySet<string>): string[] {
  return pending.filter((id) => !blocked.has(id) && [...(owed.get(id) ?? [])].every((probeId) => asked.has(probeId)));
}
