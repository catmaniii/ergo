// 打开页面时先用的本机快照（388）：页面这一半——存在这台设备的 IndexedDB 里（open-snapshot-idb.ts；存哪些、会话留多少见 state/open-snapshot.ts）。
// - 打开时读一次（页面脚本一开始就读，和问"被信任吗"同时）：网页版本（构建产物的哈希）、协议版本、快照格式三样都对得上才用，
//   对不上（网页升级了、格式改了）的当场删掉，按现在的从头补；读不了、读坏了、1.5 秒还没读出来也当没有，照现在的走；
// - 存：要存的那几样变了才存，攒着等闲下来（最后一次变化之后 3 秒，最多攒 30 秒）再写一份，切到后台、关页面时马上写；
//   写一次就是整份换掉（同一个键），写不进去不抛错，下次打开照现在的走；
// - 清：设备被吊销、回到配对页时删掉（手机上不留个人数据），之后这个页面上不再存；
// - 多台设备、多个标签页各存各的，不互相同步：同一台设备上的几个标签页（鸿蒙 App 的浏览侧边栏也是一个）谁后写用谁的，
//   每一份都是某一刻完整的样子连同它的游标，下次打开从那里补增量，补出来的一样；
// - 开发服务器的页面没有网页版本，不存不用；原型（演示页）不用。
import { isOpenSnapshot, OPEN_SNAPSHOT_FORMAT, type OpenSnapshot } from "../state/index.ts";

/** 存快照的地方（测试换成假的）：一份，读、整份写、删 */
export interface SnapshotBackend {
  read(): Promise<unknown>;
  write(value: unknown): Promise<void>;
  remove(): Promise<void>;
}

/** 存下的一份：快照连同存的时候页面是哪一版 */
interface StoredSnapshot {
  readonly format: number;
  readonly webVersion: string;
  readonly protocolVersion: number;
  readonly savedAt: string;
  readonly snapshot: OpenSnapshot;
}

export interface PageSnapshots {
  /** 打开时读的那一份（读过就是同一个 Promise，不会拒绝）：能用的快照，或者没有 */
  load(): Promise<OpenSnapshot | undefined>;
  /** 要存的变了：攒着，闲下来再取一份写（take 到写的时候才调，取的是那时最新的） */
  save(take: () => OpenSnapshot): void;
  /** 攒着的马上写（切到后台、关页面时） */
  flush(): void;
  /** 删掉（回到配对页）：之后这个页面上不再存 */
  clear(): Promise<void>;
}

export interface PageSnapshotsOptions {
  /** 页面自己是哪一版（构建产物的哈希） */
  webVersion: string;
  protocolVersion: number;
  backend: SnapshotBackend;
  /** 读多久还没读出来就当没有 */
  loadTimeoutMs?: number;
  /** 最后一次变化之后多久写 */
  idleMs?: number;
  /** 一直在变时最多攒多久 */
  maxWaitMs?: number;
  now?: () => Date;
}

const LOAD_TIMEOUT_MS = 1500;
const IDLE_MS = 3000;
const MAX_WAIT_MS = 30_000;

export function pageSnapshots(options: PageSnapshotsOptions): PageSnapshots {
  const { webVersion, protocolVersion, backend } = options;
  const idleMs = options.idleMs ?? IDLE_MS;
  const maxWaitMs = options.maxWaitMs ?? MAX_WAIT_MS;
  const now = options.now ?? (() => new Date());
  let loading: Promise<OpenSnapshot | undefined> | undefined;
  let cleared = false;
  let pending: (() => OpenSnapshot) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstPendingAt = 0;
  let writing: Promise<void> | undefined;

  const read = async (): Promise<OpenSnapshot | undefined> => {
    const stored = (await backend.read()) as Partial<StoredSnapshot> | undefined | null;
    if (stored === undefined || stored === null) return undefined;
    const usable = stored.format === OPEN_SNAPSHOT_FORMAT && stored.webVersion === webVersion && stored.protocolVersion === protocolVersion && isOpenSnapshot(stored.snapshot);
    if (usable) return stored.snapshot;
    // 网页升级了、格式改了、读坏了：这份以后也用不上，删掉
    await backend.remove().catch(() => undefined);
    return undefined;
  };

  const write = (): void => {
    if (cleared || !pending) return;
    if (writing) return; // 正在写：写完接着写攒着的
    const take = pending;
    pending = undefined;
    let snapshot: OpenSnapshot;
    try {
      snapshot = take();
    } catch {
      return;
    }
    const stored: StoredSnapshot = { format: OPEN_SNAPSHOT_FORMAT, webVersion, protocolVersion, savedAt: now().toISOString(), snapshot };
    writing = backend
      .write(stored)
      .catch(() => undefined)
      .then(() => {
        writing = undefined;
        // 写着的时候又变了：接着写
        if (pending && timer === undefined) schedule();
      });
  };

  const schedule = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    const waited = Date.now() - firstPendingAt;
    timer = setTimeout(
      () => {
        timer = undefined;
        write();
      },
      Math.max(0, Math.min(idleMs, maxWaitMs - waited)),
    );
  };

  return {
    load() {
      loading ??= new Promise<OpenSnapshot | undefined>((resolve) => {
        const giveUp = setTimeout(() => resolve(undefined), options.loadTimeoutMs ?? LOAD_TIMEOUT_MS);
        read().then(
          (snapshot) => {
            clearTimeout(giveUp);
            resolve(cleared ? undefined : snapshot);
          },
          () => {
            clearTimeout(giveUp);
            resolve(undefined);
          },
        );
      });
      return loading;
    },
    save(take) {
      if (cleared) return;
      if (!pending) firstPendingAt = Date.now();
      pending = take;
      schedule();
    },
    flush() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      write();
    },
    async clear() {
      cleared = true;
      pending = undefined;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      // 正在写的那一份写完再删，不然删在前、写在后，快照又回来了
      await writing;
      await backend.remove().catch(() => undefined);
    },
  };
}
