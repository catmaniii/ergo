// 任务状态机（规格第 8 节）："谁能改"表。所有状态迁移都在任务模块里按这张表校验（纯函数），
// 不在表里的迁移、不是表里写的人发起的迁移一律拒绝。12 号票用到规划中 → 待确认 → 排队中、待确认 → 规划中，
// 其余各行（13、14、15、22 号票要用的执行、等我、暂停、完成、转为项目、取消……）照规格先写好。
// 同一对状态之间可以有几行（执行中 → 已完成：维护者"完成"，用户"转为项目"），谁能做看全部这几行。
import { ENDED_TASK_STATES, TASK_ACTOR_LABEL, TASK_STATE_LABEL, type TaskActor, type TaskState, UNFINISHED_TASK_STATES } from "@ergou/protocol";

interface Transition {
  from: TaskState;
  to: TaskState;
  /** 这一步叫什么（拒绝时说明用） */
  action: string;
  by: readonly TaskActor[];
}

/**
 * "谁能改"表：
 * - 用户：发起任务、确认计划、暂停 / 继续、取消、批准、回答、验收、返工、归档、转为项目（以"已完成 · 已转为项目"结束）；
 * - 秘书：按用户的发起建任务卡（建卡不是迁移）、写任务书；用户要求时取消；
 * - 维护者：开始、报告进展、转为等我、完成、失败；起草计划的维护者提交计划；
 * - 系统：排队调度；卡住或超预算时转等我，累计被拒太多次时暂停；恢复执行而名额已满的回到排队中。
 */
export const TASK_TRANSITIONS: readonly Transition[] = [
  { from: "planning", to: "awaiting_confirm", action: "提交计划", by: ["maintainer"] },
  { from: "awaiting_confirm", to: "queued", action: "确认计划", by: ["user"] },
  { from: "awaiting_confirm", to: "planning", action: "打回计划", by: ["user"] },
  { from: "queued", to: "running", action: "开始执行", by: ["system", "maintainer"] },
  { from: "running", to: "waiting_for_user", action: "转为等我", by: ["maintainer", "system"] },
  { from: "waiting_for_user", to: "running", action: "接着执行", by: ["user", "system"] },
  { from: "waiting_for_user", to: "queued", action: "回到排队（执行名额满了）", by: ["user", "system"] },
  { from: "running", to: "paused", action: "暂停", by: ["user", "system"] },
  { from: "waiting_for_user", to: "paused", action: "暂停", by: ["user", "system"] },
  { from: "queued", to: "paused", action: "暂停", by: ["user"] },
  { from: "paused", to: "running", action: "继续", by: ["user"] },
  { from: "paused", to: "queued", action: "继续（执行名额满了）", by: ["user", "system"] },
  { from: "running", to: "done", action: "完成", by: ["maintainer"] },
  { from: "running", to: "failed", action: "失败", by: ["maintainer"] },
  { from: "failed", to: "running", action: "重试", by: ["user"] },
  { from: "failed", to: "queued", action: "重试（执行名额满了）", by: ["user", "system"] },
  { from: "done", to: "running", action: "返工", by: ["user"] },
  { from: "done", to: "queued", action: "返工（执行名额满了）", by: ["user", "system"] },
  ...ENDED_TASK_STATES.filter((s) => s !== "archived").map((from): Transition => ({ from, to: "archived", action: "归档", by: ["user"] })),
  ...UNFINISHED_TASK_STATES.map((from): Transition => ({ from, to: "cancelled", action: "取消", by: ["user", "secretary"] })),
  // 转为项目（15 号票）：原任务的维护者接着做立项问答，任务以"已完成 · 已转为项目"结束（Task.endKind）
  ...UNFINISHED_TASK_STATES.map((from): Transition => ({ from, to: "done", action: "转为项目", by: ["user"] })),
];

export type TransitionCheck = { ok: true; action: string } | { ok: false; reason: string };

const label = (s: TaskState) => `「${TASK_STATE_LABEL[s]}」`;

/** 这次迁移能不能做：在表里、并且是表里写的人发起的 */
export function checkTaskTransition(from: TaskState, to: TaskState, by: TaskActor): TransitionCheck {
  const rows = TASK_TRANSITIONS.filter((t) => t.from === from && t.to === to);
  if (rows.length === 0) return { ok: false, reason: `任务不能从${label(from)}直接到${label(to)}` };
  const row = rows.find((r) => r.by.includes(by));
  if (row) return { ok: true, action: row.action };
  const who = rows.map((r) => `${r.action}只有${r.by.map((a) => TASK_ACTOR_LABEL[a]).join("、")}能做`).join("，");
  return { ok: false, reason: `${TASK_ACTOR_LABEL[by]}不能把任务从${label(from)}改成${label(to)}（${who}）` };
}
