// 事实抽取（第 7.1 节）：接口 FactExtractor，和规则版 RuleFactExtractor。模型版（DeepSeek）是 ④ 号票的事，实现同一个接口。
//
// 规则版只靠关键词和句式，中文为主；结果确定，给测试和演示用。抽不出来就不抽，不硬抽：
// - 按标点切成分句，每个分句最多一条事实；去掉"只是、但是、其实"这类开头和"我"。冒号、引着一段话的引号也算分句的边界
//   （194 号票：不再抽出"在群里回：这次"这样的宾语），只引一个词的引号不分（"喜欢“剧本杀”的"）；
// - 复述以前说过的话（"上回说团建那周要加班"）不当成新说法，跳过（194 号票），只把它说到的那件事留给后面的分句当宾语；
// - 按顺序试一组句式（不反感 → 不喜欢 → 拒绝 → 不想 → 喜欢 → 参加 → 主动约 → 在做），第一个配上的算数；
//   都配不上时再看是不是在说自己的状态（忙、累……）；状态不留给后面的分句当宾语（194 号票：不再有"拒绝了忙"）；
// - 宾语先取句式后面的，后面没有（"聚会我就不去了"）取前面的，都没有就沿用同一条证据里上一个分句的宾语（"朋友约我去爬山，我没去"）；
// - 宾语去掉时间、量词、语气词，取"的"后面的中心词，再对词表和已知实体的名字（长的先配）；对不上的当一个新的话题或活动；
//   "被临时安排、被别人安排、被排满"这类"被……安排"先整个认成一个说法（192 号票），不把"安排"当后缀去掉；
// - "不是 X，是 Y"：X 取反，Y 照常；别人做主语的分句（"他不想去"）不抽，只记下宾语；
// - 本人以外的证据（别人转述）先去掉"同事说他"这类开头，照样抽，出处记成别人转述的；
// - 问句不当成说过的事（207 号票）：问号结尾的句子的最后一个分句、带"要不要、该不该、是不是该、能不能、去不去"这类商量和正反问的、
//   句末是"吗"的、"难道"这类反问的分句不抽（clauseMoods），只把它说到的那件事留给后面的分句当宾语；
// - 否定不能丢（207 号票）：说自己的状态时，紧挨在前面的"不、没、谈不上……"加上中间的"算、太、怎么、那么、觉得……"都算否定
//   （"不算忙""不怎么累""没那么忙""一点都不累"是说自己不忙、不累），"没想到这么累"不算。
import { EPISODIC_PREDICATES, type Assertion, type Entity, type EntityType, type Evidence, type Predicate } from "../domain/types.ts";
import { clauseContext } from "./context.ts";
import { DEFAULT_LEXICON, lexiconIndex, type Lexicon } from "./lexicon.ts";
import { changeSignals, correctionSignals, hasAlwaysMarker, hasPastMarker, resolveValidity } from "./signals.ts";

/** 抽取时能看的事实图谱（只读） */
export interface KgView {
  findEntity(name: string): Entity | undefined;
  /** 已知实体的名字和别名（在句子里找宾语用） */
  knownNames(): string[];
}

/** 指向一个实体：已知的给 id；新的给名字和类型，写入时对齐到已有的实体或新建 */
export type EntityRef = { id: string } | { name: string; type: EntityType };

export type DraftObject = { type: "entity"; ref: EntityRef } | { type: "value"; value: string };

/** 抽取器交出来的一条事实草稿；id、证据、出处、时间的默认值由写入时（graph.ts）补 */
export interface FactDraft {
  subject: EntityRef;
  predicate: Predicate;
  object: DraftObject;
  negated: boolean;
  context: string[];
  /** 不给 = 用证据的发生时间 */
  eventTime?: string | null;
  /** 不给 = 发生时间，不知道发生时间就用知道的时间；null = 不知道从什么时候起 */
  validFrom?: string | null;
  /** 不给 = null（现在仍成立） */
  validTo?: string | null;
  /** 不给 = 按证据的来源等级和说还是做定（graph.ts 的 assertionFor） */
  assertion?: Assertion;
  /** 精炼陈述；不给 = 按模板拼（statement.ts）。模型版自己写 */
  statement?: string;
  /** 命中的变化信号（分句）和纠正信号（整条证据） */
  signals: { change: string[]; correction: string[] };
  /** 抽出它的那个分句 */
  span: string;
}

export interface FactExtractor {
  /** 记在事实上（extractedBy），也用来记哪条证据被它处理过：rule:<版本> | model:<名> */
  readonly id: string;
  extract(evidence: Evidence, known: KgView): FactDraft[];
}

export const USER_REF: EntityRef = { id: "en-user" };

interface Rule {
  predicate: Predicate;
  negated: boolean;
  re: RegExp;
  /** 宾语必须跟在后面（"在忙"后面没东西是在说忙，不是在做什么） */
  objectAfterOnly?: boolean;
}

/** 句式，按顺序试（否定的、更长的在前）。190 号票照正式数据的正文补了"不吃"（不喜欢）、"退掉"（拒绝）、"不再"（不想要） */
const RULES: readonly Rule[] = [
  { predicate: "dislikes", negated: true, re: /(?:并不|从来不|从不|从没|没有?|不)(?:反感|讨厌|排斥|抗拒|嫌弃|介意)(?<obj>.*)/ },
  { predicate: "dislikes", negated: false, re: /(?:不太喜欢|不再喜欢|不是很喜欢|不是太喜欢|不怎么喜欢|没那么喜欢|没有那么喜欢|不喜欢|不爱|讨厌|反感|受不了|排斥|抗拒|厌倦了?|烦透了|不吃)(?<obj>.*)/ },
  {
    predicate: "declined",
    negated: false,
    re: /(?:推掉了?|推了|回绝了?|拒绝了?|婉拒了?|谢绝了?|取消了?|放弃了?|退掉了?|缺席了?|错过了?|没去成?|没参加|不想去|不想参加|不去|不参加|去不了|参加不了)(?<obj>.*)/,
  },
  { predicate: "prefers", negated: true, re: /(?:不想要|不想|不愿意|不愿|不打算|不再想|没什么兴趣|没兴趣|不感兴趣|不再)(?<obj>.*)/ },
  { predicate: "prefers", negated: false, re: /(?:喜欢|热爱|最爱|爱上了?|偏好|偏爱|想要|(?<![没思回感理猜梦幻联预])想(?![到法起过象念])|希望|愿意|打算|倾向于?|享受|感兴趣)(?<obj>.*)/ },
  { predicate: "participated_in", negated: false, re: /(?:报名参加了?|去参加了?|报名了?|报了名|参加了?|参与了?|出席了?|去了|跑去|加入了?|赴约)(?<obj>.*)/ },
  { predicate: "initiated", negated: false, re: /(?:主动约了?|组织了?|发起了?|张罗了?|召集了?|做东|请客|(?<![预大节制隐邀签])约(?![我定束])了?)(?<obj>.*)/ },
  { predicate: "works_on", negated: false, re: /(?:在做|在搞|在忙|正忙着?|忙着|负责|在推进)(?<obj>.*)/, objectAfterOnly: true },
];

const TRAILING = /(?:了吧|了啊|了呀|了呢|了|吧|啊|呀|呢|啦|哦|嘛|哈|喔|咯|么|的|一下|一会儿?|一点儿?|一些|而已|罢了)$/;
const SUFFIXES = /(?:的邀请|邀请|的机会|的安排|安排|的计划|计划|这件事|这事|的事情|的事)$/;
const BEFORE_TRAILING = /(?:我就|我也|我还是|我都|我很|我挺|我真的|我|就|也|都|还是|很|挺|真的|特别|非常|比较)$/;
const LEADING_WORDS = [
  "这个周末",
  "周末两天",
  "这周末",
  "这周六",
  "这周日",
  "下周六",
  "下周日",
  "上周六",
  "上周日",
  "工作日",
  "星期六",
  "星期天",
  "星期日",
  "礼拜六",
  "礼拜天",
  "星期一",
  "星期二",
  "星期三",
  "星期四",
  "星期五",
  "上个月",
  "这个月",
  "下个月",
  "和朋友们",
  "跟朋友们",
  "报名参加",
  "去参加",
  "周六",
  "周日",
  "周天",
  "周末",
  "周一",
  "周二",
  "周三",
  "周四",
  "周五",
  "平时",
  "平日",
  "最近",
  "现在",
  "如今",
  "今天",
  "明天",
  "昨天",
  "后天",
  "前天",
  "今晚",
  "明晚",
  "晚上",
  "早上",
  "上午",
  "下午",
  "中午",
  "傍晚",
  "今年",
  "去年",
  "明年",
  "本月",
  "每周",
  "每天",
  "每次",
  "这次",
  "那次",
  "上次",
  "下次",
  "再次",
  "一直",
  "以后",
  "之后",
  "之前",
  "以前",
  "事先",
  "其实",
  "还是",
  "这个",
  "那个",
  "这些",
  "那些",
  "这种",
  "那种",
  "一个",
  "一次",
  "一场",
  "某个",
  "好好",
  "多多",
  "总是",
  "经常",
  "常常",
  "老是",
  "主动",
  "一起",
  "自己",
  "稍微",
  "有点",
  "特别",
  "非常",
  "比较",
  "真的",
  "两天",
  "报名",
  "参加",
  "参与",
  "出去",
  "和朋友",
  "跟朋友",
  "和同事",
  "跟同事",
  "和家人",
  "跟家人",
  "的是",
  "我们",
  "这",
  "那",
  "多",
  "再",
  "又",
  "都",
  "也",
  "还",
  "就",
  "总",
  "很",
  "太",
  "挺",
  "更",
  "最",
  "去",
  "住",
  "对",
  "是",
  "我",
];
const LEADING = new RegExp(`^(?:${LEADING_WORDS.join("|")})`);
const DISCOURSE = /^(?:主要是|只不过|只是|但是|不过|可是|而是|就是|而且|所以|因为|然后|反正|毕竟|其实|并且|但|而|是|也|还|都|我们|我|用户|本人)/;
const REPORTER = /^[^，,。]{0,8}?(?:听说|告诉我|转述|提到|说|讲)(?:他|她|你|用户)?/;
const THIRD_PERSON = /^(?:他们|她们|他|她|朋友们|朋友|同事们|同事|老板|领导|家人|大家|别人|对方|小[一-鿿])/;
const INVITED = /(?:约|邀请|叫|喊|拉)我/;
const STOP = new Set(["东西", "事情", "什么", "怎么", "这样", "那样", "很多", "时间", "办法", "感觉", "一下", "活儿"]);
const MAX_OBJECT_CHARS = 12;
/** "被……安排 / 排满"（192 号票）：被临时安排、被别人安排、被领导安排、被（提前）排满，整个是一个说法 */
const PASSIVE_ARRANGED = /被[^，,。！!？?；;被]{0,4}?(?:安排|排满|排得满满的?|定死|塞满)/;
/** 词表里没有的"被……安排"统一记成这个名字 */
const ARRANGED_NAME = "被安排";

function strip(s: string, re: RegExp): string {
  let prev: string;
  let cur = s.trim();
  do {
    prev = cur;
    cur = cur.replace(re, "").trim();
  } while (cur !== prev);
  return cur;
}

/** 状态词前面的否定："不算""不怎么""没那么""一点都不""谈不上""没觉得""不用"；"没想到这么累"的"想到"不在中间词里，不算 */
const STATE_NEGATION = /(?:不|没|未|别|谈不上|算不上|称不上|说不上)(?:算|是|太|很|怎么|咋|那么|这么|多|有多|大|特别|非常|十分|至于|觉得|感觉|用|需要|必|再|会|想|有|怎样|那样|这样)*$/;

/** 引号前面是这些字时，引号里是一段话（说、回、问……） */
const SPEECH_BEFORE = /[：:说回问道讲喊写]$/;
const CLAUSE_PUNCT = /[，,。！!？?；;]/;
const PAIRED_QUOTES = /(.?)[“「『"]([^“”「」『』"]*)[”」』"]/g;

/** 分句的边界（同 splitClauses），带括号：留着边界本身，看句子在哪结束、是不是问号 */
const CLAUSE_SPLIT = /([，,。！!？?；;：:“”「」『』"\n]+|而是)/;
const SENTENCE_END = /[。！!？?；;\n]/;
const QUESTION_END = /[？?]/;
/** 商量的话、正反问（没有问号也算）：要不要、该不该、是不是该、能不能、去不去、累不累……；"不管是不是周末"这类让步不算 */
const DELIBERATION = /要不要|该不该|应不应该?|是不是(?:该|要|得|应该)|能不能|可不可以|会不会|用不用|需不需要|值不值得?|是否|(?<!不管|无论|不论)([一-鿿])不\1/;
/** 反问 */
const RHETORICAL = /难道|何必|何苦|岂不|怎么能|哪能|哪有|凭什么/;
/** 句末的"吗" */
const ENDS_WITH_MA = /吗[啊呀呢哈]?$/;
/** 问号结尾的句子里，前面的分句有这些也是问句 */
const INTERROGATIVE = /什么|啥|哪|谁|几|多少|怎么|怎样|如何|为什么|为啥|多久|多长|呢$|^还是/;

export interface ClauseMood {
  text: string;
  /** 问句、商量的话：不抽成说过的事 */
  question: boolean;
}

function prepareQuotes(text: string): string {
  return text.replace(PAIRED_QUOTES, (_all, before: string, inner: string) => (SPEECH_BEFORE.test(before) || CLAUSE_PUNCT.test(inner) ? `${before}，${inner}，` : `${before}${inner}`));
}

/**
 * 分句和它的语气（207 号票）：分句同 splitClauses。问号结尾的句子，最后一个分句是问句，前面的分句带疑问词、以"还是"开头的也是；
 * 不看问号也算问句的：商量的话和正反问（要不要、该不该、是不是该、能不能、去不去……）、句末是"吗"的、反问（难道、何必……）。
 */
export function clauseMoods(text: string): ClauseMood[] {
  const parts = prepareQuotes(text).split(CLAUSE_SPLIT);
  const out: ClauseMood[] = [];
  let sentence: string[] = [];
  const flush = (end: string) => {
    const asking = QUESTION_END.test(end);
    sentence.forEach((c, i) => {
      const marked = DELIBERATION.test(c) || RHETORICAL.test(c) || ENDS_WITH_MA.test(c);
      out.push({ text: c, question: marked || (asking && (i === sentence.length - 1 || INTERROGATIVE.test(c))) });
    });
    sentence = [];
  };
  for (let i = 0; i < parts.length; i += 2) {
    const clause = parts[i]!.trim();
    const delimiter = parts[i + 1] ?? "";
    if (clause.length > 0) sentence.push(clause);
    if (delimiter === "" || SENTENCE_END.test(delimiter)) flush(delimiter);
  }
  return out;
}

/** 正文里这个位置是不是落在问句的分句里（rule:4 的"和谁一起"用） */
export function inQuestionClause(text: string, position: number, moods: readonly ClauseMood[] = clauseMoods(text)): boolean {
  return moods.some((m) => {
    if (!m.question) return false;
    for (let from = text.indexOf(m.text); from >= 0; from = text.indexOf(m.text, from + 1)) if (position >= from && position < from + m.text.length) return true;
    return false;
  });
}

/**
 * 切分句：逗号、句号、问号、分号、冒号、换行和"而是"。引号（194 号票）：引着一段话的（前面是冒号或说、回、问这类字，或者里面有标点）
 * 两头都算边界；只引一个词的去掉引号、不分；没配对的引号也算边界。
 */
export function splitClauses(text: string): string[] {
  return prepareQuotes(text)
    .split(/[，,。！!？?；;：:“”「」『』"\n]+|而是/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

const RECOUNT_TIME = "上回|上次|之前|以前|先前|那天|那次|前几天|前两天|前阵子|刚才|当时|原先|早先";
const RECOUNT = new RegExp(`^(?:我们|我)?(?:(?:${RECOUNT_TIME})(?:我们|我)?(?:跟你|和你|对你|给你)?(?:说|讲|提|聊)(?:过|到)?|(?:跟你|和你|对你|给你)?(?:说|讲|提)过)(?!的|话)`);

/**
 * 这个分句是不是在复述以前说过的话（194 号票）："上回说团建那周要加班""之前说过不吃香菜""我跟你说过……"。
 * 要么开头是"上回、之前、以前、刚才……"加"说、讲、提"，要么开头就是"说过"；
 * "上次说的那家店"（说的是哪家店）、"没跟人说过话"、"我说先不了"（当时怎么回的）、"以后我说……"都不算。
 */
export function isRecount(clause: string): boolean {
  return RECOUNT.test(clause);
}

export class RuleFactExtractor implements FactExtractor {
  /** 194 号票改了分句、星期词、复述旧话，从 rule:1 升到 rule:2；192 号票认"被……安排"，升到 rule:3；207 号票修问句和否定，rule:3.1 */
  readonly id = "rule:3.1";
  private readonly lexicon: Lexicon;
  private readonly terms: { term: string; entry: Lexicon["entries"][number] }[];

  constructor(lexicon: Lexicon = DEFAULT_LEXICON) {
    this.lexicon = lexicon;
    this.terms = lexiconIndex(lexicon);
  }

  extract(evidence: Evidence, known: KgView): FactDraft[] {
    if (evidence.status !== "active" || evidence.text.trim().length === 0) return [];
    const correction = correctionSignals(evidence.text);
    if (evidence.kind === "correction") correction.unshift("kind:correction");
    const ref = evidence.eventTime ?? evidence.observedAt;
    const names = known
      .knownNames()
      .filter((n) => n.length >= 2)
      .toSorted((a, b) => b.length - a.length);
    const drafts: FactDraft[] = [];
    const seen = new Set<string>();
    let carry: DraftObject | undefined;

    for (const { text: raw, question } of clauseMoods(evidence.text)) {
      // 别人转述的先去掉"同事说他"（转述的人不算场景）
      const body = evidence.sourceLevel === "self" ? raw : raw.replace(REPORTER, "").trim();
      let clause = strip(body, /^(?:我们|我|用户|本人)/);
      // "不是 X"：X 取反（"不是很喜欢"只是语气，不算）
      let deny = false;
      if (/^(?:并)?不是(?![很太特])/.test(clause)) {
        deny = true;
        clause = clause.replace(/^(?:并)?不是/, "");
      }
      clause = strip(clause, DISCOURSE);
      if (clause.length === 0) continue;
      // 问句、商量的话不当成说过的事（207 号票）：只记下它说到的那件事
      if (question) {
        carry = this.carryFrom(clause, names, carry);
        continue;
      }
      // 复述以前说过的话：不当成新说法，只记下它说到的那件事（后面"就是不想去"去的是它）
      if (isRecount(clause)) {
        carry = this.carryFrom(clause, names, carry);
        continue;
      }
      if ((evidence.sourceLevel === "self" && THIRD_PERSON.test(clause) && !clause.includes("我")) || INVITED.test(clause)) {
        carry = this.carryFrom(clause, names, carry);
        continue;
      }

      const matched = this.matchRule(clause);
      let predicate: Predicate = "said_about";
      let negated = false;
      let object: DraftObject | undefined;
      let isState = false;
      if (matched) {
        predicate = matched.rule.predicate;
        negated = matched.rule.negated;
        object = this.objectFor(matched, names, carry);
      }
      if (!object) {
        const state = this.matchState(clause);
        if (!state) {
          carry = this.carryFrom(clause, names, carry);
          continue;
        }
        predicate = "said_about";
        negated = state.negated;
        object = { type: "entity", ref: { name: state.topic, type: "topic" } };
        isState = true;
      }
      // 说自己忙、累不是一件能去不去的事，不留给后面的分句当宾语
      if (!isState) carry = object;
      negated = negated !== deny;
      if (predicate === "participated_in" && object.type === "entity" && "type" in object.ref && object.ref.type === "place") predicate = "occurred_at";

      const key = `${predicate}|${negated}|${JSON.stringify(object)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const draft: FactDraft = {
        subject: USER_REF,
        predicate: predicate,
        object,
        negated,
        context: clauseContext(evidence.context, body),
        signals: { change: changeSignals(raw), correction: [...correction] },
        span: raw,
      };
      if (!EPISODIC_PREDICATES.has(predicate)) Object.assign(draft, this.validityFor(raw, ref));
      drafts.push(draft);
    }
    return drafts;
  }

  /** 状态类事实的有效期：时间说法 > "以前" > "一直"；都没有就不给（用发生时间） */
  private validityFor(clause: string, ref: string): Pick<FactDraft, "validFrom" | "validTo"> {
    const v = resolveValidity(clause, ref);
    if (v) return v;
    if (hasPastMarker(clause)) return { validFrom: null, validTo: ref };
    if (hasAlwaysMarker(clause)) return { validFrom: null };
    return {};
  }

  private matchRule(clause: string): { rule: Rule; before: string; after: string } | undefined {
    for (const rule of RULES) {
      const m = rule.re.exec(clause);
      if (m) return { rule, before: clause.slice(0, m.index), after: m.groups?.obj ?? "" };
    }
    return undefined;
  }

  /** 宾语：后面的 → 后面只有语气词时取前面的 → 都没有时沿用上一个分句的。后面有东西但认不出来时不沿用（不硬抽） */
  private objectFor(m: { rule: Rule; before: string; after: string }, names: string[], carry: DraftObject | undefined): DraftObject | undefined {
    const after = this.toObject(m.after, m.rule.predicate, names);
    if (after) return after;
    if (m.rule.objectAfterOnly) return undefined;
    const afterIsEmpty = strip(m.after, TRAILING).length === 0;
    const before = this.toObject(strip(m.before, BEFORE_TRAILING), m.rule.predicate, names);
    if (before) return before;
    return afterIsEmpty ? carry : undefined;
  }

  private toObject(raw: string, predicate: Predicate, names: string[]): DraftObject | undefined {
    let s = raw.replace(/[“”"'「」『』《》()（）]/g, "");
    const passive = PASSIVE_ARRANGED.exec(s);
    if (passive) return this.lookup(passive[0], names) ?? { type: "entity", ref: { name: ARRANGED_NAME, type: "topic" } };
    s = strip(strip(s, TRAILING), SUFFIXES);
    s = strip(s, TRAILING);
    if (s.length === 0) return undefined;
    const direct = this.lookup(s, names);
    if (direct) return direct;
    const de = s.lastIndexOf("的");
    if (de >= 0 && de < s.length - 1) s = s.slice(de + 1);
    const head = this.lookup(s, names);
    if (head) return head;
    s = strip(s, LEADING);
    const person = this.lexicon.persons.find((p) => s === p);
    if (person) return { type: "entity", ref: { name: person, type: "person" } };
    for (const p of this.lexicon.persons) if (s.startsWith(p) && s.length > p.length) s = s.slice(p.length);
    s = strip(s, LEADING);
    if (s.length < 2 || s.length > MAX_OBJECT_CHARS || /[我你他她]/.test(s) || /^[了过着得地的]/.test(s) || STOP.has(s)) return undefined;
    return { type: "entity", ref: { name: s, type: this.typeFor(s, predicate) } };
  }

  /** 词表（长的先配）和已知实体的名字里，句子包含的那个 */
  private lookup(s: string, names: string[]): DraftObject | undefined {
    const hit = this.terms.find((t) => s.includes(t.term));
    if (hit) return { type: "entity", ref: { name: hit.entry.name, type: hit.entry.type } };
    const name = names.find((n) => s.includes(n));
    if (name) return { type: "entity", ref: { name, type: "topic" } };
    return undefined;
  }

  /**
   * 没抽出事实的分句留给后面当宾语的：句子里认得的那样东西，没有就还是原来的。
   * 用顿号列了几样的（行程、安排："上午爬山、中午农家乐、晚上唱歌"）说不准后面指的是哪一样，不沿用（194 号票：
   * 冒号、引号分句以后，"我回：这个我就不参加了"的宾语要往前找，不能从行程里随便挑一样）。
   */
  private carryFrom(clause: string, names: string[], carry: DraftObject | undefined): DraftObject | undefined {
    if (clause.includes("、")) return undefined;
    return this.lookup(clause, names) ?? carry;
  }

  private typeFor(name: string, predicate: Predicate): EntityType {
    if (this.lexicon.places.includes(name) || this.lexicon.placeSuffixes.some((s) => name.endsWith(s))) return "place";
    if (predicate === "participated_in" || predicate === "declined" || predicate === "initiated") return "activity";
    if (predicate === "works_on") return "project";
    return "topic";
  }

  /** 说自己的状态（忙、累……）；前面紧挨着"不、没、谈不上……"（中间可以有"算、太、怎么、那么、觉得……"）是否定（207 号票） */
  private matchState(clause: string): { topic: string; negated: boolean } | undefined {
    for (const [topic, words] of Object.entries(this.lexicon.states)) {
      for (const w of words) {
        const i = clause.indexOf(w);
        if (i < 0) continue;
        if (w === "累" && (/[积连]$/.test(clause.slice(0, i)) || clause[i + 1] === "计")) continue;
        return { topic, negated: STATE_NEGATION.test(clause.slice(0, i)) };
      }
    }
    return undefined;
  }
}
