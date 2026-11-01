// 秘书和负责人用所选语言回答：系统提示和工具说明是写给模型看的，照旧中文，
// 只在每个 agent 的系统提示末尾加一句"用 <语言> 回答用户"，语言名取 _meta.json 里给模型的（modelName）。中文时不加。
// agent 管家拉起每个 agent 时接在前缀后面一起加（daemon.ts 的 systemPromptPrefix），⚙ 面板里"实际生效的"也带着它。
// 提示和工具说明里到处写着产品名"二狗"，不说一声模型会照抄给英文用户，所以这一句里顺带说清这个语言里产品叫什么
// （取默认名字那一句，这个语言没翻时退回中文，就不说）。这不是模型叫什么：叫什么在系统提示的"用户叫你「…」"里，用户起的名字照旧。
// @i18n-ignore-file model：这一句是给模型看的
import { DEFAULT_LANGUAGE, defaultAssistantName, type LocaleMeta } from "@ergo/protocol";

/** 中文里的产品名：提示里写的是它 */
const PRODUCT_NAME_IN_PROMPTS = "二狗";

/** 加在系统提示末尾的那一句；中文时没有 */
export function answerLanguageLine(meta: LocaleMeta): string | undefined {
  if (meta.id === DEFAULT_LANGUAGE) return undefined;
  const product = defaultAssistantName();
  const naming = product === PRODUCT_NAME_IN_PROMPTS ? "" : `系统提示和工具说明里的“${PRODUCT_NAME_IN_PROMPTS}”是这个产品的中文名，对用户说的时候写 ${product}。`;
  return `用 ${meta.modelName} 回答用户，给用户看的报告、文件也用 ${meta.modelName}。${naming}`;
}

/** 系统提示末尾接上那一句（中文时原样） */
export function withLanguageLine(systemPrompt: string, meta: LocaleMeta): string {
  const line = answerLanguageLine(meta);
  return line === undefined ? systemPrompt : `${systemPrompt}\n\n${line}`;
}
