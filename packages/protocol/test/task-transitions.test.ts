// 现在能对任务做什么（13 号票）：按"谁能改"表推出，守护进程的控制器、维护者模块和 Web 的任务详情都用这一份。表格驱动。
import { describe, expect, it } from "vitest";
import { availableTaskActions, type TaskAct, type TaskActSubject, taskActRefusal, TASK_TRANSITIONS } from "../src/index.ts";

const stage = (state: string, waitReason?: "acceptance" | "approval") => ({ state, ...(waitReason ? { waitReason } : {}) });

describe("用户能做的", () => {
  it.each<[string, TaskActSubject, TaskAct[]]>([
    ["规划中：取消、说话", { state: "planning" }, ["cancel", "message"]],
    ["待确认：取消、说话", { state: "awaiting_confirm" }, ["cancel", "message"]],
    ["排队中（没开始过）：暂停、取消、说话", { state: "queued" }, ["pause", "cancel", "message"]],
    ["执行中：暂停、取消、说话", { state: "running", stages: { list: [stage("running")] } }, ["pause", "cancel", "message"]],
    ["执行中、有一支等用户验收：多了验收通过、退回", { state: "running", stages: { list: [stage("waiting", "acceptance"), stage("running")] } }, ["pause", "cancel", "message", "accept_stage", "return_stage"]],
    ["等我（审批）：先在待我处理里处理，不能点继续", { state: "waiting_for_user", waitReason: "approval", stages: { list: [stage("waiting", "approval")] } }, ["pause", "cancel", "message"]],
    ["等我（卡住求助）：能继续执行", { state: "waiting_for_user", waitReason: "stuck", stages: { list: [stage("running")] } }, ["resume", "pause", "cancel", "message"]],
    ["等我（中断不确定，23 号票）：用户查过之后能继续执行", { state: "waiting_for_user", waitReason: "interrupted", stages: { list: [stage("running")] } }, ["resume", "pause", "cancel", "message"]],
    ["等我（超预算，14 号票）：能继续执行", { state: "waiting_for_user", waitReason: "over_budget", stages: { list: [stage("waiting")] } }, ["resume", "pause", "cancel", "message"]],
    ["等我（计划变更，14 号票）：先在待我处理里确认或拒绝计划变更卡", { state: "waiting_for_user", waitReason: "plan_change", stages: { list: [stage("waiting")] } }, ["pause", "cancel", "message"]],
    ["等我（由我验收）：验收通过、退回", { state: "waiting_for_user", waitReason: "acceptance", stages: { list: [stage("waiting", "acceptance")] } }, ["pause", "cancel", "message", "accept_stage", "return_stage"]],
    ["已暂停：继续、取消、说话", { state: "paused" }, ["resume", "cancel", "message"]],
    ["失败：重试、取消、说话（重试时维护者看得到）", { state: "failed" }, ["retry", "cancel", "message"]],
    ["已完成：返工，不再收消息", { state: "done", stages: { list: [stage("accepted")] } }, ["rework"]],
    ["已完成 · 已转为项目：什么都不能做", { state: "done", endKind: "converted_to_project" }, []],
    ["已取消、已归档：什么都不能做", { state: "cancelled" }, []],
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
    expect([...viaTransitions].toSorted()).toEqual(["cancel", "pause", "resume", "retry", "rework"]);
  });
});

describe("做不了时说明为什么", () => {
  it.each<[TaskActSubject & { title?: string }, TaskAct, string]>([
    [{ state: "done" }, "pause", "任务现在是已完成，不能暂停"],
    [{ state: "waiting_for_user", waitReason: "approval" }, "resume", "任务在等你处理：审批。先在待办里处理它"],
    [{ state: "running" }, "retry", "任务现在是执行中，只有失败的任务能重试"],
    [{ state: "done", endKind: "converted_to_project" }, "rework", "任务现在是已完成（已转为项目），只有已完成的任务能返工"],
    [{ state: "done", title: "X 的调研" }, "message", "任务「X 的调研」已完成，不再收消息；要返工请用任务详情里的“返工”"],
  ])("%j %s", (task, act, reason) => {
    expect(taskActRefusal(task, act)).toBe(reason);
  });
});
