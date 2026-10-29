// 主切面：秘书主会话的会话回退（150 号票，回退和分支）。真的守护进程，秘书接 faux provider；测试扮演前端：
// - 回到某条用户消息之前：秘书停稳、写分支摘要（BRANCH_SUMMARY_INSTRUCTIONS 原样交给模型）、会话树长出新分支；会话频道上一条 session_branch
//   （整棵树）和新分支开头一条分支摘要；同一个幂等键重发拿到同一个结果；往上翻历史只有当前分支上的；
//   守护进程重启后分支照旧，秘书下一轮的上下文从回退点接着、带着摘要（会话文件的叶子落了盘）；后连上的前端补发里先给最新的会话树；
// - 回复中撤回：这一轮停下；排着的消息留着、交给新分支作为下一轮；废弃分支上秘书发起、还没处理的卡作废，写明"用户撤回了会话"；
// - 回退前的确认：做了几件事、本机还是对外、能不能申请撤回（删除或覆盖、对外的不能），只看的不算；回退之后调撤销接口（默认什么都不做）；
// - 回不到的：秘书的回复、不在当前分支上的、分支摘要之前的那条分支开始前（撤回到这条分支开始前）照样能回。
import {
  type BranchSummaryPart,
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  type EventFrame,
  HTTP_PATHS,
  type MessageEventPayload,
  METHODS,
  ROLLBACK_VOIDED_CARD,
  type RollbackPreview,
  type RollbackSessionResult,
  type SessionBranchEventPayload,
  Type,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { defineHostTool } from "../../src/agent-manager/host-tools.ts";
import type { SessionRollbackHook } from "../../src/conversation/rollback.ts";
import { listMessages } from "../../src/conversation/views.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { requestJson } from "../helpers/http.ts";
import { SECRETARY_START_TIMEOUT_MS, waitUntil } from "../helpers/process.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { secretary: SECRETARY, cards: CARDS } = CHANNELS;
const LONG_TEST_MS = 90_000;
const SUMMARY = "摘要：用户让写邮件、订会议室，都做了，没有对外效果。";

const say = (text: string): FauxStep => ({ kind: "reply", text });
const textOf = (p: MessageEventPayload) => p.message.parts.map((part) => ("text" in part ? part.text : `<${part.type}>`)).join("");
const messages = (frontend: TestFrontend) => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.message }).map((f) => f.payload as MessageEventPayload);
const turnEnds = (frontend: TestFrontend) => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd }).length;
const waitTurns = (frontend: TestFrontend, n: number, timeoutMs = SECRETARY_START_TIMEOUT_MS) =>
  waitUntil(() => turnEnds(frontend) >= n, { timeoutMs, describe: () => `等秘书处理完 ${n} 条，现在 ${turnEnds(frontend)} 条` });
const ok = <T>(response: { ok: boolean; result?: unknown; error?: unknown }): T => {
  if (!response.ok) throw new Error(`请求失败：${JSON.stringify(response.error)}`);
  return response.result as T;
};
const rollback = (frontend: TestFrontend, before: { messageId: string } | { branchId: string }, key: string) =>
  frontend.request(METHODS.rollbackSession, { conversation: SECRETARY, before }, key);
const preview = (url: string, before: { messageId: string } | { branchId: string }) => requestJson<RollbackPreview>(url, HTTP_PATHS.rollbackPreview(SECRETARY, before));
const latestTree = (frames: EventFrame[]) => (frames.filter((f) => f.type === EVENT_TYPES.sessionBranch).at(-1)?.payload as SessionBranchEventPayload | undefined)?.branches;
const branchSummaryOf = (p: MessageEventPayload) => p.message.parts.find((part): part is BranchSummaryPart => part.type === "branch_summary");

describe("会话回退（秘书主会话）", { timeout: LONG_TEST_MS }, () => {
  it("回到某条之前：写摘要、长出新分支；往上翻只有当前分支；重启后照旧，秘书下一轮从回退点接着、带着摘要", async () => {
    const dataDir = makeTempDir("ergo-rollback-data-");
    const homeDir = makeTempDir("ergo-rollback-home-");
    const first = await startTestDaemon({
      reuse: { dataDir, homeDir },
      secretary: [
        say("好的，今天晴"),
        say("邮件写好了"),
        say("会议室订好了"),
        // 写分支摘要的那次：要求是 BRANCH_SUMMARY_INSTRUCTIONS 的原话，被放弃的是第二、三句
        {
          kind: "branch_on_context",
          contains: ["第二句：给老王写邮件", "第三句：订会议室", "用中文写 3~5 行：这条被放弃的分支做到了哪一步"],
          matched: say(SUMMARY),
          otherwise: say("摘要写错了"),
        },
      ],
    });
    const phone = await TestFrontend.connect(first.url);
    await phone.subscribe({ [SECRETARY]: 0 });
    await phone.sendText("第一句：查天气");
    await waitTurns(phone, 1);
    const second = await phone.sendText("第二句：给老王写邮件");
    await waitTurns(phone, 2);
    await phone.sendText("第三句：订会议室");
    await waitTurns(phone, 3);

    // 没做过有副作用的事
    expect((await preview(first.url, { messageId: second.messageId })).body).toEqual({ conversation: SECRETARY, before: { messageId: second.messageId }, effects: [] });
    const result = ok<RollbackSessionResult>(await rollback(phone, { messageId: second.messageId }, "k-rb"));
    expect(result.branchId).toBe("b1");
    // 会话频道：session_branch（整棵树）、分支摘要（新分支开头，系统消息）
    await waitUntil(() => messages(phone).some((m) => branchSummaryOf(m) !== undefined));
    const tree = latestTree(phone.events({ channel: SECRETARY }))!;
    const branchFrame = phone.events({ channel: SECRETARY, type: EVENT_TYPES.sessionBranch }).at(-1)!;
    expect(tree).toMatchObject({ current: "b1", epochs: [{ from: 0, branch: "b0" }, { from: branchFrame.seq, branch: "b1" }] });
    expect(tree.branches[1]).toMatchObject({ id: "b1", parent: "b0", cutoff: second.seq, start: branchFrame.seq, summary: { messageId: result.summaryMessageId, text: SUMMARY } });
    expect(tree.branches[0]!.tip).toEqual(expect.any(String));
    const summaryMessage = messages(phone).find((m) => m.message.id === result.summaryMessageId)!;
    expect(summaryMessage.message.speaker).toBe("system");
    expect(branchSummaryOf(summaryMessage)).toEqual({ type: "branch_summary", branchId: "b1", summary: SUMMARY });
    // 同一个幂等键重发：同一个结果，不多一次
    expect(ok<RollbackSessionResult>(await rollback(phone, { messageId: second.messageId }, "k-rb"))).toEqual(result);
    expect(first.daemon.store.read(SECRETARY, 0, EVENT_TYPES.sessionBranch)).toHaveLength(1);
    // 往上翻：只有当前分支上的（第一句和它的回复、分支摘要）；守护进程自己的会话视图里都还在（废弃分支保留）
    const page = await phone.history(SECRETARY);
    expect(page.messages.map((m) => ("message" in m ? textOf({ message: m.message }) : "已删除"))).toEqual(["第一句：查天气", "好的，今天晴", "<branch_summary>"]);
    expect(listMessages(first.daemon.store.reader, SECRETARY)).toHaveLength(7);
    // 回不到的：秘书的回复、不在当前分支上的
    const reply = messages(phone).find((m) => textOf(m) === "好的，今天晴")!;
    expect(await rollback(phone, { messageId: reply.message.id }, "k-bad-1")).toMatchObject({ ok: false, error: { code: "not_allowed", message: expect.stringContaining("你发的消息") } });
    expect(await rollback(phone, { messageId: second.messageId }, "k-bad-2")).toMatchObject({ ok: false, error: { code: "not_allowed", message: expect.stringContaining("不在当前分支上") } });
    await first.daemon.stop();

    // 重启：分支照旧；后连上的前端补发里有最新的会话树；秘书下一轮的上下文从第一句接着、带着摘要，第二、三句不在
    const again = await startTestDaemon({ reuse: { dataDir, homeDir }, secretary: [{ kind: "echo_context" }] });
    const laptop = await TestFrontend.connect(again.url);
    await laptop.subscribe({ [SECRETARY]: 0 });
    await waitUntil(() => latestTree(laptop.events({ channel: SECRETARY })) !== undefined);
    const replayed = turnEnds(laptop);
    expect(latestTree(laptop.events({ channel: SECRETARY }))).toEqual(tree);
    expect((await laptop.history(SECRETARY)).messages).toHaveLength(3);
    await laptop.sendText("重新来：只查天气");
    await waitUntil(() => turnEnds(laptop) > replayed, { timeoutMs: SECRETARY_START_TIMEOUT_MS });
    const seen = textOf(messages(laptop).at(-1)!);
    expect(seen).toContain("第一句：查天气");
    expect(seen).toContain("好的，今天晴");
    expect(seen).toContain(SUMMARY);
    expect(seen).toContain("重新来：只查天气");
    expect(seen).not.toContain("第二句");
    expect(seen).not.toContain("第三句");
    expect(seen).not.toContain("邮件写好了");
  });

  it("撤回到这条分支开始前：回到长出它的那一处（兄弟分支），两条废弃分支都留着", async () => {
    const td = await startTestDaemon({ secretary: [say("一"), say("二"), say("摘要甲"), say("三"), say("摘要乙")] });
    const phone = await TestFrontend.connect(td.url);
    await phone.subscribe({ [SECRETARY]: 0 });
    await phone.sendText("第一句");
    await waitTurns(phone, 1);
    const second = await phone.sendText("第二句");
    await waitTurns(phone, 2);
    const one = ok<RollbackSessionResult>(await rollback(phone, { messageId: second.messageId }, "k-1"));
    await phone.sendText("第三句");
    await waitTurns(phone, 3);
    const two = ok<RollbackSessionResult>(await rollback(phone, { branchId: one.branchId }, "k-2"));
    expect(two.branchId).toBe("b2");
    const tree = td.daemon.store.read(SECRETARY, 0, EVENT_TYPES.sessionBranch).at(-1)!.payload as SessionBranchEventPayload;
    expect(tree.branches.branches.map((b) => [b.id, b.parent, b.cutoff])).toEqual([
      ["b0", undefined, undefined],
      ["b1", "b0", second.seq],
      ["b2", "b0", second.seq],
    ]);
    expect((await phone.history(SECRETARY)).messages.map((m) => ("message" in m ? textOf({ message: m.message }) : ""))).toEqual(["第一句", "一", "<branch_summary>"]);
  });

  it("只在这段会话里有回退点：清空当前对话之前的消息回不去，之后的照常能回", async () => {
    const td = await startTestDaemon({ secretary: [say("一"), say("二"), say("摘要")] });
    const phone = await TestFrontend.connect(td.url);
    await phone.subscribe({ [SECRETARY]: 0 });
    const first = await phone.sendText("清空之前说的");
    await waitTurns(phone, 1);
    expect((await requestJson(td.url, HTTP_PATHS.agentClear("secretary"), { method: "POST", body: { idempotencyKey: "k-clear" } })).status).toBe(200);
    await waitUntil(() => messages(phone).some((m) => m.message.parts.some((p) => p.type === "conversation_cleared")));
    await phone.sendText("清空之后说的第一句");
    await waitTurns(phone, 2);
    const later = await phone.sendText("清空之后说的第二句");
    await waitTurns(phone, 3);
    expect(await rollback(phone, { messageId: first.messageId }, "k-old")).toMatchObject({ ok: false, error: { code: "not_allowed", message: expect.stringContaining("清空、换模型之后") } });
    expect((await preview(td.url, { messageId: first.messageId })).status).toBe(400);
    expect(ok<RollbackSessionResult>(await rollback(phone, { messageId: later.messageId }, "k-new")).branchId).toBe("b1");
  });

  it("废弃分支里的话照样留在素材里：秘书检索时标“在废弃分支里”、排在当前分支的后面", async () => {
    const td = await startTestDaemon({
      secretary: [say("好"), say("记下了"), say("摘要：说了苹果派"), { kind: "reply", toolCalls: [{ name: "search_materials", arguments: { query: "苹果", why: "用户问说过的苹果派" } }] }, { kind: "echo_context" }],
    });
    const phone = await TestFrontend.connect(td.url);
    await phone.subscribe({ [SECRETARY]: 0 });
    await phone.sendText("第一句：我喜欢吃苹果");
    await waitTurns(phone, 1);
    const second = await phone.sendText("第二句：其实更喜欢苹果派");
    await waitTurns(phone, 2);
    await waitUntil(() => td.daemon.materials.searchKeyword("苹果").length === 2);
    ok<RollbackSessionResult>(await rollback(phone, { messageId: second.messageId }, "k-mem"));
    await phone.sendText("第三句：查查我说过的苹果");
    await waitTurns(phone, 3);
    const seen = textOf(messages(phone).at(-1)!);
    const lines = seen.slice(seen.indexOf("[toolResult] search_materials")).split("\n").filter((l) => l.startsWith("- mat-"));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("第一句：我喜欢吃苹果");
    expect(lines[0]).not.toContain("在废弃分支里");
    expect(lines[1]).toContain("第二句：其实更喜欢苹果派");
    expect(lines[1]).toContain(" · 在废弃分支里");
  });

  it("回复中撤回：这一轮停下；排着的消息交给新分支作为下一轮；废弃分支上没处理的审批卡作废，写明用户撤回了会话", async () => {
    const td = await startTestDaemon({
      secretary: [
        say("好"),
        // 第二句：读用户目录外的文件，先问用户（审批卡），这一轮等着
        { kind: "reply", toolCalls: [{ name: "read", arguments: { path: "~/Documents/bill.txt" } }] },
        say("摘要：读账单那一步在等你批准"),
        { kind: "branch_on_context", contains: ["第三句：顺便订餐厅"], matched: say("收到第三句"), otherwise: say("没收到") },
      ],
    });
    const phone = await TestFrontend.connect(td.url);
    await phone.subscribe({ [SECRETARY]: 0, [CARDS]: 0 });
    await phone.sendText("第一句");
    await waitTurns(phone, 1);
    const second = await phone.sendText("第二句：看看我的账单 ~/Documents/bill.txt");
    const cardFrame = await phone.next(CARDS, EVENT_TYPES.card, SECRETARY_START_TIMEOUT_MS);
    const card = (cardFrame.payload as CardEventPayload).card;
    expect(card.status).toBe("pending");
    // 在回复（等审批）时发的话排队
    const third = await phone.sendText("第三句：顺便订餐厅");
    expect(third.queued).toBe(true);

    ok<RollbackSessionResult>(await rollback(phone, { messageId: second.messageId }, "k-busy"));
    // 卡作废，写明原因
    await waitUntil(() => cardsOf(phone).find((c) => c.id === card.id)?.status === "expired");
    expect(cardsOf(phone).find((c) => c.id === card.id)).toMatchObject({ status: "expired", expiredNote: ROLLBACK_VOIDED_CARD });
    const branchEvent = phone.events({ channel: SECRETARY, type: EVENT_TYPES.sessionBranch }).at(-1)!;
    expect((branchEvent.payload as SessionBranchEventPayload).expiredCards).toEqual([card.id]);
    // 停下的那一轮在分支事件之前结束（中止）；排着的第三句在分支事件之后交出去，秘书作为新分支的下一轮回了它
    await waitUntil(() => messages(phone).some((m) => textOf(m) === "收到第三句"), { timeoutMs: 30_000 });
    const frames = phone.events({ channel: SECRETARY, persistedOnly: true });
    const ended = frames.find((f) => f.type === EVENT_TYPES.turnEnd && (f.payload as { inputMessageId: string }).inputMessageId === second.messageId)!;
    expect((ended.payload as { outcome: string }).outcome).toBe("aborted");
    expect(ended.seq).toBeLessThan(branchEvent.seq);
    const delivered = frames.find((f) => f.type === EVENT_TYPES.message && (f.payload as MessageEventPayload).message.id === third.messageId)!;
    expect(delivered.seq).toBeGreaterThan(branchEvent.seq);
    // 往上翻：第一句、它的回复、分支摘要、第三句、回复
    expect((await phone.history(SECRETARY)).messages.map((m) => ("message" in m ? textOf({ message: m.message }) : ""))).toEqual([
      "第一句",
      "好",
      "<branch_summary>",
      "第三句：顺便订餐厅",
      "收到第三句",
    ]);
  });

  it("回退前的确认：做了几件事、本机还是对外、能不能申请撤回，只看的不算；回退之后调撤销接口", async () => {
    const calls = [
      { name: "send_note", arguments: { what: "给老王发一句" } },
      { name: "wipe_notes", arguments: { what: "清空草稿" } },
      { name: "touch_note", arguments: { what: "记一笔" } },
      { name: "peek_note", arguments: { what: "看一眼" } },
    ];
    const rollbacks: Parameters<SessionRollbackHook["onSessionRollback"]>[0][] = [];
    const td = await startTestDaemon({
      config: { guard: { conversationApprovals: "off" } },
      secretaryTools: [
        tool("send_note", "发便条", { categories: ["external_send"] }),
        tool("wipe_notes", "清空便条", { categories: ["delete_or_overwrite"], nature: "modify" }),
        tool("touch_note", "记便条", {}),
        tool("peek_note", "看便条", { nature: "look", readOnlyOrIdempotent: true }),
      ],
      secretary: [say("好"), { kind: "reply", toolCalls: calls }, say("都办了"), say("摘要：发了便条、清了草稿")],
      sessionRollbackHook: {
        onSessionRollback: async (event) => {
          rollbacks.push(event);
        },
      },
    });
    const phone = await TestFrontend.connect(td.url);
    await phone.subscribe({ [SECRETARY]: 0, [CARDS]: 0 });
    await phone.sendText("第一句");
    await waitTurns(phone, 1);
    const second = await phone.sendText("第二句：把便条的事都办了");
    // 对外发送对话审批关着也先问（101 号票）：一张张批准，这一轮做完
    const approved = new Set<string>();
    await waitUntil(
      () => {
        for (const card of cardsOf(phone)) {
          if (card.status !== "pending" || approved.has(card.id)) continue;
          approved.add(card.id);
          void phone.cardAction({ cardId: card.id, action: "approve", expectedVersion: card.version });
        }
        return turnEnds(phone) >= 2;
      },
      { timeoutMs: 30_000, describe: () => JSON.stringify(messages(phone).map((m) => m.message.parts)) },
    );

    const { status, body } = await preview(td.url, { messageId: second.messageId });
    expect(status).toBe(200);
    expect(body.effects.map((e) => [e.tool, e.toolTitle, e.scope, e.undoable, e.why])).toEqual([
      ["send_note", "发便条", "external", false, "已经对外生效"],
      ["wipe_notes", "清空便条", "local", false, "删除或覆盖，没有备份"],
      ["touch_note", "记便条", "local", true, undefined],
    ]);
    // 回到第一句之前：这一段一样是这三件
    expect((await preview(td.url, { messageId: messages(phone)[0]!.message.id })).body.effects).toHaveLength(3);

    const result = ok<RollbackSessionResult>(await rollback(phone, { messageId: second.messageId }, "k-effects"));
    await waitUntil(() => rollbacks.length === 1);
    expect(rollbacks[0]).toMatchObject({ conversation: SECRETARY, from: "b0", to: result.branchId, before: { messageId: second.messageId } });
    expect(rollbacks[0]!.effects.map((e) => e.tool)).toEqual(["send_note", "wipe_notes", "touch_note"]);
    expect(rollbacks[0]!.abandoned[0]!.from).toBe(second.seq);
  });
});

/** 测试用的宿主工具：参数只有一个 what，执行了回"好了" */
function tool(name: string, title: string, extra: Partial<Parameters<typeof defineHostTool>[0]>) {
  return defineHostTool({ name, title, description: `${title}（测试用）`, parameters: Type.Object({ what: Type.String() }), readOnlyOrIdempotent: false, run: () => ({ text: "好了" }), ...extra });
}

/** 每张卡的最新版本 */
function cardsOf(frontend: TestFrontend): Card[] {
  const latest = new Map<string, Card>();
  for (const f of frontend.events({ channel: CARDS, type: EVENT_TYPES.card })) {
    const { card } = f.payload as CardEventPayload;
    latest.set(card.id, card);
  }
  return [...latest.values()];
}
