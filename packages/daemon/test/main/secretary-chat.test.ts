// 主切面（规格 Testing Decisions 切面 1）：秘书聊天。
// 临时数据目录里起真的守护进程，秘书接 faux provider；测试扮演前端，经 WebSocket 收发并断言。
import fs from "node:fs";
import path from "node:path";
import { ASSISTANT_NAME_MARK, CHANNELS, EVENT_TYPES, type EventFrame, type MessageEventPayload, type StreamEventPayload, type TurnEndEventPayload, type TurnStartEventPayload } from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { listMessages } from "../../src/conversation/views.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { stripTimeMarkers } from "../helpers/echo.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { waitUntil } from "../helpers/process.ts";

const SECRETARY = CHANNELS.secretary;
const { message: MESSAGE, stream: STREAM, turnStart: TURN_START, turnEnd: TURN_END } = EVENT_TYPES;

describe("秘书聊天", () => {
  it("发一条带幂等键的文本 → 用户消息事件 → 开始处理 → 秘书回复的流式增量 → 定稿消息（推理 + 正文）→ 回合结束", async () => {
    const thinking = "用户在打招呼，简单回应就好。";
    const text = "在的，有什么要我做的？";
    const { url, dataDir } = await startTestDaemon({ secretary: [{ kind: "reply", thinking, text }] });
    const frontend = await TestFrontend.connect(url);
    expect(await frontend.subscribe({ [SECRETARY]: 0 })).toMatchObject({ ok: true, result: { resync: [] } });

    const sent = await frontend.sendText("在吗", { idempotencyKey: "k-hello" });
    expect(sent).toMatchObject({ seq: 1, idempotencyKey: "k-hello" });

    // 用户消息事件：负载里有会话、发言方、时间和原文，带着发送请求的幂等键（够 08 号票采集为"用户发言"素材）
    const userEvent = await frontend.next(SECRETARY, MESSAGE);
    expect(userEvent.seq).toBe(1);
    const userPayload = userEvent.payload as MessageEventPayload;
    expect(userPayload).toEqual({
      message: { id: sent.messageId, conversation: SECRETARY, speaker: "user", time: expect.any(String), parts: [{ type: "text", text: "在吗" }] },
      idempotencyKey: "k-hello",
    });
    expect(userPayload.message.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);

    expect((await frontend.next(SECRETARY, TURN_START)).payload as TurnStartEventPayload).toEqual({ inputMessageId: sent.messageId });
    const firstDelta = await frontend.next(SECRETARY, STREAM);
    expect(firstDelta.seq).toBe(2); // 临时事件不占序号：沿用频道最后一条落盘事件（turn_start）的序号
    const final = await frontend.next(SECRETARY, MESSAGE);
    const turnEnd = await frontend.next(SECRETARY, TURN_END);

    const reply = (final.payload as MessageEventPayload).message;
    expect(final.seq).toBe(3);
    expect(reply).toMatchObject({ conversation: SECRETARY, speaker: "agent", parts: [{ type: "reasoning", text: thinking }, { type: "text", text }] });
    // 增量里的消息 id 就是定稿消息的 id，前端原地换掉
    expect((firstDelta.payload as StreamEventPayload).messageId).toBe(reply.id);
    expect(turnEnd.seq).toBe(4);
    expect(turnEnd.payload as TurnEndEventPayload).toEqual({ inputMessageId: sent.messageId, outcome: "completed" });

    // 库是数据目录数据库区的 ergou.db（WAL）
    expect(fs.existsSync(path.join(dataDir, "db", "ergou.db"))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "db", "ergou.db-wal"))).toBe(true);
  });

  it("同一幂等键重发：拿到同一个结果，不多出消息，也不多一次回复", async () => {
    const { url, daemon } = await startTestDaemon({
      secretary: [
        { kind: "reply", text: "收到" },
        { kind: "reply", text: "MARKER_SECOND_REPLY" },
      ],
    });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });

    const first = await frontend.sendText("帮我记一下", { idempotencyKey: "k-dup" });
    const again = await frontend.sendText("帮我记一下", { idempotencyKey: "k-dup" });
    expect(again).toEqual(first);
    await frontend.next(SECRETARY, TURN_END);

    // 再发一条新的，作为"之后不会再有别的回复"的界限
    await frontend.sendText("第二件事", { idempotencyKey: "k-next" });
    await frontend.next(SECRETARY, TURN_END);

    expect(persisted(frontend).map(describeEvent)).toEqual([
      "1 user:帮我记一下",
      "2 turn_start",
      "3 agent:收到",
      "4 turn_end",
      "5 user:第二件事",
      "6 turn_start",
      "7 agent:MARKER_SECOND_REPLY",
      "8 turn_end",
    ]);
    expect(listMessages(daemon.store.reader, SECRETARY).map((m) => `${m.speaker}:${textOf(m.parts)}`)).toEqual([
      "user:帮我记一下",
      "agent:收到",
      "user:第二件事",
      "agent:MARKER_SECOND_REPLY",
    ]);
  });

  it("流式增量每 100 毫秒最多推一次、只推送不落盘：事件日志和会话视图里只有定稿的 part", async () => {
    const text = "这是一段比较长的回复，".repeat(12);
    const { url, daemon } = await startTestDaemon({ secretary: [{ kind: "reply", thinking: "先想一想再回答。", text }], secretaryTokensPerSecond: 80 });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });

    await frontend.sendText("讲一段");
    await frontend.next(SECRETARY, TURN_END);

    const arrivals = frontend.timedEvents({ type: STREAM }).map((e) => e.at);
    expect(arrivals.length).toBeGreaterThan(3);
    // 按收到的时间数帧数：每 100 毫秒最多一帧，跨度为 span 毫秒时最多 span/100 + 1 帧。
    // 收到的时间比发出的时间多一点抖动（相邻两帧可能被挤近几毫秒），给跨度放 20 毫秒的余量
    const span = arrivals.at(-1)! - arrivals[0]!;
    expect(arrivals.length).toBeLessThanOrEqual(Math.floor((span + 20) / 100) + 1);

    // 增量按 part 和偏移拼起来，是定稿内容的前缀（定稿之前还没推出去的增量直接丢掉，定稿消息取而代之）
    const streamed = streamedParts(frontend.events({ type: STREAM }).map((f) => f.payload as StreamEventPayload));
    expect(streamed[0]).toEqual({ type: "reasoning", text: "先想一想再回答。" });
    expect(text.startsWith(streamed[1]!.text)).toBe(true);

    expect(daemon.store.read(SECRETARY).map((e) => e.type)).toEqual([MESSAGE, TURN_START, MESSAGE, TURN_END]);
    expect(listMessages(daemon.store.reader, SECRETARY)[1]!.parts).toEqual([
      { type: "reasoning", text: "先想一想再回答。" },
      { type: "text", text },
    ]);
  });

  it("秘书正忙时连发两条：按顺序逐条处理，第二条看得到第一条的回复", async () => {
    // 第一条的回复要说一会儿（第二条在它说的时候到）；速度不能太慢：第二条的回复念出整个上下文（含越来越长的系统提示）
    const slowReply = "第一条的回复，慢慢说完。".repeat(80);
    const { url } = await startTestDaemon({
      secretary: [{ kind: "reply", text: slowReply }, { kind: "echo_context" }],
      secretaryTokensPerSecond: 300,
    });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });

    const first = await frontend.sendText("第一条");
    await frontend.next(SECRETARY, STREAM); // 秘书已经在回第一条
    const second = await frontend.sendText("第二条");

    await frontend.next(SECRETARY, TURN_END);
    await frontend.next(SECRETARY, TURN_END);
    const events = persisted(frontend);
    expect(events.map((f) => describeEvent(f).replace(/\n[\s\S]*/, "…"))).toEqual([
      "1 user:第一条",
      "2 turn_start",
      "3 user:第二条",
      `4 agent:${slowReply}`,
      "5 turn_end",
      "6 turn_start",
      expect.stringMatching(/^7 agent:/),
      "8 turn_end",
    ]);
    expect([events[1], events[4]].map((f) => (f!.payload as TurnEndEventPayload).inputMessageId)).toEqual([first.messageId, first.messageId]);
    expect([events[5], events[7]].map((f) => (f!.payload as TurnEndEventPayload).inputMessageId)).toEqual([second.messageId, second.messageId]);
    // 第二次模型调用看到的上下文：第一条、第一条的回复、第二条，依次排列（不是插话）
    // （每条用户消息前面的本地时间标记去掉再比）
    const context = stripTimeMarkers(textOf((events[6]!.payload as MessageEventPayload).message.parts));
    expect(context).toContain(["[user] 第一条", `[assistant] ${slowReply}`, "[user] 第二条"].join("\n"));
  });

  it("秘书的系统提示是固定的那一段，不含 pi 默认的编程助手提示", async () => {
    const { url } = await startTestDaemon({ secretary: [{ kind: "echo_context" }] });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await frontend.sendText("念一遍系统提示");
    await frontend.next(SECRETARY, MESSAGE);
    const seen = textOf(((await frontend.next(SECRETARY, MESSAGE)).payload as MessageEventPayload).message.parts);
    expect(seen).toMatch(/^\[system\] 你是「二狗」的秘书/);
    expect(seen).not.toContain("coding assistant");
  });

  it("秘书没能回复（模型出错）：会话里多一条系统说明，回合以出错结束，之后照常可用", async () => {
    // 剧本是空的：第一次模型调用就得到错误回复
    const { url } = await startTestDaemon({ secretary: [] });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    const sent = await frontend.sendText("在吗");
    await frontend.next(SECRETARY, MESSAGE);
    const note = (await frontend.next(SECRETARY, MESSAGE)).payload as MessageEventPayload;
    expect(note.message.speaker).toBe("system");
    expect(textOf(note.message.parts)).toMatch(new RegExp(`^${ASSISTANT_NAME_MARK}这次没能回复：`));
    expect((await frontend.next(SECRETARY, TURN_END)).payload).toMatchObject({ inputMessageId: sent.messageId, outcome: "error" });
  });

  it("守护进程停掉再起：历史还在，秘书接着同一条主线会话", async () => {
    const first = await startTestDaemon({ secretary: [{ kind: "reply", text: "记住了，暗号是青蛙" }] });
    const frontend = await TestFrontend.connect(first.url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await frontend.sendText("暗号是什么？");
    await frontend.next(SECRETARY, TURN_END);
    await frontend.close();
    await first.daemon.stop();

    const second = await startTestDaemon({ secretary: [{ kind: "echo_context" }], reuse: { dataDir: first.dataDir, homeDir: first.homeDir } });
    const reopened = await TestFrontend.connect(second.url);
    await reopened.subscribe({ [SECRETARY]: 0 });
    await reopened.next(SECRETARY, TURN_END);
    expect(persisted(reopened).map(describeEvent)).toEqual(["1 user:暗号是什么？", "2 turn_start", "3 agent:记住了，暗号是青蛙", "4 turn_end"]);

    await reopened.sendText("刚才说了什么？");
    await reopened.next(SECRETARY, MESSAGE);
    const seen = stripTimeMarkers(textOf(((await reopened.next(SECRETARY, MESSAGE)).payload as MessageEventPayload).message.parts));
    expect(seen).toContain("[user] 暗号是什么？");
    expect(seen).toContain("[assistant] 记住了，暗号是青蛙");
  });
});

describe("处理到一半被打断的输入：标成中断出队，不重送", () => {
  it("秘书子进程崩溃：那条输入以\"中断\"结束，会话里一条系统说明请用户重发；重新拉起后不再处理它，新消息照常处理", async () => {
    const slow = "这一段要说很久很久，".repeat(20);
    const { url, daemon } = await startTestDaemon({ secretary: [{ kind: "reply", text: slow }], secretaryTokensPerSecond: 20 });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });

    const first = await frontend.sendText("第一条，说到一半崩了");
    await frontend.next(SECRETARY, STREAM);
    process.kill(daemon.secretary.pid!);

    const note = (await frontend.next(SECRETARY, MESSAGE)).payload as MessageEventPayload;
    expect(note.message.speaker).toBe("system");
    expect(textOf(note.message.parts)).toBe(`上一条消息「第一条，说到一半崩了」处理时中断了，${ASSISTANT_NAME_MARK}没有接着处理；需要的话请重发。`);
    expect((await frontend.next(SECRETARY, TURN_END)).payload).toEqual({ inputMessageId: first.messageId, outcome: "interrupted" });

    // 重新拉起之后：被打断的那条不再交给秘书；新消息照常处理
    await waitUntil(() => daemon.secretary.status === "idle", { timeoutMs: 15_000 });
    const second = await frontend.sendText("第二条");
    await frontend.next(SECRETARY, TURN_END);
    const events = persisted(frontend);
    expect(events.filter((f) => f.type === TURN_START).map((f) => (f.payload as TurnStartEventPayload).inputMessageId)).toEqual([first.messageId, second.messageId]);
    expect(events.map((f) => describeEvent(f).replace(/:[\s\S]*/, ""))).toEqual(["1 user", "2 turn_start", "3 system", "4 turn_end", "5 user", "6 turn_start", "7 agent", "8 turn_end"]);
  });

  it("守护进程重启：被杀时正在处理的那条以\"中断\"结束、不重送；排在它后面、还没开始的照常处理", async () => {
    const first = await startTestDaemon({ secretary: [{ kind: "reply", text: "这一段要说很久很久，".repeat(20) }], secretaryTokensPerSecond: 20 });
    const frontend = await TestFrontend.connect(first.url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    const interrupted = await frontend.sendText("说到一半守护进程没了");
    await frontend.next(SECRETARY, STREAM);
    const queued = await frontend.sendText("排着队的一条");
    await frontend.close();
    await first.daemon.stop();

    const second = await startTestDaemon({ secretary: [{ kind: "reply", text: "排着队的那条的回复" }], reuse: { dataDir: first.dataDir, homeDir: first.homeDir } });
    const reopened = await TestFrontend.connect(second.url);
    await reopened.subscribe({ [SECRETARY]: 0 });
    await reopened.next(SECRETARY, TURN_END);
    await reopened.next(SECRETARY, TURN_END);
    const events = persisted(reopened);
    expect(events.map(describeEvent)).toEqual([
      "1 user:说到一半守护进程没了",
      "2 turn_start",
      "3 user:排着队的一条",
      `4 system:上一条消息「说到一半守护进程没了」处理时中断了，${ASSISTANT_NAME_MARK}没有接着处理；需要的话请重发。`,
      "5 turn_end",
      "6 turn_start",
      "7 agent:排着队的那条的回复",
      "8 turn_end",
    ]);
    expect(events[4]!.payload).toEqual({ inputMessageId: interrupted.messageId, outcome: "interrupted" });
    expect(events[5]!.payload).toEqual({ inputMessageId: queued.messageId });
  });
});

function persisted(frontend: TestFrontend): EventFrame[] {
  return frontend.events({ channel: SECRETARY, persistedOnly: true });
}

function textOf(parts: ReadonlyArray<{ type: string; text?: string }>): string {
  return parts.map((p) => (p.type === "text" ? (p.text ?? "") : "")).join("");
}

/** 把一条落盘事件压成"序号 发言方:文字"或"序号 类型" */
function describeEvent(frame: { seq: number; type: string; payload: unknown }): string {
  if (frame.type !== MESSAGE) return `${frame.seq} ${frame.type}`;
  const { message } = frame.payload as MessageEventPayload;
  return `${frame.seq} ${message.speaker}:${textOf(message.parts)}`;
}

/** 按 part 下标和偏移把增量拼回去 */
function streamedParts(payloads: StreamEventPayload[]): Array<{ type: string; text: string }> {
  const parts: Array<{ type: string; text: string }> = [];
  for (const { deltas } of payloads) {
    for (const d of deltas) {
      const part = (parts[d.part] ??= { type: d.type, text: "" });
      expect(d.offset).toBe(part.text.length);
      part.text += d.text;
    }
  }
  return parts;
}
