// 主切面：素材删除（规格第 15 节）。秘书接 faux 剧本：用素材检索工具（关键词 + 向量）找出匹配的素材，
// 再用"提议快速动作"出一张记忆删除卡；卡同时进待我处理，用户核对后确认才执行：
// - 忘掉：素材及其原文副本从 memory.db 删除，关键词和向量检索都不再命中，聊天历史里原话仍在；
// - 别推断：素材和索引保留，带"不参与推断"标记；
// - 彻底删除：事件日志和秘书会话文件里的原文都改写成删除标记，历史分页和重连补发只返回标记，整体重建派生视图后也不回来；
//   别的事件（审批决定、卡片、工具调用记录、效果日志）只改带原话的字段，状态不变（审批表重建后仍是已拒绝）；
//   没有别的消息引用的附件媒体文件一起删（按媒体 id 下载 404）；
// 设置里按会话、按时间段批量做这三种删除；附件菜单"作为材料投喂"发的消息记成"用户主动投喂的材料"。
import fs from "node:fs";
import path from "node:path";
import {
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  type HistoryMessage,
  type InboxItemEventPayload,
  isDeletedEventPayload,
  type MessageEventPayload,
  type MessagePart,
  type MessagesPurgedEventPayload,
  PURGED_TEXT,
  type QuickActionExecutedEventPayload,
} from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { listMessages } from "../../src/conversation/views.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { realPathOf } from "../../src/util/real-path.ts";
import { countAgentSpawns, startTestDaemon } from "../helpers/daemon.ts";
import { vectorsSettled } from "../helpers/embedder.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { materialsApi, media } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";
import { saveOrCheckRecording } from "../helpers/recording.ts";

const { secretary: SECRETARY, cards: CARDS, inbox: INBOX, board: BOARD } = CHANNELS;
const ALL = { [SECRETARY]: 0, [CARDS]: 0, [INBOX]: 0, [BOARD]: 0 };
const MATERIAL_ID = "mat-[0-9a-f]{24}";

const reply = (text: string): FauxStep => ({ kind: "reply", text });
const search = (query: string): FauxStep => ({ kind: "reply", toolCalls: [{ name: "search_materials", arguments: { query } }] });
/** 秘书照着检索结果里的素材 id 提议删除 */
const proposeFromResults = (type: "forget" | "purge" | "no_infer"): FauxStep => ({
  kind: "call_with_matches",
  toolCall: { name: "propose_quick_action", arguments: { type, params: {} } },
  argument: "params.materialIds",
  pattern: MATERIAL_ID,
});

async function tell(frontend: TestFrontend, text: string) {
  const sent = await frontend.sendText(text);
  await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
  return sent;
}

const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).flatMap((f) => (isDeletedEventPayload(f.payload) ? [] : [(f.payload as CardEventPayload).card]));
const latest = (frontend: TestFrontend, id: string): Card => cardsOf(frontend).filter((c) => c.id === id).at(-1)!;
const deleteCards = (frontend: TestFrontend): Card[] => [...new Map(cardsOf(frontend).filter((c) => c.type === "memory_delete").map((c) => [c.id, c])).values()];
const lastReply = (frontend: TestFrontend): string =>
  (frontend.events({ channel: SECRETARY, type: EVENT_TYPES.message }).at(-1)!.payload as MessageEventPayload).message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
/** 聊天里某个工具的调用记录（07 的守卫接入：每次工具调用一条只有工具调用 part 的消息） */
const toolCallRecords = (frontend: TestFrontend, tool: string) =>
  frontend.events({ channel: SECRETARY, type: EVENT_TYPES.message }).flatMap((f) => {
    if (isDeletedEventPayload(f.payload)) return [];
    const message = (f.payload as MessageEventPayload).message;
    const part = message.parts[0];
    return part?.type === "tool_call" && part.tool === tool ? [{ seq: f.seq, messageId: message.id }] : [];
  });
const originalsOf = (dataDir: string): string[] => {
  const root = path.join(dataDir, "materials", "originals");
  return fs.existsSync(root) ? fs.readdirSync(root, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".json")).map((f) => path.basename(f, ".json")) : [];
};

describe("忘掉、别推断", () => {
  it("秘书检索出匹配的素材，出记忆删除卡（进待我处理）；确认忘掉后素材和原文副本都删了、检索不再命中，聊天历史里原话还在；别推断只打标记", async () => {
    const { url, daemon, dataDir } = await startTestDaemon({
      secretary: [
        reply("好"),
        reply("好"),
        search("房东"),
        proposeFromResults("forget"),
        { kind: "echo_context" },
        search("搬家公司"),
        proposeFromResults("no_infer"),
        reply("请核对"),
      ],
    });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe(ALL);
    const moving = await tell(frontend, "下个月要搬家了，房东要卖房");
    await tell(frontend, "搬家公司选便宜的");
    const [movingMaterial, moverMaterial] = daemon.materials.list();
    await vectorsSettled(daemon.materials);
    const spawned = countAgentSpawns(daemon);

    await tell(frontend, "忘掉我说的房东卖房的事");
    const [card] = deleteCards(frontend);
    expect(card).toMatchObject({
      status: "pending",
      payload: {
        mode: "forget",
        conversation: SECRETARY,
        matches: [{ materialId: movingMaterial!.id, kind: "用户发言", excerpt: "下个月要搬家了，房东要卖房", conversation: SECRETARY }],
      },
      text: "记忆删除：忘掉 1 条素材（待核对）",
    });
    const item = frontend.events({ channel: INBOX, type: EVENT_TYPES.inboxItem }).map((f) => (f.payload as InboxItemEventPayload).item).find((i) => i.kind === "card" && i.cardId === card!.id);
    expect(item).toMatchObject({ title: "核对要忘掉的记忆（1 条）", urgency: "non_blocking" });
    // 秘书看到的：检索结果（命令本身不列出）、等用户确认
    const seen = lastReply(frontend);
    expect(seen).toContain(`[toolResult] search_materials: 找到 1 条素材：\n- ${movingMaterial!.id}`);
    expect(seen).toContain("[toolResult] propose_quick_action: 等用户确认：忘掉 1 条素材");
    // 还没确认：什么都没删
    expect(daemon.materials.get(movingMaterial!.id)).toBeDefined();

    const ack = await frontend.cardAction({ cardId: card!.id, action: "delete", expectedVersion: 1, input: { mode: "forget", materialIds: [movingMaterial!.id] } }, "forget-key");
    expect(ack.ok).toBe(true);
    const record = (await frontend.next(SECRETARY, EVENT_TYPES.quickActionExecuted)).payload as QuickActionExecutedEventPayload;
    expect(record).toMatchObject({ action: { type: "forget", params: { materialIds: [movingMaterial!.id] } }, cardId: card!.id, explicit: false, result: { ok: true, summary: "已忘掉 1 条素材" } });
    expect(latest(frontend, card!.id)).toMatchObject({ status: "handled", outcome: { action: "delete" }, payload: { result: { mode: "forget", count: 1 } }, text: "记忆删除：已忘掉 1 条素材" });
    // 同一个请求重发：同一个结果，不再执行
    expect(await frontend.cardAction({ cardId: card!.id, action: "delete", expectedVersion: 1, input: { mode: "forget", materialIds: [movingMaterial!.id] } }, "forget-key")).toMatchObject({ ok: true, result: ack.ok ? ack.result : undefined });
    expect(frontend.events({ channel: SECRETARY, type: EVENT_TYPES.quickActionExecuted })).toHaveLength(1);

    expect(daemon.materials.get(movingMaterial!.id)).toBeUndefined();
    expect(daemon.materials.searchKeyword("房东要卖房")).toEqual([]);
    expect((await daemon.materials.searchSemantic("换个地方住", { limit: 10 })).map((h) => h.material.id)).not.toContain(movingMaterial!.id);
    expect(originalsOf(dataDir)).not.toContain(movingMaterial!.id);
    // 聊天历史里原话还在
    const page = await frontend.history(SECRETARY);
    expect(page.messages.find((m: HistoryMessage) => m.seq === moving.seq)).toMatchObject({ message: { parts: [{ type: "text", text: "下个月要搬家了，房东要卖房" }] } });
    // 显式记忆命令素材
    expect(daemon.materials.list({ kind: "memory_command" })).toMatchObject([{ context: ["command:forget", "secretary"], segments: [{ text: "忘掉 1 条素材" }] }]);

    await tell(frontend, "别根据搬家公司那条做推断");
    const noInfer = deleteCards(frontend)[1]!;
    expect(noInfer.payload).toMatchObject({ mode: "no_infer", matches: [{ materialId: moverMaterial!.id }] });
    await frontend.cardAction({ cardId: noInfer.id, action: "delete", expectedVersion: 1, input: { mode: "no_infer", materialIds: [moverMaterial!.id] } });
    await frontend.next(SECRETARY, EVENT_TYPES.quickActionExecuted);
    expect(daemon.materials.get(moverMaterial!.id)).toMatchObject({ noInfer: true });
    // 素材和索引都还在（用户这句"别推断"本身也是一条发言素材）
    expect(daemon.materials.searchKeyword("搬家公司").map((m) => m.id)).toContain(moverMaterial!.id);
    expect(originalsOf(dataDir)).toContain(moverMaterial!.id);

    // 执行不拉起 agent、看板不变
    expect(spawned()).toBe(0);
    expect(frontend.events({ channel: BOARD })).toEqual([]);
  });
});

describe("彻底删除", () => {
  it("事件日志和会话文件里的原文改写成删除标记；历史分页、重连补发只返回标记；重建派生视图后也不回来；素材和索引按忘掉删除", async () => {
    // 秘书改写会话文件后重新拉起，faux 剧本从头再来：第一步留给那时的 echo_context（看它的上下文）
    const { url, daemon, dataDir } = await startTestDaemon({
      secretary: [{ kind: "echo_context" }, reply("嗯"), search("房东 卖房"), proposeFromResults("purge"), reply("请核对")],
    });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe(ALL);
    await tell(frontend, "你好");
    const moving = await tell(frontend, "下个月要搬家了，房东要卖房");
    const material = daemon.materials.list().find((m) => m.ref.messageId === moving.messageId);
    await tell(frontend, "彻底删除我说的房东卖房的事");
    const [card] = deleteCards(frontend);
    expect(card!.payload).toMatchObject({ mode: "purge", matches: [{ materialId: material!.id, excerpt: "下个月要搬家了，房东要卖房" }] });
    const secretaryPid = daemon.secretary.pid;

    await frontend.cardAction({ cardId: card!.id, action: "delete", expectedVersion: 1, input: { mode: "purge", materialIds: [material!.id] } });
    const purged = (await frontend.next(SECRETARY, EVENT_TYPES.messagesPurged)).payload as MessagesPurgedEventPayload;
    // 原话那条消息整条删掉；检索素材那次调用的记录（结果摘要里有素材的摘录）只换掉参数摘要和结果摘要，还是一次工具调用
    const searchRecord = toolCallRecords(frontend, "search_materials")[0]!;
    expect(purged).toMatchObject({
      messages: [
        { seq: moving.seq, messageId: moving.messageId },
        {
          seq: searchRecord.seq,
          messageId: searchRecord.messageId,
          replacement: { parts: [{ type: "tool_call", tool: "search_materials", argsSummary: PURGED_TEXT, resultSummary: PURGED_TEXT, outcome: "done" }] },
        },
      ],
      materialIds: [material!.id],
      toolCallIds: [],
      mediaIds: [],
    });
    expect(purged.messages[0]).not.toHaveProperty("replacement");
    await frontend.next(SECRETARY, EVENT_TYPES.quickActionExecuted);
    // 卡片换成去掉摘录的新版本
    expect(latest(frontend, card!.id)).toMatchObject({ status: "handled", payload: { result: { mode: "purge", count: 1 }, matches: [{ materialId: material!.id, excerpt: "", purged: true }] } });

    // 事件日志：原来的事件改写成标记（位置、类型、时间不变），整个日志里一个字都不剩
    const rewritten = daemon.store.eventAt(SECRETARY, moving.seq)!;
    expect(rewritten.type).toBe(EVENT_TYPES.message);
    expect(rewritten.payload).toEqual({ deleted: true, deletedAt: expect.any(String), messageId: moving.messageId, messageTime: expect.any(String) });
    expect(JSON.stringify(daemon.store.readGlobal(0, 100_000))).not.toContain("房东要卖房");
    // 历史分页只返回标记
    const page = await frontend.history(SECRETARY);
    expect(page.messages.find((m) => m.seq === moving.seq)).toEqual({ seq: moving.seq, deleted: rewritten.payload });
    // 重连补发（新开一个页面）只返回标记，卡片只有去掉摘录的版本
    const fresh = await TestFrontend.connect(url);
    await fresh.subscribe({ [SECRETARY]: 0, [CARDS]: 0 });
    await waitUntil(() => fresh.cursors[SECRETARY] === daemon.store.lastSeq(SECRETARY) && fresh.cursors[CARDS] === daemon.store.lastSeq(CARDS));
    expect(fresh.events({ channel: SECRETARY }).find((f) => f.seq === moving.seq)?.payload).toEqual(rewritten.payload);
    expect(JSON.stringify(fresh.events())).not.toContain("房东要卖房");
    expect(latest(fresh, card!.id).payload).toMatchObject({ matches: [{ excerpt: "", purged: true }] });
    // 从事件日志整体重建派生视图：原文也不回来
    daemon.store.rebuildViews();
    expect(listMessages(daemon.store.reader, SECRETARY).map((m) => m.id)).not.toContain(moving.messageId);
    expect(daemon.cards.get(card!.id)?.payload).toMatchObject({ matches: [{ excerpt: "" }] });
    // 素材和原文副本按忘掉删除
    expect(daemon.materials.get(material!.id)).toBeUndefined();
    expect(daemon.materials.searchKeyword("房东要卖房")).toEqual([]);
    expect(originalsOf(dataDir)).not.toContain(material!.id);

    // 秘书的会话文件也改写了：秘书停下、改写、接着同一个会话再拉起；之后它看到的上下文里只有删除标记
    await waitUntil(() => daemon.secretary.pid !== undefined && daemon.secretary.pid !== secretaryPid && daemon.secretary.status === "idle");
    const sessionDir = path.join(dataDir, "sessions", "secretary");
    // （秘书自己的回复、工具调用参数里转述的话不改写：这里秘书检索时只写了"房东 卖房"）
    for (const f of fs.readdirSync(sessionDir)) expect(fs.readFileSync(path.join(sessionDir, f), "utf8")).not.toContain("房东要卖房");
    await tell(frontend, "刚才我说了什么？");
    const seen = lastReply(frontend);
    expect(seen).not.toContain("房东要卖房");
    expect(seen).toContain(`[user] ${PURGED_TEXT}`);
    expect(seen).toContain(`- ${material!.id} · ${PURGED_TEXT}`);
    saveOrCheckRecording("memory-purge", frontend.recording);
  });

  it("彻底删除\"记住\"过的内容：记忆命令、操作记录、快速动作卡、提议和检索的工具调用记录、效果日志里都不剩原话", async () => {
    const remembered = "我对花生过敏，吃了会起疹子";
    const { url, daemon, dataDir } = await startTestDaemon({
      secretary: [
        { kind: "reply", toolCalls: [{ name: "propose_quick_action", arguments: { type: "remember", params: { content: remembered } } }] },
        reply("记下了"),
        search("花生"),
        proposeFromResults("purge"),
        reply("请核对"),
      ],
    });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe(ALL);
    await tell(frontend, `记住：${remembered}`);
    const [said, command] = [daemon.materials.list({ kind: "user_utterance" })[0]!, daemon.materials.list({ kind: "memory_command" })[0]!];
    const proposeRecord = toolCallRecords(frontend, "propose_quick_action")[0]!;
    // 效果日志里有这次提议（参数里有原话）
    expect(JSON.stringify(daemon.store.read("guard"))).toContain(remembered);

    await tell(frontend, "彻底删除花生的事");
    const secretaryPid = daemon.secretary.pid;
    const [card] = deleteCards(frontend);
    expect((card!.payload as { matches: Array<{ materialId: string }> }).matches.map((m) => m.materialId).toSorted()).toEqual([said.id, command.id].toSorted());
    await frontend.cardAction({ cardId: card!.id, action: "delete", expectedVersion: 1, input: { mode: "purge", materialIds: [said.id, command.id] } });
    const purged = (await frontend.next(SECRETARY, EVENT_TYPES.messagesPurged)).payload as MessagesPurgedEventPayload;
    expect(purged.messages.map((m) => m.messageId)).toEqual(expect.arrayContaining([said.ref.messageId, proposeRecord.messageId, toolCallRecords(frontend, "search_materials")[0]!.messageId]));
    // 提议"记住"的那次工具调用：会话文件里它的参数和结果也要改
    expect(purged.toolCallIds).toEqual([(cardsOf(frontend).find((c) => c.type === "quick_action")!.payload as { toolCallId: string }).toolCallId]);

    // 整个事件日志里一个字都不剩；快速动作卡只剩动作的名字（状态还是已执行）
    expect(JSON.stringify(daemon.store.readGlobal(0, 100_000))).not.toContain("吃了会起疹子");
    const quick = cardsOf(frontend).find((c) => c.type === "quick_action")!;
    expect(daemon.cards.get(quick.id)).toMatchObject({ status: "handled", payload: { title: `记住：${PURGED_TEXT}`, action: { type: "remember", params: null } } });
    expect(daemon.materials.get(said.id)).toBeUndefined();
    expect(daemon.materials.get(command.id)).toBeUndefined();
    // 秘书的会话文件里也不剩：用户的话、提议"记住"的参数和结果、检索结果里的摘录
    await waitUntil(() => daemon.secretary.pid !== undefined && daemon.secretary.pid !== secretaryPid && daemon.secretary.status === "idle");
    const sessionDir = path.join(dataDir, "sessions", "secretary");
    for (const f of fs.readdirSync(sessionDir)) expect(fs.readFileSync(path.join(sessionDir, f), "utf8")).not.toContain("起疹子");
  });
});

describe("彻底删除不改坏状态、连附件一起删", () => {
  it("审批决定：彻底删除秘书主线后，事件日志里没有用户拒绝时写的说明，审批表仍是已拒绝；整体重建派生视图后也一样", async () => {
    const { url, daemon, homeDir, dataDir } = await startTestDaemon({
      secretary: [{ kind: "reply", toolCalls: [{ name: "read", arguments: { path: "~/Documents/diary.txt" } }] }, reply("好的，不看了")],
    });
    const home = realPathOf(homeDir)!;
    fs.mkdirSync(path.join(home, "Documents"), { recursive: true });
    fs.writeFileSync(path.join(home, "Documents", "diary.txt"), "今天心情不错");
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe(ALL);
    await frontend.sendText("看看 ~/Documents/diary.txt");
    await waitUntil(() => cardsOf(frontend).some((c) => c.type === "approval"), { timeoutMs: 20_000, describe: () => "等审批卡" });
    const approval = cardsOf(frontend).find((c) => c.type === "approval")!;
    const approvalId = (approval.payload as { approvalId: string }).approvalId;
    await frontend.cardAction({ cardId: approval.id, action: "deny", expectedVersion: approval.version, note: "这是我的私人日记，别看" });
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
    expect(daemon.materials.list({ kind: "approval_decision" })).toHaveLength(1);
    expect(daemon.approvals.get(approvalId)).toMatchObject({ status: "denied" });
    const secretaryPid = daemon.secretary.pid;

    expect((await materialsApi.delete(url, { scope: { kind: "conversation", conversation: SECRETARY }, mode: "purge", idempotencyKey: "purge-all" })).body).toMatchObject({ count: 2 });

    const log = JSON.stringify(daemon.store.readGlobal(0, 100_000));
    expect(log).not.toContain("私人日记");
    // 审批决定的事件还在：决定、审批 id、卡片不变，只有说明和参数摘要换成了删除标记
    const decided = daemon.store.read("guard").find((e) => e.type === "approval_decided")!;
    expect(decided.payload).toMatchObject({ approvalId, decision: "denied", note: PURGED_TEXT, argsSummary: PURGED_TEXT, cardId: approval.id });
    expect(daemon.approvals.get(approvalId)).toMatchObject({ status: "denied" });
    // 审批卡：还是已处理（拒绝），用户写的说明换成删除标记
    expect(daemon.cards.get(approval.id)).toMatchObject({ status: "handled", outcome: { action: "deny", note: PURGED_TEXT } });
    expect(daemon.materials.list({ kind: "approval_decision" })).toEqual([]);

    daemon.store.rebuildViews();
    expect(daemon.approvals.get(approvalId)).toMatchObject({ status: "denied" });
    expect(daemon.cards.get(approval.id)).toMatchObject({ status: "handled", outcome: { action: "deny" } });

    // 会话文件里模型收到的"用户拒绝了这次调用：<说明>"也改写了
    await waitUntil(() => daemon.secretary.pid !== undefined && daemon.secretary.pid !== secretaryPid && daemon.secretary.status === "idle");
    const sessionDir = path.join(dataDir, "sessions", "secretary");
    for (const f of fs.readdirSync(sessionDir)) expect(fs.readFileSync(path.join(sessionDir, f), "utf8")).not.toContain("私人日记");
  });

  it("被删的消息引用的附件：没有别的消息引用的，媒体文件一起删（按媒体 id 下载 404）；别的消息还引用的留着", async () => {
    const { url, daemon } = await startTestDaemon();
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe(ALL);
    const report = await media.upload(url, Buffer.from("血常规正常"), { name: "体检报告.txt", mime: "text/plain" });
    const shared = await media.upload(url, Buffer.from("公司地址"), { name: "地址.txt", mime: "text/plain" });
    const filePart = (m: typeof report, name: string): MessagePart => ({ type: "file", mediaId: m.mediaId, name, mime: "text/plain", size: m.size });
    await frontend.sendParts([filePart(report, "体检报告.txt"), filePart(shared, "地址.txt"), { type: "text", text: "体检报告和地址" }]);
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
    await frontend.sendParts([filePart(shared, "地址.txt"), { type: "text", text: "再发一次地址" }]);
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
    const [first] = daemon.materials.list();

    await materialsApi.delete(url, { scope: { kind: "time_range", from: first!.time, to: first!.time }, mode: "purge", idempotencyKey: "purge-report" });
    const purged = (await frontend.next(SECRETARY, EVENT_TYPES.messagesPurged)).payload as MessagesPurgedEventPayload;
    expect(purged.mediaIds.toSorted()).toEqual([report.mediaId, shared.mediaId].toSorted());
    expect((await media.download(url, report.mediaId)).status).toBe(404);
    expect((await media.download(url, shared.mediaId)).status).toBe(200);
  });
});

describe("设置里按会话、按时间段删除", () => {
  it("选一个会话或一个时间段、选一种删法，确认后对范围内的全部素材执行；同一个请求重发只执行一次", async () => {
    const { url, daemon } = await startTestDaemon();
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe(ALL);
    for (const text of ["第一句：想换工作", "第二句：猎头又来了", "第三句：先别跟人说"]) await tell(frontend, text);
    const [first, second, third] = daemon.materials.list();

    expect((await materialsApi.scope(url)).body).toEqual({ count: 3, conversations: [{ conversation: SECRETARY, count: 3 }] });
    expect((await materialsApi.scope(url, { kind: "conversation", conversation: SECRETARY })).body).toMatchObject({ count: 3 });
    const range = { kind: "time_range" as const, from: second!.time, to: second!.time };
    expect((await materialsApi.scope(url, range)).body).toMatchObject({ count: 1 });

    // 按时间段：别推断
    expect((await materialsApi.delete(url, { scope: range, mode: "no_infer", idempotencyKey: "k-1" })).body).toEqual({ count: 1 });
    expect(daemon.materials.get(second!.id)?.noInfer).toBe(true);
    expect(daemon.materials.get(first!.id)?.noInfer).toBe(false);
    // 按时间段：彻底删除第三句
    const thirdRange = { kind: "time_range" as const, from: third!.time, to: third!.time };
    expect((await materialsApi.delete(url, { scope: thirdRange, mode: "purge", idempotencyKey: "k-2" })).body).toEqual({ count: 1 });
    expect(daemon.materials.get(third!.id)).toBeUndefined();
    expect(JSON.stringify(daemon.store.read(SECRETARY))).not.toContain("先别跟人说");
    expect((await frontend.next(SECRETARY, EVENT_TYPES.messagesPurged)).payload).toMatchObject({ messages: [{ messageId: third!.ref.messageId }] });
    // 按会话：忘掉剩下的（重发同一个请求只执行一次）
    const scope = { kind: "conversation" as const, conversation: SECRETARY };
    expect((await materialsApi.delete(url, { scope, mode: "forget", idempotencyKey: "k-3" })).body).toEqual({ count: 2 });
    expect((await materialsApi.delete(url, { scope, mode: "forget", idempotencyKey: "k-3" })).body).toEqual({ count: 2 });
    expect(daemon.materials.list({ kind: "user_utterance" })).toEqual([]);
    expect(JSON.stringify(daemon.store.read(SECRETARY))).toContain("第一句：想换工作");
    // 每次删除都是一条显式记忆命令
    expect(daemon.materials.list({ kind: "memory_command" }).map((m) => m.context[0])).toEqual(["command:no_infer", "command:purge", "command:forget"]);

    expect((await materialsApi.delete(url, { scope: { kind: "time_range", from: "不是时间", to: "2026-01-01" }, mode: "forget", idempotencyKey: "k-4" })).status).toBe(400);
  });
});

describe("作为材料投喂", () => {
  it("经附件菜单\"作为材料投喂\"发的消息和附件产生\"用户主动投喂的材料\"素材；普通方式发的附件不产生", async () => {
    const { url, daemon } = await startTestDaemon();
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe(ALL);
    const notes = await media.upload(url, Buffer.from("# 置身事内\n读书笔记"), { name: "笔记.md", mime: "text/markdown" });
    const fed = await frontend.sendParts([{ type: "file", mediaId: notes.mediaId, name: "笔记.md", mime: "text/markdown", size: notes.size, asMaterial: true }, { type: "text", text: "这是我的读书笔记" }]);
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
    const plain = await frontend.sendParts([{ type: "file", mediaId: notes.mediaId, name: "笔记.md", mime: "text/markdown", size: notes.size }]);
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);

    const messages = frontend.events({ channel: SECRETARY, type: EVENT_TYPES.message }).map((f) => (f.payload as MessageEventPayload).message);
    expect(messages.find((m) => m.id === fed.messageId)!.parts[0]).toMatchObject({ type: "file", asMaterial: true });
    expect(messages.find((m) => m.id === plain.messageId)!.parts[0]).not.toHaveProperty("asMaterial");
    expect(daemon.materials.list().map((m) => [m.ref.messageId, m.kind])).toEqual([
      [fed.messageId, "fed_material"],
      [plain.messageId, "user_utterance"],
    ]);
  });
});
