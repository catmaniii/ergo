// 识别结果里剔除模型自带的串词（180 号票，用户 2026-10-19 提）：FasterWhisper 偶尔把"请不吝点赞 订阅 转发 打赏支持明镜与点点栏目"
// 这类训练语料（视频字幕）里的句子编进转写，不是用户说的。识别进程的宿主（recognizer.ts）在交出结果之前过一遍这里，
// 语音消息、输入框的按住说话、悬浮按钮和侧边栏的语音、Debug 页拿到的都是剔过的。
// - 规则是一组正则（配置 voice.recognizer.stripPatterns，默认是用户给的 5 条），命中就整句删掉——不只删几个字，免得留下半句残渣；
// - 句子按 。！？!?；; 换行切（英文的句点后面跟空白也算一句完），另外每个分段（faster-whisper 的 segment）的边界也算句子的边界：
//   中文转写常常不带标点，串词又多半自成一段，这样不会连累同一行里别的分段；
// - 大小写、空格、标点不敏感：每句的原样和"统一全角半角、小写、去掉空白和标点符号"之后的样子各试一次，哪个命中都算；
// - 分段跟着删：整段都被删掉的分段去掉；只删了其中几句的，文字换成剩下的（时间不变，切不出更细的时间）；没碰到的分段原样留着。
//   全文和分段对不上（拼不回全文）时，全文、分段各自按句删；
// - 删完没剩下字母、数字、汉字（空的、只剩标点）就是空的：文字、分段都清掉，调用方当作没识别出内容；
// - 没命中时返回 undefined：原样不动，普通语音一字不差。
// 规则写错（不是合法的正则、空的、会匹配空句子——那等于删掉所有话）的启动时跳过、写日志，不让守护进程起不来。

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

/** 一条剔除规则：配置里写的原文和编译好的正则（不分大小写） */
export interface StripRule {
  pattern: string;
  regex: RegExp;
}

/** 剔过之后的样子 */
export interface StrippedTranscript {
  text: string;
  segments: TranscriptSegment[];
  /** 剔掉了多少字（不算空白） */
  chars: number;
  /** 命中了哪几条规则（规则原文，按配置里的先后） */
  rules: string[];
}

/**
 * 编译配置里的规则：不是合法的正则、空的、会匹配空句子的跳过，各写一行日志（日志里只有规则原文）
 */
export function compileStripRules(patterns: readonly string[], log: (line: string) => void): StripRule[] {
  const rules: StripRule[] = [];
  for (const pattern of patterns) {
    if (pattern.trim() === "") {
      log("语音识别的剔除规则里有一条是空的，跳过");
      continue;
    }
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, "iu");
    } catch (err) {
      log(`语音识别的剔除规则 ${JSON.stringify(pattern)} 不是合法的正则，跳过：${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (regex.test("")) {
      log(`语音识别的剔除规则 ${JSON.stringify(pattern)} 连空句子都匹配（等于删掉所有话），跳过`);
      continue;
    }
    rules.push({ pattern, regex });
  }
  return rules;
}

/** 句末的标点（连着的几个算一个句末） */
const SENTENCE_END = /[。！？!?；;\n]/u; // @i18n-ignore data：句末标点
/** 句末标点后面紧跟着的右引号、右括号也算这一句的 */
const CLOSING = /[”’"'）)】」』》]/u; // @i18n-ignore data：右引号、右括号
/** 有没有字（字母、数字、汉字）：删完只剩标点、空白的算空 */
const HAS_WORD = /[\p{L}\p{N}]/u;
/** 归一时去掉的：空白、标点、符号 */
const NOISE = /[\s\p{P}\p{S}]/gu;

const isSpace = (ch: string) => /\s/u.test(ch);
const nonSpaceCount = (text: string) => [...text].filter((ch) => !isSpace(ch)).length;
const normalized = (text: string) => text.normalize("NFKC").toLowerCase().replace(NOISE, "");

/** 这句话命中了哪几条规则（原样、归一之后各试一次） */
function hitsOf(sentence: string, rules: readonly StripRule[]): StripRule[] {
  const plain = normalized(sentence);
  return rules.filter((rule) => rule.regex.test(sentence) || (plain !== "" && rule.regex.test(plain)));
}

/**
 * 把 text 切成句子（下标区间，连起来就是全文）：句末标点处切开，extraBreaks 里的位置（分段的边界）也切开；
 * 只有空白的一截并进后面那句（删掉一句时连它前面的空白一起删，英文不会留下两个空格）
 */
function sentencesOf(text: string, extraBreaks: ReadonlySet<number> = new Set()): Array<[number, number]> {
  const breaks = new Set<number>(extraBreaks);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const period = ch === "." && (i + 1 >= text.length || isSpace(text[i + 1]!));
    if (!SENTENCE_END.test(ch) && !period) continue;
    let end = i + 1;
    while (end < text.length && (SENTENCE_END.test(text[end]!) || CLOSING.test(text[end]!))) end++;
    breaks.add(end);
    i = end - 1;
  }
  const points = [...breaks].filter((p) => p > 0 && p < text.length).toSorted((a, b) => a - b);
  const pieces: Array<[number, number]> = [];
  let from = 0;
  for (const p of [...points, text.length]) {
    if (p > from) pieces.push([from, p]);
    from = p;
  }
  // 只有空白的一截并进后面那句（最后一截并进前面那句）
  const merged: Array<[number, number]> = [];
  let carry: number | undefined;
  for (const [a, b] of pieces) {
    if (text.slice(a, b).trim() === "") {
      carry ??= a;
      continue;
    }
    merged.push([carry ?? a, b]);
    carry = undefined;
  }
  if (carry !== undefined) {
    const last = merged.at(-1);
    if (last) last[1] = text.length;
    else merged.push([carry, text.length]);
  }
  return merged;
}

/** 按句删一段文字：每个字留不留（命中规则的句子整句不留）、命中的规则；没命中返回 undefined */
function strike(text: string, rules: readonly StripRule[], extraBreaks?: ReadonlySet<number>): { keep: boolean[]; hit: Set<StripRule> } | undefined {
  const keep = Array.from({ length: text.length }, () => true);
  const hit = new Set<StripRule>();
  for (const [a, b] of sentencesOf(text, extraBreaks)) {
    const hits = hitsOf(text.slice(a, b), rules);
    if (hits.length === 0) continue;
    for (const rule of hits) hit.add(rule);
    keep.fill(false, a, b);
  }
  return hit.size === 0 ? undefined : { keep, hit };
}

const keptOf = (text: string, keep: readonly boolean[], from = 0, to = text.length) => {
  let out = "";
  for (let i = from; i < to; i++) if (keep[i]) out += text[i];
  return out;
};

/** 一个分段剔过的样子：没碰到的原样；整段删掉、剩下的没有字的不要（undefined）；剩下的文字去掉首尾空白 */
function trimmedSegment(segment: TranscriptSegment, kept: string, touched: boolean): TranscriptSegment | undefined {
  if (!touched) return segment;
  const text = kept.trim();
  return HAS_WORD.test(text) ? { ...segment, text } : undefined;
}

/** 分段在全文里依次在哪（下标区间）；有一段对不上就是 undefined（空的分段不占位置） */
function locate(text: string, segments: readonly TranscriptSegment[]): Array<[number, number] | undefined> | undefined {
  const out: Array<[number, number] | undefined> = [];
  let cursor = 0;
  for (const segment of segments) {
    if (segment.text === "") {
      out.push(undefined);
      continue;
    }
    const at = text.indexOf(segment.text, cursor);
    if (at < 0) return undefined;
    out.push([at, at + segment.text.length]);
    cursor = at + segment.text.length;
  }
  return out;
}

/**
 * 剔除识别结果里命中规则的句子（见文件开头）。没命中返回 undefined（原样不动）
 */
export function stripTranscript(text: string, segments: readonly TranscriptSegment[], rules: readonly StripRule[]): StrippedTranscript | undefined {
  if (rules.length === 0) return undefined;
  const located = locate(text, segments);
  const hit = new Set<StripRule>();
  let kept: string;
  let nextSegments: TranscriptSegment[];
  if (located) {
    // 分段拼得回全文：分段的边界也是句子的边界，分段跟着全文删
    const breaks = new Set<number>(located.flatMap((r) => r ?? []));
    const struck = strike(text, rules, breaks);
    if (!struck) return undefined;
    for (const rule of struck.hit) hit.add(rule);
    kept = keptOf(text, struck.keep);
    nextSegments = segments.flatMap((segment, i) => {
      const range = located[i];
      if (!range) return [];
      const touched = struck.keep.slice(range[0], range[1]).includes(false);
      return trimmedSegment(segment, keptOf(text, struck.keep, range[0], range[1]), touched) ?? [];
    });
  } else {
    // 对不上：全文、分段各自按句删
    const struck = strike(text, rules);
    kept = struck ? keptOf(text, struck.keep) : text;
    for (const rule of struck?.hit ?? []) hit.add(rule);
    nextSegments = segments.flatMap((segment) => {
      const own = strike(segment.text, rules);
      for (const rule of own?.hit ?? []) hit.add(rule);
      return (own ? trimmedSegment(segment, keptOf(segment.text, own.keep), true) : segment) ?? [];
    });
    if (hit.size === 0) return undefined;
  }
  const finalText = HAS_WORD.test(kept) ? kept.trim() : "";
  return {
    text: finalText,
    segments: finalText === "" ? [] : nextSegments,
    chars: nonSpaceCount(text) - nonSpaceCount(finalText),
    rules: rules.filter((rule) => hit.has(rule)).map((rule) => rule.pattern),
  };
}
