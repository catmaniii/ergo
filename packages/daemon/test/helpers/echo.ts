// faux 剧本 echo_context 回显的上下文：每条用户消息前面有一行本地时间标记（投影第 1 版，09 号票），
// 时间每次都不一样。只关心消息内容的断言先把标记去掉；标记本身在 attachments.test.ts 里单独断言。
export const TIME_MARKER = /\[\d{4}-\d{2}-\d{2} 周[一二三四五六日] \d{2}:\d{2} [+-]\d{2}:\d{2}\]\n/g;

export function stripTimeMarkers(context: string): string {
  return context.replace(TIME_MARKER, "");
}

/**
 * 回显的上下文里模型此刻能用的工具（名字，按先后）：开头那条系统消息带的那一份。273 号票起接着会话时换了工具也是开头一份、
 * 按这次交的先后（子进程给每次请求排一遍），会话中途不再列增减（[tool-removed]）；开头之后的 [tool] 行是以前回显的旧上下文，不算
 */
export function toolsNow(context: string): string[] {
  const end = context.indexOf("\n[user]");
  const head = end < 0 ? context : context.slice(0, end);
  return head.split("\n").flatMap((line) => (line.startsWith("[tool] ") ? [line.slice("[tool] ".length).trim()] : []));
}
