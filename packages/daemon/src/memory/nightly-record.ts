// 每晚整理的整理记录（225 号票）：整理跑没跑、新增 / 变化 / 标着复核（329 号票前叫待复核）、问题箱的变化、调了几次模型、为什么没跑成。
//
// - 事件日志（守护进程内部的 internal 频道，前端不订阅；和 internal_jobs 并列的另一类）：每跑一次、推后一次、跳过、失败
//   都追加一条，事后可查（EventStore.read / ofType）；
// - 派生视图 `memory_nightly`（ergo.db，一夜一条，后来的覆盖先前的）：233、235 的网页展示和看板从这里读；
// - 完整的 `NightlyReport`（含每条结论、问题的原文）在 rg.db 的 `nightly_runs` 表里，由 @ergo/memory 写；这里只记摘要和给
//   人看的一段文字，不重复存结论原文。素材的原文不进这里。
import type { DerivedView, EventStore } from "../events/event-store.ts";
import type { JobTrigger } from "../scheduler/internal-jobs.ts";
import { INTERNAL_CHANNEL } from "../scheduler/internal-jobs.ts";
import type { ReadonlyDatabase } from "../storage/sqlite.ts";

/** internal 频道上的事件类型：一条整理记录 */
export const MEMORY_NIGHTLY_EVENT = "memory_nightly";

/**
 * 一次整理（或者没跑成）的状态：
 * - ran：整理跑了，有报告；
 * - deferred：这一夜还没跑（没到点、用户在用往后推、这一夜已经跑过）；
 * - skipped：没法跑（没配模型 key），下一夜照常；
 * - failed：跑了但出错（模型不可用、库打不开……），素材不动，下一夜接着做；
 * - rebuild_needed：推理库的版本对不上、要重建，不自动迁移
 */
export type MemoryNightlyState = "ran" | "deferred" | "skipped" | "failed" | "rebuild_needed";

/** 问题箱的变化（这一夜）：新出、判了、不用问、过期、问了没答、跳过两次退下、整理完还开着几个 */
export interface MemoryNightlyQuestions {
  added: number;
  resolved: number;
  obsolete: number;
  expired: number;
  skipped: number;
  retired: number;
  open: number;
}

/**
 * 283 号票：个人档案的联动这一夜做了什么——认人物信息问了几次模型、看了几条话、认出几个人、新攒几条候选、合成的候选核对卡、
 * 档案里换过的值让几条旧事实到期
 */
export interface MemoryNightlyPeople {
  calls: number;
  scanned: number;
  mentions: number;
  candidates: number;
  cardId?: string;
  expiredFacts: number;
}

/** 对抗复核这一夜的结果（263 号票） */
export interface MemoryNightlyReview {
  reviewed: number;
  rejected: number;
  unclear: number;
}

/** 预测账本这一夜的变化（263 号票） */
export interface MemoryNightlyPredictions {
  created: number;
  judged: number;
  hit: number;
  miss: number;
  unclear: number;
  open: number;
  /** 330 号票（R10）：落空以后往回打来源——撤了几条错的前提、可废止的挨了几条反证、判不出的几条、前提都已验证挨反例的几条（没落空的夜里没有） */
  backprop?: { retracted: number; countered: number; undetermined: number; counterexamples: number };
}

/**
 * 270 号票：这一夜的模型调用按道分（两次整理合起来）：新证据、判回答（271）、重跑旧追问、往上抽、判预测、编策略（@ergo/memory 的 ReflectSpend），
 * 加上对抗复核自己那份（不占上限）。limit 是这一夜引擎的上限（memory.maxModelCalls）
 */
export interface MemoryNightlySpend {
  limit: number;
  newEvidence: number;
  /** 271 号票：判顺口问的回答（271 以前的记录没有） */
  replies?: number;
  rejudge: number;
  lift: number;
  predictions: number;
  strategies: number;
  review: number;
}

/** 271 号票：记忆管理员这一夜判顺口问的回答：问了几次模型、答了几个、没答（算跳过）几个、拿不准几个、没轮到几个 */
export interface MemoryNightlyReplies {
  calls: number;
  answered: number;
  notAnswered: number;
  unsure: number;
  waiting: number;
}

/**
 * 267 号票：每晚校验这一夜的结果（326 号票起是记忆系统自己的图谱自检）：通过、不合格（报了几个问题、加复核标记几条、降回猜测几条）、跳过（为什么）
 */
export interface MemoryNightlyValidation {
  state: "ok" | "failed" | "skipped";
  /** 校验器报了几个问题 */
  problems: number;
  /** 因此加了复核标记的结论（329 号票前是转待复核的） */
  claimIds: string[];
  /** 跳过的原因（校验器出错） */
  reason?: string;
  /** 329 号票：违反传播铁律、这一夜降回猜测的结论（326 号票的老记录里是降成假设的；更早的记录没有） */
  downgraded?: string[];
}

/** 326 号票：这一夜在结论和假设之间换了的（前提里有拿不准的事实降成假设；冲突解决升回结论）。329 号票起身份锁死，不再写，只在老记录里 */
export interface MemoryNightlyHypotheses {
  downgraded: string[];
  upgraded: string[];
}

/** 一条整理记录（事件负载就是它，视图里按夜存 JSON） */
export interface MemoryNightlyRecord {
  /** 哪一夜（本地日期 YYYY-MM-DD） */
  night: string;
  /** 记这条的时间 */
  at: string;
  state: MemoryNightlyState;
  /** 这次为什么跑（到点、启动时补错过的） */
  trigger: JobTrigger;
  /** 没跑成 / 推后的原因，给人看的一句话 */
  reason?: string;
  /** 跑起来的时间（只在 ran 时有） */
  ranAt?: string;
  /** 推到了最晚的时间才跑（或者错过了补跑） */
  late?: boolean;
  /** 这一夜用户在用，往后推了几次 */
  deferrals: number;
  /** 新出的结论条数 */
  newClaims: number;
  /** 状态、置信度变了的旧结论条数 */
  changedClaims: number;
  /** 跑之前标着复核、这一夜重判了的条数 */
  reviewed: number;
  /** 跑完还标着复核的条数 */
  needsReview: number;
  questions: MemoryNightlyQuestions;
  /** 这一夜调了几次模型（两次整理都算，含抽事实、判预测，加上对抗复核自己那份；不含记忆管理员自己的 curatorModelCalls） */
  modelCalls: number;
  /** 预算用完、没做完（下一夜接着做） */
  budgetExhausted: boolean;
  /** 这一夜整理完几条证据（两次整理合起来；270 号票起整理完一条算一条，预算用完时没轮到的不算） */
  processedEvidence: number;
  /** 跑完还剩几条有效证据没整理（236：首次建库要处理现有 500+ 条素材，看它几夜做完；270：积压的按时间先后接着做） */
  pendingEvidence: number;
  /** 270 号票：这一夜的调用按道分（只在 ran 时有；以前的记录没有） */
  spend?: MemoryNightlySpend;
  /** 271 号票：判顺口问的回答（只在 ran 时有；以前的记录没有） */
  replies?: MemoryNightlyReplies;
  /**
   * 263 号票：对抗复核（227，两次整理合起来）：复核了几条、判不一致加复核标记几条、拿不准几条。只在 ran 时有；
   * 以前的记录（线上还没接复核时）没有这个字段
   */
  review?: MemoryNightlyReview;
  /** 263 号票：预测账本（226）：新记几条、到期判了几条（应验、落空、说不清）、整理完还开着几条。只在 ran 时有 */
  predictions?: MemoryNightlyPredictions;
  /** 267 号票：每晚校验（只在 ran 且接了校验器时有） */
  validation?: MemoryNightlyValidation;
  /** 267 号票：这一夜唯一写入口拒了几处（原因进了整理报告；只在 ran 时有） */
  refused?: number;
  /** 326 号票：结论 ↔ 假设（326 号票的老记录才有；329 号票起不再写） */
  hypotheses?: MemoryNightlyHypotheses;
  /** 283 号票：个人档案的联动（只在 ran、档案在的时候有；认人物信息问的模型次数也算进了 modelCalls） */
  people?: MemoryNightlyPeople;
  /**
   * 242 号票：记忆管理员这一夜自己额外调了几次模型（叙述、判断用；引擎那 maxModelCalls 是另一份预算）。
   * 管理员没起来、这一夜没有日记时没有这个字段
   */
  curatorModelCalls?: number;
  /** 242 号票：管理员这一夜自己的预算跑满、被停下了（下一夜照常） */
  curatorBudgetExhausted?: boolean;
  /** 整理报告拼好的一段（只在 ran 时有） */
  text?: string;
}

/** 派生视图：一夜一条整理记录 */
export const memoryNightlyView: DerivedView = {
  name: "memory_nightly",
  channels: [INTERNAL_CHANNEL],
  create: (db) =>
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_nightly (
        night TEXT PRIMARY KEY,
        at TEXT NOT NULL,
        state TEXT NOT NULL,
        record TEXT NOT NULL
      );
    `),
  clear: (db) => db.exec("DELETE FROM memory_nightly"),
  apply(db, event) {
    if (event.channel !== INTERNAL_CHANNEL || event.type !== MEMORY_NIGHTLY_EVENT) return;
    const record = event.payload as Partial<MemoryNightlyRecord>;
    if (typeof record.night !== "string" || typeof record.at !== "string" || typeof record.state !== "string") return;
    db.run(
      `INSERT INTO memory_nightly (night, at, state, record) VALUES (?, ?, ?, ?)
       ON CONFLICT (night) DO UPDATE SET at = excluded.at, state = excluded.state, record = excluded.record`,
      record.night,
      record.at,
      record.state,
      JSON.stringify(record),
    );
  },
};

/** 记一条整理记录（事件日志 + 视图在同一个事务里） */
export function appendNightlyRecord(store: Pick<EventStore, "append">, record: MemoryNightlyRecord): MemoryNightlyRecord {
  store.append({ channel: INTERNAL_CHANNEL, type: MEMORY_NIGHTLY_EVENT, payload: record });
  return record;
}

/** 全部整理记录，按夜从早到晚（233、235 的展示用） */
export function listNightlyRecords(db: ReadonlyDatabase): MemoryNightlyRecord[] {
  return db.all<{ record: string }>("SELECT record FROM memory_nightly ORDER BY night").map((row) => JSON.parse(row.record) as MemoryNightlyRecord);
}

/** 最近一夜的整理记录（没有是 undefined） */
export function latestNightlyRecord(db: ReadonlyDatabase): MemoryNightlyRecord | undefined {
  const row = db.get<{ record: string }>("SELECT record FROM memory_nightly ORDER BY night DESC LIMIT 1");
  return row === undefined ? undefined : (JSON.parse(row.record) as MemoryNightlyRecord);
}

/** 某一夜的整理记录（没有是 undefined） */
export function nightlyRecordOf(db: ReadonlyDatabase, night: string): MemoryNightlyRecord | undefined {
  const row = db.get<{ record: string }>("SELECT record FROM memory_nightly WHERE night = ?", night);
  return row === undefined ? undefined : (JSON.parse(row.record) as MemoryNightlyRecord);
}
