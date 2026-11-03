// 本机快照页面那一半（388）：读的时候网页版本、协议版本、格式都对得上才用，对不上的删掉；读不了、太慢当没有；
// 存的时候攒着等闲下来再写、写不进去不抛错；清掉之后不再存。IndexedDB 换成假的（真的在 test/open-snapshot-page.test.ts 里）。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { pageSnapshots, type SnapshotBackend } from "../../src/app/open-snapshot.ts";
import { initialUiState, OPEN_SNAPSHOT_FORMAT, type OpenSnapshot, replay, snapshotOf } from "../../src/state/index.ts";

class FakeBackend implements SnapshotBackend {
  value: unknown = undefined;
  writes: unknown[] = [];
  removes = 0;
  failWrite = false;
  failRead = false;
  readDelayMs = 0;
  writeDelayMs = 0;
  read(): Promise<unknown> {
    if (this.failRead) return Promise.reject(new Error("打不开"));
    return new Promise((resolve) => setTimeout(() => resolve(this.value), this.readDelayMs));
  }
  write(value: unknown): Promise<void> {
    if (this.failWrite) return Promise.reject(new Error("存满了"));
    const done = () => {
      this.value = value;
      this.writes.push(value);
    };
    if (this.writeDelayMs === 0) return Promise.resolve().then(done);
    return new Promise((resolve) =>
      setTimeout(() => {
        done();
        resolve();
      }, this.writeDelayMs),
    );
  }
  remove(): Promise<void> {
    this.removes += 1;
    this.value = undefined;
    return Promise.resolve();
  }
}

const snapshot = (seq: number): OpenSnapshot =>
  snapshotOf(replay([{ channel: "secretary", seq, type: "message", payload: { message: { id: `m-${seq}`, conversation: "secretary", speaker: "user", time: "2026-11-03T09:00:00.000+08:00", parts: [] } } }], initialUiState));

const stored = (snap: OpenSnapshot, over: Record<string, unknown> = {}) => ({ format: OPEN_SNAPSHOT_FORMAT, webVersion: "web-1", protocolVersion: 1, savedAt: "2026-11-03T01:00:00.000Z", snapshot: snap, ...over });

let backend: FakeBackend;
const make = (over: Partial<Parameters<typeof pageSnapshots>[0]> = {}) => pageSnapshots({ webVersion: "web-1", protocolVersion: 1, backend, ...over });

beforeEach(() => {
  vi.useFakeTimers();
  backend = new FakeBackend();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("打开时读", () => {
  test("网页版本、协议版本、格式都对得上：用；读一次（再要还是同一个）", async () => {
    backend.value = stored(snapshot(3));
    const snapshots = make();
    const loading = snapshots.load();
    expect(snapshots.load()).toBe(loading);
    await vi.runAllTimersAsync();
    expect((await loading)?.cursors).toEqual({ secretary: 3 });
  });

  test("网页升级了、协议换了、格式改了、读坏了：不用，当场删掉", async () => {
    for (const over of [{ webVersion: "web-0" }, { protocolVersion: 0 }, { format: OPEN_SNAPSHOT_FORMAT + 1 }, { snapshot: { cursors: "坏的" } }]) {
      backend.value = stored(snapshot(3), over);
      const removes = backend.removes;
      const loading = make().load();
      await vi.runAllTimersAsync();
      expect(await loading).toBeUndefined();
      expect(backend.removes).toBe(removes + 1);
    }
  });

  test("没存过、读不了、1.5 秒还没读出来：当没有（照现在的从头补）", async () => {
    let loading = make().load();
    await vi.runAllTimersAsync();
    expect(await loading).toBeUndefined();

    backend.failRead = true;
    loading = make().load();
    await vi.runAllTimersAsync();
    expect(await loading).toBeUndefined();

    backend.failRead = false;
    backend.value = stored(snapshot(3));
    backend.readDelayMs = 5000;
    loading = make().load();
    await vi.advanceTimersByTimeAsync(1500);
    expect(await loading).toBeUndefined();
  });
});

describe("存", () => {
  test("攒着：最后一次变化之后 3 秒才写一次，写的是那时最新的；一直在变也最多攒 30 秒", async () => {
    const snapshots = make();
    let latest = snapshot(1);
    snapshots.save(() => latest);
    await vi.advanceTimersByTimeAsync(2000);
    latest = snapshot(2);
    snapshots.save(() => latest);
    await vi.advanceTimersByTimeAsync(2999);
    expect(backend.writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(backend.writes).toHaveLength(1);
    expect(backend.value).toMatchObject({ format: OPEN_SNAPSHOT_FORMAT, webVersion: "web-1", protocolVersion: 1, snapshot: { cursors: { secretary: 2 } } });

    // 每 2 秒变一次：30 秒时照样写一次
    for (let i = 0; i < 16; i++) {
      latest = snapshot(10 + i);
      snapshots.save(() => latest);
      await vi.advanceTimersByTimeAsync(2000);
    }
    expect(backend.writes.length).toBeGreaterThanOrEqual(2);
  });

  test("切到后台、关页面：攒着的马上写", async () => {
    const snapshots = make();
    snapshots.save(() => snapshot(5));
    snapshots.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.writes).toHaveLength(1);
  });

  test("写不进去不抛错，之后照样能写", async () => {
    const snapshots = make();
    backend.failWrite = true;
    snapshots.save(() => snapshot(1));
    await vi.advanceTimersByTimeAsync(3000);
    backend.failWrite = false;
    snapshots.save(() => snapshot(2));
    await vi.advanceTimersByTimeAsync(3000);
    expect(backend.writes).toHaveLength(1);
  });

  test("写着的时候又变了：写完接着写最新的", async () => {
    const snapshots = make();
    backend.writeDelayMs = 1000;
    snapshots.save(() => snapshot(1));
    snapshots.flush();
    snapshots.save(() => snapshot(2));
    snapshots.flush();
    await vi.advanceTimersByTimeAsync(5000);
    expect(backend.writes.map((w) => (w as { snapshot: OpenSnapshot }).snapshot.cursors.secretary)).toEqual([1, 2]);
  });
});

describe("清掉（回到配对页）", () => {
  test("删掉存着的，之后不再存；正在写的写完再删，快照不会又回来", async () => {
    const snapshots = make();
    backend.writeDelayMs = 1000;
    snapshots.save(() => snapshot(1));
    snapshots.flush();
    const clearing = snapshots.clear();
    await vi.advanceTimersByTimeAsync(1000);
    await clearing;
    expect(backend.value).toBeUndefined();
    snapshots.save(() => snapshot(2));
    snapshots.flush();
    await vi.advanceTimersByTimeAsync(5000);
    expect(backend.value).toBeUndefined();
  });

  test("还在读的时候清掉了：读到的也不用", async () => {
    backend.value = stored(snapshot(3));
    backend.readDelayMs = 500;
    const snapshots = make();
    const loading = snapshots.load();
    await snapshots.clear();
    await vi.runAllTimersAsync();
    expect(await loading).toBeUndefined();
  });
});
