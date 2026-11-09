// 手机本机存的聊天记录（457）的等价性，拿真的守护进程那一头锁：事件日志用真的事件库和会话的派生视图，往上翻的一页用
// conversation/history.ts 的 historyPage，第一次订阅补发的照网关（firstReplayAfter + replayPins，先补的几条在前），带游标的照
// store.read。网页那一头是真的状态层（reduce）和本机存的聊天记录（app/chat-cache.ts，IndexedDB 换成 web 测试里的假后端）。
// 同一个会话，几轮"打开（热打开带快照的游标、网页换了一版冷打开）→ 开着时又来事 → 往上翻到头 → 关掉 → 关着时又来事"：
// 每一轮"本机存的 + 向电脑要的"拼出来的，和一台新设备全部向电脑要的一样——回退、切换分支、正在回复的一轮、重新识别语音、
// 彻底删除都在里面。
import path from "node:path";
import {
  CHANNELS,
  type ConversationBranches,
  EVENT_TYPES,
  type EventFrame,
  grownTree,
  type MessageEventPayload,
  nextBranchId,
  nowIso,
  rollbackFork,
  switchedTree,
  type VoiceRecord,
} from "@ergo/protocol";
import { describe, expect, test } from "vitest";
import { type ChatCache, chatHistoryCache } from "../../../web/src/app/chat-cache.ts";
import { conversationView, initialUiState, olderHistory, onPathOf, reduce, snapshotOf, type UiInput, type UiState } from "../../../web/src/state/index.ts";
import { FakeChatBackend } from "../../../web/test/chat-cache/fake-backend.ts";
import { appendMessage, buildTimelineRecord } from "../../src/conversation/messages.ts";
import { firstReplayAfter, historyPage, replayPins } from "../../src/conversation/history.ts";
import { branchTreeOf } from "../../src/conversation/session-branches.ts";
import { conversationViews } from "../../src/conversation/views.ts";
import { deletedMarker } from "../../src/events/purge.ts";
import { type EventStore, openEventStore, type StoredEvent } from "../../src/events/event-store.ts";
import { agentVoicesView } from "../../src/voice-records/agent-views.ts";
import { voicesView } from "../../src/voice-records/views.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const S = CHANNELS.secretary;
const frameOf = (e: StoredEvent): EventFrame => ({ channel: e.channel, seq: e.seq, type: e.type, payload: e.payload });

/** 网关的订阅补发：游标 0 先补最新那条会话树、这一页消息的语音对象，再补最近一页起的；否则游标之后的全部 */
function subscribe(store: EventStore, cursor: number): EventFrame[] {
  const from = cursor === 0 ? firstReplayAfter(store, S) : cursor;
  const replay = store.read(S, from);
  const pinned = cursor === 0 ? replayPins(store, S, from, replay) : [];
  return [...pinned, ...replay].map(frameOf);
}

class Device {
  state: UiState = initialUiState;
  readonly cache: ChatCache | undefined;
  served = 0;
  asked = 0;
  private cursor = 0;

  private readonly store: EventStore;

  constructor(store: EventStore, backend: FakeChatBackend | undefined) {
    this.store = store;
    this.cache = backend ? chatHistoryCache({ backend, protocolVersion: 1, idleMs: 0, maxWaitMs: 0 }) : undefined;
  }

  private deliver(input: UiInput): void {
    this.cache?.note(input);
    this.state = reduce(this.state, input);
  }

  open(from?: UiState): this {
    const snapshot = from && snapshotOf(from);
    if (snapshot) this.state = reduce(this.state, { kind: "restore", snapshot });
    const cursor = snapshot?.cursors[S] ?? 0;
    this.cache?.begin({ [S]: cursor }, snapshot ? (c) => snapshot.conversations[c]?.branches : undefined);
    this.deliver({ kind: "batch", inputs: [...subscribe(this.store, cursor).map((frame): UiInput => ({ kind: "frame", frame, catchUp: true })), { kind: "synced" }] });
    this.cursor = this.store.lastSeq(S);
    return this;
  }

  live(): void {
    for (const e of this.store.read(S, this.cursor)) this.deliver({ kind: "frame", frame: frameOf(e) });
    this.cursor = this.store.lastSeq(S);
  }

  async scrollToTop(): Promise<this> {
    for (let i = 0; i < 200; i++) {
      const { canLoadOlder, before } = olderHistory(this.state, S);
      if (!canLoadOlder || before === undefined) break;
      const cached = await this.cache?.page(S, before, undefined, this.state.conversations[S]?.branches);
      if (cached) {
        this.served += 1;
        this.state = reduce(this.state, { kind: "history_page", conversation: S, page: cached });
        continue;
      }
      const ticket = this.cache?.ticket(S);
      this.asked += 1;
      const page = historyPage(this.store, S, { before });
      this.state = reduce(this.state, { kind: "history_page", conversation: S, page });
      if (ticket !== undefined) this.cache?.keep(S, before, page, ticket);
    }
    return this;
  }

  async close(): Promise<UiState> {
    for (let i = 0; this.cache && i < 5; i++) {
      this.cache.flush();
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    return this.state;
  }
}

/** 界面上看到的：当前分支上的条目（"已删除"的只剩标记），连同语音消息的识别结果、时间线记录 */
function shown(state: UiState) {
  const items = conversationView(state, S);
  const conv = state.conversations[S];
  return {
    items: items.map((it) => (it.kind === "deleted" ? `deleted:${it.key}` : it.kind === "message" ? it.message.id : it.kind)),
    voices: items.flatMap((it) => (it.kind === "message" ? it.message.parts.flatMap((p) => (p.type === "voice" && p.voiceId ? [state.voices[p.voiceId]?.recognition?.text ?? null] : [])) : [])),
    records: (conv?.records ?? []).filter(({ seq }) => onPathOf(conv?.branches)(seq)).map((r) => r.seq),
    exhausted: conv?.olderExhausted,
  };
}

/** 一台新设备（不存）冷打开、一直向电脑要到头 */
const fresh = async (store: EventStore) => shown((await new Device(store, undefined).open().scrollToTop()).state);

/** 一个会话的事件日志，连同往里加东西的几样（照守护进程写的样子） */
function world() {
  const store = openEventStore({ file: path.join(makeTempDir("ergo-chat-cache-"), "ergo.db"), views: [...conversationViews, voicesView, agentVoicesView] });
  let n = 0;
  const say = (count: number, prefix: string) => {
    for (let i = 0; i < count; i++) {
      n += 1;
      appendMessage(store, { conversation: S, speaker: i % 2 ? "agent" : "user", parts: [{ type: "text", text: `${prefix} 第 ${n} 句` }] }, {});
      if (n % 9 === 0) store.append(buildTimelineRecord(S, { kind: "deviation", summary: `记录 ${n}` }).event);
    }
  };
  const messageSeqs = () => store.read(S, 0, EVENT_TYPES.message).map((e) => e.seq);
  const tree = (): ConversationBranches => branchTreeOf(store.reader, S);
  const rollbackTo = (seq: number) => {
    const t = tree();
    const at = store.lastSeq(S) + 1;
    const branches = grownTree(t, { id: nextBranchId(t), ...rollbackFork(t, { seq })! }, at, undefined);
    store.append({ channel: S, type: EVENT_TYPES.sessionBranch, payload: { change: "rollback", branches, from: t.current, to: branches.current, by: "user", time: nowIso() } });
  };
  const switchBack = () => {
    const t = tree();
    if (t.branches.length < 2) return;
    const to = t.branches.find((b) => b.id !== t.current)!.id;
    store.append({ channel: S, type: EVENT_TYPES.sessionBranch, payload: { change: "switch", branches: switchedTree(t, to, store.lastSeq(S) + 1, undefined), from: t.current, to, by: "user", time: nowIso() } });
  };
  let voiceNo = 0;
  const voiceVersions = new Map<string, number>();
  const voice = (id: string, messageId: string, text: string) => {
    const version = (voiceVersions.get(id) ?? 0) + 1;
    voiceVersions.set(id, version);
    const record: VoiceRecord = { id, messageId, conversation: S, mediaId: "a".repeat(64), mime: "audio/webm", durationMs: 1500, waveform: [1, 2], status: "done", attempt: version, recognition: { text } as unknown as VoiceRecord["recognition"], createdAt: nowIso(), updatedAt: nowIso(), version };
    store.append({ channel: S, type: EVENT_TYPES.voice, payload: { voice: record } });
  };
  const sayVoice = () => {
    voiceNo += 1;
    const id = `v-${voiceNo}`;
    const message = appendMessage(store, { conversation: S, speaker: "user", parts: [{ type: "voice", voiceId: id, mediaId: "a".repeat(64), mime: "audio/webm", durationMs: 1500, waveform: [1, 2] }] }, {});
    voice(id, message.id, `语音 ${voiceNo}`);
    return { id, messageId: message.id };
  };
  /** 正在回复的一轮：用户说一句、回合开始、agent 说一串（这一轮还没完：冷打开时补发从这一轮开头起） */
  const openTurn = (count: number) => {
    const input = appendMessage(store, { conversation: S, speaker: "user", parts: [{ type: "text", text: "开一轮" }] }, {});
    store.append({ channel: S, type: EVENT_TYPES.turnStart, payload: { inputMessageId: input.id } });
    for (let i = 0; i < count; i++) appendMessage(store, { conversation: S, speaker: "agent", parts: [{ type: "text", text: `回复 ${i}` }] }, {});
    return input.id;
  };
  const purge = (seq: number) => {
    const event = store.eventAt(S, seq)!;
    const { message } = event.payload as MessageEventPayload;
    const voices = store.read(S, 0, EVENT_TYPES.voice).filter((e) => (e.payload as { voice: VoiceRecord }).voice.messageId === message.id);
    const deletedAt = nowIso();
    store.appendBatch([{ channel: S, type: EVENT_TYPES.messagesPurged, payload: { messages: [{ seq, messageId: message.id }], materialIds: [], toolCallIds: [], mediaIds: [], deletedAt } }], {
      purge: [event, ...voices].map((e) => ({ globalSeq: e.globalSeq, payload: deletedMarker(e, deletedAt) })),
    });
  };

  return { store, say, messageSeqs, rollbackTo, switchBack, voice, sayVoice, openTurn, purge };
}

describe("本机存的 + 向电脑要的 = 全部向电脑要的（真的事件库和 historyPage）", () => {
  test("几轮打开、关掉，回退、切换分支、正在回复的一轮、重新识别、彻底删除交替着来", async () => {
    const { store, say, messageSeqs, rollbackTo, switchBack, voice, sayVoice, openTurn, purge } = world();
    say(80, "开头");
    const firstVoice = sayVoice();
    say(40, "接着");
    let pendingTurn: string | undefined;
    const steps: ((round: number) => void)[] = [
      (r) => say(25 + r * 3, `第 ${r} 轮`),
      () => {
        const seqs = messageSeqs();
        rollbackTo(seqs[seqs.length - 15]!);
        say(4, "回退后");
      },
      () => {
        pendingTurn = openTurn(70);
      },
      () => {
        if (pendingTurn) store.append({ channel: S, type: EVENT_TYPES.turnEnd, payload: { inputMessageId: pendingTurn, outcome: "completed" } });
        pendingTurn = undefined;
        voice(firstVoice.id, firstVoice.messageId, "重新识别的第一段语音");
        sayVoice();
        say(55, "又一页");
      },
      () => {
        switchBack();
        say(3, "切回来");
      },
      () => {
        const target = store.read(S, 0, EVENT_TYPES.message).find((e) => (e.payload as MessageEventPayload).message?.speaker === "user" && !("deleted" in (e.payload as object)));
        if (target) purge(target.seq);
        say(2, "删完");
      },
    ];

    const backend = new FakeChatBackend();
    let snapshot: UiState | undefined;
    let served = 0;
    let asked = 0;
    for (let round = 0; round < 12; round++) {
      const device = new Device(store, backend).open(round % 3 === 2 ? undefined : snapshot);
      steps[round % steps.length]!(round);
      device.live();
      await device.scrollToTop();
      expect(shown(device.state), `第 ${round} 轮`).toEqual(await fresh(store));
      served += device.served;
      asked += device.asked;
      snapshot = await device.close();
      steps[(round + 3) % steps.length]!(round);
    }
    // 两头都走到了
    expect(served).toBeGreaterThan(5);
    expect(asked).toBeGreaterThan(3);
    store.close();
  });
  test("回退之后新分支上说了一页多才打开（本机只有新分支上的）、之后切回原来那条再冷打开：截到分叉之前，切回来的那段向电脑要", async () => {
    const { store, say, messageSeqs, rollbackTo, switchBack } = world();
    say(120, "开头");
    rollbackTo(messageSeqs()[60]!);
    say(60, "新分支");
    const backend = new FakeChatBackend();
    const first = new Device(store, backend).open();
    await first.scrollToTop();
    await first.close();
    switchBack();
    say(2, "切回来");
    const again = new Device(store, backend).open();
    await again.scrollToTop();
    expect(shown(again.state)).toEqual(await fresh(store));
    expect(again.served).toBeGreaterThan(0);
    expect(again.asked).toBeGreaterThan(0);
    store.close();
  });

  test("关掉期间彻底删除了一条、又来了一页多再冷打开：中间那截没看到，本机存的不用", async () => {
    const { store, say, purge, messageSeqs } = world();
    say(120, "开头");
    const backend = new FakeChatBackend();
    const first = new Device(store, backend).open();
    await first.scrollToTop();
    await first.close();
    purge(messageSeqs()[2]!);
    say(70, "之后");
    const again = new Device(store, backend).open();
    await again.scrollToTop();
    expect(again.served).toBe(0);
    expect(shown(again.state)).toEqual(await fresh(store));
    store.close();
  });
});
