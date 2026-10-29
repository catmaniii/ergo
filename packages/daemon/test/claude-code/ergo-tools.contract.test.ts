// Claude Code 适配子进程的契约测试：二狗的工具、上下文、工具包里的 skill 交给 Claude Code（291 号票）。SDK 是手动挡的假的
// （helpers/fake-claude-sdk.ts：测试扮演 claude 和它的 MCP 客户端、叫钩子），不启动真的 claude、不花额度、不碰用户真实的 ~/.claude。
// - 二狗的工具经进程内 MCP 服务交给 Claude：mcp__ergo__<工具名>、工具包里的 MCP 按服务各一个；tools/call 转成 host_tool_call（调用 id 是
//   _meta 里的 tool_use id，没带时按工具名认领），结果交回 MCP；取消了的交回"回合已中止"、晚到的结果不报错；报给守护进程的工具名换回二狗的；
// - 守卫：mcp__ergo__<工具名> 按二狗的工具判（native 留原样），放行了直接 allow；
// - 工具包当场换（宿主协议 toolkit）：同一个服务的工具清单当场换（list_changed），服务有增减 setMcpServers；skill 变了重拼插件目录、reloadPlugins、
//   报回刷新后的命令；"工具包已变更"交给下一次工具结果；
// - 上下文：上下文块每条输入之前、压缩之后注入；跟在输入后面的只给这一条；系统提示后缀和近期范围记录起 query 后、变了、压缩之后才注入；
//   contribution、scope_context 换文字；手动压缩带上压缩指令；
// - 工具包里的 skill 拼成本地插件交给 query 的 plugins：目录里是这几个 skill（复制，依赖目录照样是联接），skill 库的原件、用户的 ~/.claude、
//   工作目录里的 .claude/ 都没被写。
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, onTestFinished } from "vitest";
import { runClaudeChild } from "../../src/claude-code/child/child.ts";
import { pluginSkillNames } from "../../src/claude-code/skill-plugin.ts";
import { type AgentReport, HOST_PROTOCOL_VERSION, type HostCommand, type HostToolSpec, type SessionAssembly } from "../../src/runtime/index.ts";
import { encodeLine, readJsonLines } from "../../src/runtime/line-channel.ts";
import { fauxModel } from "../helpers/daemon.ts";
import { createFakeClaudeSdk, type FakeClaudeQuery, inputText, sdk, sdkReply } from "../helpers/fake-claude-sdk.ts";
import { ReportLog } from "../helpers/report-log.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const spec = (name: string, description = `${name} 的说明`): HostToolSpec => ({
  name,
  description,
  parameters: { type: "object", properties: { question: { type: "string" } }, additionalProperties: false },
});

function assemblyOf(overrides: Partial<SessionAssembly> = {}): SessionAssembly {
  return {
    agentId: "claude-test",
    cwd: overrides.cwd ?? makeTempDir("ergo-claude-cwd-"),
    sessionDir: overrides.sessionDir ?? makeTempDir("ergo-claude-sessions-"),
    piAgentDir: "",
    model: fauxModel([]),
    credentials: {},
    tools: [],
    contributions: { tools: [], contextBlocks: [], hooks: [] },
    skillPaths: [],
    systemPrompt: "你是二狗的维护者。",
    continueSession: true,
    forwardToolCalls: false,
    shellEnv: {},
    heartbeatIntervalMs: 60_000,
    ...overrides,
  };
}

/** 在本进程里跑一个适配子进程，SDK 是手动挡的假的；env 换成临时的主目录（不碰用户真实的 ~/.claude） */
function startChild(session: Partial<SessionAssembly> = {}) {
  const fake = createFakeClaudeSdk();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const listeners = new Set<(report: AgentReport) => void>();
  readJsonLines<AgentReport>(stdout, (report) => listeners.forEach((l) => l(report)), { onInvalid: () => {} });
  const log = new ReportLog({
    onReport: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const home = makeTempDir("ergo-claude-home-");
  const logs: string[] = [];
  const child = runClaudeChild(
    { stdin, stdout, env: { PATH: "C:\\Windows", USERPROFILE: home, HOME: home }, log: (line) => logs.push(line), exit: () => {} },
    { queryFor: () => fake.query, executable: null },
  );
  const assembly = assemblyOf(session);
  const send = (command: HostCommand) => stdin.write(encodeLine(command));
  send({ type: "start", protocolVersion: HOST_PROTOCOL_VERSION, session: assembly });
  onTestFinished(() => child.shutdown(0));
  return { fake, send, log, logs, assembly, home };
}

type Child = ReturnType<typeof startChild>;

/** 送一条输入，等假 SDK 收到 */
async function prompt(child: Child, inputId: string, text: string, extra: Partial<Extract<HostCommand, { type: "user_input" }>> = {}) {
  child.send({ type: "user_input", inputId, text, ...extra });
  const query = await child.fake.nth(1);
  const input = await query.nextInput();
  return { query, input };
}

/** 等到条件成立 */
async function until(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`等不到：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 一个 skill 目录（skill 库里的样子）：SKILL.md 和一个附带的文件 */
function makeSkill(root: string, dir: string, name = dir): string {
  const skill = path.join(root, dir);
  fs.mkdirSync(path.join(skill, "references"), { recursive: true });
  fs.writeFileSync(path.join(skill, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} 的说明\n---\n\n照着做 ${name}。\n`);
  fs.writeFileSync(path.join(skill, "references", "notes.md"), `${name} 的参考\n`);
  return skill;
}

/** 一个目录下全部文件的相对路径和内容（不跟链接） */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const relPath = path.join(rel, entry.name);
      const st = fs.lstatSync(path.join(dir, relPath));
      if (st.isSymbolicLink()) out[relPath] = `-> ${fs.realpathSync(path.join(dir, relPath))}`;
      else if (st.isDirectory()) walk(relPath);
      else out[relPath] = fs.readFileSync(path.join(dir, relPath), "utf8");
    }
  };
  walk("");
  return out;
}

const finishTurn = (query: FakeClaudeQuery, uuid: string | undefined) => query.emit(sdk.result({ ...(uuid ? { userMessageUuids: [uuid] } : {}), queuedTurnCount: 0 }));

describe("二狗的工具交给 Claude（进程内 MCP 服务，假 SDK）", () => {
  it("mcp__ergo__<工具名> 和工具包里的 MCP 各一个服务；tools/call 转成 host_tool_call、结果交回 MCP；报给守护进程的工具名换回二狗的；没带 id 的按工具名认领；取消了交回回合已中止", async () => {
    const child = startChild({ contributions: { tools: [spec("ask_memory", "问二狗的记忆"), spec("mcp__github__create_issue")], contextBlocks: [], hooks: [] } });
    await child.log.next("ready");
    const { query, input } = await prompt(child, "in-1", "我最近在忙什么？");
    expect(Object.keys(query.options.mcpServers ?? {})).toEqual(["ergo", "github"]);
    expect(Object.values(query.options.mcpServers ?? {}).map((s) => s.type)).toEqual(["sdk", "sdk"]);
    const ergo = query.mcpLink("ergo")!;
    expect(await ergo.listTools()).toEqual([{ name: "ask_memory", description: "问二狗的记忆", inputSchema: spec("ask_memory").parameters }]);
    expect((await query.mcpLink("github")!.listTools()).map((t) => t.name)).toEqual(["create_issue"]);

    // Claude 调 mcp__ergo__ask_memory：定稿和工具调用开始都写二狗的名字
    query.emit(sdk.init("s"), ...sdkReply("msg_1", { text: "我问一下记忆。", toolCalls: [{ id: "toolu_1", name: "mcp__ergo__ask_memory", input: { question: "最近在忙什么" } }] }));
    const final = await child.log.next("message_final");
    expect(final.message.parts.at(-1)).toEqual({ type: "tool_call", toolCallId: "toolu_1", toolName: "ask_memory", args: { question: "最近在忙什么" } });
    expect(await child.log.next("tool_call_start")).toEqual({ type: "tool_call_start", toolCallId: "toolu_1", toolName: "ask_memory", args: { question: "最近在忙什么" } });
    const answer = ergo.callTool("ask_memory", { question: "最近在忙什么" }, "toolu_1");
    const call = await child.log.next("host_tool_call");
    expect(call).toMatchObject({ toolCallId: "toolu_1", toolName: "ask_memory", args: { question: "最近在忙什么" } });
    const png = Buffer.from("png").toString("base64");
    child.send({ type: "host_tool_result", requestId: call.requestId, result: { text: "你最近在忙二狗 v2 的 Claude Code 接入。", isError: false, images: [{ mime: "image/png", data: png }] } });
    expect(await answer).toEqual({
      content: [
        { type: "text", text: "你最近在忙二狗 v2 的 Claude Code 接入。" },
        { type: "image", data: png, mimeType: "image/png" },
      ],
    });
    query.emit(sdk.toolResult("toolu_1", [{ type: "text", text: "你最近在忙二狗 v2 的 Claude Code 接入。" }]));
    expect(await child.log.next("tool_call_end")).toMatchObject({ toolCallId: "toolu_1", toolName: "ask_memory", isError: false });

    // 工具包里的 MCP：二狗这边的名字和 Claude 的一样；没带 id 时按工具名认领那次报过开始的调用
    query.emit(...sdkReply("msg_2", { toolCalls: [{ id: "toolu_2", name: "mcp__github__create_issue", input: { question: "开个票" } }] }));
    await child.log.next("tool_call_start");
    const issue = query.mcpLink("github")!.callTool("create_issue", { question: "开个票" });
    const issueCall = await child.log.next("host_tool_call");
    expect(issueCall).toMatchObject({ toolCallId: "toolu_2", toolName: "mcp__github__create_issue" });
    child.send({ type: "host_tool_result", requestId: issueCall.requestId, result: { text: "开好了 #12", isError: true } });
    expect(await issue).toEqual({ content: [{ type: "text", text: "开好了 #12" }], isError: true });

    // 取消（Claude Code 打断时发 notifications/cancelled）：交回回合已中止；之后才到的结果不报错
    const cancelled = ergo.callTool("ask_memory", { question: "再问一次" }, "toolu_3", "req-cancel");
    const third = await child.log.next("host_tool_call");
    ergo.cancel("req-cancel");
    expect(await cancelled).toEqual({ content: [{ type: "text", text: "回合已中止" }], isError: true });
    child.send({ type: "host_tool_result", requestId: third.requestId, result: { text: "晚了", isError: false } });
    // 不在清单里的工具：MCP 层面回出错，不打扰守护进程
    expect(await ergo.callTool("no_such_tool", {}, "toolu_4")).toMatchObject({ isError: true });
    finishTurn(query, input.uuid);
    await child.log.next("turn_end");
    expect(child.log.ofType("error")).toEqual([]);
    expect(child.log.ofType("host_tool_call")).toHaveLength(3);
  });

  it("守卫：mcp__ergo__<工具名> 按二狗的工具判（native 留原样），放行了直接 allow；用户自己配的 MCP 放行后照旧交给 Claude Code 自己的权限", async () => {
    const child = startChild({ forwardToolCalls: true, contributions: { tools: [spec("ask_memory")], contextBlocks: [], hooks: [] } });
    await child.log.next("ready");
    const { query } = await prompt(child, "in-1", "问一下");
    const own = query.runTool("toolu_1", "mcp__ergo__ask_memory", { question: "x" });
    const request = await child.log.next("guard_request");
    expect(request).toMatchObject({ toolCallId: "toolu_1", toolName: "ask_memory", args: { question: "x" }, native: { toolName: "mcp__ergo__ask_memory", args: { question: "x" } } });
    child.send({ type: "guard_reply", requestId: request.requestId, verdict: { allow: true } });
    expect(await own).toMatchObject({ allowed: true, decision: "allow", asked: false });

    const theirs = query.runTool("toolu_2", "mcp__userserver__do", { a: 1 });
    const second = await child.log.next("guard_request");
    expect(second).toMatchObject({ toolName: "mcp__userserver__do" });
    child.send({ type: "guard_reply", requestId: second.requestId, verdict: { allow: true } });
    const run = await theirs;
    expect(run.allowed).toBe(true);
    expect(run.decision).toBeUndefined();
  });

  it("追加的系统提示后面补一句二狗的工具在 Claude Code 里叫什么", async () => {
    const child = startChild();
    await child.log.next("ready");
    const query = await child.fake.nth(1);
    expect(query.options.systemPrompt).toMatchObject({ type: "preset", preset: "claude_code", snapshot: false, append: expect.stringContaining("你是二狗的维护者。") });
    const append = (query.options.systemPrompt as { append: string }).append;
    expect(append).toContain("mcp__ergo__submit_plan");
    expect(append).toContain("/ergo:");
  });
});

describe("工具包当场换（宿主协议 toolkit，假 SDK）", () => {
  it("同一个服务的工具清单当场换（list_changed）、服务有增减 setMcpServers；skill 变了重拼插件、reloadPlugins、报回命令；工具包已变更交给下一次工具结果；回合不停下", async () => {
    const library = makeTempDir("ergo-skill-library-");
    const alpha = makeSkill(library, "alpha");
    const beta = makeSkill(library, "beta");
    const runtimeDir = makeTempDir("ergo-claude-runtime-");
    const child = startChild({ runtimeDir, skillPaths: [alpha], contributions: { tools: [spec("ask_memory")], contextBlocks: [], hooks: [] } });
    await child.log.next("ready");
    const { query, input } = await prompt(child, "in-1", "开始");
    const ergo = query.mcpLink("ergo")!;
    expect((await ergo.listTools()).map((t) => t.name)).toEqual(["ask_memory"]);
    expect(query.pluginSkills()).toEqual(["alpha"]);

    child.send({ type: "toolkit", tools: [spec("ask_memory"), spec("read_profile"), spec("mcp__notion__search")], skillPaths: [alpha, beta], notice: "工具包已变更（任务的工具包改了）：加上 read_profile。" });
    await until(() => query.reloads === 1, "重新加载插件");
    expect(ergo.listChanged).toBe(1);
    expect((await ergo.listTools()).map((t) => t.name)).toEqual(["ask_memory", "read_profile"]);
    expect(query.setMcpServersCalls).toEqual([["ergo", "notion"]]);
    expect((await query.mcpLink("notion")!.listTools()).map((t) => t.name)).toEqual(["search"]);
    expect(query.pluginSkills()).toEqual(["alpha", "beta"]);
    // 重新加载之后报回刷新后的命令（输入框的 / 补全）
    const catalog = child.log.ofType("runtime_catalog").at(-1)!;
    expect(catalog.commands?.map((c) => c.name)).toEqual(expect.arrayContaining(["ergo:alpha", "ergo:beta"]));
    // 工具包已变更：下一次主线工具结果交给模型，只交一次
    expect((await query.runTool("toolu_1", "Read", { file_path: "a.md" })).context).toBe("工具包已变更（任务的工具包改了）：加上 read_profile。");
    expect((await query.runTool("toolu_2", "Read", { file_path: "b.md" })).context).toBeUndefined();

    // 去掉一个 skill、去掉 MCP：插件目录跟着变，notion 断开；同一个 query（不重新拉起）
    child.send({ type: "toolkit", tools: [spec("ask_memory")], skillPaths: [beta] });
    await until(() => query.reloads === 2, "第二次重新加载插件");
    expect(query.pluginSkills()).toEqual(["beta"]);
    expect(query.setMcpServersCalls.at(-1)).toEqual(["ergo"]);
    expect(query.mcpLink("notion")).toBeUndefined();
    expect((await ergo.listTools()).map((t) => t.name)).toEqual(["ask_memory"]);
    // 只换了 MCP 的工具、skill 没变：不重新加载插件
    child.send({ type: "toolkit", tools: [spec("ask_memory"), spec("read_profile")], skillPaths: [beta] });
    await until(async () => (await ergo.listTools()).length === 2, "工具清单换成两个");
    expect(query.reloads).toBe(2);
    finishTurn(query, input.uuid);
    expect(await child.log.next("turn_end")).toMatchObject({ outcome: "completed" });
    expect(child.fake.queries).toHaveLength(1);
    expect(child.log.ofType("error")).toEqual([]);
  });
});

describe("进上下文不显示的内容经钩子注入（假 SDK）", () => {
  it("上下文块每条输入之前、压缩之后；跟在输入后面的只给这一条；后缀和近期范围记录起 query 后、变了、压缩之后才注入；contribution、scope_context 换文字", async () => {
    const child = startChild({
      contributions: {
        tools: [],
        contextBlocks: [
          { id: "reinjection", text: "【阶段：第一阶段】" },
          { id: "probe:brief", text: "【项目规范 v1】" },
        ],
        hooks: [
          { id: "probe:rules", kind: "system_prompt_suffix", text: "【规矩 v1】" },
          { id: "compaction", kind: "compaction_instructions", text: "只留结论" },
        ],
      },
      scopeReview: { model: fauxModel([]), instructions: "审视", reference: "立项书", recentRecords: "【近期范围记录 v1】" },
    });
    await child.log.next("ready");
    const query = await child.fake.nth(1);
    // 309 号票：装配了范围审视的多一个 PreCompact（压缩之前报 compacting）
    expect(Object.keys(query.options.hooks ?? {}).toSorted()).toEqual(["PostToolUse", "PostToolUseFailure", "PreCompact", "SessionStart", "UserPromptSubmit"]);

    // 第一条：SessionStart（startup）先注入上下文块和"一直在"的那段，UserPromptSubmit 只加这条后面跟的；上下文块只注入一次
    const first = await prompt(child, "in-1", "第一条", { context: "【记忆简报：你上周说过要先做 Claude Code】" });
    expect(first.input.message.content).toBe("第一条");
    const seen1 = await query.promptHooks(first.input);
    expect(seen1.split("\n\n")).toEqual(["【阶段：第一阶段】", "【项目规范 v1】", "【规矩 v1】", "【近期范围记录 v1】", "【记忆简报：你上周说过要先做 Claude Code】"]);
    query.emit(sdk.init("s"), ...sdkReply("msg_1", { text: "好的" }));
    finishTurn(query, first.input.uuid);
    await child.log.next("turn_end");

    // 第二条：上下文块照样在前（每条输入之前），后缀和近期范围记录没变不再注入，上一条后面跟的不带
    const second = await prompt(child, "in-2", "第二条");
    expect(await query.promptHooks(second.input)).toBe("【阶段：第一阶段】\n\n【项目规范 v1】");
    finishTurn(query, second.input.uuid);
    await child.log.next("turn_end");

    // 换文字：阶段推进（重注入块）、后缀换了；近期范围记录换了
    child.send({ type: "contribution", id: "reinjection", text: "【阶段：第二阶段】" });
    child.send({ type: "contribution", id: "probe:rules", text: "【规矩 v2】" });
    child.send({ type: "scope_context", reference: "立项书", recentRecords: "【近期范围记录 v2】" });
    const third = await prompt(child, "in-3", "第三条");
    expect(await query.promptHooks(third.input)).toBe("【阶段：第二阶段】\n\n【项目规范 v1】\n\n【规矩 v2】\n\n【近期范围记录 v2】");

    // 压缩之后（SessionStart compact）：上下文块、"一直在"的那段再注入一次
    query.emit(sdk.compactBoundary("auto", 150_000));
    expect(await query.compactedHooks()).toBe("【阶段：第二阶段】\n\n【项目规范 v1】\n\n【规矩 v2】\n\n【近期范围记录 v2】");
    finishTurn(query, third.input.uuid);
    await child.log.next("turn_end");

    // 二狗发的手动压缩带上压缩指令
    child.send({ type: "compact" });
    expect(inputText(await query.nextInput())).toBe("/compact 只留结论");
  });
});

describe("工具包里的 skill 拼成本地插件（假 SDK）", () => {
  it("plugins 选项里是二狗拼的插件目录：几个 skill 复制进去（重名的加 -2，依赖目录照样是联接）；skill 库原件、~/.claude、工作目录的 .claude/ 都没被写", async () => {
    const library = makeTempDir("ergo-skill-library-");
    const alpha = makeSkill(library, "alpha");
    // 依赖目录：skill 库里是指向来源的目录联接
    const deps = makeTempDir("ergo-skill-deps-");
    fs.writeFileSync(path.join(deps, "lib.js"), "module.exports = 1;\n");
    fs.symlinkSync(deps, path.join(alpha, "node_modules"), "junction");
    const other = makeSkill(path.join(library, "pstack"), "alpha", "pstack alpha");
    const before = snapshot(library);
    const runtimeDir = makeTempDir("ergo-claude-runtime-");
    const cwd = makeTempDir("ergo-claude-cwd-");
    const child = startChild({ runtimeDir, cwd, skillPaths: [alpha, other] });
    await child.log.next("ready");
    const query = await child.fake.nth(1);
    const root = path.join(runtimeDir, "ergo");
    expect(query.options.plugins).toEqual([{ type: "local", path: root, skipMcpDiscovery: true }]);
    expect(pluginSkillNames([alpha, other])).toEqual(["alpha", "alpha-2"]);
    expect(query.pluginSkills()).toEqual(["alpha", "alpha-2"]);
    expect(JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin", "plugin.json"), "utf8"))).toMatchObject({ name: "ergo" });
    expect(fs.readFileSync(path.join(root, "skills", "alpha", "SKILL.md"), "utf8")).toBe(fs.readFileSync(path.join(alpha, "SKILL.md"), "utf8"));
    expect(fs.readFileSync(path.join(root, "skills", "alpha-2", "references", "notes.md"), "utf8")).toBe("pstack alpha 的参考\n");
    // 依赖目录照样是联接（指到同一个地方），不复制
    expect(fs.lstatSync(path.join(root, "skills", "alpha", "node_modules")).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(path.join(root, "skills", "alpha", "node_modules"))).toBe(fs.realpathSync(deps));
    // 复制的不是硬链接：改插件里的文件改不到 skill 库
    fs.writeFileSync(path.join(root, "skills", "alpha", "SKILL.md"), "被 Claude 改了");
    expect(fs.readFileSync(path.join(alpha, "SKILL.md"), "utf8")).toContain("照着做 alpha");

    // 工具包去掉重名的那个：插件目录跟着删，联接只删联接本身
    child.send({ type: "toolkit", tools: [], skillPaths: [other] });
    await until(() => query.reloads === 1, "重新加载插件");
    expect(query.pluginSkills()).toEqual(["alpha"]);
    expect(fs.readFileSync(path.join(root, "skills", "alpha", "SKILL.md"), "utf8")).toContain("pstack alpha");
    expect(fs.existsSync(path.join(deps, "lib.js"))).toBe(true);
    expect(snapshot(library)).toEqual(before);
    // 二狗不写用户的 ~/.claude、工作目录（项目）的 .claude/
    expect(fs.existsSync(path.join(child.home, ".claude"))).toBe(false);
    expect(fs.existsSync(path.join(cwd, ".claude"))).toBe(false);
    expect(fs.readdirSync(child.home)).toEqual([]);
  });

  it("没有运行时目录（老的装配）不拼插件；有运行时目录、工具包里没有 skill 也交一个空插件（之后加的 skill 重新加载就有）", async () => {
    const none = startChild();
    await none.log.next("ready");
    expect((await none.fake.nth(1)).options.plugins).toBeUndefined();
    const runtimeDir = makeTempDir("ergo-claude-runtime-");
    const empty = startChild({ runtimeDir });
    await empty.log.next("ready");
    const query = await empty.fake.nth(1);
    expect(query.options.plugins).toEqual([{ type: "local", path: path.join(runtimeDir, "ergo"), skipMcpDiscovery: true }]);
    expect(query.pluginSkills()).toEqual([]);
  });
});
