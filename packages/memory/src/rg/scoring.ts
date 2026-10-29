// 假设的状态和置信度怎么从关联算出来（第 4.3、5、7.3 节）。规则版、模型版共用这一套，推理实现只管交关联。
//
// 关联的多重按证据权重记分（似然比取分贝，可加）：weak 3、strong 6、decisive 10。只算能当依据的（本人且有效）。
// - 一条假设有决定性的反证（用户明说的、纠正的；329 号票：反证要落地——拿不准的事实当不了推翻）、又没有决定性的支持 → 撤回
//   （retracted，retractedBy 指向那条反证，留墓碑）；
// - 一组里剩下的按"支持 − 反证"排：领先的比第二名多 6 分贝以上、自己是正的、而且至少有一条判别性的支持
//   （至少是强的，别的假设没有、或者在它那里更轻）→ active，
//   其余 contested（还活着，没被排除）；分不出来就全部 contested，理由写真正卡住的那几样（领先不到 6 分贝、领先的那条
//   不是正的、没有判别性的强支持——领先够了只缺判别性支持时不写"不到 6"）。只剩一条的，是正的就 active；
// - 搜不到不判负：没有找到的东西不扣分。
// 置信度只有 low、medium、high，再按 confidenceCap 封顶（推断的最多 medium；need、value 证据少、不跨时期和场景的最多 low）。
// 330 号票（ADR-0032）：
// - R14：随口说的不再自动算决定性——只有当面确认 / 否掉、回答了解你问题、用户的纠正、预测被证伪（link-sources.ts）算决定性，
//   别的"决定性"按强的算（6 分贝，不当推翻、也不当决定性的支持）；
// - R12：已验证碰上有分量的反例（落了地的强反证）先降回猜测、标复核，等弄清：反例以后又有够分量的支持（合起来 6 分贝以上，
//   只是例外）、或者用户当面确认过（当面确认的最有分量），才算弄清了，照旧已验证。
import { localDate, toMs } from "../domain/time.ts";
import type { Claim, ClaimStatus, Confidence, LinkWeight, StoredLink } from "../domain/types.ts";
import { confidenceAtMost, confidenceCap } from "../domain/validate.ts";
import { faceToFaceRationale } from "./link-sources.ts";
import type { RgView } from "./types.ts";

export const WEIGHT_DB: Readonly<Record<LinkWeight, number>> = { weak: 3, strong: 6, decisive: 10 };

/** 领先多少分贝才算分出来了（一条"冒烟的枪"） */
export const LEAD_DB = 6;

/** 纠正的证据优先于原来的推断：多重升一档 */
export function upgrade(weight: LinkWeight): LinkWeight {
  return weight === "weak" ? "strong" : "decisive";
}

/** 330 号票（R12）：一条有分量的反例（落了地、按 R14 算下来至少是强的反证） */
export interface Counterexample {
  target: string;
  rationale: string;
  /** 反例背后的证据最晚是什么时候的事（毫秒） */
  atMs: number;
}

export interface Tally {
  claimId: string;
  support: number;
  refute: number;
  net: number;
  supportTargets: string[];
  /** 每个支持目标的分贝（判别性：领先的那条在某个目标上比别的假设重） */
  supportDb?: Record<string, number>;
  refuteTargets: string[];
  /** 决定性的反证（有的话第一条） */
  decisiveRefute: StoredLink | undefined;
  decisiveSupport: boolean;
  /** 支持背后能当依据的证据 */
  supportEvidenceIds: string[];
  /** 支持的证据来自几个月份、几种场景（need、value 的门槛） */
  periods: number;
  contexts: number;
  /** 330 号票（R12）：有分量的反例 */
  counterexamples?: Counterexample[];
  /** 330 号票（R12、R14）：用户当面确认过（决定性的支持是当面的） */
  userConfirmed?: boolean;
  /** 330 号票（R12）：每条支持的分贝和它背后的证据最晚是什么时候的事（判"反例以后又有够分量的支持"） */
  supportTimes?: { db: number; atMs: number }[];
}

/**
 * 330 号票（R14）：计分时这条关联算多重——决定性的只有当面确认 / 否掉、回答、证伪、明说结论自己那条、用户的纠正，
 * 别的（随口说的、模型判的、追问判的）按强的算
 */
export function effectiveWeight(link: Pick<StoredLink, "weight" | "rationale" | "target">, view: RgView): LinkWeight {
  if (link.weight !== "decisive") return link.weight;
  if (faceToFaceRationale(link.rationale)) return "decisive";
  const behind = evidenceBehind(link.target, view);
  if (behind.some((id) => view.isCorrection(id))) return "decisive";
  return "strong";
}

/** 目标背后的证据最晚是什么时候的事（毫秒）；看不到证据的按 0 */
function latestMs(target: string, view: RgView): number {
  let ms = 0;
  for (const id of evidenceBehind(target, view)) {
    const e = view.evidence(id);
    if (e) ms = Math.max(ms, toMs(e.eventTime ?? e.observedAt));
  }
  return ms;
}

/** 关联的目标还能当依据吗：事实要成立过、是本人的；证据要本人且有效 */
function usableTarget(target: string, view: RgView): boolean {
  const fact = view.fact(target);
  if (fact) return fact.status !== "retracted" && fact.status !== "corrected" && view.usableFact(fact);
  return view.usableEvidence(target);
}

/** 反证落地了吗（能推翻）：事实成立或被新值取代（拿不准的不算）；证据有效 */
function landed(target: string, view: RgView): boolean {
  const fact = view.fact(target);
  if (fact) return fact.status === "active" || fact.status === "superseded";
  return view.usableEvidence(target);
}

/** 目标背后能当依据的证据 */
export function evidenceBehind(target: string, view: RgView): string[] {
  const fact = view.fact(target);
  if (fact) return fact.evidenceIds.filter((id) => view.usableEvidence(id));
  return view.usableEvidence(target) ? [target] : [];
}

export function tally(claimId: string, links: readonly StoredLink[], view: RgView): Tally {
  const t: Tally = {
    claimId,
    support: 0,
    refute: 0,
    net: 0,
    supportTargets: [],
    supportDb: {},
    refuteTargets: [],
    decisiveRefute: undefined,
    decisiveSupport: false,
    supportEvidenceIds: [],
    periods: 0,
    contexts: 0,
    counterexamples: [],
    userConfirmed: false,
    supportTimes: [],
  };
  const months = new Set<string>();
  const scenes = new Set<string>();
  for (const link of links) {
    if (link.polarity === "context" || !usableTarget(link.target, view)) continue;
    const weight = effectiveWeight(link, view);
    const db = WEIGHT_DB[weight];
    if (link.polarity === "supports") {
      t.support += db;
      t.supportTargets.push(link.target);
      t.supportDb![link.target] = Math.max(t.supportDb![link.target] ?? 0, db);
      t.supportTimes!.push({ db, atMs: latestMs(link.target, view) });
      if (weight === "decisive") {
        t.decisiveSupport = true;
        t.userConfirmed = true;
      }
      for (const id of evidenceBehind(link.target, view)) {
        if (!t.supportEvidenceIds.includes(id)) t.supportEvidenceIds.push(id);
        const e = view.evidence(id);
        if (e) months.add(localDate(e.eventTime ?? e.observedAt).slice(0, 7));
      }
      const fact = view.fact(link.target);
      const context = fact?.context ?? view.evidence(link.target)?.context ?? [];
      scenes.add(context.toSorted().join("+"));
    } else {
      t.refute += db;
      t.refuteTargets.push(link.target);
      // 329 号票：推翻（撤回）要反证落地——拿不准的事实（真冲突里的一边）是猜测，记分照算，但当不了决定性的推翻（原始推理图谱的 rebut）
      if (weight === "decisive" && !t.decisiveRefute && landed(link.target, view)) t.decisiveRefute = link;
      // 330 号票（R12）：落了地的强反证是有分量的反例
      else if (weight === "strong" && landed(link.target, view)) t.counterexamples!.push({ target: link.target, rationale: link.rationale, atMs: latestMs(link.target, view) });
    }
  }
  t.net = t.support - t.refute;
  t.periods = months.size;
  t.contexts = scenes.size;
  return t;
}

/** 一条假设在某个目标上的支持有多重（没记分贝的按"有就是 1"） */
function supportWeight(t: Tally, target: string): number {
  return t.supportDb?.[target] ?? (t.supportTargets.includes(target) ? 1 : 0);
}

export interface Decision {
  status: Extract<ClaimStatus, "active" | "contested" | "retracted">;
  /** 撤回时指向那条决定性的反证 */
  retractedBy: string | null;
  /** 一句话：为什么是这个状态（写进修订日志） */
  reason: string;
  /** 330 号票（R12）：证据够已验证，但碰上了还没弄清的有分量的反例（降回猜测、要标复核） */
  counterexample?: Counterexample;
}

/**
 * 330 号票（R12）：还没弄清的有分量的反例——用户当面确认过的不算（当面确认的最有分量）；反例以后又有够分量的支持
 * （合起来 LEAD_DB 以上：只是例外）的不算
 */
export function unresolvedCounterexamples(t: Tally): Counterexample[] {
  if (t.userConfirmed) return [];
  return (t.counterexamples ?? []).filter((c) => (t.supportTimes ?? []).filter((s) => s.atMs > c.atMs).reduce((sum, s) => sum + s.db, 0) < LEAD_DB);
}

/** 证据够已验证时再看反例（R12）：有没弄清的就降回猜测 */
function verified(t: Tally, reason: string): Decision {
  const [open] = unresolvedCounterexamples(t);
  if (!open) return { status: "active", retractedBy: null, reason };
  return { status: "contested", retractedBy: null, reason: `${reason}，但碰上有分量的反例 ${open.target}（${open.rationale}），先降回猜测、等弄清（R12）`, counterexample: open };
}

/** 一组竞争假设各自是什么状态（见文件开头） */
export function decideGroup(members: readonly Tally[]): Map<string, Decision> {
  const out = new Map<string, Decision>();
  const alive: Tally[] = [];
  for (const m of members) {
    if (m.decisiveRefute && !m.decisiveSupport) {
      out.set(m.claimId, { status: "retracted", retractedBy: m.decisiveRefute.target, reason: `决定性反证 ${m.decisiveRefute.target}：${m.decisiveRefute.rationale}` });
    } else {
      alive.push(m);
    }
  }
  if (alive.length === 1) {
    const only = alive[0]!;
    out.set(only.claimId, only.net > 0 ? verified(only, "竞争的假设都被排除了，只剩它") : { status: "contested", retractedBy: null, reason: "只剩它，但反证不比支持少" });
    return out;
  }
  const ranked = alive.toSorted((a, b) => b.net - a.net);
  const [leader, second] = ranked;
  if (leader && second) {
    const others = ranked.slice(1);
    // 判别性的支持至少要是强的（"冒烟的枪"）：弱的旁证、大家共有的观察分不出胜负
    const discriminating = leader.supportTargets.some((t) => supportWeight(leader, t) >= WEIGHT_DB.strong && others.some((o) => supportWeight(o, t) < supportWeight(leader, t)));
    const lead = leader.net - second.net;
    if (leader.net > 0 && lead >= LEAD_DB && discriminating) {
      out.set(leader.claimId, verified(leader, `领先第二名 ${lead} 分贝，有别的假设没有的支持`));
      for (const o of others) out.set(o.claimId, { status: "contested", retractedBy: null, reason: `落后 ${leader.claimId} ${leader.net - o.net} 分贝，还没被排除` });
      return out;
    }
    // 理由写真正卡住的那几样（领先够了、只是缺判别性的强支持时，不写成"不到 6"）
    const why = [
      lead >= LEAD_DB ? `领先 ${lead} 分贝` : `领先 ${lead} 分贝，不到 ${LEAD_DB}`,
      ...(leader.net > 0 ? [] : ["领先的那条反证不比支持少"]),
      ...(discriminating ? [] : ["没有别的假设没有的强支持"]),
    ];
    for (const m of ranked) out.set(m.claimId, { status: "contested", retractedBy: null, reason: `竞争的假设还没分出来（${why.join("，")}）` });
  }
  return out;
}

/** 置信度：按"支持 − 反证"和证据条数，再按第 4.3 节封顶 */
export function confidenceOf(claim: Pick<Claim, "tier" | "epistemic">, t: Tally): Confidence {
  const n = t.supportEvidenceIds.length;
  const raw: Confidence = t.net >= 12 && n >= 3 ? "high" : t.net >= 6 && n >= 2 ? "medium" : "low";
  const cap = confidenceCap({ tier: claim.tier, epistemic: claim.epistemic, supportCount: n, periods: t.periods, contexts: t.contexts });
  return confidenceAtMost(raw, cap) ? raw : cap;
}
