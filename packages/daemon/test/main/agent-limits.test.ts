// 主切面：agent 管家的资源限制（规格第 3、21 节，12 号票），数值配小：
// - 同时存活的子进程不超过上限；满了以后新的唤起排队（活动状态"排队"），名额空出时按先后拉起；
// - 维护者闲置到设定时间后子进程退出，再来输入时重新拉起、接着原会话；秘书常驻、不闲置退出；
// - 单次模型调用、单次工具调用超时被中止并上报错误（工具可以声明更长）；
// - 孤儿进程按周期被回收（Job 对象只在 Windows 上有）。
import fs from "node:fs";
import path from "node:path";
import { ASSISTANT_NAME_MARK, type ActivityEventPayload, CHANNELS, EVENT_TYPES, maintainerChannel, type MessageEventPayload, Type, type TurnEndEventPayload } from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { defineHostTool } from "../../src/agent-manager/host-tools.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { spawnTestAgent, startTestDaemon, fauxModel } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { submitPlanStep } from "../helpers/plans.ts";
import { isProcessAlive, waitUntil } from "../helpers/process.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { secretary: SECRETARY, cards: CARDS, board: BOARD, activity: ACTIVITY } = CHANNELS;

const say = (text: string): FauxStep => ({ kind: "reply", text });
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const writeBrief = (taskId: string): FauxStep => call("write_task_brief", { taskId, goal: `完成 ${taskId}`, acceptanceCriteria: ["做完"], constraints: [], projects: [], memoryScope: "" });

const messagesOf = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.message }).map((f) => f.payload as MessageEventPayload);
const textOf = (p: MessageEventPayload) => p.message.parts.map((part) => ("text" in part ? part.text : `<${part.type}>`)).join("");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const slash = (p: string) => p.replaceAll("\\", "/");
const activityOf = (frontend: TestFrontend) => frontend.events({ channel: ACTIVITY, type: EVENT_TYPES.activity }).map((f) => f.payload as ActivityEventPayload);

describe("子进程上限与排队", () => {
  it("同时存活的子进程不超过上限（秘书占一个）；满了以后新的唤起不报错而是排队，排队期间活动状态是“排队”；名额空出时按先后拉起", async () => {
    const { url, daemon } = await startTestDaemon({
      config: { agents: { maxLive: 2, idleMinutes: 0.01 } },
      secretary: [writeBrief("t-1"), say("好"), writeBrief("t-2"), say("好"), writeBrief("t-3"), say("好")],
      maintainer: [submitPlanStep(), say("交了")],
    });
    // 一直看着：活着的子进程数的最大值
    let maxLive = 0;
    const sampler = setInterval(() => (maxLive = Math.max(maxLive, daemon.agents.live().length)), 10);
    try {
      const frontend = await TestFrontend.connect(url);
      await frontend.subscribe({ [SECRETARY]: 0, [CARDS]: 0, [BOARD]: 0, [ACTIVITY]: 0 });
      for (const n of [1, 2, 3]) await frontend.startTask(`任务 ${n}`);
      await waitUntil(() => daemon.tasks.list().every((t) => t.state === "awaiting_confirm"), { timeoutMs: 45_000, describe: () => JSON.stringify(daemon.tasks.list().map((t) => t.state)) });

      expect(maxLive).toBeLessThanOrEqual(2);
      const activity = activityOf(frontend);
      // 后两个维护者都排过队；排队的先后就是拉起的先后
      for (const id of ["tm-2", "tm-3"]) expect(activity).toContainEqual(expect.objectContaining({ agentId: id, state: "queued" }));
      const firstRun = (id: string) => activity.findIndex((a) => a.agentId === id && a.state !== "queued");
      expect(firstRun("tm-1")).toBeLessThan(firstRun("tm-2"));
      expect(firstRun("tm-2")).toBeLessThan(firstRun("tm-3"));
      expect(firstRun("tm-2")).toBeGreaterThan(activity.findIndex((a) => a.agentId === "tm-2" && a.state === "queued"));
    } finally {
      clearInterval(sampler);
    }
  }, 90_000);
});

describe("闲置退出", () => {
  it("维护者闲置到设定时间后子进程退出；再来输入时重新拉起、接着原会话；秘书常驻、不闲置退出", async () => {
    const { url, daemon } = await startTestDaemon({
      config: { agents: { idleMinutes: 0.02 } },
      secretary: [call("create_task", { title: "X 的调研", summary: "帮我整理 X 的调研" }), writeBrief("t-1"), say("交给维护者了")],
      // 第一次唤起：提交计划；闲置退出后第二次唤起：回显看到的上下文（接着原会话）
      maintainer: (_id, spawn) => (spawn === 1 ? [submitPlanStep(), say("计划交了")] : [{ kind: "echo_context" }]),
    });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0, [CARDS]: 0, [BOARD]: 0, [maintainerChannel("tm-1")]: 0 });
    const secretaryPid = daemon.secretary.pid;
    await frontend.sendText("帮我整理一份 X 的调研");
    await waitUntil(() => daemon.tasks.get("t-1")?.state === "awaiting_confirm", { timeoutMs: 20_000 });
    // 闲置 1.2 秒后退出
    await waitUntil(() => !daemon.agents.live().some((a) => a.agentId === "tm-1"), { timeoutMs: 15_000, describe: () => JSON.stringify(daemon.agents.live()) });
    // 秘书还是原来那个子进程
    expect(daemon.secretary.pid).toBe(secretaryPid);
    expect(isProcessAlive(secretaryPid!)).toBe(true);

    // 用户打回：意见作为输入交给维护者，它被重新拉起，接着原会话
    const card = daemon.tasks.latestPlan("t-1")!;
    const result = await frontend.cardAction({ cardId: card.cardId, action: "reject", expectedVersion: 1, note: "再简短一点" });
    expect(result.ok).toBe(true);
    await waitUntil(() => frontend.events({ channel: maintainerChannel("tm-1"), type: EVENT_TYPES.turnEnd }).length >= 2, { timeoutMs: 20_000 });
    const seen = textOf(messagesOf(frontend, maintainerChannel("tm-1")).at(-1)!);
    const users = seen.split("\n").filter((l) => l.startsWith("[user]"));
    expect(users).toHaveLength(2);
    expect(seen).toContain("[toolResult] submit_plan: 计划已提交（第 1 版）");
    expect(seen).toContain("用户打回了计划（第 1 版），意见：「再简短一点」");
    expect(daemon.secretary.pid).toBe(secretaryPid);
  }, 60_000);
});

describe("超时", () => {
  it("单次模型调用超时：中止这一轮，以出错结束，会话里说明是模型调用超时", async () => {
    const { url } = await startTestDaemon({
      config: { agents: { modelCallMinutes: 0.01 } },
      secretary: [say("这是一段很长的回答，".repeat(40))],
      secretaryTokensPerSecond: 5,
    });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await frontend.sendText("讲讲");
    const end = (await frontend.next(SECRETARY, EVENT_TYPES.turnEnd, 15_000)).payload as TurnEndEventPayload;
    expect(end).toMatchObject({ outcome: "error", error: "模型调用超过 0.6 秒没有结束，已中止" });
    expect(textOf(messagesOf(frontend, SECRETARY).at(-1)!)).toBe(`${ASSISTANT_NAME_MARK}这次没能回复：模型调用超过 0.6 秒没有结束，已中止`);
  }, 30_000);

  it("单次工具调用超时：默认的被中止并上报错误；声明了更长超时的工具不受默认超时限制", async () => {
    const params = Type.Object({});
    const slowDefault = defineHostTool({ name: "slow_default", title: "慢的工具", description: "要等很久", parameters: params, readOnlyOrIdempotent: true, run: async () => (await sleep(4000), { text: "终于好了" }) });
    const slowDeclared = defineHostTool({ name: "slow_declared", title: "声明了更长超时的工具", description: "要等一会儿", parameters: params, readOnlyOrIdempotent: true, timeoutMs: 10_000, run: async () => (await sleep(1500), { text: "好了" }) });
    const { url } = await startTestDaemon({
      config: { agents: { toolCallMinutes: 0.01 } },
      secretaryTools: [slowDefault, slowDeclared],
      secretary: [call("slow_declared", {}), say("做完了"), call("slow_default", {}), say("不该到这里")],
    });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await frontend.sendText("做一下");
    expect(((await frontend.next(SECRETARY, EVENT_TYPES.turnEnd, 15_000)).payload as TurnEndEventPayload).outcome).toBe("completed");
    expect(textOf(messagesOf(frontend, SECRETARY).at(-1)!)).toBe("做完了");

    await frontend.sendText("再做一下");
    const end = (await frontend.next(SECRETARY, EVENT_TYPES.turnEnd, 15_000)).payload as TurnEndEventPayload;
    expect(end).toMatchObject({ outcome: "error", error: "工具 slow_default 的调用超过 0.6 秒没有结束，已中止" });
    expect(messagesOf(frontend, SECRETARY).map(textOf)).not.toContain("不该到这里");
  }, 30_000);
});

describe.runIf(process.platform === "win32")("孤儿进程回收", () => {
  it("bash 起的进程在父进程退出后成了孤儿：按周期被回收；agent 子进程本身不动", async () => {
    const { daemon } = await startTestDaemon({ config: { agents: { orphanSweepSeconds: 0.3 } } });
    const pidDir = makeTempDir("ergou-orphan-");
    const script = path.join(import.meta.dirname, "..", "fixtures", "grandchild.mjs");
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "orphan-test",
      model: fauxModel([call("bash", { command: `"${slash(process.execPath)}" "${slash(script)}" "${slash(pidDir)}" --orphan-parent` }), say("起好了")]),
      tools: ["bash"],
    });
    await log.next("ready");
    agent.send({ type: "user_input", inputId: "in-1", text: "起一个后台进程" });
    await log.next("turn_end");
    const orphanFile = path.join(pidDir, "orphan.pid");
    await waitUntil(() => fs.existsSync(orphanFile) && fs.readFileSync(orphanFile, "utf8") !== "");
    // 孤儿自己一直挂着不退出（fixtures/grandchild.mjs）：它不在了就是被回收了（可能在这一轮结束之前就已经被回收）
    const orphan = Number(fs.readFileSync(orphanFile, "utf8"));
    await waitUntil(() => !isProcessAlive(orphan), { timeoutMs: 10_000, describe: () => `孤儿进程 ${orphan} 还活着` });
    expect(isProcessAlive(agent.pid!)).toBe(true);
    expect(daemon.agents.live()).toContainEqual({ agentId: "orphan-test", pid: agent.pid });
  }, 30_000);
});
