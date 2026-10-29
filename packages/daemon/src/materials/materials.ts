// 素材模块（规格第 2、15 节）：采集、来源标记、原文副本、索引、回避信号。
// - 素材由守护进程从事件日志确定性地产生：登记过的事件类型（capture.ts）一来就采，agent 没有任何写素材、挑选素材的工具；
//   彻底删除改写过的事件（"已删除"标记）一律跳过；
// - 采到事件日志的哪一条记在 materials.db 里（和素材同一事务）：重启后从那里接着补采，同一条事件不会采两次；
// - 本人素材另存原文副本（originals.ts，连同信封，不可修改、只追加）：它是本人素材的真相。
//   materials.db 是派生的（ADR-0006）：清空后重建 = 从事件日志采出的素材 ∪ 原文副本里事件日志已经没有的本人素材（按素材 id 去重）。
//   所以删除素材也要先记进事件日志、并删掉原文副本，否则重建时会回来；
// - materials.db 只有这里拿得到写入口（对外只有读、检索和登记来源）；
// - 关键词索引随素材在同一事务里写好；向量在后台异步补算（vectors.ts），不卡写入和对话；
//   166 号票：采集规则可以另给一段只进索引的外部正文（MaterialDraft.indexText，只有用户主动存的网页给），不进信封和原文副本；
//   索引文字的规则变了（索引文字的版本比库里记的新）时，采成素材的那次启动按原始事件把已有素材的索引文字重算一遍（reindex）；
// - 回避信号：卡片被关闭直接采；建议卡、提问卡若干天没处理，由调度器的内部作业追加 card_stale 事件再采（avoidance.ts）。
// - 记忆命令（21 号票，commands.ts）：memory_command 事件既产生"显式记忆命令"素材，也删除（忘掉、彻底删除）、
//   标记（别推断）素材；被忘掉的留下墓碑，重建、从原文副本补回时都跳过，原文副本随之删掉。
//   彻底删除之后 materials.db 做一次 WAL 检查点（TRUNCATE；连接开着 secure_delete），删掉的内容不留在 WAL 和空闲页里。
// 不在本票：materials.db 和素材区的备份（11）。
//
// 129 号票（ADR-0027，"素材与记忆"做成插件）起分两层：
// - 素材库（这里，内核）：materials.db 和原文副本的保管——跟着事件日志照做记忆命令的删除和标记、留下本人的话的原文副本、读；
//   素材来源由拥有事件的模块声明进来（register：内核的在组合根里，插件的在它的数据契约里，停用也照样声明）。
//   这些不随记忆插件停：用户的数据承诺（本人说过的话留一份不可修改的原文副本，删项目也不受影响）和"彻底删除照常能删"。
// - 采成素材（collect，记忆插件装配时开）：把事件采成素材写进 materials.db 和关键词索引、从原文副本补回、向量补算和语义检索、
//   回避信号计时。记忆插件没开时素材库**只保管**：不采成素材（采集位置停在那里，capture_state 另记只保管处理到哪一条）、
//   新的本人的话照样留原文副本、删除照做；再开时从停下的采集位置补采（同守护进程停着时追加的事件），停用期间的素材一条不少。
//   只保管时读（get、list、referencesMedia）也算上"只在原文副本里、还没进库"的本人素材，设置里的删除、删项目时随项目删的
//   照样找得到它们。
import { EVENT_TYPES, isDeletedEventPayload, type MemoryCommandEventPayload } from "@ergo/protocol";
import type { EventStore, StoredEvent } from "../events/event-store.ts";
import type { InboxService } from "../inbox/inbox.ts";
import type { Clock } from "../scheduler/clock.ts";
import type { Scheduler } from "../scheduler/scheduler.ts";
import type { Database } from "../storage/sqlite.ts";
import { startStaleCardWatch } from "./avoidance.ts";
import { buildMaterial, type MaterialDraft, materialId, type MaterialSource } from "./capture.ts";
import { commandEffect, MATERIALS_CHANNEL } from "./commands.ts";
import { type Embedder, EmbeddingUnavailable } from "./embedding/embedder.ts";
import {
  forgetMaterials,
  forgottenIds,
  getMaterial,
  hasMaterial,
  insertMaterial,
  isForgotten,
  isNoInfer,
  keywordSearch,
  listMaterials,
  markNoInfer,
  type MaterialFilter,
  openMaterialsDb,
  readCursor,
  readKeptCursor,
  readSearchTextVersion,
  referencesMedia,
  replaceSearchText,
  searchTextOf,
  writeCursor,
  writeKeptCursor,
  writeSearchTextVersion,
} from "./memory-db.ts";
import { deleteOriginal, listOriginals, needsOriginal, readOriginal, writeOriginal } from "./originals.ts";
import { BUILTIN_SOURCES } from "./sources.ts";
import type { CapturedMaterial, Material, OriginalCopy } from "./types.ts";
import { createVectorIndex, type MaterialHit, type VectorIndex, type VectorStatus } from "./vectors.ts";

export interface MaterialsOptions {
  store: EventStore;
  /** 数据库区：materials.db 放在这里 */
  dbDir: string;
  /** 素材区：原文副本放在 originals/ 下 */
  materialsDir: string;
  log: (line: string) => void;
}

/** 采成素材要的（记忆插件装配时交来，129 号票） */
export interface CollectOptions {
  /** 向量函数（正式运行是 bge-m3；测试注入假的） */
  embedder: Embedder;
  scheduler: Scheduler;
  clock: Clock;
  /** 模型文件不在时，往待我处理里放一条提示 */
  inbox: InboxService;
  /** 建议卡、提问卡多少天没处理算回避（配置 materials.staleCardDays） */
  staleCardDays: number;
}

export interface Materials {
  /**
   * 声明一种素材来源（拥有这类事件的模块：内核的在组合根里，插件的在它的数据契约里）；要在 start() 之前。
   * 返回撤销函数：之后这类事件不再采成素材、不再留原文副本（采集位置照样往后挪，已经采到的素材留着）
   */
  register(source: MaterialSource): () => void;
  /** 这类事件登记了素材来源没有（306 号票：数据源的断开确认框按它说"由它们整理出的素材"） */
  captures(eventType: string): boolean;
  /**
   * 开始采成素材（记忆插件装配时）：写进 materials.db 和关键词索引、从原文副本补回、向量补算、回避信号计时。
   * 211 号票起素材库启动之后也能开始（记忆插件运行中启用、装回）：马上从停下的采集位置补采。
   * 返回撤销函数（插件停用时）：停掉向量和回避信号计时，之后只保管（采集位置停在这里）
   */
  collect(options: CollectOptions): () => Promise<void>;
  /** 补采停着时追加的事件（采成素材时还补回只在原文副本里的本人素材、约好向量补算、开始回避信号计时），之后跟着事件日志 */
  start(): void;
  stop(): Promise<void>;
  get(id: string): Material | undefined;
  /** 素材，按原始事件的先后 */
  list(filter?: MaterialFilter): Material[];
  /** 关键词检索（FTS5 trigram；3 个字以下的词退回子串扫描） */
  searchKeyword(query: string, options?: { limit?: number }): Material[];
  /** 语义检索（向量，暴力扫描）；模型文件不在、没在采集素材（记忆插件没开）时抛 EmbeddingUnavailable */
  searchSemantic(query: string, options?: { limit?: number }): Promise<MaterialHit[]>;
  /** 读一条素材的原文副本（存下时的信封，本人切段里是原文）；没有原文副本的是 undefined */
  readOriginal(material: Material): CapturedMaterial | undefined;
  /** 向量补算的状态（没在采集素材时 state 是 off） */
  vectorStatus(): VectorStatus;
  /** 在不在采成素材（记忆插件开着）；只保管时是 false（167 号票：记忆 · 素材页顶上写明，搜的时候退回逐条比对） */
  collecting(): boolean;
  /** 还有没有素材引用这个媒体（彻底删除后决定能不能删媒体文件） */
  referencesMedia(mediaId: string): boolean;
}

/** 记忆命令对已有素材的作用（不是记忆命令、或者已被彻底删除改写过的，没有） */
function effectOf(event: StoredEvent) {
  return event.type === EVENT_TYPES.memoryCommand && !isDeletedEventPayload(event.payload) ? commandEffect(event.payload as MemoryCommandEventPayload) : undefined;
}

/** 补采时一批读多少条事件 */
const CATCH_UP_BATCH = 500;
/** 索引文字的版本：1 = 166 号票起采集规则给的外部正文（indexText）也进索引 */
const SEARCH_TEXT_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 采成素材时的那些：向量索引、回避信号计时（启动后才有） */
interface Collector {
  options: CollectOptions;
  vectors: VectorIndex;
  stopStaleWatch?: () => void;
}

/** 只在原文副本里、还没进库的本人素材（只保管时）：原文副本里的信封和它在那条事件里是第几条 */
interface PendingMaterial {
  material: CapturedMaterial & { original: OriginalCopy };
  position: number;
}

/** 没在采集素材时的向量状态 */
const VECTORS_OFF: VectorStatus = { model: "", available: false, indexed: 0, pending: 0, state: "off" };

export function openMaterials(options: MaterialsOptions): Materials {
  const { store, materialsDir, log } = options;
  const db: Database = openMaterialsDb(options.dbDir);
  const sources = new Map<string, MaterialSource[]>();
  const names = new Set<string>();
  let started = false;
  let stopped = false;
  let unsubscribe: (() => void) | undefined;
  let collector: Collector | undefined;
  /** 处理到事件日志的哪一条（内存里的；写进库的只在采到素材时跟着更新，其余的事件重启后再跳过一遍也不费事） */
  let cursor = readCursor(db);
  /** 只保管时处理到哪一条（采集位置之前的都处理过：取两者大的） */
  let kept = readKeptCursor(db);
  /** 只保管时：只在原文副本里、还没进库的本人素材（素材 id →） */
  const pending = new Map<string, PendingMaterial>();

  /** 这次从哪一条之后接着处理：采成素材时按采集位置（只保管期间的事件再处理一遍，留原文副本和删除都是幂等的），只保管时按两者大的 */
  const processedTo = () => (collector ? cursor : Math.max(cursor, kept));

  const register = (source: MaterialSource) => {
    if (started) throw new Error(`素材来源 ${source.name} 要在素材模块启动之前登记`); // @i18n-ignore log：编程错误
    if (names.has(source.name)) throw new Error(`素材来源 ${source.name} 已经登记过了`); // @i18n-ignore log：编程错误
    names.add(source.name);
    sources.set(source.eventType, [...(sources.get(source.eventType) ?? []), source]);
    return () => {
      const left = (sources.get(source.eventType) ?? []).filter((s) => s !== source);
      if (left.length === (sources.get(source.eventType) ?? []).length) return;
      names.delete(source.name);
      if (left.length > 0) sources.set(source.eventType, left);
      else sources.delete(source.eventType);
    };
  };
  for (const source of BUILTIN_SOURCES) register(source);

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

  /**
   * 把一条事件的素材写进库（在调用方的事务里）；返回写了几条。被忘掉过的素材（墓碑）不写，原文副本也不重写。
   * 只保管时只留原文副本（记进 pending），不写库
   */
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
        if (collector) {
          if (insertMaterial(db, { ...envelope, original }, position, draft.indexText)) written += 1;
        } else if (original && !hasMaterial(db, envelope.id)) pending.set(envelope.id, { material: { ...envelope, original }, position });
        position += 1;
      });
    }
    return written;
  };

  /** 删掉被忘掉的素材的原文副本（库已经提交之后）；库里没有它的（只在原文副本里、还没补回的）按 id 在素材区里找 */
  const deleteOriginals = (known: readonly string[], ids: readonly string[]) => {
    const paths = new Set(known);
    for (const id of ids) {
      const waiting = pending.get(id);
      if (waiting) paths.add(waiting.material.original.path);
      pending.delete(id);
    }
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

  /** 处理到了 globalSeq（在调用方的事务里写进库）：采成素材时是采集位置，只保管时另记 */
  const persist = (globalSeq: number) => (collector ? writeCursor(db, globalSeq) : writeKeptCursor(db, globalSeq));
  const advance = (globalSeq: number) => {
    if (collector) cursor = globalSeq;
    else kept = globalSeq;
  };

  /**
   * 处理一批事件：素材、记忆命令的作用和采集位置在同一个事务里；没有素材也不是记忆命令的事件只往后挪位置，不写库。
   * 被忘掉的素材的原文副本在提交之后删（ADR-0006：先记进事件日志、再删原文副本）
   */
  const processBatch = (events: readonly StoredEvent[]): number => {
    const from = processedTo();
    const relevant = events.filter((e) => e.globalSeq > from);
    if (relevant.length === 0) return 0;
    const last = relevant.at(-1)!.globalSeq;
    const work = relevant.map((event) => ({ event, captured: draftsOf(event), effect: effectOf(event) })).filter((w) => w.captured.length > 0 || w.effect);
    if (work.length === 0) {
      advance(last);
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
      persist(last);
      return n;
    });
    advance(last);
    if (forgotten.length > 0) deleteOriginals(doomed, forgotten);
    if (purged) checkpoint();
    return written;
  };

  /** 彻底删除之后：删掉的内容不留在 WAL 里（空闲页由 secure_delete 清零） */
  const checkpoint = () => {
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (err) {
      log(`彻底删除后 materials.db 做 WAL 检查点出错：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /**
   * 还没处理的记忆命令里要忘掉的素材，先记下墓碑：重建 materials.db 时，补采到它们的原始事件就直接跳过，
   * 不会把已经删掉的原文副本又写出来
   */
  const markPendingForgets = () => {
    const from = processedTo();
    const ids = store
      .read(MATERIALS_CHANNEL, 0, EVENT_TYPES.memoryCommand)
      .filter((e) => e.globalSeq > from)
      .flatMap((e) => effectOf(e)?.forget ?? []);
    if (ids.length > 0) db.transaction(() => forgetMaterials(db, ids));
  };

  const catchUp = (): number => {
    // 事件日志比记下的位置还短（ergo.db 换成了更早的版本）：从日志末尾接着采，已有的素材留着
    const lastGlobal = store.lastGlobalSeq();
    if (cursor > lastGlobal) {
      log(`素材采集位置（#${cursor}）比事件日志的末尾（#${lastGlobal}）还靠后：ergo.db 可能换成了更早的版本，从末尾接着采`);
      cursor = lastGlobal;
      db.transaction(() => writeCursor(db, lastGlobal));
    }
    if (kept > lastGlobal) {
      log(`素材库只保管时处理到的位置（#${kept}）比事件日志的末尾（#${lastGlobal}）还靠后：ergo.db 可能换成了更早的版本，从末尾接着处理`);
      kept = lastGlobal;
      db.transaction(() => writeKeptCursor(db, lastGlobal));
    }
    let written = 0;
    for (;;) {
      const batch = store.readGlobal(processedTo(), CATCH_UP_BATCH);
      if (batch.length === 0) break;
      written += processBatch(batch);
    }
    return written;
  };

  /**
   * 原文副本里有、materials.db 里没有的本人素材：被忘掉过的不算，它的原文副本还在的（上次删的时候出错、或者中途崩溃了）删掉。
   * 采成素材时补回库里（原始事件已经不在事件日志里了的），只保管时记进 pending
   */
  const originalsNotInDb = (): Array<{ id: string; path: string }> => {
    const tombstones = forgottenIds(db);
    const all = listOriginals(materialsDir);
    const leftovers = all.filter((o) => tombstones.has(o.id));
    if (leftovers.length > 0) deleteOriginals(leftovers.map((o) => o.path), []);
    return all.filter((o) => !tombstones.has(o.id) && !hasMaterial(db, o.id));
  };

  const restoreFromOriginals = (): number => {
    const missing = originalsNotInDb();
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

  /**
   * 索引文字的规则变了（166 号票：外部正文 indexText 也进索引）：已有素材按原始事件重新采一遍、重算索引文字，变了的换掉
   * （关键词索引跟着换，向量删掉等补算）。原始事件不在了、对不上的（只在原文副本里的本人素材）不动。只在采成素材时做，做完记下版本
   */
  const reindex = () => {
    let changed = 0;
    db.transaction(() => {
      for (const m of listMaterials(db)) {
        const { channel, seq, type } = m.ref.event;
        const event = store.eventAt(channel, seq);
        if (!event || event.type !== type) continue;
        for (const { source, drafts } of draftsOf(event)) {
          drafts.forEach((draft, index) => {
            if (materialId(event, source.name, index) === m.id && replaceSearchText(db, m.id, searchTextOf(m, draft.indexText))) changed += 1;
          });
        }
      }
      writeSearchTextVersion(db, SEARCH_TEXT_VERSION);
    });
    if (changed > 0) log(`索引文字的规则变了：按原始事件重算了 ${changed} 条素材的索引文字（向量随后补算）`);
  };

  /** 只保管时启动：只在原文副本里的本人素材记进 pending（读的时候算上它们） */
  const loadPending = () => {
    for (const o of originalsNotInDb()) {
      if (pending.has(o.id)) continue;
      const { record, copy } = readOriginal(materialsDir, o.path);
      pending.set(o.id, { material: { ...record.material, original: copy }, position: record.position });
    }
  };

  /** pending 里的一条，作为素材（"不参与推断"的标记按素材 id 记，照样带上） */
  const pendingMaterial = (p: PendingMaterial): Material => ({ ...p.material, noInfer: isNoInfer(db, p.material.id) });

  /**
   * 开始采成素材的那一段（启动时，或者运行中又开始采集）：从采集位置补采、从原文副本补回（只保管时记着的那些进库）、
   * 索引文字的规则变了就重算、向量和回避信号计时开起来
   */
  const beginCollecting = (mine: Collector) => {
    markPendingForgets();
    catchUp();
    restoreFromOriginals();
    pending.clear();
    if (readSearchTextVersion(db) < SEARCH_TEXT_VERSION) reindex();
    mine.vectors.start();
    mine.stopStaleWatch = startStaleCardWatch({ store, scheduler: mine.options.scheduler, staleAfterMs: mine.options.staleCardDays * DAY_MS });
  };

  return {
    register,
    captures: (eventType) => (sources.get(eventType)?.length ?? 0) > 0,
    collect(collectOptions) {
      if (stopped) throw new Error("素材库已经停了，不能再开始采集"); // @i18n-ignore log：编程错误
      if (collector) throw new Error("素材库已经在采集素材了"); // @i18n-ignore log：编程错误
      const mine: Collector = {
        options: collectOptions,
        vectors: createVectorIndex({ db, store, embedder: collectOptions.embedder, scheduler: collectOptions.scheduler, clock: collectOptions.clock, inbox: collectOptions.inbox, log }),
      };
      collector = mine;
      // 211 号票：素材库已经启动了（记忆插件运行中启用、装回）——马上从停下的采集位置补采，和重启时一样
      if (started) beginCollecting(mine);
      return async () => {
        if (collector !== mine) return;
        collector = undefined;
        // 素材库已经停了：向量、回避信号计时已经随它停了
        if (stopped) return;
        mine.stopStaleWatch?.();
        await mine.vectors.stop();
        // 之后只保管：采集位置停在这里（下次采成素材时从这里补采），只保管从这里接着
        kept = Math.max(kept, cursor);
      };
    },
    start() {
      if (started) return;
      started = true;
      // 先订阅再补采：两者在同一段同步代码里，中间不会有事件漏掉
      unsubscribe = store.onAppend((event) => {
        // 正常是紧接着上一条；前面有没采成的（比如写原文副本时磁盘出错，这次的追加照样成功了），从事件日志补上
        const written = event.globalSeq === processedTo() + 1 ? processBatch([event]) : catchUp();
        if (written > 0) collector?.vectors.kick();
      });
      if (!collector) {
        markPendingForgets();
        catchUp();
        loadPending();
        return;
      }
      beginCollecting(collector);
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      unsubscribe?.();
      collector?.stopStaleWatch?.();
      await collector?.vectors.stop();
      // 没采到素材的事件也记下位置，下次少跳几条
      if (started) db.transaction(() => persist(processedTo()));
      db.close();
    },
    get: (id) => getMaterial(db, id) ?? (pending.has(id) ? pendingMaterial(pending.get(id)!) : undefined),
    list(filter) {
      if (pending.size === 0) return listMaterials(db, filter);
      // 只保管时：库里的（已经按原始事件的先后排好）和只在原文副本里的合在一起，按原始事件的先后
      const { limit, ...rest } = filter ?? {};
      const waiting = [...pending.values()]
        .filter((p) => (rest.kind === undefined || p.material.kind === rest.kind) && (rest.conversation === undefined || p.material.conversation === rest.conversation))
        .toSorted((a, b) => a.material.ref.event.globalSeq - b.material.ref.event.globalSeq || a.position - b.position);
      const out: Material[] = [];
      let next = 0;
      for (const m of listMaterials(db, rest)) {
        while (next < waiting.length && waiting[next]!.material.ref.event.globalSeq < m.ref.event.globalSeq) out.push(pendingMaterial(waiting[next++]!));
        out.push(m);
      }
      out.push(...waiting.slice(next).map(pendingMaterial));
      return limit === undefined ? out : out.slice(0, limit);
    },
    searchKeyword: (query, opts) => keywordSearch(db, query, opts?.limit ?? 20),
    searchSemantic: (query, opts) => {
      if (!collector) return Promise.reject(new EmbeddingUnavailable("素材库现在只保管、不采集素材（记忆插件没启用），没有语义检索")); // @i18n-ignore log：调用方只认错误的类型
      return collector.vectors.search(query, opts?.limit ?? 10);
    },
    readOriginal: (material) => (material.original === null ? undefined : readOriginal(materialsDir, material.original.path).record.material),
    vectorStatus: () => collector?.vectors.status() ?? VECTORS_OFF,
    collecting: () => collector !== undefined,
    referencesMedia: (mediaId) => referencesMedia(db, mediaId) || [...pending.values()].some((p) => JSON.stringify(p.material.segments).includes(mediaId)),
  };
}
