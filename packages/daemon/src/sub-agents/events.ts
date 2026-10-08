// 子 agent 并行的事件（20 号票）：都在守护进程内部的 sub_agents 频道上，前端不订阅。
// 前端看到的是它们的另一面：并行确认卡、维护者会话里子 agent 的工具调用记录和交回的结果、活动状态。
// - parallel_proposed：维护者提议了一次并行（子 agent 的 id 在这时定下）；
// - parallel_decided：用户在并行确认卡上同意并行或不同意（和卡片更新同一事务），"审批决定"素材的来源；
// - sub_agent_started / sub_agent_finished：一个子 agent 拉起（名额满了时在排队）、结束（交回了结果、出错、被打断、任务停了）。
// 派生视图（views.ts）由它们归并：哪个子 agent 属于哪个任务的哪个阶段、现在还在不在做（24 号票按它把用量归到任务）。
import { EVENT_TYPES, type ParallelAgent, type ParallelDecision } from "@ergou/protocol";

export const SUB_AGENTS_CHANNEL = "sub_agents";

export const SUB_AGENT_EVENTS = {
  parallelProposed: "parallel_proposed",
  parallelDecided: EVENT_TYPES.parallelDecided,
  subAgentStarted: "sub_agent_started",
  subAgentFinished: "sub_agent_finished",
} as const;

/** 一个子 agent 属于谁：哪个任务的哪个阶段、哪个维护者的哪次提议（24 号票按它把子 agent 的用量归到任务和阶段） */
export interface SubAgentOwner {
  taskId: string;
  stageId: string;
  maintainerId: string;
  proposalId: string;
}

export interface ParallelProposedPayload {
  proposalId: string;
  taskId: string;
  maintainerId: string;
  cardId: string;
  reason: string;
  agents: ParallelAgent[];
  time: string;
}

export interface ParallelDecidedPayload {
  proposalId: string;
  taskId: string;
  taskTitle: string;
  cardId: string;
  /** 用户的决定（就是卡上的两个动作，协议包的 PARALLEL_DECISIONS） */
  decision: ParallelDecision;
  /** 提议里的子 agent（素材里写"派了谁、各做什么"） */
  agents: Array<Pick<ParallelAgent, "agentId" | "stageId" | "stageTitle" | "step" | "instructions">>;
  /** 用户写的话（不同意时的原因、同意时的补充） */
  note?: string;
  by: "user";
  time: string;
}

export interface SubAgentStartedPayload extends SubAgentOwner {
  agentId: string;
  workDir: string;
  time: string;
}

/**
 * 子 agent 怎么结束的：交回了结果（done）、这一轮出错（error）、守护进程重启或子进程意外退出（interrupted）、
 * 任务暂停、取消、结束了（stopped）
 */
export type SubAgentOutcome = "done" | "error" | "interrupted" | "stopped";

export interface SubAgentFinishedPayload extends SubAgentOwner {
  agentId: string;
  outcome: SubAgentOutcome;
  /** 交回维护者的那条消息 */
  messageId: string;
  time: string;
}
