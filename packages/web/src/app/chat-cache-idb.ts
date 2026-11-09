// 手机本机存的聊天记录（457）存在这台设备的 IndexedDB 里（存什么、什么时候存见 chat-cache.ts）。单放一个文件：只有页面用它
// （App.tsx），测试换成假的、在 Node 里跑，不带 DOM 的类型。
// 单独一个库（ergo-chat），和本机快照、本机存的事件那个库（ergo-page）不混：两边各升各的版本，谁也挡不着谁。两张表：
// - meta：每个会话一份说明（键是会话频道），整份一份（键 #）；
// - entries：一条一个键 [会话, 种类, 序号或 id]（种类：m 消息、r 时间线记录、s 阶段记号按序号；v 语音对象、a agent 语音对象按 id），
//   值是 { v: 存的东西, b: 字节数, ver: 语音对象的版本 }。一个会话的条目是一段键（删一个会话是删一段键）。
import type { AgentVoiceRecord, HistoryMessage, HistoryRecord, HistoryStageStart, VoiceRecord } from "../state/index.ts";
import type { ChatCacheBackend, ChatCacheGlobal, ConversationWrite, ConversationWriteResult, PageQuery } from "./chat-cache.ts";

const DB_NAME = "ergo-chat";
const META = "meta";
const ENTRIES = "entries";
const GLOBAL_KEY = "#";

/** 存着的一条 */
interface Stored {
  readonly v: unknown;
  readonly b: number;
  readonly ver?: number;
}

/** 一个会话的全部条目的键（数组排在数字、字符串后面） */
const conversationKeys = (conversation: string): IDBKeyRange => IDBKeyRange.bound([conversation], [conversation, []]);
/** 一个会话某一种按序号存的条目里 [lo, before) 那一段 */
const seqKeys = (conversation: string, kind: string, lo: number, before: number): IDBKeyRange => IDBKeyRange.bound([conversation, kind, lo], [conversation, kind, before], false, true);

/**
 * 存在这台设备的 IndexedDB 里。没有 IndexedDB、打不开（隐私模式、禁用了站点数据）时 load 交回 undefined（这个页面不存）；
 * 读不了当没有；写的事务没完成时拒绝
 */
export function indexedDbChatCacheBackend(factory: IDBFactory | undefined = globalThis.indexedDB): ChatCacheBackend {
  let opening: Promise<IDBDatabase | undefined> | undefined;
  const open = (): Promise<IDBDatabase | undefined> =>
    (opening ??= new Promise<IDBDatabase | undefined>((resolve) => {
      try {
        if (!factory) return resolve(undefined);
        const request = factory.open(DB_NAME, 1);
        request.addEventListener("upgradeneeded", () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
          if (!db.objectStoreNames.contains(ENTRIES)) db.createObjectStore(ENTRIES);
        });
        request.addEventListener("success", () => {
          // 以后要是升库的版本：这一页让开，别挡着新版本的页面
          request.result.addEventListener("versionchange", () => request.result.close());
          resolve(request.result);
        });
        request.addEventListener("error", () => resolve(undefined));
        request.addEventListener("blocked", () => resolve(undefined));
      } catch {
        resolve(undefined);
      }
    }));
  /** 在一个事务里做 act；事务完成了交回 result()。没有库是 undefined；事务没完成时 strict（写）拒绝、否则当没有 */
  const run = <T>(mode: IDBTransactionMode, act: (tx: IDBTransaction) => () => T, strict = false): Promise<T | undefined> =>
    open().then(
      (db) =>
        new Promise<T | undefined>((resolve, reject) => {
          const failed = () => (strict ? reject(new Error("IndexedDB transaction did not complete")) : resolve(undefined));
          if (!db) return strict ? failed() : resolve(undefined);
          try {
            const tx = db.transaction([META, ENTRIES], mode);
            const result = act(tx);
            tx.addEventListener("complete", () => resolve(result()));
            tx.addEventListener("error", failed);
            tx.addEventListener("abort", failed);
          } catch {
            failed();
          }
        }),
    );

  return {
    async load() {
      const db = await open();
      if (!db) return undefined;
      return run("readonly", (tx) => {
        const request = tx.objectStore(META).openCursor();
        let global: unknown;
        const metas: unknown[] = [];
        request.addEventListener("success", () => {
          const cursor = request.result;
          if (!cursor) return;
          if (cursor.key === GLOBAL_KEY) global = cursor.value;
          else metas.push(cursor.value);
          cursor.continue();
        });
        return () => ({ global, metas });
      });
    },

    async write(writes: readonly ConversationWrite[], global?: ChatCacheGlobal) {
      const results: ConversationWriteResult[] = [];
      await run(
        "readwrite",
        (tx) => {
          const metas = tx.objectStore(META);
          const entries = tx.objectStore(ENTRIES);
          if (global) metas.put(global, GLOBAL_KEY);
          for (const w of writes) {
            const stored = metas.get(w.conversation);
            stored.addEventListener("success", () => {
              const old = stored.result as { rev?: string; bytes?: number; count?: number } | undefined;
              // 本机存着的不是这个页面上次写的那一版（别的标签页改过、删过）：不写
              if (!w.force && (old?.rev ?? null) !== w.expect) {
                results.push({ conversation: w.conversation, ok: false, bytes: 0, count: 0 });
                return;
              }
              if (w.wipe) entries.delete(conversationKeys(w.conversation));
              if (w.meta === null) {
                metas.delete(w.conversation);
                results.push({ conversation: w.conversation, ok: true, bytes: 0, count: 0 });
                return;
              }
              let bytes = w.wipe ? 0 : (old?.bytes ?? 0);
              let count = w.wipe ? 0 : (old?.count ?? 0);
              for (const e of w.puts) {
                const key = [w.conversation, e.kind, e.key];
                const existing = entries.get(key);
                existing.addEventListener("success", () => {
                  const prev = existing.result as Stored | undefined;
                  // 消息、记录、阶段记号已经有了的不动（内容不会变：变了的是彻底删除，整份作废）；语音对象版本新的才盖
                  if (prev && !("version" in e && e.version > (prev.ver ?? 0))) return;
                  entries.put({ v: e.value, b: e.bytes, ...("version" in e ? { ver: e.version } : {}) } satisfies Stored, key);
                  bytes += e.bytes - (prev?.b ?? 0);
                  if (!prev && e.kind === "m") count += 1;
                });
              }
              // 排在这些读的后面：它回来时上面每一条都算过了，再写说明
              const after = metas.get(w.conversation);
              after.addEventListener("success", () => {
                metas.put({ ...w.meta, bytes, count }, w.conversation);
                results.push({ conversation: w.conversation, ok: true, bytes, count });
              });
            });
          }
          return () => undefined;
        },
        true,
      );
      return results;
    },

    readPage(query: PageQuery) {
      return run("readonly", (tx) => {
        const metas = tx.objectStore(META);
        const entries = tx.objectStore(ENTRIES);
        const { conversation: c, lo, before, limit } = query;
        let ok = false;
        const newest: HistoryMessage[] = [];
        let records: HistoryRecord[] = [];
        let stageStarts: HistoryStageStart[] = [];
        const voices = new Map<string, VoiceRecord>();
        const agentVoices = new Map<string, AgentVoiceRecord>();
        const meta = metas.get(c);
        meta.addEventListener("success", () => {
          if ((meta.result as { rev?: string } | undefined)?.rev !== query.rev) return;
          ok = true;
          // before 之前当前分支上的消息，新的在前，多读一条（知道更早还有没有）
          const cursorRequest = entries.openCursor(seqKeys(c, "m", lo, before), "prev");
          cursorRequest.addEventListener("success", () => {
            const cursor = cursorRequest.result;
            if (cursor) {
              const seq = (cursor.key as [string, string, number])[2];
              if (query.keep(seq)) newest.push((cursor.value as Stored).v as HistoryMessage);
              if (newest.length <= limit) return cursor.continue();
            }
            const recordsRequest = entries.getAll(seqKeys(c, "r", lo, before));
            recordsRequest.addEventListener("success", () => {
              records = (recordsRequest.result as Stored[]).map((s) => s.v as HistoryRecord);
            });
            const startsRequest = entries.getAll(seqKeys(c, "s", lo, before));
            startsRequest.addEventListener("success", () => {
              stageStarts = (startsRequest.result as Stored[]).map((s) => s.v as HistoryStageStart);
            });
            const ids = query.voiceIds(newest.slice(0, limit));
            for (const id of ids.voices) {
              const request = entries.get([c, "v", id]);
              request.addEventListener("success", () => {
                const stored = request.result as Stored | undefined;
                if (stored) voices.set(id, stored.v as VoiceRecord);
              });
            }
            for (const id of ids.agentVoices) {
              const request = entries.get([c, "a", id]);
              request.addEventListener("success", () => {
                const stored = request.result as Stored | undefined;
                if (stored) agentVoices.set(id, stored.v as AgentVoiceRecord);
              });
            }
          });
        });
        return () => (ok ? { newest, records, stageStarts, voices, agentVoices } : undefined);
      });
    },

    async clear() {
      await run("readwrite", (tx) => {
        tx.objectStore(META).clear();
        tx.objectStore(ENTRIES).clear();
        return () => undefined;
      });
    },
  };
}
