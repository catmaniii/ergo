// 回话时"调用记忆"单独显示（187 号票）：检索素材、读素材执行了的调用不算进"调用了 N 个工具"，在它发生的位置单独出一行
// "回忆了 N 条记忆 ›"；同一段里连着的几次合成一行，N 是去重后的素材条数，查了没找到的写"查了记忆，没找到相关的"。
// 点开是"这次用到的记忆"：按先后列出每次为什么查、查了什么、找到的每条（怎么找出来的、读没读全文），原文和时间由界面按素材 id 现取。
// 187 号票之前的记录（没有结构化的部分）从参数摘要、结果摘要和完整返回里认。按共享协议的 schema 构造事件。
import { MessageEventPayload as MessageEventPayloadSchema, PURGED_TEXT, schemaChecker } from "@ergo/protocol";
import { describe, expect, test } from "vitest";
import {
  type ChatItem,
  chatItems,
  chatLook,
  detailContent,
  type EventFrame,
  locateChatItem,
  type MaterialDetailView,
  type MemoryRecall,
  type MessageEnvelope,
  type MessageEventPayload,
  type MessagePart,
  parseLegacyHits,
  recallAgo,
  recallHowLabel,
  recallMaterial,
  recallSummary,
  replay,
  zoomBlocks,
} from "../../src/state/index.ts";
import { frame } from "./events.ts";

type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;

const checkMessage = schemaChecker(MessageEventPayloadSchema);
const S = "secretary";
const at = (s: number) => `2026-10-20T10:00:${String(s).padStart(2, "0")}.000+08:00`;

function messageFrame(seq: number, id: string, speaker: MessageEnvelope["speaker"], parts: MessagePart[]): EventFrame {
  const payload: MessageEventPayload = { message: { id, conversation: S, speaker, time: at(seq), parts } };
  const problem = checkMessage.firstError(payload);
  if (problem) throw new Error(`构造的事件不合 schema：${problem}`);
  return frame(S, seq, "message", payload);
}

const text = (t: string): MessagePart => ({ type: "text", text: t });
const reasoning = (t: string): MessagePart => ({ type: "reasoning", text: t });
/** 检索到的一条（默认关键词命中；more 里 keyword 写 undefined 就是没有关键词命中） */
function hit(n: number, more: Partial<MemoryRecall["hits"][number]> = {}): MemoryRecall["hits"][number] {
  const { keyword, ...rest } = { materialId: `mat-${n}`, kind: "user_utterance", time: "2026-10-17T09:12:00.000+08:00", conversation: S, keyword: true as const, ...more };
  return keyword === undefined ? rest : { ...rest, keyword };
}

function call(callId: string, tool: string, overrides: Partial<ToolCallPart> = {}): ToolCallPart {
  return { type: "tool_call", callId, tool, argsSummary: "", categoryTitles: [], disposition: "do", withinGrant: false, genericBash: false, outcome: "done", nature: "look", ...overrides };
}
const search = (callId: string, recall: Omit<MemoryRecall, "source"> | undefined, overrides: Partial<ToolCallPart> = {}) =>
  call(callId, "search_materials", { argsSummary: `query=${recall?.query ?? ""} why=${recall?.why ?? ""}`, ...(recall ? { recall: { source: "search", ...recall } } : {}), ...overrides });
const read = (callId: string, materialId: string, overrides: Partial<ToolCallPart> = {}) =>
  call(callId, "read_material", { argsSummary: `materialId=${materialId}`, recall: { source: "read", hits: [{ materialId, kind: "user_utterance", time: "2026-10-17T09:12:00.000+08:00", conversation: S }] }, ...overrides });
const callFrame = (seq: number, part: ToolCallPart) => messageFrame(seq, `m-${part.callId}`, "agent", [part]);
/** 问记忆（263 号票）：hits 不给就是 263 之前的记录（没有结构化部分） */
const ask = (callId: string, question: string, hits: MemoryRecall["hits"] | undefined, overrides: Partial<ToolCallPart> = {}) =>
  call(callId, "ask_memory", { argsSummary: `question=${question}`, ...(hits ? { recall: { source: "ask", query: question, hits } } : {}), ...overrides });

const kinds = (items: readonly ChatItem[]) =>
  items.map((it) => (it.kind === "tool_group" ? `tool_group[${it.calls.map((c) => c.part.tool).join(",")}]` : it.kind === "recall" ? `recall[${it.calls.map((c) => c.part.callId).join(",")}]` : it.kind));

describe("对话层：调用记忆单独一行", () => {
  test("检索、读全文不算进调用了 N 个工具，在它发生的位置单独一行；连着的几次（中间隔着思考也算）合成一行，思考跟着后面的那一段", () => {
    const items = chatItems(
      replay([
        messageFrame(1, "u1", "user", [text("我对什么过敏？再算算九月的账")]),
        messageFrame(2, "t1", "agent", [reasoning("先查记忆")]),
        callFrame(3, search("s1", { why: "用户问对什么过敏", query: "过敏", hits: [hit(1), hit(2)] })),
        messageFrame(4, "t2", "agent", [reasoning("再看看全文")]),
        callFrame(5, read("r1", "mat-1")),
        messageFrame(6, "t3", "agent", [reasoning("然后算账")]),
        callFrame(7, call("w1", "write", { argsSummary: "a.csv", nature: "act" })),
        callFrame(8, search("s2", { why: "找九月的月结单", query: "月结单", hits: [hit(3)] })),
        messageFrame(9, "a1", "agent", [text("你对芒果过敏；九月花了 300")]),
      ]),
      S,
    );
    expect(kinds(items)).toEqual(["user", "recall[s1,r1]", "tool_group[write]", "recall[s2]", "reply"]);
    const recall = items[1]!;
    if (recall.kind !== "recall") throw new Error("第二条应当是调用记忆");
    // 思考：前面的跟着后面的那一段（先查记忆 → 调用记忆那一行；然后算账 → 工具调用组）
    expect(recall.steps.map((s) => (s.kind === "thinking" ? s.text : s.call.part.callId))).toEqual(["先查记忆", "s1", "再看看全文", "r1"]);
    const group = items[2]!;
    expect(group.kind === "tool_group" && group.steps.map((s) => (s.kind === "thinking" ? s.text : s.call.part.callId))).toEqual(["然后算账", "w1"]);
    // N 是去重后的素材条数（读的是检索到的那条，不另算）
    expect([recall.id, recall.keyLine, recall.recall.count, recall.content, recall.detail]).toEqual(["recall:m-s1#0", "回忆了 2 条记忆", 2, "tool", "recall"]);
    expect(group.keyLine).toBe("调用了 1 个工具：写文件");
    // 按调用、思考的 id 都找得到这一行
    expect(locateChatItem(items, "m-r1#0")).toMatchObject({ item: { id: "recall:m-s1#0" }, call: { id: "m-r1#0" } });
    expect(locateChatItem(items, "t2:think")?.item.id).toBe("recall:m-s1#0");
    expect(locateChatItem(items, "recall:m-s1#0")).toEqual({ item: recall });
  });

  test("那一行的样子：记忆图标那一种（recall_line）、写回忆了几条，整行点开；查了没找到的写没找到", () => {
    const items = chatItems(
      replay([
        messageFrame(1, "u1", "user", [text("我说过火星基地吗")]),
        callFrame(2, search("s1", { why: "看用户有没有说过火星基地", query: "火星基地", hits: [] })),
        messageFrame(3, "a1", "agent", [text("没说过")]),
      ]),
      S,
    );
    const line = items[1]!;
    expect(line.keyLine).toBe("查了记忆，没找到相关的");
    expect(chatLook(line)).toEqual({ form: "recall_line", text: "查了记忆，没找到相关的", found: false, open: "row" });
  });

  test("被拦下、出错的记忆调用照旧留在调用了 N 个工具里（状况看得见）；只有工具调用的一段里，顺利执行的内部工具跟着调用记忆那一行挂着", () => {
    const items = chatItems(
      replay([
        messageFrame(1, "u1", "user", [text("读一下那条")]),
        callFrame(2, read("r1", "mat-9", { outcome: "error", recall: undefined, resultSummary: "素材库里没有 mat-9" })),
        callFrame(3, search("s1", { why: "重新找", query: "那条", hits: [hit(9)] })),
        callFrame(4, call("x1", "write_progress", { argsSummary: "进展" })),
        messageFrame(5, "a1", "agent", [text("找到了")]),
      ]),
      S,
    );
    expect(kinds(items)).toEqual(["user", "tool_group[read_material]", "recall[s1]", "reply"]);
    expect(items[1]!.keyLine).toContain("1 次出错");
    expect(items[2]!.internalCalls.map((c) => c.part.callId)).toEqual(["x1"]);
  });

  test("缩小后（要点层、全局层）照调用了 N 个工具的规则逐次画：每次调用记忆、每段思考各一块", () => {
    const items = chatItems(
      replay([messageFrame(1, "t1", "agent", [reasoning("查一下")]), callFrame(2, search("s1", { why: "查", query: "过敏", hits: [hit(1)] })), callFrame(3, read("r1", "mat-1"))]),
      S,
    );
    const blocks = zoomBlocks(items[0]!);
    expect(blocks.map((b) => [b.kind, b.id, b.groupId])).toEqual([
      ["thinking", "t1:think", "recall:m-s1#0"],
      ["call", "m-s1#0", "recall:m-s1#0"],
      ["call", "m-r1#0", "recall:m-s1#0"],
    ]);
  });
});

/** 187 号票之前的检索记录：没有结构化的部分 */
const legacy = (resultSummary: string) => search("old", undefined, { argsSummary: "query=过敏 limit=10", resultSummary });

describe("计数：去重、没找到、旧记录", () => {
  test("同一条素材在几次检索里出现、又被读了全文，只算一条；读的不在检索结果里的另算", () => {
    expect(recallSummary([search("a", { why: "x", query: "q", hits: [hit(1), hit(2)] }), search("b", { why: "y", query: "q2", hits: [hit(2), hit(3)] }), read("c", "mat-1"), read("d", "mat-7")])).toEqual({
      count: 4,
      known: true,
      calls: 4,
    });
    expect(recallSummary([search("a", { why: "x", query: "q", hits: [] })])).toEqual({ count: 0, known: true, calls: 1 });
  });

  test("187 号票之前的检索记录（没有结构化的部分）：条数按结果摘要里的找到 N 条，没找到的是 0，认不出（彻底删除过）的不准", () => {
    expect(recallSummary([legacy("找到 3 条素材： - mat-aaa · 2026-10-08 09:30 · 用户发言 · secretary（关键词）：我对芒果过敏")])).toEqual({ count: 3, known: true, calls: 1 });
    expect(recallSummary([legacy("没有找到和「过敏」匹配的素材。")])).toEqual({ count: 0, known: true, calls: 1 });
    expect(recallSummary([legacy(PURGED_TEXT)])).toEqual({ count: 0, known: false, calls: 1 });
    const items = chatItems(replay([callFrame(1, legacy(PURGED_TEXT)), callFrame(2, legacy(PURGED_TEXT))]), S);
    expect(items.map((it) => it.keyLine)).toEqual(["查了 2 次记忆"]);
    // 旧记录的读全文：素材 id 从参数摘要里认
    expect(recallSummary([read("r", "mat-5", { recall: undefined })])).toEqual({ count: 1, known: true, calls: 1 });
  });

  test("旧记录的完整返回按行认出命中：素材 id、关键词、语义的分数", () => {
    const result = [
      "找到 3 条素材：",
      "- mat-0123456789abcdef01234567 · 2026-10-08 09:30 · 用户发言 · secretary（关键词）：我对芒果过敏",
      "- mat-1123456789abcdef01234567 · 2026-10-09 20:15 · 审批决定 · maintainer:pm-1 · 不参与推断（语义 0.62）：批准：导出账单",
      "- mat-2123456789abcdef01234567 · 2026-10-10 08:00 · 用户主动投喂的材料 · 用户存的网页（关键词+语义 0.71）：攻略（https://x.example）",
      "（向量模型不在，这次只按关键词检索）",
    ].join("\n");
    expect(parseLegacyHits(result)).toEqual([
      { materialId: "mat-0123456789abcdef01234567", keyword: true },
      { materialId: "mat-1123456789abcdef01234567", semantic: 0.62 },
      { materialId: "mat-2123456789abcdef01234567", keyword: true, semantic: 0.71 },
    ]);
    expect(parseLegacyHits("没有找到和「x」匹配的素材。")).toEqual([]);
  });
});

describe("详情：这次用到的记忆", () => {
  const items = chatItems(
    replay([
      messageFrame(1, "u1", "user", [text("我对什么过敏？")]),
      messageFrame(2, "t1", "agent", [reasoning("查记忆")]),
      callFrame(3, search("s1", { why: "用户问对什么过敏", query: "过敏", hits: [hit(1), hit(2, { keyword: undefined, semantic: 0.71 }), hit(3, { semantic: 0.66 })] })),
      callFrame(4, read("r1", "mat-2")),
      callFrame(5, read("r2", "mat-8")),
      callFrame(6, search("s2", undefined, { argsSummary: "query=体检 limit=5", resultSummary: "找到 1 条素材： - mat-x" })),
      messageFrame(7, "a1", "agent", [text("你对芒果过敏")]),
    ]),
    S,
  );

  test("按先后列出：思考、每次检索（为什么查、查了什么、找到的每条：怎么找出来的、读没读全文）；读的是前面检索到的那条不另列，别的读全文单独一条", () => {
    const detail = detailContent(replay([]), items, { type: "item", id: items[1]!.id });
    expect(detail).toMatchObject({ kind: "recall", itemId: "recall:m-s1#0", title: "回忆了 5 条记忆", count: 5 });
    if (detail.kind !== "recall") throw new Error("应当是调用记忆的详情");
    expect(detail.steps).toEqual([
      { kind: "thinking", id: "t1:think", text: "查记忆" },
      {
        kind: "search",
        id: "m-s1#0",
        callId: "s1",
        title: "用户问对什么过敏",
        query: "过敏",
        hits: [
          { materialId: "mat-1", how: "关键词命中", readFull: false },
          { materialId: "mat-2", how: "语义相近（0.71）", readFull: true },
          { materialId: "mat-3", how: "关键词命中，语义也相近（0.66）", readFull: false },
        ],
      },
      { kind: "read", id: "m-r2#0", callId: "r2", hit: { materialId: "mat-8", how: undefined, readFull: true } },
      // 旧记录：没有为什么查，写"查：<query>"；命中要从完整返回里认（hits 是 undefined）
      { kind: "search", id: "m-s2#0", callId: "s2", title: "查：体检", query: undefined, hits: undefined },
    ]);
  });

  test("怎么找出来的说法", () => {
    expect([recallHowLabel({ keyword: true }), recallHowLabel({ semantic: 0.5 }), recallHowLabel({ keyword: true, semantic: 0.83 }), recallHowLabel({})]).toEqual([
      "关键词命中",
      "语义相近（0.50）",
      "关键词命中，语义也相近（0.83）",
      undefined,
    ]);
  });
});

// 263 号票：问记忆（ask_memory，查推理图谱）也进"回忆了 N 条记忆"那一行
describe("问记忆也算调用记忆", () => {
  test("不算进调用了 N 个工具，单独一行；和检索素材连着的合成一行，条数按素材去重", () => {
    const items = chatItems(
      replay([
        messageFrame(1, "u1", "user", [text("我是不是不喜欢周末被排满？")]),
        callFrame(2, ask("q1", "是不是不喜欢周末被排满", [hit(1, { keyword: undefined }), hit(2, { keyword: undefined })])),
        callFrame(3, search("s1", { why: "看原话", query: "周末", hits: [hit(2), hit(3)] })),
        messageFrame(4, "a1", "agent", [text("是的")]),
      ]),
      S,
    );
    expect(kinds(items)).toEqual(["user", "recall[q1,s1]", "reply"]);
    expect(items[1]!.keyLine).toBe("回忆了 3 条记忆");
  });

  test("详情里写\"问记忆：<问题>\"，列出简报引用的证据背后的素材；263 号票之前的问记忆记录认不出条数（写查了 N 次记忆）", () => {
    const items = chatItems(replay([callFrame(1, ask("q1", "我最看重什么", [hit(4, { keyword: undefined })]))]), S);
    const detail = detailContent(replay([]), items, { type: "item", id: items[0]!.id });
    if (detail.kind !== "recall") throw new Error("应当是调用记忆的详情");
    expect(detail.steps).toEqual([{ kind: "search", id: "m-q1#0", callId: "q1", title: "问记忆：我最看重什么", query: undefined, hits: [{ materialId: "mat-4", how: undefined, readFull: false }] }]);
    // 以前的记录（没有结构化部分）
    const old = chatItems(replay([callFrame(1, ask("q0", "我最看重什么", undefined))]), S);
    expect(old.map((it) => it.keyLine)).toEqual(["查了 1 次记忆"]);
    expect(recallSummary([ask("q0", "我最看重什么", undefined)])).toEqual({ count: 0, known: false, calls: 1 });
  });
});

type BriefPart = Extract<MessagePart, { type: "memory_brief" }>;
const brief = (hits: MemoryRecall["hits"]): BriefPart => ({
  type: "memory_brief",
  recall: { source: "brief", hits },
  items: [
    { key: "claim:cl-0001", kind: "claim", reason: "direct", claimIds: ["cl-0001"], routes: ["upward", "index"] },
    { key: "claim:cl-0007", kind: "claim", reason: "area", claimIds: ["cl-0007"], routes: ["domain"] },
    { key: "group:g1", kind: "group", reason: "undecided", claimIds: ["cl-0003", "cl-0004"], routes: ["upward"] },
    { key: "claim:cl-0002", kind: "hard", reason: "hard", claimIds: ["cl-0002"], routes: [] },
  ],
  brought: { "claim:cl-0001": "0123456789ab" },
  tokens: 420,
  chars: 900,
});

// 266 号票：每条消息自动带上的记忆简报也进"回忆了 N 条记忆"那一行——结构化的部分挂在秘书这一轮的第一条回话上（MemoryBriefPart）
describe("记忆简报也算调用记忆", () => {
  test("回话前面单独一行（不算进调用了 N 个工具），回话的正文照常一条；和紧接着的问记忆合成一行，条数按素材去重", () => {
    const alone = chatItems(replay([messageFrame(1, "u1", "user", [text("这周六又被约了")]), messageFrame(2, "a1", "agent", [brief([hit(1, { keyword: undefined }), hit(2, { keyword: undefined })]), text("要不推掉？")])]), S);
    expect(alone.map((it) => it.kind)).toEqual(["user", "recall", "reply"]);
    expect(alone[1]!.keyLine).toBe("回忆了 2 条记忆");
    expect(alone[2]!.keyLine).toContain("要不推掉？");

    const merged = chatItems(
      replay([
        messageFrame(1, "u1", "user", [text("我是不是不喜欢周末被排满？")]),
        messageFrame(2, "a1", "agent", [brief([hit(1, { keyword: undefined }), hit(2, { keyword: undefined })]), call("q1", "ask_memory", { argsSummary: "question=周末", recall: { source: "ask", query: "周末", hits: [hit(2, { keyword: undefined }), hit(3, { keyword: undefined })] } })]),
        messageFrame(3, "a2", "agent", [text("是的")]),
      ]),
      S,
    );
    expect(merged.map((it) => it.kind)).toEqual(["user", "recall", "reply"]);
    expect(merged[1]!.keyLine).toBe("回忆了 3 条记忆");
    expect(recallSummary([])).toEqual({ count: 0, known: true, calls: 0 });
  });

  test("点开看为什么带它：每条写明为什么（直接说到这件事、经哪条路找到的；同一方面；还没分出胜负；明说过的禁忌）和说到的结论，下面是简报引的原话背后的素材", () => {
    const items = chatItems(replay([messageFrame(1, "a1", "agent", [brief([hit(5, { keyword: undefined })]), text("好")])]), S);
    const detail = detailContent(replay([]), items, { type: "item", id: items[0]!.id });
    if (detail.kind !== "recall") throw new Error("应当是调用记忆的详情");
    expect(detail.steps).toEqual([
      {
        kind: "brief",
        id: "a1#0",
        title: "自动带上的记忆简报：你这句话和下面这些记忆相关",
        items: [
          { key: "claim:cl-0001", reason: "直接说到这件事", how: "从你说过的话往上找到的、结论的说法对上了", claimIds: ["cl-0001"] },
          { key: "claim:cl-0007", reason: "同一方面，不一定直接说到这件事", how: undefined, claimIds: ["cl-0007"] },
          { key: "group:g1", reason: "还没分出胜负的几种解释", how: undefined, claimIds: ["cl-0003", "cl-0004"] },
          { key: "claim:cl-0002", reason: "你明说过的禁忌", how: undefined, claimIds: ["cl-0002"] },
        ],
        hits: [{ materialId: "mat-5", how: undefined, readFull: false }],
      },
    ]);
  });
});

describe("找到的那一条：原话或说明、什么时候、在哪", () => {
  const base: MaterialDetailView = {
    id: "mat-1",
    kind: "用户发言",
    mode: "say",
    time: "2026-10-17T09:12:00.000+08:00",
    conversation: S,
    source: "self",
    context: [S],
    segments: [{ form: "typed", source: "self", notes: [], text: "我对芒果过敏，吃了会起疹子" }],
    event: { channel: S, seq: 3, type: "message" },
    message: { id: "msg-1", state: "shown" },
    marks: {},
  };
  const now = Date.parse("2026-10-20T10:00:00.000+08:00");

  test("本人的话给原文；长的截断、可展开；什么时候写具体时间加相对说法；在哪是来源会话；出处的消息还在能跳回去", () => {
    expect(recallMaterial(replay([]), base, now)).toEqual({
      text: "我对芒果过敏，吃了会起疹子",
      head: "我对芒果过敏，吃了会起疹子",
      more: false,
      own: true,
      kind: "用户发言",
      at: "2026-10-17 09:12",
      ago: "3天前",
      conversation: S,
      taskId: undefined,
      projectId: undefined,
      jump: { kind: "secretary", at: "msg-1" },
    });
    const long = recallMaterial(replay([]), { ...base, segments: [{ form: "typed", source: "self", notes: [], text: "很长的话。".repeat(40) }] }, now);
    expect([long.more, long.head.length, long.text.length]).toEqual([true, 121, 200]);
    expect(long.head.endsWith("…")).toBe(true);
  });

  test("不是本人的话给说明：存的网页写标题，回避信号写卡片的说明；出处的消息不在了跳不回去", () => {
    const page = recallMaterial(
      replay([]),
      {
        ...base,
        kind: "用户主动投喂的材料",
        source: "self",
        segments: [{ form: "web_page", source: "external_untrusted", notes: [], label: "跑步入门（https://run.example）", url: "https://run.example", saved: { title: "跑步入门", text: "第一周……", truncated: false, total: 5 } }],
        message: undefined,
        conversation: undefined,
      },
      now,
    );
    expect([page.own, page.text, page.conversation, page.jump]).toEqual([false, "跑步入门", undefined, undefined]);
    const dismissed = recallMaterial(replay([]), { ...base, kind: "回避信号", mode: "do", source: "agent", segments: [{ form: "agent_output", source: "agent", notes: [], label: "建议发起任务：整理相册" }], message: { id: "msg-2", state: "gone" } }, now);
    expect([dismissed.own, dismissed.text, dismissed.jump]).toEqual([false, "建议发起任务：整理相册", undefined]);
  });

  test("相对说法：刚才、几分钟前、几小时前、昨天、几天前、几个月前", () => {
    const iso = (ms: number) => new Date(now - ms).toISOString();
    const min = 60_000;
    expect([recallAgo(iso(10_000), now), recallAgo(iso(5 * min), now), recallAgo(iso(3 * 60 * min), now), recallAgo(iso(26 * 60 * min), now), recallAgo(iso(40 * 24 * 60 * min), now)]).toEqual([
      "刚刚",
      "5分钟前",
      "3小时前",
      "昨天",
      "上个月",
    ]);
  });
});
