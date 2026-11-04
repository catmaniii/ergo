// 素材的"回的是什么"（400）：会话里本人的话接着对方的话说的，挂上前文意思的总结；新话题、会话第一句不挂。
// - 找前文：同一会话当前分支上最近一条不是用户说的（agent 的回复、通知、卡片），用户连着说的往前跳过，看不见的（只有工具调用）跳过，
//   清空当前对话的分隔线前面的不算；隔了几小时才回照样交给模型；
// - 判：第一句不问模型；一批问一次模型，接着回的记总结、新话题不挂、没判出来的不记（下一夜再判）；每晚有上限，新的先判；
// - 记下：素材频道上的 material_replies，素材库照它在素材上标，materials.db 重建后照样在；忘掉、彻底删除跟着走，
//   删任务（连负责人会话一起删）时那个会话里挂的前文撤掉；
// - 读成证据：原文后面接"［前文，不是用户说的］…"一行，场景只从用户自己的话推；还没判的新近几条先不读。
import { FakeChatModel, type ChatRequest, REPLY_CONTEXT_PREFIX } from "@ergo/memory";
import {
  CHANNELS,
  type DeleteCommandPayload,
  EVENT_TYPES,
  isDeletedEventPayload,
  maintainerChannel,
  MEMORY_CURATOR_CONVERSATION,
  type MaterialRepliesEventPayload,
  type MemoryCommandEventPayload,
  type MessagePart,
  PURGED_TEXT,
  type Task,
} from "@ergo/protocol";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { createCardService } from "../../src/cards/cards.ts";
import { CardTypeRegistry } from "../../src/cards/registry.ts";
import { cardsView } from "../../src/cards/views.ts";
import { conversationViews } from "../../src/conversation/views.ts";
import { openEventStore } from "../../src/events/event-store.ts";
import { toolCallDetailsView } from "../../src/guard-runtime/tool-call-details.ts";
import { DeletionParticipants, TASK_DELETION } from "../../src/deletion/participants.ts";
import { MATERIALS_CHANNEL } from "../../src/materials/commands.ts";
import { materialRepliesPurge } from "../../src/materials/replies.ts";
import type { Material } from "../../src/materials/types.ts";
import { registerMaterialsDeletion } from "../../src/memory/deletion-participants.ts";
import { evidenceDraftOf, MaterialsEvidenceSource } from "../../src/memory/evidence-source.ts";
import { createMemoryNightlyJob } from "../../src/memory/nightly-job.ts";
import type { MemoryNightlyRecord } from "../../src/memory/nightly-record.ts";
import { purgePlan } from "../../src/memory/purge.ts";
import { createReasoningPurge } from "../../src/memory/purge-rg.ts";
import { openReasoningDb } from "../../src/memory/rg-db.ts";
import { isReplyCandidate, judgeMaterialReplies, precedingOf, replyHeldBack } from "../../src/memory/reply-context.ts";
import { PurgeRewriters } from "../../src/memory/rewriters.ts";
import { clockIso } from "../../src/scheduler/clock.ts";
import { INTERNAL_CHANNEL } from "../../src/scheduler/internal-jobs.ts";
import { openDatabase } from "../../src/storage/sqlite.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { materialsSetup, postMessage, text } from "../materials/helpers.ts";

type Setup = ReturnType<typeof materialsSetup>;

const time = (d: number, hh: number, mm = 0) => `2026-10-${String(d).padStart(2, "0")}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00.000+08:00`;
const toolCall = (tool: string): MessagePart => ({ type: "tool_call", callId: `call-${tool}`, tool, argsSummary: "x", categoryTitles: [], withinGrant: true, genericBash: false, outcome: "done" }) as MessagePart;

/** 这条消息采成的素材 */
const materialOf = (t: Setup, messageId: string): Material => t.materials.list().find((m) => m.ref.messageId === messageId)!;

/**
 * 假模型：按请求里"用户这句"给答——用户这句在 replies 里的回那个总结，在 topics 里的算新话题，别的不交（判不出来）。
 * 记下每次请求
 */
function judge(answers: { replies?: Record<string, string>; topics?: readonly string[] }) {
  const calls: ChatRequest[] = [];
  const model = new FakeChatModel((request) => {
    calls.push(request);
    const lines = request.user
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as { id: string; user: string });
    return {
      items: lines.flatMap((l) => {
        const summary = answers.replies?.[l.user];
        if (summary !== undefined) return [{ id: l.id, reply: true, summary }];
        if (answers.topics?.includes(l.user)) return [{ id: l.id, reply: false }];
        return [];
      }),
    };
  });
  return { model, calls };
}

/** 素材频道上的 material_replies 事件 */
const replyEvents = (t: Setup) => t.store.read(MATERIALS_CHANNEL, 0, EVENT_TYPES.materialReplies);

describe("找前文", () => {
  it("隔了几小时才回秘书的问题：前文是秘书那一轮（看不见的工具调用跳过、连着的两条一起给），谁说的写秘书", () => {
    const t = materialsSetup();
    postMessage(t.store, [text("周末想出去走走")], { time: time(10, 9) });
    postMessage(t.store, [text("好的，我看看天气。")], { speaker: "agent", time: time(10, 9, 1) });
    postMessage(t.store, [toolCall("weather")], { speaker: "agent", time: time(10, 9, 1) });
    postMessage(t.store, [text("周六晴。要不要约上老周一起去爬香山？")], { speaker: "agent", time: time(10, 9, 2) });
    postMessage(t.store, [toolCall("search_materials")], { speaker: "agent", time: time(10, 9, 2) });
    const late = postMessage(t.store, [text("好，就这么办")], { time: time(10, 15, 30) }).message.id;

    const preceding = precedingOf(t.store, materialOf(t, late));
    expect(preceding).toMatchObject({ by: "秘书", text: "好的，我看看天气。\n周六晴。要不要约上老周一起去爬香山？" });
  });

  it("会话第一句没有前文；用户连着说的几句往前跳过自己的；清空当前对话的分隔线前面的不算", () => {
    const t = materialsSetup();
    const first = postMessage(t.store, [text("帮我记一下明天交房租")], { time: time(10, 8) }).message.id;
    postMessage(t.store, [text("记下了，明天上午提醒你。")], { speaker: "agent", time: time(10, 8, 1) });
    const a = postMessage(t.store, [text("还有")], { time: time(10, 8, 2) }).message.id;
    const b = postMessage(t.store, [text("水电费也一起")], { time: time(10, 8, 2) }).message.id;
    postMessage(t.store, [{ type: "conversation_cleared" } as MessagePart], { speaker: "system", time: time(10, 9) });
    const fresh = postMessage(t.store, [text("今天想吃火锅")], { time: time(10, 9, 1) }).message.id;

    expect(precedingOf(t.store, materialOf(t, first))).toBeUndefined();
    expect(precedingOf(t.store, materialOf(t, a))?.text).toBe("记下了，明天上午提醒你。");
    expect(precedingOf(t.store, materialOf(t, b))?.text).toBe("记下了，明天上午提醒你。");
    expect(precedingOf(t.store, materialOf(t, fresh))).toBeUndefined();
  });

  it("出处不是那条消息事件的（语音的素材由识别完成的 voice 事件产生）：按消息 id 找到那条消息再往前找", () => {
    const VOICE_DONE = "test-voice-done" as never;
    const t = materialsSetup({
      sources: [
        {
          name: "test-voice",
          eventType: VOICE_DONE,
          capture: (event) => {
            const p = event.payload as { messageId: string; text: string };
            return [{ kind: "user_utterance", source: "self", conversation: CHANNELS.secretary, segments: [{ form: "voice", source: "self", notes: ["transcribed"], locator: { part: 0 }, text: p.text }], ref: { messageId: p.messageId } }];
          },
        },
      ],
    });
    postMessage(t.store, [text("今晚想吃什么？")], { speaker: "agent", time: time(10, 18) });
    const voiceMessage = postMessage(t.store, [{ type: "voice", voiceId: "v-1", mediaId: "m".repeat(64), durationMs: 1200 } as unknown as MessagePart], { time: time(10, 18, 5) }).message.id;
    postMessage(t.store, [text("（语音识别中）")], { speaker: "agent", time: time(10, 18, 6) });
    t.store.append({ channel: CHANNELS.secretary, type: VOICE_DONE, payload: { messageId: voiceMessage, text: "随便，面条就行" } });
    const voiced = t.materials.list().find((m) => m.ref.messageId === voiceMessage && m.ref.event.type === VOICE_DONE)!;
    expect(precedingOf(t.store, voiced)?.text).toBe("今晚想吃什么？");
  });

  it("谁说的：负责人、记忆管理员、通知、卡片（卡片给纯文本降级）", () => {
    const t = materialsSetup();
    const owner = maintainerChannel("tm-3");
    postMessage(t.store, [text("第一稿写好了，要不要先看大纲？")], { conversation: owner, speaker: "agent", time: time(10, 9) });
    const toOwner = postMessage(t.store, [text("先看大纲")], { conversation: owner, time: time(10, 9, 5) }).message.id;
    postMessage(t.store, [text("最近睡得怎么样？")], { conversation: MEMORY_CURATOR_CONVERSATION, speaker: "agent", time: time(10, 10) });
    const toCurator = postMessage(t.store, [text("还行")], { conversation: MEMORY_CURATOR_CONVERSATION, time: time(10, 10, 1) }).message.id;
    postMessage(t.store, [text("任务「整理发票」完成了")], { speaker: "system", time: time(10, 11) });
    const toNotice = postMessage(t.store, [text("辛苦")], { time: time(10, 11, 1) }).message.id;
    postMessage(t.store, [{ type: "card_ref", cardId: "c-9" }], { speaker: "agent", time: time(10, 12) });
    const toCard = postMessage(t.store, [text("先不用")], { time: time(10, 12, 1) }).message.id;

    expect(precedingOf(t.store, materialOf(t, toOwner))?.by).toBe("负责人");
    expect(precedingOf(t.store, materialOf(t, toCurator))?.by).toBe("记忆管理员");
    expect(precedingOf(t.store, materialOf(t, toNotice))?.by).toBe("通知");
    expect(precedingOf(t.store, materialOf(t, toCard), (id) => (id === "c-9" ? "建议发起任务：每周整理一次相册" : undefined))).toMatchObject({
      by: "卡片",
      text: "［卡片］建议发起任务：每周整理一次相册",
    });
  });
});

describe("判和记下", () => {
  it("接着回的挂上前文的总结，新话题、会话第一句不挂；结果是一条 material_replies，素材上标着、读成证据时原文后面接前文那一行", async () => {
    const t = materialsSetup();
    const opener = postMessage(t.store, [text("周末想出去走走")], { time: time(10, 9) }).message.id;
    postMessage(t.store, [text("要不要约老周周六一起爬香山？")], { speaker: "agent", time: time(10, 9, 1) });
    const reply = postMessage(t.store, [text("好，就这么办")], { time: time(10, 15) }).message.id;
    postMessage(t.store, [text("好的，我跟老周说。")], { speaker: "agent", time: time(10, 15, 1) });
    const topic = postMessage(t.store, [text("对了，我下个月要换工作")], { time: time(10, 16) }).message.id;
    const { model, calls } = judge({ replies: { "好，就这么办": "秘书提议周六约老周一起去爬香山" }, topics: ["对了，我下个月要换工作"] });

    const run = await judgeMaterialReplies({ store: t.store, materials: t.materials, chat: model, clock: t.clock });
    expect(run.report).toMatchObject({ calls: 1, attached: 1, newTopic: 1, first: 1, failed: 0, pending: 0 });
    expect(calls[0]!.purpose).toBe("reply_context");
    // 第一句不问模型
    expect(calls[0]!.user).not.toContain("周末想出去走走");

    expect(materialOf(t, reply).reply).toEqual({ summary: "秘书提议周六约老周一起去爬香山", fromMessageId: expect.any(String) });
    expect(materialOf(t, topic).reply).toBeUndefined();
    expect(materialOf(t, opener).reply).toBeUndefined();
    expect([...t.materials.replyJudged()].toSorted()).toEqual([opener, reply, topic].map((id) => materialOf(t, id).id).toSorted());
    const verdicts = replyEvents(t).flatMap((e) => (e.payload as MaterialRepliesEventPayload).items.map((i) => i.verdict));
    expect(verdicts.toSorted()).toEqual(["first", "new_topic", "reply"]);

    // 读成证据：前文一行跟在用户的话后面
    const draft = evidenceDraftOf(materialOf(t, reply))!;
    expect(draft.text).toBe(`好，就这么办\n${REPLY_CONTEXT_PREFIX}秘书提议周六约老周一起去爬香山`);
    // 判过的不再判
    const again = await judgeMaterialReplies({ store: t.store, materials: t.materials, chat: model, clock: t.clock });
    expect(again.report.calls).toBe(0);
  });

  it("每晚有上限：新的先判，超了的留到下一夜；同一夜再跑一次也不超；没判出来的不记、下一夜再判", async () => {
    const t = materialsSetup();
    const ids: string[] = [];
    for (let i = 1; i <= 4; i++) {
      postMessage(t.store, [text(`第 ${i} 个问题？`)], { speaker: "agent", time: time(10, 8 + i) });
      ids.push(postMessage(t.store, [text(`回答 ${i}`)], { time: time(10, 8 + i, 5) }).message.id);
    }
    t.clock.jumpTo(new Date("2026-10-11T03:00:00+08:00"));
    const replies = { "回答 1": "秘书问第 1 个问题", "回答 2": "秘书问第 2 个问题", "回答 4": "秘书问第 4 个问题" };
    const first = await judgeMaterialReplies({ store: t.store, materials: t.materials, chat: judge({ replies }).model, clock: t.clock, limit: 2 });
    // 新的先判：4、3 交给了模型（3 没判出来），1、2 留到下一夜
    expect(first.report).toMatchObject({ attached: 1, failed: 1, pending: 2 });
    expect(materialOf(t, ids[3]!).reply?.summary).toBe("秘书问第 4 个问题");
    expect(t.materials.replyJudged().has(materialOf(t, ids[2]!).id)).toBe(false);
    expect([...first.tried]).toEqual([ids[3]!, ids[2]!].map((id) => materialOf(t, id).id));
    // 没判出来的（交给过模型）读成证据时不压着；没轮到的新近几条压着
    const held = replyHeldBack(t.materials.replyJudged(), clockIso(t.clock), first.tried);
    expect(ids.map((id) => held(materialOf(t, id)))).toEqual([true, true, false, false]);

    // 同一夜再跑：这一夜已经交了两句，不再判
    const sameNight = await judgeMaterialReplies({ store: t.store, materials: t.materials, chat: judge({ replies }).model, clock: t.clock, limit: 2 });
    expect(sameNight.report).toMatchObject({ calls: 0, pending: 3 });

    // 下一夜接着判（3 再试一次，这次模型判出来了）
    t.clock.jumpTo(new Date("2026-10-12T03:00:00+08:00"));
    const next = await judgeMaterialReplies({ store: t.store, materials: t.materials, chat: judge({ replies: { ...replies, "回答 3": "秘书问第 3 个问题" } }).model, clock: t.clock, limit: 2 });
    expect(next.report).toMatchObject({ attached: 2, pending: 1 });
    expect(materialOf(t, ids[2]!).reply?.summary).toBe("秘书问第 3 个问题");
  });

  it("模型写长了截到 80 字；别推断的、访谈里的、数据源的不判", async () => {
    const t = materialsSetup();
    postMessage(t.store, [text("要不要把周报改成每周五下午发？")], { speaker: "agent", time: time(10, 9) });
    const long = postMessage(t.store, [text("行")], { time: time(10, 9, 1) }).message.id;
    await judgeMaterialReplies({ store: t.store, materials: t.materials, chat: judge({ replies: { 行: "秘书".repeat(60) } }).model, clock: t.clock });
    const summary = materialOf(t, long).reply!.summary;
    expect([...summary]).toHaveLength(80);
    expect(summary.endsWith("…")).toBe(true);

    const m = materialOf(t, long);
    expect(isReplyCandidate({ ...m, noInfer: true })).toBe(false);
    expect(isReplyCandidate({ ...m, origin: { dataSource: "gmail", scene: {}, sensitive: [] } })).toBe(false);
    expect(isReplyCandidate({ ...m, segments: [{ form: "agent_output", source: "agent", notes: [], locator: { field: "interviewQuestion" }, label: "记忆管理员问：x" }, ...m.segments] })).toBe(false);
  });
});

/** 一句接着秘书的问题回的话，判好、挂上前文 */
async function replied(t: Setup) {
  postMessage(t.store, [text("周五晚上的爵士音乐会，你一直很喜欢爵士乐，要我订两张票吗？")], { speaker: "agent", time: time(10, 9) });
  const id = postMessage(t.store, [text("周五不行，那天要加班")], { time: time(10, 9, 3) }).message.id;
  await judgeMaterialReplies({ store: t.store, materials: t.materials, chat: judge({ replies: { "周五不行，那天要加班": "秘书说用户喜欢爵士乐，问要不要订周五的音乐会票" } }).model, clock: t.clock });
  return materialOf(t, id);
}

describe("可重建、跟着删除走", () => {
  it("materials.db 删掉重建后前文还在（照事件派生，不进原文副本）", async () => {
    const t = materialsSetup();
    const m = await replied(t);
    expect(m.reply?.summary).toBe("秘书说用户喜欢爵士乐，问要不要订周五的音乐会票");
    expect(JSON.stringify(t.materials.readOriginal(m))).not.toContain("爵士乐");
    await t.reopen({ deleteMaterialsDb: true });
    expect(t.materials.get(m.id)?.reply?.summary).toBe("秘书说用户喜欢爵士乐，问要不要订周五的音乐会票");
    expect(t.materials.replyJudged().has(m.id)).toBe(true);
  });

  it("忘掉：挂的前文跟着走，重建也不回来", async () => {
    const t = materialsSetup();
    const m = await replied(t);
    const from: DeleteCommandPayload["from"] = { kind: "settings", scope: { kind: "material", materialId: m.id } };
    t.store.append({ channel: MATERIALS_CHANNEL, type: EVENT_TYPES.memoryCommand, payload: { commandId: "mc-1", command: "forget", materialIds: [m.id], from } as MemoryCommandEventPayload });
    expect(t.materials.get(m.id)).toBeUndefined();
    expect(t.materials.replyJudged().has(m.id)).toBe(false);
    await t.reopen({ deleteMaterialsDb: true });
    expect(t.materials.get(m.id)).toBeUndefined();
    expect(t.materials.replyJudged().has(m.id)).toBe(false);
  });

  it("别推断：素材留着、前文还挂着，但整条不读成证据", async () => {
    const t = materialsSetup();
    const m = await replied(t);
    t.store.append({ channel: MATERIALS_CHANNEL, type: EVENT_TYPES.memoryCommand, payload: { commandId: "mc-2", command: "no_infer", materialIds: [m.id], from: { kind: "settings", scope: { kind: "material", materialId: m.id } } } as MemoryCommandEventPayload });
    expect(t.materials.get(m.id)?.noInfer).toBe(true);
    expect(evidenceDraftOf(t.materials.get(m.id)!)).toBeUndefined();
  });

  it("彻底删除：判它的那条事件里这一项的总结换成删除标记（别的项不动），重建后不挂", async () => {
    const t = materialsSetup();
    const m = await replied(t);
    // 同一条事件里另一条素材的判定（不该被改）
    t.store.append({ channel: MATERIALS_CHANNEL, type: EVENT_TYPES.materialReplies, payload: { night: "2026-10-08", items: [{ materialId: m.id, conversation: CHANNELS.secretary, verdict: "reply", summary: "秘书说用户喜欢爵士乐，问要不要订周五的音乐会票" }, { materialId: "mat-other", conversation: CHANNELS.secretary, verdict: "reply", summary: "秘书问别的事" }] } satisfies MaterialRepliesEventPayload });
    // 彻底删除那一套按素材 id 找到判它的事件（purgePlan 找的那几条另有用例），这里照改写函数改
    const context = { deletedAt: time(11, 10), materialIds: new Set([m.id]) };
    const purge = replyEvents(t).map((event) => ({ globalSeq: event.globalSeq, payload: materialRepliesPurge.rewrite(event, context) }));
    const command: MemoryCommandEventPayload = { commandId: "mc-3", command: "purge", materialIds: [m.id], from: { kind: "settings", scope: { kind: "material", materialId: m.id } } };
    t.store.appendBatch([{ channel: MATERIALS_CHANNEL, type: EVENT_TYPES.memoryCommand, payload: command }], { purge });

    const events = replyEvents(t).filter((e) => !isDeletedEventPayload(e.payload));
    expect(JSON.stringify(events.map((e) => e.payload))).not.toContain("爵士乐");
    expect(JSON.stringify(events.map((e) => e.payload))).toContain(PURGED_TEXT);
    expect(JSON.stringify(events.map((e) => e.payload))).toContain("秘书问别的事");
    await t.reopen({ deleteMaterialsDb: true });
    expect(t.materials.get(m.id)).toBeUndefined();
  });

  it("彻底删除那一套按素材 id 找到判它的事件（没登记改写函数的整个拒删）", () => {
    const root = makeTempDir("ergo-reply-purge-plan-");
    const store = openEventStore({ file: path.join(root, "ergo.db"), views: [...conversationViews, cardsView, toolCallDetailsView] });
    onTestFinished(() => store.close());
    const cards = createCardService({ store, registry: new CardTypeRegistry(), now: () => time(11, 10) });
    const material = { id: "mat-reply", kind: "user_utterance", ref: { event: { globalSeq: 999, channel: CHANNELS.secretary, seq: 999, type: EVENT_TYPES.message } } } as unknown as Material;
    const { event } = store.append({ channel: MATERIALS_CHANNEL, type: EVENT_TYPES.materialReplies, payload: { night: "2026-10-10", items: [{ materialId: "mat-reply", conversation: CHANNELS.secretary, verdict: "reply", summary: "秘书问周六去不去爬山" }] } satisfies MaterialRepliesEventPayload });
    store.append({ channel: MATERIALS_CHANNEL, type: EVENT_TYPES.materialReplies, payload: { night: "2026-10-10", items: [{ materialId: "mat-else", conversation: CHANNELS.secretary, verdict: "first" }] } satisfies MaterialRepliesEventPayload });
    expect(() => purgePlan({ store, cards, rewriters: new PurgeRewriters() }, [material])).toThrow(/没有登记改写函数/);
    const rewriters = new PurgeRewriters();
    rewriters.register(materialRepliesPurge);
    const plan = purgePlan({ store, cards, rewriters }, [material]);
    expect(plan.purge.map((p) => p.globalSeq)).toEqual([event.globalSeq]);
    expect((plan.purge[0]!.payload as MaterialRepliesEventPayload).items[0]!.summary).toBe(PURGED_TEXT);
  });

  it("删任务连负责人会话一起删：那个会话里挂的前文撤掉（判它的事件里换成删除标记、追加一条 cleared），话本身作为素材留着；重建后也不挂", async () => {
    const t = materialsSetup();
    const owner = maintainerChannel("tm-7");
    postMessage(t.store, [text("第一章写完了，下一章写客户访谈还是竞品分析？")], { conversation: owner, speaker: "agent", time: time(10, 9) });
    const said = postMessage(t.store, [text("先写竞品")], { conversation: owner, time: time(10, 9, 2), taskId: "t-7" }).message.id;
    await judgeMaterialReplies({ store: t.store, materials: t.materials, chat: judge({ replies: { 先写竞品: "负责人问下一章先写客户访谈还是竞品分析" } }).model, clock: t.clock });
    const m = materialOf(t, said);
    expect(m.reply?.summary).toBe("负责人问下一章先写客户访谈还是竞品分析");

    const rewriters = new PurgeRewriters();
    const participants = new DeletionParticipants({ store: t.store, cards: t.cards, rewriters });
    registerMaterialsDeletion(participants, { store: t.store, cards: t.cards, rewriters, materials: () => t.materials.list(), internalRecords: () => [] });
    const result = participants.plan(TASK_DELETION, { task: { id: "t-7" } as Task, conversation: owner, agents: new Set(["tm-7"]) }, { deletedAt: time(11, 10), materialIds: new Set() });
    t.store.appendBatch(result.events, { purge: result.purge });

    expect(t.materials.get(m.id)?.reply).toBeUndefined();
    expect(t.materials.get(m.id)).toBeDefined();
    const payloads = replyEvents(t).map((e) => e.payload as MaterialRepliesEventPayload);
    expect(JSON.stringify(payloads)).not.toContain("客户访谈");
    expect(payloads.at(-1)!.items).toEqual([{ materialId: m.id, conversation: owner, verdict: "cleared" }]);
    await t.reopen({ deleteMaterialsDb: true });
    expect(t.materials.get(m.id)?.reply).toBeUndefined();
    expect(t.materials.replyJudged().has(m.id)).toBe(true);
  });
});

describe("读成证据", () => {
  it("还没判的新近几条先不读，判过的带着前文读；场景只从用户自己的话推（前文里的\"上班\"不算）", async () => {
    const t = materialsSetup();
    postMessage(t.store, [text("明天上班要不要早点叫你？")], { speaker: "agent", time: time(10, 21) });
    const id = postMessage(t.store, [text("嗯")], { time: time(10, 21, 1) }).message.id;
    t.clock.jumpTo(new Date("2026-10-11T03:00:00+08:00"));
    const source = (judged: ReadonlySet<string>) => new MaterialsEvidenceSource({ materials: t.materials, clock: t.clock, holdBack: replyHeldBack(judged, clockIso(t.clock)) });
    expect(source(t.materials.replyJudged()).read()).toEqual([]);

    await judgeMaterialReplies({ store: t.store, materials: t.materials, chat: judge({ replies: { 嗯: "秘书问明天上班要不要早点叫用户起床" } }).model, clock: t.clock });
    const drafts = source(t.materials.replyJudged()).read();
    expect(drafts.map((d) => d.text)).toEqual([`嗯\n${REPLY_CONTEXT_PREFIX}秘书问明天上班要不要早点叫用户起床`]);
    expect(drafts[0]!.context).toEqual([]);
    expect(materialOf(t, id).reply).toBeDefined();
  });
});

describe("整理一夜（每晚整理之前先判）", () => {
  it("接着秘书的话回的一句：整理之前判出前文、带着前文读成证据；前文里\"秘书说用户喜欢爵士乐\"，就算模型照前文抽，整理后也没有\"用户喜欢爵士乐\"；判的那次算进这一夜的调用、从预算里先扣", async () => {
    const t = materialsSetup();
    postMessage(t.store, [text("周五晚上有爵士音乐会，你一直很喜欢爵士乐，要我订两张票吗？")], { speaker: "agent", time: "2026-10-08T09:00:00.000+08:00" });
    const said = postMessage(t.store, [text("周五不行，那天要加班")], { time: "2026-10-08T15:30:00.000+08:00" }).message.id;
    t.clock.jumpTo(new Date("2026-10-09T03:00:00+08:00"));
    const purposes: string[] = [];
    const chat = () =>
      new FakeChatModel((request) => {
        purposes.push(request.purpose);
        if (request.purpose === "reply_context") return { items: [{ id: "r1", reply: true, summary: "秘书说用户一直很喜欢爵士乐，问要不要订周五爵士音乐会的票" }] };
        if (request.purpose !== "extract") return {};
        const id = /"evidence_id":"(ev-[^"]+)"/.exec(request.user)![1];
        return {
          facts: [
            { evidence_id: id, predicate: "prefers", object: { name: "爵士乐", type: "activity" }, negated: false, statement: "用户喜欢爵士乐", change: false, correction: false, span: "很喜欢爵士乐" },
            { evidence_id: id, predicate: "declined", object: { name: "周五的音乐会", type: "event" }, negated: false, statement: "用户周五要加班，推掉了音乐会", change: false, correction: false, span: "周五不行，那天要加班" },
          ],
        };
      });
    const file = path.join(t.root, "rg.db");
    const job = createMemoryNightlyJob({
      file,
      materials: t.materials,
      clock: t.clock,
      store: t.store,
      inbox: { get: () => undefined, add: () => ({}) as never },
      config: { maxModelCalls: 50, extractor: "model", sensitiveCategories: [], enabled: true, nightlyTimeoutMinutes: 60, curator: { maxModelCalls: 8 } },
      chat,
      replyContext: { store: t.store, judged: () => t.materials.replyJudged() },
    });
    onTestFinished(async () => {
      job.abort();
      await job.whenIdle();
    });
    const record = (await job.run("scheduled", new AbortController().signal)) as MemoryNightlyRecord;
    expect(record.state).toBe("ran");
    expect(purposes[0]).toBe("reply_context");
    expect(record.replyContext).toEqual({ calls: 1, attached: 1, newTopic: 0, first: 0, failed: 0, pending: 0 });
    expect(record.modelCalls).toBeGreaterThanOrEqual(2);
    expect(t.store.read(INTERNAL_CHANNEL).length).toBeGreaterThan(0);
    expect(materialOf(t, said).reply?.summary).toBe("秘书说用户一直很喜欢爵士乐，问要不要订周五爵士音乐会的票");

    const db = openDatabase(file);
    try {
      const evidence = db.all<{ text: string }>("SELECT text FROM evidence");
      expect(evidence.map((e) => e.text)).toEqual([`周五不行，那天要加班
${REPLY_CONTEXT_PREFIX}秘书说用户一直很喜欢爵士乐，问要不要订周五爵士音乐会的票`]);
      const facts = db.all<{ statement: string }>("SELECT statement FROM facts").map((f) => f.statement);
      expect(facts).toEqual(["用户周五要加班，推掉了音乐会"]);
      expect(JSON.stringify(db.all("SELECT * FROM claims"))).not.toContain("爵士乐");
    } finally {
      db.close();
    }
  });
});

describe("推理库里带着前文的证据", () => {
  it("前文所在的会话删了（cleared）：带着前文的证据撤掉、下一夜不带前文重读；没带前文的不动；启动时补做一遍也一样（幂等）", () => {
    const t = materialsSetup();
    const file = path.join(t.root, "rg.db");
    const opened = openReasoningDb({ file, clock: () => clockIso(t.clock), model: "deepseek-flash" });
    if (!opened.ok) throw new Error("推理库打不开");
    opened.engine.ingestEvidence({ sourceLevel: "self", mode: "say", kind: "utterance", text: `先写竞品
${REPLY_CONTEXT_PREFIX}负责人问下一章先写什么`, context: [], eventTime: time(10, 9), observedAt: time(10, 9), sourceRef: "mat-a" });
    opened.engine.ingestEvidence({ sourceLevel: "self", mode: "say", kind: "utterance", text: "周末想出去走走", context: [], eventTime: time(10, 9), observedAt: time(10, 9), sourceRef: "mat-b" });
    opened.engine.close();
    const purge = createReasoningPurge({ file, store: t.store, clock: t.clock, config: { maxModelCalls: 200, extractor: "model", sensitiveCategories: [], enabled: true, nightlyTimeoutMinutes: 60, curator: { maxModelCalls: 8 } } });
    const stop = purge.start();
    onTestFinished(stop);
    t.store.append({ channel: MATERIALS_CHANNEL, type: EVENT_TYPES.materialReplies, payload: { night: "2026-10-11", items: [{ materialId: "mat-a", conversation: maintainerChannel("tm-7"), verdict: "cleared" }, { materialId: "mat-b", conversation: CHANNELS.secretary, verdict: "cleared" }] } satisfies MaterialRepliesEventPayload });
    const left = () => {
      const db = openDatabase(file);
      try {
        return db.all<{ source_ref: string; text: string }>("SELECT source_ref, text FROM evidence").map((r) => r.source_ref);
      } finally {
        db.close();
      }
    };
    expect(left()).toEqual(["mat-b"]);
    purge.reconcile();
    expect(left()).toEqual(["mat-b"]);
  });
});
