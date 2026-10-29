// 主切面：彻底删除的一次性补抹（272 号票第 1 条）。真的守护进程起在一个"265 号票以前就删过东西"的数据目录上：
// - 推理库里那条素材的证据已经删了（记忆插件跟着记忆命令删的，留着审计）；事件日志里登记着那次彻底删除（记忆命令），
//   但秘书问记忆那次调用的记录、完整内容和秘书会话文件里的结果还引着被删的原话（265 号票以前不按证据编号找）；
// - 守护进程起来：问记忆结果里引着被删素材证据编号的那几行（连同原话这些续行）换成删除标记，别的证据、简报结构一字不动；
//   秘书的会话上追加一条 messages_purged，秘书据此把会话文件里的结果也按编号换掉——每条消息的记忆简报（266 号票，跟在用户输入后面的
//   上下文消息，只在会话文件里引原话）一样换；内部频道记一笔；
// - 再起一次不再跑（记过了）。
// 记忆插件关着跑：补抹是内核这一侧的（推理库属于数据目录，插件停用了照样补）。不碰 ~/.ergo、不调模型。
import fs from "node:fs";
import path from "node:path";
import { type EvidenceDraft, purgeEvidence } from "@ergo/memory";
import { CHANNELS, EVENT_TYPES, type MessageEventPayload, type MessagesPurgedEventPayload, PURGED_TEXT, type ToolCallDetail } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { appendMessage } from "../../src/conversation/messages.ts";
import { conversationViews } from "../../src/conversation/views.ts";
import { openEventStore } from "../../src/events/event-store.ts";
import { recordToolCallDetail, TOOL_CALLS_CHANNEL, toolCallDetailsView } from "../../src/guard-runtime/tool-call-details.ts";
import { askMemoryTool } from "../../src/memory/ask-tool.ts";
import { memoryCommandEvent } from "../../src/memory/deletion.ts";
import { kernelEmbedderAdapter } from "../../src/memory/embedder-adapter.ts";
import { createMemoryEngineProvider } from "../../src/memory/engine-provider.ts";
import { PURGE_BACKFILL_EVENT } from "../../src/memory/purge-backfill.ts";
import { openReasoningDb } from "../../src/memory/rg-db.ts";
import { INPUT_CONTEXT_TYPE } from "../../src/runtime/index.ts";
import { INTERNAL_CHANNEL } from "../../src/scheduler/internal-jobs.ts";
import { clockIso } from "../../src/scheduler/clock.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { FakeEmbedder } from "../helpers/embedder.ts";
import { waitUntil } from "../helpers/process.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const PEANUT = "我对花生过敏，吃了会起疹子";
const CILANTRO = "我不吃香菜，一吃就过敏";
const at = "2026-10-22T04:00:00.000Z";

const say = (sourceRef: string, text: string, when: string): EvidenceDraft => ({ sourceLevel: "self", mode: "say", kind: "utterance", text, context: [], eventTime: when, observedAt: when, sourceRef });
const line = (entry: unknown) => JSON.stringify(entry);

/** 265 号票以前就在的数据：推理库（证据已删、留着审计）、事件日志、秘书的会话文件；返回简报和被删那条的证据编号 */
async function existingData(dataDir: string): Promise<{ brief: string; peanutEv: string; messageBrief: string }> {
  const layout = dataDirLayout(dataDir);
  const clock = new ManualClock(new Date(2026, 9, 12, 12, 0));
  const options = { file: layout.rgDb, clock: () => clockIso(clock), model: "deepseek-flash", embedder: kernelEmbedderAdapter(new FakeEmbedder()) };
  const opened = openReasoningDb(options);
  if (!opened.ok) throw new Error("应该能建库");
  opened.engine.ingestEvidence(say("mat-peanut", PEANUT, "2026-05-01T10:00:00+08:00"));
  opened.engine.ingestEvidence(say("mat-cilantro", CILANTRO, "2026-05-02T10:00:00+08:00"));
  await opened.engine.reflect();
  const peanutEv = opened.engine.store.listEvidence().find((e) => e.sourceRef === "mat-peanut")!.id;
  const cilantroEv = opened.engine.store.listEvidence().find((e) => e.sourceRef === "mat-cilantro")!.id;
  opened.engine.close();
  // 秘书那时问过一次记忆（真的简报正文）
  const provider = createMemoryEngineProvider(options);
  const brief = (await askMemoryTool(provider).run({ question: "我对什么过敏？花生还是香菜？" }, { toolCallId: "call-ask" })).text;
  provider.close();
  // 之后彻底删除了花生那条：记忆插件删了推理库里的证据、写了审计
  const again = openReasoningDb(options);
  if (!again.ok) throw new Error("应该能打开");
  purgeEvidence(again.engine, [peanutEv], { reason: "彻底删除素材", materialIds: ["mat-peanut"], at: clockIso(clock), op: "purge", actor: "user" });
  again.engine.close();

  // 事件日志：问记忆的调用记录和完整内容（原话还在），登记过的彻底删除（记忆命令）
  fs.mkdirSync(layout.db, { recursive: true });
  const store = openEventStore({ file: path.join(layout.db, "ergo.db"), views: [...conversationViews, toolCallDetailsView] });
  try {
    appendMessage(store, {
      conversation: CHANNELS.secretary,
      speaker: "agent",
      parts: [{ type: "tool_call", callId: "call-ask", tool: "ask_memory", argsSummary: "question=我对什么过敏？", categoryTitles: [], withinGrant: false, genericBash: false, outcome: "done", resultSummary: brief }],
    });
    const detail: ToolCallDetail = { callId: "call-ask", agentId: "secretary", conversation: CHANNELS.secretary, tool: "ask_memory", args: { question: "我对什么过敏？" }, outcome: "done", endedAt: at, result: brief, isError: false };
    recordToolCallDetail(store, detail);
    store.append(memoryCommandEvent({ command: "purge", materialIds: ["mat-peanut"], from: { kind: "settings", scope: { kind: "conversation", conversation: CHANNELS.secretary } } }));
  } finally {
    store.close();
  }

  // 秘书的会话文件：那次问记忆的结果；后来一句话跟着的记忆简报（266 号票的写法：结论下面一行一条原话）
  const messageBrief = [
    "【记忆简报】和用户这句话相关的记忆",
    "【对用户的理解】",
    "- [cl-0001] 需求 · 本人说的 · 确认 · 把握高：用户有食物过敏。支持 2 条、反对 0 条",
    `  · 支持 [${peanutEv}] 2026-05-01 · 本人说的：「${PEANUT}」`,
    `  · 支持 [${cilantroEv}] 2026-05-02 · 本人说的：「${CILANTRO}」`,
  ].join("\n");
  const sessionDir = path.join(layout.sessions, "secretary");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, `${at.replaceAll(":", "-")}_s1.jsonl`),
    [
      line({ type: "session", version: 3, id: "s1", timestamp: at, cwd: dataDir }),
      line({ type: "message", id: "m1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: "我对什么过敏来着？" }], timestamp: 0 } }),
      line({ type: "message", id: "m2", parentId: "m1", timestamp: at, message: { role: "assistant", content: [{ type: "toolCall", id: "call-ask", name: "ask_memory", arguments: { question: "我对什么过敏？" } }], timestamp: 0 } }),
      line({ type: "message", id: "m3", parentId: "m2", timestamp: at, message: { role: "toolResult", toolCallId: "call-ask", toolName: "ask_memory", content: [{ type: "text", text: brief }], isError: false, timestamp: 0 } }),
      line({ type: "message", id: "m4", parentId: "m3", timestamp: at, message: { role: "user", content: [{ type: "text", text: "晚饭点什么好" }], timestamp: 0 } }),
      line({ type: "custom_message", id: "c1", parentId: "m4", timestamp: at, customType: INPUT_CONTEXT_TYPE, content: messageBrief, display: false }),
      "",
    ].join("\n"),
  );
  return { brief, peanutEv, messageBrief };
}

/** 秘书会话文件里跟在输入后面的上下文消息（记忆简报） */
function sessionBrief(dataDir: string): string {
  const dir = path.join(dataDirLayout(dataDir).sessions, "secretary");
  for (const name of fs.readdirSync(dir)) {
    for (const raw of fs.readFileSync(path.join(dir, name), "utf8").split("\n")) {
      if (raw.trim() === "") continue;
      const entry = JSON.parse(raw) as { type: string; customType?: string; content?: string };
      if (entry.type === "custom_message" && entry.customType === INPUT_CONTEXT_TYPE) return entry.content ?? "";
    }
  }
  throw new Error("会话文件里没有记忆简报");
}

/** 秘书会话文件里 ask_memory 的结果 */
function sessionResult(dataDir: string): string {
  const dir = path.join(dataDirLayout(dataDir).sessions, "secretary");
  for (const name of fs.readdirSync(dir)) {
    for (const raw of fs.readFileSync(path.join(dir, name), "utf8").split("\n")) {
      if (raw.trim() === "") continue;
      const entry = JSON.parse(raw) as { type: string; message?: { role: string; toolName?: string; content: Array<{ text?: string }> } };
      if (entry.message?.role === "toolResult" && entry.message.toolName === "ask_memory") return entry.message.content.map((c) => c.text ?? "").join("");
    }
  }
  throw new Error("会话文件里没有 ask_memory 的结果");
}

describe("彻底删除的一次性补抹（272 号票）", () => {
  it("265 号票以前删过的素材：守护进程起来时把问记忆结果里引着它的那几行换成删除标记（事件日志和秘书会话文件），别的一字不动；记一笔，再起不再跑", async () => {
    const dataDir = makeTempDir("ergo-data-");
    const homeDir = makeTempDir("ergo-home-");
    const { brief, peanutEv, messageBrief } = await existingData(dataDir);
    // 简报里真的带着两句原话（不然这条用例没意义）
    expect(brief).toContain(PEANUT);
    expect(brief).toContain(CILANTRO);
    expect(messageBrief).toContain(PEANUT);

    const first = await startTestDaemon({ reuse: { dataDir, homeDir }, memoryPlugin: false, secretary: [{ kind: "reply", text: "好" }] });
    const { store } = first.daemon;
    const gone = `- ${peanutEv} · ${PURGED_TEXT}`;
    // 事件日志：调用记录的结果摘要、完整返回里被删的那句换掉了，香菜那句、简报结构、问题都在
    const record = store.read(CHANNELS.secretary, 0, EVENT_TYPES.message).find((e) => JSON.stringify(e.payload).includes('"callId":"call-ask"'))!;
    const part = (record.payload as MessageEventPayload).message.parts[0]!;
    expect(part).toMatchObject({ type: "tool_call", tool: "ask_memory", argsSummary: "question=我对什么过敏？", outcome: "done" });
    const summary = part.type === "tool_call" ? part.resultSummary! : "";
    const detail = store.read(TOOL_CALLS_CHANNEL).map((e) => e.payload as ToolCallDetail).find((d) => d.callId === "call-ask")!;
    for (const text of [summary, detail.result]) {
      expect(text).not.toContain(PEANUT);
      expect(text).toContain(gone);
      expect(text).toContain(CILANTRO);
      expect(text).toContain("【记录】");
    }
    expect(detail.args).toEqual({ question: "我对什么过敏？" });
    expect(JSON.stringify(store.readGlobal(0, 100_000))).not.toContain(PEANUT);
    // 秘书的会话上追加了 messages_purged（改写后的调用记录、被删的素材），内部频道记了一笔
    const purged = store.read(CHANNELS.secretary, 0, EVENT_TYPES.messagesPurged).map((e) => e.payload as MessagesPurgedEventPayload);
    expect(purged).toHaveLength(1);
    expect(purged[0]).toMatchObject({ materialIds: ["mat-peanut"], toolCallIds: [], mediaIds: [] });
    expect(purged[0]!.messages.map((m) => m.messageId)).toEqual([(record.payload as MessageEventPayload).message.id]);
    expect(store.read(INTERNAL_CHANNEL, 0, PURGE_BACKFILL_EVENT)).toHaveLength(1);
    // 秘书的会话文件：问记忆的结果也按编号换掉了（秘书起来时照 messages_purged 改写）
    await waitUntil(() => !sessionResult(dataDir).includes(PEANUT), { timeoutMs: 30_000, describe: () => "秘书会话文件里问记忆的结果改写" });
    expect(sessionResult(dataDir)).toContain(gone);
    expect(sessionResult(dataDir)).toContain(CILANTRO);
    // 每条消息的记忆简报（266 号票）也按编号换掉，香菜那句、简报的结构都在
    expect(sessionBrief(dataDir)).not.toContain(PEANUT);
    expect(sessionBrief(dataDir)).toBe(messageBrief.replace(`  · 支持 [${peanutEv}] 2026-05-01 · 本人说的：「${PEANUT}」`, gone));
    await first.daemon.stop();

    // 再起一次：记过了，不再跑（没有第二笔、第二条 messages_purged）
    const second = await startTestDaemon({ reuse: { dataDir, homeDir }, memoryPlugin: false });
    expect(second.daemon.store.read(INTERNAL_CHANNEL, 0, PURGE_BACKFILL_EVENT)).toHaveLength(1);
    expect(second.daemon.store.read(CHANNELS.secretary, 0, EVENT_TYPES.messagesPurged)).toHaveLength(1);
  }, 90_000);
});
