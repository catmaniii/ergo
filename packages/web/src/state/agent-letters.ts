// agent 之间的来信（"收到其他 agent 的来信……不要上来就把信全部展示出来，搞成一行，写一句总结，
// 我可以点详情去查看"）：秘书会话里的任务做完、负责人来信，负责人会话里的秘书转达，运行时补给负责人的计划检查，在会话里
// 只画一行——图标、种类、一句话总结、时间、"详情 ›"——点开看全文（照 Markdown 画）。哪些算来信、总结从哪来在协议包
// （agent-letters.ts，守护进程写通知时用同一份标记）；这里给种类的说法和图标，详情里全文怎么交给 Markdown。
// 只改显示：交给 agent 的照旧是全文。给用户看的说明（"计划已确认，开始执行"）、没有标记的短通知、工单分隔线、阶段框照旧。
// 运行时交给 agent 的长通知没有标记也折（一句话总结 + "详情 ›"，种类只在详情里写）；阶段说明的总结写是哪一步，取不到退回第一句。
import { type AgentLetterKind, currentWording, letterKindOf, letterSummaryOf, type MessageEnvelope, stageBriefOf, t } from "./protocol.ts";
import { relayLabel } from "./timeline.ts";

/** 会话里折成一行的一封来信 */
export interface AgentLetter {
  readonly kind: AgentLetterKind;
  /** 种类的说法："任务做完""负责人来信""<名字占位>转达""计划检查""系统说明"（界面照名字标签画） */
  readonly label: string;
  /** 一行最前面的图标 */
  readonly icon: string;
  /** 一句话总结（守护进程存的，旧消息取第一句；换成现在的说法、名字占位留着） */
  readonly summary: string;
}

/** 每种来信的说法和图标（秘书转达的说法和气泡上方那行小字、要点标注同一个）；说法按当前语言现取（取值函数） */
export const LETTER_LOOK: Readonly<Record<AgentLetterKind, { readonly label: string; readonly icon: string }>> = {
  task_done: { get label() { return t("state.agentLetters.taskDone"); }, icon: "✅" },
  maintainer_letter: { get label() { return t("state.agentLetters.maintainerLetter"); }, icon: "✉️" },
  secretary_relay: { get label() { return relayLabel(); }, icon: "📨" },
  plan_check: { get label() { return t("state.agentLetters.planCheck"); }, icon: "📋" },
  notice: { get label() { return t("state.detailContent.text.system"); }, icon: "📝" },
};

/** 那一行的总结：阶段说明写清楚是哪一步；存了总结的、没有那一行的走来信的老路：存的总结、第一句 */
function summaryOf(kind: AgentLetterKind, message: MessageEnvelope): string {
  const stage = kind === "notice" && !message.summary ? stageBriefOf(message.parts.map((p) => (p.type === "text" ? p.text : "")).join("")) : undefined;
  return stage ? t("state.agentLetters.stageSummary", { code: stage.code, title: stage.title }) : currentWording(letterSummaryOf(message));
}

/** 这条消息是不是来信、是的话那一行写什么；不是来信的是 undefined。agentInput：这条交给了 agent（消息事件上的，没有标记的长通知按它认） */
export function agentLetterOf(message: MessageEnvelope, agentInput = false): AgentLetter | undefined {
  const kind = letterKindOf(message, agentInput);
  if (kind === undefined) return undefined;
  return { kind, ...LETTER_LOOK[kind], summary: summaryOf(kind, message) };
}

/** 代码块的开头、结尾 */
const FENCE = /^\s*(`{3,}|~{3,})/;

/** 列表的一项 */
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;

/**
 * 详情里来信的全文交给 Markdown 之前：运行时写的通知用单个换行分行（"它最后说：\n……\n交付的文件……"），Markdown 会把它们
 * 并成一行——代码块外、这一行和下一行都不空的，行尾加硬换行（两个空格）。空行、代码块里的不动。
 * 列表后面紧跟不缩进的一行（阶段说明的"- （没有）\n时序规则："），Markdown 会把它并进上一项，隔一个空行让列表先结束
 */
export function letterMarkdown(text: string): string {
  const lines = text.split("\n");
  let fence: string | undefined;
  let inList = false;
  return lines
    .map((line, i) => {
      const marker = FENCE.exec(line)?.[1];
      if (marker !== undefined) {
        if (fence === undefined) fence = marker[0];
        else if (marker[0] === fence) fence = undefined;
        return line;
      }
      if (fence !== undefined) return line;
      if (line.trim() === "") inList = false;
      else if (LIST_ITEM.test(line)) inList = true;
      else if (!/^\s/.test(line)) inList = false;
      const next = lines[i + 1];
      if (line.trim() === "" || next === undefined || next.trim() === "") return line;
      return inList && !LIST_ITEM.test(next) && !/^\s/.test(next) ? `${line}\n` : `${line}  `;
    })
    .join("\n");
}
