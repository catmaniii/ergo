// 带证据的回答（④ 号票第 6 条）：answer(question, { at, context, gate })。规则版用模板拼句子。
// 202 号票先分流（rg/question.ts），各走各的：
// - 事实回忆（"10 月 3 日参加了什么"）只走检索：找到的本人证据和它的精炼陈述，每句后面带证据 id。
//   前几条都和问题不挨着（rg/relevance.ts 的 hitSupported：没有话题词、余弦没超过这个问题的向量门槛——205 号票起按自带背景语料
//   校准，比随便一句闲聊更像才算）、或者说到的事实之间真冲突（事实图谱判的
//   "同时间同场景互相排斥"）时明说"不确定"，并说缺什么证据；
// - 关于自己的判断（"我是不是……"）、为什么：查用户模型和推理图谱——196 号票的三条路（relevantUserModel）找断言，过相关门槛
//   （relevance.ts）的才拿来用，对不上就当没有，不硬挑一组。找到的那组竞争假设分出来了就说比较可能的解释、反证、已经排除的、
//   还没排除的；相关的需求、价值观（往上抽出来的）一起说；没分出来、只有还拿不准的就明说"不确定"，给出能区分的追问（问具体的事，
//   不问动机）；什么都没过门槛就说"证据不够"、缺什么，只列找到的相关记录。只是同一方面（领域对上）的断言当背景列出，不靠它下结论；
// - 任务和建议（"帮我……"）：走 adviseTask（196 号票），这次明说的要求排第一，下面几层推翻不了它。
// 只有本人的有效证据当依据；别人转述的单独说一句"不当依据"。
// 每条引用带角色（192 号票）：结论、用户说过的、记录、还没排除的、已经排除的、反证，评测按角色分"断言了什么"。
import { validAt } from "../domain/time.ts";
import type { Claim, ClaimTier, Fact } from "../domain/types.ts";
import type { Hit } from "../retrieval/types.ts";
import type { AdviceItem } from "./advice.ts";
import { cite, contextPhrase } from "./concepts.ts";
import { classifyQuestion, topicTerms } from "./question.ts";
import type { ReasoningGraph } from "./reasoning-graph.ts";
import { explicitSameMatter, hitSupported, questionVectorGate, relevantForQuestion, type VectorGate } from "./relevance.ts";
import { claimsForSearch, expandWithClaims } from "./rg-search.ts";
import type { Answer, AnswerOptions, Citation, CitationRole, RgView } from "./types.ts";
import { DEFAULT_PER_TIER, isThin, UPWARD_HITS } from "./value-retrieval.ts";

/** 为什么类、什么都没找到时给的追问：问最近一次的具体情况 */
export const GENERIC_PROBE = "最近一次是什么情况？当时在忙什么、那件事是谁安排的、换个时间会不会去？";

/** 关于自己的判断、什么都没找到时给的追问：问具体的事，不问动机 */
export const SELF_PROBE = "最近一次和这件事有关的具体情况是什么样的？当时在做什么、和谁一起、是谁定的？";

/** 不确定时说缺什么（202 号票） */
export const MISSING = {
  record: "直接说到这件事的原话或做过的记录",
  ownRecord: "你自己说的或做过的记录（别人转述的不当依据）",
  resolve: "能分出哪个对的证据：最近一次的具体情况，或者你直接说哪个对",
  distinguish: "能区分这几种说法的具体情况（见下面的追问）",
  repeated: "几次同类的事（一两次下不了结论）",
  ownReason: "你自己说的原因",
  ownView: "你自己说过的看法",
} as const;

/** 事实回忆那条路用几条检索结果 */
export const RETRIEVAL_ANSWER_HITS = 5;
/** 推理那条路回答里带的检索结果（D 组） */
export const REASONING_ANSWER_HITS = 8;

const LABEL: Record<Claim["epistemic"], string> = { explicit: "你说的", inferred: "推断的", user_confirmed: "你确认过" };
const TIER_LABEL: Record<ClaimTier, string> = { state: "近期状态", preference: "偏好", need: "需求", value: "价值观" };

export async function answerQuestion(rg: ReasoningGraph, question: string, options: AnswerOptions): Promise<Answer> {
  const at = options.at ?? rg.store.now();
  const kind = classifyQuestion(question);
  if (kind === "task") return taskAnswer(rg, question, at, options);
  const view = rg.view(at);
  if (kind === "recall") {
    const hits = await rg.baseSearch(question, { at, context: options.context, limit: RETRIEVAL_ANSWER_HITS });
    const vector = await questionVectorGate(rg, question, at, options.gate);
    return answerFromHits(rg, question, hits, view, vector);
  }
  return reasoningAnswer(rg, question, kind, at, view, options);
}

function supportIds(rg: ReasoningGraph, claimId: string, view: RgView, polarity: "supports" | "refutes" = "supports"): string[] {
  const ids: string[] = [];
  for (const l of rg.store.linksOf(claimId)) if (l.polarity === polarity) for (const id of rg.evidenceOfTarget(l.target, view)) if (!ids.includes(id)) ids.push(id);
  return ids;
}

/** 成立的：不是还拿不准（contested）、证据也够（不是 low 的偏好、需求、价值） */
const established = (c: Claim) => c.status !== "contested" && !isThin(c);

const usableIds = (f: Fact, view: RgView) => f.evidenceIds.filter((id) => view.usableEvidence(id));

/** 说到的事实里和别的成立的事实真冲突的（事实图谱判的：同时间同场景互相排斥），每对只算一次 */
function conflictsAmong(citations: readonly Citation[], view: RgView): [Fact, Fact][] {
  const pairs: [Fact, Fact][] = [];
  const seen = new Set<string>();
  for (const c of citations) {
    const f = c.factId ? view.fact(c.factId) : undefined;
    if (!f || f.status !== "contested") continue;
    for (const pid of f.contestedWith) {
      const p = view.fact(pid);
      if (!p || (p.status !== "active" && p.status !== "contested") || !validAt(p, view.at) || usableIds(p, view).length === 0) continue;
      const key = [f.id, p.id].toSorted().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push([f, p]);
    }
  }
  return pairs;
}

/**
 * 只按检索结果拼的回答（不进推理图谱）：前几条里和问题挨着的本人证据和它们的精炼陈述，每句后面带证据 id。
 * 不确定（202 号票）：一条挨着的都没有（检索总会给满，排在前面不等于相关）、只有别人说的、或者说到的事实之间真冲突时明说，并说缺什么证据。
 * 事实回忆走它；评测里没有推理图谱的 A、B、C 组也用它（拿各组自己的检索结果，192 号票）——不确定的判法四组一样，消融只拿掉推理图谱。
 * minCosine 是这个问题的向量门槛（206 号票起是 questionVectorGate 算好的两道，也可以给一个数）；不给（null）时向量那一路不算挨着，只看话题词和图扩展。
 */
export function answerFromHits(rg: ReasoningGraph, question: string, hits: readonly Hit[], view: RgView, minCosine: VectorGate | number | null = null): Answer {
  const kind = classifyQuestion(question);
  const topic = topicTerms(question);
  const citations: Citation[] = [];
  const others: string[] = [];
  let weak = 0;
  for (const hit of hits) {
    const e = rg.store.getEvidence(hit.evidenceId);
    if (!e) continue;
    if (!hitSupported(hit, topic, view, minCosine)) {
      weak += 1;
      continue;
    }
    if (!view.usableEvidence(e.id)) {
      others.push(`${e.id}「${e.text}」`);
      continue;
    }
    const facts = view.factsOfEvidence(e.id);
    if (facts.length === 0) citations.push({ claimId: null, factId: null, evidenceIds: [e.id], text: `「${e.text}」`, role: "record" });
    for (const f of facts) citations.push({ claimId: null, factId: f.id, evidenceIds: [e.id], text: f.statement, role: "record" });
  }
  const hearsay = (lead: string) => (others.length > 0 ? `${lead}（不当依据）：${others.join("；")}。` : "");
  const base = { question, kind, route: "retrieval" as const, hits: [...hits] };
  if (citations.length === 0) {
    const missing = [others.length > 0 ? MISSING.ownRecord : MISSING.record];
    const why = others.length > 0 ? "没找到你自己说的或做过的相关记录" : weak > 0 ? `没找到和这个问题直接相关的记录（前 ${weak} 条字面对不上、意思也不够近）` : "没找到相关的记录";
    const text = `不确定：${why}。${hearsay("只有别人说的")}缺：${missing.join("；")}。`;
    return { ...base, text, certain: false, citations, probes: [], missing };
  }
  // 回答里只说前 5 条，引用也只留这 5 条（说了什么就引用什么）
  const shown = citations.slice(0, 5);
  const conflicts = conflictsAmong(shown, view);
  if (conflicts.length > 0) {
    const inConflict = new Set(conflicts.flatMap(([a]) => [a.id]));
    const cited: Citation[] = [];
    const lines: string[] = [];
    for (const [a, b] of conflicts) {
      const aIds = shown.filter((c) => c.factId === a.id).flatMap((c) => c.evidenceIds);
      const bIds = usableIds(b, view);
      cited.push({ claimId: null, factId: a.id, evidenceIds: aIds, text: a.statement, role: "open" }, { claimId: null, factId: b.id, evidenceIds: bIds, text: b.statement, role: "open" });
      lines.push(`${a.statement}${cite(aIds)}，但${b.statement}${cite(bIds)}`);
      inConflict.add(b.id);
    }
    const rest = shown.filter((c) => !c.factId || !inConflict.has(c.factId));
    const probes = rg.store
      .listProbes()
      .filter((p) => conflicts.some(([a, b]) => p.discriminates.includes(a.id) && p.discriminates.includes(b.id)))
      .slice(0, 2)
      .map((p) => ({ probeId: p.id, ask: p.ask }));
    const missing = [MISSING.resolve];
    const text =
      `不确定：记录之间互相矛盾——${lines.join("；")}。` +
      (rest.length > 0 ? `另有记录：${rest.map((c) => `${c.text}${cite(c.evidenceIds)}`).join("；")}。` : "") +
      hearsay("另有别人说的") +
      `缺：${missing.join("；")}。` +
      (probes.length > 0 ? `能区分的问题：${probes.map((p) => p.ask).join(" / ")}` : "");
    return { ...base, text, certain: false, citations: [...cited, ...rest], probes, missing };
  }
  const lines = shown.map((c) => `${c.text}${cite(c.evidenceIds)}`);
  const text = `根据记录：${lines.join("；")}。${hearsay("另有别人说的")}`;
  return { ...base, text, certain: true, citations: shown, probes: [], missing: [] };
}

async function reasoningAnswer(rg: ReasoningGraph, question: string, kind: "self" | "why", at: string, view: RgView, options: AnswerOptions): Promise<Answer> {
  const store = rg.store;
  const context = options.context;
  const base = await rg.baseSearch(question, { at, context, limit: UPWARD_HITS });
  const relevance = await relevantForQuestion(rg, question, { at, context, gate: options.gate }, base);
  const hits = await expandWithClaims(rg, question, { mode: "hybrid_kg_rg", at, context, limit: REASONING_ANSWER_HITS }, base, claimsForSearch(rg, relevance.gated));
  const claimsOf = (direct: boolean) =>
    relevance.gated
      .filter((g) => g.direct === direct)
      .map((g) => store.getClaim(g.claimId))
      .filter((c): c is Claim => c !== undefined);
  const direct = claimsOf(true);
  const area = claimsOf(false);

  const citations: Citation[] = [];
  const parts: string[] = [];
  const probes: Answer["probes"] = [];
  const missing: string[] = [];
  const say = (claim: Claim, prefix: string, ids: string[], role: CitationRole) => {
    citations.push({ claimId: claim.id, factId: null, evidenceIds: ids, text: claim.statement, role });
    return `${prefix}${claim.statement}${cite(ids)}`;
  };
  const counter = (claim: Claim, ids: string[]) => citations.push({ claimId: claim.id, factId: null, evidenceIds: ids, text: `${claim.statement}的反证`, role: "counter" });
  const addProbe = (probeId: string | null, ask: string) => {
    if (probes.length < 2 && !probes.some((p) => p.ask === ask)) probes.push({ probeId, ask });
  };

  const groupKey = direct.map((c) => rg.registry.memberOf(c.id)?.groupKey).find((k) => k !== undefined);
  const group = groupKey ? rg.groupView(groupKey) : undefined;
  const inGroup = new Set(group?.members.map((m) => m.claim.id) ?? []);
  const outside = (c: Claim) => !inGroup.has(c.id);
  const explicit = direct.filter((c) => outside(c) && c.epistemic !== "inferred" && established(c)).slice(0, 3);
  const related = direct.filter((c) => outside(c) && c.epistemic === "inferred" && established(c)).slice(0, DEFAULT_PER_TIER);
  const unsure = direct.filter((c) => outside(c) && !established(c)).slice(0, DEFAULT_PER_TIER);
  const sameArea = area.filter(outside).slice(0, DEFAULT_PER_TIER);
  let certain = false;
  let excludedPart: string[] = [];
  let groupOpen: Claim[] = [];
  /** 已经放在最前面"以你说的为准"说了的明说断言（205 号票：组没分出来时以明说的为准） */
  const led = new Set<string>();
  const quoteOf = (ids: readonly string[]) => {
    const text = ids.map((id) => store.getEvidence(id)?.text).find((t) => t !== undefined && t.length > 0);
    return text ? `——原话「${text}」` : "";
  };

  if (group) {
    const members = group.members.map((m) => store.getClaim(m.claim.id)!).filter((c) => c.status !== "superseded");
    const winner = members.find((c) => c.status === "active" && c.confidence !== "low");
    const open = members.filter((c) => c.status === "contested" || (c.status === "active" && c !== winner));
    const excluded = members.filter((c) => c.status === "retracted");
    if (winner) {
      certain = true;
      const lead = kind === "why" ? "比较可能的解释" : "比较站得住的看法";
      parts.push(say(winner, `${lead}（${LABEL[winner.epistemic]}，置信 ${winner.confidence}）：`, supportIds(rg, winner.id, view), "conclusion"));
      const against = supportIds(rg, winner.id, view, "refutes");
      if (against.length > 0) {
        counter(winner, against);
        parts.push(`也有不太一致的${cite(against)}`);
      }
      groupOpen = open;
    } else {
      // 明说的最权威（205 号票）：几种解释还没分出来，但用户明说过相关的话——以明说的为准、算有结论，引用那句原话；几种解释照样列。
      // 206 号票：那句明说的话要和这组说的是同一件事（同一批观察、共同的话题词、它自己的陈述过了门槛，三条之一），对不上的只跟在后面当"你说过"
      const viaOf = (c: Claim) => relevance.gated.find((g) => g.claimId === c.id)?.via ?? [];
      const sameMatter = explicit.filter((c) => explicitSameMatter(rg, c, group, relevance.topic, viaOf(c)).same);
      if (sameMatter.length > 0) {
        certain = true;
        for (const c of sameMatter) led.add(c.id);
        for (const c of sameMatter) {
          const ids = supportIds(rg, c.id, view);
          parts.push(say(c, "以你说的为准：", ids, "stated") + quoteOf(ids));
        }
        parts.push(`另外，${group.description}，几种说得通的解释还没分出来`);
      } else parts.push(`不确定：${group.description}，几种说得通的解释还没分出来`);
      for (const c of open) {
        const against = supportIds(rg, c.id, view, "refutes");
        if (against.length > 0) counter(c, against);
        parts.push(say(c, "可能是：", supportIds(rg, c.id, view), "open") + (against.length > 0 ? `，但有反证${cite(against)}` : ""));
      }
      for (const { probeId } of rg.registry.probesOf(group.key)) {
        const p = store.getProbe(probeId);
        if (p) addProbe(p.id, p.ask);
      }
      if (!certain) missing.push(MISSING.distinguish);
    }
    excludedPart = excluded.map((c) => {
      const by = c.retractedBy ? store.getFact(c.retractedBy) : undefined;
      const ids = c.retractedBy ? rg.evidenceOfTarget(c.retractedBy, view) : [];
      citations.push({ claimId: c.id, factId: by?.id ?? null, evidenceIds: ids, text: c.statement, role: "excluded" });
      return `已经排除：${c.statement}${by ? `——${by.statement}` : ""}${cite(ids)}`;
    });
  } else if (explicit.length + related.length > 0) {
    certain = true;
  } else if (unsure.length > 0) {
    parts.push("不确定：只有还拿不准的说法");
    for (const c of unsure) {
      const against = supportIds(rg, c.id, view, "refutes");
      if (against.length > 0) counter(c, against);
      const why = c.status === "contested" ? "和别的解释还没分出来" : "证据还不够";
      parts.push(say(c, "可能是：", supportIds(rg, c.id, view), "open") + `（${why}）` + (against.length > 0 ? `，有反证${cite(against)}` : ""));
    }
    for (const c of unsure) for (const p of discriminatingProbes(rg, c)) addProbe(p.probeId, p.ask);
    if (probes.length === 0) {
      const c = unsure[0]!;
      const rival = c.competesWith.map((id) => store.getClaim(id)).find((x) => x !== undefined && x.status !== "retracted");
      addProbe(null, rival ? `更接近「${c.statement}」，还是「${rival.statement}」？` : `「${c.statement}」——这样理解对吗？`);
    }
    missing.push(MISSING.distinguish);
  } else {
    parts.push(`不确定：证据不够，下不了结论${context && context.length > 0 ? `（${contextPhrase(context)}）` : ""}：用户模型和推理图谱里没有直接说到这件事的结论`);
    const ok = new Set(relevance.supportedHitIds);
    const facts = base.filter((h) => ok.has(h.evidenceId) && view.usableEvidence(h.evidenceId)).flatMap((h) => view.factsOfEvidence(h.evidenceId).map((f) => ({ f, ev: h.evidenceId })));
    for (const { f, ev } of facts.slice(0, 3)) {
      citations.push({ claimId: null, factId: f.id, evidenceIds: [ev], text: f.statement, role: "record" });
      parts.push(`只找到：${f.statement}${cite([ev])}`);
    }
    addProbe(null, kind === "why" ? GENERIC_PROBE : SELF_PROBE);
    missing.push(...(kind === "why" ? [MISSING.repeated, MISSING.ownReason] : [MISSING.ownView, MISSING.repeated]));
  }

  for (const c of related) parts.push(say(c, `相关的${TIER_LABEL[c.tier]}（${LABEL[c.epistemic]}，置信 ${c.confidence}）：`, supportIds(rg, c.id, view), "conclusion"));
  for (const c of explicit) if (!led.has(c.id)) parts.push(say(c, "你说过：", supportIds(rg, c.id, view), "stated"));
  parts.push(...excludedPart);
  for (const c of groupOpen) parts.push(say(c, "还没完全排除：", supportIds(rg, c.id, view), "open"));
  if (group || explicit.length + related.length > 0) for (const c of unsure) parts.push(say(c, "还拿不准：", supportIds(rg, c.id, view), "open"));
  for (const c of sameArea) parts.push(say(c, "同一方面还有（不一定和这个问题直接相关）：", supportIds(rg, c.id, view), "open"));
  const topic = relevance.topic;
  const others = hits
    .filter((h) => !view.usableEvidence(h.evidenceId) && store.getEvidence(h.evidenceId)?.status === "active" && hitSupported(h, topic, view, relevance.vectorThreshold))
    .map((h) => h.evidenceId);
  if (others.length > 0) parts.push(`别人转述的不当依据${cite(others)}`);
  if (!certain && missing.length > 0) parts.push(`缺：${missing.join("；")}`);
  if (probes.length > 0) parts.push(`能区分的问题：${probes.map((p) => p.ask).join(" / ")}`);
  return { question, kind, route: "reasoning", text: `${parts.join("。")}。`, certain, citations, probes, missing: certain ? [] : missing, hits };
}

/** 组里区分这条断言的追问（还没找到结果的在前） */
function discriminatingProbes(rg: ReasoningGraph, claim: Claim): { probeId: string; ask: string }[] {
  const member = rg.registry.memberOf(claim.id);
  if (!member) return [];
  return rg.registry
    .probesOf(member.groupKey)
    .map((p) => rg.store.getProbe(p.probeId))
    .filter((p) => p !== undefined && p.discriminates.includes(claim.id))
    .toSorted((a, b) => Number(a!.outcome === "found") - Number(b!.outcome === "found"))
    .map((p) => ({ probeId: p!.id, ask: p!.ask }));
}

/**
 * 任务和建议：交给 adviseTask（196 号票），明说的要求排第一；引用按各层的角色记。
 * 建议附了追问也算有结论（205 号票）：建议照常给了，追问只是补充，放在 probes 里。
 */
async function taskAnswer(rg: ReasoningGraph, question: string, at: string, options: AnswerOptions): Promise<Answer> {
  const advice = await rg.adviseTask(question, { at, context: options.context });
  const citations: Citation[] = [];
  const add = (i: AdviceItem, role: CitationRole) => citations.push({ claimId: i.claimId, factId: null, evidenceIds: i.evidenceIds, text: i.statement, role });
  for (const h of advice.hardConstraints) add(h, "stated");
  for (const p of advice.preferences) add(p, "stated");
  for (const m of advice.motives) add(m, m.label === "inferred" ? "conclusion" : "stated");
  for (const u of advice.uncertain) add(u, "open");
  const probes = advice.question ? [{ probeId: advice.question.probeId, ask: advice.question.ask }] : [];
  return { question, kind: "task", route: "advice", text: advice.text, certain: true, citations, probes, missing: [], hits: [], advice };
}
