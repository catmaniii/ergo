// 预测账本（226 号票）：结论当时预测了什么、后来应验没有。
//
// - 记下来（recordPredictions）：这次整理新出的、变了的结论里，predicts 非空、tier 是 need 或 value、把握不是 low、还成立的，
//   没有开着的预测就建一条。made_at 是这一夜，due_at 需求层 +14 天、价值层 +30 天；同一结论只留一条开着的——
//   上一夜已经记过、还没判的不重复建（判完以后再改的结论算新的预测，另建一条）。
// - 到期判（judgeDuePredictions）：due_at <= at 且还开着的最多 10 条（MAX_DUE_PREDICTIONS），按到期先后。只喂给模型：
//   结论陈述、它写的 predicts、made_at 之后的新证据原话（最多 10 条，MAX_JUDGE_EVIDENCE）；模型回
//   {"outcome":"hit|miss|unclear","why":"..."}，写 status、judged_at、note，evidence_id 记喂进去的最新那条。
//   没有模型、预算用完、没有新证据、模型判不了（解析不了、说不清、出错）的一律留 open，下一夜再判。
// - 330 号票（R10，ADR-0032）：账本做成预测节点——从结论推出来（premiseIds，第一条是 claimId）、带推法（derivation：演绎 / 可废止）。
//   应验了只刷新这一条（hit：依据就是那条观察；"证实的不对称"，来源不因此变已验证，只算更可信）；
//   落空了先撤预测（miss，retractedBy 是证伪它的那条观察），再由调用方（onMiss，reasoning-graph.ts 的 predictionMissed）回头打来源：
//   演绎的撤错的那条前提（再按 R8 往上传）、判不出就出问题；可废止的来源只挨一条反证。来源被撤回，开着的预测跟着作废（void，R8），
//   来源复活它跟着回来（R11）——这一步在写入口每次写的末尾做（predictionsFollowSources），不用每个撤回的地方各记着。
//   除此以外不改结论的把握、状态、有效期。
// - 只有本人说的、做的能证实、证伪关于用户的结论（R3）：判的时候只喂本人有效的新证据，别人转述的不喂。
// - 两步都在 reflect() 末尾跑（ReflectReport.predictions），所以评测建库也跑得到；nightly 只负责在报告里展示。
// - 模型判用 PredictionJudge（真模型是 LlmPredictionJudge，测试用假模型）。提示词只让模型判"应验没有"、说是凭哪条证据，不喂别的东西。
import { addDays, toMs } from "../domain/time.ts";
import type { Claim, Derivation, PredictionBlame, PredictionRecord, PredictionStatus, RevisionCause } from "../domain/types.ts";
import { canSupportUserClaims, isVerdictEvidence } from "../evidence/boundary.ts";
import type { ChatModel, ChatRequest } from "../llm/chat.ts";
import { parseModelJson } from "../llm/json.ts";
import { type MemoryStore, rgSession, rgWriter, type RgWriter } from "../store/store.ts";

/** 到期时间：需求层 +14 天、价值观层 +30 天（票面定的） */
export const PREDICTION_DUE_DAYS: Readonly<Record<"need" | "value", number>> = { need: 14, value: 30 };
/** 到期判每夜最多几条 */
export const MAX_DUE_PREDICTIONS = 10;
/** 判的时候最多喂几条 made_at 之后的新证据 */
export const MAX_JUDGE_EVIDENCE = 10;
/** 模型写的预测最多几个字（超了留空，不因此丢这条解释） */
export const MAX_PREDICTION_CHARS = 30;

/** 这一步的统计（ReflectReport.predictions、NightlyReport.predictions） */
export interface PredictionStats {
  /** 这一夜新记了几条 */
  created: number;
  /** 这一夜判了几条（hit + miss + unclear） */
  judged: number;
  hit: number;
  miss: number;
  unclear: number;
  /** 判完还开着几条（全库，不只是这一夜到期的） */
  open: number;
  /** 330 号票：这一夜落空的往回打来源，各几条（没有落空的不写） */
  backprop?: BackpropStats;
}

/** 330 号票（R10）：落空以后往回打来源——撤了几条错的前提、可废止的挨了几条反证、判不出的几条预测、来源都已验证（挨反例）的几条 */
export interface BackpropStats {
  retracted: number;
  countered: number;
  undetermined: number;
  counterexamples: number;
}

/** 判预测的模型（真模型、假模型都实现这个）：判不了返回 null，留 open */
export interface PredictionJudge {
  judgePrediction(input: PredictionJudgeInput): Promise<PredictionVerdict | null>;
}

/** 交给模型判的东西：结论陈述、它写的 predicts、made_at 之后的新证据原话 */
export interface PredictionJudgeInput {
  claimId: string;
  statement: string;
  predicts: string;
  madeAt: string;
  evidence: { id: string; text: string; observedAt: string }[];
}

/** 判的结果：只认这三种（open 是没判成）；evidenceId 是模型说的"凭哪条证据"（330 号票，落空时就是证伪它的那条；不给按喂进去的最新那条） */
export interface PredictionVerdict {
  outcome: Extract<PredictionStatus, "hit" | "miss" | "unclear">;
  why: string;
  evidenceId?: string;
}

/** 预算（同 rg/types.ts 的 ModelBudget；这里不引它，免得和 rg/types 互相引） */
export interface PredictionBudget {
  take(): boolean;
}

/** 空统计 */
export const EMPTY_PREDICTION_STATS: PredictionStats = { created: 0, judged: 0, hit: 0, miss: 0, unclear: 0, open: 0 };

/** 结论的 predicts 拼成一条（几条用「；」连起来）；没有就是空串 */
export function predictsTextOf(claim: Claim): string {
  return claim.predicts
    .map((p) => (typeof p.claim === "string" ? p.claim.trim() : ""))
    .filter((text) => text.length > 0)
    .join("；");
}

/**
 * 330 号票（ADR-0032）：结论的陈述里有没有全称的说法（每次、从不、一定……）。只有这种结论推出"其中具体的一次"才可能是演绎；
 * 倾向（还会、大概、一般）一律是可废止的
 */
export const UNIVERSAL_MARKERS = /每次|每回|总是|总会|从不|从来不|从来没|一律|一定会|一向|永远|无论.{0,8}都/;

/**
 * 330 号票（ADR-0032 的"谁能标演绎"）：模型说是演绎、结论陈述里又真有全称说法，才记 deductive；别的一律 defeasible
 * （原始推理图谱：缺省按弱的算——把判断误当演绎，落空时会错撤来源）
 */
export function predictionDerivation(statement: string, claimed: unknown): Derivation {
  return claimed === "deductive" && UNIVERSAL_MARKERS.test(statement) ? "deductive" : "defeasible";
}

/** 结论上写的几条预测合成一条节点时的推法：每条都是演绎才是演绎（有一条可废止就按可废止） */
export function derivationOf(claim: Claim): Derivation {
  const written = claim.predicts.filter((p) => typeof p.claim === "string" && p.claim.trim().length > 0);
  return written.length > 0 && written.every((p) => p.derivation === "deductive") ? "deductive" : "defeasible";
}

/** 这一条结论该不该记账本（票面的四个条件 + predicts 非空） */
export function predictionEligible(claim: Claim): boolean {
  return (
    claim.status === "active" &&
    claim.confidence !== "low" &&
    (claim.tier === "need" || claim.tier === "value") &&
    predictsTextOf(claim).length > 0
  );
}

/** 模型写的预测过不过关：缺了、太长、不像预测（没有将来会怎样的说法、太短）的留空，不因此丢这条解释 */
export function modelPredictionText(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length === 0) return "";
  if (Array.from(text).length > MAX_PREDICTION_CHARS) return "";
  if (Array.from(text).length < 6) return "";
  // 要说出"接下来会看到什么"：有将来的说法、或者明确的两周窗口
  if (!/(?:会|还会|仍|仍然|再|下次|接下来|今后|以后|将来|两周|这周|下周|月底|下个|最近|预计|打算|准备|应该|愿意)/.test(text)) return "";
  return text;
}

/**
 * 记下来：这次整理新出的、变了的结论里符合条件的，没有开着的预测就建一条。
 * 返回新建的预测 id；同一条结论已经有开着的预测就不建（同一结论只留一条开着的）。
 */
export function recordPredictions(store: MemoryStore, claimIds: readonly string[], at: string): string[] {
  const created: string[] = [];
  for (const claimId of new Set(claimIds)) {
    const claim = store.getClaim(claimId);
    if (!claim || !predictionEligible(claim)) continue;
    if (store.listPredictions({ status: "open", claimId }).length > 0) continue;
    const predicts = predictsTextOf(claim);
    const days = PREDICTION_DUE_DAYS[claim.tier as "need" | "value"];
    const cause: RevisionCause = { evidenceId: claim.predicts[0]?.evidenceIds[0] ?? null, reason: `整理时记下这条结论的预测：${claim.statement}` };
    // 267 号票：经唯一写入口（记预测，夜班）
    const prediction = rgSession(store, { op: "predict", actor: "nightly", reason: `记下结论 ${claimId} 的预测` }, () => rgWriter(store).putPrediction(
      {
        claimId,
        premiseIds: [claimId],
        derivation: derivationOf(claim),
        retractedBy: null,
        blame: null,
        predicts,
        madeAt: at,
        dueAt: addDays(at, days),
        status: "open",
        evidenceId: null,
        judgedAt: null,
        note: "",
      },
      cause,
    ));
    created.push(prediction.id);
  }
  return created;
}

/**
 * made_at 之后、现在之前的新证据原话（最多 MAX_JUDGE_EVIDENCE 条，取最新的）；用户对结论的表态（263 号票）不是观察到的事，不算；
 * 330 号票（R3）：只有本人有效的证据能证实、证伪关于用户的预测，别人转述的不喂
 */
function newEvidenceAfter(store: MemoryStore, madeAt: string, at: string): PredictionJudgeInput["evidence"] {
  return store
    .listEvidence({ status: "active" })
    .filter((e) => canSupportUserClaims(e) && toMs(e.observedAt) > toMs(madeAt) && toMs(e.observedAt) <= toMs(at) && e.text.length > 0 && !isVerdictEvidence(e))
    .slice(-MAX_JUDGE_EVIDENCE)
    .map((e) => ({ id: e.id, text: e.text, observedAt: e.observedAt }));
}

/**
 * 到期判：due_at <= at 且开着的，按到期先后最多 limit 条（默认 MAX_DUE_PREDICTIONS）。
 * 没有模型、没有新证据、预算用完、模型判不了一律留 open；判了的写状态、判定时间、理由、证据。
 */
export async function judgeDuePredictions(
  store: MemoryStore,
  at: string,
  judge: PredictionJudge,
  options: { budget?: PredictionBudget; limit?: number; onMiss?: OnMiss } = {},
): Promise<PredictionStats> {
  const limit = options.limit ?? MAX_DUE_PREDICTIONS;
  const stats: PredictionStats = { ...EMPTY_PREDICTION_STATS };
  if (limit <= 0) {
    stats.open = store.listPredictions({ status: "open" }).length;
    return stats;
  }
  const due = store.listPredictions({ status: "open", dueBefore: at })
    .toSorted((a, b) => toMs(a.dueAt ?? a.madeAt) - toMs(b.dueAt ?? b.madeAt))
    .slice(0, limit);
  for (const prediction of due) {
    const claim = store.getClaim(prediction.claimId);
    // 结论没了（或者判不了）就留 open
    if (!claim) continue;
    const evidence = newEvidenceAfter(store, prediction.madeAt, at);
    // 没有新证据就不问模型：问了也只能猜
    if (evidence.length === 0) continue;
    // 预算每次调用扣一次；扣不到就停，下夜再判
    if (options.budget && !options.budget.take()) break;
    let verdict: PredictionVerdict | null = null;
    try {
      verdict = await judge.judgePrediction({
        claimId: claim.id,
        statement: claim.statement,
        predicts: prediction.predicts,
        madeAt: prediction.madeAt,
        evidence,
      });
    } catch {
      verdict = null;
    }
    if (!verdict) continue;
    const cited = verdict.evidenceId !== undefined && evidence.some((e) => e.id === verdict.evidenceId) ? verdict.evidenceId : undefined;
    const evidenceId = cited ?? evidence.at(-1)!.id;
    // 330 号票：落空 = 撤回这条预测（墓碑指证伪它的那条观察），再回头打来源（调用方给的 onMiss，在同一次写里）
    const missed = verdict.outcome === "miss";
    const blame = rgSession(store, { op: "predict", actor: "nightly", reason: `到期判预测 ${prediction.id}：${verdict.outcome}` }, () => {
      const updated = rgWriter(store).updatePrediction(
        prediction.id,
        { status: verdict.outcome, judgedAt: at, note: verdict.why, evidenceId, ...(missed ? { retractedBy: evidenceId } : {}) },
        { reason: missed ? `到期判：落空（${evidenceId} 证伪了它，撤回）` : `到期判：${verdict.outcome}`, evidenceId },
      );
      return missed ? options.onMiss?.(updated) : undefined;
    });
    stats.judged += 1;
    if (verdict.outcome === "hit") stats.hit += 1;
    else if (verdict.outcome === "miss") stats.miss += 1;
    else stats.unclear += 1;
    if (blame) {
      const b = (stats.backprop ??= { retracted: 0, countered: 0, undetermined: 0, counterexamples: 0 });
      if (blame.mode === "culprit") b.retracted += blame.claimIds.length;
      else if (blame.mode === "counter") b.countered += blame.claimIds.length;
      else if (blame.mode === "undetermined") b.undetermined += 1;
      else if (blame.mode === "counterexample") b.counterexamples += blame.claimIds.length;
    }
  }
  stats.open = store.listPredictions({ status: "open" }).length;
  return stats;
}

/** 330 号票：落空的预测回头打来源（在判它的那一次写里调），交回打了谁 */
export type OnMiss = (prediction: PredictionRecord) => PredictionBlame | undefined;

/** reflect 末尾调：先记下来，再到期判（没给模型就只记下来，到期预测留 open）；落空的经 onMiss 往回打来源 */
export async function runPredictions(
  store: MemoryStore,
  options: { at: string; claimIds: readonly string[]; judge?: PredictionJudge; budget?: PredictionBudget; dueLimit?: number; onMiss?: OnMiss },
): Promise<PredictionStats> {
  const created = recordPredictions(store, options.claimIds, options.at);
  const judged = options.judge
    ? await judgeDuePredictions(store, options.at, options.judge, { budget: options.budget, limit: options.dueLimit, onMiss: options.onMiss })
    : { ...EMPTY_PREDICTION_STATS, open: store.listPredictions({ status: "open" }).length };
  return {
    created: created.length,
    judged: judged.judged,
    hit: judged.hit,
    miss: judged.miss,
    unclear: judged.unclear,
    open: judged.open,
    ...(judged.backprop ? { backprop: judged.backprop } : {}),
  };
}

const LIVE_SOURCE: ReadonlySet<string> = new Set(["active", "contested"]);

/**
 * 330 号票（R8、R11 落到预测节点上）：这几条结论的状态这次变了——撤回了的，以它为来源、还开着的预测跟着作废（void，墓碑指它）；
 * 又活过来的（撤回 → 已验证 / 猜测），因它作废的预测、来源都还活着的回到开着。写入口在每次写的末尾调（同一次写里）
 */
export function predictionsFollowSources(store: MemoryStore, writer: RgWriter, claimIds: Iterable<string>): void {
  for (const claimId of new Set(claimIds)) {
    const claim = store.getClaim(claimId);
    if (!claim) continue;
    if (claim.status === "retracted") {
      for (const p of store.listPredictions({ status: "open", premiseId: claimId })) {
        writer.updatePrediction(p.id, { status: "void", retractedBy: claimId }, { reason: `来源 ${claimId} 撤回了，这条预测跟着作废（R8）` });
      }
    } else if (LIVE_SOURCE.has(claim.status)) {
      for (const p of store.listPredictions({ status: "void", retractedBy: claimId })) {
        if (!p.premiseIds.every((id) => LIVE_SOURCE.has(store.getClaim(id)?.status ?? ""))) continue;
        writer.updatePrediction(p.id, { status: "open", retractedBy: null }, { reason: `来源 ${claimId} 又站住了，这条预测跟着回来（R11）` });
      }
    }
  }
}

// ---------- 模型判 ----------

export const PREDICTION_SYSTEM = `你是记忆系统的推理器，判断一条早先写下的预测后来应验了没有。规则：
- 只看给你的证据（evidence_id、时间、原话），不编造；
- 预测到期了：证据里明明发生了预测说的事 → hit；明明没发生、或者发生了相反的事 → miss；证据不够、说不清 → unclear；
- why 一句话说明依据，不超过 40 个字；evidence_id 写你凭的是哪一条（只能用给你的 evidence_id；unclear 可以不写）；
只输出 JSON：{"outcome": "hit | miss | unclear", "why": "...", "evidence_id": "..."}`;

/** 判一条预测的请求：结论陈述、它写的 predicts、made_at 之后的新证据原话 */
export function predictionRequest(input: PredictionJudgeInput): ChatRequest {
  const lines = input.evidence.map((e) => `- ${e.id} ${e.observedAt.slice(0, 10)}「${e.text}」`);
  return {
    purpose: "prediction",
    system: PREDICTION_SYSTEM,
    user: [
      `结论（${input.claimId}）：${input.statement}`,
      `当时写的预测（${input.madeAt}）：${input.predicts}`,
      `这之后的新证据（最多 ${MAX_JUDGE_EVIDENCE} 条）：`,
      lines.join("\n") || "（没有）",
    ].join("\n"),
    maxTokens: 800,
  };
}

/** 用模型判（真模型、假模型都行）：解析不了、outcome 不认得、why 为空都返回 null（留 open，下夜再判） */
export class LlmPredictionJudge implements PredictionJudge {
  private readonly model: ChatModel;

  constructor(model: ChatModel) {
    this.model = model;
  }

  async judgePrediction(input: PredictionJudgeInput): Promise<PredictionVerdict | null> {
    try {
      const response = await this.model.complete(predictionRequest(input));
      const parsed = parseModelJson(response.content);
      const outcome = parsed.outcome;
      const why = typeof parsed.why === "string" ? parsed.why.trim() : "";
      if (outcome !== "hit" && outcome !== "miss" && outcome !== "unclear") return null;
      if (why.length === 0) return null;
      // 330 号票：凭的哪条证据（只认喂进去的）；不给、给错了按喂进去的最新那条
      const cited = typeof parsed.evidence_id === "string" && input.evidence.some((e) => e.id === parsed.evidence_id) ? parsed.evidence_id : undefined;
      return cited === undefined ? { outcome, why } : { outcome, why, evidenceId: cited };
    } catch {
      return null;
    }
  }
}
