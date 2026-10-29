// pi 契约测试：被杀之后从会话文件接着会话（23 号票，规格第 17 节）。守护进程被杀时 Job 对象把 agent 子进程一起结束，
// 会话文件（pi 的 JSONL，追加写）停在被杀的那一刻：
// - 末尾可能有写到一半的一行：接着会话时去掉它，只保留完整的条目（输出到一半的回复不留碎片）；
// - 最后一个回合里模型要调用的工具还没有结果（正在执行、正在等审批，或者同一批里先做完、结果还没写进会话）：接着会话时
//   补上工具结果，守护进程按调用给了的（等审批的、做完了的、说不清做没做完的，连同出错与否）用它的，没给的用默认的那句，
//   模型从这里接着往下走；
// - 补过之后再接着会话，不会重复补。
// 这里用到的 pi 行为：助手消息（带工具调用）在执行工具之前就落盘；工具结果在下一条助手消息之前落盘；会话文件按行解析；
// SessionManager.appendMessage 追加的工具结果进模型的上下文。
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { INTERRUPTED_TOOL_RESULT, type HostToolSpec } from "../../src/runtime/index.ts";
import { fauxModel, spawnTestAgent, startTestDaemon } from "../helpers/daemon.ts";

const SLOW_TOOL: HostToolSpec = {
  name: "slow_job",
  description: "做一件要很久的事（测试用：守护进程一直不回结果）",
  parameters: { type: "object", properties: { what: { type: "string" } }, required: ["what"], additionalProperties: false },
};

/** 会话文件的每一行（都要能解析） */
function linesOf(file: string): string[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l !== "");
}

const textOf = (message: { message: { parts: Array<{ type: string; text?: string }> } }) => message.message.parts.map((p) => p.text ?? "").join("");

describe("pi 契约：被杀之后从会话文件接着会话", () => {
  it("会话文件末尾有写到一半的一行：接着会话时去掉它，只留完整的条目；模型看到上一个完整的回合，看不到碎片", async () => {
    const { daemon } = await startTestDaemon();
    const first = spawnTestAgent(daemon, { agentId: "contract-half-line", model: fauxModel([{ kind: "reply", text: "暗号是青蛙" }]), tools: [], continueSession: true });
    const ready = await first.log.next("ready");
    first.agent.send({ type: "user_input", inputId: "in-1", text: "暗号是什么？" });
    await first.log.next("turn_end");
    first.agent.kill();
    await first.agent.exited;
    // 被杀时正写着下一条：半行，没有换行
    const file = ready.sessionFile;
    fs.appendFileSync(file, '{"type":"message","id":"half0001","parentId":null,"message":{"role":"assistant","content":[{"type":"text","text":"说到一半的回');

    const second = spawnTestAgent(daemon, { agentId: "contract-half-line", model: fauxModel([{ kind: "echo_context" }]), tools: [], continueSession: true });
    expect((await second.log.next("ready")).sessionFile).toBe(file);
    // 半行没了，剩下的每一行都是完整的条目
    expect(fs.readFileSync(file, "utf8")).not.toContain("说到一半");
    for (const line of linesOf(file)) expect(() => JSON.parse(line)).not.toThrow();
    second.agent.send({ type: "user_input", inputId: "in-2", text: "刚才说到哪了？" });
    const seen = textOf(await second.log.next("message_final"));
    expect(seen).toContain("[assistant] 暗号是青蛙");
    expect(seen).not.toContain("说到一半");
    expect((await second.log.next("turn_end")).outcome).toBe("completed");
    // 新的这一轮接在后面，文件仍然每行完整
    for (const line of linesOf(file)) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("最后一个回合的工具调用没有结果（被杀时正在执行）：接着会话时补上被中断的结果——守护进程给了说法的用它的，没给的用默认的；模型接着往下走；再接着会话不重复补", async () => {
    const { daemon } = await startTestDaemon();
    const first = spawnTestAgent(daemon, {
      agentId: "contract-orphan",
      model: fauxModel([
        {
          kind: "reply",
          text: "我去办两件事",
          toolCalls: [
            { name: "slow_job", arguments: { what: "发邮件" } },
            { name: "slow_job", arguments: { what: "查天气" } },
          ],
        },
      ]),
      tools: [],
      hostTools: [SLOW_TOOL],
      continueSession: true,
    });
    const ready = await first.log.next("ready");
    first.agent.send({ type: "user_input", inputId: "in-1", text: "去办事" });
    const final = await first.log.next("message_final");
    const [sendCall, weatherCall] = final.message.parts.filter((p) => p.type === "tool_call").map((p) => (p.type === "tool_call" ? p.toolCallId : ""));
    // 第一件正在做（守护进程不回结果），这时子进程被杀
    await first.log.next("host_tool_call");
    first.agent.kill();
    await first.agent.exited;
    const file = ready.sessionFile;
    // 带工具调用的助手消息已经落盘，工具结果还没有
    expect(fs.readFileSync(file, "utf8")).toContain(sendCall!);
    expect(linesOf(file).filter((l) => l.includes('"toolResult"'))).toEqual([]);

    // 守护进程给第一件备好了结果（比如它其实已经做完了，只是结果还没写进会话：不算出错），第二件没给，用默认的那句
    const done = "这次调用已经执行完了（发邮件），不要重做。";
    const second = spawnTestAgent(daemon, {
      agentId: "contract-orphan",
      model: fauxModel([{ kind: "echo_context" }]),
      tools: [],
      hostTools: [SLOW_TOOL],
      continueSession: true,
      interruptedToolResults: { [sendCall!]: { text: done, isError: false } },
    });
    await second.log.next("ready");
    // 补上的两条工具结果已经落盘（按工具调用的顺序），出错与否照给的
    const results = linesOf(file)
      .map((l) => JSON.parse(l) as { type: string; message?: { role: string; toolCallId?: string; isError?: boolean; content?: Array<{ text: string }> } })
      .filter((e) => e.message?.role === "toolResult");
    expect(results.map((e) => [e.message!.toolCallId, e.message!.isError, e.message!.content![0]!.text])).toEqual([
      [sendCall, false, done],
      [weatherCall, true, INTERRUPTED_TOOL_RESULT],
    ]);
    second.agent.send({ type: "user_input", inputId: "in-2", text: "办得怎么样？" });
    const seen = textOf(await second.log.next("message_final"));
    expect(seen).toContain("[assistant] 我去办两件事");
    expect(seen).toContain(`[toolResult] slow_job: ${done}`);
    expect(seen).toContain(`[toolResult] slow_job: ${INTERRUPTED_TOOL_RESULT}`);
    expect(seen).toContain("[user] 办得怎么样？");
    expect((await second.log.next("turn_end")).outcome).toBe("completed");
    second.agent.send({ type: "exit" });
    await second.agent.exited;

    // 再接着会话：已经补过了，不重复补
    const third = spawnTestAgent(daemon, {
      agentId: "contract-orphan",
      model: fauxModel([{ kind: "reply", text: "好" }]),
      tools: [],
      hostTools: [SLOW_TOOL],
      continueSession: true,
      interruptedToolResults: { [sendCall!]: { text: done, isError: false } },
    });
    await third.log.next("ready");
    expect(linesOf(file).filter((l) => l.includes('"toolResult"'))).toHaveLength(2);
  });
});
