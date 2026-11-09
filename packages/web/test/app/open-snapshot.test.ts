// 本机快照和本机存的事件，页面那一半（388、452、456）：读的时候网页版本、协议版本、格式都对得上才用快照；网页换了一版（快照格式变了）
// 但协议没变时读存着的事件、只认合并后该留的一条不缺的；协议换了全删；读不了、太慢当没有。存的时候攒着等闲下来再写（快照和事件一个事务）、
// 写不进去不抛错且事件留到下次；存的事件按冷补发同一份规则合并，被盖掉的删掉；冷补发里合并掉的洞认，别的洞不认；452 存的整段照样能用；
// 重新同步的频道清掉；清掉之后不再存。IndexedDB 换成假的（真的在 test/open-snapshot-page.test.ts 里）。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type EventWrite, pageSnapshots, type SnapshotBackend } from "../../src/app/open-snapshot.ts";
import {
  addToCompaction,
  type ChannelCompaction,
  emptyCompaction,
  type EventFrame,
  initialUiState,
  OPEN_EVENTS_FORMAT,
  OPEN_SNAPSHOT_FORMAT,
  type OpenSnapshot,
  REPLAY_COMPACTION_VERSION,
  replay,
  snapshotOf,
  type UiInput,
  type UiState,
} from "../../src/state/index.ts";

/** 照 IndexedDB 那份的样子：快照一个键，事件按 [频道, 序号] 一条一个键；一次写要么全成、要么全不成 */
class FakeBackend implements SnapshotBackend {
  value: unknown = undefined;
  events = new Map<string, EventFrame>();
  writes: { value: unknown; events: EventWrite }[] = [];
  removes = 0;
  eventReads = 0;
  failWrite = false;
  failRead = false;
  readDelayMs = 0;
  eventsDelayMs = 0;
  writeDelayMs = 0;
  read(): Promise<unknown> {
    if (this.failRead) return Promise.reject(new Error("打不开"));
    return new Promise((resolve) => setTimeout(() => resolve(this.value), this.readDelayMs));
  }
  readEvents(): Promise<unknown> {
    this.eventReads += 1;
    const all = [...this.events.values()].toSorted((a, b) => (a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : a.seq - b.seq));
    return new Promise((resolve) => setTimeout(() => resolve(structuredClone(all)), this.eventsDelayMs));
  }
  write(value: unknown, events: EventWrite): Promise<void> {
    if (this.failWrite) return Promise.reject(new Error("存满了"));
    const done = () => {
      if (events.clear === "all") this.events.clear();
      else for (const c of events.clear) for (const k of this.events.keys()) if (k.startsWith(`${c}#`)) this.events.delete(k);
      for (const { channel, seq } of events.remove) this.events.delete(`${channel}#${seq}`);
      for (const f of events.add) this.events.set(`${f.channel}#${f.seq}`, structuredClone(f));
      this.value = structuredClone(value);
      this.writes.push({ value, events });
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
    this.events.clear();
    return Promise.resolve();
  }
  /** 存着的某个频道的序号 */
  seqs(channel: string): number[] {
    return [...this.events.values()].filter((f) => f.channel === channel).map((f) => f.seq);
  }
}

const message = (seq: number): EventFrame => ({ channel: "secretary", seq, type: "message", payload: { message: { id: `m-${seq}`, conversation: "secretary", speaker: "user", time: "2026-11-03T09:00:00.000+08:00", parts: [] } } });
const activity = (seq: number, agentId = `a-${seq}`): EventFrame => ({ channel: "activity", seq, type: "activity", payload: { agentId, state: "working", since: "2026-11-09T09:00:00.000+08:00" } });
const readMark = (seq: number): EventFrame => ({ channel: "read_marks", seq, type: "read_mark", payload: { conversation: "secretary", seq, time: "2026-11-09T09:00:00.000+08:00" } });

const snapshot = (seq: number): OpenSnapshot => snapshotOf(replay([message(seq)], initialUiState));

/** 一个频道这几条合并到哪儿（存着的那一栏里记的） */
function mergedOf(frames: readonly EventFrame[]): ChannelCompaction {
  const state = emptyCompaction();
  for (const f of frames) addToCompaction(state, f);
  return state;
}
/** 存着的事件那一栏（格式 2：合并过的） */
const storedEvents = (byChannel: Record<string, EventFrame[]>) => ({
  format: OPEN_EVENTS_FORMAT,
  rules: REPLAY_COMPACTION_VERSION,
  through: Object.fromEntries(Object.entries(byChannel).map(([c, f]) => [c, f.at(-1)!.seq])),
  merged: Object.fromEntries(Object.entries(byChannel).map(([c, f]) => [c, mergedOf(f)])),
});

const stored = (snap: OpenSnapshot, over: Record<string, unknown> = {}) => ({ format: OPEN_SNAPSHOT_FORMAT, webVersion: "web-1", protocolVersion: 1, savedAt: "2026-11-03T01:00:00.000Z", snapshot: snap, ...over });

let backend: FakeBackend;
const make = (over: Partial<Parameters<typeof pageSnapshots>[0]> = {}) => pageSnapshots({ webVersion: "web-1", protocolVersion: 1, backend, ...over });

/** 连接交来的一样输入：先记一下、再归并（照 store.tsx） */
function deliver(snapshots: ReturnType<typeof make>, state: UiState, input: UiInput): UiState {
  snapshots.note(input);
  return replay([input], state);
}
/** 读完（假的计时器下要拨一下才读得出来） */
async function loaded(snapshots: ReturnType<typeof make>) {
  const loading = snapshots.load();
  await vi.runAllTimersAsync();
  return loading;
}
const frames = (list: EventFrame[]): UiInput => ({ kind: "batch", inputs: [...list.map((frame): UiInput => ({ kind: "frame", frame, catchUp: true })), { kind: "synced" }] });

beforeEach(() => {
  vi.useFakeTimers();
  backend = new FakeBackend();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("打开时读", () => {
  test("网页版本、协议版本、格式都对得上：用快照；读一次（再要还是同一个），不读事件", async () => {
    backend.value = stored(snapshot(3));
    const snapshots = make();
    const loading = snapshots.load();
    expect(snapshots.load()).toBe(loading);
    await vi.runAllTimersAsync();
    const start = await loading;
    expect(start?.kind === "snapshot" && start.snapshot.cursors).toEqual({ secretary: 3 });
    expect(backend.eventReads).toBe(0);
  });

  test("协议换了、格式改了又没存事件、读坏了：不用，当场全删", async () => {
    for (const over of [{ webVersion: "web-0" }, { protocolVersion: 0 }, { format: OPEN_SNAPSHOT_FORMAT + 1 }, { snapshot: { cursors: "坏的" } }, { protocolVersion: 0, events: { format: OPEN_EVENTS_FORMAT, through: {} } }]) {
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

/** 旧版本的页面冷打开、补完、存下来：秘书会话 2 条、活动状态 3 条（三个 agent）、已读位置 2 条（合并后只留后一条） */
async function oldVersionSaved(): Promise<void> {
  const old = pageSnapshots({ webVersion: "web-0", protocolVersion: 1, backend });
  await loaded(old);
  let state = initialUiState;
  state = deliver(old, state, frames([message(1), message(2), activity(1), activity(2), activity(3), readMark(1), readMark(2)]));
  const latest = state;
  old.save(() => snapshotOf(latest));
  await vi.advanceTimersByTimeAsync(3000);
}

describe("换了一版：用本机存的事件（452）", () => {
  test("快照不用，读出存着的事件：会话频道不存，别的频道按订阅的先后交回，游标是存到的那一条", async () => {
    await oldVersionSaved();
    expect(backend.seqs("secretary")).toEqual([]);
    expect(backend.seqs("activity")).toEqual([1, 2, 3]);
    expect(backend.seqs("read_marks")).toEqual([2]);
    expect(backend.value).toMatchObject({ webVersion: "web-0", events: { format: OPEN_EVENTS_FORMAT, rules: REPLAY_COMPACTION_VERSION, through: { activity: 3, read_marks: 2 } } });

    const snapshots = make({ channelOrder: ["secretary", "read_marks", "activity"] });
    const loading = snapshots.load();
    await vi.runAllTimersAsync();
    const start = await loading;
    expect(start?.kind).toBe("events");
    if (start?.kind !== "events") return;
    expect(start.cursors).toEqual({ activity: 3, read_marks: 2 });
    expect(start.events.map((f) => `${f.channel}:${f.seq}`)).toEqual(["read_marks:2", "activity:1", "activity:2", "activity:3"]);
  });

  test("接着补来的增量记下、和新版本的快照一起写；重复、更旧的不记", async () => {
    await oldVersionSaved();
    const snapshots = make();
    const loading = snapshots.load();
    await vi.runAllTimersAsync();
    const start = await loading;
    if (start?.kind !== "events") throw new Error("应该用事件");
    let state = replay([{ kind: "batch", inputs: start.events.map((frame): UiInput => ({ kind: "frame", frame, catchUp: true })) }]);
    // 守护进程只补增量；秘书会话游标 0，补最近一页
    state = deliver(snapshots, state, frames([message(1), message(2), message(3), activity(3), activity(4), readMark(3)]));
    const latest = state;
    snapshots.save(() => snapshotOf(latest));
    await vi.advanceTimersByTimeAsync(3000);
    // 已读位置往后挪了：存着的那条被盖掉，同一次写里删掉
    expect(backend.writes.at(-1)!.events).toEqual({ clear: [], remove: [{ channel: "read_marks", seq: 2 }], add: [activity(4), readMark(3)] });
    expect(backend.value).toMatchObject({ webVersion: "web-1", events: { through: { activity: 4, read_marks: 3 } }, snapshot: { cursors: { secretary: 3, activity: 4, read_marks: 3 } } });
    expect(backend.seqs("activity")).toEqual([1, 2, 3, 4]);
  });

  test("一个频道存着的不全（别的标签页删掉了一段）：这个频道不用、游标不带（守护进程从头补它），第一次写时先删掉它", async () => {
    await oldVersionSaved();
    backend.events.delete("activity#2");
    const snapshots = make();
    const loading = snapshots.load();
    await vi.runAllTimersAsync();
    const start = await loading;
    if (start?.kind !== "events") throw new Error("应该用事件");
    expect(start.cursors).toEqual({ read_marks: 2 });
    expect(start.events.every((f) => f.channel === "read_marks")).toBe(true);
    let state = replay([{ kind: "batch", inputs: start.events.map((frame): UiInput => ({ kind: "frame", frame, catchUp: true })) }]);
    state = deliver(snapshots, state, frames([activity(1), activity(2), activity(3)]));
    const latest = state;
    snapshots.save(() => snapshotOf(latest));
    await vi.advanceTimersByTimeAsync(3000);
    expect(backend.writes.at(-1)!.events.clear).toEqual(["activity"]);
    expect(backend.seqs("activity")).toEqual([1, 2, 3]);
    expect(backend.value).toMatchObject({ events: { through: { activity: 3, read_marks: 2 } } });
  });

  test("读事件太慢（5 秒）：当没有，从头补；第一次写时把存着的全删了重来", async () => {
    await oldVersionSaved();
    backend.eventsDelayMs = 8000;
    const snapshots = make();
    const loading = snapshots.load();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await loading).toBeUndefined();
    await vi.runAllTimersAsync();
    let state = initialUiState;
    state = deliver(snapshots, state, frames([activity(1), activity(2), activity(3), activity(4)]));
    const latest = state;
    snapshots.save(() => snapshotOf(latest));
    await vi.advanceTimersByTimeAsync(3000);
    expect(backend.writes.at(-1)!.events.clear).toBe("all");
    expect(backend.seqs("activity")).toEqual([1, 2, 3, 4]);
    expect(backend.seqs("read_marks")).toEqual([]);
    expect(backend.value).toMatchObject({ events: { through: { activity: 4 } } });
  });
});

describe("同一版：快照和事件接着存", () => {
  test("快照和存的事件游标对得上：接着记增量；对不上（只存了快照）：这次打开不存事件，存着的全删", async () => {
    backend.value = stored(snapshotOf(replay([activity(1), activity(2)])), { events: storedEvents({ activity: [activity(1), activity(2)] }) });
    backend.events.set("activity#1", activity(1));
    backend.events.set("activity#2", activity(2));
    let snapshots = make();
    let loading = snapshots.load();
    await vi.runAllTimersAsync();
    let start = await loading;
    expect(start?.kind).toBe("snapshot");
    if (start?.kind !== "snapshot") return;
    let state = replay([{ kind: "restore", snapshot: start.snapshot }]);
    state = deliver(snapshots, state, frames([activity(3)]));
    let latest = state;
    snapshots.save(() => snapshotOf(latest));
    await vi.advanceTimersByTimeAsync(3000);
    expect(backend.seqs("activity")).toEqual([1, 2, 3]);
    expect(backend.value).toMatchObject({ events: { through: { activity: 3 } } });

    // 快照的游标比存的事件新（事件没跟上）：订阅只补快照之后的，事件接不上了
    backend.value = stored(snapshotOf(replay([activity(1), activity(2), activity(3), activity(4)])), { events: storedEvents({ activity: [activity(1), activity(2), activity(3)] }) });
    snapshots = make();
    loading = snapshots.load();
    await vi.runAllTimersAsync();
    start = await loading;
    if (start?.kind !== "snapshot") throw new Error("应该用快照");
    state = replay([{ kind: "restore", snapshot: start.snapshot }]);
    state = deliver(snapshots, state, frames([activity(5)]));
    latest = state;
    snapshots.save(() => snapshotOf(latest));
    await vi.advanceTimersByTimeAsync(3000);
    expect(backend.writes.at(-1)!.events).toEqual({ clear: "all", remove: [], add: [] });
    expect(backend.events.size).toBe(0);
    expect((backend.value as { events?: unknown }).events).toBeUndefined();
  });

  test("只存快照折到的那部分：连接交来了、状态层还没折进快照的留到下次写", async () => {
    const snapshots = make();
    await loaded(snapshots);
    let state = deliver(snapshots, initialUiState, frames([activity(1), activity(2)]));
    const early = state;
    snapshots.note({ kind: "frame", frame: activity(3) });
    snapshots.save(() => snapshotOf(early));
    await vi.advanceTimersByTimeAsync(3000);
    expect(backend.seqs("activity")).toEqual([1, 2]);
    state = replay([{ kind: "frame", frame: activity(3) }], state);
    const later = state;
    snapshots.save(() => snapshotOf(later));
    await vi.advanceTimersByTimeAsync(3000);
    expect(backend.seqs("activity")).toEqual([1, 2, 3]);
    expect(backend.value).toMatchObject({ events: { through: { activity: 3 } } });
  });

  test("订阅回 resync 的频道：存着的清掉，接着从头补发的从 1 记起", async () => {
    const snapshots = make();
    await loaded(snapshots);
    let state = deliver(snapshots, initialUiState, frames([activity(1), activity(2), activity(3), readMark(1)]));
    let latest = state;
    snapshots.save(() => snapshotOf(latest));
    await vi.advanceTimersByTimeAsync(3000);
    expect(backend.seqs("activity")).toEqual([1, 2, 3]);
    state = deliver(snapshots, state, { kind: "batch", inputs: [{ kind: "resync", channel: "activity" }, { kind: "frame", frame: activity(1, "x"), catchUp: true }, { kind: "synced" }] });
    latest = state;
    snapshots.save(() => snapshotOf(latest));
    await vi.advanceTimersByTimeAsync(3000);
    expect(backend.writes.at(-1)!.events.clear).toEqual(["activity"]);
    expect(backend.seqs("activity")).toEqual([1]);
    expect(backend.events.get("activity#1")?.payload).toMatchObject({ agentId: "x" });
    expect(backend.value).toMatchObject({ events: { through: { activity: 1, read_marks: 1 } } });
  });

  test("临时事件、会话频道的不存", async () => {
    const snapshots = make();
    await loaded(snapshots);
    const state = deliver(snapshots, initialUiState, frames([message(1), activity(1), { channel: "activity", seq: 1, type: "web_version", payload: { version: "x" } }, { channel: "maintainer:tm-1", seq: 1, type: "message", payload: message(1).payload }]));
    snapshots.save(() => snapshotOf(state));
    await vi.advanceTimersByTimeAsync(3000);
    expect([...backend.events.keys()]).toEqual(["activity#1"]);
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

  test("写不进去不抛错，事件留到下次一起写", async () => {
    const snapshots = make();
    await loaded(snapshots);
    backend.failWrite = true;
    let state = deliver(snapshots, initialUiState, frames([activity(1), activity(2)]));
    let latest = state;
    snapshots.save(() => snapshotOf(latest));
    await vi.advanceTimersByTimeAsync(3000);
    backend.failWrite = false;
    state = deliver(snapshots, state, frames([activity(3)]));
    latest = state;
    snapshots.save(() => snapshotOf(latest));
    await vi.advanceTimersByTimeAsync(3000);
    expect(backend.writes).toHaveLength(1);
    expect(backend.seqs("activity")).toEqual([1, 2, 3]);
    expect(backend.value).toMatchObject({ events: { through: { activity: 3 } } });
  });

  test("写着的时候又变了：写完接着写最新的", async () => {
    const snapshots = make();
    backend.writeDelayMs = 1000;
    snapshots.save(() => snapshot(1));
    snapshots.flush();
    snapshots.save(() => snapshot(2));
    snapshots.flush();
    await vi.advanceTimersByTimeAsync(5000);
    expect(backend.writes.map((w) => (w.value as { snapshot: OpenSnapshot }).snapshot.cursors.secretary)).toEqual([1, 2]);
  });

  test("记下的事件攒得太多（一直写不进去时）：这次打开不再存事件（不一直占着内存）", async () => {
    const snapshots = make({ maxPendingEvents: 3 });
    await loaded(snapshots);
    const state = deliver(snapshots, initialUiState, frames([activity(1), activity(2), activity(3), activity(4)]));
    snapshots.save(() => snapshotOf(state));
    await vi.advanceTimersByTimeAsync(3000);
    expect(backend.events.size).toBe(0);
    expect((backend.value as { events?: unknown }).events).toBeUndefined();
  });
});

describe("清掉（回到配对页）", () => {
  test("快照和事件都删掉，之后不再存；正在写的写完再删，快照不会又回来", async () => {
    const snapshots = make();
    await loaded(snapshots);
    backend.writeDelayMs = 1000;
    const state = deliver(snapshots, initialUiState, frames([activity(1), message(1)]));
    snapshots.save(() => snapshotOf(state));
    snapshots.flush();
    const clearing = snapshots.clear();
    await vi.advanceTimersByTimeAsync(1000);
    await clearing;
    expect(backend.value).toBeUndefined();
    expect(backend.events.size).toBe(0);
    snapshots.note({ kind: "frame", frame: activity(2) });
    snapshots.save(() => snapshot(2));
    snapshots.flush();
    await vi.advanceTimersByTimeAsync(5000);
    expect(backend.value).toBeUndefined();
    expect(backend.events.size).toBe(0);
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

/** 活动状态频道上一个 agent 的一条（同一个 agent 后来的盖掉前面的） */
const busy = (seq: number, agentId = "a") => activity(seq, agentId);
/** 一次写之后存着的那一栏（格式 2） */
const eventsColumn = () => (backend.value as { events?: { format: number; rules: number; through: Record<string, number>; merged: Record<string, ChannelCompaction> } }).events;
/** 冷补发：这几帧一起，补发的；最后 synced */
const catchUp = (list: EventFrame[]): UiInput => frames(list);

describe("本机存的事件按冷补发同一份规则合并（456）", () => {
  test("写入时合并：同一件事后来的盖掉前面的，存着的只留最后一条；被盖掉的在下一次写里删掉", async () => {
    const snapshots = make();
    await loaded(snapshots);
    let state = deliver(snapshots, initialUiState, catchUp([busy(1), busy(2, "b"), busy(3), busy(4)]));
    let latest = state;
    snapshots.save(() => snapshotOf(latest));
    await vi.advanceTimersByTimeAsync(3000);
    // 第一次冷打开：守护进程没合并（比如旧版）也一样，存的时候合并
    expect(backend.writes.at(-1)!.events).toEqual({ clear: "all", remove: [], add: [busy(2, "b"), busy(4)] });
    expect(backend.seqs("activity")).toEqual([2, 4]);
    expect(eventsColumn()).toMatchObject({ format: OPEN_EVENTS_FORMAT, rules: REPLAY_COMPACTION_VERSION, through: { activity: 4 } });

    // 接着来的：a 又变了，b 也变了
    state = deliver(snapshots, state, { kind: "frame", frame: busy(5, "b") });
    state = deliver(snapshots, state, { kind: "frame", frame: busy(6) });
    latest = state;
    snapshots.save(() => snapshotOf(latest));
    await vi.advanceTimersByTimeAsync(3000);
    expect(backend.writes.at(-1)!.events).toEqual({
      clear: [],
      remove: [
        { channel: "activity", seq: 2 },
        { channel: "activity", seq: 4 },
      ],
      add: [busy(5, "b"), busy(6)],
    });
    expect(backend.seqs("activity")).toEqual([5, 6]);
    expect(eventsColumn()!.through).toEqual({ activity: 6 });
  });

  test("守护进程合并过的冷补发中间有洞：从头补的频道认，接着来的实时帧接得上就记", async () => {
    const snapshots = make();
    await loaded(snapshots);
    // 守护进程只发了 3、7（1、2、4、5、6 被盖掉了）
    let state = deliver(snapshots, initialUiState, catchUp([busy(3, "b"), busy(7)]));
    state = deliver(snapshots, state, { kind: "frame", frame: busy(8, "c") });
    const latest = state;
    snapshots.save(() => snapshotOf(latest));
    await vi.advanceTimersByTimeAsync(3000);
    expect(backend.seqs("activity")).toEqual([3, 7, 8]);
    expect(eventsColumn()!.through).toEqual({ activity: 8 });
  });

  test("不该有的洞（增量补发、实时帧跳了一段）：这个频道这次打开不再往下记，存的停在缺的前面；别的频道照记", async () => {
    const snapshots = make();
    await loaded(snapshots);
    let state = deliver(snapshots, initialUiState, catchUp([busy(1), readMark(1)]));
    // 补发完了之后：活动状态跳过了 2，已读位置接得上
    state = deliver(snapshots, state, { kind: "frame", frame: busy(3, "b") });
    state = deliver(snapshots, state, { kind: "frame", frame: busy(4, "c") });
    state = deliver(snapshots, state, { kind: "frame", frame: readMark(2) });
    const latest = state;
    snapshots.save(() => snapshotOf(latest));
    await vi.advanceTimersByTimeAsync(3000);
    expect(backend.seqs("activity")).toEqual([1]);
    expect(backend.seqs("read_marks")).toEqual([2]);
    expect(eventsColumn()!.through).toEqual({ activity: 1, read_marks: 2 });
    // 快照的游标比存的事件新：下次同一版打开不再接着存（照 452）
    expect((backend.value as { snapshot: OpenSnapshot }).snapshot.cursors.activity).toBe(4);
  });

  test("换了一版：只读合并后该留的；该留的缺了一条，这个频道从头补；该留的以外还存着的，下次写删掉", async () => {
    backend.value = stored(snapshot(1), { webVersion: "web-0", events: storedEvents({ activity: [busy(1), busy(2, "b"), busy(3)], read_marks: [readMark(1), readMark(2)] }) });
    // 该留的：活动状态 2、3，已读位置 2。多存了一条活动状态 1（比如别的标签页还没删）；已读位置该留的那条没了
    for (const f of [busy(1), busy(2, "b"), busy(3), readMark(1)]) backend.events.set(`${f.channel}#${f.seq}`, f);
    const snapshots = make();
    const loading = snapshots.load();
    await vi.runAllTimersAsync();
    const start = await loading;
    if (start?.kind !== "events") throw new Error("应该用事件");
    expect(start.events.map((f) => `${f.channel}:${f.seq}`)).toEqual(["activity:2", "activity:3"]);
    expect(start.cursors).toEqual({ activity: 3 });
    let state = replay([{ kind: "batch", inputs: start.events.map((frame): UiInput => ({ kind: "frame", frame, catchUp: true })) }]);
    // 已读位置从头补（合并过的：只有 2）
    state = deliver(snapshots, state, catchUp([readMark(2), busy(4, "b")]));
    const latest = state;
    snapshots.save(() => snapshotOf(latest));
    await vi.advanceTimersByTimeAsync(3000);
    const write = backend.writes.at(-1)!.events;
    expect(write.clear).toEqual(["read_marks"]);
    expect(write.remove).toEqual([
      { channel: "activity", seq: 1 },
      { channel: "activity", seq: 2 },
    ]);
    expect(backend.seqs("activity")).toEqual([3, 4]);
    expect(backend.seqs("read_marks")).toEqual([2]);
    expect(eventsColumn()!.through).toEqual({ activity: 4, read_marks: 2 });
  });

  test("452 存的整段（格式 1，从 1 起一条不缺）：照样用，读出来先合并、只交合并后的；第一次写删掉被盖掉的，记成合并过的", async () => {
    backend.value = stored(snapshot(1), { webVersion: "web-0", events: { format: 1, through: { activity: 4 } } });
    for (const f of [busy(1), busy(2, "b"), busy(3), busy(4)]) backend.events.set(`${f.channel}#${f.seq}`, f);
    const snapshots = make();
    const loading = snapshots.load();
    await vi.runAllTimersAsync();
    const start = await loading;
    if (start?.kind !== "events") throw new Error("应该用事件");
    expect(start.events.map((f) => f.seq)).toEqual([2, 4]);
    expect(start.cursors).toEqual({ activity: 4 });
    let state = replay([{ kind: "batch", inputs: start.events.map((frame): UiInput => ({ kind: "frame", frame, catchUp: true })) }]);
    state = deliver(snapshots, state, catchUp([busy(5, "c")]));
    const latest = state;
    snapshots.save(() => snapshotOf(latest));
    await vi.advanceTimersByTimeAsync(3000);
    expect(backend.writes.at(-1)!.events.remove).toEqual([
      { channel: "activity", seq: 1 },
      { channel: "activity", seq: 3 },
    ]);
    expect(backend.seqs("activity")).toEqual([2, 4, 5]);
    expect(eventsColumn()).toMatchObject({ format: OPEN_EVENTS_FORMAT, rules: REPLAY_COMPACTION_VERSION, through: { activity: 5 } });

    // 整段里缺了一条的：这个频道不用
    backend.value = stored(snapshot(1), { webVersion: "web-0", events: { format: 1, through: { activity: 3 } } });
    backend.events.clear();
    for (const f of [busy(1), busy(3)]) backend.events.set(`${f.channel}#${f.seq}`, f);
    const again = make();
    const loadingAgain = again.load();
    await vi.runAllTimersAsync();
    const startAgain = await loadingAgain;
    expect(startAgain?.kind === "events" && startAgain.cursors).toEqual({});
  });

  test("合并规则换了一版、合并到哪儿对不上 through：存的事件不用，全删、从头补", async () => {
    for (const events of [
      { ...storedEvents({ activity: [busy(1)] }), rules: REPLAY_COMPACTION_VERSION + 1 },
      { ...storedEvents({ activity: [busy(1)] }), through: { activity: 2 } },
      { ...storedEvents({ activity: [busy(1)] }), merged: { activity: { last: 1 } } },
    ]) {
      backend.value = stored(snapshot(1), { webVersion: "web-0", events });
      backend.events.set("activity#1", busy(1));
      const removes = backend.removes;
      const loading = make().load();
      await vi.runAllTimersAsync();
      expect(await loading).toBeUndefined();
      expect(backend.removes).toBe(removes + 1);
    }
  });

  test("写不进去：合并的退回存着的那份，下次写时删的、加的照样对", async () => {
    const snapshots = make();
    await loaded(snapshots);
    let state = deliver(snapshots, initialUiState, catchUp([busy(1), busy(2, "b")]));
    let latest = state;
    snapshots.save(() => snapshotOf(latest));
    await vi.advanceTimersByTimeAsync(3000);
    expect(backend.seqs("activity")).toEqual([1, 2]);
    backend.failWrite = true;
    state = deliver(snapshots, state, { kind: "frame", frame: busy(3) });
    latest = state;
    snapshots.save(() => snapshotOf(latest));
    await vi.advanceTimersByTimeAsync(3000);
    backend.failWrite = false;
    state = deliver(snapshots, state, { kind: "frame", frame: busy(4, "b") });
    latest = state;
    snapshots.save(() => snapshotOf(latest));
    await vi.advanceTimersByTimeAsync(3000);
    expect(backend.seqs("activity")).toEqual([3, 4]);
    expect(eventsColumn()!.through).toEqual({ activity: 4 });
  });
});
