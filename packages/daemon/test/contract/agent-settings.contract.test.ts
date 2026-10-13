// pi 契约测试：会话里的 ⚙ 用到的那几样（114 号票，宿主协议 17）。
// - ready 报回会话的上下文窗口和 pi 的压缩设置（用量超过窗口减 16384 自动压缩，最近约 2 万 token 原样保留）；
// - 清空当前对话（装配参数 freshSession）：会话目录里还没有这个名字的会话，就马上用它新开一个（不带以前的聊天）；有了就照常接着
//   最近的（就是它），所以守护进程每次拉起都带上最近一次清空的名字也不会再清一次；
// - 手动压缩（compact 命令）：压好了报一条 compacted（outcome done，带压缩前的估算），压缩那次的用量照常报（purpose: compaction）；
//   会话还短（最近约 2 万 token 原样保留、前面没有）的报 nothing，不算没压成。
import { describe, expect, it } from "vitest";
import { fauxModel, spawnTestAgent, startTestDaemon } from "../helpers/daemon.ts";

/** 一段约 2.5 万 token 的材料 */
const long = (n: number) => `材料${n}：${"一段很长的材料。".repeat(12_500)}`;

const textOf = (final: { message: { parts: Array<{ type: string; text?: string }> } }) =>
  final.message.parts.map((p) => (p.type === "text" ? (p.text ?? "") : "")).join("\n");

describe("pi 契约：⚙ 用到的上下文、清空、压缩", () => {
  it("ready 报回上下文窗口和 pi 的压缩设置", async () => {
    const { daemon } = await startTestDaemon();
    const { log } = spawnTestAgent(daemon, { agentId: "contract-context-info", model: fauxModel([]), tools: [] });
    const ready = await log.next("ready");
    expect(ready.context.window).toBeGreaterThan(0);
    expect(ready.context).toMatchObject({ reserveTokens: 16_384, keepRecentTokens: 20_000 });
    // agent 管家按记账的模型键记下（faux 是 faux）：没在跑的 agent 的面板用它
    expect(daemon.agents.contextOf("faux")).toEqual(ready.context);
  });

  it("freshSession：还没有这个名字的会话就新开（模型看不到以前的聊天）；有了就照常接着它", async () => {
    const { daemon } = await startTestDaemon();
    const first = spawnTestAgent(daemon, { agentId: "contract-fresh", model: fauxModel([{ kind: "reply", text: "记住了" }]), tools: [], continueSession: true });
    await first.log.next("ready");
    first.agent.send({ type: "user_input", inputId: "in-1", text: "暗号是蓝鲸" });
    await first.log.next("turn_end");
    first.agent.kill();
    await first.agent.exited;

    const second = spawnTestAgent(daemon, {
      agentId: "contract-fresh",
      model: fauxModel([{ kind: "echo_context" }]),
      tools: [],
      continueSession: true,
      freshSession: "cleared-m-1",
    });
    expect(await second.log.next("ready")).toMatchObject({ session: "cleared-m-1" });
    second.agent.send({ type: "user_input", inputId: "in-2", text: "暗号是什么" });
    const seen = textOf(await second.log.next("message_final"));
    await second.log.next("turn_end");
    expect(seen).toContain("[user] 暗号是什么");
    expect(seen).not.toContain("蓝鲸");
    second.agent.kill();
    await second.agent.exited;

    // 再带同一个名字拉起：已经有了，照常接着最近的（就是清空之后的这一段），不再清一次
    const third = spawnTestAgent(daemon, {
      agentId: "contract-fresh",
      model: fauxModel([{ kind: "echo_context" }]),
      tools: [],
      continueSession: true,
      freshSession: "cleared-m-1",
    });
    expect(await third.log.next("ready")).toMatchObject({ session: "cleared-m-1" });
    third.agent.send({ type: "user_input", inputId: "in-3", text: "再问一次" });
    const again = textOf(await third.log.next("message_final"));
    expect(again).toContain("[user] 暗号是什么");
    expect(again).toContain("[user] 再问一次");
    expect(again).not.toContain("蓝鲸");
  });

  it("手动压缩：压好了报 compacted（done，带压缩前的估算），压缩那次的用量照常报；会话还短的报 nothing", async () => {
    const { daemon } = await startTestDaemon();
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "contract-compact-now",
      model: fauxModel([{ kind: "reply", text: "好" }, { kind: "reply", text: "好" }, { kind: "reply", text: "摘要：用户发过一大段材料" }]),
      tools: [],
    });
    await log.next("ready");
    agent.send({ type: "user_input", inputId: "in-0", text: "短短一句" });
    await log.next("turn_end");
    agent.send({ type: "compact" });
    expect(await log.next("compacted")).toEqual({ type: "compacted", reason: "manual", outcome: "nothing" });

    // 第一轮很长（约 2.5 万 token），压缩时写进摘要；第二轮很短，留着
    agent.send({ type: "user_input", inputId: "in-1", text: long(1) });
    await log.next("turn_end");
    agent.send({ type: "compact" });
    const done = await log.next("compacted");
    expect(done).toMatchObject({ type: "compacted", reason: "manual", outcome: "done" });
    expect(done.tokensBefore).toBeGreaterThan(20_000);
    expect(log.ofType("usage").at(-1)).toMatchObject({ purpose: "compaction", messageId: "compaction-1" });
  });
});
