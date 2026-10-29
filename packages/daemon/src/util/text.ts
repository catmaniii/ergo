// 给人看的短文本：参数摘要、结果摘要、审批卡和待我处理事项的标题都压成一行再截短。

/** 压成一行（连续空白并成一个空格）、截到 max 个字符，截掉的用"…"表示 */
export function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}
