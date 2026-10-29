// 变化信号词、纠正信号词、"以前""一直"这类标记，以及有效期的时间说法（第 5 节）。
// - 变化信号看分句（"以前喜欢，现在不喜欢了"里"现在"只管后半句）；
// - 纠正信号看整条证据（"记错了，我其实不喜欢爬山"：信号在前一个分句，事实在后一个）；
// - 时间说法只给状态类的事实定有效期（喜欢、不喜欢……），事情类的用证据的发生时间。
import { addDays, addMonths, monthStart, startOfMonth, startOfWeek, startOfYear, yearMonthOf } from "../domain/time.ts";

/** 观点变化的信号（文档第 5 节列的"开始、现在、最近、不再"，加上常见的同义说法） */
export const CHANGE_SIGNALS: readonly string[] = [
  "开始",
  "现在",
  "最近",
  "不再",
  "再也不",
  "已经不",
  "越来越",
  "渐渐",
  "慢慢",
  "变得",
  "改成",
  "改为",
  "转而",
  "如今",
  "这阵子",
  "近来",
  "后来",
  "从此",
  "以后",
];
const CHANGE_PATTERNS: readonly RegExp[] = [/从.{1,8}(?:起|开始)/, /不.{0,8}了[吧啊呀呢啦]?$/];

/** 纠正的信号（文档第 5 节列的"其实一直、我从没、记错了、不是…是…"，加上常见的同义说法） */
export const CORRECTION_SIGNALS: readonly string[] = [
  "其实一直",
  "一直都",
  "我从没",
  "从来没",
  "从没",
  "从来不",
  "记错",
  "搞错",
  "弄错",
  "说错",
  "纠正一下",
  "更正",
  "并不是",
  "没说过",
];
const CORRECTION_PATTERNS: readonly RegExp[] = [/^不对/, /不是[^，,。]+?[，,]?(?:而|就|只)?是/];

/** 说的是以前（到现在为止已经不是了，或者至少说不准现在） */
export const PAST_MARKERS: readonly string[] = ["以前", "原来", "过去", "之前", "曾经", "那时候", "小时候", "当年"];

/** 一直如此：不知道从什么时候起 */
export const ALWAYS_MARKERS: readonly string[] = ["一直", "向来", "从来都", "一向"];

function found(text: string, words: readonly string[], patterns: readonly RegExp[]): string[] {
  const hits = words.filter((w) => text.includes(w));
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) hits.push(m[0]);
  }
  return hits;
}

/** 分句里的变化信号（命中的词） */
export function changeSignals(clause: string): string[] {
  return found(clause, CHANGE_SIGNALS, CHANGE_PATTERNS);
}

/** 整条证据里的纠正信号（命中的词） */
export function correctionSignals(text: string): string[] {
  return found(text, CORRECTION_SIGNALS, CORRECTION_PATTERNS);
}

export function hasPastMarker(clause: string): boolean {
  return PAST_MARKERS.some((w) => clause.includes(w));
}

export function hasAlwaysMarker(clause: string): boolean {
  return ALWAYS_MARKERS.some((w) => clause.includes(w));
}

// ---------- 334 号票：用户自己说了"变了" ----------
//
// 上面的变化信号（changeSignals）是宽的："现在、最近、这阵子"也算。334 号票（用户 10-27 选 A）起，前后两句意思相反时，
// 只有新的那句**自己说了变化**才按"新取代旧"走；没说的当矛盾（两边都是猜测、问用户），哪边都不自动赢（原始推理图谱 LIFECYCLE §6b：
// 不许"信先到的、信后到的"）。所以这里只认明说变化的说法，拿不准的一律不算（宁可多问一句，也不吞掉新说法）：
// - 不再、再也不、已经不、不…了 / 没…了（"不读博了""没兴趣了"）；
// - 改成、改为、换成、转而、变成、变得、越来越、渐渐、开始、从此、从…起；
// - 搬家、换工作这类状态变化（搬到、搬去、换了工作、跳槽、辞职、离职、转行）；
// - 一句话里先说以前（以前、原来、之前……）、后说现在（现在、如今、后来、目前）。
// 只说"现在、最近、这阵子"，或者"想…了""喜欢上…了"这类只是新说法的，不算——它们可能是变了，也可能只是这一阵的说法。

/** 明说变化的词（分句里） */
const EXPLICIT_CHANGE_WORDS: readonly string[] = ["不再", "再也不", "已经不", "改成", "改为", "换成", "转而", "变成", "变得", "越来越", "渐渐", "开始", "从此", "搬到", "搬去", "搬家", "跳槽", "辞职", "离职", "转行"];
const EXPLICIT_CHANGE_PATTERNS: readonly RegExp[] = [
  /从.{1,8}(?:起|开始)/,
  // 不…了、没…了：否定后面同一个小分句里以"了"收尾（"不读博了""没兴趣了吧"）
  /(?:不|没)[^，,。！!？?；;、\s]{0,8}了[吧啊呀呢啦]?(?=$|[，,。！!？?；;、\s])/,
  /换了?(?:一?份|个|家)?工作/,
];
/** 说现在的词（跟在"以前"后面才算明说变化） */
const NOW_MARKERS: readonly string[] = ["现在", "如今", "后来", "目前"];

/**
 * 334 号票：这句话本身有没有明说"变了"（命中的说法）。span 是抽出这条事实的那段原话（分句），fullText 是整条证据——
 * "以前…，现在…"跨分句，在整条里看；别的在分句里看
 */
export function explicitChangeSignals(span: string, fullText: string = span): string[] {
  const hits = found(span, EXPLICIT_CHANGE_WORDS, EXPLICIT_CHANGE_PATTERNS);
  for (const past of PAST_MARKERS) {
    const i = fullText.indexOf(past);
    if (i < 0) continue;
    const now = NOW_MARKERS.find((w) => fullText.indexOf(w, i + past.length) >= 0);
    if (now !== undefined) {
      hits.push(`${past}…${now}`);
      break;
    }
  }
  return hits;
}

/**
 * 334 号票：这句话自己说了从什么时候起（时间说法、"以前""一直"）——说了的，抽出来的有效期可以早于说这句话的那天；
 * 没说的（说的是现在的感受、打算），开始不能早于说这句话的那天
 */
export function statesOwnStart(span: string, ref: string): boolean {
  return resolveValidity(span, ref) !== undefined || hasPastMarker(span) || hasAlwaysMarker(span) || /从小|向来|打小/.test(span);
}

const CN_DIGITS: Readonly<Record<string, number>> = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 半: 0.5 };

/** 阿拉伯数字或十以内的中文数字（十一、十二也认） */
function parseCount(s: string): number | undefined {
  if (/^\d+$/.test(s)) return Number(s);
  if (s === "十") return 10;
  if (/^十[一二三四五六七八九]$/.test(s)) return 10 + CN_DIGITS[s[1]!]!;
  if (/^[一二两三四五六七八九]十$/.test(s)) return CN_DIGITS[s[0]!]! * 10;
  return CN_DIGITS[s];
}

export interface Validity {
  validFrom: string | null;
  validTo: string | null;
}

/**
 * 分句里说的有效期（以 ref = 这句话发生的时间为准）：
 * - "上个月开始、去年起、三个月前开始、从 9 月起"：从那时起，现在仍成立；
 * - "去年、上个月、上周"（没说"开始"）：只在那一段时间里；
 * - "今年、这个月、这周"：从这一段的开头起；
 * 没有时间说法返回 undefined（用证据的发生时间）。"最近"不挪时间。
 */
export function resolveValidity(clause: string, ref: string): Validity | undefined {
  const since = /开始|起|以来/.test(clause);
  const period = (from: string, to: string | null): Validity => ({ validFrom: from, validTo: since ? null : to });

  const ago = /(\d+|[一两二三四五六七八九十半]+)(?:个)?(天|周|星期|礼拜|月|年)(?:前|以前|之前)/.exec(clause);
  if (ago && since) {
    const n = parseCount(ago[1]!);
    if (n !== undefined) {
      const unit = ago[2]!;
      const from = unit === "天" ? addDays(ref, -n) : unit === "月" ? addMonths(ref, -Math.round(n)) : unit === "年" ? addMonths(ref, -Math.round(n * 12)) : addDays(ref, -7 * n);
      return { validFrom: from, validTo: null };
    }
  }
  const month = /(\d{1,2}|[一二三四五六七八九十]{1,2})月份?(?:开始|起|以来)/.exec(clause);
  if (month) {
    const m = parseCount(month[1]!);
    if (m !== undefined && m >= 1 && m <= 12) {
      const { year, month: refMonth } = yearMonthOf(ref);
      return { validFrom: monthStart(ref, m > refMonth ? year - 1 : year, m), validTo: null };
    }
  }
  if (/上个?月/.test(clause)) return period(startOfMonth(ref, -1), startOfMonth(ref, 0));
  if (/这个?月|本月/.test(clause)) return { validFrom: startOfMonth(ref, 0), validTo: null };
  if (/前年/.test(clause)) return period(startOfYear(ref, -2), startOfYear(ref, -1));
  if (/去年/.test(clause)) return period(startOfYear(ref, -1), startOfYear(ref, 0));
  if (/今年/.test(clause)) return { validFrom: startOfYear(ref, 0), validTo: null };
  if (/上周|上个?星期|上个?礼拜/.test(clause)) return period(startOfWeek(ref, -1), startOfWeek(ref, 0));
  if (/这周|本周|这个?星期|这个?礼拜/.test(clause)) return { validFrom: startOfWeek(ref, 0), validTo: null };
  return undefined;
}
