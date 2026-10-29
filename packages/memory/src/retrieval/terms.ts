// 问题拆词：自然语言的问题（没有空格的中文）拆成关键词检索用的词。
// - 去掉问句词、代词、虚词，和相对的时间说法（去年、最近、11 月中旬……：意思随说话的时间变，按字面去配原话会配错，
//   交给时间过滤，见 plan.ts）；节日、星期这类绝对的说法（五一、周六、周末）留着当关键词；
// - 剩下的连续文字是一段：3 个字以上的段拆成重叠的三字词，走 FTS5 trigram 索引（bm25 排序）；
//   段里重叠的两字词、本来就两个字的段，FTS5 trigram 查不了，照二狗的做法退回子串扫描（keyword.ts）；一个字的不要。
// 二狗的素材检索（daemon materials/memory-db.ts）是用户自己敲的关键词，按空白拆、每个词都要出现；这里是一整句问题，
// 所以拆成小段、任何一个词命中都算（OR），靠 bm25 的权重区分常见词和少见词。
// 单字的虚词分两种：很少出现在实词里的（我、的、是、吗……）直接当分隔；常出现在实词里的（去：过去；更：更正……）
// 只从段的两头去掉，不拆开段的中间。
// 192 号票：一个字的一般不要，但说人状态的单字（忙、累、烦、困……）是问"最近忙吗""累不累"时唯一的实词，丢了就什么都搜不到；
// 问题里出现这些字（不管在不在别的段里）单独记下来，走子串扫描（keyword.ts，和两字词同一个打分公式）。

/** 多字的问句词、虚词（和相对时间词一起，长的先去） */
const STOP_PHRASES: readonly string[] = [
  "可不可以",
  "是不是",
  "能不能",
  "要不要",
  "有没有",
  "会不会",
  "怎么样",
  "为什么",
  "你觉得",
  "帮我",
  "为啥",
  "什么",
  "怎么",
  "哪天",
  "哪家",
  "哪些",
  "哪个",
  "哪里",
  "哪儿",
  "多少",
  "到底",
  "那个",
  "这个",
  "那些",
  "这些",
  "那种",
  "这种",
  "一下",
  "一点",
  "有点",
  "还是",
  "或者",
  "而且",
  "但是",
  "因为",
  "所以",
  "如果",
  "就是",
  "可能",
  "应该",
  "觉得",
  "我们",
  "你们",
  "他们",
  "她们",
  "自己",
  "这样",
  "那样",
  "顺便",
];

/** 相对的时间说法：交给时间过滤，不当关键词 */
const RELATIVE_TIME_WORDS: readonly string[] = [
  "那段时间",
  "这一年",
  "那会儿",
  "那阵子",
  "这阵子",
  "那时候",
  "上个月",
  "这个月",
  "下个月",
  "去年",
  "今年",
  "明年",
  "前年",
  "现在",
  "最近",
  "以前",
  "之前",
  "以后",
  "之后",
  "目前",
  "如今",
  "当时",
  "那会",
  "那阵",
  "那时",
  "时候",
  "一年",
  "上旬",
  "中旬",
  "下旬",
  "月初",
  "月底",
  "月份",
];

const PHRASES = [...STOP_PHRASES, ...RELATIVE_TIME_WORDS].toSorted((a, b) => b.length - a.length);

/** 很少出现在实词里的单字虚词：直接当分隔 */
const SPLIT_CHARS = "我你他她它咱谁啥吗呢啊呀嘛的了是跟和与把被都也就又很挺太最这那哪";
/** 常出现在实词里的单字虚词：只从段的两头去掉 */
const EDGE_CHARS = "去得还着过么吧更没给对个";

/** 说人状态的单字（192 号票）：问题里出现就单独走子串扫描 */
export const SINGLE_STATE_CHARS: readonly string[] = ["忙", "累", "烦", "困", "闷", "乏", "倦", "饿", "病", "疼", "慌"];

/** 几月：阿拉伯数字或中文数字加"月"（"五一"不是） */
const MONTH = /(?:\d{1,2}|[一二三四五六七八九十]{1,3})\s*月/g;
const SPLIT = new RegExp(`[^\\p{L}\\p{N}]+|[${SPLIT_CHARS}]+`, "u");
const EDGES = new RegExp(`^[${EDGE_CHARS}]+|[${EDGE_CHARS}]+$`, "gu");

export interface QueryTerms {
  /** 3 个字的词，走 FTS5 trigram（MATCH，bm25 排序） */
  fts: string[];
  /** 2 个字的词，子串扫描 */
  short: string[];
  /** 说人状态的单字（忙、累……），子串扫描（192 号票） */
  single: string[];
}

const chars = (s: string) => Array.from(s);

function push(list: string[], w: string): void {
  if (!list.includes(w)) list.push(w);
}

function windows(s: string, n: number): string[] {
  const c = chars(s);
  const out: string[] = [];
  for (let i = 0; i + n <= c.length; i++) out.push(c.slice(i, i + n).join(""));
  return out;
}

/** 把问题拆成关键词（见文件开头）；结果去重、按出现的先后 */
export function queryTerms(query: string): QueryTerms {
  let s = query.toLowerCase().replace(MONTH, " ");
  for (const w of PHRASES) s = s.replaceAll(w, " ");
  const segments = s
    .split(SPLIT)
    .map((x) => x.replace(EDGES, ""))
    .filter((x) => chars(x).length >= 2 && !/^\d+$/.test(x));
  const fts: string[] = [];
  const short: string[] = [];
  const single: string[] = [];
  for (const ch of chars(s)) if (SINGLE_STATE_CHARS.includes(ch)) push(single, ch);
  for (const seg of segments) {
    if (chars(seg).length === 2) {
      push(short, seg);
      continue;
    }
    for (const w of windows(seg, 3)) push(fts, w);
    for (const w of windows(seg, 2)) push(short, w);
  }
  return { fts, short, single };
}
