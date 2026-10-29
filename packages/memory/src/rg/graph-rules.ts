// 推理图谱的几条规矩（326 号票从写入口里拆出来；329 号票照原始推理图谱改，ADR-0032）：唯一写入口（write-gate.ts，每次写只查
// 这一次改到的）和图谱自检（graph-check.ts，每晚整理完把整张图查一遍）用的是同一份，不各写各的。
// - refExists：引用的证据、事实、结论真实存在（写入口的 exists、图谱自检的 exists）；
// - premiseHolds：前提还在——不留悬空结论（写入口的 dangling、图谱自检的 dangling）；
// - premiseVerified：前提已验证——传播铁律（R4）：已验证的结论，成立推断写的前提都得已验证；前提降成猜测、撤回，
//   依赖它的已验证降回猜测（前提照挂、结论保留）。写入口在依据变的那一刻查，图谱自检查整张图上已验证的结论。
// premiseHolds 和 premiseVerified 只差在"猜测"上：猜测的结论、拿不准的事实"还在"（不算悬空，能当前提往上推，推出来的也是猜测），
// 但"没验证"（不能撑已验证的结论）。事实成立、被新值取代算已验证（被取代的是观点变了，旧值在它那段有效期里是对的，ADR-0030 的
// 有意不同）；拿不准的事实还在、没验证；被纠正、撤回的不在了。证据有效才算（本人的证据是直接观察，有效就是已验证的根）。
// 复核标记（Claim.needsReview）：标着的结论依据在重推（前提被删、被忘掉），写入口和自检不查它悬空、缺前提，等整理重判完再查。
import { idKind } from "../domain/ids.ts";
import { HELD_STATUSES, type MemoryStore } from "../store/store.ts";
import { isRelayedSource } from "./relayed.ts";

/** 还活着的结论：已验证、猜测 */
export const LIVE_CLAIM_STATUSES: readonly string[] = ["active", "contested"];

/** 查规矩要的那一点：一个 id 指向的证据、事实、结论在不在、是什么状态；一条结论的成立推断写了哪些前提；有没有复核标记 */
export interface GraphLookup {
  /** 状态；不在（或者不是证据、事实、结论的 id）是 undefined */
  statusOf(id: string): string | undefined;
  /** 这条结论的成立推断写的前提（事实、结论、证据的 id） */
  premisesOf(claimId: string): readonly string[];
  /** 这条结论有没有复核标记（依据在重推）；没给就当没有 */
  flagged?(claimId: string): boolean;
  /** 330 号票（R3）：这条是不是别人转述的（转述的事实、别人转述的证据）——转述的永远不算已验证的前提；没给就当不是 */
  relayed?(id: string): boolean;
}

/** 按存储查（写入口用）：每次现查，读到的是这一次写里的最新状态 */
export function storeLookup(store: MemoryStore): GraphLookup {
  return {
    statusOf(id) {
      switch (idKind(id)) {
        case "evidence":
          return store.getEvidence(id)?.status;
        case "fact":
          return store.getFact(id)?.status;
        case "claim":
          return store.getClaim(id)?.status;
        default:
          return undefined;
      }
    },
    premisesOf: (claimId) =>
      store
        .inferencesOf(claimId)
        .filter((i) => i.status === "active")
        .flatMap((i) => i.premiseIds),
    flagged: (claimId) => store.getClaim(claimId)?.needsReview === true,
    relayed: (id) => isRelayedSource(store, id),
  };
}

/** 引用的证据、事实、结论真实存在（被删的、编出来的都不算） */
export function refExists(lookup: GraphLookup, id: string): boolean {
  return lookup.statusOf(id) !== undefined;
}

const factHeld = (status: string) => (HELD_STATUSES as readonly string[]).includes(status);

/** 前提还在吗（不留悬空结论）：事实成立过（没撤回、没被纠正）、证据有效、结论没撤回没被取代（猜测也算还在） */
export function premiseHolds(lookup: GraphLookup, id: string): boolean {
  const status = lookup.statusOf(id);
  if (status === undefined) return false;
  switch (idKind(id)) {
    case "fact":
      return factHeld(status);
    case "evidence":
      return status === "active";
    case "claim":
      return status !== "retracted" && status !== "superseded";
    default:
      return false;
  }
}

/** 前提已验证吗（传播铁律）：结论已验证（active）、事实成立或被新值取代（拿不准的不算）、证据有效 */
export function premiseVerified(lookup: GraphLookup, id: string): boolean {
  const status = lookup.statusOf(id);
  if (status === undefined) return false;
  // 330 号票（R3）：只有转述的永远是猜测——转述的事实、别人转述的证据不算已验证的前提
  if (lookup.relayed?.(id) === true) return false;
  switch (idKind(id)) {
    case "fact":
      return status === "active" || status === "superseded";
    case "evidence":
      return status === "active";
    case "claim":
      return status === "active";
    default:
      return false;
  }
}

/** 一条结论的成立推断写的前提里没验证的（猜测、拿不准、撤回、不在了的） */
export function unverifiedPremises(lookup: GraphLookup, claimId: string): string[] {
  return [...new Set(lookup.premisesOf(claimId))].filter((id) => !premiseVerified(lookup, id));
}

/** 违反传播铁律：已验证的结论压在没验证的前提上（交回那几条前提；没违反是空的） */
export function ironLawViolation(lookup: GraphLookup, claimId: string): string[] {
  return lookup.statusOf(claimId) === "active" ? unverifiedPremises(lookup, claimId) : [];
}

/** 悬空：还活着的结论，成立推断写了前提、可一条都不在了（复核标记着的等重判，不算） */
export function isDangling(lookup: GraphLookup, claimId: string): boolean {
  const status = lookup.statusOf(claimId);
  if (status === undefined || !LIVE_CLAIM_STATUSES.includes(status) || lookup.flagged?.(claimId) === true) return false;
  const premises = lookup.premisesOf(claimId);
  return premises.length > 0 && !premises.some((id) => premiseHolds(lookup, id));
}

/** 推论没有前提：还活着的结论连一条写了前提的成立推断都没有（复核标记着的等重判，不算） */
export function lacksPremises(lookup: GraphLookup, claimId: string): boolean {
  const status = lookup.statusOf(claimId);
  if (status === undefined || !LIVE_CLAIM_STATUSES.includes(status) || lookup.flagged?.(claimId) === true) return false;
  return lookup.premisesOf(claimId).length === 0;
}

/** 降回猜测的原因（修订、留痕、整理报告里用；数据，不随界面语言变） */
export function ironLawReason(premises: readonly string[]): string {
  return `前提 ${premises.join("、")} 没验证（猜测、拿不准或撤回了），已验证的不能压在它上面，降回猜测（前提照挂、保留）`;
}
