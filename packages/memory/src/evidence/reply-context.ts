// 证据原文里的"前文"一行：用户在会话里接着对方（秘书、负责人、通知、卡片）的话说的一句，读成证据时原文后面接一行
// 对方前面说了什么的意思（"［前文，不是用户说的］秘书问周六要不要去爬山"）。它只用来读懂用户这句在回什么：
// - 不是用户说的：不能单独当关于用户的证据、不能拿它确认或否认结论，前文里说用户怎样的话不算到用户头上；
// - 规则版的解析（抽事实、认变化和纠正的说法、读回答是 / 不是、约束和难处的说法、认人物信息）一律只看用户自己的话（userWordsOf）；
// - 交给模型的照样带着这一行（模型看了才懂"好""不用"回的是什么），提示词里讲明规矩（REPLY_CONTEXT_RULE）；
//   模型版抽事实另有一道硬关：原文片段（span）只出自前文的事实、关系、别名丢掉（kg/llm-extractor.ts）。
// 数据源素材的场景一行（"［场景］…"）不受影响：它不是前文。
// 二狗那边由记忆插件按素材上挂的前文拼（daemon/src/memory/evidence-source.ts）；合成数据的 reply_to 字段同样拼（synthetic.ts）。

/** 前文那一行的开头 */
export const REPLY_CONTEXT_PREFIX = "［前文，不是用户说的］";

/** 给模型的规矩（抽事实、判证据、复核……的提示词里接上）：前文那一行只用来读懂用户这句 */
export const REPLY_CONTEXT_RULE = `原文里以"${REPLY_CONTEXT_PREFIX}"开头的那一行是用户这句话之前对方（秘书、负责人、通知、卡片）说的意思，只用来读懂用户这句在回什么：前文里说用户怎样、提议了什么、汇报了什么都不是用户说的，不能算到用户头上，也不能单独拿来支持或反驳关于用户的结论；用户这句表示同意、拒绝、回答的，按用户这句的意思读（前文提议周六去爬山、用户回"好"，是用户答应周六去爬山）`;

/** 原文后面接上前文那一行（总结里的换行压成空格） */
export function withReplyContext(text: string, summary: string): string {
  const line = summary.replace(/\s+/g, " ").trim();
  return line.length === 0 ? text : `${text}\n${REPLY_CONTEXT_PREFIX}${line}`;
}

/** 原文里前文那一行的内容（不带开头）；没有是 undefined */
export function replyContextOf(text: string): string | undefined {
  const line = text.split("\n").find((l) => l.startsWith(REPLY_CONTEXT_PREFIX));
  return line === undefined ? undefined : line.slice(REPLY_CONTEXT_PREFIX.length);
}

/** 用户自己的话：原文去掉前文那一行（没有前文的原样返回） */
export function userWordsOf(text: string): string {
  if (!text.includes(REPLY_CONTEXT_PREFIX)) return text;
  return text
    .split("\n")
    .filter((l) => !l.startsWith(REPLY_CONTEXT_PREFIX))
    .join("\n");
}

/** 这段原文片段只出自前文（不在用户自己的话里、在前文里）：模型版抽事实据此丢掉算到用户头上的前文 */
export function spanOnlyInReplyContext(text: string, span: string): boolean {
  const context = replyContextOf(text);
  if (context === undefined) return false;
  const needle = span.trim();
  if (needle.length === 0) return false;
  return !userWordsOf(text).includes(needle) && context.includes(needle);
}

/** 证据换成只有用户自己的话（规则版的解析用；没有前文的原样返回同一个对象） */
export function withUserWordsOnly<E extends { text: string }>(evidence: E): E {
  const own = userWordsOf(evidence.text);
  return own === evidence.text ? evidence : { ...evidence, text: own };
}
