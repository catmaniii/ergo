// pi 契约测试：守护进程代为执行的工具（宿主工具），和用户输入里的图片。
// - 宿主工具：秘书建、改、取消提醒这类只产生卡片的工具（06），"读取附件""把文件作为附件发出"（09）……
//   装配参数里给出工具的名字、说明和参数的 JSON Schema，子进程把它们登记成 pi 的自定义工具；模型调用时，
//   子进程发 host_tool_call 给守护进程，等同一 requestId 的 host_tool_result 再把结果交回模型。
//   工具白名单是空的（秘书没有 pi 的内置工具）时，宿主工具照样可用；一次一个、按模型给出的顺序执行。
//   调用时带上这一轮已经进了上下文的插话（86 号票，宿主协议 16：发语音工具据此认出用户在说话的那一轮）。
// - 图片输入（09）：用户输入带图片时，模型调用的上下文里有这张图片。
import { describe, expect, it } from "vitest";
import type { HostToolSpec } from "../../src/runtime/index.ts";
import { fauxModel, spawnTestAgent, startTestDaemon } from "../helpers/daemon.ts";

const NOTE_TOOL: HostToolSpec = {
  name: "make_note",
  description: "记一条笔记（测试用）",
  parameters: { type: "object", properties: { text: { type: "string" }, times: { type: "integer" } }, required: ["text"], additionalProperties: false },
};

/** 调一次记笔记 */
const note = (text: string) => ({ name: "make_note", arguments: { text } });

describe("pi 契约：守护进程代为执行的工具", () => {
  it("工具登记进会话；模型调用时转给守护进程，等结果期间工具没结束；结果原样回到下一次模型调用的上下文里", async () => {
    const { daemon } = await startTestDaemon();
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "contract-host-tool",
      model: fauxModel([{ kind: "reply", toolCalls: [{ name: "make_note", arguments: { text: "交报告", times: 2 } }] }, { kind: "echo_context" }]),
      tools: [],
      hostTools: [NOTE_TOOL],
    });
    const ready = await log.next("ready");
    expect(ready.loaded.tools).toEqual(["make_note"]);
    agent.send({ type: "user_input", inputId: "in-1", text: "记一下交报告" });

    const call = await log.next("host_tool_call");
    expect(call).toMatchObject({ toolName: "make_note", args: { text: "交报告", times: 2 } });
    // 等结果期间工具没有结束
    await new Promise((r) => setTimeout(r, 300));
    expect(log.ofType("tool_call_end")).toEqual([]);

    agent.send({ type: "host_tool_result", requestId: call.requestId, result: { text: "记好了：交报告 ×2", isError: false } });
    expect(await log.next("tool_call_end")).toMatchObject({ toolCallId: call.toolCallId, toolName: "make_note", isError: false, resultText: "记好了：交报告 ×2" });
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
      model: fauxModel([{ kind: "reply", toolCalls: [{ name: "make_note", arguments: { text: "下周一" } }] }, { kind: "reply", text: "好，我换个写法。" }]),
      tools: [],
      hostTools: [NOTE_TOOL],
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
      model: fauxModel([{ kind: "reply", toolCalls: [{ name: "make_note", arguments: { times: 1 } }] }, { kind: "reply", text: "漏了内容。" }]),
      tools: [],
      hostTools: [NOTE_TOOL],
    });
    await log.next("ready");
    agent.send({ type: "user_input", inputId: "in-1", text: "记一下" });
    expect(await log.next("tool_call_end")).toMatchObject({ isError: true });
    expect((await log.next("turn_end")).outcome).toBe("completed");
    expect(log.ofType("host_tool_call")).toEqual([]);
  });

  it("模型一次调用几个工具：一次一个、按模型给出的顺序转给守护进程，前一个有结果才转下一个", async () => {
    const { daemon } = await startTestDaemon();
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "contract-host-tool-sequential",
      model: fauxModel([
        { kind: "reply", toolCalls: [{ name: "make_note", arguments: { text: "一" } }, { name: "make_note", arguments: { text: "二" } }] },
        { kind: "reply", text: "都记好了。" },
      ]),
      tools: [],
      hostTools: [NOTE_TOOL],
    });
    await log.next("ready");
    agent.send({ type: "user_input", inputId: "in-1", text: "记两条" });
    const first = await log.next("host_tool_call");
    expect(first.args).toEqual({ text: "一" });
    await new Promise((r) => setTimeout(r, 300));
    expect(log.ofType("host_tool_call")).toHaveLength(1);
    agent.send({ type: "host_tool_result", requestId: first.requestId, result: { text: "记好了：一", isError: false } });
    const second = await log.next("host_tool_call");
    expect(second.args).toEqual({ text: "二" });
    agent.send({ type: "host_tool_result", requestId: second.requestId, result: { text: "记好了：二", isError: false } });
    expect((await log.next("turn_end")).outcome).toBe("completed");
  });

  it("调用带上这一轮已经进了上下文的插话（86 号票）：送进去还排着的不算（同一批里后面的调用），进了上下文之后才算；下一轮不再带", async () => {
    const { daemon } = await startTestDaemon();
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "contract-host-tool-interjected",
      model: fauxModel([
        { kind: "reply", toolCalls: [note("一"), note("二")] },
        { kind: "reply", toolCalls: [note("三")] },
        { kind: "reply", text: "好" },
        { kind: "reply", toolCalls: [note("四")] },
        { kind: "reply", text: "好" },
      ]),
      tools: [],
      hostTools: [NOTE_TOOL],
    });
    await log.next("ready");
    const answer = async (expected: string) => {
      const call = await log.next("host_tool_call");
      expect(call.args).toEqual({ text: expected });
      agent.send({ type: "host_tool_result", requestId: call.requestId, result: { text: `记好了：${expected}`, isError: false } });
      return call;
    };
    agent.send({ type: "user_input", inputId: "in-1", text: "记几条" });
    const first = await log.next("host_tool_call");
    expect(first).not.toHaveProperty("interjected");
    // 第一条在等结果时用户插了一句：排进 pi 的插话队列，这一批工具做完、下一次模型调用之前才进上下文
    agent.send({ type: "interject", inputId: "in-2", text: "顺便记一下买牛奶" });
    await new Promise((r) => setTimeout(r, 300));
    agent.send({ type: "host_tool_result", requestId: first.requestId, result: { text: "记好了：一", isError: false } });
    expect(await answer("二")).not.toHaveProperty("interjected");
    // 下一次模型调用之前插话进了上下文：之后的调用带上它
    expect((await answer("三")).interjected).toEqual(["in-2"]);
    expect(await log.next("turn_end")).toEqual({ type: "turn_end", outcome: "completed", interjected: ["in-2"] });
    // 下一轮：不再带上一轮的插话
    agent.send({ type: "user_input", inputId: "in-3", text: "再记一条" });
    expect(await answer("四")).not.toHaveProperty("interjected");
    expect((await log.next("turn_end")).outcome).toBe("completed");
  });
});

describe("pi 契约：图片输入", () => {
  it("用户输入带图片：模型调用的上下文里有这张图片", async () => {
    const { daemon } = await startTestDaemon();
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "contract-image-input",
      model: fauxModel([{ kind: "echo_context" }]),
      tools: [],
    });
    await log.next("ready");
    const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    agent.send({ type: "user_input", inputId: "in-1", text: "[图片 1：点.png]", images: [{ mime: "image/png", data: pixel.toString("base64") }] });
    const echo = await log.next("message_final");
    const context = echo.message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    expect(context).toContain("[user] [图片 1：点.png]");
    expect(context).toContain("[image image/png]");
  });
});
