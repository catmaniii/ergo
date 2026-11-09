// 本机快照和本机存的事件存在这台设备的 IndexedDB 里（388、452；存什么、什么时候存见 open-snapshot.ts）。单放一个文件：只有页面用它
// （App.tsx），测试换成假的、在 Node 里跑，不带 DOM 的类型。
// 一个库、一张表：快照在键 latest 上；事件一条一个键 [频道, 序号]（数组键排在字符串后面，按频道、序号排好，删一个频道是删一段键）。
// 和 388 的同一张表，不升库的版本：开着的旧版本页面照样读写它的 latest，不会被升级挡住。
// 存的事件按冷补发同一份规则合并（456）：一次写先删（整个、某几个频道、被盖掉的那几条），再加，快照换掉，一个事务。
import type { EventWrite, SnapshotBackend } from "./open-snapshot.ts";

/** IndexedDB 里的库名、表名、快照的键 */
const DB_NAME = "ergo-page";
const STORE = "open-snapshot";
const KEY = "latest";

/** 全部事件的键（数组键都在字符串键后面） */
const allEvents = (): IDBKeyRange => IDBKeyRange.lowerBound([]);
/** 一个频道的事件的键：[频道, 任何序号]（数字排在数组前面） */
const channelEvents = (channel: string): IDBKeyRange => IDBKeyRange.bound([channel], [channel, []]);

/**
 * 存在这台设备的 IndexedDB 里。没有 IndexedDB、打不开（隐私模式、禁用了站点数据）时读回没有、写和删什么都不做，都不抛错；
 * 写的事务没完成（存满了、出错）时拒绝，攒着的事件留到下次写
 */
export function indexedDbSnapshotBackend(factory: IDBFactory | undefined = globalThis.indexedDB): SnapshotBackend {
  let opening: Promise<IDBDatabase | undefined> | undefined;
  const open = (): Promise<IDBDatabase | undefined> =>
    (opening ??= new Promise<IDBDatabase | undefined>((resolve) => {
      try {
        if (!factory) return resolve(undefined);
        const request = factory.open(DB_NAME, 1);
        request.addEventListener("upgradeneeded", () => {
          if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
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
  /**
   * 在一个事务里做 act；事务完成了交回 result()。事务没完成时 strict（写）拒绝、否则当没有；根本没有 IndexedDB 时都当没有
   * （读回来什么都没有，每次打开本来就从头补）
   */
  const run = <T>(mode: IDBTransactionMode, act: (store: IDBObjectStore) => () => T, strict = false): Promise<T | undefined> =>
    open().then(
      (db) =>
        new Promise<T | undefined>((resolve, reject) => {
          const failed = () => (strict ? reject(new Error("IndexedDB transaction did not complete")) : resolve(undefined));
          if (!db) return resolve(undefined);
          try {
            const tx = db.transaction(STORE, mode);
            const result = act(tx.objectStore(STORE));
            tx.addEventListener("complete", () => resolve(result()));
            tx.addEventListener("error", failed);
            tx.addEventListener("abort", failed);
          } catch {
            failed();
          }
        }),
    );
  return {
    read: () =>
      run("readonly", (store) => {
        const request = store.get(KEY);
        return () => request.result as unknown;
      }),
    readEvents: () =>
      run("readonly", (store) => {
        const request = store.getAll(allEvents());
        return () => request.result as unknown;
      }),
    write: async (value: unknown, events: EventWrite) => {
      await run(
        "readwrite",
        (store) => {
          if (events.clear === "all") store.delete(allEvents());
          else for (const channel of events.clear) store.delete(channelEvents(channel));
          // 合并时被后来的盖掉了的（456）
          for (const { channel, seq } of events.remove) store.delete([channel, seq]);
          for (const frame of events.add) store.put(frame, [frame.channel, frame.seq]);
          store.put(value, KEY);
          return () => undefined;
        },
        true,
      );
    },
    remove: async () => {
      await run("readwrite", (store) => {
        store.clear();
        return () => undefined;
      });
    },
  };
}
