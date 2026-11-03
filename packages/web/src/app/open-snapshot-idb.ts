// 本机快照存在这台设备的 IndexedDB 里（388；存什么、什么时候存见 open-snapshot.ts）。单放一个文件：只有页面用它（App.tsx），
// 测试换成假的、在 Node 里跑，不带 DOM 的类型。
import type { SnapshotBackend } from "./open-snapshot.ts";

/** IndexedDB 里的库名、表名、键 */
const DB_NAME = "ergo-page";
const STORE = "open-snapshot";
const KEY = "latest";

/**
 * 存在这台设备的 IndexedDB 里。没有 IndexedDB、打不开（隐私模式、禁用了站点数据）时读回没有、写和删什么都不做，都不抛错
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
        request.addEventListener("success", () => resolve(request.result));
        request.addEventListener("error", () => resolve(undefined));
        request.addEventListener("blocked", () => resolve(undefined));
      } catch {
        resolve(undefined);
      }
    }));
  const run = <T>(mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> =>
    open().then(
      (db) =>
        new Promise<T | undefined>((resolve) => {
          if (!db) return resolve(undefined);
          try {
            const tx = db.transaction(STORE, mode);
            const request = act(tx.objectStore(STORE));
            tx.addEventListener("complete", () => resolve(request.result));
            tx.addEventListener("error", () => resolve(undefined));
            tx.addEventListener("abort", () => resolve(undefined));
          } catch {
            resolve(undefined);
          }
        }),
    );
  return {
    read: () => run("readonly", (store) => store.get(KEY)),
    write: async (value) => {
      await run("readwrite", (store) => store.put(value, KEY));
    },
    remove: async () => {
      await run("readwrite", (store) => store.delete(KEY));
    },
  };
}
