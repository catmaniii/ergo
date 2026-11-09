// 手机本机存的聊天记录（457），页面那一半：往上翻时本机有的直接用、没有才向电脑要、要来的存下；缺一截只要缺的；
// 回退、彻底删除、resync、移除插件连数据删、删任务、协议变了、吊销都作废对；上限和淘汰；几个标签页各记各的；存不了照旧向电脑要。
// 等价：同一个会话，"本机存的 + 向电脑要的"拼出来的和一台新设备全部向电脑要的一样（回退之后也一样）。
// "守护进程那一头"照 conversation/history.ts 的规矩（test/chat-cache/history-log.ts），IndexedDB 换成假的（真的在 chat-cache-page.test.ts）。
import { describe, expect, test } from "vitest";
import { type ChatCache, chatHistoryCache, type ChatCacheOptions } from "../../src/app/chat-cache.ts";
import { conversationView, type EventFrame, initialUiState, olderHistory, reduce, snapshotOf, type UiInput, type UiState } from "../../src/state/index.ts";
import { FakeChatBackend } from "../chat-cache/fake-backend.ts";
import { ConversationLog } from "../chat-cache/history-log.ts";

const S = "secretary";

/** 让攒着的写进去 */
const settle = async (cache: ChatCache) => {
  for (let i = 0; i < 5; i++) {
    cache.flush();
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

/** 一台设备上的一次打开：照 store.tsx 接连接、往上翻（本机有的直接用，没有向"守护进程"要，要来的存下） */
class Device {
  state: UiState = initialUiState;
  readonly cache: ChatCache | undefined;
  /** 向电脑要的往上翻（before） */
  readonly asks: number[] = [];
  /** 本机拼的往上翻（before） */
  readonly served: number[] = [];
  private cursor = 0;

  readonly log: ConversationLog;

  constructor(log: ConversationLog, backend: FakeChatBackend | undefined, options: Partial<ChatCacheOptions> = {}) {
    this.log = log;
    this.cache = backend ? chatHistoryCache({ backend, protocolVersion: 1, idleMs: 0, maxWaitMs: 0, ...options }) : undefined;
  }

  private deliver(input: UiInput): void {
    this.cache?.note(input);
    this.state = reduce(this.state, input);
  }

  /** 打开：from 是上次存下的快照（热打开，带它的游标）；不给是冷打开（游标 0，守护进程补最近一页） */
  open(from?: UiState): this {
    const snapshot = from && snapshotOf(from);
    if (snapshot) this.state = reduce(this.state, { kind: "restore", snapshot });
    const cursor = snapshot?.cursors[this.log.channel] ?? 0;
    this.cache?.begin({ [this.log.channel]: cursor }, snapshot ? (c) => snapshot.conversations[c]?.branches : undefined);
    this.deliver({ kind: "batch", inputs: [...this.log.replay(cursor).map((frame): UiInput => ({ kind: "frame", frame, catchUp: true })), { kind: "synced" }] });
    this.cursor = this.log.last;
    return this;
  }

  /** 打开着时守护进程又来了的（实时推来） */
  live(): void {
    for (const frame of this.log.frames.filter((f) => f.seq > this.cursor)) this.deliver({ kind: "frame", frame });
    this.cursor = this.log.last;
  }

  /** 往上翻一次；翻不了了是 false */
  async scrollUp(limit?: number): Promise<boolean> {
    const channel = this.log.channel as "secretary";
    const { canLoadOlder, before } = olderHistory(this.state, channel);
    if (!canLoadOlder || before === undefined) return false;
    const cached = await this.cache?.page(channel, before, limit, this.state.conversations[channel]?.branches);
    if (cached) {
      this.served.push(before);
      this.state = reduce(this.state, { kind: "history_page", conversation: channel, page: cached });
      return true;
    }
    const ticket = this.cache?.ticket(channel);
    this.asks.push(before);
    const page = this.log.page(before, limit);
    this.state = reduce(this.state, { kind: "history_page", conversation: channel, page });
    if (ticket !== undefined) this.cache?.keep(channel, before, page, ticket);
    return true;
  }

  async scrollToTop(): Promise<this> {
    for (let i = 0; i < 100 && (await this.scrollUp()); i++);
    return this;
  }

  async close(): Promise<UiState> {
    if (this.cache) await settle(this.cache);
    return this.state;
  }
}

/** 界面上看到的：当前分支上的条目，连同语音消息的识别结果 */
function shown(state: UiState, channel = S) {
  const items = conversationView(state, channel as "secretary");
  const voices = items.flatMap((it) => (it.kind === "message" ? it.message.parts.flatMap((p) => (p.type === "voice" && p.voiceId ? [state.voices[p.voiceId]?.recognition] : [])) : []));
  return { items: items.map((it) => (it.kind === "deleted" ? `deleted:${it.key}` : it.kind === "message" ? it.message.id : it.kind)), voices, exhausted: state.conversations[channel]?.olderExhausted };
}

/** 一台新设备（不存）冷打开、一直向电脑要到头 */
async function fresh(log: ConversationLog): Promise<UiState> {
  return (await new Device(log, undefined).open().scrollToTop()).state;
}

/** n 条消息，每 10 条后面一条时间线记录 */
function chat(log: ConversationLog, n: number, prefix = "m"): void {
  const base = log.frames.filter((f) => f.type === "message").length;
  for (let i = 1; i <= n; i++) {
    log.say(`${prefix}${base + i}`, `第 ${base + i} 句`, { speaker: i % 2 ? "user" : "agent" });
    if (i % 10 === 0) log.record(`记录 ${base + i}`);
  }
}

describe("往上翻：本机有的直接用，没有才向电脑要，要来的存下", () => {
  test("第一次向电脑要、存下；关掉再热打开往上翻一次都不向电脑要，内容一样", async () => {
    const log = new ConversationLog();
    chat(log, 180);
    const backend = new FakeChatBackend();
    const first = new Device(log, backend).open();
    await first.scrollToTop();
    expect(first.asks).toHaveLength(3);
    const closed = await first.close();
    chat(log, 5);
    const second = new Device(log, backend).open(closed);
    await second.scrollToTop();
    expect(second.asks).toEqual([]);
    expect(second.served.length).toBeGreaterThan(0);
    expect(shown(second.state)).toEqual(shown(await fresh(log)));
  });

  test("网页换了一版（会话频道游标 0、守护进程补最近一页）：关掉期间来的不多，接得上，照样不向电脑要", async () => {
    const log = new ConversationLog();
    chat(log, 150);
    const backend = new FakeChatBackend();
    const first = new Device(log, backend).open();
    await first.scrollToTop();
    await first.close();
    chat(log, 20);
    const second = new Device(log, backend).open();
    await second.scrollToTop();
    expect(second.asks).toEqual([]);
    expect(shown(second.state)).toEqual(shown(await fresh(log)));
  });

  test("冷打开时关掉期间来了一页多（中间那截没看到，可能有彻底删除）：信不过，整个删掉重新存", async () => {
    const log = new ConversationLog();
    chat(log, 120);
    const backend = new FakeChatBackend();
    const first = new Device(log, backend).open();
    await first.scrollToTop();
    await first.close();
    chat(log, 80);
    const second = new Device(log, backend).open();
    await second.scrollToTop();
    expect(second.served).toEqual([]);
    expect(second.asks.length).toBeGreaterThan(0);
    expect(shown(second.state)).toEqual(shown(await fresh(log)));
    // 重新存下的接得上：再热打开一次就都在本机了
    const closedSecond = await second.close();
    const third = new Device(log, backend).open(closedSecond);
    await third.scrollToTop();
    expect(third.asks).toEqual([]);
  });

  test("热打开时本机存的落在快照后面（上次关得急，没写进去）：信不过，整个删掉", async () => {
    const log = new ConversationLog();
    chat(log, 120);
    const backend = new FakeChatBackend();
    const first = new Device(log, backend).open();
    await first.scrollToTop();
    await first.close();
    // 之后又收到几条、快照存下了，本机的聊天记录却没来得及写
    const second = new Device(log, undefined).open(first.state);
    chat(log, 3);
    second.live();
    const third = new Device(log, backend).open(second.state);
    await third.scrollToTop();
    expect(third.served).toEqual([]);
    expect(shown(third.state)).toEqual(shown(await fresh(log)));
  });

  test("缺一截：本机有的先拼出来，缺的那一截再向电脑要（before 正好是本机最早那条，要回来的不重）", async () => {
    const log = new ConversationLog();
    chat(log, 130);
    const backend = new FakeChatBackend();
    // 第一次只翻了一页就关了：本机有最近一页 + 往上一页
    const first = new Device(log, backend).open();
    await first.scrollUp();
    const closed = await first.close();
    const second = new Device(log, backend).open(closed);
    await second.scrollUp();
    expect(second.asks).toEqual([]);
    await second.scrollToTop();
    // 本机的到头之后才向电脑要，要的是本机最早那条之前的
    const earliestCached = Math.min(...backend.messageSeqs(S).filter((seq) => seq < second.asks[0]! + 1000));
    expect(second.asks.length).toBeGreaterThan(0);
    expect(second.asks[0]).toBeLessThanOrEqual(earliestCached);
    expect(shown(second.state)).toEqual(shown(await fresh(log)));
  });

  test("一页多少条照往上翻要的（任务详情一次 200 条）：本机够就一次拼 200 条", async () => {
    const log = new ConversationLog();
    chat(log, 400);
    const backend = new FakeChatBackend();
    const first = new Device(log, backend).open();
    await first.scrollToTop();
    const closed = await first.close();
    const second = new Device(log, backend).open(closed);
    await second.scrollUp(200);
    expect(second.asks).toEqual([]);
    const conv = second.state.conversations[S]!;
    expect(conv.messages.length).toBe(250);
  });

  test("语音消息：本机存着语音对象的一起拼；关掉期间重新识别过的用新的；缺了又不知道本来没有的向电脑要", async () => {
    const log = new ConversationLog();
    log.say("v-msg", "", { voiceId: "v1" });
    log.voice("v1", "v-msg", 1, "识别第一版");
    chat(log, 120);
    const backend = new FakeChatBackend();
    const first = new Device(log, backend).open();
    await first.scrollToTop();
    const closed = await first.close();
    log.voice("v1", "v-msg", 2, "重新识别的");
    const second = new Device(log, backend).open(closed);
    await second.scrollToTop();
    expect(second.asks).toEqual([]);
    expect(shown(second.state).voices).toEqual([expect.objectContaining({ text: "重新识别的" })]);
    expect(shown(second.state)).toEqual(shown(await fresh(log)));
  });
});

const PLUGIN_PURGED: UiInput = { kind: "frame", frame: { channel: "plugins", seq: 7, type: "plugin_data_purged", payload: { plugin: "voice", at: "2026-11-09T10:00:00.000+08:00", counts: {}, eventTypes: ["voice"], cardTypes: [] } } };

/** 开着、存了一百多条的一台设备 */
async function stored(): Promise<{ log: ConversationLog; backend: FakeChatBackend; device: Device }> {
  const log = new ConversationLog();
  chat(log, 120);
  const backend = new FakeChatBackend();
  const device = new Device(log, backend).open();
  await device.scrollToTop();
  await device.close();
  expect(backend.messageSeqs(S).length).toBeGreaterThan(100);
  return { log, backend, device };
}

describe("作废", () => {
  test("回退过：本机存的截到分叉之前，旧分支上的不出现；拼出来的和全部向电脑要的一样", async () => {
    const log = new ConversationLog();
    chat(log, 150);
    const backend = new FakeChatBackend();
    const first = new Device(log, backend).open();
    await first.scrollToTop();
    const closed = await first.close();
    // 关掉之后在电脑上回到第 90 条消息之前，又说了几句
    const target = log.frames.filter((f) => f.type === "message")[89]!.seq;
    log.rollback(target);
    chat(log, 5, "n");
    const served: number[] = [];
    for (const hot of [true, false]) {
      const again = new Device(log, backend).open(hot ? closed : undefined);
      await again.scrollToTop();
      const view = shown(again.state);
      expect(view).toEqual(shown(await fresh(log)));
      expect(view.items).not.toContain("m120");
      expect(view.items).toContain("m89");
      expect(view.items).toContain("n155");
      served.push(again.served.length);
    }
    // 热打开时分叉之前的照样是本机拼的
    expect(served[0]).toBeGreaterThan(0);
  });

  test("切回一条废弃分支：本机按另一棵树存的那几段截到分叉之前，切回来的那一段向电脑要", async () => {
    const log = new ConversationLog();
    chat(log, 120);
    log.rollback(log.frames.filter((f) => f.type === "message")[60]!.seq);
    chat(log, 60, "n");
    const backend = new FakeChatBackend();
    // 回退之后、新分支上又说了一页多才第一次打开：本机存的全是向电脑要来的当前分支（b1）上的，b0 回退点之后那一段没有
    const first = new Device(log, backend).open();
    await first.scrollToTop();
    await first.close();
    expect(backend.messageSeqs(S)).not.toContain(log.frames.find((f) => f.type === "message" && (f.payload as { message: { id: string } }).message.id === "m100")!.seq);
    log.switchTo("b0");
    chat(log, 2, "z");
    // 网页换了一版再打开：最近一页是 b0 上的
    const again = new Device(log, backend).open();
    await again.scrollToTop();
    expect(shown(again.state)).toEqual(shown(await fresh(log)));
    expect(shown(again.state).items).toContain("m65");
    expect(again.asks.length).toBeGreaterThan(0);
    expect(again.served.length).toBeGreaterThan(0);
  });

  test("开着的时候回退、又切回原来那条：一直和全部向电脑要的一样", async () => {
    const log = new ConversationLog();
    chat(log, 140);
    const backend = new FakeChatBackend();
    const device = new Device(log, backend).open();
    await device.scrollToTop();
    const target = log.frames.filter((f) => f.type === "message")[100]!.seq;
    log.rollback(target);
    chat(log, 3, "r");
    device.live();
    const closedFirst = await device.close();
    let reopened = new Device(log, backend).open(closedFirst);
    await reopened.scrollToTop();
    expect(shown(reopened.state)).toEqual(shown(await fresh(log)));
    log.switchTo("b0");
    reopened.live();
    const closed = await reopened.close();
    reopened = new Device(log, backend).open(closed);
    await reopened.scrollToTop();
    expect(shown(reopened.state)).toEqual(shown(await fresh(log)));
    expect(shown(reopened.state).items).not.toContain("r141");
  });

  test("彻底删除过（关掉期间）：整份作废，删掉的不会从本机冒出来", async () => {
    const log = new ConversationLog();
    log.say("secret", "", { voiceId: "v-secret" });
    log.voice("v-secret", "secret", 1, "不该留下的话");
    chat(log, 130);
    const backend = new FakeChatBackend();
    const first = new Device(log, backend).open();
    await first.scrollToTop();
    const closed = await first.close();
    log.purge([1]);
    const again = new Device(log, backend).open(closed);
    await again.scrollToTop();
    expect(again.served).toEqual([]);
    expect(shown(again.state)).toEqual(shown(await fresh(log)));
    expect(JSON.stringify([...backend.entries.values()])).not.toContain("不该留下的话");
  });

  test("彻底删除过、之后又来了一页多再冷打开：中间那截没看到，信不过、整个删掉", async () => {
    const log = new ConversationLog();
    chat(log, 120);
    const backend = new FakeChatBackend();
    const first = new Device(log, backend).open();
    await first.scrollToTop();
    await first.close();
    log.purge([5]);
    chat(log, 70);
    const again = new Device(log, backend).open();
    await again.scrollToTop();
    expect(again.served).toEqual([]);
    expect(shown(again.state)).toEqual(shown(await fresh(log)));
    await again.close();
    // 删掉的那句只剩"已删除"标记
    expect(JSON.stringify([...backend.entries.values()])).not.toContain("第 5 句");
    expect(backend.messageSeqs(S)).toContain(5);
  });

  test("早就处理过的彻底删除（冷打开补发的那一页里又看到）：不再作废", async () => {
    const log = new ConversationLog();
    chat(log, 120);
    log.purge([3]);
    chat(log, 2);
    const backend = new FakeChatBackend();
    const first = new Device(log, backend).open();
    await first.scrollToTop();
    await first.close();
    const again = new Device(log, backend).open();
    await again.scrollToTop();
    expect(again.asks).toEqual([]);
    expect(shown(again.state)).toEqual(shown(await fresh(log)));
  });

  test("订阅回 resync（任何一个频道：数据目录恢复过）：整份作废", async () => {
    const { backend, device } = await stored();
    device.cache!.note({ kind: "resync", channel: "board" });
    await settle(device.cache!);
    expect(backend.messageSeqs(S)).toEqual([]);
  });

  test("移除插件时连数据删了：整份作废；同一条再看到一遍（重新打开时插件频道照样补发）不再作废", async () => {
    const { log, backend, device } = await stored();
    device.cache!.note(PLUGIN_PURGED);
    await settle(device.cache!);
    expect(backend.messageSeqs(S)).toEqual([]);
    const again = new Device(log, backend).open(device.state);
    await again.scrollToTop();
    await again.close();
    // 热打开：快照里那一页之前的又向电脑要了一遍、存下了
    const kept = backend.messageSeqs(S).length;
    expect(kept).toBeGreaterThan(50);
    again.cache!.note(PLUGIN_PURGED);
    await settle(again.cache!);
    expect(backend.messageSeqs(S)).toHaveLength(kept);
  });

  test("删任务、删项目：负责人的会话整个删掉", async () => {
    const log = new ConversationLog("maintainer:tm-t1");
    chat(log, 60);
    const backend = new FakeChatBackend();
    const device = new Device(log, backend).open();
    await device.scrollToTop();
    await device.close();
    expect(backend.metas.has("maintainer:tm-t1")).toBe(true);
    const task = { id: "t1", maintainerId: "tm-t1", deleted: true };
    device.cache!.note({ kind: "frame", frame: { channel: "board", seq: 3, type: "task", payload: { task, change: "deleted", by: "user" } } as EventFrame });
    await settle(device.cache!);
    expect(backend.metas.has("maintainer:tm-t1")).toBe(false);
    expect(backend.messageSeqs("maintainer:tm-t1")).toEqual([]);
  });

  test("协议版本变了：打开时整份删掉", async () => {
    const log = new ConversationLog();
    chat(log, 80);
    const backend = new FakeChatBackend();
    const device = new Device(log, backend).open();
    await device.scrollToTop();
    const closed = await device.close();
    expect(backend.metas.size).toBe(1);
    const next = new Device(log, backend, { protocolVersion: 2 }).open(closed);
    await next.scrollToTop();
    expect(next.served).toEqual([]);
    expect(backend.clears).toBe(1);
  });

  test("吊销、回到配对页（clear）：整份删掉，之后这个页面上不再存", async () => {
    const log = new ConversationLog();
    chat(log, 80);
    const backend = new FakeChatBackend();
    const device = new Device(log, backend).open();
    await device.scrollToTop();
    await device.close();
    await device.cache!.clear();
    expect(backend.metas.size).toBe(0);
    expect(backend.entries.size).toBe(0);
    chat(log, 5);
    device.live();
    await settle(device.cache!);
    expect(backend.entries.size).toBe(0);
    expect(device.cache!.stats()).toEqual({ state: "off" });
  });
});

describe("上限和淘汰", () => {
  test("超了上限按最久没用过的会话整个删，删到上限的八成；Debug 那一行看得到存了多少", async () => {
    const logs = ["maintainer:a", "maintainer:b", "maintainer:c"].map((c) => new ConversationLog(c));
    for (const log of logs) chat(log, 40);
    // 一个会话存下来多大
    const probe = new FakeChatBackend();
    await new Device(logs[0]!, probe).open().close();
    const one = (probe.metas.get("maintainer:a") as { bytes: number }).bytes;
    // 上限只够两个多一点：一个页面上先后打开 a、b、c 三个负责人的会话
    let t = 1000;
    const backend = new FakeChatBackend();
    const cache = chatHistoryCache({ backend, protocolVersion: 1, idleMs: 0, maxWaitMs: 0, maxBytes: Math.floor(one * 2.6), now: () => (t += 10) });
    cache.begin({});
    for (const log of logs) {
      cache.note({ kind: "batch", inputs: log.replay(0).map((frame): UiInput => ({ kind: "frame", frame, catchUp: true })) });
      await settle(cache);
    }
    // 存第三个时超了：最久没用的 a 删掉（还开着的从现在起重新存），剩下的在八成以内
    expect(backend.messageSeqs("maintainer:a")).toEqual([]);
    expect(backend.messageSeqs("maintainer:b")).toHaveLength(40);
    expect(backend.messageSeqs("maintainer:c")).toHaveLength(40);
    expect(cache.stats()).toEqual({ state: "on", conversations: 2, messages: 80, bytes: one * 2, maxBytes: Math.floor(one * 2.6) });
  });

  test("正在用的那个自己就超了：连它一起删，从现在起重新存", async () => {
    const log = new ConversationLog();
    chat(log, 200);
    const backend = new FakeChatBackend();
    const device = new Device(log, backend, { maxBytes: 20_000 });
    device.open();
    await device.scrollToTop();
    await device.close();
    const stats = device.cache!.stats() as { state: string; bytes: number };
    expect(stats.state).toBe("on");
    expect(stats.bytes).toBeLessThanOrEqual(20_000);
  });
});

describe("几个标签页、存不了", () => {
  test("别的标签页改过这个会话：这个标签页不再存它、也不用它（读的时候核对版本）", async () => {
    const log = new ConversationLog();
    chat(log, 150);
    const backend = new FakeChatBackend();
    const a = new Device(log, backend).open();
    await a.scrollToTop();
    const closedA = await a.close();
    const b = new Device(log, backend).open(closedA);
    const c = new Device(log, backend).open(closedA);
    chat(log, 2);
    b.live();
    await b.close();
    // c 读的时候版本对不上（b 写过）：当没有，向电脑要
    await c.scrollToTop();
    expect(c.served).toEqual([]);
    c.live();
    await c.close();
    // b 写的那份还在
    const d = new Device(log, backend).open(b.state);
    await d.scrollToTop();
    expect(d.asks).toEqual([]);
  });

  test("没有 IndexedDB（隐私模式）、写不进去：照旧向电脑要，不抛错；Debug 那一行说存不了", async () => {
    const log = new ConversationLog();
    chat(log, 120);
    const off = new FakeChatBackend();
    off.unavailable = true;
    const device = new Device(log, off).open();
    await device.scrollToTop();
    expect(device.served).toEqual([]);
    expect(shown(device.state)).toEqual(shown(await fresh(log)));
    expect(device.cache!.stats()).toEqual({ state: "off" });

    const full = new FakeChatBackend();
    const first = new Device(log, full).open();
    full.failWrite = true;
    await first.scrollToTop();
    await first.close();
    expect(first.cache!.stats()).toEqual({ state: "off" });
    full.failWrite = false;
    const second = new Device(log, full).open(first.state);
    await second.scrollToTop();
    expect(shown(second.state)).toEqual(shown(await fresh(log)));
  });
});

describe("等价：本机存的 + 向电脑要的 = 全部向电脑要的", () => {
  test("几轮打开、关掉、回退、切换、彻底删除、重新识别交替着来，每次翻到头都一样", async () => {
    const log = new ConversationLog();
    const backend = new FakeChatBackend();
    let snapshot: UiState | undefined;
    const steps: ((round: number) => void)[] = [
      (r) => chat(log, 30 + r * 7, `a${r}-`),
      (r) => {
        const messages = log.frames.filter((f) => f.type === "message");
        log.rollback(messages[Math.max(0, messages.length - 20 - r)]!.seq);
        chat(log, 4, `b${r}-`);
      },
      (r) => {
        log.say(`voice-${r}`, "", { voiceId: `vo-${r}` });
        log.voice(`vo-${r}`, `voice-${r}`, 1, `语音 ${r}`);
        chat(log, 60, `c${r}-`);
        log.voice(`vo-${r}`, `voice-${r}`, 2, `语音 ${r} 改过`);
      },
      () => {
        const tree = log.tree();
        if (tree && tree.branches.length > 1) log.switchTo(tree.branches.find((b) => b.id !== tree.current)!.id);
        chat(log, 3, "s-");
      },
      () => {
        const target = log.frames.find((f) => f.type === "message" && !("deleted" in (f.payload as object)));
        if (target) log.purge([target.seq]);
        chat(log, 2, "p-");
      },
    ];
    chat(log, 70);
    let served = 0;
    let asked = 0;
    for (let round = 0; round < 10; round++) {
      const hot = round % 3 !== 0;
      const device = new Device(log, backend).open(hot ? snapshot : undefined);
      // 开着的时候也来点事
      steps[round % steps.length]!(round);
      device.live();
      await device.scrollToTop();
      expect(shown(device.state), `第 ${round} 轮`).toEqual(shown(await fresh(log)));
      served += device.served.length;
      asked += device.asks.length;
      snapshot = await device.close();
      steps[(round + 2) % steps.length]!(round);
    }
    // 两头都走到了：有本机拼的，也有向电脑要的
    expect(served).toBeGreaterThan(5);
    expect(asked).toBeGreaterThan(5);
  });
});
