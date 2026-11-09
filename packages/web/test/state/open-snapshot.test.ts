// 打开页面时先用的本机快照（388）：存哪些、会话留多少、先用快照再补增量和从头补出来的一样；补发攒着一次交（batch）和逐帧交一样。
// 本机存的事件（452）：网页换了一版时用本机存的事件重新折一遍、再补增量，和守护进程冷补发折出来的一样。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  CHANNELS,
  conversationView,
  type EventFrame,
  HISTORY_PAGE_SIZE,
  initialUiState,
  isEphemeralEventType,
  isOpenSnapshot,
  keepsOpenEvents,
  olderHistory,
  reduce,
  refoldInput,
  replay,
  snapshotChanged,
  snapshotOf,
  type UiInput,
  type UiState,
} from "../../src/state/index.ts";
import { syntheticLog, USER_SCALE } from "../open-snapshot/synthetic.ts";

const RECORDINGS = path.join(import.meta.dirname, "recordings");

function load(name: string): UiInput[] {
  return JSON.parse(fs.readFileSync(path.join(RECORDINGS, name), "utf8")) as UiInput[];
}

/** 先用快照（存了再读回来：IndexedDB 存的是结构化克隆，这里用 JSON 走一遍，存不下的东西会露出来） */
function restored(snapshotFrom: UiState): UiState {
  const snapshot = JSON.parse(JSON.stringify(snapshotOf(snapshotFrom))) as ReturnType<typeof snapshotOf>;
  return reduce(initialUiState, { kind: "restore", snapshot });
}

const voice = (id: string, messageId: string, seq: number): EventFrame => ({
  channel: "secretary",
  seq,
  type: "voice",
  payload: { voice: { id, messageId, conversation: "secretary", mediaId: "x", mime: "audio/webm", durationMs: 1000, waveform: [], status: "done", attempt: 1, version: 1 } },
});

const message = (seq: number, speaker: "user" | "agent" = "agent"): EventFrame => ({
  channel: "secretary",
  seq,
  type: "message",
  payload: { message: { id: `m-${seq}`, conversation: "secretary", speaker, time: "2026-11-03T09:00:00.000+08:00", parts: [{ type: "text", text: `第 ${seq} 条` }] } },
});

/**
 * 比较用：语音对象只看留下的消息、排着的消息带的，和还没落到消息上的。快照里截掉了的消息，它的语音对象后来又推来新版本时
 * 先用快照的手里多一条用不上的（消息不在手里，界面不会画它），不算不一样
 */
function comparable(state: UiState) {
  const snap = snapshotOf(state);
  const ids = new Set(Object.values(snap.conversations).flatMap((c) => [...c.messages.flatMap((m) => ("message" in m ? [m.message.id] : [])), ...c.queue.map((q) => q.message.id)]));
  const used = <V extends { messageId?: string }>(voices: Readonly<Record<string, V>>) => Object.fromEntries(Object.entries(voices).filter(([, v]) => v.messageId === undefined || ids.has(v.messageId)));
  return { ...snap, voices: used(snap.voices), agentVoices: used(snap.agentVoices) };
}

describe("先用快照再补增量，和从头补出来的一样（录下的真实事件流）", () => {
  // 打开的时候守护进程补的是游标之后的事件；之前本机做过、还没等到结果的不留（下次打开不再有）
  const names = fs.readdirSync(RECORDINGS).filter((f) => f.endsWith(".json"));
  for (const name of names) {
    test(`录下的 ${name}`, () => {
      const inputs = load(name);
      const full = replay(inputs);
      for (const cut of [Math.floor(inputs.length / 3), Math.floor(inputs.length / 2), Math.floor((inputs.length * 4) / 5)]) {
        const before = replay(inputs.slice(0, cut));
        const after = replay(inputs.slice(cut), restored(before));
        expect(comparable(after), `在第 ${cut} 个输入处存的快照`).toEqual(comparable(full));
        expect(after.cursors).toEqual(full.cursors);
      }
    });
  }

  test("合成的大份数据（会话比一页长、看板上几百个任务）：在中间存一份，先用它再补后面的，和从头补的一样", () => {
    const log = syntheticLog({ ...USER_SCALE, tasks: 30, cards: 40, inboxItems: 40, activityEvents: 200, readMarks: 100, deviceEvents: 20, projectEvents: 30 });
    const frames = [...log.channels.values()].flat();
    const half = (list: EventFrame[]) => list.filter((f) => f.seq <= Math.floor(log.lastSeq(f.channel) / 2));
    const before = replay(half(frames));
    const rest = frames.filter((f) => f.seq > (before.cursors[f.channel] ?? 0));
    expect(comparable(replay(rest, restored(before)))).toEqual(comparable(replay(frames)));
    expect(snapshotOf(before).conversations.secretary!.messages).toHaveLength(HISTORY_PAGE_SIZE);
  });

  test("agent 语音落到的消息还没到（合成完先改了语音，消息随后才追加）：语音对象照留", () => {
    const agentVoice = { id: "av-1", conversation: "secretary", scope: {}, inputMessageId: "m-1", replyMessageIds: [], status: "done", version: 2, createdAt: "2026-11-03T09:00:00.000+08:00", messageId: "m-later" };
    const state = replay([message(1, "user"), { channel: "secretary", seq: 2, type: "agent_voice", payload: { voice: agentVoice } }]);
    expect(Object.keys(snapshotOf(state).agentVoices)).toEqual(["av-1"]);
  });
});

/** 页面一打开就订阅的频道，照 App.tsx 的先后（守护进程冷补发按订阅的先后一个频道一个频道补） */
const OPENING_ORDER: readonly string[] = [
  CHANNELS.secretary,
  CHANNELS.cards,
  CHANNELS.inbox,
  CHANNELS.board,
  CHANNELS.activity,
  CHANNELS.devices,
  CHANNELS.workdayCalendar,
  CHANNELS.watchCategories,
  CHANNELS.projects,
  CHANNELS.assistantName,
  CHANNELS.readMarks,
  CHANNELS.language,
  CHANNELS.plugins,
  CHANNELS.backgroundAgents,
];

/** 录下的输入里守护进程最后的事件日志：按频道、序号（重新同步过的频道只留之后的；临时事件不算，两边订阅时都补推同样的） */
function serverLog(inputs: readonly UiInput[]): Map<string, EventFrame[]> {
  const log = new Map<string, Map<number, EventFrame>>();
  const visit = (input: UiInput): void => {
    if (input.kind === "batch") return input.inputs.forEach(visit);
    if (input.kind === "resync") return void log.delete(input.channel);
    if (input.kind !== "frame" || isEphemeralEventType(input.frame.type)) return;
    const channel = log.get(input.frame.channel) ?? new Map<number, EventFrame>();
    log.set(input.frame.channel, channel);
    channel.set(input.frame.seq, input.frame);
  };
  inputs.forEach(visit);
  return new Map([...log].map(([c, m]) => [c, [...m.values()].toSorted((a, b) => a.seq - b.seq)]));
}

/** 订阅的先后：一打开就订阅的，后面是后来多订阅的（负责人的会话） */
const orderOf = (log: Map<string, EventFrame[]>): string[] => [...OPENING_ORDER.filter((c) => log.has(c)), ...[...log.keys()].filter((c) => !OPENING_ORDER.includes(c)).toSorted()];

/** 守护进程从头补发（游标全 0）：一个频道一个频道补完，攒着一次交，最后 synced（会话频道两边补的一样，这里补全部） */
function coldOpen(log: Map<string, EventFrame[]>): UiState {
  const inputs: UiInput[] = orderOf(log).flatMap((c) => log.get(c)!.map((frame): UiInput => ({ kind: "frame", frame, catchUp: true })));
  return reduce(initialUiState, { kind: "batch", inputs: [...inputs, { kind: "synced" }] });
}

/**
 * 换了一版：本机存着各频道到 cut 为止的事件（会话频道不存），读出来（IndexedDB 是结构化克隆，这里用 JSON 走一遍）按订阅的先后重新折一遍；
 * 再带着游标订阅——存了的频道守护进程只补 cut 之后的，会话频道游标 0 照冷打开补
 */
function refoldThenIncrement(log: Map<string, EventFrame[]>, cut: (channel: string, frames: EventFrame[]) => number): UiState {
  const order = orderOf(log);
  const cuts = new Map(order.map((c) => [c, keepsOpenEvents(c) ? cut(c, log.get(c)!) : 0]));
  const stored = JSON.parse(JSON.stringify(order.flatMap((c) => log.get(c)!.filter((f) => f.seq <= cuts.get(c)!)))) as EventFrame[];
  const refolded = reduce(initialUiState, refoldInput(stored));
  const increment: UiInput[] = order.flatMap((c) => log.get(c)!.filter((f) => f.seq > cuts.get(c)!).map((frame): UiInput => ({ kind: "frame", frame, catchUp: true })));
  return reduce(refolded, { kind: "batch", inputs: [...increment, { kind: "synced" }] });
}

describe("换了一版：本机存的事件重新折一遍再补增量，和守护进程冷补发折出来的一样（452）", () => {
  const names = fs.readdirSync(RECORDINGS).filter((f) => f.endsWith(".json"));
  for (const name of names) {
    test(`录下的 ${name}`, () => {
      const log = serverLog(load(name));
      const cold = coldOpen(log);
      for (const fraction of [0, 1 / 3, 1 / 2, 4 / 5, 1]) {
        const after = refoldThenIncrement(log, (_c, frames) => frames[Math.floor(frames.length * fraction) - 1]?.seq ?? 0);
        expect(snapshotOf(after), `各频道存到 ${fraction} 处`).toEqual(snapshotOf(cold));
        expect(after.cursors).toEqual(cold.cursors);
      }
    });
  }

  test("合成的用户量级数据（一万多条、十来 MB）：存到一半、存全了，都和冷补发的一样", () => {
    const synthetic = syntheticLog();
    const log = new Map([...synthetic.channels].map(([c, frames]) => [c, frames]));
    const cold = coldOpen(log);
    for (const fraction of [1 / 2, 1]) {
      const after = refoldThenIncrement(log, (_c, frames) => frames[Math.floor(frames.length * fraction) - 1]?.seq ?? 0);
      expect(snapshotOf(after)).toEqual(snapshotOf(cold));
      expect(after.cursors).toEqual(cold.cursors);
    }
  });

  test("会话频道（秘书会话、负责人的会话）不存，别的都存", () => {
    expect(keepsOpenEvents(CHANNELS.secretary)).toBe(false);
    expect(keepsOpenEvents("maintainer:tm-1")).toBe(false);
    for (const channel of OPENING_ORDER.filter((c) => c !== CHANNELS.secretary)) expect(keepsOpenEvents(channel)).toBe(true);
  });
});

describe("存哪些", () => {
  test("不存发送中的、提醒弹窗、被拒的提示、正在生成的回复、连接状态这些临时的；游标、会话、卡片照存", () => {
    const state = replay([
      message(1, "user"),
      { kind: "send_message", conversation: "secretary", idempotencyKey: "k-1", parts: [{ type: "text", text: "还没发到" }], time: "2026-11-03T09:01:00.000+08:00" },
      { kind: "alert", alert: { id: "a-1", title: "到点了" } },
      { kind: "request_failed", idempotencyKey: "k-x", error: "不行" },
      { channel: "secretary", seq: 1, type: "stream", payload: { messageId: "m-2", deltas: [{ part: 0, type: "text", offset: 0, text: "正在" }] } },
      { channel: "cards", seq: 1, type: "card", payload: { card: { id: "c-1", type: "suggest_task", typeVersion: 1, version: 1, status: "pending", createdAt: "2026-11-03T09:00:00.000+08:00", payload: {} } } },
      { kind: "card_action", cardId: "c-1", action: "approve", idempotencyKey: "k-c" },
      { kind: "connection", status: "online" },
      { kind: "synced" },
    ]);
    expect(conversationView(state, "secretary").map((i) => i.kind)).toEqual(["message", "streaming", "pending"]);
    const back = restored(state);
    expect(back.cursors).toEqual({ secretary: 1, cards: 1 });
    expect(conversationView(back, "secretary").map((i) => i.kind)).toEqual(["message"]);
    expect(back.cards["c-1"]).toEqual({ card: state.cards["c-1"]!.card });
    expect(back.alerts).toEqual([]);
    expect(back.failures).toEqual([]);
    expect(back.streams).toEqual({});
    expect(back.connection).toBe("connecting");
    expect(back.caughtUp).toBe(false);
  });

  test("会话只留当前分支上最近一页：更早的、它们的语音对象不留，留下的还能往上翻；没满一页的原样留", () => {
    const frames: EventFrame[] = [];
    for (let seq = 1; seq <= HISTORY_PAGE_SIZE + 10; seq++) frames.push(message(seq));
    const n = HISTORY_PAGE_SIZE + 10;
    frames.push(voice("v-old", "m-3", n + 1), voice("v-new", `m-${n}`, n + 2));
    const state = replay(frames);
    const snap = snapshotOf(state);
    const kept = snap.conversations.secretary!.messages;
    expect(kept).toHaveLength(HISTORY_PAGE_SIZE);
    expect(kept[0]!.seq).toBe(11);
    expect(Object.keys(snap.voices)).toEqual(["v-new"]);
    const back = restored(state);
    expect(olderHistory(back, "secretary")).toEqual({ canLoadOlder: true, before: 11 });
    expect(back.cursors.secretary).toBe(n + 2);

    const short = replay([message(1), message(2)]);
    expect(snapshotOf(short).conversations.secretary!.messages).toHaveLength(2);
  });

  test("已经收到事件了就不再用快照盖", () => {
    const snapshot = snapshotOf(replay([message(1), message(2)]));
    const live = replay([message(1)]);
    expect(reduce(live, { kind: "restore", snapshot })).toBe(live);
  });

  test("要存的那几样变了才算变了：正在生成的回复、弹窗、连接状态变了不算", () => {
    const a = replay([message(1)]);
    expect(snapshotChanged(undefined, a)).toBe(true);
    expect(snapshotChanged(a, reduce(a, { kind: "alert", alert: { id: "a", title: "x" } }))).toBe(false);
    expect(snapshotChanged(a, reduce(a, { kind: "connection", status: "online" }))).toBe(false);
    expect(snapshotChanged(a, reduce(a, { kind: "frame", frame: message(2) }))).toBe(true);
  });

  test("读回来的不像快照就不用", () => {
    expect(isOpenSnapshot(JSON.parse(JSON.stringify(snapshotOf(replay([message(1)])))))).toBe(true);
    expect(isOpenSnapshot(undefined)).toBe(false);
    expect(isOpenSnapshot({ cursors: { secretary: -1 } })).toBe(false);
    expect(isOpenSnapshot({ ...snapshotOf(initialUiState), conversations: [] })).toBe(false);
  });
});

describe("补发攒着一次交", () => {
  test("一次交的和一帧帧交的归并出来一样", () => {
    for (const name of ["multi-project.json", "secretary-reconnect.json", "secretary-resync.json", "task-execution.json"]) {
      const inputs = load(name);
      expect(reduce(initialUiState, { kind: "batch", inputs })).toEqual(replay(inputs));
    }
  });

  test("补发的帧和 synced 一起到：一次就是补完的样子", () => {
    const state = reduce(initialUiState, { kind: "batch", inputs: [{ kind: "frame", frame: message(1), catchUp: true }, { kind: "frame", frame: message(2), catchUp: true }, { kind: "synced" }] });
    expect(state.caughtUp).toBe(true);
    expect(conversationView(state, "secretary")).toHaveLength(2);
  });
});
