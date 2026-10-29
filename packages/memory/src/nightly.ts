// 每日整理（198 号票，架构文档第 7.6 节；CONTEXT.md 的"做梦阶段"）：每天凌晨 03:00（可配置）跑一次。PoC 里用模拟时钟，不真起定时器；
// 接进二狗时作为记忆插件的内部作业登记，由调度器到点调 runNightly。
//
// 什么时候跑（主会话 2026-10-20 定的第 1 条）：
// - 到点前不跑（not_due，告诉下次几点）；同一夜跑过了不再跑（already_ran）；
// - 跑之前看用户是不是正在用（给了 userActive 用它；给了 lastActiveAt 看它；都没给看最近一条本人记录）：30 分钟里在用就往后推 30 分钟，
//   最多推到 05:00——到 05:00 不再推，照跑（late）；错过了（机器关着）到了再补跑，也记 late。
//
// 跑一次做什么（按顺序）：
//   1. 问了没答、已经过了一天的问题算跳过一次；过了过期时间的问题标过期；
//   2. reflect()：处理前一天以来的新证据（增量），更新事实、假设、需求和价值；待复核的重判；
//   3. 上一夜以后答了、还没判的了解你问题，按问题里写的"什么回答支持哪边"判（不明确的最多记强的），涉及的组重新定状态；
//      判完有断言因此待复核的，再 reflect 一次；
//   4. 编交互策略（compileStrategies：成立的需求、价值 → 新的 proposed，已有的跟着依据走）；
//   5. 从推理图谱出了解你问题（question-sources.ts），交给问题箱更新（去重、别问这个、冷却、过期、优先级；要弄清的有结果了的标不用问了）；
//   6. 整理报告：新的、变了的（之前 → 之后）、待复核的、问题队列的变化，外加拼好的一段文字。
//   7. 预测账本（226 号票，rg/predictions.ts，实际在 reflect 末尾跑）：成立的结论当时写下预测，到期判应验没有；只记账、不改分。
//      报告里带这一夜新记几条、判几条（应验 / 落空 / 还说不准）、还开着几条。
//   8. 每晚校验（267 号票，rg/nightly-validate.ts；给了 validator 才做，守护进程给的是记忆系统自己的图谱自检 graphSelfCheck）：
//      整张推理图谱查一遍（rg/graph-check.ts），不合格的结论转待复核（经唯一写入口，夜班），写进报告。
// 预算（270 号票，rg/nightly-lanes.ts）：一夜总共 maxModelCalls 次（对抗复核另算）——第二次 reflect 只用第一次剩下的；
// reflect 里按道花：新证据排第一，判回答（271）有一小份保底、排在新证据之后，重跑旧追问用剩下的，往上抽留 1/4。
// 报告写每一道、每一步花了几次，还积压几条新证据。
// 顺口问的回答（271 号票，rg/reply-judge.ts；给了 replyJudge 才做）：第 1 步的"问了没答算跳过"换成记忆管理员判——问过、还在等回答的问题，
// 把问题和用户之后的几句话交给模型判（reflect 里判回答那一道），答了回写（第 3 步同一夜按判法判）、没答算跳过一次、拿不准留到下一夜；
// 过期挪到判完以后（问过的先判，答了的不会因为今晚到期就丢掉）。没给模型（规则版、演示）照旧。
// 永不推送：报告和问题都只进问题箱和记忆页，顺口问只在用户来对话时（pickQuestion）。
import type { Claim, ClaimStatus, Confidence, Evidence } from "./domain/types.ts";
import { addDays, localDate, offsetMinutes, toMs } from "./domain/time.ts";
import type { MemoryEngine } from "./engine.ts";
import { addSpend, emptySpend, isReviewDue, REFLECT_LANES, type ReflectSpend } from "./rg/nightly-lanes.ts";
import { DEFAULT_MAX_MODEL_CALLS } from "./rg/reasoning-graph.ts";
import { generateQuestions, type DroppedQuestion } from "./rg/question-sources.ts";
import type { Question, QuestionView } from "./rg/questions.ts";
import type { BackpropStats, PredictionStats } from "./rg/predictions.ts";

/** 330 号票：两次整理的"落空往回打"合起来（都没有就不写这一项） */
function addBackprop(a: BackpropStats | undefined, b: BackpropStats | undefined): { backprop?: BackpropStats } {
  if (!a && !b) return {};
  const zero: BackpropStats = { retracted: 0, countered: 0, undetermined: 0, counterexamples: 0 };
  const x = a ?? zero;
  const y = b ?? zero;
  return { backprop: { retracted: x.retracted + y.retracted, countered: x.countered + y.countered, undetermined: x.undetermined + y.undetermined, counterexamples: x.counterexamples + y.counterexamples } };
}
import { validateNightly, type GraphValidator, type NightlyValidation } from "./rg/nightly-validate.ts";
import {
  applyReplyJudgments,
  evidenceFollowUps,
  judgeReplyCases,
  planReplies,
  REPLY_JUDGE_RESERVE,
  type RepliesReport,
  type ReplyFollowUpSource,
  type ReplyJudge,
  type ReplyJudgment,
} from "./rg/reply-judge.ts";
import type { ReflectReport } from "./rg/types.ts";
import type { StageStatsMap } from "./llm/robust.ts";
import type { MemoryStore } from "./store/store.ts";

export interface NightlyConfig {
  /** 每天几点跑（本地时间 HH:MM，默认 03:00） */
  time: string;
  /** 用户在用时往后推几分钟（默认 30） */
  deferMinutes: number;
  /** 最多推到几点（默认 05:00）：到这个点不再推，照跑 */
  latest: string;
  /** 最近一条本人记录在几分钟以内就算"正在用"（默认 30） */
  activeWindowMinutes: number;
}

export const DEFAULT_NIGHTLY: NightlyConfig = { time: "03:00", deferMinutes: 30, latest: "05:00", activeWindowMinutes: 30 };

export interface NightlyOptions {
  /** 现在几点：要和引擎的时钟一致（模拟时钟先拨到这里）；不给就是引擎的时钟 */
  at?: string;
  /** 用户是不是正在用（调用的人知道就直接给） */
  userActive?: boolean;
  /** 用户最后一次在用的时间（不给 userActive 时看它） */
  lastActiveAt?: string;
  config?: Partial<NightlyConfig>;
  /** 这一夜最多调几次模型（规则版不调；对抗复核另算）。270 号票起判完回答再整理的那一次只用第一次剩下的，一夜合起来不超过它 */
  maxModelCalls?: number;
  /**
   * 手动整理一次（235 号票：用户点了"立即整理一次"，不等 03:00）：
   * - **现在就跑**：不看几点、不看用户在不在用（`user_active` 的推后只该管 03:00 的定时那一次）；
   * - **不看"这一夜跑过了"**：同一天 03:00 跑过、或者刚才手动跑过，都照样进来——省钱靠的是引擎自己的增量
   *   （证据按 sourceRef 跳过、抽事实按 extraction_log 每条每条一次、假设/追问/往上抽走 rg_* 簿记），没有新东西时几乎不调模型；
   * - **不动那一夜的定时水位**：报告和运行状态记在 `nightly_runs` 里手动自己的键（`manualRunKey`），那一夜的 `night` 那一行
   *   （定时那次的 `ran_at`）一个字节不改——所以同一天 03:00 的定时那次照常跑，不会因为 01:00 手动整理过就被当成"已经整理过"；
   * - 整理报告里 `night` 还是那一天、`late` 是 false、推后次数不变。
   */
  manual?: boolean;
  /** 267 号票：整理完跑的推理图谱校验器（守护进程给的是 graphSelfCheck，326 号票起不再起别的程序）；不给就不校验 */
  validator?: GraphValidator;
  /**
   * 271 号票：判顺口问的回答的模型（守护进程给 LlmReplyJudge，和整理同一个模型）。给了就由它判问过的问题用户有没有在答，
   * 不再按"问了没答到第二天"一律记跳过；不给照旧
   */
  replyJudge?: ReplyJudge;
  /** 271 号票：取问过以后用户说的话（守护进程按会话里的消息取）；不给按本人证据的时间取（evidenceFollowUps） */
  followUps?: ReplyFollowUpSource;
  /** 271 号票：判回答那一道的保底最多几次（默认 REPLY_JUDGE_RESERVE；实际按这一夜要问模型的问题数） */
  replyReserve?: number;
}

/** 推后规则看的状态：这一夜跑过没有、已经推了几次 */
export interface NightlyState {
  /** 跑过的那一夜（本地日期）；这一夜没跑过是 null */
  ranNight: string | null;
  deferrals: number;
}

export interface NightlyDecision {
  /** 这一夜（本地日期 YYYY-MM-DD） */
  night: string;
  run: boolean;
  reason?: "not_due" | "user_active" | "already_ran";
  /** 不跑时下次几点再来看 */
  nextAt?: string;
  /** 到了最晚的时间（推后推到头了，或者错过了补跑） */
  late?: boolean;
}

export interface ClaimBrief {
  id: string;
  statement: string;
  tier: Claim["tier"];
  status: ClaimStatus;
  confidence: Confidence;
}

export interface ClaimChange {
  id: string;
  statement: string;
  from: ClaimStatus;
  to: ClaimStatus;
  fromConfidence: Confidence;
  toConfidence: Confidence;
}

export interface NightlyReport {
  night: string;
  ranAt: string;
  /** 这一夜推后了几次 */
  deferrals: number;
  late: boolean;
  reflect: ReflectReport;
  /** 判完回答以后又整理了一次（有断言因此待复核时） */
  secondReflect: ReflectReport | null;
  newClaims: ClaimBrief[];
  /** 状态、置信度变了的旧断言（之前 → 之后） */
  changedClaims: ClaimChange[];
  /** 跑之前标着复核的（这一夜重判了；329 号票起"待复核"是复核标记，不占真值状态） */
  reviewedClaims: ClaimBrief[];
  /** 跑完还标着复核的（预算用完没做完的、依据还在重推的） */
  needsReview: ClaimBrief[];
  /**
   * 到期待复评：active、reviewed_at 为空或早于 30 天前的结论条数（270 号票起模型版有剩下的预算时重跑它们那几组的追问）。
   * 272 号票起用户明说的不算（跟着那句话走，不按时间复评）
   */
  reviewDue: number;
  /** 270 号票：这一夜的预算按道花了几次（两次整理合起来；对抗复核另算） */
  spend: ReflectSpend;
  /** 270 号票：跑完还有几条新证据没整理完（下一夜按时间先后接着做） */
  backlog: number;
  /** 这一夜处理的证据按来源级别和说/做分桶的条数（本人说的、本人做的、本人纠正、别人转述、助理记的、系统记的） */
  representation: Record<string, number>;
  strategies: { created: string[]; updated: string[]; statusChanged: string[] };
  /** 226 号票：预测账本（reflect 末尾记下来、到期判；还开着几条是全库） */
  predictions: PredictionStats;
  /** 267 号票：每晚校验（给了校验器才有） */
  validation?: NightlyValidation;
  questions: {
    added: QuestionView[];
    /** 这一夜判了的回答 */
    resolved: QuestionView[];
    /** 要弄清的已经有结果了、依据变了，不用问了 */
    obsolete: QuestionView[];
    expired: QuestionView[];
    /** 问了没答、算跳过一次的 */
    skipped: QuestionView[];
    /** 跳过两次退下的 */
    retired: QuestionView[];
    /** 271 号票：记忆管理员夜里判顺口问的回答（给了 replyJudge 才有）：答了、没答、拿不准、没轮到、当天才问的 */
    replies?: RepliesReport;
    /** 没建的草稿（别问这个、冷却、刚答过……）和措辞不过关丢掉的 */
    notCreated: { key: string; reason: string }[];
    dropped: DroppedQuestion[];
    /** 整理完问题箱里开着的（按优先级） */
    queue: QuestionView[];
  };
  text: string;
}

export type NightlyResult =
  | { ran: true; night: string; at: string; deferrals: number; late: boolean; report: NightlyReport }
  | { ran: false; night: string; at: string; reason: "not_due" | "user_active" | "already_ran"; nextAt: string; deferrals: number; detail: string };

// ---------- 时间小工具（保留时区） ----------

const pad = (n: number) => String(n).padStart(2, "0");

function zoneOf(offset: number): string {
  if (offset === 0) return "Z";
  const abs = Math.abs(offset);
  return `${offset < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** 加减几分钟（保留时区） */
function addMinutes(iso: string, minutes: number): string {
  const offset = offsetMinutes(iso);
  const d = new Date(toMs(iso) + (minutes + offset) * 60_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${zoneOf(offset)}`;
}

/** 这一天（按 iso 的时区）的 HH:MM */
function atClock(iso: string, hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`时间要写成 HH:MM：${hhmm}`);
  return `${localDate(iso)}T${pad(Number(m[1]))}:${m[2]}:00${zoneOf(offsetMinutes(iso))}`;
}

/** 模拟时钟：演示和测试里"过了一夜"用它拨时间（MemoryEngine.open({ clock: clock.now })） */
export class SimClock {
  private current: string;

  constructor(start: string) {
    this.current = start;
  }

  readonly now = (): string => this.current;

  set(at: string): void {
    this.current = at;
  }

  advanceMinutes(minutes: number): string {
    this.current = addMinutes(this.current, minutes);
    return this.current;
  }
}

// ---------- 推后规则（纯函数） ----------

/** 这个时间要不要跑这一夜的整理：没到点、跑过了、用户在用（推后，最多到 latest）、跑（手动整理不看前四条） */
export function nightlyDecision(at: string, state: NightlyState, config: NightlyConfig, userActive: boolean, options: { manual?: boolean } = {}): NightlyDecision {
  const night = localDate(at);
  // 235 号票：用户点了"立即整理一次"——现在就跑，不看几点、不看用户在不在用、也不看这一夜跑过没有（省钱靠引擎的增量）
  if (options.manual === true) return { night, run: true, late: false };
  if (state.ranNight === night) return { night, run: false, reason: "already_ran", nextAt: atClock(addDays(at, 1), config.time) };
  const due = atClock(at, config.time);
  if (toMs(at) < toMs(due)) return { night, run: false, reason: "not_due", nextAt: due };
  const latest = atClock(at, config.latest);
  const late = toMs(at) >= toMs(latest);
  if (late) return { night, run: true, late: true };
  if (userActive) {
    const next = addMinutes(at, config.deferMinutes);
    return { night, run: false, reason: "user_active", nextAt: toMs(next) < toMs(latest) ? next : latest };
  }
  return { night, run: true, late: false };
}

// ---------- 跑一次 ----------

/**
 * 手动整理在 `nightly_runs` 里的键（235 号票）：和那一夜的定时水位（`night` 那一行）分开，一次手动一行，
 * 同一分钟点两次算同一行（报告以后来的为准）。这样手动整理**不会把那一夜写成"已经整理过"**，当天 03:00 的定时那次照常跑。
 * 报告里的 `night` 还是那一天的本地日期——这个键只用来存运行状态和报告。
 */
export function manualRunKey(night: string, at: string): string {
  return `${night}#manual-${at.slice(11, 16).replace(":", "")}`;
}

function readState(engine: MemoryEngine, key: string): { ranAt: string | null; deferrals: number } {
  const row = engine.store.db.get<{ ran_at: string | null; deferrals: number }>("SELECT ran_at, deferrals FROM nightly_runs WHERE night = ?", key);
  return { ranAt: row?.ran_at ?? null, deferrals: Number(row?.deferrals ?? 0) };
}

function writeState(engine: MemoryEngine, night: string, patch: { deferrals: number; at: string; ranAt?: string; report?: unknown }): void {
  engine.store.db.run(
    `INSERT INTO nightly_runs (night, deferrals, last_check_at, ran_at, report) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (night) DO UPDATE SET deferrals = excluded.deferrals, last_check_at = excluded.last_check_at,
       ran_at = coalesce(excluded.ran_at, nightly_runs.ran_at), report = coalesce(excluded.report, nightly_runs.report)`,
    night,
    patch.deferrals,
    patch.at,
    patch.ranAt ?? null,
    patch.report === undefined ? null : JSON.stringify(patch.report),
  );
}

/** 用户是不是正在用：给了就用给的；否则看最近一条本人记录（不晚于 at）是不是在窗口里 */
function userActiveAt(engine: MemoryEngine, at: string, options: NightlyOptions, config: NightlyConfig): boolean {
  if (options.userActive !== undefined) return options.userActive;
  const windowStart = toMs(at) - config.activeWindowMinutes * 60_000;
  const recent = (t: string) => toMs(t) <= toMs(at) && toMs(t) > windowStart;
  if (options.lastActiveAt !== undefined) return recent(options.lastActiveAt);
  return engine.store.listEvidence({ sourceLevel: "self" }).some((e) => recent(e.observedAt));
}

const brief = (c: Claim): ClaimBrief => ({ id: c.id, statement: c.statement, tier: c.tier, status: c.status, confidence: c.confidence });

// ---------- 复评水位、表象覆盖（227 号票） ----------

/** 到期待复评的条数：active、reviewed_at 为空或早于 REVIEW_DUE_DAYS（30）天前，用户明说的不算（272 号票；水位和判法在 rg/nightly-lanes.ts） */
export function reviewDueCount(store: MemoryStore, at: string): number {
  return store.listClaims({ status: "active" }).filter((c) => isReviewDue(c, at)).length;
}

/** 表象覆盖的桶（固定顺序：本人说的、本人做的、本人纠正、别人转述、助理记的、系统记的） */
export const REPRESENTATION_BUCKETS = ["本人说的", "本人做的", "本人纠正", "别人转述", "助理记的", "系统记的"] as const;

function representationBucket(evidence: Evidence): string {
  if (evidence.kind === "correction" && evidence.sourceLevel === "self") return "本人纠正";
  if (evidence.sourceLevel === "untrusted") return "别人转述";
  if (evidence.sourceLevel === "agent") return "助理记的";
  if (evidence.sourceLevel === "system") return "系统记的";
  return evidence.mode === "do" ? "本人做的" : "本人说的";
}

/** 这一夜处理的证据按来源级别和说/做分桶计数；没出现的桶不写（固定顺序） */
export function representationOf(store: MemoryStore, evidenceIds: readonly string[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const id of new Set(evidenceIds)) {
    const evidence = store.getEvidence(id);
    if (!evidence) continue;
    const bucket = representationBucket(evidence);
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  const out: Record<string, number> = {};
  for (const bucket of REPRESENTATION_BUCKETS) {
    const n = counts.get(bucket);
    if (n !== undefined) out[bucket] = n;
  }
  return out;
}

/**
 * 每日整理（见文件开头）：按时间规则决定跑还是推后；跑了就 reflect、判回答、编策略、出了解你问题，返回整理报告。
 * 模拟时钟：at 要和引擎的时钟一致。
 */
export async function runNightly(engine: MemoryEngine, options: NightlyOptions = {}): Promise<NightlyResult> {
  const now = engine.store.now();
  const at = options.at ?? now;
  if (toMs(at) !== toMs(now)) throw new Error(`runNightly 的 at（${at}）要和引擎的时钟（${now}）一致：模拟时钟先拨到 at`);
  const config: NightlyConfig = { ...DEFAULT_NIGHTLY, ...options.config };
  const night = localDate(at);
  // 235 号票：手动整理用自己的运行状态键，不动那一夜的定时水位
  const stateKey = options.manual === true ? manualRunKey(night, at) : night;
  const state = readState(engine, stateKey);
  const active = userActiveAt(engine, at, options, config);
  const decision = nightlyDecision(at, { ranNight: state.ranAt ? night : null, deferrals: state.deferrals }, config, active, options.manual === true ? { manual: true } : {});
  if (!decision.run) {
    const deferrals = decision.reason === "user_active" ? state.deferrals + 1 : state.deferrals;
    if (decision.reason === "user_active") writeState(engine, stateKey, { deferrals, at });
    const detail =
      decision.reason === "not_due"
        ? `还没到 ${config.time}，${decision.nextAt} 再来`
        : decision.reason === "already_ran"
          ? `${night} 这一夜已经整理过了（${state.ranAt}），下一次 ${decision.nextAt}`
          : `用户正在用，往后推 ${config.deferMinutes} 分钟到 ${decision.nextAt}（第 ${deferrals} 次；最晚 ${config.latest} 照跑）`;
    return { ran: false, night, at, reason: decision.reason!, nextAt: decision.nextAt!, deferrals, detail };
  }

  const book = engine.questions;
  const store = engine.store;
  const before = new Map(store.listClaims().map((c) => [c.id, brief(c)]));
  const reviewedClaims = store.listClaims({ needsReview: true }).map(brief);

  // 207 号票：reflect 里联动分不出的问题已经经钩子进箱，这一夜新出的按"跑之前没有"算
  const existing = new Set(book.listRaw().map((q) => q.id));
  // 271：给了判回答的模型，问过的问题交给记忆管理员判（reflect 里判回答那一道），不再一律记跳过；过期挪到判完以后
  const judge = options.replyJudge;
  const settled = judge === undefined ? book.settleUnanswered(at) : { skipped: [] as Question[], retired: [] as Question[] };
  const expiredFirst = judge === undefined ? book.expire(at) : [];
  const plan = judge === undefined ? undefined : planReplies(book, store, options.followUps ?? evidenceFollowUps(store), at);
  const judgments = new Map<string, ReplyJudgment | null>();
  const cases = plan?.cases ?? [];
  const replies =
    judge !== undefined && cases.length > 0
      ? {
          reserve: Math.min(options.replyReserve ?? REPLY_JUDGE_RESERVE, cases.length),
          run: async (budget: Parameters<typeof judgeReplyCases>[2]) => {
            for (const [id, judgment] of await judgeReplyCases(cases, judge, budget)) judgments.set(id, judgment);
          },
        }
      : undefined;
  const reflect = await engine.reflect({ maxModelCalls: options.maxModelCalls, ...(replies === undefined ? {} : { replies }) });
  const judged = plan === undefined ? undefined : applyReplyJudgments(book, plan, judgments, at);
  const expired = judge === undefined ? expiredFirst : book.expire(at);
  const resolved = book.applyPendingAnswers(at);
  // 226 号票：预测账本的两步在 reflect 末尾跑；第二次 reflect 不再判到期预测，保证一夜最多 10 条。
  // 270 号票：第二次只用第一次剩下的预算（一夜合起来不超过 maxModelCalls；对抗复核照旧另算）
  const leftover = Math.max(0, (options.maxModelCalls ?? DEFAULT_MAX_MODEL_CALLS) - reflect.modelCalls);
  const secondReflect = resolved.length > 0 && store.listClaims({ needsReview: true }).length > 0 ? await engine.reflect({ maxModelCalls: leftover, predictionDueLimit: 0 }) : null;
  const compiled = engine.compileStrategies();
  const generated = generateQuestions(engine.rg, at);
  const refreshed = book.refresh(generated.drafts, at);
  // 267 号票：整理完把推理图谱整张查一遍，不合格的结论转待复核（在拍"整理之后"的快照之前，报告里的待复核才算上它们）
  const validation = options.validator === undefined ? undefined : await validateNightly(engine, options.validator);

  const after = store.listClaims();
  const view = (q: Question) => book.view(book.get(q.id) ?? q);
  // 227：这一夜处理的证据（两次整理都算），按来源级别和说/做分桶
  const processedEvidenceIds = [...new Set([...reflect.processedEvidenceIds, ...(secondReflect?.processedEvidenceIds ?? [])])];
  const report: NightlyReport = {
    night,
    ranAt: at,
    deferrals: state.deferrals,
    late: decision.late === true,
    reflect,
    secondReflect,
    newClaims: after.filter((c) => !before.has(c.id)).map(brief),
    changedClaims: after.flatMap((c) => {
      const was = before.get(c.id);
      if (!was || (was.status === c.status && was.confidence === c.confidence)) return [];
      return [{ id: c.id, statement: c.statement, from: was.status, to: c.status, fromConfidence: was.confidence, toConfidence: c.confidence }];
    }),
    reviewedClaims,
    needsReview: after.filter((c) => c.needsReview).map(brief),
    reviewDue: reviewDueCount(store, at),
    spend: addSpend(reflect.spend ?? emptySpend(0), secondReflect?.spend),
    backlog: (secondReflect ?? reflect).backlog ?? 0,
    representation: representationOf(store, processedEvidenceIds),
    strategies: { created: compiled.created, updated: compiled.updated, statusChanged: compiled.statusChanged },
    predictions: {
      created: (reflect.predictions?.created ?? 0) + (secondReflect?.predictions?.created ?? 0),
      judged: (reflect.predictions?.judged ?? 0) + (secondReflect?.predictions?.judged ?? 0),
      hit: (reflect.predictions?.hit ?? 0) + (secondReflect?.predictions?.hit ?? 0),
      miss: (reflect.predictions?.miss ?? 0) + (secondReflect?.predictions?.miss ?? 0),
      unclear: (reflect.predictions?.unclear ?? 0) + (secondReflect?.predictions?.unclear ?? 0),
      open: store.listPredictions({ status: "open" }).length,
      ...addBackprop(reflect.predictions?.backprop, secondReflect?.predictions?.backprop),
    },
    ...(validation === undefined ? {} : { validation }),
    questions: {
      added: [...book.listRaw().filter((q) => !existing.has(q.id) && !refreshed.added.some((a) => a.id === q.id)), ...refreshed.added].map(view),
      resolved: resolved.map(view),
      obsolete: refreshed.obsolete.map(view),
      expired: expired.map(view),
      skipped: [...settled.skipped.map(view), ...(judged?.notAnswered ?? []).map(view)],
      retired: [...settled.retired.map(view), ...(judged?.retired ?? []).map(view)],
      ...(judged === undefined ? {} : { replies: judged }),
      notCreated: refreshed.skipped,
      dropped: generated.dropped,
      queue: book.list({ status: "open" }),
    },
    text: "",
  };
  report.text = formatNightlyReport(report, config);
  writeState(engine, stateKey, { deferrals: state.deferrals, at, ranAt: at, report: { ...report, text: report.text } });
  return { ran: true, night, at, deferrals: state.deferrals, late: report.late, report };
}

// ---------- 报告 ----------

const STATUS_CN: Readonly<Record<ClaimStatus, string>> = { active: "已验证", contested: "猜测", retracted: "已撤回", superseded: "已被取代" };
const cut = (s: string, n = 28) => (s.length > n ? `${s.slice(0, n)}…` : s);
const ids = (list: readonly { id: string }[]) => list.map((x) => x.id).join("、");

/** 整理报告拼成一段（演示、记忆页用） */
export function formatNightlyReport(r: NightlyReport, config: NightlyConfig = DEFAULT_NIGHTLY): string {
  const lines: string[] = [];
  const when = r.ranAt.slice(11, 16);
  const deferred = r.deferrals > 0 ? `，用户在用推后了 ${r.deferrals} 次` : "";
  lines.push(`整理报告（${r.night} 这一夜，${when} 跑的${deferred}${r.late ? `；到 ${config.latest} 不再推，照跑` : ""}）`);
  const rf = r.reflect;
  // 270 号票：整理完几条、还积压几条（两次整理合起来），预算按道、按步骤各花了几次
  const processed = new Set([...rf.processedEvidenceIds, ...(r.secondReflect?.processedEvidenceIds ?? [])]).size;
  lines.push(
    rf.skipped
      ? `- 整理：${rf.skipped}`
      : `- 整理：新证据整理完 ${processed} 条、还积压 ${r.backlog} 条${r.backlog > 0 ? "（预算用完，下一夜按时间先后接着做）" : ""}，跑了 ${rf.probeIds.length} 条追问、${rf.rounds} 轮检索${rf.modelCalls > 0 ? `，调了 ${rf.modelCalls} 次模型` : ""}`,
  );
  if (spentCalls(r.spend) > 0) lines.push(`- ${spendLine(r)}`);
  const buckets = Object.entries(r.representation);
  lines.push(`- 表象覆盖（这一夜处理的证据）：${buckets.length === 0 ? "（没有）" : buckets.map(([bucket, n]) => `${bucket} ${n}`).join("、")}`);
  const review = r.reflect.review;
  if (review && (review.reviewed.length > 0 || review.budgetExhausted)) {
    const rejected = review.rejectedByReview.length === 0 ? "" : `（${review.rejectedByReview.join("、")}）`;
    lines.push(
      `- 对抗复核：复核 ${review.reviewed.length} 条，不一致 ${review.rejectedByReview.length} 条${rejected}，拿不准 ${review.unclear} 条${review.budgetExhausted ? "；5 次调用用完，剩下的下夜再判" : ""}`,
    );
  }
  lines.push(`- 到期待复评 ${r.reviewDue} 条（30 天没复核过；用户明说的不算）`);
  if (r.reviewedClaims.length > 0) lines.push(`- 跑之前标着复核的：${r.reviewedClaims.map((c) => c.id).join("、")}（这一夜重判）`);
  lines.push(`- 新的：${r.newClaims.length === 0 ? "（没有）" : r.newClaims.map((c) => `${c.id}「${cut(c.statement)}」${STATUS_CN[c.status]}`).join("；")}`);
  lines.push(`- 变了的：${r.changedClaims.length === 0 ? "（没有）" : r.changedClaims.map((c) => `${c.id} ${STATUS_CN[c.from]}（${c.fromConfidence}）→ ${STATUS_CN[c.to]}（${c.toConfidence}）`).join("；")}`);
  lines.push(`- 还标着复核的：${r.needsReview.length === 0 ? "（没有）" : r.needsReview.map((c) => c.id).join("、")}`);
  // 256 号票：往上抽先出的临时结论、以及结构上就没过的组
  const lift = r.reflect.stats?.lift;
  if (lift && (lift.provisional > 0 || lift.failed > 0)) {
    const soft = Object.entries(lift.provisionalByReason).map(([k, n]) => `${k} ${n} 组`).join("、");
    if (lift.provisional > 0) {
      lines.push(
        `- 往上抽：先出了 ${lift.provisional} 组临时结论${soft ? `（${soft}）` : ""}——两种场合、两条以上证据都够了，差的是时间跨度；置信度先按薄的压成 low，跨度够了下一夜自己升上来`,
      );
    }
    if (lift.failed > 0) {
      const hard = Object.entries(lift.byReason).map(([k, n]) => `${k} ${n} 组`).join("、");
      lines.push(`- 往上抽：${lift.failed} 组没出${hard ? `（${hard}）` : ""}`);
    }
  }
  lines.push(
    `- 预测账本：新记 ${r.predictions.created} 条、到期判 ${r.predictions.judged} 条（应验 ${r.predictions.hit}、落空 ${r.predictions.miss}、还说不准 ${r.predictions.unclear}），还开着 ${r.predictions.open} 条`,
  );
  const bp = r.predictions.backprop;
  if (bp) lines.push(`- 预测落空往回打（330 号票）：撤了错的前提 ${bp.retracted} 条、可废止的来源挨反证 ${bp.countered} 条、判不出撤哪条 ${bp.undetermined} 条（出了问题）、前提都已验证挨反例 ${bp.counterexamples} 条`);
  if (r.validation) lines.push(`- ${validationLine(r.validation)}`);
  const refused = [...r.reflect.dropped, ...(r.secondReflect?.dropped ?? [])].filter((d) => d.stage === "gate");
  if (refused.length > 0) lines.push(`- 写入口拒了 ${refused.length} 处（原因交回给整理，这一夜没写进去）：${refused.slice(0, 3).map((d) => cut(d.reason, 60)).join("；")}${refused.length > 3 ? "……" : ""}`);
  if (r.strategies.created.length + r.strategies.updated.length + r.strategies.statusChanged.length > 0) {
    lines.push(`- 交互策略：新编 ${r.strategies.created.length} 条、更新 ${r.strategies.updated.length} 条、状态变了 ${r.strategies.statusChanged.length} 条（新的都等你确认）`);
  }
  const q = r.questions;
  lines.push("- 问题队列的变化：");
  const replied = q.replies === undefined ? 0 : q.replies.answered.length + q.replies.unsure.length + q.replies.waiting.length + q.replies.later.length;
  const changed = q.resolved.length + q.added.length + q.obsolete.length + q.expired.length + q.skipped.length + q.retired.length + replied > 0;
  if (!changed) lines.push("  · （没有变化）");
  if (q.resolved.length > 0) for (const x of q.resolved) lines.push(`  · 判了 ${x.id}：${x.outcome ?? ""}`);
  if (q.added.length > 0) lines.push(`  · 新出 ${q.added.length} 个：${ids(q.added)}`);
  if (q.obsolete.length > 0) lines.push(`  · 不用问了 ${q.obsolete.length} 个：${ids(q.obsolete)}（要弄清的已经有结果，或者依据变了）`);
  if (q.expired.length > 0) lines.push(`  · 过期 ${q.expired.length} 个：${ids(q.expired)}`);
  if (q.skipped.length > 0) lines.push(`  · 问了没答、算跳过一次：${ids(q.skipped)}`);
  if (q.retired.length > 0) lines.push(`  · 跳过两次退下：${ids(q.retired)}（记了回避信号）`);
  if (q.replies) {
    const line = repliesLine(q.replies);
    if (line !== undefined) lines.push(`  · ${line}`);
  }
  if (q.notCreated.length > 0) lines.push(`  · 没出的：${q.notCreated.map((x) => `${x.key}（${x.reason}）`).join("；")}`);
  if (q.dropped.length > 0) lines.push(`  · 丢掉的：${q.dropped.map((x) => `${x.key}（${x.reason}）`).join("；")}`);
  lines.push(`- 问题队列（${q.queue.length} 个，按优先级；永不推送，只在相关的对话里顺口问）：${q.queue.length === 0 ? "（空）" : ""}`);
  for (const x of q.queue) lines.push(`  ${x.priority.toFixed(3)}  ${x.id} ${x.text}`);
  return lines.join("\n");
}

/**
 * 271 号票：记忆管理员夜里判顺口问的回答那一行（没有要判的是 undefined）：问了几次模型，答了、没答（算跳过一次）、拿不准、没轮到、当天才问的
 */
export function repliesLine(r: RepliesReport): string | undefined {
  const total = r.answered.length + r.notAnswered.length + r.retired.length + r.unsure.length + r.waiting.length + r.later.length;
  if (total === 0) return undefined;
  const parts = [
    r.answered.length > 0 ? `答了 ${ids(r.answered)}（回写成本人证据，同一夜按判法判）` : "",
    r.notAnswered.length + r.retired.length > 0 ? `没在答、算跳过一次 ${ids([...r.notAnswered, ...r.retired])}` : "",
    r.unsure.length > 0 ? `拿不准、留到下一夜 ${ids(r.unsure)}` : "",
    r.waiting.length > 0 ? `没判成、留到下一夜 ${ids(r.waiting)}` : "",
    r.later.length > 0 ? `当天才问、下一夜再看 ${ids(r.later)}` : "",
  ].filter((p) => p.length > 0);
  return `顺口问的回答（记忆管理员看问过以后用户说的话，问了 ${r.calls} 次模型）：${parts.join("；")}`;
}

/** 270 号票：按步骤记的那几步（建库统计 stats.steps 的键）怎么说 */
const STEP_CN: readonly (readonly [keyof StageStatsMap, string])[] = [
  ["extract", "抽事实"],
  ["propose", "出假设"],
  ["probes", "出追问"],
  ["judge", "判证据"],
  ["lift", "往上抽"],
  ["strategies", "编策略"],
];

const spentCalls = (s: ReflectSpend) => REFLECT_LANES.reduce((n, lane) => n + s[lane], 0);

/**
 * 270 号票：预算那一行——这一夜调了几次（上限几次），按道（新证据、重跑旧追问、往上抽、判预测、编策略）、按步骤各几次；
 * 对抗复核另算（它有自己的 5 次）
 */
export function spendLine(r: Pick<NightlyReport, "spend" | "reflect" | "secondReflect">): string {
  const s = r.spend;
  const reflects = [r.reflect, ...(r.secondReflect ? [r.secondReflect] : [])];
  const steps = STEP_CN.flatMap(([key, name]) => {
    const n = reflects.reduce((sum, rf) => sum + (rf.stats?.steps[key]?.calls ?? 0), 0);
    return n > 0 ? [`${name} ${n}`] : [];
  });
  const reviews = reflects.flatMap((rf) => (rf.review ? [rf.review.modelCalls] : []));
  // 272 号票：问过、没变化就没再问的（出假设的观察、往上抽的下层断言）
  const unchanged = (["propose", "lift"] as const).flatMap((key) => {
    const n = reflects.reduce((sum, rf) => sum + (rf.stats?.steps[key]?.unchanged ?? 0), 0);
    return n > 0 ? [key === "propose" ? `出假设 ${n} 条观察` : `往上抽 ${n} 条下层断言`] : [];
  });
  return [
    `预算：调了 ${spentCalls(s)} 次（上限 ${s.limit}）：新证据 ${s.newEvidence}、判回答 ${s.replies}、重跑旧追问 ${s.rejudge}、往上抽 ${s.lift}、判预测 ${s.predictions}、编策略 ${s.strategies}`,
    ...(steps.length > 0 ? [`按步骤：${steps.join("、")}`] : []),
    ...(unchanged.length > 0 ? [`问过、没变化没再问：${unchanged.join("、")}`] : []),
    ...(reviews.length > 0 ? [`对抗复核另算 ${reviews.reduce((a, b) => a + b, 0)} 次`] : []),
  ].join("；");
}

/** 每晚校验那一行（267 号票） */
export function validationLine(v: NightlyValidation): string {
  if (v.state === "skipped") return `每晚校验：跳过（${v.reason ?? "原因不明"}）`;
  // 329 号票：违反传播铁律的降回猜测（以前的报告里这一项是 326 号票的"降成假设"）
  const downgraded = v.downgraded ?? [];
  const changes = downgraded.length === 0 ? "" : `；${downgraded.length} 条已验证的压在没验证的前提上，降回猜测（${downgraded.join("、")}）`;
  if (v.state === "ok") return `每晚校验：查了 ${v.nodes} 个节点，${v.validator}通过${changes}`;
  const which = v.claimIds.length === 0 ? "没有要标复核的结论" : `加复核标记 ${v.claimIds.length} 条（${v.claimIds.join("、")}）`;
  return `每晚校验：${v.validator}报了 ${v.problems.length} 个问题，${which}：${v.problems.slice(0, 3).map((p) => cut(p, 60)).join("；")}${v.problems.length > 3 ? "……" : ""}${changes}`;
}
