// 素材模块（规格第 2、15 节）：采集、来源标记、原文副本、索引、回避信号。
// - 素材由守护进程从事件日志确定性地产生：登记过的事件类型（capture.ts）一来就采，agent 没有任何写素材、挑选素材的工具；
//   彻底删除改写过的事件（"已删除"标记）一律跳过；
// - 采到事件日志的哪一条记在 memory.db 里（和素材同一事务）：重启后从那里接着补采，同一条事件不会采两次；
// - 本人素材另存原文副本（originals.ts，连同信封，不可修改、只追加）：它是本人素材的真相。
//   memory.db 是派生的（ADR-0006）：清空后重建 = 从事件日志采出的素材 ∪ 原文副本里事件日志已经没有的本人素材（按素材 id 去重）。
//   所以删除素材也要先记进事件日志、并删掉原文副本，否则重建时会回来；
// - memory.db 只有这里拿得到写入口（对外只有读、检索和登记来源）；
// - 关键词索引随素材在同一事务里写好；向量在后台异步补算（vectors.ts），不卡写入和对话；
// - 回避信号：卡片被关闭直接采；建议卡、提问卡若干天没处理，由调度器的内部作业追加 card_stale 事件再采（avoidance.ts）。
// - 记忆命令（21 号票，commands.ts）：memory_command 事件既产生"显式记忆命令"素材，也删除（忘掉、彻底删除）、
//   标记（别推断）素材；被忘掉的留下墓碑，重建、从原文副本补回时都跳过，原文副本随之删掉。
//   彻底删除之后 memory.db 做一次 WAL 检查点（TRUNCATE；连接开着 secure_delete），删掉的内容不留在 WAL 和空闲页里。
// 不在本票：memory.db 和素材区的备份（11）。
import { EVENT_TYPES, isDeletedEventPayload, type MemoryCommandEventPayload } from "@ergou/protocol";
import type { EventStore, StoredEvent } from "../events/event-store.ts";
import type { InboxService } from "../inbox/inbox.ts";
import type { Clock } from "../scheduler/clock.ts";
import type { Scheduler } from "../scheduler/scheduler.ts";
import type { Database } from "../storage/sqlite.ts";
import { startStaleCardWatch } from "./avoidance.ts";
import { buildMaterial, type MaterialDraft, type MaterialSource } from "./capture.ts";
import { commandEffect, MATERIALS_CHANNEL, memoryCommandSource } from "./commands.ts";
import type { Embedder } from "./embedding/embedder.ts";
import {
  forgetMaterials,
  forgottenIds,
  getMaterial,
  hasMaterial,
  insertMaterial,
  isForgotten,
  keywordSearch,
  listMaterials,
  markNoInfer,
  type MaterialFilter,
  openMemoryDb,
  readCursor,
  referencesMedia,
  writeCursor,
} from "./memory-db.ts";
import { deleteOriginal, listOriginals, needsOriginal, readOriginal, writeOriginal } from "./originals.ts";
import { BUILTIN_SOURCES } from "./sources.ts";
import type { CapturedMaterial, Material } from "./types.ts";
import { createVectorIndex, type MaterialHit, type VectorStatus } from "./vectors.ts";

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
  /** 建议卡、提问卡多少天没处理算回避（配置 materials.staleCardDays） */
  staleCardDays: number;
  log: (line: string) => void;
}

export interface Materials {
  /** 登记一种素材来源（其他票的事件类型）；要在 start() 之前 */
  register(source: MaterialSource): void;
  /** 补采停着时追加的事件、补回只在原文副本里的本人素材，之后跟着事件日志采；约好向量补算，开始回避信号计时 */
  start(): void;
  stop(): Promise<void>;
  get(id: string): Material | undefined;
  /** 素材，按原始事件的先后 */
  list(filter?: MaterialFilter): Material[];
  /** 关键词检索（FTS5 trigram；3 个字以下的词退回子串扫描） */
  searchKeyword(query: string, options?: { limit?: number }): Material[];
  /** 语义检索（向量，暴力扫描）；模型文件不在时抛 EmbeddingUnavailable */
  searchSemantic(query: string, options?: { limit?: number }): Promise<MaterialHit[]>;
  /** 读一条素材的原文副本（存下时的信封，本人切段里是原文）；没有原文副本的是 undefined */
  readOriginal(material: Material): CapturedMaterial | undefined;
  /** 向量补算的状态 */
  vectorStatus(): VectorStatus;
  /** 还有没有素材引用这个媒体（彻底删除后决定能不能删媒体文件） */
  referencesMedia(mediaId: string): boolean;
}

/** 记忆命令对已有素材的作用（不是记忆命令、或者已被彻底删除改写过的，没有） */
function effectOf(event: StoredEvent) {
  return event.type === EVENT_TYPES.memoryCommand && !isDeletedEventPayload(event.payload) ? commandEffect(event.payload as MemoryCommandEventPayload) : undefined;
}

/** 补采时一批读多少条事件 */
const CATCH_UP_BATCH = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

export function openMaterials(options: MaterialsOptions): Materials {
  const { store, materialsDir, log } = options;
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
  for (const source of [...BUILTIN_SOURCES, memoryCommandSource]) register(source);

  /** 一条事件产生的素材（还没写）：彻底删除过的事件、采集出错的来源都不产生 */
  const draftsOf = (event: StoredEvent): Array<{ source: MaterialSource; drafts: MaterialDraft[] }> => {
    if (isDeletedEventPayload(event.payload)) return [];
    const out: Array<{ source: MaterialSource; drafts: MaterialDraft[] }> = [];
    for (const source of sources.get(event.type) ?? []) {
      try {
        const drafts = source.capture(event);
        if (drafts.length > 0) out.push({ source, drafts });
      } catch (err) {
        log(`素材来源 ${source.name} 处理事件 #${event.globalSeq} 出错，跳过：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      }
    }
    return out;
  };

  /** 把一条事件的素材写进库（在调用方的事务里）；返回写了几条。被忘掉过的素材（墓碑）不写，原文副本也不重写 */
  const write = (event: StoredEvent, captured: ReturnType<typeof draftsOf>): number => {
    let written = 0;
    let position = 0;
    for (const { source, drafts } of captured) {
      drafts.forEach((draft, index) => {
        const envelope = buildMaterial(event, source.name, index, draft);
        if (isForgotten(db, envelope.id)) {
          position += 1;
          return;
        }
        // 原文副本先落盘（已经在就不动），再写库：中途崩溃时重采一次也落到同一个文件
        const original = needsOriginal(envelope) ? writeOriginal(materialsDir, envelope, position) : null;
        if (insertMaterial(db, { ...envelope, original }, position)) written += 1;
        position += 1;
      });
    }
    return written;
  };

  /** 删掉被忘掉的素材的原文副本（库已经提交之后）；库里没有它的（只在原文副本里、还没补回的）按 id 在素材区里找 */
  const deleteOriginals = (known: readonly string[], ids: readonly string[]) => {
    const paths = new Set(known);
    const missing = new Set(ids.filter((id) => ![...paths].some((p) => p.endsWith(`/${id}.json`))));
    if (missing.size > 0) for (const o of listOriginals(materialsDir)) if (missing.has(o.id)) paths.add(o.path);
    for (const p of paths) {
      try {
        deleteOriginal(materialsDir, p);
      } catch (err) {
        // 墓碑已经记下了：下次启动时再删
        log(`删原文副本 ${p} 出错，下次启动时再删：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  /**
   * 处理一批事件：素材、记忆命令的作用和采集位置在同一个事务里；没有素材也不是记忆命令的事件只往后挪位置，不写库。
   * 被忘掉的素材的原文副本在提交之后删（ADR-0006：先记进事件日志、再删原文副本）
   */
  const processBatch = (events: readonly StoredEvent[]): number => {
    const relevant = events.filter((e) => e.globalSeq > cursor);
    if (relevant.length === 0) return 0;
    const last = relevant.at(-1)!.globalSeq;
    const work = relevant.map((event) => ({ event, captured: draftsOf(event), effect: effectOf(event) })).filter((w) => w.captured.length > 0 || w.effect);
    if (work.length === 0) {
      cursor = last;
      return 0;
    }
    const doomed: string[] = [];
    const forgotten: string[] = [];
    let purged = false;
    const written = db.transaction(() => {
      let n = 0;
      for (const w of work) {
        n += write(w.event, w.captured);
        if (!w.effect) continue;
        doomed.push(...forgetMaterials(db, w.effect.forget).map((c) => c.path));
        forgotten.push(...w.effect.forget);
        markNoInfer(db, w.effect.noInfer);
        purged ||= w.effect.purge;
      }
      writeCursor(db, last);
      return n;
    });
    cursor = last;
    if (forgotten.length > 0) deleteOriginals(doomed, forgotten);
    if (purged) checkpoint();
    return written;
  };

  /** 彻底删除之后：删掉的内容不留在 WAL 里（空闲页由 secure_delete 清零） */
  const checkpoint = () => {
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (err) {
      log(`彻底删除后 memory.db 做 WAL 检查点出错：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /**
   * 还没处理的记忆命令里要忘掉的素材，先记下墓碑：重建 memory.db 时，补采到它们的原始事件就直接跳过，
   * 不会把已经删掉的原文副本又写出来
   */
  const markPendingForgets = () => {
    const ids = store
      .read(MATERIALS_CHANNEL, 0, EVENT_TYPES.memoryCommand)
      .filter((e) => e.globalSeq > cursor)
      .flatMap((e) => effectOf(e)?.forget ?? []);
    if (ids.length > 0) db.transaction(() => forgetMaterials(db, ids));
  };

  const catchUp = (): number => {
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

  /**
   * 原文副本里有、memory.db 里没有的本人素材（原始事件已经不在事件日志里了）补回来；
   * 被忘掉过的不补，它的原文副本还在的（上次删的时候出错、或者中途崩溃了）删掉
   */
  const restoreFromOriginals = (): number => {
    const tombstones = forgottenIds(db);
    const all = listOriginals(materialsDir);
    const leftovers = all.filter((o) => tombstones.has(o.id));
    if (leftovers.length > 0) deleteOriginals(leftovers.map((o) => o.path), []);
    const missing = all.filter((o) => !tombstones.has(o.id) && !hasMaterial(db, o.id));
    if (missing.length === 0) return 0;
    const restored = db.transaction(() => {
      let n = 0;
      for (const o of missing) {
        const { record, copy } = readOriginal(materialsDir, o.path);
        if (insertMaterial(db, { ...record.material, original: copy }, record.position)) n += 1;
      }
      return n;
    });
    log(`从原文副本补回了 ${restored} 条本人素材（事件日志里已经没有它们的原始事件）`);
    return restored;
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
      markPendingForgets();
      catchUp();
      restoreFromOriginals();
      vectors.start();
      stopStaleWatch = startStaleCardWatch({ store, scheduler: options.scheduler, staleAfterMs: options.staleCardDays * DAY_MS });
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
    readOriginal: (material) => (material.original === null ? undefined : readOriginal(materialsDir, material.original.path).record.material),
    vectorStatus: () => vectors.status(),
    referencesMedia: (mediaId) => referencesMedia(db, mediaId),
  };
}
