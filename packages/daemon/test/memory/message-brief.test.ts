// 266 号票：每条消息的记忆简报（memory/message-brief.ts）。用临时目录里的真 SQLite、真 MemoryEngine（规则版抽取和推理、假向量）、
// 真事件存储，不调模型；整条路径（装配、秘书真收到、回话里那一行）由主切面 test/main/memory-message-brief.test.ts 走。
// 彻底删除时会话文件里简报引的原话一起抹掉（照 265 号票问记忆的规矩：按证据编号换行，连同续行）。
// 例子是 196 号票测试的那个人（自己写的，不看 @ergo/memory 的 fixtures/truth）。
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, EVENT_TYPES, type MemoryBriefInput, type MemoryBriefResult, type MessageEnvelope, type MessagePart, PURGED_SUMMARY_TEXT, PURGED_TEXT } from "@ergo/protocol";
import type { EvidenceDraft, MemoryEngine } from "@ergo/memory";
import { describe, expect, it, onTestFinished } from "vitest";
import { conversationMessagesView } from "../../src/conversation/views.ts";
import { openEventStore, type EventStore } from "../../src/events/event-store.ts";
import type { Materials } from "../../src/materials/index.ts";
import { sessionRewriteFor } from "../../src/memory/after-purge.ts";
import { kernelEmbedderAdapter } from "../../src/memory/embedder-adapter.ts";
import { createMemoryEngineProvider } from "../../src/memory/engine-provider.ts";
import { createMessageBriefs, isShortReply, MESSAGE_BRIEF_HEAD, type MessageBriefs, type MessageBriefsOptions, queryMemoEmbedder } from "../../src/memory/message-brief.ts";
import { openReasoningDb } from "../../src/memory/rg-db.ts";
import { buildChildEnv } from "../../src/process/child-env.ts";
import { INPUT_CONTEXT_TYPE, runSessionRewrite, type SessionRewriteRequest } from "../../src/runtime/index.ts";
import { clockIso } from "../../src/scheduler/clock.ts";
import { ManualClock } from "../helpers/clock.ts";
import { FakeEmbedder } from "../helpers/embedder.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const NOW = new Date(2026, 9, 12, 12, 0);

/** 改写会话文件走守护进程那条路（拉起一次性子进程 rewrite-main），不越过 pi 的封装边界直接 import agent-child/ 里的模块 */
const rewriteViaChild = (req: SessionRewriteRequest) => runSessionRewrite(req, { env: buildChildEnv(process.env, {}) });
const { secretary: SECRETARY } = CHANNELS;

const say = (id: string, text: string, at: string, over: Partial<EvidenceDraft> = {}): EvidenceDraft => ({
  id,
  sourceLevel: "self",
  mode: "say",
  kind: "utterance",
  text,
  context: [],
  eventTime: at,
  observedAt: at,
  sourceRef: `mat-${id}`,
  ...over,
});
const WEEKEND = { context: ["weekend", "social"] };
const WORKDAY = { context: ["workday", "work"] };
const STORY: readonly EvidenceDraft[] = [
  say("ev-w1", "这周六的饭局我就不去了", "2026-03-07T10:00:00+08:00", WEEKEND),
  say("ev-w2", "周日的剧本杀我推掉了", "2026-03-15T10:00:00+08:00", WEEKEND),
  say("ev-w4", "周六的生日会我也没去", "2026-03-21T10:00:00+08:00", WEEKEND),
  say("ev-w3", "我不喜欢周末被排得满满的", "2026-04-04T10:00:00+08:00", { context: ["weekend"] }),
  say("ev-d1", "周二的分享会我推掉了", "2026-10-06T10:00:00+08:00", WORKDAY),
  say("ev-d2", "拒绝了周四的临时会议", "2026-10-08T10:00:00+08:00", WORKDAY),
  say("ev-d3", "工作日我也不喜欢被提前排满", "2026-10-09T10:00:00+08:00", { context: ["workday"] }),
  say("ev-a1", "我不吃香菜，一吃就过敏", "2026-05-01T10:00:00+08:00"),
];

const TALK = "这周六同事又约我去团建，周末被排得满满的好烦";

/** 向量模型"不在"的假向量函数（见下面 reasoning 的说明） */
const vectors = () => kernelEmbedderAdapter(new FakeEmbedder({ available: false }));

/**
 * 临时目录里的 rg.db（灌证据、规则版整理一遍）和读它的只读引擎（和插件里一样懒打开、缓存）。
 * 假向量只有几个概念组、别的字散列到几维上，余弦没有意义（随便一句话都可能过向量门槛）：这里让向量模型"不在"，
 * 相关门槛只按话题词认（真的 bge-m3 的两道向量门槛由 @ergo/memory 的测试管）
 */
async function reasoning(): Promise<{ engine: () => MemoryEngine | undefined }> {
  const clock = new ManualClock(NOW);
  const file = path.join(makeTempDir("ergo-message-brief-"), "db", "rg.db");
  const opened = openReasoningDb({ file, clock: () => clockIso(clock), model: "deepseek-flash", embedder: vectors() });
  if (!opened.ok) throw new Error("应该能建库");
  for (const draft of STORY) opened.engine.ingestEvidence(draft);
  await opened.engine.reflect();
  await opened.engine.indexVectors();
  opened.engine.close();
  const provider = createMemoryEngineProvider({ file, clock: () => clockIso(clock), model: "deepseek-flash", embedder: vectors() });
  onTestFinished(() => provider.close());
  return { engine: () => provider.get() };
}

function eventStore(): EventStore {
  const store = openEventStore({ file: path.join(makeTempDir("ergo-message-brief-store-"), "ergo.db"), views: [conversationMessagesView] });
  onTestFinished(() => store.close());
  return store;
}

/** 素材库里只有 mat-ev-…（简报引的证据背后的素材） */
const materials = {
  get: (id: string) => (id.startsWith("mat-ev-") ? ({ id, kind: "user_utterance", time: "2026-10-09T10:00:00.000+08:00", conversation: "secretary" } as never) : undefined),
} as unknown as Pick<Materials, "get">;

let seq = 0;
function userMessage(store: EventStore, text: string): MessageEnvelope {
  seq += 1;
  const message: MessageEnvelope = { id: `m-user-${seq}`, conversation: SECRETARY, speaker: "user", time: clockIso(new ManualClock(NOW)), parts: [{ type: "text", text }] };
  store.append({ channel: SECRETARY, type: EVENT_TYPES.message, payload: { message } });
  return message;
}

/** 秘书这一轮的回话（带上会话交过来的 part，和 agent 会话做的一样） */
function agentReply(store: EventStore, parts: readonly MessagePart[]): void {
  seq += 1;
  const message: MessageEnvelope = { id: `m-agent-${seq}`, conversation: SECRETARY, speaker: "agent", time: clockIso(new ManualClock(NOW)), parts: [...parts, { type: "text", text: "好的" }] };
  store.append({ channel: SECRETARY, type: EVENT_TYPES.message, payload: { message } });
}

function briefs(options: Partial<MessageBriefsOptions> & Pick<MessageBriefsOptions, "engine"> & { store: EventStore }): { briefs: MessageBriefs; logs: string[]; usage: unknown[] } {
  const logs: string[] = [];
  const usage: unknown[] = [];
  const made = createMessageBriefs({ materials, enabled: () => true, record: (u) => usage.push(u), log: (line) => logs.push(line), ...options });
  // 和插件里一样跟着事件日志（ctx.effect 订的）
  const off = options.store.onAppend((event) => made.onEvent(event));
  onTestFinished(off);
  return { briefs: made, logs, usage };
}

const TARGET = { agentId: "secretary" };

/** 说一句：交回这一轮的上下文块和回话要带的 part，并把回话追加进会话（像 agent 会话做的那样） */
async function turn(store: EventStore, b: MessageBriefs, text: string) {
  const message = userMessage(store, text);
  const block = await b.inputText(message, TARGET);
  const parts = b.replyParts(message) ?? [];
  agentReply(store, parts);
  return { block, parts };
}

describe("短应答", () => {
  it("好的、谢谢、嗯这类短应答算；带了正事的、说到别的事的不算", () => {
    const short = ["好的", "谢谢", "嗯", "嗯嗯", "好的谢谢！", "OK", "收到。", "👍", "行吧", "知道了", "  ", "哈哈哈", "可以啊。", "好嘞", "嗯呢"];
    const real = ["好的，帮我订周六的餐厅", "周末又被排满了", "谢谢你上次帮我改的方案，再改一版", "不去", "播放吧", "回我语音吧"];
    expect(short.filter((text) => !isShortReply(text))).toEqual([]);
    expect(real.filter((text) => isShortReply(text))).toEqual([]);
  });
});

describe("每条消息的记忆简报", () => {
  it("相关时带一块【记忆简报】（结论连原话），回话带上一份结构化的部分进\"回忆了 N 条记忆\"（为什么带、引到的素材）；记一笔用量", async () => {
    const store = eventStore();
    const { briefs: b, usage } = briefs({ ...(await reasoning()), store });
    const { block, parts } = await turn(store, b, TALK);
    expect(block).toBeDefined();
    expect(block!.startsWith(MESSAGE_BRIEF_HEAD)).toBe(true);
    expect(block).toContain("【对用户的理解】");
    expect(block).toContain("「我不喜欢周末被排得满满的」");
    expect(block).not.toContain("【记录】");
    const [part] = parts;
    expect(part).toMatchObject({ type: "memory_brief", recall: { source: "brief" } });
    if (part?.type !== "memory_brief") throw new Error("应该有记忆简报的 part");
    // 命中：简报里引的证据背后的素材（素材库里有的），没有原话、没有这句话的文字
    expect(part.recall.hits.length).toBeGreaterThan(0);
    expect(part.recall.hits.map((h) => h.materialId)).toContain("mat-ev-w3");
    expect(part.recall).not.toHaveProperty("query");
    expect(JSON.stringify(part)).not.toContain("排得满满");
    // 为什么带：直接说到这件事的结论、明说的禁忌
    expect(part.items.some((i) => i.reason === "direct" && i.claimIds.length > 0)).toBe(true);
    expect(part.items.some((i) => i.reason === "hard")).toBe(true);
    expect(part.tokens).toBeGreaterThan(0);
    expect(part.chars).toBe(block!.length);
    expect(usage).toEqual([{ agentId: "secretary", kind: "memory_brief", chars: block!.length, tokens: part.tokens }]);
  });

  it("不相关、短应答、设置关着都不带；推理库用不了不带", async () => {
    const store = eventStore();
    const r = await reasoning();
    let on = true;
    const { briefs: b, usage } = briefs({ ...r, store, enabled: () => on });
    expect((await turn(store, b, "明天上海会下雨吗")).block).toBeUndefined();
    expect((await turn(store, b, "好的谢谢")).block).toBeUndefined();
    on = false;
    expect((await turn(store, b, TALK)).block).toBeUndefined();
    expect(usage).toEqual([]);
    const { briefs: none } = briefs({ engine: () => undefined, store });
    expect((await turn(store, none, TALK)).block).toBeUndefined();
  });

  it("同一段对话里带过、没变的不再带；压缩、清空当前对话之后再带；守护进程重启后从会话里认得出带过的", async () => {
    const store = eventStore();
    const r = await reasoning();
    const { briefs: b } = briefs({ ...r, store });
    expect((await turn(store, b, TALK)).block).toBeDefined();
    // 同一段对话：同样的话不再带
    const again = await turn(store, b, TALK);
    expect(again.block).toBeUndefined();
    expect(again.parts).toEqual([]);

    // 重启：新的一份从会话里的回话认出带过的
    const { briefs: restarted } = briefs({ ...r, store });
    expect((await turn(store, restarted, TALK)).block).toBeUndefined();

    // 压缩过一次（时间线上记一笔 compaction）：前面带过的已经不在上下文里了，再带
    store.append({ channel: SECRETARY, type: EVENT_TYPES.timelineRecord, payload: { record: { id: "rec-1", kind: "compaction", summary: "压缩了一次", time: clockIso(new ManualClock(NOW)) } } });
    expect((await turn(store, restarted, TALK)).block).toBeDefined();
    expect((await turn(store, restarted, TALK)).block).toBeUndefined();

    // 清空当前对话：再带
    seq += 1;
    store.append({ channel: SECRETARY, type: EVENT_TYPES.message, payload: { message: { id: `m-clear-${seq}`, conversation: SECRETARY, speaker: "system", time: clockIso(new ManualClock(NOW)), parts: [{ type: "conversation_cleared" }] } } });
    expect((await turn(store, restarted, TALK)).block).toBeDefined();
  });

  it("太慢（超过上限）就这一轮不带，记一行日志，不拖住回话", async () => {
    const store = eventStore();
    const slow = { messageBrief: () => new Promise(() => {}), store: { now: () => clockIso(new ManualClock(NOW)) } } as unknown as MemoryEngine;
    const { briefs: b, logs } = briefs({ engine: () => slow, store, timeoutMs: 50 });
    expect((await turn(store, b, TALK)).block).toBeUndefined();
    expect(logs.some((line) => line.includes("记忆简报") && line.includes("超时"))).toBe(true);
  });
});

describe("查询向量只算一次", () => {
  it("同一句话的查询向量记住（一份简报里几处检索共用），文档向量照常算", async () => {
    let queries = 0;
    const inner = kernelEmbedderAdapter(new FakeEmbedder());
    const counting = { ...inner, embedQueries: (texts: readonly string[]) => ((queries += texts.length), inner.embedQueries(texts)) };
    const memo = queryMemoEmbedder(counting);
    const [a] = await memo.embedQueries(["周末"]);
    const [b] = await memo.embedQueries(["周末"]);
    expect(b).toBe(a);
    expect(queries).toBe(1);
    await memo.embedQueries(["工作日"]);
    expect(queries).toBe(2);
    expect(memo.model).toBe(inner.model);
  });
});

const AT = "2026-10-12T04:00:00.000Z";
const purged = (materialIds: string[]) => ({ messages: [], materialIds, toolCallIds: [], mediaIds: [], deletedAt: AT });
/** 假的查法：mat-ev-w3 那条素材背后是 ev-w3 */
const w3Evidence = (ids: readonly string[]) => (ids.includes("mat-ev-w3") ? ["ev-w3"] : []);
const jsonLine = (entry: unknown) => JSON.stringify(entry);

describe("彻底删除：会话文件里记忆简报引的原话也抹掉", () => {
  const at = AT;

  it("sessionRewriteFor 按被删素材找到证据编号，交给子进程一条\"跟在输入后面的上下文消息\"的规矩（连续行一起换）；没有证据就不带", () => {
    const evidenceOf = w3Evidence;
    expect(sessionRewriteFor([purged(["mat-ev-w3"])], { evidenceOf }).contextLines).toEqual([{ customType: INPUT_CONTEXT_TYPE, needles: ["ev-w3"], continuation: true }]);
    expect(sessionRewriteFor([purged(["mat-other"])], { evidenceOf }).contextLines).toEqual([]);
    expect(sessionRewriteFor([purged(["mat-ev-w3"])]).contextLines).toEqual([]);
  });

  it("会话文件里跟在输入后面的那条上下文消息：引着被删证据的行（连同续行）换成删除标记，别的照旧；覆盖了它的压缩摘要整段换掉；再改一遍不变", { timeout: 60_000 }, async () => {
    const store = eventStore();
    const { briefs: b } = briefs({ ...(await reasoning()), store });
    const { block } = await turn(store, b, TALK);
    expect(block).toContain("「我不喜欢周末被排得满满的」");
    expect(block).toContain("「这周六的饭局我就不去了」");
    const dir = makeTempDir("ergo-message-brief-session-");
    const file = path.join(dir, `${at.replaceAll(":", "-")}_s1.jsonl`);
    const line = jsonLine;
    fs.writeFileSync(
      file,
      [
        line({ type: "session", version: 3, id: "s1", timestamp: at, cwd: dir }),
        line({ type: "message", id: "m1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: TALK }], timestamp: 0 } }),
        line({ type: "custom_message", id: "c1", parentId: "m1", timestamp: at, customType: INPUT_CONTEXT_TYPE, content: block, display: false }),
        line({ type: "message", id: "m2", parentId: "c1", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: "好的" }], timestamp: 0 } }),
        line({ type: "compaction", id: "k1", parentId: "m2", timestamp: at, summary: "用户不喜欢周末被排满", firstKeptEntryId: "m2", tokensBefore: 100 }),
        "",
      ].join("\n"),
    );
    const rewrite = sessionRewriteFor([purged(["mat-ev-w3"])], { evidenceOf: () => ["ev-w3"] });
    expect(await rewriteViaChild({ sessionDir: dir, ...rewrite })).toEqual({ files: 1, entries: 1, summaries: 1 });
    const entries = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as { type: string; content?: string; summary?: string });
    const context = entries.find((e) => e.type === "custom_message")!.content!;
    expect(context).not.toContain("我不喜欢周末被排得满满的");
    expect(context).toContain(`- ev-w3 · ${PURGED_TEXT}`);
    // 别的证据的原话、简报的结构都在
    expect(context).toContain("「这周六的饭局我就不去了」");
    expect(context.startsWith(MESSAGE_BRIEF_HEAD)).toBe(true);
    expect(entries.find((e) => e.type === "compaction")!.summary).toBe(PURGED_SUMMARY_TEXT);
    expect(await rewriteViaChild({ sessionDir: dir, ...rewrite })).toEqual({ files: 0, entries: 0, summaries: 0 });
  });
});

/**
 * 337 号票：这段简报改成问记忆插件要（createMessageBriefs 注入的 brief，组合根传记忆插件宿主的 host.brief）。
 * 这里摆一个假的 brief，看 message-brief 这一侧的行为没变：正文进这一轮输入、keys 记下去重、用量照旧、出错和超时回空。
 * （上面那些老测试走的是 engine 那条回落，两边算法都是 engineMessageBrief，算出来的东西一样。）
 */
describe("337：简报问记忆插件要（注入的 brief）", () => {
  /** 注入假 brief 的一份 createMessageBriefs：记下问过什么，这一轮回什么由 reply 摆 */
  function injecting(
    store: EventStore,
    reply: (input: MemoryBriefInput) => Promise<MemoryBriefResult | string | undefined>,
    over: Partial<MessageBriefsOptions> = {},
  ): { briefs: MessageBriefs; logs: string[]; usage: unknown[]; asked: MemoryBriefInput[] } {
    const logs: string[] = [];
    const usage: unknown[] = [];
    const asked: MemoryBriefInput[] = [];
    const made = createMessageBriefs({
      store,
      materials,
      enabled: () => true,
      record: (u) => usage.push(u),
      log: (line) => logs.push(line),
      brief: async (input) => {
        asked.push(input);
        return reply(input);
      },
      ...over,
    });
    const off = store.onAppend((event) => made.onEvent(event));
    onTestFinished(off);
    return { briefs: made, logs, usage, asked };
  }

  it("注入的正文出现在这一轮输入里；keys 进回话那部分、下一轮当 known 交回去（插件按它不再带）；用量照旧记一笔；结构化的部分照旧", async () => {
    const store = eventStore();
    const KEY = { "claim:cl-0001": "0123456789ab" };
    const { briefs: b, usage, asked } = injecting(store, async (input) =>
      Object.keys(input.known ?? {}).length > 0
        ? undefined // 插件自己按 known 判：带过没变的就不给正文（和会意一样）
        : {
            text: "甲的结论：周末别排满（「我不喜欢周末被排得满满的」）",
            keys: KEY,
            items: [{ key: "claim:cl-0001", kind: "claim", reason: "direct", claimIds: ["cl-0001"], routes: ["upward"] }],
            hits: [{ materialId: "mat-ev-w3", kind: "user_utterance", time: "2026-10-09T10:00:00.000+08:00" }],
          },
    );

    const first = await turn(store, b, TALK);
    expect(first.block).toBeDefined();
    expect(first.block!.startsWith(MESSAGE_BRIEF_HEAD)).toBe(true);
    expect(first.block!).toContain("甲的结论：周末别排满");
    // 问的是这句话、这一轮的场景；第一轮没有带过的
    expect(asked[0]).toMatchObject({ text: TALK, known: {}, conversation: { id: SECRETARY, agentId: "secretary" } });
    // 回话上的结构化部分：带过的指纹、为什么带、命中的素材、字数、估的 token
    const part = first.parts[0];
    if (part?.type !== "memory_brief") throw new Error("应该有记忆简报的 part");
    expect(part.brought).toEqual(KEY);
    expect(part.items).toEqual([{ key: "claim:cl-0001", kind: "claim", reason: "direct", claimIds: ["cl-0001"], routes: ["upward"] }]);
    expect(part.recall).toEqual({ source: "brief", hits: [{ materialId: "mat-ev-w3", kind: "user_utterance", time: "2026-10-09T10:00:00.000+08:00" }] });
    expect(part.chars).toBe(first.block!.length);
    expect(part.tokens).toBeGreaterThan(0);
    // 用量照旧：这一次带的一笔
    expect(usage).toEqual([{ agentId: "secretary", kind: "memory_brief", chars: first.block!.length, tokens: part.tokens }]);

    // 同一段对话里再说一遍：上一轮的 keys 当 known 交回去，插件按它不带
    const again = await turn(store, b, TALK);
    expect(again.block).toBeUndefined();
    expect(again.parts).toEqual([]);
    expect(asked[1]).toMatchObject({ text: TALK, known: KEY });
    expect(usage).toHaveLength(1);
  });

  it("插件只回字符串（没有 keys）时照常带、不报错：不去重，每一轮都带", async () => {
    const store = eventStore();
    const { briefs: b, usage, asked } = injecting(store, async () => "甲的文字简报（不带键）");

    const first = await turn(store, b, TALK);
    const second = await turn(store, b, TALK);
    expect(first.block!).toContain("甲的文字简报（不带键）");
    // 没有键就不去重：同样的这句话，第二轮回样带（退化成"每次都带"）
    expect(second.block!).toContain("甲的文字简报（不带键）");
    const part = first.parts[0];
    if (part?.type !== "memory_brief") throw new Error("应该有记忆简报的 part");
    expect(part.brought).toEqual({});
    expect(part.items).toEqual([]);
    expect(part.recall).toEqual({ source: "brief", hits: [] });
    // 两轮都没把带过的交回去（没有任何键）
    expect(asked.map((input) => input.known)).toEqual([{}, {}]);
    expect(usage).toHaveLength(2);
  });

  it("插件 brief 抛错时这一轮不带、只记一行日志；慢过上限也一样（照现有出错/超时的处理，不拖住回话）", async () => {
    const store = eventStore();
    const boom = injecting(store, async () => {
      throw new Error("插件炸了");
    });
    expect((await turn(store, boom.briefs, TALK)).block).toBeUndefined();
    expect(boom.logs.some((line) => line.includes("记忆简报出错") && line.includes("插件炸了"))).toBe(true);
    expect(boom.usage).toEqual([]);

    // 插件一直不回（超过上限）：这一轮不带、记一行日志；用法和老测试里"引擎太慢"一样
    const slow = injecting(store, () => new Promise<never>(() => {}), { timeoutMs: 50 });
    expect((await turn(store, slow.briefs, TALK)).block).toBeUndefined();
    expect(slow.logs.some((line) => line.includes("记忆简报超时"))).toBe(true);
    expect(slow.usage).toEqual([]);
  });
});
