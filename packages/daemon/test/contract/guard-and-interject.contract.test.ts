// pi 契约测试：守卫转发与插话。这两条是 ADR-0004 选 SDK + 自定义 IPC 的实测依据：
// - 工具调用能停在 pi 的 tool_call 钩子里，等守护进程异步送回判定（规格要求最长能等 5 分钟，这里用 2 秒模拟），
//   等待期间工具不执行，按判定执行或不执行；
// - 回合进行中送的插话（pi 的 steer），在当前这一步做完之后、下一次模型调用之前进入上下文。
//   144 号票起插话只用于运行时标了插话送达的通知（14 号票的无进展催促）：用户在 agent 回复时说的话排队，这一轮做完再作为下一轮的输入
//   （那一边是守护进程的事，主切面 test/main/message-queue.test.ts）；这里的插话照催促的样子写。
// - 中止（144 号票的"停止"，任务暂停、取消也是它）：已经流出来的文字留在定稿消息里（stopReason 是 aborted），回合以中止结束。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fauxModel, spawnTestAgent, startTestDaemon } from "../helpers/daemon.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const GUARD_DELAY_MS = 2_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("pi 契约：守卫转发", () => {
  it("等判定期间工具不执行；判定不放行，工具就不执行，模型收到理由", async () => {
    const { daemon } = await startTestDaemon();
    const cwd = makeTempDir("ergo-cwd-");
    const target = path.join(cwd, "denied.txt");
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "contract-guard-deny",
      cwd,
      model: fauxModel([
        { kind: "reply", toolCalls: [{ name: "write", arguments: { path: "denied.txt", content: "不该出现" } }] },
        { kind: "reply", text: "好的，不写了。" },
      ]),
      tools: ["write"],
      forwardToolCalls: true,
    });
    await log.next("ready");
    agent.send({ type: "user_input", inputId: "in-1", text: "写一个文件" });

    const request = await log.next("guard_request");
    expect(request).toMatchObject({ toolName: "write", args: { path: "denied.txt" } });
    await sleep(GUARD_DELAY_MS);
    expect(fs.existsSync(target)).toBe(false);
    expect(log.ofType("tool_call_end")).toEqual([]);

    agent.send({ type: "guard_reply", requestId: request.requestId, verdict: { allow: false, reason: "这一步要先问用户" } });

    const end = await log.next("tool_call_end");
    expect(end).toMatchObject({ toolCallId: request.toolCallId, isError: true });
    expect(end.resultText).toContain("这一步要先问用户");
    expect((await log.next("turn_end")).outcome).toBe("completed");
    expect(fs.existsSync(target)).toBe(false);
  });

  it("等判定期间工具不执行；判定放行之后才执行", async () => {
    const { daemon } = await startTestDaemon();
    const cwd = makeTempDir("ergo-cwd-");
    const target = path.join(cwd, "allowed.txt");
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "contract-guard-allow",
      cwd,
      model: fauxModel([
        { kind: "reply", toolCalls: [{ name: "write", arguments: { path: "allowed.txt", content: "放行后写入" } }] },
        { kind: "reply", text: "写好了。" },
      ]),
      tools: ["write"],
      forwardToolCalls: true,
    });
    await log.next("ready");
    agent.send({ type: "user_input", inputId: "in-1", text: "写一个文件" });

    const request = await log.next("guard_request");
    await sleep(GUARD_DELAY_MS);
    expect(fs.existsSync(target)).toBe(false);

    agent.send({ type: "guard_reply", requestId: request.requestId, verdict: { allow: true } });

    const end = await log.next("tool_call_end");
    expect(end).toMatchObject({ toolCallId: request.toolCallId, isError: false });
    expect(fs.readFileSync(target, "utf8")).toBe("放行后写入");
    expect((await log.next("turn_end")).outcome).toBe("completed");
  });
});

describe("pi 契约：守卫放行时换掉参数（59 号票：流程执行时按计划改回参数）", () => {
  it("放行带了参数：按换掉的参数执行，工具结果前面加上说明，模型看得到", async () => {
    const { daemon } = await startTestDaemon();
    const cwd = makeTempDir("ergo-cwd-");
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "contract-guard-rewrite",
      cwd,
      model: fauxModel([{ kind: "reply", toolCalls: [{ name: "write", arguments: { path: "notes.md", content: "模型写的" } }] }, { kind: "echo_context" }]),
      tools: ["write"],
      forwardToolCalls: true,
    });
    await log.next("ready");
    agent.send({ type: "user_input", inputId: "in-1", text: "写一个文件" });
    const request = await log.next("guard_request");
    agent.send({
      type: "guard_reply",
      requestId: request.requestId,
      verdict: { allow: true, args: { path: "notes.md", content: "计划里写的" }, resultPrefix: "【自动纠偏】参数和计划对不上，已按计划改回。以下是按计划参数执行的结果：" },
    });
    expect(await log.next("tool_call_end")).toMatchObject({ toolCallId: request.toolCallId, isError: false });
    expect(fs.readFileSync(path.join(cwd, "notes.md"), "utf8")).toBe("计划里写的");
    const reply = await log.next("message_final");
    expect(JSON.stringify(reply)).toContain("【自动纠偏】参数和计划对不上，已按计划改回。以下是按计划参数执行的结果：");
    expect((await log.next("turn_end")).outcome).toBe("completed");
  });
});

describe("pi 契约：守卫转发（bash 和守护进程代为执行的工具）", () => {
  it("bash 也停在钩子里：判定不放行，命令真的没跑", async () => {
    const { daemon } = await startTestDaemon();
    const cwd = makeTempDir("ergo-cwd-");
    const target = path.join(cwd, "ran.txt");
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "contract-guard-bash",
      cwd,
      model: fauxModel([{ kind: "reply", toolCalls: [{ name: "bash", arguments: { command: "echo ran > ran.txt" } }] }, { kind: "reply", text: "好。" }]),
      tools: ["bash"],
      forwardToolCalls: true,
    });
    await log.next("ready");
    agent.send({ type: "user_input", inputId: "in-1", text: "跑个命令" });
    const request = await log.next("guard_request");
    expect(request).toMatchObject({ toolName: "bash", args: { command: "echo ran > ran.txt" } });
    agent.send({ type: "guard_reply", requestId: request.requestId, verdict: { allow: false, reason: "拒绝：测试" } });
    expect(await log.next("tool_call_end")).toMatchObject({ toolCallId: request.toolCallId, isError: true });
    expect((await log.next("turn_end")).outcome).toBe("completed");
    expect(fs.existsSync(target)).toBe(false);
  });

  it("守护进程代为执行的工具先经守卫：判定不放行就不发 host_tool_call", async () => {
    const { daemon } = await startTestDaemon();
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "contract-guard-host-tool",
      model: fauxModel([{ kind: "reply", toolCalls: [{ name: "pay", arguments: { amount: 30 } }] }, { kind: "reply", text: "好。" }]),
      tools: [],
      hostTools: [{ name: "pay", description: "付款（测试用）", parameters: { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] } }],
      forwardToolCalls: true,
    });
    await log.next("ready");
    agent.send({ type: "user_input", inputId: "in-1", text: "付 30 块" });
    const request = await log.next("guard_request");
    expect(request).toMatchObject({ toolName: "pay", args: { amount: 30 } });
    agent.send({ type: "guard_reply", requestId: request.requestId, verdict: { allow: false, reason: "交给用户做" } });
    expect(await log.next("tool_call_end")).toMatchObject({ isError: true });
    expect((await log.next("turn_end")).outcome).toBe("completed");
    expect(log.ofType("host_tool_call")).toEqual([]);
  });
});

describe("pi 契约：插话", () => {
  it("回合进行中送的插话，在当前工具调用之后、下一次模型调用之前进入上下文", async () => {
    const { daemon } = await startTestDaemon();
    const cwd = makeTempDir("ergo-cwd-");
    // 运行时的催促（14 号票）：守护进程交给子进程时开头带"[系统通知]"
    const interjection = "[系统通知] 已经 20 分钟没有新进展了，说一下卡在哪、接下来怎么做";
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "contract-interject",
      cwd,
      model: fauxModel([
        { kind: "reply", toolCalls: [{ name: "write", arguments: { path: "draft.txt", content: "草稿" } }] },
        { kind: "echo_context" },
      ]),
      tools: ["write"],
      // 借守卫转发把回合停在第一次工具调用上，确保插话是在回合进行中送到的
      forwardToolCalls: true,
    });
    await log.next("ready");
    agent.send({ type: "user_input", inputId: "in-1", text: "写一份草稿" });

    const request = await log.next("guard_request");
    agent.send({ type: "interject", inputId: "in-2", text: interjection });
    agent.send({ type: "guard_reply", requestId: request.requestId, verdict: { allow: true } });

    await log.next("tool_call_end");
    const echo = await log.next("message_final");
    // 回合结束时列出这一轮里收下的插话（守护进程据此把那条输入记成"已处理"，13 号票）
    expect(await log.next("turn_end")).toEqual({ type: "turn_end", outcome: "completed", interjected: ["in-2"] });

    // 第二次模型调用看到的上下文：原输入 → 工具结果 → 催促
    const lines = echo.message.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n").split("\n");
    const userInput = lines.findIndex((l) => l === "[user] 写一份草稿");
    const toolResult = lines.findIndex((l) => l.startsWith("[toolResult] write"));
    const interjected = lines.findIndex((l) => l === `[user] ${interjection}`);
    expect(userInput).toBeGreaterThanOrEqual(0);
    expect(toolResult).toBeGreaterThan(userInput);
    expect(interjected).toBeGreaterThan(toolResult);
    // 插话前后各只有一次模型调用：第一次产出工具调用，第二次就是回显
    expect(log.ofType("usage")).toHaveLength(2);
  });

  it("没有进行中的回合时送的插话不收：回一条带输入 id 的错误（守护进程把它当普通输入再送），回合结束时也不列它", async () => {
    const { daemon } = await startTestDaemon();
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "contract-interject-late",
      model: fauxModel([{ kind: "reply", text: "好" }, { kind: "echo_context" }]),
      tools: [],
    });
    await log.next("ready");
    agent.send({ type: "user_input", inputId: "in-1", text: "第一句" });
    expect(await log.next("turn_end")).toEqual({ type: "turn_end", outcome: "completed" });
    agent.send({ type: "interject", inputId: "in-2", text: "[系统通知] 来晚了的催促" });
    expect(await log.next("error")).toMatchObject({ code: "bad_command", inputId: "in-2", fatal: false });
    agent.send({ type: "user_input", inputId: "in-2", text: "[系统通知] 来晚了的催促" });
    const echo = await log.next("message_final");
    expect(await log.next("turn_end")).toEqual({ type: "turn_end", outcome: "completed" });
    const lines = echo.message.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n").split("\n");
    expect(lines.filter((l) => l === "[user] [系统通知] 来晚了的催促")).toHaveLength(1);
  });
});

describe("pi 契约：中止（144 号票的停止）", () => {
  it("说到一半中止：已经流出来的文字留在定稿消息里（stopReason 是 aborted），回合以中止结束；下一轮的模型调用看得到这段说了一半的话", async () => {
    const { daemon } = await startTestDaemon();
    const long = "这是一段很长的回复，说了一半会被停下。".repeat(80);
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "contract-stop",
      model: fauxModel([{ kind: "reply", text: long }, { kind: "echo_context" }], { tokensPerSecond: 40 }),
      tools: [],
    });
    await log.next("ready");
    agent.send({ type: "user_input", inputId: "in-1", text: "写一篇长文" });
    await log.next("stream_delta");
    await sleep(500);
    agent.send({ type: "abort" });

    const final = await log.next("message_final");
    expect(await log.next("turn_end")).toEqual({ type: "turn_end", outcome: "aborted" });
    expect(final.message.stopReason).toBe("aborted");
    const said = final.message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    const streamed = log.ofType("stream_delta").map((d) => d.delta).join("");
    // 留下来的就是流出来的那些：是整段的开头，没说完
    expect(said.length).toBeGreaterThan(0);
    expect(said.length).toBeLessThan(long.length);
    expect(long.startsWith(said)).toBe(true);
    expect(streamed.startsWith(said) || said.startsWith(streamed)).toBe(true);

    // 下一轮（停止后交出的排队消息）：模型看得到上一轮说了一半的话
    agent.send({ type: "user_input", inputId: "in-2", text: "算了，换个话题" });
    let echo = await log.next("message_final");
    while (echo.message.stopReason !== "done") echo = await log.next("message_final");
    const seen = echo.message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    expect(seen).toContain(`[assistant] ${said.slice(0, 20)}`);
    expect(seen).toContain("[user] 算了，换个话题");
  });
});
