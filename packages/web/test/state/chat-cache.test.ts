// 手机本机存的聊天记录（457），纯函数那一半：存成什么、一段段怎么并、截，两棵会话树从哪起不一样，用本机存的怎么拼一页
// （照守护进程 conversation/history.ts 的 historyPage），哪些事件让它作废。
import { describe, expect, test } from "vitest";
import {
  absentRefsOf,
  type CachedRead,
  cachedPage,
  cacheEntryOf,
  chatCacheSignalOf,
  type ConversationBranches,
  grownTree,
  type HistoryMessage,
  type HistoryPage,
  nextBranchId,
  pathDivergence,
  rollbackFork,
  sameTree,
  SINGLE_BRANCH,
  spanAt,
  spanOfPage,
  spansBefore,
  switchedTree,
  withSpan,
} from "../../src/state/index.ts";
import { frame, textMessage } from "./events.ts";

const textAt = (seq: number): HistoryMessage => ({ seq, message: textMessage(`m${seq}`, "user", "x") });
const read = (seqs: number[], over: Partial<CachedRead> = {}): CachedRead => ({ newest: seqs.toReversed().map((s) => textAt(s)), records: [], stageStarts: [], voices: new Map(), agentVoices: new Map(), ...over });
const rollback = (tree: ConversationBranches, seq: number, at: number) => grownTree(tree, { id: nextBranchId(tree), ...rollbackFork(tree, { seq })! }, at, undefined);

describe("一段段怎么并、截", () => {
  test("交叠、挨着的并成一段，起点更早的那段说了算之前还有没有", () => {
    const spans = withSpan(withSpan([], { lo: 50, hi: 99, more: true }), { lo: 100, hi: 140, more: false });
    expect(spans).toEqual([{ lo: 50, hi: 140, more: true }]);
    expect(withSpan(spans, { lo: 200, hi: 210, more: false })).toEqual([
      { lo: 50, hi: 140, more: true },
      { lo: 200, hi: 210, more: false },
    ]);
    expect(withSpan(spans, { lo: 1, hi: 60, more: false })).toEqual([{ lo: 1, hi: 140, more: false }]);
    expect(spanAt(spans, 140)).toEqual({ lo: 50, hi: 140, more: true });
    expect(spanAt(spans, 141)).toBeUndefined();
  });

  test("会话树变了：截到分叉之前", () => {
    expect(spansBefore([{ lo: 1, hi: 100, more: false }, { lo: 120, hi: 130, more: false }], 90)).toEqual([{ lo: 1, hi: 89, more: false }]);
  });

  test("向电脑要来的一页给的一段：第一条消息（更早没有了的从 1）到 before - 1", () => {
    expect(spanOfPage(80, { conversation: "secretary", messages: [textAt(30), textAt(40)], records: [], hasMore: true })).toEqual({ lo: 30, hi: 79, more: true });
    expect(spanOfPage(80, { conversation: "secretary", messages: [textAt(30)], records: [], hasMore: false })).toEqual({ lo: 1, hi: 79, more: false });
  });
});

describe("两棵会话树的当前路径从哪起不一样", () => {
  test("没回退过的一样；回退到第 10 条之前：从 10 起不一样；切回原来那条也从 10 起", () => {
    expect(pathDivergence(undefined, SINGLE_BRANCH)).toBe(Number.POSITIVE_INFINITY);
    const one = rollback(SINGLE_BRANCH, 10, 20);
    expect(pathDivergence(undefined, one)).toBe(10);
    const back = switchedTree(one, "b0", 30, undefined);
    expect(pathDivergence(one, back)).toBe(10);
    // 在新分支上再回退一次（回到第 25 条之前）：前面都一样，从 25 起不一样
    const two = rollback(one, 25, 40);
    expect(pathDivergence(one, two)).toBe(25);
    expect(sameTree(undefined, SINGLE_BRANCH)).toBe(true);
    expect(sameTree(one, structuredClone(one))).toBe(true);
    expect(sameTree(one, two)).toBe(false);
  });
});

describe("用本机存的拼一页", () => {
  const query = { conversation: "secretary", limit: 3, onPath: () => true, toolVoices: {}, absent: new Set<string>() };

  test("多读出一条就知道更早还有；不够一页时从头起的到头了、不是从头起的说更早还有（下次向电脑要缺的）", () => {
    const full = cachedPage({ ...query, span: { lo: 1, hi: 99, more: false } }, read([10, 20, 30, 40]));
    expect(full?.messages.map((m) => m.seq)).toEqual([20, 30, 40]);
    expect(full?.hasMore).toBe(true);
    const start = cachedPage({ ...query, span: { lo: 1, hi: 99, more: false } }, read([10, 20]));
    expect(start?.hasMore).toBe(false);
    const partial = cachedPage({ ...query, span: { lo: 15, hi: 99, more: true } }, read([20]));
    expect(partial?.messages.map((m) => m.seq)).toEqual([20]);
    expect(partial?.hasMore).toBe(true);
    expect(cachedPage({ ...query, span: { lo: 15, hi: 99, more: true } }, read([]))).toBeUndefined();
  });

  test("记录、阶段记号照这一页的范围（更早没有了的从 1 起），不在当前分支上的不要", () => {
    const records = [5, 25, 35].map((seq) => ({ seq, type: "timeline_record" as const, payload: { record: { kind: "deviation", text: `${seq}` } } as never }));
    const page = cachedPage({ ...query, span: { lo: 1, hi: 99, more: false }, onPath: (s) => s !== 35 }, read([20, 30, 40], { records }));
    expect(page?.hasMore).toBe(false);
    expect(page?.records.map((r) => r.seq)).toEqual([5, 25]);
    const paged = cachedPage({ ...query, span: { lo: 1, hi: 99, more: false } }, read([10, 20, 30, 40], { records }));
    expect(paged?.records.map((r) => r.seq)).toEqual([25, 35]);
  });

  test("引用的语音对象本机缺了又不知道它本来没有：拼不出；知道本来没有的照拼", () => {
    const voiceMsg: HistoryMessage = { seq: 30, message: { ...textMessage("mv", "user", ""), parts: [{ type: "voice", voiceId: "v1", mediaId: "a".repeat(64), mime: "audio/webm", durationMs: 1000, waveform: [1] }] } };
    const r: CachedRead = { newest: [voiceMsg], records: [], stageStarts: [], voices: new Map(), agentVoices: new Map() };
    expect(cachedPage({ ...query, span: { lo: 1, hi: 99, more: false } }, r)).toBeUndefined();
    expect(cachedPage({ ...query, span: { lo: 1, hi: 99, more: false }, absent: new Set(["v:v1"]) }, r)?.messages).toHaveLength(1);
    const page: HistoryPage = { conversation: "secretary", messages: [voiceMsg], records: [], hasMore: false };
    expect(absentRefsOf(page)).toEqual(["v:v1"]);
  });
});

describe("存成什么、哪些事件让它作废", () => {
  test("会话频道上的消息、记录、阶段记号、语音对象存成协议里历史分页的样子", () => {
    const message = textMessage("m1", "user", "你好");
    expect(cacheEntryOf(frame("secretary", 3, "message", { message, idempotencyKey: "k", taskId: "t1" }))).toEqual({ kind: "m", key: 3, value: { seq: 3, message, idempotencyKey: "k", taskId: "t1" } });
    expect(cacheEntryOf(frame("secretary", 4, "message", { deleted: true, deletedAt: "x", messageId: "m1" }))).toEqual({ kind: "m", key: 4, value: { seq: 4, deleted: { deleted: true, deletedAt: "x", messageId: "m1" } } });
    expect(cacheEntryOf(frame("secretary", 5, "turn_end", {}))).toBeUndefined();
  });

  test("彻底删除、会话树、移除插件连数据删、删任务（自己的负责人）、删项目", () => {
    expect(chatCacheSignalOf(frame("secretary", 9, "messages_purged", { messages: [] }))).toEqual({ kind: "purged" });
    expect(chatCacheSignalOf(frame("plugins", 2, "plugin_data_purged", { plugin: "voice" }))).toEqual({ kind: "plugin_purged" });
    expect(chatCacheSignalOf(frame("board", 2, "task", { task: { id: "t1", maintainerId: "tm-t1", deleted: true } }))).toEqual({ kind: "conversation_deleted", conversation: "maintainer:tm-t1" });
    // 借用项目负责人的任务删了，负责人的会话还在
    expect(chatCacheSignalOf(frame("board", 2, "task", { task: { id: "t2", maintainerId: "pm-p1", deleted: true } }))).toBeUndefined();
    expect(chatCacheSignalOf(frame("projects", 2, "project", { project: { id: "p1", maintainerId: "pm-p1" }, change: "deleted" }))).toEqual({ kind: "conversation_deleted", conversation: "maintainer:pm-p1" });
    expect(chatCacheSignalOf(frame("board", 2, "task", { task: { id: "t1", maintainerId: "tm-t1" } }))).toBeUndefined();
  });
});
