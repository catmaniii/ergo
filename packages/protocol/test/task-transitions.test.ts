// 现在能对任务做什么（13 号票）：按"谁能改"表推出，守护进程的控制器、维护者模块和 Web 的任务详情都用这一份。表格驱动。
import { describe, expect, it } from "vitest";
import { availableTaskActions, type TaskAct, type TaskActSubject, taskActRefusal, TASK_TRANSITIONS } from "../src/index.ts";

const stage = (state: string, waitReason?: "acceptance" | "approval") => ({ state, ...(waitReason ? { waitReason } : {}) });

describe("用户能做的", () => {
  it.each<[string, TaskActSubject, TaskAct[]]>([
    ["规划中：取消、说话", { state: "planning" }, ["cancel", "message"]],
    ["待确认：取消、说话", { state: "awaiting_confirm" }, ["cancel", "message"]],
    ["排队中（没开始过）：暂停、取消、说话", { state: "queued" }, ["pause", "cancel", "message"]],
    // 84 号票：建好了阶段的长程任务都能从某个阶段重做（rework），照 AgentSense 里程碑开始过就能重开（用户 2026-10-11 定；哪个阶段开始过由
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
    ["失败：重试、取消、说话（重试时维护者看得到）", { state: "failed" }, ["retry", "cancel", "message"]],
    ["失败（建好了阶段）：还能从某个阶段重做，重做后重新排队", { state: "failed", stages: { list: [stage("running")] } }, ["retry", "cancel", "message", "rework"]],
    ["已完成：返工，不再收消息", { state: "done", stages: { list: [stage("accepted")] } }, ["rework"]],
    ["已完成 · 已转为项目：什么都不能做", { state: "done", endKind: "converted_to_project" }, []],
    ["已取消、已归档：什么都不能做", { state: "cancelled" }, []],
    // 75 号票：普通任务没有阶段、没有返工；做完了还收消息——用户接着说，它接着做
    ["普通任务排队中：暂停、取消、说话", { state: "queued", kind: "plain" }, ["pause", "cancel", "message"]],
    ["普通任务执行中（没有阶段）：暂停、取消、说话", { state: "running", kind: "plain" }, ["pause", "cancel", "message"]],
    ["普通任务卡住求助：继续执行、回一句", { state: "waiting_for_user", waitReason: "stuck", kind: "plain" }, ["resume", "pause", "cancel", "message"]],
    ["普通任务已完成：不能返工，但还收消息（接着说）", { state: "done", kind: "plain" }, ["message"]],
    ["普通任务已取消：什么都不能做", { state: "cancelled", kind: "plain" }, []],
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

  it("归档（64 号票）：结束了的项目内部任务用户能在项目页上归档；全局任务不行（在每周的归档清单上），没结束的不行", () => {
    const internal = { projectId: "p-1", projectName: "记账本" };
    expect(availableTaskActions({ state: "done", internal }, "user")).toContain("archive");
    expect(availableTaskActions({ state: "cancelled", internal }, "user")).toContain("archive");
    expect(availableTaskActions({ state: "archived", internal }, "user")).not.toContain("archive");
    expect(availableTaskActions({ state: "running", internal }, "user")).not.toContain("archive");
    expect(availableTaskActions({ state: "done" }, "user")).not.toContain("archive");
    expect(availableTaskActions({ state: "done", internal }, "secretary")).not.toContain("archive");
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
  ])("%j %s", (task, act, reason) => {
    expect(taskActRefusal(task, act)).toBe(reason);
  });
});
