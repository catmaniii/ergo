// 主切面：从已有的 Claude Code 会话接管（290 号票，Claude Code 接入一期之五）。真的守护进程走组合根和插件清单；清单里的 Claude Code 插件
// 换成同名的、子进程接假 SDK、会话来源是假本机的那个（helpers/fake-claude-sessions.ts：编的会话、编的"正开着"、编的前情，
// 不读用户真实的 ~/.claude、不起 claude、不花额度）：
// - 列出：本机的会话连同标题、工作目录、分支、最近活动、大小；终端里开着的、后台会话、停着的后台记录标成占着；查不到占没占的一律占着；
// - 接管空闲的成任务：普通任务、运行时 Claude Code、工作目录是会话原来的；维护者恢复的就是选中的会话（resume）、cwd 是会话原来的；
//   前情（用户说的、它回的、工具调用，读密钥文件的不留结果）进了维护者的会话、带 prelude，不交给 agent；之后列表里标"任务在管"；
//   同一个幂等键重发拿到同一个任务（不再读前情）；
// - 被占着的：不分叉被拒（写明在哪开着）；二狗自己在管的同样被拒；分叉一份接管：新会话，原会话不动；
// - 交还：维护者的子进程退了、发消息被拒、列表里不再是"在管"；收回：别处开着的被拒，关掉后收回，接着同一个会话；
// - 接管成项目：不经秘书直接建出（筹备中），工作目录是会话原来的（外部路径），用户说话时维护者接着那个会话；
// - 前情读不出来照样接管，会话里写明。
import fs from "node:fs";
import path from "node:path";
import { EVENT_TYPES, maintainerChannel, type MessageEventPayload, type Task } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { CLAUDE_CODE_RUNTIME_ID } from "../../src/claude-code/api.ts";
import type { FauxStep, RuntimeHistory } from "../../src/runtime/index.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import type { FakeClaudeEcho } from "../helpers/fake-claude-sdk.ts";
import { FakeClaudeSessions, fakeTakeoverClaudeCodePlugin } from "../helpers/fake-claude-sessions.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { agentSettingsApi, takeoverApi } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const echo: FauxStep = { kind: "echo_context" };
const CC = CLAUDE_CODE_RUNTIME_ID;

/** 编的前情：问了一句、它跑了测试（一次 bash、一次读 .env）、回了一句；再问一句、它改了文件 */
const HISTORY: RuntimeHistory = {
  truncated: true,
  items: [
    { kind: "compacted" },
    { kind: "user", text: "CI 上 test/flaky.test.ts 老是挂，帮我看看" },
    {
      kind: "agent",
      parts: [
        { type: "reasoning", text: "先跑一遍测试看看" },
        { type: "tool", id: "toolu_1", tool: "bash", native: "Bash", args: { command: "npm test -- flaky" }, result: "2 failed, 8 passed" },
        { type: "tool", id: "toolu_2", tool: "read", native: "Read", args: { path: "D:/demo/.env" }, result: "API_TOKEN=sk-secret-123456" },
        { type: "text", text: "有两个用例在时区上不稳。" },
      ],
    },
    { kind: "user", text: "先修第一个" },
    { kind: "agent", parts: [{ type: "tool", id: "toolu_3", tool: "edit", native: "Edit", args: { path: "test/flaky.test.ts" }, failed: true, result: "old_string not found" }, { type: "text", text: "第一个改好了，还剩两个。" }] },
  ],
};

interface Setup {
  td: TestDaemon;
  sessions: FakeClaudeSessions;
  frontend: TestFrontend;
  /** 会话原来的工作目录（真实路径） */
  dirs: { idle: string; terminal: string; project: string };
}

async function setup(maintainer: FauxStep[] | ((id: string, spawn: number) => FauxStep[]) = [echo]): Promise<Setup> {
  const root = makeTempDir("ergo-takeover-");
  const mk = (name: string) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    return fs.realpathSync.native(dir);
  };
  const dirs = { idle: mk("flaky-ci"), terminal: mk("ledger"), project: mk("home-wiki") };
  const sessions = new FakeClaudeSessions();
  const at = Date.parse("2026-10-25T10:00:00+08:00");
  sessions.sessions = [
    { sessionId: "s-idle", title: "修 CI 的 flaky 测试", cwd: dirs.idle, branch: "fix/flaky", lastModified: at, bytes: 2_400_000 },
    { sessionId: "s-term", title: "记账本导出 CSV", cwd: dirs.terminal, branch: "main", lastModified: at - 3_600_000, bytes: 180_000 },
    { sessionId: "s-bg", title: "夜里跑的数据整理", cwd: dirs.terminal, lastModified: at - 7_200_000 },
    { sessionId: "s-proj", title: "家里的知识库", cwd: dirs.project, branch: "main", lastModified: at - 86_400_000, bytes: 52_000_000 },
  ];
  sessions.open = [
    { sessionId: "s-term", kind: "interactive", pid: 4321, name: "work-1" },
    { sessionId: "s-bg", kind: "background", id: "c153a547" },
  ];
  sessions.histories.set("s-idle", HISTORY);
  const td = await startTestDaemon({ extraPlugins: [fakeTakeoverClaudeCodePlugin(sessions)], maintainer });
  const frontend = await TestFrontend.connect(td.url);
  return { td, sessions, frontend, dirs };
}

const payloadsOf = (td: TestDaemon, channel: string) =>
  td.daemon.store
    .read(channel, 0, EVENT_TYPES.message)
    .map((e) => e.payload as MessageEventPayload);
const textOf = (p: MessageEventPayload) => p.message.parts.map((part) => ("text" in part ? part.text : `<${part.type}>`)).join("");
const agentReplies = (td: TestDaemon, channel: string) =>
  payloadsOf(td, channel)
    .filter((p) => p.message.speaker === "agent" && p.message.prelude !== true)
    .map(textOf);
async function nthReply(td: TestDaemon, channel: string, n: number): Promise<FakeClaudeEcho> {
  await waitUntil(() => agentReplies(td, channel).length >= n, { timeoutMs: 30_000, describe: () => `等 ${channel} 的第 ${n} 条回复：${JSON.stringify(payloadsOf(td, channel).map(textOf))}` });
  return JSON.parse(agentReplies(td, channel)[n - 1]!) as FakeClaudeEcho;
}
const taskNow = (td: TestDaemon, id: string): Task => td.daemon.tasks.get(id)!;

describe("从已有的 Claude Code 会话接管（290 号票）", () => {
  it("列出本机的会话，终端里开着的、后台会话标成占着；查不到占没占的一律占着", async () => {
    const { td, sessions, dirs } = await setup();
    const listed = await takeoverApi.sessions(td.url, CC);
    expect(listed.status).toBe(200);
    expect(listed.body.sessions.map((s) => s.id)).toEqual(["s-idle", "s-term", "s-bg", "s-proj"]);
    expect(listed.body.sessions[0]).toEqual({ id: "s-idle", title: "修 CI 的 flaky 测试", cwd: dirs.idle, branch: "fix/flaky", updatedAt: expect.stringMatching(/^2026-10-25T10:00:00/), bytes: 2_400_000 });
    expect(listed.body.sessions[1]!.busy).toBe("在终端里开着（进程 4321）");
    expect(listed.body.sessions[2]!.busy).toBe("有一个停着的后台会话记着它（c153a547），当作占着");
    expect(listed.body.sessions[3]!.busy).toBeUndefined();
    // pi 不能接管
    expect((await takeoverApi.sessions(td.url, "pi")).status).toBe(400);
    sessions.open = new Error("没找到本机的 claude.exe");
    const unknown = await takeoverApi.sessions(td.url, CC);
    expect(unknown.body.sessions.every((s) => s.busy === "查不到它现在有没有在别处开着")).toBe(true);
  }, 60_000);

  it("接管空闲的成任务：恢复选中的会话、在原来的工作目录里；前情进会话不交给 agent；之后标任务在管、别的再接被拒，分叉一份能接", async () => {
    const { td, sessions, frontend, dirs } = await setup();
    const taken = await takeoverApi.takeOver(td.url, CC, { sessionId: "s-idle", as: "task", request: "把剩下两个测试修好", idempotencyKey: "k-1" });
    expect(taken.status).toBe(200);
    expect(taken.body).toMatchObject({ sessionId: "s-idle", prelude: HISTORY.items.length });
    const task = taskNow(td, taken.body.taskId!);
    expect(task).toMatchObject({ kind: "plain", origin: "takeover", runtime: CC, workdir: dirs.idle, title: "修 CI 的 flaky 测试", summary: "把剩下两个测试修好" });
    expect(task.takeover).toMatchObject({ runtime: CC, sessionId: "s-idle", title: "修 CI 的 flaky 测试" });
    expect(task.takeover!.returnedAt).toBeUndefined();

    // 第一条输入就是用户写的那句：Claude Code 恢复的是选中的会话、cwd 是会话原来的；前情不在输入里
    const channel = maintainerChannel(task.maintainerId);
    const first = await nthReply(td, channel, 1);
    expect(first.options.resume).toBe("s-idle");
    expect(first.options.sessionId).toBeUndefined();
    expect(first.options.cwd).toBe(dirs.idle);
    expect(first.input).toContain("把剩下两个测试修好");
    expect(first.input).not.toContain("CI 上 test/flaky.test.ts 老是挂");

    // 前情：说明、压缩标记、用户的两句、它的两条回复（工具调用画成二狗的；读密钥文件的不留结果），最后一行写明接管了
    const all = payloadsOf(td, channel);
    const prelude = all.filter((p) => p.message.prelude === true);
    expect(prelude.map((p) => p.message.speaker)).toEqual(["system", "system", "user", "agent", "user", "agent"]);
    expect(textOf(prelude[0]!)).toBe("前情：Claude Code 会话「修 CI 的 flaky 测试」最近的 5 条（更早的留在 Claude Code 自己的记录里）");
    expect(prelude.every((p) => p.taskId === task.id)).toBe(true);
    const calls = prelude[3]!.message.parts.filter((part) => part.type === "tool_call");
    expect(calls).toMatchObject([
      { tool: "bash", argsSummary: "npm test -- flaky", outcome: "done", resultSummary: "2 failed, 8 passed", genericBash: true },
      { tool: "read", argsSummary: "D:/demo/.env", outcome: "done", readsSecretFile: true },
    ]);
    expect(calls[0]).not.toHaveProperty("disposition");
    expect(calls[1]).not.toHaveProperty("resultSummary");
    expect(prelude[5]!.message.parts[0]).toMatchObject({ type: "tool_call", tool: "edit", outcome: "error" });
    const note = all.find((p) => p.message.speaker === "system" && p.message.prelude !== true && textOf(p).startsWith("接管了"));
    expect(textOf(note!)).toBe(`接管了 Claude Code 会话「修 CI 的 flaky 测试」：工作目录 ${dirs.idle} · 分支 fix/flaky。管着期间只有这里写这个会话；要回终端里用，先在 ⚙ 里交还`);
    // 前情不在输入队列里：任务做完一轮就完成了（没有排着的）
    await waitUntil(() => taskNow(td, task.id).state === "done", { timeoutMs: 30_000, describe: () => JSON.stringify(taskNow(td, task.id)) });

    // 同一个幂等键重发：同一个任务，不再读前情
    const historyCalls = sessions.calls.history;
    const again = await takeoverApi.takeOver(td.url, CC, { sessionId: "s-idle", as: "task", request: "把剩下两个测试修好", idempotencyKey: "k-1" });
    expect(again.body.taskId).toBe(task.id);
    expect(sessions.calls.history).toBe(historyCalls);

    // 列表里标"任务在管"（二狗自己的进程在 agents 里也显示成开着，以写入锁为准）
    sessions.open = [...(sessions.open as []), { sessionId: "s-idle", kind: "interactive", pid: 999 }];
    const listed = await takeoverApi.sessions(td.url, CC);
    const held = listed.body.sessions.find((s) => s.id === "s-idle")!;
    expect(held.heldBy).toEqual({ kind: "task", id: task.id, title: "修 CI 的 flaky 测试", maintainerId: task.maintainerId });
    expect(held.busy).toBe(`任务 ${task.id}「修 CI 的 flaky 测试」在管（交还之前别的不能接管）`);

    // 二狗在管的、终端里开着的：不分叉被拒，写明在哪开着
    const refusedHeld = await takeoverApi.takeOver(td.url, CC, { sessionId: "s-idle", as: "task", request: "再来一个", idempotencyKey: "k-2" });
    expect(refusedHeld.status).toBe(409);
    expect(refusedHeld.body.message).toContain(`任务 ${task.id}「修 CI 的 flaky 测试」在管`);
    const refusedTerm = await takeoverApi.takeOver(td.url, CC, { sessionId: "s-term", as: "task", request: "接着导出", idempotencyKey: "k-3" });
    expect(refusedTerm.status).toBe(409);
    expect(refusedTerm.body.message).toBe("在终端里开着（进程 4321）：先在那边关掉再接管，或者分叉一份接管（原会话不动）");
    expect(td.daemon.tasks.list()).toHaveLength(1);

    // 分叉一份接管：新会话，原会话不动（没有被恢复）
    const forked = await takeoverApi.takeOver(td.url, CC, { sessionId: "s-term", as: "task", request: "接着导出", fork: true, idempotencyKey: "k-4" });
    expect(forked.status).toBe(200);
    expect(sessions.forks).toEqual([{ from: "s-term", to: "s-term-fork-1" }]);
    const forkTask = taskNow(td, forked.body.taskId!);
    expect(forkTask.takeover).toMatchObject({ sessionId: "s-term-fork-1", forkedFrom: "s-term" });
    expect(forkTask.workdir).toBe(dirs.terminal);
    const forkEcho = await nthReply(td, maintainerChannel(forkTask.maintainerId), 1);
    expect(forkEcho.options.resume).toBe("s-term-fork-1");
    expect(payloadsOf(td, maintainerChannel(forkTask.maintainerId)).some((p) => textOf(p).startsWith("分叉了一份 Claude Code 会话「记账本导出 CSV」来接管（原会话不动）"))).toBe(true);
    await frontend.close();
  }, 120_000);

  it("交还：子进程退了、发消息被拒、不再在管；收回：别处开着的被拒，关掉后收回，接着同一个会话", async () => {
    const { td, sessions, frontend } = await setup();
    const taken = await takeoverApi.takeOver(td.url, CC, { sessionId: "s-idle", as: "task", request: "把剩下两个测试修好", idempotencyKey: "k-1" });
    const task = taskNow(td, taken.body.taskId!);
    const channel = maintainerChannel(task.maintainerId);
    await nthReply(td, channel, 1);
    await waitUntil(() => taskNow(td, task.id).state === "done", { timeoutMs: 30_000, describe: () => JSON.stringify(taskNow(td, task.id)) });
    expect(td.daemon.agents.live().some((a) => a.agentId === task.maintainerId)).toBe(true);

    // ⚙ 里看得到接管自哪个会话
    const panel = await agentSettingsApi.view(td.url, task.maintainerId);
    // 292 号票起写明现在在哪边（二狗接管着）
    expect(panel.body.runtime?.takeover).toEqual({ sessionId: "s-idle", title: "修 CI 的 flaky 测试", cwd: task.workdir, returned: false, place: "ergo" });

    const returned = await agentSettingsApi.takeover(td.url, task.maintainerId, "return");
    expect(returned.status).toBe(200);
    expect(returned.body.runtime?.takeover?.returned).toBe(true);
    expect(taskNow(td, task.id).takeover?.returnedAt).toBeDefined();
    // 交还等子进程退干净才回
    expect(td.daemon.agents.live().some((a) => a.agentId === task.maintainerId)).toBe(false);
    const refused = await frontend.trySendParts([{ type: "text", text: "接着修" }], { conversation: channel });
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.error.message).toBe("这个会话已交还给 Claude Code：先在 ⚙ 里收回，再接着说");
    const listed = await takeoverApi.sessions(td.url, CC);
    expect(listed.body.sessions.find((s) => s.id === "s-idle")).not.toHaveProperty("heldBy");

    // 交还期间用户在终端里开着：收回被拒
    sessions.open = [{ sessionId: "s-idle", kind: "interactive", pid: 777 }];
    const busy = await agentSettingsApi.takeover(td.url, task.maintainerId, "reclaim");
    expect(busy.status).toBe(409);
    expect(busy.body.message).toBe("在终端里开着（进程 777）：先在那边关掉再收回");
    // 关掉以后收回：接着同一个会话
    sessions.open = [];
    const reclaimed = await agentSettingsApi.takeover(td.url, task.maintainerId, "reclaim");
    expect(reclaimed.status).toBe(200);
    expect(reclaimed.body.runtime?.takeover?.returned).toBe(false);
    await frontend.sendText("接着修", { conversation: channel });
    const next = await nthReply(td, channel, 2);
    expect(next.options.resume).toBe("s-idle");
    expect(next.input).toContain("接着修");
    await frontend.close();
  }, 120_000);

  it("接管成项目：直接建出，工作目录是会话原来的（外部路径），用户说话时维护者接着那个会话；前情读不出来照样接管", async () => {
    const { td, sessions, frontend, dirs } = await setup();
    sessions.histories.set("s-proj", new Error("会话记录读不了"));
    const taken = await takeoverApi.takeOver(td.url, CC, { sessionId: "s-proj", as: "project", request: "", idempotencyKey: "k-p" });
    expect(taken.status).toBe(200);
    const project = td.daemon.projects.get(taken.body.projectId!)!;
    expect(project).toMatchObject({ name: "家里的知识库", goal: "家里的知识库", origin: "takeover", state: "preparing", runtime: CC, workdir: { external: true, path: dirs.project } });
    expect(project.takeover).toMatchObject({ sessionId: "s-proj" });
    expect(td.daemon.projects.workdir(project)).toBe(dirs.project);
    const channel = maintainerChannel(project.maintainerId);
    expect(payloadsOf(td, channel).map(textOf)[0]).toBe("前情没读出来（会话记录读不了）；会话照常接管，之前的对话留在 Claude Code 自己的记录里");
    // 不自动开始：用户说话时维护者才接着那个会话
    expect(td.daemon.agents.live().some((a) => a.agentId === project.maintainerId)).toBe(false);
    await frontend.sendText("先看看现在有哪些页面", { conversation: channel });
    const first = await nthReply(td, channel, 1);
    expect(first.options.resume).toBe("s-proj");
    expect(first.options.cwd).toBe(dirs.project);
    // 同名的再接一个（分叉）：名字加序号
    const again = await takeoverApi.takeOver(td.url, CC, { sessionId: "s-proj", as: "project", request: "试一个分支", fork: true, idempotencyKey: "k-p2" });
    expect(td.daemon.projects.get(again.body.projectId!)!.name).toBe("家里的知识库 (2)");
    await frontend.close();
  }, 120_000);
});
