// 给模型看的话照旧用中文（用户 2026-10-19 定：系统提示、工具说明、给 agent 的说明不翻；173 号票）。
// 有些话同一份既交回 agent、又给用户看：守卫的说明（判定的依据、"先问用户：……"）回给 agent，也写在审批卡、"交给我做"事项上；
// 计划检查查出的问题回给维护者，也写在审批卡、时间线上。这些话在代码里只写一遍、走 t()，要哪种语言就在哪种语言下算：
// - inModelLanguage(fn)：在中文下算（交回 agent 的那一份）；就是协议包的 forModel（172 号票），当前是中文时直接算；
// - 给用户看的那一份在用户的语言下照同样的输入再算一遍（守卫的判定、计划比对是纯函数，见 guard-runtime.ts 的 userView）。
import { activeLanguage, DEFAULT_LANGUAGE, forModel } from "@ergo/protocol";

/** 用户的语言就是中文（给用户的和给模型的是同一份，不用再算一遍） */
export function userLanguageIsModelLanguage(): boolean {
  return activeLanguage() === DEFAULT_LANGUAGE;
}

/** 在中文下算（给模型看的那一份） */
export function inModelLanguage<T>(fn: () => T): T {
  return forModel(fn);
}
