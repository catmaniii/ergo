// 守护进程代为执行的工具（serveHostTools）：子进程先结束了这次调用（这一轮被中止、管家按超时中止）或者 agent 已经退出，
// 工具才做完——结果不再送回（不然子进程报"没有在等结果的工具调用"（bad_command），退出了的报"送不回去"），只记一行收尾。
// 423：记忆管理员的整理被工具调用默认的 10 分钟砍掉后，整理跑完时连着几夜就是这两种报错。假的 agent 句柄，不起子进程。
import { describe, expect, it } from "vitest";
import type { AgentLink } from "../../src/agent-manager/agent-manager.ts";
import { defineHostTool, type HostToolCall, serveHostTools } from "../../src/agent-manager/host-tools.ts";
import type { AgentExit, AgentReport, HostCommand } from "../../src/runtime/index.ts";
import { Type } from "@ergo/protocol";

/** 假的 agent 句柄：记下送过去的命令；退出以后再送就抛错（和真的一样） */
function fakeAgent() {
  const listeners = new Set<(report: AgentReport) => void>();
  const sent: Exclude<HostCommand, { type: "start" }>[] = [];
  let exit: (value: AgentExit) => void = () => {};
  let exited = false;
  const agent: AgentLink = {
    agentId: "memory-curator",
    send(command) {
      if (exited) throw new Error("agent memory-curator 现在已经退出，不能送 host_tool_result");
      sent.push(command);
    },
    onReport(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    exited: new Promise<AgentExit>((resolve) => {
      exit = resolve;
    }),
  };
  return {
    agent,
    sent,
    report: (report: AgentReport) => {
      for (const listener of listeners) listener(report);
    },
    exit: () => {
      exited = true;
      exit({ code: 0, signal: null });
    },
  };
}

/** 一个慢工具：调用到了以后等 finish 才交回（造"整理要跑十几分钟"）；记下这次调用的情境 */
function slowTool(outcome: "ok" | "throw" = "ok") {
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const calls: HostToolCall[] = [];
  const tool = defineHostTool({
    name: "run_memory_consolidation",
    title: "整理一次记忆",
    description: "测试用",
    parameters: Type.Object({}, { additionalProperties: false }),
    readOnlyOrIdempotent: false,
    async run(_args, call) {
      calls.push(call);
      await done;
      if (outcome === "throw") throw new Error("整理被中止了");
      return { text: "整理完了" };
    },
  });
  return { tool, calls, finish: () => finish() };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

const CALL: AgentReport = { type: "host_tool_call", requestId: "host-tool-1", toolCallId: "call-1", toolName: "run_memory_consolidation", args: {} };
const ENDED: AgentReport = { type: "tool_call_end", toolCallId: "call-1", toolName: "run_memory_consolidation", isError: true, resultText: "回合已中止" };

describe("serveHostTools：子进程已经不等结果时不再送", () => {
  it("平常：做完把结果送回同一个 requestId", async () => {
    const fake = fakeAgent();
    const slow = slowTool();
    const logs: string[] = [];
    serveHostTools(fake.agent, [slow.tool], { log: (line) => logs.push(line) });
    fake.report(CALL);
    await flush();
    slow.finish();
    await flush();
    expect(fake.sent).toEqual([{ type: "host_tool_result", requestId: "host-tool-1", result: { text: "整理完了", isError: false } }]);
    expect(logs).toEqual([]);
  });

  it("这一轮被中止（子进程先报了这次调用结束）以后工具才做完：不送结果（子进程不会报 bad_command），这次调用的中止信号置位，只记一行收尾", async () => {
    const fake = fakeAgent();
    const slow = slowTool();
    const logs: string[] = [];
    serveHostTools(fake.agent, [slow.tool], { log: (line) => logs.push(line) });
    fake.report(CALL);
    await flush();
    // 管家按超时中止了这一轮：子进程那边这次调用按"回合已中止"收了尾
    fake.report(ENDED);
    expect(slow.calls[0]!.signal!.aborted).toBe(true);
    slow.finish();
    await flush();
    expect(fake.sent).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("结果不再送回");
    expect(logs.join("\n")).not.toContain("送不回去");
  });

  it("agent 已经退出（闲置退出）以后工具才做完：不去送（不报送不回去）", async () => {
    const fake = fakeAgent();
    const slow = slowTool();
    const logs: string[] = [];
    serveHostTools(fake.agent, [slow.tool], { log: (line) => logs.push(line) });
    fake.report(CALL);
    await flush();
    fake.exit();
    await flush();
    slow.finish();
    await flush();
    expect(fake.sent).toEqual([]);
    expect(logs.join("\n")).not.toContain("送不回去");
    expect(logs.join("\n")).toContain("结果不再送回");
  });

  it("中止以后工具抛错：不当成工具出错记一整段堆栈、不送结果，只记一行收尾", async () => {
    const fake = fakeAgent();
    const slow = slowTool("throw");
    const logs: string[] = [];
    serveHostTools(fake.agent, [slow.tool], { log: (line) => logs.push(line) });
    fake.report(CALL);
    await flush();
    fake.report(ENDED);
    slow.finish();
    await flush();
    expect(fake.sent).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("整理被中止了");
    expect(logs[0]).not.toContain("出错：");
  });
});
