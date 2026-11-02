// 主切面：从已有的 Codex 会话接管、交还、收回。真的守护进程走组合根和插件清单；清单里的 Codex 插件换成同名的、子进程接假 app-server、会话来源是假本机的那个
// （helpers/fake-codex.ts：编的会话、编的状况、编的前情，不读 ~/.codex、不起 codex、不花额度）：
// - 列出：本机的会话连同标题、工作目录、分支、最近活动；Codex 说开着的、最近有活动的标成占着，再早的写判不准；
// - 接管（判不准的也能接）：普通任务、运行时 Codex、工作目录是会话原来的；负责人恢复的就是选中的会话（thread/resume）；前情进会话不交给 agent；之后标"任务在管"；
// - 占着的：不分叉被拒；分叉一份接管：新会话，原会话不动；
// - 交还：负责人的子进程退了、发消息被拒；收回：交还之后别处又动过、开着的被拒，交还之后没动过的能收回，接着同一个会话；
// - 接管成项目；前情读不出来照样接管。
import fs from "node:fs";
import path from "node:path";
import { EVENT_TYPES, maintainerChannel, type MessageEventPayload, type Task } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { CODEX_RUNTIME_ID } from "../../src/codex/api.ts";
import type { FauxStep, RuntimeHistory } from "../../src/runtime/index.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { FakeCodexSessions, fakeCodexPluginWith } from "../helpers/fake-codex.ts";
import type { FakeCodexEcho } from "../helpers/fake-codex-app-server.ts";
import { FAKE_CODEX_STORE, FakeCodexStore } from "../helpers/fake-codex-app-server.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { agentSettingsApi, takeoverApi } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const echo: FauxStep = { kind: "echo_context" };
const CODEX = CODEX_RUNTIME_ID;

const HISTORY: RuntimeHistory = {
  truncated: true,
  items: [
    { kind: "user", text: "CI 上 test/flaky.test.ts 老是挂，帮我看看" },
    {
      kind: "agent",
      parts: [
        { type: "reasoning", text: "先跑一遍测试看看" },
        { type: "tool", id: "c1", tool: "bash", native: "Bash", args: { command: "npm test -- flaky" }, result: "2 failed, 8 passed" },
        { type: "text", text: "有两个用例在时区上不稳。" },
      ],
    },
  ],
};

async function setup(maintainer: FauxStep[] | ((id: string, spawn: number) => FauxStep[]) = [echo]) {
  const root = makeTempDir("ergo-codex-takeover-");
  const mk = (name: string) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    return fs.realpathSync.native(dir);
  };
  const dirs = { idle: mk("flaky-ci"), open: mk("ledger"), project: mk("home-wiki") };
  const sessions = new FakeCodexSessions();
  const hourAgo = Date.now() - 3_600_000;
  sessions.sessions = [
    { sessionId: "s-recent", title: "刚刚还在动的", cwd: dirs.open, updatedAt: Date.now() - 30_000, loaded: false },
    { sessionId: "s-idle", title: "修 CI 的 flaky 测试", cwd: dirs.idle, branch: "fix/flaky", updatedAt: hourAgo, loaded: false },
    { sessionId: "s-open", title: "记账本导出 CSV", cwd: dirs.open, branch: "main", updatedAt: hourAgo - 1000, loaded: true },
    { sessionId: "s-proj", title: "家里的知识库", cwd: dirs.project, updatedAt: hourAgo - 2000, loaded: false },
  ];
  sessions.histories.set("s-idle", HISTORY);
  const td = await startTestDaemon({ extraPlugins: [fakeCodexPluginWith(sessions)], maintainer });
  const frontend = await TestFrontend.connect(td.url);
  return { td, sessions, frontend, dirs };
}

const payloadsOf = (td: TestDaemon, channel: string) => td.daemon.store.read(channel, 0, EVENT_TYPES.message).map((e) => e.payload as MessageEventPayload);
const textOf = (p: MessageEventPayload) => p.message.parts.map((part) => ("text" in part ? part.text : `<${part.type}>`)).join("");
const agentReplies = (td: TestDaemon, channel: string) =>
  payloadsOf(td, channel)
    .filter((p) => p.message.speaker === "agent" && p.message.prelude !== true)
    .map(textOf);
async function nthReply(td: TestDaemon, channel: string, n: number): Promise<FakeCodexEcho> {
  await waitUntil(() => agentReplies(td, channel).length >= n, { timeoutMs: 30_000, describe: () => `等 ${channel} 的第 ${n} 条回复：${JSON.stringify(payloadsOf(td, channel).map(textOf))}` });
  return JSON.parse(agentReplies(td, channel)[n - 1]!) as FakeCodexEcho;
}
const taskNow = (td: TestDaemon, id: string): Task => td.daemon.tasks.get(id)!;

/** 这个负责人的会话目录里假 Codex 的记录（测试读它看接着的是哪个 thread） */
function storeOf(td: TestDaemon, maintainerId: string): FakeCodexStore {
  const found = fs
    .readdirSync(td.dataDir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name === FAKE_CODEX_STORE)
    .map((d) => path.join(d.parentPath, d.name))
    .find((file) => file.includes(maintainerId));
  if (!found) throw new Error(`没找到 ${maintainerId} 的假 Codex 记录`);
  return new FakeCodexStore(found);
}

describe("从已有的 Codex 会话接管", () => {
  it("列出本机的会话：开着的、最近有活动的标成占着（写明可能开着），再早的写判不准；pi 不能接管", async () => {
    const { td, dirs } = await setup();
    const listed = await takeoverApi.sessions(td.url, CODEX);
    expect(listed.status).toBe(200);
    const byId = new Map(listed.body.sessions.map((s) => [s.id, s]));
    expect(byId.get("s-idle")).toMatchObject({ title: "修 CI 的 flaky 测试", cwd: dirs.idle, branch: "fix/flaky", unsure: expect.stringContaining("可能还开着，先在那边关掉，或者分叉一份接管") });
    expect(byId.get("s-idle")!.busy).toBeUndefined();
    expect(byId.get("s-open")!.busy).toBe("这个会话正开着（有别的 Codex 进程在写它）");
    expect(byId.get("s-recent")!.busy).toContain("可能还开着");
    expect((await takeoverApi.sessions(td.url, "pi")).status).toBe(400);
  }, 60_000);

  it("接管判不准的成任务：恢复选中的会话、在原来的工作目录里；前情进会话不交给 agent；之后标任务在管、别的再接被拒，分叉一份能接", async () => {
    const { td, sessions, dirs } = await setup();
    const taken = await takeoverApi.takeOver(td.url, CODEX, { sessionId: "s-idle", as: "task", request: "把剩下两个测试修好", idempotencyKey: "k-1" });
    expect(taken.status).toBe(200);
    expect(taken.body).toMatchObject({ sessionId: "s-idle", prelude: HISTORY.items.length });
    const task = taskNow(td, taken.body.taskId!);
    expect(task).toMatchObject({ kind: "plain", origin: "takeover", runtime: CODEX, workdir: dirs.idle, title: "修 CI 的 flaky 测试" });
    expect(task.takeover).toMatchObject({ runtime: CODEX, sessionId: "s-idle" });

    const channel = maintainerChannel(task.maintainerId);
    const first = await nthReply(td, channel, 1);
    // 第一条输入就是用户写的那句；thread 是接管的那个；工作目录是原来的；前情不在输入里
    expect(first.thread).toBe("s-idle");
    expect(first.cwd).toBe(dirs.idle);
    expect(first.input).toContain("把剩下两个测试修好");
    expect(first.input).not.toContain("CI 上 test/flaky.test.ts 老是挂");
    const prelude = payloadsOf(td, channel).filter((p) => p.message.prelude === true);
    expect(prelude.map((p) => p.message.speaker)).toEqual(["system", "user", "agent"]);
    expect(textOf(prelude[0]!)).toContain("前情：Codex 会话「修 CI 的 flaky 测试」");
    expect(prelude[2]!.message.parts.find((part) => part.type === "tool_call")).toMatchObject({ tool: "bash", argsSummary: "npm test -- flaky", outcome: "done" });
    const store = storeOf(td, task.maintainerId);
    expect(store.violations).toEqual([]);
    expect(Object.keys(store.threads)).toEqual(["s-idle"]);

    // 标"任务在管"；别的再接被拒
    const again = (await takeoverApi.sessions(td.url, CODEX)).body.sessions.find((s) => s.id === "s-idle")!;
    expect(again.heldBy).toMatchObject({ kind: "task", id: task.id });
    const second = await takeoverApi.takeOver(td.url, CODEX, { sessionId: "s-idle", as: "task", request: "再来", idempotencyKey: "k-2" });
    expect(second.status).toBe(409);

    // 分叉一份能接：新会话，原会话不动
    const forked = await takeoverApi.takeOver(td.url, CODEX, { sessionId: "s-idle", as: "task", request: "分叉接着", fork: true, idempotencyKey: "k-3" });
    expect(forked.status).toBe(200);
    expect(sessions.forks).toMatchObject([{ from: "s-idle", cwd: dirs.idle }]);
    expect(taskNow(td, forked.body.taskId!).takeover).toMatchObject({ sessionId: sessions.forks[0]!.to, forkedFrom: "s-idle" });
    expect(sessions.sessions.find((s) => s.sessionId === "s-idle")!.title).toBe("修 CI 的 flaky 测试");
  }, 90_000);

  it("占着的（Codex 说开着、最近有活动）：不分叉被拒，写明；分叉能接", async () => {
    const { td, sessions } = await setup();
    const open = await takeoverApi.takeOver(td.url, CODEX, { sessionId: "s-open", as: "task", request: "接着", idempotencyKey: "k-1" });
    expect(open.status).toBe(409);
    const recent = await takeoverApi.takeOver(td.url, CODEX, { sessionId: "s-recent", as: "task", request: "接着", idempotencyKey: "k-2" });
    expect(recent.status).toBe(409);
    const forked = await takeoverApi.takeOver(td.url, CODEX, { sessionId: "s-open", as: "task", request: "分叉接着", fork: true, idempotencyKey: "k-3" });
    expect(forked.status).toBe(200);
    expect(sessions.forks).toHaveLength(1);
  }, 60_000);

  it("交还、收回：交还后子进程退了、不再写；交还之后别处又动过的收回被拒；没动过的收回接着同一个会话", async () => {
    const { td, sessions, frontend } = await setup(() => [echo, echo]);
    const taken = await takeoverApi.takeOver(td.url, CODEX, { sessionId: "s-idle", as: "task", request: "先做一点", idempotencyKey: "k-1" });
    const task = taskNow(td, taken.body.taskId!);
    const channel = maintainerChannel(task.maintainerId);
    expect((await nthReply(td, channel, 1)).thread).toBe("s-idle");

    // 交还：负责人的子进程退了，⚙ 里写明；发消息被拒
    const returned = await agentSettingsApi.takeover(td.url, task.maintainerId, "return");
    expect(returned.status).toBe(200);
    expect(returned.body.runtime?.takeover?.returned).toBe(true);
    expect(taskNow(td, task.id).takeover?.returnedAt).toBeDefined();
    expect(td.daemon.agents.live().some((a) => a.agentId === task.maintainerId)).toBe(false);
    // 交还之后列表里不再是"在管"
    expect((await takeoverApi.sessions(td.url, CODEX)).body.sessions.find((s) => s.id === "s-idle")?.heldBy).toBeUndefined();

    // 交还之后用户在终端里又用了：收回被拒，写明
    const moved = sessions.sessions.find((s) => s.sessionId === "s-idle")!;
    moved.updatedAt = Date.now() + 1000;
    const refused = await agentSettingsApi.takeover(td.url, task.maintainerId, "reclaim");
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toContain("可能还开着");

    // 那边关了、过了一阵（活动时间早于"最近"）：能收回，接着同一个会话
    moved.updatedAt = Date.now() - 3_600_000;
    const reclaimed = await agentSettingsApi.takeover(td.url, task.maintainerId, "reclaim");
    expect(reclaimed.status).toBe(200);
    expect(reclaimed.body.runtime?.takeover?.returned).toBe(false);
    expect(taskNow(td, task.id).takeover?.returnedAt).toBeUndefined();
    await frontend.sendText("接着做", { conversation: channel });
    const second = await nthReply(td, channel, 2);
    expect(second.thread).toBe("s-idle");
    expect(second.input).toContain("接着做");
    expect(storeOf(td, task.maintainerId).violations).toEqual([]);
  }, 120_000);

  it("接管成项目：不经秘书直接建出，工作目录是会话原来的；前情读不出来照样接管、写明", async () => {
    const { td, sessions, dirs } = await setup();
    sessions.histories.set("s-proj", new Error("读不了"));
    const taken = await takeoverApi.takeOver(td.url, CODEX, { sessionId: "s-proj", as: "project", request: "", idempotencyKey: "k-1" });
    expect(taken.status).toBe(200);
    expect(taken.body.projectId).toBeDefined();
    const project = td.daemon.projects.get(taken.body.projectId!)!;
    expect(project).toMatchObject({ runtime: CODEX, workdir: { external: true, path: dirs.project } });
    expect(taken.body.prelude).toBe(0);
  }, 60_000);
});
