// 主切面：第一次装二狗的人能跑起来（315 号票）。站在陌生人的角度：数据目录还不存在、没有模型 key、没装 Claude Code 的 Agent SDK——
// - 守护进程照常起来，自己把数据目录建好；网页能打开；
// - 模型的 key 没配：GET /api/model-settings/key 说没配（会话页据此出"还没配模型……去配置"），跟二狗说话时回"还没配模型、去设置 · 模型看怎么配"，
//   不是 pi 的英文报错；
// - Claude Code 插件：SDK 没装时不装配，设置 · 插件里写"没装"和怎么装（启用不了），运行时写同一句；别的插件照常运行；装好后点启用就装上；
// - 8810 / 8811 被占：像 LSM 那样拉起真入口（main.ts），一句话说清是谁占着、怎么改端口，以退出码 1 退出、不碰数据目录；
// - 新装时两样收紧（315 号票第 3 步，用户 2026-10-27 定）：对话审批开着、任务的预算控制开着，明着写进配置文件（已写的键不碰）；
//   已有的数据目录（有事件库）里没写的照旧关着、不写配置；设置里的两个开关（GET / PUT /api/safety-settings）改了写回配置、马上生效。
// 都在临时目录、系统挑的空闲端口上（不碰 8810 / 8811 和真的 ~/.ergo），模型请求发往本机的假 DeepSeek（没 key 时一次都不该发），
// Claude Code 的"装没装"是注入的（不用真去卸 SDK）。
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { CHANNELS, EVENT_TYPES, type MessageEventPayload, type MessagePart, type Plan } from "@ergo/protocol";
import { describe, expect, it, onTestFinished } from "vitest";
import { CLAUDE_CODE_PLUGIN, CLAUDE_CODE_RUNTIME_ID } from "../../src/claude-code/api.ts";
import { createClaudeCodePlugin } from "../../src/claude-code/plugin.ts";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { startTestDaemon, writeConfig } from "../helpers/daemon.ts";
import { startFakeDeepSeek } from "../helpers/fake-deepseek.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { modelSettingsApi, pluginsApi, request, runtimesApi, safetyApi } from "../helpers/http.ts";
import { writePortsConfig } from "../helpers/ports.ts";
import { killIfRunning } from "../helpers/process.ts";
import { call, completeStage, confirmTask, connect, maintainerScript, say, tasksOf, taskWhere, twoStagePlan, write } from "../helpers/task-flow.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { NO_LSM_ENV, tempUserProfileEnv, withEnv } from "../helpers/user-profile.ts";
import { realPathOf } from "../../src/util/real-path.ts";

const SRC = path.resolve(import.meta.dirname, "../../src");
const SDK_COMMAND = /npm install --no-save @anthropic-ai\/claude-agent-sdk@\d+\.\d+\.\d+/;

describe("第一次装：空数据目录、没有模型 key、没装 Claude Code 的 SDK", () => {
  it("守护进程起来、建好数据目录、网页能开；跟二狗说话回'还没配模型、去哪配'；Claude Code 写'没装'和怎么装，别的插件照常，装好后能启用", { timeout: 90_000 }, async () => {
    const fake = await startFakeDeepSeek();
    const logs: string[] = [];
    let sdkInstalled = false;
    const td = await startTestDaemon({
      fresh: true,
      modelsFromSettings: ["secretary"],
      catalogBaseUrl: fake.baseUrl,
      env: { DEEPSEEK_API_KEY: undefined },
      extraPlugins: [createClaudeCodePlugin({ sdkInstalled: () => sdkInstalled })],
      log: (line) => logs.push(line),
    });

    // 数据目录是守护进程自己建的
    const layout = dataDirLayout(td.dataDir);
    for (const dir of [layout.root, layout.config, layout.db, layout.tmp]) expect(fs.statSync(dir).isDirectory()).toBe(true);
    expect(logs.join("\n")).toContain(`数据目录 ${layout.root} 还没有，新建一个`);
    // 新装：对话审批、预算控制两样收紧，明着写进配置文件；设置里看到的是开着
    expect(JSON.parse(fs.readFileSync(layout.configFile, "utf8"))).toEqual({ guard: { conversationApprovals: "on" }, tasks: { thresholds: { budgetControl: true } } });
    expect(logs.join("\n")).toContain(`新装：在配置文件 ${layout.configFile} 里打开了 guard.conversationApprovals、tasks.thresholds.budgetControl`);
    expect((await safetyApi.view(td.url)).body).toEqual({ conversationApprovals: true, budgetControl: true });
    // 网页能开
    const page = await request(td.url, "/");
    expect(page.status).toBe(200);
    expect(page.body.toString("utf8")).toContain("二狗测试页");

    // 模型的 key 没配：接口说没配、是哪家
    const key = await modelSettingsApi.key(td.url);
    expect(key.status).toBe(200);
    expect(key.body).toEqual({ provider: { id: "deepseek", label: "DeepSeek" }, apiKey: { configured: false, envVar: "DEEPSEEK_API_KEY", secretFile: "secrets/deepseek-api-key.txt", lsm: false } });

    // 跟二狗说话：回"还没配模型、去设置 · 模型看怎么配"，不是 pi 的英文报错；一次请求都没发给模型服务
    const frontend = await TestFrontend.connect(td.url);
    await frontend.sendText("在吗");
    let note = "";
    for (const deadline = Date.now() + 30_000; note === "" && Date.now() < deadline; ) {
      for (const m of (await frontend.history(CHANNELS.secretary)).messages) {
        if ("message" in m && m.message.speaker === "system") note = m.message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
      }
      if (note === "") await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(note).toContain("这次没能回复：还没配模型：没有 DeepSeek 的 API Key。去「设置 · 模型」看怎么配");
    expect(note).not.toMatch(/No API key|\/login/);
    expect(fake.requests).toHaveLength(0);

    // Claude Code：没装（写着怎么装）、启用不了；别的插件照常在运行
    const plugins = (await pluginsApi.view(td.url)).body.plugins;
    const cc = plugins.find((p) => p.name === CLAUDE_CODE_PLUGIN)!;
    expect(cc).toMatchObject({ state: "skipped", missing: true });
    expect(cc.problem).toContain("没装 Claude Code 的 Agent SDK");
    expect(cc.problem).toMatch(SDK_COMMAND);
    expect(cc.cannotEnable).toBe(cc.problem);
    expect(plugins.filter((p) => p.name !== CLAUDE_CODE_PLUGIN).map((p) => [p.name, p.state])).toEqual(plugins.filter((p) => p.name !== CLAUDE_CODE_PLUGIN).map((p) => [p.name, "running"]));
    const refused = await pluginsApi.act(td.url, CLAUDE_CODE_PLUGIN, { action: "enable", idempotencyKey: "enable-missing" });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toContain("没装 Claude Code 的 Agent SDK");
    // 新建任务、项目时的运行时清单：Claude Code 写同一句（不是"没启用"）
    const runtime = (await runtimesApi.view(td.url)).body.runtimes.find((r) => r.id === CLAUDE_CODE_RUNTIME_ID)!;
    expect(runtime.available).toBe(false);
    expect(runtime.unavailable).toMatch(SDK_COMMAND);

    // 装好了：点启用就装上，运行时能用了
    sdkInstalled = true;
    const enabled = await pluginsApi.act(td.url, CLAUDE_CODE_PLUGIN, { action: "enable", idempotencyKey: "enable-installed" });
    expect(enabled.status).toBe(200);
    expect(enabled.body.plugins.find((p) => p.name === CLAUDE_CODE_PLUGIN)).toMatchObject({ state: "running" });
    expect(enabled.body.plugins.find((p) => p.name === CLAUDE_CODE_PLUGIN)?.missing).toBeUndefined();
    expect((await runtimesApi.view(td.url)).body.runtimes.find((r) => r.id === CLAUDE_CODE_RUNTIME_ID)).toMatchObject({ available: true });
  });
});

describe("端口被占（像 LSM 那样拉起真入口）", () => {
  it("本机端口、外网端口被占着：一句话说清是谁占着、怎么改端口，以退出码 1 退出，不碰数据目录", { timeout: 60_000 }, async () => {
    for (const which of ["local", "external"] as const) {
      const dataDir = makeTempDir("ergo-data-");
      const homeDir = makeTempDir("ergo-home-");
      const ports = await writePortsConfig(dataDir);
      const port = ports[which];
      // 测试进程自己占着这个端口
      const holder = net.createServer();
      await new Promise<void>((resolve) => holder.listen(port, "127.0.0.1", resolve));
      onTestFinished(() => new Promise<void>((resolve) => holder.close(() => resolve())));

      const env = withEnv(process.env, NO_LSM_ENV, tempUserProfileEnv(homeDir), { ERGO_DATA_DIR: dataDir, DEEPSEEK_API_KEY: undefined });
      const child = spawn(process.execPath, [path.join(SRC, "main.ts")], { env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
      onTestFinished(() => {
        killIfRunning(child);
      });
      let stderr = "";
      child.stderr!.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
      const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));

      expect(code).toBe(1);
      const name = which === "local" ? "本机端口" : "外网端口";
      expect(stderr).toContain(`${name} ${port} 被占着：node.exe（PID ${process.pid}），二狗起不来。`);
      expect(stderr).toContain(`在配置文件 ${dataDirLayout(dataDir).configFile} 里换一个端口`);
      expect(stderr).toContain('"ports"');
      // 一句话：没有调用栈
      expect(stderr).not.toMatch(/\n\s+at /);
      // 没碰数据目录：没建库、没写 pid 文件
      expect(fs.existsSync(dataDirLayout(dataDir).db)).toBe(false);
      expect(fs.existsSync(dataDirLayout(dataDir).pidFile)).toBe(false);
    }
  });
});

/** 秘书这一轮里的工具调用块 */
type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;
const secretaryToolParts = (frontend: TestFrontend): ToolCallPart[] =>
  frontend
    .events({ channel: CHANNELS.secretary, type: EVENT_TYPES.message })
    .map((f) => (f.payload as MessageEventPayload).message)
    .flatMap((m) => m.parts.filter((p): p is ToolCallPart => p.type === "tool_call"));
const configOf = (dataDir: string) => JSON.parse(fs.readFileSync(dataDirLayout(dataDir).configFile, "utf8")) as Record<string, unknown>;

describe("新装的默认值收紧（315 号票第 3 步）：对话审批、任务的预算控制；设置里能关", () => {
  it("新装（还没有事件库）：两样写进配置文件，已写的键不碰；守卫按开着判（读工作区外的文件出审批卡）；设置里关掉马上生效、写回配置，同样的调用直接做", { timeout: 90_000 }, async () => {
    const dataDir = makeTempDir("ergo-data-");
    const homeDir = makeTempDir("ergo-home-");
    // 安装时（或用户自己）先写好的几项：照旧
    writeConfig(dataDir, { approvals: { waitMinutes: 0.02 }, tasks: { maxRunning: 2 } });
    const outside = realPathOf(makeTempDir("ergo-outside-"))!;
    fs.writeFileSync(path.join(outside, "notes.txt"), "外面的笔记");
    const read = path.join(outside, "notes.txt");
    // 秘书的剧本：读一次工作区外的文件、看结果（开关一改秘书按新的系统提示重新拉起，剧本从头再来一遍）
    const td = await startTestDaemon({ reuse: { dataDir, homeDir }, keepConfig: true, secretary: [call("read", { path: read }), { kind: "echo_context" }] });
    expect(configOf(dataDir)).toEqual({ approvals: { waitMinutes: 0.02 }, tasks: { maxRunning: 2, thresholds: { budgetControl: true } }, guard: { conversationApprovals: "on" } });
    expect(td.daemon.config.guard.conversationApprovals).toBe("on");
    expect((await safetyApi.view(td.url)).body).toEqual({ conversationApprovals: true, budgetControl: true });

    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [CHANNELS.secretary]: 0, [CHANNELS.cards]: 0 });
    await frontend.sendText("看看那份笔记");
    await frontend.next(CHANNELS.secretary, EVENT_TYPES.turnEnd);
    expect(secretaryToolParts(frontend).map((p) => [p.tool, p.disposition, p.outcome])).toEqual([["read", "ask_first", "blocked"]]);
    expect(td.daemon.approvals.list().map((a) => a.status)).toEqual(["pending"]);

    // 设置里关掉"先问我"：写回配置文件（别的照旧），马上生效
    const off = await safetyApi.change(td.url, { conversationApprovals: false });
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ conversationApprovals: false, budgetControl: true });
    expect(configOf(dataDir)).toEqual({ approvals: { waitMinutes: 0.02 }, tasks: { maxRunning: 2, thresholds: { budgetControl: true } }, guard: { conversationApprovals: "off" } });
    await frontend.sendText("再看一遍");
    await frontend.next(CHANNELS.secretary, EVENT_TYPES.turnEnd);
    expect(secretaryToolParts(frontend).map((p) => [p.tool, p.disposition, p.outcome])).toEqual([
      ["read", "ask_first", "blocked"],
      ["read", "do", "done"],
    ]);
    expect(td.daemon.approvals.list().map((a) => a.status)).toEqual(["pending"]);
    // 参数不对的拒收
    expect((await safetyApi.change(td.url, {})).status).toBe(400);
    expect((await safetyApi.change(td.url, { budgetControl: "on" })).status).toBe(400);
  });

  it("已有的数据目录（有事件库）、配置里没写这两项：照旧是现在的默认（都关着），不往配置里写", { timeout: 60_000 }, async () => {
    const first = await startTestDaemon({});
    const { dataDir, homeDir } = first;
    await first.daemon.stop();
    // 老用户的配置：没写 guard、tasks（测试底座写的拿掉）
    const { guard: _g, tasks: _t, ...rest } = configOf(dataDir);
    fs.writeFileSync(dataDirLayout(dataDir).configFile, JSON.stringify(rest));
    const td = await startTestDaemon({ reuse: { dataDir, homeDir }, keepConfig: true });
    expect(td.daemon.config.guard.conversationApprovals).toBe("off");
    expect(td.daemon.config.tasks.thresholds.budgetControl).toBe(false);
    expect((await safetyApi.view(td.url)).body).toEqual({ conversationApprovals: false, budgetControl: false });
    expect(configOf(dataDir)).toEqual(rest);
  });

  it("新装时预算控制开着：任务的工具调用超出预算 2 倍就停下（转等我）；设置里关掉后，同样的任务做下去不停", { timeout: 120_000 }, async () => {
    const base = twoStagePlan();
    const plan: Plan = { ...base, stages: [{ ...base.stages[0]!, budget: { tokens: 0, toolCalls: 1 } }, base.stages[1]!] };
    const td = await startTestDaemon({
      fresh: true,
      // 两个任务的维护者都照这一份：第 3 次调用之后超过预算的 2 倍
      maintainer: maintainerScript(plan, [write("a.md", "a"), write("b.md", "b"), write("c.md", "c"), write("sources.md", "- 来源\n"), completeStage("s1"), say("交了"), say("知道了"), say("等你"), say("好")]),
    });
    const frontend = await connect(td.url, 2);
    const first = await confirmTask(td, frontend, "超了就停");
    await taskWhere(frontend, (e) => e.task.id === first && e.change === "waiting" && e.task.waitReason === "over_budget", "第一个任务转等我（超预算）");

    expect((await safetyApi.change(td.url, { budgetControl: false })).body).toEqual({ conversationApprovals: true, budgetControl: false });
    expect(configOf(td.dataDir)).toMatchObject({ tasks: { thresholds: { budgetControl: false } } });
    const second = await confirmTask(td, frontend, "超了也做");
    await taskWhere(frontend, (e) => e.task.id === second && e.change === "stage_accepted" && e.stageId === "s1", "第二个任务的 s1 验收通过");
    expect(tasksOf(frontend).some((e) => e.task.id === second && e.task.waitReason === "over_budget")).toBe(false);
    expect(td.daemon.tasks.get(first)).toMatchObject({ state: "waiting_for_user", waitReason: "over_budget" });
  });
});
