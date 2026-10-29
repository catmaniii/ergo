// 主切面：Claude Code 会话交给官方 App（Remote Control）和二狗接管互转（292 号票，Claude Code 接入一期之七；issue 24 用户答复第 4、6 条，调研 35）。
// 真的守护进程走组合根和插件清单；清单里的 Claude Code 插件换成同名的：子进程接假 SDK、会话来源是假本机的（helpers/fake-claude-sessions.ts：编的会话、
// 编的会话记录，只读跟随的翻法是真的）、命令行是扮演本机 claude 的假的（helpers/fake-claude-cli.ts：照调研 35 实测的样子开后台会话、唤醒、停掉、
// 开出副本）——不起真的 claude、不花额度、不碰用户真实的 ~/.claude。
// - 交出（接管来的会话）：状态变成在官方 App 里、二狗的子进程退了，命令按顺序（先确认二狗的进程退干净、看有没有停着的后台会话，第一次带名字开，
//   再确认后台会话在跑、拿链接）；会话里写明、给链接；在官方 App 里时会话里说话被拒、列会话时写明交给了官方 App；
// - 只读跟随：那边新增的用户说的、它回的、调用的工具补记进维护者的会话（标 remote，不交给 agent），跟几遍不重复记，还没说完的那条回复先不记；
// - 收回：停掉那边的后台会话、最后补记一遍（没说完的那条也记上），恢复同一个会话；再交出去是唤醒原来的后台会话（不带参数，带了会开出副本），同一个链接；
// - 二狗自己开的会话（新建的 Claude Code 任务）也能交：在做一轮的先打断，执行中的任务转等我（写明在官方 App 里），第一次交时记下（own）；
//   终端里又开着的不交（回到二狗接管）；开出副本的停掉副本、不算交出去；收回后接着同一个会话；pi 的不能交。
import fs from "node:fs";
import path from "node:path";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { EVENT_TYPES, maintainerChannel, type MessageEventPayload, type MessagePart, type Task } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { CLAUDE_CODE_RUNTIME_ID } from "../../src/claude-code/api.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { FakeClaudeCli } from "../helpers/fake-claude-cli.ts";
import type { FakeClaudeEcho } from "../helpers/fake-claude-sdk.ts";
import { FakeClaudeSessions, fakeTakeoverClaudeCodePlugin } from "../helpers/fake-claude-sessions.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { agentSettingsApi, takeoverApi } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const CC = CLAUDE_CODE_RUNTIME_ID;
const echo: FauxStep = { kind: "echo_context" };
const say = (text: string): FauxStep => ({ kind: "reply", text });

// —— 编的会话记录（SDK 读出的 SessionMessage 样子）——
const base = { session_id: "s-idle", parent_tool_use_id: null, parent_agent_id: null };
const userSays = (uuid: string, text: string, at?: string): SessionMessage => ({ ...base, type: "user", uuid, message: { role: "user", content: text }, ...(at ? { timestamp: at } : {}) }) as SessionMessage;
const replies = (uuid: string, id: string, content: unknown[], stop: string): SessionMessage => ({ ...base, type: "assistant", uuid, message: { id, role: "assistant", content, stop_reason: stop } }) as SessionMessage;
const result = (uuid: string, toolUseId: string, text: string): SessionMessage => ({ ...base, type: "user", uuid, message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: text }] } }) as SessionMessage;
const textBlock = (text: string) => ({ type: "text", text });
const bash = (id: string, command: string) => ({ type: "tool_use", id, name: "Bash", input: { command } });

interface Setup {
  td: TestDaemon;
  sessions: FakeClaudeSessions;
  cli: FakeClaudeCli;
  frontend: TestFrontend;
  dir: string;
}

async function setup(maintainer: FauxStep[] | ((id: string, spawn: number) => FauxStep[]) = [echo]): Promise<Setup> {
  const root = makeTempDir("ergo-remote-");
  const dir = path.join(root, "flaky-ci");
  fs.mkdirSync(dir, { recursive: true });
  const real = fs.realpathSync.native(dir);
  const sessions = new FakeClaudeSessions();
  sessions.sessions = [{ sessionId: "s-idle", title: "修 CI 的 flaky 测试", cwd: real, branch: "fix/flaky", lastModified: Date.parse("2026-10-25T10:00:00+08:00"), bytes: 2_400_000 }];
  const cli = new FakeClaudeCli(sessions);
  const td = await startTestDaemon({ extraPlugins: [fakeTakeoverClaudeCodePlugin(sessions, cli)], maintainer, remoteFollowMs: 150 });
  const frontend = await TestFrontend.connect(td.url);
  return { td, sessions, cli, frontend, dir: real };
}

const taskNow = (td: TestDaemon, id: string): Task => td.daemon.tasks.get(id)!;
const payloadsOf = (td: TestDaemon, channel: string) =>
  td.daemon.store
    .read(channel, 0, EVENT_TYPES.message)
    .map((e) => e.payload as MessageEventPayload);
const textOf = (p: MessageEventPayload) => p.message.parts.map((part) => ("text" in part ? part.text : `<${part.type}>`)).join("");
const remoteOf = (td: TestDaemon, channel: string) => payloadsOf(td, channel).filter((p) => p.message.remote === true);
const agentReplies = (td: TestDaemon, channel: string) =>
  payloadsOf(td, channel)
    .filter((p) => p.message.speaker === "agent" && p.message.prelude !== true && p.message.remote !== true)
    .map(textOf);
/** 假 SDK 照着剧本回的 echo（交给 Claude 的输入和 query 的选项） */
const echoes = (td: TestDaemon, channel: string) => agentReplies(td, channel).filter((text) => text.startsWith('{"input"'));
async function nthReply(td: TestDaemon, channel: string, n: number): Promise<FakeClaudeEcho> {
  await waitUntil(() => echoes(td, channel).length >= n, { timeoutMs: 30_000, describe: () => `等 ${channel} 的第 ${n} 条回复：${JSON.stringify(payloadsOf(td, channel).map(textOf))}` });
  return JSON.parse(echoes(td, channel)[n - 1]!) as FakeClaudeEcho;
}
const live = (td: TestDaemon, agentId: string) => td.daemon.agents.live().some((a) => a.agentId === agentId);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;

describe("Claude Code 会话交给官方 App、收回到二狗（292 号票）", () => {
  it("接管来的会话：交出去命令按顺序、子进程退了；只读跟随补记不重复；收回停掉那边、补记最后一轮、恢复同一会话；再交出去是唤醒（不带参数）", async () => {
    const { td, sessions, cli, frontend, dir } = await setup();
    const taken = await takeoverApi.takeOver(td.url, CC, { sessionId: "s-idle", as: "task", request: "把剩下两个测试修好", idempotencyKey: "k-1" });
    const task = taskNow(td, taken.body.taskId!);
    const channel = maintainerChannel(task.maintainerId);
    await nthReply(td, channel, 1);
    await waitUntil(() => taskNow(td, task.id).state === "done", { timeoutMs: 30_000, describe: () => JSON.stringify(taskNow(td, task.id)) });
    expect(live(td, task.maintainerId)).toBe(true);
    // 二狗自己的进程在 agents 里也显示成开着（interactive），退了才不显示
    cli.ergoOpen = () => (live(td, task.maintainerId) ? [{ sessionId: "s-idle", pid: 999 }] : []);
    sessions.transcripts.set("s-idle", [userSays("u1", "CI 上 test/flaky.test.ts 老是挂"), replies("a1", "m1", [textBlock("有两个用例在时区上不稳。")], "end_turn"), userSays("u2", "把剩下两个测试修好"), replies("a2", "m2", [textBlock("改好了")], "end_turn")]);

    // ⚙ 里：二狗接管着，能交给官方 App
    const before = await agentSettingsApi.view(td.url, task.maintainerId);
    expect(before.body.runtime).toMatchObject({ remoteControl: true, takeover: { place: "ergo", returned: false } });

    const handed = await agentSettingsApi.takeover(td.url, task.maintainerId, "remote");
    expect(handed.status).toBe(200);
    const url = "https://claude.ai/code/session_01Rcs-idle";
    expect(handed.body.runtime?.takeover).toMatchObject({ sessionId: "s-idle", place: "remote", returned: true, url });
    // 二狗的子进程退干净了才开后台会话
    expect(live(td, task.maintainerId)).toBe(false);
    expect(cli.calls.map((c) => c.args.join(" "))).toEqual(["agents --json", "agents --json --all", "--bg --resume s-idle --remote-control 修 CI 的 flaky 测试", "agents --json", "logs s-idle"]);
    expect(cli.calls[2]!.cwd).toBe(dir);
    expect(taskNow(td, task.id).takeover).toMatchObject({ runtime: CC, sessionId: "s-idle", returnedAt: expect.any(String), remote: { job: "s-idle", sessionId: "s-idle", url, since: expect.any(String), from: "a2" } });
    expect(payloadsOf(td, channel).map(textOf).at(-1)).toBe(
      `交给官方 App 了：在 Claude Code 的官方 App 里接着（${url}）。这里不再写这个会话，那边的进度会补记到这里；这里接管期间说的几轮，官方 App 里可能看不到。要接回来，在 ⚙ 里收回`,
    );
    // 在官方 App 里时：会话里说话被拒；列会话时写明交给了官方 App
    const refused = await frontend.trySendParts([{ type: "text", text: "接着修" }], { conversation: channel });
    expect(refused.ok === false && refused.error.message).toBe("这个会话在 Claude Code 的官方 App 里：先在 ⚙ 里收回，再接着说");
    const listed = await takeoverApi.sessions(td.url, CC);
    expect(listed.body.sessions.find((s) => s.id === "s-idle")?.busy).toBe(`任务 ${task.id}「修 CI 的 flaky 测试」交给了官方 App`);

    // 只读跟随：那边新的一轮（手机上说的、它调的工具、它回的）补记进来，标 remote，不交给 agent（维护者不拉起）
    sessions.transcripts.get("s-idle")!.push(
      userSays("r1", "在手机上：再跑一遍那几个用例", "2026-10-25T02:10:00.000Z"),
      replies("r2", "m3", [bash("toolu_r1", "npm test -- flaky")], "tool_use"),
      result("r3", "toolu_r1", "15 passed"),
      replies("r4", "m4", [textBlock("都过了，可以推了。")], "end_turn"),
    );
    await waitUntil(() => remoteOf(td, channel).length === 3, { timeoutMs: 10_000, describe: () => JSON.stringify(remoteOf(td, channel).map(textOf)) });
    const [said, called, answered] = remoteOf(td, channel);
    expect(said!.message).toMatchObject({ speaker: "user", remote: true, parts: [{ type: "text", text: "在手机上：再跑一遍那几个用例" }] });
    expect(said!.message.time).toMatch(/^2026-10-25T/);
    expect(said!.taskId).toBe(task.id);
    // 两次模型调用各是一条回复（同前情）：调工具的那条带着结果，说话的那条
    expect(called!.message.speaker).toBe("agent");
    expect(called!.message.parts).toEqual([expect.objectContaining({ type: "tool_call", tool: "bash", argsSummary: "npm test -- flaky", outcome: "done", resultSummary: "15 passed" })]);
    expect(called!.message.parts[0]).not.toHaveProperty("disposition");
    expect(answered!.message).toMatchObject({ speaker: "agent", remote: true, parts: [{ type: "text", text: "都过了，可以推了。" }] });
    expect(live(td, task.maintainerId)).toBe(false);
    // 再跟几遍不重复记
    await sleep(600);
    expect(remoteOf(td, channel)).toHaveLength(3);
    // 还没说完的那条回复（工具结果还没回来）先不记
    sessions.transcripts.get("s-idle")!.push(userSays("r5", "再看看 lint"), replies("r6", "m5", [bash("toolu_r2", "npm run lint")], "tool_use"));
    await waitUntil(() => remoteOf(td, channel).length === 4, { timeoutMs: 10_000, describe: () => JSON.stringify(remoteOf(td, channel).map(textOf)) });
    await sleep(500);
    expect(remoteOf(td, channel).map(textOf)).toEqual(["在手机上：再跑一遍那几个用例", "<tool_call>", "都过了，可以推了。", "再看看 lint"]);

    // 收回：停掉那边的后台会话、最后补记一遍（没说完的那条也记上），恢复同一个会话
    cli.calls.splice(0);
    const reclaimed = await agentSettingsApi.takeover(td.url, task.maintainerId, "reclaim");
    expect(reclaimed.status).toBe(200);
    expect(reclaimed.body.runtime?.takeover).toMatchObject({ place: "ergo", returned: false });
    expect(reclaimed.body.runtime?.takeover).not.toHaveProperty("url");
    expect(cli.commands()).toEqual(["stop s-idle"]);
    expect(cli.jobOf("s-idle")?.[1].pid).toBeUndefined();
    expect(remoteOf(td, channel)).toHaveLength(5);
    expect((remoteOf(td, channel)[4]!.message.parts[0] as ToolCallPart).argsSummary).toBe("npm run lint");
    expect(taskNow(td, task.id).takeover).toMatchObject({ remote: { job: "s-idle", sessionId: "s-idle", url } });
    expect(taskNow(td, task.id).takeover?.remote).not.toHaveProperty("since");
    expect(taskNow(td, task.id).takeover?.returnedAt).toBeUndefined();
    expect(payloadsOf(td, channel).map(textOf).at(-1)).toBe("收回了：官方 App 那边的后台会话已经停掉，这里接着同一个 Claude Code 会话");
    await frontend.sendText("接着修", { conversation: channel });
    const next = await nthReply(td, channel, 2);
    expect(next.options.resume).toBe("s-idle");
    expect(next.input).toContain("接着修");
    await waitUntil(() => taskNow(td, task.id).state === "done", { timeoutMs: 30_000, describe: () => JSON.stringify(taskNow(td, task.id)) });

    // 再交出去：唤醒原来的后台会话（不带参数，带了会开出副本），同一个链接
    cli.calls.splice(0);
    const again = await agentSettingsApi.takeover(td.url, task.maintainerId, "remote");
    expect(again.status).toBe(200);
    expect(cli.commands()).toEqual(["--bg --resume s-idle", "logs s-idle"]);
    expect(again.body.runtime?.takeover?.url).toBe(url);
    expect(cli.jobs.size).toBe(1);
    await frontend.close();
  }, 120_000);

  it("二狗自己开的会话也能交：在做一轮的先打断、任务转等我；终端里开着的不交；开出副本的停掉、不算交出去；收回后接着同一个会话；pi 的不能交", async () => {
    // 第一轮：说一句、同时问你（提问卡等着）——这一轮没做完
    const question: FauxStep = {
      kind: "reply",
      text: "先看看下载目录。",
      toolCalls: [{ name: "AskUserQuestion", arguments: { questions: [{ question: "按什么分？", header: "分法", options: [{ label: "按月份", description: "一个月一个" }, { label: "按类型", description: "图片、文档分开" }], multiSelect: false }] } as never }],
    };
    const { td, cli, frontend } = await setup((_id, spawn) => (spawn === 1 ? [question, say("问的没答上，先停下。")] : [echo]));
    const task = td.daemon.tasks.delegate({ title: "整理下载目录", instructions: "把下载目录按月份分好", runtime: CC });
    const channel = maintainerChannel(task.maintainerId);
    // 在做一轮：等提问卡的时候还没做完
    await waitUntil(() => td.daemon.store.read("cards", 0, EVENT_TYPES.card).length > 0 && live(td, task.maintainerId), { timeoutMs: 30_000, describe: () => JSON.stringify(payloadsOf(td, channel).map(textOf)) });
    const panel = await agentSettingsApi.view(td.url, task.maintainerId);
    expect(panel.body.runtime).toMatchObject({ id: CC, remoteControl: true });
    expect(panel.body.runtime).not.toHaveProperty("takeover");
    let ergoSession = "";
    cli.ergoOpen = () => (live(td, task.maintainerId) && ergoSession ? [{ sessionId: ergoSession, pid: 777 }] : []);

    const handed = await agentSettingsApi.takeover(td.url, task.maintainerId, "remote");
    expect(handed.status).toBe(200);
    expect(live(td, task.maintainerId)).toBe(false);
    const own = taskNow(td, task.id).takeover!;
    expect(own).toMatchObject({ runtime: CC, title: "整理下载目录", own: true, returnedAt: expect.any(String), remote: { since: expect.any(String) } });
    ergoSession = own.sessionId;
    expect(own.remote?.sessionId).toBe(own.sessionId);
    expect(cli.commands()[0]).toBe(`--bg --resume ${own.sessionId} --remote-control 整理下载目录`);
    expect(handed.body.runtime?.takeover).toMatchObject({ own: true, place: "remote", url: `https://claude.ai/code/session_01Rc${own.sessionId.slice(0, 8)}` });
    // 执行中的任务转等我，写明在官方 App 里
    await waitUntil(() => taskNow(td, task.id).state === "waiting_for_user", { timeoutMs: 10_000, describe: () => JSON.stringify(taskNow(td, task.id)) });
    expect(taskNow(td, task.id).waitNote).toBe("在 Claude Code 的官方 App 里接着：在 ⚙ 里收回后接着");

    // 收回：任务接着执行；在这里接着说，接的是同一个会话（按会话目录里记着的恢复）
    const reclaimed = await agentSettingsApi.takeover(td.url, task.maintainerId, "reclaim");
    expect(reclaimed.status).toBe(200);
    await waitUntil(() => taskNow(td, task.id).state === "running", { timeoutMs: 10_000, describe: () => JSON.stringify(taskNow(td, task.id)) });
    await frontend.sendText("按月份分吧", { conversation: channel });
    const resumed = await nthReply(td, channel, 1);
    expect(resumed.options.resume).toBe(own.sessionId);
    expect(resumed.input).toContain("按月份分吧");
    await waitUntil(() => taskNow(td, task.id).state === "done", { timeoutMs: 30_000, describe: () => JSON.stringify(taskNow(td, task.id)) });

    // 终端里又开着：不交（二狗的进程停了一下，又回到二狗接管）
    cli.interactive = [{ sessionId: own.sessionId, pid: 4321 }];
    cli.calls.splice(0);
    const busy = await agentSettingsApi.takeover(td.url, task.maintainerId, "remote");
    expect(busy.status).toBe(409);
    expect(busy.body.message).toBe("在终端里开着（进程 4321）：等了 1 秒还开着，先不交给官方 App（这时交出去会开出一份副本）");
    expect(cli.commands()).toEqual([]);
    expect(taskNow(td, task.id).takeover?.returnedAt).toBeUndefined();
    expect((await agentSettingsApi.view(td.url, task.maintainerId)).body.runtime?.takeover).toMatchObject({ place: "ergo", own: true });

    // 开出了副本（另一个进程刚开、agents 还没列出来）：停掉副本，不算交出去
    cli.interactive = [];
    cli.hidden = [own.sessionId];
    cli.calls.splice(0);
    const copied = await agentSettingsApi.takeover(td.url, task.maintainerId, "remote");
    expect(copied.status).toBe(409);
    expect(copied.body.message).toBe("Claude Code 没接着原来的会话，另开了一份副本（copy1000），副本已经停掉；先不交给官方 App");
    expect(cli.commands()).toEqual([`--bg --resume ${own.sessionId}`, "stop copy1000"]);
    expect(cli.jobs.get("copy1000")?.pid).toBeUndefined();
    expect(taskNow(td, task.id).takeover?.returnedAt).toBeUndefined();

    // pi 的不能交
    const piTask = td.daemon.tasks.delegate({ title: "pi 的任务", instructions: "随便做点什么" });
    const refused = await agentSettingsApi.takeover(td.url, piTask.maintainerId, "remote");
    expect(refused.status).not.toBe(200);
    expect(refused.body.message).toBe("pi 不能交给官方 App");
    await frontend.close();
  }, 120_000);
});
