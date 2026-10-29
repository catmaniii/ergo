// pi 契约测试：会话树上挪（150 号票：会话回退；151 号票：切换分支）。用的是 pi 会话文件（JSONL）和会话树的这些行为：
// - 每条输入在会话文件里是 [上下文块…][输入标记][用户消息]：回到"这条输入之前"，叶子落在它第一条条目的父条目上
//   （前面那条是自定义消息——换模型新开会话开头的交接摘要——也落得对，navigateTree 在这种情况下落不对）；
// - 写分支摘要：被放弃的那段（原来的叶子到共同祖先）交给模型、要求接在 pi 的提示后面；摘要条目接在新叶子下面，进新分支的上下文；
//   那次调用报一条用量（purpose: branch_summary）；
// - 叶子落盘：挪完追加一条记号（不进模型的上下文），子进程退出、重开文件时叶子还在新分支上（pi 重开时取文件里的最后一条）；
// - 不写摘要的挪（切换分支）一样落盘，原来那条分支整条回到上下文里；
// - 找不到这条输入时报原因，会话不动；
// - 152 号票：回到某次工具调用的结果之后（afterCall：最后一条工具结果）、回到它所在的那条回复之前（beforeCall：那条 assistant 消息的父条目）。
import fs from "node:fs";
import { BRANCH_SUMMARY_INSTRUCTIONS } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { CONTEXT_BLOCK_TYPE, type FauxStep, SESSION_BRANCH_ENTRY, SESSION_INPUT_TAG } from "../../src/runtime/index.ts";
import { fauxModel, spawnTestAgent, startTestDaemon } from "../helpers/daemon.ts";
import type { Daemon } from "../../src/daemon.ts";
import type { SpawnAgentRequest } from "../../src/agent-manager/agent-manager.ts";

const AGENT = "contract-navigate";

type Entry = { id: string; parentId: string | null; type: string; customType?: string; data?: unknown; summary?: string; message?: { role: string; content: unknown } };

/** 会话文件里的条目（会话头之后的） */
function entriesOf(file: string): Entry[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Entry)
    .filter((e) => e.type !== "session");
}

const textOf = (e: Entry) => JSON.stringify(e.message?.content ?? "");

/** 起一个接 faux 的 agent，按顺序送几条输入，每条等它说完 */
async function chat(daemon: Daemon, script: FauxStep[], inputs: Array<[string, string]>, extra: Partial<SpawnAgentRequest> = {}) {
  const run = spawnTestAgent(daemon, { agentId: AGENT, model: fauxModel(script), tools: [], continueSession: true, ...extra });
  const ready = await run.log.next("ready");
  for (const [inputId, text] of inputs) {
    run.agent.send({ type: "user_input", inputId, text });
    await run.log.next("turn_end");
  }
  return { ...run, file: ready.sessionFile };
}

/** 让 agent 退出、等它退干净 */
async function exit(run: { agent: { send(c: { type: "exit" }): void; exited: Promise<unknown> } }) {
  run.agent.send({ type: "exit" });
  await run.agent.exited;
}

/** 接着这个会话再起一个，问一句，拿到它看到的上下文 */
async function contextAfterReopen(daemon: Daemon, file: string, extra: Partial<SpawnAgentRequest> = {}): Promise<string> {
  const run = spawnTestAgent(daemon, { agentId: AGENT, model: fauxModel([{ kind: "echo_context" }]), tools: [], continueSession: true, ...extra });
  expect((await run.log.next("ready")).sessionFile).toBe(file);
  run.agent.send({ type: "user_input", inputId: "in-after", text: "接着说" });
  const seen = (await run.log.next("message_final")).message.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n");
  await exit(run);
  return seen;
}

describe("pi 契约：会话树上挪", () => {
  it("回到某条输入之前、写分支摘要：叶子落在上一轮末尾；摘要按要求写、进新分支的上下文；退出重开后叶子还在新分支上", async () => {
    const { daemon } = await startTestDaemon();
    const run = await chat(
      daemon,
      [
        { kind: "reply", text: "一号回复" },
        { kind: "reply", text: "二号回复" },
        { kind: "reply", text: "三号回复" },
        // 写分支摘要的那次：回出它看到的东西（被放弃的那段和要求）
        { kind: "reply_with_context", text: "摘要：{{context}}" },
      ],
      [
        ["in-1", "第一句：查天气"],
        ["in-2", "第二句：给老王发邮件"],
        ["in-3", "第三句：订会议室"],
      ],
    );
    const before = entriesOf(run.file);
    const reply1 = before.find((e) => e.message?.role === "assistant" && textOf(e).includes("一号回复"))!;
    run.agent.send({ type: "navigate_session", requestId: "r-1", target: { beforeInput: "in-2" }, summary: { instructions: BRANCH_SUMMARY_INSTRUCTIONS }, marker: { branchId: "b1", change: "rollback" } });
    const navigated = await run.log.next("session_navigated");
    expect(navigated).toMatchObject({ requestId: "r-1", ok: true, from: before.at(-1)!.id, at: reply1.id });
    if (!navigated.ok) throw new Error(navigated.error);
    // 交给模型的是被放弃的那段（第二、三句），不含共同祖先之前的第一句；要求接在后面；报回的摘要不带 pi 加的开头
    expect(navigated.summary).toContain("第二句：给老王发邮件");
    expect(navigated.summary).toContain("第三句：订会议室");
    expect(navigated.summary).not.toContain("第一句");
    expect(navigated.summary).toContain(BRANCH_SUMMARY_INSTRUCTIONS);
    expect(navigated.summary!.startsWith("摘要：")).toBe(true);
    expect(run.log.ofType("usage").some((u) => u.purpose === "branch_summary" && u.messageId === "branch-summary-r-1")).toBe(true);
    await exit(run);

    // 会话文件：原来的条目都在（分支留在树上）；新分支 = 摘要 → 标签 → 记号，接在第一轮的回复下面；最后一条是记号
    const after = entriesOf(run.file);
    expect(after.slice(0, before.length)).toEqual(before);
    const summary = after.find((e) => e.type === "branch_summary")!;
    expect(summary.parentId).toBe(reply1.id);
    expect(after.at(-1)).toMatchObject({ type: "custom", customType: SESSION_BRANCH_ENTRY, data: { branchId: "b1", change: "rollback" } });

    // 重开：上下文从第一句接着，带着分支摘要（摘要里转述着被放弃的那段），第二、三句不再是上下文里的消息，记号不进上下文
    const seen = await contextAfterReopen(daemon, run.file);
    expect(seen).toContain("[user] 第一句：查天气");
    expect(seen).toContain("[assistant] 一号回复");
    expect(seen).toMatch(/\[user\] The following is a summary of a branch[\s\S]*摘要：/);
    expect(seen).not.toContain("[user] 第二句");
    expect(seen).not.toContain("[assistant] 二号回复");
    expect(seen).not.toContain("[assistant] 三号回复");
    expect(seen).not.toContain(SESSION_BRANCH_ENTRY);
    expect(seen).toContain("[user] 接着说");
  });

  it("这条输入前面有上下文块：一起退掉（新分支上不留第二句那次注入的块）", async () => {
    const { daemon } = await startTestDaemon();
    const blocks = { contributions: { contextBlocks: [{ id: "brief", text: "【简报】今天周五" }], hooks: [] } };
    const run = await chat(
      daemon,
      [
        { kind: "reply", text: "一号回复" },
        { kind: "reply", text: "二号回复" },
        { kind: "reply", text: "这一段做了二号" },
      ],
      [
        ["in-1", "第一句"],
        ["in-2", "第二句"],
      ],
      blocks,
    );
    const before = entriesOf(run.file);
    const tag2 = before.findIndex((e) => e.customType === SESSION_INPUT_TAG && (e.data as { inputId: string }).inputId === "in-2");
    expect(before[tag2 - 1]).toMatchObject({ type: "custom_message", customType: CONTEXT_BLOCK_TYPE });
    run.agent.send({ type: "navigate_session", requestId: "r-2", target: { beforeInput: "in-2" }, summary: { instructions: "写摘要" }, marker: { branchId: "b1", change: "rollback" } });
    const navigated = await run.log.next("session_navigated");
    expect(navigated).toMatchObject({ ok: true, at: before[tag2 - 1]!.parentId, summary: "这一段做了二号" });
    await exit(run);
    // 重开后问一句：第一句那次的块、这一句的块，两块；第二句那次的不在
    const seen = await contextAfterReopen(daemon, run.file, blocks);
    expect(seen.split("【简报】今天周五").length - 1).toBe(2);
    expect(seen).not.toContain("第二句");
  });

  it("前面那条是自定义消息（换模型新开会话开头的交接摘要）、这条输入没有上下文块：叶子落在那条自定义消息上，它留在新分支的上下文里", async () => {
    const { daemon } = await startTestDaemon();
    const first = await chat(daemon, [{ kind: "reply", text: "一号回复" }], [["in-1", "第一句"]]);
    await exit(first);
    // 手工接上一条自定义消息（和交接摘要同一种条目）
    const last = entriesOf(first.file).at(-1)!;
    const handoff = { type: "custom_message", id: "cm000001", parentId: last.id, timestamp: new Date().toISOString(), customType: "ergo-handoff", content: "交接：之前聊了天气", display: false };
    fs.appendFileSync(first.file, `${JSON.stringify(handoff)}\n`);
    const run = await chat(
      daemon,
      [
        { kind: "reply", text: "二号回复" },
        { kind: "reply", text: "摘要二号" },
      ],
      [["in-2", "第二句"]],
    );
    run.agent.send({ type: "navigate_session", requestId: "r-3", target: { beforeInput: "in-2" }, summary: { instructions: "写摘要" }, marker: { branchId: "b1", change: "rollback" } });
    expect(await run.log.next("session_navigated")).toMatchObject({ ok: true, at: "cm000001" });
    await exit(run);
    const seen = await contextAfterReopen(daemon, run.file);
    expect(seen).toContain("交接：之前聊了天气");
    expect(seen).not.toContain("第二句");
  });

  it("不写摘要地挪到原来那条分支的末端（151 号票的切换）：一样落盘，重开后原来那条整条回到上下文里", async () => {
    const { daemon } = await startTestDaemon();
    const run = await chat(
      daemon,
      [
        { kind: "reply", text: "一号回复" },
        { kind: "reply", text: "二号回复" },
        { kind: "reply", text: "分支摘要" },
      ],
      [
        ["in-1", "第一句"],
        ["in-2", "第二句"],
      ],
    );
    run.agent.send({ type: "navigate_session", requestId: "r-4", target: { beforeInput: "in-2" }, summary: { instructions: "写摘要" }, marker: { branchId: "b1", change: "rollback" } });
    const back = await run.log.next("session_navigated");
    if (!back.ok) throw new Error(back.error);
    run.agent.send({ type: "navigate_session", requestId: "r-5", target: { entry: back.from }, marker: { branchId: "b0", change: "switch" } });
    const switched = await run.log.next("session_navigated");
    expect(switched).toMatchObject({ ok: true, at: back.from });
    expect(switched).not.toHaveProperty("summary");
    await exit(run);
    expect(entriesOf(run.file).at(-1)).toMatchObject({ customType: SESSION_BRANCH_ENTRY, parentId: back.from, data: { branchId: "b0", change: "switch" } });
    const seen = await contextAfterReopen(daemon, run.file);
    expect(seen).toContain("二号回复");
    expect(seen).not.toContain("分支摘要");
  });

  it("回到某次工具调用的结果之后（afterCall）、回到它所在的那条回复之前（beforeCall，152 号票）：叶子落在最后一条工具结果上、落在那条回复的父条目上", async () => {
    const { daemon } = await startTestDaemon();
    const run = await chat(
      daemon,
      [
        { kind: "reply", text: "一号回复" },
        { kind: "reply", text: "先查一下", toolCalls: [{ name: "lookup", arguments: { q: "x" } }] },
        { kind: "reply", text: "查完了" },
        { kind: "reply", text: "摘要：查完之后说了查完了" },
      ],
      [
        ["in-1", "第一句"],
        ["in-2", "第二句：查一下"],
      ],
    );
    const before = entriesOf(run.file);
    const reply = before.find((e) => e.message?.role === "assistant" && textOf(e).includes("先查一下"))!;
    const callId = (reply.message!.content as Array<{ type: string; id?: string }>).find((c) => c.type === "toolCall")!.id!;
    const result = before[before.indexOf(reply) + 1]!;
    expect(result.message?.role).toBe("toolResult");
    run.agent.send({ type: "navigate_session", requestId: "r-8", target: { afterCall: callId }, summary: { instructions: "写摘要" }, marker: { branchId: "b1", change: "rollback" } });
    const after = await run.log.next("session_navigated");
    expect(after).toMatchObject({ ok: true, at: result.id, summary: "摘要：查完之后说了查完了" });
    if (!after.ok) throw new Error(after.error);
    // 再回到这条回复之前（不写摘要）：叶子落在它的父条目上（第二句）
    run.agent.send({ type: "navigate_session", requestId: "r-9", target: { beforeCall: callId }, marker: { branchId: "b2", change: "rollback" } });
    expect(await run.log.next("session_navigated")).toMatchObject({ ok: true, at: reply.parentId });
    await exit(run);
    const seen = await contextAfterReopen(daemon, run.file);
    expect(seen).toContain("[user] 第二句：查一下");
    expect(seen).not.toContain("先查一下");
    expect(seen).not.toContain("查完了");
    // 找不到这次调用：报原因
    const again = await chat(daemon, [], []);
    again.agent.send({ type: "navigate_session", requestId: "r-10", target: { beforeCall: "call-nope" }, marker: { branchId: "b3", change: "rollback" } });
    expect(await again.log.next("session_navigated")).toMatchObject({ ok: false, error: expect.stringContaining("找不到这次工具调用") });
    await exit(again);
  });

  it("找不到这条输入、已经在那里：报原因，会话文件不动", async () => {
    const { daemon } = await startTestDaemon();
    const run = await chat(daemon, [{ kind: "reply", text: "一号回复" }], [["in-1", "第一句"]]);
    const before = fs.readFileSync(run.file, "utf8");
    run.agent.send({ type: "navigate_session", requestId: "r-6", target: { beforeInput: "in-nope" }, summary: { instructions: "写摘要" }, marker: { branchId: "b1", change: "rollback" } });
    expect(await run.log.next("session_navigated")).toMatchObject({ ok: false, error: expect.stringContaining("找不到这条消息") });
    const leaf = entriesOf(run.file).at(-1)!.id;
    run.agent.send({ type: "navigate_session", requestId: "r-7", target: { entry: leaf }, marker: { branchId: "b1", change: "switch" } });
    expect(await run.log.next("session_navigated")).toMatchObject({ ok: false, error: expect.stringContaining("已经在这里") });
    expect(fs.readFileSync(run.file, "utf8")).toBe(before);
    await exit(run);
  });
});
