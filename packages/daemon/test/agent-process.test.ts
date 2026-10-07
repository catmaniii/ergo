// 守护进程拉起接 faux provider 的 agent 子进程，按 agent 宿主协议走完一轮（集成测试，用临时数据目录）。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fauxModel, spawnTestAgent, startTestDaemon } from "./helpers/daemon.ts";
import { makeTempDir } from "./helpers/temp-dir.ts";

// 带一个 U+2028：它在 JSON 字符串里是合法字符，按行分帧时不能被当成换行
const REPLY = "你好，我是二狗。这一段回复会被切成好几段流式增量 然后再拼成一条定稿消息。";

describe("agent 子进程", () => {
  it("就绪后送用户输入，收到流式增量、消息定稿和回合结束；会话写在数据目录的会话区", async () => {
    const { daemon, dataDir } = await startTestDaemon();
    // （秘书由守护进程自己拉起，这里另起一个 agent）
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "demo-agent",
      model: fauxModel([{ kind: "reply", text: REPLY }]),
      tools: [],
    });

    const ready = await log.next("ready");
    expect(ready.pid).toBe(agent.pid);
    expect(ready.sessionFile.startsWith(path.join(dataDir, "sessions", "demo-agent") + path.sep)).toBe(true);

    agent.send({ type: "user_input", inputId: "in-1", text: "介绍一下你自己" });

    const firstDelta = await log.next("stream_delta");
    const final = await log.next("message_final");
    const turnEnd = await log.next("turn_end");

    const deltas = log.ofType("stream_delta").filter((d) => d.messageId === final.messageId);
    expect(deltas[0]).toBe(firstDelta);
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.map((d) => d.delta).join("")).toBe(REPLY);
    expect(final.message.parts).toEqual([{ type: "text", text: REPLY }]);
    expect(final.message.stopReason).toBe("done");
    expect(turnEnd.outcome).toBe("completed");

    const usage = log.ofType("usage");
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ messageId: final.messageId, provider: "faux" });
    expect(usage[0]!.output).toBeGreaterThan(0);

    const sessionText = fs.readFileSync(ready.sessionFile, "utf8");
    expect(sessionText).toContain("介绍一下你自己");
    expect(sessionText).toContain("我是二狗");
  });

  it("中止能停住进行中的回合", async () => {
    const { daemon } = await startTestDaemon();
    const longText = "这是一段很长的回复。".repeat(200);
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "maintainer-a",
      model: fauxModel([{ kind: "reply", text: longText }], { tokensPerSecond: 20 }),
      tools: [],
    });
    await log.next("ready");
    agent.send({ type: "user_input", inputId: "in-1", text: "写一篇长文" });
    await log.next("stream_delta");

    agent.send({ type: "abort" });

    const turnEnd = await log.next("turn_end");
    expect(turnEnd.outcome).toBe("aborted");
    expect(log.ofType("message_final").map((f) => f.message.stopReason)).toEqual(["aborted"]);
    const streamed = log.ofType("stream_delta").map((d) => d.delta).join("");
    expect(streamed.length).toBeLessThan(longText.length);
  });

  it("中止之后还能接着送下一条输入", async () => {
    const { daemon } = await startTestDaemon();
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "maintainer-b",
      model: fauxModel(
        [
          { kind: "reply", text: "很长很长的回复。".repeat(200) },
          { kind: "reply", text: "好的，换个话题。" },
        ],
        { tokensPerSecond: 20 },
      ),
      tools: [],
    });
    await log.next("ready");
    agent.send({ type: "user_input", inputId: "in-1", text: "写一篇长文" });
    await log.next("stream_delta");
    agent.send({ type: "abort" });
    expect((await log.next("turn_end")).outcome).toBe("aborted");

    agent.send({ type: "user_input", inputId: "in-2", text: "算了，换个话题" });
    let final = await log.next("message_final");
    while (final.message.stopReason !== "done") final = await log.next("message_final");
    expect(final.message.parts).toEqual([{ type: "text", text: "好的，换个话题。" }]);
    expect((await log.next("turn_end")).outcome).toBe("completed");
  });

  it("退出让子进程正常结束", async () => {
    const { daemon } = await startTestDaemon();
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "demo-agent",
      model: fauxModel([]),
      tools: [],
    });
    await log.next("ready");
    agent.send({ type: "exit" });
    await expect(agent.exited).resolves.toEqual({ code: 0, signal: null, reason: "killed" });
  });

  it("子进程按装配参数里的间隔发心跳", async () => {
    const { daemon } = await startTestDaemon();
    const { log } = spawnTestAgent(daemon, {
      agentId: "demo-agent",
      model: fauxModel([]),
      tools: [],
      heartbeatIntervalMs: 50,
    });
    await log.next("ready");
    const beat = await log.next("heartbeat", 5_000);
    expect(beat.at).toBeGreaterThan(0);
  });

  it("还没实现的命令回一条 unsupported 错误，子进程照常工作", async () => {
    const { daemon } = await startTestDaemon();
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "maintainer-c",
      model: fauxModel([{ kind: "reply", text: "收到" }]),
      tools: [],
    });
    await log.next("ready");
    agent.send({ type: "work_order", workOrderId: "wo-1", text: "整理一下项目档案" });
    const error = await log.next("error");
    expect(error).toMatchObject({ code: "unsupported", fatal: false });
    expect(error.message).toContain("work_order");

    agent.send({ type: "user_input", inputId: "in-1", text: "在吗" });
    expect((await log.next("turn_end")).outcome).toBe("completed");
  });

  it("工具调用的开始和结束都报给守护进程", async () => {
    const { daemon } = await startTestDaemon();
    const cwd = makeTempDir();
    fs.writeFileSync(path.join(cwd, "note.txt"), "便签内容：周五交周报");
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "maintainer-d",
      cwd,
      model: fauxModel([
        { kind: "reply", toolCalls: [{ name: "read", arguments: { path: "note.txt" } }] },
        { kind: "reply", text: "便签说周五交周报。" },
      ]),
      tools: ["read"],
    });
    await log.next("ready");
    agent.send({ type: "user_input", inputId: "in-1", text: "看看便签" });

    const start = await log.next("tool_call_start");
    const end = await log.next("tool_call_end");
    expect(start).toMatchObject({ toolName: "read", args: { path: "note.txt" } });
    expect(end).toMatchObject({ toolCallId: start.toolCallId, toolName: "read", isError: false });
    expect(end.resultText).toContain("周五交周报");
    expect((await log.next("turn_end")).outcome).toBe("completed");
  });
});
