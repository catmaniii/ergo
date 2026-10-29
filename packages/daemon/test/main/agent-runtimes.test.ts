// 主切面：插件宿主的"运行时"贡献点（286 号票，ADR-0027）。真的守护进程走组合根和插件清单；测试用的假运行时插件
// （helpers/fake-runtime.ts，只在测试里）经 extraPlugins 接在清单后面，在数据契约里登记运行时 fake，子进程入口是
// fixtures/fake-runtime-child.ts（不跑模型，只说宿主协议——和 pi 的子进程收同一条"启动"、说同一套消息）：
// - GET /api/runtimes：pi 在最前（内核自带，照同一个接口登记），假运行时带插件名、能力清单、可选模型、设置项；停用了写明原因；
// - 运行时是 fake 的任务：它的维护者经假运行时的子进程入口拉起，普通任务照常做完；没写运行时的照旧是 pi；
// - 插件停用着：运行时是 fake 的任务一开始做就转等我（运行时没启用，写明哪个插件没启用），维护者不拉起、点"继续"没用，
//   活动状态"等你"；启用后接着做完；
// - 插件运行中停用：手头在做的那一轮做完（不中止，任务照常自动完成），排着队还没拉起的维护者不再拉起、它的任务转等我；
//   之后接着说的任务也转等我；启用后都接着做完；
// - 项目的维护者用它、插件在配置里停用着：用户说话时维护者不拉起，活动状态"等你"写明哪个插件没启用；启用后接着回话。
// pi 的维护者行为不变由现有的主切面锁着（它们照旧全过、录制不用重录）。
import { type ActivityEventPayload, activityDetailText, CHANNELS, EVENT_TYPES, maintainerChannel, type MessageEventPayload, type Task } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import type { Daemon } from "../../src/daemon.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { FAKE_REPLY, FAKE_RUNTIME_ID, FAKE_RUNTIME_PLUGIN, fakeRuntime, fakeRuntimePlugin } from "../helpers/fake-runtime.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { pluginsApi, runtimesApi } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";
import { seedProject } from "../helpers/projects.ts";

/** 从现在起拉起（或排队）了哪些 agent、各用哪个运行时（测试接缝：包一层 agent 管家的 spawn，同 helpers/daemon.ts 的 agentSpawns） */
function runtimeSpawns(daemon: Daemon): () => Array<{ agentId: string; runtime: string }> {
  const seen: Array<{ agentId: string; runtime: string }> = [];
  const spawn = daemon.agents.spawn.bind(daemon.agents);
  daemon.agents.spawn = (request) => {
    seen.push({ agentId: request.agentId, runtime: request.runtime ?? "pi" });
    return spawn(request);
  };
  return () => [...seen];
}

const textOf = (p: MessageEventPayload) => p.message.parts.map((part) => ("text" in part ? part.text : `<${part.type}>`)).join("");
/** 会话里 agent 说的话 */
const agentSaid = (td: TestDaemon, channel: string) =>
  td.daemon.store
    .read(channel, 0, EVENT_TYPES.message)
    .map((e) => e.payload as MessageEventPayload)
    .filter((p) => p.message.speaker === "agent")
    .map(textOf);
/** 某个 agent 最近一次记下的活动状态 */
const activityOf = (td: TestDaemon, agentId: string) =>
  td.daemon.store
    .read(CHANNELS.activity, 0, EVENT_TYPES.activity)
    .map((e) => e.payload as ActivityEventPayload)
    .filter((p) => p.agentId === agentId)
    .at(-1);
const taskNow = (td: TestDaemon, taskId: string): Task => td.daemon.tasks.get(taskId)!;
const waitState = (td: TestDaemon, taskId: string, state: Task["state"]) =>
  waitUntil(() => taskNow(td, taskId).state === state, { timeoutMs: 30_000, describe: () => `等 ${taskId} ${state}，现在：${JSON.stringify(taskNow(td, taskId))}` });

const toggle = async (td: TestDaemon, action: "enable" | "disable") => {
  const r = await pluginsApi.act(td.url, FAKE_RUNTIME_PLUGIN, { action, idempotencyKey: `k-${action}-${Date.now()}` });
  expect(r.status).toBe(200);
};

describe("运行时贡献点：插件登记的运行时", () => {
  it("GET /api/runtimes：pi 在最前（内核自带），假运行时带插件名、能力清单、可选模型和设置项；插件运行中停用后写明不能用的原因", async () => {
    const td = await startTestDaemon({ extraPlugins: [fakeRuntimePlugin] });
    const view = (await runtimesApi.view(td.url)).body;
    // 287 起清单里自带 Claude Code 插件，排在 pi 后面
    expect(view.runtimes.map((r) => r.id)).toEqual(["pi", "claude-code", FAKE_RUNTIME_ID]);
    expect(view.runtimes[0]).toMatchObject({ id: "pi", title: "pi", available: true, settings: [] });
    expect(view.runtimes[0]!.plugin).toBeUndefined();
    expect(view.runtimes[0]!.capabilities).toMatchObject({ rollback: true, compact: true, slash_passthrough: false, take_over: false });
    expect(view.runtimes.find((r) => r.id === FAKE_RUNTIME_ID)).toEqual({
      id: FAKE_RUNTIME_ID,
      title: "假运行时",
      plugin: FAKE_RUNTIME_PLUGIN,
      available: true,
      capabilities: { ...fakeRuntime.capabilities },
      models: [{ id: "fake-1", title: "假模型一号" }],
      settings: [{ id: "mode", title: "模式", options: [{ value: "calm", title: "稳" }, { value: "fast", title: "快" }], default: "calm" }],
    });
    await toggle(td, "disable");
    expect((await runtimesApi.view(td.url)).body.runtimes.find((r) => r.id === FAKE_RUNTIME_ID)).toMatchObject({ available: false, unavailable: "假运行时插件没启用" });
  });

  it("运行时是 fake 的普通任务：维护者经假运行时的子进程拉起（同一套宿主协议），回了话、这一轮做完任务自动完成；没写运行时的照旧是 pi", async () => {
    const td = await startTestDaemon({ extraPlugins: [fakeRuntimePlugin], maintainer: [{ kind: "reply", text: "pi 做好了" }] });
    const spawns = runtimeSpawns(td.daemon);
    const fake = td.daemon.tasks.delegate({ title: "整理下载目录", instructions: "把下载目录按月份分好", runtime: FAKE_RUNTIME_ID });
    expect(fake.runtime).toBe(FAKE_RUNTIME_ID);
    await waitState(td, fake.id, "done");
    expect(agentSaid(td, maintainerChannel(fake.maintainerId))).toEqual([`${FAKE_REPLY}（第 1 条）`]);

    const pi = td.daemon.tasks.delegate({ title: "整理桌面", instructions: "把桌面上的截图挪走" });
    expect(pi.runtime).toBeUndefined();
    await waitState(td, pi.id, "done");
    expect(agentSaid(td, maintainerChannel(pi.maintainerId))).toEqual(["pi 做好了"]);
    expect(spawns()).toEqual([
      { agentId: fake.maintainerId, runtime: FAKE_RUNTIME_ID },
      { agentId: pi.maintainerId, runtime: "pi" },
    ]);
  }, 60_000);

  it("插件停用着：运行时是 fake 的任务一开始做就转等我（运行时没启用，写明哪个插件没启用），维护者不拉起、活动状态\"等你\"、点\"继续\"没用；启用后接着做完", async () => {
    const td = await startTestDaemon({ extraPlugins: [fakeRuntimePlugin], config: { plugins: { disabled: [FAKE_RUNTIME_PLUGIN] } } });
    const spawns = runtimeSpawns(td.daemon);
    const task = td.daemon.tasks.delegate({ title: "整理下载目录", instructions: "把下载目录按月份分好", runtime: FAKE_RUNTIME_ID });
    await waitState(td, task.id, "waiting_for_user");
    expect(taskNow(td, task.id)).toMatchObject({ waitReason: "runtime_off", waitNote: "假运行时插件没启用" });
    // 任务书照样排进维护者的队里，维护者拉不起：活动状态"等你"，写明哪个插件没启用
    await waitUntil(() => activityOf(td, task.maintainerId)?.state === "waiting_for_user", { describe: () => JSON.stringify(activityOf(td, task.maintainerId)) });
    const waiting = activityOf(td, task.maintainerId)!;
    expect(waiting.detail).toEqual({ kind: "runtime_off", plugin: "假运行时" });
    expect(activityDetailText(waiting.detail!)).toBe("假运行时插件没启用");
    expect(spawns()).toEqual([]);
    // "继续"不能点：等的是插件启用
    const frontend = await TestFrontend.connect(td.url);
    const resumed = await frontend.taskAction({ taskId: task.id, action: "resume" });
    expect(resumed.ok).toBe(false);

    await toggle(td, "enable");
    await waitState(td, task.id, "done");
    expect(agentSaid(td, maintainerChannel(task.maintainerId))).toEqual([`${FAKE_REPLY}（第 1 条）`]);
    expect(spawns()).toEqual([{ agentId: task.maintainerId, runtime: FAKE_RUNTIME_ID }]);
    await waitUntil(() => activityOf(td, task.maintainerId)?.state !== "waiting_for_user");
  }, 60_000);

  it("插件运行中停用：手头在做的那一轮做完（不中止，任务照常自动完成），排着队还没拉起的维护者不再拉起、它的任务转等我；之后接着说的也转等我；启用后都接着做完", async () => {
    // 子进程最多 2 个（秘书占一个）：第二个维护者排队等名额；维护者闲着很快退出，让出名额
    const td = await startTestDaemon({ extraPlugins: [fakeRuntimePlugin], config: { agents: { maxLive: 2, idleMinutes: 0.01 } } });
    const spawns = runtimeSpawns(td.daemon);
    const slow = td.daemon.tasks.delegate({ title: "慢慢整理", instructions: "【慢】把下载目录按月份分好", runtime: FAKE_RUNTIME_ID });
    const slowChannel = maintainerChannel(slow.maintainerId);
    await waitUntil(() => td.daemon.store.read(slowChannel, 0, EVENT_TYPES.turnStart).length === 1, { describe: () => "等慢的那个维护者开始这一轮" });
    const queued = td.daemon.tasks.delegate({ title: "整理桌面", instructions: "把桌面上的截图挪走", runtime: FAKE_RUNTIME_ID });
    await waitUntil(() => spawns().some((s) => s.agentId === queued.maintainerId), { describe: () => JSON.stringify(spawns()) });
    expect(taskNow(td, queued.id).state).toBe("running");
    expect(td.daemon.agents.live().map((a) => a.agentId)).not.toContain(queued.maintainerId);

    await toggle(td, "disable");
    // 排着队的：维护者手头没在做，任务马上转等我；做着的那一轮照样做完，任务自动完成（没被中止）
    expect(taskNow(td, queued.id)).toMatchObject({ state: "waiting_for_user", waitReason: "runtime_off", waitNote: "假运行时插件没启用" });
    expect(taskNow(td, slow.id).state).toBe("running");
    await waitState(td, slow.id, "done");
    expect(agentSaid(td, slowChannel)).toEqual([`${FAKE_REPLY}（第 1 条）`]);
    // 做完那一轮子进程就退出，排着队的也不再拉起
    await waitUntil(() => !td.daemon.agents.live().some((a) => a.agentId === slow.maintainerId || a.agentId === queued.maintainerId), {
      describe: () => JSON.stringify(td.daemon.agents.live()),
    });
    expect(taskNow(td, queued.id).state).toBe("waiting_for_user");

    // 在做完了的任务里接着说：回到执行中，维护者拉不起，转等我
    const frontend = await TestFrontend.connect(td.url);
    await frontend.sendText("再按年份分一遍", { conversation: slowChannel });
    await waitState(td, slow.id, "waiting_for_user");
    expect(taskNow(td, slow.id)).toMatchObject({ waitReason: "runtime_off", waitNote: "假运行时插件没启用" });
    const spawnsWhileOff = spawns().length;

    await toggle(td, "enable");
    await waitState(td, slow.id, "done");
    await waitState(td, queued.id, "done");
    expect(agentSaid(td, slowChannel)).toHaveLength(2);
    expect(agentSaid(td, maintainerChannel(queued.maintainerId))).toEqual([`${FAKE_REPLY}（第 1 条）`]);
    expect(spawns().slice(spawnsWhileOff).every((s) => s.runtime === FAKE_RUNTIME_ID)).toBe(true);
  }, 90_000);

  it("项目的维护者用假运行时、插件在配置里停用着：用户说话时维护者不拉起，活动状态\"等你\"写明哪个插件没启用；启用后接着回话", async () => {
    const td = await startTestDaemon({ extraPlugins: [fakeRuntimePlugin], config: { plugins: { disabled: [FAKE_RUNTIME_PLUGIN] } } });
    const project = seedProject(td.daemon, "家庭网盘", {
      state: "in_use",
      charterConfirmed: true,
      kind: "other",
      toolkit: { skills: [], mcp: [], bash: false, network: false },
      runtime: FAKE_RUNTIME_ID,
    });
    const channel = maintainerChannel(project.maintainerId);
    const spawns = runtimeSpawns(td.daemon);
    const frontend = await TestFrontend.connect(td.url);
    await frontend.sendText("网盘最近满了吗", { conversation: channel });
    await waitUntil(() => activityOf(td, project.maintainerId)?.state === "waiting_for_user", { describe: () => JSON.stringify(activityOf(td, project.maintainerId)) });
    expect(activityOf(td, project.maintainerId)?.detail).toEqual({ kind: "runtime_off", plugin: "假运行时" });
    expect(spawns()).toEqual([]);

    await toggle(td, "enable");
    await waitUntil(() => agentSaid(td, channel).length === 1, { describe: () => JSON.stringify(agentSaid(td, channel)) });
    expect(agentSaid(td, channel)).toEqual([`${FAKE_REPLY}（第 1 条）`]);
    expect(spawns()).toEqual([{ agentId: project.maintainerId, runtime: FAKE_RUNTIME_ID }]);
    await waitUntil(() => activityOf(td, project.maintainerId)?.state !== "waiting_for_user");
  }, 60_000);
});
