// agent 管家给体检的（411，agent-manager.ts 的 doctorFacts）：子进程的名额用了多少、排队几个；每个在一轮里的 agent 停在哪一步、
// 停了多久、多久算太久（单次模型调用的超时 + 工具调用的超时；工具声明了自己的超时按它的）；在等用户批准的不算。
// 子进程换成停在一个工具调用上的测试子进程（fixtures/stuck-tool-child.ts）：不跑模型、不连网。判几级在 housekeeping.test.ts。
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { type AgentManager, createAgentManager } from "../../src/agent-manager/agent-manager.ts";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { piRuntime } from "../../src/runtime/index.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const STUCK_ENTRY = fileURLToPath(new URL("../fixtures/stuck-tool-child.ts", import.meta.url));
const MINUTE = 60_000;

function manager(): AgentManager {
  const created = createAgentManager({
    layout: dataDirLayout(makeTempDir("ergo-doctor-agents-")),
    parentEnv: process.env,
    job: undefined,
    limits: { maxLive: 2, modelCallMs: 5 * MINUTE, toolCallMs: 10 * MINUTE },
    runtimes: { resolve: () => ({ ...piRuntime, entry: STUCK_ENTRY }) },
    log: () => {},
  });
  return created;
}

const spawn = (agents: AgentManager, agentId: string) =>
  agents.spawn({
    agentId,
    model: { kind: "catalog", provider: "deepseek", modelId: "deepseek-flash", thinkingLevel: "off" },
    tools: [],
    toolTimeouts: { slow_tool: 60 * MINUTE },
    toolTitles: { slow_tool: "慢工具", quick_tool: "快工具" },
  });

describe("agent 管家给体检的名额和步骤（411）", () => {
  it("闲着没有步骤；一轮里停在工具上：报工具的中文名、停了多久、多久算太久（模型 + 工具的超时，工具声明的优先）；等用户批准时不报", { timeout: 60_000 }, async () => {
    const agents = manager();
    try {
      const agent = spawn(agents, "tm-1");
      await vi.waitUntil(() => agent.state === "running", { timeout: 30_000 });
      expect(agents.doctorFacts()).toEqual({ live: 1, maxLive: 2, queued: 0, steps: [] });

      // 默认超时的工具：5 + 10 分钟
      agent.send({ type: "user_input", inputId: "in-1", text: "quick_tool" });
      await vi.waitUntil(() => agents.doctorFacts().steps.some((step) => step.detail.kind === "calling_tool"), { timeout: 10_000 });
      const [quick] = agents.doctorFacts().steps;
      expect(quick).toMatchObject({ agentId: "tm-1", detail: { kind: "calling_tool", tool: "快工具" }, limitMs: 15 * MINUTE });
      expect(quick!.forMs).toBeGreaterThanOrEqual(0);
      expect(quick!.forMs).toBeLessThan(MINUTE);

      // 在等用户批准：不算卡住，不报；不等了又报
      agents.userWaitStarted("tm-1", "approval-1", { kind: "approval", tool: "快工具" });
      expect(agents.doctorFacts().steps).toEqual([]);
      agents.userWaitEnded("tm-1", "approval-1");
      expect(agents.doctorFacts().steps).toHaveLength(1);

      // 中止这一轮：没有步骤了
      agent.send({ type: "abort" });
      await vi.waitUntil(() => agents.doctorFacts().steps.length === 0, { timeout: 10_000 });

      // 声明了自己超时的工具：5 + 60 分钟
      agent.send({ type: "user_input", inputId: "in-2", text: "slow_tool" });
      // 送了输入、工具调用还没开始的那一下是在等模型（5 + 10 分钟）
      expect(agents.doctorFacts().steps).toMatchObject([{ detail: { kind: "thinking" }, limitMs: 15 * MINUTE }]);
      await vi.waitUntil(() => agents.doctorFacts().steps[0]?.detail.kind === "calling_tool", { timeout: 10_000 });
      expect(agents.doctorFacts().steps[0]).toMatchObject({ detail: { kind: "calling_tool", tool: "慢工具" }, limitMs: 65 * MINUTE });
    } finally {
      await agents.shutdown();
    }
  });

  it("名额：活着的到了上限，后来的排队，排队的个数报出来", { timeout: 60_000 }, async () => {
    const agents = manager();
    try {
      const first = spawn(agents, "tm-1");
      const second = spawn(agents, "tm-2");
      spawn(agents, "tm-3");
      await vi.waitUntil(() => first.state === "running" && second.state === "running", { timeout: 30_000 });
      expect(agents.doctorFacts()).toMatchObject({ live: 2, maxLive: 2, queued: 1 });
    } finally {
      await agents.shutdown();
    }
  });
});
