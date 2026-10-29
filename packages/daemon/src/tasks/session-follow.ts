// 任务状态跟着维护者的会话树走（152 号票，用户定的第 6 条：阶段的状态按保留下来的
// 分支重新推导，会话回退、切换分支之后都调它）。纯函数，执行控制器（execution.ts 的 followSession）调用。
//
// 要是计划、阶段状态都在会话里（工具调用的结果），按分支推导就是只看这条分支上的条目；可二狗的任务状态在事件日志的看板频道里
// （task 事件，每条是任务那一刻的整个样子），计划在 tasks 频道里，都不在会话里。所以先把它们对到会话树上：一条看板 / tasks 频道的事件
// 落在会话频道上它前面最后一条事件之后，那条会话事件在不在某条分支的路径上，它就在不在（session-branches 的 onBranchPath）。
// 然后"按保留的分支推导"就是：在这条路径上、回退点之前的最后一条 task 事件是那时任务的样子（taskAt），最后一版生效的计划是那时的计划
// （planInForce）。
// 推出来的那一刻的样子再整理一下（normalizedStages）：那时在验收的（结论是在被放弃的那段里出的、或者永远出不来了）、那时在等的事已经
// 不在等了（被放弃的那段里处理了、作废了）的，回到能开始，运行时再替维护者开始。
import { type ConversationBranches, onBranchPath, type Plan, type Task, type TaskEventPayload, type TaskStage } from "@ergo/protocol";
import type { NewEvent, StoredEvent } from "../events/event-store.ts";
import { type GrantRenewalDecidedPayload, type GrantTimes, type PlanDecidedPayload, type PlanRevisedPayload, TASK_EVENTS } from "./events.ts";
import { stageNow } from "./stages.ts";

/** 会话频道上每条事件的序号和全局序号（按序号从早到晚） */
export interface ConversationIndex {
  readonly seqs: readonly number[];
  readonly globals: readonly number[];
}

export function conversationIndex(events: readonly Pick<StoredEvent, "seq" | "globalSeq">[]): ConversationIndex {
  return { seqs: events.map((e) => e.seq), globals: events.map((e) => e.globalSeq) };
}

/** 全局序号 g 的事件在会话频道上落在哪条之后（它前面最后一条会话事件的序号；会话里还没有事件时是 0） */
export function positionOf(index: ConversationIndex, g: number): number {
  let lo = 0;
  let hi = index.globals.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (index.globals[mid]! < g) lo = mid + 1;
    else hi = mid;
  }
  return lo === 0 ? 0 : index.seqs[lo - 1]!;
}

/** 别的频道的一条事件（全局序号 g）在不在这棵树当前分支的路径上：看它前面最后一条会话事件 */
export function onPathAt(tree: ConversationBranches, index: ConversationIndex, g: number): boolean {
  const s = positionOf(index, g);
  return s === 0 || onBranchPath(tree, s);
}

/** 路径上、boundary（全局序号，不含）之前这个任务最后的样子；没有是 undefined */
export function taskAt(history: readonly StoredEvent[], taskId: string, onPath: (g: number) => boolean, boundary = Number.POSITIVE_INFINITY): Task | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const e = history[i]!;
    if (e.globalSeq >= boundary) continue;
    const { task } = e.payload as TaskEventPayload;
    if (task.id !== taskId || !onPath(e.globalSeq)) continue;
    return task;
  }
  return undefined;
}

/** 路径上那时生效的计划：哪一版（planId）、计划、每项授权的授予和到期时间（续期过的按续期后的） */
export interface PlanInForce {
  planId: string;
  revision: number;
  plan: Plan;
  grantTimes?: GrantTimes;
}

/**
 * 路径上、boundary 之前最后一版生效的计划（当前分支上最近一次被授权的计划）：确认的、自行调整（含运行时、
 * 你改的）那一版生效；生效的那一版被撤回会话作废（回到计划确认之前）就没有生效的了；续期改了它的授权时间。没有确认过的是 undefined
 */
export function planInForce(events: readonly StoredEvent[], taskId: string, onPath: (g: number) => boolean, boundary = Number.POSITIVE_INFINITY): PlanInForce | undefined {
  let current: PlanInForce | undefined;
  for (const e of events) {
    if (e.globalSeq >= boundary) break;
    if (!onPath(e.globalSeq)) continue;
    switch (e.type) {
      case TASK_EVENTS.planDecided: {
        const p = e.payload as PlanDecidedPayload;
        if (p.taskId !== taskId) break;
        if (p.decision === "confirmed" && p.plan) current = { planId: p.planId, revision: p.revision, plan: p.plan, ...(p.grantTimes ? { grantTimes: p.grantTimes } : {}) };
        else if (p.decision === "voided" && current?.planId === p.planId) current = undefined;
        break;
      }
      case TASK_EVENTS.planRevised: {
        const p = e.payload as PlanRevisedPayload;
        if (p.taskId === taskId) current = { planId: p.planId, revision: p.revision, plan: p.plan, grantTimes: p.grantTimes };
        break;
      }
      case TASK_EVENTS.grantRenewalDecided: {
        const p = e.payload as GrantRenewalDecidedPayload;
        if (p.taskId === taskId && p.decision === "renewed" && p.grantTimes && current?.planId === p.planId) current = { ...current, grantTimes: p.grantTimes };
        break;
      }
      default:
        break;
    }
  }
  return current;
}

/**
 * 推出来的那一刻各阶段的样子再整理一下（回退时这一轮被中止，没有在等的确认留下来）：
 * - 那时在验收的：结论是在被放弃的那段里出的（或者那次验收还没完、出来也作废），回到能开始——运行时再替维护者开始它、交代上次没过的；
 * - 那时在等的：在等的那件事还在等（stillWaiting）就接着等，已经处理了、作废了的回到能开始（和"一支不用再等了"一样，branchUnblocked）。
 * 别的（未开始、在做、已验收）照那时的样子
 */
export function normalizedStages(list: readonly TaskStage[], stillWaiting: (waitingOn: string) => boolean): TaskStage[] {
  return list.map((s) => {
    if (s.state === "accepting") return stageNow(s, "pending");
    if (s.state === "waiting" && (s.waitingOn === undefined || !stillWaiting(s.waitingOn))) return stageNow(s, "pending");
    return s;
  });
}

/** 跟着撤回变了的阶段（推出来的和现在的状态、交上来的次数、开始的时间不一样，或者现在没有这个阶段）：这几个阶段的这一轮重新算 */
export function changedStages(derived: readonly TaskStage[], current: readonly TaskStage[]): string[] {
  const now = new Map(current.map((s) => [s.stageId, s]));
  return derived.flatMap((s) => {
    const was = now.get(s.stageId);
    return was && was.state === s.state && was.attempts === s.attempts && was.startedAt === s.startedAt ? [] : [s.stageId];
  });
}

/** 会话树换了分支，任务跟着走要的（execution.ts 的 followSession）：哪个任务、要回到哪条路径、只看哪之前的 */
export interface SessionFollowInput {
  taskId: string;
  conversation: string;
  change: "rollback" | "switch";
  /** 要回到的路径：这棵树的当前分支（回退：回退之前的那棵树，路径截在 boundary 之前；切换：切换之后的那棵） */
  tree: ConversationBranches;
  /** 只看这之前的（全局序号，不含）：回退点；切换不给（整条路径） */
  boundary?: number;
  /** 撤回到长程任务一个阶段开始前（stage_start 记号里的阶段） */
  stage?: { stageId: string; title: string };
  /** 被放弃的那段（切换：离开的那条分支自己的那段；会话频道上的序号段）：里面还排着的这个任务的运行时通知作废出队 */
  abandoned: readonly { from: number; to: number }[];
  /** 被放弃的那段已经对外做了的（交给维护者接着做的那句里说） */
  external: readonly { toolTitle?: string; tool: string; argsSummary: string }[];
}

/** 跟着走要在同一事务里追加的事件；落盘之后要做的 */
export interface SessionFollowResult {
  events: NewEvent[];
  /** 被放弃的那段里排着、作废出队（不带到新分支）的输入（消息 id） */
  voidedInputs: ReadonlySet<string>;
  /** 作废了的卡（记进 session_branch 的 expiredCards） */
  expiredCards: readonly string[];
  /** 交给维护者接着做的那句（分支摘要说清楚了，界面上不重复显示） */
  notice?: string;
  /** 分支摘要那条消息的归属：这个任务、跟着走完之后它在做的阶段（时间线、阶段框据此把摘要放进重新开始的那个阶段）；任务状态不跟着走的没有 */
  scope?: { taskId: string; stageId?: string };
  afterCommit(): void;
}
