// 记忆边界：只有本人的证据能用来支持或反驳关于用户的假设；别的来源（别人转述、agent、系统）只能当背景。
// 被忘掉、被纠正的本人证据也不再当依据。④ 号票的推理图谱建关联、判追问时用它挑证据。
// 330 号票（R3，用户 10-27 放宽，ADR-0032）：别人转述的可以让二狗起一个猜测、往问题箱出问题找用户确认（rg/relayed.ts）；
// 计分照旧不算它，转述的事实、证据也不算已验证的前提——只有转述、用户没确认过的永远只是猜测，转述打不下已验证的，最多出一个问题。
import type { Evidence } from "../domain/types.ts";

export function canSupportUserClaims(evidence: Pick<Evidence, "sourceLevel" | "status">): boolean {
  return evidence.sourceLevel === "self" && evidence.status === "active";
}

/** 263 号票：用户对一条结论直接表态记下的证据，出处是 verdict:<结论 id>（rg/verdicts.ts） */
export const VERDICT_SOURCE_PREFIX = "verdict:";

/**
 * 是不是表态证据（"用户说这条结论对"这类，出处 verdict:…）：它能当依据（本人的），但不是用户原来的话、也不是观察到的事——
 * 抽事实时跳过（抽了会和结论自己的依据重复计数），判预测时不当新证据
 */
export function isVerdictEvidence(evidence: Pick<Evidence, "sourceRef">): boolean {
  return evidence.sourceRef?.startsWith(VERDICT_SOURCE_PREFIX) ?? false;
}
