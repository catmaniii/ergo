// faux 剧本 echo_context 回显的上下文：每条用户消息前面有一行本地时间标记（投影第 1 版，09 号票），
// 时间每次都不一样。只关心消息内容的断言先把标记去掉；标记本身在 attachments.test.ts 里单独断言。
export const TIME_MARKER = /\[\d{4}-\d{2}-\d{2} 周[一二三四五六日] \d{2}:\d{2} [+-]\d{2}:\d{2}\]\n/g;

export function stripTimeMarkers(context: string): string {
  return context.replace(TIME_MARKER, "");
}
