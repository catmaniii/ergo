// 227 号票：对抗复核（独立复核员不看结论、只从证据重推）。
//
// 为什么：整理时模型自己出假设、自己判证据，容易只找支持自己的东西。这一步另起一个复核员——不告诉它系统得出的结论，
// 只给它支持这条结论的证据原话，先让它写下"从这些观察能推出关于这个人的什么"（1 条），再给出候选结论让它判：
// {"support":"yes|no|unclear","why":"..."}。先写自己的推断再看候选，减少锚定。
//
// 规矩：
// - 抽样：tier 是 need/value、confidence 是 medium 或 high、status active、epistemic inferred 的结论；
// - 最多 5 条（单独 5 次模型调用预算，不算进 reflect 的预算），用光就记 budgetExhausted，剩下的下次整理接着判；
// - 每条一次调用；支持证据原话最多 8 条、带编号、打乱顺序（按结论 id 定种子，稳定可复现）；
// - no → 结论加复核标记（记修订，原因"对抗复核不一致"；329 号票起"待复核"不占真值状态，标记不改已验证 / 猜测，下一次整理重判）；
//   unclear 只计数；yes 不动；
// - 判过的记在 claim_reviews 表里，不重复判（yes 也记，但结论本身不动）。
//
// 放在 reflect 末尾：评测建库走 MemoryEngine.reflect()，这样评测里也跑得到；规则版不调模型（引擎没给复核模型）。
import type { Claim, ClaimReview } from "../domain/types.ts";
import { canSupportUserClaims } from "../evidence/boundary.ts";
import { unparsedReason, type ChatModel, type ChatRequest } from "../llm/chat.ts";
import { parseModelJson } from "../llm/json.ts";
import { type MemoryStore, rgSession, rgWriter } from "../store/store.ts";
import type { AdversarialReviewReport, DroppedOutput, ReviewInput, ReviewVerdict } from "./types.ts";

/** 一次整理里复核最多调几次模型（单独预算；用光的下次整理接着判） */
export const REVIEW_MAX_CALLS = 5;
/** 一条结论最多给复核员看几条支持证据原话 */
export const REVIEW_MAX_OBSERVATIONS = 8;
/** 复核的输出不长：一条推断、一个判断、一句理由 */
export const REVIEW_MAX_TOKENS = 800;

export const REVIEW_SYSTEM = `你是记忆系统的独立复核员。你看不到系统原来得出了什么结论，只能根据下面这些观察原话自己判断。规则：
- 只根据给你的观察原话，不编造；别人转述的、系统记的不能当依据；
- 第一步：先写下从这些观察能推出关于这个人的一条结论（写在 inference），不要猜系统想让你说什么；
- 第二步：再看候选结论，判断这些观察支不支持它：support 写 yes（支持）、no（不支持）、unclear（看不出来）；
- why 一句话说理由；
只输出 JSON：{"inference": "你从观察推出的结论", "support": "yes|no|unclear", "why": "一句话理由"}`;

/** 复核员的请求：先是打乱顺序的观察原话，再是候选结论（和推断分开，先写推断） */
export function reviewRequest(input: ReviewInput): ChatRequest {
  return {
    purpose: "review",
    system: REVIEW_SYSTEM,
    user: [
      "观察（编号是原话，顺序已打乱）：",
      ...input.observations.map((text, i) => `${i + 1}. ${text}`),
      "",
      "第一步：先写下从这些观察能推出关于这个人的一条结论（写在 inference），不要猜系统想让你说什么。",
      "",
      `第二步：候选结论：「${input.statement}」`,
      "判断上面的观察是否支持这条候选结论。",
      '只输出 JSON：{"inference": "...", "support": "yes|no|unclear", "why": "..."}',
    ].join("\n"),
    maxTokens: REVIEW_MAX_TOKENS,
  };
}

/** 解析复核员的判断：三个字段都要有、support 是那三种之一；不合格抛错（调用方记进 dropped，下次再判） */
export function parseReviewVerdict(content: string): ReviewVerdict {
  const parsed = parseModelJson(content);
  const support = parsed.support;
  if (support !== "yes" && support !== "no" && support !== "unclear") throw new Error(`support 应为 yes | no | unclear，现在是 ${JSON.stringify(support)}`);
  const why = typeof parsed.why === "string" ? parsed.why.trim() : "";
  if (why.length === 0) throw new Error("没有写 why");
  const inference = typeof parsed.inference === "string" ? parsed.inference.trim() : "";
  if (inference.length === 0) throw new Error("没有先写自己的推断（inference）");
  return { support, why, inference };
}

/** 按种子打乱（FNV-1a 哈希 + LCG；同一条结论每次整理看到的顺序一样，测试也稳定） */
export function shuffleWithSeed<T>(items: readonly T[], seed: string): T[] {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    const j = h % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * 一条结论的支持证据原话：顺着支持它的关联找到事实、再找到事实背后的证据；只留能当依据的本人有效证据。
 * 最多 8 条，按结论 id 打乱顺序
 */
export function reviewObservations(store: MemoryStore, claim: Claim): string[] {
  const ids: string[] = [];
  for (const link of store.linksOf(claim.id)) {
    if (link.polarity !== "supports") continue;
    const fact = store.getFact(link.target);
    for (const id of fact ? fact.evidenceIds : [link.target]) {
      if (ids.includes(id)) continue;
      const evidence = store.getEvidence(id);
      if (!evidence || !canSupportUserClaims(evidence) || evidence.text.trim().length === 0) continue;
      ids.push(id);
    }
  }
  return shuffleWithSeed(ids, claim.id)
    .slice(0, REVIEW_MAX_OBSERVATIONS)
    .map((id) => store.getEvidence(id)!.text.trim());
}

/** 要复核的结论：need/value、挺有把握、还成立、推断出来的，而且没复核过 */
function reviewable(claim: Claim): boolean {
  if (claim.tier !== "need" && claim.tier !== "value") return false;
  return claim.confidence !== "low" && claim.status === "active" && claim.epistemic === "inferred";
}

/** 判 no、已经加了复核标记的 */
export interface RejectedReview {
  claimId: string;
  why: string;
}

export interface ReviewOutcome {
  report: AdversarialReviewReport;
  rejected: RejectedReview[];
}

export interface AdversarialReviewOptions {
  store: MemoryStore;
  /** 这一夜整理的时间（记复核时间、修订时间） */
  at: string;
  /** 复核员（模型）；规则版没有就不复核 */
  model: ChatModel;
  /** 丢掉的模型输出记在这里 */
  dropped?: DroppedOutput[];
  /** 这一次最多调几次模型（默认 REVIEW_MAX_CALLS） */
  maxCalls?: number;
  /** 判 no、结论加了复核标记以后调用方要跟着做的 */
  onRejected?: (claim: Claim) => void;
}

/**
 * 对抗复核（见文件开头）：挑没复核过的 need/value 结论（这次整理新出的，加上上次预算用完没轮到的），
 * 一条一次调用，判 no 的加复核标记。单独的调用预算（默认 5 次），用光就停，剩下的等下一次整理
 * （claim_reviews 表保证判过的不重复判）。
 */
export async function adversarialReview(options: AdversarialReviewOptions): Promise<ReviewOutcome> {
  const { store, at, model } = options;
  const maxCalls = options.maxCalls ?? REVIEW_MAX_CALLS;
  const report: AdversarialReviewReport = { reviewed: [], rejectedByReview: [], unclear: 0, modelCalls: 0, budgetExhausted: false };
  const rejected: RejectedReview[] = [];
  const candidates = store.listClaims().filter((claim) => reviewable(claim) && !store.claimReviewed(claim.id));
  if (candidates.length === 0) {
    report.skipped = "没有要复核的结论（还没有新的 need/value 结论，或者都复核过了）";
    return { report, rejected };
  }
  let calls = 0;
  for (const claim of candidates) {
    const observations = reviewObservations(store, claim);
    if (observations.length === 0) continue;
    if (calls >= maxCalls) {
      report.budgetExhausted = true;
      break;
    }
    calls += 1;
    const request = reviewRequest({ claimId: claim.id, statement: claim.statement, observations });
    const response = await model.complete(request);
    let verdict: ReviewVerdict;
    try {
      verdict = parseReviewVerdict(response.content);
    } catch (err) {
      options.dropped?.push({ stage: "review", reason: unparsedReason(response, request, err), item: claim.id });
      continue;
    }
    report.reviewed.push(claim.id);
    store.recordClaimReview({ claimId: claim.id, verdict: verdict.support, why: verdict.why, inference: verdict.inference, at } satisfies ClaimReview);
    if (verdict.support === "no") {
      // 267 号票：经唯一写入口（标复核，夜班）；329 号票起只加复核标记，不改真值状态，往下的不动
      rgSession(store, { op: "mark_review", actor: "nightly", reason: `对抗复核不一致：${verdict.why}` }, () => {
        rgWriter(store).updateClaim(claim.id, { needsReview: true, reviewedAt: at }, { reason: "对抗复核不一致" });
        options.onRejected?.(claim);
      });
      report.rejectedByReview.push(claim.id);
      rejected.push({ claimId: claim.id, why: verdict.why });
    } else if (verdict.support === "unclear") {
      report.unclear += 1;
    }
  }
  report.modelCalls = calls;
  if (report.reviewed.length === 0 && !report.budgetExhausted) report.skipped = "没有能复核的结论（都没有支持它的证据原话）";
  return { report, rejected };
}
