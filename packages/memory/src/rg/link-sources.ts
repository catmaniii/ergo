// 330 号票（R14，ADR-0032）：哪些关联能算决定性。原来"用户明说的算决定性"，随口说的一句就能推翻一条结论；R14 改成只有
// 当面问、用户明确确认 / 否掉的（表态、回答了解你问题）、用户的纠正、预测被证伪才算决定性，别的"决定性"计分时按强的算（scoring.ts）。
// 认法看关联的说法开头（这几处写关联时都用下面的开头）和证据的种类（纠正）。

/** 用户确认（confirmClaim）记的那条决定性支持的说法开头；263 号票收回确认时按它认 */
export const USER_CONFIRMATION = "用户确认：";
/** 263 号票：用户否认（rejectClaim）记的那条决定性反证的说法开头 */
export const USER_DENIAL = "用户否认：";
/** 198 号票：回答了解你问题写的关联的说法开头（rg/questions.ts） */
export const ANSWER_BASIS = "回答了解你问题";
/** 330 号票（R10）：演绎预测落空、撤错的前提那条决定性反证的说法开头（rg/falsify.ts） */
export const FALSIFIED_BASIS = "演绎预测";
/** 明说的结论跟着它那条事实的决定性支持（reasoning-graph.ts 的 createExplicit）：明说的结论不在组里计分，这条照旧 */
export const STATED_BASIS = "用户明说：";

const FACE_TO_FACE = [USER_CONFIRMATION, USER_DENIAL, ANSWER_BASIS, FALSIFIED_BASIS, STATED_BASIS];

/** 这条关联的说法是不是当面确认 / 否掉、回答、证伪、明说结论自己的那条（能算决定性） */
export function faceToFaceRationale(rationale: string): boolean {
  return FACE_TO_FACE.some((p) => rationale.startsWith(p));
}
