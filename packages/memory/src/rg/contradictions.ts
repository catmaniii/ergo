// 330 号票 A（R12、R13，ADR-0032）：矛盾里"要分场合"那一种——结论层收窄。
// - R12：已验证碰上有分量的反例，支持都在一种场合（比如周末）、反例在另一种（工作日）——事实自己带的场景标签就能把两边分开：
//   把结论收窄成"在周末成立"的新结论（新建一条，原结论被它取代、留痕），场合外的那条反例在新结论上只当背景。
// - R13：两条打架、都够已验证，各自的支持按场景标签能分开（一边都在周末、一边都在工作日）：各自收窄，收窄以后场合对不上、不再打架。
// 只看事实、证据自己带的场景标签（kg/context.ts 的维度），不从图上的关系去补（那是琢磨出来的判断，当猜测、问用户，用户 10-27 选 A）。
// 收窄是一次写里的事：新结论照抄原结论的推断（前提、推法）和关联，同一组里接替原结论的位置（同一个模板）；原结论依赖它的照传播铁律降回猜测
// （R4：不悄悄换依据）。
import type { Claim, RevisionCause } from "../domain/types.ts";
import { CONTEXT_DIMENSIONS, CONTEXT_LABELS } from "../kg/context.ts";
import { rgWriter, type MemoryStore, type RgWriter } from "../store/store.ts";
import type { RgRegistry } from "./registry.ts";
import type { StatusKeeper } from "./status-keeper.ts";
import type { RgView } from "./types.ts";

/** 关联的目标自己带的场景标签：事实的、证据的 */
export function targetContext(target: string, view: RgView): string[] {
  return view.fact(target)?.context ?? view.evidence(target)?.context ?? [];
}

/**
 * 两拨目标能不能按场景标签分开：有一个维度（一天是哪种、在哪方面、出行是哪种）上，里面这拨每条都写了、外面那拨每条也都写了、
 * 两边没有交集。能分开交回里面这拨在那个维度上的标签（结论原来已经限定了这个维度的不算），不能是 undefined
 */
export function separatingTags(inside: readonly string[], outside: readonly string[], claimContext: readonly string[], view: RgView): string[] | undefined {
  if (inside.length === 0 || outside.length === 0) return undefined;
  for (const tags of Object.values(CONTEXT_DIMENSIONS)) {
    if (claimContext.some((t) => tags.includes(t))) continue;
    const of = (target: string) => targetContext(target, view).filter((t) => tags.includes(t));
    const ins = inside.map(of);
    const outs = outside.map(of);
    if (ins.some((x) => x.length === 0) || outs.some((x) => x.length === 0)) continue;
    const a = new Set(ins.flat());
    const b = new Set(outs.flat());
    if ([...a].some((t) => b.has(t))) continue;
    return [...a].toSorted((x, y) => tags.indexOf(x) - tags.indexOf(y));
  }
  return undefined;
}

/** 场景标签的说法："周末""工作日、社交场合" */
export function tagsLabel(tags: readonly string[]): string {
  return tags.map((t) => CONTEXT_LABELS[t] ?? t).join("、");
}

export interface NarrowDeps {
  store: MemoryStore;
  registry: RgRegistry;
  keeper: StatusKeeper;
  reasonerId: string;
}

/**
 * 把一条结论收窄到 tags 那些场合（见文件开头）：新建一条（陈述后面写明"只在……"、场景加上 tags），抄推断和关联（outside 里的目标
 * 在新结论上只当背景），同一组里接替原结论；原结论标"被取代"、指向新的；它原来已验证的，依赖它的照铁律降回猜测。交回新结论的 id
 */
export function narrowClaim(deps: NarrowDeps, claim: Claim, tags: readonly string[], outside: ReadonlySet<string>, at: string, cause: RevisionCause, view: RgView): string {
  const w: RgWriter = rgWriter(deps.store);
  const label = tagsLabel(tags);
  const member = deps.registry.memberOf(claim.id);
  const created = w.insertClaim(
    {
      tier: claim.tier,
      statement: `${claim.statement}（只在${label}）`,
      kind: claim.kind,
      epistemic: claim.epistemic,
      method: claim.method,
      status: claim.status === "active" ? "contested" : claim.status,
      confidence: claim.confidence,
      context: [...new Set([...claim.context, ...tags])],
      validFrom: claim.validFrom,
      validTo: claim.validTo,
      inferredAt: at,
      reviewedAt: at,
      retractedBy: null,
      supersededBy: null,
      competesWith: [...claim.competesWith],
      predicts: [],
    },
    cause,
  );
  for (const inf of deps.store.inferencesOf(claim.id)) {
    if (inf.status !== "active") continue;
    w.insertInference({ conclusionClaimId: created.id, premiseIds: [...inf.premiseIds], method: inf.method, rationale: `${inf.rationale}（收窄到${label}）`, by: deps.reasonerId, status: "active" }, cause);
  }
  for (const link of deps.store.linksOf(claim.id)) {
    if (link.polarity !== "context" && outside.has(link.target)) {
      w.putLink({ claimId: created.id, target: link.target, polarity: "context", weight: "weak", rationale: `场合外的（不在${label}）：${link.rationale}——收窄以后只当背景` }, cause);
      continue;
    }
    w.putLink({ claimId: created.id, target: link.target, polarity: link.polarity, weight: link.weight, rationale: link.rationale }, cause);
  }
  if (member) {
    deps.registry.removeMember(claim.id);
    deps.registry.addMember(created.id, member.groupKey, member.template);
  }
  w.updateClaim(claim.id, { status: "superseded", supersededBy: created.id, needsReview: false, reviewedAt: at }, { ...cause, reason: `${cause.reason}：结论层收窄成"只在${label}"，由 ${created.id} 取代` });
  if (claim.status === "active") deps.keeper.downgradeDependents(claim.id, at, { ...cause, reason: `前提 ${claim.id} 被收窄后的 ${created.id} 取代` }, view);
  return created.id;
}
