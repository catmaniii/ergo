// 263 号票：用户对一条结论直接表态——对（confirm）、不对（reject）、拿不准（doubt）。线上是记忆管理员的 review_memory_claim 调它。
//
// 为什么要走这里，不直接改结论的状态：结论的状态每次整理都按关联重新算（scoring.ts）。直接改库，下一次整理计分就改回去了
// （改成成立的又变回"还拿不准"，撤回的又恢复成立）。所以用户的表态要变成计分认的东西：
// - 先记一条本人的表态证据（来源本人、说的、种类 approval；原文是固定的一句"用户说这条结论对：「陈述」"，出处 verdict:<结论 id>）。
//   这条证据**不抽事实**（engine.extractFacts 跳过它）：它不是用户原来的话，抽出来会和那条结论自己的依据重复计数；判预测时也不当新证据
//   （出处前缀和 isVerdictEvidence 在 evidence/boundary.ts）；
// - confirm：走 confirmClaim——标"你确认过"、记一条决定性的支持、重定那组；
// - reject：走 rejectClaim——记一条决定性的反证、重定那组（没有决定性的支持就撤回，墓碑指向这句表态）；
// - doubt：走 markClaimForReview——标待复核，下一次整理按现有的证据重判（证据撑得住就恢复，撑不住就撤回）。不记支持也不记反证；
// - 用户改主意（先说对、后说不对，或者后来说拿不准）：先前对这条结论的表态证据按"被这次纠正"处理（engine.correct，不再当依据，
//   原文留着当记录），收回了确认的标回推断的（推法照确认之前的）。只收回表态证据，不碰用户别的原话。
//
// 拒绝（抛 ClaimVerdictRefused，什么都不写）：
// - 被取代了的（改新的那条）；
// - 已经撤回的再说不对（没什么可改的）；
// - 撤回了的说对、说拿不准：只有当初是用户表态撤的才行（收回那句表态就恢复）；因为依据不在了、被用户明说的话反驳才撤回的，
//   不能直接改回——下一次整理有新证据会重新推；
// - 明说的断言说不对：它跟着用户说的那句话走（syncExplicit），直接撤了下一次整理又恢复；要改得纠正、忘掉那句话（交回它背后的证据）。
import type { Claim, EvidenceDraft, Method } from "../domain/types.ts";
import type { MemoryEngine } from "../engine.ts";
import { canSupportUserClaims, isVerdictEvidence, VERDICT_SOURCE_PREFIX } from "../evidence/boundary.ts";
import { USER_CONFIRMATION } from "./status-keeper.ts";

export const CLAIM_VERDICTS = ["confirm", "reject", "doubt"] as const;
/** 用户的表态：对、不对、拿不准 */
export type ClaimVerdict = (typeof CLAIM_VERDICTS)[number];

/** 表态证据原文的说法（固定的一句加结论陈述） */
const VERDICT_TEXT: Readonly<Record<ClaimVerdict, string>> = { confirm: "说这条结论对", reject: "说这条结论不对", doubt: "说这条结论拿不准" };

/** 没给原因时证据入库那条修订写什么 */
const VERDICT_NOTE: Readonly<Record<ClaimVerdict, string>> = { confirm: "用户确认这条结论", reject: "用户否认这条结论", doubt: "用户说这条结论拿不准" };

export interface ClaimVerdictOptions {
  /** 表态的时间（证据的发生、知道时间）；不给用引擎的时钟 */
  at?: string;
  /** 经谁转达（写进证据原文，比如"经记忆管理员"）；固定的说法，不放用户的原话 */
  via?: string;
  /** 为什么（写进修订记录：证据入库那条、拿不准时结论那条），比如管理员记下的用户怎么说的 */
  note?: string;
}

export interface ClaimVerdictResult {
  /** 表态以后的结论 */
  claim: Claim;
  /** 这次记的表态证据 */
  evidenceId: string;
  /** 收回了的先前表态（被这次纠正） */
  withdrawn: string[];
}

/** 拒绝的原因：被取代了、已经撤回了（或者不是表态撤的）、明说的 */
export type ClaimVerdictRefusal = "superseded" | "retracted" | "explicit";

/** 表态被拒（什么都没写）：code 说为什么；明说的断言带上它背后的证据（要改得纠正、忘掉它们） */
export class ClaimVerdictRefused extends Error {
  readonly code: ClaimVerdictRefusal;
  readonly claimId: string;
  readonly evidenceIds: string[];

  constructor(code: ClaimVerdictRefusal, claimId: string, message: string, evidenceIds: readonly string[] = []) {
    super(message);
    this.name = "ClaimVerdictRefused";
    this.code = code;
    this.claimId = claimId;
    this.evidenceIds = [...evidenceIds];
  }
}

/** 这条结论上还算数的表态证据（本人、有效、出处 verdict:），按关联的方向 */
function verdictsOn(engine: MemoryEngine, claimId: string, polarity: "supports" | "refutes"): string[] {
  const ids: string[] = [];
  for (const link of engine.store.linksOf(claimId)) {
    if (link.polarity !== polarity || ids.includes(link.target)) continue;
    const evidence = engine.store.getEvidence(link.target);
    if (evidence && isVerdictEvidence(evidence) && canSupportUserClaims(evidence)) ids.push(evidence.id);
  }
  return ids;
}

/** 撤回它的是一句还算数的表态证据（当初是用户说不对才撤的）；是就交回它的 id */
function retractedByVerdict(engine: MemoryEngine, claim: Claim): string | undefined {
  if (claim.retractedBy === null) return undefined;
  const evidence = engine.store.getEvidence(claim.retractedBy);
  return evidence && isVerdictEvidence(evidence) && canSupportUserClaims(evidence) ? evidence.id : undefined;
}

/** 明说的断言背后的证据（要撤得纠正、忘掉它们） */
function explicitEvidenceOf(engine: MemoryEngine, claimId: string): string[] {
  const factId = engine.rg.registry.explicitFactOf(claimId);
  const fact = factId === undefined ? undefined : engine.store.getFact(factId);
  return fact ? [...fact.evidenceIds] : [];
}

/** 确认之前的推法：从修订日志里找变成"你确认过"的那一次；找不到用它的推断记的推法 */
function methodBeforeConfirmation(engine: MemoryEngine, claimId: string): Method {
  const revision = engine.store
    .revisions(claimId, "claim")
    .toReversed()
    .find((r) => r.changes.epistemic?.to === "user_confirmed");
  const from = revision?.changes.method?.from;
  if (from === "deduction" || from === "induction" || from === "abduction") return from;
  const method = engine.store.inferencesOf(claimId)[0]?.method;
  return method === "deduction" || method === "induction" ? method : "abduction";
}

/**
 * 收回了确认以后：要是已经没有别的还算数的"用户确认"支持（比如回答了解你问题时确认的），标回推断的——推法照确认之前的，
 * 把握最多 medium（推断的上限）
 */
function revertConfirmation(engine: MemoryEngine, claimId: string, byEvidenceId: string): void {
  const claim = engine.store.getClaim(claimId);
  if (!claim || claim.epistemic !== "user_confirmed") return;
  const stillConfirmed = engine.store.linksOf(claimId).some((link) => {
    if (link.polarity !== "supports" || link.weight !== "decisive" || !link.rationale.startsWith(USER_CONFIRMATION)) return false;
    const evidence = engine.store.getEvidence(link.target);
    return evidence !== undefined && canSupportUserClaims(evidence);
  });
  if (stillConfirmed) return;
  const patch: Partial<Claim> = { epistemic: "inferred", method: methodBeforeConfirmation(engine, claimId) };
  if (claim.confidence === "high") patch.confidence = "medium";
  engine.gate.updateClaim(claimId, patch, { evidenceId: byEvidenceId, reason: "用户收回了确认，标回推断的" });
}

/** 用户对一条结论表态（见文件开头）：记表态证据、收回先前相反的表态、走引擎的写接口；被拒时抛 ClaimVerdictRefused、什么都不写 */
export function recordClaimVerdict(engine: MemoryEngine, claimId: string, verdict: ClaimVerdict, options: ClaimVerdictOptions = {}): ClaimVerdictResult {
  const store = engine.store;
  // 267 号票：经唯一写入口——记下用户的表态（经谁转达写进留痕；原因是管理员记下的那句）
  return engine.gate.write({ op: "verdict", actor: "user_verdict", ...(options.via ? { via: options.via } : {}), reason: options.note ?? VERDICT_NOTE[verdict] }, () => {
    const claim = store.getClaim(claimId);
    if (!claim) throw new Error(`没有这条断言：${claimId}`);
    if (claim.status === "superseded") throw new ClaimVerdictRefused("superseded", claimId, `断言 ${claimId} 已经被 ${claim.supersededBy ?? "新的一条"} 取代了，改新的那条`);
    let retractingVerdict: string | undefined;
    if (claim.status === "retracted") {
      if (verdict === "reject") throw new ClaimVerdictRefused("retracted", claimId, `断言 ${claimId} 已经撤回了`);
      retractingVerdict = retractedByVerdict(engine, claim);
      if (retractingVerdict === undefined) {
        throw new ClaimVerdictRefused("retracted", claimId, `断言 ${claimId} 是因为 ${claim.retractedBy ?? "依据不在了"} 撤回的（依据不在了，或者有用户明说的反证），不是用户表态撤的，不能直接改回；下一次整理有新证据会重新推`);
      }
    }
    if (verdict === "reject" && claim.epistemic === "explicit") {
      throw new ClaimVerdictRefused("explicit", claimId, `断言 ${claimId} 是用户明说的，跟着那句话走，直接撤不掉；要改得纠正或者忘掉那句话`, explicitEvidenceOf(engine, claimId));
    }

    const at = options.at ?? store.now();
    const draft: EvidenceDraft = {
      sourceLevel: "self",
      mode: "say",
      kind: "approval",
      text: `用户${options.via ?? ""}${VERDICT_TEXT[verdict]}：「${claim.statement}」`,
      context: [...claim.context],
      eventTime: at,
      observedAt: at,
      sourceRef: `${VERDICT_SOURCE_PREFIX}${claimId}`,
    };
    const evidence = engine.gate.insertEvidence(draft, { reason: options.note ?? VERDICT_NOTE[verdict] });

    // 用户改主意：先前相反的表态收回（拿不准时两个方向的都收回）；撤回它的那句表态也在里面
    const opposite = verdict === "confirm" ? verdictsOn(engine, claimId, "refutes") : verdict === "reject" ? verdictsOn(engine, claimId, "supports") : [...verdictsOn(engine, claimId, "supports"), ...verdictsOn(engine, claimId, "refutes")];
    const withdrawn = [...new Set([...opposite, ...(retractingVerdict === undefined ? [] : [retractingVerdict])])].filter((id) => id !== evidence.id);
    for (const id of withdrawn) engine.correct(id, evidence.id);
    if (verdict !== "confirm" && withdrawn.length > 0) revertConfirmation(engine, claimId, evidence.id);

    let updated: Claim;
    if (verdict === "confirm") updated = engine.rg.confirmClaim(claimId, evidence.id);
    else if (verdict === "reject") updated = engine.rg.rejectClaim(claimId, evidence.id);
    else updated = engine.rg.markClaimForReview(claimId, { evidenceId: evidence.id, reason: options.note ?? VERDICT_NOTE.doubt });
    return { claim: updated, evidenceId: evidence.id, withdrawn };
  });
}
