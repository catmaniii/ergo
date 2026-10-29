// explainClaim、tracePremises（第 7.2 节）：结论、推法、前提链、支持证据和反证（带原文）、只当背景的、竞争假设、追问和结果、修订历史。
// 330 号票：猜测写明"为什么还是猜测"（哪条前提没证实、证据哪里不够，R5）；从它推出来的预测节点和结局（R10）。
import type { Claim, Evidence, PredictionRecord, StoredLink } from "../domain/types.ts";
import { storeLookup, unverifiedPremises } from "./graph-rules.ts";
import { idKind } from "../domain/ids.ts";
import { canSupportUserClaims } from "../evidence/boundary.ts";
import { cite } from "./concepts.ts";
import { effectiveWeight } from "./scoring.ts";
import type { ReasoningGraph } from "./reasoning-graph.ts";
import type { ClaimExplanation, EvidenceView, ExplainedLink, GuessReason, PremiseTrace } from "./types.ts";

/** 追溯的深度上限（断言 → 断言 → 事实 → 证据） */
export const MAX_TRACE_DEPTH = 8;

const TIER_LABEL: Record<Claim["tier"], string> = { state: "近期状态", preference: "偏好和目标", need: "稳定需求", value: "长期价值取向" };
const STATUS_LABEL: Record<Claim["status"], string> = { active: "已验证", contested: "猜测（没验证）", retracted: "已撤回", superseded: "已被取代" };
const EPISTEMIC_LABEL: Record<Claim["epistemic"], string> = { explicit: "用户说的", inferred: "推断的", user_confirmed: "你确认过" };
const WEIGHT_LABEL: Record<StoredLink["weight"], string> = { weak: "弱", strong: "强", decisive: "决定性" };

export function evidenceView(e: Evidence): EvidenceView {
  return {
    id: e.id,
    text: e.text,
    sourceLevel: e.sourceLevel,
    mode: e.mode,
    kind: e.kind,
    status: e.status,
    eventTime: e.eventTime,
    observedAt: e.observedAt,
    usable: canSupportUserClaims(e),
  };
}

function explainLink(rg: ReasoningGraph, link: StoredLink): ExplainedLink {
  const fact = rg.store.getFact(link.target);
  const ids = fact ? fact.evidenceIds : [link.target];
  const evidence = ids.map((id) => rg.store.getEvidence(id)).filter((e): e is Evidence => e !== undefined).map(evidenceView);
  return { ...link, statement: fact?.statement ?? null, evidence, counted: link.polarity === "context" ? link.weight : effectiveWeight(link, rg.view()) };
}

/** 关联的分量：随口说的"决定性"写明按强的算（R14） */
export function weightLabel(l: Pick<ExplainedLink, "weight" | "counted">): string {
  return l.counted !== undefined && l.counted !== l.weight ? `${WEIGHT_LABEL[l.weight]}，按${WEIGHT_LABEL[l.counted]}的算（不是当面确认的）` : WEIGHT_LABEL[l.weight];
}

export function tracePremises(rg: ReasoningGraph, claimId: string): PremiseTrace {
  if (!rg.store.getClaim(claimId)) throw new Error(`没有这条断言：${claimId}`);
  const walk = (id: string, depth: number, path: ReadonlySet<string>): PremiseTrace => {
    const kind = idKind(id);
    if (kind === "claim") {
      const c = rg.store.getClaim(id)!;
      const node: PremiseTrace = { id, kind: "claim", label: c.statement, status: c.status, premises: [] };
      if (depth >= MAX_TRACE_DEPTH) return { ...node, truncated: true };
      // 329 号票（R7）：改挂到直接证实以后，原来的推理链记作历史，前提链走现在的依据（只有历史的照旧走历史）
      const all = rg.store.inferencesOf(id);
      const current = all.filter((i) => i.status !== "history");
      const premises = [...new Set((current.length > 0 ? current : all).flatMap((i) => i.premiseIds))];
      node.premises = premises.filter((p) => !path.has(p)).map((p) => walk(p, depth + 1, new Set([...path, p])));
      return node;
    }
    if (kind === "fact") {
      const f = rg.store.getFact(id);
      if (!f) return { id, kind: "fact", label: "（没有这条事实）", status: "missing", premises: [] };
      return { id, kind: "fact", label: f.statement, status: f.status, premises: f.evidenceIds.map((ev) => walk(ev, depth + 1, path)) };
    }
    const e = rg.store.getEvidence(id);
    return { id, kind: "evidence", label: e ? e.text || "（原文已忘掉）" : "（没有这条证据）", status: e?.status ?? "missing", premises: [] };
  };
  return walk(claimId, 0, new Set([claimId]));
}

/** 一个 id 的陈述（结论、事实）或原文（证据），给人看 */
function labelOf(rg: ReasoningGraph, id: string): string {
  const kind = idKind(id);
  if (kind === "claim") return rg.store.getClaim(id)?.statement ?? id;
  if (kind === "fact") return rg.store.getFact(id)?.statement ?? id;
  return rg.store.getEvidence(id)?.text ?? id;
}

/**
 * 330 号票（R5）：一条猜测为什么还是猜测——推理链上没验证的前提（猜测、拿不准、撤回的；R4 铁律压着），加上证据哪里不够
 * （组里还没分出来、只剩它但反证不比支持少、它那组的条件不成立了、依据在重推、用户说的那句和别的话对不上）。不是猜测的是 null
 */
export function guessReason(rg: ReasoningGraph, claim: Claim): GuessReason | null {
  if (claim.status !== "contested") return null;
  const store = rg.store;
  const lookup = storeLookup(store);
  const premises = unverifiedPremises(lookup, claim.id).map((id) => ({ id, statement: labelOf(rg, id), status: lookup.statusOf(id) ?? "missing" }));
  let evidence: string | null = null;
  if (claim.epistemic === "explicit") evidence = "用户说的那句和别的话对不上（那条事实拿不准）";
  else if (!store.inferencesOf(claim.id).some((i) => i.status === "active")) evidence = "依据在重推（前提被删了）";
  else {
    const member = rg.registry.memberOf(claim.id);
    const group = member ? rg.registry.getGroup(member.groupKey) : undefined;
    if (group?.live) {
      const d = rg.decisionsFor(group.key, rg.view()).decisions.get(claim.id);
      if (d && d.status !== "active") evidence = d.reason;
    } else if (group) evidence = "它那组的条件不成立了（证据变少，没有推翻者），留成猜测";
  }
  if (premises.length === 0 && evidence === null) evidence = "等下一次整理按证据重判";
  return { unverifiedPremises: premises, evidence };
}

export function explainClaim(rg: ReasoningGraph, claimId: string): ClaimExplanation {
  const store = rg.store;
  const claim = store.getClaim(claimId);
  if (!claim) throw new Error(`没有这条断言：${claimId}`);
  const member = rg.registry.memberOf(claimId);
  const group = member ? rg.registry.getGroup(member.groupKey) : undefined;
  const links = store.linksOf(claimId).map((l) => explainLink(rg, l));
  const supports = links.filter((l) => l.polarity === "supports");
  const refutes = links.filter((l) => l.polarity === "refutes");
  const background = links.filter((l) => l.polarity === "context");
  const competitors = claim.competesWith.map((id) => store.getClaim(id)).filter((c): c is Claim => c !== undefined);
  const probes = store.listProbes().filter((p) => p.discriminates.includes(claimId));
  const premises = tracePremises(rg, claimId);
  const evidence = new Map<string, EvidenceView>();
  const collect = (t: PremiseTrace) => {
    if (t.kind === "evidence") {
      const e = store.getEvidence(t.id);
      if (e) evidence.set(e.id, evidenceView(e));
    }
    t.premises.forEach(collect);
  };
  collect(premises);
  for (const l of links) for (const e of l.evidence) evidence.set(e.id, e);
  const writes = rg.gate.recordsBySeq(claimId);
  const explanation: ClaimExplanation = {
    claim,
    group: group ? { key: group.key, pattern: group.pattern, description: group.description } : null,
    inferences: store.inferencesOf(claimId),
    supports,
    refutes,
    background,
    competitors,
    probes,
    premises,
    whyGuess: guessReason(rg, claim),
    predictions: store.listPredictions({ premiseId: claimId }),
    evidence: [...evidence.values()],
    revisions: [...store.revisions(claimId, "claim"), ...store.revisions(claimId, "link")]
      .toSorted((a, b) => a.seq - b.seq)
      .map((r) => {
        // 267 号票：每条修订标上是哪一次写留下的（谁写的、做什么、经谁转达）
        const record = writes.get(r.seq);
        return record ? { ...r, by: { actor: record.actor, op: record.op, via: record.via } } : r;
      }),
    text: "",
  };
  explanation.text = renderExplanation(explanation);
  return explanation;
}

const quote = (e: EvidenceView) => `${e.id}${e.usable ? "" : `（${e.sourceLevel}，不当依据）`}：「${e.text || "原文已忘掉"}」`;

function linkLine(l: ExplainedLink): string {
  const head = `  - [${weightLabel(l)}] ${l.rationale}`;
  return [head, ...l.evidence.map((e) => `      ${quote(e)}`)].join("\n");
}

function traceLines(t: PremiseTrace, indent: string): string[] {
  const label = t.kind === "evidence" ? `「${t.label}」` : t.label;
  return [`${indent}${t.id}（${t.status}）${label}${t.truncated ? " …（到深度上限）" : ""}`, ...t.premises.flatMap((p) => traceLines(p, `${indent}  `))];
}

const DERIVATION_LABEL: Record<PredictionRecord["derivation"], string> = { deductive: "演绎", defeasible: "可废止" };
const BLAME_LABEL: Record<NonNullable<PredictionRecord["blame"]>["mode"], string> = {
  culprit: "撤了错的那条前提",
  undetermined: "判不出是哪条前提错了，出了问题",
  counterexample: "前提都已验证，各挨一条反例、要弄清",
  counter: "来源各挨一条反证",
  exception: "嫌疑的几条用户都确认还对，算例外",
  none: "来源都已经不在了",
};

/** 一条预测节点的一行：推法、状态、结局 */
function predictionLine(p: PredictionRecord): string {
  const outcome =
    p.status === "open"
      ? `还开着（${p.dueAt?.slice(0, 10) ?? "没定"} 到期）`
      : p.status === "hit"
        ? `应验了（${p.evidenceId}；只刷新这一条，来源不因此变已验证）`
        : p.status === "miss"
          ? `落空了（${p.retractedBy}${p.blame ? `；${BLAME_LABEL[p.blame.mode]}${p.blame.claimIds.length > 0 ? `：${p.blame.claimIds.join("、")}` : ""}` : ""}）`
          : p.status === "void"
            ? `作废了（来源 ${p.retractedBy} 撤回了）`
            : "说不清";
  return `  - ${p.id}（${DERIVATION_LABEL[p.derivation]}，从 ${p.premiseIds.join("、")} 推出）「${p.predicts}」：${outcome}`;
}

/** 拼一段说明：结论、推法、前提链、支持和反证（带原文）、背景、竞争假设、追问 */
export function renderExplanation(x: ClaimExplanation): string {
  const c = x.claim;
  const lines = [
    `结论 ${c.id}：${c.statement}`,
    `  层：${TIER_LABEL[c.tier]}；${EPISTEMIC_LABEL[c.epistemic]}（${c.method}）；状态：${STATUS_LABEL[c.status]}${c.needsReview ? "（标着复核）" : ""}；置信度：${c.confidence}${c.context.length > 0 ? `；场景：${c.context.join("、")}` : ""}`,
    `  有效期：${c.validFrom ?? "不知道从什么时候"} 到 ${c.validTo ?? "现在"}`,
  ];
  if (c.retractedBy) lines.push(`  撤回它的：${c.retractedBy}`);
  if (x.whyGuess) {
    const parts = [
      ...(x.whyGuess.unverifiedPremises.length > 0 ? [`前提 ${x.whyGuess.unverifiedPremises.map((p) => `${p.id}「${p.statement}」（${STATUS_LABEL[p.status as Claim["status"]] ?? p.status}）`).join("、")} 没证实`] : []),
      ...(x.whyGuess.evidence ? [x.whyGuess.evidence] : []),
    ];
    lines.push(`  为什么还是猜测：${parts.join("；")}`);
  }
  if (c.supersededBy) lines.push(`  取代它的：${c.supersededBy}`);
  if (x.group) lines.push(`观察：${x.group.description}`);
  for (const inf of x.inferences) lines.push(`推断 ${inf.id}（${inf.method}，${inf.by}，${inf.status}）：前提 ${inf.premiseIds.join("、")}`);
  lines.push("前提链：", ...traceLines(x.premises, "  "));
  lines.push(`支持${cite(x.supports.flatMap((l) => l.evidence.filter((e) => e.usable).map((e) => e.id)))}：`, ...(x.supports.length > 0 ? x.supports.map(linkLine) : ["  （没有）"]));
  lines.push(`反证${cite(x.refutes.flatMap((l) => l.evidence.filter((e) => e.usable).map((e) => e.id)))}：`, ...(x.refutes.length > 0 ? x.refutes.map(linkLine) : ["  （没找到）"]));
  if (x.background.length > 0) lines.push("只当背景（不当依据）：", ...x.background.map(linkLine));
  if (x.competitors.length > 0) lines.push("竞争的假设：", ...x.competitors.map((o) => `  - ${o.id}（${STATUS_LABEL[o.status]}，${o.confidence}）${o.statement}`));
  if (x.predictions.length > 0) lines.push("从它推出来的预测：", ...x.predictions.map(predictionLine));
  if (x.probes.length > 0) {
    lines.push("判别性追问：");
    for (const p of x.probes) {
      const result = p.outcome === "found" ? `找到了 ${p.foundEvidenceIds.join("、")}` : p.outcome === "not_found" ? "没找到（不判负，inconclusive）" : "还没跑";
      lines.push(`  - ${p.id} ${p.ask}（区分 ${p.discriminates.join(" / ")}${p.ifFound ? `，找到了算 ${p.ifFound}` : ""}）：${result}`);
    }
  }
  return lines.join("\n");
}
