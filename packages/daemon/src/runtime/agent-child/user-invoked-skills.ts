// 只在用户点名时才用的 skill（72 号票）：SKILL.md 的 frontmatter 写了 `disable-model-invocation: true` 的
// （pstack 51 个里的 50 个，matt-pocock 的 implement、to-spec、wayfinder 这些也是）。
// pi 把它们从系统提示的 skill 清单里拿掉，只能靠用户打 `/skill:名字` 展开（pi 的写法）；二狗交给 pi 的每条用户消息第一行是本地时间标记，
// pi 那边的展开永远不会发生，模型也就不知道有这些 skill——工具包里选了等于没选。两种方式都支持（主会话 2026-10-10 定）：
// - 这里另起一段追加在系统提示后面，照作者的意思写明"只在用户点名时才用"（说出它的名字就算点名），列出名字、说明和文件位置；
//   用户没点名时模型不主动用。工具包里没有这类 skill 时不加这一段；
// - 用户打 `/目录名`（82 号票；`/skill:目录名` 是后备写法），守护进程在加时间标记之前就展开成 skill 的全文（skills/skill-command.ts）。
import type { Skill } from "@earendil-works/pi-coding-agent";

/** 追加在系统提示后面的一段；没有这类 skill 时是 undefined */
export function userInvokedSkillsBlock(skills: readonly Skill[]): string | undefined {
  const named = skills.filter((s) => s.disableModelInvocation);
  if (named.length === 0) return undefined;
  return [
    "下面这些 skill 的作者写明了只在用户点名时才用：用户说出它的名字（或者写 /目录名：location 里 SKILL.md 所在的那一层目录）就算点名，这时先用 read 读它的文件、照着做；",
    "文件里的相对路径按 skill 所在的目录解析。用户没点名时不要主动用它们。",
    "",
    "<user_invoked_skills>",
    ...named.flatMap((s) => ["  <skill>", `    <name>${escapeXml(s.name)}</name>`, `    <description>${escapeXml(s.description)}</description>`, `    <location>${escapeXml(s.filePath)}</location>`, "  </skill>"]),
    "</user_invoked_skills>",
  ].join("\n");
}

function escapeXml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
