// 子 agent 并行（规格第 8、11 节，20 号票）：并行确认卡的负载，守护进程和 Web 共用。
// 维护者执行任务时用"提议并行"工具提议派子 agent 同时做几个阶段（或一个定步阶段里的几步）；运行时据此建这张卡放进待我处理，
// 用户点"同意并行"（parallel）才真正拉起子 agent，点"不并行，按顺序做"（sequential）维护者照常一件一件做。
import { type Static, Type } from "typebox";
import type { CARD_ACTIONS } from "./constants.ts";

/** 并行确认卡上用户的两个决定（就是卡上的两个动作）：同意并行、不并行，按顺序做 */
export const PARALLEL_DECISIONS = ["parallel", "sequential"] as const satisfies ReadonlyArray<(typeof CARD_ACTIONS)[number]>;
export type ParallelDecision = (typeof PARALLEL_DECISIONS)[number];

/** 维护者提议派的一个子 agent：做哪个阶段（哪一步）、做什么、在哪个目录里做 */
export const ParallelAgent = Type.Object({
  /** 子 agent 的 id（sa-<n>），提议时就定下，卡上、会话里、活动状态里都用它 */
  agentId: Type.String(),
  stageId: Type.String(),
  stageTitle: Type.String(),
  /** 定步阶段里的哪一步（只并行几步时写） */
  step: Type.Optional(Type.String()),
  /** 维护者给它的工作说明 */
  instructions: Type.String(),
  /** 它干活的目录（绝对路径）：维护者为它建的目录（开发类是 git worktree），或者维护者自己的工作目录 */
  workDir: Type.String(),
  /** 有没有自己的目录（维护者为它另建的，开发类是 git worktree）；没有就和维护者在同一个工作目录里 */
  ownWorkDir: Type.Boolean(),
});
export type ParallelAgent = Static<typeof ParallelAgent>;

/** 并行确认卡：哪个任务、为什么并行、派几个子 agent、各做什么 */
export const ParallelCardPayload = Type.Object({
  proposalId: Type.String(),
  taskId: Type.String(),
  taskTitle: Type.String(),
  maintainerId: Type.String(),
  /** 维护者写的为什么并行 */
  reason: Type.String(),
  agents: Type.Array(ParallelAgent, { minItems: 1 }),
});
export type ParallelCardPayload = Static<typeof ParallelCardPayload>;
