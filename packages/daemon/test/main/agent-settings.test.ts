// 主切面：每个 agent 的会话里一个 ⚙（114 号票，规格第 19 节"Web UI"、系统提示一节）。
// - 单独的提示词：存在数据目录配置区（agent-prompts/，按 agent 分）、读回、面板上拼出实际用的系统提示，从这个 agent 的下一轮起按新的；
//   占位符照它的通用模板查，写错的存不进去；整份自己写的替换通用模板，能恢复用通用模板；
// - 清空当前对话：新开一段会话，模型看到的上下文里没有之前的聊天（旧消息还在事件日志里，会话里一条分隔线）；任务的计划、阶段
//   照常作为上下文给到新的一段；在处理一条时等它说完再清；项目维护者的清空就是重置维护者（新的一段只凭项目档案，设置跟着项目走）；
// - 上下文用量和"现在压缩"：用量和 token 账本里最近一次调用的对得上，窗口是子进程报的；"现在压缩"经宿主协议的 compact 真的压缩，
//   压缩那次照常记账（用途"压缩"），时间线上记一笔"这里压缩过一次"。
import fs from "node:fs";
import path from "node:path";
import {
  type AgentSettingsView,
  type ConversationId,
  CHANNELS,
  EVENT_TYPES,
  maintainerChannel,
  type MessageEventPayload,
  type SegmentEventPayload,
  type TimelineRecordEventPayload,
  tokenTotal,
} from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { stripTimeMarkers } from "../helpers/echo.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { agentSettingsApi } from "../helpers/http.ts";
import { submitPlanStep } from "../helpers/plans.ts";
import { waitUntil } from "../helpers/process.ts";
import { seedProject } from "../helpers/projects.ts";
import { onePlan, runningTask } from "../helpers/running-task.ts";
import { say } from "../helpers/task-flow.ts";

const { secretary: SECRETARY, board: BOARD, cards: CARDS } = CHANNELS;
const ECHO: FauxStep = { kind: "echo_context" };
const echoes = (n: number): FauxStep[] => Array.from({ length: n }, () => ECHO);

/** 一段约 2.5 万 token 的材料 */
const long = (n: number) => `材料${n}：${"一段很长的材料。".repeat(12_500)}`;

const textOf = (payload: MessageEventPayload) => payload.message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
const messagesOf = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.message }).map((f) => f.payload as MessageEventPayload);
const turnEnds = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.turnEnd }).length;

/** 说一句，等这个会话又处理完一条，返回 agent 最后说的（回显的上下文去掉时间标记） */
async function say1(frontend: TestFrontend, text: string, conversation: ConversationId = SECRETARY): Promise<string> {
  const before = turnEnds(frontend, conversation);
  await frontend.sendText(text, { conversation });
  await waitUntil(() => turnEnds(frontend, conversation) > before, { timeoutMs: 30_000, describe: () => `等 ${conversation} 处理完「${text.slice(0, 10)}」` });
  const reply = messagesOf(frontend, conversation).findLast((m) => m.message.speaker === "agent");
  return stripTimeMarkers(reply ? textOf(reply) : "");
}

/**
 * 回显里这一轮的系统提示（pi 在后面另接的工作目录、工具清单不算）：换了提示接着原会话时，pi 在会话中途记一条新的系统消息，
 * 后面的轮次按新的——取最后一条
 */
const systemOf = (echo: string) => {
  const rest = echo.slice(echo.lastIndexOf("[system] "));
  const end = rest.search(/\n\n<cwd>|\n\[(user|assistant|tool|system)\] /);
  return end < 0 ? rest : rest.slice(0, end);
};

describe("单独的提示词：存、读回、拼出实际的提示，下一轮按新的", () => {
  it("秘书：追加一段存进配置区、面板上读回和实际用的全文，下一轮的系统提示照它；写错的存不进去；整份自己写、恢复用通用模板", async () => {
    const { url, dataDir } = await startTestDaemon({ secretary: echoes(6) });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });

    const before = await agentSettingsApi.view(url, "secretary");
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ agentId: "secretary", kind: "secretary", prompt: { state: "template", content: "", template: { id: "secretary" } }, clear: { how: "new_session", pending: false } });
    const template = before.body.prompt.effective;
    expect(template).toContain("用户叫你「二狗」");
    expect(systemOf(await say1(frontend, "你好"))).toBe(`[system] ${template}`);

    // 追加：存在数据目录配置区，面板读回；占位符和通用模板一样能用
    const saved = await agentSettingsApi.savePrompt(url, "secretary", { mode: "append", content: "回答尽量短，{{名字}}只说要点。" });
    expect(saved.status).toBe(200);
    expect(saved.body.prompt).toMatchObject({ state: "append", content: "回答尽量短，{{名字}}只说要点。", effective: `${template}\n\n回答尽量短，二狗只说要点。` });
    expect(fs.readFileSync(path.join(dataDirLayout(dataDir).agentPrompts, "secretary.append.md"), "utf8")).toBe("回答尽量短，{{名字}}只说要点。\n");
    expect((await agentSettingsApi.view(url, "secretary")).body.prompt.state).toBe("append");
    // 下一轮起按新的（接着同一条主线会话：前面那一轮还在）
    const next = await say1(frontend, "第二句");
    expect(systemOf(next)).toContain("回答尽量短，二狗只说要点。");
    expect(next).toContain("[user] 你好");

    // 占位符写错的存不进去（和设置 · 系统提示同一套检查，说清第几行），整份的不能是空的
    const bad = await agentSettingsApi.savePrompt(url, "secretary", { mode: "replace", content: "你是{{名字}}\n叫我{{老板}}" });
    expect(bad).toMatchObject({ status: 400, body: { code: "bad_request", message: expect.stringContaining("第 2 行：不认得的占位符 {{老板}}") } });
    expect((await agentSettingsApi.savePrompt(url, "secretary", { mode: "replace", content: " " })).status).toBe(400);
    expect((await agentSettingsApi.view(url, "secretary")).body.prompt.state).toBe("append");

    // 整份自己写：替换通用模板
    const replaced = await agentSettingsApi.savePrompt(url, "secretary", { mode: "replace", content: "你是{{名字}}，一个只会说短句的秘书。" });
    expect(replaced.body.prompt).toMatchObject({ state: "replace", effective: "你是二狗，一个只会说短句的秘书。" });
    expect(systemOf(await say1(frontend, "第三句"))).toBe("[system] 你是二狗，一个只会说短句的秘书。");

    // 恢复用通用模板
    const reset = await agentSettingsApi.resetPrompt(url, "secretary");
    expect(reset.body.prompt).toMatchObject({ state: "template", content: "", effective: template });
    expect(systemOf(await say1(frontend, "第四句"))).toBe(`[system] ${template}`);
    expect(fs.readdirSync(dataDirLayout(dataDir).agentPrompts)).toEqual([]);

    // 不认得的 agent
    expect((await agentSettingsApi.view(url, "nobody")).status).toBe(404);
  });
});

describe("清空当前对话：新开一段会话，旧的不删", () => {
  it("秘书：清空后模型看到的上下文里没有之前的聊天，旧消息还在事件日志里，会话里一条分隔线；同一个幂等键只清一次", async () => {
    const { url, daemon } = await startTestDaemon({ secretary: echoes(3) });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    expect(await say1(frontend, "暗号是蓝鲸")).toContain("[user] 暗号是蓝鲸");

    const cleared = await agentSettingsApi.clear(url, "secretary", "k-1");
    expect(cleared.status).toBe(200);
    expect(cleared.body.clear).toMatchObject({ how: "new_session", pending: false, lastAt: expect.any(String) });
    // 重发同一个幂等键：不再清一次
    await agentSettingsApi.clear(url, "secretary", "k-1");
    const after = await say1(frontend, "暗号是什么");
    expect(after).toContain("[user] 暗号是什么");
    expect(after).not.toContain("蓝鲸");

    const all = daemon.store.read(SECRETARY, 0, EVENT_TYPES.message).map((e) => e.payload as MessageEventPayload);
    const dividers = all.filter((m) => m.message.parts.some((p) => p.type === "conversation_cleared"));
    expect(dividers).toHaveLength(1);
    expect(dividers[0]!.message.speaker).toBe("system");
    const order = all.map((m) => (m.message.parts.some((p) => p.type === "conversation_cleared") ? "<清空>" : textOf(m).slice(0, 5)));
    expect(order.indexOf("<清空>")).toBeGreaterThan(order.indexOf("暗号是蓝鲸"));
    expect(order.indexOf("暗号是什么")).toBeGreaterThan(order.indexOf("<清空>"));
  });

  it("秘书正在处理一条：等这一条说完再清（面板上写着在等），分隔线在它的回复之后", async () => {
    const slow = "好的，我慢慢说。".repeat(20);
    const { url } = await startTestDaemon({ secretary: [say(slow)], secretaryTokensPerSecond: 30 });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await frontend.sendText("说点什么");
    await frontend.next(SECRETARY, EVENT_TYPES.turnStart);
    const waiting = await agentSettingsApi.clear(url, "secretary", "k-busy");
    expect(waiting.body.clear.pending).toBe(true);
    expect(waiting.body.context.busy).toBe(true);
    await waitUntil(() => messagesOf(frontend, SECRETARY).some((m) => m.message.parts.some((p) => p.type === "conversation_cleared")), { timeoutMs: 30_000, describe: () => "等分隔线" });
    const order = messagesOf(frontend, SECRETARY).map((m) => (m.message.parts.some((p) => p.type === "conversation_cleared") ? "<清空>" : m.message.speaker));
    expect(order).toEqual(["user", "agent", "<清空>"]);
    expect((await agentSettingsApi.view(url, "secretary")).body.clear.pending).toBe(false);
  });

  it("秘书在说话时点了清空、用户接着又说一句（秘书不收插话，排着）：这一句交给新开的那一段，不交给旧的子进程", async () => {
    // 每次拉起剧本从头来：旧的子进程接着往下是第二步，新拉起的又是第一步
    const slow = "好的，我慢慢说。".repeat(20);
    const { url, dataDir } = await startTestDaemon({ secretary: [say(slow), say("这是旧的子进程接着回的")], secretaryTokensPerSecond: 30 });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await frontend.sendText("暗号是蓝鲸");
    await frontend.next(SECRETARY, EVENT_TYPES.turnStart);
    expect((await agentSettingsApi.clear(url, "secretary", "k-queued")).body.clear.pending).toBe(true);
    await frontend.sendText("暗号是什么");
    await waitUntil(() => turnEnds(frontend, SECRETARY) >= 2, { timeoutMs: 60_000, describe: () => "等第二句处理完" });

    const order = messagesOf(frontend, SECRETARY).map((m) => (m.message.parts.some((p) => p.type === "conversation_cleared") ? "<清空>" : `${m.message.speaker}:${textOf(m).slice(0, 6)}`));
    expect(order.indexOf("<清空>")).toBeGreaterThan(order.indexOf("agent:好的，我慢慢"));
    // 第二句的回复在分隔线之后，是新拉起的子进程回的
    expect(order.at(-1)).toBe("agent:好的，我慢慢");
    expect(order).not.toContain("agent:这是旧的子进");
    // 新开的那一段会话里有第二句，没有清空之前的
    const marker = messagesOf(frontend, SECRETARY).find((m) => m.message.parts.some((p) => p.type === "conversation_cleared"))!;
    const fresh = fs.readFileSync(path.join(dataDirLayout(dataDir).sessions, "secretary", `cleared-${marker.message.id}.jsonl`), "utf8");
    expect(fresh).toContain("暗号是什么");
    expect(fresh).not.toContain("蓝鲸");
  }, 90_000);

  it("执行中的任务：清空后新的一段没有之前的聊天，计划和当前阶段照常作为上下文给到；任务结束后面板只读", async () => {
    const td = await startTestDaemon({ maintainer: (_id, n) => (n === 1 ? [submitPlanStep(onePlan()), say("计划交上去了")] : echoes(4)) });
    const TM1 = maintainerChannel("tm-1");
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [BOARD]: 0, [CARDS]: 0, [TM1]: 0 });
    const taskId = await runningTask(td, frontend, "整理相册");
    await waitUntil(() => turnEnds(frontend, TM1) >= 2, { timeoutMs: 30_000, describe: () => "等维护者处理完开始执行的通知" });

    const view = await agentSettingsApi.view(td.url, "tm-1");
    expect(view.body).toMatchObject({ kind: "task", label: `长程任务 ${taskId}「整理相册」的维护者`, prompt: { template: { id: "task-maintainer" } }, clear: { how: "new_session" } });
    expect(await say1(frontend, "暗号是蓝鲸", TM1)).toContain("暗号是蓝鲸");

    expect((await agentSettingsApi.clear(td.url, "tm-1", "k-task")).status).toBe(200);
    const after = await say1(frontend, "现在做到哪了", TM1);
    expect(after).not.toContain("蓝鲸");
    expect(after).toContain("[user] 现在做到哪了");
    // 重注入块：计划、当前阶段照常给到新的一段
    expect(after).toMatch(/\[user\] 【运行时注入】[\s\S]*动手做/);

    // 任务结束（取消）了：面板只读，存、清、压都被拒
    await frontend.taskAction({ taskId, action: "cancel" });
    await expect.poll(async () => (await agentSettingsApi.view(td.url, "tm-1")).body.readOnly, { timeout: 10_000 }).toEqual(expect.any(String));
    const refused = await agentSettingsApi.savePrompt(td.url, "tm-1", { mode: "append", content: "多写注释" });
    expect(refused).toMatchObject({ status: 400, body: { message: expect.stringContaining("只能看") } });
    expect((await agentSettingsApi.compact(td.url, "tm-1")).status).toBe(400);
  });

  it("项目维护者：清空就是重置维护者，新的一段只凭项目档案重建理解，单独的提示词跟着项目走（重置之后照旧用）", async () => {
    const td = await startTestDaemon({ maintainer: (id) => (id === "pm-1" ? echoes(3) : []) });
    const project = seedProject(td.daemon, "记账本");
    const records = td.daemon.projects.records(project.id);
    fs.mkdirSync(path.dirname(records.spec), { recursive: true });
    fs.writeFileSync(records.spec, "规格：记账本只记家里的开销");
    const PM1 = maintainerChannel("pm-1");
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [PM1]: 0 });

    expect((await agentSettingsApi.view(td.url, "pm-1")).body).toMatchObject({ kind: "project", label: "项目「记账本」的维护者", prompt: { template: { id: "project-maintainer" } }, clear: { how: "reset_maintainer" } });
    expect(await say1(frontend, "暗号是蓝鲸", PM1)).toContain("暗号是蓝鲸");
    // 单独的提示词：面板上实际用的全文里有项目维护者的模板、追加的一段和这一段的固定上下文
    const saved = await agentSettingsApi.savePrompt(td.url, "pm-1", { mode: "append", content: "项目「{{项目名}}」的事都先查项目档案。" });
    expect(saved.body.prompt.effective).toContain("项目「记账本」的事都先查项目档案。");
    expect(saved.body.prompt.effective).toContain("规格：记账本只记家里的开销");

    const cleared = await agentSettingsApi.clear(td.url, "pm-1", "k-project");
    expect(cleared.status).toBe(200);
    const segments = frontend.events({ channel: PM1, type: EVENT_TYPES.segment }).map((f) => f.payload as SegmentEventPayload);
    expect(segments.filter((s) => s.change === "opened").at(-1)?.segment.reset).toBe(true);
    const after = await say1(frontend, "现在呢", PM1);
    expect(after).not.toContain("蓝鲸");
    expect(after).toContain("规格：记账本只记家里的开销");
    expect(systemOf(after)).toContain("项目「记账本」的事都先查项目档案。");
    expect((await agentSettingsApi.view(td.url, "pm-1")).body.clear.lastAt).toEqual(expect.any(String));
  });
});

describe("上下文用量和现在压缩", () => {
  it("秘书：用量和账本里最近一次调用对得上，窗口是子进程报的；现在压缩真的压了，压缩那次记账、时间线上记一笔，之后的用量从下一次调用起算", async () => {
    const td = await startTestDaemon({ secretary: [say("好"), say("收到了一大段"), say("好"), say("摘要：用户发过一大段材料"), ECHO] });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    // 开头一句（压缩时写进摘要），然后一大段（约 2.5 万 token，和后面的一句话作为最近的原样留着）
    await say1(frontend, "开头一句");
    await say1(frontend, long(1));
    await say1(frontend, "第二句");

    const lastWork = () => td.daemon.ledger.entries(null).filter((e) => e.agentId === "secretary" && e.purpose === "work").at(-1)!;
    const view = (await agentSettingsApi.view(td.url, "secretary")).body;
    expect(view.context).toMatchObject({ running: true, busy: false, compaction: "idle", usedTokens: tokenTotal(lastWork().tokens), measuredAt: lastWork().time });
    expect(view.context.usedTokens).toBeGreaterThan(20_000);
    expect(view.context.window).toBeGreaterThan(0);
    expect(view.context.autoCompactAt).toBe(view.context.window! - 16_384);
    expect(view.context.keepRecentTokens).toBe(20_000);
    expect(view.context.lastCompactedAt).toBeUndefined();

    const started = await agentSettingsApi.compact(td.url, "secretary");
    expect(started.status).toBe(200);
    expect(["waiting", "running"]).toContain(started.body.context.compaction);
    const done = await settled(td.url, "secretary");
    expect(done.context.lastCompact).toMatchObject({ outcome: "done" });
    expect(done.context.lastCompactedAt).toEqual(expect.any(String));
    // 压缩之后还没调用过模型：用量等下一次调用
    expect(done.context.usedTokens).toBeUndefined();
    // 压缩那次的用量照常记账（用途"压缩"）
    expect(td.daemon.ledger.entries(null).filter((e) => e.agentId === "secretary" && e.purpose === "compaction")).toHaveLength(1);
    // 时间线上一笔"这里压缩过一次"
    await waitUntil(() => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.timelineRecord }).length > 0, { timeoutMs: 10_000 });
    const records = frontend.events({ channel: SECRETARY, type: EVENT_TYPES.timelineRecord }).map((f) => (f.payload as TimelineRecordEventPayload).record);
    expect(records).toEqual([expect.objectContaining({ kind: "compaction", summary: "这里压缩过一次", detail: expect.stringContaining("你点了“现在压缩”") })]);

    const after = await say1(frontend, "压缩之后");
    expect(after).toContain("摘要：用户发过一大段材料");
    const again = (await agentSettingsApi.view(td.url, "secretary")).body.context;
    expect(again.usedTokens).toBe(tokenTotal(lastWork().tokens));
  });

  it("压缩那次模型调用卡住：按单次模型调用的超时停掉子进程，面板写没压成，会话不再一直忙着、排着的照常处理", async () => {
    // 单次模型调用 0.6 秒；平常的回话很短（来得及），写摘要那次很长、按每秒 5 个 token 吐，压缩超时
    const td = await startTestDaemon({
      config: { agents: { modelCallMinutes: 0.01 } },
      secretary: [say("好"), say("好"), say("好"), say("摘要写得非常非常慢。".repeat(60)), say("不该到这里")],
      secretaryTokensPerSecond: 5,
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await say1(frontend, "开头一句");
    await say1(frontend, long(1));
    await say1(frontend, "第二句");

    expect((await agentSettingsApi.compact(td.url, "secretary")).status).toBe(200);
    const done = await settled(td.url, "secretary");
    expect(done.context.lastCompact).toMatchObject({ outcome: "failed", message: expect.stringContaining("超时") });
    expect(done.context.lastCompactedAt).toBeUndefined();
    expect(td.daemon.ledger.entries(null).filter((e) => e.agentId === "secretary" && e.purpose === "compaction")).toEqual([]);
    // 重新拉起（接着原来的会话，剧本从头来），照常回话
    expect(await say1(frontend, "还在吗")).toBe("好");
    expect(frontend.events({ channel: SECRETARY, type: EVENT_TYPES.timelineRecord })).toEqual([]);
  }, 90_000);

  it("没在跑的维护者先拉起再压（会话还短的回\"没什么可压的\"，不在时间线上记）；项目维护者没有在进行的一段时压不了", async () => {
    const td = await startTestDaemon({
      config: { agents: { idleMinutes: 0.01 } },
      maintainer: (id, n) => (id === "tm-1" && n === 1 ? [submitPlanStep(onePlan()), say("计划交上去了")] : [say("好"), say("好")]),
    });
    const TM1 = maintainerChannel("tm-1");
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [BOARD]: 0, [CARDS]: 0, [TM1]: 0 });
    await runningTask(td, frontend, "整理相册");
    // 闲置退出了
    await expect.poll(async () => (await agentSettingsApi.view(td.url, "tm-1")).body.context.running, { timeout: 20_000 }).toBe(false);
    const started = await agentSettingsApi.compact(td.url, "tm-1");
    expect(started.status).toBe(200);
    const done = await settled(td.url, "tm-1");
    expect(done.context.lastCompact).toMatchObject({ outcome: "nothing" });
    expect(frontend.events({ channel: TM1, type: EVENT_TYPES.timelineRecord }).filter((f) => (f.payload as TimelineRecordEventPayload).record.kind === "compaction")).toEqual([]);

    // 项目维护者还没说过话：没有在进行的一段，压不了
    seedProject(td.daemon, "记账本");
    expect((await agentSettingsApi.view(td.url, "pm-1")).body.context.cannotCompact).toContain("没有在进行的一段会话");
    expect((await agentSettingsApi.compact(td.url, "pm-1"))).toMatchObject({ status: 400, body: { message: expect.stringContaining("没有在进行的一段会话") } });
  });
});

/** 等"现在压缩"压完（面板上不在等、不在压），返回那时的面板 */
async function settled(url: string, agentId: string): Promise<AgentSettingsView> {
  let last: AgentSettingsView | undefined;
  await expect
    .poll(
      async () => {
        last = (await agentSettingsApi.view(url, agentId)).body;
        return last.context.compaction;
      },
      { timeout: 30_000 },
    )
    .toBe("idle");
  return last!;
}
