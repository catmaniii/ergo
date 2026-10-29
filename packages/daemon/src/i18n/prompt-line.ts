// 秘书和维护者用所选语言回答（168 号票，用户 2026-10-19 定）：系统提示和工具说明是写给模型看的，照旧中文，
// 只在每个 agent 的系统提示末尾加一句"用 <语言> 回答用户"，语言名取 _meta.json 里给模型的（modelName）。中文时不加。
// agent 管家拉起每个 agent 时接在前缀后面一起加（daemon.ts 的 systemPromptPrefix），⚙ 面板里"实际生效的"也带着它。
// @i18n-ignore-file model：这一句是给模型看的
import { DEFAULT_LANGUAGE, type LocaleMeta } from "@ergo/protocol";

/** 加在系统提示末尾的那一句；中文时没有 */
export function answerLanguageLine(meta: LocaleMeta): string | undefined {
  if (meta.id === DEFAULT_LANGUAGE) return undefined;
  return `用 ${meta.modelName} 回答用户，给用户看的报告、文件也用 ${meta.modelName}。`;
}

/** 系统提示末尾接上那一句（中文时原样） */
export function withLanguageLine(systemPrompt: string, meta: LocaleMeta): string {
  const line = answerLanguageLine(meta);
  return line === undefined ? systemPrompt : `${systemPrompt}\n\n${line}`;
}
