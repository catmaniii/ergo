// Codex 适配子进程的契约测试（照 Claude Code 的 test/claude-code/adapter.contract.test.ts）：宿主协议 ⇄ codex app-server 的对照。
// app-server 换成假的（helpers/fake-codex-app-server.ts：说的话按 0.166 生成的 schema 校验），不启动真的 codex、不花额度；适配子进程、钩子脚本、MCP 中转都是真的。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RECORD_EXT } from "../../src/codex/child/records.ts";
import { CODEX_SETTING } from "../../src/codex/settings.ts";
import { HOST_PROTOCOL_VERSION } from "../../src/runtime/index.ts";
import { type CodexChild, startCodexChild } from "../helpers/codex-child.ts";
import { type FakeCodexEcho, FakeCodexServer, FakeCodexStore } from "../helpers/fake-codex-app-server.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

/** 最近一条回复里 echo 回的 */
const echoOf = async (child: CodexChild): Promise<FakeCodexEcho> => {
  const final = child.log.ofType("message_final").at(-1)!;
  const part = final.message.parts.find((p) => p.type === "text");
  return JSON.parse((part as { text: string }).text) as FakeCodexEcho;
};

describe("Codex 适配子进程（假 app-server）", () => {
  it("新开会话一轮：thread/start 报 ready、记下记录；逐字输出 → 定稿 → 用量 → 轮次结束；参数照用户的决定", async () => {
    const child = startCodexChild({
      server: { turns: [[{ kind: "reply", thinking: "先看看目录里有什么。", text: "整理好了。", usage: { cacheHit: 30, cacheMiss: 120, output: 40 } }]], userInstructions: "用户自己的说明" },
    });
    const ready = await child.log.next("ready");
    expect(ready.sessionId).toMatch(/^th-/);
    expect(ready.session).not.toBe("");
    expect(ready).toMatchObject({ vision: true, model: { provider: "codex", modelId: "gpt-fake", pinned: false } });
    expect(fs.existsSync(path.join(child.assembly.sessionDir, `${ready.session}${RECORD_EXT}`))).toBe(true);
    // 模型列表报回，隐藏的不报
    expect((await child.log.next("runtime_catalog")).models).toEqual([
      { id: "gpt-fake", title: "GPT Fake" },
      { id: "gpt-other", title: "GPT Other" },
    ]);

    // 最严的审批策略、送到二狗；二狗的系统提示只追加（用户配置里的在前）；不传 model（跟 Codex 自己的设置）；沙箱没选是只能写工作目录
    const [start] = child.server.callsOf("thread/start");
    expect(start).toMatchObject({ cwd: child.assembly.cwd, approvalPolicy: "untrusted", approvalsReviewer: "user" });
    expect(start).not.toHaveProperty("model");
    expect(start).toMatchObject({ sandbox: "workspace-write" });
    expect(start!.developerInstructions).toMatch(/^用户自己的说明\n\n你是二狗的负责人。MARKER_ERGO_APPEND\n\n（二狗补充：/);

    expect((await child.turn("in-1", "把下载目录整理一下")).outcome).toBe("completed");
    const deltas = child.log.ofType("stream_delta");
    expect(deltas.filter((d) => d.part === "thinking").map((d) => d.delta).join("")).toBe("先看看目录里有什么。");
    expect(deltas.filter((d) => d.part === "text").map((d) => d.delta).join("")).toBe("整理好了。");
    expect(child.log.ofType("message_final").map((m) => m.message)).toEqual([
      {
        role: "assistant",
        parts: [
          { type: "thinking", text: "先看看目录里有什么。" },
          { type: "text", text: "整理好了。" },
        ],
        stopReason: "done",
      },
    ]);
    // input 不含缓存；订阅登录记成 codex-subscription（消耗页写"不算钱"）
    expect(child.log.ofType("usage")).toMatchObject([{ provider: "codex-subscription", modelId: "gpt-fake", input: 120, cacheRead: 30, cacheWrite: 0, output: 40, totalTokens: 190 }]);
    // 第一轮之后才算开始：记录里 started
    const record = JSON.parse(fs.readFileSync(path.join(child.assembly.sessionDir, `${ready.session}${RECORD_EXT}`), "utf8")) as { started: boolean; threadId: string };
    expect(record).toMatchObject({ started: true, threadId: ready.sessionId });
  });

  it("不写 ~/.codex 和项目配置：钩子、中转、联网开关都走 -c 启动参数；交给 codex 的环境去掉改计费的变量，CODEX_HOME 留着", async () => {
    const child = startCodexChild({
      env: { ...process.env, OPENAI_API_KEY: "sk-should-not-pass", CODEX_API_KEY: "sk-should-not-pass", CODEX_HOME: "D:\\my-codex-home" },
      server: { turns: [[{ kind: "echo" }]] },
    });
    await child.log.next("ready");
    const spawn = child.server.spawns.at(-1)!;
    expect(spawn.args[0]).toBe("app-server");
    expect(spawn.args.join(" ")).toContain('hooks.PreToolUse=[{matcher=".*",hooks=[{type="command",command="ergo-guard-hook"');
    expect(spawn.args.join(" ")).toContain('mcp_servers.ergo.default_tools_approval_mode="approve"');
    // Codex 自己的联网搜索钩子拦不到：一律关掉，要联网走二狗的 web_search（调用之前过守卫）
    expect(spawn.args).toContain('web_search="disabled"');
    // 往开着的终端里送字符钩子拦不到（实测）：关掉 TTY，开不了能接着送命令的终端
    expect(spawn.args.join(" ")).toContain("--disable unified_exec_tty");
    expect(spawn.env.OPENAI_API_KEY).toBeUndefined();
    expect(spawn.env.CODEX_API_KEY).toBeUndefined();
    expect(spawn.env.CODEX_HOME).toBe("D:\\my-codex-home");
    expect(spawn.cwd).toBe(child.assembly.cwd);
    await child.turn("in-1", "你好");
    const echo = await echoOf(child);
    expect(echo.env.OPENAI_API_KEY).toBeUndefined();
    // 项目目录里没多东西
    expect(fs.readdirSync(child.assembly.cwd)).toEqual([]);
  });

  it("上下文不拼进用户消息：上下文块、这条输入的上下文、system_prompt_suffix、近期范围记录都走 additionalContext；contribution 按 id 换文字，一直在的那段文字没变不重复带", async () => {
    const child = startCodexChild({
      session: {
        contributions: {
          tools: [],
          contextBlocks: [{ id: "c1", text: "上下文块一" }],
          hooks: [{ id: "h1", kind: "system_prompt_suffix", text: "末尾的话" }],
        },
      },
      server: { turns: [[{ kind: "echo" }], [{ kind: "echo" }]] },
    });
    await child.log.next("ready");
    await child.turn("in-1", "第一句", { context: "跟着这条的上下文" });
    const first = await echoOf(child);
    expect(first.input).toBe("第一句");
    expect(first.additionalContext).toHaveLength(1);
    expect(first.additionalContext[0]).toBe("上下文块一\n\n末尾的话\n\n跟着这条的上下文");

    child.send({ type: "contribution", id: "c1", text: "上下文块新的" });
    await child.turn("in-2", "第二句");
    const second = await echoOf(child);
    expect(second.input).toBe("第二句");
    expect(second.additionalContext).toEqual(["上下文块新的"]);
  });

  it("图片：data URL 交给 turn/start；选的模型、思考档位、沙箱翻成参数", async () => {
    const child = startCodexChild({
      session: { runtimeOptions: { model: "gpt-other", settings: { [CODEX_SETTING.effort]: "high", [CODEX_SETTING.sandbox]: "workspace-write" } } },
      server: { turns: [[{ kind: "echo" }]] },
    });
    await child.log.next("ready");
    expect(child.server.callsOf("thread/start")[0]).toMatchObject({ model: "gpt-other", sandbox: "workspace-write" });
    await child.turn("in-1", "看图", { images: [{ data: "QUJD", mime: "image/png" }] });
    expect(child.server.callsOf("turn/start")[0]).toMatchObject({
      effort: "high",
      clientUserMessageId: "in-1",
      input: [
        { type: "text", text: "看图", text_elements: [] },
        { type: "image", url: "data:image/png;base64,QUJD" },
      ],
    });
    expect((await echoOf(child)).model).toBe("gpt-other");
  });

  it("接着已有的会话：第一轮之后的走 thread/resume（不再 thread/start）；还没开始过的再 thread/start（没落盘，resume 不了）", async () => {
    const server = new FakeCodexServer({ turns: [[{ kind: "reply", text: "第一轮" }], [{ kind: "reply", text: "第二轮" }]] });
    const sessionDir = makeTempDir("ergo-codex-sessions-");
    const never = startCodexChild({ server, session: { sessionDir } });
    const firstReady = await never.log.next("ready");
    await never.shutdown(0);

    const second = startCodexChild({ server, session: { sessionDir } });
    const again = await second.log.next("ready");
    expect(again.session).toBe(firstReady.session);
    // 没开始过的：新开了一个 thread，记录跟着换
    expect(server.callsOf("thread/start")).toHaveLength(2);
    expect(server.callsOf("thread/resume")).toHaveLength(0);
    expect(again.sessionId).not.toBe(firstReady.sessionId);
    expect((await second.turn("in-1", "你好")).outcome).toBe("completed");
    await second.shutdown(0);

    const third = startCodexChild({ server, session: { sessionDir } });
    const resumed = await third.log.next("ready");
    expect(resumed.sessionId).toBe(again.sessionId);
    expect(resumed.model.pinned).toBe(true);
    expect(server.callsOf("thread/resume")).toMatchObject([{ threadId: again.sessionId, approvalPolicy: "untrusted", approvalsReviewer: "user", excludeTurns: true }]);
    expect((await third.turn("in-2", "接着")).outcome).toBe("completed");
  });

  it("工具包里的 skill 复制进 runtimeDir、经 skills/extraRoots/set 交给 Codex；原件不动，不写配置目录", async () => {
    const source = path.join(makeTempDir("ergo-skill-lib-"), "demo-skill");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "SKILL.md"), "---\nname: demo-skill\n---\n");
    const child = startCodexChild({ session: { skillPaths: [source] } });
    await child.log.next("ready");
    const root = path.join(child.assembly.runtimeDir!, "skills");
    expect(fs.readFileSync(path.join(root, "demo-skill", "SKILL.md"), "utf8")).toContain("demo-skill");
    expect(child.server.callsOf("skills/extraRoots/set")).toEqual([{ extraRoots: [root] }]);
  });

  it("插话：turn/steer 带 expectedTurnId，收下的列在 turn_end.interjected；这一轮做完了插不上的回 bad_command 带输入 id", async () => {
    const child = startCodexChild({ server: { turns: [[{ kind: "hang" }, { kind: "reply", text: "听到了。" }]] } });
    await child.log.next("ready");
    child.send({ type: "user_input", inputId: "in-1", text: "干活" });
    await expectCall(child, "turn/start");
    const turnId = await activeTurnId(child);
    child.send({ type: "interject", inputId: "in-2", text: "顺便改一下" });
    await expectCall(child, "turn/steer");
    expect(child.server.callsOf("turn/steer")[0]).toMatchObject({ expectedTurnId: turnId, clientUserMessageId: "in-2" });
    const end = await child.log.next("turn_end");
    expect(end).toMatchObject({ outcome: "completed", interjected: ["in-2"] });

    child.send({ type: "interject", inputId: "in-3", text: "晚了" });
    const error = await child.log.next("error");
    expect(error).toMatchObject({ code: "bad_command", inputId: "in-3" });
  });

  it("打断：turn/interrupt，已经说出来的留着，轮次按 aborted 收尾", async () => {
    const child = startCodexChild({ server: { turns: [[{ kind: "reply", text: "说到一半" }, { kind: "hang" }]] } });
    await child.log.next("ready");
    child.send({ type: "user_input", inputId: "in-1", text: "干活" });
    await child.log.next("stream_delta");
    await expectCall(child, "turn/start");
    await activeTurnId(child);
    child.send({ type: "abort" });
    const end = await child.log.next("turn_end");
    expect(end.outcome).toBe("aborted");
    expect(child.server.callsOf("turn/interrupt")).toHaveLength(1);
    expect(child.log.ofType("message_final").at(-1)!.message).toMatchObject({ parts: [{ type: "text", text: "说到一半" }], stopReason: "aborted" });
  });

  it("手动压缩：thread/compact/start，装配了范围审视的先报 compacting，压完报 compacted；还没开始过的是 nothing", async () => {
    const child = startCodexChild({
      session: { scopeReview: { model: { kind: "faux", script: [] }, instructions: "", recorded: true } as never },
      server: { turns: [[{ kind: "reply", text: "好" }]] },
    });
    await child.log.next("ready");
    child.send({ type: "compact" });
    expect(await child.log.next("compacted")).toMatchObject({ reason: "manual", outcome: "nothing" });
    await child.turn("in-1", "你好");
    child.send({ type: "compact" });
    expect(await child.log.next("compacting")).toEqual({ type: "compacting", reason: "manual" });
    expect(await child.log.next("compacted")).toMatchObject({ reason: "manual", outcome: "done" });
    expect(child.server.callsOf("thread/compact/start")).toHaveLength(1);
  });

  it("轮次中自动压缩：报 threshold，之后一直在的上下文再带一次", async () => {
    const child = startCodexChild({
      session: { contributions: { tools: [], contextBlocks: [], hooks: [{ id: "h1", kind: "system_prompt_suffix", text: "末尾的话" }] }, scopeReview: { recentRecords: "近期记录" } as never },
      server: { turns: [[{ kind: "echo" }, { kind: "compaction" }, { kind: "reply", text: "压过了" }], [{ kind: "echo" }], [{ kind: "echo" }]] },
    });
    await child.log.next("ready");
    await child.turn("in-1", "一");
    expect((await echoOf(child)).additionalContext).toEqual(["末尾的话\n\n近期记录"]);
    expect(child.log.ofType("compacted")).toMatchObject([{ reason: "threshold", outcome: "done" }]);
    await child.turn("in-2", "二");
    expect((await echoOf(child)).additionalContext).toEqual(["末尾的话\n\n近期记录"]);
    await child.turn("in-3", "三");
    expect((await echoOf(child)).additionalContext).toEqual([]);
  });

  it("写交接摘要（换运行时）：临时分叉上跑一轮，不进原来的会话，用量 purpose 是 handoff；工具不让用；还没开始过的报错", async () => {
    const child = startCodexChild({
      server: {
        turns: [[{ kind: "reply", text: "做了点事" }]],
        ephemeralSteps: [{ kind: "command", command: "echo hi", id: "h-1" }, { kind: "reply", text: "这是交接摘要", usage: { cacheHit: 0, cacheMiss: 50, output: 10 } }],
      },
    });
    const ready = await child.log.next("ready");
    child.send({ type: "write_handoff", requestId: "w-0", instructions: "写摘要", timeoutMs: 10_000 });
    expect((await child.log.next("handoff_written")).error).toBeDefined();
    await child.turn("in-1", "干活");
    child.send({ type: "write_handoff", requestId: "w-1", instructions: "写摘要", timeoutMs: 10_000 });
    expect(await child.log.next("handoff_written")).toMatchObject({ requestId: "w-1", text: "这是交接摘要" });
    expect(child.server.callsOf("thread/fork")).toMatchObject([{ threadId: ready.sessionId, ephemeral: true }]);
    // 没进回复、原来的会话没多一轮；临时分叉里的命令被挡了、没发 guard_request
    expect(child.log.ofType("message_final")).toHaveLength(1);
    expect(child.log.ofType("guard_request")).toHaveLength(0);
    expect(child.server.executed).toEqual([]);
    expect(child.server.toolResults.get("h-1")).toContain("只写交接摘要");
    expect(child.server.store.threads[ready.sessionId]!.turns).toHaveLength(1);
    expect(child.log.ofType("usage").at(-1)).toMatchObject({ purpose: "handoff", input: 50, output: 10 });
    expect((await child.turn("in-2", "接着")).outcome).toBe("completed");
  });

  it("换模型：接着的会话模型和选的不一样，带 handoff 就旧模型写摘要、新模型新开，摘要进下一条输入；不带 handoff 报 differs", async () => {
    const server = new FakeCodexServer({ turns: [[{ kind: "reply", text: "旧模型做的" }], [{ kind: "echo" }]] });
    const sessionDir = makeTempDir("ergo-codex-sessions-");
    const first = startCodexChild({ server, session: { sessionDir } });
    const ready = await first.log.next("ready");
    await first.turn("in-1", "干活");
    await first.shutdown(0);

    const noHandoff = startCodexChild({ server, session: { sessionDir, runtimeOptions: { model: "gpt-other" } } });
    expect((await noHandoff.log.next("ready")).model).toMatchObject({ differs: true, modelId: "gpt-fake" });
    await noHandoff.shutdown(0);

    const swapped = startCodexChild({ server, session: { sessionDir, runtimeOptions: { model: "gpt-other" }, handoff: { instructions: "写摘要", timeoutMs: 10_000 } } });
    const again = await swapped.log.next("ready");
    expect(again.handoff).toMatchObject({ from: { model: { modelId: "gpt-fake" } }, to: { modelId: "gpt-other" } });
    expect(again.handoff!.error).toBeUndefined();
    expect(again.sessionId).not.toBe(ready.sessionId);
    expect(again.model.differs).toBeUndefined();
    await swapped.turn("in-2", "接着");
    const echo = await echoOf(swapped);
    expect(echo.model).toBe("gpt-other");
    expect(echo.additionalContext.join("\n")).toContain("交接摘要");
    // 写摘要那次的用量 ready 之后才报
    expect(swapped.log.ofType("usage")[0]).toMatchObject({ purpose: "handoff" });
  });

  it("现在的模型用不了（真账号实测 modelNotFound）：写明去换；选了别的不写交接摘要（旧模型写不了）、任务中途也不卡住，新开 thread 用选的模型，之前的记录进上下文，用量记新模型", async () => {
    const server = new FakeCodexServer({
      turns: [
        [{ kind: "fail", message: "The 'gpt-fake' model is not supported when using Codex with a ChatGPT account.", codexErrorInfo: "modelNotFound" }],
        [{ kind: "fail", message: "The 'gpt-fake' model is not supported when using Codex with a ChatGPT account.", codexErrorInfo: "modelNotFound" }],
        [{ kind: "echo" }],
        [{ kind: "reply", text: "接着做", usage: { cacheHit: 0, cacheMiss: 100, output: 10 } }],
      ],
    });
    const sessionDir = makeTempDir("ergo-codex-sessions-");
    const first = startCodexChild({ server, session: { sessionDir } });
    const opened = await first.log.next("ready");
    const failed = await first.turn("in-1", "干活");
    expect(failed).toMatchObject({ outcome: "error", errorMessage: expect.stringContaining("点 ⚙ 换一个模型") });
    expect(failed.errorMessage).toContain("The 'gpt-fake' model is not supported");
    // 没选别的：照旧，不带 model
    expect((await first.turn("in-2", "再试")).outcome).toBe("error");
    expect(server.callsOf("thread/start")).toHaveLength(1);
    const oldThread = server.callsOf("turn/start").at(-1)?.threadId;
    await first.shutdown(0);

    const picked = startCodexChild({ server, session: { sessionDir, runtimeOptions: { model: "gpt-other" }, handoff: { instructions: "写摘要", timeoutMs: 10_000 } } });
    const ready = await picked.log.next("ready");
    expect(ready.handoff).toBeUndefined();
    expect(ready.model.differs).toBeUndefined();
    expect(ready.sessionId).toBe(opened.sessionId);
    await picked.turn("in-3", "接着");
    const echo = await echoOf(picked);
    expect(echo.model).toBe("gpt-other");
    expect(echo.thread).not.toBe(oldThread);
    expect(server.callsOf("thread/start").at(-1)).toMatchObject({ model: "gpt-other" });
    // 第一轮交代的事进了新 thread 的上下文
    expect(echo.additionalContext.join("\n")).toContain("用户：干活");
    expect(echo.additionalContext.join("\n")).toContain("换成 gpt-other 新开了会话");
    // 换成了：下一轮接着这个 thread，不再新开；用量记新模型
    await picked.turn("in-4", "再来");
    expect(server.callsOf("turn/start").at(-1)?.threadId).toBe(echo.thread);
    expect(server.callsOf("thread/start").filter((call) => call.model === "gpt-other")).toHaveLength(1);
    expect(picked.log.ofType("usage").at(-1)).toMatchObject({ modelId: "gpt-other" });
  });

  it("撤回带上这个会话的模型（实测 thread/fork 不带就回到配置里的）；撤回到开头新开的也是", async () => {
    const server = new FakeCodexServer({ turns: [[{ kind: "reply", text: "一" }], [{ kind: "reply", text: "二" }], [{ kind: "echo" }], [{ kind: "echo" }]] });
    const child = startCodexChild({ server, session: { runtimeOptions: { model: "gpt-other" } } });
    await child.log.next("ready");
    await child.turn("in-1", "第一句");
    await child.turn("in-2", "第二句");
    child.send({ type: "navigate_session", requestId: "nav-1", target: { beforeInput: "in-2" }, marker: { change: "rewind", entry: "m", at: "2026-11-02T00:00:00.000Z" } } as never);
    await child.log.next("session_navigated");
    expect(server.callsOf("thread/fork").at(-1)).toMatchObject({ model: "gpt-other" });
    await child.turn("in-3", "撤回后");
    expect((await echoOf(child)).model).toBe("gpt-other");
    child.send({ type: "navigate_session", requestId: "nav-2", target: { beforeInput: "in-1" }, marker: { change: "rewind", entry: "m", at: "2026-11-02T00:00:00.000Z" } } as never);
    await child.log.next("session_navigated");
    expect(server.callsOf("thread/start").at(-1)).toMatchObject({ model: "gpt-other" });
    await child.turn("in-4", "撤回到开头后");
    expect((await echoOf(child)).model).toBe("gpt-other");
  });

  it("现在的模型用不了、读不到之前的记录：照样换，日志写明", async () => {
    const server = new FakeCodexServer({
      turns: [[{ kind: "fail", message: "not supported", codexErrorInfo: "modelNotFound" }], [{ kind: "echo" }]],
    });
    const sessionDir = makeTempDir("ergo-codex-sessions-");
    const first = startCodexChild({ server, session: { sessionDir } });
    await first.log.next("ready");
    await first.turn("in-1", "干活");
    await first.shutdown(0);
    server.failing.add("thread/turns/list");
    const picked = startCodexChild({ server, session: { sessionDir, runtimeOptions: { model: "gpt-other" } } });
    await picked.log.next("ready");
    await picked.turn("in-2", "接着");
    expect((await echoOf(picked)).model).toBe("gpt-other");
    expect(picked.logs.join("\n")).toContain("新 thread 没有前情");
  });

  it("没登录：这一轮按出错收尾、写清怎么登录，关掉 app-server；登录之后下一条输入重新起、接着做", async () => {
    const child = startCodexChild({ server: { account: null, turns: [[{ kind: "reply", text: "登录了" }]] } });
    await child.log.next("ready");
    const end = await child.turn("in-1", "干活");
    expect(end).toMatchObject({ outcome: "error", errorMessage: expect.stringContaining("codex login") });
    expect(child.server.callsOf("turn/start")).toHaveLength(0);
    child.server.account = "apiKey";
    expect((await child.turn("in-2", "再来")).outcome).toBe("completed");
    expect(child.server.spawns.length).toBeGreaterThanOrEqual(2);
    // API key 登录记成 codex-api-key（消耗页写明按量计费）
    expect(child.log.ofType("usage")).toMatchObject([{ provider: "codex-api-key" }]);
  });

  it("额度用完：这一轮按出错收尾，写明额度用完", async () => {
    const child = startCodexChild({ server: { turns: [[{ kind: "fail", message: "You hit your usage limit", codexErrorInfo: "usageLimitExceeded" }]] } });
    await child.log.next("ready");
    const end = await child.turn("in-1", "干活");
    expect(end.outcome).toBe("error");
    expect(end.errorMessage).toContain("额度用完");
    expect(end.errorMessage).toContain("You hit your usage limit");
  });

  it("app-server 自己退出：手头这一轮按出错收尾，下一条输入重新起、按 id 恢复", async () => {
    const child = startCodexChild({ server: { turns: [[{ kind: "reply", text: "第一轮" }], [{ kind: "hang" }], [{ kind: "reply", text: "恢复了" }]] } });
    const ready = await child.log.next("ready");
    await child.turn("in-1", "一");
    child.send({ type: "user_input", inputId: "in-2", text: "二" });
    await waitFor(() => child.server.connection.active !== undefined);
    child.server.connection.crash();
    const end = await child.log.next("turn_end");
    expect(end).toMatchObject({ outcome: "error", errorMessage: "Codex 的进程结束了" });
    expect((await child.turn("in-3", "三")).outcome).toBe("completed");
    expect(child.server.callsOf("thread/resume")).toMatchObject([{ threadId: ready.sessionId }]);
    expect(child.server.spawns.length).toBeGreaterThanOrEqual(2);
  });

  it("接着的会话别的进程开着（写入锁）：start_failed 写清楚先去关掉或者分叉，不把 Codex 的原话交给用户", async () => {
    const store = new FakeCodexStore();
    store.addThread({ id: "open-1", cwd: "D:\\work" });
    store.activeWriters.add("open-1");
    const child = startCodexChild({ server: { store }, session: { resumeRuntimeSession: "open-1", continueSession: false } });
    const error = await child.log.next("error");
    expect(error).toMatchObject({ code: "start_failed", fatal: true, message: expect.stringContaining("先在那边关掉，或者分叉一份接管") });
    expect((error as { message: string }).message).not.toContain("active writer");
  });

  it("子代理的模型调用也记用量（各算各的累计），另起 messageId；登录过期（带状态码的 401）写明要登录、429 写明额度", async () => {
    const child = startCodexChild({
      server: {
        turns: [
          [{ kind: "collab", id: "c-1", steps: [{ kind: "reply", text: "子代理说的", usage: { cacheHit: 0, cacheMiss: 70, output: 7 } }] }, { kind: "reply", text: "好", usage: { cacheHit: 0, cacheMiss: 10, output: 1 } }],
          [{ kind: "fail", message: "unexpected status 401", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } as never }],
          [{ kind: "fail", message: "unexpected status 429", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } } as never }],
        ],
      },
    });
    child.answerGuard();
    await child.log.next("ready");
    expect((await child.turn("in-1", "派一个")).outcome).toBe("completed");
    const usage = child.log.ofType("usage");
    expect(usage.map((u) => u.input + u.output)).toEqual([77, 11]);
    expect(new Set(usage.map((u) => u.messageId)).size).toBe(2);
    expect((await child.turn("in-2", "再来")).errorMessage).toContain("codex login");
    expect((await child.turn("in-3", "再来")).errorMessage).toContain("额度用完");
  });

  it("子代理：它的工具调用带 parentToolCallId，挂在派它的那次下面；正文不当成回复", async () => {
    const child = startCodexChild({
      server: { turns: [[{ kind: "collab", id: "c-1", steps: [{ kind: "reply", text: "子代理说的" }, { kind: "command", command: "git status", id: "sub-1", approval: false }] }, { kind: "reply", text: "子代理做完了" }]] },
    });
    child.answerGuard();
    await child.log.next("ready");
    expect((await child.turn("in-1", "派一个")).outcome).toBe("completed");
    const starts = child.log.ofType("tool_call_start");
    expect(starts.map((s) => [s.toolCallId, s.toolName, s.parentToolCallId])).toEqual([
      ["c-1", "spawnAgent", undefined],
      ["sub-1", "bash", "c-1"],
    ]);
    expect(child.log.ofType("tool_call_end").find((e) => e.toolCallId === "sub-1")).toMatchObject({ parentToolCallId: "c-1", isError: false });
    expect(child.log.ofType("message_final").flatMap((m) => m.message.parts.filter((p) => p.type === "text"))).toEqual([{ type: "text", text: "子代理做完了" }]);
  });

  it("Codex 自己要问用户：报 ask_user，回答按它的写法交回；没答的交回空", async () => {
    const child = startCodexChild({ server: { turns: [[{ kind: "ask", id: "a-1", question: "选哪个？", options: ["甲", "乙"] }, { kind: "reply", text: "好" }]] } });
    await child.log.next("ready");
    child.send({ type: "user_input", inputId: "in-1", text: "问我" });
    const ask = await child.log.next("ask_user");
    expect(ask).toMatchObject({ toolCallId: "a-1", question: { kind: "choices", questions: [{ question: "选哪个？", options: [{ label: "甲" }, { label: "乙" }] }] } });
    child.send({ type: "ask_user_reply", requestId: ask.requestId, reply: { kind: "choices", answers: [{ question: "选哪个？", selected: ["乙"] }] } });
    expect((await child.log.next("turn_end")).outcome).toBe("completed");
    expect(child.server.toolResults.get("a-1")).toBe(JSON.stringify({ q1: { answers: ["乙"] } }));
  });

  it("宿主协议版本对不上：start_failed，退出码 1；不支持的命令回 unsupported、不崩；scope_review 回没做成；yield 收下不管", async () => {
    const bad = startCodexChild({ protocolVersion: HOST_PROTOCOL_VERSION + 1 });
    expect(await bad.log.next("error")).toMatchObject({ code: "start_failed", fatal: true });
    await waitFor(() => bad.exitCode() === 1);

    const child = startCodexChild();
    await child.log.next("ready");
    child.send({ type: "toolkit", contributions: { tools: [], contextBlocks: [], hooks: [] }, toolkit: {} } as never);
    expect((await child.log.next("error")).code).toBe("unsupported");
    child.send({ type: "yield" } as never);
    child.send({ type: "scope_review", requestId: "r-1" } as never);
    expect(await child.log.next("scope_review_result")).toMatchObject({ requestId: "r-1", error: expect.any(String) });
  });
});

async function waitFor(ok: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error("等太久了");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const expectCall = (child: CodexChild, method: string) => waitFor(() => child.server.callsOf(method).length > 0);

async function activeTurnId(child: CodexChild): Promise<string> {
  await waitFor(() => child.server.connection.active !== undefined);
  const id = child.server.connection.active!.id;
  // 等这一轮的 id 到了适配子进程（turn/started 通知、turn/start 的回复）
  await new Promise((resolve) => setTimeout(resolve, 50));
  return id;
}
