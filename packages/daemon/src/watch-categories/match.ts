// 关注类别的名字和确定规则（匹配工具、路径、收件人、金额）在交给守卫之前的检查和规范化（26 号票），守护进程里只有这一处：
// 设置页的自定义类别、计划里维护者加的和用户在计划卡上加的本任务类别都过这一道。
// - 名字不能是空的；规则至少要有一个条件；
// - 工具名不查登记：可以为还没登记的工具（比如以后接上的 MCP 工具）建类别，登记了才会命中（界面上提示）；
//   规则里的工具后来没了，也不妨碍只改处置；
// - 路径要写完整的 Windows 路径（盘符或网络路径；Git Bash 的盘符写法 /d/x 换成 D:\x），统一成反斜杠、去掉末尾的分隔符：
//   守卫按"在这个目录之内"比，相对路径没有意义；
// - 列表去掉首尾空白、空的和重复的。
// 守卫自己匹配时不分大小写、不分斜杠方向（guard/paths.ts、judge.ts 的 matchCustomCategory）。
import { win32 } from "node:path";
import { t, type WatchCategoryMatch } from "@ergo/protocol";
import { fromShellDrivePath, isWindowsAbsolutePath } from "../guard/index.ts";

export interface CheckedCategory {
  title: string;
  match: WatchCategoryMatch;
  problems: string[];
}

/** 去掉首尾空白、空的和重复的 */
function list(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((v) => v.trim()).filter(Boolean))];
}

/** 一个类别的名字和规则：检查并规范化；problems 不空表示不能用 */
export function normalizeCategoryMatch(category: { title: string; match: WatchCategoryMatch }): CheckedCategory {
  const { match } = category;
  const title = category.title.trim();
  const problems: string[] = title === "" ? [t("watchCategories.match.emptyName")] : [];
  const out: WatchCategoryMatch = {};

  const tools = list(match.tools);
  if (tools.length > 0) out.tools = tools;
  const paths = list(match.paths);
  if (paths.length > 0) {
    out.paths = paths.map((raw) => {
      const p = fromShellDrivePath(raw) ?? raw;
      if (!isWindowsAbsolutePath(p)) {
        problems.push(t("watchCategories.match.notAbsolute", { path: raw }));
        return raw;
      }
      const n = win32.normalize(p);
      return n.length > 3 && /[\\/]$/.test(n) ? n.slice(0, -1) : n;
    });
  }
  const recipients = list(match.recipients);
  if (recipients.length > 0) out.recipients = recipients;
  if (match.amountOver !== undefined) out.amountOver = match.amountOver;
  if (Object.keys(out).length === 0) problems.push(t("watchCategories.match.noCondition"));
  return { title, match: out, problems };
}
