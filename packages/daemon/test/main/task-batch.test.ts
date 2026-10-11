// 主切面：看板多选的批量操作（90 号票，规格第 19 节"任务看板"）。真的守护进程，维护者接 faux 剧本，测试扮演前端。
// - task_batch_action 一次对多个任务做暂停、继续、取消、归档：每个任务各自按"谁能改"表判断、各自成败，结果按请求里的先后逐条回报
//   （做不了的写原因，和单个 task_action 被拒时同一句）；同一个幂等键重发，做成了的拿到同一个结果；
// - 结束了的任务（全局任务也行）能直接归档，没结束的要先取消；
// - 定时触发的任务运营中时的暂停、继续、取消照旧落到它的触发上（取消时任务一起取消），取消之后能归档。
// - 失败的任务直接归档（单个、批量）：它留下的"失败后的抉择"作废——不再卡着任务、能归档删除，再点"重试"被拒、不会假装做成了。
import { CHANNELS, EVENT_TYPES, type InboxItem, type InboxItemEventPayload } from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { submitPlanStep } from "../helpers/plans.ts";
import { eventually, maintainerScript, ok, onePlan, runningTask, tasksOf } from "../helpers/running-task.ts";

const { cards: CARDS, board: BOARD, inbox: INBOX } = CHANNELS;

describe("一次处理多个任务", () => {
  it("暂停、继续、取消、归档：各自成败、逐条回报；重发拿到同一个结果；结束了的全局任务能直接归档，没结束的要先取消；定时触发的落到它的触发上", async () => {
    const td = await startTestDaemon({ maintainer: maintainerScript() });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [BOARD]: 0, [CARDS]: 0, [INBOX]: 0 });
    const running = await runningTask(td, frontend, "整理笔记");
    const planning = td.daemon.tasks.createByRequest({ title: "查资料", summary: "查资料" }).id;
    const weekly = { kind: "schedule" as const, schedule: { kind: "weekly" as const, time: "09:00", weekdays: [1] } };
    const timed = (ok(await frontend.startTask("每周检查依赖\n看看依赖有没有新版本", "k-timed", [], "plain", weekly)) as { taskId: string }).taskId;
    const jobOf = () => td.daemon.scheduledJobs.ofTask(timed)!;
    expect(jobOf().state).toBe("active");

    // 暂停：执行中的暂停了；规划中的不能暂停、找不到的写明，不影响别的
    expect(ok(await frontend.taskBatchAction({ taskIds: [running, planning, "t-none"], action: "pause" }))).toEqual({
      results: [
        { taskId: running, ok: true, state: "paused" },
        { taskId: planning, ok: false, code: "not_allowed", message: "任务现在是规划中，不能暂停" },
        { taskId: "t-none", ok: false, code: "not_found", message: "没有任务 t-none" },
      ],
    });
    expect(td.daemon.tasks.get(running)!.state).toBe("paused");

    // 继续：回到执行中（有名额）
    expect(ok(await frontend.taskBatchAction({ taskIds: [running], action: "resume" }))).toEqual({ results: [{ taskId: running, ok: true, state: "running" }] });

    // 取消两个；同一个幂等键重发拿到同一个结果，不再做一遍
    const cancelled = { results: [{ taskId: running, ok: true, state: "cancelled" }, { taskId: planning, ok: true, state: "cancelled" }] };
    expect(ok(await frontend.taskBatchAction({ taskIds: [running, planning], action: "cancel" }, "k-cancel"))).toEqual(cancelled);
    expect(ok(await frontend.taskBatchAction({ taskIds: [running, planning], action: "cancel" }, "k-cancel"))).toEqual(cancelled);

    // 归档：结束了的全局任务直接归档；运营中的定时任务没结束，要先取消
    expect(ok(await frontend.taskBatchAction({ taskIds: [running, planning, timed], action: "archive" }))).toEqual({
      results: [
        { taskId: running, ok: true, state: "archived" },
        { taskId: planning, ok: true, state: "archived" },
        { taskId: timed, ok: false, code: "not_allowed", message: "任务现在是运营中，还没结束：先取消再归档" },
      ],
    });
    expect(td.daemon.tasks.get(running)!.state).toBe("archived");

    // 定时触发的：暂停、继续落到触发上，任务还是运营中；取消时任务一起取消，之后能归档
    expect(ok(await frontend.taskBatchAction({ taskIds: [timed], action: "pause" }))).toEqual({ results: [{ taskId: timed, ok: true, state: "operating" }] });
    expect(jobOf().state).toBe("paused");
    ok(await frontend.taskBatchAction({ taskIds: [timed], action: "resume" }));
    expect(jobOf().state).toBe("active");
    expect(ok(await frontend.taskBatchAction({ taskIds: [timed], action: "cancel" }))).toEqual({ results: [{ taskId: timed, ok: true, state: "cancelled" }] });
    expect(jobOf().state).toBe("cancelled");
    expect(ok(await frontend.taskBatchAction({ taskIds: [timed], action: "archive" }))).toEqual({ results: [{ taskId: timed, ok: true, state: "archived" }] });
  }, 60_000);

  it("失败的任务直接归档（单个、批量）：失败后的抉择作废，不再卡着任务、能归档删除，再点重试被拒", async () => {
    // 维护者第一次唤起交计划，确认后一开始就判失败
    const failing = (_id: string, spawn: number): FauxStep[] =>
      spawn === 1
        ? [submitPlanStep(onePlan()), { kind: "reply", text: "计划交上去了" }]
        : [{ kind: "reply", toolCalls: [{ name: "fail_task", arguments: { reason: "源站打不开" } as never }] }, { kind: "reply", text: "失败了" }];
    const td = await startTestDaemon({ maintainer: failing });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [BOARD]: 0, [CARDS]: 0, [INBOX]: 0 });
    const inboxOf = (): InboxItem[] => frontend.events({ channel: INBOX, type: EVENT_TYPES.inboxItem }).map((f) => (f.payload as InboxItemEventPayload).item);
    const choiceOf = (taskId: string) => eventually(inboxOf, (i) => i.kind === "notice" && i.notice === "failure_choice" && (i.data as { taskId?: unknown }).taskId === taskId, `${taskId} 失败后的抉择`);

    const one = await runningTask(td, frontend, "抓取 A 站");
    const two = await runningTask(td, frontend, "抓取 B 站");
    for (const id of [one, two]) await eventually(() => tasksOf(frontend), (e) => e.task.id === id && e.change === "failed", `${id} 失败`);
    const [first, second] = [await choiceOf(one), await choiceOf(two)];
    expect(first).toMatchObject({ urgency: "blocking", actions: ["重试", "取消任务"] });
    // 卡着任务时不能归档、删除
    expect(await frontend.inboxAction({ itemIds: [first.id], action: "archive" })).toMatchObject({ ok: false, error: { code: "not_allowed" } });

    // 一个单个归档，一个批量归档
    expect(ok(await frontend.taskAction({ taskId: one, action: "archive" }))).toEqual({ taskId: one, state: "archived" });
    expect(ok(await frontend.taskBatchAction({ taskIds: [two], action: "archive" }))).toEqual({ results: [{ taskId: two, ok: true, state: "archived" }] });

    // 两条抉择都作废了：不再卡着任务
    const voided = { kind: "notice", handled: "已作废", handledNote: "任务已经归档，这一条作废了", urgency: "non_blocking", read: true };
    expect(await eventually(inboxOf, (i) => i.id === first.id && i.kind === "notice" && i.handled !== undefined, "第一条作废")).toMatchObject(voided);
    expect(await eventually(inboxOf, (i) => i.id === second.id && i.kind === "notice" && i.handled !== undefined, "第二条作废")).toMatchObject(voided);
    // 再点"重试"：被拒，写明原因；任务还是已归档，什么也没做
    expect(await frontend.inboxAction({ itemIds: [first.id], action: "handle", choice: "重试" })).toMatchObject({ ok: false, error: { code: "conflict", message: "任务已经归档，这一条作废了" } });
    expect(td.daemon.tasks.get(one)!.state).toBe("archived");
    // 能归档、删除
    ok(await frontend.inboxAction({ itemIds: [first.id], action: "archive" }));
    ok(await frontend.inboxAction({ itemIds: [second.id], action: "delete" }));
    expect(td.daemon.inbox.get(first.id)).toMatchObject({ archived: true });
    expect(td.daemon.inbox.get(second.id)).toMatchObject({ deleted: true });
  }, 60_000);
});
