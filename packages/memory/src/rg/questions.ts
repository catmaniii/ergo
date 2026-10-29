// 了解你问题的问题箱（198 号票，架构文档第 7.6 节）：存、去重、优先级、过期、顺口问、回答回写、跳过、"别问这个"。
// 问题从哪来见 question-sources.ts；每日整理（nightly.ts）每夜把新草稿交给 refresh。
//
// 规矩（主会话 2026-10-20 定的第 2–5 条）：
// - 问题箱：同一个 key 只有一个还开着的问题；"别问这个"挡住的那一类、跳过两次退下的不再生成；答过、过期的冷却 30 天；
//   刚回答过关于某条假设的问题，30 天内不再就它发问。过期时间默认 30 天，目标里有近期状态的跟着它的有效期提前。
// - 顺口问（pick）：每轮回话前看一眼。急事、在等用户做决定时不问；今天问过了不问；话题（196 号票的领域和场景）对得上的才问，
//   挑优先级最高的那个，在回话末尾带一句。对不上的留在问题箱里。永不推送：只有这里和 list 两个出口。
// - 跳过：问了没答（调用的人告诉 recordSkip，或者到第二天还没答）算跳过一次；同一个问题跳过两次退下，记一条回避信号（系统观察到的，不当依据）。
// - 回答（recordAnswer）：回答记成一条本人证据。规则版按"是 / 不是 / 说不好"读，回答得很明确（确实、一点都不、当然……）的马上照问题里写的
//   判法记决定性的支持或反证（支持的走 confirmClaim，标"你确认过"；反证让那一组重新定状态，撤回留墓碑）；有偏向但不明确的等下一夜
//   （applyPendingAnswers）记强的；说不好的照样是证据，不判输赢。
// - 透明：每个问题带"为什么问、为了弄清哪几个假设、什么回答支持哪边"，经过（question_log，只追加）在 list 里看得到。
// - 207 号票：问题箱也是 199 联动的 QuestionSink（引擎默认接上）：reflect 里矛盾根源、对比模式分不出时交来的问题经 offer 进箱
//   （和每夜 refresh 同一套去重、"别问这个"、退下、冷却、刚答过），那一组分出来了经 onClosed 标"不用问了"。
//   优先级 = 回答能不能分出胜负 × 分数接近的程度 × 常不常遇到 × 还没问过（question-sources.ts 的 PriorityDetail）。
// - 271 号票：线上秘书按语气自己改写问法，问了就标一下（标了才 markAsked）；用户紧接着的下一句照旧由白天的规则（classifyReply）认明显的，
//   规则没认出来的不在白天记跳过（pick 的 settle: false），留给每晚整理时记忆管理员把问题和用户之后的几句话一起看（rg/reply-judge.ts）：
//   答了经 recordAnswer（reading 交来模型读出的是 / 不是）回写，没答的 recordNightSkip 算跳过一次，拿不准的 recordUnsure 留到下一夜。
import { addDays, localDate, sameLocalDay, toMs } from "../domain/time.ts";
import type { Claim, ClaimStatus, Confidence, Evidence, EvidenceDraft, LinkWeight, RevisionCause } from "../domain/types.ts";
import type { MemoryEngine } from "../engine.ts";
import { canSupportUserClaims } from "../evidence/boundary.ts";
import { contextsCompatible } from "../kg/context.ts";
import { HELD_STATUSES, rgSession, rgWriter, type RgWriter } from "../store/store.ts";
import type { WriteActor, WriteIntent } from "../domain/types.ts";
import { domainLabels, tagsInText, taskDomains } from "./domains.ts";
import type { KnowYouQuestion, QuestionSink } from "./joint.ts";
import { claimStatusLabel, type AnswerEffect, type PriorityDetail, type QuestionAnswers, type QuestionDraft, type QuestionSource, type QuestionTarget } from "./question-sources.ts";

export const QUESTION_STATUSES = ["open", "asked", "answered", "resolved", "declined", "retired", "expired", "obsolete"] as const;
/**
 * open：在问题箱里（没问过，或者跳过一次又回来了）；asked：顺口问了，等回答；answered：答了、等下一夜判；resolved：判过了；
 * declined：用户说"别问这个"；retired：跳过两次退下；expired：过期了没问到；obsolete：要弄清的已经有结果了（或者依据变了），不用问了
 */
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

export type AnswerVerdict = "yes" | "no" | "unclear";

/** 271 号票加了 unsure：每晚整理时记忆管理员看了问过以后用户说的话，拿不准有没有在答，留到下一夜 */
export const QUESTION_EVENTS = ["created", "asked", "skipped", "retired", "answered", "resolved", "declined", "expired", "obsolete", "unsure"] as const;
export type QuestionEvent = (typeof QUESTION_EVENTS)[number];

export interface Question {
  id: string;
  key: string;
  topic: string;
  kind: QuestionSource;
  sources: QuestionSource[];
  text: string;
  why: string;
  targets: QuestionTarget[];
  answers: QuestionAnswers;
  domains: string[];
  scenes: string[];
  terms: string[];
  probeId: string | null;
  priority: number;
  priorityDetail: PriorityDetail;
  status: QuestionStatus;
  askedCount: number;
  skippedCount: number;
  lastAskedAt: string | null;
  answerEvidenceId: string | null;
  verdict: AnswerVerdict | null;
  /** 回答得很明确（马上判的） */
  clear: boolean;
  answeredAt: string | null;
  /** 回答按判法写进推理图谱的时间 */
  appliedAt: string | null;
  /** 回答那一刻目标断言的状态（判完以后对比"之前 → 之后"） */
  before: Record<string, { status: ClaimStatus; confidence: Confidence }> | null;
  /** 判的结果（之前 → 之后，谁胜出） */
  outcome: string | null;
  createdAt: string;
  expiresAt: string;
  closedAt: string | null;
}

export interface QuestionLogEntry {
  seq: number;
  event: QuestionEvent;
  detail: string;
  evidenceId: string | null;
  at: string;
}

/** 记忆页看的一个问题：目标带现在的状态，加上经过 */
export interface QuestionView extends Question {
  targets: (QuestionTarget & { status: string })[];
  history: QuestionLogEntry[];
}

export interface QuestionBookOptions {
  /** 问题默认多少天过期（默认 30） */
  expiryDays?: number;
  /** 答过、过期的同一个问题多少天内不再生成；刚答过的假设多少天内不再就它发问（默认 30） */
  cooldownDays?: number;
}

export interface RefreshReport {
  added: Question[];
  updated: Question[];
  obsolete: Question[];
  /** 没建的草稿和原因（别问这个、退下了、冷却、刚答过） */
  skipped: { key: string; reason: string }[];
}

export interface PickOptions {
  /** 默认引擎的时钟 */
  at?: string;
  /** 这一轮对话的场景标签（周末、社交……），和对话文字里认出来的合起来 */
  context?: string[];
  /** 这一轮是急事（文字里有"赶紧、马上、紧急……"也算） */
  urgent?: boolean;
  /** 秘书这一轮在等用户做决定（审批、二选一） */
  awaitingDecision?: boolean;
  /**
   * 只看不记（264 号票）：照样挑、写好那一句，但不记"问过"——线上秘书回话前先挑，等它真的在回话里带上了再 markAsked。
   * 问了没答到第二天算跳过那一步照常做
   */
  peek?: boolean;
  /**
   * 挑之前先把问了没答、已经到第二天的记成跳过（默认 true，198 的规矩）。271 号票：线上传 false——白天规则没认出回答的问题
   * 留给每晚整理时记忆管理员判过再记（rg/reply-judge.ts），白天不抢先记跳过
   */
  settle?: boolean;
  /** 267 号票：谁挑的、经谁带出去（留痕用；不给是记忆管理员）——挑之前把问了没答到第二天的记成跳过、记"问过"都算它的 */
  actor?: WriteActor;
  via?: string;
}

/** 267 号票：问题箱的写经唯一写入口时，谁写的、经谁转达（不给按写操作的默认：问过是记忆管理员，跳过、回答是用户的表态，别问这个是用户发起） */
export interface QuestionWriteBy {
  actor?: WriteActor;
  via?: string;
}

export type PickReason = "matched" | "urgent" | "awaiting_decision" | "asked_today" | "empty" | "no_match";

export interface PickResult {
  ask: boolean;
  reason: PickReason;
  /** 为什么问、为什么不问（一句话） */
  detail: string;
  question?: QuestionView;
  /** 回话末尾顺口带的那一句 */
  text?: string;
  /** 话题对上在哪（领域、说法），问了的时候写进经过（264 号票：peek 之后 markAsked 用） */
  matchedOn?: string;
  /** 看过的问题：对没对上、为什么 */
  considered: { questionId: string; matched: boolean; why: string }[];
}

/**
 * 用户在顺口问之后的下一句是什么（264 号票）：在回答这个问题、跳过、说"别问这个"，还是在说别的（不算回答）
 */
export type ReplyKind = "answer" | "skip" | "decline" | "unrelated";

export interface ReplyReading {
  kind: ReplyKind;
  /** 回答读成什么（kind 是 answer 时有） */
  verdict?: AnswerVerdict;
  /** 回答得很明确（kind 是 answer 时有） */
  clear?: boolean;
  /** 认出来靠的那几个字 */
  cue: string;
  /** 为什么这么读（一句话，日志和记忆页用） */
  why: string;
}

export interface AnswerRecord {
  question: QuestionView;
  evidenceId: string;
  verdict: AnswerVerdict;
  clear: boolean;
  /** now：回答得很明确，马上判了；nightly：等下一夜按判法判；none：说不好，不判 */
  applied: "now" | "nightly" | "none";
}

/** 271 号票：交给 recordAnswer 的读法（每晚整理时记忆管理员判出来的：是 / 不是 / 说不好，说得明不明确） */
export interface AnswerReading {
  verdict: AnswerVerdict;
  clear: boolean;
}

export interface SkipRecord {
  question: QuestionView;
  /** 跳过两次退下时记的回避信号 */
  avoidanceEvidenceId: string | null;
}

/** 回话末尾顺口带的那一句的尾巴：说清楚是为了了解你、可以不答 */
export const WOVEN_TAIL = "（想更了解你一点，不想答可以跳过。）";

/** 急事的说法 */
const URGENT_WORDS: readonly string[] = ["赶紧", "马上", "立刻", "立即", "紧急", "来不及", "尽快", "快点", "救命", "火速", "十万火急", "急死"];

const json = (v: unknown) => JSON.stringify(v);
const parse = <T>(v: unknown): T => JSON.parse(String(v)) as T;
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const WEIGHT_ORDER: readonly LinkWeight[] = ["weak", "strong", "decisive"];
const minWeight = (a: LinkWeight, b: LinkWeight): LinkWeight => (WEIGHT_ORDER.indexOf(a) <= WEIGHT_ORDER.indexOf(b) ? a : b);
const VERDICT_LABEL: Readonly<Record<AnswerVerdict, string>> = { yes: "是", no: "不是", unclear: "说不好" };
const STATUS_TEXT: Readonly<Record<QuestionStatus, string>> = {
  open: "在问题箱里",
  asked: "问过、等回答",
  answered: "答了、等下一夜判",
  resolved: "判过了",
  declined: "说了别问这个",
  retired: "跳过两次退下了",
  expired: "过期了",
  obsolete: "不用问了",
};

const COLUMNS = [
  "id",
  "key",
  "topic",
  "kind",
  "sources",
  "text",
  "why",
  "targets",
  "answers",
  "domains",
  "scenes",
  "terms",
  "probe_id",
  "priority",
  "priority_detail",
  "status",
  "asked_count",
  "skipped_count",
  "last_asked_at",
  "answer_evidence_id",
  "verdict",
  "clear",
  "answered_at",
  "applied_at",
  "before_state",
  "outcome",
  "created_at",
  "expires_at",
  "closed_at",
] as const;

function toRow(q: Question): (string | number | null)[] {
  return [
    q.id,
    q.key,
    q.topic,
    q.kind,
    json(q.sources),
    q.text,
    q.why,
    json(q.targets),
    json(q.answers),
    json(q.domains),
    json(q.scenes),
    json(q.terms),
    q.probeId,
    q.priority,
    json(q.priorityDetail),
    q.status,
    q.askedCount,
    q.skippedCount,
    q.lastAskedAt,
    q.answerEvidenceId,
    q.verdict,
    q.clear ? 1 : 0,
    q.answeredAt,
    q.appliedAt,
    q.before === null ? null : json(q.before),
    q.outcome,
    q.createdAt,
    q.expiresAt,
    q.closedAt,
  ];
}

function fromRow(r: Record<string, unknown>): Question {
  return {
    id: String(r.id),
    key: String(r.key),
    topic: String(r.topic),
    kind: r.kind as QuestionSource,
    sources: parse<QuestionSource[]>(r.sources),
    text: String(r.text),
    why: String(r.why),
    targets: parse<QuestionTarget[]>(r.targets),
    answers: parse<QuestionAnswers>(r.answers),
    domains: parse<string[]>(r.domains),
    scenes: parse<string[]>(r.scenes),
    terms: parse<string[]>(r.terms),
    probeId: str(r.probe_id),
    priority: Number(r.priority),
    priorityDetail: parse<PriorityDetail>(r.priority_detail),
    status: r.status as QuestionStatus,
    askedCount: Number(r.asked_count),
    skippedCount: Number(r.skipped_count),
    lastAskedAt: str(r.last_asked_at),
    answerEvidenceId: str(r.answer_evidence_id),
    verdict: str(r.verdict) as AnswerVerdict | null,
    clear: Number(r.clear) === 1,
    answeredAt: str(r.answered_at),
    appliedAt: str(r.applied_at),
    before: r.before_state === null || r.before_state === undefined ? null : parse<Question["before"]>(r.before_state),
    outcome: str(r.outcome),
    createdAt: String(r.created_at),
    expiresAt: String(r.expires_at),
    closedAt: str(r.closed_at),
  };
}

/** 优先级 = 回答能不能分出胜负 × 分数接近的程度 × 常不常遇到 × 还没问过（207 号票） */
export function questionPriority(d: PriorityDetail): number {
  return round3(d.separation * d.closeness * d.frequency * d.fresh);
}

// ---------- 回答怎么读（规则版） ----------

/** 含糊的说法：有它又没有加重的词，就是"说不好" */
const HEDGES: readonly string[] = ["不知道", "说不好", "说不准", "看情况", "不一定", "可能", "也许", "大概", "或许", "难说", "都有", "差不多", "看心情", "不清楚", "不好说"];
/** 加重的词：有它就算回答得很明确 */
const EMPHASIS: readonly string[] = ["确实", "当然", "肯定", "完全", "根本", "一点都", "一点也", "绝对", "压根", "从来", "没错", "就是这样", "的确", "真的", "不可能"];
/** 没表态的垫话（"还好，……"）：拿掉以后什么都不剩的那一句跳过 */
const FILLERS: readonly string[] = ["还好", "还行", "一般", "哈哈", "这个嘛", "怎么说呢", "吧", "啊", "呀", "呢", "嘛", "…"];
/** 带"不、没"却是肯定的说法（先拿掉再找否定） */
const AFFIRM_WITH_NEGATION: readonly string[] = ["没错", "不错", "没问题", "可不是", "不就是", "不少"];
const NEGATION = /[不没别]|并非|未曾/;
const AFFIRM = /[是会对嗯有要行好去愿]|可以|确实|当然|肯定|没错|的确|挺|特别|非常|很/;

/**
 * 读用户对了解你问题的回答：是、不是、说不好；有没有说得很明确。规则版：逐句找第一句表了态的（"还好，……"这种没表态的跳过），
 * 有否定词是"不是"，有肯定词是"是"；有"确实、一点都不、当然"这类加重的算明确；有"可能、看情况、不知道"又没加重的算说不好。
 * 认不出的算说不好（不猜）。
 */
export function classifyAnswer(text: string): { verdict: AnswerVerdict; clear: boolean; cue: string } {
  const clauses = text
    .split(/[，,。！!？?；;、\s]+/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  const emphasis = EMPHASIS.find((w) => text.includes(w));
  const hedge = HEDGES.find((w) => text.includes(w));
  if (hedge && !emphasis) return { verdict: "unclear", clear: false, cue: hedge };
  for (const clause of clauses) {
    let plain = clause;
    for (const w of FILLERS) plain = plain.replaceAll(w, "");
    if (plain.length === 0) continue;
    for (const w of AFFIRM_WITH_NEGATION) plain = plain.replaceAll(w, "是");
    if (NEGATION.test(plain)) return { verdict: "no", clear: emphasis !== undefined, cue: clause };
    if (AFFIRM.test(plain)) return { verdict: "yes", clear: emphasis !== undefined, cue: clause };
  }
  return { verdict: "unclear", clear: false, cue: "" };
}

// ---------- 用户的下一句是不是在答这个问题（264 号票） ----------

/** "别问这个"的说法：这一类以后不再问。"别问为什么，反正……"这类不算 */
const DECLINE_PHRASES: readonly string[] = ["别问这个", "别问这种", "别问这些", "别问了", "别再问", "不要问这个", "不要再问", "不要问了", "以后别问", "这个别问", "这种别问", "这些别问", "不想被问", "别打听"];
/** 跳过的说法 */
const SKIP_PHRASES: readonly string[] = ["跳过", "略过", "pass", "不想答", "不想回答", "不回答", "不想说", "不方便说", "不方便回答", "不告诉你", "保密", "无可奉告", "下一个", "不聊这个", "换个话题", "先不说这个", "先不说了", "不说这个"];
/** 一两个字就能答的（对、是的、没有、会……）：短短一句只有它的算回答 */
const SHORT_ANSWERS: ReadonlySet<string> = new Set(["对", "是", "对的", "是的", "没错", "不是", "没有", "不对", "当然", "确实", "肯定", "并没有", "当然不", "肯定不", "会", "不会", "要", "不要", "有", "没"]);
/** 短句里去掉的语气字 */
const PARTICLES = /[啊呀吧呢嘛哦哈的了嗯哇噢喔诶欸嘿么啦咯]/g;
/** 短句里去掉否定字以后剩下的字都出现在问题里：接着问题的话头答（会去吗 → 去 / 不去） */
const NEGATORS = /[不没别]/g;
/** 短句最多几个字（去掉语气字以后） */
const SHORT_MAX = 4;
/** 跟秘书提要求的说法：这样的分句是在说新的事，不当成回答 */
const REQUEST_MARKERS: readonly string[] = ["帮我", "给我", "替我", "提醒我", "麻烦你", "麻烦帮", "请你", "你帮", "能不能帮", "帮忙"];
/** 两边都常有、说明不了"说到同一件事"的两字词 */
const COMMON_PAIRS: ReadonlySet<string> = new Set([
  "这个",
  "那个",
  "什么",
  "是不",
  "不是",
  "一下",
  "你会",
  "我会",
  "会不",
  "不会",
  "有没",
  "没有",
  "如果",
  "要是",
  "的话",
  "可以",
  "怎么",
  "时候",
  "一点",
  "就是",
  "还是",
  "或者",
  "但是",
  "因为",
  "所以",
  "这样",
  "那样",
  "一个",
  "一些",
  "这些",
  "那些",
  "要不",
  "不要",
  "是的",
  "我们",
  "你们",
]);
/** 一段话里的汉字两字词（相邻的两个汉字；中间隔着标点、字母的不算） */
function cjkPairs(text: string): Set<string> {
  const out = new Set<string>();
  const chars = [...text];
  for (let i = 0; i + 1 < chars.length; i += 1) {
    const pair = chars[i]! + chars[i + 1]!;
    if (/^\p{Script=Han}{2}$/u.test(pair) && !COMMON_PAIRS.has(pair)) out.add(pair);
  }
  return out;
}

/** 这一分句接着问题的话头短短答了一句（会、不去、是的、对……）：返回那几个字，不是是 undefined */
function echoAnswer(clause: string, question: string): string | undefined {
  const core = clause.replace(PARTICLES, "").trim();
  if (core.length === 0 || [...core].length > SHORT_MAX) return undefined;
  if (SHORT_ANSWERS.has(core)) return core;
  const rest = core.replace(NEGATORS, "");
  return rest.length > 0 && [...rest].every((c) => question.includes(c)) ? core : undefined;
}

/**
 * 用户在秘书顺口问了以后的下一句：是在回答这个问题、跳过、说"别问这个"，还是在说别的。规则版，不调模型：
 * - 有"别问这个、这个别问了、以后别再问"是别问这个；有"跳过、不想说、先不说这个"是跳过；
 * - 逐个分句看是不是说到了这个问题：短短一句接着问题的话头答（会 / 不去 / 是的 / 对），或者和问题有两个以上相同的两字词，
 *   或者说到了问题的说法（检索短语、活动名，两个字以上的）；跟秘书提要求的分句（帮我……、提醒我……）不算。说到了的那几个分句
 *   按 classifyAnswer 读成是 / 不是 / 说不好；
 * - 整句很短、只是"看情况、说不好"的，也是回答（说不好）；
 * - 别的都算在说别的（不当回答）。宁可漏认：漏认的回答照样存成素材、下一夜读成证据，问题到第二天算跳过一次；错认会把别的话
 *   当成对这个问题的表态。
 */
export function classifyReply(question: Pick<Question, "text" | "terms">, reply: string): ReplyReading {
  const text = reply.trim();
  const lower = text.toLowerCase();
  const decline = DECLINE_PHRASES.find((p) => text.includes(p));
  if (decline) return { kind: "decline", cue: decline, why: `说了"${decline}"：这一类以后不再问` };
  const skip = SKIP_PHRASES.find((p) => lower.includes(p));
  if (skip) return { kind: "skip", cue: skip, why: `说了"${skip}"：跳过这个问题` };
  const clauses = text
    .split(/[，,。！!？?；;\n]+/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  const asked = cjkPairs(question.text);
  const terms = question.terms.filter((term) => [...term].length >= 2);
  const relevant: { clause: string; cue: string }[] = [];
  for (const clause of clauses) {
    const echo = echoAnswer(clause, question.text);
    if (echo !== undefined) {
      relevant.push({ clause, cue: echo });
      continue;
    }
    if (REQUEST_MARKERS.some((m) => clause.includes(m))) continue;
    const shared = [...cjkPairs(clause)].filter((pair) => asked.has(pair));
    const term = terms.find((t) => clause.includes(t));
    if (shared.length >= 2 || term !== undefined) relevant.push({ clause, cue: term ?? shared.join("、") });
  }
  if (relevant.length > 0) {
    const read = classifyAnswer(relevant.map((r) => r.clause).join("，"));
    const on = relevant.map((r) => r.cue).join("；");
    return { kind: "answer", verdict: read.verdict, clear: read.clear, cue: read.cue || on, why: `说到了问题里的事（${on}），读成"${VERDICT_LABEL[read.verdict]}"${read.clear ? "，说得很明确" : ""}` };
  }
  const hedge = HEDGES.find((w) => text.includes(w));
  if (hedge && [...text.replace(PARTICLES, "")].length <= 8) return { kind: "answer", verdict: "unclear", clear: false, cue: hedge, why: `只说了"${hedge}"：回答了，但说不好` };
  return { kind: "unrelated", cue: "", why: "没说到问题里的事，像是在说别的，不当成回答" };
}

/** 只留给了的 actor / via（不给的跟外面那一次写、或者按写操作的默认） */
function writeBy(by: QuestionWriteBy): QuestionWriteBy {
  return { ...(by.actor === undefined ? {} : { actor: by.actor }), ...(by.via === undefined ? {} : { via: by.via }) };
}

// ---------- 问题箱 ----------

export class QuestionBook implements QuestionSink {
  private readonly engine: MemoryEngine;
  readonly expiryDays: number;
  readonly cooldownDays: number;

  constructor(engine: MemoryEngine, options: QuestionBookOptions = {}) {
    this.engine = engine;
    this.expiryDays = options.expiryDays ?? 30;
    this.cooldownDays = options.cooldownDays ?? 30;
  }

  private get store() {
    return this.engine.store;
  }

  /** 267 号票：写推理图谱经唯一写入口 */
  private get w(): RgWriter {
    return rgWriter(this.engine.store);
  }

  private get db() {
    return this.engine.store.db;
  }

  /**
   * 267 号票：问题箱的每一次改动也经唯一写入口（264 号票顺口问接进线上以后一并收进来）——开一次写，说清谁写、做什么、经谁转达；
   * 下面 insert / save / log / 挡住一类都向写入口报一声（noteQuestion），留痕记一行。只读的引擎（秘书那一份）开不了写，改不了问题箱
   */
  private session<T>(intent: WriteIntent, fn: () => T): T {
    return this.engine.gate.write(intent, fn);
  }

  /** 这个问题的依据（留痕用）：要弄清的结论、事实，回答的证据 */
  private basisOf(q: Question): string[] {
    return [...q.targets.map((t) => t.id), ...(q.answerEvidenceId === null ? [] : [q.answerEvidenceId])];
  }

  // ---------- 读写 ----------

  get(id: string): Question | undefined {
    const row = this.db.get(`SELECT * FROM questions WHERE id = ?`, id);
    return row && fromRow(row);
  }

  /** 问题，按优先级从高到低（一样的按先后）；可按状态过滤 */
  listRaw(filter: { status?: QuestionStatus | readonly QuestionStatus[] } = {}): Question[] {
    const statuses = filter.status === undefined ? undefined : typeof filter.status === "string" ? [filter.status] : filter.status;
    const rows = statuses
      ? this.db.all(`SELECT * FROM questions WHERE status IN (${statuses.map(() => "?").join(", ")}) ORDER BY priority DESC, rowid`, ...statuses)
      : this.db.all("SELECT * FROM questions ORDER BY priority DESC, rowid");
    return rows.map(fromRow);
  }

  /** 记忆页看的问题（目标带现在的状态，加上经过） */
  list(filter: { status?: QuestionStatus | readonly QuestionStatus[] } = {}): QuestionView[] {
    return this.listRaw(filter).map((q) => this.view(q));
  }

  view(q: Question): QuestionView {
    return {
      ...q,
      targets: q.targets.map((t) => ({ ...t, status: this.targetStatus(t) })),
      history: this.history(q.id),
    };
  }

  history(questionId: string): QuestionLogEntry[] {
    return this.db.all("SELECT * FROM question_log WHERE question_id = ? ORDER BY seq", questionId).map((r) => ({
      seq: Number(r.seq),
      event: r.event as QuestionEvent,
      detail: String(r.detail),
      evidenceId: str(r.evidence_id),
      at: String(r.at),
    }));
  }

  private targetStatus(t: QuestionTarget): string {
    if (t.kind === "strategy") return this.store.getStrategy(t.id)?.status ?? "没有了";
    if (t.kind === "claim") {
      const c = this.store.getClaim(t.id);
      return c ? `${claimStatusLabel(c.status)}（${c.confidence}）` : "没有了";
    }
    return this.store.getFact(t.id)?.status ?? "没有了";
  }

  private nextId(): string {
    let n = Number(this.db.get<{ value: number }>("SELECT value FROM counters WHERE name = 'question'")?.value ?? 0);
    let id: string;
    do {
      n += 1;
      id = `qu-${String(n).padStart(4, "0")}`;
    } while (this.db.get("SELECT 1 AS found FROM questions WHERE id = ?", id));
    this.db.run("INSERT INTO counters (name, value) VALUES ('question', ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value", n);
    return id;
  }

  private insert(q: Question): void {
    this.engine.gate.noteQuestion(q.id, this.basisOf(q));
    this.db.run(`INSERT INTO questions (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})`, ...toRow(q));
  }

  private save(q: Question): void {
    this.engine.gate.noteQuestion(q.id, this.basisOf(q));
    this.db.run(`UPDATE questions SET ${COLUMNS.slice(1).map((c) => `${c} = ?`).join(", ")} WHERE id = ?`, ...toRow(q).slice(1), q.id);
  }

  private log(questionId: string, event: QuestionEvent, detail: string, at: string, evidenceId: string | null = null): void {
    this.engine.gate.noteQuestion(questionId, evidenceId === null ? [] : [evidenceId]);
    this.db.run("INSERT INTO question_log (question_id, event, detail, evidence_id, at) VALUES (?, ?, ?, ?, ?)", questionId, event, detail, evidenceId, at);
  }

  private close(q: Question, status: QuestionStatus, at: string, event: QuestionEvent, detail: string, evidenceId: string | null = null): Question {
    const next: Question = { ...q, status, closedAt: at };
    this.save(next);
    this.log(q.id, event, detail, at, evidenceId);
    return next;
  }

  /** "别问这个"挡住了这一类 */
  isBlocked(topic: string): boolean {
    return this.db.get("SELECT 1 AS found FROM question_blocks WHERE topic = ?", topic) !== undefined;
  }

  blocks(): { topic: string; questionId: string; reason: string; evidenceId: string | null; at: string }[] {
    return this.db.all("SELECT * FROM question_blocks ORDER BY rowid").map((r) => ({ topic: String(r.topic), questionId: String(r.question_id), reason: String(r.reason), evidenceId: str(r.evidence_id), at: String(r.at) }));
  }

  // ---------- 每夜更新问题箱 ----------

  /**
   * 交来这一夜的草稿：开着的同 key 问题更新问法、判法和优先级；新的建上（挡住的、退下的、冷却中的、刚答过那条假设的不建）；
   * 开着的问题这次没有草稿了（要弄清的已经有结果、或者依据变了）标"不用问了"。
   */
  refresh(drafts: readonly QuestionDraft[], at: string): RefreshReport {
    return this.session({ op: "question", reason: "每晚整理更新问题箱" }, () => {
      const report: RefreshReport = { added: [], updated: [], obsolete: [], skipped: [] };
      const keys = new Set(drafts.map((d) => d.key));
      const cooldownFrom = toMs(addDays(at, -this.cooldownDays));
      const answeredClaims = this.recentlyAnsweredClaims(cooldownFrom);
      for (const q of this.listRaw({ status: ["open", "asked"] })) {
        if (!keys.has(q.key)) {
          report.obsolete.push(this.close(q, "obsolete", at, "obsolete", `不用问了：${this.targetsNow(q)}`));
          continue;
        }
        const answered = q.targets.find((t) => t.kind === "claim" && answeredClaims.has(t.id));
        if (answered) report.obsolete.push(this.close(q, "obsolete", at, "obsolete", `不用问了：${answeredClaims.get(answered.id)} 刚问过 ${answered.id}，${this.cooldownDays} 天内不再就它发问`));
      }
      const all = this.listRaw();
      const recentlyAnswered = new Set(answeredClaims.keys());
      for (const d of drafts) {
        const r = this.upsert(d, at, all, cooldownFrom, recentlyAnswered, `整理时生成（${d.sources.join("、")}）`);
        if (r.added) report.added.push(r.added);
        if (r.updated) report.updated.push(r.updated);
        if (r.skipped) report.skipped.push({ key: d.key, reason: r.skipped });
      }
      return report;
    });
  }

  /** 刚回答过的问题问的是哪几条假设（断言 → 问题 id）：冷却期里不再就它们发问 */
  private recentlyAnsweredClaims(cooldownFrom: number): Map<string, string> {
    const answeredClaims = new Map<string, string>();
    for (const q of this.listRaw()) {
      if (q.answeredAt === null || toMs(q.answeredAt) < cooldownFrom) continue;
      for (const t of q.targets) if (t.kind === "claim" && !answeredClaims.has(t.id)) answeredClaims.set(t.id, q.id);
    }
    return answeredClaims;
  }

  /** 一个草稿进箱：开着的同 key 问题更新问法、判法和优先级（跳过过的照旧减半）；新的建上（挡住的、退下的、冷却中的、刚答过那条假设的不建） */
  private upsert(
    d: QuestionDraft,
    at: string,
    all: readonly Question[],
    cooldownFrom: number,
    recentlyAnswered: ReadonlySet<string>,
    how: string,
  ): { added?: Question; updated?: Question; skipped?: string } {
    const same = all.filter((q) => q.key === d.key);
    const open = same.find((q) => q.status === "open" || q.status === "asked");
    const detail = (fresh: number): PriorityDetail => ({ separation: d.separation, closeness: d.closeness, frequency: d.frequency, fresh });
    if (open) {
      const priorityDetail = detail(0.5 ** open.skippedCount);
      const next: Question = {
        ...open,
        sources: d.sources,
        text: d.text,
        why: d.why,
        targets: d.targets,
        answers: d.answers,
        domains: d.domains,
        scenes: d.scenes,
        terms: d.terms,
        priorityDetail,
        priority: questionPriority(priorityDetail),
      };
      this.save(next);
      return { updated: next };
    }
    const reason = this.blockReason(d, same, cooldownFrom, recentlyAnswered);
    if (reason) return { skipped: reason };
    const priorityDetail = detail(1);
    const expiry = addDays(at, this.expiryDays);
    const expiresAt = d.validUntil !== null && toMs(d.validUntil) > toMs(at) && toMs(d.validUntil) < toMs(expiry) ? d.validUntil : expiry;
    const q: Question = {
      id: this.nextId(),
      key: d.key,
      topic: d.topic,
      kind: d.kind,
      sources: d.sources,
      text: d.text,
      why: d.why,
      targets: d.targets,
      answers: d.answers,
      domains: d.domains,
      scenes: d.scenes,
      terms: d.terms,
      probeId: d.probeId,
      priority: questionPriority(priorityDetail),
      priorityDetail,
      status: "open",
      askedCount: 0,
      skippedCount: 0,
      lastAskedAt: null,
      answerEvidenceId: null,
      verdict: null,
      clear: false,
      answeredAt: null,
      appliedAt: null,
      before: null,
      outcome: null,
      createdAt: at,
      expiresAt,
      closedAt: null,
    };
    this.insert(q);
    this.log(q.id, "created", how, at);
    return { added: q };
  }

  // ---------- 199 联动交来的问题（QuestionSink，207 号票） ----------

  /**
   * 交来一个草稿（不碰别的问题）：同 key 开着的更新，新的建上；挡住的、退下的、冷却中的、刚答过那条假设的不建，返回原因。
   * 每夜 refresh 照样从推理图谱出同一个 key 的草稿，对得上就只是更新。
   */
  offer(draft: QuestionDraft, at: string, how = "整理时由知识图谱联动交来"): { question?: Question; skipped?: string } {
    return this.session({ op: "question", reason: how }, () => {
      const cooldownFrom = toMs(addDays(at, -this.cooldownDays));
      const r = this.upsert(draft, at, this.listRaw(), cooldownFrom, new Set(this.recentlyAnsweredClaims(cooldownFrom).keys()), how);
      return r.skipped ? { skipped: r.skipped } : { question: r.added ?? r.updated };
    });
  }

  /** QuestionSink：联动的组分不出时交来的问题进箱 */
  onQuestion(question: KnowYouQuestion): void {
    this.offer(question.draft, question.createdAt, `整理时由知识图谱联动交来（${question.kind === "conflict_root" ? "矛盾根源" : "对比模式"}查不清）`);
  }

  /** QuestionSink：那一组分出来了（或者撤回了、这条追问的两边有一条不在了），还开着的这个问题标"不用问了" */
  onClosed(key: string, at: string, why: string): void {
    const open = this.listRaw({ status: ["open", "asked"] }).filter((q) => q.key === key);
    if (open.length === 0) return;
    this.session({ op: "question", reason: `不用问了：${why}` }, () => {
      for (const q of open) this.close(q, "obsolete", at, "obsolete", `不用问了：${why}`);
    });
  }

  private blockReason(d: QuestionDraft, same: readonly Question[], cooldownFrom: number, recentlyAnswered: ReadonlySet<string>): string | undefined {
    if (this.isBlocked(d.topic)) return `这一类用户说了别问（${d.topic}）`;
    if (same.some((q) => q.status === "declined")) return "用户说了别问这个";
    if (same.some((q) => q.status === "retired")) return "跳过两次退下了，不再问";
    const cooling = same.find((q) => (q.status === "answered" || q.status === "resolved" || q.status === "expired") && toMs(q.closedAt ?? q.answeredAt ?? q.createdAt) >= cooldownFrom);
    if (cooling) return `${cooling.id} ${STATUS_TEXT[cooling.status]}，${this.cooldownDays} 天内不再问`;
    const answered = d.targets.find((t) => t.kind === "claim" && recentlyAnswered.has(t.id));
    if (answered) return `刚回答过关于 ${answered.id} 的问题，${this.cooldownDays} 天内不再就它发问`;
    return undefined;
  }

  /** 目标现在的状态（一句话） */
  private targetsNow(q: Question): string {
    return q.targets.map((t) => `${t.id} ${this.targetStatus(t)}`).join("，");
  }

  /** 过了过期时间还没答的标过期 */
  expire(at: string): Question[] {
    const due = this.listRaw({ status: ["open", "asked"] }).filter((q) => toMs(q.expiresAt) <= toMs(at));
    if (due.length === 0) return [];
    return this.session({ op: "question", reason: "问题到期没问到（或者没答），过期" }, () => due.map((q) => this.close(q, "expired", at, "expired", `到 ${q.expiresAt} 还没问到（或者没答），过期`)));
  }

  /**
   * 彻底删除（234 号票）：要弄清的目标（断言、事实）被删了或者转成待复核了，开着的相关问题标过期，
   * 以后不再问（和到时间过期同一个状态；日志里写明是因为依据被删）
   */
  expireForTargets(targets: { claimIds?: readonly string[]; factIds?: readonly string[] }, at: string, reason: string): Question[] {
    const claims = new Set(targets.claimIds ?? []);
    const facts = new Set(targets.factIds ?? []);
    if (claims.size === 0 && facts.size === 0) return [];
    const due = this.listRaw({ status: ["open", "asked"] }).filter((q) => q.targets.some((t) => (t.kind === "claim" ? claims.has(t.id) : facts.has(t.id))));
    if (due.length === 0) return [];
    return this.session({ op: "question", reason }, () => due.map((q) => this.close(q, "expired", at, "expired", reason)));
  }

  /** 问了没答、已经不是同一天了：算跳过一次（跳过两次退下） */
  settleUnanswered(at: string, by: QuestionWriteBy = {}): { skipped: Question[]; retired: Question[] } {
    const out = { skipped: [] as Question[], retired: [] as Question[] };
    const due = this.listRaw({ status: "asked" }).filter((q) => !(q.lastAskedAt === null || sameLocalDay(at, q.lastAskedAt) || toMs(q.lastAskedAt) > toMs(at)));
    if (due.length === 0) return out;
    // 267 号票：经写入口（跳过两次退下时那条回避信号也是在这一次写里入库的）；整理时是夜班，挑问题时是挑的那一方
    return this.session({ op: "skip", ...writeBy(by), reason: "问了以后到第二天还没回答，算跳过一次" }, () => {
      for (const q of due) {
        const r = this.skip(q, at, "问了以后到第二天还没回答，算跳过一次");
        (r.question.status === "retired" ? out.retired : out.skipped).push(r.question);
      }
      return out;
    });
  }

  // ---------- 顺口问 ----------

  /** 这一轮要不要顺口问、问哪个（问了就记下"问过"）；不问时写明为什么 */
  pick(conversationText: string, options: PickOptions = {}): PickResult {
    const at = options.at ?? this.store.now();
    // 267 号票：挑的那一方（不给是记忆管理员——ADR-0030 白天提顺口问归它），记跳过、记"问过"都按它留痕
    const by: QuestionWriteBy = { actor: options.actor ?? "curator", ...(options.via === undefined ? {} : { via: options.via }) };
    return this.store.transaction(() => {
      if (options.settle !== false) this.settleUnanswered(at, by);
      const none = (reason: PickReason, detail: string, considered: PickResult["considered"] = []): PickResult => ({ ask: false, reason, detail, considered });
      const urgentWord = URGENT_WORDS.find((w) => conversationText.includes(w));
      if (options.urgent || urgentWord) return none("urgent", `这一轮是急事${urgentWord ? `（"${urgentWord}"）` : ""}，不问`);
      if (options.awaitingDecision) return none("awaiting_decision", "这一轮在等你做决定，不问");
      const today = this.db
        .all("SELECT question_id, at FROM question_log WHERE event = 'asked' ORDER BY seq DESC")
        .find((r) => sameLocalDay(at, String(r.at)) && toMs(String(r.at)) <= toMs(at));
      if (today) return none("asked_today", `今天（${localDate(at)}）已经问过 ${String(today.question_id)} 了，每天最多一个`);
      const candidates = this.listRaw({ status: "open" }).filter((q) => toMs(q.expiresAt) > toMs(at) && !this.isBlocked(q.topic) && this.stillAskable(q));
      if (candidates.length === 0) return none("empty", "问题箱里没有能问的");
      const tags = [...new Set([...tagsInText(conversationText), ...(options.context ?? [])])];
      const domains: readonly string[] = taskDomains(conversationText, options.context ?? []);
      const considered: PickResult["considered"] = [];
      const matched: { q: Question; shared: string[]; terms: string[] }[] = [];
      for (const q of candidates) {
        if (!contextsCompatible(q.scenes, tags)) {
          considered.push({ questionId: q.id, matched: false, why: `场景对不上（问题是 ${q.scenes.join("、") || "不限"}，这一轮是 ${tags.join("、")}）` });
          continue;
        }
        const shared = q.domains.filter((d) => domains.includes(d));
        const terms = q.terms.filter((t) => conversationText.includes(t));
        if (shared.length === 0 && terms.length === 0) {
          considered.push({ questionId: q.id, matched: false, why: `话题对不上（问题是 ${domainLabels(q.domains) || "没有领域"}，这一轮是 ${domainLabels(domains) || "认不出领域"}）` });
          continue;
        }
        considered.push({ questionId: q.id, matched: true, why: `对上了：${[domainLabels(shared), terms.join("、")].filter((s) => s.length > 0).join("；")}` });
        matched.push({ q, shared, terms });
      }
      if (matched.length === 0) return none("no_match", `话题对不上，${candidates.length} 个问题留在问题箱里`, considered);
      const best = matched.toSorted((a, b) => b.q.priority - a.q.priority || b.shared.length + b.terms.length - (a.shared.length + a.terms.length))[0]!;
      const on = [domainLabels(best.shared), best.terms.join("、")].filter((s) => s.length > 0).join("；");
      // 只看不记（264 号票）：线上等秘书真的在回话里带上了再 markAsked
      const chosen = options.peek ? best.q : this.session({ op: "ask", ...by, reason: `顺口问（话题对上了：${on}）` }, () => this.saveAsked(best.q, at, `顺口问（话题对上了：${on}）`));
      return {
        ask: true,
        reason: "matched",
        detail: `话题对上了（${on}），这一轮不急、没在等你做决定，今天还没问过；挑了优先级最高的 ${chosen.id}（${chosen.priority}）：${chosen.why}`,
        question: this.view(chosen),
        text: `顺便问一句：${chosen.text}${WOVEN_TAIL}`,
        matchedOn: on,
        considered,
      };
    });
  }

  /** 记"问过"：状态 asked、问过几次加一、最近一次问的时间，经过里写一笔 */
  private saveAsked(q: Question, at: string, how: string): Question {
    const asked: Question = { ...q, status: "asked", askedCount: q.askedCount + 1, lastAskedAt: at };
    this.save(asked);
    this.log(asked.id, "asked", how, at);
    return asked;
  }

  /**
   * 秘书真的在回话里带上了这个问题（264 号票：peek 挑出来的那个）：记"问过"。只有还在问题箱里（open）的能记；
   * 记了以后同一天不再挑（每天最多一个按"问过"算）
   */
  markAsked(questionId: string, options: { at?: string; how?: string } & QuestionWriteBy = {}): QuestionView {
    const at = options.at ?? this.store.now();
    const q = this.get(questionId);
    if (!q) throw new Error(`没有这个问题：${questionId}`);
    if (q.status !== "open") throw new Error(`问题 ${questionId} ${STATUS_TEXT[q.status]}，不是在问题箱里，记不了问过`);
    const how = options.how ?? "顺口问";
    return this.session({ op: "ask", ...writeBy(options), reason: how }, () => this.view(this.saveAsked(q, at, how)));
  }

  /** 按这个问题读用户的下一句（264 号票，classifyReply）：在答、跳过、别问这个，还是在说别的 */
  readReply(questionId: string, reply: string): ReplyReading {
    const q = this.get(questionId);
    if (!q) throw new Error(`没有这个问题：${questionId}`);
    return classifyReply(q, reply);
  }

  /** 目标还在、没有待复核的（待复核的等下一夜重判完再问） */
  private stillAskable(q: Question): boolean {
    return q.targets.every((t) => {
      if (t.kind === "strategy") {
        const s = this.store.getStrategy(t.id);
        return s !== undefined && (s.status === "active" || s.status === "paused");
      }
      if (t.kind === "fact") {
        const f = this.store.getFact(t.id);
        return f !== undefined && (HELD_STATUSES as readonly string[]).includes(f.status);
      }
      const c = this.store.getClaim(t.id);
      return c !== undefined && (c.status === "active" || c.status === "contested");
    });
  }

  // ---------- 跳过、别问这个 ----------

  /** 用户没接这个问题（问了没答）：跳过一次；两次就退下，记一条回避信号 */
  recordSkip(questionId: string, options: { at?: string } & QuestionWriteBy = {}): SkipRecord {
    const at = options.at ?? this.store.now();
    const q = this.get(questionId);
    if (!q) throw new Error(`没有这个问题：${questionId}`);
    if (q.status !== "asked") throw new Error(`问题 ${questionId} ${STATUS_TEXT[q.status]}，不是在等回答，谈不上跳过`);
    // 267 号票：用户的表态（他不接这个问题）
    return this.session({ op: "skip", actor: options.actor ?? "user_verdict", ...(options.via === undefined ? {} : { via: options.via }), reason: `用户没接了解你问题 ${q.id}` }, () => this.skip(q, at, "用户没接这个问题"));
  }

  private skip(q: Question, at: string, why: string): SkipRecord {
    const skippedCount = q.skippedCount + 1;
    if (skippedCount < 2) {
      const next: Question = { ...q, status: "open", skippedCount, priorityDetail: { ...q.priorityDetail, fresh: 0.5 ** skippedCount } };
      next.priority = questionPriority(next.priorityDetail);
      this.save(next);
      this.log(q.id, "skipped", `${why}（第 ${skippedCount} 次）`, at);
      return { question: this.view(next), avoidanceEvidenceId: null };
    }
    // 回避信号：系统观察到的（同二狗"提问卡长期没处理"那一类，来源是系统），不当关于用户的依据
    const signal = this.engine.ingestEvidence({
      sourceLevel: "system",
      mode: "do",
      kind: "action",
      text: `用户两次没有接了解你问题 ${q.id} 的话，以后不再问`,
      context: ["avoidance", "question"],
      eventTime: at,
      observedAt: at,
      sourceRef: `question:${q.id}`,
    });
    const next: Question = { ...q, status: "retired", skippedCount, closedAt: at };
    this.save(next);
    this.log(q.id, "skipped", `${why}（第 ${skippedCount} 次）`, at);
    this.log(q.id, "retired", `跳过两次，不再问；记了一条回避信号 ${signal.id}`, at, signal.id);
    return { question: this.view(next), avoidanceEvidenceId: signal.id };
  }

  /** 用户说"别问这个"：这一类（同一组假设、同一样东西）都不再问，开着的一起关掉 */
  decline(questionId: string, options: { at?: string; evidence?: EvidenceDraft | string } & QuestionWriteBy = {}): Question {
    const at = options.at ?? this.store.now();
    const q = this.get(questionId);
    if (!q) throw new Error(`没有这个问题：${questionId}`);
    if (q.status !== "open" && q.status !== "asked") throw new Error(`问题 ${questionId} ${STATUS_TEXT[q.status]}，不用再关`);
    // 267 号票："别问这个"只由用户发起（写入口认 actor 是用户）
    return this.session({ op: "decline", ...writeBy(options), reason: `用户说别问这个（${q.id}，这一类：${q.topic}）` }, () => {
      const evidence = options.evidence === undefined ? undefined : this.resolveEvidence(options.evidence);
      const evidenceId = evidence?.id ?? null;
      this.engine.gate.noteQuestion(q.id, evidenceId === null ? [] : [evidenceId]);
      this.db.run("INSERT OR IGNORE INTO question_blocks (topic, question_id, reason, evidence_id, at) VALUES (?, ?, ?, ?, ?)", q.topic, q.id, "用户说别问这个", evidenceId, at);
      const closed = this.close(q, "declined", at, "declined", `用户说别问这个；这一类（${q.topic}）都不再问`, evidenceId);
      for (const other of this.listRaw({ status: ["open", "asked"] })) {
        if (other.id !== q.id && other.topic === q.topic) this.close(other, "declined", at, "declined", `同一类的 ${q.id} 用户说了别问这个`, evidenceId);
      }
      return closed;
    });
  }

  // ---------- 每晚整理时判回答（271 号票，rg/reply-judge.ts） ----------

  /**
   * 记忆管理员夜里看了问过以后用户说的话，判成没在答：算跳过一次（跳过两次退下、记回避信号），照 198 的"问了没答"。
   * 夜班写，经谁转达写进留痕（via）
   */
  recordNightSkip(questionId: string, options: { at?: string; why: string; via?: string }): SkipRecord {
    const at = options.at ?? this.store.now();
    const q = this.get(questionId);
    if (!q) throw new Error(`没有这个问题：${questionId}`);
    if (q.status !== "asked") throw new Error(`问题 ${questionId} ${STATUS_TEXT[q.status]}，不是在等回答，谈不上跳过`);
    return this.session({ op: "skip", actor: "nightly", ...(options.via === undefined ? {} : { via: options.via }), reason: options.why }, () => this.skip(q, at, options.why));
  }

  /**
   * 记忆管理员夜里拿不准用户有没有在答：问题还等回答（asked），经过里记一笔 unsure（evidenceId 是这一夜看到的最后一句话的证据），
   * 下一夜再看（unsureState 数第几夜、上一夜看到哪一句为止）
   */
  recordUnsure(questionId: string, options: { at?: string; why: string; lastSeen: string | null; via?: string }): QuestionView {
    const at = options.at ?? this.store.now();
    const q = this.get(questionId);
    if (!q) throw new Error(`没有这个问题：${questionId}`);
    if (q.status !== "asked") throw new Error(`问题 ${questionId} ${STATUS_TEXT[q.status]}，不是在等回答`);
    return this.session({ op: "question", actor: "nightly", ...(options.via === undefined ? {} : { via: options.via }), reason: options.why }, () => {
      this.log(q.id, "unsure", options.why, at, options.lastSeen);
      return this.view(q);
    });
  }

  /** 这一次问过以后，夜里拿不准过几夜、上一夜看到哪一句为止（最近一笔 unsure 的证据） */
  unsureState(questionId: string): { nights: number; lastSeen: string | null } {
    const history = this.history(questionId);
    const since = history.findLastIndex((h) => h.event === "asked");
    const unsure = history.slice(since + 1).filter((h) => h.event === "unsure");
    return { nights: unsure.length, lastSeen: unsure.at(-1)?.evidenceId ?? null };
  }

  // ---------- 回答 ----------

  /** 交来的证据：已经入库的按 id 取；草稿就入库 */
  private resolveEvidence(evidence: EvidenceDraft | string): Evidence {
    if (typeof evidence === "string") {
      const e = this.store.getEvidence(evidence);
      if (!e) throw new Error(`没有这条证据：${evidence}`);
      return e;
    }
    if (evidence.sourceLevel !== "self") throw new Error(`只认本人的回答（这条的来源是 ${evidence.sourceLevel}）`);
    return this.engine.ingestEvidence(evidence);
  }

  /**
   * 回答回写：回答记成一条本人证据（素材里"澄清问题的回答"那一类），按"是 / 不是 / 说不好"读。
   * 回答得很明确的马上照问题里写的判法判（支持的标"你确认过"，反驳的撤回、留墓碑；矛盾、张力、反常输入另按 facts 改事实这一层）；
   * 不明确的等下一夜（applyPendingAnswers）；说不好的不判。
   */
  recordAnswer(questionId: string, evidence: EvidenceDraft | string, options: { at?: string; reading?: AnswerReading; note?: string } & QuestionWriteBy = {}): AnswerRecord {
    const at = options.at ?? this.store.now();
    const q = this.get(questionId);
    if (!q) throw new Error(`没有这个问题：${questionId}`);
    if (q.status !== "open" && q.status !== "asked") throw new Error(`问题 ${questionId} ${STATUS_TEXT[q.status]}，不能再答`);
    if (typeof evidence !== "string" && evidence.sourceLevel !== "self") throw new Error(`只认本人的回答（这条的来源是 ${evidence.sourceLevel}）`);
    // 267 号票：经写入口——用户的表态（回答证据入库、问题记"答了"、明确时马上判的确认 / 重定那组 / 改事实，都在这一次写里）
    return this.session({ op: "verdict", actor: options.actor ?? "user_verdict", ...(options.via === undefined ? {} : { via: options.via }), reason: `回答了解你问题 ${q.id}` }, () => {
      const e = this.resolveEvidence(evidence);
      if (!canSupportUserClaims(e)) throw new Error(`只认本人有效的回答（${e.id} 的来源是 ${e.sourceLevel}、状态是 ${e.status}）`);
      // 271 号票：每晚整理时记忆管理员判出来的回答交来它读出的是 / 不是（隐含的回答规则读不出来）；没交就照规则读
      const { verdict, clear } = options.reading ?? classifyAnswer(e.text);
      const answered: Question = { ...q, status: "answered", answerEvidenceId: e.id, verdict, clear, answeredAt: at, before: this.snapshot(q) };
      this.save(answered);
      const later = options.reading === undefined ? "下一夜按判法判" : "按判法判";
      this.log(q.id, "answered", `${options.note === undefined ? "" : `${options.note}；`}回答"${e.text}"：读成"${VERDICT_LABEL[verdict]}"${verdict === "unclear" ? "" : clear ? "，说得很明确，马上判" : `，不算明确，${later}`}`, at, e.id);
      if (verdict === "unclear" || !clear) {
        return { question: this.view(answered), evidenceId: e.id, verdict, clear, applied: verdict === "unclear" ? "none" : "nightly" };
      }
      const effect = q.answers[verdict];
      this.apply(answered, effect, e.id, effect.maxWeight, true, at);
      const resolved = this.resolve(answered, at, `回答得很明确，按"${VERDICT_LABEL[verdict]}"马上判（${effect.maxWeight === "decisive" ? "决定性" : "最多记弱的"}）`);
      return { question: this.view(resolved), evidenceId: e.id, verdict, clear, applied: "now" };
    });
  }

  /** 每日整理里：答了、还没判的按问题里写的判法判（不明确的最多记强的）；说不好的不判 */
  applyPendingAnswers(at: string): Question[] {
    const out: Question[] = [];
    for (const q of this.listRaw({ status: "answered" })) {
      if (q.appliedAt !== null || q.answerEvidenceId === null) continue;
      const evidence = this.store.getEvidence(q.answerEvidenceId);
      if (q.verdict === null || q.verdict === "unclear" || !evidence || !canSupportUserClaims(evidence)) {
        const why = !evidence || !canSupportUserClaims(evidence) ? "回答那句话已经不能当依据（被忘掉或纠正了），不判" : "回答没有明确偏向哪一边，不判输赢（回答照样记成本人证据）";
        out.push(this.session({ op: "question", actor: "nightly", reason: why }, () => this.resolve({ ...q, appliedAt: at }, at, why)));
        continue;
      }
      const effect = q.answers[q.verdict];
      const weight = minWeight("strong", effect.maxWeight);
      out.push(
        this.session({ op: "verdict", actor: "user_verdict", via: "每晚整理按回答判", reason: `回答了解你问题 ${q.id}` }, () => {
          const n = this.apply(q, effect, q.answerEvidenceId!, weight, false, at);
          const dup = n.already > 0 ? `；这句回答抽出的事实已经按同样的方向记过 ${n.already} 处，不重复记` : "";
          return this.resolve(q, at, `下一夜按"${VERDICT_LABEL[q.verdict!]}"判（不算明确，最多记${weight === "weak" ? "弱" : "强"}的${dup}）`);
        }),
      );
    }
    return out;
  }

  /** 目标断言现在的状态（判之前存一份） */
  private snapshot(q: Question): Question["before"] {
    const ids = new Set([...q.targets.filter((t) => t.kind === "claim").map((t) => t.id), ...q.answers.yes.supports, ...q.answers.yes.refutes, ...q.answers.no.supports, ...q.answers.no.refutes]);
    const out: NonNullable<Question["before"]> = {};
    for (const id of ids) {
      const c = this.store.getClaim(id);
      if (c) out[id] = { status: c.status, confidence: c.confidence };
    }
    return out;
  }

  /** 按一种回答的判法写进推理图谱：支持、反证（同一句回答抽出的事实已经这样关联过的不重复记），涉及的组重新定状态；明确时改事实这一层 */
  private apply(q: Question, effect: AnswerEffect, evidenceId: string, weight: LinkWeight, clear: boolean, at: string): { written: number; already: number } {
    // 267 号票：经唯一写入口——记下用户的表态（他对了解你问题的回答）；不明确、夜里才判的写明是每晚整理按回答判的
    return rgSession(this.store, { op: "verdict", actor: "user_verdict", ...(clear ? {} : { via: "每晚整理按回答判" }), reason: `回答了解你问题 ${q.id}` }, () => this.applyAnswer(q, effect, evidenceId, weight, clear, at));
  }

  private applyAnswer(q: Question, effect: AnswerEffect, evidenceId: string, weight: LinkWeight, clear: boolean, at: string): { written: number; already: number } {
    const rg = this.engine.rg;
    const rationale = `回答了解你问题 ${q.id}「${q.text}」`;
    const cause: RevisionCause = { evidenceId, reason: rationale };
    const groups = new Set<string>();
    const count = { written: 0, already: 0 };
    const usable = (id: string): Claim | undefined => {
      const c = this.store.getClaim(id);
      return c && c.status !== "retracted" && c.status !== "superseded" ? c : undefined;
    };
    for (const id of effect.supports) {
      if (!usable(id)) continue;
      if (weight === "decisive") {
        rg.confirmClaim(id, evidenceId);
        count.written += 1;
        continue;
      }
      if (this.linkedThroughFacts(id, evidenceId, "supports")) {
        count.already += 1;
        continue;
      }
      this.w.putLink({ claimId: id, target: evidenceId, polarity: "supports", weight, rationale: `${rationale}：${effect.note}` }, cause);
      count.written += 1;
      const g = rg.registry.memberOf(id)?.groupKey;
      if (g) groups.add(g);
    }
    for (const id of effect.refutes) {
      if (!usable(id)) continue;
      // 330 号票（R3）：转述起的猜测（不在组里）你说"不是"——你亲口否掉，撤回（R8，墓碑是你那句话）
      if (weight === "decisive" && q.kind === "relayed" && !rg.registry.memberOf(id) && usable(id)!.epistemic !== "explicit") {
        rg.rejectClaim(id, evidenceId);
        count.written += 1;
        continue;
      }
      if (weight !== "decisive" && this.linkedThroughFacts(id, evidenceId, "refutes")) {
        count.already += 1;
        continue;
      }
      this.w.putLink({ claimId: id, target: evidenceId, polarity: "refutes", weight, rationale: `${rationale}：${effect.note}` }, cause);
      count.written += 1;
      const g = rg.registry.memberOf(id)?.groupKey;
      if (g) groups.add(g);
    }
    for (const g of groups) if (rg.registry.getGroup(g)?.live) rg.redecideGroup(g);
    if (clear && effect.facts) this.applyFacts(effect.facts, evidenceId, at, cause);
    // 330 号票（R6）：做法的理由没了、用户答得很明确——还要的记成重新确认，不要了的撤回（不明确的不动，留着下次再问）
    if (clear && effect.strategies) {
      for (const id of effect.strategies.keep ?? []) {
        this.engine.strategies.answerBasisGone(id, true, evidenceId);
        count.written += 1;
      }
      for (const id of effect.strategies.retract ?? []) {
        this.engine.strategies.answerBasisGone(id, false, evidenceId);
        count.written += 1;
      }
    }
    return count;
  }

  /** 这条断言已经有一条同方向的关联指向这句回答抽出的事实 */
  private linkedThroughFacts(claimId: string, evidenceId: string, polarity: "supports" | "refutes"): boolean {
    return this.store.linksOf(claimId).some((l) => l.polarity === polarity && (this.store.getFact(l.target)?.evidenceIds.includes(evidenceId) ?? false));
  }

  /**
   * 回答得很明确时事实这一层的改动：定下来的事实 active（解除冲突）、另一条到期（superseded，被定下来的那条接上；没有就到这句回答为止），
   * 明说的断言跟着改（下一次 reflect 同步时结果一样）；当成被纠正的证据走引擎的 correct（旧的派生状态恢复，传播照旧）。
   */
  private applyFacts(facts: NonNullable<AnswerEffect["facts"]>, evidenceId: string, at: string, cause: RevisionCause): void {
    const registry = this.engine.rg.registry;
    const winner = facts.activate?.[0] ?? null;
    const until = this.store.getEvidence(evidenceId)?.eventTime ?? at;
    for (const id of facts.activate ?? []) {
      const f = this.store.getFact(id);
      if (!f) continue;
      this.w.updateFact(id, { status: "active", contestedWith: [] }, cause);
      const claimId = registry.explicitClaimOf(id);
      if (claimId) this.w.updateClaim(claimId, { status: "active", confidence: "high", competesWith: [], reviewedAt: at }, cause);
    }
    for (const id of facts.supersede ?? []) {
      const f = this.store.getFact(id);
      if (!f) continue;
      this.w.updateFact(id, { status: "superseded", supersededBy: winner, contestedWith: [], validTo: until }, cause);
      const claimId = registry.explicitClaimOf(id);
      if (!claimId) continue;
      const by = winner ? (registry.explicitClaimOf(winner) ?? null) : null;
      const wasActive = this.store.getClaim(claimId)?.status === "active";
      this.w.updateClaim(claimId, by ? { status: "superseded", supersededBy: by, competesWith: [], validTo: until, reviewedAt: at } : { validTo: until, competesWith: [], reviewedAt: at }, cause);
      // 267 号票：成立的那条被取代了，以它为前提的跟着动；329 号票起照传播铁律降回猜测（前提照挂、保留，R4）
      if (by && wasActive) this.engine.rg.keeper.downgradeDependents(claimId, at, { ...cause, reason: `前提 ${claimId} 被取代了（${cause.reason}）` }, this.engine.rg.view(at));
    }
    for (const id of facts.correctEvidence ?? []) {
      const e = this.store.getEvidence(id);
      if (e && e.status === "active" && id !== evidenceId) this.engine.correct(id, evidenceId);
    }
  }

  /** 判完：之前 → 之后，谁胜出、谁排除了 */
  private resolve(q: Question, at: string, how: string): Question {
    const lines: string[] = [];
    const won: string[] = [];
    const out: string[] = [];
    for (const [id, was] of Object.entries(q.before ?? {})) {
      const c = this.store.getClaim(id);
      if (!c) continue;
      lines.push(`${id}「${c.statement.slice(0, 16)}${c.statement.length > 16 ? "…" : ""}」${claimStatusLabel(was.status)} → ${claimStatusLabel(c.status)}（${c.confidence}）`);
      if (c.status === "active" && was.status !== "active") won.push(id);
      if (c.status === "active" && c.epistemic === "user_confirmed" && !won.includes(id)) won.push(id);
      if ((c.status === "retracted" || c.status === "superseded") && was.status !== c.status) out.push(id);
    }
    const verdict = won.length > 0 ? `定了：${won.join("、")} 胜出` : out.length > 0 ? `排除了 ${out.join("、")}` : "还没分出来";
    const outcome = `${how}。${lines.join("；")}。${verdict}。`;
    const next: Question = { ...q, status: "resolved", appliedAt: q.appliedAt ?? at, outcome, closedAt: at };
    this.save(next);
    this.log(q.id, "resolved", outcome, at, q.answerEvidenceId);
    return next;
  }
}

/** 一个问题的经过和"为什么问"拼成几行（演示、记忆页用） */
export function describeQuestion(q: QuestionView): string {
  const lines = [
    `${q.id} ${q.text}`,
    `  从哪来：${q.sources.join("、")}；状态：${STATUS_TEXT[q.status]}；优先级 ${q.priority}（分得出胜负 ${q.priorityDetail.separation} × 接近 ${q.priorityDetail.closeness} × 常遇到 ${q.priorityDetail.frequency} × 还没问过 ${q.priorityDetail.fresh}）；${localDate(q.expiresAt)} 过期`,
    `  为什么问：${q.why}`,
    `  要弄清的：${q.targets.map((t) => `${t.id}（${t.status}）`).join("、")}；领域 ${domainLabels(q.domains) || "没有"}；场景 ${q.scenes.join("、") || "不限"}`,
  ];
  if (q.outcome) lines.push(`  结果：${q.outcome}`);
  return lines.join("\n");
}
