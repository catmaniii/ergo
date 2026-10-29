// 主切面：废弃分支的切换、详情、申请撤回（151 号票）。真的守护进程，
// 秘书接 faux provider；测试扮演前端：
// - 切换分支：不写摘要（模型不多调一次）；会话频道上一条 session_branch（change: switch，整棵树），原来的当前分支记下末端、成为废弃分支；
//   秘书下一轮的上下文是那条分支原样（那条开头有分支摘要的照样在），切回来也对；往上翻沿新的当前分支；重启后不变（叶子落了盘）；
// - 切换时正在回复：先停稳（这一轮中止），卡片不作废，排着的消息交给切过去的那条作为下一轮；
// - 分支的样子：废弃分支自己那一段的消息、遗留效果、分支摘要（被回退离开时写的那份；只被切换离开过的没有）；和别的分支比的那一段；
// - 申请撤回：记进事件日志、调撤销接口；再取分支的样子还是"已提交"；同一件再点不多记；对外的、删了没备份的、当前分支上的不能申请。
import {
  type Card,
  type CardEventPayload,
  CHANNELS,
  type BranchView,
  type EffectUndoRequestedEventPayload,
  EVENT_TYPES,
  type EventFrame,
  HTTP_PATHS,
  type MessageEventPayload,
  METHODS,
  type RequestEffectUndoResult,
  type RollbackSessionResult,
  type SessionBranchEventPayload,
  type SwitchBranchResult,
  Type,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { defineHostTool } from "../../src/agent-manager/host-tools.ts";
import type { SessionRollbackHook } from "../../src/conversation/rollback.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { requestJson } from "../helpers/http.ts";
import { SECRETARY_START_TIMEOUT_MS, waitUntil } from "../helpers/process.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { secretary: SECRETARY, cards: CARDS } = CHANNELS;
const LONG_TEST_MS = 120_000;
const SUMMARY = "摘要：用户让给老王写邮件，写好了，没有对外效果。";

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
const switchTo = (frontend: TestFrontend, branchId: string, key: string) => frontend.request(METHODS.switchBranch, { conversation: SECRETARY, branchId }, key);
const askUndo = (frontend: TestFrontend, branchId: string, callId: string, key: string) =>
  frontend.request(METHODS.requestEffectUndo, { conversation: SECRETARY, branchId, callId }, key);
const branchView = (url: string, branchId: string, against?: string) => requestJson<BranchView>(url, HTTP_PATHS.branchView(SECRETARY, branchId, against));
const branchEvents = (frames: EventFrame[]) => frames.filter((f) => f.type === EVENT_TYPES.sessionBranch).map((f) => ({ seq: f.seq, ...(f.payload as SessionBranchEventPayload) }));
const historyTexts = async (frontend: TestFrontend) => (await frontend.history(SECRETARY)).messages.map((m) => ("message" in m ? textOf({ message: m.message }) : "已删除"));
const viewTexts = (view: BranchView) => view.messages.map((m) => ("message" in m ? textOf({ message: m.message }) : "已删除"));

describe("废弃分支：切换、详情、申请撤回", { timeout: LONG_TEST_MS }, () => {
  it("切换：不写摘要，原分支变废弃；秘书下一轮的上下文是那条分支原样，切回来也对；重启后不变", async () => {
    const dataDir = makeTempDir("ergo-switch-data-");
    const homeDir = makeTempDir("ergo-switch-home-");
    const first = await startTestDaemon({
      reuse: { dataDir, homeDir },
      // 只有这几次模型调用：切换不写摘要，多调一次就会拿到"不该有的调用"
      secretary: [say("好的，今天晴"), say("邮件写好了"), say(SUMMARY), say("会议室订好了"), say("不该有的调用")],
    });
    const phone = await TestFrontend.connect(first.url);
    await phone.subscribe({ [SECRETARY]: 0 });
    await phone.sendText("第一句：查天气");
    await waitTurns(phone, 1);
    const second = await phone.sendText("第二句：给老王写邮件");
    await waitTurns(phone, 2);
    const one = ok<RollbackSessionResult>(await rollback(phone, { messageId: second.messageId }, "k-rb"));
    expect(one.branchId).toBe("b1");
    await phone.sendText("第三句：订会议室");
    await waitTurns(phone, 3);

    // b0 被回退离开：它自己那一段是第二句和回复，分支摘要是回退时写的那份；没做过有副作用的事
    const abandoned = await branchView(first.url, "b0");
    expect(abandoned.status).toBe(200);
    expect(abandoned.body).toMatchObject({ conversation: SECRETARY, branchId: "b0", against: "b1", summary: SUMMARY, effects: [] });
    expect(viewTexts(abandoned.body)).toEqual(["第二句：给老王写邮件", "邮件写好了"]);
    // 当前分支不是废弃分支：自己那一段是空的
    expect((await branchView(first.url, "b1")).body.messages).toEqual([]);

    // 切到 b0：一条 session_branch（switch），b1 记下末端；模型没被多调（没写摘要）
    const switched = ok<SwitchBranchResult>(await switchTo(phone, "b0", "k-sw"));
    expect(switched).toEqual({ branchId: "b0" });
    await waitUntil(() => branchEvents(phone.events({ channel: SECRETARY })).length === 2);
    const sw = branchEvents(phone.events({ channel: SECRETARY })).at(-1)!;
    expect(sw).toMatchObject({ change: "switch", from: "b1", to: "b0", by: "user" });
    expect(sw.before).toBeUndefined();
    expect(sw.branches.current).toBe("b0");
    expect(sw.branches.epochs.at(-1)).toEqual({ from: sw.seq, branch: "b0" });
    expect(sw.branches.branches.find((b) => b.id === "b1")!.tip).toEqual(expect.any(String));
    expect(messages(phone).some((m) => textOf(m) === "不该有的调用")).toBe(false);
    // 同一个幂等键重发：同一个结果，不多切一次
    expect(ok<SwitchBranchResult>(await switchTo(phone, "b0", "k-sw"))).toEqual(switched);
    expect(first.daemon.store.read(SECRETARY, 0, EVENT_TYPES.sessionBranch)).toHaveLength(2);
    // 已经在这条上了、没有这条
    expect(await switchTo(phone, "b0", "k-sw-again")).toMatchObject({ ok: false, error: { code: "not_allowed", message: expect.stringContaining("已经在这条分支上") } });
    expect(await switchTo(phone, "b9", "k-sw-none")).toMatchObject({ ok: false, error: { code: "not_found" } });
    // 往上翻沿新的当前分支：b0 原样（没有分支摘要）
    expect(await historyTexts(phone)).toEqual(["第一句：查天气", "好的，今天晴", "第二句：给老王写邮件", "邮件写好了"]);
    // 现在废弃的是 b1：它自己那一段（分支摘要那条、第三句和回复）；它只被切换离开过，没有它的分支摘要
    const b1 = (await branchView(first.url, "b1")).body;
    expect(viewTexts(b1)).toEqual(["<branch_summary>", "第三句：订会议室", "会议室订好了"]);
    expect(b1.summary).toBeUndefined();
    // 别的设备切换之后要取的：b0 上不在 b1 路径上的那一段
    expect(viewTexts((await branchView(first.url, "b0", "b1")).body)).toEqual(["第二句：给老王写邮件", "邮件写好了"]);
    await first.daemon.stop();

    // 重启：分支照旧，秘书下一轮的上下文是 b0 原样——有第二句、没有 b1 上的分支摘要和第三句
    const again = await startTestDaemon({ reuse: { dataDir, homeDir }, secretary: [{ kind: "echo_context" }, { kind: "echo_context" }] });
    const laptop = await TestFrontend.connect(again.url);
    await laptop.subscribe({ [SECRETARY]: 0 });
    await waitUntil(() => branchEvents(laptop.events({ channel: SECRETARY })).length > 0);
    expect(branchEvents(laptop.events({ channel: SECRETARY })).at(-1)!.branches).toEqual(sw.branches);
    const replayed = turnEnds(laptop);
    await laptop.sendText("第四句：接着写邮件");
    await waitUntil(() => turnEnds(laptop) > replayed, { timeoutMs: SECRETARY_START_TIMEOUT_MS });
    const onB0 = textOf(messages(laptop).at(-1)!);
    expect(onB0).toContain("第一句：查天气");
    expect(onB0).toContain("第二句：给老王写邮件");
    expect(onB0).toContain("邮件写好了");
    expect(onB0).toContain("第四句：接着写邮件");
    expect(onB0).not.toContain("第三句");
    expect(onB0).not.toContain(SUMMARY);

    // 切回 b1：上下文是 b1 原样——开头的分支摘要照样在，第三句和回复在，b0 上的第二句、第四句不在
    ok<SwitchBranchResult>(await switchTo(laptop, "b1", "k-back"));
    const before = turnEnds(laptop);
    await laptop.sendText("第五句：会议改到下午");
    await waitUntil(() => turnEnds(laptop) > before, { timeoutMs: SECRETARY_START_TIMEOUT_MS });
    const onB1 = textOf(messages(laptop).at(-1)!);
    expect(onB1).toContain("第一句：查天气");
    expect(onB1).toContain(SUMMARY);
    expect(onB1).toContain("第三句：订会议室");
    expect(onB1).toContain("会议室订好了");
    expect(onB1).toContain("第五句：会议改到下午");
    expect(onB1).not.toContain("第二句");
    expect(onB1).not.toContain("第四句");
    // 往上翻：b1 的路径（它前面 b0 的那一截、分支摘要、第三句和回复、切回来之后的第五句和回复）
    expect(await historyTexts(laptop)).toEqual([
      "第一句：查天气",
      "好的，今天晴",
      "<branch_summary>",
      "第三句：订会议室",
      "会议室订好了",
      "第五句：会议改到下午",
      expect.stringContaining("第五句：会议改到下午"),
    ]);
    // b0 又被切换离开（切回来之后多了第四句）：回退时那份摘要说的是那时的 b0，不再算它的摘要
    const b0 = (await branchView(again.url, "b0")).body;
    expect(viewTexts(b0).slice(0, 2)).toEqual(["第二句：给老王写邮件", "邮件写好了"]);
    expect(viewTexts(b0)).toContain("第四句：接着写邮件");
    expect(b0.summary).toBeUndefined();
  });

  it("切换时正在回复：先停稳、这一轮中止；卡片不作废；排着的消息交给切过去的那条作为下一轮", async () => {
    const td = await startTestDaemon({
      secretary: [
        say("好"),
        say("记下了"),
        say("摘要：记了一笔"),
        // 新分支上的第三句：读用户目录外的文件，先问用户（审批卡），这一轮等着
        { kind: "reply", toolCalls: [{ name: "read", arguments: { path: "~/Documents/bill.txt" } }] },
        // 切回 b0 之后交出去的第四句：上下文是 b0 原样
        { kind: "branch_on_context", contains: ["第二句：记一笔", "第四句：顺便订餐厅"], matched: say("收到第四句"), otherwise: say("上下文不对") },
      ],
    });
    const phone = await TestFrontend.connect(td.url);
    await phone.subscribe({ [SECRETARY]: 0, [CARDS]: 0 });
    await phone.sendText("第一句");
    await waitTurns(phone, 1);
    const second = await phone.sendText("第二句：记一笔");
    await waitTurns(phone, 2);
    ok<RollbackSessionResult>(await rollback(phone, { messageId: second.messageId }, "k-rb"));
    const third = await phone.sendText("第三句：看看我的账单 ~/Documents/bill.txt");
    const cardFrame = await phone.next(CARDS, EVENT_TYPES.card, SECRETARY_START_TIMEOUT_MS);
    const card = (cardFrame.payload as CardEventPayload).card;
    expect(card.status).toBe("pending");
    const fourth = await phone.sendText("第四句：顺便订餐厅");
    expect(fourth.queued).toBe(true);

    ok<SwitchBranchResult>(await switchTo(phone, "b0", "k-busy"));
    await waitUntil(() => messages(phone).some((m) => textOf(m) === "收到第四句" || textOf(m) === "上下文不对"), { timeoutMs: 30_000 });
    expect(messages(phone).some((m) => textOf(m) === "收到第四句")).toBe(true);
    const frames = phone.events({ channel: SECRETARY, persistedOnly: true });
    const sw = frames.filter((f) => f.type === EVENT_TYPES.sessionBranch).at(-1)!;
    expect((sw.payload as SessionBranchEventPayload).expiredCards).toBeUndefined();
    const ended = frames.find((f) => f.type === EVENT_TYPES.turnEnd && (f.payload as { inputMessageId: string }).inputMessageId === third.messageId)!;
    expect((ended.payload as { outcome: string }).outcome).toBe("aborted");
    expect(ended.seq).toBeLessThan(sw.seq);
    const delivered = frames.find((f) => f.type === EVENT_TYPES.message && (f.payload as MessageEventPayload).message.id === fourth.messageId)!;
    expect(delivered.seq).toBeGreaterThan(sw.seq);
    // 卡片不作废（切换不动卡片）
    expect(cardsOf(phone).find((c) => c.id === card.id)!.status).not.toBe("expired");
  });

  it("申请撤回：记进事件日志、调撤销接口，再取还是已提交；对外的、删了没备份的、当前分支上的不能申请", async () => {
    const calls = [
      { name: "send_note", arguments: { what: "给老王发一句" } },
      { name: "wipe_notes", arguments: { what: "清空草稿" } },
      { name: "touch_note", arguments: { what: "记一笔" } },
      { name: "peek_note", arguments: { what: "看一眼" } },
    ];
    const asked: Parameters<NonNullable<SessionRollbackHook["onEffectUndoRequest"]>>[0][] = [];
    const td = await startTestDaemon({
      config: { guard: { conversationApprovals: "off" } },
      secretaryTools: [
        tool("send_note", "发便条", { categories: ["external_send"] }),
        tool("wipe_notes", "清空便条", { categories: ["delete_or_overwrite"], nature: "modify" }),
        tool("touch_note", "记便条", {}),
        tool("peek_note", "看便条", { nature: "look", readOnlyOrIdempotent: true }),
      ],
      secretary: [say("好"), { kind: "reply", toolCalls: calls }, say("都办了"), say("摘要：发了便条、清了草稿、记了一笔")],
      sessionRollbackHook: {
        onSessionRollback: async () => {},
        onEffectUndoRequest: async (event) => {
          asked.push(event);
        },
      },
    });
    const phone = await TestFrontend.connect(td.url);
    await phone.subscribe({ [SECRETARY]: 0, [CARDS]: 0 });
    await phone.sendText("第一句");
    await waitTurns(phone, 1);
    const second = await phone.sendText("第二句：把便条的事都办了");
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
      { timeoutMs: 30_000 },
    );
    ok<RollbackSessionResult>(await rollback(phone, { messageId: second.messageId }, "k-rb"));

    // 废弃的 b0：遗留效果三件（只看的不算），都还没申请
    const view = (await branchView(td.url, "b0")).body;
    expect(view.summary).toBe("摘要：发了便条、清了草稿、记了一笔");
    expect(view.effects.map((e) => [e.tool, e.scope, e.undoable, e.why, e.undoRequested])).toEqual([
      ["send_note", "external", false, "已经对外生效", undefined],
      ["wipe_notes", "local", false, "删除或覆盖，没有备份", undefined],
      ["touch_note", "local", true, undefined, undefined],
    ]);
    const touch = view.effects.find((e) => e.tool === "touch_note")!;

    // 申请撤回本机能撤的那件：一条 effect_undo_requested，调到撤销接口
    const result = ok<RequestEffectUndoResult>(await askUndo(phone, "b0", touch.callId, "k-undo"));
    expect(result.requestedAt).toEqual(expect.any(String));
    await waitUntil(() => phone.events({ channel: SECRETARY, type: EVENT_TYPES.effectUndoRequested }).length === 1);
    expect(phone.events({ channel: SECRETARY, type: EVENT_TYPES.effectUndoRequested })[0]!.payload as EffectUndoRequestedEventPayload).toMatchObject({
      branchId: "b0",
      callId: touch.callId,
      tool: "touch_note",
      by: "user",
      time: result.requestedAt,
    });
    await waitUntil(() => asked.length === 1);
    expect(asked[0]).toMatchObject({ conversation: SECRETARY, branchId: "b0", effect: { callId: touch.callId, tool: "touch_note", undoable: true } });
    // 再取（刷新之后）：还是已提交；别的设备再点同一件（另一个幂等键）拿到第一次的时间，不多记一笔、不多调一次
    expect((await branchView(td.url, "b0")).body.effects.find((e) => e.callId === touch.callId)!.undoRequested).toBe(result.requestedAt);
    expect(ok<RequestEffectUndoResult>(await askUndo(phone, "b0", touch.callId, "k-undo-2"))).toEqual(result);
    expect(td.daemon.store.read(SECRETARY, 0, EVENT_TYPES.effectUndoRequested)).toHaveLength(1);
    expect(asked).toHaveLength(1);

    // 不能申请的：对外的、删了没备份的（无法撤回）；当前分支上的；没有这件
    const external = view.effects.find((e) => e.tool === "send_note")!;
    const wiped = view.effects.find((e) => e.tool === "wipe_notes")!;
    expect(await askUndo(phone, "b0", external.callId, "k-x1")).toMatchObject({ ok: false, error: { code: "not_allowed", message: expect.stringContaining("无法撤回") } });
    expect(await askUndo(phone, "b0", wiped.callId, "k-x2")).toMatchObject({ ok: false, error: { code: "not_allowed", message: expect.stringContaining("无法撤回") } });
    expect(await askUndo(phone, "b1", touch.callId, "k-x3")).toMatchObject({ ok: false, error: { code: "not_allowed", message: expect.stringContaining("当前分支") } });
    expect(await askUndo(phone, "b0", "call-none", "k-x4")).toMatchObject({ ok: false, error: { code: "not_found" } });
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
