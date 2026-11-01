// 主切面：负责人用 request_skill_change 把写好的 skill 提交进 skill 库，用户在"skill 变更"卡上确认之后，
// 运行时才复制进 skill 区、配进它的工具包，它的会话按新的装配重新拉起，这个 skill 就能用了。真的守护进程、真的 skill 区；模型是假的。
// 覆盖的验收：
// - 假模型走通闭环：负责人写好 skill、提交、卡进待办；用户确认；skill 进库并配进工具包；重新拉起后系统提示里有这个 skill；
// - 未确认时 skill 区一个字节都不变，校验不过不出卡；
// - 拒绝：不变，记了决定（审批决定素材里查得到）；
// - 用写文件、bash 直接往 skill 区写被拦下（处置"永不"）；
// - 删了之后工具包里留着的名字不挡别的改动（改工具包、会话照常拉起）；
// - 任务自己的负责人（执行中）也有这个工具，配进任务的工具包；
// - 用 Claude Code 跑的负责人走同一条路（mcp__ergo__request_skill_change），子 agent 没有这个工具。
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, EVENT_TYPES, maintainerChannel, METHODS, type SkillChangeCardPayload, type SkillDecidedPayload } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { CLAUDE_CODE_RUNTIME_ID } from "../../src/claude-code/api.ts";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { REQUEST_SKILL_CHANGE_TOOL } from "../../src/skills/tool-names.ts";
import { MAINTAINER_ONLY_TOOLS, subAgentAssembly } from "../../src/sub-agents/assembly.ts";
import type { TestDaemon } from "../helpers/daemon.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { toolsNow } from "../helpers/echo.ts";
import { fakeSdkClaudeCodePlugin } from "../helpers/fake-claude-code.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { waitUntil } from "../helpers/process.ts";
import { seedProject } from "../helpers/projects.ts";
import { settled } from "../helpers/settled.ts";
import { call, cardWhere, confirmTask, eventually, fwd, inboxOf, maintainerScript, messagesOf, ok, recordsOf, say, taskWhere, textOf, toolCallsOf, twoStagePlan } from "../helpers/task-flow.ts";
import { seedToolkitProject, toolkit, toolkitApi, writeSkill } from "../helpers/toolkit.ts";

const PM1 = maintainerChannel("pm-1");
const echo = { kind: "echo_context" } as const;
const MARKER = "MARKER_NOTES_STYLE";
const SKILL_TEXT = `---\nname: notes-style\ndescription: ${MARKER}\n---\n\n# 笔记的写法\n\n照着做。\n`;

/** 负责人会话里 agent 的回复（echo_context 回的是它看到的上下文） */
const repliesOf = (frontend: TestFrontend, channel: string) =>
  messagesOf(frontend, channel)
    .filter((m) => m.message.speaker === "agent" && m.message.parts.some((p) => p.type === "text"))
    .map(textOf);

async function nthReply(frontend: TestFrontend, channel: string, n: number): Promise<string> {
  await waitUntil(() => repliesOf(frontend, channel).length >= n, { timeoutMs: 60_000, describe: () => `等 ${channel} 的第 ${n} 条回复；现在是：\n${repliesOf(frontend, channel).map((t) => t.slice(0, 200)).join("\n")}` });
  return repliesOf(frontend, channel)[n - 1]!;
}

async function connect(td: TestDaemon, extra: string[] = []): Promise<TestFrontend> {
  const frontend = await TestFrontend.connect(td.url);
  await frontend.subscribe(Object.fromEntries([CHANNELS.cards, CHANNELS.inbox, CHANNELS.projects, PM1, ...extra].map((channel) => [channel, 0])));
  return frontend;
}

const skillArea = (td: TestDaemon) => dataDirLayout(td.dataDir).skills;
const listing = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).toSorted() : []);

describe("skill 变更", () => {
  it("假模型走通闭环：负责人写好 skill、提交，卡进待办；用户确认后进库、配进工具包，重新拉起之后 skill 能用；时间线、审计、素材都记着", { timeout: 120_000 }, async () => {
    const td = await startTestDaemon({
      // 第 1 次：写 SKILL.md、提交（接着回它看到的上下文）；批准之后按新工具包重新拉起
      maintainer: (_id, spawn) =>
        spawn === 1
          ? [call("write", { path: "skill-src/notes-style/SKILL.md", content: SKILL_TEXT }), call("write", { path: "skill-src/notes-style/run.py", content: "print('x')\n" }), call("request_skill_change", { action: "add", path: "skill-src/notes-style", why: "做项目沉淀下来的，别的项目也用得上" }), echo]
          : [echo, say("用上了")],
    });
    const project = seedToolkitProject(td.daemon, "笔记", toolkit());
    const frontend = await connect(td);
    await frontend.sendText("把写笔记的规矩沉淀成 skill", { conversation: PM1 });

    const card = await cardWhere(frontend, (c) => c.type === "skill_change", "skill 变更卡");
    const payload = card.payload as SkillChangeCardPayload;
    expect(payload).toMatchObject({
      action: "add",
      name: "notes-style",
      description: MARKER,
      why: "做项目沉淀下来的，别的项目也用得上",
      submitter: { kind: "project", projectId: project.id, projectName: "笔记", maintainerId: "pm-1" },
      source: { dirName: "notes-style", fileCount: 2, scriptCount: 1 },
    });
    expect(payload.source!.skillMd).toBe(SKILL_TEXT);
    expect(card.text).toContain("里面有 1 个脚本，用它的 agent 可能会运行");
    expect(inboxOf(frontend).some((item) => item.kind === "card" && item.cardId === card.id)).toBe(true);
    // 工具结果告诉负责人卡进待办了；没确认之前 skill 区一个字节都没有
    expect(await nthReply(frontend, PM1, 1)).toContain("已提交“skill 变更”卡");
    expect(listing(skillArea(td))).toEqual([]);
    expect(td.daemon.projects.get(project.id)?.toolkit?.skills).toEqual([]);

    await settled(td, "pm-1");
    ok(await frontend.cardAction({ cardId: card.id, action: "approve", expectedVersion: card.version, note: "收了" }));
    // 进库了（目录名是来源的目录名），工具包里有了
    expect(fs.readFileSync(path.join(skillArea(td), "notes-style", "SKILL.md"), "utf8")).toBe(SKILL_TEXT);
    expect(td.daemon.projects.get(project.id)?.toolkit?.skills).toEqual(["notes-style"]);
    const catalog = (await toolkitApi.catalog(td.url)).body.skills.find((s) => s.name === "notes-style");
    expect(catalog).toMatchObject({ origin: "imported", submittedBy: { kind: "project", title: "笔记" } });
    // 重新拉起之后：系统提示里有这个 skill，能用
    const seen = await nthReply(frontend, PM1, 2);
    expect(seen).toContain(MARKER);
    expect(seen.split("[system]").at(-1)).toContain("notes-style");
    // 卡、时间线、审计、素材
    const approved = frontend.events({ channel: CHANNELS.cards, type: EVENT_TYPES.card }).map((f) => (f.payload as { card: { id: string; status: string; payload: SkillChangeCardPayload; outcome?: { note?: string } } }).card).filter((c) => c.id === card.id).at(-1)!;
    expect(approved.status).toBe("handled");
    expect(approved.payload).toMatchObject({ applied: true, addedToToolkit: true, check: { ok: true } });
    expect(approved.outcome?.note).toContain("进库了");
    const record = recordsOf(frontend, PM1).map((r) => r.record).filter((r) => r.kind === "skill").at(-1)!;
    expect(record.summary).toContain("项目「笔记」的负责人");
    expect(record.summary).toContain("自检通过");
    expect(td.daemon.store.read("skills", 0).map((e) => e.payload as SkillDecidedPayload)).toMatchObject([{ decision: "approved", action: "add", name: "notes-style", cardId: card.id, applied: true, note: "收了" }]);
    const decision = await eventually(() => td.daemon.materials.list({ kind: "approval_decision" }).filter((m) => m.context.includes("card:skill_change")), (m) => m.context.includes("decision:approved"), "skill 变更的审批决定素材");
    expect(decision.segments.map((s) => s.text).join("\n")).toContain("收了");
    await frontend.close();
  });

  it("拒绝：一个字节都不变，记了决定；校验不过（工作目录外）不出卡；用写文件、bash 直接往 skill 区写被拦下", { timeout: 120_000 }, async () => {
    let target = "";
    const td = await startTestDaemon({
      maintainer: (_id, spawn) =>
        spawn === 1
          ? [
              // 工作目录外：当场回原因
              call("request_skill_change", { action: "add", path: path.dirname(path.dirname(target)) }),
              // 绕过：自己写 skill 区
              call("write", { path: path.join(skillArea(td), "sneaky", "SKILL.md"), content: SKILL_TEXT }),
              call("bash", { command: `mkdir -p "${fwd(path.join(skillArea(td), "sneaky"))}" && echo x > "${fwd(path.join(skillArea(td), "sneaky", "SKILL.md"))}"` }),
              call("write", { path: "skill-src/notes-style/SKILL.md", content: SKILL_TEXT }),
              call("request_skill_change", { action: "add", path: "skill-src/notes-style" }),
              echo,
            ]
          : [echo],
    });
    target = path.join(td.dataDir, "projects", "p-1", "x");
    seedToolkitProject(td.daemon, "笔记", toolkit({ bash: true }));
    const frontend = await connect(td);
    await frontend.sendText("试试", { conversation: PM1 });
    const card = await cardWhere(frontend, (c) => c.type === "skill_change", "skill 变更卡");
    const seen = await nthReply(frontend, PM1, 1);
    expect(seen).toContain("[toolResult] request_skill_change");
    expect(seen).toContain("只能是你自己的工作目录或项目档案");
    // 只有那一张合规的出了卡
    const skillCards = () => frontend.events({ channel: CHANNELS.cards, type: EVENT_TYPES.card }).filter((f) => (f.payload as { card: { type: string } }).card.type === "skill_change");
    expect(skillCards()).toHaveLength(1);
    // 直接写的两条路都被拦下（处置"永不"，结局"被拦下"）
    const calls = toolCallsOf(frontend, PM1);
    expect(calls.filter((c) => c.tool === "write" && c.outcome === "blocked")).toHaveLength(1);
    expect(calls.filter((c) => c.tool === "bash").map((c) => [c.disposition, c.outcome])).toEqual([["never", "blocked"]]);
    // 是因为 skill 区是受保护区域
    expect(calls.find((c) => c.tool === "bash")?.resultSummary).toContain("skill 区");
    expect(listing(skillArea(td))).toEqual([]);

    await settled(td, "pm-1");
    ok(await frontend.cardAction({ cardId: card.id, action: "deny", expectedVersion: card.version, note: "先不要" }));
    expect(listing(skillArea(td))).toEqual([]);
    expect(td.daemon.store.read("skills", 0).map((e) => e.payload as SkillDecidedPayload)).toMatchObject([{ decision: "denied", name: "notes-style", applied: false, note: "先不要" }]);
    await eventually(() => td.daemon.materials.list({ kind: "approval_decision" }).filter((m) => m.context.includes("card:skill_change")), (m) => m.context.includes("decision:denied"), "拒绝的审批决定素材");
    await frontend.close();
  });

  it("删：卡上列出在用的工具包；删了之后工具包里留着的名字不挡别的改动，会话照常拉起（跳过它）；改工具包时新加不在库里的照旧拒绝", { timeout: 120_000 }, async () => {
    const td = await startTestDaemon({
      maintainer: (id, spawn) => (id === "pm-1" && spawn === 1 ? [call("request_skill_change", { action: "remove", name: "notes-style", why: "过时了" }), say("提了")] : [echo]),
    });
    writeSkill(path.join(skillArea(td), "notes-style"), "notes-style", MARKER);
    const first = seedToolkitProject(td.daemon, "笔记", toolkit({ skills: ["notes-style"] }));
    const second = seedToolkitProject(td.daemon, "别的项目", toolkit({ skills: ["notes-style"] }));
    const frontend = await connect(td, [maintainerChannel(second.maintainerId)]);
    await frontend.sendText("这个 skill 不要了", { conversation: PM1 });
    const card = await cardWhere(frontend, (c) => c.type === "skill_change", "删 skill 的卡");
    expect(card.payload).toMatchObject({ action: "remove", name: "notes-style", usedBy: [{ kind: "project", title: "笔记" }, { kind: "project", title: "别的项目" }] });
    await settled(td, "pm-1");
    ok(await frontend.cardAction({ cardId: card.id, action: "approve", expectedVersion: card.version }));
    expect(listing(skillArea(td))).toEqual([".history"]);
    expect(listing(path.join(skillArea(td), ".history"))[0]).toMatch(/^notes-style@/);
    // 别的项目的工具包里名字留着；它的会话照常拉起，只是不带这个 skill
    expect(td.daemon.projects.get(second.id)?.toolkit?.skills).toEqual(["notes-style"]);
    await frontend.sendText("看看", { conversation: maintainerChannel(second.maintainerId) });
    expect(await nthReply(frontend, maintainerChannel(second.maintainerId), 1)).not.toContain(MARKER);
    // 留着的名字不挡别的改动：开 bash 照样改得了
    const changed = ok(await frontend.request(METHODS.setToolkit, { target: { kind: "project", projectId: second.id }, toolkit: toolkit({ skills: ["notes-style"], bash: true }) }, "k-stale"));
    expect(changed).toMatchObject({ toolkit: { bash: true, skills: ["notes-style"] } });
    // 新加不在库里的照旧拒绝
    expect(await frontend.request(METHODS.setToolkit, { target: { kind: "project", projectId: first.id }, toolkit: toolkit({ skills: ["notes-style", "chart-maker"] }) }, "k-bad")).toMatchObject({ error: { code: "bad_params", message: expect.stringContaining("chart-maker") } });
    await frontend.close();
  });

  it("任务自己的负责人（执行中）也有这个工具：配进任务的工具包，项目的不动", { timeout: 120_000 }, async () => {
    const plan = twoStagePlan({ toolkit: toolkit() });
    const td = await startTestDaemon({
      maintainer: maintainerScript(plan, (spawn) =>
        spawn === 2 ? [call("write", { path: "skill-src/task-skill/SKILL.md", content: `---
name: task-skill
description: ${MARKER}
---

照着做。
` }), call("request_skill_change", { action: "add", path: "skill-src/task-skill" }), echo] : [echo],
      ),
    });
    const frontend = await connect(td, [maintainerChannel("tm-1"), CHANNELS.board]);
    const taskId = await confirmTask(td, frontend, "整理发票");
    const card = await cardWhere(frontend, (c) => c.type === "skill_change", "任务负责人提的 skill 变更卡");
    expect(card.payload).toMatchObject({ action: "add", name: "task-skill", submitter: { kind: "task", taskId, taskTitle: "整理发票", maintainerId: td.daemon.tasks.get(taskId)!.maintainerId } });
    ok(await frontend.cardAction({ cardId: card.id, action: "approve", expectedVersion: card.version }));
    expect(td.daemon.skills.find(["task-skill"])).toHaveLength(1);
    expect(td.daemon.tasks.confirmedPlan(taskId)?.plan.toolkit.skills).toEqual(["task-skill"]);
    await taskWhere(frontend, (e) => e.change === "toolkit_changed" && e.task.id === taskId, "任务的工具包变了");
    await frontend.close();
  });

  it("任务的计划里留着被删了的 skill：自行调整计划照常过；新加不在库里的照旧拒绝", { timeout: 120_000 }, async () => {
    const plan = twoStagePlan({ toolkit: toolkit({ skills: ["notes-style"] }) });
    const { watchCategories: _w, userLimits: _u, memoryScope: _m, ...rest } = plan;
    // 不扩大授权的调整：第一阶段写明步骤（工具包不动，里面留着被删了的 notes-style）
    const draft = { ...rest, stages: [{ ...plan.stages[0]!, mode: "steps", steps: ["先列清单", "再核对"] }, plan.stages[1]!] };
    let removed = false;
    const td = await startTestDaemon({
      maintainer: maintainerScript(plan, (spawn) => {
        // 执行开始之前这个 skill 从库里删了
        if (spawn === 2 && !removed) {
          removed = true;
          td.daemon.skills.removeSkill("notes-style");
        }
        return spawn === 2 ? [call("revise_plan", { plan: draft, why: "调一下" }), call("revise_plan", { plan: { ...draft, toolkit: toolkit({ skills: ["notes-style", "chart-maker"] }) }, why: "加一个没有的" }), say("调完了")] : [echo];
      }),
    });
    writeSkill(path.join(skillArea(td), "notes-style"), "notes-style", MARKER);
    const frontend = await connect(td, [maintainerChannel("tm-1"), CHANNELS.board]);
    const taskId = await confirmTask(td, frontend, "整理笔记");
    const channel = maintainerChannel(td.daemon.tasks.get(taskId)!.maintainerId);
    await frontend.subscribe({ [channel]: 0 });
    const revises = () => toolCallsOf(frontend, channel).filter((c) => c.tool === "revise_plan" && c.outcome !== "running");
    await waitUntil(() => revises().length === 2, { timeoutMs: 60_000, describe: () => `等两次自行调整计划：${JSON.stringify(revises())}` });
    expect(revises()[0]).toMatchObject({ outcome: "done" });
    expect(revises()[1]!.resultSummary).toContain("chart-maker");
    expect(revises()[1]!.resultSummary).not.toContain("notes-style 不在");
    await frontend.close();
  });

  it("用 Claude Code 跑的负责人走同一条路：mcp__ergo__request_skill_change 出卡，确认后插件目录里多出这个 skill", { timeout: 120_000 }, async () => {
    const td = await startTestDaemon({
      extraPlugins: [fakeSdkClaudeCodePlugin],
      maintainer: (id) => (id === "pm-1" ? [call("mcp__ergo__request_skill_change", { action: "add", path: "skill-src/notes-style" }), echo] : []),
    });
    const project = seedProject(td.daemon, "记账本", { state: "in_use", charterConfirmed: true, kind: "dev", runtime: CLAUDE_CODE_RUNTIME_ID, toolkit: toolkit({ bash: true, network: true }) });
    const src = path.join(td.daemon.projects.workdir(project), "skill-src", "notes-style");
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, "SKILL.md"), SKILL_TEXT);
    const frontend = await connect(td);
    await frontend.sendText("沉淀成 skill", { conversation: PM1 });
    const card = await cardWhere(frontend, (c) => c.type === "skill_change", "skill 变更卡");
    expect(card.payload).toMatchObject({ action: "add", name: "notes-style", submitter: { kind: "project", projectId: project.id } });
    await settled(td, "pm-1");
    ok(await frontend.cardAction({ cardId: card.id, action: "approve", expectedVersion: card.version }));
    expect(td.daemon.projects.get(project.id)?.toolkit?.skills).toEqual(["notes-style"]);
    const pluginRoot = path.join(td.dataDir, "cache", "runtimes", project.maintainerId, "ergo");
    await waitUntil(() => fs.existsSync(path.join(pluginRoot, "skills", "notes-style", "SKILL.md")), { timeoutMs: 30_000, describe: () => "等插件目录里多出 notes-style" });
    await frontend.close();
  });

  it("子 agent 没有这个工具：候选里给了也去掉", () => {
    expect(MAINTAINER_ONLY_TOOLS).toContain(REQUEST_SKILL_CHANGE_TOOL);
    const maintainer = { cwd: "C:\\w", toolkit: { bash: true, network: true }, skillPaths: [], piTools: ["read"], hostTools: [REQUEST_SKILL_CHANGE_TOOL, "web_search"], projectRecords: [], workingDirs: ["C:\\w"], development: false };
    const sub = subAgentAssembly(maintainer, { agentId: "sa-1", cwd: "C:\\w", hostTools: [REQUEST_SKILL_CHANGE_TOOL, "web_search"] });
    expect(sub.hostTools).toEqual(["web_search"]);
    expect(sub.guardAgent.toolkit.tools).not.toContain(REQUEST_SKILL_CHANGE_TOOL);
  });

  it("负责人的系统提示里写清楚了什么时候值得提交、SKILL.md 怎么写、要用户确认；工具说明同样", { timeout: 120_000 }, async () => {
    const td = await startTestDaemon({ maintainer: () => [echo] });
    seedToolkitProject(td.daemon, "笔记", toolkit());
    const frontend = await connect(td);
    await frontend.sendText("你能做什么", { conversation: PM1 });
    const seen = await nthReply(frontend, PM1, 1);
    expect(toolsNow(seen)).toContain(REQUEST_SKILL_CHANGE_TOOL);
    expect(seen).toContain("别的项目也用得上");
    expect(seen).toContain("frontmatter");
    expect(seen).toContain("要用户确认");
    await frontend.close();
  });
});
