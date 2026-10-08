// 执行中各阶段的状态（规格第 8 节"阶段执行""状态补充""返工"）：控制器（execution.ts）用的纯函数。
// 阶段的状态存在任务里（Task.stages.list，看板频道上的 task 事件），不在 pi 会话里。
// - 前置阶段都验收了才能开始（missingPrerequisites）；
// - 同一时刻维护者只做一个阶段（running 或 accepting）；可并行的阶段在本票由维护者依次执行，真正并行在 20 号票；
// - 下一步（nextStep）：有在做的就接着做；没有就开始一个能开始的（之前做到一半停下的优先，其余按计划里的顺序）；
//   没有能开始的、有一支在等用户就转等我；阶段都建好了、全部验收了才完成（还没建阶段的不算完成）；
// 开始执行时各阶段的样子（initialStages）在共享协议包里（Web 在还没开始执行时也按它列出）。
// - 返工（reopen）：按依赖重开指定阶段和它的全部下游，其余保持已验收。
import type { StageState, TaskStage, TaskWaitReason } from "@ergou/protocol";

export function findStage(list: readonly TaskStage[], stageId: string): TaskStage | undefined {
  return list.find((s) => s.stageId === stageId);
}

/** 阶段换个状态，去掉"在等什么"（开始、不用再等、验收、退回时） */
export function stageNow(stage: TaskStage, state: StageState, patch: Partial<TaskStage> = {}): TaskStage {
  const { waitReason: _reason, waitingOn: _on, ...rest } = stage;
  return { ...rest, ...patch, state };
}

/** 换掉一个阶段（其余不动） */
export function withStage(list: readonly TaskStage[], stageId: string, patch: (s: TaskStage) => TaskStage): TaskStage[] {
  return list.map((s) => (s.stageId === stageId ? patch(s) : s));
}

/** 这个阶段还有哪些前置阶段没验收（空的就能开始） */
export function missingPrerequisites(list: readonly TaskStage[], stageId: string): string[] {
  const stage = findStage(list, stageId);
  if (!stage) return [];
  return stage.dependsOn.filter((dep) => findStage(list, dep)?.state !== "accepted");
}

/** 维护者正在做（或在验收）的阶段 */
export function activeStage(list: readonly TaskStage[]): TaskStage | undefined {
  return list.find((s) => s.state === "running" || s.state === "accepting");
}

/** 能开始的阶段：没开始、前置都验收了。之前做到一半停下的（开始过的）在前，其余按计划里的顺序 */
export function runnableStages(list: readonly TaskStage[]): TaskStage[] {
  const ready = list.filter((s) => s.state === "pending" && missingPrerequisites(list, s.stageId).length === 0);
  return [...ready.filter((s) => s.startedAt !== undefined), ...ready.filter((s) => s.startedAt === undefined)];
}

export type NextStep =
  /** 有阶段在做或在验收：接着做 */
  | { kind: "continue" }
  /** 开始这个阶段 */
  | { kind: "start"; stageId: string }
  /** 所有能推进的分支都在等用户：转等我（原因取第一支在等的） */
  | { kind: "wait"; reason: TaskWaitReason; stageId: string }
  /** 全部阶段验收了：完成 */
  | { kind: "complete" };

/** 阶段都建好了、全部验收了（还没建阶段的不算） */
export function allAccepted(list: readonly TaskStage[]): boolean {
  return list.length > 0 && list.every((s) => s.state === "accepted");
}

export function nextStep(list: readonly TaskStage[]): NextStep {
  if (allAccepted(list)) return { kind: "complete" };
  // 还没建阶段（不该在执行中出现）：什么也不做
  if (list.length === 0 || activeStage(list)) return { kind: "continue" };
  const start = runnableStages(list)[0];
  if (start) return { kind: "start", stageId: start.stageId };
  const waiting = list.find((s) => s.state === "waiting");
  // 计划的检查保证前置关系不成环，没有在等的又没有能开始的不会出现；万一出现按卡住求助
  if (!waiting) return { kind: "wait", reason: "stuck", stageId: list.find((s) => s.state !== "accepted")!.stageId };
  return { kind: "wait", reason: waiting.waitReason ?? "stuck", stageId: waiting.stageId };
}

/** 这个阶段和它的全部下游（按依赖传递），按计划里的顺序 */
export function downstreamOf(list: readonly TaskStage[], stageId: string): string[] {
  const out = new Set([stageId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of list) {
      if (!out.has(s.stageId) && s.dependsOn.some((d) => out.has(d))) {
        out.add(s.stageId);
        grew = true;
      }
    }
  }
  return list.map((s) => s.stageId).filter((id) => out.has(id));
}

/** 返工：重开指定阶段和它的全部下游（回到未开始，清掉验收结果），其余不动 */
export function reopen(list: readonly TaskStage[], stageId: string): TaskStage[] {
  const reopened = new Set(downstreamOf(list, stageId));
  return list.map((s) => {
    if (!reopened.has(s.stageId)) return s;
    const { startedAt: _started, ...rest } = stageNow(s, "pending");
    return { ...rest, acceptance: s.acceptance.map(({ criterion, method }) => ({ criterion, method })) };
  });
}

/** 看板上的"第 N 阶段"（按计划里的顺序）：在做的；没有就第一支在等的；再没有就第一个没开始的；全验收了是最后一个 */
export function stagePosition(list: readonly TaskStage[]): number {
  const at = list.indexOf(stageInFocus(list));
  return at + 1;
}

/** 守卫看到的当前阶段（授权只在所属阶段内有效；调用指纹也按它）：同上 */
export function guardStageId(list: readonly TaskStage[]): string {
  return stageInFocus(list).stageId;
}

function stageInFocus(list: readonly TaskStage[]): TaskStage {
  return activeStage(list) ?? list.find((s) => s.state === "waiting") ?? list.find((s) => s.state === "pending") ?? list.at(-1)!;
}
