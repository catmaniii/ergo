// agent 之间的来信（115 号票，用户 2026-10-13："收到其他 agent 的来信……不要上来就把信全部展示出来，搞成一行，写一句总结，
// 我可以点详情去查看"）：秘书会话里的任务做完、维护者来信，维护者会话里的秘书转达，运行时补给维护者的计划检查，在会话里
// 只画一行——图标、种类、一句话总结、时间、"详情 ›"——点开看全文（照 Markdown 画）。哪些算来信、总结从哪来在协议包
// （agent-letters.ts，守护进程写通知时用同一份标记）；这里给种类的说法和图标，详情里全文怎么交给 Markdown。
// 只改显示：交给 agent 的照旧是全文。给用户看的说明（"计划已确认，开始执行"）、没有标记的通知、工单分隔线、阶段框照旧。
import { type AgentLetterKind, currentWording, letterKindOf, letterSummaryOf, type MessageEnvelope } from "./protocol.ts";
import { RELAY_LABEL } from "./timeline.ts";

/** 会话里折成一行的一封来信 */
export interface AgentLetter {
  readonly kind: AgentLetterKind;
  /** 种类的说法："任务做完""维护者来信""<名字占位>转达""计划检查"（界面照名字标签画） */
  readonly label: string;
  /** 一行最前面的图标 */
  readonly icon: string;
  /** 一句话总结（守护进程存的，旧消息取第一句；换成现在的说法、名字占位留着） */
  readonly summary: string;
}

/** 每种来信的说法和图标（秘书转达的说法和气泡上方那行小字、要点标注同一个，103 号票） */
export const LETTER_LOOK: Readonly<Record<AgentLetterKind, { readonly label: string; readonly icon: string }>> = {
  task_done: { label: "任务做完", icon: "✅" },
  maintainer_letter: { label: "维护者来信", icon: "✉️" },
  secretary_relay: { label: RELAY_LABEL, icon: "📨" },
  plan_check: { label: "计划检查", icon: "📋" },
};

/** 这条消息是不是来信、是的话那一行写什么；不是来信的是 undefined */
export function agentLetterOf(message: MessageEnvelope): AgentLetter | undefined {
  const kind = letterKindOf(message);
  if (kind === undefined) return undefined;
  return { kind, ...LETTER_LOOK[kind], summary: currentWording(letterSummaryOf(message)) };
}

/** 代码块的开头、结尾 */
const FENCE = /^\s*(`{3,}|~{3,})/;

/**
 * 详情里来信的全文交给 Markdown 之前：运行时写的通知用单个换行分行（"它最后说：\n……\n交付的文件……"），Markdown 会把它们
 * 并成一行——代码块外、这一行和下一行都不空的，行尾加硬换行（两个空格）。空行、代码块里的不动
 */
export function letterMarkdown(text: string): string {
  const lines = text.split("\n");
  let fence: string | undefined;
  return lines
    .map((line, i) => {
      const marker = FENCE.exec(line)?.[1];
      if (marker !== undefined) {
        if (fence === undefined) fence = marker[0];
        else if (marker[0] === fence) fence = undefined;
        return line;
      }
      if (fence !== undefined) return line;
      const next = lines[i + 1];
      return line.trim() !== "" && next !== undefined && next.trim() !== "" ? `${line}  ` : line;
    })
    .join("\n");
}
