// pi 契约测试：守卫转发与插话。这两条是 ADR-0004 选 SDK + 自定义 IPC 的实测依据：
// - 工具调用能停在 pi 的 tool_call 钩子里，等守护进程异步送回判定（规格要求最长能等 5 分钟，这里用 2 秒模拟），
//   等待期间工具不执行，按判定执行或不执行；
// - 回合进行中送的插话（pi 的 steer），在当前这一步做完之后、下一次模型调用之前进入上下文。
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
    const cwd = makeTempDir("ergou-cwd-");
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
    const cwd = makeTempDir("ergou-cwd-");
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

describe("pi 契约：守卫转发（bash 和守护进程代为执行的工具）", () => {
  it("bash 也停在钩子里：判定不放行，命令真的没跑", async () => {
    const { daemon } = await startTestDaemon();
    const cwd = makeTempDir("ergou-cwd-");
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
    const cwd = makeTempDir("ergou-cwd-");
    const interjection = "插话：顺便把语气改正式一点";
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

    // 第二次模型调用看到的上下文：原输入 → 工具结果 → 插话
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
    agent.send({ type: "interject", inputId: "in-2", text: "来晚了的插话" });
    expect(await log.next("error")).toMatchObject({ code: "bad_command", inputId: "in-2", fatal: false });
    agent.send({ type: "user_input", inputId: "in-2", text: "来晚了的插话" });
    const echo = await log.next("message_final");
    expect(await log.next("turn_end")).toEqual({ type: "turn_end", outcome: "completed" });
    const lines = echo.message.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n").split("\n");
    expect(lines.filter((l) => l === "[user] 来晚了的插话")).toHaveLength(1);
  });
});
