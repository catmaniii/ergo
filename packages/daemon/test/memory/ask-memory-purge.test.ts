// 265 号票：彻底删除素材时，ask_memory（问记忆）结果里带的原话也要从 agent 的会话文件里抹掉（263 号票交回的第 3 条）。
// 问记忆的结果按证据编号（ev-…）引原话、不带素材 id，所以检索素材那条"按素材 id 换行"的规矩抓不到它：
// - 被删素材背后的证据编号从推理库里找（purgedEvidenceIds）：还在库里的按出处（sourceRef 是素材 id），已经删掉的按彻底删除的审计；
// - 会话文件里 ask_memory 的结果，提到这些证据编号的行换成"- <证据编号> · 已删除"，这一条下面缩进的续行（原话、精炼）、
//   没合上的「」里的行一起换掉；编号按整段认（ev-1000 不会当成 ev-10000 的一部分）。
// 用临时目录里的真 rg.db、真 MemoryEngine（规则版、假向量）和真的简报正文（askMemoryTool 的输出），不调模型。
import fs from "node:fs";
import path from "node:path";
import { type EvidenceDraft, purgeEvidence } from "@ergo/memory";
import { EVENT_TYPES, type MessageEventPayload, type MessagesPurgedEventPayload, PURGED_TEXT, type ToolCallDetail } from "@ergo/protocol";
import { describe, expect, it, onTestFinished } from "vitest";
import { createCardService } from "../../src/cards/cards.ts";
import { CardTypeRegistry } from "../../src/cards/registry.ts";
import { cardsView } from "../../src/cards/views.ts";
import { appendMessage } from "../../src/conversation/messages.ts";
import { messagePurge } from "../../src/conversation/purge.ts";
import { conversationViews } from "../../src/conversation/views.ts";
import { openEventStore } from "../../src/events/event-store.ts";
import { recordToolCallDetail, TOOL_CALLS_CHANNEL, toolCallDetailPurge, toolCallDetailsView } from "../../src/guard-runtime/tool-call-details.ts";
import type { Material } from "../../src/materials/index.ts";
import { sessionRewriteFor } from "../../src/memory/after-purge.ts";
import { purgePlan } from "../../src/memory/purge.ts";
import { PurgeRewriters } from "../../src/memory/rewriters.ts";
import { askMemoryTool } from "../../src/memory/ask-tool.ts";
import { kernelEmbedderAdapter } from "../../src/memory/embedder-adapter.ts";
import { createMemoryEngineProvider } from "../../src/memory/engine-provider.ts";
import { purgedEvidenceIds } from "../../src/memory/purged-evidence.ts";
import { openReasoningDb } from "../../src/memory/rg-db.ts";
import { buildChildEnv } from "../../src/process/child-env.ts";
import { INPUT_CONTEXT_TYPE, runSessionRewrite } from "../../src/runtime/index.ts";
import type { SessionRewriteRequest } from "../../src/runtime/index.ts";
import { clockIso } from "../../src/scheduler/clock.ts";
import { ManualClock } from "../helpers/clock.ts";
import { FakeEmbedder } from "../helpers/embedder.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

/** 改写会话文件走守护进程那条路（拉起一次性子进程 rewrite-main），不越过 pi 的封装边界直接 import agent-child/ 里的模块 */
const rewriteViaChild = (req: SessionRewriteRequest) => runSessionRewrite(req, { env: buildChildEnv(process.env, {}) });

const NOW = new Date(2026, 9, 12, 12, 0);
const MODEL = "deepseek-flash";

const say = (sourceRef: string, text: string, at: string, context: string[] = []): EvidenceDraft => ({
  sourceLevel: "self",
  mode: "say",
  kind: "utterance",
  text,
  context,
  eventTime: at,
  observedAt: at,
  sourceRef,
});

/** 被删的那句（花生过敏）和留着的几句 */
const PEANUT = "我对花生过敏，吃了会起疹子";
const STORY: readonly EvidenceDraft[] = [
  say("mat-peanut", PEANUT, "2026-05-01T10:00:00+08:00"),
  say("mat-cilantro", "我不吃香菜，一吃就过敏", "2026-05-02T10:00:00+08:00"),
  say("mat-weekend-1", "这周六的饭局我就不去了", "2026-03-07T10:00:00+08:00", ["weekend", "social"]),
  say("mat-weekend-2", "我不喜欢周末被排得满满的", "2026-04-04T10:00:00+08:00", ["weekend"]),
];

function engineOptions(file: string, clock: ManualClock) {
  return { file, clock: () => clockIso(clock), model: MODEL, embedder: kernelEmbedderAdapter(new FakeEmbedder()) };
}

/** 临时目录里的 rg.db：灌证据、按规则版整理一遍、关掉 */
async function reasoningDb(): Promise<{ file: string; clock: ManualClock }> {
  const clock = new ManualClock(NOW);
  const file = path.join(makeTempDir("ergo-ask-purge-"), "db", "rg.db");
  const opened = openReasoningDb(engineOptions(file, clock));
  if (!opened.ok) throw new Error("应该能建库");
  for (const draft of STORY) opened.engine.ingestEvidence(draft);
  await opened.engine.reflect();
  opened.engine.close();
  return { file, clock };
}

/** 秘书调一次 ask_memory 拿到的正文（和插件里同一条路：懒打开的只读引擎） */
async function askMemory(file: string, clock: ManualClock, question: string): Promise<string> {
  const provider = createMemoryEngineProvider(engineOptions(file, clock));
  try {
    const output = await askMemoryTool(provider).run({ question }, { toolCallId: "call-ask" });
    expect(output.isError ?? false).toBe(false);
    return output.text;
  } finally {
    provider.close();
  }
}

/** 照记忆插件的 purge-rg 那样彻底删除素材：删证据和只靠它的事实，写审计（用户发起） */
function purgeMaterial(file: string, clock: ManualClock, materialId: string): void {
  const opened = openReasoningDb(engineOptions(file, clock));
  if (!opened.ok) throw new Error("应该能打开");
  try {
    const ids = opened.engine.store.listEvidence().filter((e) => e.sourceRef === materialId).map((e) => e.id);
    purgeEvidence(opened.engine, ids, { reason: "彻底删除素材", materialIds: [materialId], at: clockIso(clock), op: "purge", actor: "user" });
  } finally {
    opened.engine.close();
  }
}

const line = (entry: unknown) => JSON.stringify(entry);
const at = "2026-10-12T04:00:00.000Z";

/** 秘书的会话文件：用户问了一句，秘书调 ask_memory，工具结果是简报正文；另有一次检索素材的结果 */
function writeSession(dir: string, askText: string, searchText: string): string {
  const file = path.join(dir, `${at.replaceAll(":", "-")}_s1.jsonl`);
  const toolResult = (id: string, parentId: string, toolCallId: string, toolName: string, text: string) => ({
    type: "message",
    id,
    parentId,
    timestamp: at,
    message: { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError: false, timestamp: 0 },
  });
  fs.writeFileSync(
    file,
    [
      line({ type: "session", version: 3, id: "s1", timestamp: at, cwd: dir }),
      line({ type: "message", id: "m1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: "我对什么过敏来着？" }], timestamp: 0 } }),
      line({
        type: "message",
        id: "m2",
        parentId: "m1",
        timestamp: at,
        message: { role: "assistant", content: [{ type: "toolCall", id: "call-ask", name: "ask_memory", arguments: { question: "我对什么过敏？" } }], timestamp: 0 },
      }),
      line(toolResult("m3", "m2", "call-ask", "ask_memory", askText)),
      line(toolResult("m4", "m3", "call-search", "search_materials", searchText)),
      "",
    ].join("\n"),
  );
  return file;
}

const request = (dir: string, rewrite: Omit<SessionRewriteRequest, "sessionDir">): SessionRewriteRequest => ({ sessionDir: dir, ...rewrite });

const purgedEvent = (materialIds: string[]): MessagesPurgedEventPayload => ({ messages: [], materialIds, toolCallIds: [], mediaIds: [], deletedAt: at });

/** 会话文件里某个工具结果的正文 */
function toolResultText(file: string, toolName: string): string {
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    if (raw.trim() === "") continue;
    const entry = JSON.parse(raw) as { type: string; message?: { role: string; toolName?: string; content: Array<{ type: string; text?: string }> } };
    if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === toolName) return entry.message.content.map((c) => c.text ?? "").join("");
  }
  throw new Error(`会话文件里没有 ${toolName} 的结果`);
}

describe("被删素材背后的证据编号（265 号票）", () => {
  it("还在推理库里的按出处找（sourceRef 是素材 id）；推理库这边已经删掉的按彻底删除的审计找；别的素材的不算；库没建是空的", async () => {
    const { file, clock } = await reasoningDb();
    const opened = openReasoningDb({ ...engineOptions(file, clock), readOnly: true });
    if (!opened.ok) throw new Error("应该能打开");
    const peanut = opened.engine.store.listEvidence().filter((e) => e.sourceRef === "mat-peanut").map((e) => e.id);
    opened.engine.close();
    expect(peanut).toHaveLength(1);

    expect(purgedEvidenceIds(file, ["mat-peanut"])).toEqual(peanut);
    expect(purgedEvidenceIds(file, [])).toEqual([]);
    expect(purgedEvidenceIds(file, ["mat-unknown"])).toEqual([]);

    // 记忆插件跟着记忆命令把证据删了：按审计照样找得到
    purgeMaterial(file, clock, "mat-peanut");
    expect(purgedEvidenceIds(file, ["mat-peanut"])).toEqual(peanut);
    expect(purgedEvidenceIds(file, ["mat-peanut", "mat-cilantro"])).toHaveLength(2);

    expect(purgedEvidenceIds(path.join(makeTempDir("ergo-no-rg-"), "rg.db"), ["mat-peanut"])).toEqual([]);
  });
});

/** 假的查法：花生那条素材背后是 ev-0001 */
const peanutEvidence = (ids: readonly string[]) => (ids.includes("mat-peanut") ? ["ev-0001"] : []);

describe("彻底删除改写会话文件时 ask_memory 结果里的原话（265 号票）", () => {
  it("sessionRewriteFor 按被删素材找到证据编号，交给子进程一条 ask_memory 的规矩（连续行一起换）；没有证据就不带", async () => {
    const evidenceOf = peanutEvidence;
    expect(sessionRewriteFor([purgedEvent(["mat-peanut"])], { evidenceOf }).toolResultLines).toEqual([
      { toolName: "search_materials", needles: ["mat-peanut"] },
      { toolName: "ask_memory", needles: ["ev-0001"], continuation: true },
      // 272 号票：问记忆管理员的回答（它自己写的话）里证据编号、素材 id 都可能提
      { toolName: "ask_curator", needles: ["ev-0001", "mat-peanut"], continuation: true },
    ]);
    expect(sessionRewriteFor([purgedEvent(["mat-other"])], { evidenceOf }).toolResultLines).toEqual([
      { toolName: "search_materials", needles: ["mat-other"] },
      { toolName: "ask_curator", needles: ["mat-other"], continuation: true },
    ]);
    // 不给查法（老的装配）：检索素材那条，问记忆管理员只按素材 id
    expect(sessionRewriteFor([purgedEvent(["mat-peanut"])]).toolResultLines).toEqual([
      { toolName: "search_materials", needles: ["mat-peanut"] },
      { toolName: "ask_curator", needles: ["mat-peanut"], continuation: true },
    ]);
    expect(sessionRewriteFor([purgedEvent([])], { evidenceOf }).toolResultLines).toEqual([]);
  });

  it("会话文件里问记忆的结果：被删素材的原话（记录那一条连原话、精炼，结论下面引的那句）都换成删除标记，别的证据照旧；检索素材的结果照旧按素材 id 换", async () => {
    const { file, clock } = await reasoningDb();
    const askText = await askMemory(file, clock, "我对什么过敏？花生还是香菜？");
    // 简报里真的带着这句原话（不然这条用例没意义）
    expect(askText).toContain(PEANUT);
    expect(askText).toContain("我不吃香菜，一吃就过敏");
    const dir = makeTempDir("ergo-ask-purge-session-");
    const session = writeSession(dir, askText, ["找到 2 条：", `- mat-peanut · 2026-05-01 · ${PEANUT}`, "- mat-cilantro · 2026-05-02 · 我不吃香菜，一吃就过敏"].join("\n"));

    // 记忆插件先删了推理库里的证据（跟着记忆命令），之后 agent 闲下来才改写会话文件：编号按审计找
    purgeMaterial(file, clock, "mat-peanut");
    const rewrite = sessionRewriteFor([purgedEvent(["mat-peanut"])], { evidenceOf: (ids) => purgedEvidenceIds(file, ids) });
    const result = await rewriteViaChild(request(dir, rewrite));

    expect(result).toMatchObject({ files: 1 });
    const text = fs.readFileSync(session, "utf8");
    expect(text).not.toContain("花生");
    const ask = toolResultText(session, "ask_memory");
    const [peanutId] = rewrite.toolResultLines.find((r) => r.toolName === "ask_memory")!.needles;
    expect(ask).toContain(`- ${peanutId} · ${PURGED_TEXT}`);
    // 别的证据（香菜那句）和简报的结构都在
    expect(ask).toContain("我不吃香菜，一吃就过敏");
    expect(ask).toContain("【记录】");
    expect(toolResultText(session, "search_materials")).toBe(["找到 2 条：", `- mat-peanut · ${PURGED_TEXT}`, "- mat-cilantro · 2026-05-02 · 我不吃香菜，一吃就过敏"].join("\n"));
    // 再改一遍什么都不变（幂等）
    expect(await rewriteViaChild(request(dir, rewrite))).toEqual({ files: 0, entries: 0, summaries: 0 });
  });

  it("续行的认法：往下缩进、不是新一条的行（原话、精炼）和没合上的「」里的行（原话里本来就有换行）一起换；同级的下一条、往下缩进的新一条（· 支持……）、下一节不动；编号按整段认", async () => {
    const dir = makeTempDir("ergo-ask-purge-lines-");
    const askText = [
      "【记录】",
      "1. [ev-1000] 2026-05-01 · 本人说的",
      "   原话：「第一行说花生",
      "第二行还是花生」",
      "   精炼：用户对花生过敏",
      "2. [ev-10000] 2026-05-02 · 本人说的",
      "   原话：「香菜不吃」",
      "【对用户的理解】",
      "- [cl-0001] 偏好 · 用户说的 · 已验证 · 把握高：不吃香菜。支持 2 条、反对 0 条（已排除：[cl-0009] 爱吃花生（被 ev-1000 推翻））",
      "  · 支持 [ev-1000] 2026-05-01 · 本人说的：「花生那句」",
      "  · 支持 [ev-10000]（原话见记录）",
      "- 「注意饮食」，几种说得通的解释还没分出来：",
      "  · 可能是：[cl-0002] 需求 · 推断的 · 拿不准 · 把握低：注意饮食。支持 1 条；反对 1 条：ev-1000「花生那句」",
      "  · 可能是：[cl-0003] 需求 · 推断的 · 拿不准 · 把握低：口味挑。支持 1 条［ev-10000］；反对 0 条",
      "  能区分的问题：你是不是对好几样东西过敏？",
    ].join("\n");
    const session = writeSession(dir, askText, "（没有结果）");

    await rewriteViaChild(request(dir, sessionRewriteFor([purgedEvent(["mat-x"])], { evidenceOf: () => ["ev-1000"] })));

    const gone = `- ev-1000 · ${PURGED_TEXT}`;
    expect(toolResultText(session, "ask_memory")).toBe(
      [
        "【记录】",
        gone,
        "2. [ev-10000] 2026-05-02 · 本人说的",
        "   原话：「香菜不吃」",
        "【对用户的理解】",
        gone,
        gone,
        "  · 支持 [ev-10000]（原话见记录）",
        "- 「注意饮食」，几种说得通的解释还没分出来：",
        gone,
        "  · 可能是：[cl-0003] 需求 · 推断的 · 拿不准 · 把握低：口味挑。支持 1 条［ev-10000］；反对 0 条",
        "  能区分的问题：你是不是对好几样东西过敏？",
      ].join("\n"),
    );
  });
});

describe("彻底删除改写事件日志里问记忆的那次调用（265 号票）", () => {
  /** 一条被删的素材（原始事件不在了也照样找问记忆的调用） */
  const material = { id: "mat-peanut", kind: "user_utterance", ref: { event: { globalSeq: 999, channel: "secretary", seq: 999, type: EVENT_TYPES.message } } } as unknown as Material;

  it("263 号票以前的记录（没有调用记忆的部分）按证据编号找：结果摘要或完整返回里引着被删素材的证据编号的，记录和完整内容都改写、会话里列进 messages_purged；只引着前缀相同的别的编号的不动；不给查法时找不到", async () => {
    const root = makeTempDir("ergo-ask-purge-plan-");
    const store = openEventStore({ file: path.join(root, "ergo.db"), views: [...conversationViews, cardsView, toolCallDetailsView] });
    // 临时目录的删除钩子先登记、后跑：库在删目录之前关掉
    onTestFinished(() => store.close());
    const cards = createCardService({ store, registry: new CardTypeRegistry(), now: () => at });
    const rewriters = new PurgeRewriters();
    rewriters.register(messagePurge, toolCallDetailPurge);
    /** 秘书调了一次问记忆：聊天里的调用记录（263 号票以前的样子，没有 recall）和完整内容 */
    const ask = (callId: string, brief: string) => {
      const message = appendMessage(store, {
        conversation: "secretary",
        speaker: "agent",
        parts: [{ type: "tool_call", callId, tool: "ask_memory", argsSummary: "question=我对什么过敏？", categoryTitles: [], withinGrant: false, genericBash: false, outcome: "done", resultSummary: brief.slice(0, 40) }],
      });
      const detail: ToolCallDetail = { callId, agentId: "secretary", conversation: "secretary", tool: "ask_memory", args: { question: "我对什么过敏？" }, outcome: "done", endedAt: at, result: brief, isError: false };
      recordToolCallDetail(store, detail);
      return message.id;
    };
    // 结果摘要只有开头：被删的那条在后面，只有完整返回里有它的编号
    const old = ask("call-old", ["【明说过的要求和禁忌】", "- 禁忌：[cl-0002] 不吃香菜（用户说的）［ev-0002］", "【记录】", "1. [ev-1000] 2026-05-01 · 本人说的", `   原话：「${PEANUT}」`].join("\n"));
    const other = ask("call-other", ["【记录】", "1. [ev-10000] 2026-05-02 · 本人说的", "   原话：「我不吃香菜，一吃就过敏」"].join("\n"));

    const plan = purgePlan({ store, cards, rewriters, now: () => at, evidenceOf: (ids) => (ids.includes("mat-peanut") ? ["ev-1000"] : []) }, [material]);

    const purgedSeqs = new Set(plan.purge.map((p) => p.globalSeq));
    const eventsOf = (callId: string) =>
      store.readGlobal(0, 1000).filter((e) => (e.type === EVENT_TYPES.message && JSON.stringify(e.payload).includes(callId)) || (e.channel === TOOL_CALLS_CHANNEL && (e.payload as ToolCallDetail).callId === callId));
    expect(eventsOf("call-old")).toHaveLength(2);
    for (const event of eventsOf("call-old")) expect(purgedSeqs.has(event.globalSeq)).toBe(true);
    for (const event of eventsOf("call-other")) expect(purgedSeqs.has(event.globalSeq)).toBe(false);
    expect(JSON.stringify(plan.purge)).not.toContain(PEANUT);
    expect(JSON.stringify(plan.purge)).toContain(PURGED_TEXT);
    // 会话里的 messages_purged 列着那次调用的记录（秘书据此改写会话文件，再按证据编号换掉结果里的行）
    const purged = plan.events.find((e) => e.type === EVENT_TYPES.messagesPurged)!.payload as MessagesPurgedEventPayload;
    expect(purged.messages.map((m) => m.messageId)).toEqual([old]);
    expect(purged.messages.map((m) => m.messageId)).not.toContain(other);
    expect((purged.messages[0]!.replacement as MessageEventPayload["message"]).parts[0]).toMatchObject({ tool: "ask_memory", argsSummary: PURGED_TEXT, resultSummary: PURGED_TEXT });

    // 不给查法（老的装配）：没有调用记忆的部分的记录找不到
    expect(purgePlan({ store, cards, rewriters, now: () => at }, [material]).purge).toEqual([]);
  });
});

describe("秘书会话里只在会话文件里的原话（272 号票合 266）", () => {
  const material = { id: "mat-peanut", kind: "user_utterance", ref: { event: { globalSeq: 999, channel: "maintainer:pm-1", seq: 999, type: EVENT_TYPES.message } } } as unknown as Material;

  it("被删素材在推理库里有证据时，事件日志里秘书会话一条没改也追加一条 messages_purged（每条消息的记忆简报只在会话文件里引原话，秘书据此改）；没有证据不追加", () => {
    const root = makeTempDir("ergo-brief-purge-plan-");
    const store = openEventStore({ file: path.join(root, "ergo.db"), views: [...conversationViews, cardsView, toolCallDetailsView] });
    onTestFinished(() => store.close());
    const cards = createCardService({ store, registry: new CardTypeRegistry(), now: () => at });
    const rewriters = new PurgeRewriters();
    rewriters.register(messagePurge, toolCallDetailPurge);

    const plan = purgePlan({ store, cards, rewriters, now: () => at, evidenceOf: (ids) => (ids.includes("mat-peanut") ? ["ev-1000"] : []) }, [material]);
    expect(plan.purge).toEqual([]);
    const purged = plan.events.filter((e) => e.type === EVENT_TYPES.messagesPurged);
    expect(purged.map((e) => e.channel)).toEqual(["secretary"]);
    expect(purged[0]!.payload).toMatchObject({ messages: [], materialIds: ["mat-peanut"], toolCallIds: [], mediaIds: [] });

    expect(purgePlan({ store, cards, rewriters, now: () => at, evidenceOf: () => [] }, [material]).events).toEqual([]);
    expect(purgePlan({ store, cards, rewriters, now: () => at }, [material]).events).toEqual([]);
  });

  it("会话文件里的记忆简报：换过的行重跑时不再吃掉后面缩进更深的行（守护进程每次启动都按以前的 messages_purged 再改一遍）", async () => {
    const dir = makeTempDir("ergo-brief-rewrite-twice-");
    const file = path.join(dir, "2026-10-12T04-00-00-000Z_s1.jsonl");
    const block = [
      "【记忆简报】和用户这句话相关的记忆",
      "【对用户的理解】",
      "- 「注意饮食」，几种说得通的解释还没分出来：",
      "  · 可能是：[cl-0002] 需求 · 推断的 · 拿不准 · 把握低：注意饮食。支持 1 条［ev-1001］；反对 1 条：ev-1000「我对花生过敏」",
      "  能区分的问题：你是不是对好几样东西过敏？",
    ].join("\n");
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: at, cwd: dir }),
        JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: "晚饭吃什么" }], timestamp: 0 } }),
        JSON.stringify({ type: "custom_message", id: "c1", parentId: "m1", timestamp: at, customType: INPUT_CONTEXT_TYPE, content: block, display: false }),
        "",
      ].join("\n"),
    );
    const rewrite = sessionRewriteFor([{ messages: [], materialIds: ["mat-peanut"], toolCallIds: [], mediaIds: [], deletedAt: at }], { evidenceOf: () => ["ev-1000"] });
    expect(await rewriteViaChild({ sessionDir: dir, ...rewrite })).toEqual({ files: 1, entries: 1, summaries: 0 });
    const contextOf = () => (fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as { type: string; content?: string }).find((e) => e.type === "custom_message")!.content!);
    const once = contextOf();
    expect(once).not.toContain("我对花生过敏");
    expect(once).toContain(`- ev-1000 · ${PURGED_TEXT}`);
    expect(once).toContain("  能区分的问题：你是不是对好几样东西过敏？");
    expect(await rewriteViaChild({ sessionDir: dir, ...rewrite })).toEqual({ files: 0, entries: 0, summaries: 0 });
    expect(contextOf()).toBe(once);
  });

  it("已经换过的问记忆结果照样算被改的条目：覆盖它的压缩摘要（换过以后才压缩的）重跑时也换掉，和简报块一个规矩", async () => {
    const dir = makeTempDir("ergo-ask-rewrite-covered-");
    const file = path.join(dir, "2026-10-12T04-00-00-000Z_s1.jsonl");
    const result = ["【记录】", `- ev-1000 · ${PURGED_TEXT}`, "2. [ev-1001] 2026-05-02 · 本人说的", "   原话：「我不吃香菜」"].join("\n");
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: at, cwd: dir }),
        JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: at, message: { role: "toolResult", toolCallId: "call-ask", toolName: "ask_memory", content: [{ type: "text", text: result }], isError: false, timestamp: 0 } }),
        JSON.stringify({ type: "message", id: "m2", parentId: "m1", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: "好的" }], timestamp: 0 } }),
        JSON.stringify({ type: "compaction", id: "k1", parentId: "m2", timestamp: at, summary: "用户对花生过敏", firstKeptEntryId: "m2", tokensBefore: 100 }),
        "",
      ].join("\n"),
    );
    const rewrite = sessionRewriteFor([{ messages: [], materialIds: ["mat-peanut"], toolCallIds: [], mediaIds: [], deletedAt: at }], { evidenceOf: () => ["ev-1000"] });
    expect(await rewriteViaChild({ sessionDir: dir, ...rewrite })).toEqual({ files: 1, entries: 0, summaries: 1 });
    expect(fs.readFileSync(file, "utf8")).toContain("原话：「我不吃香菜」");
  });
});

describe("问记忆管理员（ask_curator）的回答也照问记忆那套抹（272 号票）", () => {
  const material = { id: "mat-peanut", kind: "user_utterance", ref: { event: { globalSeq: 999, channel: "secretary", seq: 999, type: EVENT_TYPES.message } } } as unknown as Material;

  it("彻底删除时：回答里引着被删素材证据编号、或者提到它素材 id 的那次调用，记录和完整内容照彻底删除的口径改写、会话里列进 messages_purged；只引着前缀相同的别的编号的不动", async () => {
    const root = makeTempDir("ergo-curator-purge-plan-");
    const store = openEventStore({ file: path.join(root, "ergo.db"), views: [...conversationViews, cardsView, toolCallDetailsView] });
    onTestFinished(() => store.close());
    const cards = createCardService({ store, registry: new CardTypeRegistry(), now: () => at });
    const rewriters = new PurgeRewriters();
    rewriters.register(messagePurge, toolCallDetailPurge);
    const curator = (callId: string, answer: string) => {
      const message = appendMessage(store, {
        conversation: "secretary",
        speaker: "agent",
        parts: [{ type: "tool_call", callId, tool: "ask_curator", argsSummary: "question=为什么说我饮食讲究？", categoryTitles: [], withinGrant: false, genericBash: false, outcome: "done", resultSummary: answer.slice(0, 30) }],
      });
      recordToolCallDetail(store, { callId, agentId: "secretary", conversation: "secretary", tool: "ask_curator", args: { question: "为什么说我饮食讲究？" }, outcome: "done", endedAt: at, result: answer, isError: false });
      return message.id;
    };
    // 摘要只有开头，编号在后面：按完整返回找到
    const byEvidence = curator("call-ev", ["记忆管理员说：", "我去看了一下，那条是从这几句推出来的：", `- ev-1000「${PEANUT}」`].join("\n"));
    const byMaterial = curator("call-mat", ["记忆管理员说：", "你要忘掉的是 mat-peanut 那一句，我先记下了。"].join("\n"));
    const other = curator("call-other", ["记忆管理员说：", "- ev-10000「我不吃香菜，一吃就过敏」"].join("\n"));

    const plan = purgePlan({ store, cards, rewriters, now: () => at, evidenceOf: (ids) => (ids.includes("mat-peanut") ? ["ev-1000"] : []) }, [material]);

    const purgedSeqs = new Set(plan.purge.map((p) => p.globalSeq));
    const eventsOf = (callId: string) =>
      store.readGlobal(0, 1000).filter((e) => (e.type === EVENT_TYPES.message && JSON.stringify(e.payload).includes(callId)) || (e.channel === TOOL_CALLS_CHANNEL && (e.payload as ToolCallDetail).callId === callId));
    for (const callId of ["call-ev", "call-mat"]) {
      expect(eventsOf(callId)).toHaveLength(2);
      for (const event of eventsOf(callId)) expect(purgedSeqs.has(event.globalSeq)).toBe(true);
    }
    for (const event of eventsOf("call-other")) expect(purgedSeqs.has(event.globalSeq)).toBe(false);
    expect(JSON.stringify(plan.purge)).not.toContain(PEANUT);
    const purged = plan.events.find((e) => e.type === EVENT_TYPES.messagesPurged)!.payload as MessagesPurgedEventPayload;
    expect(purged.messages.map((m) => m.messageId).toSorted()).toEqual([byEvidence, byMaterial].toSorted());
    expect(purged.messages.map((m) => m.messageId)).not.toContain(other);
  });

  it("会话文件里问记忆管理员的结果：提到被删证据编号、素材 id 的行连同续行换成删除标记，别的照旧", async () => {
    const dir = makeTempDir("ergo-curator-purge-session-");
    const answer = ["记忆管理员说：", "那条是从这两句推出来的：", `- ev-1000「${PEANUT}`, "第二行」", "- ev-10000「我不吃香菜，一吃就过敏」", "要忘掉 mat-peanut 那句就跟我说。"].join("\n");
    const session = writeSession(dir, "（没有结果）", "（没有结果）");
    // 秘书问的是管理员：把会话文件里的那条工具结果换成 ask_curator 的
    fs.writeFileSync(session, fs.readFileSync(session, "utf8").replace('"toolName":"search_materials","content":[{"type":"text","text":"（没有结果）"}]', `"toolName":"ask_curator","content":[{"type":"text","text":${JSON.stringify(answer)}}]`));

    await rewriteViaChild(request(dir, sessionRewriteFor([purgedEvent(["mat-peanut"])], { evidenceOf: () => ["ev-1000"] })));

    expect(toolResultText(session, "ask_curator")).toBe(
      ["记忆管理员说：", "那条是从这两句推出来的：", `- ev-1000 · ${PURGED_TEXT}`, "- ev-10000「我不吃香菜，一吃就过敏」", `- mat-peanut · ${PURGED_TEXT}`].join("\n"),
    );
  });
});
