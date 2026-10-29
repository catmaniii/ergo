// 现在能对任务做什么（13 号票）：按"谁能改"表推出，守护进程的控制器、维护者模块和 Web 的任务详情都用这一份。表格驱动。
import { describe, expect, it } from "vitest";
import { archiveCancelsFirst, availableTaskActions, boardGroupOfReminder, type TaskAct, type TaskActSubject, taskActRefusal, taskDeleteRefusal, TASK_TRANSITIONS } from "../src/index.ts";

const stage = (state: string, waitReason?: "acceptance" | "approval") => ({ state, ...(waitReason ? { waitReason } : {}) });

describe("用户能做的", () => {
  it.each<[string, TaskActSubject, TaskAct[]]>([
    ["规划中：取消、说话", { state: "planning" }, ["cancel", "message"]],
    ["待确认：取消、说话", { state: "awaiting_confirm" }, ["cancel", "message"]],
    ["排队中（没开始过）：暂停、取消、说话", { state: "queued" }, ["pause", "cancel", "message"]],
    // 84 号票：建好了阶段的长程任务都能从某个阶段重做（rework），阶段开始过就能重开（用户 2026-10-11 定；哪个阶段开始过由
    // 控制器和任务详情再看）
    ["执行中：暂停、取消、说话、从某个阶段重做", { state: "running", stages: { list: [stage("running")] } }, ["pause", "cancel", "message", "rework"]],
    ["执行中、有一支等用户验收：多了验收通过、退回", { state: "running", stages: { list: [stage("waiting", "acceptance"), stage("running")] } }, ["pause", "cancel", "message", "accept_stage", "return_stage", "rework"]],
    ["执行中的流程：不能重做（流程没有返工）", { state: "running", kind: "workflow", stages: { list: [stage("running")] } }, ["pause", "cancel", "message"]],
    ["等我（审批）：先在待我处理里处理，不能点继续；能从某个阶段重做", { state: "waiting_for_user", waitReason: "approval", stages: { list: [stage("waiting", "approval")] } }, ["pause", "cancel", "message", "rework"]],
    ["等我（卡住求助）：能继续执行", { state: "waiting_for_user", waitReason: "stuck", stages: { list: [stage("running")] } }, ["resume", "pause", "cancel", "message", "rework"]],
    // 重做时那条"中断：不确定"随之作废（84 号票）
    ["等我（中断不确定，23 号票）：用户查过之后能继续执行；也能从某个阶段重做", { state: "waiting_for_user", waitReason: "interrupted", stages: { list: [stage("running")] } }, ["resume", "pause", "cancel", "message", "rework"]],
    ["等我（超预算，14 号票）：能继续执行", { state: "waiting_for_user", waitReason: "over_budget", stages: { list: [stage("waiting")] } }, ["resume", "pause", "cancel", "message", "rework"]],
    ["等我（计划变更，14 号票）：先在待我处理里确认或拒绝计划变更卡", { state: "waiting_for_user", waitReason: "plan_change", stages: { list: [stage("waiting")] } }, ["pause", "cancel", "message", "rework"]],
    ["等我（由我验收）：验收通过、退回", { state: "waiting_for_user", waitReason: "acceptance", stages: { list: [stage("waiting", "acceptance")] } }, ["pause", "cancel", "message", "accept_stage", "return_stage", "rework"]],
    ["已暂停（没开始过）：继续、取消、说话", { state: "paused" }, ["resume", "cancel", "message"]],
    ["已暂停（建好了阶段）：还能从某个阶段重做，重做后仍暂停", { state: "paused", stages: { list: [stage("running")] } }, ["resume", "cancel", "message", "rework"]],
    ["排队中（开始过）：还能从某个阶段重做，重做后仍排队", { state: "queued", stages: { list: [stage("running")] } }, ["pause", "cancel", "message", "rework"]],
    // 90 号票：结束了的（失败、已完成、已取消）随时能直接归档，全局任务、项目内部任务都行
    ["失败：重试、取消、说话（重试时维护者看得到）、归档", { state: "failed" }, ["retry", "cancel", "message", "archive"]],
    ["失败（建好了阶段）：还能从某个阶段重做，重做后重新排队", { state: "failed", stages: { list: [stage("running")] } }, ["retry", "cancel", "message", "rework", "archive"]],
    ["已完成：返工、归档，不再收消息", { state: "done", stages: { list: [stage("accepted")] } }, ["rework", "archive"]],
    ["已完成 · 已转为项目：只能归档", { state: "done", endKind: "converted_to_project" }, ["archive"]],
    ["已取消：只能归档", { state: "cancelled" }, ["archive"]],
    ["已归档：什么都不能做", { state: "archived" }, []],
    // 75 号票：普通任务没有阶段、没有返工；做完了还收消息——用户接着说，它接着做
    ["普通任务排队中：暂停、取消、说话", { state: "queued", kind: "plain" }, ["pause", "cancel", "message"]],
    ["普通任务执行中（没有阶段）：暂停、取消、说话", { state: "running", kind: "plain" }, ["pause", "cancel", "message"]],
    ["普通任务卡住求助：继续执行、回一句", { state: "waiting_for_user", waitReason: "stuck", kind: "plain" }, ["resume", "pause", "cancel", "message"]],
    ["普通任务已完成：不能返工，但还收消息（接着说）；能归档", { state: "done", kind: "plain" }, ["message", "archive"]],
    ["普通任务已取消：只能归档", { state: "cancelled", kind: "plain" }, ["archive"]],
  ])("%s", (_name, task, acts) => {
    expect(availableTaskActions(task, "user").toSorted()).toEqual(acts.toSorted());
  });
});

describe("别人能做的", () => {
  it("维护者在规划中、待确认、执行中、等我时处理输入；排队中、已暂停、结束了的输入留在队里", () => {
    const works = (["planning", "awaiting_confirm", "queued", "running", "waiting_for_user", "paused", "done", "failed", "cancelled", "archived"] as const).filter((state) =>
      availableTaskActions({ state }, "maintainer").includes("work"),
    );
    expect(works).toEqual(["planning", "awaiting_confirm", "running", "waiting_for_user"]);
  });

  it("秘书只能取消（用户要求时）；系统能暂停执行中的（14 号票：累计被拒太多次时）", () => {
    expect(availableTaskActions({ state: "running" }, "secretary")).toEqual(["cancel"]);
    expect(availableTaskActions({ state: "running" }, "system")).toEqual(["pause"]);
  });

  it("用户的控制都对得上表里的迁移（除了验收通过、退回这两件阶段上的事）", () => {
    const viaTransitions = new Set(TASK_TRANSITIONS.flatMap((t) => (t.act ? [t.act] : [])));
    expect([...viaTransitions].toSorted()).toEqual(["archive", "cancel", "pause", "resume", "retry", "rework"]);
  });

  it("归档（90 号票）：结束了的任务用户随时能直接归档——全局任务、项目内部任务都行（每周的归档清单照旧）；没结束的要先取消；只有用户能归档", () => {
    for (const state of ["done", "failed", "cancelled"] as const) {
      expect(availableTaskActions({ state }, "user")).toContain("archive");
      expect(availableTaskActions({ state, internal: { projectId: "p-1", projectName: "记账本" } }, "user")).toContain("archive");
      expect(availableTaskActions({ state }, "secretary")).not.toContain("archive");
      expect(availableTaskActions({ state }, "maintainer")).not.toContain("archive");
    }
    for (const state of ["planning", "awaiting_confirm", "scheduled", "queued", "running", "waiting_for_user", "paused", "operating", "archived"] as const) {
      expect(availableTaskActions({ state }, "user")).not.toContain("archive");
    }
  });
});

describe("做不了时说明为什么", () => {
  it.each<[TaskActSubject & { title?: string }, TaskAct, string]>([
    [{ state: "done" }, "pause", "任务现在是已完成，不能暂停"],
    [{ state: "waiting_for_user", waitReason: "approval" }, "resume", "任务在等你处理：审批。先在待办里处理它"],
    [{ state: "running" }, "retry", "任务现在是执行中，只有失败的任务能重试"],
    [{ state: "done", endKind: "converted_to_project", stages: { list: [stage("accepted")] } }, "rework", "任务现在是已完成（已转为项目），不能再从某个阶段重做"],
    [{ state: "paused" }, "rework", "任务还没开始执行，没有能重做的阶段"],
    [{ state: "cancelled", stages: { list: [stage("running")] } }, "rework", "任务现在是已取消，不能从某个阶段重做"],
    [{ state: "done", title: "X 的调研" }, "message", "任务「X 的调研」已完成，不再收消息；要返工请用任务详情里的“返工”"],
    [{ state: "done", kind: "plain" }, "rework", "普通任务没有返工：在任务详情里接着说，它就接着做"],
    [{ state: "running" }, "archive", "任务现在是执行中，还没结束：先取消再归档"],
    [{ state: "archived" }, "archive", "任务已经归档了"],
  ])("%j %s", (task, act, reason) => {
    expect(taskActRefusal(task, act)).toBe(reason);
  });
});

describe("简单提醒在看板上的分组（185 号票）", () => {
  it.each<[string, Parameters<typeof boardGroupOfReminder>[0], ReturnType<typeof boardGroupOfReminder>]>([
    ["待触发的在运营中", { status: "pending" }, "ops"],
    ["已触发的一次性提醒在最近结束", { status: "fired" }, "ended"],
    ["已取消的也在最近结束（和已取消的任务一样，能归档、删除）", { status: "cancelled" }, "ended"],
    ["归档了的在已归档", { status: "fired", archived: true }, "archived"],
    ["取消后归档的在已归档", { status: "cancelled", archived: true }, "archived"],
    ["删了的不上看板", { status: "deleted" }, undefined],
    ["归档后又删了的也不上", { status: "deleted", archived: true }, undefined],
  ])("%s", (_name, reminder, group) => {
    expect(boardGroupOfReminder(reminder)).toBe(group);
  });
});

describe("没结束的任务归档：先取消再归档（186 号票）", () => {
  it.each<[TaskActSubject, boolean]>([
    [{ state: "planning" }, true],
    [{ state: "running", stages: { list: [stage("running")] } }, true],
    [{ state: "waiting_for_user", waitReason: "approval" }, true],
    [{ state: "operating" }, true],
    [{ state: "scheduled" }, true],
    // 结束了的直接归档，不用先取消；已归档的不能再归档
    [{ state: "done" }, false],
    [{ state: "failed" }, false],
    [{ state: "cancelled" }, false],
    [{ state: "archived" }, false],
  ])("%j", (task, cancelsFirst) => {
    expect(archiveCancelsFirst(task)).toBe(cancelsFirst);
  });
});

describe("任务能不能删（186 号票）", () => {
  const live = { "pm-1": { name: "记账本" } } as Record<string, { name: string }>;
  const projectOf = (maintainerId: string) => live[maintainerId];
  it.each<[string, Parameters<typeof taskDeleteRefusal>[0], string | undefined]>([
    ["任务自己的维护者做的：能删", { maintainerId: "tm-3" }, undefined],
    ["项目内部任务：随项目删", { maintainerId: "pm-1", internal: { projectId: "p-1", projectName: "记账本" } }, "这是项目「记账本」的内部任务，项目还在时由项目管：删项目时它一起删掉"],
    ["转为项目了的（项目还在）：跟着项目", { maintainerId: "pm-1", endKind: "converted_to_project" }, "任务已转为项目「记账本」，会话和工作目录跟着项目走：项目还在时由项目管，删项目时一起删"],
    ["项目的维护者做的单项目任务（64 号票之前的）：会话在项目里", { maintainerId: "pm-1" }, "这个任务由项目「记账本」的维护者做，会话在项目的维护者会话里：项目还在时由项目管，不能单独删"],
    ["转为项目、项目已经删了：能删（会话随项目删过了）", { maintainerId: "tm-2", endKind: "converted_to_project" }, undefined],
    ["项目的维护者做的、项目已经删了：能删", { maintainerId: "pm-9" }, undefined],
  ])("%s", (_name, task, refusal) => {
    expect(taskDeleteRefusal(task, projectOf)).toBe(refusal);
  });
});
