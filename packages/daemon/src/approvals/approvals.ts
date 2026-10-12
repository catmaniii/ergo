// 审批（规格第 9 节"审批流程"）：守卫判定为"先问我"时，守护进程先写审批表、再建审批卡并通知前端。
// - 请求：审批表的一条（approval_requested）、审批卡、待我处理事项、（对话里）聊天里的卡片引用，同一事务追加，
//   审批表在最前：前端收到审批卡时，审批表里一定已有这条记录；
// - 决定：用户在审批卡上批准这一次或拒绝（卡片动作，只接受来自前端的请求），和卡片更新同一事务追加 approval_decided。
//   决定时子进程里那次调用还在等（守卫接入用 markWaiting 登记）就接着执行或拦下；不在等（已挂起，或 agent 已不等了）的，
//   批准记成一条按调用指纹匹配的一次性授权（findOneTimeGrant / consume）：只放行命中的关注类别都在当初批准过的类别里的重试；
// - 挂起：等的那次调用超时，记 approval_suspended（带任务和阶段），审批仍待处理。
// 这里不碰子进程：等待、超时、回判定都在守卫接入（guard-runtime/guard-runtime.ts）。
import { randomUUID } from "node:crypto";
import { ApprovalCardPayload, internalMark, PURGED_TEXT, type Urgency } from "@ergou/protocol";
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
  type CallOrigin,
  GUARD_CHANNEL,
  callInboxOrigin,
  GUARD_EVENTS,
  originScope,
} from "../guard-runtime/events.ts";
import type { InboxService } from "../inbox/inbox.ts";
import { oneLine } from "../util/text.ts";
import { type Approval, type ApprovalStatus, findOneTimeGrant, getApproval, listApprovals } from "./views.ts";

export interface NewApproval {
  /** 调用从哪儿来：对话里审批卡出现在它的会话里，卡上的来源是它的 source */
  origin: CallOrigin;
  toolCallId: string;
  tool: string;
  args: unknown;
  toolTitle: string;
  argsSummary: string;
  fingerprint: string;
  /** 命中的关注类别：id 记进审批表，名字显示在卡上 */
  categories: { id: string; title: string }[];
  reason: string;
}

export interface ApprovalService {
  /** 写审批表、建审批卡、放进待我处理（对话里还在聊天里出现这张卡），同一事务；再提示用户 */
  request(input: NewApproval): Approval;
  get(approvalId: string): Approval | undefined;
  list(status?: ApprovalStatus): Approval[];
  /**
   * 还没用掉的一次性授权：事后批准的、同一个 agent、同样的调用指纹，并且这次判定命中的关注类别（id）都在当初批准过的类别里；
   * 多命中了别的类别就不算，重新走审批
   */
  oneTimeGrant(agentId: string, fingerprint: string, categories: readonly string[]): Approval | undefined;
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
      const { origin } = input;
      const payload: ApprovalCardPayload = {
        approvalId,
        source: origin.source,
        ...(origin.taskId === null ? {} : { taskId: origin.taskId }),
        ...(origin.stageId === null ? {} : { stageId: origin.stageId }),
        tool: input.tool,
        toolTitle: input.toolTitle,
        argsSummary: input.argsSummary,
        categoryTitles: input.categories.map((c) => c.title),
        reason: input.reason,
      };
      // 对话里的审批不卡任务；任务里的按卡住任务算（13 号票接任务一侧）
      const urgency: Urgency = origin.taskId === null ? "non_blocking" : "blocking";
      const card = cards.buildCreate({ type: "approval", payload, urgency });
      const record: ApprovalRecord = {
        approvalId,
        cardId: card.card.id,
        origin,
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
      const item = inbox.buildAdd({ kind: "card", cardId: card.card.id, title: oneLine(`审批：${input.toolTitle} ${input.argsSummary}`, TITLE_MAX), source: origin.source, ...internalMark(origin.internal), ...callInboxOrigin(origin, input.toolCallId), urgency });
      const events: NewEvent[] = [{ channel: GUARD_CHANNEL, type: GUARD_EVENTS.approvalRequested, payload: requested }, card.event, item.event];
      if (origin.conversation !== null) {
        events.push(buildMessage({ conversation: origin.conversation, speaker: "agent", parts: [{ type: "card_ref", cardId: card.card.id }] }, originScope(origin)).event);
      }
      store.appendBatch(events);
      inbox.alert(item.item);
      return getApproval(store.reader, approvalId)!;
    },
    get: (approvalId) => getApproval(store.reader, approvalId),
    list: (status) => listApprovals(store.reader, status),
    oneTimeGrant: (agentId, fingerprint, categories) => findOneTimeGrant(store.reader, agentId, fingerprint, categories),
    consume(approvalId, toolCallId) {
      const payload: ApprovalConsumedPayload = { approvalId, toolCallId, time: now() };
      store.append({ channel: GUARD_CHANNEL, type: GUARD_EVENTS.approvalConsumed, payload });
    },
    suspend(approvalId) {
      const approval = getApproval(store.reader, approvalId);
      if (!approval) return;
      const payload: ApprovalSuspendedPayload = { approvalId, origin: approval.origin, toolCallId: approval.toolCallId, time: now() };
      store.append({ channel: GUARD_CHANNEL, type: GUARD_EVENTS.approvalSuspended, payload });
    },
    markWaiting: (approvalId) => void waiting.add(approvalId),
    unmarkWaiting: (approvalId) => void waiting.delete(approvalId),
    isWaiting: (approvalId) => waiting.has(approvalId),
  };
}

/** 审批卡（卡片类型注册表里的 approval）：批准这一次、拒绝（可附说明） */
export function approvalCardType(approvals: ApprovalService) {
  const decided = (p: ApprovalCardPayload, cardId: string, decision: "approved" | "denied", time: string, note: string | undefined): NewEvent => {
    const approval = approvals.get(p.approvalId);
    // 审批表和审批卡同一事务写入，正常总能找到；找不到时按卡上的写
    const origin: CallOrigin = approval?.origin ?? { agentId: "", conversation: null, taskId: p.taskId ?? null, stageId: p.stageId ?? null, source: p.source };
    const payload: ApprovalDecidedPayload = {
      approvalId: p.approvalId,
      decision,
      ...(note === undefined || note.trim() === "" ? {} : { note }),
      resumed: approvals.isWaiting(p.approvalId),
      by: "user",
      time,
      origin,
      cardId,
      tool: p.tool,
      toolTitle: p.toolTitle,
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
      approve: { input: undefined, run: ({ card, payload, now: time, note }) => ({ status: "handled", events: [decided(payload, card.id, "approved", time, note)] }) },
      deny: { input: undefined, run: ({ card, payload, now: time, note }) => ({ status: "handled", events: [decided(payload, card.id, "denied", time, note)] }) },
    },
    toText: (p) => `审批（${p.source}）：${p.toolTitle}「${p.argsSummary}」${p.categoryTitles.length > 0 ? ` · ${p.categoryTitles.join("、")}` : ""}`,
    // 彻底删除：要做的那次调用的参数摘要和守卫的说明换成删除标记（和审批决定的事件一样）；卡片的状态、来源、工具不变
    purge: (p) => ({ ...p, argsSummary: PURGED_TEXT, reason: PURGED_TEXT }),
  });
}
