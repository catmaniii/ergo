// 主切面：会话历史分页（规格第 5 节 HTTP）。
// 前端第一次订阅会话频道时，WebSocket 只补发最近一页（50 条消息起）的事件；往上翻时经 HTTP 按页取更早的消息。
// 分页结果和 WebSocket 上的事件在交界处不重不漏。时间线记录（偏离、范围变更、越界、快速动作的操作记录）跟着它所在的那一页（25 号票）。
import {
  CHANNELS,
  EVENT_TYPES,
  type HistoryMessage,
  HistoryPage,
  maintainerChannel,
  type MessageEventPayload,
  type QuickActionExecutedEventPayload,
  QuickActionExecutedEventPayload as QuickActionExecutedSchema,
  schemaChecker,
  type TurnEndEventPayload,
} from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { appendMessage, buildTimelineRecord } from "../../src/conversation/messages.ts";
import { listMessages } from "../../src/conversation/views.ts";
import type { Daemon } from "../../src/daemon.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { history } from "../helpers/http.ts";
import { SECRETARY_START_TIMEOUT_MS, waitUntil } from "../helpers/process.ts";
import { saveOrCheckRecording } from "../helpers/recording.ts";

const SECRETARY = CHANNELS.secretary;
const M1 = maintainerChannel("tm-1");

/** 一次快速动作的执行（操作记录）：用户点明的"记住"，按共享协议包的 schema 构造 */
function operation(actionId: string): QuickActionExecutedEventPayload {
  const payload: QuickActionExecutedEventPayload = {
    actionId,
    action: { type: "remember", params: { content: "周三体检" } },
    name: "记住",
    title: "记住：周三体检",
    explicit: true,
    basis: "explicit",
    cardId: `c-${actionId}`,
    result: { ok: true, summary: "已记住" },
  };
  expect(schemaChecker(QuickActionExecutedSchema).firstError(payload)).toBeUndefined();
  return payload;
}
const { message: MESSAGE, turnEnd: TURN_END } = EVENT_TYPES;

/**
 * 在秘书会话里布置 count 条历史消息（直接追加 agent 的消息，不惊动秘书），每 10 条后面跟一条 turn_end（不是消息的事件）。
 * 第 i 条消息的序号是 i + floor((i-1)/10)。
 */
function seedHistory(daemon: Daemon, count: number): void {
  for (let i = 1; i <= count; i++) {
    appendMessage(daemon.store, { conversation: SECRETARY, speaker: "agent", parts: [{ type: "text", text: `第 ${i} 条` }] });
    if (i % 10 === 0) {
      const payload: TurnEndEventPayload = { inputMessageId: `m-seed-${i}`, outcome: "completed" };
      daemon.store.append({ channel: SECRETARY, type: TURN_END, payload });
    }
  }
}

const seqOf = (i: number) => i + Math.floor((i - 1) / 10);
const texts = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, k) => `第 ${from + k} 条`);

describe("会话历史分页", () => {
  // 几次等待加起来（补发 10 秒、等秘书拉起来回一轮 20 秒）超过默认的用例超时：写明更长的，真超时时报的是 waitUntil 的说明
  it("第一次订阅只补发最近 50 条消息起的事件；往上翻经 HTTP 按页取更早的；分页和 WebSocket 的事件不重不漏，之后的新事件照常推送", { timeout: 45_000 }, async () => {
    const { url, daemon } = await startTestDaemon({ secretary: [{ kind: "reply", text: "新的回复" }] });
    seedHistory(daemon, 120);
    const last = daemon.store.lastSeq(SECRETARY);
    expect(last).toBe(132);

    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await waitUntil(() => frontend.cursors[SECRETARY] === last, { describe: () => `补发到 ${frontend.cursors[SECRETARY]}，要到 ${last}` });
    const replayed = frontend.events({ channel: SECRETARY, persistedOnly: true });
    // 最近 50 条消息是第 71–120 条；从第 71 条（序号 78）起的事件都补发了，包括中间的 turn_end
    expect(replayed[0]!.seq).toBe(seqOf(71));
    expect(replayed.map((f) => f.seq)).toEqual(Array.from({ length: last - seqOf(71) + 1 }, (_, k) => seqOf(71) + k));
    const wsTexts = replayed.filter((f) => f.type === MESSAGE).map((f) => textOf(f.payload as MessageEventPayload));
    expect(wsTexts).toEqual(texts(71, 120));

    // 往上翻：before 是手里最早那条消息的序号
    const page1 = await frontend.history(SECRETARY, { before: seqOf(71) });
    expect(page1.hasMore).toBe(true);
    expect(page1.messages.map((m) => m.seq)).toEqual(Array.from({ length: 50 }, (_, k) => seqOf(21 + k)));
    expect(page1.messages.map((m) => textOf(m))).toEqual(texts(21, 70));
    const page2 = await frontend.history(SECRETARY, { before: page1.messages[0]!.seq });
    expect(page2.hasMore).toBe(false);
    expect(page2.messages.map((m) => textOf(m))).toEqual(texts(1, 20));

    // 拼起来正好是全部消息，按顺序、不重不漏
    const all = [...page2.messages.map(idOf), ...page1.messages.map(idOf), ...replayed.filter((f) => f.type === MESSAGE).map((f) => (f.payload as MessageEventPayload).message.id)];
    expect(all).toEqual(listMessages(daemon.store.reader, SECRETARY).map((m) => m.id));

    // 之后的新事件照常推送，序号接着最后一条
    await frontend.sendText("还在吗");
    await waitUntil(() => frontend.events({ channel: SECRETARY, type: TURN_END }).length === 6, {
      timeoutMs: SECRETARY_START_TIMEOUT_MS,
      describe: () => `等秘书回完这一轮，现在 ${frontend.events({ channel: SECRETARY, type: TURN_END }).length} 条 turn_end`,
    });
    expect(frontend.events({ channel: SECRETARY, persistedOnly: true }).slice(replayed.length).map((f) => f.seq)).toEqual([133, 134, 135, 136]);
  });

  it("消息不到 50 条时第一次订阅照旧从头补发；带着游标重连只补缺的", async () => {
    const { url, daemon } = await startTestDaemon();
    seedHistory(daemon, 30);
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    // 30 条消息加 3 条 turn_end
    await waitUntil(() => frontend.cursors[SECRETARY] === 33, { describe: () => `补发到 ${frontend.cursors[SECRETARY]}，要到 33` });
    expect(frontend.events({ channel: SECRETARY, persistedOnly: true }).map((f) => f.seq)).toEqual(Array.from({ length: 33 }, (_, k) => k + 1));

    await frontend.disconnect();
    seedHistory(daemon, 60);
    await frontend.reconnect([SECRETARY]);
    await waitUntil(() => frontend.cursors[SECRETARY] === 33 + 66, { describe: () => `补发到 ${frontend.cursors[SECRETARY]}，要到 99` });
    // 重连带着游标 33：从 34 起全部补发（不按"最近一页"截）
    expect(frontend.events({ channel: SECRETARY, persistedOnly: true }).map((f) => f.seq)).toEqual(Array.from({ length: 99 }, (_, k) => k + 1));
  });

  it("时间线记录跟着它所在的那一页回来：超过一页之后，旧页里的偏离、操作记录往上翻取回；第一次补发只带最近一页里的（录给前端回放）", async () => {
    const { url, daemon } = await startTestDaemon();
    // 维护者会话：60 条消息（前 30 条在第一阶段），第 5 条之后一条偏离、第 55 条之后一条范围变更
    for (let i = 1; i <= 60; i++) {
      const scope = { taskId: "t-1", stageId: i <= 30 ? "s1" : "s2" };
      appendMessage(daemon.store, { conversation: M1, speaker: "agent", parts: [{ type: "text", text: `第 ${i} 条` }] }, scope);
      if (i === 5) daemon.store.append(buildTimelineRecord(M1, { kind: "deviation", summary: "计划外读了一次参考资料", detail: "在授权范围内" }, scope).event);
      if (i === 55) daemon.store.append(buildTimelineRecord(M1, { kind: "scope_change", summary: "加了一个导出步骤" }, scope).event);
    }
    // 秘书会话：60 条消息，第 3 条之后、第 58 条之后各一次快速动作的执行（操作记录）
    for (let i = 1; i <= 60; i++) {
      appendMessage(daemon.store, { conversation: SECRETARY, speaker: "agent", parts: [{ type: "text", text: `第 ${i} 条` }] });
      if (i === 3 || i === 58) daemon.store.append({ channel: SECRETARY, type: EVENT_TYPES.quickActionExecuted, payload: operation(`qa-${i}`) });
    }

    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [M1]: 0, [SECRETARY]: 0 });
    await waitUntil(() => frontend.cursors[M1] === daemon.store.lastSeq(M1) && frontend.cursors[SECRETARY] === daemon.store.lastSeq(SECRETARY));
    const typesOf = (channel: string) => frontend.events({ channel, persistedOnly: true }).map((f) => f.type);
    // 第一次补发：最近 50 条消息起（第 11 条起），只带着其中的记录
    expect(typesOf(M1).filter((t) => t !== MESSAGE)).toEqual([EVENT_TYPES.timelineRecord]);
    expect(typesOf(SECRETARY).filter((t) => t !== MESSAGE)).toEqual([EVENT_TYPES.quickActionExecuted]);

    // 往上翻：旧页里的记录跟着消息回来，序号落在这一页里
    const firstSeq = (channel: string) => frontend.events({ channel, persistedOnly: true })[0]!.seq;
    const m1Page = await frontend.history(M1, { before: firstSeq(M1) });
    expect(m1Page.hasMore).toBe(false);
    expect(m1Page.records).toEqual([{ seq: 6, type: EVENT_TYPES.timelineRecord, payload: expect.objectContaining({ taskId: "t-1", stageId: "s1", record: expect.objectContaining({ kind: "deviation", summary: "计划外读了一次参考资料" }) }) }]);
    expect(m1Page.messages.every((m) => "message" in m && m.stageId === "s1")).toBe(true);
    const secretaryPage = await frontend.history(SECRETARY, { before: firstSeq(SECRETARY) });
    expect(secretaryPage.records).toEqual([{ seq: 4, type: EVENT_TYPES.quickActionExecuted, payload: operation("qa-3") }]);
    for (const page of [m1Page, secretaryPage]) expect(schemaChecker(HistoryPage).firstError(page)).toBeUndefined();

    // 只取更早的一部分时：只带落在这一页里的记录（第 5 条之后那条在更早的一页）
    const partial = await frontend.history(M1, { before: firstSeq(M1), limit: 4 });
    expect(partial.hasMore).toBe(true);
    expect(partial.records).toEqual([]);
    saveOrCheckRecording("timeline-history", frontend.recording.filter((input) => input.kind !== "history_page" || input.page !== partial));
  });

  it("HTTP 接口：不带 before 取最近一页；limit 有上限；不认识的会话、参数不对时报错", async () => {
    const { url, daemon } = await startTestDaemon();
    seedHistory(daemon, 12);
    const latest = await history(url, SECRETARY, { limit: 5 });
    expect(latest.status).toBe(200);
    expect(latest.body).toMatchObject({ conversation: SECRETARY, hasMore: true });
    expect(latest.body.messages.map((m) => textOf(m))).toEqual(texts(8, 12));
    expect((await history(url, SECRETARY)).body.messages).toHaveLength(12);
    expect((await history(url, "maintainer:没有这个人")).body).toEqual({ conversation: "maintainer:没有这个人", messages: [], records: [], hasMore: false });

    expect((await history(url, "board")).status).toBe(404);
    expect((await history(url, SECRETARY, { before: -1 })).status).toBe(400);
    expect((await history(url, SECRETARY, { limit: 0 })).status).toBe(400);
    expect((await history(url, SECRETARY, { limit: 1000 })).body.messages).toHaveLength(12);
  });
});

/** 一条消息的文字；被彻底删除的（只有标记）是空串 */
function textOf(payload: { message: { parts: readonly { type: string; text?: string }[] } } | { deleted: unknown }): string {
  if (!("message" in payload)) return "";
  return payload.message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
}

/** 历史分页里一条的消息 id（被彻底删除的取标记里的） */
function idOf(entry: HistoryMessage): string | undefined {
  return "message" in entry ? entry.message.id : entry.deleted.messageId;
}
