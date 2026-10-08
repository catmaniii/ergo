// 事件存储（规格第 2、4 节）：事件日志是唯一真相。
// - 事件 `{全局序号, 频道, 频道内序号, 类型, 负载, 时间, 幂等键}`；频道内序号从 1 起连续。
// - 带幂等键的追加：同一个键第二次追加不落新事件，直接拿到第一次的结果。
// - 派生视图（看板、待我处理、会话……）在追加事件的同一个事务里更新：视图更新失败，事件也不落。
// - 派生视图可以清空后从事件日志整体重建。
// - 彻底删除（规格第 15 节，21 号票）是事件日志不可修改的唯一例外：appendBatch 的 purge 把指定事件的负载换掉。
//   改写入口只有这一个，换成什么由记忆模块按事件类型登记的改写函数定（memory/rewriters.ts）：消息事件整条换成
//   "已删除"标记（共享协议包的 DeletedEventPayload），别的事件只把带原话的文本字段换成删除标记文字、状态不变。
//   派生视图看不到"已删除"标记（和素材采集一样跳过），改写后在同一事务里整体重建；提交后做一次 WAL 检查点（TRUNCATE），
//   连接开着 secure_delete（storage/sqlite.ts），旧内容不留在 WAL 和空闲页里。
// 库是数据目录数据库区的 ergou.db（WAL），所有访问经过存储薄接口（storage/sqlite.ts）。
import { isDeletedEventPayload, nowIso } from "@ergou/protocol";
import { type Database, openDatabase, openReadonlyDatabase, type ReadonlyDatabase } from "../storage/sqlite.ts";

export interface StoredEvent {
  globalSeq: number;
  channel: string;
  /** 频道内序号，从 1 起连续 */
  seq: number;
  type: string;
  payload: unknown;
  /** 带时区偏移的 ISO 时间 */
  time: string;
  idempotencyKey: string | null;
}

export interface NewEvent {
  channel: string;
  type: string;
  payload: unknown;
  idempotencyKey?: string;
}

/** 彻底删除时一条事件改写后的负载 */
export interface PurgeRewrite {
  globalSeq: number;
  payload: unknown;
}

export interface AppendResult {
  event: StoredEvent;
  /** 幂等键已经用过：这次没有落新事件，event 是第一次追加的那条 */
  duplicate: boolean;
}

/**
 * 派生视图：从事件归并出来的表。每个视图管自己的表，只在 apply 里写。
 * apply 和事件写入在同一个事务里；抛错则整个追加回滚。彻底删除改写过的事件（"已删除"标记）不交给 apply。
 */
export interface DerivedView {
  name: string;
  /** 建表（要幂等：CREATE TABLE IF NOT EXISTS） */
  create(db: Database): void;
  /** 清空视图的全部内容 */
  clear(db: Database): void;
  /** 把一条事件归并进视图；不关心的事件直接忽略 */
  apply(db: Database, event: StoredEvent): void;
}

export interface EventStore {
  /** 追加一条事件，并在同一事务里更新所有派生视图；提交后通知订阅者 */
  append(event: NewEvent): AppendResult;
  /**
   * 一组事件在同一个事务里追加：要么全落、要么全不落（比如卡片动作的结果和它引起的提醒变化）。
   * 每条各按自己的幂等键去重；提交后按顺序通知订阅者（去重掉的不通知）。
   * purge：彻底删除，同一事务里把这些事件（全局序号）的负载换成给出的样子（没变的不动；没有这条事件时整组回滚），
   * 派生视图随之整体重建，提交后做一次 WAL 检查点。改写不通知订阅者，要让别处知道就同时追加一条事件说明
   * （比如会话频道的 messages_purged）。改写成什么只由记忆模块的改写函数表定（memory/rewriters.ts）。
   */
  appendBatch(events: readonly NewEvent[], options?: { purge?: readonly PurgeRewrite[] }): AppendResult[];
  /** 某个频道里序号大于 afterSeq 的事件（给了 type 就只取这一类），按序号排 */
  read(channel: string, afterSeq?: number, type?: string): StoredEvent[];
  /** 某个频道里序号小于 beforeSeq 的最后 limit 条事件（给了 type 就只取这一类），按序号从早到晚（历史分页用） */
  readBefore(channel: string, beforeSeq: number, limit: number, type?: string): StoredEvent[];
  /** 某个频道里某个序号的事件（没有是 undefined） */
  eventAt(channel: string, seq: number): StoredEvent | undefined;
  /** 用某个幂等键追加的那条事件（没有是 undefined） */
  eventByIdempotencyKey(key: string): StoredEvent | undefined;
  /** 负载里含有这段文字的某类事件，按全局序号（彻底删除时找提到被删素材、某次工具调用的记录） */
  mentioning(type: string, text: string): StoredEvent[];
  /** 所有频道里某一类事件，按全局序号 */
  ofType(type: string): StoredEvent[];
  /** 某个频道最后一条事件的序号（没有事件是 0） */
  lastSeq(channel: string): number;
  /** 所有频道里全局序号大于 afterGlobalSeq 的事件，按全局序号排，最多 limit 条（素材采集按它补采） */
  readGlobal(afterGlobalSeq: number, limit: number): StoredEvent[];
  /** 最后一条事件的全局序号（没有事件是 0） */
  lastGlobalSeq(): number;
  /**
   * 订阅新追加的事件（提交之后同步调用）；返回取消订阅的函数。
   * 订阅者在通知里又追加了事件时，新事件排在后面：每个订阅者收到的事件都按追加顺序，一条不漏。
   */
  onAppend(listener: (event: StoredEvent) => void): () => void;
  /** 清空所有派生视图，再按全局序号把事件日志整个重放一遍 */
  rebuildViews(): void;
  /** 读派生视图用的只读连接（各视图模块提供读取函数）；写一律经 append */
  readonly reader: ReadonlyDatabase;
  close(): void;
}

export interface OpenEventStoreOptions {
  file: string;
  views: readonly DerivedView[];
  /** 事件时间；测试可以换成固定的钟 */
  now?: () => string;
  /** 订阅者抛错时记日志（不影响追加） */
  log?: (line: string) => void;
}

interface EventRow {
  global_seq: number;
  channel: string;
  seq: number;
  type: string;
  payload: string;
  time: string;
  idempotency_key: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  global_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  time TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  UNIQUE (channel, seq)
);
`;

function toEvent(row: EventRow): StoredEvent {
  return {
    globalSeq: Number(row.global_seq),
    channel: row.channel,
    seq: Number(row.seq),
    type: row.type,
    payload: JSON.parse(row.payload) as unknown,
    time: row.time,
    idempotencyKey: row.idempotency_key,
  };
}

export function openEventStore(options: OpenEventStoreOptions): EventStore {
  const db = openDatabase(options.file);
  const now = options.now ?? nowIso;
  const log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
  const views = [...options.views];
  const listeners = new Set<(event: StoredEvent) => void>();
  // 等着通知的事件：通知进行中又追加的事件排在这里，由最外层的那次通知按顺序发完。
  // 一组事件一起排进来（appendBatch）：订阅者处理组里前面的事件时又追加的事件，排在这一组后面（序号也在后面），
  // 不会先于组里后面的事件发出去
  const undelivered: StoredEvent[] = [];
  let notifying = false;
  const notify = (...events: StoredEvent[]) => {
    undelivered.push(...events);
    if (undelivered.length === 0) return;
    if (notifying) return;
    notifying = true;
    try {
      for (let next = undelivered.shift(); next; next = undelivered.shift()) {
        for (const listener of listeners) {
          try {
            listener(next);
          } catch (err) {
            log(`事件订阅者出错：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
          }
        }
      }
    } finally {
      notifying = false;
    }
  };

  db.transaction(() => {
    db.exec(SCHEMA);
    for (const view of views) view.create(db);
  });
  const reader = openReadonlyDatabase(options.file);

  const checkpoint = () => {
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (err) {
      log(`彻底删除后做 WAL 检查点出错：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const lastSeq = (channel: string): number =>
    Number(db.get<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM events WHERE channel = ?", channel)?.seq ?? 0);

  /** 在已经开着的事务里追加一条 */
  const appendInTransaction = (input: NewEvent, mode: { skipViews?: boolean } = {}): AppendResult => {
    if (input.idempotencyKey !== undefined) {
      const existing = db.get<EventRow>("SELECT * FROM events WHERE idempotency_key = ?", input.idempotencyKey);
      if (existing) return { event: toEvent(existing), duplicate: true };
    }
    const seq = lastSeq(input.channel) + 1;
    const time = now();
    const { lastInsertRowid } = db.run(
      "INSERT INTO events (channel, seq, type, payload, time, idempotency_key) VALUES (?, ?, ?, ?, ?, ?)",
      input.channel,
      seq,
      input.type,
      JSON.stringify(input.payload),
      time,
      input.idempotencyKey ?? null,
    );
    const event: StoredEvent = {
      globalSeq: Number(lastInsertRowid),
      channel: input.channel,
      seq,
      type: input.type,
      // 存进去的是 JSON：负载按 JSON 往返一次，和之后读出来的一模一样
      payload: JSON.parse(JSON.stringify(input.payload)) as unknown,
      time,
      idempotencyKey: input.idempotencyKey ?? null,
    };
    if (!mode.skipViews && !isDeletedEventPayload(event.payload)) for (const view of views) view.apply(db, event);
    return { event, duplicate: false };
  };

  /** 清空派生视图，按全局序号把事件日志重放一遍（"已删除"标记跳过）；在调用方的事务里 */
  const replayViews = () => {
    for (const view of views) view.clear(db);
    for (const row of db.all<EventRow>("SELECT * FROM events ORDER BY global_seq")) {
      const event = toEvent(row);
      if (isDeletedEventPayload(event.payload)) continue;
      for (const view of views) view.apply(db, event);
    }
  };

  /** 换掉一条事件的负载；没变的不动。返回是否改写了。在调用方的事务里 */
  const purgeInTransaction = ({ globalSeq, payload }: PurgeRewrite): boolean => {
    const row = db.get<EventRow>("SELECT payload FROM events WHERE global_seq = ?", globalSeq);
    if (!row) throw new Error(`彻底删除：事件日志里没有全局序号为 ${globalSeq} 的事件`);
    const next = JSON.stringify(payload);
    if (next === row.payload) return false;
    db.run("UPDATE events SET payload = ? WHERE global_seq = ?", next, globalSeq);
    return true;
  };

  return {
    reader,
    append(input) {
      const result = db.transaction(() => appendInTransaction(input));
      if (!result.duplicate) notify(result.event);
      return result;
    },
    appendBatch(inputs, batch) {
      const purge = batch?.purge ?? [];
      let rewritten = false;
      const results = db.transaction(() => {
        for (const rewrite of purge) rewritten = purgeInTransaction(rewrite) || rewritten;
        // 先改写再追加：视图按改写后的日志整体重建（新事件在重建里一并归并，追加时不再单独归并）
        if (!rewritten) return inputs.map((input) => appendInTransaction(input));
        const appended = inputs.map((input) => appendInTransaction(input, { skipViews: true }));
        replayViews();
        return appended;
      });
      // 原来的内容不留在 WAL 里（空闲页由 secure_delete 清零）；有读者正占着时做不完整，下次检查点再清
      if (rewritten) checkpoint();
      notify(...results.filter((r) => !r.duplicate).map((r) => r.event));
      return results;
    },
    read(channel, afterSeq = 0, type) {
      const rows =
        type === undefined
          ? db.all<EventRow>("SELECT * FROM events WHERE channel = ? AND seq > ? ORDER BY seq", channel, afterSeq)
          : db.all<EventRow>("SELECT * FROM events WHERE channel = ? AND seq > ? AND type = ? ORDER BY seq", channel, afterSeq, type);
      return rows.map(toEvent);
    },
    readBefore(channel, beforeSeq, limit, type) {
      const rows =
        type === undefined
          ? db.all<EventRow>("SELECT * FROM events WHERE channel = ? AND seq < ? ORDER BY seq DESC LIMIT ?", channel, beforeSeq, limit)
          : db.all<EventRow>("SELECT * FROM events WHERE channel = ? AND seq < ? AND type = ? ORDER BY seq DESC LIMIT ?", channel, beforeSeq, type, limit);
      return rows.map(toEvent).toReversed();
    },
    lastSeq,
    eventAt(channel, seq) {
      const row = db.get<EventRow>("SELECT * FROM events WHERE channel = ? AND seq = ?", channel, seq);
      return row && toEvent(row);
    },
    eventByIdempotencyKey(key) {
      const row = db.get<EventRow>("SELECT * FROM events WHERE idempotency_key = ?", key);
      return row && toEvent(row);
    },
    mentioning(type, text) {
      return db.all<EventRow>("SELECT * FROM events WHERE type = ? AND instr(payload, ?) > 0 ORDER BY global_seq", type, text).map(toEvent);
    },
    ofType(type) {
      return db.all<EventRow>("SELECT * FROM events WHERE type = ? ORDER BY global_seq", type).map(toEvent);
    },
    readGlobal(afterGlobalSeq, limit) {
      return db.all<EventRow>("SELECT * FROM events WHERE global_seq > ? ORDER BY global_seq LIMIT ?", afterGlobalSeq, limit).map(toEvent);
    },
    lastGlobalSeq: () => Number(db.get<{ seq: number | null }>("SELECT MAX(global_seq) AS seq FROM events")?.seq ?? 0),
    onAppend(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    rebuildViews() {
      db.transaction(replayViews);
    },
    close() {
      listeners.clear();
      reader.close();
      db.close();
    },
  };
}
