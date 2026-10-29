// 主切面：运营方案建的内部任务也上任务看板（141 号票，2026-10-18 用户定"显示，只能暂停、恢复"）。真的守护进程，测试扮演前端；
// 运营方案确认后的样子直接造出来（项目使用中、方案里每一条绑着它生效成的内部任务——起草、确认、变更的主切面在 operations.test.ts，
// 变更时去掉的那条照变更流程取消也在那里测）。
// - 秘书的查看板列出它们、标项目名（运营中的定时任务在运营中，某个时间做一次的在进行中）；项目的别的内部任务照旧只有数目；
// - 在任务页（task_action）暂停的就是项目页上那份触发登记：项目页（scheduled_job_action）恢复，任务页看到的也恢复了；
// - 项目在用时用户发取消、归档被拒（任务页、多选、项目页的作业行都一样），原因写清：这是项目「X」运营方案里的一条……；
// - 项目归档：它们跟着归档（运营中的、等时间的、做完了的；触发登记照旧暂停），查看板在已归档里；取消归档回到原来的状态；
// - 项目删除：随项目一起删掉（照彻底删除的口径：行留着、文字换成删除标记），查看板上没有了。
import { CHANNELS, EVENT_TYPES, METHODS, nowIso, type Project, type ProjectEventPayload, type Task, type TaskEventPayload } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { boardToolText } from "../../src/board/kinds.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { internalTask, seedProject } from "../helpers/projects.ts";
import { eventually, ok } from "../helpers/running-task.ts";

const { board: BOARD, inbox: INBOX, projects: PROJECTS } = CHANNELS;
const NOTE = "这是项目「AI 简报站」运营方案里的一条，要去掉请让项目维护者改运营方案";
/** 本地时间 2026 年 10 月 d 日 hh:mm */
const at = (d: number, hh: number) => new Date(2026, 9, d, hh, 0);

const item = (key: string, name: string, taskId: string) => ({
  key,
  name,
  means: "schedule",
  meansLabel: "定时触发的任务",
  automatic: true,
  triggerText: "每天 08:00",
  approach: "plain" as const,
  instructions: name,
  capabilities: {},
  taskId,
});

/** 运营方案里的一条生效成的内部任务（origin operations，用户确认的） */
function operationsTask(td: TestDaemon, title: string, schedule: object): Task {
  const { task, events } = td.daemon.tasks.buildInternal({ projectId: "p-1", title, summary: `${title}：每次做一期`, kind: "plain", origin: "operations", trigger: { kind: "schedule", schedule } as never }, "user");
  td.daemon.store.appendBatch(events);
  return task;
}

/**
 * 使用中的「AI 简报站」：现在生效的运营方案里有日报（t-1，每天 08:00）、发布会（t-2，10-20 09:00 做一次）、上周回顾（t-3，做完了）；
 * 另有项目的维护任务 t-4（项目内部、不是运营方案建的，还没写任务书）
 */
async function inUse() {
  const clock = new ManualClock(at(18, 9));
  const td = await startTestDaemon({ clock, secretary: [], maintainer: () => [] });
  const project = seedProject(td.daemon, "AI 简报站", { state: "in_use", charterConfirmed: true, kind: "other", toolkit: { skills: [], mcp: [], bash: false, network: true } });
  operationsTask(td, "日报", { kind: "daily", time: "08:00" });
  operationsTask(td, "发布会", { kind: "once", at: nowIso(at(20, 9)) });
  const recap = operationsTask(td, "上周回顾", { kind: "once", at: nowIso(at(19, 9)) });
  // 上周回顾已经做完了（执行在别处测，这里直接造出来）
  const done: TaskEventPayload = { task: { ...recap, state: "done", updatedAt: nowIso() }, change: "completed", from: "scheduled", by: "system" };
  td.daemon.store.append({ channel: BOARD, type: EVENT_TYPES.task, payload: done });
  internalTask(td.daemon, "AI 简报站", "升级依赖");
  const confirmed: Project = { ...project, operations: { revision: 1, confirmedAt: nowIso(), items: [item("daily", "日报", "t-1"), item("launch", "发布会", "t-2"), item("recap", "上周回顾", "t-3")] } };
  td.daemon.store.append({ channel: PROJECTS, type: EVENT_TYPES.project, payload: { project: confirmed, change: "operations_changed", from: "in_use", by: "user" } satisfies ProjectEventPayload });
  const frontend = await TestFrontend.connect(td.url);
  await frontend.subscribe({ [BOARD]: 0, [INBOX]: 0, [PROJECTS]: 0 });
  return { td, frontend };
}

const board = (td: TestDaemon) => boardToolText(td.daemon.store, td.daemon.boardKinds);
/** 查看板里某一组那一段（到下一组为止） */
const section = (text: string, title: string) => {
  const from = text.indexOf(`## ${title}`);
  if (from < 0) return "";
  const next = text.indexOf("\n## ", from + 1);
  return text.slice(from, next < 0 ? undefined : next);
};
const taskEvents = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.task }).map((f) => f.payload as TaskEventPayload);
const refusal = (frame: { ok: boolean; error?: { code: string; message: string } }) => (frame.ok ? undefined : frame.error);

describe("运营方案建的内部任务上任务看板，项目在用时只能暂停、恢复", () => {
  it("查看板列出它们、标项目名；任务页暂停、项目页恢复是同一份；取消、归档被拒（任务页、多选、项目页的作业行），原因写清", async () => {
    const { td, frontend } = await inUse();
    expect(td.daemon.tasks.get("t-1")).toMatchObject({ state: "operating", origin: "operations" });
    const job = td.daemon.scheduledJobs.ofTask("t-1")!;
    expect(job).toMatchObject({ state: "active", ownerTaskId: "t-1" });

    // 秘书的查看板：日报在运营中、发布会在进行中、上周回顾在最近结束，都标着项目；维护任务照旧只有数目
    const text = board(td);
    expect(section(text, "运营中")).toContain("- 任务 t-1「日报」：运营中；定时触发：每天 08:00；下一次");
    expect(section(text, "运营中")).toContain("属于项目：AI 简报站");
    expect(section(text, "进行中")).toMatch(/- 任务 t-2「发布会」：等时间；.*属于项目：AI 简报站/);
    expect(section(text, "最近结束")).toMatch(/- 任务 t-3「上周回顾」：已完成；.*属于项目：AI 简报站/);
    expect(text).not.toContain("升级依赖");
    expect(text).toContain("- 项目「AI 简报站」里有 1 个进行中的内部任务（细节只在项目页上，你看不到）");

    // 任务页暂停 → 项目页上的触发登记暂停了；项目页恢复 → 任务页看到的也恢复了
    expect(ok(await frontend.taskAction({ taskId: "t-1", action: "pause" }))).toEqual({ taskId: "t-1", state: "operating" });
    expect(td.daemon.scheduledJobs.ofTask("t-1")).toMatchObject({ state: "paused", pausedBy: "user" });
    expect(section(board(td), "运营中")).toContain("- 任务 t-1「日报」：已暂停；");
    ok(await frontend.scheduledJobAction({ jobId: job.id, action: "resume" }));
    expect(td.daemon.scheduledJobs.ofTask("t-1")).toMatchObject({ state: "active" });

    // 取消、归档被拒：任务页（运营中的落到触发上、等时间的、做完了的）、多选、项目页的作业行
    expect(refusal(await frontend.taskAction({ taskId: "t-1", action: "cancel" }))).toEqual({ code: "not_allowed", message: NOTE });
    expect(refusal(await frontend.taskAction({ taskId: "t-2", action: "cancel" }))).toEqual({ code: "not_allowed", message: NOTE });
    expect(refusal(await frontend.taskAction({ taskId: "t-3", action: "archive" }))).toEqual({ code: "not_allowed", message: NOTE });
    expect(ok(await frontend.taskBatchAction({ taskIds: ["t-1", "t-2"], action: "cancel" }))).toEqual({
      results: [
        { taskId: "t-1", ok: false, code: "not_allowed", message: NOTE },
        { taskId: "t-2", ok: false, code: "not_allowed", message: NOTE },
      ],
    });
    expect(refusal(await frontend.scheduledJobAction({ jobId: job.id, action: "cancel" }))).toEqual({ code: "not_allowed", message: NOTE });
    expect(td.daemon.tasks.get("t-1")!.state).toBe("operating");
    expect(td.daemon.tasks.get("t-2")!.state).toBe("scheduled");
    expect(td.daemon.tasks.get("t-3")!.state).toBe("done");
    expect(td.daemon.scheduledJobs.ofTask("t-1")!.state).toBe("active");
    // 暂停照常（多选也是）
    expect(ok(await frontend.taskBatchAction({ taskIds: ["t-1"], action: "pause" }))).toEqual({ results: [{ taskId: "t-1", ok: true, state: "operating" }] });
  });

  it("项目归档：它们跟着归档（触发登记照旧暂停），查看板在已归档里；取消归档回到原来的状态；项目删除：随项目一起删掉，查看板上没有了", async () => {
    const { td, frontend } = await inUse();
    ok(await frontend.taskAction({ taskId: "t-1", action: "pause" }));

    ok(await frontend.request(METHODS.projectAction, { projectId: "p-1", action: "archive" }, "k-archive"));
    expect(td.daemon.tasks.get("t-1")).toMatchObject({ state: "archived", archivedFrom: "operating" });
    expect(td.daemon.tasks.get("t-2")).toMatchObject({ state: "archived", archivedFrom: "scheduled" });
    expect(td.daemon.tasks.get("t-3")).toMatchObject({ state: "archived", archivedFrom: "done" });
    // 用户自己暂停的触发登记照旧（之前就暂停了的保持原样），没有取消
    expect(td.daemon.scheduledJobs.ofTask("t-1")).toMatchObject({ state: "paused", pausedBy: "user" });
    // 不是运营方案建的维护任务不动
    expect(td.daemon.tasks.get("t-4")!.state).toBe("planning");
    // 看板频道上记的是系统做的"归档"
    expect(await eventually(() => taskEvents(frontend), (e) => e.task.id === "t-1" && e.change === "archived", "跟着归档")).toMatchObject({ by: "system", from: "operating" });
    expect(section(board(td), "已归档")).toMatch(/- 任务 t-1「日报」：已归档；.*属于项目：AI 简报站/);
    expect(section(board(td), "运营中")).toBe("");
    // 项目已归档时不能单独恢复它的内部任务（现有限制保留）
    expect(refusal(await frontend.taskAction({ taskId: "t-1", action: "resume" }))?.code).toBe("not_allowed");

    ok(await frontend.request(METHODS.projectAction, { projectId: "p-1", action: "unarchive" }, "k-unarchive"));
    expect(td.daemon.tasks.get("t-1")!.state).toBe("operating");
    expect(td.daemon.tasks.get("t-1")!.archivedFrom).toBeUndefined();
    expect(td.daemon.tasks.get("t-2")!.state).toBe("scheduled");
    expect(td.daemon.tasks.get("t-3")!.state).toBe("done");
    expect(td.daemon.scheduledJobs.ofTask("t-1")).toMatchObject({ state: "paused", pausedBy: "user" });
    expect(await eventually(() => taskEvents(frontend), (e) => e.task.id === "t-1" && e.change === "unarchived", "回到原来的状态")).toMatchObject({ by: "system", from: "archived" });
    expect(section(board(td), "运营中")).toContain("- 任务 t-1「日报」：已暂停；");

    // 删除：先归档，再确认删除
    ok(await frontend.request(METHODS.projectAction, { projectId: "p-1", action: "archive" }, "k-archive-2"));
    const asked = ok(await frontend.request(METHODS.projectAction, { projectId: "p-1", action: "delete" }, "k-delete")) as { confirmItemId: string };
    await eventually(() => frontend.events({ channel: INBOX, type: EVENT_TYPES.inboxItem }), (f) => (f.payload as { item: { id: string } }).item.id === asked.confirmItemId, "删除的二次确认");
    ok(await frontend.inboxAction({ itemIds: [asked.confirmItemId], action: "handle", choice: "确认删除" }));
    await eventually(() => frontend.events({ channel: PROJECTS, type: EVENT_TYPES.project }), (f) => (f.payload as ProjectEventPayload).change === "deleted", "项目删掉");
    const after = board(td);
    expect(after).not.toContain("t-1");
    expect(after).not.toContain("AI 简报站");
    expect(td.daemon.scheduledJobs.ofTask("t-1")!.state).toBe("cancelled");
  });
});
