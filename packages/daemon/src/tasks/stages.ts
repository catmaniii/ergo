// 执行中各阶段的状态（规格第 8 节"阶段执行""状态补充""返工"）：控制器（execution.ts）用的纯函数。
// 阶段的状态存在任务里（Task.stages.list，看板频道上的 task 事件），不在 pi 会话里。
// - 前置阶段都验收了才能开始（missingPrerequisites）；
// - 同一时刻维护者只做一个阶段（running 或 accepting）；可并行的阶段由维护者依次执行，用户同意派子 agent 时（20 号票）
//   几个阶段才同时在做。有子 agent 在做的阶段（busy，控制器另外知道）不算维护者手头的；
// - 维护者的当前阶段（currentStage）：它最后一次开始的那个（focus，记在任务里），不按计划里的顺序取；
// - 下一步（nextStep）：维护者手头有在做的就接着做；没有就开始一个能开始的（之前做到一半停下的优先，其余按计划里的顺序）；
//   在做的只剩子 agent 的就接着等它们；没有能开始的、有一支在等用户就转等我；阶段都建好了、全部验收了才完成（还没建阶段的不算完成）；
// 开始执行时各阶段的样子（initialStages）在共享协议包里（Web 在还没开始执行时也按它列出）。
// - 返工（reopen）：按依赖重开指定阶段和它的全部下游，其余保持已验收。
import type { MessageScope, StageState, Task, TaskStage, TaskWaitReason } from "@ergou/protocol";

export function findStage(list: readonly TaskStage[], stageId: string): TaskStage | undefined {
  return list.find((s) => s.stageId === stageId);
}

/** 阶段换个状态，去掉"在等什么"和为什么停下（开始、不用再等、验收、退回时） */
export function stageNow(stage: TaskStage, state: StageState, patch: Partial<TaskStage> = {}): TaskStage {
  const { waitReason: _reason, waitingOn: _on, waitNote: _note, ...rest } = stage;
  return { ...rest, ...patch, state };
}

/** 这一支停下等用户：在等什么（审批 id、待我处理事项 id、计划变更卡 id）、为什么（14 号票） */
export function stageWaiting(stage: TaskStage, reason: TaskWaitReason, waitingOn: string, note?: string): TaskStage {
  return { ...stageNow(stage, "waiting"), waitReason: reason, waitingOn, ...(note === undefined ? {} : { waitNote: note }) };
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

/** busy：有子 agent 在做的阶段（20 号票），不算维护者手头的 */
export function nextStep(list: readonly TaskStage[], busy: ReadonlySet<string> = new Set()): NextStep {
  if (allAccepted(list)) return { kind: "complete" };
  // 还没建阶段（不该在执行中出现）：什么也不做
  if (list.length === 0 || activeStage(list.filter((s) => !busy.has(s.stageId)))) return { kind: "continue" };
  const start = runnableStages(list)[0];
  if (start) return { kind: "start", stageId: start.stageId };
  // 在做的只剩子 agent 的：等它们交回结果
  if (activeStage(list)) return { kind: "continue" };
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

/**
 * 维护者的当前阶段（守卫看到的：授权只在所属阶段内有效，调用指纹也按它；看板上的"第 N 阶段"、重注入块的"当前阶段"也按它）：
 * - 它最后一次开始的阶段（focus：维护者 start_stage 的、运行时替它开始的；用户同意并行时交给子 agent 的不算）还在做、
 *   在验收或在等用户，就是它（交给了子 agent 的也是：维护者在协调这一支）；
 * - 否则（还没记下过、已经验收了、放下了）：它自己在做的（有子 agent 在做的不算）；没有就第一支在等的；再没有就第一个没开始的；
 *   都没有就子 agent 在做的；全验收了是最后一个
 */
export function currentStage(list: readonly TaskStage[], focus?: string, busy: ReadonlySet<string> = new Set()): TaskStage {
  const mine = focus === undefined ? undefined : findStage(list, focus);
  if (mine && (mine.state === "running" || mine.state === "accepting" || mine.state === "waiting")) return mine;
  return (
    activeStage(list.filter((s) => !busy.has(s.stageId))) ??
    list.find((s) => s.state === "waiting") ??
    list.find((s) => s.state === "pending") ??
    activeStage(list) ??
    list.at(-1)!
  );
}

/** 看板上的"第 N 阶段"（按计划里的顺序）：维护者的当前阶段是第几个 */
export function stagePosition(list: readonly TaskStage[], focus?: string, busy?: ReadonlySet<string>): number {
  return list.indexOf(currentStage(list, focus, busy)) + 1;
}

/** 守卫看到的当前阶段：同上 */
export function guardStageId(list: readonly TaskStage[], focus?: string, busy?: ReadonlySet<string>): string {
  return currentStage(list, focus, busy).stageId;
}

/**
 * 任务的维护者会话里一条消息、一条时间线记录的归属（25 号票：时间线的全局层按阶段聚色块）。"当前阶段"只在这里算：
 * 说的是哪个阶段就写哪个；不写就是维护者的当前阶段（guardStageId，按任务里记的 focus：它最后一次开始的那个，20 号票）；
 * 还没开始执行的只有任务。执行控制器的系统说明、维护者的回复、用户发给维护者的消息都用它；工具调用记录取守卫判定那一刻的。
 * 这里不知道哪些阶段有子 agent 在做（只在 focus 已经验收、放下了时才用得上），子 agent 的消息自己写明阶段
 */
export function taskMessageScope(task: Task, stageId?: string): MessageScope {
  const list = task.stages?.list ?? [];
  const stage = stageId ?? (list.length > 0 ? guardStageId(list, task.stages?.focus) : undefined);
  return { taskId: task.id, ...(stage === undefined ? {} : { stageId: stage }) };
}
