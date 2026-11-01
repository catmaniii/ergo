// agent 之间的来信（115 号票，用户 2026-10-13："收到其他 agent 的来信……不要上来就把信全部展示出来，搞成一行，写一句总结，
// 我可以点详情去查看"）：别的 agent 或运行时写给这个 agent 的消息——秘书会话里的任务做完、维护者来信，维护者会话里的秘书转达，
// 运行时补给维护者的计划检查——会话里只显示"种类 + 一句总结"，点详情看全文。只改显示：交给 agent 的照旧是全文。
// 守护进程（通知开头的标记、写进消息的一句总结）和 Web（认哪些折、旧消息没有总结时的退路）共用这一份；不引用 TypeBox。
// 367 号票（用户 2026-11-01："这种需求一大段文字应该默认折叠，点详情再展开"）：运行时交给 agent 的通知没有标记的，长的也折（"notice"），
// 只看文字长度和交没交给 agent，老消息照样折，不用迁移；阶段说明那一行（stageBriefLine）守护进程照它写、界面照它认是哪一步。
import type { MessageEnvelope } from "./schema.ts";

/**
 * 运行时写给 agent 的通知开头的标记（守护进程的 secretary/notice-tags.ts 取这里的；计划检查的那个在守卫里另写了一份
 * NUDGE_PREFIX，守护进程的测试核对两边一样）。开头是这几个标记的系统消息在会话里折成一行
 */
export const LETTER_TAGS = {
  /** 任务做完告诉秘书（99 号票），开了跑完自动播报的后面还紧跟一个标记（100 号票） */
  task_done: "【任务做完】", // @i18n-ignore model：给 agent 的通知开头的标记
  /** 维护者等 agent 给秘书发的消息，经运行时转交（102 号票） */
  maintainer_letter: "【维护者来信】", // @i18n-ignore model
  /** 流程、定时触发的流程收工时还有步骤没做也没说明跳过，运行时提醒维护者（59、76 号票） */
  plan_check: "【计划检查】", // @i18n-ignore model
} as const;

/**
 * 来信的种类：上面几种通知，秘书按用户的话转达进任务、项目维护者会话的那一句（103 号票：发言方是用户、标着 relayedBy），
 * 和没有标记、但长的通知（367 号票）
 */
export type AgentLetterKind = keyof typeof LETTER_TAGS | "secretary_relay" | "notice";

/** 没有标记的通知多长算长、折成一行（367 号票）：超过这么多字或这么多行 */
export const NOTICE_FOLD = { chars: 120, lines: 2 } as const;

/** 这段通知的文字算不算长 */
function isLongNotice(text: string): boolean {
  const trimmed = text.trim();
  return [...trimmed].length > NOTICE_FOLD.chars || trimmed.split("\n").length > NOTICE_FOLD.lines;
}

/** 一句话总结最多几个字（含截短时的省略号） */
export const LETTER_SUMMARY_MAX = 30;

/**
 * 这条消息在会话里算哪种来信；不是来信（用户自己打的、agent 说的、给用户看的系统说明、没有标记的短通知）是 undefined。
 * agentInput：这条交给了 agent（消息事件上的 agentInput），没有标记的通知只有交给 agent、又长的才折；带附件的不折（附件要露在外面）
 */
export function letterKindOf(message: Pick<MessageEnvelope, "speaker" | "parts" | "relayedBy">, agentInput = false): AgentLetterKind | undefined {
  if (message.speaker === "user") return message.relayedBy === undefined ? undefined : "secretary_relay";
  if (message.speaker !== "system") return undefined;
  const first = message.parts[0];
  if (first?.type !== "text") return undefined;
  const tagged = (Object.keys(LETTER_TAGS) as (keyof typeof LETTER_TAGS)[]).find((kind) => first.text.startsWith(LETTER_TAGS[kind]));
  if (tagged) return tagged;
  const onlyText = message.parts.every((p) => p.type === "text");
  return agentInput && onlyText && isLongNotice(message.parts.map((p) => (p.type === "text" ? p.text : "")).join("")) ? "notice" : undefined;
}

/**
 * 运行时交代一个阶段时写明是哪一步的那一行（367 号票）：守护进程的 stageText 照它写（给模型看的，只有中文），界面照 stageBriefOf 认，
 * 不用让人读第一句的长文。stage 的编号是计划里存的（"3""1a"）
 */
export function stageBriefLine(stage: { code: string; layers: number; stageId: string; title: string }): string {
  return `现在是第 ${stage.code}/${stage.layers} 阶段 ${stage.stageId}「${stage.title}」：`; // @i18n-ignore model
}

/** stageBriefLine 那一行 */
const STAGE_BRIEF_LINE = /^现在是第 ([^/\s]+)\/\d+ 阶段 [^\s「]+「(.+)」：$/m; // @i18n-ignore data

/** 这段通知交代的是哪个阶段；没有那一行的是 undefined */
export function stageBriefOf(text: string): { code: string; title: string } | undefined {
  const found = STAGE_BRIEF_LINE.exec(text);
  return found ? { code: found[1]!, title: found[2]! } : undefined;
}

/** 截到 max 个字（按字符数，含省略号；截在空格上的，省略号前不留空格） */
function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}…` : text;
}

/**
 * 一段话的第一句：第一个非空行到第一个句号、叹号、问号、分号为止（英文句点不算：文件名、版本号里都有），去掉末尾的冒号，
 * 长的截到 max 字。秘书转达的总结（103 号票的那一句）、旧消息的退路都用它
 */
export function firstSentence(text: string, max = LETTER_SUMMARY_MAX): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (line === undefined) return "";
  const cut = line.search(/[。！？!?；;]/); // @i18n-ignore data
  const sentence = (cut < 0 ? line : line.slice(0, cut)).replace(/[：:]+$/, "").trim(); // @i18n-ignore data
  return clip(sentence, max);
}

/** 开头的标记（可能连着两个：任务做完后面跟着跑完自动播报） */
const LEADING_TAGS = /^(?:【[^】\n]*】)+/; // @i18n-ignore data

/**
 * 运行时写的通知（旧的，没存总结）的第一句：去掉开头的标记，跳过引子——冒号结尾、后面还有内容的行（"后台有一件事做完了（……）："
 * "……的维护者说："），再取第一句
 */
function noticeFirstSentence(text: string): string {
  const lines = text
    .replace(LEADING_TAGS, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  let i = 0;
  while (i < lines.length - 1 && /[：:]$/.test(lines[i]!)) i += 1; // @i18n-ignore data
  return firstSentence(lines.slice(i).join("\n"));
}

/**
 * 来信在会话里那一行的一句总结：消息上存着的（守护进程写的：运行时拼的、agent 给的、转达的话的第一句）；
 * 旧消息没有的，取正文去掉标记后的第一句截短（秘书转达的取话本身的第一句）
 */
export function letterSummaryOf(message: Pick<MessageEnvelope, "speaker" | "parts" | "summary">): string {
  const stored = message.summary?.trim();
  if (stored) return stored;
  const text = message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
  return message.speaker === "system" ? noticeFirstSentence(text) : firstSentence(text);
}
