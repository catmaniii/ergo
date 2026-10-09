// 工具调用完整内容的保留期和总量上限（65 号票，ADR-0024）：53 号票起每次调用的完整参数和返回都另存一份
// （tool-call-details.ts），不清就一直涨。这里定时清（用户 2026-10-09 定：保留 90 天、上限 2 GB，每天凌晨清一次）：
// - 过了保留期（默认 90 天，按存下的时间算）的清掉；
// - 清完总量还超过上限（默认 2 GB）的，从最旧的起清到上限以内；
// - 还被用着的不清（callsInUse）：没结束的任务（含流程）里的调用、还在待办里（没删、没归档）的事项引用到的调用
//   （哪些卡片、通知会引用调用见 CALL_REFERENCES 这张表），外加还没决定的审批（审批卡被归档了也算）；
// - 清掉的只是完整内容：换成只剩摘要的样子（tool-call-details.ts 的 clearedDetail），工具调用记录、要点、效果记录、
//   时间线都不动；详情接口照样回 200，cleared 注明原因。
// 怎么跑：内部作业（scheduler/internal-jobs.ts）每天 04:15 一次，错过了开机后补一次（异步，不挡启动）；设置里的"现在就清理"
// 也走同一套（cleanup("manual")）。同一时间只跑一次（后来的排在后面）。一批最多 BATCH 条一个事务，批与批之间让出事件循环，
// 守护进程停止时中止。每跑一次写一行日志：清了多少、腾出多少、还被用着没清的有几次、现在占多大。
import {
  type ApprovalCardPayload,
  type Card,
  interruptedNoticeData,
  type NoticeInboxItem,
  nowIso,
  type QuickActionCardPayload,
  type ToolCallCleanupResult,
  type ToolCallClearReason,
  type ToolCallStorageView,
  UNFINISHED_TASK_STATES,
} from "@ergou/protocol";
import { getApproval, listApprovals } from "../approvals/views.ts";
import { getCard } from "../cards/views.ts";
import type { ToolCallDetailLimits } from "../config/config.ts";
import type { EventStore } from "../events/event-store.ts";
import type { HandOverData } from "../hand-over/hand-over.ts";
import { listInboxItems } from "../inbox/views.ts";
import { sizeLabel } from "../media/file-types.ts";
import type { Clock } from "../scheduler/clock.ts";
import type { InternalJobs } from "../scheduler/internal-jobs.ts";
import type { ReadonlyDatabase } from "../storage/sqlite.ts";
import { listTasks } from "../tasks/views.ts";
import { clearDetails, detailTotals, fullDetails, type StoredDetail } from "./tool-call-details.ts";

/** 内部作业的名字和时间：每天 04:15（在每晚备份 03:30、清理临时区 04:00 之后） */
export const DETAIL_RETENTION_JOB = "tool_call_detail_retention";
export const DETAIL_RETENTION_TIME = "04:15";

/** 一个事务最多清几条（每条要读回完整内容再改写），批与批之间让出事件循环 */
const BATCH = 100;
const DAY_MS = 86_400_000;

export interface ToolCallDetailRetention {
  /** 登记内部作业（每天定时清） */
  start(): void;
  /** 设置里显示的：现在占多大、规则、照现在的规则马上清会清掉多少 */
  view(): ToolCallStorageView;
  /** 按现在的规则清一次（定时的、设置里"现在就清理"的）；同一时间只跑一次，后来的等前一次跑完再跑 */
  cleanup(trigger: ToolCallCleanupResult["trigger"], signal?: AbortSignal): Promise<ToolCallCleanupResult>;
}

export interface ToolCallDetailRetentionOptions {
  store: EventStore;
  internalJobs: InternalJobs;
  clock: Clock;
  limits: ToolCallDetailLimits;
  log: (line: string) => void;
}

/** 还被用着、不能清的：没结束的任务，和待办里引用着的调用 */
export interface InUse {
  tasks: ReadonlySet<string>;
  calls: ReadonlySet<string>;
}

/** 待办里一种会引用工具调用的卡片或通知：从它身上怎么找到那次调用（找不到是空的） */
export type CallReference =
  | { kind: "card"; cardType: string; what: string; callIds(card: Card, db: ReadonlyDatabase): readonly string[] }
  | { kind: "notice"; notice: string; what: string; callIds(item: NoticeInboxItem): readonly string[] };

const oneId = (id: unknown): readonly string[] => (typeof id === "string" ? [id] : []);

/**
 * 待办里会引用一次工具调用的卡片和通知（还在待办里的，引用到的调用不清）。
 * 以后新加的卡片、通知要引用一次工具调用（让用户看着那次调用决定什么），在这里加一行
 */
export const CALL_REFERENCES: readonly CallReference[] = [
  { kind: "card", cardType: "approval", what: "审批卡：等你批准的那次调用（记在审批表里）", callIds: (card, db) => oneId(getApproval(db, (card.payload as Partial<ApprovalCardPayload>).approvalId ?? "")?.toolCallId) },
  { kind: "card", cardType: "quick_action", what: "快速动作卡：提出这个动作的那次调用", callIds: (card) => oneId((card.payload as Partial<QuickActionCardPayload>).toolCallId) },
  { kind: "notice", notice: "hand_over", what: "交给我做：要你亲手做的那次调用", callIds: (item) => oneId((item.data as Partial<HandOverData> | undefined)?.toolCallId) },
  { kind: "notice", notice: "interrupted", what: "中断不确定：说不清做没做完的那次调用", callIds: (item) => oneId(interruptedNoticeData(item)?.toolCallId) },
];

/** 现在还被用着的：没结束的任务（含流程）、待办里还在（没删、没归档）的事项引用到的调用（CALL_REFERENCES）、还没决定的审批 */
export function callsInUse(db: ReadonlyDatabase): InUse {
  const tasks = new Set(listTasks(db).flatMap((t) => (UNFINISHED_TASK_STATES.includes(t.state) ? [t.id] : [])));
  const calls = new Set<string>();
  const add = (ids: readonly string[]) => ids.forEach((id) => calls.add(id));
  for (const item of listInboxItems(db)) {
    if (item.archived) continue;
    if (item.kind === "notice") for (const ref of CALL_REFERENCES) if (ref.kind === "notice" && ref.notice === item.notice) add(ref.callIds(item));
    const card = item.cardId === undefined ? undefined : getCard(db, item.cardId);
    if (card) for (const ref of CALL_REFERENCES) if (ref.kind === "card" && ref.cardType === card.type) add(ref.callIds(card, db));
  }
  for (const approval of listApprovals(db, "pending")) calls.add(approval.toolCallId);
  return { tasks, calls };
}

const inUseBy = (inUse: InUse) => (d: StoredDetail) => inUse.calls.has(d.callId) || (d.taskId !== null && inUse.tasks.has(d.taskId));

/** 照现在的规则该清的（从旧到新，带原因），和到了该清的时候、但还被用着没清的有几次 */
export interface CleanupPlan {
  due: { detail: StoredDetail; reason: ToolCallClearReason }[];
  keptInUse: number;
}

/**
 * 照现在的规则该清哪些（纯函数）：先是过了保留期的；清完总量还超过上限的，从最旧的起往后挑到上限以内。
 * 超出上限的按清掉之后一个字节不剩估（剩下的摘要不算）：估少了没关系，清完重新算一遍还超就再挑（宁可少清，不多清）。
 * 还被用着的跳过，记一次 keptInUse
 */
export function planCleanup(details: readonly StoredDetail[], totalBytes: number, nowMs: number, limits: ToolCallDetailLimits, inUse: InUse): CleanupPlan {
  const used = inUseBy(inUse);
  const cutoff = nowMs - limits.retentionDays * DAY_MS;
  const due: CleanupPlan["due"] = [];
  let keptInUse = 0;
  let remaining = totalBytes;
  const rest: StoredDetail[] = [];
  for (const detail of details) {
    if (detail.savedMs >= cutoff) rest.push(detail);
    else if (used(detail)) keptInUse += 1;
    else {
      due.push({ detail, reason: "expired" });
      remaining -= detail.bytes;
    }
  }
  for (const detail of rest) {
    if (remaining <= limits.maxBytes) break;
    if (used(detail)) {
      keptInUse += 1;
      continue;
    }
    due.push({ detail, reason: "over_limit" });
    remaining -= detail.bytes;
  }
  return { due, keptInUse };
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export function createToolCallDetailRetention(options: ToolCallDetailRetentionOptions): ToolCallDetailRetention {
  const { store, internalJobs, clock, limits, log } = options;
  /** 上一次（或者正在跑的）清理：后来的排在它后面 */
  let last: Promise<unknown> = Promise.resolve();

  const plan = () => planCleanup(fullDetails(store.reader), detailTotals(store.reader).bytes, clock.now(), limits, callsInUse(store.reader));

  const run = async (trigger: ToolCallCleanupResult["trigger"], signal: AbortSignal | undefined): Promise<ToolCallCleanupResult> => {
    const at = nowIso(new Date(clock.now()));
    const counts: Record<ToolCallClearReason, number> = { expired: 0, over_limit: 0 };
    let freedBytes = 0;
    let keptInUse = 0;
    // 清完一轮重新算：超出上限的估的是清掉之后一个字节不剩，剩下的摘要可能让总量还超一点。
    // 一轮下来一条都没清掉（挑出来的都已经不是完整的了）就停，免得空转
    for (let progressed = true; progressed; ) {
      const next = plan();
      keptInUse = next.keptInUse;
      progressed = false;
      for (let i = 0; i < next.due.length; i += BATCH) {
        signal?.throwIfAborted();
        const batch = next.due.slice(i, i + BATCH).map(({ detail, reason }) => ({ globalSeq: detail.globalSeq, reason }));
        const done = clearDetails(store, batch, at);
        for (const { reason } of done.cleared) counts[reason] += 1;
        freedBytes += done.freedBytes;
        progressed ||= done.cleared.length > 0;
        await yieldToEventLoop();
      }
    }
    const totals = detailTotals(store.reader);
    const result: ToolCallCleanupResult = {
      trigger,
      at,
      expired: counts.expired,
      overLimit: counts.over_limit,
      freedBytes,
      keptInUse,
      bytes: totals.bytes,
      calls: totals.full,
    };
    log(
      `工具调用的完整内容${trigger === "manual" ? "（设置里点了现在就清理）" : ""}：清掉 ${result.expired + result.overLimit} 次（过了保留期 ${result.expired} 次、超出总量上限 ${result.overLimit} 次），` +
        `腾出 ${sizeLabel(freedBytes)}；还被用着没清 ${keptInUse} 次；现在占 ${sizeLabel(totals.bytes)}（存着完整内容的 ${totals.full} 次，保留 ${limits.retentionDays} 天、上限 ${sizeLabel(limits.maxBytes)}）`,
    );
    return result;
  };

  const cleanup: ToolCallDetailRetention["cleanup"] = (trigger, signal) => {
    const mine = last.catch(() => undefined).then(() => run(trigger, signal));
    last = mine;
    return mine;
  };

  return {
    start() {
      internalJobs.register({ name: DETAIL_RETENTION_JOB, schedule: { kind: "daily", time: DETAIL_RETENTION_TIME }, run: (_trigger, signal) => cleanup("scheduled", signal) });
    },
    view() {
      const totals = detailTotals(store.reader);
      const next = plan();
      return {
        bytes: totals.bytes,
        calls: totals.full,
        cleared: totals.cleared,
        retentionDays: limits.retentionDays,
        maxBytes: limits.maxBytes,
        due: { calls: next.due.length, bytes: next.due.reduce((sum, d) => sum + d.detail.bytes, 0), inUse: next.keptInUse },
      };
    },
    cleanup,
  };
}
