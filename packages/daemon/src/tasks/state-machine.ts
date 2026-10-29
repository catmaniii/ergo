// 任务状态机（规格第 8 节）：所有状态迁移都在任务模块里按"谁能改"表（共享协议包的 TASK_TRANSITIONS，
// 守护进程和 Web 只有这一份）校验（纯函数），不在表里的迁移、不是表里写的人发起的迁移一律拒绝。
// 同一对状态之间可以有几行（执行中 → 已完成：维护者"完成"，用户"转为项目"），谁能做看全部这几行。
// 用户现在能不能对任务做某个控制（assertUserCan）只看共享协议包的 availableTaskActions（同一张表推出）。
import {
  availableTaskActions,
  type Task,
  type TaskAction,
  taskActRefusal,
  TASK_ACTOR_LABEL,
  t,
  TASK_STATE_LABEL,
  TASK_TRANSITION_ACTION_LABEL,
  TASK_TRANSITIONS,
  type TaskActor,
  type TaskState,
} from "@ergo/protocol";
import { RequestRejected } from "../errors.ts";

export type TransitionCheck = { ok: true; action: string } | { ok: false; reason: string };

const label = (s: TaskState) => t("tasks.stateMachine.state", { state: TASK_STATE_LABEL[s] });

/** 这次迁移能不能做：在表里、并且是表里写的人发起的 */
export function checkTaskTransition(from: TaskState, to: TaskState, by: TaskActor): TransitionCheck {
  const rows = TASK_TRANSITIONS.filter((row) => row.from === from && row.to === to);
  if (rows.length === 0) return { ok: false, reason: t("tasks.stateMachine.noRow", { from: label(from), to: label(to) }) };
  const row = rows.find((r) => r.by.includes(by));
  if (row) return { ok: true, action: TASK_TRANSITION_ACTION_LABEL[row.action] };
  const who = rows
    .map((r) => t("tasks.stateMachine.onlyBy", { action: TASK_TRANSITION_ACTION_LABEL[r.action], actors: r.by.map((a) => TASK_ACTOR_LABEL[a]).join(t("protocol.common.listSep")) }))
    .join(t("protocol.plan.scope.sep"));
  return { ok: false, reason: t("tasks.stateMachine.notBy", { actor: TASK_ACTOR_LABEL[by], from: label(from), to: label(to), who }) };
}

/**
 * 用户现在能不能对这个任务做这个控制（task_action 请求、任务控制快速动作共用）：不能就抛 not_allowed，
 * 说法是 taskActRefusal，前面可以加上是哪个任务（prefix）
 */
export function assertUserCan(task: Task, action: TaskAction, prefix = ""): void {
  if (!availableTaskActions(task, "user").includes(action)) throw new RequestRejected("not_allowed", `${prefix}${taskActRefusal(task, action)}`);
}
