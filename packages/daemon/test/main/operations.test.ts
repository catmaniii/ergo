// 主切面：运营方案（130 号票，ADR-0028）。真的守护进程，项目的维护者和秘书接 faux 剧本（维护者经 agent 宿主装配、真的调用
// propose_operations），调度器的时钟手动拨，测试扮演前端。
// - 建设期间交：能力超出项目工具包的整份退回；交了的留着，建设任务做完时出现在"首版做完了"卡上（要用户手动的标出来，秘书列待办时
//   看得到）；卡出了以后再交，卡跟着更新（旧版本上点按钮被拒）；
// - "确认并转入使用"：项目进入使用中、每一条建成项目的内部任务（定时的进运营中、触发登记好）、项目上记下现在生效的运营方案，
//   维护者会话里记一笔；同一次确认重发不再建；到点由项目的维护者在一张运行工单里做完；
// - 部分失败：交上来之后项目的工具包收窄了，要联网的那条没生效（项目上记原因、通知维护者），别的照常、项目照常使用中；
// - 使用中的项目交新方案：秘书把用户的话转给项目的维护者（tell_project），维护者出"运营方案变更"卡（附核实过的原话，也出在秘书会话里）；
//   拒绝什么都不动；再交、确认后照差异生效——就地改时间（同一个任务）、去掉的取消、加上的建；停用时暂停、重新启用时恢复；
// - 流程的那一条：带着审查修补后的计划，确认方案时一起授权（流程计划卡建出就是已授权），到点照步骤做完。
import fs from "node:fs";
import path from "node:path";
import {
  type BuildDoneCardPayload,
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  type InboxItem,
  type InboxItemEventPayload,
  maintainerChannel,
  type MessageEventPayload,
  METHODS,
  nowIso,
  type OperationsChangeCardPayload,
  type Project,
  type ProjectEventPayload,
  PURGED_TEXT,
  type ScheduledJobEventPayload,
  type TaskEventPayload,
  type TimelineRecordEventPayload,
  type WorkflowPlanCardPayload,
  type WorkOrderEventPayload,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import type { FauxStep } from "../../src/runtime/index.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { waitUntil } from "../helpers/process.ts";
import { internalTask, seedProject } from "../helpers/projects.ts";
import { eventually, ok } from "../helpers/running-task.ts";
import { settled } from "../helpers/settled.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { oneLine } from "../../src/util/text.ts";

const { secretary: SECRETARY, cards: CARDS, board: BOARD, inbox: INBOX, projects: PROJECTS } = CHANNELS;
const PM1 = maintainerChannel("pm-1");

/** 本地时间 2026 年 m 月 d 日 hh:mm（2026-10-08 是周四） */
const at = (m: number, d: number, hh: number, mm = 0) => new Date(2026, m - 1, d, hh, mm);
const START = at(10, 8, 7, 30);

const say = (text: string): FauxStep => ({ kind: "reply", text });
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const ECHO: FauxStep = { kind: "echo_context" };
/** 消息 id 的样子（m-<uuid>） */
const MESSAGE_ID = "m-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** 维护者从最近一条用户消息末尾抄出 id，交运营方案（参数 userWords） */
const citing = (args: Record<string, unknown>): FauxStep => ({ kind: "call_with_matches", from: "user", pattern: MESSAGE_ID, argument: "userWords", toolCall: { name: "propose_operations", arguments: args as never } });
const propose = (items: readonly object[], why = "项目要每天自己跑起来"): FauxStep => call("propose_operations", { items, why });
const progressEdit = (records: string, oldText: string, newText: string) => call("edit", { path: path.join(records, "progress.md"), edits: [{ oldText, newText }] });
const summary = (text: string) => call("write_segment_summary", { summary: text });
/** 进展文档一开始的那句 */
const PROGRESS_INTRO = "做到哪了、下一步做什么：每段工作结束时写回。";

/** 每天 08:00 出日报（要联网） */
const DAILY = { key: "daily-report", name: "日报", means: "schedule", schedule: { kind: "daily", time: "08:00" }, instructions: "汇总昨天的 AI 新闻，写一期日报 daily.md", capabilities: { network: true } };
/** 每周日 18:00 出周报 */
const WEEKLY = { key: "weekly-report", name: "周报", means: "schedule", schedule: { kind: "weekly", time: "18:00", weekdays: [0] }, instructions: "汇总本周的日报，写一期周报 weekly.md", capabilities: { network: true } };
/** 公网入口：二狗现在做不了，要用户手动（133 号票起项目自己的服务二狗能上线了，见 operation-services.test.ts） */
const SITE = { key: "site", name: "简报站网页", means: "public_entry", instructions: "日报网页从外网也能看", manual: "在 nginx 站点里给工作目录的 site/ 开一个公网入口", capabilities: {} };

const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
const jobsOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.scheduledJob }).map((f) => f.payload as ScheduledJobEventPayload);
const projectEventsOf = (frontend: TestFrontend) => frontend.events({ channel: PROJECTS, type: EVENT_TYPES.project }).map((f) => f.payload as ProjectEventPayload);
const workOrdersOf = (frontend: TestFrontend) => frontend.events({ channel: PROJECTS, type: EVENT_TYPES.workOrder }).map((f) => f.payload as WorkOrderEventPayload);
const inboxOf = (frontend: TestFrontend): InboxItem[] => frontend.events({ channel: INBOX, type: EVENT_TYPES.inboxItem }).map((f) => (f.payload as InboxItemEventPayload).item);
const messagesOf = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.message }).map((f) => f.payload as MessageEventPayload);
const recordsOf = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.timelineRecord }).map((f) => (f.payload as TimelineRecordEventPayload).record);
const textOf = (p: MessageEventPayload) => p.message.parts.map((part) => ("text" in part ? part.text : `<${part.type}>`)).join("");
/** 维护者会话里某个工具的结果（工具调用记录上的） */
const toolResults = (frontend: TestFrontend, tool: string) =>
  messagesOf(frontend, PM1).flatMap((m) => m.message.parts.flatMap((p) => (p.type === "tool_call" && p.tool === tool ? [p] : [])));
/** 等维护者处理完 n 条输入 */
const turns = (frontend: TestFrontend, channel: string, n: number) =>
  waitUntil(() => frontend.events({ channel, type: EVENT_TYPES.turnEnd }).length >= n, { timeoutMs: 30_000, describe: () => `等 ${channel} 处理完 ${n} 条输入` });
/** 同一张卡最新的那一版 */
const latest = (frontend: TestFrontend, cardId: string) => cardsOf(frontend).filter((c) => c.id === cardId).at(-1)!;

async function connect(td: TestDaemon, channels: string[] = [SECRETARY, CARDS, BOARD, INBOX, PROJECTS, PM1]) {
  const frontend = await TestFrontend.connect(td.url);
  await frontend.subscribe(Object.fromEntries(channels.map((c) => [c, 0])));
  return frontend;
}

/** 先定下数据目录和主目录（剧本里要写项目档案的路径），再起守护进程 */
function dirs() {
  const dataDir = makeTempDir("ergo-data-");
  return { dataDir, homeDir: makeTempDir("ergo-home-"), records: path.join(fs.realpathSync.native(dataDir), "projects", "p-1") };
}

/** 一个建设中的项目（立项书已确认，能联网），它的建设任务 t-1 还在规划中 */
function buildingProject(td: TestDaemon, toolkit = { skills: [], mcp: [], bash: false, network: true }): Project {
  const project = seedProject(td.daemon, "AI 简报站", { state: "building", charterConfirmed: true, kind: "other", toolkit, buildTaskId: "t-1" });
  internalTask(td.daemon, "AI 简报站", "建设「AI 简报站」首版");
  return project;
}

/** 建设任务做完（执行和验收在别处测，这里直接造出来）：执行控制器的"任务完成后"回调交给项目模块，出"首版做完了"卡 */
function finishBuild(td: TestDaemon, taskId = "t-1") {
  const task = td.daemon.tasks.get(taskId)!;
  const payload: TaskEventPayload = { task: { ...task, state: "done", updatedAt: nowIso() }, change: "finished" as TaskEventPayload["change"], from: task.state, by: "maintainer" };
  td.daemon.store.append({ channel: BOARD, type: EVENT_TYPES.task, payload });
  td.daemon.projects.taskCompleted(payload.task);
}

const buildDoneCard = (frontend: TestFrontend) => eventually(() => cardsOf(frontend), (c) => c.type === "build_done", "“首版做完了”卡");

describe("建设期间交运营方案，“首版做完了”卡上确认一次就转入使用并开起来", () => {
  it("超出工具包的被拒；交了的留着、卡上带着（要手动的标出来）；卡出了再交卡跟着更新；确认并转入使用：项目使用中、每条建成内部任务、幂等；到点由维护者做完", async () => {
    const d = dirs();
    const clock = new ManualClock(START);
    const td = await startTestDaemon({
      clock,
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      secretary: [say("好的")],
      maintainer: (_id, spawn) =>
        spawn === 1
          ? [
              // 第一句：先交了个要 bash 的（项目的工具包不带 bash，被拒），改好再交日报和网页
              propose([{ ...DAILY, capabilities: { network: true, bash: true } }]),
              propose([DAILY, SITE]),
              progressEdit(d.records, PROGRESS_INTRO, "运营方案：交了日报和网页。"),
              summary("交了运营方案（日报、网页）"),
              ECHO,
              // 第二句（卡已经出了）：加上周报
              propose([DAILY, WEEKLY, SITE], "加上周日晚上的周报"),
              progressEdit(d.records, "运营方案：交了日报和网页。", "运营方案：加了周报。"),
              summary("运营方案加了周报"),
              say("加好了，卡在待办里"),
            ]
          : // 到点的一次运行（一张运行工单，新的一段）
            [progressEdit(d.records, "运营方案：加了周报。", "日报：10-09 的日报出了。"), summary("出了 10-09 的日报"), say("日报出了")],
    });
    buildingProject(td);
    const frontend = await connect(td);

    await frontend.sendText("这个项目做完以后每天早上 8 点出一期日报，再弄个网页给手机看", { conversation: PM1 });
    await turns(frontend, PM1, 1);
    // 维护者的对话段里有这个工具，提示里写着收尾前把运营方案交上来、不要回"建不了"
    const echo = textOf(messagesOf(frontend, PM1).filter((m) => m.message.speaker === "agent").at(-1)!);
    expect(echo).toContain("[tool] propose_operations");
    expect(echo).toContain("用 propose_operations 交一份完整的运营方案，不要写“请用户手动建定时任务”的说明，也不要回“建不了”");
    // 要 bash 的被拒（说明超了什么、怎么办），改好的收下
    const [refused, accepted] = toolResults(frontend, "propose_operations");
    expect(refused).toMatchObject({ outcome: "error" });
    expect(echo).toContain("第 1 条「日报」：要的能力超出了项目的工具包——bash。项目的工具包现在是：bash 关、联网开；skill：无；MCP：无。要加能力先用 request_toolkit_change 申请");
    expect(accepted).toMatchObject({ outcome: "done" });
    expect(echo).toContain("运营方案（第 1 份，2 条）收下了：建设任务做完时出现在“首版做完了”卡上");
    // 还没有卡、还没有任务（只有建设任务）
    expect(cardsOf(frontend).filter((c) => c.type === "build_done")).toEqual([]);
    expect(td.daemon.operations.pendingBuildPlan("p-1")).toMatchObject({ revision: 1, items: [{ key: "daily-report" }, { key: "site", automatic: false }] });

    // 建设任务做完：卡上带着运营方案，要用户手动的标出来；秘书列待办时开头就看得到方案
    finishBuild(td);
    const card = await buildDoneCard(frontend);
    const payload = card.payload as BuildDoneCardPayload;
    expect(card.typeVersion).toBe(4);
    expect(payload.operations).toMatchObject({
      revision: 1,
      items: [
        { key: "daily-report", name: "日报", means: "schedule", meansLabel: "定时触发的任务", automatic: true, triggerText: "每天 08:00", approach: "plain", capabilities: { network: true } },
        { key: "site", name: "简报站网页", means: "public_entry", automatic: false, manual: "在 nginx 站点里给工作目录的 site/ 开一个公网入口" },
      ],
    });
    expect(oneLine(card.text, 200)).toContain("转入使用后会开起来的：日报（每天 08:00，普通任务）、简报站网页（这一项二狗现在还做不了，需要你手动：在 nginx 站点里给工作目录的 site/");
    expect(card.text).toContain("等你选：确认并转入使用、继续建设、放弃并归档");

    // 卡出了以后再交：卡跟着更新（版本加 1），照旧的按钮按新的这份
    await frontend.sendText("再加一个周日晚上 6 点的周报", { conversation: PM1 });
    const updated = await eventually(() => cardsOf(frontend), (c) => c.id === card.id && c.version === 2, "卡跟着更新");
    expect((updated.payload as BuildDoneCardPayload).operations?.items.map((i) => i.key)).toEqual(["daily-report", "weekly-report", "site"]);
    expect((updated.payload as BuildDoneCardPayload).operations?.why).toBe("加上周日晚上的周报");
    await turns(frontend, PM1, 2);
    await settled(td, "pm-1");
    expect(textOf(messagesOf(frontend, PM1).filter((m) => m.message.speaker === "agent").at(-1)!)).toBe("加好了，卡在待办里");

    // 旧版本上点：被拒（照最新的那份确认）
    const stale = await frontend.cardAction({ cardId: card.id, action: "put_in_use", expectedVersion: 1 });
    expect(stale.ok ? undefined : stale.error).toMatchObject({ code: "conflict" });

    // 确认并转入使用：一次做完
    const put = ok(await frontend.cardAction({ cardId: card.id, action: "put_in_use", expectedVersion: 2 }, "k-put"));
    const inUse = await eventually(() => projectEventsOf(frontend), (e) => e.change === "in_use", "项目进入使用中");
    expect(inUse.project).toMatchObject({ state: "in_use" });
    expect(inUse.project.operations).toMatchObject({
      revision: 2,
      items: [
        { key: "daily-report", name: "日报", triggerText: "每天 08:00", taskId: "t-2" },
        { key: "weekly-report", name: "周报", triggerText: "每周日 18:00", taskId: "t-3" },
        { key: "site", automatic: false },
      ],
    });
    expect(inUse.project.operations!.items[2]!.taskId).toBeUndefined();
    // 每条建成这个项目的内部任务：定时的普通任务，运营中，由项目的维护者执行，触发登记好
    for (const [id, title] of [
      ["t-2", "日报"],
      ["t-3", "周报"],
    ] as const) {
      expect(td.daemon.tasks.get(id)).toMatchObject({ title, kind: "plain", state: "operating", origin: "operations", maintainerId: "pm-1", internal: { projectId: "p-1" } });
    }
    expect(td.daemon.tasks.get("t-2")!.summary).toBe(DAILY.instructions);
    const registered = await eventually(() => jobsOf(frontend), (e) => e.change === "registered" && e.job.ownerTaskId === "t-3", "周报的触发登记");
    expect(registered.job).toMatchObject({ projectId: "p-1", maintainerId: "pm-1", state: "active", nextAt: nowIso(at(10, 11, 18, 0)) });
    expect(td.daemon.scheduledJobs.ofTask("t-2")).toMatchObject({ state: "active", nextAt: nowIso(at(10, 8, 8, 0)) });
    // 卡上记着每一条的结局；维护者会话里记一笔"运营方案已生效"
    const decided = await eventually(() => cardsOf(frontend), (c) => c.id === card.id && c.status === "handled", "卡处理了");
    expect((decided.payload as BuildDoneCardPayload).decided).toEqual({
      choice: "put_in_use",
      operations: [
        { key: "daily-report", name: "日报", outcome: "created", taskId: "t-2" },
        { key: "weekly-report", name: "周报", outcome: "created", taskId: "t-3" },
        { key: "site", name: "简报站网页", outcome: "manual" },
      ],
    });
    expect(decided.text).toContain("你选了确认并转入使用");
    const note = messagesOf(frontend, PM1).find((m) => m.message.speaker === "system" && textOf(m).includes("确认并转入使用"));
    expect(note && textOf(note)).toContain("项目「AI 简报站」进入使用中。运营方案（第 2 份）随之生效：开着 2 条、要你手动 1 条。");
    expect(recordsOf(frontend, PM1).find((r) => r.kind === "operations")).toMatchObject({ summary: "运营方案已生效（第 2 份）：开着 2 条、要你手动 1 条" });
    // 幂等：同一次确认重发拿到同一个结果，不再建一遍
    expect(ok(await frontend.cardAction({ cardId: card.id, action: "put_in_use", expectedVersion: 2 }, "k-put"))).toEqual(put);
    expect(td.daemon.tasks.list().map((t) => t.id)).toEqual(["t-1", "t-2", "t-3"]);
    expect(td.daemon.operations.pendingBuildPlan("p-1")).toBeUndefined();

    // 到点：日报的一次运行是一张运行工单，项目的维护者做完
    clock.advanceTo(at(10, 8, 8, 0));
    const created = await eventually(() => workOrdersOf(frontend), (e) => e.change === "created" && e.workOrder.kind === "run", "日报的运行工单");
    expect(created.workOrder).toMatchObject({ source: "scheduled_job", projectId: "p-1", maintainerId: "pm-1", title: "定时触发：日报" });
    const finished = await eventually(() => jobsOf(frontend), (e) => e.change === "run_finished" && e.job.ownerTaskId === "t-2", "日报这次运行结束", 60_000);
    expect(finished.run).toMatchObject({ state: "done" });
    await settled(td, "pm-1");
    expect(fs.readFileSync(path.join(d.records, "progress.md"), "utf8")).toContain("日报：10-09 的日报出了。");
  }, 180_000);

  it("部分失败：交上来之后项目的工具包收窄了，要联网的那条没生效（项目上记原因、维护者收到通知），别的照常生效、项目照常进入使用中", async () => {
    const d = dirs();
    const clock = new ManualClock(START);
    const quiet = { key: "tidy", name: "整理收件箱", means: "schedule", schedule: { kind: "workdays", time: "09:00" }, instructions: "整理工作目录里的收件箱", capabilities: {} };
    const td = await startTestDaemon({
      clock,
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      secretary: [say("好的")],
      maintainer: () => [propose([DAILY, quiet]), progressEdit(d.records, PROGRESS_INTRO, "运营方案：交了。"), summary("交了运营方案"), say("交了"), say("收到，我看看日报为什么没开起来"), say("好")],
    });
    buildingProject(td);
    const frontend = await connect(td);
    await frontend.sendText("把运营方案交上来", { conversation: PM1 });
    await turns(frontend, PM1, 1);
    finishBuild(td);
    const card = await buildDoneCard(frontend);
    // 用户在项目页上把联网关了
    td.daemon.projects.changeToolkit("p-1", { skills: [], mcp: [], bash: false, network: false }, { by: "user", why: "你在项目页改了工具包" });

    ok(await frontend.cardAction({ cardId: card.id, action: "put_in_use", expectedVersion: 1 }));
    const inUse = await eventually(() => projectEventsOf(frontend), (e) => e.change === "in_use", "项目进入使用中");
    expect(inUse.project.state).toBe("in_use");
    expect(inUse.project.operations?.items).toMatchObject([
      { key: "daily-report", failed: "要的能力超出了项目现在的工具包（联网）" },
      { key: "tidy", taskId: "t-2" },
    ]);
    expect(inUse.project.operations!.items[0]!.taskId).toBeUndefined();
    expect(td.daemon.tasks.get("t-2")).toMatchObject({ title: "整理收件箱", state: "operating" });
    expect(td.daemon.tasks.list().map((t) => t.id)).toEqual(["t-1", "t-2"]);
    const decided = latest(frontend, card.id);
    expect((decided.payload as BuildDoneCardPayload).decided?.operations).toEqual([
      { key: "daily-report", name: "日报", outcome: "failed", reason: "要的能力超出了项目现在的工具包（联网）" },
      { key: "tidy", name: "整理收件箱", outcome: "created", taskId: "t-2" },
    ]);
    // 维护者收到通知（交给它处理的），看看是什么原因
    const notice = await eventually(() => messagesOf(frontend, PM1), (m) => m.agentInput !== undefined && textOf(m).includes("有几条没生效"), "给维护者的通知");
    expect(textOf(notice)).toContain("- 日报：没生效：要的能力超出了项目现在的工具包（联网）");
    expect(textOf(notice)).toContain("改好了用 propose_operations 再交一份完整的运营方案");
    await turns(frontend, PM1, 2);
    await settled(td, "pm-1");

    // 删除项目：交过的运营方案、用户的决定整条换成"已删除"标记，"首版做完了"卡一起删掉，项目上记着的运营方案文字换成删除标记
    ok(await frontend.request(METHODS.projectAction, { projectId: "p-1", action: "archive" }, "k-archive"));
    const asked = ok(await frontend.request(METHODS.projectAction, { projectId: "p-1", action: "delete" }, "k-delete")) as { confirmItemId: string };
    await eventually(() => inboxOf(frontend), (i) => i.id === asked.confirmItemId, "删除的二次确认");
    ok(await frontend.inboxAction({ itemIds: [asked.confirmItemId], action: "handle", choice: "确认删除" }));
    await eventually(() => projectEventsOf(frontend), (e) => e.change === "deleted", "项目删掉");
    const operationsEvents = td.daemon.store.read("operations");
    expect(operationsEvents.length).toBe(2);
    expect(operationsEvents.every((e) => (e.payload as { deleted?: boolean }).deleted === true)).toBe(true);
    expect(td.daemon.cards.get(card.id)).toBeUndefined();
    const stored = td.daemon.store.read(PROJECTS, 0, EVENT_TYPES.project).map((e) => e.payload as ProjectEventPayload);
    const withOperations = stored.filter((p) => p.project.operations);
    expect(withOperations.length).toBeGreaterThan(0);
    expect(withOperations.every((p) => p.project.operations!.items.every((i) => i.name === PURGED_TEXT && i.instructions === PURGED_TEXT))).toBe(true);
    expect(JSON.stringify(stored)).not.toContain("汇总昨天的 AI 新闻");
    expect(JSON.stringify(td.daemon.store.read(CARDS))).not.toContain("汇总昨天的 AI 新闻");
  }, 120_000);
});

describe("使用中的项目改运营方案：出“运营方案变更”卡，确认后照差异生效", () => {
  it("秘书把用户的话转给项目的维护者，维护者出卡（附核实过的原话，也出在秘书会话里）；拒绝不动；再交、确认后建；再改：就地改时间、去掉的取消、加上的建；停用暂停、重新启用恢复", async () => {
    const d = dirs();
    const clock = new ManualClock(START);
    const runFailed = { key: "run-failed", name: "运行失败时排查", means: "event", event: { kind: "event", source: "ergo", events: ["run_failed"], filter: { projectId: "p-1" } }, instructions: "看看哪次运行失败了、为什么，写进进展", capabilities: {} };
    const td = await startTestDaemon({
      clock,
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      secretary: [call("propose_quick_action", { type: "tell_project", params: { project: "AI 简报站", message: "每天早上 8 点出日报，周日晚上 6 点出周报" } }), say("转给简报站的维护者了")],
      maintainer: () => [
        // 秘书转达来的：引用那句话，交运营方案（项目在使用中：出卡）
        citing({ items: [DAILY, WEEKLY], why: "按你说的开日报和周报" }),
        progressEdit(d.records, PROGRESS_INTRO, "运营方案：交了日报和周报。"),
        summary("交了运营方案"),
        say("卡在这里，点确认就生效"),
        // 用户拒绝了（通知）
        say("好，先不开"),
        // 用户又说要开：再交一份
        propose([DAILY, WEEKLY], "还是开起来"),
        say("又交了一张卡"),
        // 确认了（通知）
        say("开起来了"),
        // 用户说要改：日报改到 7 点、周报不要了、运行失败时排查
        propose([{ ...DAILY, schedule: { kind: "daily", time: "07:00" } }, runFailed], "日报改到 7 点，周报不要了，加上运行失败时排查"),
        say("改好了，卡在这里"),
        say("改好了"),
        say("好"),
      ],
    });
    seedProject(td.daemon, "AI 简报站", { state: "in_use", charterConfirmed: true, kind: "other", toolkit: { skills: [], mcp: [], bash: false, network: true } });
    const frontend = await connect(td);

    // 用户对秘书说：秘书转给项目的维护者（用户点明了，直接转），维护者出卡
    await frontend.sendText("告诉AI 简报站，每天早上 8 点出日报，周日晚上 6 点出周报");
    const first = await eventually(() => cardsOf(frontend), (c) => c.type === "operations_change", "运营方案变更卡");
    const p1 = first.payload as OperationsChangeCardPayload;
    expect(p1).toMatchObject({ projectId: "p-1", projectName: "AI 简报站", revision: 1, why: "按你说的开日报和周报", removed: [], changed: [], restored: [], kept: [] });
    expect(p1.baseRevision).toBeUndefined();
    expect(p1.added.map((i) => `${i.name} ${i.triggerText}`)).toEqual(["日报 每天 08:00", "周报 每周日 18:00"]);
    // 核实过的原话是用户在秘书那里说的那句；卡也出在秘书会话里，进待办
    expect(p1.userWords).toEqual([expect.objectContaining({ text: "告诉AI 简报站，每天早上 8 点出日报，周日晚上 6 点出周报", relayedBy: "secretary" })]);
    await waitUntil(() => messagesOf(frontend, SECRETARY).some((m) => m.message.parts.some((p) => p.type === "card_ref" && p.cardId === first.id)), { describe: () => "卡出在秘书会话里" });
    expect(await eventually(() => inboxOf(frontend), (i) => i.kind === "card" && i.cardId === first.id, "待办里的卡")).toMatchObject({ title: "运营方案变更等你确认：AI 简报站", source: "项目「AI 简报站」" });
    expect(first.text).toContain("- 加上：日报（每天 08:00，普通任务）");
    await turns(frontend, PM1, 1);
    await settled(td, "pm-1");

    // 拒绝：什么都不动，维护者收到通知
    ok(await frontend.cardAction({ cardId: first.id, action: "reject", expectedVersion: 1, note: "先不开" }));
    await eventually(() => messagesOf(frontend, PM1), (m) => m.agentInput !== undefined && textOf(m).includes("用户拒绝了运营方案变更（第 1 份）：「先不开」"), "拒绝的通知");
    expect((latest(frontend, first.id).payload as OperationsChangeCardPayload).decided).toMatchObject({ confirmed: false });
    expect(td.daemon.tasks.list()).toEqual([]);
    expect(td.daemon.projects.get("p-1")!.operations).toBeUndefined();
    await turns(frontend, PM1, 2);
    await settled(td, "pm-1");

    // 用户直接在维护者会话里说：再交一张，确认后建出两个内部任务
    await frontend.sendText("还是开起来吧", { conversation: PM1 });
    const second = await eventually(() => cardsOf(frontend), (c) => c.type === "operations_change" && c.id !== first.id, "第二张卡");
    expect((second.payload as OperationsChangeCardPayload).revision).toBe(2);
    await turns(frontend, PM1, 3);
    await settled(td, "pm-1");
    ok(await frontend.cardAction({ cardId: second.id, action: "confirm", expectedVersion: 1 }));
    const changed = await eventually(() => projectEventsOf(frontend), (e) => e.change === "operations_changed", "现在生效的运营方案");
    expect(changed.project.state).toBe("in_use");
    expect(changed.project.operations).toMatchObject({ revision: 2, items: [{ key: "daily-report", taskId: "t-1" }, { key: "weekly-report", taskId: "t-2" }] });
    await eventually(() => jobsOf(frontend), (e) => e.change === "registered" && e.job.ownerTaskId === "t-2", "周报登记");
    expect((latest(frontend, second.id).payload as OperationsChangeCardPayload).decided?.results).toEqual([
      { key: "daily-report", name: "日报", outcome: "created", taskId: "t-1" },
      { key: "weekly-report", name: "周报", outcome: "created", taskId: "t-2" },
    ]);
    await eventually(() => messagesOf(frontend, PM1), (m) => m.agentInput !== undefined && textOf(m).includes("用户确认了运营方案变更（第 2 份）"), "确认的通知");
    await turns(frontend, PM1, 4);
    await settled(td, "pm-1");

    // 再改：日报只改了时间（就地改，同一个任务）、周报去掉（取消）、加上运行失败时排查（事件触发）
    await frontend.sendText("日报改成每天早上 7 点，周报不要了，运行失败的时候帮我查一下原因", { conversation: PM1 });
    const third = await eventually(() => cardsOf(frontend), (c) => c.type === "operations_change" && c.id !== first.id && c.id !== second.id, "第三张卡");
    const p3 = third.payload as OperationsChangeCardPayload;
    expect(p3).toMatchObject({ revision: 3, baseRevision: 2 });
    expect(p3.changed.map((c) => [c.before.triggerText, c.after.triggerText, c.inPlace])).toEqual([["每天 08:00", "每天 07:00", true]]);
    expect(p3.removed.map((i) => i.key)).toEqual(["weekly-report"]);
    expect(p3.added.map((i) => [i.key, i.means, i.triggerText])).toEqual([["run-failed", "event", "二狗内部：项目「AI 简报站」的一次运行失败"]]);
    await turns(frontend, PM1, 5);
    await settled(td, "pm-1");
    ok(await frontend.cardAction({ cardId: third.id, action: "confirm", expectedVersion: 1 }));
    await eventually(() => projectEventsOf(frontend), (e) => e.change === "operations_changed" && e.project.operations?.revision === 3, "第 3 份生效");
    expect(td.daemon.projects.get("p-1")!.operations?.items).toMatchObject([
      { key: "daily-report", taskId: "t-1", triggerText: "每天 07:00" },
      { key: "run-failed", taskId: "t-3" },
    ]);
    expect(td.daemon.scheduledJobs.ofTask("t-1")).toMatchObject({ state: "active", schedule: { kind: "daily", time: "07:00" }, nextAt: nowIso(at(10, 9, 7, 0)) });
    expect(td.daemon.tasks.get("t-2")!.state).toBe("cancelled");
    expect(td.daemon.scheduledJobs.ofTask("t-2")!.state).toBe("cancelled");
    expect(td.daemon.tasks.get("t-3")).toMatchObject({ title: "运行失败时排查", state: "operating", trigger: { kind: "event", source: "ergo" } });
    await eventually(() => jobsOf(frontend), (e) => e.change === "registered" && e.job.ownerTaskId === "t-3", "事件触发的登记");
    expect((latest(frontend, third.id).payload as OperationsChangeCardPayload).decided?.results).toEqual([
      { key: "daily-report", name: "日报", outcome: "rescheduled", taskId: "t-1" },
      { key: "run-failed", name: "运行失败时排查", outcome: "created", taskId: "t-3" },
      { key: "weekly-report", name: "周报", outcome: "cancelled", taskId: "t-2" },
    ]);
    await turns(frontend, PM1, 6);
    await settled(td, "pm-1");

    // 停用：运营方案里的任务暂停；重新启用：恢复
    ok(await frontend.request(METHODS.projectAction, { projectId: "p-1", action: "retire" }, "retire"));
    await waitUntil(() => ["t-1", "t-3"].every((id) => td.daemon.scheduledJobs.ofTask(id)?.pausedBy === "project_retired"), { describe: () => "停用时暂停" });
    ok(await frontend.request(METHODS.projectAction, { projectId: "p-1", action: "reactivate" }, "reactivate"));
    await waitUntil(() => ["t-1", "t-3"].every((id) => td.daemon.scheduledJobs.ofTask(id)?.state === "active"), { describe: () => "重新启用时恢复" });
    expect(td.daemon.scheduledJobs.ofTask("t-1")!.nextAt).toBe(nowIso(at(10, 9, 7, 0)));
    // 现在生效的运营方案没变（停用、重新启用不改它）
    expect(td.daemon.projects.get("p-1")!.operations?.revision).toBe(3);
  }, 240_000);

  it("和现在生效的一样：被拒，不出卡；没有这种手段、事件来源写错的整份退回", async () => {
    const d = dirs();
    const td = await startTestDaemon({
      clock: new ManualClock(START),
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      secretary: [say("好的")],
      maintainer: () => [
        propose([DAILY]),
        progressEdit(d.records, PROGRESS_INTRO, "运营方案：交了日报。"),
        summary("交了运营方案"),
        say("卡在这里"),
        say("开起来了"),
        propose([DAILY]),
        propose([{ ...DAILY, means: "webhook" }, { key: "bad-event", name: "坏事件", means: "event", event: { kind: "event", source: "nowhere", events: ["x"] }, instructions: "x", capabilities: {} }]),
        ECHO,
      ],
    });
    seedProject(td.daemon, "AI 简报站", { state: "in_use", charterConfirmed: true, kind: "other", toolkit: { skills: [], mcp: [], bash: false, network: true } });
    const frontend = await connect(td);
    await frontend.sendText("开个日报", { conversation: PM1 });
    const card = await eventually(() => cardsOf(frontend), (c) => c.type === "operations_change", "运营方案变更卡");
    await turns(frontend, PM1, 1);
    await settled(td, "pm-1");
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: 1 }));
    await eventually(() => projectEventsOf(frontend), (e) => e.change === "operations_changed", "生效");
    await turns(frontend, PM1, 2);
    await settled(td, "pm-1");

    await frontend.sendText("再交一下", { conversation: PM1 });
    await turns(frontend, PM1, 3);
    const echo = textOf(messagesOf(frontend, PM1).filter((m) => m.message.speaker === "agent").at(-1)!);
    expect(echo).toContain("[toolResult] propose_operations: 和现在生效的运营方案一样，没有要改的（照旧在跑）。");
    expect(echo).toContain("第 1 条「日报」：没有这种运营手段「webhook」（现在登记的：schedule 定时触发的任务、event 事件触发的任务、service 项目自己的服务（登记到 LSM）、public_entry 公网入口）");
    expect(echo).toContain("第 2 条「坏事件」：");
    expect(cardsOf(frontend).filter((c) => c.type === "operations_change").map((c) => c.id)).toEqual([card.id, card.id]);
  }, 120_000);

  it("别处登记的运营手段（插件经插件宿主登记的走同一张表）：工具说明里列出来、确认时生效；项目停用时叫它的暂停、重新启用时叫恢复；撤掉之后再交被拒", async () => {
    const calls: string[] = [];
    const NOTICE_BOARD = { key: "board", name: "公告墙", means: "board", instructions: "每条日报贴到公告墙上", capabilities: {} };
    const td = await startTestDaemon({
      clock: new ManualClock(START),
      secretary: [say("好的")],
      maintainer: () => [propose([NOTICE_BOARD]), say("卡在这里"), say("好"), propose([NOTICE_BOARD]), ECHO],
    });
    const undo = td.daemon.operationMeans.register({
      id: "board",
      label: "公告墙",
      hint: "把项目的产出贴到公告墙上",
      automatic: true,
      check: () => [],
      describe: () => "一直挂着",
      apply: (item) => {
        calls.push(`apply ${item.key}`);
        return { taskId: "board-1", events: [] };
      },
      pause: (binding) => (calls.push(`pause ${binding.taskId}`), []),
      resume: (binding) => (calls.push(`resume ${binding.taskId}`), []),
    });
    seedProject(td.daemon, "AI 简报站", { state: "in_use", charterConfirmed: true, kind: "other", toolkit: { skills: [], mcp: [], bash: false, network: true } });
    const frontend = await connect(td);
    // 维护者的工具说明每次装配时照登记表现写
    expect(td.daemon.operations.tool("p-1", "pm-1").spec.description).toContain("board（公告墙）：把项目的产出贴到公告墙上");

    await frontend.sendText("贴到公告墙上", { conversation: PM1 });
    const card = await eventually(() => cardsOf(frontend), (c) => c.type === "operations_change", "运营方案变更卡");
    expect((card.payload as OperationsChangeCardPayload).added).toMatchObject([{ key: "board", meansLabel: "公告墙", triggerText: "一直挂着" }]);
    await turns(frontend, PM1, 1);
    await settled(td, "pm-1");
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: 1 }));
    await eventually(() => projectEventsOf(frontend), (e) => e.change === "operations_changed", "生效");
    expect(td.daemon.projects.get("p-1")!.operations?.items).toMatchObject([{ key: "board", taskId: "board-1" }]);
    await turns(frontend, PM1, 2);
    await settled(td, "pm-1");

    ok(await frontend.request(METHODS.projectAction, { projectId: "p-1", action: "retire" }, "retire"));
    ok(await frontend.request(METHODS.projectAction, { projectId: "p-1", action: "reactivate" }, "reactivate"));
    expect(calls).toEqual(["apply board", "pause board-1", "resume board-1"]);

    // 撤掉（插件停用）之后：工具说明里没有它了，再交用它的被拒
    undo();
    expect(td.daemon.operations.tool("p-1", "pm-1").spec.description).not.toContain("board（公告墙）");
    await frontend.sendText("再交一下", { conversation: PM1 });
    await turns(frontend, PM1, 3);
    const seen = textOf(messagesOf(frontend, PM1).filter((m) => m.message.speaker === "agent").at(-1)!);
    expect(seen).toContain("[toolResult] propose_operations: 运营方案没通过检查，改好再交（整份重交）");
    expect(seen).toContain("第 1 条「公告墙」：没有这种运营手段「board」");
  }, 120_000);
});

describe("流程的那一条：确认方案时一起授权", () => {
  it("带着审查修补后的计划：卡上看得到步骤；确认并转入使用后是项目内部的流程，流程计划卡建出就是已授权，计划记下了；到点照步骤做完", async () => {
    const d = dirs();
    const clock = new ManualClock(START);
    const workflow = {
      key: "daily-file",
      name: "日报文件",
      means: "schedule",
      schedule: { kind: "daily", time: "08:00" },
      approach: "workflow",
      instructions: "每天在工作目录里写一份日报文件",
      workflow: { steps: [{ id: "s1", title: "写日报文件", tool: "write", args: { path: "daily.md", content: "# 日报\n" } }] },
      capabilities: {},
    };
    const td = await startTestDaemon({
      clock,
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      secretary: [say("好的")],
      maintainer: (_id, spawn) =>
        spawn === 1
          ? [propose([workflow]), progressEdit(d.records, PROGRESS_INTRO, "运营方案：交了日报文件。"), summary("交了运营方案"), say("交了")]
          : [
              // 照步骤做，report_step 自报
              call("report_step", { stepId: "s1", status: "in_progress" }),
              call("write", { path: "daily.md", content: "# 日报\n" }),
              call("report_step", { stepId: "s1", status: "done", gist: "写好了" }),
              say("日报文件写好了"),
              // 写项目档案不在步骤里：用 write_progress
              call("write_progress", { content: "日报文件写了。" }),
              summary("写了日报文件"),
              say("写回了"),
            ],
    });
    buildingProject(td, { skills: [], mcp: [], bash: false, network: false });
    const frontend = await connect(td);
    await frontend.sendText("每天写一份日报文件，按流程来", { conversation: PM1 });
    await turns(frontend, PM1, 1);
    finishBuild(td);
    const card = await buildDoneCard(frontend);
    const item = (card.payload as BuildDoneCardPayload).operations!.items[0]!;
    expect(item).toMatchObject({ approach: "workflow", triggerText: "每天 08:00" });
    expect(item.workflow?.steps.map((s) => s.tool)).toContain("write");
    await settled(td, "pm-1");

    ok(await frontend.cardAction({ cardId: card.id, action: "put_in_use", expectedVersion: 1 }));
    await eventually(() => projectEventsOf(frontend), (e) => e.change === "in_use", "项目进入使用中");
    const task = td.daemon.tasks.get("t-2")!;
    expect(task).toMatchObject({ kind: "workflow", state: "operating", origin: "operations", internal: { projectId: "p-1" } });
    // 流程计划卡建出就是已授权（写明随运营方案一起授权），计划确认了
    const planCard = await eventually(() => cardsOf(frontend), (c) => c.id === task.planCardId, "流程计划卡");
    expect(planCard).toMatchObject({ type: "workflow_plan", status: "handled", outcome: { action: "confirm", note: "随运营方案一起授权（你确认运营方案时）" } });
    expect((planCard.payload as WorkflowPlanCardPayload).schedule).toEqual({ kind: "daily", time: "08:00" });
    expect(td.daemon.tasks.confirmedPlan("t-2")?.workflow?.steps.map((s) => s.tool)).toContain("write");
    await eventually(() => jobsOf(frontend), (e) => e.change === "registered" && e.job.ownerTaskId === "t-2", "流程的触发登记");

    // 到点：照步骤做完，这次运行成功
    clock.advanceTo(at(10, 8, 8, 0));
    const finished = await eventually(() => jobsOf(frontend), (e) => e.change === "run_finished" && e.job.ownerTaskId === "t-2", "流程这次运行结束", 60_000);
    expect(finished.run).toMatchObject({ state: "done" });
    expect(fs.readFileSync(path.join(d.records, "workdir", "daily.md"), "utf8")).toBe("# 日报\n");
  }, 180_000);
});
