// 顺口问的回答由记忆管理员每晚整理时批量判（271 号票，用户 2026-10-25 定）。
//
// 线上秘书按当时的话题和语气自己改写问法（不再原样带 198 那一句），用户也常常不正面答——问"这阵子是不是特别忙"，答"最近在赶项目"。
// 白天的规则（questions.ts 的 classifyReply）只认紧接着的下一句里明显的"是 / 不是 / 跳过 / 别问这个"，认不出的不在白天记跳过，
// 留到每晚整理：把问题和用户之后的几句话一起交给记忆管理员（模型）判，不拖慢白天回话，花整理的预算。
//
// 一夜怎么判（nightly.ts 调这里的三步）：
//   1. planReplies：问过、还在等回答（asked）、不是当天才问的问题，按 ReplyFollowUpSource 取用户之后说的话（同一会话、问过以后
//      REPLY_WINDOW_HOURS 小时内、最多 REPLY_FOLLOW_UPS 句；守护进程按会话里的消息取，记忆包自己按本人证据的时间取），
//      每句对到推理库里能当依据的本人证据（别推断、敏感类别没打开、被忘掉的不交给模型）。
//      一句都没说的、拿不准过以后也没再说什么的，不问模型，直接当没答；
//   2. judgeReplyCases：一个问题问一次模型（每问一次 take 一次预算，预算是 reflect 里判回答那一道给的：保底 REPLY_JUDGE_RESERVE
//      次以内、按这一夜要问模型的问题数定，排在新证据之后、重跑旧追问之前；take 不到就停，没判的留到下一夜）；
//   3. applyReplyJudgments：
//      - 答了：用户那句话（模型点名的第一句）当回答，经 recordAnswer 回写——问题记"答了"、读成模型说的是 / 不是 / 说不好；
//        说得明不明确再拿规则版的 classifyAnswer 核一遍（规则也读成同一边、又有"确实、一点都不"这类加重的才算明确，马上判；
//        别的同一夜由 applyPendingAnswers 按判法记强的）。写入口里记成用户的表态、经记忆管理员夜里判；
//      - 没答：算跳过一次（跳过两次退下、记回避信号），夜班写；
//      - 拿不准：留到下一夜（经过里记一笔 unsure，记下看到哪一句为止）；下一夜用户又说了话就再判一次，没再说什么就当没答；
//        最多 REPLY_MAX_NIGHTS 夜，第二夜还拿不准也当没答。
// 模型判不了（解析不了、出错、说在答又没点名哪句）当拿不准。
import { sameLocalDay, toMs } from "../domain/time.ts";
import type { Evidence } from "../domain/types.ts";
import { canSupportUserClaims, isVerdictEvidence } from "../evidence/boundary.ts";
import type { ChatModel, ChatRequest } from "../llm/chat.ts";
import { parseModelJson } from "../llm/json.ts";
import type { MemoryStore } from "../store/store.ts";
import { type AnswerVerdict, classifyAnswer, type QuestionBook, type QuestionView } from "./questions.ts";
import type { ModelBudget } from "./types.ts";

/** 判回答那一道的保底最多几次（reflect 里从前段划出来；实际按这一夜要问模型的问题数，不超过它） */
export const REPLY_JUDGE_RESERVE = 10;
/** 用户之后说的话只看问过以后多少小时内的 */
export const REPLY_WINDOW_HOURS = 24;
/** 用户之后说的话最多看几句 */
export const REPLY_FOLLOW_UPS = 6;
/** 拿不准最多留几夜：第这么多夜还拿不准就当没答 */
export const REPLY_MAX_NIGHTS = 2;
/** 夜里判的写在留痕里记的"经谁转达" */
export const NIGHTLY_JUDGE_VIA = "经记忆管理员夜里判";

/** 交给模型的一句话最多多少字、秘书那一轮的回话最多多少字 */
const FOLLOW_UP_CHARS = 200;
const ASKED_AS_CHARS = 300;

/** 问过以后用户说的一句话：这句话在推理库里的证据（证据 id，或者素材 id = 整理时已经读成证据的那条的 sourceRef） */
export interface ReplyFollowUp {
  at: string;
  evidenceId?: string;
  sourceRef?: string;
}

/** 一个问题问过以后的样子：秘书当时那一轮的回话（问在里面；没有就不给）、用户之后说的话（按先后） */
export interface ReplyContext {
  askedAs?: string;
  followUps: readonly ReplyFollowUp[];
}

/** 取一个问题问过以后用户说的话（守护进程按会话里的消息取；不给按本人证据的时间取，见 evidenceFollowUps） */
export type ReplyFollowUpSource = (question: QuestionView, options: { at: string }) => ReplyContext;

/** 交给模型判的：问题、为什么问、两种回答各说明什么、秘书怎么问的、用户之后说的话（s1、s2…） */
export interface ReplyJudgeInput {
  questionId: string;
  question: string;
  why: string;
  yes: string;
  no: string;
  askedAs?: string;
  askedAt: string;
  followUps: { id: string; text: string; at: string }[];
}

export type ReplyJudgmentKind = "answered" | "not_answered" | "unsure";

/** 模型判的结果：答了（读成是 / 不是 / 说不好，在答的是哪几句）、没答、拿不准 */
export interface ReplyJudgment {
  kind: ReplyJudgmentKind;
  verdict?: AnswerVerdict;
  answerIds: string[];
  why: string;
}

/** 判回答的模型（真模型、假模型都实现这个）：判不了返回 null（当拿不准） */
export interface ReplyJudge {
  judgeReply(input: ReplyJudgeInput): Promise<ReplyJudgment | null>;
}

/** 要问模型的一个问题 */
export interface ReplyCase {
  question: QuestionView;
  askedAs?: string;
  /** 用户之后说的话（id 是交给模型的 s1、s2…；证据都是本人有效的） */
  followUps: { id: string; evidenceId: string; text: string; at: string }[];
  /** 之前拿不准过几夜 */
  nights: number;
}

/** 这一夜要判的：问模型的、不用问模型直接当没答的、当天才问明天再看的 */
export interface ReplyPlan {
  cases: ReplyCase[];
  settled: { question: QuestionView; why: string }[];
  later: QuestionView[];
}

/** 这一夜判回答的结果（整理报告里一行） */
export interface RepliesReport {
  /** 问了几次模型 */
  calls: number;
  /** 判成在答、回写了 */
  answered: QuestionView[];
  /** 判成没在答，算跳过一次 */
  notAnswered: QuestionView[];
  /** 没在答、跳过两次退下的 */
  retired: QuestionView[];
  /** 拿不准，留到下一夜 */
  unsure: QuestionView[];
  /** 预算没轮到（或者写入口没让写），留到下一夜 */
  waiting: QuestionView[];
  /** 当天才问的，明天夜里再看 */
  later: QuestionView[];
  /** 每个问题怎么判的（一句话） */
  notes: { questionId: string; outcome: "answered" | "not_answered" | "unsure" | "waiting"; why: string }[];
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** 默认的取法（记忆包自己、没有会话的地方）：问过以后 REPLY_WINDOW_HOURS 小时内本人说的话（证据），按时间先后最多 REPLY_FOLLOW_UPS 句 */
export function evidenceFollowUps(store: MemoryStore): ReplyFollowUpSource {
  return (question, { at }) => {
    if (question.lastAskedAt === null) return { followUps: [] };
    const from = toMs(question.lastAskedAt);
    const until = Math.min(toMs(at), from + REPLY_WINDOW_HOURS * 3_600_000);
    const followUps = store
      .listEvidence({ status: "active", sourceLevel: "self" })
      .filter((e) => e.mode === "say" && !isVerdictEvidence(e) && toMs(e.observedAt) > from && toMs(e.observedAt) <= until)
      .toSorted((a, b) => toMs(a.observedAt) - toMs(b.observedAt))
      .slice(0, REPLY_FOLLOW_UPS)
      .map((e) => ({ at: e.observedAt, evidenceId: e.id }));
    return { followUps };
  };
}

/**
 * 第 1 步：这一夜要判哪些。问过、还在等回答、不是当天才问的；用户之后的话对到能当依据的本人证据（对不上的不交给模型）。
 * 一句都没说的、拿不准过以后没再说什么的直接当没答（不问模型）
 */
export function planReplies(book: QuestionBook, store: MemoryStore, source: ReplyFollowUpSource, at: string): ReplyPlan {
  const plan: ReplyPlan = { cases: [], settled: [], later: [] };
  const asked = book.list({ status: "asked" });
  if (asked.length === 0) return plan;
  const active = store.listEvidence({ status: "active" });
  const byRef = new Map<string, Evidence>();
  for (const e of active) if (e.sourceRef !== null && !byRef.has(e.sourceRef)) byRef.set(e.sourceRef, e);
  const usable = (f: ReplyFollowUp): Evidence | undefined => {
    const e = f.evidenceId !== undefined ? store.getEvidence(f.evidenceId) : f.sourceRef !== undefined ? byRef.get(f.sourceRef) : undefined;
    return e !== undefined && canSupportUserClaims(e) && !isVerdictEvidence(e) && e.text.trim().length > 0 ? e : undefined;
  };
  for (const question of asked) {
    const askedAt = question.lastAskedAt;
    if (askedAt === null) continue;
    // 当天才问的（到第二天才算"问了没答"，198 的规矩）：明天夜里再看
    if (sameLocalDay(at, askedAt) || toMs(askedAt) > toMs(at)) {
      plan.later.push(question);
      continue;
    }
    const context = source(question, { at });
    const seen = new Set<string>();
    const followUps: ReplyCase["followUps"] = [];
    for (const f of context.followUps) {
      const e = usable(f);
      if (e === undefined || seen.has(e.id)) continue;
      seen.add(e.id);
      followUps.push({ id: `s${followUps.length + 1}`, evidenceId: e.id, text: clip(e.text.trim(), FOLLOW_UP_CHARS), at: f.at });
      if (followUps.length >= REPLY_FOLLOW_UPS) break;
    }
    const state = book.unsureState(question.id);
    if (followUps.length === 0) {
      plan.settled.push({ question, why: "问过以后用户一句都没再说（到第二天）" });
      continue;
    }
    if (state.nights > 0 && followUps.at(-1)!.evidenceId === state.lastSeen) {
      plan.settled.push({ question, why: `拿不准以后用户没再说什么（拿不准过 ${state.nights} 夜）` });
      continue;
    }
    plan.cases.push({ question, ...(context.askedAs === undefined || context.askedAs.trim() === "" ? {} : { askedAs: clip(context.askedAs.trim(), ASKED_AS_CHARS) }), followUps, nights: state.nights });
  }
  return plan;
}

/** 交给模型的输入 */
export function replyJudgeInput(c: ReplyCase): ReplyJudgeInput {
  const q = c.question;
  return {
    questionId: q.id,
    question: q.text,
    why: q.why,
    yes: q.answers.yes.note,
    no: q.answers.no.note,
    ...(c.askedAs === undefined ? {} : { askedAs: c.askedAs }),
    askedAt: q.lastAskedAt ?? "",
    followUps: c.followUps.map((f) => ({ id: f.id, text: f.text, at: f.at })),
  };
}

/** 第 2 步：一个问题问一次模型（每次 take 一次预算，take 不到就停）；判不了的记 null */
export async function judgeReplyCases(cases: readonly ReplyCase[], judge: ReplyJudge, budget: Pick<ModelBudget, "take">): Promise<Map<string, ReplyJudgment | null>> {
  const out = new Map<string, ReplyJudgment | null>();
  for (const c of cases) {
    if (!budget.take()) break;
    let judgment: ReplyJudgment | null = null;
    try {
      judgment = await judge.judgeReply(replyJudgeInput(c));
    } catch {
      judgment = null;
    }
    out.set(c.question.id, judgment);
  }
  return out;
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 第 3 步：按判的结果写问题箱（答了经 recordAnswer 回写、没答算跳过一次、拿不准留到下一夜）；预算没轮到的留着 */
export function applyReplyJudgments(book: QuestionBook, plan: ReplyPlan, judgments: ReadonlyMap<string, ReplyJudgment | null>, at: string): RepliesReport {
  const report: RepliesReport = { calls: judgments.size, answered: [], notAnswered: [], retired: [], unsure: [], waiting: [], later: plan.later, notes: [] };
  const skip = (question: QuestionView, why: string) => {
    const r = book.recordNightSkip(question.id, { at, why: `记忆管理员夜里看了问过以后用户说的话：${why}，算没答（跳过一次）`, via: NIGHTLY_JUDGE_VIA });
    (r.question.status === "retired" ? report.retired : report.notAnswered).push(r.question);
    report.notes.push({ questionId: question.id, outcome: "not_answered", why });
  };
  const wait = (question: QuestionView, why: string) => {
    report.waiting.push(question);
    report.notes.push({ questionId: question.id, outcome: "waiting", why });
  };
  for (const { question, why } of plan.settled) skip(question, why);
  for (const c of plan.cases) {
    const q = c.question;
    if (!judgments.has(q.id)) {
      wait(q, "这一夜判回答的预算没轮到，留到下一夜");
      continue;
    }
    const judgment = judgments.get(q.id) ?? { kind: "unsure" as const, answerIds: [], why: "模型的回答读不懂，判不了" };
    try {
      if (judgment.kind === "answered") {
        const answer = c.followUps.filter((f) => judgment.answerIds.includes(f.id));
        const verdict = judgment.verdict ?? "unclear";
        // 说得明不明确拿规则核一遍：规则也读成同一边、又有加重的说法才算明确（马上判）；别的同一夜按判法记强的
        const rule = classifyAnswer(answer.map((f) => f.text).join("，"));
        const clear = verdict !== "unclear" && rule.clear && rule.verdict === verdict;
        const record = book.recordAnswer(q.id, answer[0]!.evidenceId, {
          at,
          actor: "user_verdict",
          via: NIGHTLY_JUDGE_VIA,
          reading: { verdict, clear },
          note: `记忆管理员夜里看了问过以后用户说的话，判成在答（${judgment.why}）`,
        });
        report.answered.push(record.question);
        report.notes.push({ questionId: q.id, outcome: "answered", why: judgment.why });
      } else if (judgment.kind === "not_answered") {
        skip(q, judgment.why);
      } else if (c.nights + 1 >= REPLY_MAX_NIGHTS) {
        skip(q, `拿不准有没有在答，已经第 ${c.nights + 1} 夜（${judgment.why}）`);
      } else {
        const why = `记忆管理员夜里看了问过以后用户说的 ${c.followUps.length} 句话，拿不准有没有在答（第 ${c.nights + 1} 夜，留到下一夜）：${judgment.why}`;
        report.unsure.push(book.recordUnsure(q.id, { at, why, lastSeen: c.followUps.at(-1)!.evidenceId, via: NIGHTLY_JUDGE_VIA }));
        report.notes.push({ questionId: q.id, outcome: "unsure", why: judgment.why });
      }
    } catch (err) {
      // 写入口没让写（或者问题这期间变了）：这一夜不动它，原因进报告，下一夜再看
      wait(q, `没写进去：${messageOf(err)}`);
    }
  }
  return report;
}

// ---------- 模型判 ----------

export const REPLY_JUDGE_SYSTEM = `你是二狗的记忆管理员，每晚整理记忆时判一件事：白天秘书顺着话题问了用户一个"了解你问题"，用户之后说的这几句话里，有没有在回答它。规则：
- 只看给你的问题和用户的原话，不编造、不替用户补话，也不揣测他为什么这么说；
- 用户常常不正面答：话里实际回答了问题问的那件事就算在答，哪怕没用问题里的字眼。比如问"这阵子是不是特别忙"，答"最近在赶项目"就是在答（读成 yes）；
- 在答：kind 写 answered；verdict 写 yes（问的那件事是这样）、no（不是这样）或 unclear（答了，但说不好、看情况）；answer 写在答的那几句的编号；
- 没在答（在说别的事、只是应一声、接着交代别的事）：kind 写 not_answered；
- 看不出来是不是在答：kind 写 unsure；
- why 一句话说依据，不超过 40 个字；
只输出 JSON：{"kind": "answered | not_answered | unsure", "verdict": "yes | no | unclear", "answer": ["s1"], "why": "..."}`;

const minute = (iso: string) => (iso.length >= 16 ? iso.slice(5, 16).replace("T", " ") : iso);

/** 判一个问题的请求 */
export function replyJudgeRequest(input: ReplyJudgeInput): ChatRequest {
  return {
    purpose: "reply",
    system: REPLY_JUDGE_SYSTEM,
    user: [
      `问题（${input.questionId}）：${input.question}`,
      `为什么问：${input.why}`,
      `回答"是"说明：${input.yes}；回答"不是"说明：${input.no}`,
      input.askedAs === undefined ? `问的时间：${minute(input.askedAt)}` : `秘书当时是这么问的（${minute(input.askedAt)}，用的是它自己的话）：「${input.askedAs}」`,
      `用户之后说的话（按先后，最多 ${REPLY_FOLLOW_UPS} 句）：`,
      input.followUps.map((f) => `- ${f.id} ${minute(f.at)}「${f.text}」`).join("\n"),
    ].join("\n"),
    maxTokens: 400,
  };
}

const KINDS: ReadonlySet<string> = new Set(["answered", "not_answered", "unsure"]);
const VERDICTS: ReadonlySet<string> = new Set(["yes", "no", "unclear"]);

/** 用模型判（真模型、假模型都行）：解析不了、kind 不认得、说在答又没点名给过的哪一句都返回 null（当拿不准） */
export class LlmReplyJudge implements ReplyJudge {
  private readonly model: ChatModel;

  constructor(model: ChatModel) {
    this.model = model;
  }

  async judgeReply(input: ReplyJudgeInput): Promise<ReplyJudgment | null> {
    try {
      const response = await this.model.complete(replyJudgeRequest(input));
      const parsed = parseModelJson(response.content);
      const kind = typeof parsed.kind === "string" ? parsed.kind.trim() : "";
      if (!KINDS.has(kind)) return null;
      const why = typeof parsed.why === "string" && parsed.why.trim().length > 0 ? parsed.why.trim() : "（没写理由）";
      if (kind !== "answered") return { kind: kind as ReplyJudgmentKind, answerIds: [], why };
      const known = new Set(input.followUps.map((f) => f.id));
      const answerIds = (Array.isArray(parsed.answer) ? parsed.answer : []).filter((id): id is string => typeof id === "string" && known.has(id));
      if (answerIds.length === 0) return null;
      const verdict = typeof parsed.verdict === "string" && VERDICTS.has(parsed.verdict) ? (parsed.verdict as AnswerVerdict) : "unclear";
      return { kind: "answered", verdict, answerIds, why };
    } catch {
      return null;
    }
  }
}
