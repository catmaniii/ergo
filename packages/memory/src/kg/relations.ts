// 实体关系更丰富（199 号票）：规则版抽取在 188 的 RuleFactExtractor（以用户为中心的"用户 拒绝了 聚会"）上加一层：
// - 事件当实体：别人来约用户（"老王组织的""阿珂问今晚要不要去……"）认成一个邀约，事件实体带组织者、参加的人、地点、时间段、活动类型、
//   提前多久约的（organized_by、involves、held_at、in_slot、of_type、lead_time），用户对它是拒绝了还是去了（declined、participated_in）；
//   这条证据里 188 抽出的"参加了、拒绝了、主动约了"换成对事件的（188 把别人约的认成用户主动约的，"当晚""第一个"也当成了活动）；
// - 人：外号（老王、小许、王哥、刘姐、阿珂、大飞）、亲属称呼（我妈、表姐）、工作上的角色（客户、供应商、猎头、组长）；
//   和谁一起（"跟阿杰去""陪我爸""喊上老周和阿杰"，went_with），提到了谁（mentioned）；
// - 人和人的关系：同事、家人、朋友、工作上的联系人（colleague_of、family_of、friend_of、work_contact_of），看称呼和旁边的说法
//   （隔壁组、部门群、高中同学……）；
// - 别名："老王（组里都喊他王哥）""X，也就是 Y"交出一对叫法，引擎抽事实之前先对齐（kg/align.ts）；
// - 188 认不出的几种简单句式：最烦 X、要 / 打算 / 每天 X（打算做的事记成偏好）、一条 X 记录也没有（没做）、聊得挺开心（对上一样活动的好感）、
//   坐 / 没赶上 / 已检票的车次、在投简历；"累就没了"这类不是在说累，不抽。
// 都是通用的说法表，不对着哪条数据写；认不出就不认。id 是 rule:4（207 号票修问句和否定以后 rule:4.1）。
import { EPISODIC_PREDICATES, type EntityType, type Evidence, type Predicate } from "../domain/types.ts";
import { localDate, offsetMinutes } from "../domain/time.ts";
import type { AliasAware, AliasDraft } from "./align.ts";
import { clauseContext } from "./context.ts";
import { clauseMoods, inQuestionClause, RuleFactExtractor, USER_REF, type DraftObject, type EntityRef, type FactDraft, type FactExtractor, type KgView } from "./extractor.ts";
import { DEFAULT_LEXICON, lexiconIndex, type Lexicon } from "./lexicon.ts";
import { changeSignals, correctionSignals, hasAlwaysMarker, hasPastMarker, resolveValidity } from "./signals.ts";

// ---------- 词表 ----------

/** 人和人的关系 */
export const RELATION_PREDICATES = ["colleague_of", "family_of", "friend_of", "work_contact_of"] as const;
export type RelationPredicate = (typeof RELATION_PREDICATES)[number];

/** 关系的说法 */
export const RELATION_LABELS: Readonly<Record<RelationPredicate, string>> = { colleague_of: "同事", family_of: "家人", friend_of: "朋友", work_contact_of: "工作上的联系人" };

/** 关系对应的场景标签（推理图谱补场景用） */
export const RELATION_SCENES: Readonly<Record<RelationPredicate, string>> = { colleague_of: "work", family_of: "family", friend_of: "social", work_contact_of: "work" };

/** 事件实体的属性 */
export const EVENT_PREDICATES = ["organized_by", "involves", "held_at", "in_slot", "of_type", "lead_time"] as const;
export type EventPredicate = (typeof EVENT_PREDICATES)[number];

/** 提前多久约的：三档 */
export const LEAD_BUCKETS = ["当天才约", "提前1到3天约", "提前4天以上约"] as const;

/** 时间段：一天是哪种 + 一天里的哪段 */
export const SLOT_DAYTYPES = ["工作日", "周末", "假期"] as const;
export const SLOT_PARTS = ["上午", "中午", "下午", "晚上"] as const;
export const SLOT_PATTERN = /^(?:工作日|周末|假期)(?:上午|中午|下午|晚上)$/;

/** 邀约的活动类型（规范名 → 说法），说法长的先配 */
export const ACTIVITY_KINDS: Readonly<Record<string, readonly string[]>> = {
  聚餐: ["火锅", "烤鱼", "串串", "烧烤", "撸串", "宵夜", "一桌菜", "欢送饭", "饭局", "聚餐", "吃饭", "喝酒", "喝一杯", "下午茶", "请客"],
  运动: ["羽毛球", "篮球", "足球", "网球", "乒乓球", "打球", "跑步", "爬山", "徒步", "游泳", "健身", "骑行", "露营"],
  文娱: ["听现场", "音乐酒馆", "演唱会", "音乐节", "看电影", "电影", "看展", "唱K", "KTV", "唱歌", "剧本杀", "桌游", "密室"],
  工作机会: ["二面", "一面", "三面", "终面", "面试", "岗位", "offer", "职位", "工作机会"],
  见面: ["见一面", "见个面", "见面", "聚一聚", "聚聚"],
  会议: ["开会", "会议", "评审", "站会"],
};

const SURNAMES = "王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤";

/** 亲属称呼 → 规范名 */
const KIN: readonly (readonly [string, string])[] = [
  ["我爸妈", "爸妈"],
  ["爸妈", "爸妈"],
  ["父母", "爸妈"],
  ["我爸", "爸"],
  ["爸爸", "爸"],
  ["老爸", "爸"],
  ["我妈", "妈"],
  ["妈妈", "妈"],
  ["老妈", "妈"],
  ...["表姐", "表哥", "表妹", "表弟", "堂姐", "堂哥", "堂弟", "堂妹", "姐姐", "哥哥", "弟弟", "妹妹", "老婆", "老公", "儿子", "女儿", "舅舅", "姑姑", "姨妈", "叔叔", "奶奶", "爷爷", "外婆", "外公"].map((k) => [k, k] as const),
];

/** 工作上的角色：说法 → 关系 */
const ROLES: Readonly<Record<string, RelationPredicate>> = {
  客户: "work_contact_of",
  供应商: "work_contact_of",
  猎头: "work_contact_of",
  面试官: "work_contact_of",
  组长: "colleague_of",
  领导: "colleague_of",
  老板: "colleague_of",
  经理: "colleague_of",
  主管: "colleague_of",
};

/** 名字前面紧挨着这些说法：朋友、同事 */
const FRIEND_CUES = /(?:高中同学|大学同学|初中同学|老同学|同学|朋友|发小|室友|哥们|闺蜜)$/;
const COLLEAGUE_CUES = /(?:同事|隔壁组|组里|我们组|他们组|部门)$/;
/** 一句话里有这些说法，这句话的头一个人是同事（在部门群里约、周会上） */
const COLLEAGUE_SENTENCE = /部门群|公司群|工作群|组里|周会|隔壁组|他们组|我们组/;

/** 认出的一个人（或单位） */
interface Mention {
  name: string;
  start: number;
  end: number;
  type: EntityType;
  /** 称呼本身带的关系（亲属、角色） */
  relation?: RelationPredicate;
}

const NICK = new RegExp(`(?:[老小][${SURNAMES}](?![病家板师乡婆公头子年时样实])|[${SURNAMES}][哥姐](?!们)|阿[一-鿿](?<![阿][姨里拉尔富根联]))`, "g");
const BIG = /大[一-鿿](?=发消息|发来|说|问|约|叫|打电话|打来|在群里|在部门)/g;
/** 单位："上海一家公司""深圳那家"（城市名开头的），"X 那家公司" */
const ORG = new RegExp(`(?:(?:${DEFAULT_LEXICON.places.join("|")})(?:一家|那家|这家)(?:公司)?|[一-鿿]{2,3}(?:一家|那家|这家)公司)`, "g");

/** 一段话里的人和单位（按位置，长的优先、不重叠） */
export function detectPersons(text: string, known?: KgView): Mention[] {
  const found: Mention[] = [];
  const add = (m: Mention) => found.push(m);
  for (const [term, name] of KIN) for (let i = text.indexOf(term); i >= 0; i = text.indexOf(term, i + 1)) add({ name, start: i, end: i + term.length, type: "person", relation: "family_of" });
  for (const [term, relation] of Object.entries(ROLES)) for (let i = text.indexOf(term); i >= 0; i = text.indexOf(term, i + 1)) add({ name: term, start: i, end: i + term.length, type: "person", relation });
  for (const m of text.matchAll(NICK)) add({ name: m[0], start: m.index, end: m.index + m[0].length, type: "person" });
  for (const m of text.matchAll(BIG)) add({ name: m[0], start: m.index, end: m.index + m[0].length, type: "person" });
  for (const m of text.matchAll(ORG)) add({ name: m[0], start: m.index, end: m.index + m[0].length, type: "organization" });
  if (known) {
    for (const n of known.knownNames()) {
      if (n.length < 2 || known.findEntity(n)?.type !== "person") continue;
      for (let i = text.indexOf(n); i >= 0; i = text.indexOf(n, i + 1)) add({ name: n, start: i, end: i + n.length, type: "person" });
    }
  }
  // 长的优先、不重叠（"老王"和"王哥"里的"王"不会两个都算）
  const sorted = found.toSorted((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const kept: Mention[] = [];
  for (const m of sorted) if (!kept.some((k) => m.start < k.end && k.start < m.end)) kept.push(m);
  return kept.toSorted((a, b) => a.start - b.start);
}

/** 一个人和用户的关系：称呼本身带的，或者名字前面、这句话里的说法 */
function relationOf(m: Mention, text: string, sentenceStart: number, firstInSentence: boolean): RelationPredicate | undefined {
  if (m.relation) return m.relation;
  if (m.type !== "person") return undefined;
  const before = text.slice(Math.max(0, m.start - 6), m.start);
  if (FRIEND_CUES.test(before)) return "friend_of";
  if (COLLEAGUE_CUES.test(before)) return "colleague_of";
  const sentence = text.slice(sentenceStart, sentenceEndOf(text, m.start));
  if (firstInSentence && COLLEAGUE_SENTENCE.test(sentence)) return "colleague_of";
  return undefined;
}

const SENTENCE_END = /[。！？!?；;\n]/;

function sentenceStartOf(text: string, i: number): number {
  for (let j = i - 1; j >= 0; j--) if (SENTENCE_END.test(text[j]!)) return j + 1;
  return 0;
}

function sentenceEndOf(text: string, i: number): number {
  for (let j = i; j < text.length; j++) if (SENTENCE_END.test(text[j]!)) return j;
  return text.length;
}

/** 别名："老王（组里都喊他王哥）"、"老王，也就是王哥" */
export function detectAliases(text: string, known?: KgView): AliasDraft[] {
  const out: AliasDraft[] = [];
  const persons = detectPersons(text, known);
  for (const p of persons) {
    const rest = text.slice(p.end);
    const paren = /^[（(]([^）)]{0,12}?)(?:喊他|叫他|称他|喊她|叫她|称她|都叫|也叫|人称|外号|又叫)([^）)]{1,6})[）)]/.exec(rest);
    const also = /^[，,]?(?:也就是|就是|即)([^，。！？]{1,6})/.exec(rest);
    const raw = paren ? paren[2]! : also ? also[1]! : undefined;
    if (!raw) continue;
    const alias = detectPersons(raw, known)[0]?.name ?? raw.trim();
    if (alias.length === 0 || alias === p.name) continue;
    out.push({ name: p.name, alias, type: p.type, span: text.slice(p.start, p.end + (paren ?? also)![0].length) });
  }
  return out;
}

// ---------- 时间 ----------

const DAY_NUM: Readonly<Record<string, number>> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };

/** 本地日期（YYYY-MM-DD）加减几天 */
function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

/** 星期几（周一 = 1 … 周日 = 7） */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;
}

function dayMs(s: string): number {
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

function daysBetween(from: string, to: string): number {
  return Math.round((dayMs(to) - dayMs(from)) / 86_400_000);
}

/** 这周（周一起）的第几天 */
function dayOfWeek(ref: string, weekDelta: number, day: number): string {
  return shiftDate(ref, -(weekdayOf(ref) - 1) + weekDelta * 7 + (day - 1));
}

const PART_WORDS: readonly (readonly [RegExp, (typeof SLOT_PARTS)[number]])[] = [
  [/上午|早上|早晨|一早/, "上午"],
  [/中午|午饭/, "中午"],
  [/下午/, "下午"],
  [/晚上|今晚|明晚|下班|夜里|宵夜|晚饭|傍晚/, "晚上"],
];

function partOf(s: string): (typeof SLOT_PARTS)[number] | undefined {
  let best: { i: number; part: (typeof SLOT_PARTS)[number] } | undefined;
  for (const [re, part] of PART_WORDS) {
    const m = re.exec(s);
    if (m && (!best || m.index < best.i)) best = { i: m.index, part };
  }
  return best?.part;
}

/** 约的那天：动词前面的"上周一、周三、下午五点多……"；没说是 undefined。sameDayClock：只说了几点（当天） */
function inviteDate(before: string, whole: string, ref: string): { date: string; sameDayClock: boolean; part?: (typeof SLOT_PARTS)[number] } | undefined {
  const last = /上(?:周|个?星期|个?礼拜)([一二三四五六日天])/.exec(before);
  if (last) return { date: dayOfWeek(ref, -1, DAY_NUM[last[1]!]!), sameDayClock: false };
  // "王哥周三在部门群里约"是约的那天；"发了周六的安排"里的周六是活动那天，不算
  const thisWeek = /(?<![上下这本])(?:周|星期|礼拜)([一二三四五六日天])(?!的)/.exec(before);
  const clock = /(上午|下午|晚上|早上|中午|傍晚)?[一二三四五六七八九十两\d]{1,3}点/.exec(before);
  if (thisWeek) return { date: dayOfWeek(ref, 0, DAY_NUM[thisWeek[1]!]!), sameDayClock: clock !== null, part: clock?.[1] ? partOf(clock[1]) : undefined };
  if (clock) return { date: ref, sameDayClock: true, part: clock[1] ? partOf(clock[1]) : undefined };
  if (/昨天/.test(before)) return { date: shiftDate(ref, -1), sameDayClock: false };
  // "上周就订好了"：只说了上周，按上周最晚的那天（周日）算，往少里算
  if (/上(?:周|个?星期|个?礼拜)(?![一二三四五六日天])[^，。]{0,2}就/.test(whole)) return { date: dayOfWeek(ref, -1, 7), sameDayClock: false };
  return undefined;
}

/**
 * 活动那天：动词后面的"这周五、下周六、今晚、现在……"；动词后面没说的，再看组织者和动词之间有没有"今晚、中午"这类
 * （"表姐打来电话，说中午做了一桌菜，叫用户过去"），那里的星期几是约的那天，不算
 */
function eventDate(after: string, between: string, invite: { date: string; sameDayClock: boolean } | undefined, ref: string): string | undefined {
  const next = /下(?:周|个?星期|个?礼拜)([一二三四五六日天])/.exec(after);
  if (next) return dayOfWeek(ref, 1, DAY_NUM[next[1]!]!);
  const thisWeek = /(?<!上)(?:这|本)?(?:周|星期|礼拜)([一二三四五六日天])/.exec(after);
  if (thisWeek) return dayOfWeek(ref, 0, DAY_NUM[thisWeek[1]!]!);
  const modifier = /(?<!上)(?:这|本)?(?:周|星期|礼拜)([一二三四五六日天])的/.exec(between);
  if (modifier) return dayOfWeek(ref, 0, DAY_NUM[modifier[1]!]!);
  const sameDay = /今晚|今天|现在|马上|这会儿|晚上|中午|下午|上午/;
  for (const s of [after, between]) {
    if (/明天|明晚/.test(s)) return shiftDate(invite?.date ?? ref, 1);
    if (sameDay.test(s)) return invite?.date ?? ref;
  }
  return undefined;
}

export function leadBucket(days: number): (typeof LEAD_BUCKETS)[number] | undefined {
  if (days < 0) return undefined;
  if (days === 0) return "当天才约";
  return days <= 3 ? "提前1到3天约" : "提前4天以上约";
}

// ---------- 邀约 ----------

/** 认出的一个邀约 */
export interface EventFrame {
  organizer: Mention;
  /** 用户怎么回的 */
  response: "declined" | "accepted";
  name: string;
  /** 活动的说法和类型 */
  activity?: string;
  kind?: string;
  place?: string;
  participants: Mention[];
  slot?: string;
  lead?: (typeof LEAD_BUCKETS)[number];
  leadDays?: number;
  /** 活动那天（本地日期），不知道是 undefined */
  date?: string;
  /** 邀约那句话 */
  span: string;
}

const INVITE_VERB = /约了?|问|叫|喊|张罗了?|组织了?|发起了?|推了个?|发过来|发来|邀请/g;
const DECLINE_CUES = /没接龙|不去了|就不去|就不了|不过去了|就不过去|先不考虑|不考虑了|你们去吧|你们吃|你们玩|下回吧|下次吧|下次一定|下回|改天吧|推掉|回绝|婉拒|拒绝了|不参加了?|去不了|先不了|还是回了|回掉了/g;
const ACCEPT_CUES = /报了名|报名了?|(?<![不没])去了|答应了?|说好|好的|能！|能!|必须去|一起去|先约个面试|可以，|赴约|(?<![不没])(?:吃到|玩到|听到)/g;

/** 用户最后怎么回的：拒绝和去了的说法里最后出现的那个（"不过去了"里的"去了"不算去了） */
function lastCue(text: string): "declined" | "accepted" | undefined {
  const declines = [...text.matchAll(DECLINE_CUES)].map((m) => ({ i: m.index, end: m.index + m[0].length }));
  const accepts = [...text.matchAll(ACCEPT_CUES)].map((m) => ({ i: m.index, end: m.index + m[0].length })).filter((a) => !declines.some((d) => a.i < d.end && d.i < a.end));
  const lastDecline = declines.at(-1)?.i ?? -1;
  const lastAccept = accepts.at(-1)?.i ?? -1;
  if (lastDecline < 0 && lastAccept < 0) return undefined;
  return lastDecline > lastAccept ? "declined" : "accepted";
}

/** 活动的说法：最早出现的那个（同一位置长的先），带类型 */
function activityIn(s: string): { activity: string; kind: string } | undefined {
  let best: { i: number; len: number; activity: string; kind: string } | undefined;
  for (const [kind, words] of Object.entries(ACTIVITY_KINDS)) {
    for (const w of words) {
      const i = s.indexOf(w);
      if (i < 0) continue;
      if (!best || i < best.i || (i === best.i && w.length > best.len)) best = { i, len: w.length, activity: w === "音乐酒馆" ? "听现场" : w, kind };
    }
  }
  return best && { activity: best.activity, kind: best.kind };
}

const VENUE = /(?:去|在|到)([一-鿿]{1,8}?(?:酒馆|酒吧|餐厅|饭店|饭馆|火锅店|球馆|球场|公园|河边|江边|海边|湖边|广场|商场|咖啡馆|茶馆|包间))/;
const HOME = /(?:去|在|到)([一-鿿]{1,3}?家)(?![一-鿿])/;

/** 地点：去、在、到后面的场所，"她家"是组织者家；都没有看提到的城市（最先出现的） */
function placeIn(s: string, organizer: Mention, places: readonly string[]): string | undefined {
  const venue = VENUE.exec(s);
  if (venue && !/^[我你]/.test(venue[1]!)) return venue[1]!;
  const home = HOME.exec(s);
  if (home) return /^[她他]家$/.test(home[1]!) ? `${organizer.name}家` : /^[我你]/.test(home[1]!) ? undefined : home[1]!;
  return earliestCity(s, places);
}

function earliestCity(s: string, places: readonly string[]): string | undefined {
  let best: { i: number; c: string } | undefined;
  for (const c of places) {
    const i = s.indexOf(c);
    if (i >= 0 && (!best || i < best.i)) best = { i, c };
  }
  return best?.c;
}

/**
 * 认一个邀约：同一句话里，一个人（或单位）后面跟着约、问、叫、张罗、推……，后面不是另一个人（"约老周"是用户约别人）；
 * 前面不是"没、不、别"。用户怎么回的看最后一个回复的说法（拒绝：没接龙、就不去了、下回吧……；去了：报了名、当晚去了、答应了……）。
 * 认不出回复的不算（只认邀约不认回复，用户和事件连不上）。只认本人的证据（别人转述的不抽事件）。
 */
export function detectInvitation(evidence: Evidence, known?: KgView, places: readonly string[] = DEFAULT_LEXICON.places): EventFrame | undefined {
  if (evidence.sourceLevel !== "self") return undefined;
  const text = evidence.text;
  const persons = detectPersons(text, known);
  const aliasSpans = detectAliases(text, known).map((a) => {
    const i = text.indexOf(a.span);
    return [i, i + a.span.length] as const;
  });
  for (const v of text.matchAll(INVITE_VERB)) {
    const at = v.index;
    if (/[没不别]$/.test(text.slice(Math.max(0, at - 1), at))) continue;
    const sStart = sentenceStartOf(text, at);
    const before = persons.filter((p) => p.start >= sStart && p.end <= at && !aliasSpans.some(([a, b]) => p.start > a && p.end <= b));
    const organizer = before.at(-1);
    if (!organizer) continue;
    const nextPerson = persons.find((p) => p.start >= at + v[0].length && p.start <= at + v[0].length + 1);
    if (nextPerson) continue;
    const response = lastCue(text.slice(at));
    if (!response) continue;
    const sEnd = sentenceEndOf(text, at);
    const sentence = text.slice(sStart, sEnd);
    const ref = localDate(evidence.eventTime ?? evidence.observedAt);
    const beforeVerb = text.slice(sStart, at);
    const invite = inviteDate(beforeVerb, text, ref);
    const eventSeg = text.slice(at + v[0].length, sEnd);
    const between = text.slice(organizer.end, at);
    const date = eventDate(eventSeg, between, invite, ref);
    const act = activityIn(eventSeg) ?? activityIn(text.slice(organizer.start, sEnd));
    const part = partOf(eventSeg) ?? partOf(between) ?? (invite?.sameDayClock && date === invite.date ? invite.part : undefined);
    let slot: string | undefined;
    if (date && part) {
      const holiday = evidence.context.includes("holiday") && date === ref;
      slot = `${holiday ? "假期" : weekdayOf(date) >= 6 ? "周末" : "工作日"}${part}`;
    }
    const leadDays = invite && date ? daysBetween(invite.date, date) : undefined;
    const participants = persons.filter((p) => p.type === "person" && p.name !== organizer.name && !aliasSpans.some(([a, b]) => p.start > a && p.end <= b));
    const what = act?.activity ?? act?.kind ?? "活动";
    return {
      organizer,
      response,
      name: `${organizer.name}约的${what}（${date ?? ref}）`,
      activity: act?.activity,
      kind: act?.kind,
      place: placeIn(text.slice(organizer.end, sEnd), organizer, places) ?? (organizer.type === "organization" ? earliestCity(organizer.name, places) : undefined),
      participants: [...new Map(participants.map((p) => [p.name, p])).values()],
      slot,
      lead: leadDays === undefined ? undefined : leadBucket(leadDays),
      leadDays,
      date,
      span: sentence,
    };
  }
  return undefined;
}

// ---------- 抽取器 ----------

const COMPANION_BEFORE = /(?:跟|和|陪|喊上|叫上|约上|带上|带着)$/;

/** 一条不带信号的关系草稿 */
const rel = (who: EntityRef, predicate: Predicate, object: DraftObject, span: string, context: string[] = []): FactDraft => ({ subject: who, predicate, object, negated: false, context, signals: { change: [], correction: [] }, span });
const personRef = (m: Mention): EntityRef => ({ name: m.name, type: m.type });
/** 车次：动车也记成高铁 */
const vehicle = (s: string): DraftObject => ({ type: "entity", ref: { name: s === "动车" ? "高铁" : s, type: "activity" } });
const pad = (n: string | undefined, d = "00") => (n ?? d).padStart(2, "0");
const RELIEF = /(?:就|都|也|一下)?(?:没了|全没了|消了|散了|一扫而空|好多了)/;
const EPISODE_PREDICATES: ReadonlySet<Predicate> = new Set<Predicate>(["participated_in", "declined", "initiated", "occurred_at"]);
const VEHICLES = "高铁|动车|火车|飞机|航班|大巴";
const RUN = /跑(?:步|了?[\d一二两三四五六七八九十几半]+(?:公里|圈|回|次|趟)|这么跑|起来)/;

/** 规则版抽取（rule:4）：188 的规则版加实体关系（见文件开头）；同时交出别名。207 号票修问句和否定，rule:4.1 */
export class RelationalFactExtractor implements FactExtractor, AliasAware {
  readonly id = "rule:4.1";
  private readonly base: RuleFactExtractor;
  private readonly lexicon: Lexicon;
  private readonly terms: { term: string; entry: Lexicon["entries"][number] }[];

  constructor(lexicon: Lexicon = DEFAULT_LEXICON) {
    this.lexicon = lexicon;
    this.base = new RuleFactExtractor(lexicon);
    this.terms = lexiconIndex(lexicon);
  }

  aliasesOf(evidence: Evidence, known: KgView): AliasDraft[] {
    if (evidence.status !== "active" || evidence.sourceLevel !== "self") return [];
    return detectAliases(evidence.text, known);
  }

  extract(evidence: Evidence, known: KgView): FactDraft[] {
    const base = this.base.extract(evidence, known);
    if (evidence.status !== "active" || evidence.text.trim().length === 0) return base;
    const text = evidence.text;
    const correction = correctionSignals(text);
    if (evidence.kind === "correction") correction.unshift("kind:correction");
    const signals = (span: string) => ({ change: changeSignals(span), correction: [...correction] });
    const frame = detectInvitation(evidence, known, this.lexicon.places);
    // 188 抽出的：有邀约时"参加了、拒绝了、主动约了"换成对事件的；"累就没了"不是在说累
    let drafts = base.filter((d) => {
      if (frame && EPISODE_PREDICATES.has(d.predicate)) return false;
      if (d.predicate === "said_about" && d.object.type === "entity" && "name" in d.object.ref) {
        const state = this.lexicon.states[d.object.ref.name] ?? [];
        if (state.some((w) => d.span.includes(w) && RELIEF.test(d.span.slice(d.span.indexOf(w) + w.length)))) return false;
      }
      return true;
    });
    if (evidence.sourceLevel !== "self") return drafts;

    const out: FactDraft[] = [];
    const persons = detectPersons(text, known);
    const aliasNames = new Set(detectAliases(text, known).map((a) => a.alias));
    const user: DraftObject = { type: "entity", ref: USER_REF };

    // 人和人的关系
    const related = new Set<string>();
    for (const m of persons) {
      if (aliasNames.has(m.name) || related.has(m.name)) continue;
      const sStart = sentenceStartOf(text, m.start);
      const first = persons.find((p) => p.start >= sStart) === m;
      const r = relationOf(m, text, sStart, first);
      if (!r) continue;
      related.add(m.name);
      out.push(rel(personRef(m), r, user, text.slice(sStart, sentenceEndOf(text, m.start))));
    }

    // 邀约：事件实体
    if (frame) {
      const event: EntityRef = { name: frame.name, type: "event" };
      const eventObj: DraftObject = { type: "entity", ref: event };
      out.push({
        subject: USER_REF,
        predicate: frame.response === "declined" ? "declined" : "participated_in",
        object: eventObj,
        negated: false,
        context: [...evidence.context],
        signals: signals(frame.span),
        span: frame.span,
      });
      out.push(rel(event, "organized_by", { type: "entity", ref: personRef(frame.organizer) }, frame.span));
      for (const p of frame.participants) out.push(rel(event, "involves", { type: "entity", ref: personRef(p) }, frame.span));
      if (frame.place) out.push(rel(event, "held_at", { type: "entity", ref: { name: frame.place, type: "place" } }, frame.span));
      if (frame.slot) out.push(rel(event, "in_slot", { type: "value", value: frame.slot }, frame.span));
      if (frame.kind) out.push(rel(event, "of_type", { type: "entity", ref: { name: frame.kind, type: "activity" } }, frame.span));
      if (frame.lead) out.push(rel(event, "lead_time", { type: "value", value: frame.lead }, frame.span));
    } else {
      // 和谁一起、提到了谁
      let companion: boolean = false;
      const emitted = new Set<string>();
      const moods = clauseMoods(text);
      for (const [i, m] of persons.entries()) {
        if (m.type !== "person" || aliasNames.has(m.name)) continue;
        const before = text.slice(Math.max(0, m.start - 3), m.start);
        const chained: boolean = i > 0 && companion && /^(?:和|、|跟)$/.test(text.slice(persons[i - 1]!.end, m.start));
        // 问句里的"跟阿杰去"不是和阿杰一起去了（207 号票），只算提到了
        const isCompanion: boolean = (COMPANION_BEFORE.test(before) || chained) && !inQuestionClause(text, m.start, moods);
        companion = isCompanion;
        const span = text.slice(sentenceStartOf(text, m.start), sentenceEndOf(text, m.start));
        if (emitted.has(m.name)) continue;
        if (isCompanion) {
          emitted.add(m.name);
          out.push({ ...rel(USER_REF, "went_with", { type: "entity", ref: personRef(m) }, span, clauseContext(evidence.context, span)), signals: signals(span) });
        } else if (evidence.mode === "say" && !persons.slice(i + 1).some((x) => x.name === m.name && COMPANION_BEFORE.test(text.slice(Math.max(0, x.start - 3), x.start)))) {
          emitted.add(m.name);
          out.push({ ...rel(USER_REF, "mentioned", { type: "entity", ref: personRef(m) }, span, clauseContext(evidence.context, span)), signals: signals(span) });
        }
      }
    }

    // 188 认不出的几种简单句式（只看 188 什么都没抽出来的分句）
    const covered = new Set(drafts.map((d) => d.span));
    let carry: DraftObject | undefined;
    const ref = evidence.eventTime ?? evidence.observedAt;
    for (const { text: raw, question } of clauseMoods(text)) {
      const found = this.activityOf(raw);
      // 问句、商量的话不当成说过的事（207 号票）：只记下说到的活动
      if (question) {
        if (found) carry = found;
        continue;
      }
      if (covered.has(raw)) {
        const d = drafts.find((x) => x.span === raw);
        if (d && d.object.type === "entity" && "type" in d.object.ref && d.object.ref.type === "activity") carry = d.object;
        else if (found) carry = found;
        continue;
      }
      const draft = this.clauseRule(raw, found, carry, evidence, signals(raw), known);
      if (found) carry = found;
      if (!draft) continue;
      if (!EPISODIC_PREDICATES.has(draft.predicate)) Object.assign(draft, this.validityFor(raw, ref));
      if (draft.object.type === "entity" && "type" in draft.object.ref && draft.object.ref.type === "activity") carry = draft.object;
      out.push(draft);
    }
    drafts = [...drafts, ...out];
    // 同一条证据里一模一样的只留一条
    const seen = new Set<string>();
    return drafts.filter((d) => {
      const key = `${JSON.stringify(d.subject)}|${d.predicate}|${d.negated}|${JSON.stringify(d.object)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /** 分句里说到的活动：跑几公里 → 跑步；词表里的活动 */
  private activityOf(clause: string): DraftObject | undefined {
    if (RUN.test(clause)) return { type: "entity", ref: { name: "跑步", type: "activity" } };
    const hit = this.terms.find((t) => t.entry.type === "activity" && clause.includes(t.term));
    return hit ? { type: "entity", ref: { name: hit.entry.name, type: "activity" } } : undefined;
  }

  /** 宾语：词表、跑几公里；"这么跑""这样做"沿用上一样活动 */
  private objectOf(s: string, carry: DraftObject | undefined): DraftObject | undefined {
    if (/^(?:这么|这样|那样)/.test(s.trim()) && carry) return carry;
    if (RUN.test(s)) return { type: "entity", ref: { name: "跑步", type: "activity" } };
    const hit = this.terms.find((t) => s.includes(t.term));
    if (hit) return { type: "entity", ref: { name: hit.entry.name, type: hit.entry.type } };
    return undefined;
  }

  private clauseRule(raw: string, found: DraftObject | undefined, carry: DraftObject | undefined, evidence: Evidence, signals: FactDraft["signals"], known: KgView): FactDraft | undefined {
    // 别人做主语的分句不抽（"阿珂要出差两周"）
    const head = detectPersons(raw, known)[0];
    if ((head && head.start === 0) || /^(?:他们|她们|他|她|别人|大家|对方)/.test(raw)) return undefined;
    const context = clauseContext(evidence.context, raw);
    const draft = (predicate: Predicate, object: DraftObject | undefined, negated = false, extra: Partial<FactDraft> = {}): FactDraft | undefined =>
      object ? { subject: USER_REF, predicate, object, negated, context, signals, span: raw, ...extra } : undefined;
    // 坐了、没赶上、已检票的车次
    const missed = new RegExp(`没赶上[^，。]{0,8}?(${VEHICLES})`).exec(raw);
    if (missed) return draft("participated_in", vehicle(missed[1]!), true);
    const ticket = new RegExp(`(${VEHICLES})票[^。]*?(?:已检票|已使用|已出行|已乘坐)`).exec(evidence.text);
    if (ticket && raw.includes("票")) return draft("participated_in", vehicle(ticket[1]!), false, { eventTime: this.dateInText(evidence) });
    const rode = new RegExp(`(?:坐|乘|搭)了?[^，。]{0,8}?(${VEHICLES})`).exec(raw);
    if (rode) return draft("participated_in", vehicle(rode[1]!));
    // 跑了五公里、打了两个钟头：做了这样活动
    if (found && /(?:跑|打|踢|游|爬|骑|练)了/.test(raw) && !/[没不]/.test(raw)) return draft("participated_in", found);
    // 在投简历、工作还在看
    if (/在(?:投|找|看)(?:简历|工作|机会)|(?:简历|工作)[^，。]{0,3}(?:还在|在)(?:看|找|投)/.test(raw)) return draft("works_on", { type: "entity", ref: { name: "找工作", type: "topic" } });
    // 最烦 X
    const annoyed = /(?:最烦|很烦|真烦|烦死了?|最怕|很怕)(.+)/.exec(raw);
    if (annoyed) return draft("dislikes", this.objectOf(annoyed[1]!, carry));
    // 一条 X 记录也没有、一回都没起来：没做
    const none = /(?:一条|一次|一回)([^，。啥什么]{0,6}?)(?:记录)?(?:也|都)没(?:有)?/.exec(raw);
    if (none) return draft("participated_in", this.objectOf(none[1]!, carry) ?? found ?? carry, true);
    // 我要、打算、从……起每天 X：打算做的事记成偏好（问句在外面就跳过了）
    const plan = /(?:我要|我想要|打算|准备|决定|计划)(?:以后)?(?:每天|天天|每周|每晚|经常)?(.+)/.exec(raw) ?? (/起|开始|以后/.test(raw) ? /(?:每天|天天)(.+)/.exec(raw) : null);
    if (plan) return draft("prefers", this.objectOf(plan[1]!, carry));
    // 聊得挺开心、舒服：对上一样活动的好感
    if (/(?:^|得)(?:挺|很|特别|真|超|好)?(?:开心|舒服|过瘾|痛快|爽|带劲)(?:了|的)?$/.test(raw)) return draft("prefers", carry);
    return undefined;
  }

  /** 正文里写的日期（"4 月 13 日 07:00"）；没写用证据的发生时间 */
  private dateInText(evidence: Evidence): string | null {
    const m = /(\d{1,2})\s*月\s*(\d{1,2})\s*日[^，。\d]{0,8}?(\d{1,2}):(\d{2})/.exec(evidence.text) ?? /(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(evidence.text);
    const ref = evidence.eventTime ?? evidence.observedAt;
    if (!m) return evidence.eventTime;
    const year = Number(localDate(ref).slice(0, 4));
    const offset = offsetMinutes(ref);
    const sign = offset >= 0 ? "+" : "-";
    const zone = `${sign}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0")}:${String(Math.abs(offset) % 60).padStart(2, "0")}`;
    const iso = `${year}-${pad(m[1])}-${pad(m[2])}T${pad(m[3])}:${pad(m[4])}:00${zone}`;
    return iso;
  }

  /** 状态类事实的有效期（同 188）：时间说法 > "以前" > "一直" */
  private validityFor(clause: string, ref: string): Pick<FactDraft, "validFrom" | "validTo"> {
    const v = resolveValidity(clause, ref);
    if (v) return v;
    if (hasPastMarker(clause)) return { validFrom: null, validTo: ref };
    if (hasAlwaysMarker(clause)) return { validFrom: null };
    return {};
  }
}

/** 事件属性的说法（对比模式、回答里用） */
export const EVENT_ATTRIBUTE_LABELS: Readonly<Record<EventPredicate, string>> = {
  organized_by: "组织者",
  involves: "参加的人",
  held_at: "地点",
  in_slot: "时间段",
  of_type: "活动类型",
  lead_time: "提前多久约的",
};
