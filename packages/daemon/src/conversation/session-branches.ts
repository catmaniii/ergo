// 会话树在守护进程这一侧（150 号票，形状和推导在共享协议包的 session-branches.ts）：
// - 派生视图 session_branches：每个会话最新的会话树（会话频道上最新一条 session_branch 带着整棵），重建时照样从事件日志归并；
// - 当前路径上的事件：往上翻历史（history.ts 的 historyPage）、第一次订阅补发哪一页（firstReplayAfter）、回退点的校验都沿当前分支取；
// - 第一次订阅时最新那条 session_branch 落在补发的一页之前，网关先补发它（前端据此认出哪些是废弃分支上的）；
// - 素材在不在废弃分支里（检索时排在后面，用户定的第 3 条）。
import {
  CHANNELS,
  type ConversationBranches,
  EVENT_TYPES,
  isChannel,
  MAINTAINER_CHANNEL_PREFIX,
  onBranchPath,
  pathRanges,
  type SessionBranchEventPayload,
  SINGLE_BRANCH,
} from "@ergo/protocol";
import type { DerivedView, EventStore, StoredEvent } from "../events/event-store.ts";
import type { ReadonlyDatabase } from "../storage/sqlite.ts";

export const sessionBranchesView: DerivedView = {
  name: "session_branches",
  create: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_branches (
        conversation TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        tree TEXT NOT NULL
      );
    `);
  },
  clear: (db) => db.exec("DELETE FROM session_branches"),
  apply(db, event) {
    if (event.type !== EVENT_TYPES.sessionBranch) return;
    const { branches } = event.payload as SessionBranchEventPayload;
    db.run(
      "INSERT INTO session_branches (conversation, seq, tree) VALUES (?, ?, ?) ON CONFLICT (conversation) DO UPDATE SET seq = excluded.seq, tree = excluded.tree",
      event.channel,
      event.seq,
      JSON.stringify(branches),
    );
  },
};

/** 这个会话现在的会话树；没回退过的只有最初那条 */
export function branchTreeOf(db: ReadonlyDatabase, conversation: string): ConversationBranches {
  const row = db.get<{ tree: string }>("SELECT tree FROM session_branches WHERE conversation = ?", conversation);
  return row ? (JSON.parse(row.tree) as ConversationBranches) : SINGLE_BRANCH;
}

/** 最新那条 session_branch 在会话频道上的序号；没回退过是 undefined */
export function latestBranchSeq(db: ReadonlyDatabase, conversation: string): number | undefined {
  const row = db.get<{ seq: number }>("SELECT seq FROM session_branches WHERE conversation = ?", conversation);
  return row ? Number(row.seq) : undefined;
}

/**
 * 当前路径上序号小于 before 的最后 limit 条事件（给了 type 就只取这一类），按序号从早到晚。没回退过的就是 readBefore；
 * 回退过的按当前路径上的序号段从后往前取（废弃分支上的跳过）
 */
export function pathEventsBefore(store: EventStore, conversation: string, before: number, limit: number, type?: string): StoredEvent[] {
  const tree = branchTreeOf(store.reader, conversation);
  if (tree.branches.length === 1) return store.readBefore(conversation, before, limit, type);
  const ranges = pathRanges(tree);
  const out: StoredEvent[] = [];
  for (let i = ranges.length - 1; i >= 0 && out.length < limit; i--) {
    const range = ranges[i]!;
    const upper = Math.min(before, range.to);
    if (upper <= range.from) continue;
    out.unshift(...store.readBefore(conversation, upper, limit - out.length, type).filter((e) => e.seq >= range.from));
  }
  return out;
}

/**
 * 第一次订阅时要先补发的：最新那条 session_branch 落在补发的起点之前（from 之后的才补发）时就是它，前端据此认出补发的这一页里
 * 哪些在废弃分支上、分叉在哪；落在之后的照常补发，不用另给
 */
export function pinnedReplay(store: EventStore, conversation: string, from: number): StoredEvent[] {
  const seq = latestBranchSeq(store.reader, conversation);
  if (seq === undefined || seq > from) return [];
  const event = store.eventAt(conversation, seq);
  return event ? [event] : [];
}

/** 是不是一个会话频道（秘书会话、某个维护者的会话） */
function conversationChannel(channel: string): boolean {
  return isChannel(channel) && (channel === CHANNELS.secretary || channel.startsWith(MAINTAINER_CHANNEL_PREFIX));
}

/**
 * 一条事件在不在废弃分支上（用户定的第 3 条：废弃分支里的话照样留在素材里，标"在废弃分支里"，检索时排在当前分支的后面）。
 * 不是会话频道上的、会话没回退过的都不在
 */
export function inAbandonedBranch(db: ReadonlyDatabase, event: { channel: string; seq: number }): boolean {
  if (!conversationChannel(event.channel)) return false;
  const tree = branchTreeOf(db, event.channel);
  return tree.branches.length > 1 && !onBranchPath(tree, event.seq);
}

/**
 * 别的频道上的事件（守卫频道的 plan_call_committed、看板上的事件……）在不在这个会话当前分支的路径上（153 号票：流程的计划核对按保留的
 * 分支重建）：看它前面最后一条会话事件——那条在当前路径上（或者会话里那时还没有事件），它就在。和 tasks/session-follow.ts 的 onPathAt
 * 同一个口径，只是不把整个会话频道读出来：路径上每一段 [from, to) 换成全局序号的窗口（from 那条的全局序号 < g < to 那条的全局序号）。
 * 没回退过的一律在
 */
export function foreignOnPath(store: EventStore, conversation: string): (globalSeq: number) => boolean {
  const tree = branchTreeOf(store.reader, conversation);
  if (tree.branches.length === 1) return () => true;
  const globalAt = (seq: number) => (Number.isFinite(seq) ? (store.eventAt(conversation, seq)?.globalSeq ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY);
  const first = store.eventAt(conversation, 1)?.globalSeq ?? Number.POSITIVE_INFINITY;
  // 从头开始的那一段（序号从 1 起）：前面最后一条会话事件只要有就不早于它
  const windows = pathRanges(tree).map((r) => ({ lo: r.from <= 1 ? 0 : globalAt(r.from), hi: globalAt(r.to) }));
  return (g) => g < first || windows.some((w) => w.lo < g && g < w.hi);
}
