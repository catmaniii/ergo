// 会话外层 .conv 上给风格用的两样（40 号票，不改样子）：data-mode 分得出秘书和维护者的会话；秘书的会话挂内联自定义属性
// --assistant-initial（个人助理名字的第一个字，已经写成 CSS 字符串），风格用 content: var(--assistant-initial) 画字头像
// （暖纸手帐）。维护者的会话不挂：那里说话的不是个人助理。取第一个字在状态层（state/assistant-name.ts 的 assistantInitial）。
// 单独一个 .ts（不带 JSX），组件测试在 Node 里直接渲染它给的属性（test/ui/conversation-root.test.ts）。
import type { CSSProperties } from "react";
import { assistantInitial } from "../../state/index.ts";

/** 会话的种类：秘书主线，或者任务、项目的维护者（和输入框的 ComposerMode 一样） */
export type ConversationRootMode = "secretary" | "maintainer";

/**
 * 一段文字写成 CSS 字符串（给 content 用）：外面加双引号；双引号、反斜杠前面加反斜杠；控制字符（换行这类）写成十六进制转义
 * （后面跟一个空格，免得和后面的字连成一个转义）
 */
export function cssString(text: string): string {
  const body = Array.from(text, (ch) => {
    const code = ch.codePointAt(0)!;
    if (ch === '"' || ch === "\\") return `\\${ch}`;
    if (code < 0x20 || code === 0x7f) return `\\${code.toString(16)} `;
    return ch;
  }).join("");
  return `"${body}"`;
}

/** .conv 上的属性：data-mode 总是有；--assistant-initial 只在秘书的会话里有 */
export function conversationRootProps(mode: ConversationRootMode, assistantName: string): { "data-mode": ConversationRootMode; style?: CSSProperties } {
  if (mode !== "secretary") return { "data-mode": mode };
  return { "data-mode": mode, style: { "--assistant-initial": cssString(assistantInitial(assistantName)) } as CSSProperties };
}
