// 主切面：工具调用完整内容的保留期和总量上限（65 号票）。真的守护进程，agent 接 faux 剧本，时钟手动拨，测试扮演前端：
// - 守护进程每天定时清一次：过了保留期（默认 90 天）的完整内容只剩摘要；总量超过上限（默认 2 GB）时从最旧的起清到上限以内；
// - 还被用着的不清：没结束的任务里的调用、还在待办里的卡片引用到的调用；不用了以后下一次照样清；
// - 清掉的只是完整参数和返回：详情接口照样回 200，args、result 是摘要，cleared 注明原因；效果记录、聊天里的工具调用记录照旧；
// - 设置里看占了多大（GET /api/tool-call-storage），"现在就清理"按现在的规则马上清一次（POST /api/tool-call-storage/cleanup）；
// - 清了多少写一行日志。
import path from "node:path";
import { CHANNELS, EVENT_TYPES, type InboxItem, type InboxItemEventPayload, maintainerChannel, type MessageEventPayload, type MessagePart } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import type { FauxStep } from "../../src/runtime/index.ts";
import { openDatabase } from "../../src/storage/sqlite.ts";
import { ManualClock } from "../helpers/clock.ts";
import { type StartTestDaemonOptions, startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { toolCallDetail, toolCallStorageApi } from "../helpers/http.ts";
import { onePlan } from "../helpers/running-task.ts";
import { draftTask, inputsDone, maintainerScript, ok } from "../helpers/task-flow.ts";

const { secretary: SECRETARY, cards: CARDS, inbox: INBOX, board: BOARD } = CHANNELS;
const MAINTAINER = maintainerChannel("tm-1");
const T0 = new Date(2026, 9, 9, 10, 0);
const DAY = 86_400_000;
const KB = 1024;
const GB = 1024 ** 3;

type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const reply = (text: string): FauxStep => ({ kind: "reply", text });
const toolPartsOf = (frontend: TestFrontend, channel: string = SECRETARY): ToolCallPart[] =>
  frontend
    .events({ channel, type: EVENT_TYPES.message })
    .flatMap((f) => (f.payload as MessageEventPayload).message.parts)
    .filter((p): p is ToolCallPart => p.type === "tool_call");
const inboxOf = (frontend: TestFrontend): InboxItem[] => frontend.events({ channel: INBOX, type: EVENT_TYPES.inboxItem }).map((f) => (f.payload as InboxItemEventPayload).item);

/** 一段比摘要长得多的笔记（多行） */
const NOTES = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行：周三下午三点和装修师傅确认厨房的水电改造方案`).join("\n");

async function setup(options: {
  secretary: FauxStep[];
  maintainer?: StartTestDaemonOptions["maintainer"];
  config?: Record<string, unknown>;
  start?: number;
  reuse?: StartTestDaemonOptions["reuse"];
  memoryPlugin?: boolean;
}) {
  const clock = new ManualClock(options.start ?? T0);
  const logs: string[] = [];
  const td = await startTestDaemon({
    clock,
    secretary: options.secretary,
    ...(options.maintainer ? { maintainer: options.maintainer } : {}),
    ...(options.config ? { config: options.config } : {}),
    ...(options.reuse ? { reuse: options.reuse } : {}),
    ...(options.memoryPlugin === undefined ? {} : { memoryPlugin: options.memoryPlugin }),
    log: (line) => logs.push(line),
  });
  const frontend = await TestFrontend.connect(td.url);
  await frontend.subscribe({ [SECRETARY]: 0, [CARDS]: 0, [INBOX]: 0, [BOARD]: 0, [MAINTAINER]: 0 });
  await td.daemon.internalJobs.whenIdle();
  /** 跳到某个时刻（像电脑睡着又醒来）：途中到点的内部作业醒来时跑一次，等它们跑完 */
  const sleepUntil = async (time: number) => {
    clock.jumpTo(time);
    await td.daemon.internalJobs.whenIdle();
  };
  return { ...td, clock, frontend, logs, sleepUntil };
}

async function tell(frontend: TestFrontend, text: string) {
  await frontend.sendText(text);
  await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
}

describe("保留期", () => {
  it("过了 90 天的定时清掉：详情接口照样回 200，参数和返回只剩摘要，注明过了保留期；效果记录、聊天里的记录照旧；90 天以内的不清", async () => {
    const { url, frontend, daemon, logs, sleepUntil } = await setup({ secretary: [call("write", { path: "notes.md", content: NOTES }), reply("记好了")] });
    await tell(frontend, "把装修的事记下来");
    const [write] = toolPartsOf(frontend);
    const full = (await toolCallDetail(url, write!.callId)).body;
    expect(full.args).toEqual({ path: "notes.md", content: NOTES });

    const before = (await toolCallStorageApi.view(url)).body;
    expect(before).toMatchObject({ calls: 1, cleared: 0, retentionDays: 90, maxBytes: 2 * GB, due: { calls: 0, bytes: 0, inUse: 0 } });
    expect(before.bytes).toBeGreaterThan(Buffer.byteLength(NOTES));

    // 第 89 天：还在保留期里
    await sleepUntil(T0.getTime() + 89 * DAY);
    expect((await toolCallDetail(url, write!.callId)).body.args).toEqual({ path: "notes.md", content: NOTES });

    await sleepUntil(T0.getTime() + 91 * DAY);
    const cleared = await toolCallDetail(url, write!.callId);
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({
      callId: write!.callId,
      tool: "write",
      toolTitle: "写文件",
      agentId: "secretary",
      conversation: SECRETARY,
      outcome: "done",
      isError: false,
      args: write!.argsSummary,
      result: write!.resultSummary,
      cleared: { reason: "expired", at: expect.any(String) },
    });
    // 效果记录照旧
    expect(cleared.body.effects).toEqual(full.effects);
    expect(full.effects).toHaveLength(1);
    // 完整内容的原文不留了（效果日志不在这份完整内容里，56 号票的效果记录照旧）；聊天里的工具调用记录还在
    expect(JSON.stringify(daemon.store.read("tool_calls"))).not.toContain("第 2 行");
    expect(daemon.store.read(SECRETARY, 0, EVENT_TYPES.message).flatMap((e) => (e.payload as MessageEventPayload).message.parts)).toContainEqual(write);

    const after = (await toolCallStorageApi.view(url)).body;
    expect(after).toMatchObject({ calls: 0, cleared: 1, due: { calls: 0 } });
    // 腾出的差不多就是笔记那么大（剩下的摘要只有几百字节）
    expect(before.bytes - after.bytes).toBeGreaterThan(Buffer.byteLength(NOTES) - 1024);
    expect(logs.filter((l) => l.includes("工具调用的完整内容")).at(-1)).toMatch(/清掉 1 次（过了保留期 1 次、超出总量上限 0 次）/);
  });
});

describe("总量上限", () => {
  it("超出上限时从最旧的清，清到上限以内；设置里先看到会清掉几次，\"现在就清理\"马上清并回清了多少，再点一次没有可清的", async () => {
    const piece = (mark: string) => mark.repeat(Math.round((10 * KB) / 3));
    const { url, frontend } = await setup({
      secretary: [call("write", { path: "a.md", content: piece("甲") }), call("write", { path: "b.md", content: piece("乙") }), call("write", { path: "c.md", content: piece("丙") }), reply("写好了")],
      config: { toolCallDetails: { maxSizeGB: (25 * KB) / GB } },
    });
    await tell(frontend, "写三个文件");
    const [a, b, c] = toolPartsOf(frontend);

    const before = (await toolCallStorageApi.view(url)).body;
    expect(before).toMatchObject({ calls: 3, maxBytes: 25 * KB, due: { calls: 1, inUse: 0 } });
    expect(before.bytes).toBeGreaterThan(30 * KB);
    expect(before.due.bytes).toBeGreaterThan(9 * KB);

    const done = await toolCallStorageApi.cleanup(url);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ trigger: "manual", expired: 0, overLimit: 1, keptInUse: 0, calls: 2 });
    expect(done.body.freedBytes).toBeGreaterThan(9 * KB);
    expect(done.body.bytes).toBeLessThanOrEqual(25 * KB);

    expect((await toolCallDetail(url, a!.callId)).body).toMatchObject({ args: "a.md", cleared: { reason: "over_limit" } });
    for (const p of [b, c]) {
      const { body } = await toolCallDetail(url, p!.callId);
      expect(body).not.toHaveProperty("cleared");
      expect((body.args as { content: string }).content).toHaveLength(Math.round((10 * KB) / 3));
    }

    expect((await toolCallStorageApi.view(url)).body).toMatchObject({ calls: 2, cleared: 1, due: { calls: 0, bytes: 0 } });
    expect((await toolCallStorageApi.cleanup(url)).body).toMatchObject({ expired: 0, overLimit: 0, freedBytes: 0 });
  });
});

describe("还被用着的不清", () => {
  it("没结束的任务里的调用、还在待办里的卡片引用到的调用到期也不清；任务取消、卡片从待办里删掉之后，下一次照样清", async () => {
    const td = await setup({
      secretary: [call("propose_quick_action", { type: "remember", params: { content: "对青霉素过敏" } }), call("write", { path: "a.md", content: "随手记" }), reply("好")],
      maintainer: maintainerScript(onePlan(), [reply("好的")]),
      // 265 号票：给了 clock 时底座默认停掉记忆插件；"记住"的快速动作是它的（待办里的那张卡靠它），打开，
      // 但只关掉整理（memory.enabled）：这条拨时钟跨过两个 03:00，不要后台唤醒记忆管理员
      config: { toolCallDetails: { retentionDays: 1 }, memory: { enabled: false } },
      memoryPlugin: true,
    });
    const { url, frontend, logs, sleepUntil } = td;
    await tell(frontend, "我好像青霉素过敏，另外随手记一笔");
    const [propose, write] = toolPartsOf(frontend);
    const item = inboxOf(frontend).find((i) => i.kind === "card")!;
    expect(item).toBeDefined();

    const draft = await draftTask(td, frontend, "整理笔记");
    // 计划卡和交计划的那条工具调用记录在两个频道上，卡可能先到：等起草的这一轮结束再找
    await inputsDone(frontend, MAINTAINER);
    const submit = toolPartsOf(frontend, MAINTAINER).find((p) => p.tool === "submit_plan")!;
    expect((await toolCallDetail(url, submit.callId)).body.taskId).toBe(draft.taskId);

    await sleepUntil(T0.getTime() + 2 * DAY);
    expect((await toolCallDetail(url, write!.callId)).body).toMatchObject({ cleared: { reason: "expired" } });
    expect((await toolCallDetail(url, propose!.callId)).body).not.toHaveProperty("cleared");
    expect((await toolCallDetail(url, submit.callId)).body).not.toHaveProperty("cleared");
    expect(logs.filter((l) => l.includes("工具调用的完整内容")).at(-1)).toMatch(/还被用着没清 2 次/);
    expect((await toolCallStorageApi.view(url)).body.due).toMatchObject({ calls: 0, inUse: 2 });

    ok(await frontend.inboxAction({ itemIds: [item.id], action: "delete" }));
    ok(await frontend.taskAction({ taskId: draft.taskId, action: "cancel" }));
    await sleepUntil(T0.getTime() + 3 * DAY);
    expect((await toolCallDetail(url, propose!.callId)).body).toMatchObject({ cleared: { reason: "expired" } });
    expect((await toolCallDetail(url, submit.callId)).body).toMatchObject({ cleared: { reason: "expired" }, taskId: draft.taskId });
  });
});

describe("本票之前的数据目录", () => {
  it("视图里没有时间、大小这几列（53 号票建的表）：启动时从事件日志补上；停机期间错过的清理开机后补一次，照样清掉过期的", async () => {
    const first = await setup({ secretary: [call("write", { path: "notes.md", content: NOTES }), reply("记好了")] });
    await tell(first.frontend, "把装修的事记下来");
    const [write] = toolPartsOf(first.frontend);
    const before = (await toolCallStorageApi.view(first.url)).body;
    const dbFile = path.join(first.daemon.layout.db, "ergo.db");
    await first.daemon.stop();

    // 换回 53 号票的表：只有调用 id、工具、agent、会话、项目
    const db = openDatabase(dbFile);
    db.exec(`
      DROP TABLE tool_call_details;
      CREATE TABLE tool_call_details (global_seq INTEGER PRIMARY KEY, call_id TEXT NOT NULL, tool TEXT NOT NULL, agent_id TEXT NOT NULL, conversation TEXT, project_id TEXT);
      INSERT INTO tool_call_details SELECT global_seq, json_extract(payload, '$.callId'), json_extract(payload, '$.tool'), json_extract(payload, '$.agentId'), json_extract(payload, '$.conversation'), NULL
        FROM events WHERE channel = 'tool_calls';
    `);
    db.close();

    const second = await setup({ secretary: [], start: T0.getTime() + 91 * DAY, reuse: { dataDir: first.dataDir, homeDir: first.homeDir } });
    expect((await toolCallDetail(second.url, write!.callId)).body).toMatchObject({ args: "notes.md", cleared: { reason: "expired" } });
    const after = (await toolCallStorageApi.view(second.url)).body;
    expect(after).toMatchObject({ calls: 0, cleared: 1 });
    expect(before.bytes - after.bytes).toBeGreaterThan(Buffer.byteLength(NOTES) - 1024);
    expect(second.logs.filter((l) => l.includes("工具调用的完整内容"))).toEqual([expect.stringMatching(/清掉 1 次（过了保留期 1 次/)]);
  });
});
