// 每晚 03:00 的记忆整理作业（225 号票，接入设计第 3、4、8 节）：记忆插件把它登记成内部作业，到点调 @ergo/memory 的 runNightly。
//
// 一次整理做什么：
// 1. 没配 DEEPSEEK_API_KEY 就跳过（记下原因，不建库、不调模型、不打扰用户），下一夜照常；
// 2. 打开推理库 rg.db（每次整理打开、跑完关掉；manifest 的版本对不上就不打开，记一条"要重建推理库"的提示）；
// 3. 把素材库里的新素材读成证据（只读；已经进过库的按 sourceRef 跳过，不重复吃钱）；
// 4. 调 runNightly（@ergo/memory 已有：到点前不跑、同一夜只跑一次、用户在用往后推 30 分钟、最多推到 05:00、
//    错过了补跑）。用户在用就由这里按 nextAt 睡到下一轮再试，到 05:00 runNightly 自己会照跑；
// 5. 把整理报告写进事件日志和整理记录视图（见 nightly-record.ts）；失败时进"待我处理"一条事项。
//
// 预算：config.memory.maxModelCalls（默认 200），一夜最多调这么多（判完回答再整理的那一次只用剩下的）。270 号票起 reflect 里按道花
// （@ergo/memory 的 rg/nightly-lanes.ts）：新证据排第一、用前 3/4（抽事实、出假设、新组的追问、检索结果里有新证据的旧追问），
// 剩下的才重跑标着复核、到期复评那几组的旧追问，往上抽和编策略留 1/4（334 号票起这 1/4 里先给编交互策略留 4 次，往上抽用剩下的；
// 出问题不调模型，预算用完也照跑）；整理完一条新证据记一条，没轮到的下一夜按时间先后接着做。
// 整理记录的 spend 记每一道花了几次，processedEvidence / pendingEvidence 是整理完几条、还积压几条。
// 模型走 @ergo/memory 的 LlmReasoner + DeepSeekChat（key 只从环境变量读，不打印）。
//
// 对抗复核和判预测（263 号票，照 226、227 号票面）：打开引擎时给复核模型 reviewer 和判预测的 LlmPredictionJudge，都是同一个 chat。
// - 对抗复核在 reflect 末尾：还没复核过的 need/value 推断结论交给不看结论的复核员，判 no 的加复核标记；它有自己的预算
//   （@ergo/memory 的 REVIEW_MAX_CALLS，每次 reflect 最多 5 次，不占 maxModelCalls），一夜最多两次 reflect，所以最多多 10 次调用；
// - 判预测也在 reflect 末尾：到期还开着的预测，按到期先后每夜最多 10 条，用的是 maxModelCalls 里剩下的那份（不另加预算）；
//   没有新证据的不问模型，预算用完、判不了的留 open 下夜再判。
// 整理记录的 modelCalls 把复核的次数也算上（判预测本来就在 reflect 的次数里）。
//
// 抽事实（236 号票）：默认用 @ergo/memory 的模型版 LlmFactExtractor（和评测时一样），和推理用同一个 chat、同一份预算；
// 配置 memory.extractor 写 rule 时用规则版（RelationalFactExtractor，不调模型，只当兜底/省钱）。单批抽取的输出被截断、
// 解析不了时 reflect 把它记进 dropped 继续跑，不失败整夜；抽取的模型调用和别的步骤共用 maxModelCalls。
// 首次建库要把现有素材重抽一遍：抽过的不再重抽，整理记录里的 processedEvidence / pendingEvidence 看进度。
//
// signal：守护进程停止、插件停用时置位，正在等推后的那一次马上停（抛 AbortError，内部作业当没跑过，下次补）。
//
// 唯一写入口（267 号票）：整理里所有对推理图谱的写都经 @ergo/memory 的 engine.gate（记成夜班），没打开的敏感类别交给写入口不推断；
// 被拒的不让整夜失败，原因进整理报告（refused 记几处）。整理完跑每晚校验：插件给的是 @ergo/memory 的图谱自检 graphSelfCheck
// （326 号票起是记忆系统自己的 TypeScript，整张推理图谱查一遍，不起别的程序），违反传播铁律的降回猜测、别的不合格加复核标记，写进报告。
//
// 顺口问的回答（271 号票）：问过、还在等回答的问题，由记忆管理员在这一夜批量判用户有没有在答——模型是 @ergo/memory 的 LlmReplyJudge
// （和整理同一个 chat、同一份预算：判回答那一道有一小份保底，排在新证据之后、重跑旧追问之前），用户之后的几句话按会话取
// （reply-follow-ups.ts：从秘书标了问题的那一轮之后、同一个会话、24 小时内）；没给会话（离线建库）时按本人证据的时间取。
// 答了回写（留痕：用户的表态、经记忆管理员夜里判），没答算跳过一次，拿不准留到下一夜。整理记录的 spend.replies、replies 记这一步。
//
// 个人档案的联动（283 号票，personal-files-link.ts）：模型包两层——推理那几步的提示末尾加档案摘要当情境（不当证据），每个请求里
// 号码类、住址的值换成占位（号码类字段不进任何发给模型的整理提示）；整理跑完以后先把档案里换过的值对一遍（旧值的事实到期），
// 再从这一夜新来的话里认人物信息（同一个模型、这一夜剩下的预算，最多 5 次），攒成档案的候选、合成第二天的候选核对卡。
// 认人物信息的调用算进这一夜的 modelCalls，整理记录多一项 people。
//
// 墙钟上限（237 号票，config.memory.nightlyTimeoutMinutes，默认 60 分钟）：每一夜到点就 abort（抛 AbortError），
// 记一条 failed（原因写"整理超时"）+ 待我处理一条，下一夜照常；whenIdle() 照样会返回。
// 注意能停下来的只有能回到事件循环的点（等模型、等 IO、等推后的 sleepUntil）：卡在本地同步死循环里时 abort
// 也没用（229 号票 p2 建库那次就是同步死循环，根子在 llm/robust.ts 的宽松解析，237 号票修掉了）。
import {
  type ChatModel,
  type ChatRequest,
  type ChatResponse,
  DEEPSEEK_DEFAULT_MODEL,
  DEEPSEEK_KEY_ENV,
  DeepSeekChat,
  type Embedder,
  type FactExtractor,
  FULL_REJUDGE_MAX_MODEL_CALLS,
  type FullRejudgeProgress,
  type FullRejudgeReport,
  type FullRejudgeSpend,
  type GraphValidator,
  LlmFactExtractor,
  LlmPredictionJudge,
  LlmReasoner,
  LlmReplyJudge,
  localDate,
  type MemoryEngine,
  MeteredChat,
  type MeterReport,
  type NightlyConfig,
  type NightlyReport,
  type NightlyResult,
  RelationalFactExtractor,
  runFullRejudge,
  runNightly,
  toMs,
} from "@ergo/memory";
import { type NoticeType, t } from "@ergo/protocol";
import type { MemoryConfig } from "../config/config.ts";
import type { EventStore } from "../events/event-store.ts";
import type { InboxService, NewInboxItem } from "../inbox/inbox.ts";
import type { Materials } from "../materials/materials.ts";
import type { PersonalFilesForMemory } from "../personal-files/index.ts";
import { clockIso, type Clock } from "../scheduler/clock.ts";
import type { InternalJob, JobTrigger } from "../scheduler/internal-jobs.ts";
import { DATA_SOURCE_EVIDENCE_PER_NIGHT, ingestedMaterialIds } from "./data-source-evidence.ts";
import { MaterialsEvidenceSource } from "./evidence-source.ts";
import { appendNightlyRecord, type MemoryNightlyRecord, type MemoryNightlyReview, type MemoryNightlyState } from "./nightly-record.ts";
import { guardNightlyChat, linkNightly } from "./personal-files-link.ts";
import { lockedSensitiveTags } from "./privacy.ts";
import { conversationFollowUps } from "./reply-follow-ups.ts";
import { openReasoningDb, type ReasoningDbIssue } from "./rg-db.ts";

/** 作业名（配置、日志、测试里用它） */
export const MEMORY_NIGHTLY_JOB = "memory-nightly";
/** 每天 03:00（本地时间） */
export const MEMORY_NIGHTLY_SCHEDULE = { kind: "daily", time: "03:00" } as const;

/**
 * 整理失败的通知（待我处理）：前端可能还不认识（协议 schema 允许未知种类，网页回落到通用的"通知"）。
 * 这一票不动网页，所以不用 NOTICE_TYPES 里的名字
 */
export const MEMORY_NIGHTLY_FAILED_NOTICE = "memory_nightly_failed";
/** "要重建推理库"的通知：同一份提示只留一条 */
export const MEMORY_NIGHTLY_REBUILD_NOTICE = "memory_nightly_rebuild";

/** 通知上的"知道了"（按字认，不翻） */
const ACK = "知道了"; // @i18n-ignore fixed：事项的动作按字认

/** 待我处理里那两种通知的 id（稳定，同一份提示不重复加） */
const FAILED_ITEM_PREFIX = "memory-nightly-failed-";
const REBUILD_ITEM_ID = "memory-nightly-rebuild";

/** 作业要的待我处理（add / get） */
export type NightlyInbox = Pick<InboxService, "add" | "get">;

export interface MemoryNightlyJobOptions {
  /** rg.db 的路径（338 号票起是 <数据目录>/memory/subtext/rg.db；以前在 db 区） */
  file: string;
  /** 素材库（只读 list） */
  materials: Pick<Materials, "list">;
  clock: Clock;
  /** 事件日志：整理记录追加到 internal 频道 */
  store: Pick<EventStore, "append">;
  inbox: NightlyInbox;
  /** 配置的 memory 一节（maxModelCalls 预算、extractor 抽事实用模型版还是规则版） */
  config: MemoryConfig;
  /** 向量函数（内核的 bge-m3 转接）；不给就不算向量 */
  embedder?: Embedder;
  /** 读 DEEPSEEK_API_KEY 的环境；不给按没配 key 处理（测试注入） */
  env?: Readonly<Record<string, string | undefined>>;
  /** 模型工厂：每次整理新建一个。不给就按 DEEPSEEK_API_KEY 建 DeepSeekChat（测试给假的，永远不连真模型） */
  chat?: () => ChatModel;
  /** 整理用的模型名（写进 manifest；默认 deepseek-flash） */
  model?: string;
  log?: (line: string) => void;
  /** runNightly 的时间表（默认 03:00、推 30 分钟、最晚 05:00） */
  nightly?: Partial<NightlyConfig>;
  /** 267 号票：整理完跑的推理图谱校验器（插件给 @ergo/memory 的图谱自检 graphSelfCheck）；不给就不校验 */
  validator?: GraphValidator;
  /** 271 号票：会话（判顺口问的回答时按会话取问过以后用户说的话）；不给（离线建库）按本人证据的时间取 */
  conversations?: Pick<EventStore, "reader">;
  /** 283 号票：个人档案（内核的，档案摘要、不进提示的值、候选）；不给（离线建库）就没有联动 */
  personalFiles?: () => PersonalFilesForMemory | undefined;
}

/** 作业句柄：作业本身、直接跑一次（测试用）、手动整理一次（235 号票：用户点了"立即整理一次"）、停用/移除时中止、等正在跑的那一次停下 */
export interface MemoryNightlyJob {
  readonly job: InternalJob;
  run(trigger: JobTrigger, signal: AbortSignal): Promise<MemoryNightlyRecord | undefined>;
  /**
   * 手动整理一次（235 号票）：走同一份作业逻辑（同一个引擎、同一份预算、同一条整理记录），只是不看 03:00、不看用户在不在用、
   * 也不看这一夜跑过没有（trigger 记 manual）。省钱靠引擎的增量：素材按 sourceRef 跳过、抽事实按 extraction_log 每条一次、
   * 假设和追问走 rg_* 簿记——没有新东西时几乎不调模型。**不动那一夜的定时水位**（@ergo/memory 用 `manualRunKey` 另开一行），
   * 所以 01:00 手动整理过，当天 03:00 的定时那次照常跑、只处理这期间的新增量。
   * 正在跑的那一次还没完时不叠着开第二个引擎，回一条"正在整理"。插件停用/守护进程停止时跟着中止
   */
  runNow(): Promise<MemoryNightlyRecord | undefined>;
  /**
   * 242 号票：挂上"03:00 交给记忆管理员来跑"的委派（记忆管理员被唤醒、自己调 run）。作业这一夜不自己调 runNightly；
   * 管理员那一轮没调（起不来、没听明白）时照旧补跑一次，保证整理这条确定性路径一定走。返回取消挂上的函数
   */
  wakeWith(wake: (info: MemoryNightlyWake) => Promise<MemoryNightlyWakeResult | undefined>): () => void;
  /**
   * 333 号票：全量重判一次（@ergo/memory 的 runFullRejudge）：同一份引擎设置（模型、抽事实、复核员、判预测、敏感类别、档案摘要），
   * 不读新素材、不写整理记录；模型外面包一层计量（MeteredChat：调用次数、token、按时段算的钱，给了 maxYuan 就封顶），
   * 进度和花费经 onProgress 报。正在整理时不叠着开（busy）；没配 key 跳过。命令行 `npm run memory:rejudge` 用它
   */
  runFullRejudge(options?: FullRejudgeJobOptions): Promise<FullRejudgeJobResult>;
  abort(reason?: unknown): void;
  whenIdle(): Promise<void>;
}

/** 333 号票：全量重判一次的设置 */
export interface FullRejudgeJobOptions {
  /** 跑之前把 rg.db VACUUM INTO 到这里（撤回就换回它）；不给就不存 */
  backupFile?: string;
  /** 整理那一步最多调几次模型（默认 FULL_REJUDGE_MAX_MODEL_CALLS） */
  maxModelCalls?: number;
  /** 最多花多少钱（元）：MeteredChat 发之前按最坏的算，超了就不发 */
  maxYuan?: number;
  onProgress?: (event: FullRejudgeProgress) => void;
}

/** 333 号票：全量重判一次的结果（meter 是模型的用量和钱） */
export type FullRejudgeJobResult =
  | { state: "ran"; report: FullRejudgeReport; meter: MeterReport }
  | { state: "skipped" | "busy" | "rebuild_needed" | "failed"; reason: string; meter?: MeterReport };

/** MeteredChat 的用量 → 全量重判报告里的花费 */
export function rejudgeSpendOf(r: MeterReport): FullRejudgeSpend {
  return { calls: r.calls, inputTokens: r.inputTokens, outputTokens: r.outputTokens, yuan: r.yuan };
}

/** 03:00 的委派交给谁：这一夜怎么跑、为什么跑、中止信号 */
export interface MemoryNightlyWake {
  readonly trigger: JobTrigger;
  readonly signal: AbortSignal;
  /** 跑一次整理（同一份作业） */
  run(trigger: JobTrigger, signal: AbortSignal): Promise<MemoryNightlyRecord | undefined>;
}

/** 被唤醒的那个交回：这一夜自己调了几次模型、跑成的整理记录（没跑成是 undefined） */
export interface MemoryNightlyWakeResult {
  /** 管理员这一夜自己调了几次模型（记进整理记录） */
  readonly modelCalls: number;
  /** 那一轮里跑成的整理记录（工具调 run 交回的）；没跑是 undefined */
  readonly record?: MemoryNightlyRecord | undefined;
  /** 预算跑满、管理员被停下 */
  readonly budgetExhausted?: boolean;
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
const isAbort = (err: unknown) => (err as { name?: unknown } | undefined)?.name === "AbortError";

/** AbortError：内部作业据此知道"被中止了，不算跑过" */
function abortError(reason?: unknown): Error {
  const err = new Error(typeof reason === "string" && reason.length > 0 ? reason : "记忆整理已中止"); // @i18n-ignore log：被中止时的错误信息，只进日志
  err.name = "AbortError";
  return err;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal.reason);
}

/** 前端可能还不认识的两种通知（见 MEMORY_NIGHTLY_FAILED_NOTICE 的说明） */
const noticeType = (notice: string): NoticeType => notice as NoticeType;

/** 空记录（推后、跳过、失败时只填其中几项） */
function blankRecord(night: string, at: string, state: MemoryNightlyState, trigger: JobTrigger): MemoryNightlyRecord {
  return {
    night,
    at,
    state,
    trigger,
    deferrals: 0,
    newClaims: 0,
    changedClaims: 0,
    reviewed: 0,
    needsReview: 0,
    questions: { added: 0, resolved: 0, obsolete: 0, expired: 0, skipped: 0, retired: 0, open: 0 },
    modelCalls: 0,
    budgetExhausted: false,
    processedEvidence: 0,
    pendingEvidence: 0,
  };
}

/** 库不能用的原因 → 给人看的一句话 */
export function reasoningIssueText(issue: ReasoningDbIssue): string {
  switch (issue.code) {
    case "manifest_missing":
      return t("memory.nightly.issue.manifestMissing");
    case "schema_mismatch":
      return t("memory.nightly.issue.schemaMismatch", { found: issue.found, expected: issue.expected });
    case "store_schema_mismatch":
      return t("memory.nightly.issue.storeSchemaMismatch", { found: issue.found, expected: issue.expected });
    case "open_failed":
      return t("memory.nightly.issue.openFailed", { detail: issue.detail });
  }
}

/** 加一条待我处理的通知；同一个 id 已经在就不再加 */
function addNoticeOnce(inbox: NightlyInbox, input: NewInboxItem): boolean {
  if (input.id !== undefined && inbox.get(input.id) !== undefined) return false;
  inbox.add(input);
  return true;
}

/** "要重建推理库"进待我处理一次（同一份提示只留一条） */
export function announceRebuildNeeded(inbox: NightlyInbox, reason: string): boolean {
  return addNoticeOnce(inbox, {
    kind: "notice",
    id: REBUILD_ITEM_ID,
    notice: noticeType(MEMORY_NIGHTLY_REBUILD_NOTICE),
    title: t("memory.nightly.rebuild.title"),
    body: t("memory.nightly.rebuild.body", { reason }),
    source: t("memory.nightly.source"),
    urgency: "non_blocking",
    actions: [ACK],
  });
}

/** 整理失败进待我处理一条（一夜一条） */
function addFailedNotice(inbox: NightlyInbox, night: string, reason: string): boolean {
  return addNoticeOnce(inbox, {
    kind: "notice",
    id: `${FAILED_ITEM_PREFIX}${night}`,
    notice: noticeType(MEMORY_NIGHTLY_FAILED_NOTICE),
    title: t("memory.nightly.failed.title", { night }),
    body: t("memory.nightly.failed.body", { reason }),
    source: t("memory.nightly.source"),
    urgency: "non_blocking",
    actions: [ACK],
  });
}

/**
 * 守护进程启动时发现推理库不能用（要重建）：记一条整理记录，并在待我处理里提示一次（同一份提示只留一条，第二天不再重复）
 */
export function reportUnusableReasoningDb(options: { store: Pick<EventStore, "append">; inbox: NightlyInbox; clock: Clock; issue: ReasoningDbIssue; log?: (line: string) => void }): MemoryNightlyRecord {
  const at = clockIso(options.clock);
  const reason = reasoningIssueText(options.issue);
  const record = blankRecord(localDate(at), at, "rebuild_needed", "catch_up");
  record.reason = reason;
  appendNightlyRecord(options.store, record);
  announceRebuildNeeded(options.inbox, reason);
  const log = options.log ?? (() => {});
  log(`记忆整理要重建推理库（${options.issue.code}）：${reason}`);
  return record;
}

/** 一次 reflect 调了几次模型（含它末尾的对抗复核） */
function modelCallsOf(report: NightlyReport["reflect"]): number {
  return report.modelCalls + (report.review?.modelCalls ?? 0);
}

/**
 * 抽事实用哪个（236 号票，配置 memory.extractor）：model = @ergo/memory 的模型版（和评测一致，和推理用同一个模型）；
 * rule = 规则版（不调模型，只当兜底/省钱）。显式给出来，manifest 里才记着这一次实际用的那个
 */
function configuredExtractor(config: MemoryConfig, chat: ChatModel): FactExtractor {
  return config.extractor === "rule" ? new RelationalFactExtractor() : new LlmFactExtractor(chat);
}

/** 跑完还剩几条有效证据没整理（预算用完的、下一夜接着做；首次建库时看它几夜做完） */
function pendingEvidenceOf(engine: MemoryEngine): number {
  return engine.store.listEvidence({ status: "active" }).filter((evidence) => !engine.rg.registry.isReflected(evidence.id, engine.rg.reasoner.id)).length;
}

/** 把 NightlyReport 收成一条整理记录 */
function recordOfReport(report: NightlyReport, trigger: JobTrigger, at: string, pendingEvidence: number): MemoryNightlyRecord {
  const second = report.secondReflect;
  return {
    night: report.night,
    at,
    state: "ran",
    trigger,
    ranAt: report.ranAt,
    late: report.late,
    deferrals: report.deferrals,
    newClaims: report.newClaims.length,
    changedClaims: report.changedClaims.length,
    reviewed: report.reviewedClaims.length,
    needsReview: report.needsReview.length,
    questions: {
      added: report.questions.added.length,
      resolved: report.questions.resolved.length,
      obsolete: report.questions.obsolete.length,
      expired: report.questions.expired.length,
      skipped: report.questions.skipped.length,
      retired: report.questions.retired.length,
      open: report.questions.queue.length,
    },
    modelCalls: modelCallsOf(report.reflect) + (second === null ? 0 : modelCallsOf(second)),
    budgetExhausted:
      report.reflect.budgetExhausted ||
      (second?.budgetExhausted ?? false) ||
      (report.reflect.review?.budgetExhausted ?? false) ||
      (second?.review?.budgetExhausted ?? false),
    processedEvidence: new Set([...report.reflect.processedEvidenceIds, ...(second?.processedEvidenceIds ?? [])]).size,
    pendingEvidence,
    spend: { ...report.spend, review: (report.reflect.review?.modelCalls ?? 0) + (second?.review?.modelCalls ?? 0) },
    ...(report.questions.replies === undefined
      ? {}
      : {
          replies: {
            calls: report.questions.replies.calls,
            answered: report.questions.replies.answered.length,
            notAnswered: report.questions.replies.notAnswered.length + report.questions.replies.retired.length,
            unsure: report.questions.replies.unsure.length,
            waiting: report.questions.replies.waiting.length,
          },
        }),
    review: reviewOf(report),
    predictions: { ...report.predictions },
    ...(report.validation === undefined
      ? {}
      : {
          validation: {
            state: report.validation.state,
            problems: report.validation.problems.length,
            claimIds: [...report.validation.claimIds],
            ...(report.validation.reason === undefined ? {} : { reason: report.validation.reason }),
            ...((report.validation.downgraded ?? []).length === 0 ? {} : { downgraded: [...report.validation.downgraded] }),
          },
        }),
    refused: [...report.reflect.dropped, ...(second?.dropped ?? [])].filter((d) => d.stage === "gate").length,
    // 329 号票：身份锁死，不再有"结论 ↔ 假设"（326 号票的 hypotheses 只在老记录里）
    text: report.text,
  };
}

/** 263 号票：两次整理的对抗复核合起来（没给复核模型时两次都没有 review，记成全 0） */
function reviewOf(report: NightlyReport): MemoryNightlyReview {
  const reviews = [report.reflect.review, report.secondReflect?.review].filter((review) => review !== undefined);
  return {
    reviewed: reviews.reduce((n, review) => n + review.reviewed.length, 0),
    rejected: reviews.reduce((n, review) => n + review.rejectedByReview.length, 0),
    unclear: reviews.reduce((n, review) => n + review.unclear, 0),
  };
}

/** 没跑成（没到点、这一夜跑过了）收成一条记录 */
function recordOfDeferral(result: Extract<NightlyResult, { ran: false }>, trigger: JobTrigger, at: string): MemoryNightlyRecord {
  const record = blankRecord(result.night, at, "deferred", trigger);
  record.reason = result.detail;
  record.deferrals = result.deferrals;
  return record;
}

/** 按此刻的时钟睡到 at（毫秒）：守护进程停止、插件停用时马上醒（抛 AbortError） */
function sleepUntil(clock: Clock, atMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal.reason));
      return;
    }
    let cancel: (() => void) | undefined;
    const onAbort = () => {
      cancel?.();
      reject(abortError(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    cancel = clock.setTimer(atMs, () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

/** 把模型包一层：每次调用前后看一眼中止信号（守护进程停止时不再接着花钱） */
function abortableChat(chat: ChatModel, signal: AbortSignal): ChatModel {
  return {
    name: chat.name,
    async complete(request: ChatRequest): Promise<ChatResponse> {
      throwIfAborted(signal);
      const response = await chat.complete(request);
      throwIfAborted(signal);
      return response;
    },
  };
}

/** 按环境里的 key 建 DeepSeekChat；请求也接上中止信号（停止时不再等超时） */
function deepseekChat(env: Readonly<Record<string, string | undefined>>, model: string, signal: AbortSignal): ChatModel {
  return new DeepSeekChat({
    model,
    env,
    post: (url, init) => fetch(url, { ...init, signal: init.signal === undefined ? signal : AbortSignal.any([signal, init.signal]) }),
  });
}

/**
 * 这一夜要整理的新证据：素材库照样读一遍，已经进过库的（按 sourceRef 背后的素材）跳过；敏感类别默认不读（234 号票）。
 * 303 号票：数据源的素材同一个数据源、同一种、同一天多的合成一条，当天的等这一天过完，一夜最多 DATA_SOURCE_EVIDENCE_PER_NIGHT 条——
 * 用户说的话照旧全读进来，不被数据源挤掉
 */
function ingestNewEvidence(engine: MemoryEngine, materials: Pick<Materials, "list">, clock: Clock, config: MemoryConfig): number {
  const source = new MaterialsEvidenceSource({
    materials,
    clock,
    inferableSensitiveCategories: config.sensitiveCategories,
    skip: ingestedMaterialIds(engine.store.listEvidence()),
    dataSourceLimit: DATA_SOURCE_EVIDENCE_PER_NIGHT,
  });
  const fresh = source.read();
  if (fresh.length > 0) engine.ingestFrom({ name: source.name, now: source.now, read: () => fresh });
  return fresh.length;
}

/** 登记作业（记忆插件的 setup 调它） */
export function createMemoryNightlyJob(options: MemoryNightlyJobOptions): MemoryNightlyJob {
  const log = options.log ?? (() => {});
  const model = options.model ?? DEEPSEEK_DEFAULT_MODEL;
  const env = options.env ?? {};
  const controller = new AbortController();
  let running: Promise<MemoryNightlyRecord | undefined> | undefined;
  /** 这一夜交给谁跑（242 号票：记忆管理员；没挂上就自己跑） */
  let wake: ((info: MemoryNightlyWake) => Promise<MemoryNightlyWakeResult | undefined>) | undefined;
  /** 已经追加了几条整理记录：管理员那一轮里调没调 run（没调就补跑一次）看它 */
  let appended = 0;

  const append = (record: MemoryNightlyRecord): MemoryNightlyRecord => {
    appendNightlyRecord(options.store, record);
    appended += 1;
    log(`记忆整理 ${record.night}：${record.state}${record.reason === undefined ? "" : `（${record.reason}）`}`);
    return record;
  };

  /** 打开推理库、接上每晚整理的那一套（抽事实、推理、对抗复核、判预测都是这个模型；没打开的敏感类别交给写入口）。全量重判一次也用它 */
  const openNightlyEngine = (chat: ChatModel) =>
    openReasoningDb({
      file: options.file,
      clock: () => clockIso(options.clock),
      model,
      extractor: configuredExtractor(options.config, chat),
      reasoner: new LlmReasoner(chat),
      // 263 号票：对抗复核、判到期预测（226、227），和推理同一个模型
      reviewer: chat,
      predictionJudge: new LlmPredictionJudge(chat),
      // 267 号票：没打开的敏感类别交给唯一写入口——不在上面推断（用户明说的照常记）
      sensitiveTags: lockedSensitiveTags(options.config.sensitiveCategories),
      ...(options.embedder === undefined ? {} : { embedder: options.embedder }),
    });

  const execute = async (trigger: JobTrigger, outerSignal: AbortSignal, manual = false): Promise<MemoryNightlyRecord | undefined> => {
    throwIfAborted(outerSignal);
    const at = clockIso(options.clock);
    const night = localDate(at);

    // 模型在不在：没配 key 就跳过（不建库、不调模型），下一夜照常
    const key = (env[DEEPSEEK_KEY_ENV] ?? "").trim();
    if (options.chat === undefined && key.length === 0) {
      const record = blankRecord(night, at, "skipped", trigger);
      record.reason = t("memory.nightly.reason.noKey");
      return append(record);
    }

    // 237 号票：这一夜自己的中止信号（守护进程停止 + 墙钟上限）；到点 abort，能回到事件循环的点都停得下来
    // （默认 60 分钟；0 = 不限。配置解析时一定会填上，这里的 60 只是兜底）
    const timeoutMinutes = options.config.nightlyTimeoutMinutes ?? 60;
    const timeoutReason = () => t("memory.nightly.reason.timeout", { minutes: timeoutMinutes });
    const runController = new AbortController();
    const signal = AbortSignal.any([outerSignal, runController.signal]);
    let timedOut = false;
    const timer =
      timeoutMinutes > 0
        ? setTimeout(() => {
            timedOut = true;
            runController.abort(abortError(timeoutReason()));
          }, timeoutMinutes * 60_000)
        : undefined;
    timer?.unref?.();

    // 283：档案摘要当推理的情境、号码类和住址的值换成占位（每个请求都过这一层）
    const files = options.personalFiles?.();
    const chat = guardNightlyChat(abortableChat(options.chat === undefined ? deepseekChat(env, model, signal) : options.chat(), signal), files);
    let engine: MemoryEngine | undefined;
    try {
      const opened = openNightlyEngine(chat);
      if (!opened.ok) {
        const reason = reasoningIssueText(opened.issue);
        const record = blankRecord(night, at, "rebuild_needed", trigger);
        record.reason = reason;
        append(record);
        announceRebuildNeeded(options.inbox, reason);
        return record;
      }
      engine = opened.engine;
      if (opened.created) log(`记忆整理建好了推理库 ${options.file}`);

      ingestNewEvidence(engine, options.materials, options.clock, options.config);
      throwIfAborted(signal);
      await engine.indexVectors();
      throwIfAborted(signal);

      const nightly = options.nightly === undefined ? {} : { config: options.nightly };
      // 手动整理（235）：同一份 runNightly，只是 manual 让它不看 03:00、不看用户在不在用；预算照旧
      const nightlyOptions = {
        maxModelCalls: options.config.maxModelCalls,
        ...nightly,
        ...(manual ? { manual: true } : {}),
        ...(options.validator === undefined ? {} : { validator: options.validator }),
        // 271 号票：记忆管理员判顺口问的回答（同一个模型、同一份预算）；用户之后的话按会话取
        replyJudge: new LlmReplyJudge(chat),
        ...(options.conversations === undefined ? {} : { followUps: conversationFollowUps({ reader: options.conversations.reader, materials: options.materials }) }),
      };
      let result = await runNightly(engine, nightlyOptions);
      // 用户在用：按 nextAt 睡过去再试，最多到 runNightly 的 latest（05:00）——到点它自己会 late 照跑
      while (!result.ran && result.reason === "user_active") {
        append(recordOfDeferral(result, trigger, clockIso(options.clock)));
        await sleepUntil(options.clock, toMs(result.nextAt), signal);
        throwIfAborted(signal);
        ingestNewEvidence(engine, options.materials, options.clock, options.config);
        throwIfAborted(signal);
        await engine.indexVectors();
        throwIfAborted(signal);
        result = await runNightly(engine, nightlyOptions);
      }
      const atNow = clockIso(options.clock);
      if (!result.ran) return append(recordOfDeferral(result, trigger, atNow));
      const record = recordOfReport(result.report, trigger, atNow, pendingEvidenceOf(engine));
      if (files !== undefined) {
        // 283：个人档案的联动（出错不让整夜失败：整理已经跑成了）
        try {
          const people = await linkNightly(engine, { files, chat, config: options.config, remaining: options.config.maxModelCalls - record.modelCalls, night: record.night, at: atNow, log });
          record.people = people;
          record.modelCalls += people.calls;
        } catch (err) {
          if (isAbort(err) || signal.aborted) throw err;
          log(`记忆整理 ${record.night}：个人档案的联动出错（整理照常算跑成）：${messageOf(err)}`);
        }
      }
      return append(record);
    } catch (err) {
      // 超时：记一条 failed（原因写"整理超时"）+ 待我处理一条，下一夜照常（不是 AbortError 往上抛，
      // 内部作业不会把它当"没跑过"再补一次）
      if (timedOut) {
        const reason = timeoutReason();
        const record = blankRecord(night, at, "failed", trigger);
        record.reason = reason;
        append(record);
        addFailedNotice(options.inbox, night, reason);
        log(`记忆整理 ${night} 超时（${timeoutMinutes} 分钟），这一夜放弃：${reason}`);
        return record;
      }
      if (isAbort(err) || signal.aborted) throw abortError(isAbort(err) ? undefined : err);
      const reason = messageOf(err);
      const record = blankRecord(night, at, "failed", trigger);
      record.reason = reason;
      append(record);
      addFailedNotice(options.inbox, night, reason);
      log(`记忆整理 ${night} 出错：${reason}`);
      return record;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      engine?.close();
    }
  };

  const start = (trigger: JobTrigger, signal: AbortSignal, manual = false): Promise<MemoryNightlyRecord | undefined> => {
    const combined = AbortSignal.any([signal, controller.signal]);
    const task = execute(trigger, combined, manual).finally(() => {
      if (running === task) running = undefined;
    });
    running = task;
    return task;
  };

  const run = (trigger: JobTrigger, signal: AbortSignal): Promise<MemoryNightlyRecord | undefined> => start(trigger, signal);

  /** 333 号票：全量重判一次（见 MemoryNightlyJob.runFullRejudge） */
  const fullRejudge = async (opts: FullRejudgeJobOptions, signal: AbortSignal): Promise<FullRejudgeJobResult> => {
    throwIfAborted(signal);
    const key = (env[DEEPSEEK_KEY_ENV] ?? "").trim();
    if (options.chat === undefined && key.length === 0) return { state: "skipped", reason: t("memory.nightly.reason.noKey") };
    const meter = new MeteredChat(options.chat === undefined ? deepseekChat(env, model, signal) : options.chat(), opts.maxYuan === undefined ? {} : { maxYuan: opts.maxYuan });
    // 283：档案摘要当推理的情境、号码类和住址的值换成占位（同每晚整理）；计量在最里面，记的是真发出去的请求
    const chat = guardNightlyChat(abortableChat(meter, signal), options.personalFiles?.());
    let engine: MemoryEngine | undefined;
    try {
      const opened = openNightlyEngine(chat);
      if (!opened.ok) return { state: "rebuild_needed", reason: reasoningIssueText(opened.issue), meter: meter.report() };
      engine = opened.engine;
      const report = await runFullRejudge(engine, {
        maxModelCalls: opts.maxModelCalls ?? FULL_REJUDGE_MAX_MODEL_CALLS,
        ...(opts.backupFile === undefined ? {} : { backupFile: opts.backupFile }),
        ...(options.validator === undefined ? {} : { validator: options.validator }),
        ...(opts.onProgress === undefined ? {} : { onProgress: opts.onProgress }),
        spend: () => rejudgeSpendOf(meter.report()),
      });
      log(`记忆全量重判一次：变了 ${report.changes.length} 条结论，调了 ${report.modelCalls} 次模型`);
      return { state: "ran", report, meter: meter.report() };
    } catch (err) {
      if (isAbort(err) || signal.aborted) throw abortError(isAbort(err) ? undefined : err);
      log(`记忆全量重判一次出错：${messageOf(err)}`);
      return { state: "failed", reason: messageOf(err), meter: meter.report() };
    } finally {
      engine?.close();
    }
  };

  /**
   * 242 号票：到点时作业不自己调 runNightly，先叫挂上的那个（记忆管理员被唤醒、在它那一轮里调 run）。
   * 管理员那一轮没调成（起不来、没听明白）时照旧自己补跑一次——整理这条确定性路径一定走，不能因为管理员出问题就整夜不整理。
   * 管理员那一轮里抛错只记日志，不把作业弄崩；中止（守护进程停止）照旧往上抛，内部作业当没跑过
   */
  const runMaybeThroughWake = async (trigger: JobTrigger, signal: AbortSignal): Promise<MemoryNightlyRecord | undefined> => {
    if (wake === undefined) return start(trigger, signal);
    const before = appended;
    let result: MemoryNightlyWakeResult | undefined;
    try {
      result = await wake({ trigger, signal, run: (t, s) => start(t, s) });
    } catch (err) {
      if (isAbort(err)) throw err;
      log(`记忆管理员的唤醒出错，这一夜照旧整理：${messageOf(err)}`);
    }
    throwIfAborted(signal);
    if (appended !== before) {
      // 管理员那一轮自己跑了整理：把管理员额外花的调用次数补进同一条整理记录（一夜还是一条，后写的覆盖先前的）
      if (result?.record !== undefined && result.modelCalls > 0) {
        append({
          ...result.record,
          curatorModelCalls: result.modelCalls,
          ...(result.budgetExhausted === true ? { curatorBudgetExhausted: true } : {}),
        });
      }
      return result?.record;
    }
    if (result !== undefined && result.modelCalls > 0) log(`记忆管理员这一夜调了 ${result.modelCalls} 次模型，但没有自己跑整理：作业补跑一次`);
    else log("记忆管理员这一夜没有自己跑整理，作业补跑一次");
    return start(trigger, signal);
  };

  const job: InternalJob = { name: MEMORY_NIGHTLY_JOB, schedule: MEMORY_NIGHTLY_SCHEDULE, run: (trigger, signal) => runMaybeThroughWake(trigger, signal) };

  return {
    job,
    run,
    async runNow() {
      // 正在跑的那一次（推后的那个可能睡到 05:00）不叠着开第二个引擎：这一夜交给它，回一句"正在整理"
      if (running !== undefined) {
        const at = clockIso(options.clock);
        const record = blankRecord(localDate(at), at, "deferred", "manual");
        record.reason = t("memory.nightly.reason.busy");
        return append(record);
      }
      return start("manual", controller.signal, true);
    },
    async runFullRejudge(opts: FullRejudgeJobOptions = {}) {
      // 正在整理（或者正在重判）时不叠着开第二个引擎
      if (running !== undefined) return { state: "busy", reason: t("memory.nightly.reason.busy") };
      const task = fullRejudge(opts, controller.signal);
      const idle = task.then(
        () => undefined,
        () => undefined,
      );
      running = idle;
      void idle.finally(() => {
        if (running === idle) running = undefined;
      });
      return task;
    },
    wakeWith(handler) {
      // 同一时间只挂一个（再挂就换掉；记忆管理员重装时是这个顺序）
      wake = handler;
      return () => {
        if (wake === handler) wake = undefined;
      };
    },
    abort(reason?: unknown) {
      controller.abort(reason);
    },
    async whenIdle() {
      let current = running;
      while (current !== undefined) {
        await current.catch(() => {});
        current = running;
      }
    },
  };
}
