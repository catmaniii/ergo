// 口语稿（32 号票）：agent 的回复送进 TTS 之前的样子，纯函数。
// - speakable：回复的文字变成念得出来的口语稿——去掉 Markdown 的标记；代码块、表格、链接地址念不出来，去掉并标出来
//   （有它们的回复不整段合成，合成口语总结，详细内容照常是文字）；
// - estimateSpeechSeconds：按字数估念出来要多少秒（汉字每秒 charsPerSecond 个，一个英文单词、数字串按两个汉字算）；
// - leadingSentences：截出开头念得完的几句；一句都放不下时按字截、加省略号；
// - runtimeSummary：追问了 agent 还是没写口语总结时运行时兜底的那段——回复开头念得完的几句，加一句"详细内容我发在聊天里了"。
//   守护进程自己不调模型（ADR-0011 的后果之一），所以兜底是截，不是重新概括；
// - speechSegments（38 号票）：分段合成时口语稿怎么切段（规则和数字见 SPEECH_SEGMENT_RULES）。
// 语速和"多长算长"打包成 SpokenPace（配置里的 voice.reply）。
import { t } from "@ergo/protocol";
import { runtimeSummaryTail } from "./texts.ts";

/** 念多快、多长算长：口语稿估出来念超过 maxSeconds 秒算长；估时长按每秒 charsPerSecond 个汉字（一个英文单词按两个汉字） */
export interface SpokenPace {
  maxSeconds: number;
  charsPerSecond: number;
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const WORD = /[A-Za-z0-9]+(?:['.][A-Za-z0-9]+)*/g;
/** 句末（或者停顿）的标点 */
const ENDING = /[。！？!?；;…，,：:.]$/; // @i18n-ignore data：认句末的标点

/** 一段口语稿有几个"字"：汉字（含日文假名、韩文）一个算一个，英文单词、数字串一个算两个 */
function speechUnits(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0;
  const words = text.match(WORD)?.length ?? 0;
  return cjk + words * 2;
}

/** 估一段口语稿念出来要多少秒 */
export function estimateSpeechSeconds(text: string, pace: Pick<SpokenPace, "charsPerSecond">): number {
  return speechUnits(text) / pace.charsPerSecond;
}

/** 念得完吗（不超过 maxSeconds） */
export function fitsPace(text: string, pace: SpokenPace): boolean {
  return estimateSpeechSeconds(text, pace) <= pace.maxSeconds;
}

/** 回复的文字 → 念得出来的口语稿，以及有没有去掉念不出来的内容（代码块、表格、图片、链接地址） */
export function speakable(markdown: string): { text: string; unspeakable: boolean } {
  let unspeakable = false;
  // 代码块整块去掉
  let text = markdown.replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|(?![\s\S]))/gm, () => {
    unspeakable = true;
    return "\n";
  });
  // 图片去掉；链接留下文字
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, () => {
    unspeakable = true;
    return "";
  });
  text = text.replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, "$1");
  // 光秃秃的链接地址念不出来
  // @i18n-ignore-next data：认网址到哪为止
  text = text.replace(/\b(?:https?|ftp):\/\/[^\s)）\]】>]+/g, () => {
    unspeakable = true;
    return "";
  });
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    // 表格的行（| a | b |）和分隔线
    if (/^\|.*\|/.test(line) || /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?$/.test(line)) {
      unspeakable = true;
      continue;
    }
    // 分隔线
    if (/^([-*_])(\s*\1){2,}$/.test(line)) continue;
    line = line
      .replace(/^#{1,6}\s+/, "")
      .replace(/^>\s?/, "")
      .replace(/^[-*+]\s+/, "")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/\*\*|__|~~|\*/g, "")
      .replace(/\p{Extended_Pictographic}️?/gu, "")
      .replace(/\s+/g, " ")
      .trim();
    if (line) lines.push(line);
  }
  // 一行一句：行末没有标点的补个句号，念的时候有停顿
  const joined = lines.map((line, i) => (i < lines.length - 1 && !ENDING.test(line) ? `${line}。` : line)).join(""); // @i18n-ignore data：念的稿子按中文标点断句
  return { text: joined, unspeakable };
}

/** 切成句子（句末标点跟着前一句；英文按句点加空白切） */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?；;…])|(?<=[.])\s+/) // @i18n-ignore data
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 开头念得完（maxSeconds 内）的几句；一句都放不下时按字截、加省略号；没有内容时是空串 */
export function leadingSentences(text: string, pace: SpokenPace): string {
  let out = "";
  for (const sentence of sentences(text)) {
    const next = out ? `${out}${/[\p{Script=Han}，。！？；：…]$/u.test(out) ? "" : " "}${sentence}` : sentence; // @i18n-ignore data
    if (!fitsPace(next, pace)) break;
    out = next;
  }
  if (out || !text.trim()) return out;
  // 第一句就太长：按字截
  const chars = [...text.trim()];
  let cut = "";
  for (const ch of chars) {
    if (!fitsPace(`${cut}${ch}……`, pace)) break;
    cut += ch;
  }
  return cut ? `${cut}……` : "";
}

/** 追问了 agent 还是没写口语总结时运行时兜底的那段：回复开头念得完的几句，加一句"详细内容我发在聊天里了" */
export function runtimeSummary(plain: string, pace: SpokenPace): string {
  const tail = runtimeSummaryTail();
  const budget = pace.maxSeconds - estimateSpeechSeconds(tail, pace);
  const lead = budget > 0 ? leadingSentences(plain, { ...pace, maxSeconds: budget }) : "";
  if (!lead) return tail;
  // 173 号票：兜底的那句按当前语言；前面截的句子没有句末标点时补一个（中文"。"、英文"."），接的时候空不空格也按语言
  return t("voice.spoken.leadThenTail", { lead: ENDING.test(lead) ? lead : t("voice.spoken.endSentence", { lead }), tail });
}

// ───────────── 分段合成（38 号票） ─────────────

/**
 * 分段合成怎么切段（字数按 speechUnits：汉字一个算一个，英文单词、数字串一个算两个；每秒约念 4.5 个字）：
 * - 按句切：句末是。！？!?；;…和换行，英文的句点后面跟空白才算（3.5 这样的不切），句末后面的引号、括号跟着前一句；
 * - 一句一段；不到 min 字的句子并到下一句（最后一句并到前一句），免得太碎、段间语气不连；
 * - 第一段最多 firstMax 字（约 3.5 秒，第一声只等它）；之后每段的上限是前一段的 growth 倍（16、20、25、31、39），
 *   最多 max 字（约 9 秒）。合成只比实时快一点（1 秒语音约 0.85–0.9 秒），后一段比前一段长太多就赶不上前一段播完；
 * - 超过上限的句子按逗号切开（，、：和英文逗号；英文冒号只在后面跟空白时才算，15:30、3:2、https:// 不切），小句凑到上限以内（至少一个小句，凑出来不到 min 字的再带上下一个）；
 *   切下来剩的不到 min 字时留在这一段里；一个小句本身就超过上限的不再切
 */
export const SPEECH_SEGMENT_RULES = { firstMax: 16, growth: 1.25, max: 40, min: 8 } as const;

/** 句末的标点；英文句点另算 */
// @i18n-ignore-start data：认标点
const SENTENCE_END = new Set("。！？!?；;…\n");
/** 句末后面跟着前一句的收尾：引号、括号 */
const CLOSERS = new Set("\"'”’」』）)】》");
/** 小句之间的中文标点（按逗号切长句用；英文的逗号、冒号另算，见 isClauseEnd） */
const CLAUSE_END = new Set("，、：");
// @i18n-ignore-end

/** 在 isEnd 认的标点处切开（标点和它后面的引号、括号跟着前一截）；切下来的保留原样（含空白），拼回去就是原文 */
function splitAfter(text: string, isEnd: (chars: readonly string[], i: number) => boolean): string[] {
  const chars = [...text];
  const out: string[] = [];
  let from = 0;
  for (let i = 0; i < chars.length; i++) {
    if (!isEnd(chars, i)) continue;
    let to = i + 1;
    // 连着的句末标点（……、？！）和收尾的引号、括号都跟着这一截
    while (to < chars.length && (CLOSERS.has(chars[to]!) || (SENTENCE_END.has(chars[to]!) && chars[to] !== "\n"))) to++;
    out.push(chars.slice(from, to).join(""));
    from = to;
    i = to - 1;
  }
  if (from < chars.length) out.push(chars.slice(from).join(""));
  return out;
}

const isSentenceEnd = (chars: readonly string[], i: number) =>
  SENTENCE_END.has(chars[i]!) || (chars[i] === "." && (i + 1 === chars.length || /\s/.test(chars[i + 1]!) || CLOSERS.has(chars[i + 1]!)));
/**
 * 小句之间：中文的逗号、顿号、冒号；英文的逗号（1,000 这样数字中间的不算）；英文冒号只在后面跟空白时才算
 * （15:30、3:2、https:// 都不切）
 */
const isClauseEnd = (chars: readonly string[], i: number) => {
  const c = chars[i]!;
  if (c === ":") return /\s/.test(chars[i + 1] ?? "");
  if (c === ",") return !(/\d/.test(chars[i - 1] ?? "") && /\d/.test(chars[i + 1] ?? ""));
  return CLAUSE_END.has(c);
};

/** 不到 min 字的并到下一截（最后一截并到前一截） */
function mergeShort(pieces: readonly string[], min: number): string[] {
  const out: string[] = [];
  let pending = "";
  for (const piece of pieces) {
    pending += piece;
    if (speechUnits(pending) >= min) {
      out.push(pending);
      pending = "";
    }
  }
  if (pending) {
    if (out.length > 0) out[out.length - 1] += pending;
    else out.push(pending);
  }
  return out;
}

/** 一句超过上限：按逗号切开，从头凑出不超过上限的一段（至少一个小句、不到 min 字的再带上下一个），剩下的另算；剩的太短就不切 */
function takeWithin(sentence: string, cap: number, min: number): [string, string] {
  const clauses = splitAfter(sentence, isClauseEnd);
  let head = clauses[0]!;
  let used = 1;
  while (used < clauses.length) {
    const units = speechUnits(head);
    if (units >= min && units + speechUnits(clauses[used]!) > cap) break;
    head += clauses[used]!;
    used++;
  }
  const rest = clauses.slice(used).join("");
  return speechUnits(rest) < min ? [sentence, ""] : [head, rest];
}

/** 口语稿切成依次合成的几段（规则见 SPEECH_SEGMENT_RULES）；没有念得出来的字时是空的 */
export function speechSegments(text: string): string[] {
  if (speechUnits(text) === 0) return [];
  const { firstMax, growth, max, min } = SPEECH_SEGMENT_RULES;
  const queue = mergeShort(splitAfter(text, isSentenceEnd), min);
  const out: string[] = [];
  let cap: number = firstMax;
  while (queue.length > 0) {
    const sentence = queue.shift()!;
    const [head, rest] = speechUnits(sentence) > cap ? takeWithin(sentence, cap, min) : [sentence, ""];
    out.push(head.trim());
    if (rest) queue.unshift(rest);
    cap = Math.min(max, Math.round(cap * growth));
  }
  return out;
}
