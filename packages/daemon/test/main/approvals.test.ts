// 主切面：守卫问用户与批准（规格第 9 节"审批流程""交给我做"）。秘书接 faux 剧本：
// - 读草稿区外的文件、bash 碰到草稿区外的路径，守卫判"越出项目目录"、在对话里就是先问用户：守护进程先写审批表，
//   再在聊天和待我处理里出一张审批卡（同一张卡，状态同步）。用户批准 → 这次调用接着执行；拒绝 → 拦下，模型收到"用户拒绝"；
// - 子进程里这次调用最多等 5 分钟（时钟可注入）：超时以"已提交审批，等待用户"拦下，产生一条挂起事件。之后用户批准，
//   记成一条按调用指纹匹配的一次性授权，运行时给秘书递"……已获批准，可以重试"；重试放行一次，再来一次重新走审批；
//   重试时多命中了当初没批准过的关注类别，也重新走审批。之后用户拒绝，同样给秘书递"……已被用户拒绝"；
// - "交给我做"（测试里登记的、带"花钱"类别的工具）：不执行，建一个"交给我做"事项，用户点"已完成"后秘书收到通知；
// - 审批决定（批准、拒绝）是素材（08 号票的素材库）；"交给我做"的"已完成"不算审批决定。
import fs from "node:fs";
import path from "node:path";
import {
  type ApprovalCardPayload,
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  HAND_OVER_DONE,
  type InboxItem,
  type InboxItemEventPayload,
  type MessageEnvelope,
  type MessageEventPayload,
  type MessagePart,
  Type,
} from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { defineHostTool } from "../../src/agent-manager/host-tools.ts";
import { type ApprovalDecidedPayload, type ApprovalSuspendedPayload, GUARD_CHANNEL, GUARD_EVENTS } from "../../src/guard-runtime/events.ts";
import { listEffects } from "../../src/guard-runtime/effect-log.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { SECRETARY_SEGMENT_ID } from "../../src/secretary/secretary.ts";
import { realPathOf } from "../../src/util/real-path.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon, type StartTestDaemonOptions } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { SECRETARY_START_TIMEOUT_MS, waitUntil } from "../helpers/process.ts";
import { saveOrCheckRecording } from "../helpers/recording.ts";

const { secretary: SECRETARY, cards: CARDS, inbox: INBOX } = CHANNELS;
const ALL = { [SECRETARY]: 0, [CARDS]: 0, [INBOX]: 0 };

type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;

/** 秘书对话里的调用从哪儿来 */
const SECRETARY_ORIGIN = { agentId: "secretary", conversation: SECRETARY, taskId: null, stageId: null, segmentId: SECRETARY_SEGMENT_ID, source: "秘书对话" };
/** 几次等待加起来会超过默认用例超时（30 秒）的用例写明更长的超时：真超时时报的是 waitUntil 的说明 */
const LONG_TEST_MS = 60_000;

const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const say = (text: string): FauxStep => ({ kind: "reply", text });

async function setup(script: FauxStep[], options: Omit<StartTestDaemonOptions, "secretary"> = {}) {
  const test = await startTestDaemon({ secretary: script, ...options });
  const frontend = await TestFrontend.connect(test.url);
  await frontend.subscribe(ALL);
  return { ...test, frontend, home: realPathOf(test.homeDir)! };
}

const messagesOf = (frontend: TestFrontend): MessageEnvelope[] =>
  frontend.events({ channel: SECRETARY, type: EVENT_TYPES.message }).map((f) => (f.payload as MessageEventPayload).message);
const toolPartsOf = (frontend: TestFrontend): ToolCallPart[] =>
  messagesOf(frontend).flatMap((m) => m.parts.filter((p): p is ToolCallPart => p.type === "tool_call"));
const lastEcho = (frontend: TestFrontend): string =>
  messagesOf(frontend)
    .at(-1)!
    .parts.map((p) => (p.type === "text" ? p.text : ""))
    .join("");
/** 每张卡的最新版本，按建卡先后 */
function cardsOf(frontend: TestFrontend): Card[] {
  const latest = new Map<string, Card>();
  for (const f of frontend.events({ channel: CARDS, type: EVENT_TYPES.card })) {
    const { card } = f.payload as CardEventPayload;
    latest.set(card.id, card);
  }
  return [...latest.values()];
}
const inboxOf = (frontend: TestFrontend): InboxItem[] => {
  const latest = new Map<string, InboxItem>();
  for (const f of frontend.events({ channel: INBOX, type: EVENT_TYPES.inboxItem })) {
    const { item } = f.payload as InboxItemEventPayload;
    latest.set(item.id, item);
  }
  return [...latest.values()];
};
/** 等到有 count 张卡；第一次等要算上秘书拉起来的时间（timeoutMs 传 SECRETARY_START_TIMEOUT_MS） */
async function waitForCards(frontend: TestFrontend, count: number, timeoutMs?: number): Promise<Card[]> {
  await waitUntil(() => cardsOf(frontend).length >= count, { ...(timeoutMs === undefined ? {} : { timeoutMs }), describe: () => `等 ${count} 张卡，现在 ${cardsOf(frontend).length} 张` });
  return cardsOf(frontend);
}
const turnEnds = (frontend: TestFrontend) => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd }).length;
/** 等到秘书处理完 count 条输入；第一次等要算上秘书拉起来的时间 */
async function waitForTurnEnds(frontend: TestFrontend, count: number, timeoutMs?: number): Promise<void> {
  await waitUntil(() => turnEnds(frontend) >= count, { ...(timeoutMs === undefined ? {} : { timeoutMs }), describe: () => `等秘书处理完 ${count} 条输入，现在 ${turnEnds(frontend)} 条` });
}
const approve = (frontend: TestFrontend, card: Card) => frontend.cardAction({ cardId: card.id, action: "approve", expectedVersion: card.version });
const deny = (frontend: TestFrontend, card: Card, note?: string) =>
  frontend.cardAction({ cardId: card.id, action: "deny", expectedVersion: card.version, ...(note === undefined ? {} : { note }) });

describe("先问我：审批卡", { timeout: LONG_TEST_MS }, () => {
  it("读用户给的本机文件：先写审批表，再出审批卡（聊天和待我处理里是同一张，不卡任务）；用户批准 → 这次调用接着执行", async () => {
    const { frontend, daemon, home } = await setup([call("read", { path: "~/Documents/bill.txt" }), { kind: "echo_context" }]);
    fs.mkdirSync(path.join(home, "Documents"), { recursive: true });
    fs.writeFileSync(path.join(home, "Documents", "bill.txt"), "九月电费 230 元");
    await frontend.sendText("看看我的账单 ~/Documents/bill.txt");

    // 收到审批卡事件的那一刻，审批表里已经有这条记录（第一次等要算上秘书拉起来的时间）
    const cardFrame = await frontend.next(CARDS, EVENT_TYPES.card, SECRETARY_START_TIMEOUT_MS);
    const card = (cardFrame.payload as CardEventPayload).card;
    const payload = card.payload as ApprovalCardPayload;
    expect(daemon.approvals.get(payload.approvalId)).toMatchObject({ status: "pending", cardId: card.id, origin: SECRETARY_ORIGIN, categories: ["outside_project"] });
    expect(card).toMatchObject({ type: "approval", status: "pending", urgency: "non_blocking" });
    expect(payload).toMatchObject({ source: "秘书对话", tool: "read", toolTitle: "读文件", argsSummary: "~/Documents/bill.txt", categoryTitles: ["越出项目目录"] });
    expect(payload.reason).toContain("越出项目目录");
    expect(payload).not.toHaveProperty("taskId");

    // 同一张卡出现在聊天和待我处理里
    await waitUntil(() => inboxOf(frontend).length > 0 && messagesOf(frontend).some((m) => m.parts.some((p) => p.type === "card_ref")), { describe: () => "等审批卡出现在待我处理和聊天里" });
    expect(messagesOf(frontend).find((m) => m.parts.some((p) => p.type === "card_ref"))!.parts).toEqual([{ type: "card_ref", cardId: card.id }]);
    expect(inboxOf(frontend)).toMatchObject([{ kind: "card", cardId: card.id, source: "秘书对话", urgency: "non_blocking" }]);

    expect((await approve(frontend, card)).ok).toBe(true);
    await waitForTurnEnds(frontend, 1);
    expect(lastEcho(frontend)).toContain("[toolResult] read: 九月电费 230 元");
    expect(toolPartsOf(frontend)).toMatchObject([{ tool: "read", categoryTitles: ["越出项目目录"], disposition: "ask_first", withinGrant: false, genericBash: false, outcome: "done" }]);
    expect(cardsOf(frontend)).toMatchObject([{ id: card.id, status: "handled", outcome: { action: "approve" } }]);
    expect(daemon.inbox.isProcessed(daemon.inbox.list()[0]!)).toBe(true);
    // 审批决定的事件（"审批决定"素材的来源）
    const decided = daemon.store.read(GUARD_CHANNEL).filter((e) => e.type === GUARD_EVENTS.approvalDecided);
    expect(decided.map((e) => e.payload)).toMatchObject([
      { approvalId: payload.approvalId, decision: "approved", resumed: true, by: "user", origin: SECRETARY_ORIGIN, tool: "read", categories: ["outside_project"] },
    ]);
    expect(daemon.approvals.get(payload.approvalId)).toMatchObject({ status: "approved", resumed: true });
    expect(listEffects(daemon.store.reader, { taskId: null, agentId: "secretary", segmentId: SECRETARY_SEGMENT_ID }).map((e) => e.tool)).toEqual(["read"]);
  });

  it("bash 跑用户某个目录里的现成脚本：用户拒绝 → 调用被拦下，模型收到\"用户拒绝\"，脚本没跑", async () => {
    const { frontend, daemon, home } = await setup([call("bash", { command: "node ~/tools/report.js" }), { kind: "echo_context" }]);
    fs.mkdirSync(path.join(home, "tools"), { recursive: true });
    fs.writeFileSync(path.join(home, "tools", "report.js"), `require("fs").writeFileSync(${JSON.stringify(path.join(home, "ran.txt"))}, "ran");\n`);
    await frontend.sendText("跑一下我的报表脚本");
    const [card] = await waitForCards(frontend, 1, SECRETARY_START_TIMEOUT_MS);
    expect(card!.payload).toMatchObject({ tool: "bash", toolTitle: "通用 bash", argsSummary: "node ~/tools/report.js", categoryTitles: ["越出项目目录"] });

    expect((await deny(frontend, card!, "这个脚本别动")).ok).toBe(true);
    await waitForTurnEnds(frontend, 1);
    expect(lastEcho(frontend)).toMatch(/\[toolResult\] bash: 用户拒绝了这次调用：这个脚本别动/);
    expect(toolPartsOf(frontend)).toMatchObject([{ tool: "bash", genericBash: true, disposition: "ask_first", outcome: "denied", resultSummary: "你拒绝了：这个脚本别动" }]);
    expect(fs.existsSync(path.join(home, "ran.txt"))).toBe(false);
    expect(daemon.approvals.list()).toMatchObject([{ status: "denied", note: "这个脚本别动" }]);
    const decided = daemon.store.read(GUARD_CHANNEL).filter((e) => e.type === GUARD_EVENTS.approvalDecided);
    expect((decided[0]!.payload as ApprovalDecidedPayload).decision).toBe("denied");
    expect(listEffects(daemon.store.reader, { taskId: null, agentId: "secretary", segmentId: SECRETARY_SEGMENT_ID })).toEqual([]);
  });
});

describe("等待与挂起", { timeout: LONG_TEST_MS }, () => {
  it("5 分钟没处理：以\"已提交审批，等待用户\"拦下、产生挂起事件；之后批准记成一次性授权，秘书收到\"可以重试\"，重试放行一次，再来一次重新走审批", async () => {
    const clock = new ManualClock(new Date(2026, 9, 8, 10, 0));
    const target = "~/Documents/bill.txt";
    const { frontend, daemon, home } = await setup(
      [
        call("read", { path: target }),
        say("已提交审批，等你批准。"),
        // 用户事后批准，秘书收到通知后重试
        call("read", { path: target }),
        call("read", { path: target }),
        { kind: "echo_context" },
      ],
      { clock },
    );
    fs.mkdirSync(path.join(home, "Documents"), { recursive: true });
    fs.writeFileSync(path.join(home, "Documents", "bill.txt"), "九月电费 230 元");
    await frontend.sendText("看看我的账单");
    const [first] = await waitForCards(frontend, 1, SECRETARY_START_TIMEOUT_MS);

    clock.advance(5 * 60_000 - 1);
    expect(turnEnds(frontend)).toBe(0);
    clock.advance(1);
    await waitForTurnEnds(frontend, 1);
    expect(toolPartsOf(frontend)).toMatchObject([{ tool: "read", disposition: "ask_first", outcome: "blocked", resultSummary: "已提交审批，等待用户" }]);
    const approvalId = (first!.payload as ApprovalCardPayload).approvalId;
    const suspended = daemon.store.read(GUARD_CHANNEL).filter((e) => e.type === GUARD_EVENTS.approvalSuspended);
    expect(suspended.map((e) => e.payload as ApprovalSuspendedPayload)).toMatchObject([{ approvalId, origin: SECRETARY_ORIGIN }]);
    // 审批卡还在，仍待处理
    expect(cardsOf(frontend)).toMatchObject([{ id: first!.id, status: "pending" }]);
    expect(daemon.approvals.get(approvalId)).toMatchObject({ status: "pending", suspended: true });

    // 事后批准：一次性授权；秘书收到通知后重试，同样的调用放行一次；再来一次重新走审批
    expect((await approve(frontend, first!)).ok).toBe(true);
    const notice = messagesOf(frontend).find((m) => m.speaker === "system");
    expect(notice?.parts).toEqual([{ type: "text", text: expect.stringContaining("已获用户批准，可以重试") }]);
    const [, second] = await waitForCards(frontend, 2);
    expect(daemon.approvals.get(approvalId)).toMatchObject({ status: "approved", resumed: false, consumed: true });
    expect((await deny(frontend, second!)).ok).toBe(true);
    await waitForTurnEnds(frontend, 2);

    expect(toolPartsOf(frontend).map((p) => p.outcome)).toEqual(["blocked", "done", "denied"]);
    const seen = lastEcho(frontend);
    expect(seen).toContain("[系统通知]");
    expect(seen).toContain("已获用户批准，可以重试");
    expect(seen).toContain("[toolResult] read: 九月电费 230 元");
    expect(seen).toMatch(/\[toolResult\] read: 用户拒绝了这次调用/);
    // 只有两张审批卡：重试的那次没有再问
    expect(cardsOf(frontend).map((c) => c.type)).toEqual(["approval", "approval"]);
  });

  it("挂起之后用户拒绝：秘书收到\"……已被用户拒绝\"，不再以为还在等", async () => {
    const clock = new ManualClock(new Date(2026, 9, 8, 10, 0));
    const { frontend, daemon } = await setup([call("read", { path: "~/Documents/bill.txt" }), say("已提交审批，等你批准。"), { kind: "echo_context" }], { clock });
    await frontend.sendText("看看我的账单");
    const [card] = await waitForCards(frontend, 1, SECRETARY_START_TIMEOUT_MS);
    clock.advance(5 * 60_000);
    await waitForTurnEnds(frontend, 1);
    expect(daemon.approvals.get((card!.payload as ApprovalCardPayload).approvalId)).toMatchObject({ status: "pending", suspended: true });

    expect((await deny(frontend, card!, "账单别看了")).ok).toBe(true);
    const notice = messagesOf(frontend).find((m) => m.speaker === "system");
    expect(notice?.parts).toEqual([{ type: "text", text: expect.stringContaining("已被用户拒绝：账单别看了") }]);
    await waitForTurnEnds(frontend, 2);
    const seen = lastEcho(frontend);
    expect(seen).toContain("[系统通知]");
    expect(seen).toContain("读文件「~/Documents/bill.txt」已被用户拒绝：账单别看了");
    // 不是一次性授权：没有什么可以重试
    expect(daemon.approvals.get((card!.payload as ApprovalCardPayload).approvalId)).toMatchObject({ status: "denied", resumed: false });
  });

  it("一次性授权只放行当初批准过的类别：重试时多命中了别的关注类别（这里是用户刚加的自定义类别），重新走审批，授权不用掉", async () => {
    const clock = new ManualClock(new Date(2026, 9, 8, 10, 0));
    const target = "~/Documents/bill.txt";
    const { frontend, daemon, home } = await setup(
      [call("read", { path: target }), say("已提交审批，等你批准。"), call("read", { path: target }), { kind: "echo_context" }],
      { clock },
    );
    fs.mkdirSync(path.join(home, "Documents"), { recursive: true });
    fs.writeFileSync(path.join(home, "Documents", "bill.txt"), "九月电费 230 元");
    await frontend.sendText("看看我的账单");
    const [first] = await waitForCards(frontend, 1, SECRETARY_START_TIMEOUT_MS);
    clock.advance(5 * 60_000);
    await waitForTurnEnds(frontend, 1);

    // 用户加了一个自定义类别：读文件一律先问
    fs.writeFileSync(
      daemon.layout.watchCategoriesFile,
      JSON.stringify({ custom: [{ id: "private-reading", title: "读私人文件", match: { tools: ["read"] }, chat: "ask_first", task: "ask_first" }] }),
    );
    expect((await approve(frontend, first!)).ok).toBe(true);
    const [, second] = await waitForCards(frontend, 2);
    expect(second!.payload).toMatchObject({ tool: "read", argsSummary: target, categoryTitles: ["越出项目目录", "读私人文件"] });
    const firstId = (first!.payload as ApprovalCardPayload).approvalId;
    expect(daemon.approvals.get(firstId)).toMatchObject({ status: "approved", resumed: false, consumed: false, categories: ["outside_project"] });

    expect((await approve(frontend, second!)).ok).toBe(true);
    await waitForTurnEnds(frontend, 2);
    expect(toolPartsOf(frontend).map((p) => p.outcome)).toEqual(["blocked", "done"]);
    expect(lastEcho(frontend)).toContain("[toolResult] read: 九月电费 230 元");
  });

  it("等多久可以配置", async () => {
    const clock = new ManualClock(new Date(2026, 9, 8, 10, 0));
    const test = await startTestDaemon({ secretary: [call("read", { path: "~/x.txt" }), say("在等你批准")], clock, config: { approvals: { waitMinutes: 1 } } });
    const frontend = await TestFrontend.connect(test.url);
    await frontend.subscribe(ALL);
    await frontend.sendText("读一下 ~/x.txt");
    await waitForCards(frontend, 1, SECRETARY_START_TIMEOUT_MS);
    clock.advance(60_000);
    await waitForTurnEnds(frontend, 1);
    expect(toolPartsOf(frontend)).toMatchObject([{ outcome: "blocked", resultSummary: "已提交审批，等待用户" }]);
  });
});

describe("交给我做", { timeout: LONG_TEST_MS }, () => {
  it("带\"花钱\"类别的工具：不执行，建一个\"交给我做\"事项（带这次调用的规范化摘要）；用户点\"已完成\"后秘书收到通知", async () => {
    let paid = false;
    const payBill = defineHostTool({
      name: "pay_bill",
      title: "付账单",
      description: "付一笔账单（测试用）",
      parameters: Type.Object({ payee: Type.String(), amount: Type.Number() }),
      categories: ["spend_money"],
      readOnlyOrIdempotent: false,
      run: () => {
        paid = true;
        return { text: "付好了" };
      },
    });
    const { frontend } = await setup([call("pay_bill", { payee: "电力公司", amount: 230 }), say("这笔要你亲手付，已放进待我处理。"), { kind: "echo_context" }], {
      secretaryTools: [payBill],
    });
    await frontend.sendText("把电费付了");
    await waitForTurnEnds(frontend, 1, SECRETARY_START_TIMEOUT_MS);

    expect(paid).toBe(false);
    expect(toolPartsOf(frontend)).toMatchObject([{ tool: "pay_bill", categoryTitles: ["花钱"], disposition: "hand_to_me", outcome: "blocked" }]);
    expect(cardsOf(frontend)).toEqual([]);
    const [item] = inboxOf(frontend);
    expect(item).toMatchObject({ kind: "notice", notice: "hand_over", source: "秘书对话", urgency: "non_blocking", actions: [HAND_OVER_DONE] });
    expect(item!.kind === "notice" && item!.body).toContain('"payee":"电力公司"');
    expect(item!.kind === "notice" && item!.data).toMatchObject({
      origin: SECRETARY_ORIGIN,
      tool: "pay_bill",
      toolTitle: "付账单",
      calls: [{ tool: "pay_bill", title: "付账单", args: { payee: "电力公司", amount: 230 } }],
    });

    expect((await frontend.inboxAction({ itemIds: [item!.id], action: "handle", choice: HAND_OVER_DONE })).ok).toBe(true);
    await waitForTurnEnds(frontend, 2);
    expect(lastEcho(frontend)).toContain("用户已经亲手完成了");
    expect(paid).toBe(false);
  });
});

describe("审批决定是素材", { timeout: LONG_TEST_MS }, () => {
  it("用户批准一次、拒绝一次（附说明）：素材库里各有一条\"审批决定\"（做、本人：用户的选择注明 agent 先提出，说明是用户自己的话），按说明搜得到", async () => {
    const { frontend, daemon, home } = await setup([call("read", { path: "~/a.txt" }), call("read", { path: "~/b.txt" }), { kind: "echo_context" }]);
    fs.writeFileSync(path.join(home, "a.txt"), "甲");
    fs.writeFileSync(path.join(home, "b.txt"), "乙");
    await frontend.sendText("看看 a 和 b");
    const [first] = await waitForCards(frontend, 1, SECRETARY_START_TIMEOUT_MS);
    expect((await approve(frontend, first!)).ok).toBe(true);
    const [, second] = await waitForCards(frontend, 2);
    expect((await deny(frontend, second!, "b 是私事，别看")).ok).toBe(true);
    await waitForTurnEnds(frontend, 1);

    const decisions = daemon.materials.list().filter((m) => m.kind === "approval_decision");
    expect(decisions).toMatchObject([
      {
        mode: "do",
        source: "self",
        conversation: SECRETARY,
        context: ["decision:approved", "tool:read", "category:outside_project"],
        ref: { recordId: (first!.payload as ApprovalCardPayload).approvalId, cardId: first!.id },
        segments: [{ form: "choice", source: "self", text: "批准：读文件「~/a.txt」", notes: ["agent_proposed"] }],
      },
      {
        context: ["decision:denied", "tool:read", "category:outside_project"],
        ref: { recordId: (second!.payload as ApprovalCardPayload).approvalId, cardId: second!.id },
        segments: [
          { form: "choice", source: "self", text: "拒绝：读文件「~/b.txt」", notes: ["agent_proposed"] },
          { form: "typed", source: "self", text: "b 是私事，别看" },
        ],
      },
    ]);
    expect(daemon.materials.searchKeyword("私事").map((m) => m.id)).toEqual([decisions[1]!.id]);
  });

  it("\"交给我做\"事项上点\"已完成\"不算审批决定", async () => {
    const payBill = defineHostTool({
      name: "pay_bill",
      title: "付账单",
      description: "付一笔账单（测试用）",
      parameters: Type.Object({ payee: Type.String(), amount: Type.Number() }),
      categories: ["spend_money"],
      readOnlyOrIdempotent: false,
      run: () => ({ text: "付好了" }),
    });
    const { frontend, daemon } = await setup([call("pay_bill", { payee: "水务公司", amount: 80 }), say("放进待我处理了。"), say("好的")], { secretaryTools: [payBill] });
    await frontend.sendText("把水费付了");
    await waitForTurnEnds(frontend, 1, SECRETARY_START_TIMEOUT_MS);
    const [item] = inboxOf(frontend);
    expect((await frontend.inboxAction({ itemIds: [item!.id], action: "handle", choice: HAND_OVER_DONE })).ok).toBe(true);
    await waitForTurnEnds(frontend, 2);
    expect(daemon.materials.list().filter((m) => m.kind === "approval_decision")).toEqual([]);
  });
});

describe("录事件流", { timeout: LONG_TEST_MS }, () => {
  it("secretary-approval：秘书要读草稿区外的文件，聊天里出审批卡，待我处理里同一张；批准后接着执行", async () => {
    const { frontend, home } = await setup([call("read", { path: "~/notes.txt" }), say("读到了：周五交房租。")]);
    fs.writeFileSync(path.join(home, "notes.txt"), "周五交房租");
    await frontend.sendText("看看 ~/notes.txt");
    const [card] = await waitForCards(frontend, 1, SECRETARY_START_TIMEOUT_MS);
    await waitUntil(() => inboxOf(frontend).length > 0, { describe: () => "等审批卡出现在待我处理里" });
    await approve(frontend, card!);
    await waitForTurnEnds(frontend, 1);
    expect(toolPartsOf(frontend)).toMatchObject([{ tool: "read", outcome: "done" }]);
    saveOrCheckRecording("secretary-approval", frontend.recording);
  });
});

