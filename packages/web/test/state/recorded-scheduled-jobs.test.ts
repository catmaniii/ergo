// 前端状态层回放 19 号票（76 号票起是定时触发的任务）的主切面录下的事件流（packages/daemon/test/main/scheduled-jobs.test.ts）：
// 看板运营中一组里定时触发的任务卡（带着它的触发登记）、项目页的定时触发列表和工单流水线、待我处理里的"已自动暂停""错过的提醒""归档清单"。
// 重新录：ERGOU_RECORD_EVENTS=1 npx vitest run packages/daemon/test/main/scheduled-jobs.test.ts
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  type ArchiveListCardPayload,
  boardGroups,
  CARD_TYPE_VERSIONS,
  cardDisplay,
  inboxEntries,
  jobRuns,
  projectPipeline,
  projectScheduledJobs,
  replay,
  type ScheduledJobEventPayload,
  type ScheduledJobView,
  selectCard,
  selectScheduledJob,
  selectTask,
  taskRunViews,
  taskTokenTotal,
  type UiInput,
  type UiState,
} from "../../src/state/index.ts";

function load(name: string): UiInput[] {
  return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "recordings", `${name}.json`), "utf8")) as UiInput[];
}

/** 第一个满足条件的输入的下标 */
function indexOf(inputs: readonly UiInput[], match: (input: UiInput) => boolean): number {
  const i = inputs.findIndex(match);
  if (i < 0) throw new Error("录好的事件流里没有要找的输入");
  return i;
}

/** 看板频道上某种变化的 scheduled_job 事件（给了运行号的还要是那一次运行） */
const jobEvent = (change: string, runId?: string) => (input: UiInput) => {
  if (input.kind !== "frame" || input.frame.type !== "scheduled_job") return false;
  const p = input.frame.payload as ScheduledJobEventPayload;
  return p.change === change && (runId === undefined || p.run?.runId === runId);
};

/** 回放到第一个满足条件的输入（含） */
const upTo = (inputs: readonly UiInput[], match: (input: UiInput) => boolean) => replay(inputs.slice(0, indexOf(inputs, match) + 1));

/** 看板运营中一组里定时触发的任务卡带着的触发登记（76 号票：触发登记不单独占卡） */
function opsJobs(state: UiState): ScheduledJobView[] {
  const ops = boardGroups(state).find((g) => g.group === "ops")!;
  expect(ops.items.filter((i) => i.kind === "scheduled_job")).toEqual([]);
  return ops.items.flatMap((i) => (i.kind === "task" && i.trigger ? [i.trigger] : []));
}

/** 回放出来的归档清单卡 */
const listCard = (state: UiState) => Object.values(state.cards).find((c) => c.card.type === "archive_list")!;

/** 作业卡压成一行："j-1 运营中 每天 09:00 [最近一次失败]" */
const card = (v: ScheduledJobView) => [v.job.id, v.statusText, v.scheduleText, ...(v.lastFailedText ? [v.lastFailedText] : [])].join(" ");

describe("回放：属于项目的定时触发的任务（scheduled-job-project）", () => {
  // 录制在 scheduled-jobs.test.ts 的"属于项目的"：在发起对话框里选项目「资讯站」、定时每天 09:00 建普通任务（这个项目的内部任务，
  // 建出就是运营中、登记触发）；拨到 09:00，派单器给项目维护者开一张来源为定时触发的工单，维护者做完、写回，工单结束，运行成功
  const inputs = load("scheduled-job-project");

  test("建出就登记：项目页的定时触发列表里有它（运营中、每天 09:00，普通任务没有预先授权的操作）；项目内部的不上全局看板", () => {
    const state = upTo(inputs, jobEvent("registered"));
    expect(boardGroups(state).flatMap((g) => g.items)).toEqual([]);
    expect(projectScheduledJobs(state, "p-1").map(card)).toEqual(["j-1 运营中 每天 09:00"]);
    expect(projectScheduledJobs(state, "p-1")[0]).toMatchObject({ grants: [], rules: [], actions: ["pause", "cancel"], job: { projectId: "p-1", projectName: "资讯站", title: "每天早上出简报", ownerTaskId: "t-1" } });
    expect(selectTask(state, "t-1")).toMatchObject({ state: "operating", kind: "plain", trigger: { kind: "schedule" } });
    expect(jobRuns(state, "j-1")).toEqual([]);
  });

  test("到点：这次运行进队列；它的工单开始后这次运行开始（开始了才占名额）：项目页的工单流水线上是一张来自定时触发的工单，写着是哪个的运行、这次运行到哪了", () => {
    expect(jobRuns(upTo(inputs, jobEvent("triggered")), "j-1").map((r) => `${r.runId} ${r.trigger} ${r.state}`)).toEqual(["j-1-r1 scheduled queued"]);
    const state = upTo(inputs, jobEvent("run_started"));
    const [active] = projectPipeline(state, "p-1").active;
    expect(active).toMatchObject({ source: "定时触发", kind: "一次运行", run: "运行中", task: undefined, stage: undefined, job: { id: "j-1", title: "每天早上出简报" } });
    expect(active!.workOrder).toMatchObject({ source: "scheduled_job", scheduledJobId: "j-1", runId: "j-1-r1", title: "定时触发：每天早上出简报" });
    expect(jobRuns(state, "j-1").map((r) => `${r.runId} ${r.trigger} ${r.state}`)).toEqual(["j-1-r1 scheduled running"]);
  });

  test("做完：工单结束、这次运行成功；没有失败标记；任务详情的运行一栏有这一次；用量记在任务名下", () => {
    const state = replay(inputs);
    expect(projectPipeline(state, "p-1").ended[0]).toMatchObject({ kind: "一次运行", status: "已结束 · 完成", run: "成功" });
    expect(jobRuns(state, "j-1").map((r) => `${r.runId} ${r.state}`)).toEqual(["j-1-r1 done"]);
    const view = selectScheduledJob(state, "j-1")!;
    expect(card(view)).toBe("j-1 运营中 每天 09:00");
    expect(view.lastRun).toMatchObject({ runId: "j-1-r1", state: "done" });
    expect(taskRunViews(state, "t-1").map((r) => `${r.no} ${r.stateText}`)).toEqual(["1 成功"]);
    expect(taskTokenTotal(state, "t-1")).toBeGreaterThan(0);
    expect(projectScheduledJobs(state, "p-1").map(card)).toEqual(["j-1 运营中 每天 09:00"]);
  });
});

describe("回放：失败和自动暂停（scheduled-job-failures）", () => {
  // 录制在 scheduled-jobs.test.ts 的"失败和自动暂停"：定时触发的普通任务的 agent 连着做 6 次，失败、失败、成功、失败、失败、失败，
  // 第 6 次后自动暂停；在待我处理的事项上点"恢复"
  const inputs = load("scheduled-job-failures");

  test("失败一次：任务卡标最近一次失败，仍在运营中；中间成功一次，标记去掉", () => {
    expect(opsJobs(upTo(inputs, jobEvent("run_finished", "j-1-r1"))).map(card)).toEqual(["j-1 运营中 每天 09:00 最近一次失败"]);
    expect(opsJobs(upTo(inputs, jobEvent("run_finished", "j-1-r3"))).map(card)).toEqual(["j-1 运营中 每天 09:00"]);
  });

  test("连续失败 3 次：任务卡上写已暂停和原因（还在运营中一组，能恢复）；待我处理出现一条已自动暂停的事项", () => {
    const state = upTo(inputs, (i) => i.kind === "frame" && i.frame.type === "inbox_item" && (i.frame.payload as { item: { notice?: string } }).item.notice === "scheduled_job_auto_paused");
    expect(opsJobs(state).map(card)).toEqual(["j-1 已暂停（连续失败 3 次，自动暂停） 每天 09:00 最近一次失败"]);
    expect(opsJobs(state)[0]!.actions).toEqual(["resume", "cancel"]);
    expect(jobRuns(state, "j-1").map((r) => r.state)).toEqual(["failed", "failed", "done", "failed", "failed", "failed"]);
    const paused = inboxEntries(state, "open").find((e) => e.item.kind === "notice" && e.item.notice === "scheduled_job_auto_paused");
    expect(paused).toMatchObject({ processed: false, item: { title: "定时触发的任务「每天早上出简报」已自动暂停", urgency: "non_blocking", actions: ["恢复", "保持暂停"] } });
    expect(taskRunViews(state, "t-1").map((r) => r.stateText)).toEqual(["失败", "失败", "失败", "成功", "失败", "失败"]);
  });

  test("点了恢复：事项处理完，任务卡回到运营中（最近一次仍是失败）", () => {
    const state = replay(inputs);
    expect(opsJobs(state).map(card)).toEqual(["j-1 运营中 每天 09:00 最近一次失败"]);
    expect(selectScheduledJob(state, "j-1")!.job.consecutiveFailures).toBe(0);
    expect(inboxEntries(state, "open").filter((e) => e.item.kind === "notice" && e.item.notice === "scheduled_job_auto_paused")).toEqual([]);
    expect(inboxEntries(state, "done").filter((e) => e.item.kind === "notice" && e.item.notice === "scheduled_job_auto_paused")).toHaveLength(1);
  });
});

describe("回放：停机期间错过的触发（missed-triggers）", () => {
  // 录制在 scheduled-jobs.test.ts 的"错过的触发"：停到 10-10 09:20 才起来，作业错过了 3 次，一次性的提醒晚了 20 分钟，
  // 每天 07:00 的提醒晚了 2 小时 20 分钟；重启后连上的前端从头收到
  const inputs = load("missed-triggers");
  const state = replay(inputs);

  test("晚了 20 分钟的提醒照发并写明晚了多久；晚了 2 个多小时的改放一条错过的提醒", () => {
    const open = inboxEntries(state, "open");
    const due = open.find((e) => e.item.kind === "notice" && e.item.notice === "reminder_due");
    expect(due?.item.kind === "notice" && due.item.body).toContain("晚了 20 分钟");
    const missed = open.filter((e) => e.item.kind === "notice" && e.item.notice === "missed_reminder");
    expect(missed.map((e) => e.item.title)).toEqual(["错过的提醒：吃药"]);
  });

  test("只补跑一次：运行记录写明是开机补跑、错过了 3 次，做完成功；任务卡仍在运营中", () => {
    expect(jobRuns(state, "j-1").map((r) => `${r.runId} ${r.trigger} ${r.missed} ${r.state}`)).toEqual(["j-1-r1 catch_up 3 done"]);
    expect(opsJobs(state).map(card)).toEqual(["j-1 运营中 每天 09:00"]);
  });
});

describe("回放：归档清单（archive-list）", () => {
  // 录制在 scheduled-jobs.test.ts 的"归档清单"：四个任务结束（两个完成、一个失败、一个取消）超过 7 天，每周的内部作业出一张清单；
  // 整理发票归档、写周报继续改（返工）、订机票继续改（重试）、搬家清单想继续改被拒、先留着
  const inputs = load("archive-list");

  test("清单出来：待我处理里一条归档清单的卡片事项（不卡任务），卡片这个页面认识；已取消的只能归档或先留着", () => {
    const state = upTo(inputs, (i) => i.kind === "frame" && i.frame.type === "inbox_item" && (i.frame.payload as { item: { title: string } }).item.title.startsWith("归档清单"));
    expect(CARD_TYPE_VERSIONS.archive_list).toBe(1);
    const view = listCard(state);
    expect(cardDisplay(state, view.card.id)).toMatchObject({ kind: "typed", type: "archive_list" });
    const entry = inboxEntries(state, "open").find((e) => e.item.kind === "card" && e.item.cardId === view.card.id);
    expect(entry).toMatchObject({ processed: false, item: { title: "归档清单：4 个任务结束超过 7 天", urgency: "non_blocking" } });
    const payload = view.card.payload as ArchiveListCardPayload;
    expect(payload.items.map((i) => `${i.taskId} ${i.state} ${i.choices.join("/")}`)).toEqual([
      "t-1 done archive/continue/keep",
      "t-2 done archive/continue/keep",
      "t-3 failed archive/continue/keep",
      "t-4 cancelled archive/keep",
    ]);
  });

  test("已取消的选继续改被拒：卡片上写明原因，这一项还能选", () => {
    const refused = indexOf(inputs, (i) => i.kind === "request_failed");
    const state = replay(inputs.slice(0, refused + 1));
    const view = selectCard(state, listCard(state).card.id)!;
    expect(view.pending).toMatchObject({ status: "failed", error: expect.stringContaining("已取消，不能继续改") });
    expect((view.card.payload as ArchiveListCardPayload).items[3]!.decision).toBeUndefined();
  });

  test("每项都选了：清单处理完；归档的到了看板的已归档分组，继续改的回到执行中，先留着的不变", () => {
    const state = replay(inputs);
    const view = listCard(state);
    expect(view.card.status).toBe("handled");
    expect((view.card.payload as ArchiveListCardPayload).items.map((i) => i.decision)).toEqual(["archive", "continue", "continue", "keep"]);
    expect(inboxEntries(state, "done").some((e) => e.item.kind === "card" && e.item.cardId === view.card.id)).toBe(true);
    const groupOf = (taskId: string) => boardGroups(state).find((g) => g.items.some((i) => i.kind === "task" && i.task.id === taskId))?.group;
    expect(groupOf("t-1")).toBe("archived");
    expect([selectTask(state, "t-2")?.state, selectTask(state, "t-3")?.state]).toEqual(["running", "running"]);
    expect(groupOf("t-4")).toBe("ended");
    expect(selectTask(state, "t-4")?.state).toBe("cancelled");
  });
});
