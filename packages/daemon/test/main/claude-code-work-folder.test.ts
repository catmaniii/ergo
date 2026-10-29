// 主切面：新建 Claude Code 任务 / 项目时选工作文件夹、设置里定默认文件夹（305 号票）。真的守护进程走组合根和插件清单，清单里的
// Claude Code 插件经 extraPlugins 换成子进程接假 SDK 的那个（helpers/fake-claude-code.ts：运行时、适配子进程、守卫的钩子都是真的，
// SDK 按 faux 剧本扮演 claude，不启动真的 claude、不花额度）。测试扮演前端。
// - 设置里的默认文件夹（PUT /api/runtimes/claude-code/work-folder）：运行时清单里带上；不存在、是文件、在数据目录或二狗程序目录里的 400；
//   pi 不能设；
// - 设了默认文件夹：点"发起任务"选 Claude Code（不选文件夹）→ 在默认文件夹下按标题新开子文件夹，子进程的 cwd 就是它；同名的再建一个加序号；
//   起了名字的照名字；
// - 选已有文件夹：cwd 是它；路径不对（不存在、是文件、在数据目录、在二狗程序目录里）被拒，原因写明；pi 的任务不看文件夹；
// - 守卫：在选的文件夹里写不弹卡，在外面写弹审批卡；
// - 长程任务：重注入块写的工作目录、阶段验收的脚本都在选的文件夹里（294 号票端到端小测发现原来按产出区）；
// - 新建项目：选了已有文件夹的先核对（不对的当场拒），通知里写明、秘书照写在建议立项卡上，点"立项"后项目的工作目录就是它（在外面）。
import fs from "node:fs";
import path from "node:path";
import { type Card, type CardEventPayload, CHANNELS, EVENT_TYPES, maintainerChannel, type MessageEventPayload, type MessagePart, METHODS, type ResponseFrame, type Task } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { CLAUDE_CODE_RUNTIME_ID } from "../../src/claude-code/api.ts";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { TOOL } from "../../src/guard/index.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { fakeSdkClaudeCodePlugin } from "../helpers/fake-claude-code.ts";
import type { FakeClaudeEcho } from "../helpers/fake-claude-sdk.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { runtimesApi } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";
import { cardWhere, messagesOf, ok, textOf as taskTextOf, twoStagePlan } from "../helpers/task-flow.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;

const echo: FauxStep = { kind: "echo_context" };
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const say = (text: string): FauxStep => ({ kind: "reply", text });

const taskNow = (td: TestDaemon, taskId: string): Task => td.daemon.tasks.get(taskId)!;
const waitState = (td: TestDaemon, taskId: string, state: Task["state"]) =>
  waitUntil(() => taskNow(td, taskId).state === state, { timeoutMs: 30_000, describe: () => `等 ${taskId} ${state}，现在：${JSON.stringify(taskNow(td, taskId))}` });
const real = (p: string) => fs.realpathSync.native(p);
const sameDir = (a: string, b: string) => real(a).toLowerCase() === real(b).toLowerCase();
const textOf = (p: MessageEventPayload) => p.message.parts.map((part) => ("text" in part ? part.text : `<${part.type}>`)).join("");
const agentSaid = (td: TestDaemon, channel: string) =>
  td.daemon.store
    .read(channel, 0, EVENT_TYPES.message)
    .map((e) => e.payload as MessageEventPayload)
    .filter((p) => p.message.speaker === "agent")
    .map(textOf);
/** 维护者看到的（假 SDK 的 echo_context）：第 n 条回复 */
async function echoed(td: TestDaemon, task: Task, n = 1): Promise<FakeClaudeEcho> {
  const channel = maintainerChannel(task.maintainerId);
  await waitUntil(() => agentSaid(td, channel).length >= n, { timeoutMs: 30_000, describe: () => `等 ${channel} 的第 ${n} 条回复：${JSON.stringify(agentSaid(td, channel))}` });
  return JSON.parse(agentSaid(td, channel)[n - 1]!) as FakeClaudeEcho;
}
const started = (r: ResponseFrame): string => (ok(r) as { taskId: string }).taskId;
const refusal = (r: ResponseFrame): string => {
  if (r.ok) throw new Error(`应该被拒：${JSON.stringify(r.result)}`);
  return r.error.message;
};
const cardsOf = (td: TestDaemon): Card[] => td.daemon.store.read(CHANNELS.cards, 0, EVENT_TYPES.card).map((e) => (e.payload as CardEventPayload).card);
const toolParts = (td: TestDaemon, task: Task): ToolCallPart[] =>
  td.daemon.store
    .read(maintainerChannel(task.maintainerId), 0, EVENT_TYPES.message)
    .flatMap((e) => (e.payload as MessageEventPayload).message.parts.filter((p): p is ToolCallPart => p.type === "tool_call"));

describe("新建 Claude Code 任务时选工作文件夹（305 号票）", () => {
  it("设置里的默认文件夹：新建的在它下面按标题新开子文件夹、cwd 是它，重名加序号；选已有的 cwd 是它；路径不对被拒；pi 不看", async () => {
    const workRoot = makeTempDir("ergo-cc-work-");
    const existing = makeTempDir("ergo-cc-existing-");
    const aFile = path.join(existing, "readme.md");
    fs.writeFileSync(aFile, "# 说明\n");
    const programDir = makeTempDir("ergo-cc-program-");
    const td = await startTestDaemon({ extraPlugins: [fakeSdkClaudeCodePlugin], programDir, maintainer: () => [echo] });
    const frontend = await TestFrontend.connect(td.url);

    // 默认文件夹：路径不对的 400（不存在、是文件、数据目录里、二狗程序目录里）；pi 不能设
    const setFolder = (folder: string | null) => runtimesApi.setFolder(td.url, CLAUDE_CODE_RUNTIME_ID, folder);
    expect((await setFolder(path.join(workRoot, "没有这个"))).body.message).toMatch(/不存在/);
    expect((await setFolder(aFile)).body.message).toMatch(/是一个文件/);
    const dataInside = dataDirLayout(td.dataDir).projects;
    fs.mkdirSync(dataInside, { recursive: true });
    expect((await setFolder(dataInside)).status).toBe(400);
    expect((await setFolder(programDir)).body.message).toMatch(/二狗程序目录/);
    expect((await setFolder("relative\\dir")).body.message).toMatch(/不是完整的路径/);
    expect((await runtimesApi.setFolder(td.url, "pi", workRoot)).status).not.toBe(200);
    // 设好了：运行时清单里带上（pi 没有这一项）；存进配置区
    const saved = await setFolder(workRoot);
    expect(saved.status).toBe(200);
    expect(saved.body.runtimes.find((r) => r.id === CLAUDE_CODE_RUNTIME_ID)?.workFolder).toEqual({ defaultFolder: real(workRoot) });
    expect(saved.body.runtimes.find((r) => r.id === "pi")?.workFolder).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(dataDirLayout(td.dataDir).workFoldersFile, "utf8"))).toEqual({ format: 1, defaults: { [CLAUDE_CODE_RUNTIME_ID]: real(workRoot) } });

    // 不选文件夹：在默认文件夹下按标题新开一个子文件夹（不合法的字符换掉），子进程的 cwd 就是它
    const first = taskNow(td, started(await frontend.startTask("整理下载/目录", undefined, undefined, "plain", undefined, { runtime: CLAUDE_CODE_RUNTIME_ID })));
    expect(first.workdir).toBeDefined();
    expect(sameDir(first.workdir!, path.join(workRoot, "整理下载-目录"))).toBe(true);
    expect((await echoed(td, first)).options.cwd).toBe(first.workdir);
    await waitState(td, first.id, "done");
    // 同名再建一个：加序号；同一个幂等键重发不多开文件夹
    const again = await frontend.startTask("整理下载/目录", "k-again", undefined, "plain", undefined, { runtime: CLAUDE_CODE_RUNTIME_ID });
    const second = taskNow(td, started(again));
    expect(sameDir(second.workdir!, path.join(workRoot, "整理下载-目录 (2)"))).toBe(true);
    expect(started(await frontend.startTask("整理下载/目录", "k-again", undefined, "plain", undefined, { runtime: CLAUDE_CODE_RUNTIME_ID }))).toBe(second.id);
    expect(fs.readdirSync(workRoot).toSorted()).toEqual(["整理下载-目录", "整理下载-目录 (2)"]);
    // 起了名字的照名字
    const named = taskNow(td, started(await frontend.request(METHODS.startTask, { request: "写周报", kind: "plain", runtime: CLAUDE_CODE_RUNTIME_ID, folder: { kind: "new", name: "weekly" } }, "k-named")));
    expect(sameDir(named.workdir!, path.join(workRoot, "weekly"))).toBe(true);

    // 选已有的文件夹：cwd 是它
    const inExisting = taskNow(td, started(await frontend.request(METHODS.startTask, { request: "看看这个仓库", kind: "plain", runtime: CLAUDE_CODE_RUNTIME_ID, folder: { kind: "existing", path: existing } }, "k-existing")));
    expect(sameDir(inExisting.workdir!, existing)).toBe(true);
    expect((await echoed(td, inExisting)).options.cwd).toBe(inExisting.workdir);

    // 路径不对的被拒、不建任务
    const before = td.daemon.tasks.list().length;
    const refuse = async (folder: string) => refusal(await frontend.request(METHODS.startTask, { request: "不该建出来", kind: "plain", runtime: CLAUDE_CODE_RUNTIME_ID, folder: { kind: "existing", path: folder } }, `k-bad-${folder}`));
    expect(await refuse(path.join(existing, "没有这个"))).toMatch(/不存在/);
    expect(await refuse(aFile)).toMatch(/是一个文件/);
    expect(await refuse(dataInside)).toMatch(/数据目录/);
    expect(await refuse(programDir)).toMatch(/二狗程序目录/);
    expect(td.daemon.tasks.list().length).toBe(before);

    // pi 的任务不看文件夹（照旧用产出区）
    const pi = taskNow(td, started(await frontend.request(METHODS.startTask, { request: "pi 的任务", kind: "plain", folder: { kind: "existing", path: existing } }, "k-pi")));
    expect(pi.runtime).toBeUndefined();
    expect(pi.workdir).toBeUndefined();

    // 秘书交给后台的（delegate_task 的 folder）：已有的照用；不写的按默认新开
    const delegated = td.daemon.tasks.delegate({ title: "查日志", instructions: "看看日志", runtime: CLAUDE_CODE_RUNTIME_ID, folder: { kind: "existing", path: existing } });
    expect(sameDir(delegated.workdir!, existing)).toBe(true);
    const byDefault = td.daemon.tasks.delegate({ title: "查日志", instructions: "看看日志", runtime: CLAUDE_CODE_RUNTIME_ID });
    expect(sameDir(byDefault.workdir!, path.join(workRoot, "查日志"))).toBe(true);

    // 不设了：新建的照旧（产出区）
    expect((await setFolder(null)).body.runtimes.find((r) => r.id === CLAUDE_CODE_RUNTIME_ID)?.workFolder).toEqual({});
    const plain = taskNow(td, started(await frontend.startTask("没有默认文件夹", undefined, undefined, "plain", undefined, { runtime: CLAUDE_CODE_RUNTIME_ID })));
    expect(plain.workdir).toBeUndefined();
    expect(fs.existsSync(dataDirLayout(td.dataDir).workFoldersFile)).toBe(false);

    // 只核对的接口（新建对话框交之前看一眼）
    expect((await runtimesApi.checkFolder(td.url, CLAUDE_CODE_RUNTIME_ID, existing)).body.folder).toBe(real(existing));
    expect((await runtimesApi.checkFolder(td.url, CLAUDE_CODE_RUNTIME_ID, aFile)).status).toBe(400);
  }, 120_000);

  it("守卫：在选的文件夹里写不弹卡；在外面写——文件工具一律拒绝，bash 弹审批卡", async () => {
    const folder = makeTempDir("ergo-cc-folder-");
    const outside = makeTempDir("ergo-cc-outside-");
    // 写真实路径（临时目录可能是 8.3 短名：守卫按写的路径和真实路径都核对）
    const inside = path.join(real(folder), "notes.md");
    const outFile = path.join(real(outside), "notes.md");
    const td = await startTestDaemon({
      extraPlugins: [fakeSdkClaudeCodePlugin],
      maintainer: () => [
        call("Write", { file_path: inside, content: "# 笔记\n" }),
        call("Write", { file_path: outFile, content: "# 笔记\n" }),
        call("Bash", { command: `echo hi > "${outFile.replaceAll("\\", "/")}"`, description: "写到外面" }),
        say("写好了。"),
      ],
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [CHANNELS.cards]: 0 });
    const task = taskNow(td, started(await frontend.request(METHODS.startTask, { request: "记笔记", kind: "plain", runtime: CLAUDE_CODE_RUNTIME_ID, folder: { kind: "existing", path: folder } }, "k-guard")));
    expect(sameDir(task.workdir!, folder)).toBe(true);

    // bash 写到外面：审批卡（越出项目目录）；之前文件夹里的那次写已经做了、没弹卡，文件工具写外面的被拒（不问用户）
    let approval: Card | undefined;
    await waitUntil(() => (approval = cardsOf(td).find((c) => c.type === "approval" && c.status === "pending")) !== undefined, {
      timeoutMs: 60_000,
      describe: () => `等审批卡；工具调用：${JSON.stringify(toolParts(td, task).map((p) => [p.tool, p.argsSummary, p.outcome, p.blockedBy, p.resultSummary, p.categoryTitles]))}`,
    });
    expect(JSON.stringify(approval!.payload)).toContain(path.basename(outside));
    const writes = toolParts(td, task).filter((p) => p.tool === TOOL.write);
    expect(writes.map((p) => [p.argsSummary.includes(path.basename(folder)), p.outcome])).toEqual([
      [true, "done"],
      [false, "blocked"],
    ]);
    expect(writes[1]).toMatchObject({ blockedBy: "hard_refusal" });
    expect(cardsOf(td).filter((c) => c.type === "approval")).toHaveLength(1);
  }, 120_000);

  // 2026-10-26 端到端小测（294 号票）发现：执行时重注入块写的工作目录、阶段验收的脚本都还按产出区 outputs/<任务 id>，
  // 真的 Claude 照着往数据目录里写被拒，验收脚本因为那个目录不存在"闸门进程起不来"
  it("长程任务：重注入块写的工作目录是选的文件夹，阶段验收的脚本在那里跑", async () => {
    const folder = makeTempDir("ergo-cc-long-");
    const base = twoStagePlan();
    const plan = { ...base, stages: [base.stages[0]!] };
    const td = await startTestDaemon({
      extraPlugins: [fakeSdkClaudeCodePlugin],
      maintainer: (_id, spawn) =>
        spawn === 1
          ? [call("mcp__ergo__submit_plan", plan as unknown as Record<string, unknown>), say("计划交上去了")]
          : [call("mcp__ergo__complete_stage", { stageId: "s1", summary: "清单写好了" }), echo],
    });
    // 假 SDK 不真的执行 Claude 的工具：交付件先放好，验收脚本 test -f sources.md 只有在这个文件夹里跑才过
    fs.writeFileSync(path.join(folder, "sources.md"), "- 来源\n");
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [CHANNELS.cards]: 0 });
    const task = taskNow(td, started(await frontend.request(METHODS.startTask, { request: "整理资料", kind: "long_running", runtime: CLAUDE_CODE_RUNTIME_ID, folder: { kind: "existing", path: folder } }, "k-long")));
    // 交给秘书的通知写明了在哪个文件夹做（秘书就不再问"放在哪"）
    const notices = td.daemon.store.read(CHANNELS.secretary, 0, EVENT_TYPES.message).map((e) => textOf(e.payload as MessageEventPayload));
    expect(notices.some((text) => text.includes(`定好的工作文件夹里做：${task.workdir}`))).toBe(true);
    td.daemon.tasks.writeBrief(task.id, { goal: "整理资料", acceptanceCriteria: ["有资料清单"], constraints: [], projects: [], memoryScope: "" });
    const card = await cardWhere(frontend, (c) => c.type === "plan");
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: 1, input: {} }));

    await waitState(td, task.id, "done");
    expect(taskNow(td, task.id).stages?.list?.map((s) => [s.stageId, s.state])).toEqual([["s1", "accepted"]]);
    // 执行那一轮最后的 echo（之前几条回复是计划、工具调用；任务完成在验收那一刻，echo 稍后才到）
    const echoText = () => agentSaid(td, maintainerChannel(task.maintainerId)).findLast((text) => text.startsWith("{"));
    await waitUntil(() => echoText() !== undefined, { timeoutMs: 30_000, describe: () => JSON.stringify(agentSaid(td, maintainerChannel(task.maintainerId))) });
    const seen = JSON.parse(echoText()!) as FakeClaudeEcho;
    expect(seen.options.cwd).toBe(task.workdir);
    expect(seen.hookContext).toContain(`工作目录 ${real(folder)}`);
    expect(seen.hookContext).not.toContain(path.join(dataDirLayout(td.dataDir).outputs, task.id));
    expect(fs.existsSync(path.join(dataDirLayout(td.dataDir).outputs, task.id))).toBe(false);
  }, 120_000);
});

describe("新建 Claude Code 项目时选工作文件夹（305 号票）", () => {
  it("选已有文件夹：先核对，通知里写明、秘书照写在建议立项卡上，点立项后项目的工作目录就是它；路径不对当场拒", async () => {
    const existing = makeTempDir("ergo-cc-project-");
    const td = await startTestDaemon({
      extraPlugins: [fakeSdkClaudeCodePlugin],
      secretary: [{ kind: "reply", toolCalls: [{ name: "suggest_project", arguments: { name: "家电档案", goal: "记下家电的保修", runtime: CLAUDE_CODE_RUNTIME_ID, folder: existing } }] }, { kind: "reply", text: "给你一张建议立项卡" }],
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [CHANNELS.secretary]: 0, [CHANNELS.cards]: 0 });
    expect(refusal(await frontend.request(METHODS.newProject, { request: "做一个家电档案", runtime: CLAUDE_CODE_RUNTIME_ID, folder: { kind: "existing", path: path.join(existing, "没有这个") } }, "k-bad"))).toMatch(/不存在/);
    ok(await frontend.request(METHODS.newProject, { request: "做一个家电档案", runtime: CLAUDE_CODE_RUNTIME_ID, folder: { kind: "existing", path: existing } }, "k-new"));
    const notice = messagesOf(frontend, CHANNELS.secretary).find((m) => m.agentInput);
    expect(notice && taskTextOf(notice)).toContain(`出卡时 folder 原样写 ${JSON.stringify(existing)}`);
    const card = await cardWhere(frontend, (c) => c.type === "suggest_project", "建议立项卡");
    expect(card.payload).toEqual({ name: "家电档案", goal: "记下家电的保修", runtime: CLAUDE_CODE_RUNTIME_ID, folder: { kind: "existing", path: existing } });
    ok(await frontend.cardAction({ cardId: card.id, action: "kickoff", expectedVersion: 1 }));
    await waitUntil(() => td.daemon.projects.list().length === 1, { describe: () => JSON.stringify(td.daemon.projects.list()) });
    const project = td.daemon.projects.list()[0]!;
    expect(project).toMatchObject({ name: "家电档案", runtime: CLAUDE_CODE_RUNTIME_ID, workdir: { external: true } });
    expect(sameDir(project.workdir.path!, existing)).toBe(true);
  }, 60_000);
});
