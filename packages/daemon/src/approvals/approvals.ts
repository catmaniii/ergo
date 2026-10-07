// 审批（规格第 9 节"审批流程"）：守卫判定为"先问我"时，守护进程先写审批表、再建审批卡并通知前端。
// - 请求：审批表的一条（approval_requested）、审批卡、待我处理事项、（对话里）聊天里的卡片引用，同一事务追加，
//   审批表在最前：前端收到审批卡时，审批表里一定已有这条记录；
// - 决定：用户在审批卡上批准这一次或拒绝（卡片动作，只接受来自前端的请求），和卡片更新同一事务追加 approval_decided。
//   决定时子进程里那次调用还在等（守卫接入用 markWaiting 登记）就接着执行或拦下；不在等（已挂起，或 agent 已不等了）的，
//   批准记成一条按调用指纹匹配的一次性授权（findOneTimeGrant / consume）；
// - 挂起：等的那次调用超时，记 approval_suspended（带任务和阶段），审批仍待处理。
// 这里不碰子进程：等待、超时、回判定都在守卫接入（guard-runtime/guard-runtime.ts）。
import { randomUUID } from "node:crypto";
import { ApprovalCardPayload, type ConversationId, type Urgency } from "@ergou/protocol";
import type { CardService } from "../cards/cards.ts";
import { defineCardType } from "../cards/registry.ts";
import { buildMessage } from "../conversation/messages.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import {
  type ApprovalConsumedPayload,
  type ApprovalDecidedPayload,
  type ApprovalRecord,
  type ApprovalRequestedPayload,
  type ApprovalSuspendedPayload,
  GUARD_CHANNEL,
  GUARD_EVENTS,
} from "../guard-runtime/events.ts";
import type { InboxService } from "../inbox/inbox.ts";
import { type Approval, type ApprovalStatus, findOneTimeGrant, getApproval, listApprovals } from "./views.ts";

export interface NewApproval {
  agentId: string;
  /** 对话里调用所在的会话：审批卡在聊天里出现在这里 */
  conversation: ConversationId | null;
  taskId: string | null;
  stageId: string | null;
  segmentId?: string;
  toolCallId: string;
  tool: string;
  args: unknown;
  toolTitle: string;
  argsSummary: string;
  fingerprint: string;
  /** 命中的关注类别：id 记进审批表，名字显示在卡上 */
  categories: { id: string; title: string }[];
  reason: string;
  /** 卡上的来源："秘书对话"，任务里写任务和阶段 */
  source: string;
}

export interface ApprovalService {
  /** 写审批表、建审批卡、放进待我处理（对话里还在聊天里出现这张卡），同一事务；再提示用户 */
  request(input: NewApproval): Approval;
  get(approvalId: string): Approval | undefined;
  list(status?: ApprovalStatus): Approval[];
  /** 还没用掉的一次性授权（事后批准的、同一个 agent、同样的调用指纹） */
  oneTimeGrant(agentId: string, fingerprint: string): Approval | undefined;
  /** 用掉一次性授权 */
  consume(approvalId: string, toolCallId: string): void;
  /** 等的那次调用超时：记挂起（审批仍待处理） */
  suspend(approvalId: string): void;
  /** 子进程里有调用在等这条审批（守卫接入登记、撤销）；用户决定时据此记 resumed */
  markWaiting(approvalId: string): void;
  unmarkWaiting(approvalId: string): void;
  isWaiting(approvalId: string): boolean;
}

export interface ApprovalServiceOptions {
  store: EventStore;
  cards: CardService;
  inbox: InboxService;
  now: () => string;
}

const TITLE_MAX = 60;

export function createApprovalService(options: ApprovalServiceOptions): ApprovalService {
  const { store, cards, inbox, now } = options;
  const waiting = new Set<string>();

  return {
    request(input) {
      const approvalId = `a-${randomUUID()}`;
      const payload: ApprovalCardPayload = {
        approvalId,
        source: input.source,
        ...(input.taskId === null ? {} : { taskId: input.taskId }),
        ...(input.stageId === null ? {} : { stageId: input.stageId }),
        tool: input.tool,
        toolTitle: input.toolTitle,
        argsSummary: input.argsSummary,
        categories: input.categories.map((c) => c.title),
        reason: input.reason,
      };
      // 对话里的审批不卡任务；任务里的按卡住任务算（13 号票接任务一侧）
      const urgency: Urgency = input.taskId === null ? "non_blocking" : "blocking";
      const card = cards.buildCreate({ type: "approval", payload, urgency });
      const record: ApprovalRecord = {
        approvalId,
        cardId: card.card.id,
        agentId: input.agentId,
        conversation: input.conversation,
        taskId: input.taskId,
        stageId: input.stageId,
        ...(input.segmentId === undefined ? {} : { segmentId: input.segmentId }),
        toolCallId: input.toolCallId,
        tool: input.tool,
        args: input.args,
        toolTitle: input.toolTitle,
        argsSummary: input.argsSummary,
        fingerprint: input.fingerprint,
        categories: input.categories.map((c) => c.id),
        reason: input.reason,
        requestedAt: now(),
      };
      const requested: ApprovalRequestedPayload = { approval: record };
      const item = inbox.buildAdd({ kind: "card", cardId: card.card.id, title: clip(`审批：${input.toolTitle} ${input.argsSummary}`, TITLE_MAX), source: input.source, urgency });
      const events: NewEvent[] = [{ channel: GUARD_CHANNEL, type: GUARD_EVENTS.approvalRequested, payload: requested }, card.event, item.event];
      if (input.conversation !== null) {
        events.push(buildMessage({ conversation: input.conversation, speaker: "agent", parts: [{ type: "card_ref", cardId: card.card.id }] }).event);
      }
      store.appendBatch(events);
      inbox.alert(item.item);
      return getApproval(store.reader, approvalId)!;
    },
    get: (approvalId) => getApproval(store.reader, approvalId),
    list: (status) => listApprovals(store.reader, status),
    oneTimeGrant: (agentId, fingerprint) => findOneTimeGrant(store.reader, agentId, fingerprint),
    consume(approvalId, toolCallId) {
      const payload: ApprovalConsumedPayload = { approvalId, toolCallId, time: now() };
      store.append({ channel: GUARD_CHANNEL, type: GUARD_EVENTS.approvalConsumed, payload });
    },
    suspend(approvalId) {
      const approval = getApproval(store.reader, approvalId);
      if (!approval) return;
      const payload: ApprovalSuspendedPayload = {
        approvalId,
        agentId: approval.agentId,
        conversation: approval.conversation,
        taskId: approval.taskId,
        stageId: approval.stageId,
        toolCallId: approval.toolCallId,
        time: now(),
      };
      store.append({ channel: GUARD_CHANNEL, type: GUARD_EVENTS.approvalSuspended, payload });
    },
    markWaiting: (approvalId) => void waiting.add(approvalId),
    unmarkWaiting: (approvalId) => void waiting.delete(approvalId),
    isWaiting: (approvalId) => waiting.has(approvalId),
  };
}

/** 审批卡（卡片类型注册表里的 approval）：批准这一次、拒绝（可附说明） */
export function approvalCardType(approvals: ApprovalService) {
  const decided = (p: ApprovalCardPayload, decision: "approved" | "denied", time: string, note: string | undefined): NewEvent => {
    const approval = approvals.get(p.approvalId);
    const payload: ApprovalDecidedPayload = {
      approvalId: p.approvalId,
      decision,
      ...(note === undefined || note.trim() === "" ? {} : { note }),
      resumed: approvals.isWaiting(p.approvalId),
      by: "user",
      time,
      agentId: approval?.agentId ?? "",
      conversation: approval?.conversation ?? null,
      taskId: approval?.taskId ?? null,
      stageId: approval?.stageId ?? null,
      tool: p.tool,
      argsSummary: p.argsSummary,
      categories: approval?.categories ?? [],
    };
    return { channel: GUARD_CHANNEL, type: GUARD_EVENTS.approvalDecided, payload };
  };
  return defineCardType({
    type: "approval",
    version: 1,
    payload: ApprovalCardPayload,
    actions: {
      approve: { input: undefined, run: ({ payload, now: time, note }) => ({ status: "handled", events: [decided(payload, "approved", time, note)] }) },
      deny: { input: undefined, run: ({ payload, now: time, note }) => ({ status: "handled", events: [decided(payload, "denied", time, note)] }) },
    },
    toText: (p) => `审批（${p.source}）：${p.toolTitle}「${p.argsSummary}」${p.categories.length > 0 ? ` · ${p.categories.join("、")}` : ""}`,
  });
}

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}
