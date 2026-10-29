// 主切面：对话里能停止、回复中发的消息排队（144 号票）。真的守护进程，秘书、项目维护者接 faux provider（吐字放慢，好在"正说着"时动手）；
// 测试扮演前端（几台设备各一个连接），经 WebSocket 收发并断言：
// - 回复中发的话不进会话，排进这个会话的队列（message_queue 事件带整队），几台设备看到的一样，后连上的也看得到；
//   能叉掉、能改顺序；这一轮做完按队列的顺序一起交给 agent 作为下一轮（turn_start 带上另外几条），交出去的是普通的用户消息
//   （负载里带着发送请求的幂等键：界面上同一个气泡）；
// - 停止：秘书、项目维护者回复中点停止，这一轮以中止结束，已经说出来的留着（标"已停止"），时间线上记一笔"你停止了这一轮"，
//   排着的马上交出去；没在回复时点了什么都不做；
// - 维护者回复中用户发的话不再插进当前这一轮（以前是插话）；
// - 守护进程重启后排着的还在，起来时交给秘书。
import {
  CHANNELS,
  EVENT_TYPES,
  type EventFrame,
  maintainerChannel,
  type MessageEventPayload,
  type MessageQueueEventPayload,
  METHODS,
  type QueuedMessageActionResult,
  type StopReplyResult,
  type TimelineRecordEventPayload,
  type TurnEndEventPayload,
  type TurnStartEventPayload,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { queuedMessages } from "../../src/conversation/message-queue.ts";
import { listMessages } from "../../src/conversation/views.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { waitUntil } from "../helpers/process.ts";
import { seedProject } from "../helpers/projects.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const SECRETARY = CHANNELS.secretary;
const PM1 = maintainerChannel("pm-1");
/** 说得慢的一大段：吐字放慢后要说好几秒，够在它说着的时候排队、停止 */
const LONG = "这是一段很长很长的回复，要说好一会儿。".repeat(60);

const textOf = (p: MessageEventPayload) => p.message.parts.map((part) => ("text" in part ? part.text : `<${part.type}>`)).join("");

/** 这个前端在某个会话频道上收到的落盘事件，按序号（流式增量不算） */
const persisted = (frontend: TestFrontend, channel: string) => frontend.events({ channel, persistedOnly: true });

/** 收到的最新一份队列（里面消息的文字，按先后） */
const latestQueue = (frontend: TestFrontend, channel: string) => {
  const last = frontend.events({ channel, type: EVENT_TYPES.messageQueue }).at(-1);
  return last ? (last.payload as MessageQueueEventPayload).queue.map((q) => q.message.parts.map((p) => ("text" in p ? p.text : "")).join("")) : [];
};

/** 一串事件的简写：用户、agent、系统的消息写文字，回合写开始结束，队列写变化 */
function describeEvent(frame: EventFrame): string {
  if (frame.type === EVENT_TYPES.message) {
    const p = frame.payload as MessageEventPayload;
    const text = textOf(p);
    return `${p.message.speaker}:${text.length > 12 ? `${text.slice(0, 12)}…` : text}${p.message.stopped ? "（已停止）" : ""}`;
  }
  if (frame.type === EVENT_TYPES.turnStart) {
    const p = frame.payload as TurnStartEventPayload;
    return `turn_start${p.moreInputMessageIds ? `+${p.moreInputMessageIds.length}` : ""}`;
  }
  if (frame.type === EVENT_TYPES.turnEnd) {
    const p = frame.payload as TurnEndEventPayload;
    return `turn_end:${p.outcome}${p.moreInputMessageIds ? `+${p.moreInputMessageIds.length}` : ""}`;
  }
  if (frame.type === EVENT_TYPES.messageQueue) return `queue:${(frame.payload as MessageQueueEventPayload).change}`;
  if (frame.type === EVENT_TYPES.timelineRecord) return `record:${(frame.payload as TimelineRecordEventPayload).record.summary}`;
  return frame.type;
}

const ok = <T>(response: { ok: boolean; result?: unknown; error?: unknown }): T => {
  if (!response.ok) throw new Error(`请求失败：${JSON.stringify(response.error)}`);
  return response.result as T;
};

describe("回复中发的消息排队", () => {
  it("秘书说着时发的话排进队（不进会话），几台设备一样、后连上的也看得到；叉掉、改顺序；这一轮做完按顺序一起交出去作为下一轮", async () => {
    const td = await startTestDaemon({
      secretary: [
        { kind: "reply", text: LONG },
        // 下一轮的那次模型调用同时看到排着的两句（叉掉的那句不在）才回"两句都收到了"
        { kind: "branch_on_context", contains: ["第一句：先查天气", "第三句：再订餐厅"], matched: { kind: "reply", text: "两句都收到了" }, otherwise: { kind: "reply", text: "没收全" } },
      ],
      secretaryTokensPerSecond: 30,
    });
    const phone = await TestFrontend.connect(td.url);
    const laptop = await TestFrontend.connect(td.url);
    await phone.subscribe({ [SECRETARY]: 0 });
    await laptop.subscribe({ [SECRETARY]: 0 });

    const first = await phone.sendText("先写一篇长文");
    expect(first.queued).toBeUndefined();
    await phone.next(SECRETARY, EVENT_TYPES.stream);

    // 说着的时候发的三句：排进队，结果写明 queued；会话里没有它们
    const one = await phone.sendText("第一句：先查天气", { idempotencyKey: "k-one" });
    const two = await laptop.sendText("第二句：算了不用了");
    const three = await phone.sendText("第三句：再订餐厅", { idempotencyKey: "k-three" });
    expect([one.queued, two.queued, three.queued]).toEqual([true, true, true]);
    // 同一个幂等键重发：拿到同一个结果，不多排一条
    expect(await phone.sendText("第一句：先查天气", { idempotencyKey: "k-one" })).toEqual(one);
    expect(listMessages(td.daemon.store.reader, SECRETARY).map((m) => m.speaker)).toEqual(["user"]);
    for (const device of [phone, laptop]) {
      await waitUntil(() => latestQueue(device, SECRETARY).length === 3, { describe: () => JSON.stringify(latestQueue(device, SECRETARY)) });
      expect(latestQueue(device, SECRETARY)).toEqual(["第一句：先查天气", "第二句：算了不用了", "第三句：再订餐厅"]);
    }
    const queued = (await phone.next(SECRETARY, EVENT_TYPES.messageQueue)).payload as MessageQueueEventPayload;
    // 排进来的那条带着消息 id（交出去时就是它）和发送请求的幂等键
    expect(queued).toMatchObject({ change: "queued", messageIds: [one.messageId], requestKey: "k-one", queue: [{ message: { id: one.messageId, speaker: "user" }, idempotencyKey: "k-one" }] });

    // 后连上的设备（刷新页面）：补发里有排着的队
    const tablet = await TestFrontend.connect(td.url);
    await tablet.subscribe({ [SECRETARY]: 0 });
    await waitUntil(() => latestQueue(tablet, SECRETARY).length === 3);

    // 笔记本上叉掉第二句；手机上拖动，第三句挪到最前
    const removed = ok<QueuedMessageActionResult>(await laptop.request(METHODS.queuedMessageAction, { conversation: SECRETARY, action: "remove", messageId: two.messageId }, "k-remove"));
    expect(removed.changed).toBe(true);
    expect(removed.queue.map((q) => q.message.id)).toEqual([one.messageId, three.messageId]);
    const reordered = ok<QueuedMessageActionResult>(await phone.request(METHODS.queuedMessageAction, { conversation: SECRETARY, action: "reorder", messageIds: [three.messageId, one.messageId] }, "k-order"));
    expect(reordered).toMatchObject({ changed: true });
    // 已经不在队里的叉不掉、顺序一样的不算改
    expect(ok<QueuedMessageActionResult>(await laptop.request(METHODS.queuedMessageAction, { conversation: SECRETARY, action: "remove", messageId: two.messageId }, "k-remove-2")).changed).toBe(false);
    expect(ok<QueuedMessageActionResult>(await laptop.request(METHODS.queuedMessageAction, { conversation: SECRETARY, action: "reorder", messageIds: [three.messageId] }, "k-order-2")).changed).toBe(false);
    for (const device of [phone, laptop, tablet]) await waitUntil(() => latestQueue(device, SECRETARY).join() === "第三句：再订餐厅,第一句：先查天气");

    // 这一轮说完：排着的两句按队列的顺序追加成普通的用户消息（同一批），队列空了；秘书一轮里同时收到两句
    await waitUntil(() => td.daemon.store.read(SECRETARY, 0, EVENT_TYPES.turnEnd).length === 2, { timeoutMs: 60_000, describe: () => persisted(phone, SECRETARY).map(describeEvent).join(" | ") });
    await waitUntil(() => persisted(phone, SECRETARY).filter((f) => f.type === EVENT_TYPES.turnEnd).length === 2);
    expect(persisted(phone, SECRETARY).map(describeEvent)).toEqual([
      "user:先写一篇长文",
      "turn_start",
      "queue:queued",
      "queue:queued",
      "queue:queued",
      "queue:removed",
      "queue:reordered",
      `agent:${LONG.slice(0, 12)}…`,
      "turn_end:completed",
      "user:第三句：再订餐厅",
      "user:第一句：先查天气",
      "queue:delivered",
      "turn_start+1",
      "agent:两句都收到了",
      "turn_end:completed+1",
    ]);
    const delivered = persisted(phone, SECRETARY)
      .filter((f) => f.type === EVENT_TYPES.message)
      .map((f) => f.payload as MessageEventPayload)
      .filter((p) => p.queueDelivery !== undefined);
    // 交出去的消息：id 是排队时的，负载里带着发送请求的幂等键（界面上原地换掉排队的气泡），同一批
    expect(delivered.map((p) => [p.message.id, p.idempotencyKey])).toEqual([
      [three.messageId, "k-three"],
      [one.messageId, "k-one"],
    ]);
    expect(new Set(delivered.map((p) => p.queueDelivery)).size).toBe(1);
    const start = persisted(phone, SECRETARY).filter((f) => f.type === EVENT_TYPES.turnStart).at(-1)!.payload as TurnStartEventPayload;
    expect(start).toEqual({ inputMessageId: three.messageId, moreInputMessageIds: [one.messageId] });
    expect(latestQueue(phone, SECRETARY)).toEqual([]);
    expect(queuedMessages(td.daemon.store.reader, SECRETARY)).toEqual([]);
    // 叉掉的那句不进会话
    expect(listMessages(td.daemon.store.reader, SECRETARY).map((m) => m.parts.map((p) => ("text" in p ? p.text : "")).join(""))).not.toContain("第二句：算了不用了");

    // 不在回复时发的话照常直接进会话
    const later = await phone.sendText("谢谢");
    expect(later.queued).toBeUndefined();
  });

  it("停止（秘书）：说到一半点停止，已经说出来的留着、标已停止，时间线记一笔，会话回到空闲，排着的马上交出去；没在回复时点了什么都不做", async () => {
    const td = await startTestDaemon({ secretary: [{ kind: "reply", text: LONG }, { kind: "reply", text: "好的，换个话题。" }], secretaryTokensPerSecond: 20 });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0 });

    // 没在回复：点了什么都不做
    expect(ok<StopReplyResult>(await frontend.request(METHODS.stopReply, { conversation: SECRETARY }, "k-stop-idle"))).toEqual({ stopped: false });

    await frontend.sendText("写一篇长文");
    await frontend.next(SECRETARY, EVENT_TYPES.stream);
    await new Promise((r) => setTimeout(r, 300));
    const change = await frontend.sendText("算了，换个话题");
    expect(change.queued).toBe(true);
    expect(ok<StopReplyResult>(await frontend.request(METHODS.stopReply, { conversation: SECRETARY }, "k-stop"))).toEqual({ stopped: true });

    await waitUntil(() => persisted(frontend, SECRETARY).filter((f) => f.type === EVENT_TYPES.turnEnd).length === 2, { timeoutMs: 30_000, describe: () => persisted(frontend, SECRETARY).map(describeEvent).join(" | ") });
    const events = persisted(frontend, SECRETARY).map(describeEvent);
    expect(events.filter((e) => !e.startsWith("queue:queued"))).toEqual([
      "user:写一篇长文",
      "turn_start",
      `agent:${LONG.slice(0, 12)}…（已停止）`,
      "record:你停止了这一轮",
      "turn_end:aborted",
      "user:算了，换个话题",
      "queue:delivered",
      "turn_start",
      "agent:好的，换个话题。",
      "turn_end:completed",
    ]);
    // 已经说出来的留着：是这一大段的开头，没说完
    const stopped = persisted(frontend, SECRETARY)
      .filter((f) => f.type === EVENT_TYPES.message)
      .map((f) => (f.payload as MessageEventPayload).message)
      .find((m) => m.stopped)!;
    const said = stopped.parts.map((p) => ("text" in p ? p.text : "")).join("");
    expect(said.length).toBeGreaterThan(0);
    expect(said.length).toBeLessThan(LONG.length);
    expect(LONG.startsWith(said)).toBe(true);
    const record = persisted(frontend, SECRETARY).find((f) => f.type === EVENT_TYPES.timelineRecord)!.payload as TimelineRecordEventPayload;
    expect(record.record).toMatchObject({ kind: "stopped", summary: "你停止了这一轮" });

    // 回复完了再点：什么都不做，不多记
    expect(ok<StopReplyResult>(await frontend.request(METHODS.stopReply, { conversation: SECRETARY }, "k-stop-late"))).toEqual({ stopped: false });
    expect(td.daemon.store.read(SECRETARY, 0, EVENT_TYPES.timelineRecord)).toHaveLength(1);
  });

  it("项目维护者：回复中用户发的话不插进这一轮（排队，这一轮之后才交）；回复中点停止同样停下、记一笔，排着的马上交出去", async () => {
    const td = await startTestDaemon({ maintainer: (id) => (id === "pm-1" ? [{ kind: "reply", text: LONG }, { kind: "reply", text: "收到，按你说的改。" }] : []), maintainerTokensPerSecond: 20 });
    seedProject(td.daemon, "家庭网盘", { state: "in_use", charterConfirmed: true, kind: "other", toolkit: { skills: [], mcp: [], bash: false, network: false } });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [PM1]: 0 });

    await frontend.sendText("讲讲网盘现在的情况", { conversation: PM1 });
    await frontend.next(PM1, EVENT_TYPES.stream, 30_000);
    const interjection = await frontend.sendText("顺便看看照片目录", { conversation: PM1 });
    expect(interjection.queued).toBe(true);
    // 一会儿之后它还是没进会话、也没开始处理（以前会作为插话插进这一轮）
    await new Promise((r) => setTimeout(r, 800));
    expect(listMessages(td.daemon.store.reader, PM1).some((m) => m.id === interjection.messageId)).toBe(false);
    expect(td.daemon.store.read(PM1, 0, EVENT_TYPES.turnStart).map((e) => (e.payload as TurnStartEventPayload).inputMessageId)).not.toContain(interjection.messageId);

    expect(ok<StopReplyResult>(await frontend.request(METHODS.stopReply, { conversation: PM1 }, "k-stop-pm"))).toEqual({ stopped: true });
    await waitUntil(() => persisted(frontend, PM1).filter((f) => f.type === EVENT_TYPES.turnEnd).length === 2, { timeoutMs: 30_000, describe: () => persisted(frontend, PM1).map(describeEvent).join(" | ") });
    const events = persisted(frontend, PM1)
      .map(describeEvent)
      .filter((e) => e.startsWith("user:") || e.startsWith("agent:") || e.startsWith("turn_") || e.startsWith("record:") || e === "queue:delivered");
    expect(events).toEqual([
      "user:讲讲网盘现在的情况",
      "turn_start",
      `agent:${LONG.slice(0, 12)}…（已停止）`,
      "record:你停止了这一轮",
      "turn_end:aborted",
      "user:顺便看看照片目录",
      "queue:delivered",
      "turn_start",
      "agent:收到，按你说的改。",
      "turn_end:completed",
    ]);
    // 交出去的那句照常属于项目（归属在交出去时认）
    const delivered = persisted(frontend, PM1).find((f) => f.type === EVENT_TYPES.message && (f.payload as MessageEventPayload).message.id === interjection.messageId)!;
    expect((delivered.payload as MessageEventPayload).projectId).toBe("p-1");
  });

  it("守护进程重启后排着的还在：起来时被打断的那一轮标中断，排着的交给秘书作为下一轮", async () => {
    const dataDir = makeTempDir("ergo-queue-data-");
    const homeDir = makeTempDir("ergo-queue-home-");
    const first = await startTestDaemon({ reuse: { dataDir, homeDir }, secretary: [{ kind: "reply", text: LONG }], secretaryTokensPerSecond: 20 });
    const frontend = await TestFrontend.connect(first.url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await frontend.sendText("写一篇长文");
    await frontend.next(SECRETARY, EVENT_TYPES.stream);
    const a = await frontend.sendText("然后帮我查天气");
    const b = await frontend.sendText("再订个餐厅");
    expect([a.queued, b.queued]).toEqual([true, true]);
    await first.daemon.stop();

    const second = await startTestDaemon({
      reuse: { dataDir, homeDir },
      secretary: [{ kind: "branch_on_context", contains: ["然后帮我查天气", "再订个餐厅"], matched: { kind: "reply", text: "两件事都记下了" }, otherwise: { kind: "reply", text: "没收全" } }],
    });
    const after = await TestFrontend.connect(second.url);
    await after.subscribe({ [SECRETARY]: 0 });
    await waitUntil(() => second.daemon.store.read(SECRETARY, 0, EVENT_TYPES.turnEnd).length === 2, { timeoutMs: 30_000 });
    await waitUntil(() => persisted(after, SECRETARY).filter((f) => f.type === EVENT_TYPES.turnEnd).length === 2);
    const events = persisted(after, SECRETARY)
      .map(describeEvent)
      .filter((e) => !e.startsWith("queue:queued"));
    expect(events).toEqual([
      "user:写一篇长文",
      "turn_start",
      "system:上一条消息「写一篇长文」…",
      "turn_end:interrupted",
      "user:然后帮我查天气",
      "user:再订个餐厅",
      "queue:delivered",
      "turn_start+1",
      "agent:两件事都记下了",
      "turn_end:completed+1",
    ]);
  });
});
