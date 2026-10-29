// @i18n-ignore-file data：认用户中文原话的词表和正则（否定词、句末、问句……），不是界面文字
// "明确点了"的运行时判定（规格第 9 节"快速动作的确认"）：不由秘书自报，每个执行器自己声明判定（registry.ts 的 explicit），
// 用这里的共用辅助函数。纯函数。
// - 用户这一轮说了什么（UserTurn）：用户自己打的字、语音识别出的文字（31 号票）、消息里的引用块（素材切段的同一套规则，
//   materials/segments.ts）、用户引用的卡片（纯文本降级和负载里的文字）；
// - 语音转写和打的字一样算用户自己说的话（ownWords，规格第 22 节"快速动作的点明"：用户发的语音，识别出的文字直接显示在
//   气泡下方，就算用户对识别结果的确认），只是点明的来源记成 voice（素材标"语音转写"）；
// - foundIn：对象、内容原样出现在哪里（自己说的话优先：打的字、语音转写，其次引用块、引用的卡片）；
// - commandTails：命令式的动作（记住、忘掉……）用：用户自己说的话里的触发词（前面没有否定词）后面到句末的那一段。
import { type Card, type MessagePart, voiceIdsOf } from "@ergo/protocol";
import { messagePieces } from "../materials/index.ts";

/** 用户这一轮说了什么 */
export interface UserTurn {
  /** 用户自己打的字（消息里引用块之外的文字），一段一项 */
  typed: string[];
  /** 用户这条消息里的语音识别出的文字（31 号票），一条语音一项；没识别出来的没有 */
  spoken: string[];
  /** 消息里的引用块（外部、不可信），一块一项 */
  quotes: string[];
  /** 用户引用的卡片：每张卡的纯文本降级和负载里的文字 */
  cards: string[][];
}

/** 用户自己说的话从哪里来：打的字、语音转写 */
export type OwnWordsSource = "typed" | "voice";

/** 点明了，以及点明的内容在哪里：用户自己打的字、语音转写、引用块、引用的卡片（素材的来源标记跟着它） */
export interface ExplicitFinding {
  source: OwnWordsSource | "quote" | "card";
}

/** 否定词：触发词前面（同一个分句里）有它们的，不算下了命令 */
export const NEGATIONS: readonly string[] = ["别", "不要", "不用", "不必", "无需", "甭"];

/** 句末：触发词后面的那一段到这里为止 */
const SENTENCE_END = /[。！？!?；;\n]/;
/** 分句的分隔：找否定词只看触发词所在的分句 */
const CLAUSE_BREAK = /[，,。！？!?；;\n、：:]/;

/**
 * 用户这一轮说了什么（一条用户消息）。cardOf 取引用的卡片，voiceTextOf 取语音识别出的文字
 * （识别完成的才有；秘书处理这条消息时语音已经有了结局，见 conversation/agent-session.ts）
 */
export function userTurnOf(parts: readonly MessagePart[], cardOf: (cardId: string) => Card | undefined, voiceTextOf: (voiceId: string) => string | undefined): UserTurn {
  const turn: UserTurn = { typed: [], spoken: [], quotes: [], cards: [] };
  for (const piece of messagePieces(parts)) {
    if (piece.form === "typed") turn.typed.push(piece.text);
    else if (piece.form === "quote") turn.quotes.push(piece.text);
  }
  for (const part of parts) {
    if (part.type !== "card_ref") continue;
    const card = cardOf(part.cardId);
    if (card) turn.cards.push([card.text, ...stringsIn(card.payload)]);
  }
  for (const voiceId of voiceIdsOf(parts)) {
    const text = voiceTextOf(voiceId);
    if (text !== undefined && text.trim() !== "") turn.spoken.push(text);
  }
  return turn;
}

/** 用户自己说的话，一段一项：打的字在前，语音转写在后（两者一样参与点明判定，来源分开记） */
export function ownWords(turn: UserTurn): Array<{ text: string; source: OwnWordsSource }> {
  return [...turn.typed.map((text) => ({ text, source: "typed" as const })), ...turn.spoken.map((text) => ({ text, source: "voice" as const }))];
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

// ───────────── 按句、按分句看（任务控制从严的那一套，22、100 号票；103 号票的秘书转达共用） ─────────────

/** 一句话（连同它结尾的标点）：句号、叹号、问号、分号、换行 */
const SENTENCES = /[^。！？!?；;\n]+[。！？!?；;\n]?/g;
/** 分句：逗号、顿号 */
const CLAUSE = /[，,、]/;
/** 问句的收尾（去掉结尾的标点和空白之后） */
const QUESTION_ENDINGS = ["吗", "么", "呢", "没有", "没", "嘛"];

/** 一段话拆成一句一句（连同句末的标点） */
export function sentencesOf(text: string): string[] {
  return text.match(SENTENCES) ?? [];
}

/** 一句话拆成分句（逗号、顿号分） */
export function clausesOf(sentence: string): string[] {
  return sentence.split(CLAUSE);
}

/** 问句：以问号结尾，或者以"吗""么""呢""没有"这类收尾的（"t-3 取消了吗？"） */
export function isQuestion(sentence: string): boolean {
  if (/[？?]\s*$/.test(sentence)) return true;
  const body = sentence.replace(/[\s\p{P}\p{S}]+$/u, "");
  return QUESTION_ENDINGS.some((ending) => body.endsWith(ending));
}

/** 编号作为一个词出现（"t-1" 不算出现在 "t-10" 里；编号只有字母、数字和连字符） */
function mentionsId(text: string, id: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9-])${id}(?![0-9])`, "i").test(text);
}

/** 编号和完整的名字（任务标题、项目名） */
export interface NamedRef {
  id: string;
  name: string;
}

/**
 * 名字前面紧挨着可以是这些（引导词、动作词、指代）：别的字紧挨着时，名字可能只是更长的一个词的一部分（"AI 日报"里的"日报"），不算
 */
const LEAD_INS = ["把", "将", "让", "给", "对", "跟", "和", "与", "及", "叫", "告诉", "这个", "那个", "任务", "以后", "往后", "今后", "每次", "打开", "关掉", "关闭", "关了", "停掉", "取消", "暂停", "继续", "恢复", "运行", "再跑", "重跑"];

/** 名字前面这一段到这里为止是个边界：段首、标点符号、引导词；空白前面不是字母数字（"AI 日报"的空白前面是 I，不算） */
function leadsIn(before: string): boolean {
  if (before === "") return true;
  const last = before.at(-1)!;
  if (/[\p{P}\p{S}]/u.test(last)) return true;
  if (/\s/u.test(last)) return !/[A-Za-z0-9]$/.test(before.trimEnd());
  return LEAD_INS.some((word) => before.endsWith(word));
}

/** hay 里有一处 other 盖住了 [at, at + length) 这一段 */
function covered(hay: string, other: string, at: number, length: number): boolean {
  for (let p = hay.indexOf(other); p >= 0 && p <= at; p = hay.indexOf(other, p + 1)) if (p + other.length >= at + length) return true;
  return false;
}

/**
 * 这段话里点到了这个对象（排版上的差别不算）：编号作为一个词（"t-1"不算出现在"t-10"里），或者完整的名字——子串不算：
 * 名字前面紧挨着的要是段首、标点、空白（空白前面不是字母数字）或引导词（"取消""把""以后"……），名字以字母数字结尾时后面不能紧跟字母数字；
 * 别的对象（others：别的任务、项目）更长的名字把这一处盖住时（从同一位置开始，或者包着它）算那个更长的，不算这个（"日报"不算"日报汇总"）。
 * 拿不准的算没点到（推断出来的出卡确认）
 */
export function mentionsRef(text: string, ref: NamedRef, others: readonly NamedRef[] = []): boolean {
  const plain = normalizeForMatch(text);
  if (mentionsId(plain, ref.id)) return true;
  const name = normalizeForMatch(ref.name);
  if (name.length === 0) return false;
  const hay = plain.toLowerCase();
  const needle = name.toLowerCase();
  const longer = others.map((o) => normalizeForMatch(o.name).toLowerCase()).filter((n) => n.length > needle.length && n.includes(needle));
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
    if (!leadsIn(plain.slice(0, at))) continue;
    if (/[A-Za-z0-9]$/.test(name) && /^[A-Za-z0-9]/.test(plain.slice(at + name.length))) continue;
    if (longer.some((other) => covered(hay, other, at, needle.length))) continue;
    return true;
  }
  return false;
}

/** 一段文字原样出现在哪里：用户自己说的话（打的字、语音转写）优先，其次引用块、引用的卡片；哪里都没有是 undefined */
export function foundIn(turn: UserTurn, text: string): ExplicitFinding | undefined {
  const needle = normalizeForMatch(text);
  if (needle.length === 0) return undefined;
  const has = (texts: readonly string[]) => texts.some((t) => normalizeForMatch(t).includes(needle));
  const own = ownWords(turn).find((w) => has([w.text]));
  if (own) return { source: own.source };
  if (has(turn.quotes)) return { source: "quote" };
  if (turn.cards.some(has)) return { source: "card" };
  return undefined;
}

/**
 * 用户自己说的话（打的字、语音转写）里每个触发词（同一个分句里前面没有否定词）后面到句末的那一段（原样，没去标点），
 * 连同它是打的字还是语音转写。比如"记住：下周三上午体检。"→"：下周三上午体检"；"别记住这个"没有（前面有否定词）
 */
export function commandTails(turn: UserTurn, triggers: readonly string[], negations: readonly string[] = NEGATIONS): Array<{ text: string; source: OwnWordsSource }> {
  const tails: Array<{ text: string; source: OwnWordsSource }> = [];
  for (const { text, source } of ownWords(turn)) {
    for (const trigger of triggers) {
      for (let at = text.indexOf(trigger); at >= 0; at = text.indexOf(trigger, at + 1)) {
        const before = text.slice(0, at);
        const clause = before.slice(lastIndexOf(before, CLAUSE_BREAK) + 1);
        if (negations.some((n) => clause.includes(n))) continue;
        const after = text.slice(at + trigger.length);
        const end = after.search(SENTENCE_END);
        tails.push({ text: end < 0 ? after : after.slice(0, end), source });
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
