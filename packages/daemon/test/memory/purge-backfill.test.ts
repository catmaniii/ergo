// 272 号票第 1 条：一次性补抹。265 号票以前（10-21 有问记忆以来）做过的彻底删除，事件日志里问记忆（ask_memory）那几次调用的
// 记录和完整内容还留着被删素材的原话（purgePlan 只在删的那一刻算一次）。守护进程启动时跑一次：
// - 按已登记的彻底删除（素材频道上 command 为 purge 的记忆命令）找被删素材背后的证据编号（还在推理库里的按出处、删掉的按审计）；
// - 问记忆、问记忆管理员（ask_curator，272 号票第 3 条）的调用记录（结果摘要）和完整内容（完整返回）里，只把提到这些编号
//   （问记忆管理员另看素材 id）的行连同续行换成"- 编号 · 删除标记"，别的一个字不动（保守：碰的是用户真实的事件日志）；
// - 秘书的会话上追加一条 messages_purged（改写过的调用记录给出改写后的样子、列上被删的素材）：开着的页面换掉手里的，
//   秘书据此把会话文件里问记忆的结果也按编号换一遍；
// - 做完在内部频道记一笔（幂等键），以后不再跑；推理库查不了时不记、下次启动再补。
// 用临时目录里的真 rg.db、真简报（askMemoryTool 的输出）、真事件存储，不碰 ~/.ergo、不调模型。
import path from "node:path";
import { type EvidenceDraft, purgeEvidence } from "@ergo/memory";
import { CHANNELS, EVENT_TYPES, type MessageEventPayload, type MessagesPurgedEventPayload, PURGED_TEXT, type ToolCallDetail } from "@ergo/protocol";
import { describe, expect, it, onTestFinished } from "vitest";
import { appendMessage } from "../../src/conversation/messages.ts";
import { conversationViews, listMessages } from "../../src/conversation/views.ts";
import { type EventStore, openEventStore, type StoredEvent } from "../../src/events/event-store.ts";
import { recordToolCallDetail, TOOL_CALLS_CHANNEL, toolCallDetailsView } from "../../src/guard-runtime/tool-call-details.ts";
import { askMemoryTool } from "../../src/memory/ask-tool.ts";
import { memoryCommandEvent } from "../../src/memory/deletion.ts";
import { kernelEmbedderAdapter } from "../../src/memory/embedder-adapter.ts";
import { createMemoryEngineProvider } from "../../src/memory/engine-provider.ts";
import { backfillPurgedQuotes, PURGE_BACKFILL_EVENT, PURGE_BACKFILL_KEY } from "../../src/memory/purge-backfill.ts";
import { lookupPurgedEvidence } from "../../src/memory/purged-evidence.ts";
import { openReasoningDb } from "../../src/memory/rg-db.ts";
import { INTERNAL_CHANNEL } from "../../src/scheduler/internal-jobs.ts";
import { clockIso } from "../../src/scheduler/clock.ts";
import { ManualClock } from "../helpers/clock.ts";
import { FakeEmbedder } from "../helpers/embedder.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const NOW = new Date(2026, 9, 12, 12, 0);
const MODEL = "deepseek-flash";
const at = "2026-10-22T04:00:00.000Z";

const say = (sourceRef: string, text: string, when: string, context: string[] = []): EvidenceDraft => ({
  sourceLevel: "self",
  mode: "say",
  kind: "utterance",
  text,
  context,
  eventTime: when,
  observedAt: when,
  sourceRef,
});

const PEANUT = "我对花生过敏，吃了会起疹子";
const CILANTRO = "我不吃香菜，一吃就过敏";
const STORY: readonly EvidenceDraft[] = [
  say("mat-peanut", PEANUT, "2026-05-01T10:00:00+08:00"),
  say("mat-cilantro", CILANTRO, "2026-05-02T10:00:00+08:00"),
  say("mat-weekend-1", "这周六的饭局我就不去了", "2026-03-07T10:00:00+08:00", ["weekend", "social"]),
  say("mat-weekend-2", "我不喜欢周末被排得满满的", "2026-04-04T10:00:00+08:00", ["weekend"]),
];

const engineOptions = (file: string, clock: ManualClock) => ({ file, clock: () => clockIso(clock), model: MODEL, embedder: kernelEmbedderAdapter(new FakeEmbedder()) });

async function reasoningDb(): Promise<{ file: string; clock: ManualClock }> {
  const clock = new ManualClock(NOW);
  const file = path.join(makeTempDir("ergo-backfill-rg-"), "db", "rg.db");
  const opened = openReasoningDb(engineOptions(file, clock));
  if (!opened.ok) throw new Error("应该能建库");
  for (const draft of STORY) opened.engine.ingestEvidence(draft);
  await opened.engine.reflect();
  opened.engine.close();
  return { file, clock };
}

async function askMemory(file: string, clock: ManualClock, question: string): Promise<string> {
  const provider = createMemoryEngineProvider(engineOptions(file, clock));
  try {
    return (await askMemoryTool(provider).run({ question }, { toolCallId: "call-ask" })).text;
  } finally {
    provider.close();
  }
}

/** 照记忆插件的 purge-rg 那样彻底删除：删证据、写审计 */
function purgeInRg(file: string, clock: ManualClock, materialId: string): string[] {
  const opened = openReasoningDb(engineOptions(file, clock));
  if (!opened.ok) throw new Error("应该能打开");
  try {
    const ids = opened.engine.store.listEvidence().filter((e) => e.sourceRef === materialId).map((e) => e.id);
    purgeEvidence(opened.engine, ids, { reason: "彻底删除素材", materialIds: [materialId], at: clockIso(clock), op: "purge", actor: "user" });
    return ids;
  } finally {
    opened.engine.close();
  }
}

function eventStore(): EventStore {
  const store = openEventStore({ file: path.join(makeTempDir("ergo-backfill-log-"), "ergo.db"), views: [...conversationViews, toolCallDetailsView] });
  onTestFinished(() => store.close());
  return store;
}

/** 秘书调了一次工具：聊天里的调用记录（结果摘要是开头）和完整内容 */
function toolCall(store: EventStore, callId: string, tool: string, result: string, args: Record<string, unknown> = { question: "我对什么过敏？" }) {
  const message = appendMessage(store, {
    conversation: CHANNELS.secretary,
    speaker: "agent",
    parts: [{ type: "tool_call", callId, tool, argsSummary: "question=我对什么过敏？", categoryTitles: [], withinGrant: false, genericBash: false, outcome: "done", resultSummary: result.slice(0, 4000) }],
  });
  const detail: ToolCallDetail = { callId, agentId: "secretary", conversation: CHANNELS.secretary, tool, args, outcome: "done", endedAt: at, result, isError: false };
  recordToolCallDetail(store, detail);
  return message.id;
}

/** 265 号票以前的彻底删除：只记了记忆命令（问记忆的记录没改写） */
const purgeCommand = (store: EventStore, materialIds: string[]) => store.append(memoryCommandEvent({ command: "purge", materialIds, from: { kind: "settings", scope: { kind: "conversation", conversation: CHANNELS.secretary } } }));

const recordOf = (store: EventStore, callId: string): StoredEvent =>
  store.read(CHANNELS.secretary, 0, EVENT_TYPES.message).find((e) => JSON.stringify(e.payload).includes(`"callId":"${callId}"`))!;
const summaryOf = (store: EventStore, callId: string): string => {
  const part = (recordOf(store, callId).payload as MessageEventPayload).message.parts[0]!;
  return part.type === "tool_call" ? (part.resultSummary ?? "") : "";
};
const detailOf = (store: EventStore, callId: string): ToolCallDetail => store.read(TOOL_CALLS_CHANNEL).map((e) => e.payload as ToolCallDetail).find((d) => d.callId === callId)!;

describe("一次性补抹 265 号票以前漏抹的问记忆原话（272 号票）", () => {
  it("只把引着被删素材证据编号的行（连同原话、精炼这些续行）换成删除标记；别的证据、简报结构、问题、没引它的调用、早就整条换掉的都不动；秘书的会话上追加 messages_purged；记一笔，再跑不重复", async () => {
    const { file, clock } = await reasoningDb();
    const brief = await askMemory(file, clock, "我对什么过敏？花生还是香菜？");
    // 简报里真的带着这两句原话（不然这条用例没意义）
    expect(brief).toContain(PEANUT);
    expect(brief).toContain(CILANTRO);
    const store = eventStore();
    const askId = toolCall(store, "call-ask", "ask_memory", brief);
    // 管理员的回答按它的提示词引证据编号（272 号票起 inspect_memory 把编号和原话写在一起）；它也可能提素材 id
    const opened = openReasoningDb({ ...engineOptions(file, clock), readOnly: true });
    if (!opened.ok) throw new Error("应该能打开");
    const peanutEv = opened.engine.store.listEvidence().find((e) => e.sourceRef === "mat-peanut")!.id;
    const cilantroEv = opened.engine.store.listEvidence().find((e) => e.sourceRef === "mat-cilantro")!.id;
    opened.engine.close();
    const curator = ["记忆管理员说：", "我去看了一下，那条是从这两句推出来的：", `- ${peanutEv}「${PEANUT}」`, `- ${cilantroEv}「${CILANTRO}」`, "素材 mat-peanut 那句你要的话可以忘掉。"].join("\n");
    toolCall(store, "call-curator", "ask_curator", curator, { question: "为什么说我饮食讲究？" });
    // 没引被删素材的问记忆：不动
    const other = ["【记录】", `1. [${cilantroEv}] 2026-05-02 · 本人说的`, `   原话：「${CILANTRO}」`].join("\n");
    toolCall(store, "call-other", "ask_memory", other);
    // 265 号票起的彻底删除已经整条换掉的：不动（再换也一样）
    toolCall(store, "call-done", "ask_memory", PURGED_TEXT);

    purgeCommand(store, ["mat-peanut"]);
    expect(purgeInRg(file, clock, "mat-peanut")).toEqual([peanutEv]);
    const before = store.lastGlobalSeq();

    const result = backfillPurgedQuotes({ store, evidenceOf: (ids) => lookupPurgedEvidence(file, ids), now: () => at, log: () => {} });

    expect(result).toMatchObject({ state: "done", records: 2, details: 2 });
    // 整个事件日志里没有被删的那句了；香菜那句、简报的结构、问题都在
    const log = JSON.stringify(store.readGlobal(0, 10_000));
    expect(log).not.toContain(PEANUT);
    expect(log).toContain(CILANTRO);
    const gone = `- ${peanutEv} · ${PURGED_TEXT}`;
    expect(detailOf(store, "call-ask").result).toContain(gone);
    expect(detailOf(store, "call-ask").result).toContain("【记录】");
    expect(detailOf(store, "call-ask").args).toEqual({ question: "我对什么过敏？" });
    expect(detailOf(store, "call-ask").purged).toBeUndefined();
    expect(detailOf(store, "call-curator").result).toBe(["记忆管理员说：", "我去看了一下，那条是从这两句推出来的：", gone, `- ${cilantroEv}「${CILANTRO}」`, `- mat-peanut · ${PURGED_TEXT}`].join("\n"));
    expect(detailOf(store, "call-other").result).toBe(other);
    expect(detailOf(store, "call-done").result).toBe(PURGED_TEXT);
    // 调用记录：只换结果摘要里的那几行，参数摘要、工具、结局照旧
    const askPart = (recordOf(store, "call-ask").payload as MessageEventPayload).message.parts[0]!;
    expect(askPart).toMatchObject({ type: "tool_call", tool: "ask_memory", argsSummary: "question=我对什么过敏？", outcome: "done" });
    expect(summaryOf(store, "call-other")).toBe(other);
    // 派生视图跟着改写后的日志重建：聊天历史里拿到的也是改写后的
    expect(JSON.stringify(listMessages(store.reader, CHANNELS.secretary))).not.toContain(PEANUT);

    // 秘书的会话上追加了一条 messages_purged：改写过的调用记录给出改写后的样子，列上被删的素材（秘书据此改会话文件）
    const appended = store.readGlobal(before, 100);
    const purged = appended.filter((e) => e.type === EVENT_TYPES.messagesPurged);
    expect(purged.map((e) => e.channel)).toEqual([CHANNELS.secretary]);
    const payload = purged[0]!.payload as MessagesPurgedEventPayload;
    expect(payload.materialIds).toEqual(["mat-peanut"]);
    expect(payload.toolCallIds).toEqual([]);
    expect(payload.messages.map((m) => m.messageId)).toContain(askId);
    expect(JSON.stringify(payload)).not.toContain(PEANUT);
    // 记了一笔（内部频道，幂等键），写着改了哪几次调用
    const marks = store.read(INTERNAL_CHANNEL, 0, PURGE_BACKFILL_EVENT);
    expect(marks).toHaveLength(1);
    expect(store.eventByIdempotencyKey(PURGE_BACKFILL_KEY)?.globalSeq).toBe(marks[0]!.globalSeq);
    expect(marks[0]!.payload).toMatchObject({ calls: ["call-ask", "call-curator"] });

    // 再跑（下次启动）：记过了，什么都不做
    const seq = store.lastGlobalSeq();
    expect(backfillPurgedQuotes({ store, evidenceOf: (ids) => lookupPurgedEvidence(file, ids), now: () => at, log: () => {} })).toMatchObject({ state: "already" });
    expect(store.lastGlobalSeq()).toBe(seq);
  });

  it("推理库查不了（打不开、版本对不上）：这次不补、不记，下次启动再补；推理库没建、没登记过彻底删除：没有要补的，记一笔就完", async () => {
    const { file, clock } = await reasoningDb();
    const brief = await askMemory(file, clock, "我对什么过敏？花生还是香菜？");
    const store = eventStore();
    toolCall(store, "call-ask", "ask_memory", brief);
    purgeCommand(store, ["mat-peanut"]);
    purgeInRg(file, clock, "mat-peanut");
    const lines: string[] = [];

    expect(backfillPurgedQuotes({ store, evidenceOf: () => undefined, now: () => at, log: (l) => lines.push(l) })).toMatchObject({ state: "deferred" });
    expect(store.read(INTERNAL_CHANNEL, 0, PURGE_BACKFILL_EVENT)).toEqual([]);
    expect(detailOf(store, "call-ask").result).toContain(PEANUT);
    expect(lines.join("\n")).toContain("下次启动");

    expect(backfillPurgedQuotes({ store, evidenceOf: (ids) => lookupPurgedEvidence(file, ids), now: () => at, log: () => {} })).toMatchObject({ state: "done", records: 1, details: 1 });
    expect(detailOf(store, "call-ask").result).not.toContain(PEANUT);

    // 没登记过彻底删除（新装的、从没删过）：没有要补的，照样记一笔
    const fresh = eventStore();
    toolCall(fresh, "call-ask", "ask_memory", brief);
    expect(backfillPurgedQuotes({ store: fresh, evidenceOf: () => undefined, now: () => at, log: () => {} })).toMatchObject({ state: "done", records: 0, details: 0 });
    expect(fresh.read(INTERNAL_CHANNEL, 0, PURGE_BACKFILL_EVENT)).toHaveLength(1);
    expect(fresh.ofType(EVENT_TYPES.messagesPurged)).toEqual([]);
    // 推理库没建：查了、没有
    expect(lookupPurgedEvidence(path.join(makeTempDir("ergo-no-rg-"), "rg.db"), ["mat-peanut"])).toEqual([]);
  });
});
