// 秘书页左上角的标题（89 号票，用户 2026-10-11 定）："个人秘书："后面跟名字标签，名字跟着改名变（写什么在状态层的 secretaryTitle）。
// 前缀不截、名字标签放不下时在末尾截成省略号；窄屏上字号按名字的字数（最多按 4 个字）缩到放得下，--secretary-fit-chars 交给样式：
// 样式在 base.css 的 .secretary-title，各套风格在自己的 style.css 里按标题的样子再调（比如水墨国风的朱砂印章跟着一起缩）。
import type { CSSProperties } from "react";
import { secretaryTitle } from "../state/index.ts";
import { NameTag } from "./assistant-name.tsx";

/** name：现在的名字（秘书页用 useAssistantName() 取） */
export function SecretaryTitle({ name }: { name: string }) {
  const title = secretaryTitle(name);
  return (
    <span className="secretary-title" title={title.plain} style={{ "--secretary-fit-chars": title.fitChars } as CSSProperties}>
      <span className="secretary-title-lead">{title.prefix}</span>
      <NameTag name={title.name} />
    </span>
  );
}
