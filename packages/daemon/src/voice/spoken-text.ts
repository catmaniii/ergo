// 口语稿（32 号票）：agent 的回复送进 TTS 之前的样子，纯函数。
// - speakable：回复的文字变成念得出来的口语稿——去掉 Markdown 的标记；代码块、表格、链接地址念不出来，去掉并标出来
//   （有它们的回复不整段合成，合成口语总结，详细内容照常是文字）；
// - estimateSpeechSeconds：按字数估念出来要多少秒（汉字每秒 charsPerSecond 个，一个英文单词、数字串按两个汉字算）；
// - leadingSentences：截出开头念得完的几句；一句都放不下时按字截、加省略号；
// - runtimeSummary：追问了 agent 还是没写口语总结时运行时兜底的那段——回复开头念得完的几句，加一句"详细内容我发在聊天里了"。
//   守护进程自己不调模型（ADR-0011 的后果之一），所以兜底是截，不是重新概括。
// 语速和"多长算长"打包成 SpokenPace（配置里的 voice.reply）。
import { RUNTIME_SUMMARY_TAIL } from "./texts.ts";

/** 念多快、多长算长：口语稿估出来念超过 maxSeconds 秒算长；估时长按每秒 charsPerSecond 个汉字（一个英文单词按两个汉字） */
export interface SpokenPace {
  maxSeconds: number;
  charsPerSecond: number;
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const WORD = /[A-Za-z0-9]+(?:['.][A-Za-z0-9]+)*/g;
/** 句末（或者停顿）的标点 */
const ENDING = /[。！？!?；;…，,：:.]$/;

/** 估一段口语稿念出来要多少秒 */
export function estimateSpeechSeconds(text: string, pace: Pick<SpokenPace, "charsPerSecond">): number {
  const cjk = text.match(CJK)?.length ?? 0;
  const words = text.match(WORD)?.length ?? 0;
  return (cjk + words * 2) / pace.charsPerSecond;
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
  const joined = lines.map((line, i) => (i < lines.length - 1 && !ENDING.test(line) ? `${line}。` : line)).join("");
  return { text: joined, unspeakable };
}

/** 切成句子（句末标点跟着前一句；英文按句点加空白切） */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?；;…])|(?<=[.])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 开头念得完（maxSeconds 内）的几句；一句都放不下时按字截、加省略号；没有内容时是空串 */
export function leadingSentences(text: string, pace: SpokenPace): string {
  let out = "";
  for (const sentence of sentences(text)) {
    const next = out ? `${out}${/[\p{Script=Han}，。！？；：…]$/u.test(out) ? "" : " "}${sentence}` : sentence;
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
  const budget = pace.maxSeconds - estimateSpeechSeconds(RUNTIME_SUMMARY_TAIL, pace);
  const lead = budget > 0 ? leadingSentences(plain, { ...pace, maxSeconds: budget }) : "";
  if (!lead) return RUNTIME_SUMMARY_TAIL;
  return `${lead}${ENDING.test(lead) ? "" : "。"}${RUNTIME_SUMMARY_TAIL}`;
}
