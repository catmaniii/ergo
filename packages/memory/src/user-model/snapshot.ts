// 用户模型快照（第 4.4 节）：不单独存，从推理图谱算出来。
// 1. 取在 at 成立的断言（validFrom ≤ at < validTo）：状态 active，或者 superseded 而 at 还在它的有效期里（那时它是成立的）；
//    置信度至少 medium（近期状态可以是 low，标出来）；
// 2. 场景过滤：断言的场景和问的场景对得上（按维度比，kg/context.ts），或者断言不限场景。一个场景的偏好不推广到另一个场景；
// 3. 分三层：近期状态、偏好和目标、长期价值取向（need、value 合在这层），每条带"用户说的 / 推断的 / 你确认过的"和支持证据；
// 4. 还拿不准的单列：contested 的（猜测）附上竞争的那几条；active 但证据不够（不到 medium）的也列在这里。每条带真值状态、把握、谁说的
//    （330 号票 R5：猜测也给，标明是猜测、把握多少；二狗可以照着说，把握低的留余地）。retracted 的不进快照（第 7.3 节第 5 条）。
//    330 号票：标着复核的（依据刚变了，"待复核"不占真值状态）照它的真值状态给，标上 needsReview。
// 5. 交互策略（196 号票）：用户确认过的（rg/strategies.ts 的 activeStrategyEntries，只读）；330 号票（R6）起建在猜测上的也算，
//    依据被推翻了照旧在用（等用户回答"还要不要"），各标 onGuess、basisGone。
import { validAt } from "../domain/time.ts";
import type { Claim, ClaimStatus } from "../domain/types.ts";
import { contextsCompatible } from "../kg/context.ts";
import { evidenceBehind } from "../rg/scoring.ts";
import { activeStrategyEntries } from "../rg/strategies.ts";
import type { RgView, UncertainEntry, UserModel, UserModelEntry, UserModelQuery } from "../rg/types.ts";
import type { MemoryStore } from "../store/store.ts";

const LABEL: Record<Claim["epistemic"], UserModelEntry["label"]> = { explicit: "user_stated", inferred: "inferred", user_confirmed: "user_confirmed" };

/** 一条断言背后能当依据的支持证据 */
export function supportEvidence(store: MemoryStore, claimId: string, view: RgView): string[] {
  const ids: string[] = [];
  for (const link of store.linksOf(claimId)) {
    if (link.polarity !== "supports") continue;
    for (const id of evidenceBehind(link.target, view)) if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

export function userModelSnapshot(store: MemoryStore, view: RgView, query: UserModelQuery & { at: string }): UserModel {
  const context = query.context ?? [];
  const model: UserModel = { at: query.at, context, state: [], preferences: [], values: [], uncertain: [] };
  const fits = (c: Claim) => validAt(c, query.at) && (c.context.length === 0 || context.length === 0 || contextsCompatible(c.context, context));
  const statuses: ClaimStatus[] = ["active", "superseded", "contested"];
  for (const claim of store.listClaims({ status: statuses })) {
    if (!fits(claim)) continue;
    const evidenceIds = supportEvidence(store, claim.id, view);
    const thin = claim.confidence === "low" && claim.tier !== "state";
    if (claim.status === "contested" || (claim.status === "active" && thin)) {
      const competitors = claim.competesWith
        .map((id) => store.getClaim(id))
        .filter((c): c is Claim => c !== undefined && c.status !== "retracted")
        .map((c) => ({ claimId: c.id, statement: c.statement, status: c.status }));
      const entry: UncertainEntry = {
        claimId: claim.id,
        statement: claim.statement,
        tier: claim.tier,
        reason: claim.status === "contested" ? "contested" : "thin",
        status: claim.status,
        confidence: claim.confidence,
        label: LABEL[claim.epistemic],
        competesWith: competitors.map((c) => c.claimId),
        competitors,
        evidenceIds,
        ...(claim.needsReview ? { needsReview: true } : {}),
      };
      model.uncertain.push(entry);
      continue;
    }
    const entry: UserModelEntry = {
      claimId: claim.id,
      statement: claim.statement,
      tier: claim.tier,
      label: LABEL[claim.epistemic],
      confidence: claim.confidence,
      evidenceIds,
      context: claim.context,
      validFrom: claim.validFrom,
      validTo: claim.validTo,
    };
    if (claim.tier === "state" && claim.confidence === "low") entry.lowConfidence = true;
    if (claim.needsReview) entry.needsReview = true;
    if (claim.tier === "state") model.state.push(entry);
    else if (claim.tier === "preference") model.preferences.push(entry);
    else model.values.push(entry);
  }
  model.strategies = activeStrategyEntries(store, query.at, context);
  return model;
}
