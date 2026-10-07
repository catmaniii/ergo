// pi 契约测试：守护进程代为执行的工具（秘书建、改、取消提醒这类只产生卡片的工具）。
// 装配参数里给出工具的名字、说明和参数的 JSON Schema，子进程把它们登记成 pi 的自定义工具；
// 模型调用时，子进程发 host_tool_call 给守护进程，等同一 requestId 的 host_tool_result 再把结果交回模型。
import { describe, expect, it } from "vitest";
import { fauxModel, spawnTestAgent, startTestDaemon } from "../helpers/daemon.ts";
import type { HostToolSpec } from "../../src/runtime/index.ts";

const ECHO_TOOL: HostToolSpec = {
  name: "make_note",
  description: "记一条笔记（测试用）",
  parameters: { type: "object", properties: { text: { type: "string" }, times: { type: "integer" } }, required: ["text"], additionalProperties: false },
};

describe("pi 契约：守护进程代为执行的工具", () => {
  it("工具登记进会话；模型调用时转给守护进程，结果原样回到模型的上下文里", async () => {
    const { daemon } = await startTestDaemon();
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "contract-host-tool",
      model: fauxModel([
        { kind: "reply", toolCalls: [{ name: "make_note", arguments: { text: "交报告", times: 2 } }] },
        { kind: "echo_context" },
      ]),
      tools: [],
      hostTools: [ECHO_TOOL],
    });
    const ready = await log.next("ready");
    expect(ready.loaded.tools).toEqual(["make_note"]);
    agent.send({ type: "user_input", inputId: "in-1", text: "记一下交报告" });

    const call = await log.next("host_tool_call");
    expect(call).toMatchObject({ toolName: "make_note", args: { text: "交报告", times: 2 } });
    agent.send({ type: "host_tool_result", requestId: call.requestId, result: { text: "记好了：交报告 ×2", isError: false } });

    expect(await log.next("tool_call_end")).toMatchObject({ toolCallId: call.toolCallId, isError: false, resultText: "记好了：交报告 ×2" });
    // 带工具调用的那条回复在 host_tool_call 之前就定稿了；这里等到的是下一次模型调用（echo_context）
    const echoed = await log.next("message_final");
    const seen = echoed.message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    expect(seen).toContain("[tool] make_note");
    expect(seen).toContain("[toolResult] make_note: 记好了：交报告 ×2");
    expect((await log.next("turn_end")).outcome).toBe("completed");
  });

  it("守护进程回报错：模型看到的是一次出错的工具调用，带着说明", async () => {
    const { daemon } = await startTestDaemon();
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "contract-host-tool-error",
      model: fauxModel([
        { kind: "reply", toolCalls: [{ name: "make_note", arguments: { text: "下周一" } }] },
        { kind: "reply", text: "好，我换个写法。" },
      ]),
      tools: [],
      hostTools: [ECHO_TOOL],
    });
    await log.next("ready");
    agent.send({ type: "user_input", inputId: "in-1", text: "记一下" });
    const call = await log.next("host_tool_call");
    agent.send({ type: "host_tool_result", requestId: call.requestId, result: { text: "日期写法不对", isError: true } });
    expect(await log.next("tool_call_end")).toMatchObject({ isError: true, resultText: "日期写法不对" });
    expect((await log.next("turn_end")).outcome).toBe("completed");
  });

  it("参数不合 JSON Schema：pi 直接把校验错误交回模型，不转给守护进程", async () => {
    const { daemon } = await startTestDaemon();
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "contract-host-tool-invalid",
      model: fauxModel([
        { kind: "reply", toolCalls: [{ name: "make_note", arguments: { times: 1 } }] },
        { kind: "reply", text: "漏了内容。" },
      ]),
      tools: [],
      hostTools: [ECHO_TOOL],
    });
    await log.next("ready");
    agent.send({ type: "user_input", inputId: "in-1", text: "记一下" });
    expect(await log.next("tool_call_end")).toMatchObject({ isError: true });
    expect((await log.next("turn_end")).outcome).toBe("completed");
    expect(log.ofType("host_tool_call")).toEqual([]);
  });
});
