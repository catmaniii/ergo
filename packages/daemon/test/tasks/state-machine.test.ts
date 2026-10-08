// 任务状态迁移按"谁能改"表校验（规格第 8 节）：纯函数，表格驱动。
import { TASK_ACTORS, TASK_STATES, type TaskActor, type TaskState } from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { checkTaskTransition } from "../../src/tasks/state-machine.ts";

const allowed = (from: TaskState, to: TaskState, by: TaskActor) => checkTaskTransition(from, to, by).ok;

describe("谁能改", () => {
  it.each([
    // 计划：只有执行的维护者提交计划把任务推进到待确认；只有用户确认和打回
    ["planning", "awaiting_confirm", "maintainer", true],
    ["planning", "awaiting_confirm", "secretary", false],
    ["planning", "awaiting_confirm", "user", false],
    ["planning", "awaiting_confirm", "system", false],
    ["awaiting_confirm", "queued", "user", true],
    ["awaiting_confirm", "queued", "secretary", false],
    ["awaiting_confirm", "queued", "maintainer", false],
    ["awaiting_confirm", "queued", "system", false],
    ["awaiting_confirm", "planning", "user", true],
    ["awaiting_confirm", "planning", "maintainer", false],
    ["awaiting_confirm", "planning", "secretary", false],
    // 排队调度是系统的事；卡住时转等我（维护者或系统）；完成、失败是维护者报的
    ["queued", "running", "system", true],
    ["queued", "running", "user", false],
    ["running", "waiting_for_user", "maintainer", true],
    ["running", "waiting_for_user", "system", true],
    ["running", "done", "maintainer", true],
    ["running", "done", "secretary", false],
    ["running", "failed", "maintainer", true],
    ["running", "paused", "user", true],
    ["running", "paused", "system", true],
    ["queued", "paused", "user", true],
    ["queued", "paused", "maintainer", false],
    ["paused", "running", "user", true],
    ["paused", "queued", "user", true],
    ["failed", "running", "user", true],
    ["done", "running", "user", true],
    ["done", "archived", "user", true],
    ["done", "archived", "system", false],
    // 取消：用户随时可以（未结束的），秘书在用户要求时
    ["planning", "cancelled", "user", true],
    ["planning", "cancelled", "secretary", true],
    ["running", "cancelled", "secretary", true],
    ["running", "cancelled", "maintainer", false],
    ["done", "cancelled", "user", false],
    // 转为项目（15 号票）：用户把任何未结束的任务转为项目，任务以"已完成 · 已转为项目"结束
    ["planning", "done", "user", true],
    ["awaiting_confirm", "done", "user", true],
    ["running", "done", "user", true],
    ["paused", "done", "user", true],
    ["planning", "done", "secretary", false],
    ["failed", "done", "user", false],
    // 13 号票：全部阶段验收通过后系统自动完成（最后一个阶段由用户验收时，任务可能正在等我）
    ["running", "done", "system", true],
    ["waiting_for_user", "done", "system", true],
    ["waiting_for_user", "done", "maintainer", false],
    // 失败后的抉择：重试或取消
    ["failed", "cancelled", "user", true],
    ["failed", "cancelled", "secretary", false],
    // 恢复执行而名额满了：回到排队中
    ["waiting_for_user", "queued", "system", true],
    ["paused", "queued", "system", true],
    ["failed", "queued", "user", true],
    ["done", "queued", "user", true],
  ] as const)("%s → %s 由 %s：%s", (from, to, by, ok) => {
    expect(allowed(from, to, by)).toBe(ok);
  });

  it("不允许的迁移给出原因（写明谁、从哪到哪）", () => {
    const result = checkTaskTransition("awaiting_confirm", "queued", "secretary");
    expect(result).toEqual({ ok: false, reason: "秘书不能把任务从「待确认」改成「排队中」（确认计划只有用户能做）" });
    expect(checkTaskTransition("planning", "failed", "maintainer")).toEqual({ ok: false, reason: "任务不能从「规划中」直接到「失败」" });
    // 同一对状态之间有几行时，原因里写全
    expect(checkTaskTransition("running", "done", "secretary")).toEqual({ ok: false, reason: "秘书不能把任务从「执行中」改成「已完成」（完成只有维护者、系统能做，转为项目只有用户能做）" });
  });

  it("已归档、已取消是终点：除了已取消的可以归档，哪儿也去不了", () => {
    for (const to of TASK_STATES) for (const by of TASK_ACTORS) expect(allowed("archived", to, by)).toBe(false);
    for (const to of TASK_STATES) for (const by of TASK_ACTORS) expect(allowed("cancelled", to, by)).toBe(to === "archived" && by === "user");
  });

  it("秘书只能取消（建卡不是迁移）", () => {
    const targets = TASK_STATES.flatMap((from) => TASK_STATES.filter((to) => allowed(from, to, "secretary")));
    expect(new Set(targets)).toEqual(new Set(["cancelled"]));
  });
});
