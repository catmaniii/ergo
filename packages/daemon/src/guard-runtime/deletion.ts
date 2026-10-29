// 守卫接入运行时在"删除参与方"登记表里的那一份（279 号票；登记表见 deletion/participants.ts）：这次删除的 agent 的审批、效果日志、
// 执行记录和调用另存的完整内容，照彻底删除的改写函数字段级改写（ADR-0008：原话换成删除标记，状态不变）。原来在 projects/deletion.ts
// （ADR-0010：这个项目维护者的）、tasks/deletion.ts（186 号票：任务自己的维护者和子 agent 的）里各写一遍。
// - 审批请求和它的决定；效果日志里全是这几个 agent 的那几条；
// - 有副作用的调用的执行记录（调用摘要、结果摘要，23 号票）；
// - 调用另存的完整参数和返回（53 号票）：删项目时维护者会话里的（含子 agent 的）、维护者自己的、归属这个项目的（评审子 agent 的）；
//   删任务时它自己的维护者会话里的、这几个 agent 的、归属这个任务的评审子 agent 的。连同它们的效果日志（记了调用 id 的按调用 id 和
//   agent，旧的按紧跟在完整内容后面）；
// - 没有完整内容的更早的调用（53 号票之前）：会话里工具调用记录后面紧跟着的旧效果日志。
// 审批卡：删项目时字段级改写、追加新版本（立项书卡、规范改写卡一样，状态不变：审批还是已批准）；删任务时整张换成标记。
import { EVENT_TYPES, maintainerChannel, type MessageEventPayload, type ToolCallDetail } from "@ergo/protocol";
import { type DeletionParticipants, type DeletionPlan, liveEvents, PROJECT_DELETION, TASK_DELETION } from "../deletion/participants.ts";
import type { StoredEvent } from "../events/event-store.ts";
import { effectCallOf, effectEventsOfCall, legacyEffectEventAfter } from "./effect-log.ts";
import { type ApprovalDecidedPayload, type ApprovalRequestedPayload, type EffectRecordedPayload, GUARD_CHANNEL, GUARD_EVENTS } from "./events.ts";
import { executionEventsOfAgent } from "./executions.ts";
import { detailEventsOfProject, detailEventsOfTask } from "./tool-call-details.ts";

interface AgentRecords {
  /** 这次删除的 agent */
  agents: ReadonlySet<string>;
  /** 审批卡怎么处理 */
  approvalCard(cardId: string): void;
  /** 调用另存的完整内容（各删除自己找） */
  details: () => readonly StoredEvent[];
  /** 整个删掉的会话（找更早的调用的旧效果日志）；没有 undefined */
  conversation: string | undefined;
  /** 会话里的消息没写 agent 时算谁的 */
  defaultAgent: string;
}

function claimAgentRecords(plan: DeletionPlan, scope: AgentRecords): void {
  const { store } = plan;
  // 审批（请求、决定）、效果日志
  const approvalIds = new Set<string>();
  for (const event of liveEvents(store.read(GUARD_CHANNEL))) {
    if (event.type === GUARD_EVENTS.approvalRequested) {
      const { approval } = event.payload as ApprovalRequestedPayload;
      if (!scope.agents.has(approval.origin.agentId)) continue;
      plan.rewrite(event);
      approvalIds.add(approval.approvalId);
      scope.approvalCard(approval.cardId);
    } else if (event.type === GUARD_EVENTS.approvalDecided) {
      if (approvalIds.has((event.payload as ApprovalDecidedPayload).approvalId)) plan.rewrite(event);
    } else if (event.type === GUARD_EVENTS.effectRecorded) {
      const { records } = event.payload as EffectRecordedPayload;
      if (records.length > 0 && records.every((r) => scope.agents.has(r.agentId))) plan.rewrite(event);
    }
  }
  // 执行记录
  for (const agentId of scope.agents) for (const event of liveEvents(executionEventsOfAgent(store, agentId))) plan.rewrite(event);
  // 调用另存的完整内容，连同它们的效果日志
  for (const event of liveEvents(scope.details())) {
    plan.rewrite(event);
    for (const effect of liveEvents(effectEventsOfCall(store, effectCallOf(event.payload as ToolCallDetail), [event]))) plan.rewrite(effect);
  }
  // 更早的调用：会话里工具调用记录后面紧跟着的旧效果日志
  if (scope.conversation === undefined) return;
  for (const event of liveEvents(store.read(scope.conversation, 0, EVENT_TYPES.message))) {
    const p = event.payload as MessageEventPayload;
    for (const part of p.message.parts) {
      if (part.type !== "tool_call") continue;
      const effect = legacyEffectEventAfter(store, event, { callId: part.callId, tool: part.tool, agentId: p.agentId ?? scope.defaultAgent, conversation: event.channel });
      if (effect) plan.rewrite(effect);
    }
  }
}

/** 守卫接入运行时登记的参与方：删项目（这个项目的维护者）、删任务（任务自己的维护者和子 agent）各一个 */
export function registerGuardRuntimeDeletion(participants: Pick<DeletionParticipants, "register">): () => void {
  const undo = [
    participants.register(PROJECT_DELETION, {
      owner: "guard-runtime",
      join: ({ project }, plan) => ({
        claim() {
          const conversation = maintainerChannel(project.maintainerId);
          claimAgentRecords(plan, {
            agents: new Set([project.maintainerId]),
            approvalCard: (cardId) => plan.purgeCard(cardId),
            details: () => detailEventsOfProject(plan.store, { maintainerConversation: conversation, maintainerId: project.maintainerId, projectId: project.id }),
            conversation,
            defaultAgent: project.maintainerId,
          });
        },
      }),
    }),
    participants.register(TASK_DELETION, {
      owner: "guard-runtime",
      join: ({ task, conversation, agents }, plan) => ({
        claim() {
          claimAgentRecords(plan, {
            agents,
            approvalCard: (cardId) => plan.dropCard(cardId),
            details: () => detailEventsOfTask(plan.store, { conversation, agentIds: [...agents], taskId: task.id }),
            conversation,
            defaultAgent: task.maintainerId,
          });
        },
      }),
    }),
  ];
  return () => {
    for (const u of undo) u();
  };
}
