// pi 契约测试：重注入块（规格第 8 节，13 号票）。每次唤起和每次压缩之后，运行时把一块固定内容
// "计划摘要 + 当前阶段 + 授权 + 边界"作为上下文消息注入会话，不改系统提示：
// - 装配参数里给了 contextBlock：每条输入之前（被唤起：刚拉起，或者闲着时来了新输入），最新的一块作为一条上下文消息
//   进会话（模型看到的是用户角色的一条消息）；插话不算唤起；
// - 守护进程随时用 context_block 换成最新的一块；压缩之后（pi 的 session_compact）子进程把最新的一块再注入一次。
// 压缩用 compact 命令手动触发（pi 的 session.compact，模型先被调用一次写摘要；守护进程现在不发它）。
import { describe, expect, it } from "vitest";
import { fauxModel, spawnTestAgent, startTestDaemon } from "../helpers/daemon.ts";

const SYSTEM_PROMPT = "你是测试用的维护者。";

function linesOf(final: { message: { parts: Array<{ type: string; text?: string }> } }): string[] {
  return final.message.parts
    .map((p) => (p.type === "text" ? (p.text ?? "") : ""))
    .join("\n")
    .split("\n");
}

describe("pi 契约：重注入块", () => {
  it("拉起时给的块在第一条输入之前进上下文（作为一条上下文消息），系统提示不变；闲着时来了新输入，注入换过的最新一块", async () => {
    const { daemon } = await startTestDaemon();
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "contract-context-wake",
      model: fauxModel([{ kind: "echo_context" }, { kind: "echo_context" }]),
      tools: [],
      systemPrompt: SYSTEM_PROMPT,
      contextBlock: "【运行时注入】计划摘要 v1",
    });
    await log.next("ready");
    agent.send({ type: "user_input", inputId: "in-1", text: "开始干活" });
    const first = linesOf(await log.next("message_final"));
    await log.next("turn_end");
    expect(first.filter((l) => l.startsWith("[system]"))).toEqual([`[system] ${SYSTEM_PROMPT}`]);
    const block = first.indexOf("[user] 【运行时注入】计划摘要 v1");
    expect(block).toBeGreaterThanOrEqual(0);
    expect(first.indexOf("[user] 开始干活")).toBeGreaterThan(block);

    // 同一个子进程闲着时来了第二条输入（也是唤起）：先注入守护进程换过的最新一块
    agent.send({ type: "context_block", text: "【运行时注入】计划摘要 v2" });
    agent.send({ type: "user_input", inputId: "in-2", text: "接着干" });
    const second = linesOf(await log.next("message_final"));
    expect(second.filter((l) => l.startsWith("[user] 【运行时注入】"))).toEqual(["[user] 【运行时注入】计划摘要 v1", "[user] 【运行时注入】计划摘要 v2"]);
    const latest = second.indexOf("[user] 【运行时注入】计划摘要 v2");
    expect(latest).toBeGreaterThan(second.indexOf("[user] 开始干活"));
    expect(second.indexOf("[user] 接着干")).toBeGreaterThan(latest);
  });

  it("压缩之后再注入一次（守护进程最近给的那一块），系统提示仍不变", async () => {
    const { daemon } = await startTestDaemon();
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "contract-context-compact",
      model: fauxModel([
        { kind: "reply", text: "收到了一大段" },
        { kind: "reply", text: "好" },
        // 压缩时写摘要的那次模型调用
        { kind: "reply", text: "摘要：用户发过一大段材料" },
        { kind: "echo_context" },
      ]),
      tools: [],
      systemPrompt: SYSTEM_PROMPT,
      contextBlock: "【运行时注入】第 1/2 阶段",
    });
    await log.next("ready");
    // 第一轮很长（约 2.5 万 token），压缩时被写进摘要；第二轮很短，留着
    agent.send({ type: "user_input", inputId: "in-1", text: `材料：${"一段很长的材料。".repeat(12_500)}` });
    await log.next("turn_end");
    agent.send({ type: "user_input", inputId: "in-2", text: "第二句" });
    await log.next("turn_end");

    agent.send({ type: "context_block", text: "【运行时注入】第 2/2 阶段" });
    agent.send({ type: "compact" });
    agent.send({ type: "user_input", inputId: "in-3", text: "压缩之后" });
    const seen = linesOf(await log.next("message_final"));
    expect(await log.next("turn_end")).toMatchObject({ outcome: "completed" });

    expect(seen.filter((l) => l.startsWith("[system]"))).toEqual([`[system] ${SYSTEM_PROMPT}`]);
    expect(seen.some((l) => l.includes("摘要：用户发过一大段材料"))).toBe(true);
    // 第一轮前注入的那一块随第一轮一起压进了摘要，留下的是第二轮前注入的那块；压缩之后注入最新的一块（排在留下的消息之后），
    // 新输入之前再注入一次
    expect(seen.filter((l) => l.includes("第 1/2 阶段"))).toEqual(["[user] 【运行时注入】第 1/2 阶段"]);
    expect(seen.indexOf("[user] 【运行时注入】第 1/2 阶段")).toBeLessThan(seen.indexOf("[user] 第二句"));
    const blocks = seen.flatMap((l, i) => (l === "[user] 【运行时注入】第 2/2 阶段" ? [i] : []));
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toBeGreaterThan(seen.indexOf("[user] 第二句"));
    expect(seen.indexOf("[user] 压缩之后")).toBeGreaterThan(blocks[1]!);
  });
});
