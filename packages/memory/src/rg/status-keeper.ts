// 状态维护（329 号票，ADR-0032）：照原始推理图谱的状态机，结论的"已验证 / 猜测 / 撤回"怎么跟着前提和证据走。
// 每晚整理（reasoning-graph.ts）、用户的表态、纠正和忘掉的传播、彻底删除都用这一份；写一律在调用方开的那一次写里（经唯一写入口），
// 写入口按同一份规矩（graph-rules.ts）查。
//
// - R4 传播铁律（downgradeDependents）：已验证的不得依赖没验证的。前提降成猜测、撤回时，依赖它的已验证降回猜测——前提照挂、
//   结论保留，不转复核、不撤、不悄悄换依据；一路往下传。前提是事实时同样（拿不准的事实当前提，推出来的是猜测）。
// - R7 证实不靠前提（directBasis / attachDirect / restoreChain）：一条结论被直接证实——用户亲口确认（还算数的"用户确认"决定性支持），
//   或者不靠前提的独立证据达标（只算前提闭包之外、已验证的支持和反证，照现在的分贝计分和"有别的假设没有的强支持"判）——依据改挂到
//   这份直接证实上（新的一条推断，理由以 DIRECT_BASIS 开头），原来的推理链记作历史（history）。以后前提被推翻，它照样成立；
//   前提不因此变已验证。证实它的那份东西没了，退回原来的推理链（别的依据也不够就是猜测）。明说的结论跟着用户那句话走，不改挂。
// - R8 推翻往上传（retractDependents）：一条结论被证伪（决定性反证）、被用户亲口否掉，或者它的前提事实被用户纠正 → 撤回；
//   建在它上面的（传递）：自己有直接证实的留下（改挂依据），没有的一律撤回，墓碑（retractedBy）指向撤了的那条前提；它底下的事实不动。
//   不管被撤的原来是猜测还是已验证，都扫下游。
// - 来源失效（sourceLost）：前提的证据被忘掉、彻底删除、别推断（不是被证伪，原始 LIFECYCLE §1 的"evidence 来源失效 → 降级"）→
//   依赖它的加复核标记、已验证的降回猜测；前提一条都不在了的（悬空）撤回，再往下照这样传。彻底删除时前提不在库里了，
//   墓碑没处指，推断先停用（needs_review）、结论标着复核等整理重推。
// - R11 复活（reinstateDependents）：推翻它的东西自己被推翻（墓碑指向的前提回来了）→ 回到猜测（加复核标记，整理重判），
//   因 R8 被连带撤回的跟着回来。
// - 复核标记（flag）不改真值状态。
import type { Claim, Confidence, Inference, RevisionCause } from "../domain/types.ts";
import type { MemoryEngine } from "../engine.ts";
import { canSupportUserClaims } from "../evidence/boundary.ts";
import { idKind } from "../domain/ids.ts";
import { type GraphLookup, ironLawReason, premiseHolds, premiseVerified, storeLookup, unverifiedPremises } from "./graph-rules.ts";
import { type Decision, decideGroup, tally, type Tally } from "./scoring.ts";
import { RELAYED_BASIS } from "./relayed.ts";
import type { RgView } from "./types.ts";

/** 用户确认、否认记的那条决定性关联的说法开头（330 号票起放在 link-sources.ts，R14 按它认"当面的"） */
import { USER_CONFIRMATION, USER_DENIAL } from "./link-sources.ts";
export { USER_CONFIRMATION, USER_DENIAL };
/** 329 号票（R7）：改挂到直接证实上的那条推断，理由以它开头 */
export const DIRECT_BASIS = "直接证实：";

/** 把握降一档（最低 low）：Q2 的"组不成立了、没有推翻者" */
export const lowerConfidence = (c: Confidence): Confidence => (c === "high" ? "medium" : "low");

/** 这条推断是不是直接证实（R7） */
export const isDirectInference = (i: Pick<Inference, "rationale">): boolean => i.rationale.startsWith(DIRECT_BASIS);

/** 一条结论的直接证实：用户亲口确认，或者不靠前提的独立证据达标；targets 是改挂上去的依据（证据、事实，都已验证） */
export interface DirectBasis {
  kind: "user" | "independent";
  targets: string[];
}

/** 一组里每条的两份判定：全部证据的、只算独立证据的 */
export interface GroupDecisions {
  full: ReadonlyMap<string, Decision>;
  independent: ReadonlyMap<string, Decision>;
}

const LIVE: ReadonlySet<string> = new Set(["active", "contested"]);

export class StatusKeeper {
  private readonly engine: MemoryEngine;

  constructor(engine: MemoryEngine) {
    this.engine = engine;
  }

  private get store() {
    return this.engine.store;
  }

  private get w() {
    return this.engine.gate;
  }

  private get lookup(): GraphLookup {
    return storeLookup(this.store);
  }

  private get registry() {
    return this.engine.rg.registry;
  }

  // ---------- 查 ----------

  /** 还算数的用户确认（本人、有效的证据，决定性支持，说法以 USER_CONFIRMATION 开头） */
  userConfirmations(claimId: string): string[] {
    const out: string[] = [];
    for (const link of this.store.linksOf(claimId)) {
      if (link.polarity !== "supports" || link.weight !== "decisive" || !link.rationale.startsWith(USER_CONFIRMATION) || out.includes(link.target)) continue;
      const evidence = this.store.getEvidence(link.target);
      if (evidence && canSupportUserClaims(evidence)) out.push(evidence.id);
    }
    return out;
  }

  /** 推理链（不是直接证实的推断）：成立的优先，没有就是记作历史的那条 */
  chainOf(claimId: string): Inference | undefined {
    const chains = this.store.inferencesOf(claimId).filter((i) => !isDirectInference(i));
    return chains.find((i) => i.status === "active") ?? chains.findLast((i) => i.status === "history") ?? chains.findLast((i) => i.status === "needs_review");
  }

  /**
   * 前提闭包（"回声"的范围）：推理链的前提，一路往上（前提是结论的，接着看它的推理链），加上闭包里每条结论的支持目标、
   * 每条事实背后的证据。独立证据只算这之外的
   */
  premiseClosure(claimId: string): Set<string> {
    const closure = new Set<string>();
    const queue = [...(this.chainOf(claimId)?.premiseIds ?? [])];
    const seen = new Set<string>([claimId]);
    const addFact = (id: string) => {
      closure.add(id);
      for (const e of this.store.getFact(id)?.evidenceIds ?? []) closure.add(e);
    };
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      closure.add(id);
      const kind = idKind(id);
      if (kind === "fact") addFact(id);
      else if (kind === "claim") {
        queue.push(...(this.chainOf(id)?.premiseIds ?? []));
        // 明说的结论没有推断，背后是它那条事实（和事实的原话）
        const stated = this.registry.explicitFactOf(id);
        if (stated !== undefined) addFact(stated);
        for (const link of this.store.linksOf(id)) {
          if (link.polarity !== "supports") continue;
          if (idKind(link.target) === "fact") addFact(link.target);
          else closure.add(link.target);
        }
      }
    }
    return closure;
  }

  /** 只算独立证据的分数：前提闭包之外、已验证（证据有效、事实成立或被取代）、能当依据的支持和反证 */
  independentTally(claim: Claim, view: RgView): Tally {
    const closure = this.premiseClosure(claim.id);
    const links = this.store.linksOf(claim.id).filter((l) => l.polarity !== "context" && !closure.has(l.target) && premiseVerified(this.lookup, l.target));
    return tally(claim.id, links, view);
  }

  /**
   * 一组里每条的两份判定（R2、R7）：full 全部证据照 decideGroup 判（证据达标）；independent 只算不靠前提的独立证据判
   * （"独立证据达标"，门槛同 decideGroup）
   */
  groupDecisions(members: readonly Claim[], view: RgView): GroupDecisions {
    return {
      full: decideGroup(members.map((c) => tally(c.id, this.store.linksOf(c.id), view))),
      independent: decideGroup(members.map((c) => this.independentTally(c, view))),
    };
  }

  /**
   * 这条结论的直接证实（R7）：用户亲口确认；或者它在活着的组里，全部证据判成立（R2 证据达标）、只算不靠前提的独立证据也判成立
   * （给了 decisions 用给的，没给按它那组现算）。明说的不算（跟着那句话走）
   */
  directBasis(claim: Claim, view: RgView, decisions?: GroupDecisions): DirectBasis | undefined {
    if (claim.epistemic === "explicit" || claim.status === "retracted" || claim.status === "superseded") return undefined;
    const confirmed = this.userConfirmations(claim.id);
    if (confirmed.length > 0) return { kind: "user", targets: confirmed };
    let judged = decisions;
    if (judged === undefined) {
      const member = this.registry.memberOf(claim.id);
      const group = member ? this.registry.getGroup(member.groupKey) : undefined;
      if (!group?.live) return undefined;
      const members = this.registry
        .members(group.key)
        .map((m) => this.store.getClaim(m.claimId))
        .filter((c): c is Claim => c !== undefined && LIVE.has(c.status));
      judged = this.groupDecisions(members, view);
    }
    if (judged.full.get(claim.id)?.status !== "active" || judged.independent.get(claim.id)?.status !== "active") return undefined;
    const t = this.independentTally(claim, view);
    const targets = t.supportTargets.filter((id, i, all) => all.indexOf(id) === i);
    return targets.length > 0 ? { kind: "independent", targets } : undefined;
  }

  /**
   * 撤回还站得住吗：墓碑指向它推理链上的前提的（连带撤回、来源失效），那条前提还没回来就站得住；
   * 指向推翻它的东西的（反证、用户的否认），那份东西还在（证据有效、事实成立）就站得住，被忘掉、被纠正了就站不住（R11 复活）
   */
  retractionStands(claim: Claim): boolean {
    const by = claim.retractedBy;
    if (claim.status !== "retracted" || by === null) return false;
    const premise = this.store.inferencesOf(claim.id).some((i) => i.premiseIds.includes(by));
    const holds = premiseHolds(this.lookup, by);
    return premise ? !holds : holds;
  }

  /**
   * 333 号票（全量重判一次，R8 / R11 / Q2）：按新规矩，这条撤回有没有真正推翻它的东西还在（R8：墓碑只指真正推翻它的）——
   * - 墓碑指它自己的反证（计分撤的、用户否认的、演绎预测证伪的）：那条反证按现在的计分（R14：当面的才算决定性）还是落了地的决定性反证；
   * - 墓碑指它推理链上的前提（连带撤回、来源失效、悬空）：那条前提真不在了（撤回、被取代、被纠正、被忘掉）；
   * - 别人转述起的猜测，墓碑指用户自己说的相反的那条事实（R3）：那条事实还在；
   * - 别的（老代码"组不成立了"留的墓碑、指着只是拿不准的结论或观察）：没有推翻者，站不住（Q2：不撤，留成猜测）。
   * 明说的结论不在这里看（跟着它那条事实走），交回 true。没撤回的也交回 true
   */
  retractionHasRefuter(claim: Claim, view: RgView): boolean {
    const by = claim.retractedBy;
    if (claim.status !== "retracted" || by === null || claim.epistemic === "explicit") return true;
    const refute = this.store.linksOf(claim.id).find((l) => l.polarity === "refutes" && l.target === by);
    if (refute) return tally(claim.id, [refute], view).decisiveRefute !== undefined;
    const chains = this.store.inferencesOf(claim.id).filter((i) => !isDirectInference(i));
    if (chains.some((i) => i.premiseIds.includes(by))) return !premiseHolds(this.lookup, by);
    if (chains.some((i) => i.rationale.startsWith(RELAYED_BASIS))) return premiseHolds(this.lookup, by);
    return false;
  }

  /**
   * 333 号票：复活一条被错撤的（没有推翻者，见 retractionHasRefuter）：照 R11 回到猜测、推理链恢复、因它被连带撤回的跟着回来；
   * 不在活着的组里的照 Q2 留成猜测、把握降一档（keepAsGuess；前提一条都不在了的照"不留悬空"撤回、墓碑改指不在了的那条前提）。
   * 在活着的组里的标着复核，由那组按证据定。交回复活的（含连带回来的）
   */
  reviveWronglyRetracted(claim: Claim, at: string, cause: RevisionCause, view: RgView): string[] {
    const revived = this.reinstate(claim, at, cause);
    for (const id of revived) {
      const c = this.store.getClaim(id);
      if (!c || !LIVE.has(c.status)) continue;
      const member = this.registry.memberOf(id);
      if (member && this.registry.getGroup(member.groupKey)?.live) continue;
      this.keepAsGuess(c, at, { ...cause, reason: `${cause.reason}；它那组已经不在了` }, view);
    }
    return revived;
  }

  /** 撤回是计分判的（墓碑指向这条结论自己的反证）：每次定状态照样重算（反证被拿掉就回来） */
  retractedByScoring(claim: Claim): boolean {
    return claim.status === "retracted" && claim.retractedBy !== null && this.store.linksOf(claim.id).some((l) => l.polarity === "refutes" && l.target === claim.retractedBy);
  }

  // ---------- 写（在调用方开的那一次写里） ----------

  /** 加复核标记（不改真值状态）；已经标着的不重复写 */
  flag(claimId: string, cause: RevisionCause): void {
    const claim = this.store.getClaim(claimId);
    if (!claim || claim.needsReview || claim.status === "retracted" || claim.status === "superseded") return;
    this.w.updateClaim(claimId, { needsReview: true }, cause);
  }

  /**
   * 改挂到直接证实上（R7）：没有就新建一条推断（理由以 DIRECT_BASIS 开头，用户确认的推法记 user_confirmation，独立证据的照结论的推法），
   * 依据变了就更新；原来的推理链记作历史
   */
  attachDirect(claim: Claim, basis: DirectBasis, by: string, cause: RevisionCause): void {
    const inferences = this.store.inferencesOf(claim.id);
    const what = basis.kind === "user" ? `用户亲口确认（${basis.targets.join("、")}）` : `不靠前提的独立证据达标（${basis.targets.join("、")}）`;
    const rationale = `${DIRECT_BASIS}${what}；原来的推理链记作历史`;
    const method = basis.kind === "user" && claim.epistemic === "user_confirmed" ? "user_confirmation" : claim.method;
    const direct = inferences.find((i) => isDirectInference(i) && i.status === "active");
    const reason = `${cause.reason}（直接证实：依据改挂到${what}上）`;
    if (!direct) this.w.insertInference({ conclusionClaimId: claim.id, premiseIds: basis.targets, method, rationale, by, status: "active" }, { ...cause, reason });
    else if (JSON.stringify(direct.premiseIds) !== JSON.stringify(basis.targets) || direct.method !== method) this.w.updateInference(direct.id, { premiseIds: basis.targets, method, rationale }, { ...cause, reason });
    for (const i of inferences) if (!isDirectInference(i) && i.status === "active") this.w.updateInference(i.id, { status: "history" }, { ...cause, reason });
  }

  /** 直接证实没了（R7 的后半句）：直接证实那条推断撤掉，原来的推理链恢复成依据。交回有没有恢复出一条 */
  restoreChain(claimId: string, cause: RevisionCause): boolean {
    const inferences = this.store.inferencesOf(claimId);
    const direct = inferences.filter((i) => isDirectInference(i) && i.status === "active");
    if (direct.length === 0) return false;
    const reason = `${cause.reason}（直接证实没了，退回原来的推理链）`;
    for (const i of direct) this.w.updateInference(i.id, { status: "retracted" }, { ...cause, reason });
    const chain = inferences.findLast((i) => !isDirectInference(i) && i.status === "history");
    if (chain) this.w.updateInference(chain.id, { status: "active" }, { ...cause, reason });
    return chain !== undefined;
  }

  /**
   * R4 传播铁律：以 id 为前提（成立推断）的已验证结论降回猜测，前提照挂、结论保留，一路往下传。有直接证实的改挂依据、照样成立（R7）。
   * spared 里的不动（写回时定根源的那组）。交回降了的
   */
  downgradeDependents(id: string, at: string, cause: RevisionCause, view: RgView, spared: ReadonlySet<string> = new Set(), seen: Set<string> = new Set()): string[] {
    const out: string[] = [];
    // 同一层先把直接证实都看好再改（一组里几条都依赖它时，不因为先改了谁、后看谁而结果不同）
    const level = this.dependentsOf(id, (c) => c.status === "active" && !spared.has(c.id) && !seen.has(c.id), view);
    for (const { inference, claim, direct } of level) {
      seen.add(claim.id);
      if (direct) {
        this.attachDirect(claim, direct, inference.by, { ...cause, reason: `前提 ${id} 没验证了，但 ${claim.id} 有直接证实` });
        continue;
      }
      if (isDirectInference(inference)) {
        this.loseDirect(claim, at, cause, view, spared, seen);
        continue;
      }
      const bad = unverifiedPremises(this.lookup, claim.id);
      if (bad.length === 0) continue;
      this.w.updateClaim(claim.id, { status: "contested", reviewedAt: at }, { ...cause, reason: `${ironLawReason(bad)}（${cause.reason}）` });
      out.push(claim.id, ...this.downgradeDependents(claim.id, at, { ...cause, reason: `前提 ${claim.id} 降回猜测` }, view, spared, seen));
    }
    return out;
  }

  /**
   * R8 推翻往上传：以 id 为前提（成立推断）的结论，有直接证实的留下（改挂依据），没有的撤回（墓碑指向 id），再往下传。
   * 不管原来是猜测还是已验证都扫。明说的结论不在这里改（跟着它那条事实走，followFact）。交回撤了的
   */
  retractDependents(id: string, at: string, cause: RevisionCause, view: RgView, spared: ReadonlySet<string> = new Set(), seen: Set<string> = new Set()): string[] {
    const out: string[] = [];
    // 同一层先把直接证实都看好再改（同上）
    const level = this.dependentsOf(id, (c) => LIVE.has(c.status) && !spared.has(c.id) && !seen.has(c.id) && c.epistemic !== "explicit", view);
    for (const { inference, claim, direct } of level) {
      seen.add(claim.id);
      if (isDirectInference(inference)) {
        // 直接证实的那份东西被推翻了：退回原来的推理链（别的依据也不够就是猜测，整理重判；推理链也不在了的撤回）
        this.loseDirect(claim, at, cause, view, spared, seen);
        continue;
      }
      if (direct) {
        this.attachDirect(claim, direct, inference.by, { ...cause, reason: `前提 ${id} 被推翻了，${claim.id} 有直接证实，留下` });
        continue;
      }
      out.push(...this.retract(claim, id, at, { ...cause, reason: `前提 ${id} 被推翻了，${claim.id} 没有直接证实，跟着撤回（以后证据够了重新推）` }, view, spared, seen, "deny"));
    }
    return out;
  }

  /**
   * 来源失效（忘掉、彻底删除、别推断）：以 id 为前提的结论加复核标记；前提一条都不在了的撤回（deleting 时墓碑没处指，推断停用、等整理重推），
   * 已验证的降回猜测；再往下照这样传。交回动过的
   */
  sourceLost(id: string, at: string, cause: RevisionCause, view: RgView, options: { deleting?: boolean; spared?: ReadonlySet<string> } = {}, seen: Set<string> = new Set()): string[] {
    const spared = options.spared ?? new Set<string>();
    const out: string[] = [];
    for (const inference of this.store.inferencesByPremise(id)) {
      if (inference.status !== "active") continue;
      const claim = this.store.getClaim(inference.conclusionClaimId);
      if (!claim || !LIVE.has(claim.status) || spared.has(claim.id) || seen.has(claim.id)) continue;
      seen.add(claim.id);
      if (isDirectInference(inference)) {
        out.push(claim.id);
        this.loseDirect(claim, at, cause, view, spared, seen);
        continue;
      }
      // 明说的跟着它那条事实走（followFact）；彻底删除时事实不在了，照下面停用推断、等重推
      if (claim.epistemic === "explicit" && !options.deleting) continue;
      out.push(claim.id);
      this.flag(claim.id, { ...cause, reason: `前提 ${id} 不在了（${cause.reason}），下一次整理重判` });
      const holds = this.lookup.premisesOf(claim.id).some((p) => p !== id && premiseHolds(this.lookup, p));
      if (!holds) {
        if (options.deleting) {
          this.w.updateInference(inference.id, { status: "needs_review" }, { ...cause, reason: `前提 ${id} 被删了（${cause.reason}），等整理重推` });
          if (claim.status === "active") this.w.updateClaim(claim.id, { status: "contested", reviewedAt: at }, { ...cause, reason: `前提 ${id} 被删了（${cause.reason}），依据在重推，先当猜测` });
          out.push(...this.sourceLost(claim.id, at, { ...cause, reason: `前提 ${claim.id} 的依据被删了` }, view, options, seen));
        } else {
          out.push(...this.retract(claim, id, at, { ...cause, reason: `前提都不在了（${id}：${cause.reason}），撤回，不留悬空` }, view, spared, seen, "lost", options));
        }
        continue;
      }
      if (claim.status === "active" && unverifiedPremises(this.lookup, claim.id).length > 0) {
        this.w.updateClaim(claim.id, { status: "contested", reviewedAt: at }, { ...cause, reason: `${ironLawReason(unverifiedPremises(this.lookup, claim.id))}（${cause.reason}）` });
        out.push(...this.downgradeDependents(claim.id, at, { ...cause, reason: `前提 ${claim.id} 降回猜测` }, view, spared));
      }
    }
    return out;
  }

  /**
   * 组不成立了、又没有推翻者（Q2，主会话 2026-10-27 按 R9 + 原始 undercut 定）：往上抽的条件不够了、场景只剩一种、联动组这次没再出来、
   * 观察不够两条……这是证据变少，不是被证伪——不撤，留成猜测、把握降一档（最低 low），推理链照挂（前提一条不拿掉）；
   * 原来已验证的往下按铁律降（R4）。有直接证实的（R7）不动。只有前提一条都不在了（悬空）才按"不留悬空"撤回（墓碑指不在了的那条前提，
   * 往下按来源失效传）。推断停用着（前提被删、在重推）的复核标记留着，别的这一步就算重判过、摘掉。交回动过的
   */
  keepAsGuess(claim: Claim, at: string, cause: RevisionCause, view: RgView): string[] {
    if (!LIVE.has(claim.status) || this.store.inferencesOf(claim.id).some((i) => i.status === "active" && isDirectInference(i))) return [];
    const premises = this.lookup.premisesOf(claim.id);
    const dangling = premises.length > 0 && !premises.some((p) => premiseHolds(this.lookup, p));
    const gone = premises.find((p) => this.lookup.statusOf(p) !== undefined && !premiseHolds(this.lookup, p));
    if (dangling && gone !== undefined) {
      return this.retract(claim, gone, at, { ...cause, reason: `${cause.reason}；前提都不在了（${gone}），撤回，不留悬空` }, view, new Set(), new Set(), "lost");
    }
    // 依据在重推（推断停用着）或者前提都被删了（墓碑没处指）：复核标记留着，等整理重推
    const pending = dangling || !this.store.inferencesOf(claim.id).some((i) => i.status === "active");
    const confidence = lowerConfidence(claim.confidence);
    this.w.updateClaim(
      claim.id,
      { status: "contested", confidence, needsReview: pending, reviewedAt: at },
      { ...cause, reason: `${cause.reason}；没有推翻者，不撤：留成猜测、把握降到 ${confidence}，前提照挂` },
    );
    const out = [claim.id];
    if (claim.status === "active") out.push(...this.downgradeDependents(claim.id, at, { ...cause, reason: `前提 ${claim.id} 降回猜测（${cause.reason}）` }, view));
    return out;
  }

  /**
   * R11 复活：墓碑指向 id 的结论，撤回已经站不住了（推翻它的前提回来了）→ 回到猜测、加复核标记（整理重判），推理链恢复；
   * 因它被连带撤回的跟着回来。交回复活的
   */
  reinstateDependents(id: string, at: string, cause: RevisionCause, seen: Set<string> = new Set()): string[] {
    const out: string[] = [];
    for (const claim of this.store.claimsRetractedBy(id)) {
      if (seen.has(claim.id) || this.retractionStands(claim) || this.retractedByScoring(claim)) continue;
      seen.add(claim.id);
      out.push(...this.reinstate(claim, at, { ...cause, reason: `推翻它的 ${id} 不再成立（${cause.reason}），复活成猜测` }, seen));
    }
    return out;
  }

  /** 复活一条（R11）：回到猜测、加复核标记、撤掉的推理链恢复；连带撤回的跟着回来 */
  reinstate(claim: Claim, at: string, cause: RevisionCause, seen: Set<string> = new Set()): string[] {
    seen.add(claim.id);
    this.w.updateClaim(claim.id, { status: "contested", retractedBy: null, needsReview: true, reviewedAt: at }, cause);
    const chain = this.store
      .inferencesOf(claim.id)
      .filter((i) => !isDirectInference(i))
      .findLast((i) => i.status === "retracted");
    if (chain && !this.store.inferencesOf(claim.id).some((i) => i.status === "active")) this.w.updateInference(chain.id, { status: "active" }, cause);
    return [claim.id, ...this.reinstateDependents(claim.id, at, { ...cause, reason: `前提 ${claim.id} 复活了` }, seen)];
  }

  /**
   * 标着复核、不在活着的组里的结论重判（整理末尾，组里的由那组按证据定）：有直接证实的（R7）依据改挂上去、已验证；
   * 推理链的前提一条都不在了的撤回（不留悬空，墓碑指不在了的那条前提，往下按来源失效传）；已验证、前提有没验证的降回猜测（R4）；
   * 摘掉复核标记。推断停用着（前提被删了、依据在重推）的照旧标着。明说的不在这里（跟着它那条事实走）
   */
  rejudge(claim: Claim, at: string, cause: RevisionCause, view: RgView): void {
    if (!claim.needsReview || !LIVE.has(claim.status) || claim.epistemic === "explicit") return;
    const active = this.store.inferencesOf(claim.id).filter((i) => i.status === "active");
    if (active.length === 0) return;
    const direct = this.directBasis(claim, view);
    if (direct) {
      this.attachDirect(claim, direct, active[0]!.by, cause);
      this.w.updateClaim(claim.id, { status: "active", needsReview: false, reviewedAt: at }, { ...cause, reason: `${cause.reason}：有直接证实，已验证` });
      return;
    }
    const premises = this.lookup.premisesOf(claim.id);
    const gone = premises.find((p) => this.lookup.statusOf(p) !== undefined && !premiseHolds(this.lookup, p));
    if (premises.length > 0 && gone !== undefined && !premises.some((p) => premiseHolds(this.lookup, p))) {
      this.retract(claim, gone, at, { ...cause, reason: `${cause.reason}：前提都不在了（${gone}），撤回，不留悬空` }, view, new Set(), new Set(), "lost");
      return;
    }
    const bad = claim.status === "active" ? unverifiedPremises(this.lookup, claim.id) : [];
    this.w.updateClaim(
      claim.id,
      { needsReview: false, reviewedAt: at, ...(bad.length > 0 ? { status: "contested" as const } : {}) },
      { ...cause, reason: bad.length > 0 ? `${cause.reason}：${ironLawReason(bad)}` : `${cause.reason}：依据还在，照旧` },
    );
    if (bad.length > 0) this.downgradeDependents(claim.id, at, { ...cause, reason: `前提 ${claim.id} 降回猜测` }, view);
  }

  // ---------- 小工具 ----------

  /** 以 id 为前提（成立推断）、要动的结论，连同改动之前看好的直接证实 */
  private dependentsOf(id: string, wanted: (claim: Claim) => boolean, view: RgView): Array<{ inference: Inference; claim: Claim; direct: DirectBasis | undefined }> {
    const out: Array<{ inference: Inference; claim: Claim; direct: DirectBasis | undefined }> = [];
    for (const inference of this.store.inferencesByPremise(id)) {
      if (inference.status !== "active") continue;
      const claim = this.store.getClaim(inference.conclusionClaimId);
      if (!claim || !wanted(claim) || out.some((x) => x.claim.id === claim.id)) continue;
      out.push({ inference, claim, direct: isDirectInference(inference) ? undefined : this.directBasis(claim, view) });
    }
    return out;
  }

  /** 撤回一条（墓碑指向 by），推断撤掉，再往下传：deny（证伪、否掉）按 R8，lost（来源失效）按 sourceLost */
  private retract(claim: Claim, by: string, at: string, cause: RevisionCause, view: RgView, spared: ReadonlySet<string>, seen: Set<string>, mode: "deny" | "lost", options: { deleting?: boolean } = {}): string[] {
    this.w.updateClaim(claim.id, { status: "retracted", retractedBy: by, needsReview: false, reviewedAt: at }, cause);
    for (const i of this.store.inferencesOf(claim.id)) if (i.status === "active" || i.status === "needs_review") this.w.updateInference(i.id, { status: "retracted" }, cause);
    const next: RevisionCause = { ...cause, reason: `前提 ${claim.id} 撤回了（${cause.reason}）` };
    return [claim.id, ...(mode === "deny" ? this.retractDependents(claim.id, at, next, view, spared, seen) : this.sourceLost(claim.id, at, next, view, { ...options, spared }, seen))];
  }

  /**
   * 直接证实没了：退回原来的推理链；已验证的先当猜测、加复核标记（整理按证据重判）。原来的推理链也一条前提都不在了（被推翻、被忘掉）的
   * 撤回（不留悬空，墓碑指向不在了的那条前提），往下按"来源失效"传
   */
  private loseDirect(claim: Claim, at: string, cause: RevisionCause, view: RgView, spared: ReadonlySet<string>, seen: Set<string>): void {
    this.restoreChain(claim.id, cause);
    const premises = this.lookup.premisesOf(claim.id);
    const gone = premises.find((p) => this.lookup.statusOf(p) !== undefined && !premiseHolds(this.lookup, p));
    if (premises.length > 0 && gone !== undefined && !premises.some((p) => premiseHolds(this.lookup, p))) {
      this.retract(claim, gone, at, { ...cause, reason: `证实它的那份东西不在了，原来的推理链前提也都不在了（${gone}），撤回，不留悬空` }, view, spared, seen, "lost");
      return;
    }
    this.w.updateClaim(claim.id, { needsReview: true, ...(claim.status === "active" ? { status: "contested" as const, reviewedAt: at } : {}) }, { ...cause, reason: `证实它的那份东西不在了（${cause.reason}），退回原来的推理链，整理重判` });
    if (claim.status === "active") this.downgradeDependents(claim.id, at, { ...cause, reason: `前提 ${claim.id} 降回猜测` }, view, spared, seen);
  }
}
