// 主切面：快速动作（规格第 9 节"快速动作的确认"、第 14 节）。秘书接 faux 剧本，用"提议快速动作"工具写清做什么、对谁做：
// - "明确点了"由运行时判定，每个执行器自己声明：记住要求触发词前面没有否定词、内容和触发词后面到句末的那一段一致
//   （或者那一段只是指代、内容在引用块或引用的卡片里）；替身动作要求对象和内容原样出现在用户这条消息（或引用的卡片）里。
//   点明了的卡片出来就是"已执行"；
// - 否则按推断处理：动作作为伪工具调用交给守卫的类别匹配（内置类别、用户的自定义类别），"先问我"时卡片带确认按钮、
//   同时进待我处理，点确认后才执行；
// - 每次执行是会话频道上的一条操作记录；执行不拉起任何 agent，任务看板不变。
// 第一种动作是记忆命令"记住"；按类别判处置用测试里登记的替身动作（发消息、整理笔记）。
import {
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  type InboxItem,
  type InboxItemEventPayload,
  type MessageEventPayload,
  type MessagePart,
  type QuickActionExecutedEventPayload,
} from "@ergou/protocol";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { FauxStep } from "../../src/runtime/index.ts";
import { suggestTaskFixture } from "../helpers/card-fixtures.ts";
import { countAgentSpawns, startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { sendNoteFixture, tidyNoteFixture } from "../helpers/quick-action-fixtures.ts";

const { secretary: SECRETARY, cards: CARDS, inbox: INBOX, board: BOARD } = CHANNELS;
const ALL = { [SECRETARY]: 0, [CARDS]: 0, [INBOX]: 0, [BOARD]: 0 };

const propose = (type: string, params: Record<string, unknown>, extra: Record<string, unknown> = {}): FauxStep => ({
  kind: "reply",
  toolCalls: [{ name: "propose_quick_action", arguments: { type, params, ...extra } as never }],
});

async function setup(secretary: FauxStep[], options: { cardTypes?: boolean } = {}) {
  const test = await startTestDaemon({ secretary, quickActions: [sendNoteFixture, tidyNoteFixture], ...(options.cardTypes ? { cardTypes: [suggestTaskFixture] } : {}) });
  const frontend = await TestFrontend.connect(test.url);
  await frontend.subscribe(ALL);
  // 秘书已经拉起；从这里起数拉起了几个 agent
  const spawned = countAgentSpawns(test.daemon);
  return { ...test, frontend, spawned };
}

/** 用户说一句话（可以带引用的卡片），等秘书这一轮结束 */
async function tell(frontend: TestFrontend, text: string, quoted: string[] = []) {
  const parts: MessagePart[] = [...quoted.map((cardId): MessagePart => ({ type: "card_ref", cardId })), { type: "text", text }];
  const sent = await frontend.sendParts(parts);
  await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
  return sent;
}

const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
const latestCard = (frontend: TestFrontend, id: string): Card => cardsOf(frontend).filter((c) => c.id === id).at(-1)!;
const executions = (frontend: TestFrontend) => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.quickActionExecuted }).map((f) => f.payload as QuickActionExecutedEventPayload);
const inboxItems = (frontend: TestFrontend): InboxItem[] => frontend.events({ channel: INBOX, type: EVENT_TYPES.inboxItem }).map((f) => (f.payload as InboxItemEventPayload).item);
/** 卡片的状态、点没点明、处置 */
const cardState = (c: Card) => {
  const p = c.payload as { explicit: boolean; disposition: string };
  return [c.status, p.explicit, p.disposition];
};
/** 秘书最后一条回复（echo_context 回显的上下文） */
const lastReply = (frontend: TestFrontend): string =>
  (frontend.events({ channel: SECRETARY, type: EVENT_TYPES.message }).at(-1)!.payload as MessageEventPayload).message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");

describe("用户明确点了对象和内容", () => {
  it("\"记住……\"：卡片只展示规范化后的动作、直接执行，聊天里留\"已执行\"卡；操作记录在会话频道上；作为显式记忆命令素材入库；不拉起 agent，看板不变", async () => {
    const { frontend, daemon, spawned } = await setup([propose("remember", { content: "下周三上午体检" }), { kind: "echo_context" }]);
    const sent = await tell(frontend, "记住：下周三上午体检。");

    const messages = frontend.events({ channel: SECRETARY, type: EVENT_TYPES.message }).map((f) => (f.payload as MessageEventPayload).message);
    // 用户的话、"已执行"卡、这次工具调用的记录（07 的守卫接入：提议快速动作只产生卡片，不落入任何类别，直接做）、秘书的回复
    expect(messages.map((m) => `${m.speaker}:${m.parts.map((p) => p.type).join(",")}`)).toEqual(["user:text", "agent:card_ref", "agent:tool_call", "agent:text"]);
    expect(messages[2]!.parts[0]).toMatchObject({ type: "tool_call", tool: "propose_quick_action", categoryTitles: [], disposition: "do", outcome: "done" });
    const [card, ...others] = cardsOf(frontend);
    expect(others).toEqual([]);
    expect(messages[1]!.parts).toEqual([{ type: "card_ref", cardId: card!.id }]);
    expect(card).toMatchObject({
      type: "quick_action",
      status: "handled",
      outcome: { action: "execute" },
      payload: { action: { type: "remember", params: { content: "下周三上午体检" } }, name: "记住", title: "记住：下周三上午体检", content: "下周三上午体检", explicit: true },
    });
    expect((card!.payload as { result?: string }).result).toBeTruthy();
    // 不进待我处理
    expect(inboxItems(frontend)).toEqual([]);

    // 操作记录：动作类型、规范化后的动作、结果、对应的卡片
    expect(executions(frontend)).toEqual([
      {
        actionId: (card!.payload as { actionId: string }).actionId,
        action: { type: "remember", params: { content: "下周三上午体检" } },
        name: "记住",
        title: "记住：下周三上午体检",
        explicit: true,
        cardId: card!.id,
        result: { ok: true, summary: expect.any(String) },
      },
    ]);

    // 显式记忆命令素材：用户自己的话
    expect(daemon.materials.list({ kind: "memory_command" })).toMatchObject([
      { source: "self", conversation: SECRETARY, segments: [{ form: "typed", source: "self", text: "下周三上午体检" }], ref: { cardId: card!.id } },
    ]);
    expect(daemon.materials.searchKeyword("上午体检").map((m) => m.kind).toSorted()).toEqual(["memory_command", "user_utterance"]);
    // 秘书看到的工具结果：已执行
    expect(lastReply(frontend)).toContain("[toolResult] propose_quick_action: 已执行：记住：下周三上午体检");
    expect(sent.messageId).toBeTruthy();

    expect(spawned()).toBe(0);
    expect(frontend.events({ channel: BOARD })).toEqual([]);
  });

  it("对象和内容在用户引用的卡片里：同样算点明了，直接执行", async () => {
    const { frontend, daemon } = await setup([propose("send_note", { to: "张三", text: "周报改到周五交" }), { kind: "reply", text: "发了" }], { cardTypes: true });
    const quoted = daemon.cards.create({ type: "suggest_task", payload: { title: "周报改到周五交", why: "张三问过" } });
    await tell(frontend, "把这个告诉张三", [quoted.id]);
    const card = cardsOf(frontend).find((c) => c.type === "quick_action")!;
    expect(card).toMatchObject({ status: "handled", payload: { explicit: true, target: "张三", content: "周报改到周五交" } });
    expect(executions(frontend)).toHaveLength(1);
  });

  it("\"记住这个\"加引用块、加引用的卡片：内容和引用块（或卡片上的一段）一致也算点明；素材的来源分别是外部不可信、用户的选择", async () => {
    const { frontend, daemon } = await setup(
      [propose("remember", { content: "医生说少吃辣" }), { kind: "reply", text: "记下了" }, propose("remember", { content: "每周三晚上去游泳" }), { kind: "reply", text: "记下了" }],
      { cardTypes: true },
    );
    await tell(frontend, "记住这个：\n> 医生说少吃辣");
    const quoted = daemon.cards.create({ type: "suggest_task", payload: { title: "每周三晚上去游泳", why: "你说想锻炼" } });
    await tell(frontend, "记住这条", [quoted.id]);

    expect(cardsOf(frontend).filter((c) => c.type === "quick_action").map((c) => [c.status, (c.payload as { explicit: boolean }).explicit])).toEqual([
      ["handled", true],
      ["handled", true],
    ]);
    expect(daemon.materials.list({ kind: "memory_command" })).toMatchObject([
      { segments: [{ form: "quote", source: "external_untrusted" }] },
      { segments: [{ form: "choice", source: "self", notes: ["agent_proposed"], text: "每周三晚上去游泳" }] },
    ]);
  });
});

describe("\"记住\"不算点明的", () => {
  it("\"别记住……\"（触发词前面有否定词）、触发词后面那一段和内容对不上：都按推断处理，出确认卡、不入库", async () => {
    const { frontend, daemon } = await setup([
      propose("remember", { content: "我的银行卡密码是 123" }, { explicit: true }),
      { kind: "reply", text: "等你确认" },
      propose("remember", { content: "周五交房租" }),
      { kind: "reply", text: "等你确认" },
    ]);
    await tell(frontend, "别记住：我的银行卡密码是 123");
    await tell(frontend, "记住：周五交房租，别忘了");
    expect(cardsOf(frontend).map(cardState)).toEqual([
      ["pending", false, "ask_first"],
      ["pending", false, "ask_first"],
    ]);
    expect(executions(frontend)).toEqual([]);
    expect(daemon.materials.list({ kind: "memory_command" })).toEqual([]);
  });
});

describe("秘书推断出来的", () => {
  it("收件人不在用户消息里：按\"以我的名义对外发送\"在对话里先问——卡片带确认按钮、进待我处理；秘书自称\"用户点明了\"不作数；点执行后才执行", async () => {
    const { frontend, spawned } = await setup([propose("send_note", { to: "李四", text: "周报改到周五交" }, { explicit: true }), { kind: "echo_context" }]);
    await tell(frontend, "周报改到周五交，跟大家说一声");

    const [card] = cardsOf(frontend);
    expect(card).toMatchObject({
      type: "quick_action",
      status: "pending",
      payload: { explicit: false, target: "李四", content: "周报改到周五交", disposition: "ask_first", categories: ["以我的名义对外发送或发布"] },
    });
    expect(executions(frontend)).toEqual([]);
    const item = inboxItems(frontend).at(-1)!;
    expect(item).toMatchObject({ kind: "card", cardId: card!.id, urgency: "non_blocking" });
    expect(lastReply(frontend)).toContain("[toolResult] propose_quick_action: 等用户确认");

    const ack = await frontend.cardAction({ cardId: card!.id, action: "execute", expectedVersion: card!.version });
    expect(ack.ok).toBe(true);
    await frontend.next(SECRETARY, EVENT_TYPES.quickActionExecuted);
    expect(latestCard(frontend, card!.id)).toMatchObject({ status: "handled", outcome: { action: "execute" }, payload: { result: "已发给李四（测试替身，没有真的发）" } });
    expect(executions(frontend)).toMatchObject([{ cardId: card!.id, explicit: false, action: { type: "send_note", params: { to: "李四", text: "周报改到周五交" } }, result: { ok: true } }]);
    expect(spawned()).toBe(0);
    expect(frontend.events({ channel: BOARD })).toEqual([]);
  });

  it("不落入任何类别的动作推断出来也直接做；\"记住\"推断出来的一律先问，确认后记成秘书提出、用户确认的", async () => {
    const { frontend, daemon } = await setup([propose("tidy_note", { title: "装修预算" }), propose("remember", { content: "对青霉素过敏" }), { kind: "reply", text: "好" }]);
    await tell(frontend, "整理一下那条笔记，另外我好像青霉素过敏");
    const [tidy, remember] = cardsOf(frontend);
    expect(tidy).toMatchObject({ payload: { action: { type: "tidy_note" }, explicit: false, disposition: "do" }, status: "handled" });
    expect(remember).toMatchObject({ payload: { action: { type: "remember" }, explicit: false, disposition: "ask_first" }, status: "pending" });
    expect(daemon.materials.list({ kind: "memory_command" })).toEqual([]);

    expect(executions(frontend).map((e) => e.action.type)).toEqual(["tidy_note"]);
    await frontend.cardAction({ cardId: remember!.id, action: "execute", expectedVersion: 1 });
    await frontend.next(SECRETARY, EVENT_TYPES.quickActionExecuted);
    expect(executions(frontend).map((e) => e.action.type)).toEqual(["tidy_note", "remember"]);
    expect(daemon.materials.list({ kind: "memory_command" })).toMatchObject([{ segments: [{ form: "choice", notes: ["agent_proposed"], text: "对青霉素过敏" }] }]);
  });

  it("按钮带幂等键：同一请求重发只执行一次、只有一条操作记录；两个前端同时点，先到先得，后到的得到\"已被处理\"", async () => {
    const { frontend, url } = await setup([propose("send_note", { to: "王五", text: "明天见" }), { kind: "reply", text: "等你确认" }]);
    const other = await TestFrontend.connect(url);
    await other.subscribe(ALL);
    await tell(frontend, "跟他说明天见");
    const [card] = cardsOf(frontend);

    const [a, b] = await Promise.all([
      frontend.cardAction({ cardId: card!.id, action: "execute", expectedVersion: 1 }, "same-key"),
      other.cardAction({ cardId: card!.id, action: "execute", expectedVersion: 1 }, "other-key"),
    ]);
    const results = [a, b].map((r) => (r.ok ? "ok" : r.error.code));
    expect(results.toSorted()).toEqual(["conflict", "ok"]);
    expect([a, b].find((r) => !r.ok)).toMatchObject({ error: { message: "已被处理" } });
    // 赢了的那个请求原样重发：拿到同一个 ack
    const [winner, sender, key] = a.ok ? [a, frontend, "same-key"] : [b, other, "other-key"];
    const again = await sender.cardAction({ cardId: card!.id, action: "execute", expectedVersion: 1 }, key);
    expect(again).toMatchObject({ ok: true, result: (winner as { result: unknown }).result });
    await frontend.next(SECRETARY, EVENT_TYPES.quickActionExecuted);
    expect(executions(frontend)).toHaveLength(1);
  });

  it("用户的自定义关注类别也管快速动作：动作作为伪工具调用 quick_action:<类型> 交给类别匹配，处置取最严", async () => {
    const { frontend, dataDir } = await setup([
      propose("tidy_note", { title: "装修预算" }),
      { kind: "reply", text: "等你确认" },
      propose("send_note", { to: "老板", text: "我请假" }),
      { kind: "echo_context" },
    ]);
    const custom = {
      custom: [
        { id: "tidy_first", title: "整理笔记先问我", match: { tools: ["quick_action:tidy_note"] }, chat: "ask_first", task: "ask_first" },
        { id: "boss", title: "给老板发的", match: { recipients: ["老板"] }, chat: "hand_over", task: "hand_over" },
      ],
    };
    fs.writeFileSync(path.join(dataDir, "config", "watch-categories.json"), JSON.stringify(custom));
    await tell(frontend, "整理一下那条笔记");
    // 不落入任何内置类别的动作，命中了自定义类别：先问
    expect(cardsOf(frontend)).toMatchObject([{ status: "pending", payload: { action: { type: "tidy_note" }, disposition: "ask_first", categories: ["整理笔记先问我"] } }]);
    // 收件人命中"交给我做"的自定义类别：比内置类别的"先问我"更严，不出卡，告诉秘书原因
    await tell(frontend, "帮我请个假");
    expect(cardsOf(frontend)).toHaveLength(1);
    expect(lastReply(frontend)).toMatch(/\[toolResult\] propose_quick_action: 「发给老板：我请假」不能作为快速动作执行：交给我做/);
  });

  it("参数不合这种动作自带的 schema：不出卡，工具把哪里不对告诉模型", async () => {
    const { frontend } = await setup([propose("remember", { text: "下周三体检" }), { kind: "echo_context" }]);
    await tell(frontend, "记住下周三体检");
    expect(cardsOf(frontend)).toEqual([]);
    expect(lastReply(frontend)).toMatch(/\[toolResult\] propose_quick_action: 参数不对：/);
  });

  it("动作类型没在执行器注册表里登记：不出卡，工具向模型返回错误", async () => {
    const { frontend } = await setup([propose("book_flight", { to: "东京", date: "下周一" }), { kind: "echo_context" }]);
    await tell(frontend, "订下周一去东京的机票");
    expect(cardsOf(frontend)).toEqual([]);
    expect(executions(frontend)).toEqual([]);
    expect(lastReply(frontend)).toMatch(/\[toolResult\] propose_quick_action: 没有登记这种快速动作：book_flight/);
  });
});
