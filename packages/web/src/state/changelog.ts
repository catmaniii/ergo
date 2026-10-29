// 关于页的更新日志（124 号票，用户 2026-10-14 选：关于页显示这一版的更新日志）：构建时把仓库根目录的 CHANGELOG.md 原样打进页面
// （build/build-info-plugin.ts），这里按二级标题切成一节一节（"## [0.2.1] - 2026-10-14"，Keep a Changelog 的写法；
// 方括号、日期都可以没有），取当前版本那一节显示，比它早的放在"以前的版本"里能展开。代码块里的 ## 不算标题。
// 开头不属于哪一版的说明不要；比当前版本新的（"未发布"）不算以前的版本。
// 日志里照领域术语写的"秘书"，构建时换成名字占位，显示时填用户起的名字（changelogWithName，主会话 2026-10-14 定）。
import { ASSISTANT_NAME_MARK } from "./protocol.ts";

export interface ChangelogSection {
  /** 版本号（方括号里的；"未发布"这类也照原样） */
  readonly version: string;
  /** 标题上写的日期 */
  readonly date?: string;
  /** 这一节的正文（Markdown，去掉首尾的空行） */
  readonly body: string;
}

/** 一节的标题：## [版本] - 日期 */
const HEADING = /^##\s+\[?([^\]\s]+)\]?(?:\s+-\s+(\S.*?))?\s*$/;
/** 代码块的边 */
const FENCE = /^\s*(```|~~~)/;
/** 算正式发布过的版本（数字开头的版本号） */
const RELEASED = /^\d+\.\d+/;

/** 按二级标题切成一节一节（按文件里的先后，新的在上面） */
export function changelogSections(markdown: string): ChangelogSection[] {
  const sections: { version: string; date?: string; lines: string[] }[] = [];
  let inFence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (FENCE.test(line)) inFence = !inFence;
    const heading = inFence ? null : HEADING.exec(line);
    if (heading) {
      sections.push({ version: heading[1]!, ...(heading[2] ? { date: heading[2] } : {}), lines: [] });
      continue;
    }
    sections.at(-1)?.lines.push(line);
  }
  return sections.map(({ lines, ...head }) => ({ ...head, body: lines.join("\n").trim() }));
}

/**
 * 更新日志里的名字占位填上现在的名字（主会话 2026-10-14 定：和界面上别处一样说用户起的名字，改名后跟着变）。占位是构建时从
 * "秘书"换来的（build/build-info-plugin.ts 的 markAssistantName）。名字原样放进去：不认 $& 这类替换记号，名字里不能有占位的
 * 括号，所以不会再被当成占位
 */
export function changelogWithName(markdown: string, name: string): string {
  return markdown.split(ASSISTANT_NAME_MARK).join(name);
}

/**
 * 当前版本那一节，和比它早的几节（文件里在它下面的）。日志里没有当前版本（忘了写）时没有那一节，正式发布过的几版都算以前的
 */
export function changelogFor(markdown: string, version: string): { current: ChangelogSection | undefined; earlier: ChangelogSection[] } {
  const sections = changelogSections(markdown);
  const at = sections.findIndex((s) => s.version === version);
  if (at < 0) return { current: undefined, earlier: sections.filter((s) => RELEASED.test(s.version)) };
  return { current: sections[at], earlier: sections.slice(at + 1) };
}
