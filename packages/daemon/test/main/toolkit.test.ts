// 主切面：skill 库、MCP 登记与工具包（27 号票，规格第 3、11、20、21 节）。
// - skill 库：列出框架自带的和数据目录 skill 区里的；设置里导入的复制一份进 skill 区，能写进工具包；~/.claude/skills 里的不出现；
// - 维护者的会话严格按工具包装配：只有工具包列的 skill（skillPaths），bash、MCP、联网照开关；用户目录里的 skill 一个都没有；
// - 工具包一变立即生效：维护者正在干活时等它做完手头这一步（当前的工具调用结束、下一次模型调用之前）就重启子进程、
//   按新工具包重新装配、从会话文件接着干，下一次模型调用里就是新的；
// - 维护者自己增减 skill（记进时间线）；不在任务里时要加能力提交"工具包变更"卡，批准后才扩大；
// - 用户在项目页、任务详情里直接改工具包，不出计划变更卡；
// - MCP：服务进程由守护进程拉起、放进 Job 对象、按登记注入凭据；agent 和它的孙进程碰不到凭据；调用先过守卫再转发；
// - 秘书的快速动作"调用 MCP 工具"。
import fs from "node:fs";
import path from "node:path";
import {
  CHANNELS,
  type Card,
  EVENT_TYPES,
  maintainerChannel,
  METHODS,
  type Plan,
  type PlanChangeCardPayload,
  planChangeItemText,
  type ProjectEventPayload,
  type TaskPlanEventPayload,
  type ToolkitChangeCardPayload,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import type { FauxStep } from "../../src/runtime/index.ts";
import { REDACTED_SECRET } from "../../src/guard/index.ts";
import { BUILTIN_SKILLS_DIR } from "../../src/skills/library.ts";
import { byMaintainer, internalTask } from "../helpers/projects.ts";
import { countAgentSpawns, startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { toolsNow } from "../helpers/echo.ts";
import { submitPlanStep } from "../helpers/plans.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { isProcessAlive, waitUntil } from "../helpers/process.ts";
import { saveOrCheckRecording } from "../helpers/recording.ts";
import { settled } from "../helpers/settled.ts";
import { call, cardsOf, cardWhere, confirmTask, eventually, inboxOf, inputsDone, messagesOf, ok, recordsOf, say, taskWhere, textOf, toolCallsOf, twoStagePlan } from "../helpers/task-flow.ts";
import { startKillableDaemon, survivors } from "../helpers/killable-daemon.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { MCP_TOKEN, MCP_TOKEN_ENV, mcpLog, seedToolkitProject, toolkit, toolkitApi, writeMcpRegistration, writeSkill } from "../helpers/toolkit.ts";

const PM1 = maintainerChannel("pm-1");
const TM1 = maintainerChannel("tm-1");

/** 看板上推的现在生效的计划 */
const taskPlansOf = (frontend: TestFrontend) => frontend.events({ channel: CHANNELS.board, type: EVENT_TYPES.taskPlan }).map((f) => f.payload as TaskPlanEventPayload);
const cardsOfType = (frontend: TestFrontend, type: string) => cardsOf(frontend).filter((c) => c.type === type);

/** 维护者交的计划（本任务的关注类别、用户的限制、定时作业、记忆范围沿用当前计划，不写） */
function draftOf(plan: Plan): Record<string, unknown> {
  const { watchCategories: _w, userLimits: _u, memoryScope: _m, ...rest } = plan;
  return rest;
}
const echo: FauxStep = { kind: "echo_context" };

/** 维护者会话里 agent 的回复（echo_context 回的是它看到的上下文） */
const repliesOf = (frontend: TestFrontend, channel: string) =>
  messagesOf(frontend, channel)
    .filter((m) => m.message.speaker === "agent" && m.message.parts.some((p) => p.type === "text"))
    .map(textOf);

/** 等维护者回出第 n 条（从 1 起）回复 */
async function nthReply(frontend: TestFrontend, channel: string, n: number): Promise<string> {
  await waitUntil(() => repliesOf(frontend, channel).length >= n, {
    timeoutMs: 30_000,
    describe: () => `等 ${channel} 的第 ${n} 条回复；会话里现在是：\n${messagesOf(frontend, channel).map((m) => `${m.message.speaker}: ${textOf(m).slice(0, 300)}`).join("\n")}`,
  });
  return repliesOf(frontend, channel)[n - 1]!;
}

/** 上下文里系统提示的最新样子：从最后一条 [system] 起（换了工具包时 pi 追加一条系统消息，按段替换） */
const latestSystem = (seen: string) => seen.slice(seen.lastIndexOf("[system]"));
/** 此刻能用的工具那几行：开头那一份（换了工具包接着会话也是开头一份、按这次交的先后，会话中途不列增减，273 号票） */
const toolLines = (seen: string) => toolsNow(seen).map((name) => `[tool] ${name}`);

async function connect(td: TestDaemon, channels: string[] = []) {
  const frontend = await TestFrontend.connect(td.url);
  await frontend.subscribe(Object.fromEntries([CHANNELS.projects, CHANNELS.cards, CHANNELS.inbox, CHANNELS.board, PM1, ...channels].map((c) => [c, 0])));
  return frontend;
}

/** 测试机的用户目录（临时的 HOME、USERPROFILE）里预先放的 skill：二狗不读它们 */
function plantHomeSkills(homeDir: string): string[] {
  writeSkill(path.join(homeDir, ".claude", "skills", "habit-tracker"), "habit-tracker", "MARKER_HOME_HABIT_TRACKER");
  writeSkill(path.join(homeDir, ".pi", "agent", "skills", "pi-home"), "pi-home", "MARKER_HOME_PI_SKILL");
  fs.writeFileSync(path.join(homeDir, ".pi", "agent", "settings.json"), JSON.stringify({ skills: [path.join(homeDir, ".claude", "skills")] }));
  return ["MARKER_HOME_HABIT_TRACKER", "MARKER_HOME_PI_SKILL"];
}

describe("skill 库", () => {
  it("列出框架自带的和数据目录 skill 区里的；从 skill 库页导入的复制一份进 skill 区、能被列出、能写进工具包；~/.claude/skills 里的不出现", async () => {
    const td = await startTestDaemon();
    plantHomeSkills(td.homeDir);
    const before = await toolkitApi.catalog(td.url);
    expect(before.status).toBe(200);
    expect(before.body.skills).toEqual([expect.objectContaining({ name: "example-checklist", origin: "framework" })]);
    expect(fs.existsSync(path.join(BUILTIN_SKILLS_DIR, "example-checklist", "SKILL.md"))).toBe(true);

    // 导入用户目录里的一个现成 skill（显式导入才有）
    const source = path.join(td.homeDir, ".claude", "skills", "habit-tracker");
    const imported = await toolkitApi.importSkill(td.url, source);
    expect(imported).toMatchObject({ status: 200, body: { skills: [{ name: "habit-tracker", origin: "imported" }], report: [{ name: "habit-tracker", ok: true }] } });
    const copied = path.join(td.dataDir, "skills", "habit-tracker", "SKILL.md");
    expect(fs.readFileSync(copied, "utf8")).toContain("MARKER_HOME_HABIT_TRACKER");
    // 复制的是一份：删掉来源，库里照样有
    fs.rmSync(source, { recursive: true });
    const after = await toolkitApi.catalog(td.url);
    expect(after.body.skills.map((s) => [s.name, s.origin])).toEqual([
      ["example-checklist", "framework"],
      ["habit-tracker", "imported"],
    ]);
    // 数据目录 skill 区里直接放的也算
    writeSkill(path.join(td.dataDir, "skills", "notes-style"), "notes-style", "笔记的写法");
    expect((await toolkitApi.catalog(td.url)).body.skills.map((s) => s.name)).toEqual(["example-checklist", "habit-tracker", "notes-style"]);

    // 同名的（说清和谁重名）、没有 SKILL.md 的导入被拒
    expect(await toolkitApi.importSkill(td.url, path.join(td.dataDir, "skills", "notes-style"))).toMatchObject({ status: 400 });
    const again = writeSkill(path.join(makeTempDir("ergo-skill-src-"), "habit-tracker"), "habit-tracker", "又一个");
    expect(await toolkitApi.importSkill(td.url, again)).toMatchObject({ status: 400, body: { message: expect.stringContaining("habit-tracker 和你导入的 habit-tracker 重名") } });
    expect(await toolkitApi.importSkill(td.url, makeTempDir("ergo-empty-"))).toMatchObject({ status: 400, body: { message: expect.stringContaining("SKILL.md") } });

    // 能写进项目的工具包；skill 库里没有的不能
    const project = seedToolkitProject(td.daemon, "笔记", toolkit());
    const frontend = await connect(td);
    expect(ok(await frontend.request(METHODS.setToolkit, { target: { kind: "project", projectId: project.id }, toolkit: toolkit({ skills: ["habit-tracker"] }) }, "k-set"))).toEqual({
      toolkit: toolkit({ skills: ["habit-tracker"] }),
      changed: true,
    });
    expect(await frontend.request(METHODS.setToolkit, { target: { kind: "project", projectId: project.id }, toolkit: toolkit({ skills: ["chart-maker"] }) }, "k-bad")).toMatchObject({
      ok: false,
      error: { code: "bad_params", message: expect.stringContaining("skill 库里没有 chart-maker") },
    });
  });
});

describe("按工具包装配维护者的会话", () => {
  it("项目维护者只加载工具包里的 skill（用户目录里的一个都没有），bash 关着时没有 bash 和带类型的 bash 工具；增减 skill 记进时间线，这次调用结束后重启子进程、按新名单接着原会话，下一次模型调用里就是新的", async () => {
    const td = await startTestDaemon({
      maintainer: (_id, spawn) =>
        spawn === 1
          ? [echo, call("adjust_skills", { add: ["example-checklist"], remove: ["notes-style"], why: "要列清单" }), say("不该走到这一步：这次调用结束后就重新装配了")]
          : [echo, say("好")],
    });
    const markers = plantHomeSkills(td.homeDir);
    writeSkill(path.join(td.dataDir, "skills", "notes-style"), "notes-style", "MARKER_NOTES_STYLE");
    seedToolkitProject(td.daemon, "笔记", toolkit({ skills: ["notes-style"] }));
    const frontend = await connect(td);

    await frontend.sendText("看看你有什么", { conversation: PM1 });
    const first = await nthReply(frontend, PM1, 1);
    expect(first).toContain("MARKER_NOTES_STYLE");
    expect(first).not.toContain("框架自带的示例 skill");
    for (const marker of markers) expect(first).not.toContain(marker);
    const tools = toolLines(first);
    expect(tools).toContain("[tool] read");
    expect(tools).toContain("[tool] adjust_skills");
    expect(tools).toContain("[tool] request_toolkit_change");
    expect(tools).not.toContain("[tool] bash");
    expect(tools.some((l) => l.includes("git_status_diff"))).toBe(false);

    await frontend.sendText("加上列清单的 skill", { conversation: PM1 });
    // 增减 skill 写进项目的工具包、记进时间线
    expect(await eventually(() => frontend.events({ channel: CHANNELS.projects, type: EVENT_TYPES.project }).map((f) => f.payload as ProjectEventPayload), (e) => e.change === "toolkit_changed", "项目的工具包变了")).toMatchObject({
      by: "maintainer",
      project: { toolkit: toolkit({ skills: ["example-checklist"] }) },
    });
    expect(await eventually(() => recordsOf(frontend, PM1), (r) => r.record.kind === "toolkit", "时间线上工具包变更的一笔")).toMatchObject({
      record: { summary: "维护者调整了 skill（要列清单）：加上 skill example-checklist；去掉 skill notes-style" },
      projectId: "p-1",
    });
    // 子进程重启（第 2 次唤起），接着原会话：下一次模型调用里就是新的 skill 名单，还看得到"工具包已变更"
    const second = await nthReply(frontend, PM1, 2);
    expect(second).toContain("看看你有什么");
    expect(second).toContain("[toolResult] adjust_skills: 已改：加上 skill example-checklist；去掉 skill notes-style");
    expect(second).toContain("工具包已变更（这一段的工具包改了）：加上 skill example-checklist；去掉 skill notes-style");
    const skillsNow = latestSystem(second);
    expect(skillsNow).toContain("框架自带的示例 skill");
    expect(skillsNow).not.toContain("MARKER_NOTES_STYLE");
    expect(second).not.toContain("不该走到这一步");
    // 那条输入算处理完（重启前后是同一轮），没有中断
    await waitUntil(() => frontend.events({ channel: PM1, type: EVENT_TYPES.turnEnd }).length >= 2);
    expect(frontend.events({ channel: PM1, type: EVENT_TYPES.turnEnd }).map((f) => (f.payload as { outcome: string }).outcome)).toEqual(["completed", "completed"]);
  });

  it("MCP：只有工具包授权了它的维护者会话里才有它的工具；服务进程由守护进程拉起、放进 Job、按登记注入凭据，agent 和它起的 bash 碰不到凭据；调用先过守卫（按登记的类别：对外发送先问），再由守护进程转发；守护进程停掉时服务进程一起结束", { timeout: 60_000 }, async () => {
    const logFile = path.join(makeTempDir("ergo-mcp-log-"), "mcp.jsonl");
    const td = await startTestDaemon({
      env: { [MCP_TOKEN_ENV]: MCP_TOKEN },
      maintainer: (id) =>
        id === "pm-1"
          ? [
              echo,
              call("mcp__demo__env_token", {}),
              call("bash", { command: 'echo "agent=[$FAKE_MCP_TOKEN][$ERGO_TEST_MCP_TOKEN]"' }),
              call("mcp__demo__send_note", { to: "老王", text: "周五开会" }),
              echo,
            ]
          : [echo],
    });
    writeMcpRegistration(td.dataDir, logFile);
    seedToolkitProject(td.daemon, "笔记", toolkit({ mcp: ["demo"], bash: true, network: true }));
    seedToolkitProject(td.daemon, "账本", toolkit({ bash: true, network: true }));
    const frontend = await connect(td, [maintainerChannel("pm-2")]);

    // 没授权 demo 的项目：会话里没有它的工具
    await frontend.sendText("看看你有什么", { conversation: maintainerChannel("pm-2") });
    const other = await nthReply(frontend, maintainerChannel("pm-2"), 1);
    expect(toolLines(other).filter((l) => l.includes("mcp__"))).toEqual([]);

    // 授权了的：登记的工具都在（参数说明取服务进程报的）
    await frontend.sendText("把笔记发给老王", { conversation: PM1 });
    const seen = await nthReply(frontend, PM1, 1);
    expect(toolLines(seen).filter((l) => l.includes("mcp__"))).toEqual([
      "[tool] mcp__demo__echo",
      "[tool] mcp__demo__env_token",
      "[tool] mcp__demo__send_note",
      "[tool] mcp__demo__wait",
      "[tool] mcp__demo__status",
    ]);
    // 凭据到了服务进程，没到 agent 和它起的 bash：服务进程把凭据报回来，交给 agent 之前擦掉了
    await frontend.sendText("发吧", { conversation: PM1 });
    const tokenCall = await eventually(() => toolCallsOf(frontend, PM1), (c) => c.tool === "mcp__demo__env_token" && c.outcome === "done", "调用 env_token");
    expect(tokenCall.resultSummary).toContain(`token=${REDACTED_SECRET}`);
    expect(tokenCall.resultSummary).not.toContain(MCP_TOKEN);
    const bashCall = await eventually(() => toolCallsOf(frontend, PM1), (c) => c.tool === "bash" && c.outcome === "done", "调用 bash");
    expect(bashCall).toMatchObject({ resultSummary: expect.stringContaining("agent=[][]") });
    const started = mcpLog(logFile).find((e) => e.started)?.started;
    expect(started?.token).toBe(MCP_TOKEN);
    // 发笔记登记了"以我的名义对外发送"：对话里先问用户，批准前不转发
    const approval = await cardWhere(frontend, (c: Card) => c.type === "approval", "审批卡");
    expect(mcpLog(logFile).some((e) => e.call === "send_note")).toBe(false);
    ok(await frontend.cardAction({ cardId: approval.id, action: "approve", expectedVersion: approval.version }));
    await waitUntil(() => mcpLog(logFile).some((e) => e.call === "send_note"), { describe: () => "等转发发笔记" });
    expect(mcpLog(logFile).filter((e) => e.call).map((e) => [e.call, e.args])).toEqual([
      ["env_token", {}],
      ["send_note", { to: "老王", text: "周五开会" }],
    ]);
    await nthReply(frontend, PM1, 2);

    // 服务进程在守护进程手里（不在 LSM 登记），守护进程停掉时一起结束
    const live = td.daemon.mcp.live();
    expect(live.map((l) => l.server)).toEqual(["demo"]);
    expect(isProcessAlive(started!.pid)).toBe(true);
    await td.daemon.stop();
    await waitUntil(() => !isProcessAlive(started!.pid) && !isProcessAlive(live[0]!.pid), { describe: () => "等 MCP 服务进程结束" });
  });

  it("凭据不出守护进程：MCP 服务进程把注入的凭据写进 stderr 和工具结果，守护进程日志、交给 agent 的结果、事件日志里都看不到原值", async () => {
    const logFile = path.join(makeTempDir("ergo-mcp-log-"), "mcp.jsonl");
    const logs: string[] = [];
    const td = await startTestDaemon({
      env: { [MCP_TOKEN_ENV]: MCP_TOKEN },
      log: (line) => logs.push(line),
      maintainer: () => [call("mcp__demo__env_token", {}), echo],
    });
    writeMcpRegistration(td.dataDir, logFile);
    seedToolkitProject(td.daemon, "笔记", toolkit({ mcp: ["demo"] }));
    const frontend = await connect(td);
    await frontend.sendText("看看凭据", { conversation: PM1 });
    const seen = await nthReply(frontend, PM1, 1);
    // 服务进程确实拿到了凭据、也确实报回来了
    expect(mcpLog(logFile).find((e) => e.started)?.started?.token).toBe(MCP_TOKEN);
    expect(seen).toContain(`[toolResult] mcp__demo__env_token: token=${REDACTED_SECRET}`);
    // stderr 进了守护进程日志，擦过
    await waitUntil(() => logs.some((l) => l.includes("env_token 被调用了")), { describe: () => "等服务进程的 stderr 进日志" });
    expect(logs.find((l) => l.includes("env_token 被调用了"))).toContain(`token=${REDACTED_SECRET}`);
    expect(logs.filter((l) => l.includes(MCP_TOKEN))).toEqual([]);
    expect(seen).not.toContain(MCP_TOKEN);
    // 事件日志里一条都没有原值（工具调用记录、会话消息、效果日志……）
    const all = td.daemon.store.readGlobal(0, 1_000_000);
    expect(all.filter((e) => JSON.stringify(e.payload).includes(MCP_TOKEN)).map((e) => `${e.channel}/${e.type}`)).toEqual([]);
  });

  it("用户在项目页直接改工具包（不出卡）：维护者正在调用工具时，等这一步做完就重启子进程、按新工具包接着干——新开的 bash 下一次模型调用里就有，去掉的 MCP 不再出现、调用它用不了；子进程不在时下次唤起就按新的", async () => {
    const logFile = path.join(makeTempDir("ergo-mcp-log-"), "mcp.jsonl");
    const td = await startTestDaemon({
      maintainer: (_id, spawn) =>
        spawn === 1 ? [echo, call("mcp__demo__wait", { ms: 1500 }), say("不该走到这一步")] : [call("mcp__demo__echo", { text: "还在吗" }), echo, say("好")],
    });
    writeMcpRegistration(td.dataDir, logFile);
    const project = seedToolkitProject(td.daemon, "笔记", toolkit());
    const frontend = await connect(td);
    // 维护者还没被唤起过（没有子进程）：改了直接写进工具包，下次唤起按新的
    expect(ok(await frontend.request(METHODS.setToolkit, { target: { kind: "project", projectId: project.id }, toolkit: toolkit({ mcp: ["demo"] }) }, "k-1"))).toMatchObject({ changed: true });
    await frontend.sendText("看看你有什么", { conversation: PM1 });
    const first = await nthReply(frontend, PM1, 1);
    expect(toolLines(first)).toContain("[tool] mcp__demo__wait");
    expect(toolLines(first)).not.toContain("[tool] bash");
    // 正在调用 wait（要 1.5 秒）时把 bash 打开、MCP 去掉
    await frontend.sendText("等一会儿", { conversation: PM1 });
    await waitUntil(() => mcpLog(logFile).some((e) => e.call === "wait"), { describe: () => "等维护者调用 wait" });
    const set = ok(await frontend.request(METHODS.setToolkit, { target: { kind: "project", projectId: project.id }, toolkit: toolkit({ bash: true }) }, "k-2"));
    expect(set).toEqual({ toolkit: toolkit({ bash: true }), changed: true });
    // 没出任何卡；项目的工具包马上就是新的
    expect(frontend.events({ channel: CHANNELS.cards })).toEqual([]);
    expect(td.daemon.projects.get(project.id)?.toolkit).toEqual(toolkit({ bash: true }));
    // 这一步（wait）做完了才停：结果照常进会话；之后重启、接着原会话。去掉的 MCP 工具调用不了
    const second = await nthReply(frontend, PM1, 2);
    expect(second).toContain("[toolResult] mcp__demo__wait: 等好了");
    expect(second).toContain("工具包已变更（这一段的工具包改了）：加上 bash；去掉 MCP demo");
    expect(second).toMatch(/\[toolResult\] mcp__demo__echo: .*not found/i);
    expect(mcpLog(logFile).filter((e) => e.call).map((e) => e.call)).toEqual(["wait"]);
    expect(toolLines(second)).toContain("[tool] bash");
    expect(toolLines(second).filter((l) => l.includes("mcp__demo__"))).toEqual([]);
    expect(second).not.toContain("[tool-removed]");
    expect(second).not.toContain("不该走到这一步");
    // 时间线记一笔
    expect(recordsOf(frontend, PM1).map((r) => r.record.summary)).toEqual(["你在项目页改了工具包：加上 MCP demo", "你在项目页改了工具包：加上 bash；去掉 MCP demo"]);
  }, 60_000);

  it("项目维护者不在任务里时要开联网、加 MCP：只能提交工具包变更卡进待我处理，批准前工具包不变；批准后扩大并立即按新工具包重新装配（审批决定是素材），拒绝则不变；减少能力随时可以", async () => {
    const logFile = path.join(makeTempDir("ergo-mcp-log-"), "mcp.jsonl");
    const td = await startTestDaemon({
      // 第 1 次：申请（关 bash 直接生效，工具包一变就在这次调用结束后重新装配）；第 2 次接着这一轮；第 3 次是批准之后
      maintainer: (_id, spawn) =>
        spawn === 1
          ? [call("request_toolkit_change", { network: true, addMcp: ["demo"], bash: false, why: "要给老王发笔记" }), say("不该走到这一步")]
          : spawn === 2
            ? [say("申请了，等你批准")]
            : [echo, call("request_toolkit_change", { bash: true, why: "想跑脚本" }), say("又申请了")],
    });
    writeMcpRegistration(td.dataDir, logFile);
    const project = seedToolkitProject(td.daemon, "笔记", toolkit({ bash: true }));
    const frontend = await connect(td);
    await frontend.sendText("给老王发个笔记", { conversation: PM1 });
    const card = await cardWhere(frontend, (c) => c.type === "toolkit_change", "工具包变更卡");
    expect(card.payload).toMatchObject({
      projectId: project.id,
      why: "要给老王发笔记",
      // 关 bash 是减少能力：直接生效，不在卡上
      before: toolkit(),
      after: toolkit({ mcp: ["demo"], network: true }),
      additions: ["MCP demo", "联网"],
    } satisfies Partial<ToolkitChangeCardPayload>);
    expect(inboxOf(frontend).some((i) => i.kind === "card" && i.cardId === card.id)).toBe(true);
    // 关 bash 直接生效：这次调用结束后按新工具包接着这一轮
    expect(await nthReply(frontend, PM1, 1)).toBe("申请了，等你批准");
    // 批准前工具包不变（只有直接生效的减少）
    expect(td.daemon.projects.get(project.id)?.toolkit).toEqual(toolkit());

    // 下面每个动作之前都等维护者这一轮说完（回复落盘之后 turn_end 才到）：批准、拒绝的时间线记录和通知不插进它这一轮，
    // 用户的话是新的一轮而不是插话，录下的事件流才确定
    await settled(td, "pm-1");
    ok(await frontend.cardAction({ cardId: card.id, action: "approve", expectedVersion: card.version, note: "可以" }));
    expect(td.daemon.projects.get(project.id)?.toolkit).toEqual(toolkit({ mcp: ["demo"], network: true }));
    expect(td.daemon.store.read("toolkits", 0).map((e) => e.payload)).toEqual([
      expect.objectContaining({ decision: "approved", target: { kind: "project", projectId: project.id }, after: toolkit({ mcp: ["demo"], network: true }), cardId: card.id, note: "可以" }),
    ]);
    // 维护者收到通知，按新工具包拉起：要联网的 MCP 工具也在了
    const after = await nthReply(frontend, PM1, 2);
    expect(after).toContain("用户批准了你申请的工具包变更：加上 MCP demo、联网");
    expect(toolLines(after)).toContain("[tool] mcp__demo__send_note");
    expect(recordsOf(frontend, PM1).map((r) => r.record.summary)).toEqual(["维护者减少了能力（要给老王发笔记）：去掉 bash", "你批准了工具包变更：加上 MCP demo、联网"]);

    // 再申请开 bash：拒绝，工具包不变，维护者收到通知
    await settled(td, "pm-1");
    await frontend.sendText("跑个脚本", { conversation: PM1 });
    const second = await cardWhere(frontend, (c) => c.type === "toolkit_change" && c.id !== card.id, "第二张工具包变更卡");
    await settled(td, "pm-1");
    ok(await frontend.cardAction({ cardId: second.id, action: "deny", expectedVersion: second.version, note: "不用脚本" }));
    expect(td.daemon.projects.get(project.id)?.toolkit).toEqual(toolkit({ mcp: ["demo"], network: true }));
    await eventually(() => messagesOf(frontend, PM1), (m) => m.agentInput === true && textOf(m).includes("用户拒绝了你申请的工具包变更（要加 bash）：不用脚本"), "拒绝的通知");
    expect(td.daemon.store.read("toolkits", 0).map((e) => (e.payload as { decision: string }).decision)).toEqual(["approved", "denied"]);
    // 批准、拒绝都是审批决定的素材（带上用户写的话）
    const decisions = () => td.daemon.materials.list({ kind: "approval_decision" }).filter((m) => m.context.includes("card:toolkit_change"));
    await waitUntil(() => decisions().length === 2, { timeoutMs: 10_000, describe: () => "工具包变更卡的审批决定素材" });
    expect(decisions().map((m) => m.context.find((c) => c.startsWith("decision:")))).toEqual(expect.arrayContaining(["decision:approved", "decision:denied"]));
    expect(decisions().find((m) => m.context.includes("decision:denied"))!.segments.map((s) => s.text)).toContain("不用脚本");
    // 给 Web 的回放：工具包变更卡（批准、拒绝）、项目的工具包跟着变、时间线上的工具包变更
    await inputsDone(frontend, PM1);
    saveOrCheckRecording("toolkit-change", frontend.recording, { perChannel: true });
  }, 60_000);

  it("联网开关：关着时会话里没有要联网的 MCP 工具，bash 里的联网命令直接拒绝并说明要申请开联网，bash 的环境里代理地址无效；用户打开后重新装配，GET 不落入关注类别，非 GET 的请求要先问", { timeout: 60_000 }, async () => {
    const logFile = path.join(makeTempDir("ergo-mcp-log-"), "mcp.jsonl");
    // 只连本机一个没人听的端口（和无效代理同一个地址），不往外发任何东西
    const GET = "curl -s -m 5 http://127.0.0.1:9/notes";
    const POST = "curl -s -m 5 -X POST -d a=1 http://127.0.0.1:9/notes";
    const td = await startTestDaemon({
      maintainer: (_id, spawn) =>
        spawn === 1
          ? [echo, call("bash", { command: 'echo "proxy=[$HTTPS_PROXY]"' }), call("bash", { command: GET }), say("联网被拒了")]
          : [echo, call("bash", { command: GET }), call("bash", { command: POST }), say("好")],
    });
    writeMcpRegistration(td.dataDir, logFile);
    const project = seedToolkitProject(td.daemon, "笔记", toolkit({ mcp: ["demo"], bash: true }));
    const frontend = await connect(td);

    await frontend.sendText("看看你有什么", { conversation: PM1 });
    const offline = toolLines(await nthReply(frontend, PM1, 1));
    expect(offline).toContain("[tool] bash");
    expect(offline).toContain("[tool] mcp__demo__echo");
    expect(offline).not.toContain("[tool] mcp__demo__send_note");
    await frontend.sendText("查一下", { conversation: PM1 });
    await nthReply(frontend, PM1, 2);
    const [proxy, get] = toolCallsOf(frontend, PM1).filter((c) => c.tool === "bash");
    expect(proxy).toMatchObject({ outcome: "done", resultSummary: expect.stringContaining("proxy=[http://127.0.0.1:9]") });
    expect(get).toMatchObject({ outcome: "blocked", resultSummary: expect.stringContaining("提交工具包变更申请开联网") });

    // 用户打开联网：按新工具包重新装配
    ok(await frontend.request(METHODS.setToolkit, { target: { kind: "project", projectId: project.id }, toolkit: toolkit({ mcp: ["demo"], bash: true, network: true }) }, "k-net"));
    await frontend.sendText("再查一下", { conversation: PM1 });
    const online = await nthReply(frontend, PM1, 3);
    expect(online).toContain("工具包已变更（这一段的工具包改了）：加上 联网");
    expect(toolLines(online)).toContain("[tool] mcp__demo__send_note");
    await frontend.sendText("发上去", { conversation: PM1 });
    // GET 不落入关注类别，直接做；POST 落入"以我的名义对外发送或发布"，先问
    const approval = await cardWhere(frontend, (c: Card) => c.type === "approval", "审批卡");
    const calls = toolCallsOf(frontend, PM1).filter((c) => c.tool === "bash");
    expect(calls[2]).toMatchObject({ argsSummary: expect.stringContaining("http://127.0.0.1:9/notes"), categoryTitles: [], disposition: "do" });
    expect(calls[2]!.outcome).not.toBe("blocked");
    expect(approval.payload).toMatchObject({ tool: "bash", argsSummary: expect.stringContaining("-X POST"), categoryTitles: ["以我的名义对外发送或发布"] });
    ok(await frontend.cardAction({ cardId: approval.id, action: "deny", expectedVersion: approval.version }));
    await nthReply(frontend, PM1, 4);
  });

  it("守卫用此刻的工具包：一步里两次调用，前一次在等审批时用户收窄了工具包——批准后它照样用不到被去掉的 MCP，同一步里的下一次调用（子进程还没重启）也被拒", { timeout: 60_000 }, async () => {
    const logFile = path.join(makeTempDir("ergo-mcp-log-"), "mcp.jsonl");
    const td = await startTestDaemon({
      maintainer: (_id, spawn) =>
        spawn === 1
          ? [
              echo,
              { kind: "reply", toolCalls: [{ name: "mcp__demo__send_note", arguments: { to: "老王", text: "周五开会" } }, { name: "bash", arguments: { command: "echo hi" } }] },
              say("不该走到这一步"),
            ]
          : [echo],
    });
    writeMcpRegistration(td.dataDir, logFile);
    const project = seedToolkitProject(td.daemon, "笔记", toolkit({ mcp: ["demo"], bash: true, network: true }));
    const frontend = await connect(td);
    await frontend.sendText("看看你有什么", { conversation: PM1 });
    await nthReply(frontend, PM1, 1);
    await frontend.sendText("发笔记，再跑个命令", { conversation: PM1 });
    const approval = await cardWhere(frontend, (c: Card) => c.type === "approval", "发笔记的审批卡");
    // 等审批时用户去掉 MCP、关掉 bash
    ok(await frontend.request(METHODS.setToolkit, { target: { kind: "project", projectId: project.id }, toolkit: toolkit({ network: true }) }, "k-narrow"));
    ok(await frontend.cardAction({ cardId: approval.id, action: "approve", expectedVersion: approval.version }));
    const calls = await eventually(
      () => [toolCallsOf(frontend, PM1).filter((c) => c.outcome !== "running")],
      (list) => list.length >= 2,
      "两次调用都有结果",
    );
    expect(calls.map((c) => [c.tool, c.outcome, c.blockedBy])).toEqual([
      ["mcp__demo__send_note", "blocked", "hard_refusal"],
      ["bash", "blocked", "hard_refusal"],
    ]);
    expect(mcpLog(logFile).some((e) => e.call === "send_note")).toBe(false);
    // 这一步做完才重启：接着干时会话里已经是新的工具包
    const after = await nthReply(frontend, PM1, 2);
    expect(after).toContain("工具包已变更");
    expect(toolLines(after)).not.toContain("[tool] bash");
    expect(toolLines(after)).not.toContain("[tool] mcp__demo__send_note");
  });

  it("增减 skill 只能从 skill 库里选", async () => {
    const td = await startTestDaemon({ maintainer: () => [call("adjust_skills", { add: ["chart-maker"], why: "沉淀知识" }), echo] });
    seedToolkitProject(td.daemon, "笔记", toolkit());
    const frontend = await connect(td);
    await frontend.sendText("用推理图谱", { conversation: PM1 });
    const seen = await nthReply(frontend, PM1, 1);
    expect(seen).toContain("[toolResult] adjust_skills: skill 库里没有 chart-maker。库里有：example-checklist");
    expect(td.daemon.projects.get("p-1")?.toolkit).toEqual(toolkit());
  });
});


describe("任务的工具包", () => {
  it("用户在任务详情里直接改工具包：现在生效的计划换一版（只改工具包），不出计划变更卡，时间线记一笔、审批决定是素材；维护者按新工具包重新装配，收窄后守卫的下一次判定就用不到去掉的能力", async () => {
    const td = await startTestDaemon({
      maintainer: (_id, spawn) =>
        spawn === 1 ? [submitPlanStep(twoStagePlan({ toolkit: toolkit() })), say("计划交上去了")] : spawn === 2 ? [say("开始做")] : spawn === 3 ? [echo] : [call("bash", { command: "echo hi" }), echo],
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe(Object.fromEntries([CHANNELS.board, CHANNELS.cards, CHANNELS.inbox, TM1].map((c) => [c, 0])));
    const taskId = await confirmTask(td, frontend, "整理笔记");
    await eventually(() => repliesOf(frontend, TM1), (r) => r === "开始做", "维护者开始做");
    expect(td.daemon.tasks.confirmedPlan(taskId)?.plan.toolkit.bash).toBe(false);

    // 打开 bash：计划换一版，不出计划变更卡
    expect(ok(await frontend.request(METHODS.setToolkit, { target: { kind: "task", taskId }, toolkit: toolkit({ bash: true }) }, "k-on"))).toEqual({ toolkit: toolkit({ bash: true }), changed: true });
    expect(await taskWhere(frontend, (e) => e.change === "toolkit_changed")).toMatchObject({ by: "user", task: { id: taskId } });
    expect(td.daemon.tasks.confirmedPlan(taskId)).toMatchObject({ revision: 2, plan: { toolkit: toolkit({ bash: true }) } });
    expect((await eventually(() => taskPlansOf(frontend), (p) => p.revision === 2, "现在生效的计划")).plan.toolkit).toEqual(toolkit({ bash: true }));
    expect(cardsOfType(frontend, "plan_change")).toEqual([]);
    expect(recordsOf(frontend, TM1).find((r) => r.record.kind === "toolkit")?.record.summary).toBe("你在任务详情里改了工具包：加上 bash");
    expect(td.daemon.store.read("toolkits", 0).map((e) => e.payload)).toEqual([expect.objectContaining({ decision: "edited", target: { kind: "task", taskId }, after: toolkit({ bash: true }) })]);
    await waitUntil(() => td.daemon.materials.list({ kind: "approval_decision" }).some((m) => m.context.includes("toolkit:edited")), { timeoutMs: 10_000, describe: () => "直接改工具包的审批决定素材" });
    // 维护者闲着：停掉子进程，下一条输入按新工具包拉起，跟着一句"工具包已变更"
    await frontend.sendText("看看你有什么", { conversation: TM1 });
    const seen = await nthReply(frontend, TM1, 3);
    expect(toolLines(seen)).toContain("[tool] bash");
    expect(seen).toContain("工具包已变更（任务的工具包改了）：加上 bash");

    // 收窄（关掉 bash）同样直接生效：之后调 bash 用不到
    ok(await frontend.request(METHODS.setToolkit, { target: { kind: "task", taskId }, toolkit: toolkit() }, "k-off"));
    await frontend.sendText("跑一下", { conversation: TM1 });
    const third = await nthReply(frontend, TM1, 4);
    expect(third).toMatch(/\[toolResult\] bash: .*not found/i);
    expect(toolCallsOf(frontend, TM1).some((c) => c.tool === "bash" && c.outcome === "done")).toBe(false);
    // 重发同一个请求拿到同一个结果，不再改一次
    expect(ok(await frontend.request(METHODS.setToolkit, { target: { kind: "task", taskId }, toolkit: toolkit() }, "k-off"))).toMatchObject({ toolkit: toolkit() });
    expect(td.daemon.tasks.confirmedPlan(taskId)?.revision).toBe(3);
  }, 60_000);

  it("有计划变更卡在等时：用户照样能直接收窄任务的工具包，扩大要等卡处理完；之后确认这张卡，生效的计划带上卡上要加的和用户收窄的", async () => {
    const plan = twoStagePlan({ toolkit: toolkit({ bash: true }) });
    const wider = { ...plan, toolkit: toolkit({ bash: true, network: true }) };
    const td = await startTestDaemon({
      maintainer: (_id, spawn) =>
        spawn === 1
          ? [submitPlanStep(plan), say("计划交上去了")]
          : spawn === 2
            ? [call("propose_plan_change", { plan: draftOf(wider), why: "要查外面的资料" }), say("等你确认")]
            : [echo],
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe(Object.fromEntries([CHANNELS.board, CHANNELS.cards, CHANNELS.inbox, TM1].map((c) => [c, 0])));
    const taskId = await confirmTask(td, frontend, "调研");
    const card = await cardWhere(frontend, (c) => c.type === "plan_change", "计划变更卡");
    await eventually(() => repliesOf(frontend, TM1), (r) => r === "等你确认", "维护者交了计划变更");
    // 扩大（开联网）要等卡处理完；收窄（关 bash）照样直接改
    expect(await frontend.request(METHODS.setToolkit, { target: { kind: "task", taskId }, toolkit: toolkit({ bash: true, network: true }) }, "k-wide")).toMatchObject({
      ok: false,
      error: { code: "not_allowed", message: expect.stringContaining("还在等用户：先处理它再扩大工具包") },
    });
    expect(ok(await frontend.request(METHODS.setToolkit, { target: { kind: "task", taskId }, toolkit: toolkit() }, "k-narrow"))).toEqual({ toolkit: toolkit(), changed: true });
    expect(td.daemon.tasks.confirmedPlan(taskId)?.plan.toolkit).toEqual(toolkit());
    // 卡照样能确认：联网（卡上要加的）有了，bash（用户收窄掉的）没有回来；生效的是最新的一版
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: card.version, input: {} }));
    expect(td.daemon.tasks.confirmedPlan(taskId)).toMatchObject({ revision: 4, plan: { toolkit: toolkit({ network: true }) } });
    expect((await eventually(() => taskPlansOf(frontend), (p) => p.revision === 4, "现在生效的计划")).plan.toolkit).toEqual(toolkit({ network: true }));
    // 维护者按最新的一版重新拉起：bash 去掉了
    const seen = await eventually(() => repliesOf(frontend, TM1), (r) => r.includes("[system]"), "按新工具包拉起的维护者");
    expect(toolLines(seen)).not.toContain("[tool] bash");
    expect(seen).not.toContain("[tool-removed]");
  }, 60_000);

  it("工具包里只能是 skill 库里的 skill、登记了的 MCP：提交计划、自行调整计划、计划变更都检查，不在就拒绝并说明", async () => {
    const good = twoStagePlan({ toolkit: toolkit() });
    const td = await startTestDaemon({
      maintainer: (_id, spawn) =>
        spawn === 1
          ? [submitPlanStep({ ...good, toolkit: toolkit({ skills: ["chart-maker"], mcp: ["nope"] }) }), submitPlanStep(good), say("计划交上去了")]
          : [
              call("revise_plan", { plan: draftOf({ ...good, toolkit: toolkit({ skills: ["chart-maker"] }) }), why: "加个 skill" }),
              call("propose_plan_change", { plan: draftOf({ ...good, toolkit: toolkit({ mcp: ["nope"] }) }), why: "加个 MCP" }),
              say("都没成"),
            ],
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe(Object.fromEntries([CHANNELS.board, CHANNELS.cards, CHANNELS.inbox, TM1].map((c) => [c, 0])));
    await confirmTask(td, frontend, "整理笔记");
    await eventually(() => repliesOf(frontend, TM1), (r) => r === "都没成", "维护者试完");
    const results = Object.fromEntries(toolCallsOf(frontend, TM1).map((c) => [c.tool, c.resultSummary ?? ""]));
    const submits = toolCallsOf(frontend, TM1).filter((c) => c.tool === "submit_plan");
    expect(submits[0]!.resultSummary).toContain("skill 库里没有 chart-maker");
    expect(submits[0]!.resultSummary).toContain("没有登记 MCP nope");
    expect(results.revise_plan).toContain("skill 库里没有 chart-maker");
    expect(results.propose_plan_change).toContain("没有登记 MCP nope");
    expect(cardsOfType(frontend, "plan_change")).toEqual([]);
  }, 60_000);

  it("项目的任务里维护者加 skill：只记在任务上，项目页的工具包不变；执行时 skill 取项目和任务的并集，会话里两边的都有", async () => {
    const td = await startTestDaemon({
      secretary: [say("好的")],
      maintainer: (id, spawn) =>
        id !== "pm-1"
          ? []
          : spawn === 1
            ? [submitPlanStep(twoStagePlan({ toolkit: toolkit() })), call("write_progress", { content: "计划交上去了，等确认。" }), call("write_segment_summary", { summary: "起草了计划" }), say("计划交上去了")]
            : spawn === 2
              ? [call("adjust_skills", { add: ["example-checklist"], why: "要列清单" }), say("不该走到这一步")]
              : [echo],
    });
    writeSkill(path.join(td.dataDir, "skills", "notes-style"), "notes-style", "MARKER_NOTES_STYLE");
    const project = seedToolkitProject(td.daemon, "笔记", toolkit({ skills: ["notes-style"] }));
    const frontend = await connect(td);
    internalTask(td.daemon, "笔记", "整理笔记");
    const created = await taskWhere(frontend, (e) => e.change === "created" && e.task.title === "整理笔记", "任务");
    td.daemon.tasks.writeBrief(created.task.id, { goal: "整理笔记", acceptanceCriteria: ["整理好"], constraints: [], projects: ["笔记"], memoryScope: "" }, byMaintainer(td.daemon, created.task.id));
    const planCard = await cardWhere(frontend, (c) => c.type === "plan", "计划卡");
    ok(await frontend.cardAction({ cardId: planCard.id, action: "confirm", expectedVersion: planCard.version, input: {} }));
    const seen = await eventually(() => repliesOf(frontend, PM1), (r) => r.includes("[system]") && r.includes("example-checklist"), "加了 skill 之后的维护者");
    expect(td.daemon.tasks.confirmedPlan(created.task.id)?.plan.toolkit.skills).toEqual(["example-checklist"]);
    expect(td.daemon.projects.get(project.id)?.toolkit).toEqual(toolkit({ skills: ["notes-style"] }));
    const skillsNow = latestSystem(seen);
    expect(skillsNow).toContain("MARKER_NOTES_STYLE");
    expect(skillsNow).toContain("框架自带的示例 skill");
    // 项目页（项目频道）上没有工具包变更
    expect(frontend.events({ channel: CHANNELS.projects, type: EVENT_TYPES.project }).map((f) => (f.payload as ProjectEventPayload).change)).not.toContain("toolkit_changed");
  }, 60_000);

  it("执行中要开联网、加 MCP 只能提交计划变更：卡上的工具包变更一栏列出要加的能力，批准前工具包不变；被拒绝则不变", async () => {
    const logFile = path.join(makeTempDir("ergo-mcp-log-"), "mcp.jsonl");
    const plan = twoStagePlan({ toolkit: toolkit() });
    const wider = { ...plan, toolkit: toolkit({ mcp: ["demo"], network: true }) };
    const td = await startTestDaemon({
      maintainer: (_id, spawn) =>
        spawn === 1 ? [submitPlanStep(plan), say("计划交上去了")] : [call("propose_plan_change", { plan: draftOf(wider), why: "要查外面的资料" }), say("等你确认工具包"), echo],
    });
    writeMcpRegistration(td.dataDir, logFile);
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe(Object.fromEntries([CHANNELS.board, CHANNELS.cards, CHANNELS.inbox, TM1].map((c) => [c, 0])));
    const taskId = await confirmTask(td, frontend, "调研");
    const card = await cardWhere(frontend, (c) => c.type === "plan_change", "计划变更卡");
    const payload = card.payload as PlanChangeCardPayload;
    const kit = payload.changes.find((c) => c.kind === "toolkit")!;
    expect(planChangeItemText(kit)).toBe("工具包变更：加上 MCP demo、联网（原来 bash 关、联网关；skill：无；MCP：无）");
    expect(payload.affectedStages.map((s) => s.stageId)).toEqual(["s1"]);
    expect(td.daemon.tasks.confirmedPlan(taskId)?.plan.toolkit).toEqual(toolkit());
    ok(await frontend.cardAction({ cardId: card.id, action: "reject", expectedVersion: card.version, note: "先不联网" }));
    await taskWhere(frontend, (e) => e.change === "plan_change_rejected");
    expect(td.daemon.tasks.confirmedPlan(taskId)?.plan.toolkit).toEqual(toolkit());
  }, 60_000);
});

describe("秘书的快速动作：调用 MCP 工具", () => {
  it("只能选登记里授权给秘书快速动作的 MCP 工具，参数按登记固定；用户点明了就直接执行：由守护进程转发调用、不拉起任何 agent，聊天里留已执行卡，操作记录进事件日志", async () => {
    const logFile = path.join(makeTempDir("ergo-mcp-log-"), "mcp.jsonl");
    const td = await startTestDaemon({
      secretary: [
        { kind: "reply", toolCalls: [{ name: "propose_quick_action", arguments: { type: "mcp_call", params: { tool: "demo/echo" } } }] },
        { kind: "reply", toolCalls: [{ name: "propose_quick_action", arguments: { type: "mcp_call", params: { tool: "demo/status" } } }] },
        { kind: "echo_context" },
      ],
    });
    writeMcpRegistration(td.dataDir, logFile);
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [CHANNELS.secretary]: 0, [CHANNELS.cards]: 0, [CHANNELS.inbox]: 0, [CHANNELS.board]: 0 });
    const spawned = countAgentSpawns(td.daemon);
    await frontend.sendText("看一下假 MCP 的状态");
    await frontend.next(CHANNELS.secretary, EVENT_TYPES.turnEnd);

    const calls = toolCallsOf(frontend, CHANNELS.secretary);
    // 没授权的工具：不出卡，告诉秘书能用哪些
    expect(calls[0]?.resultSummary).toContain("没有授权给秘书快速动作的 MCP 工具 demo/echo");
    expect(calls[0]?.resultSummary).toContain("demo/status（看一下假 MCP 的状态）");
    // 授权了的、用户原话里点明了：直接执行，结果写进"已执行"卡
    const card = await cardWhere(frontend, (c) => c.type === "quick_action", "快速动作卡");
    expect(card).toMatchObject({ status: "handled", payload: { action: { type: "mcp_call" }, title: "看一下假 MCP 的状态", explicit: true, result: "一切正常（假 MCP 的状态）" } });
    const executed = frontend.events({ channel: CHANNELS.secretary, type: EVENT_TYPES.quickActionExecuted }).map((f) => f.payload);
    expect(executed).toEqual([expect.objectContaining({ name: "调用 MCP 工具", basis: "explicit", result: { ok: true, summary: "一切正常（假 MCP 的状态）" } })]);
    expect(mcpLog(logFile).filter((e) => e.call).map((e) => e.call)).toEqual(["status"]);
    expect(spawned()).toBe(0);
    expect(frontend.events({ channel: CHANNELS.board })).toEqual([]);
  });

  it("MCP 服务进程是守护进程的子进程（不在 LSM 登记）：守护进程被直接杀掉时，服务进程随它的 Job 对象一起结束", { timeout: 60_000 }, async () => {
    const killable = await startKillableDaemon({
      secretary: [{ kind: "reply", toolCalls: [{ name: "propose_quick_action", arguments: { type: "mcp_call", params: { tool: "demo/status" } } }] }, say("看过了")],
    });
    const logFile = path.join(makeTempDir("ergo-mcp-log-"), "mcp.jsonl");
    writeMcpRegistration(killable.dataDir, logFile);
    const frontend = await TestFrontend.connect(killable.url);
    await frontend.subscribe({ [CHANNELS.secretary]: 0 });
    await frontend.sendText("看一下假 MCP 的状态");
    await waitUntil(() => mcpLog(logFile).some((e) => e.call === "status"), { describe: () => "等秘书的快速动作调用 MCP" });
    const started = mcpLog(logFile).find((e) => e.started)!.started!;
    // 服务进程的父进程是闸门进程，闸门进程的父进程是守护进程
    expect(isProcessAlive(started.pid)).toBe(true);
    expect(isProcessAlive(started.ppid)).toBe(true);
    await frontend.close();
    await killable.kill();
    expect(await survivors([started.pid, started.ppid])).toEqual([]);
  });

  it("推断出来的、登记的类别要先问：出卡进待我处理，用户点执行后才转发，结果补进卡片和操作记录", async () => {
    const logFile = path.join(makeTempDir("ergo-mcp-log-"), "mcp.jsonl");
    const td = await startTestDaemon({ secretary: [{ kind: "reply", toolCalls: [{ name: "propose_quick_action", arguments: { type: "mcp_call", params: { tool: "demo/send_note" } } }] }, say("等你确认")] });
    writeMcpRegistration(td.dataDir, logFile);
    // send_note 授权给秘书快速动作（参数固定）；它登记了"以我的名义对外发送"
    const file = path.join(td.dataDir, "config", "mcp.json");
    const registration = JSON.parse(fs.readFileSync(file, "utf8")) as { servers: { demo: { tools: Record<string, Record<string, unknown>> } } };
    registration.servers.demo.tools.send_note!.quickAction = { title: "给老王发周报提醒", args: { to: "老王", text: "记得交周报" } };
    fs.writeFileSync(file, JSON.stringify(registration));
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [CHANNELS.secretary]: 0, [CHANNELS.cards]: 0, [CHANNELS.inbox]: 0 });
    await frontend.sendText("老王是不是忘了交周报");
    await frontend.next(CHANNELS.secretary, EVENT_TYPES.turnEnd);
    const card = await cardWhere(frontend, (c) => c.type === "quick_action", "快速动作卡");
    expect(card).toMatchObject({ status: "pending", payload: { explicit: false, disposition: "ask_first", categories: ["以我的名义对外发送或发布"] } });
    expect(inboxOf(frontend).some((i) => i.kind === "card" && i.cardId === card.id)).toBe(true);
    expect(mcpLog(logFile).some((e) => e.call)).toBe(false);
    ok(await frontend.cardAction({ cardId: card.id, action: "execute", expectedVersion: card.version }));
    await waitUntil(() => mcpLog(logFile).some((e) => e.call === "send_note"), { describe: () => "等转发" });
    expect(mcpLog(logFile).find((e) => e.call === "send_note")?.args).toEqual({ to: "老王", text: "记得交周报" });
    const done = await cardWhere(frontend, (c) => c.id === card.id && (c.payload as { result?: string }).result === "已发给 老王", "卡片补上结果");
    expect(done.status).toBe("handled");
    await eventually(
      () => frontend.events({ channel: CHANNELS.secretary, type: EVENT_TYPES.quickActionExecuted }).map((f) => f.payload as { basis: string; result: { ok: boolean } }),
      (p) => p.basis === "confirmed" && p.result.ok,
      "操作记录",
    );
  });
});
