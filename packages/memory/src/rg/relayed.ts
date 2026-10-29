// 330 号票（R3，用户 10-27 放宽，ADR-0032）：别人转述的。
// - 别人转述的关于用户的事（知识图谱里出处是 third_party_reported 的事实：偏好、不喜欢、近期状态）可以让二狗起一个猜测：
//   推断出来的（hypothesis、inferred、溯因）、把握 low，推断的理由以 RELAYED_BASIS 开头，依据（那条转述的事实）只当背景
//   （context 关联，计分不算）；问题箱据此出一个问题问用户（question-sources.ts 的 relayed）。
// - 只有转述、用户没确认过的永远只是猜测：转述的事实、不是本人的证据不算已验证的前提（graph-rules.ts 的 premiseVerified 看
//   isRelayedSource），计分本来就不算它们；用户答"是"走用户确认（直接证实），答"不是"撤回。
// - 转述打不下已验证的：和用户自己说过的（成立的本人事实）对着干的，不起猜测、不记反证，只出一个问题（每条转述的事实最多一个）。
//   用户自己说了同样的话，转述起的猜测被明说的那条取代。
// 起猜测、跟着走在 reasoning-graph.ts 的 syncRelayed（整理时和明说的结论同一步）。
import { USER_ENTITY_ID } from "../domain/ids.ts";
import type { Fact, Inference } from "../domain/types.ts";
import { sameObject } from "../kg/change.ts";
import { HELD_STATUSES, type MemoryStore } from "../store/store.ts";
import { isStateTopic } from "./concepts.ts";

/** 转述起的猜测，成立推断的理由以它开头 */
export const RELAYED_BASIS = "别人转述：";

/** 本人的出处（参加变化判定的那两种，同 kg/graph.ts） */
const SELF = new Set(["user_stated", "observed"]);

/** 推断是不是"别人转述起的猜测"那一条 */
export function isRelayedInference(inference: Pick<Inference, "rationale">): boolean {
  return inference.rationale.startsWith(RELAYED_BASIS);
}

/** 这条结论是不是转述起的猜测（看它的推断，成立的、撤了的都算——撤了的同一条转述不再重起） */
export function isRelayedGuess(store: MemoryStore, claimId: string): boolean {
  return store.inferencesOf(claimId).some(isRelayedInference);
}

/** 这条转述的事实起过的猜测（还活着的、撤了的都算）；没起过是 undefined */
export function relayedGuessOf(store: MemoryStore, factId: string): string | undefined {
  return store.inferencesByPremise(factId).find(isRelayedInference)?.conclusionClaimId;
}

/** 前提是不是别人转述的：转述的事实（third_party_reported）、别人转述的证据（untrusted） */
export function isRelayedSource(store: MemoryStore, id: string): boolean {
  const fact = store.getFact(id);
  if (fact) return fact.assertion === "third_party_reported";
  const evidence = store.getEvidence(id);
  return evidence !== undefined && evidence.sourceLevel === "untrusted";
}

/** 能起猜测的转述：关于用户的偏好、不喜欢、近期状态（和明说的结论同一类），还成立、转述的那句还在 */
export function relayedEligible(store: MemoryStore, f: Fact): boolean {
  if (f.subjectId !== USER_ENTITY_ID || f.assertion !== "third_party_reported") return false;
  if (!(HELD_STATUSES as readonly string[]).includes(f.status)) return false;
  if (!f.evidenceIds.some((id) => store.getEvidence(id)?.status === "active")) return false;
  if (f.predicate === "prefers" || f.predicate === "dislikes") return true;
  return f.predicate === "said_about" && f.object.type === "entity" && isStateTopic(store.getEntity(f.object.id)?.name ?? "");
}

/** 一条事实说的方向：喜欢是 +1、不喜欢是 -1（带否定的反过来）；近期状态带否定是 -1 */
function direction(f: Fact): number {
  const base = f.predicate === "dislikes" ? -1 : 1;
  return f.negated ? -base : base;
}

/** 事实是哪一类：偏好 / 不喜欢算一类，近期状态一类，别的按谓词 */
function family(x: Fact): string {
  return x.predicate === "said_about" ? "state" : x.predicate === "prefers" || x.predicate === "dislikes" ? "pref" : x.predicate;
}

/**
 * 用户自己说过（做过）的、和这条转述说的是同一件事的成立的事实：同一个宾语、同一类（偏好 / 不喜欢算一类，近期状态一类）。
 * agrees 是方向一样的，conflicts 是对着干的
 */
export function selfCounterparts(store: MemoryStore, f: Fact): { agrees: Fact[]; conflicts: Fact[] } {
  const same = store
    .listFacts({ status: ["active", "contested"], subjectId: USER_ENTITY_ID })
    .filter((x) => SELF.has(x.assertion) && family(x) === family(f) && sameObject(x.object, f.object));
  return { agrees: same.filter((x) => direction(x) === direction(f)), conflicts: same.filter((x) => direction(x) !== direction(f)) };
}
