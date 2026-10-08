// pi 契约测试：彻底删除改写会话文件（21 号票）。改写在一次性子进程里做（agent-child/rewrite-main.ts，经 agent 管家的
// rewriteSessions 调用），用的是 pi 会话文件（JSONL）的这些形状：
// - 子进程在每条用户输入前记的自定义条目（带 inputId）落进会话文件，紧跟着就是那条用户消息；自定义条目不进模型的上下文；
// - 助手消息里的工具调用（带调用 id 和参数）、工具结果（带调用 id 和工具名）按条落在会话文件里；
// - 压缩条目（摘要、保留的第一条）：保留的第一条之前的条目由摘要代替，摘要作为一条用户消息进模型的上下文；
// - 别的自定义条目（范围审视结果的副本，18 号票）：按类型把数据里的文字换掉，结构不变；
// - 把这些改写掉之后，接着这个会话（continueSession）时模型看到的是删除标记，看不到原文；
// - pi 按修改时间挑"最近的会话"：改写保留原来的修改时间，接着用的还是同一个会话文件。
import fs from "node:fs";
import { PURGED_SUMMARY_TEXT, PURGED_TEXT } from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { type HostToolSpec, SCOPE_REVIEW_ENTRY } from "../../src/runtime/index.ts";
import { fauxModel, spawnTestAgent, startTestDaemon } from "../helpers/daemon.ts";

const tool = (name: string): HostToolSpec => ({
  name,
  description: `${name}（测试用）`,
  parameters: { type: "object", additionalProperties: true },
});
const TOOLS = [tool("search_materials"), tool("propose_quick_action")];
const AGENT = "contract-rewrite";

/** 会话文件里的条目 */
function entriesOf(file: string): Array<{ id?: string; type: string; message?: { role: string; content: unknown } }> {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as { id?: string; type: string; message?: { role: string; content: unknown } });
}

describe("pi 契约：改写会话文件里的原文", () => {
  it("按输入的标签改掉用户消息、按调用 id 改掉工具调用的参数和结果、按工具名改掉检索结果里那一行；覆盖了它们的压缩摘要整段换掉；接着这个会话，模型看不到原文；修改时间不变", async () => {
    const { daemon } = await startTestDaemon();
    const first = spawnTestAgent(daemon, {
      agentId: AGENT,
      model: fauxModel([
        { kind: "reply", toolCalls: [{ name: "search_materials", arguments: { query: "暗号" } }] },
        { kind: "reply", text: "查到了" },
        { kind: "reply", toolCalls: [{ name: "propose_quick_action", arguments: { type: "remember", params: { content: "车牌是沪A12345" } } }] },
        { kind: "reply", text: "记下了" },
        { kind: "reply", text: "好" },
      ]),
      tools: [],
      hostTools: TOOLS,
      continueSession: true,
    });
    const ready = await first.log.next("ready");
    first.agent.send({ type: "user_input", inputId: "in-secret", text: "暗号是青蛙" });
    const search = await first.log.next("host_tool_call");
    first.agent.send({ type: "host_tool_result", requestId: search.requestId, result: { text: "找到 2 条素材：\n- mat-aaa · 用户发言：暗号是青蛙\n- mat-bbb · 用户发言：今天下雨", isError: false } });
    await first.log.next("turn_end");
    first.agent.send({ type: "user_input", inputId: "in-remember", text: "记住：车牌是沪A12345" });
    const propose = await first.log.next("host_tool_call");
    first.agent.send({ type: "host_tool_result", requestId: propose.requestId, result: { text: "已执行：记住：车牌是沪A12345", isError: false } });
    await first.log.next("turn_end");
    first.agent.send({ type: "user_input", inputId: "in-keep", text: "今天天气不错" });
    await first.log.next("turn_end");
    first.agent.send({ type: "exit" });
    await first.agent.exited;

    // 手工接上一条压缩：保留的第一条是"今天天气不错"，它之前的由摘要代替（摘要里有原话）
    const file = ready.sessionFile;
    const entries = entriesOf(file);
    const kept = entries.find((e) => e.type === "message" && e.message?.role === "user" && JSON.stringify(e.message.content).includes("今天天气不错"))!;
    const compaction = { type: "compaction", id: "cmp00001", parentId: entries.at(-1)!.id, timestamp: new Date().toISOString(), summary: "用户说暗号是青蛙，车牌是沪A12345", firstKeptEntryId: kept.id, tokensBefore: 100 };
    fs.appendFileSync(file, `${JSON.stringify(compaction)}\n`);
    // 范围审视结果的副本（18 号票，appendEntry 的自定义条目）：依据里引着用户的原话
    const reviewCopy = { type: "custom", id: "cus00001", parentId: "cmp00001", timestamp: new Date().toISOString(), customType: SCOPE_REVIEW_ENTRY, data: { findings: [{ kind: "scope_change", summary: "按暗号青蛙改了", basis: "用户说暗号是青蛙" }] } };
    fs.appendFileSync(file, `${JSON.stringify(reviewCopy)}\n`);
    expect(fs.readFileSync(file, "utf8")).toContain("青蛙");
    const before = fs.statSync(file).mtimeMs;

    const request = {
      inputIds: ["in-secret", "in-remember"],
      toolCallIds: [propose.toolCallId],
      toolResultLines: [{ toolName: "search_materials", needles: ["mat-aaa"] }],
      marker: PURGED_TEXT,
      summaryMarker: PURGED_SUMMARY_TEXT,
      customTypes: [SCOPE_REVIEW_ENTRY],
    };
    // 两条用户消息、提议的参数（助手消息）和结果、检索结果、范围审视结果的副本（文字全换掉，结构不变）；一段摘要
    expect(await daemon.agents.rewriteSessions(AGENT, request)).toEqual({ files: 1, entries: 6, summaries: 1 });
    const text = fs.readFileSync(file, "utf8");
    expect(text).not.toContain("青蛙");
    expect(text).not.toContain("沪A12345");
    const copy = entriesOf(file).find((e) => e.id === "cus00001") as unknown as { data: unknown };
    expect(copy.data).toEqual({ findings: [{ kind: PURGED_TEXT, summary: PURGED_TEXT, basis: PURGED_TEXT }] });
    // 修改时间不变（文件系统的精度以内）
    expect(Math.abs(fs.statSync(file).mtimeMs - before)).toBeLessThan(1);
    // 再改一次没有变化
    expect(await daemon.agents.rewriteSessions(AGENT, request)).toEqual({ files: 0, entries: 0, summaries: 0 });

    const second = spawnTestAgent(daemon, { agentId: AGENT, model: fauxModel([{ kind: "echo_context" }]), tools: [], hostTools: TOOLS, continueSession: true });
    expect((await second.log.next("ready")).sessionFile).toBe(file);
    // 子进程在跑的时候不让改（内存里还有原文）
    await expect(daemon.agents.rewriteSessions(AGENT, request)).rejects.toThrow(/还在运行/);
    second.agent.send({ type: "user_input", inputId: "in-3", text: "刚才说了什么？" });
    const seen = (await second.log.next("message_final")).message.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n");
    expect(seen).not.toContain("青蛙");
    expect(seen).not.toContain("沪A12345");
    // 压缩摘要进上下文（换成了删除说明），保留的第一条之后照常
    expect(seen).toContain(PURGED_SUMMARY_TEXT);
    expect(seen).toContain("[user] 今天天气不错");
    // 标签不进模型的上下文
    expect(seen).not.toContain("in-secret");
  });

  it("没被压缩覆盖的摘要不动：被改的条目在压缩保留的第一条之后", async () => {
    const { daemon } = await startTestDaemon();
    const first = spawnTestAgent(daemon, { agentId: AGENT, model: fauxModel([{ kind: "reply", text: "好" }, { kind: "reply", text: "好" }]), tools: [], continueSession: true });
    const ready = await first.log.next("ready");
    first.agent.send({ type: "user_input", inputId: "in-old", text: "很早以前的话" });
    await first.log.next("turn_end");
    first.agent.send({ type: "exit" });
    await first.agent.exited;
    const entries = entriesOf(ready.sessionFile);
    // 压缩：保留的第一条是最后一条，之前的由摘要代替；被删的消息在压缩之后
    const compaction = { type: "compaction", id: "cmp00002", parentId: entries.at(-1)!.id, timestamp: new Date().toISOString(), summary: "很早以前聊过天", firstKeptEntryId: entries.at(-1)!.id, tokensBefore: 10 };
    fs.appendFileSync(ready.sessionFile, `${JSON.stringify(compaction)}\n`);
    const again = spawnTestAgent(daemon, { agentId: AGENT, model: fauxModel([{ kind: "reply", text: "好" }]), tools: [], continueSession: true });
    await again.log.next("ready");
    again.agent.send({ type: "user_input", inputId: "in-new", text: "要删的新话" });
    await again.log.next("turn_end");
    again.agent.send({ type: "exit" });
    await again.agent.exited;

    const result = await daemon.agents.rewriteSessions(AGENT, { inputIds: ["in-new"], toolCallIds: [], toolResultLines: [], marker: PURGED_TEXT, summaryMarker: PURGED_SUMMARY_TEXT, customTypes: [] });
    expect(result).toEqual({ files: 1, entries: 1, summaries: 0 });
    const text = fs.readFileSync(ready.sessionFile, "utf8");
    expect(text).toContain("很早以前聊过天");
    expect(text).not.toContain("要删的新话");
  });
});
