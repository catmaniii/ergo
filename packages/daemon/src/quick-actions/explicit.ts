// "明确点了"的运行时判定（规格第 9 节"快速动作的确认"）：不由秘书自报，每个执行器自己声明判定（registry.ts 的 explicit），
// 用这里的共用辅助函数。纯函数。
// - 用户这一轮说了什么（UserTurn）：用户自己打的字、消息里的引用块（素材切段的同一套规则，materials/segments.ts）、
//   用户引用的卡片（纯文本降级和负载里的文字）；
// - foundIn：对象、内容原样出现在哪里（自己打的字优先，其次引用块、引用的卡片）；
// - commandTails：命令式的动作（记住、忘掉……）用：用户打的字里的触发词（前面没有否定词）后面到句末的那一段。
import type { Card, MessagePart } from "@ergou/protocol";
import { messagePieces } from "../materials/index.ts";

/** 用户这一轮说了什么 */
export interface UserTurn {
  /** 用户自己打的字（消息里引用块之外的文字），一段一项 */
  typed: string[];
  /** 消息里的引用块（外部、不可信），一块一项 */
  quotes: string[];
  /** 用户引用的卡片：每张卡的纯文本降级和负载里的文字 */
  cards: string[][];
}

/** 点明了，以及点明的内容在哪里：用户自己打的字、引用块、引用的卡片（素材的来源标记跟着它） */
export interface ExplicitFinding {
  source: "typed" | "quote" | "card";
}

/** 否定词：触发词前面（同一个分句里）有它们的，不算下了命令 */
export const NEGATIONS: readonly string[] = ["别", "不要", "不用", "不必", "无需", "甭"];

/** 句末：触发词后面的那一段到这里为止 */
const SENTENCE_END = /[。！？!?；;\n]/;
/** 分句的分隔：找否定词只看触发词所在的分句 */
const CLAUSE_BREAK = /[，,。！？!?；;\n、：:]/;

/** 用户这一轮说了什么（一条用户消息） */
export function userTurnOf(parts: readonly MessagePart[], cardOf: (cardId: string) => Card | undefined): UserTurn {
  const turn: UserTurn = { typed: [], quotes: [], cards: [] };
  for (const piece of messagePieces(parts)) {
    if (piece.form === "typed") turn.typed.push(piece.text);
    else if (piece.form === "quote") turn.quotes.push(piece.text);
  }
  for (const part of parts) {
    if (part.type !== "card_ref") continue;
    const card = cardOf(part.cardId);
    if (card) turn.cards.push([card.text, ...stringsIn(card.payload)]);
  }
  return turn;
}

/**
 * 比较前的规范化：NFKC（全角半角统一）、连续的空白并成一个空格、去掉首尾空白。
 * 只抹掉排版上的差别，字一个都不能变（"原样出现"）
 */
export function normalizeForMatch(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}

/** 只留字：NFKC 之后去掉全部空白、标点和符号（"和触发词后面那一段一致"按它比） */
export function bareText(text: string): string {
  return text.normalize("NFKC").replace(/[\s\p{P}\p{S}]/gu, "");
}

/** 一段文字原样出现在哪里：用户自己打的字优先，其次引用块、引用的卡片；哪里都没有是 undefined */
export function foundIn(turn: UserTurn, text: string): ExplicitFinding | undefined {
  const needle = normalizeForMatch(text);
  if (needle.length === 0) return undefined;
  const has = (texts: readonly string[]) => texts.some((t) => normalizeForMatch(t).includes(needle));
  if (has(turn.typed)) return { source: "typed" };
  if (has(turn.quotes)) return { source: "quote" };
  if (turn.cards.some(has)) return { source: "card" };
  return undefined;
}

/**
 * 用户自己打的字里每个触发词（同一个分句里前面没有否定词）后面到句末的那一段（原样，没去标点）。
 * 比如"记住：下周三上午体检。"→"：下周三上午体检"；"别记住这个"没有（前面有否定词）
 */
export function commandTails(turn: UserTurn, triggers: readonly string[], negations: readonly string[] = NEGATIONS): string[] {
  const tails: string[] = [];
  for (const text of turn.typed) {
    for (const trigger of triggers) {
      for (let at = text.indexOf(trigger); at >= 0; at = text.indexOf(trigger, at + 1)) {
        const before = text.slice(0, at);
        const clause = before.slice(lastIndexOf(before, CLAUSE_BREAK) + 1);
        if (negations.some((n) => clause.includes(n))) continue;
        const after = text.slice(at + trigger.length);
        const end = after.search(SENTENCE_END);
        tails.push(end < 0 ? after : after.slice(0, end));
      }
    }
  }
  return tails;
}

function lastIndexOf(text: string, pattern: RegExp): number {
  for (let i = text.length - 1; i >= 0; i--) if (pattern.test(text[i]!)) return i;
  return -1;
}

function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(stringsIn);
  return [];
}
