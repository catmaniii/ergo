// 关注类别的确定规则（匹配工具、路径、收件人、金额）在交给守卫之前的检查和规范化（26 号票）：
// 设置页的自定义类别、计划里维护者加的和用户在计划卡上加的本任务类别都过这一道。
// - 至少要有一个条件；
// - 工具要是认得的（工具注册表里登记的、bash 拆出的伪工具、代为执行的工具、快速动作 quick_action:<类型>）：写错了的名字永远匹配不上；
// - 路径要写完整的 Windows 路径（盘符或网络路径），统一成反斜杠、去掉末尾的分隔符：守卫按"在这个目录之内"比，相对路径没有意义；
// - 收件人去掉首尾空白；
// 守卫自己匹配时不分大小写、不分斜杠方向（guard/paths.ts、judge.ts 的 matchCustomCategory）。
import { win32 } from "node:path";
import type { WatchCategoryMatch, WatchToolChoice } from "@ergou/protocol";

export interface CheckedMatch {
  match: WatchCategoryMatch;
  problems: string[];
}

const ABSOLUTE = /^(?:[a-z]:[\\/]|\\\\)/i;

/** 去掉首尾空白、空的和重复的 */
function list(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((v) => v.trim()).filter(Boolean))];
}

export function normalizeCategoryMatch(match: WatchCategoryMatch, tools: readonly WatchToolChoice[]): CheckedMatch {
  const problems: string[] = [];
  const out: WatchCategoryMatch = {};

  const toolNames = list(match.tools);
  if (toolNames.length > 0) {
    const known = new Set(tools.map((t) => t.name));
    for (const name of toolNames) if (!known.has(name)) problems.push(`没有这个工具：${name}（设置页的候选里列着能匹配的工具）`);
    out.tools = toolNames;
  }
  const paths = list(match.paths);
  if (paths.length > 0) {
    out.paths = paths.map((p) => {
      if (!ABSOLUTE.test(p)) {
        problems.push(`路径要写完整的 Windows 路径（比如 D:\\code\\app\\db\\migrations）：${p}`);
        return p;
      }
      const n = win32.normalize(p);
      return n.length > 3 && /[\\/]$/.test(n) ? n.slice(0, -1) : n;
    });
  }
  const recipients = list(match.recipients);
  if (recipients.length > 0) out.recipients = recipients;
  if (match.amountOver !== undefined) out.amountOver = match.amountOver;
  if (Object.keys(out).length === 0) problems.push("规则至少要有一个条件（匹配工具、路径、收件人或金额）");
  return { match: out, problems };
}
