// 在真的 Chrome 里量打开页面（388）：页面脚本跑之前装上的一段（addInitScript），记 React 每次提交（渲染）的时刻
// （React 开发者工具的挂钩，生产构建也认）、WebSocket 上收到几帧、主订阅的回执什么时候到（补发推完了）。
// 改之前、改之后的构建都能这样量，不用往页面里加东西。
import type { Page } from "playwright-core";

/** 页面脚本跑之前装上（字符串：在页面里跑，不经 TypeScript） */
export const MEASURE_SCRIPT = `(() => {
  const m = { commits: [], frames: 0, receiptId: undefined, firstFrameAt: undefined, lastFrameAt: undefined, syncedAt: undefined };
  window.__openMeasure = m;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject() { return 1; },
    onCommitFiberRoot() { m.commits.push(Date.now()); },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onScheduleFiberRoot() {},
    checkDCE() {},
  };
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(url, protocols) {
      super(url, protocols);
      this.addEventListener("message", (ev) => {
        const text = String(ev.data);
        if (text.startsWith('{"channel"')) {
          m.frames += 1;
          if (m.firstFrameAt === undefined) m.firstFrameAt = Date.now();
          m.lastFrameAt = Date.now();
        } else if (m.receiptId !== undefined && m.syncedAt === undefined && text.startsWith('{"id":"' + m.receiptId + '"')) {
          m.syncedAt = Date.now();
        }
      });
    }
    send(data) {
      try {
        const req = JSON.parse(data);
        if (m.receiptId === undefined && req.method === "subscribe" && req.params && Object.keys(req.params.cursors).length === 0) m.receiptId = req.id;
      } catch {}
      return super.send(data);
    }
  };
})();`;

/** 一次打开量到的 */
export interface OpenMeasure {
  /** 页面收到的事件帧 */
  frames: number;
  /** React 一共提交（渲染）了几次：从页面开始到补完之后安静下来 */
  commits: number;
  /** 补发的帧在路上的时候（第一帧到、回执到之间）提交了几次：中间状态画了几遍 */
  commitsWhileCatchingUp: number;
  /** 从页面开始到回执到（补发推完了）多少毫秒 */
  syncedMs: number | undefined;
  /** 从页面开始到补完之后那一次提交（界面画成最后的样子）多少毫秒 */
  paintedMs: number | undefined;
}

/** 等补发推完、再安静 quietMs（没有新的提交），交回量到的 */
export async function waitOpened(page: Page, timeoutMs = 60_000, quietMs = 1000): Promise<OpenMeasure> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const m = await read(page);
    const last = Math.max(m.commits.at(-1) ?? 0, m.syncedAt ?? 0);
    if (m.syncedAt !== undefined && m.now - last >= quietMs) return summarize(m);
    if (Date.now() > deadline) throw new Error(`等了 ${timeoutMs / 1000} 秒还没补完：${JSON.stringify({ frames: m.frames, syncedAt: m.syncedAt })}`);
    await page.waitForTimeout(200);
  }
}

interface RawMeasure {
  commits: number[];
  frames: number;
  firstFrameAt: number | undefined;
  syncedAt: number | undefined;
  origin: number;
  now: number;
}

async function read(page: Page): Promise<RawMeasure> {
  return (await page.evaluate(
    `(() => { const m = window.__openMeasure; return { commits: m.commits, frames: m.frames, firstFrameAt: m.firstFrameAt, syncedAt: m.syncedAt, origin: performance.timeOrigin, now: Date.now() }; })()`,
  )) as RawMeasure;
}

function summarize(m: RawMeasure): OpenMeasure {
  const synced = m.syncedAt;
  const from = m.firstFrameAt ?? synced ?? 0;
  const painted = synced === undefined ? undefined : m.commits.find((t) => t >= synced);
  return {
    frames: m.frames,
    commits: m.commits.length,
    commitsWhileCatchingUp: synced === undefined ? 0 : m.commits.filter((t) => t > from && t < synced).length,
    syncedMs: synced === undefined ? undefined : Math.round(synced - m.origin),
    paintedMs: painted === undefined ? undefined : Math.round(painted - m.origin),
  };
}

/** 这台设备上存着的本机快照（库名、表名、键照 app/open-snapshot.ts）：存的时候页面是哪一版、各频道的游标；没有是 null */
export async function storedSnapshot(page: Page): Promise<{ webVersion: string; cursors: Record<string, number>; conversations: Record<string, { messages: unknown[] }> } | null> {
  return (await page.evaluate(`new Promise((resolve) => {
    const open = indexedDB.open("ergo-page", 1);
    open.onupgradeneeded = () => { if (!open.result.objectStoreNames.contains("open-snapshot")) open.result.createObjectStore("open-snapshot"); };
    open.onerror = () => resolve(null);
    open.onsuccess = () => {
      const db = open.result;
      const get = db.transaction("open-snapshot").objectStore("open-snapshot").get("latest");
      get.onsuccess = () => {
        const v = get.result;
        db.close();
        resolve(v ? { webVersion: v.webVersion, cursors: v.snapshot.cursors, conversations: v.snapshot.conversations } : null);
      };
      get.onerror = () => { db.close(); resolve(null); };
    };
  })`)) as never;
}

/** 这台设备上存着的整份快照（不只是几样：比两次打开存下的一样不一样）；没有是 null */
export async function storedSnapshotFull(page: Page): Promise<{ webVersion: string; snapshot: Record<string, unknown>; events?: { through: Record<string, number> } } | null> {
  return (await page.evaluate(`new Promise((resolve) => {
    const open = indexedDB.open("ergo-page", 1);
    open.onupgradeneeded = () => { if (!open.result.objectStoreNames.contains("open-snapshot")) open.result.createObjectStore("open-snapshot"); };
    open.onerror = () => resolve(null);
    open.onsuccess = () => {
      const db = open.result;
      const get = db.transaction("open-snapshot").objectStore("open-snapshot").get("latest");
      get.onsuccess = () => { db.close(); resolve(get.result ?? null); };
      get.onerror = () => { db.close(); resolve(null); };
    };
  })`)) as never;
}

/** 这台设备上存着的事件（452：和快照同一张表，键是 [频道, 序号]），按频道数 */
export async function storedEventCounts(page: Page): Promise<Record<string, number>> {
  return (await page.evaluate(`new Promise((resolve) => {
    const open = indexedDB.open("ergo-page", 1);
    open.onupgradeneeded = () => { if (!open.result.objectStoreNames.contains("open-snapshot")) open.result.createObjectStore("open-snapshot"); };
    open.onerror = () => resolve({});
    open.onsuccess = () => {
      const db = open.result;
      const keys = db.transaction("open-snapshot").objectStore("open-snapshot").getAllKeys(IDBKeyRange.lowerBound([]));
      keys.onsuccess = () => {
        db.close();
        const counts = {};
        for (const [channel] of keys.result) counts[channel] = (counts[channel] ?? 0) + 1;
        resolve(counts);
      };
      keys.onerror = () => { db.close(); resolve({}); };
    };
  })`)) as never;
}

/** 等本机快照存下来（闲下来 3 秒才写），并且游标追上 cursors（给了的话） */
export async function waitStored(page: Page, cursors?: Record<string, number>, timeoutMs = 15_000): Promise<NonNullable<Awaited<ReturnType<typeof storedSnapshot>>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const stored = await storedSnapshot(page);
    if (stored && (cursors === undefined || Object.entries(cursors).every(([c, n]) => (stored.cursors[c] ?? 0) >= n))) return stored;
    if (Date.now() > deadline) throw new Error(`等了 ${timeoutMs / 1000} 秒本机快照还没存下来：${JSON.stringify(stored?.cursors ?? null)}`);
    await page.waitForTimeout(300);
  }
}
