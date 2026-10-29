// 主切面：337 号票"帮我记一句"。用户对秘书说一句要记下来的话（假模型按剧本调 remember_memory），秘书把**用户的原话**
// 交给记忆插件槽的宿主（host.remember），会意按原话存下来：一条"显式记忆命令"素材 + 立刻读成证据进推理库（检索找得到，
// 出处记着这条会话和那条消息）。走真的装配路径（组合根 + 插件清单 + 假模型），临时数据目录、假向量，不碰真的 ~/.ergo。
// 然后彻底删除这条会话：记忆没了，记它的那次工具调用在事件日志里也改写成删除标记（会话文件跟着改）。
import { CHANNELS, EVENT_TYPES, isDeletedEventPayload, type MemoryCommandEventPayload, type MessagesPurgedEventPayload, type MessageEventPayload, type MessagePart, PURGED_TEXT } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { MATERIALS_CHANNEL } from "../../src/materials/index.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { materialsApi } from "../helpers/http.ts";

const { secretary: SECRETARY } = CHANNELS;
const ALL = { [SECRETARY]: 0 };

/** 用户要秘书记下来的那句原话（中性假名，别用真名） */
const SAID = "周四晚上和小林约了在体育馆打羽毛球";

const say = (text: string): FauxStep => ({ kind: "reply", text });
const remember = (text: string): FauxStep => ({ kind: "reply", toolCalls: [{ name: "remember_memory", arguments: { text } }] });

/** 秘书最后一条回话的正文 */
const lastSecretaryText = (frontend: TestFrontend) =>
  (frontend.events({ channel: SECRETARY, type: EVENT_TYPES.message }).at(-1)!.payload as MessageEventPayload).message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
/** 会话里某个工具调用的记录（守卫接入记的那一条） */
const toolCallParts = (frontend: TestFrontend, tool: string): Array<Extract<MessagePart, { type: "tool_call" }>> =>
  frontend.events({ channel: SECRETARY, type: EVENT_TYPES.message }).flatMap((frame) => {
    if (isDeletedEventPayload(frame.payload)) return [];
    return (frame.payload as MessageEventPayload).message.parts.flatMap((part) => (part.type === "tool_call" && part.tool === tool ? [part] : []));
  });

const commandsOf = (td: Awaited<ReturnType<typeof startTestDaemon>>) =>
  td.daemon.store.read(MATERIALS_CHANNEL, 0, EVENT_TYPES.memoryCommand).map((event) => event.payload as MemoryCommandEventPayload);

/** 一个字都不剩（事件日志整个搜一遍）：彻底删除以后用 */
const eventLog = (td: Awaited<ReturnType<typeof startTestDaemon>>) => JSON.stringify(td.daemon.store.readGlobal(0, 100_000));

describe("秘书记一句", () => {
  it("用户说\"帮我记一句\"：秘书调 remember_memory（过了守卫、做完了），原话真的进了记忆、带着那条消息的出处", { timeout: 60_000 }, async () => {
    const td = await startTestDaemon({ secretary: [remember(SAID), say("记下了。")] });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe(ALL);
    const sent = await frontend.sendText(`帮我记一句：${SAID}`);
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);

    // 工具结果回到了秘书手里（它据此回一句"记下了"）：调用记录上记着结果摘要
    const [call] = toolCallParts(frontend, "remember_memory");
    expect(call).toMatchObject({ tool: "remember_memory", outcome: "done" });
    expect(call!.argsSummary).toContain(SAID);
    expect(call!.resultSummary).toContain("记下了");
    expect(lastSecretaryText(frontend)).toBe("记下了。");

    // 真的进了记忆：原话一字不改，出处是素材 + 那条消息
    const hit = (await td.daemon.memoryHost.search({ text: SAID })).items.find((item) => item.text === SAID);
    expect(hit).toBeDefined();
    expect(hit!.sources).toContainEqual({ kind: "message", id: sent.messageId });
    expect(hit!.sources.some((source) => source.kind === "material")).toBe(true);
    // 素材落在秘书的会话里，出处记着那条消息
    const material = td.daemon.materials.list({ conversation: SECRETARY }).find((m) => m.kind === "memory_command");
    expect(material?.ref.messageId).toBe(sent.messageId);

    // 事件日志里是一条"从秘书那里来"的记住命令：没有卡片，带着会话、消息、那次工具调用
    const command = commandsOf(td).find((payload) => payload.command === "remember");
    expect(command?.command === "remember" ? command?.from : undefined).toMatchObject({
      kind: "secretary",
      conversation: SECRETARY,
      inputMessageId: sent.messageId,
      toolCallId: call!.callId,
    });

    await frontend.close();
    await td.daemon.stop();
  });

  it("彻底删除这条会话：记忆没了，记它的那次工具调用改写成删除标记（会话文件也要改），原话整个事件日志里不剩", { timeout: 60_000 }, async () => {
    const td = await startTestDaemon({ secretary: [remember(SAID), say("记下了。")] });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe(ALL);
    const sent = await frontend.sendText(`帮我记一句：${SAID}`);
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
    const [call] = toolCallParts(frontend, "remember_memory");
    expect((await td.daemon.memoryHost.search({ text: SAID })).items.length).toBeGreaterThan(0);

    // 设置里按会话彻底删除（和用户在设置里选这个会话一样，走现成的批量删除）
    const purged = await materialsApi.delete(td.url, { scope: { kind: "conversation", conversation: SECRETARY }, mode: "purge", idempotencyKey: "purge-remember-main" });
    expect(purged.status).toBe(200);
    const notice = (await frontend.next(SECRETARY, EVENT_TYPES.messagesPurged)).payload as MessagesPurgedEventPayload;
    // 那条工具调用在会话文件里也要改（参数和结果整个换掉）
    expect(notice.toolCallIds).toContain(call!.callId);

    // 记忆没了
    expect((await td.daemon.memoryHost.search({ text: SAID })).items).toEqual([]);
    // 那次工具调用记录改写成删除标记（参数摘要、结果摘要），原话一个字不剩（含工具调用的完整内容）
    const record = td.daemon.store
      .read(SECRETARY, 0, EVENT_TYPES.message)
      .flatMap((event) => (isDeletedEventPayload(event.payload) ? [] : (event.payload as MessageEventPayload).message.parts))
      .find((part) => part.type === "tool_call" && part.tool === "remember_memory");
    expect(record).toMatchObject({ argsSummary: PURGED_TEXT, resultSummary: PURGED_TEXT });
    expect(eventLog(td)).not.toContain(SAID);
    // 记住的命令事件只换掉内容，命令 id、来源、出处不变
    const command = commandsOf(td).find((payload) => payload.command === "remember");
    expect(command?.command === "remember" ? command?.content : undefined).toBe(PURGED_TEXT);
    expect(command?.command === "remember" ? command?.from : undefined).toMatchObject({ kind: "secretary", conversation: SECRETARY, inputMessageId: sent.messageId });

    await frontend.close();
    await td.daemon.stop();
  });
});
