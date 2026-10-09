// 主切面：工具调用的完整参数和返回（53 号票，详情页用）。真的守护进程，agent 接 faux 剧本，测试扮演前端：
// 聊天里的工具调用 part 照旧只带摘要；按调用 id 经 HTTP 取完整参数和完整返回（GET /api/tool-calls/<调用 id>）——
// 普通的、被拦下的、出错的都有；和摘要一样擦掉读过的密钥值、读了密钥文件的不记返回；单个值超过 200KB 截断并注明；
// 守护进程被杀后重启照样取得到；彻底删除后只剩删除标记；外网端口和别的接口一样要设备凭证。
// 56 号票起执行成功的顺带这次调用的效果记录（摘要、涉及的对象），旧记录按紧跟在调用记录后面找；彻底删除、删除项目时
// 按调用 id 找到的效果日志一起改写，调用 id 去掉。
import fs from "node:fs";
import path from "node:path";
import {
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  HTTP_PATHS,
  type HttpErrorBody,
  maintainerChannel,
  type MessageEventPayload,
  type MessagePart,
  METHODS,
  type Plan,
  type ProjectEventPayload,
  PURGED_TEXT,
  type ResponseFrame,
  type TaskEventPayload,
  type ToolCallDetail,
  type WorkOrderEventPayload,
} from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { buildAgentNotice } from "../../src/conversation/messages.ts";
import type { EventStore } from "../../src/events/event-store.ts";
import type { EffectRecord } from "../../src/guard/index.ts";
import { type EffectRecordedPayload, GUARD_CHANNEL, GUARD_EVENTS } from "../../src/guard-runtime/events.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { realPathOf } from "../../src/util/real-path.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { pairDevice, TestDevice } from "../helpers/device.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { materialsApi, toolCallDetail } from "../helpers/http.ts";
import { png } from "../helpers/images.ts";
import { restartAfterKill, startKillableDaemon } from "../helpers/killable-daemon.ts";
import { samplePlan, submitPlanStep } from "../helpers/plans.ts";
import { waitUntil } from "../helpers/process.ts";
import { seedProject } from "../helpers/projects.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { secretary: SECRETARY, cards: CARDS, board: BOARD, inbox: INBOX, projects: PROJECTS } = CHANNELS;
const MAINTAINER = maintainerChannel("tm-1");
/** .env 里一个没有前缀的随机值（密钥形态的正则认不出） */
const ENV_VALUE = "Zq81mWp4vX2cT9";

type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const reply = (text: string): FauxStep => ({ kind: "reply", text });
/** 秘书照着检索结果里的素材 id 提议删除（21 号票的记忆删除卡） */
const proposeFromResults = (type: "purge"): FauxStep => ({
  kind: "call_with_matches",
  toolCall: { name: "propose_quick_action", arguments: { type, params: {} } },
  argument: "params.materialIds",
  pattern: "mat-[0-9a-f]{24}",
});
const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
const boardOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.task }).map((f) => f.payload as TaskEventPayload);
const projectEventsOf = (frontend: TestFrontend) => frontend.events({ channel: PROJECTS, type: EVENT_TYPES.project }).map((f) => f.payload as ProjectEventPayload);
const ok = (r: ResponseFrame) => {
  if (!r.ok) throw new Error(`请求失败：${r.error.code} ${r.error.message}`);
  return r.result;
};
async function eventually<T>(list: () => readonly T[], match: (x: T) => boolean, what: string, timeoutMs = 30_000): Promise<T> {
  let found: T | undefined;
  await waitUntil(() => (found = list().filter(match).at(-1)) !== undefined, { timeoutMs, describe: () => `等${what}` });
  return found!;
}

/** 只有一个阶段：在工作目录里写出 weekly.md，由评审子 agent 判 */
function reviewedPlan(): Plan {
  return {
    ...samplePlan(),
    stages: [
      {
        stageId: "s1",
        title: "写周报",
        deliverables: ["weekly.md"],
        acceptance: [{ criterion: "周报写了本周的事", method: "review" }],
        mode: "open",
        dependsOn: [],
        policy: { grants: [], temporalRules: [] },
        budget: { tokens: 100_000, toolCalls: 30 },
      },
    ],
    stageGroups: [],
    scheduledJobs: [],
    stops: { count: 0, where: [] },
    toolkit: { skills: [], mcp: [], bash: false, network: false },
  };
}

const toolPartsOf = (frontend: TestFrontend, channel: string = SECRETARY): ToolCallPart[] =>
  frontend
    .events({ channel, type: EVENT_TYPES.message })
    .flatMap((f) => (f.payload as MessageEventPayload).message.parts)
    .filter((p): p is ToolCallPart => p.type === "tool_call");

/** 效果日志里的全部记录（守卫频道上的 effect_recorded） */
const effectLog = (store: EventStore): EffectRecord[] => store.read(GUARD_CHANNEL, 0, GUARD_EVENTS.effectRecorded).flatMap((e) => (e.payload as EffectRecordedPayload).records);

/** 把这次调用的效果日志改回加上调用 id 之前的样子（像 56 号票之前的守护进程写下的）：位置不变，去掉调用 id */
function asLegacyEffects(store: EventStore, callId: string): void {
  const events = store.read(GUARD_CHANNEL, 0, GUARD_EVENTS.effectRecorded).filter((e) => (e.payload as EffectRecordedPayload).records.some((r) => r.callId === callId));
  expect(events).toHaveLength(1);
  const purge = events.map((e) => {
    const records = (e.payload as EffectRecordedPayload).records.map((r) => {
      const old: EffectRecord = { ...r };
      delete old.callId;
      return old;
    });
    return { globalSeq: e.globalSeq, payload: { records } satisfies EffectRecordedPayload };
  });
  store.appendBatch([], { purge });
}

/** 目录下的全部文件（往下走） */
const filesUnder = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? filesUnder(path.join(dir, d.name)) : [path.join(dir, d.name)]));

async function tell(frontend: TestFrontend, text: string) {
  await frontend.sendText(text);
  await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
}

/** 一段比摘要长得多的笔记（多行） */
const NOTES = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行：周三下午三点和装修师傅确认厨房的水电改造方案`).join("\n");

describe("按调用 id 取完整参数和返回", () => {
  it("普通调用：完整参数、完整返回（工具名、中文名、agent、会话、结局）；聊天里的工具调用 part 照旧只带摘要；没有的调用 404", async () => {
    const { url } = await startTestDaemon({ secretary: [call("write", { path: "notes.md", content: NOTES }), call("bash", { command: "cat notes.md" }), reply("记好了")] });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await tell(frontend, "把装修的事记下来");

    const [write, cat] = toolPartsOf(frontend);
    // 消息里只有摘要
    expect(write).toMatchObject({ tool: "write", argsSummary: "notes.md", outcome: "done" });
    expect(cat!.resultSummary).toMatch(/^第 1 行：.*…$/);
    expect(JSON.stringify(frontend.events({ channel: SECRETARY }))).not.toContain("第 40 行");

    const writeDetail = await toolCallDetail(url, write!.callId);
    expect(writeDetail.status).toBe(200);
    expect(writeDetail.body).toMatchObject({
      callId: write!.callId,
      tool: "write",
      toolTitle: "写文件",
      agentId: "secretary",
      conversation: SECRETARY,
      outcome: "done",
      isError: false,
      args: { path: "notes.md", content: NOTES },
      result: expect.stringContaining("Successfully wrote"),
    });
    expect(writeDetail.body).not.toHaveProperty("truncated");

    const catDetail = await toolCallDetail(url, cat!.callId);
    expect(catDetail.body).toMatchObject({ tool: "bash", toolTitle: "通用 bash", outcome: "done", isError: false, args: { command: "cat notes.md" } });
    expect(catDetail.body.result.trimEnd()).toBe(NOTES);

    const missing = await toolCallDetail(url, "no-such-call");
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("not_found");
  });

  it("被拦下的、出错的：参数照样完整；被拦下的返回是模型收到的说明，出错的是出错的原文", async () => {
    const outside = realPathOf(makeTempDir("ergou-outside-"))!;
    const target = path.join(outside, "x.txt");
    const { url } = await startTestDaemon({
      secretary: [call("write", { path: target, content: "不该写出去的内容" }), call("bash", { command: "cat missing.txt" }), reply("都没成")],
    });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await tell(frontend, "写个文件再看看另一个");

    const [blocked, failed] = toolPartsOf(frontend);
    expect([blocked!.outcome, failed!.outcome]).toEqual(["blocked", "error"]);
    expect((await toolCallDetail(url, blocked!.callId)).body).toMatchObject({
      tool: "write",
      outcome: "blocked",
      isError: true,
      args: { path: target, content: "不该写出去的内容" },
      result: expect.stringContaining("秘书的文件工具只能写草稿区"),
    });
    expect((await toolCallDetail(url, failed!.callId)).body).toMatchObject({
      tool: "bash",
      outcome: "error",
      isError: true,
      args: { command: "cat missing.txt" },
      result: expect.stringMatching(/missing\.txt: No such file or directory/),
    });
    expect(fs.existsSync(target)).toBe(false);
  });

  it("单个值超过 200KB：只留开头 200KB，末尾注明已截断和原长，truncated 里列出位置；别的值、写进去的文件不受影响", async () => {
    const big = "装".repeat(100 * 1024); // 300KB（每个字 3 字节）
    const { url, dataDir } = await startTestDaemon({ secretary: [call("write", { path: "big.txt", content: big, note: "小的值不截" }), reply("写好了")] });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await tell(frontend, "写个大文件");

    const [write] = toolPartsOf(frontend);
    const { body } = await toolCallDetail(url, write!.callId);
    expect(body.truncated).toEqual([{ pointer: "/args/content", bytes: 300 * 1024 }]);
    const content = (body.args as { content: string }).content;
    const [kept, note] = content.split("\n");
    expect(kept).toBe("装".repeat(Math.floor((200 * 1024) / 3)));
    expect(note).toBe(`…（已截断：原长 ${300 * 1024} 字节，只留开头 200 KB）`);
    expect(body.args).toMatchObject({ path: "big.txt", note: "小的值不截" });
    expect(body.result).toContain("Successfully wrote");
    expect(fs.readFileSync(path.join(dataDirLayout(realPathOf(dataDir)!).scratch, "big.txt"), "utf8")).toBe(big);
  });
});

describe("效果记录（56 号票）", () => {
  it("执行成功的顺带这次调用的效果记录：摘要、涉及的对象；通用 bash 拆出来的几条各一条；被拦下的、出错的没有", async () => {
    const outside = realPathOf(makeTempDir("ergou-outside-"))!;
    const { url, dataDir, daemon } = await startTestDaemon({
      secretary: [
        call("write", { path: "notes.md", content: NOTES }),
        call("bash", { command: "cp notes.md backup.md && cat notes.md" }),
        call("write", { path: path.join(outside, "x.txt"), content: "不该写出去的内容" }),
        call("bash", { command: "cat missing.txt" }),
        reply("记好了"),
      ],
    });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await tell(frontend, "把装修的事记下来，备份一份");
    const scratch = dataDirLayout(realPathOf(dataDir)!).scratch;

    const [write, bash, blocked, failed] = toolPartsOf(frontend);
    expect([write, bash, blocked, failed].map((p) => p?.outcome)).toEqual(["done", "done", "blocked", "error"]);
    const writeDetail = (await toolCallDetail(url, write!.callId)).body;
    expect(writeDetail.effects).toEqual([
      {
        seq: expect.any(Number),
        tool: "write",
        toolTitle: "写文件",
        summary: expect.stringMatching(/^写文件；改动 .*notes\.md；成功；结果：Successfully wrote/),
        objects: [{ kind: "path", access: "write", value: path.join(scratch, "notes.md") }],
      },
    ]);
    // 通用 bash：拆出来的复制、读各一条，摘要带着那段命令
    const bashDetail = (await toolCallDetail(url, bash!.callId)).body;
    expect(bashDetail.effects?.map((e) => e.tool)).toEqual(["copy", "read"]);
    expect(bashDetail.effects![0]).toMatchObject({
      toolTitle: "复制",
      summary: expect.stringContaining("bash「cp notes.md backup.md"),
      objects: [
        { kind: "path", access: "read", value: path.join(scratch, "notes.md") },
        { kind: "path", access: "write", value: path.join(scratch, "backup.md") },
      ],
    });
    expect(bashDetail.effects![1]).toMatchObject({ toolTitle: "读文件", objects: [{ kind: "path", access: "read", value: path.join(scratch, "notes.md") }] });
    // 序号就是效果日志里的那几条，记着这次调用的 id
    expect(
      effectLog(daemon.store)
        .filter((r) => r.callId === bash!.callId)
        .map((r) => r.seq),
    ).toEqual(bashDetail.effects!.map((e) => e.seq));

    for (const notDone of [blocked!, failed!]) expect((await toolCallDetail(url, notDone.callId)).body).not.toHaveProperty("effects");
  });

  it("加上调用 id 之前的旧记录：按紧跟在这次调用的记录后面找到；不是紧跟着的、别的 agent 的不算；按调用 id 找时也只认同一个 agent 的", async () => {
    const { url, daemon } = await startTestDaemon({ secretary: [call("write", { path: "notes.md", content: NOTES }), reply("记好了")] });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await tell(frontend, "把装修的事记下来");
    const [write] = toolPartsOf(frontend);
    const store = daemon.store;
    const detail = store.read("tool_calls").at(-1)!.payload as ToolCallDetail;
    const record = store
      .read(SECRETARY, 0, EVENT_TYPES.message)
      .map((e) => e.payload as MessageEventPayload)
      .find((p) => p.message.parts.some((part) => part.type === "tool_call" && part.callId === write!.callId))!;
    const effect = effectLog(store).find((r) => r.callId === write!.callId)!;

    /** 像加上调用 id 之前的守护进程那样写下一次调用：完整内容、会话里的工具调用记录、效果日志（不带调用 id）；between：记录和效果日志之间插了别的 */
    const legacy = (callId: string, agentId: string, between: boolean) => {
      const old: EffectRecord = { ...effect, seq: Math.max(...effectLog(store).map((r) => r.seq)) + 1, agentId, summary: `旧记录 ${callId}` };
      delete old.callId;
      const message = { ...record.message, id: `msg-${callId}`, parts: record.message.parts.map((p) => ({ ...p, callId })) };
      store.appendBatch([
        { channel: "tool_calls", type: "tool_call_detail", payload: { ...detail, callId } },
        { channel: SECRETARY, type: EVENT_TYPES.message, payload: { ...record, message } },
        ...(between ? [{ channel: GUARD_CHANNEL, type: "test_marker", payload: {} }] : []),
        { channel: GUARD_CHANNEL, type: GUARD_EVENTS.effectRecorded, payload: { records: [old] } satisfies EffectRecordedPayload },
      ]);
    };
    legacy("old-1", "secretary", false);
    legacy("old-2", "secretary", true);
    legacy("old-3", "tm-9", false);

    expect((await toolCallDetail(url, "old-1")).body.effects).toEqual([
      { seq: expect.any(Number), tool: "write", toolTitle: "写文件", summary: "旧记录 old-1", objects: [expect.objectContaining({ kind: "path", access: "write" })] },
    ]);
    expect((await toolCallDetail(url, "old-2")).body.effects).toEqual([]);
    expect((await toolCallDetail(url, "old-3")).body.effects).toEqual([]);
    // 新记录照调用 id 找，不受后来追加的旧记录影响；别的 agent 碰巧用了同一个调用 id 的不算
    const other: EffectRecord = { ...effect, seq: Math.max(...effectLog(store).map((r) => r.seq)) + 1, agentId: "tm-9", summary: "别的 agent 同号的调用" };
    store.append({ channel: GUARD_CHANNEL, type: GUARD_EVENTS.effectRecorded, payload: { records: [other] } satisfies EffectRecordedPayload });
    expect((await toolCallDetail(url, write!.callId)).body.effects?.map((e) => e.summary)).toEqual([expect.stringMatching(/^写文件；/)]);
  });
});

describe("二进制返回", () => {
  it("读图片：返回里的图片不内联（文字里是 [image] 占位），media 说明是图片、类型和大小", async () => {
    const dataDir = makeTempDir("ergou-data-");
    const homeDir = makeTempDir("ergou-home-");
    const scratch = dataDirLayout(dataDir).scratch;
    fs.mkdirSync(scratch, { recursive: true });
    fs.writeFileSync(path.join(scratch, "pic.png"), png({ width: 8, height: 4 }));
    const { url } = await startTestDaemon({ secretary: [call("read", { path: "pic.png" }), reply("是一张黑图")], reuse: { dataDir, homeDir } });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await tell(frontend, "看看这张图");

    const [read] = toolPartsOf(frontend);
    const { body } = await toolCallDetail(url, read!.callId);
    expect(body).toMatchObject({ tool: "read", outcome: "done", result: expect.stringContaining("[image]"), media: [{ type: "image", mimeType: "image/png", bytes: expect.any(Number) }] });
    expect(body.result).not.toMatch(/iVBOR/);
  });
});

describe("持久", () => {
  it("守护进程被杀后重启：以前的调用照样取得到", async () => {
    const killable = await startKillableDaemon({ secretary: [call("write", { path: "notes.md", content: NOTES }), reply("记好了")] });
    const frontend = await TestFrontend.connect(killable.url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await tell(frontend, "把装修的事记下来");
    const [write] = toolPartsOf(frontend);
    await killable.kill();

    const td = await restartAfterKill(killable);
    const { status, body } = await toolCallDetail(td.url, write!.callId);
    expect(status).toBe(200);
    expect(body).toMatchObject({ tool: "write", outcome: "done", args: { path: "notes.md", content: NOTES } });
  }, 90_000);
});

describe("彻底删除", () => {
  it("审批决定被彻底删除（设置里按会话删）：那次调用的完整内容只剩删除标记，工具和结局还在，拒绝时写的说明取不到", async () => {
    const { url, homeDir } = await startTestDaemon({ secretary: [call("read", { path: "~/Documents/diary.txt" }), reply("好的，不看了")] });
    const home = realPathOf(homeDir)!;
    fs.mkdirSync(path.join(home, "Documents"), { recursive: true });
    fs.writeFileSync(path.join(home, "Documents", "diary.txt"), "今天心情不错");
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0, [CARDS]: 0 });
    await frontend.sendText("看看 ~/Documents/diary.txt");
    await waitUntil(() => cardsOf(frontend).some((c) => c.type === "approval"), { timeoutMs: 20_000, describe: () => "等审批卡" });
    const approval = cardsOf(frontend).find((c) => c.type === "approval")!;
    await frontend.cardAction({ cardId: approval.id, action: "deny", expectedVersion: approval.version, note: "这是我的私人日记，别看" });
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
    const [read] = toolPartsOf(frontend);
    const before = await toolCallDetail(url, read!.callId);
    expect(before.body).toMatchObject({ tool: "read", outcome: "denied", args: { path: "~/Documents/diary.txt" }, result: expect.stringContaining("这是我的私人日记，别看") });

    expect((await materialsApi.delete(url, { scope: { kind: "conversation", conversation: SECRETARY }, mode: "purge", idempotencyKey: "purge-all" })).status).toBe(200);
    const after = await toolCallDetail(url, read!.callId);
    expect(after.status).toBe(200);
    expect(after.body).toEqual({ ...before.body, args: { path: PURGED_TEXT }, result: PURGED_TEXT, purged: true });
    expect(JSON.stringify(after.body)).not.toContain("私人日记");
  });

  it("检索结果里列出过的素材被彻底删除：它不在结果摘要里、只在完整返回里时，那次检索的完整内容照样改写", async () => {
    const said = ["房东说下个月要涨租金，问我续不续", "房东要把阳台的洗衣机换掉，周六上门", "房东的女儿下周来看房子，说想自己住"];
    const { url, daemon } = await startTestDaemon({
      secretary: [reply("嗯"), reply("嗯"), reply("嗯"), call("search_materials", { query: "房东" }), proposeFromResults("purge"), reply("请核对")],
    });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0, [CARDS]: 0 });
    for (const text of said) await tell(frontend, text);
    await tell(frontend, "彻底删除房东女儿要来看房的事");
    const search = toolPartsOf(frontend).find((p) => p.tool === "search_materials")!;
    const before = (await toolCallDetail(url, search.callId)).body;
    const listed = [...before.result.matchAll(/mat-[0-9a-f]{24}/g)].map((m) => m[0]);
    expect(listed).toHaveLength(3);
    // 结果摘要只有开头：最后一条素材不在摘要里，只在完整返回里
    const last = listed.at(-1)!;
    expect(search.resultSummary).not.toContain(last);
    const excerpt = said.find((s) => before.result.split("\n").find((l) => l.includes(last))!.includes(s))!;
    expect(search.resultSummary).not.toContain(excerpt);
    // 这次检索的效果记录（56 号票）：它的工具调用记录不会被改写（摘要里没有这条素材），只能按调用 id 找到
    expect(before.effects).toEqual([expect.objectContaining({ tool: "search_materials", summary: expect.stringContaining("成功") })]);
    const effectSeq = before.effects![0]!.seq;

    const card = cardsOf(frontend).find((c) => c.type === "memory_delete")!;
    await frontend.cardAction({ cardId: card.id, action: "delete", expectedVersion: 1, input: { mode: "purge", materialIds: [last] } });
    await frontend.next(SECRETARY, EVENT_TYPES.messagesPurged);
    const after = (await toolCallDetail(url, search.callId)).body;
    expect(after).toMatchObject({ tool: "search_materials", outcome: "done", purged: true, result: PURGED_TEXT });
    expect(after).not.toHaveProperty("effects");
    expect(JSON.stringify(after)).not.toContain(excerpt);
    expect(JSON.stringify(daemon.store.readGlobal(0, 100_000))).not.toContain(excerpt);
    // 效果日志里那一条：摘要换成删除标记、调用 id 去掉，序号和工具还在
    const purged = effectLog(daemon.store).find((r) => r.seq === effectSeq)!;
    expect(purged).toMatchObject({ tool: "search_materials", summary: PURGED_TEXT });
    expect(purged).not.toHaveProperty("callId");
  });

  it.each([
    ["记了调用 id 的，按调用 id 找到", false],
    ["加上调用 id 之前的旧记录，按紧跟在调用记录后面找到", true],
  ])("批准过的通用 bash 被彻底删除（设置里按会话删）：拆出来的效果记录（工具和调用记录对不上）一起改写——%s", async (_how, legacy) => {
    const { url, homeDir, daemon } = await startTestDaemon({ secretary: [call("bash", { command: "cat ~/Documents/diary.txt" }), reply("看过了")] });
    const home = realPathOf(homeDir)!;
    fs.mkdirSync(path.join(home, "Documents"), { recursive: true });
    fs.writeFileSync(path.join(home, "Documents", "diary.txt"), "今天心情不错");
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0, [CARDS]: 0 });
    await frontend.sendText("看看 ~/Documents/diary.txt");
    await waitUntil(() => cardsOf(frontend).some((c) => c.type === "approval"), { timeoutMs: 20_000, describe: () => "等审批卡" });
    const approval = cardsOf(frontend).find((c) => c.type === "approval")!;
    ok(await frontend.cardAction({ cardId: approval.id, action: "approve", expectedVersion: approval.version }));
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
    const [bash] = toolPartsOf(frontend);
    const before = (await toolCallDetail(url, bash!.callId)).body;
    expect(before.effects).toEqual([
      expect.objectContaining({ tool: "read", summary: expect.stringContaining("今天心情不错"), objects: [{ kind: "path", access: "read", value: path.join(home, "Documents", "diary.txt") }] }),
    ]);
    if (legacy) asLegacyEffects(daemon.store, bash!.callId);
    // 改回旧记录之后详情里照样找得到（按紧跟着）
    expect((await toolCallDetail(url, bash!.callId)).body.effects).toEqual(before.effects);

    expect((await materialsApi.delete(url, { scope: { kind: "conversation", conversation: SECRETARY }, mode: "purge", idempotencyKey: "purge-all" })).status).toBe(200);
    const after = (await toolCallDetail(url, bash!.callId)).body;
    expect(after).toMatchObject({ purged: true, result: PURGED_TEXT });
    expect(after).not.toHaveProperty("effects");
    const purged = effectLog(daemon.store).find((r) => r.seq === before.effects![0]!.seq)!;
    expect(purged).toMatchObject({ tool: "read", summary: PURGED_TEXT, args: { path: PURGED_TEXT } });
    expect(purged).not.toHaveProperty("callId");
    expect(JSON.stringify(effectLog(daemon.store))).not.toContain("今天心情不错");
  });
});

describe("删除项目", () => {
  it("评审子 agent 的调用（不在任何会话里）带着任务、阶段、项目的归属；删除项目后它读过的内容和维护者写的一样取不到", async () => {
    const dataDir = makeTempDir("ergou-data-");
    const homeDir = makeTempDir("ergou-home-");
    const records = path.join(fs.realpathSync.native(dataDir), "projects", "p-1");
    const weekly = "# 周报\n本周和房东谈妥了续租，下周搬书架\n";
    const td = await startTestDaemon({
      reuse: { dataDir, homeDir },
      secretary: [reply("好的")],
      maintainer: (_id, spawn) =>
        spawn === 1
          ? [submitPlanStep(reviewedPlan()), call("write_progress", { content: "周报：计划交了。" }), call("write_segment_summary", { summary: "起草了周报的计划" }), reply("交了")]
          : [
              call("write", { path: "weekly.md", content: weekly }),
              call("complete_stage", { stageId: "s1", summary: "周报写好了" }),
              call("edit", { path: path.join(records, "progress.md"), edits: [{ oldText: "周报：计划交了。", newText: "周报做完了。" }] }),
              call("write_segment_summary", { summary: "周报做完了" }),
              reply("做完了"),
            ],
      reviewer: () => [call("read", { path: "weekly.md" }), call("submit_review", { results: [{ index: 1, passed: true, reason: "写了本周的事" }] }), reply("评审完了")],
    });
    seedProject(td.daemon, "记账本", { state: "in_use", charterConfirmed: true, kind: "dev", toolkit: { skills: [], mcp: [], bash: false, network: false } });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [BOARD]: 0, [CARDS]: 0, [INBOX]: 0, [PROJECTS]: 0 });

    // 用户发起一个记账本的任务，秘书写好任务书；维护者交计划，用户确认；维护者写周报、宣布完成，评审子 agent 读周报、判通过
    ok(await frontend.startTask("给记账本加周报", "start-周报", ["记账本"]));
    const taskId = (await eventually(() => boardOf(frontend), (e) => e.change === "created", "任务建出来")).task.id;
    td.daemon.tasks.writeBrief(taskId, { goal: "每周出一份周报", acceptanceCriteria: ["有周报文件"], constraints: [], projects: ["记账本"], memoryScope: "" });
    const plan = await eventually(() => cardsOf(frontend), (c) => c.type === "plan", "计划卡");
    ok(await frontend.cardAction({ cardId: plan.id, action: "confirm", expectedVersion: 1, input: {} }));
    await eventually(() => boardOf(frontend), (e) => e.task.id === taskId && e.change === "completed", "任务完成", 90_000);

    // 评审子 agent 读周报的那次调用：不在任何会话里，归属是这个任务、阶段和项目
    const reviewerRead = td.daemon.store
      .read("tool_calls")
      .map((e) => e.payload as ToolCallDetail)
      .find((d) => d.agentId.startsWith("review-") && d.tool === "read")!;
    const reviewed = (await toolCallDetail(td.url, reviewerRead.callId)).body;
    expect(reviewed).toMatchObject({ conversation: null, taskId, stageId: "s1", projectId: "p-1", result: expect.stringContaining("谈妥了续租") });
    // 它的效果记录（56 号票）：摘要里有读到的开头
    expect(reviewed.effects).toEqual([expect.objectContaining({ tool: "read", summary: expect.stringContaining("谈妥了续租") })]);

    // 执行工单写回之后结束；归档、删除（二次确认）
    await eventually(
      () => frontend.events({ channel: PROJECTS, type: EVENT_TYPES.workOrder }).map((f) => f.payload as WorkOrderEventPayload),
      (e) => e.change === "ended" && e.workOrder.kind === "execute",
      "执行工单结束",
    );

    // 加上调用 id 之前的旧效果日志也要找到（没有调用 id，也不在维护者名下）：
    // - 评审子 agent 交评审的那次（53 号票之后、56 号票之前的样子）：紧跟在它的完整内容后面；
    const store = td.daemon.store;
    const submit = store
      .read("tool_calls")
      .map((e) => e.payload as ToolCallDetail)
      .find((d) => d.agentId.startsWith("review-") && d.tool === "submit_review")!;
    asLegacyEffects(store, submit.callId);
    const submitSeq = effectLog(store).find((r) => r.agentId === submit.agentId && r.tool === "submit_review")!.seq;
    expect((await toolCallDetail(td.url, submit.callId)).body.effects?.map((e) => e.seq)).toEqual([submitSeq]);
    // - 维护者会话里子 agent 的一次调用（53 号票之前的样子，没有完整内容）：紧跟在它的工具调用记录后面
    const pmChannel = maintainerChannel("pm-1");
    const writeRecord = store
      .read(pmChannel, 0, EVENT_TYPES.message)
      .map((e) => e.payload as MessageEventPayload)
      .find((p) => p.message.parts.some((part) => part.type === "tool_call" && part.tool === "write"))!;
    const writeEffect = effectLog(store).find((r) => r.agentId === "pm-1" && r.tool === "write")!;
    const subEffect: EffectRecord = { ...writeEffect, seq: Math.max(...effectLog(store).map((r) => r.seq)) + 1, agentId: "pm-1-sub-1", args: { path: "notes.md", content: "子 agent 记下的私事" }, summary: "写文件；改动 notes.md；成功" };
    delete subEffect.callId;
    store.appendBatch([
      {
        channel: pmChannel,
        type: EVENT_TYPES.message,
        payload: { ...writeRecord, agentId: "pm-1-sub-1", message: { ...writeRecord.message, id: "msg-old-sub", parts: writeRecord.message.parts.map((p) => ({ ...p, callId: "old-sub-1" })) } },
      },
      { channel: GUARD_CHANNEL, type: GUARD_EVENTS.effectRecorded, payload: { records: [subEffect] } satisfies EffectRecordedPayload },
    ]);

    ok(await frontend.request(METHODS.projectAction, { projectId: "p-1", action: "archive" }, "k-archive"));
    const asked = ok(await frontend.request(METHODS.projectAction, { projectId: "p-1", action: "delete" }, "k-delete")) as { confirmItemId: string };
    ok(await frontend.inboxAction({ itemIds: [asked.confirmItemId], action: "handle", choice: "确认删除" }));
    await eventually(() => projectEventsOf(frontend), (e) => e.change === "deleted", "项目删掉");

    const after = await toolCallDetail(td.url, reviewerRead.callId);
    expect(after.body).toMatchObject({ purged: true, result: PURGED_TEXT, projectId: "p-1" });
    expect(after.body).not.toHaveProperty("effects");
    // 完整内容里一个字都不剩：评审读的、维护者写的；效果日志里也是（评审子 agent 的按调用 id 找到，调用 id 去掉）
    expect(JSON.stringify(td.daemon.store.read("tool_calls"))).not.toContain("谈妥了续租");
    expect(JSON.stringify(effectLog(td.daemon.store))).not.toContain("谈妥了续租");
    const reviewerEffect = effectLog(td.daemon.store).find((r) => r.seq === reviewed.effects![0]!.seq)!;
    expect(reviewerEffect).toMatchObject({ tool: "read", summary: PURGED_TEXT });
    expect(reviewerEffect).not.toHaveProperty("callId");
    // 旧的效果日志：评审交评审的（评审意见在参数里）、子 agent 的
    expect(effectLog(store).find((r) => r.seq === submitSeq)).toMatchObject({ tool: "submit_review", summary: PURGED_TEXT });
    expect(effectLog(store).find((r) => r.seq === subEffect.seq)).toMatchObject({ agentId: "pm-1-sub-1", summary: PURGED_TEXT, args: { path: PURGED_TEXT, content: PURGED_TEXT } });
    expect(JSON.stringify(effectLog(store))).not.toContain("写了本周的事");
    expect(JSON.stringify(effectLog(store))).not.toContain("子 agent 记下的私事");
  }, 180_000);
});

describe("隐私", () => {
  it("认得出的密钥形态（比如 bash 输出里的 token）不管读没读过都擦：完整的参数和返回、工具调用记录的摘要用同一套", async () => {
    const token = "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
    const { url, daemon } = await startTestDaemon({ secretary: [call("bash", { command: `echo "token: ${token}"` }), reply("打出来了")] });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await tell(frontend, "打一下");

    const [echo] = toolPartsOf(frontend);
    expect(echo).toMatchObject({ outcome: "done", argsSummary: 'echo "token: （密钥）"', resultSummary: "token: （密钥）" });
    expect((await toolCallDetail(url, echo!.callId)).body).toMatchObject({ args: { command: 'echo "token: （密钥）"' }, result: "token: （密钥）\n" });
    expect(JSON.stringify(daemon.store.readGlobal(0, 100_000))).not.toContain(token);
  });

  it("维护者读过 .env 之后：读密钥文件的调用不记返回；别的调用的参数、返回里读过的值换成（密钥）；数据库区的文件里找不到这个值", async () => {
    const dataDir = makeTempDir("ergou-data-");
    const homeDir = makeTempDir("ergou-home-");
    const work = path.join(dataDirLayout(dataDir).outputs, "t-1");
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, ".env"), `API_KEY=${ENV_VALUE}\n`);
    const { daemon, url } = await startTestDaemon({
      secretary: [reply("好的")],
      maintainer: [
        call("read", { path: ".env" }),
        call("bash", { command: `printf '%s\\n' ${ENV_VALUE} > notes.txt` }),
        call("bash", { command: "cat notes.txt" }),
        reply("好了"),
      ],
      maintainerToolkit: () => ({ bash: true, network: false }),
      reuse: { dataDir, homeDir },
    });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [MAINTAINER]: 0 });
    daemon.tasks.startFromButton({ request: "看看配置" }, "k-start");
    daemon.store.append(buildAgentNotice(MAINTAINER, "开始干活：看看 .env 里的配置", "k-go", { taskId: "t-1" }).event);
    await waitUntil(() => frontend.events({ channel: MAINTAINER, type: EVENT_TYPES.turnEnd }).length > 0, { timeoutMs: 90_000, describe: () => "等维护者这一轮结束" });

    const [read, printf, cat] = toolPartsOf(frontend, MAINTAINER);
    expect([read, printf, cat].map((p) => p?.outcome)).toEqual(["done", "done", "done"]);
    expect((await toolCallDetail(url, read!.callId)).body).toMatchObject({
      tool: "read",
      agentId: "tm-1",
      conversation: MAINTAINER,
      taskId: "t-1",
      args: { path: ".env" },
      result: "（密钥文件的内容不记录）",
      resultWithheld: "secret_file",
    });
    expect((await toolCallDetail(url, printf!.callId)).body.args).toEqual({ command: "printf '%s\\n' （密钥） > notes.txt" });
    expect((await toolCallDetail(url, cat!.callId)).body.result.trim()).toBe("（密钥）");
    // 效果记录（56 号票）和效果日志里的一样脱敏：读密钥文件的摘要里不记结果，读过的值换成"（密钥）"
    const readEffects = (await toolCallDetail(url, read!.callId)).body.effects;
    expect(readEffects).toEqual([
      { seq: expect.any(Number), tool: "read", toolTitle: "读文件", summary: expect.stringContaining("结果：（密钥文件的内容不记录）"), objects: [{ kind: "path", access: "read", value: expect.stringMatching(/[\\/]t-1[\\/]\.env$/) }] },
    ]);
    const later = await Promise.all([printf!, cat!].map(async (p) => (await toolCallDetail(url, p.callId)).body.effects));
    expect(later.map((effects) => effects?.map((e) => e.tool))).toEqual([["shell_command", "write"], ["read"]]);
    for (const effect of later[0]!) expect(effect.summary).toContain("bash「printf '%s\\n' （密钥） > notes.txt」");
    expect(later[1]![0]!.summary).toContain("结果：（密钥）");
    expect(JSON.stringify([readEffects, later])).not.toContain(ENV_VALUE);

    const leaked = (text: string) => text.includes(ENV_VALUE);
    const dbFiles = filesUnder(dataDirLayout(dataDir).db);
    expect(dbFiles.filter((f) => leaked(fs.readFileSync(f, "latin1")))).toEqual([]);
  }, 120_000);
});

describe("鉴权", () => {
  it("和别的接口一样：外网端口上没配对的设备拿不到（401），配对过的设备取得到", async () => {
    const { url, externalUrl } = await startTestDaemon({ secretary: [call("write", { path: "notes.md", content: NOTES }), reply("记好了")] });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0, [CARDS]: 0 });
    await tell(frontend, "把装修的事记下来");
    const [write] = toolPartsOf(frontend);

    const stranger = await new TestDevice(externalUrl).request(HTTP_PATHS.toolCall(write!.callId));
    expect(stranger.status).toBe(401);
    expect(stranger.json<HttpErrorBody>().code).toBe("unauthorized");
    expect(stranger.body).not.toContain("装修师傅");

    const device = await pairDevice(externalUrl, frontend);
    const paired = await device.request(HTTP_PATHS.toolCall(write!.callId));
    expect(paired.status).toBe(200);
    expect(paired.json<ToolCallDetail>()).toMatchObject({ tool: "write", args: { path: "notes.md", content: NOTES } });
  });
});
