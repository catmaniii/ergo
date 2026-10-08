// 主切面：秘书主线的看板感知与压缩（规格第 7 节，22 号票）。秘书接 faux 剧本，echo_context 回显它收到的模型输入：
// - 看板自上次以来有变化时（新出现的、状态变了的、换了阶段的），用户的下一条消息后面多一条"看板变化"上下文消息，
//   列出变化；没变时不加；系统提示不动；守护进程重启、秘书子进程崩溃之后变化照样报（可能重报，不能丢）；
// - "查看板"只读工具返回看板的当前内容（和看板频道推给前端的一致）；
// - "读项目档案"只读工具按项目读任意项目（含已归档）的项目档案，不拉起、不唤醒它的维护者；
// - 主线压缩时用秘书专用的压缩指令，压缩后还是同一条主线会话，之后的看板变化消息照常追加。
import fs from "node:fs";
import path from "node:path";
import { type ActivityEventPayload, CHANNELS, EVENT_TYPES, type MessageEventPayload, type Plan, type ReminderEventPayload } from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import type { FauxStep } from "../../src/runtime/index.ts";
import { SECRETARY_COMPACTION_INSTRUCTIONS } from "../../src/secretary/system-prompt.ts";
import { ManualClock } from "../helpers/clock.ts";
import { countAgentSpawns, startTestDaemon } from "../helpers/daemon.ts";
import { stripTimeMarkers } from "../helpers/echo.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { seedProject } from "../helpers/projects.ts";
import { eventually, maintainerScript, onePlan, runningTask, tasksOf } from "../helpers/running-task.ts";

const { secretary: SECRETARY, cards: CARDS, board: BOARD, inbox: INBOX } = CHANNELS;
const ECHO: FauxStep = { kind: "echo_context" };
const call = (name: string, args: Record<string, unknown> = {}): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
/** 回显里某个工具的结果（这一轮最后一条） */
const toolResultOf = (context: string, tool: string) => context.slice(context.lastIndexOf(`[toolResult] ${tool}: `) + `[toolResult] ${tool}: `.length);

async function connect(url: string) {
  const frontend = await TestFrontend.connect(url);
  await frontend.subscribe({ [SECRETARY]: 0, [CARDS]: 0, [BOARD]: 0, [INBOX]: 0 });
  return frontend;
}

/** 用户说一句话，等秘书这一轮结束，返回秘书最后一条回复（echo_context 回显的模型输入，去掉时间标记） */
async function tell(frontend: TestFrontend, text: string): Promise<string> {
  await frontend.sendText(text);
  await eventually(
    () => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd }),
    () => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd }).length === frontend.events({ channel: SECRETARY, type: EVENT_TYPES.message }).filter((f) => (f.payload as MessageEventPayload).message.speaker === "user").length,
    `秘书处理完「${text}」`,
  );
  const last = frontend.events({ channel: SECRETARY, type: EVENT_TYPES.message }).filter((f) => (f.payload as MessageEventPayload).message.speaker === "agent").at(-1)!;
  return stripTimeMarkers((last.payload as MessageEventPayload).message.parts.map((p) => (p.type === "text" ? p.text : "")).join(""));
}

/** 回显里从这条用户消息起的尾巴（这一次模型调用里，它后面还跟了什么） */
const tailFrom = (context: string, userText: string) => context.slice(context.lastIndexOf(`[user] ${userText}`));
/** 回显里系统提示那一段（第一条消息之前） */
const systemOf = (context: string) => context.slice(0, context.indexOf("\n[user] "));

describe("看板变化消息", () => {
  it("看板变了（新任务执行中、执行中转为等我）：用户下一条消息后面多一条看板变化，列出变化；没变时不加；系统提示逐字不变", async () => {
    const td = await startTestDaemon({ secretary: [ECHO, ECHO, ECHO, ECHO], maintainer: maintainerScript() });
    const frontend = await connect(td.url);

    const first = await tell(frontend, "在吗");
    expect(tailFrom(first, "在吗")).toBe("[user] 在吗");

    const taskId = await runningTask(td, frontend, "整理发票");
    const second = await tell(frontend, "第二句");
    expect(tailFrom(second, "第二句")).toBe(
      [
        "[user] 第二句",
        "[user] 【看板变化】自你上次收到用户的消息以来，任务看板上有这些变化（运行时附上的，不是用户说的；要看全貌用 view_board）：",
        `- 新任务 ${taskId}「整理发票」：执行中`,
      ].join("\n"),
    );

    // 维护者卡住求助：任务从执行中转为等我
    td.daemon.taskExecution.waitForUser({ taskId, maintainerId: "tm-1" }, "缺发票原件");
    await eventually(() => tasksOf(frontend), (e) => e.change === "waiting", "任务转等我");
    const third = await tell(frontend, "第三句");
    expect(tailFrom(third, "第三句")).toBe(
      [
        "[user] 第三句",
        "[user] 【看板变化】自你上次收到用户的消息以来，任务看板上有这些变化（运行时附上的，不是用户说的；要看全貌用 view_board）：",
        `- 任务 ${taskId}「整理发票」：执行中 → 等我（卡住求助：缺发票原件）`,
      ].join("\n"),
    );

    // 没变：不加
    const fourth = await tell(frontend, "第四句");
    expect(tailFrom(fourth, "第四句")).toBe("[user] 第四句");
    // 之前的看板变化留在会话里，各自跟在当时那条用户消息后面
    expect(fourth).toContain(`[user] 第三句\n[user] 【看板变化】`);
    // 系统提示四次一样
    expect(new Set([first, second, third, fourth].map(systemOf)).size).toBe(1);
  }, 60_000);
});

describe("看板变化：守护进程重启之后", () => {
  it("重启后从事件日志对出秘书上次看到的看板：重启前已经报过的不再报，停着时和重启后的变化照常报", async () => {
    const first = await startTestDaemon({ secretary: [ECHO] });
    const before = await connect(first.url);
    first.daemon.reminders.create({ text: "交电费", schedule: { kind: "daily", time: "09:00" } }, "agent");
    expect(tailFrom(await tell(before, "在吗"), "在吗")).toContain("- 新提醒 r-1「交电费」：待触发");
    // 秘书看过之后、停机之前又有变化
    first.daemon.reminders.cancel("r-1", "user");
    await first.daemon.stop();

    const second = await startTestDaemon({ secretary: [ECHO], reuse: { dataDir: first.dataDir, homeDir: first.homeDir } });
    const after = await connect(second.url);
    second.daemon.reminders.create({ text: "买菜", schedule: { kind: "daily", time: "18:00" } }, "agent");
    expect(tailFrom(await tell(after, "回来了"), "回来了")).toBe(
      [
        "[user] 回来了",
        "[user] 【看板变化】自你上次收到用户的消息以来，任务看板上有这些变化（运行时附上的，不是用户说的；要看全貌用 view_board）：",
        "- 提醒 r-1「交电费」：待触发 → 已取消",
        "- 新提醒 r-2「买菜」：待触发",
      ].join("\n"),
    );
  }, 60_000);
});

describe("看板变化：阶段推进", () => {
  it("任务从第 1 阶段进到第 2 阶段（状态还是执行中）：看板变化里报一行进入第几阶段", async () => {
    // 两个阶段：s1 脚本验收（一定通过），s2 在 s1 之后、由用户验收
    const base = onePlan();
    const plan: Plan = {
      ...base,
      stages: [
        { ...base.stages[0]!, stageId: "s1", title: "动手做", acceptance: [{ criterion: "跑得通", method: "script", script: "true" }] },
        { ...base.stages[0]!, stageId: "s2", title: "收尾", dependsOn: ["s1"] },
      ],
    };
    const td = await startTestDaemon({ secretary: [ECHO, ECHO], maintainer: maintainerScript(plan) });
    const frontend = await connect(td.url);
    const taskId = await runningTask(td, frontend, "整理发票");
    expect(tailFrom(await tell(frontend, "在吗"), "在吗")).toContain(`- 新任务 ${taskId}「整理发票」：执行中`);

    expect(await td.daemon.taskExecution.completeStage({ taskId, maintainerId: "tm-1" }, "s1", "做完了")).toMatchObject({ outcome: "accepted" });
    await eventually(() => tasksOf(frontend), (e) => e.change === "stage_started" && e.stageId === "s2", "开始第二阶段");
    expect(tailFrom(await tell(frontend, "现在呢"), "现在呢")).toBe(
      [
        "[user] 现在呢",
        "[user] 【看板变化】自你上次收到用户的消息以来，任务看板上有这些变化（运行时附上的，不是用户说的；要看全貌用 view_board）：",
        `- 任务 ${taskId}「整理发票」进入第 2/2 阶段`,
      ].join("\n"),
    );
  }, 90_000);
});

describe("看板变化：秘书子进程崩溃之后", () => {
  it("带着看板变化的那条消息处理到一半子进程崩了：重新拉起后下一条用户消息照样报这些变化（可能重报，不能丢）", async () => {
    // 回显调慢：第一条消息还在流式输出时就把子进程杀掉
    const td = await startTestDaemon({ secretary: [ECHO], secretaryTokensPerSecond: 400 });
    const frontend = await connect(td.url);
    td.daemon.reminders.create({ text: "交电费", schedule: { kind: "daily", time: "09:00" } }, "agent");

    const first = await frontend.sendText("第一条，说到一半崩了");
    await frontend.next(SECRETARY, EVENT_TYPES.stream);
    process.kill(td.daemon.secretary.pid!);
    await eventually(
      () => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd }),
      (f) => (f.payload as { inputMessageId: string; outcome: string }).inputMessageId === first.messageId && (f.payload as { outcome: string }).outcome === "interrupted",
      "第一条以中断结束",
    );
    await eventually(() => [td.daemon.secretary.status], (s) => s === "idle", "秘书重新拉起", 20_000);

    const second = await tell(frontend, "第二条");
    expect(tailFrom(second, "第二条")).toBe(
      [
        "[user] 第二条",
        "[user] 【看板变化】自你上次收到用户的消息以来，任务看板上有这些变化（运行时附上的，不是用户说的；要看全貌用 view_board）：",
        "- 新提醒 r-1「交电费」：待触发",
      ].join("\n"),
    );
  }, 90_000);
});

describe("查看板", () => {
  it("只读工具返回看板的当前内容：任务、简单提醒按看板的分组列出（和看板频道推给前端的一致），已取消的提醒不上看板", async () => {
    // 2026-10-08（周四）10:00，本地时间
    const clock = new ManualClock(new Date(2026, 9, 8, 10, 0));
    const td = await startTestDaemon({ secretary: [call("view_board"), ECHO], maintainer: maintainerScript(), clock });
    const frontend = await connect(td.url);
    const taskId = await runningTask(td, frontend, "整理发票");
    td.daemon.reminders.create({ text: "交电费", schedule: { kind: "daily", time: "09:00" } }, "agent");
    td.daemon.reminders.create({ text: "取消掉的", schedule: { kind: "daily", time: "08:00" } }, "agent");
    td.daemon.reminders.cancel("r-2", "user");

    const result = toolResultOf(await tell(frontend, "现在看板上有什么"), "view_board");
    expect(result).toBe(
      [
        "## 进行中（1）",
        `- 任务 ${taskId}「整理发票」：执行中；第 1/1 阶段`,
        "## 运营中（1）",
        "- 提醒 r-1「交电费」：待触发；每天 09:00；下一次 10 月 9 日（周五）09:00",
      ].join("\n"),
    );
    // 看板频道推给前端的最新状态是同样的
    const reminders = new Map(frontend.events({ channel: BOARD, type: EVENT_TYPES.reminder }).map((f) => [(f.payload as ReminderEventPayload).reminder.id, (f.payload as ReminderEventPayload).reminder.status]));
    expect(Object.fromEntries(reminders)).toEqual({ "r-1": "pending", "r-2": "cancelled" });
    expect(tasksOf(frontend).at(-1)!.task).toMatchObject({ id: taskId, state: "running", stages: { current: 1, total: 1 } });
  }, 60_000);
});

describe("读项目档案", () => {
  it("按项目（编号或名字）读任意项目的项目档案，已归档的也能读；不拉起、不唤醒它的维护者，活动状态不变", async () => {
    const td = await startTestDaemon({
      secretary: [call("read_project_records", { project: "记账" }), ECHO, call("read_project_records", { project: "p-2", docs: ["progress"] }), ECHO],
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0, [CHANNELS.activity]: 0 });
    const ledger = seedProject(td.daemon, "记账", { state: "in_use", charterConfirmed: true });
    const fridge = seedProject(td.daemon, "冰箱档案", { state: "archived", archivedFrom: "in_use" });
    const write = (projectId: string, rel: string, content: string) => {
      const file = path.join(td.daemon.projects.records(projectId).root, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    };
    write(ledger.id, "charter.md", "# 立项书\n记账：每月对账");
    write(ledger.id, "progress.md", "# 进展\n首版已上线，下一步做报表");
    write(ledger.id, "adr/0001-sqlite.md", "# 用 SQLite 存账");
    write(fridge.id, "progress.md", "# 进展\n停用前做完了录入");
    fs.rmSync(td.daemon.projects.records(ledger.id).spec, { force: true });
    const spawned = countAgentSpawns(td.daemon);

    const first = toolResultOf(await tell(frontend, "记账项目进展如何"), "read_project_records");
    expect(first).toContain(`项目 ${ledger.id}「记账」（使用中）的项目档案`);
    expect(first).toContain("## 立项书（charter.md）\n# 立项书\n记账：每月对账");
    expect(first).toContain("## 进展（progress.md）\n# 进展\n首版已上线，下一步做报表");
    expect(first).toContain("### adr/0001-sqlite.md\n# 用 SQLite 存账");
    // 还没写的文件如实说
    expect(first).toContain("## 规格（spec.md）\n（还没有这个文件）");

    const second = toolResultOf(await tell(frontend, "冰箱档案那个项目当时做到哪了"), "read_project_records");
    expect(second).toContain(`项目 ${fridge.id}「冰箱档案」（已归档）的项目档案`);
    expect(second).toContain("## 进展（progress.md）\n# 进展\n停用前做完了录入");
    expect(second).not.toContain("立项书");

    // 维护者一直休眠：没拉起任何 agent，活动状态频道上没有它们
    expect(spawned()).toBe(0);
    const touched = frontend.events({ channel: CHANNELS.activity, type: EVENT_TYPES.activity }).map((f) => (f.payload as ActivityEventPayload).agentId);
    expect(touched.filter((id) => id.startsWith("pm-"))).toEqual([]);
  }, 60_000);
});

describe("主线压缩", () => {
  it("自动压缩（上下文溢出）时写摘要用秘书专用的压缩指令；压缩后还是同一条主线会话，之后的看板变化照常追加", async () => {
    const td = await startTestDaemon({
      secretary: [
        { kind: "reply", text: "在" },
        { kind: "reply", text: "收到一大段" },
        // 第三句：模型报上下文溢出，自动压缩（写摘要的那次调用回显它收到的），再重试这一轮
        { kind: "context_overflow" },
        ECHO,
        ECHO,
        ECHO,
      ],
    });
    const frontend = await connect(td.url);
    const pid = td.daemon.secretary.pid;
    await tell(frontend, "开头先说一句");
    // 很长的一句（约 2.5 万 token）：压缩时留下它和它之后的，它之前的写进摘要
    await tell(frontend, `材料：${"一段很长的材料。".repeat(12_500)}`);
    td.daemon.reminders.create({ text: "交电费", schedule: { kind: "daily", time: "09:00" } }, "agent");

    const third = await tell(frontend, "第三句");
    // 摘要是写摘要那次调用收到的东西：秘书专用的压缩指令（丢掉和保留的要求都在）
    expect(third).toContain(`Additional focus: ${SECRETARY_COMPACTION_INSTRUCTIONS}`);
    for (const requirement of ["丢掉任务的执行细节", "已经解决了的问答", "只留任务 ID 和一句话", "还在进行中的话题", "还没回答的问题", "还没处理的指示"]) {
      expect(SECRETARY_COMPACTION_INSTRUCTIONS).toContain(requirement);
    }
    // 压缩掉的开头只在摘要里
    expect(third).not.toContain("[user] 开头先说一句");
    expect(tailFrom(third, "第三句")).toBe(
      ["[user] 第三句", "[user] 【看板变化】自你上次收到用户的消息以来，任务看板上有这些变化（运行时附上的，不是用户说的；要看全貌用 view_board）：", "- 新提醒 r-1「交电费」：待触发"].join("\n"),
    );

    // 压缩之后：看板变化照常追加
    td.daemon.reminders.cancel("r-1", "user");
    const fourth = await tell(frontend, "第四句");
    expect(tailFrom(fourth, "第四句")).toBe(
      ["[user] 第四句", "[user] 【看板变化】自你上次收到用户的消息以来，任务看板上有这些变化（运行时附上的，不是用户说的；要看全貌用 view_board）：", "- 提醒 r-1「交电费」：待触发 → 已取消"].join("\n"),
    );
    expect(fourth).toContain(SECRETARY_COMPACTION_INSTRUCTIONS);
    // 同一条主线会话：同一个子进程，会话区里只有一个会话文件
    expect(td.daemon.secretary.pid).toBe(pid);
    expect(fs.readdirSync(path.join(td.daemon.layout.sessions, "secretary")).filter((f) => f.endsWith(".jsonl"))).toHaveLength(1);
  }, 90_000);
});
