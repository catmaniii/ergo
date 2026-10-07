// 素材模块（规格第 2、15 节）：采集、来源标记、原文副本、索引、回避信号。
// - 素材由守护进程从事件日志确定性地产生：登记过的事件类型（capture.ts）一来就采，agent 没有任何写素材、挑选素材的工具；
// - 采到事件日志的哪一条记在 memory.db 里（和素材同一事务）：重启后从那里接着补采，同一条事件不会采两次；
//   memory.db 被清空后从头重采，素材 id 由事件算出来，得到相同的素材；
// - memory.db 只有这里拿得到写入口（对外只有读和检索），原文副本另存在素材区（originals.ts）；
// - 关键词索引随素材在同一事务里写好；向量在后台异步补算（vectors.ts），不卡写入和对话；
// - 回避信号：卡片被关闭直接采；建议卡、提问卡 7 天（默认，可配置）没处理，由调度器的内部作业追加 card_stale 事件再采（avoidance.ts）。
// memory.db 是事件日志的派生（ADR-0006）：删除素材也要先记进事件日志，否则重建时会回来。
// 不在本票：忘掉、彻底删除、别推断，秘书的素材检索工具（21）；memory.db 和素材区的备份（11）。
import type { EventStore, StoredEvent } from "../events/event-store.ts";
import type { InboxService } from "../inbox/inbox.ts";
import type { Clock } from "../scheduler/clock.ts";
import type { Scheduler } from "../scheduler/scheduler.ts";
import type { Database } from "../storage/sqlite.ts";
import { DEFAULT_STALE_CARD_DAYS, startStaleCardWatch } from "./avoidance.ts";
import { buildMaterial, type MaterialSource } from "./capture.ts";
import type { Embedder } from "./embedding/embedder.ts";
import { getMaterial, insertMaterial, keywordSearch, listMaterials, type MaterialFilter, openMemoryDb, readCursor, writeCursor } from "./memory-db.ts";
import { readOriginal, writeOriginal } from "./originals.ts";
import { BUILTIN_SOURCES } from "./sources.ts";
import type { Material, OriginalCopy } from "./types.ts";
import { createVectorIndex, type MaterialHit, type VectorStatus } from "./vectors.ts";

export type { MaterialDraft, MaterialSource } from "./capture.ts";
export type { MaterialFilter } from "./memory-db.ts";
export type { MaterialHit, VectorStatus } from "./vectors.ts";

export interface MaterialsOptions {
  store: EventStore;
  /** 数据库区：memory.db 放在这里 */
  dbDir: string;
  /** 素材区：原文副本放在 originals/ 下 */
  materialsDir: string;
  /** 向量函数（正式运行是 bge-m3；测试注入假的） */
  embedder: Embedder;
  scheduler: Scheduler;
  clock: Clock;
  /** 模型文件不在时，往待我处理里放一条提示 */
  inbox: InboxService;
  /** 建议卡、提问卡多少天没处理算回避（默认 7） */
  staleCardDays?: number;
  log?: (line: string) => void;
}

export interface Materials {
  /** 登记一种素材来源（其他票的事件类型）；要在 start() 之前 */
  register(source: MaterialSource): void;
  /** 补采停着时追加的事件，之后跟着事件日志采；启动向量补算和回避信号计时 */
  start(): void;
  stop(): Promise<void>;
  get(id: string): Material | undefined;
  /** 素材，按原始事件的先后 */
  list(filter?: MaterialFilter): Material[];
  /** 关键词检索（FTS5 trigram；3 个字以下的词退回子串扫描） */
  searchKeyword(query: string, options?: { limit?: number }): Material[];
  /** 语义检索（向量，暴力扫描）；模型文件不在时抛 EmbeddingUnavailable */
  searchSemantic(query: string, options?: { limit?: number }): Promise<MaterialHit[]>;
  /** 读一份原文副本 */
  readOriginal(copy: OriginalCopy): string;
  /** 向量补算的状态 */
  vectorStatus(): VectorStatus;
  /** 等后台的向量补算告一段落（没有要算的，或者模型不在） */
  vectorsSettled(): Promise<void>;
}

/** 补采时一批读多少条事件 */
const CATCH_UP_BATCH = 500;

export function openMaterials(options: MaterialsOptions): Materials {
  const { store, materialsDir } = options;
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const db: Database = openMemoryDb(options.dbDir);
  const sources = new Map<string, MaterialSource[]>();
  const names = new Set<string>();
  let started = false;
  let stopped = false;
  let unsubscribe: (() => void) | undefined;
  let stopStaleWatch: (() => void) | undefined;
  /** 处理到事件日志的哪一条（内存里的；写进库的只在采到素材时跟着更新，其余的事件重启后再跳过一遍也不费事） */
  let cursor = readCursor(db);

  const vectors = createVectorIndex({ db, store, embedder: options.embedder, scheduler: options.scheduler, clock: options.clock, inbox: options.inbox, log });

  const register = (source: MaterialSource) => {
    if (started) throw new Error(`素材来源 ${source.name} 要在素材模块启动之前登记`);
    if (names.has(source.name)) throw new Error(`素材来源 ${source.name} 已经登记过了`);
    names.add(source.name);
    sources.set(source.eventType, [...(sources.get(source.eventType) ?? []), source]);
  };
  for (const source of BUILTIN_SOURCES) register(source);

  /** 一条事件产生的素材写进库（在调用方的事务里）；返回写了几条 */
  const capture = (event: StoredEvent): number => {
    let written = 0;
    let position = 0;
    for (const source of sources.get(event.type) ?? []) {
      let drafts;
      try {
        drafts = source.capture(event);
      } catch (err) {
        log(`素材来源 ${source.name} 处理事件 #${event.globalSeq} 出错，跳过：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        continue;
      }
      drafts.forEach((draft, index) => {
        const envelope = buildMaterial(event, source.name, index, draft);
        // 原文副本先落盘（已经在就不动），再写库：中途崩溃时重采一次也落到同一个文件
        const originals = envelope.segments.flatMap((segment, i) =>
          segment.source === "self" && segment.text !== undefined && segment.sha256 !== undefined
            ? [writeOriginal(materialsDir, { materialId: envelope.id, time: envelope.time, segment: i, text: segment.text, sha256: segment.sha256 })]
            : [],
        );
        if (insertMaterial(db, { ...envelope, originals }, position)) written += 1;
        position += 1;
      });
    }
    return written;
  };

  /** 处理一批事件：素材和采集位置在同一个事务里 */
  const processBatch = (events: readonly StoredEvent[]): number => {
    const relevant = events.filter((e) => e.globalSeq > cursor);
    if (relevant.length === 0) return 0;
    const last = relevant.at(-1)!.globalSeq;
    if (!relevant.some((e) => sources.has(e.type))) {
      cursor = last;
      return 0;
    }
    const written = db.transaction(() => {
      let n = 0;
      for (const event of relevant) n += capture(event);
      writeCursor(db, last);
      return n;
    });
    cursor = last;
    return written;
  };

  const catchUp = () => {
    // 事件日志比记下的位置还短（ergou.db 换成了更早的版本）：从日志末尾接着采，已有的素材留着
    const lastGlobal = store.lastGlobalSeq();
    if (cursor > lastGlobal) {
      log(`素材采集位置（#${cursor}）比事件日志的末尾（#${lastGlobal}）还靠后：ergou.db 可能换成了更早的版本，从末尾接着采`);
      cursor = lastGlobal;
      db.transaction(() => writeCursor(db, lastGlobal));
    }
    let written = 0;
    for (;;) {
      const batch = store.readGlobal(cursor, CATCH_UP_BATCH);
      if (batch.length === 0) break;
      written += processBatch(batch);
    }
    return written;
  };

  return {
    register,
    start() {
      if (started) return;
      started = true;
      // 先订阅再补采：两者在同一段同步代码里，中间不会有事件漏掉
      unsubscribe = store.onAppend((event) => {
        // 正常是紧接着上一条；前面有没采成的（比如写原文副本时磁盘出错，这次的追加照样成功了），从事件日志补上
        const written = event.globalSeq === cursor + 1 ? processBatch([event]) : catchUp();
        if (written > 0) vectors.kick();
      });
      catchUp();
      vectors.start();
      stopStaleWatch = startStaleCardWatch({
        store,
        scheduler: options.scheduler,
        clock: options.clock,
        staleAfterMs: (options.staleCardDays ?? DEFAULT_STALE_CARD_DAYS) * 24 * 60 * 60 * 1000,
      });
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      unsubscribe?.();
      stopStaleWatch?.();
      await vectors.stop();
      // 没采到素材的事件也记下位置，下次少跳几条
      if (started) db.transaction(() => writeCursor(db, cursor));
      db.close();
    },
    get: (id) => getMaterial(db, id),
    list: (filter) => listMaterials(db, filter),
    searchKeyword: (query, opts) => keywordSearch(db, query, opts?.limit ?? 20),
    searchSemantic: (query, opts) => vectors.search(query, opts?.limit ?? 10),
    readOriginal: (copy) => readOriginal(materialsDir, copy),
    vectorStatus: () => vectors.status(),
    vectorsSettled: () => vectors.settled(),
  };
}
