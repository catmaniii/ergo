// 主切面：二狗的工具、上下文、工具包里的 skill 交给 Claude Code（291 号票）。真的守护进程走组合根和插件清单，清单里的 Claude Code 插件经
// extraPlugins 换成子进程接假 SDK 的那个（helpers/fake-claude-code.ts：运行时、适配子进程、守卫的钩子、进程内 MCP 服务、上下文钩子、插件目录都是真的；
// SDK 按 faux 剧本扮演 claude——调 mcp__<服务>__<工具> 时经进程内 MCP 服务调，每条输入之前叫 SessionStart / UserPromptSubmit 钩子），
// 不启动真的 claude、不花额度、不碰用户真实的 ~/.claude（守护进程的主目录是临时的）。测试用的插件"探针"扮演给维护者工具和上下文的插件：
// - Claude 调二狗的问记忆工具（探针给任务维护者的 ask_memory）拿到结果：守卫照工具的登记判、调用记进会话；记忆简报（跟在输入后面的那块）、
//   项目规范（被唤起时注入的那块）进了模型的上下文（钩子的 additionalContext），界面上（会话频道里的消息）不显示；
// - 工具包改了（项目的工具包打开"发附件"）：维护者正在这一轮里（探针的工具卡着），下一次调用就能用新工具 send_attachment，子进程没有重新拉起，
//   "工具包已变更"随那次工具结果交给模型；
// - 工具包里的 skill 拼成本地插件交给 query（plugins 里有它，目录里是这个 skill），输入框的 / 补全列出 /ergo:<目录名>；
//   用户的 ~/.claude、项目工作目录里的 .claude/ 没被写。
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, EVENT_TYPES, HTTP_PATHS, maintainerChannel, type MessageEventPayload, type MessagePart, type SlashCommandList, type Task, Type } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { defineHostTool } from "../../src/agent-manager/host-tools.ts";
import { CLAUDE_CODE_RUNTIME_ID } from "../../src/claude-code/api.ts";
import { findToolCallDetail } from "../../src/guard-runtime/tool-call-details.ts";
import type { PluginDefinition } from "../../src/plugins/host.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { fakeSdkClaudeCodePlugin } from "../helpers/fake-claude-code.ts";
import type { FakeClaudeEcho } from "../helpers/fake-claude-sdk.ts";
import { requestJson } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";
import { seedProject } from "../helpers/projects.ts";
import { TestFrontend } from "../helpers/frontend.ts";

type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;

const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const echo: FauxStep = { kind: "echo_context" };

const BRIEF = "【记忆简报：你上周说过先把 Claude Code 接进来】";
const NORMS = "【项目规范：先写测试再改代码】";

const messagesOf = (td: TestDaemon, channel: string) => td.daemon.store.read(channel, 0, EVENT_TYPES.message).map((e) => (e.payload as MessageEventPayload).message);
const textOf = (message: { parts: readonly MessagePart[] }) => message.parts.map((p) => ("text" in p ? p.text : "")).join("");
const toolParts = (td: TestDaemon, channel: string): ToolCallPart[] => messagesOf(td, channel).flatMap((m) => m.parts.filter((p): p is ToolCallPart => p.type === "tool_call"));
/** 会话里最近一条 echo_context 的回显（agent 的回复是那段 JSON） */
const lastEcho = (td: TestDaemon, channel: string): FakeClaudeEcho | undefined => {
  const text = messagesOf(td, channel)
    .filter((m) => m.speaker === "agent")
    .map(textOf)
    .filter((t) => t.includes('"hookContext"'))
    .at(-1);
  return text === undefined ? undefined : (JSON.parse(text) as FakeClaudeEcho);
};
const slashCommands = (url: string, conversation: string) => requestJson<SlashCommandList>(url, HTTP_PATHS.slashCommands(conversation));

/** 从现在起拉起了哪些 agent（测试接缝） */
function spawnsOf(td: TestDaemon): () => string[] {
  const seen: string[] = [];
  const spawn = td.daemon.agents.spawn.bind(td.daemon.agents);
  td.daemon.agents.spawn = (request) => {
    seen.push(request.agentId);
    return spawn(request);
  };
  return () => [...seen];
}

/** 一个卡住的闸：探针的工具在它放开之前不交结果 */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open, calls: 0 };
}

/** 测试用的插件"探针"：给任务维护者问记忆、给项目维护者一个会卡住的工具；每条输入后面跟记忆简报，被唤起时注入项目规范 */
function probePlugin(hold: ReturnType<typeof gate>): PluginDefinition {
  const askMemory = defineHostTool({
    name: "ask_memory",
    title: "问记忆",
    description: "测试用：问二狗的记忆",
    parameters: Type.Object({ question: Type.String() }, { additionalProperties: false }),
    readOnlyOrIdempotent: true,
    nature: "look",
    run: (args) => ({ text: `记忆里查到：你最近在忙「${args.question}」相关的 Claude Code 接入。` }),
  });
  const wait = defineHostTool({
    name: "probe_wait",
    title: "等一下",
    description: "测试用：卡住，直到测试放开",
    parameters: Type.Object({}, { additionalProperties: false }),
    readOnlyOrIdempotent: true,
    nature: "look",
    run: async () => {
      hold.calls += 1;
      await hold.opened;
      return { text: "等完了" };
    },
  });
  return {
    name: "probe",
    title: "探针",
    setup(ctx) {
      ctx.agent.tools.register({ to: { agents: ["task"] }, tools: () => [askMemory] });
      ctx.agent.tools.register({ to: { agents: ["project"] }, tools: () => [wait] });
      ctx.agent.context.register({ to: { agents: ["task", "project"] }, when: "input", text: () => BRIEF });
      ctx.agent.context.register({ to: { agents: ["task", "project"] }, when: "wake", id: "norms", text: () => NORMS });
    },
  };
}

describe("二狗的工具和上下文交给 Claude Code（假 SDK）", () => {
  it("Claude 调二狗的问记忆工具拿到结果（守卫照登记判、调用记进会话）；记忆简报、项目规范进了模型的上下文，界面不显示", async () => {
    const td = await startTestDaemon({
      extraPlugins: [fakeSdkClaudeCodePlugin, probePlugin(gate())],
      maintainer: [call("mcp__ergo__ask_memory", { question: "最近在忙什么" }), echo],
    });
    const task = td.daemon.tasks.delegate({ title: "回顾一下", instructions: "看看我最近在忙什么", runtime: CLAUDE_CODE_RUNTIME_ID });
    const channel = maintainerChannel(task.maintainerId);
    await waitUntil(() => td.daemon.tasks.get(task.id)?.state === "done", { timeoutMs: 60_000, describe: () => `等任务做完：${JSON.stringify(td.daemon.tasks.get(task.id) as Task)}；调用：${JSON.stringify(toolParts(td, channel))}` });

    // 调用：工具名是二狗的（ask_memory），守卫放行、做完了，结果是二狗的工具交回的
    const [askCall] = toolParts(td, channel);
    expect(askCall).toMatchObject({ tool: "ask_memory", outcome: "done" });
    expect(askCall!.resultSummary).toContain("记忆里查到");
    expect(findToolCallDetail(td.daemon.store, askCall!.callId)).toMatchObject({ tool: "ask_memory", nativeTool: "mcp__ergo__ask_memory", args: { question: "最近在忙什么" }, outcome: "done" });
    expect(findToolCallDetail(td.daemon.store, askCall!.callId)!.result).toContain("最近在忙什么");

    // 模型看到的：二狗的工具在进程内 MCP 服务里；记忆简报、项目规范是钩子的 additionalContext
    const seen = lastEcho(td, channel)!;
    expect(seen.mcpTools).toContain("mcp__ergo__ask_memory");
    expect(seen.options.mcpServers).toContain("ergo");
    expect(seen.options.hooks).toEqual(expect.arrayContaining(["PreToolUse", "UserPromptSubmit", "SessionStart", "PostToolUse"]));
    expect(seen.hookContext).toContain(BRIEF);
    expect(seen.hookContext).toContain(NORMS);
    // 交给 Claude 的用户消息里没有它们（不当成用户说的话）
    expect(seen.input).not.toContain("记忆简报");
    // 界面：会话频道里除了这段回显（agent 照抄出来的）没有一条消息带着它们
    const showing = messagesOf(td, channel).filter((m) => !textOf(m).includes('"hookContext"') && (textOf(m).includes("记忆简报") || textOf(m).includes("项目规范")));
    expect(showing).toEqual([]);
    // 二狗不写用户的 ~/.claude、工作目录的 .claude/
    expect(fs.existsSync(path.join(td.homeDir, ".claude"))).toBe(false);
  }, 90_000);

  it("工具包改了：维护者这一轮正卡在二狗的工具上，下一次调用就能用新加的 send_attachment；子进程没重新拉起，工具包已变更随那次结果交给模型", async () => {
    const hold = gate();
    const td = await startTestDaemon({
      extraPlugins: [fakeSdkClaudeCodePlugin, probePlugin(hold)],
      maintainer: (id) => (id === "pm-1" ? [call("mcp__ergo__probe_wait", {}), call("mcp__ergo__send_attachment", { path: "docs/README.md", name: "说明.md" }), echo] : []),
    });
    const spawns = spawnsOf(td);
    const toolkit = { skills: [], mcp: [], bash: true, network: true, sendAttachment: false };
    const project = seedProject(td.daemon, "记账本", { state: "in_use", charterConfirmed: true, kind: "dev", runtime: CLAUDE_CODE_RUNTIME_ID, toolkit });
    const workdir = td.daemon.projects.workdir(project);
    fs.mkdirSync(path.join(workdir, "docs"), { recursive: true });
    fs.writeFileSync(path.join(workdir, "docs", "README.md"), "# 记账本\n");
    const pm = maintainerChannel(project.maintainerId);
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [CHANNELS.board]: 0, [pm]: 0 });
    await frontend.sendText("把说明发给我", { conversation: pm });

    await waitUntil(() => hold.calls === 1, { timeoutMs: 60_000, describe: () => `等维护者调到探针的工具；调用：${JSON.stringify(toolParts(td, pm))}` });
    // 这时候还没有 send_attachment（工具包里关着）；打开它
    td.daemon.projects.changeToolkit(project.id, { ...toolkit, sendAttachment: true }, { by: "user", why: "你在项目页打开了发附件" });
    hold.open();

    await waitUntil(() => lastEcho(td, pm) !== undefined, { timeoutMs: 60_000, describe: () => `等这一轮做完；调用：${JSON.stringify(toolParts(td, pm))}` });
    const calls = toolParts(td, pm);
    expect(calls.map((c) => `${c.tool}:${c.outcome}`)).toEqual(["probe_wait:done", "send_attachment:done"]);
    const sent = messagesOf(td, pm).find((m) => m.parts.some((p) => p.type === "file"));
    expect(sent?.parts).toEqual([expect.objectContaining({ type: "file", name: "说明.md" })]);
    const seen = lastEcho(td, pm)!;
    expect(seen.mcpTools).toContain("mcp__ergo__send_attachment");
    expect(seen.toolContexts.join("\n")).toContain("工具包已变更");
    // 一直是同一个子进程：没有重新拉起
    expect(spawns().filter((id) => id === project.maintainerId)).toEqual([project.maintainerId]);
  }, 120_000);

  it("工具包里的 skill 拼成本地插件交给 query（目录里是这个 skill），输入框的 / 补全列出 /ergo:<目录名>；~/.claude、项目的 .claude/ 没被写", async () => {
    const td = await startTestDaemon({ extraPlugins: [fakeSdkClaudeCodePlugin], maintainer: (id) => (id === "pm-1" ? [echo] : []) });
    const toolkit = { skills: ["example-checklist"], mcp: [], bash: true, network: true };
    const project = seedProject(td.daemon, "记账本", { state: "in_use", charterConfirmed: true, kind: "dev", runtime: CLAUDE_CODE_RUNTIME_ID, toolkit });
    const pm = maintainerChannel(project.maintainerId);
    // 补全：还没跑过（Claude Code 没报过命令）就按工具包列出
    const before = (await slashCommands(td.url, pm)).body.commands;
    expect(before.find((c) => c.text === "/ergo:example-checklist")).toMatchObject({ kind: "skill", name: "example-checklist" });
    expect(before.some((c) => c.text === "/example-checklist")).toBe(false);

    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [pm]: 0 });
    await frontend.sendText("列个清单", { conversation: pm });
    await waitUntil(() => lastEcho(td, pm) !== undefined, { timeoutMs: 60_000, describe: () => "等维护者回显" });
    const seen = lastEcho(td, pm)!;
    const pluginRoot = path.join(td.dataDir, "cache", "runtimes", project.maintainerId, "ergo");
    expect(seen.options.plugins).toEqual([pluginRoot]);
    expect(seen.pluginSkills).toEqual(["example-checklist"]);
    expect(fs.readFileSync(path.join(pluginRoot, "skills", "example-checklist", "SKILL.md"), "utf8")).toContain("name: example-checklist");
    // 跑过之后 Claude Code 报的命令里也有它（插件的 skill）：不重复列
    const after = (await slashCommands(td.url, pm)).body.commands;
    expect(after.filter((c) => c.text === "/ergo:example-checklist")).toHaveLength(1);

    // 工具包里加一个 skill（手放进 skill 区的）：维护者闲着、子进程还在——当场重拼插件目录（子进程叫 SDK 重新加载插件），补全跟着列出
    const weekly = path.join(td.dataDir, "skills", "weekly-report");
    fs.mkdirSync(weekly, { recursive: true });
    fs.writeFileSync(path.join(weekly, "SKILL.md"), "---\nname: weekly-report\ndescription: 写周报\n---\n\n照着写周报。\n");
    td.daemon.projects.changeToolkit(project.id, { ...toolkit, skills: ["example-checklist", "weekly-report"] }, { by: "user", why: "你在项目页加了一个 skill" });
    await waitUntil(() => fs.existsSync(path.join(pluginRoot, "skills", "weekly-report", "SKILL.md")), { timeoutMs: 30_000, describe: () => "等插件目录里多出 weekly-report" });
    expect(fs.readdirSync(path.join(pluginRoot, "skills")).toSorted()).toEqual(["example-checklist", "weekly-report"]);
    expect((await slashCommands(td.url, pm)).body.commands.filter((c) => c.text.startsWith("/ergo:")).map((c) => c.text)).toEqual(["/ergo:example-checklist", "/ergo:weekly-report"]);
    expect(fs.existsSync(path.join(td.homeDir, ".claude"))).toBe(false);
    expect(fs.existsSync(path.join(td.daemon.projects.workdir(project), ".claude"))).toBe(false);
  }, 90_000);
});
