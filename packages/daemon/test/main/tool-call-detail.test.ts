// 主切面：工具调用的完整参数和返回（53 号票，详情页用）。真的守护进程，agent 接 faux 剧本，测试扮演前端：
// 聊天里的工具调用 part 照旧只带摘要；按调用 id 经 HTTP 取完整参数和完整返回（GET /api/tool-calls/<调用 id>）——
// 普通的、被拦下的、出错的都有；和摘要一样擦掉读过的密钥值、读了密钥文件的不记返回；单个值超过 200KB 截断并注明；
// 守护进程被杀后重启照样取得到；彻底删除后只剩删除标记；外网端口和别的接口一样要设备凭证。
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

    const card = cardsOf(frontend).find((c) => c.type === "memory_delete")!;
    await frontend.cardAction({ cardId: card.id, action: "delete", expectedVersion: 1, input: { mode: "purge", materialIds: [last] } });
    await frontend.next(SECRETARY, EVENT_TYPES.messagesPurged);
    const after = (await toolCallDetail(url, search.callId)).body;
    expect(after).toMatchObject({ tool: "search_materials", outcome: "done", purged: true, result: PURGED_TEXT });
    expect(JSON.stringify(after)).not.toContain(excerpt);
    expect(JSON.stringify(daemon.store.readGlobal(0, 100_000))).not.toContain(excerpt);
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
    expect((await toolCallDetail(td.url, reviewerRead.callId)).body).toMatchObject({ conversation: null, taskId, stageId: "s1", projectId: "p-1", result: expect.stringContaining("谈妥了续租") });

    // 执行工单写回之后结束；归档、删除（二次确认）
    await eventually(
      () => frontend.events({ channel: PROJECTS, type: EVENT_TYPES.workOrder }).map((f) => f.payload as WorkOrderEventPayload),
      (e) => e.change === "ended" && e.workOrder.kind === "execute",
      "执行工单结束",
    );
    ok(await frontend.request(METHODS.projectAction, { projectId: "p-1", action: "archive" }, "k-archive"));
    const asked = ok(await frontend.request(METHODS.projectAction, { projectId: "p-1", action: "delete" }, "k-delete")) as { confirmItemId: string };
    ok(await frontend.inboxAction({ itemIds: [asked.confirmItemId], action: "handle", choice: "确认删除" }));
    await eventually(() => projectEventsOf(frontend), (e) => e.change === "deleted", "项目删掉");

    const after = await toolCallDetail(td.url, reviewerRead.callId);
    expect(after.body).toMatchObject({ purged: true, result: PURGED_TEXT, projectId: "p-1" });
    // 完整内容里一个字都不剩：评审读的、维护者写的
    expect(JSON.stringify(td.daemon.store.read("tool_calls"))).not.toContain("谈妥了续租");
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
