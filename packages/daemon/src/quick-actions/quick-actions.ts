// 快速动作（规格第 9 节"快速动作的确认"、第 14 节）：秘书写清做什么、对谁做，运行时决定直接执行还是先问用户。
// - 动作类型必须是执行器注册表里登记过的（registry.ts）；没登记的不出卡，工具向秘书返回错误；参数先按执行器自带的 schema 校验；
// - "明确点了"由运行时判定：执行器自己声明（explicit.ts 的辅助函数），看用户这一轮的原话。
//   点明了的：卡片出来就是"已执行"，只展示规范化后的动作（底线照样管：交给我做、永不的不执行）；
// - 推断出来的：把动作作为伪工具调用交给守卫的类别匹配（judge.ts：内置类别、用户的自定义类别、底线，取最严），
//   推断出来一律先问的、总要核对的再往严里提。会直接执行的（直接做只记录、做完告诉我）照样直接执行；先问我的出一张待确认的卡，
//   同时进待我处理，用户点"执行"才执行；交给我做、永不的不出卡，告诉秘书原因；
// - 执行由执行器直接完成，不拉起 agent、不上任务看板、不占并发名额。每次执行是动作所在会话频道上的一条
//   quick_action_executed 事件，也就是"操作记录"（动作类型、规范化后的动作、凭什么执行的、结果、对应的卡片），和卡片更新同一事务。
//   凭什么执行的（25 号票，时间线按它取样式）：用户点明的、推断出来但在已有授权内直接执行的、用户在卡上确认后。
//   卡片按钮的幂等、先到先得、"已被处理"沿用 06 号票的按钮闭环；操作记录的幂等键是动作 id，同一个动作只会有一条。
// - 彻底删除（21 号票）时快速动作卡和操作记录只把带原话的字段（标题里的内容、对象、内容、参数、结果）换成删除标记。
import { randomUUID } from "node:crypto";
import {
  type Card,
  CHANNELS,
  type Disposition as FrontendDisposition,
  EVENT_TYPES,
  PURGED_TEXT,
  type QuickActionCardPayload,
  QuickActionCardPayload as QuickActionCardPayloadSchema,
  type QuickActionExecutedEventPayload,
} from "@ergou/protocol";
import type { HostToolOutput } from "../agent-manager/host-tools.ts";
import { type CardService, newCardId } from "../cards/cards.ts";
import { type CardActionEffect, defineCardType } from "../cards/registry.ts";
import { getMessage } from "../conversation/views.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import type { PurgeRewriter } from "../events/purge.ts";
import { type Disposition, DISPOSITION_INFO, executes, strictest } from "../guard/index.ts";
import type { InboxService } from "../inbox/inbox.ts";
import { type ExplicitFinding, type UserTurn, userTurnOf } from "./explicit.ts";
import { judgeQuickAction, type QuickActionGuard } from "./judge.ts";
import type { NormalizedQuickAction, QuickActionContext, QuickActionExecutor, QuickActionOutcome, QuickActionRegistry } from "./registry.ts";

export interface QuickActionServiceOptions {
  store: EventStore;
  cards: CardService;
  inbox: InboxService;
  registry: QuickActionRegistry;
  /** 判定处置要用的：守卫的各区、秘书的草稿区、每次现读的关注类别设置（用户在设置里改了马上生效）、现在 */
  guard: QuickActionGuard;
  log: (line: string) => void;
}

/** 秘书提议的一个动作 */
export interface QuickActionRequest {
  type: string;
  /** 秘书给的参数（按执行器自带的 schema 校验） */
  params: unknown;
  /** 在哪个会话里提的 */
  conversation: string;
  /** 秘书正在处理的那条用户消息 */
  inputMessageId?: string;
  /** 提出这个动作的那次工具调用 */
  toolCallId?: string;
  /** 秘书自称用户点明了（只记日志，不作数） */
  claimedExplicit?: boolean;
}

export interface QuickActionService {
  readonly registry: QuickActionRegistry;
  /** 秘书提议一个动作（"提议快速动作"工具）：直接执行、出卡等确认，或者告诉秘书为什么不行 */
  propose(request: QuickActionRequest): HostToolOutput;
  /**
   * 执行一个动作（用户在卡片上确认了）：执行器的事件加上操作记录。给卡片动作用：
   * 结果放进 CardActionEffect 的 events 和 purge，和卡片更新同一事务
   */
  execute(executor: QuickActionExecutor, params: unknown, context: QuickActionContext, title: string): QuickActionOutcome;
}

/** 守卫的处置 → 前端协议里的处置（名字不一样，档次一一对应） */
const FRONTEND_DISPOSITION: Readonly<Record<Disposition, FrontendDisposition>> = {
  log_only: "do",
  notify_after: "do_then_tell",
  plan_listed: "planned_only",
  ask_first: "ask_first",
  hand_over: "hand_to_me",
  never: "never",
};

/** 操作记录的幂等键：同一个动作只有一条（彻底删除时据此找到操作记录） */
export const operationRecordKey = (actionId: string) => `quick-action:${actionId}`;

/** 卡片上记着的动作 → 执行时的情境（快速动作卡、记忆删除卡共用）。从卡上执行的都是用户确认过的推断动作 */
export function actionContext(card: Card, payload: { actionId: string; conversation: string; inputMessageId?: string | undefined }): QuickActionContext {
  return {
    actionId: payload.actionId,
    cardId: card.id,
    conversation: payload.conversation,
    ...(payload.inputMessageId === undefined ? {} : { inputMessageId: payload.inputMessageId }),
    basis: "confirmed",
  };
}

/** 执行一个动作：执行器的事件，加上动作所在会话频道上的操作记录（幂等键是动作 id，同一个动作只有一条） */
function execute(executor: QuickActionExecutor, params: unknown, context: QuickActionContext, title: string): QuickActionOutcome {
  const outcome = executor.execute(params, context);
  const record: QuickActionExecutedEventPayload = {
    actionId: context.actionId,
    action: { type: executor.type, params },
    name: executor.title,
    title,
    explicit: context.explicit !== undefined,
    basis: context.basis,
    cardId: context.cardId,
    result: { ok: true, summary: outcome.summary },
  };
  const recordEvent: NewEvent = { channel: context.conversation, type: EVENT_TYPES.quickActionExecuted, payload: record, idempotencyKey: operationRecordKey(context.actionId) };
  return { ...outcome, events: [...outcome.events, recordEvent] };
}

export function createQuickActionService(options: QuickActionServiceOptions): QuickActionService {
  const { store, cards, inbox, registry, log } = options;

  /** 秘书正在处理的那条用户消息：用户这一轮说了什么 */
  const turnOf = (inputMessageId: string | undefined): UserTurn => {
    const message = inputMessageId === undefined ? undefined : getMessage(store.reader, inputMessageId);
    if (!message || message.speaker !== "user") return { typed: [], quotes: [], cards: [] };
    return userTurnOf(message.parts, (cardId) => cards.get(cardId));
  };

  const propose = (request: QuickActionRequest): HostToolOutput => {
    const executor = registry.get(request.type);
    if (!executor) {
      const known = registry.list().map((e) => `${e.type}（${e.title}）`).join("、");
      return { text: `没有登记这种快速动作：${request.type}。能用的有：${known}`, isError: true };
    }
    let action: NormalizedQuickAction;
    try {
      action = executor.normalizeChecked(request.params);
    } catch (err) {
      // 执行器明说不让做的（比如任务现在的状态不能暂停）原样回给秘书；别的是参数不对
      if (err instanceof RequestRejected) return { text: `不能这样做：${err.message}`, isError: true };
      return { text: `参数不对：${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
    const explicit: ExplicitFinding | undefined = executor.confirm === "always" ? undefined : executor.explicit?.(action, turnOf(request.inputMessageId));
    if (request.claimedExplicit === true && !explicit) log(`秘书说用户点明了「${action.title}」，但运行时核对用户的原话不算点明：按推断处理`);
    const judged = judgeQuickAction(options.guard, executor, action, explicit !== undefined);
    if (judged.refused !== undefined) return { text: `「${action.title}」不能作为快速动作执行：${judged.refused}`, isError: true };
    let { disposition } = judged;
    if (!explicit && (executor.confirm === "ask_when_inferred" || executor.confirm === "always")) disposition = strictest(disposition, "ask_first");
    if (disposition === "never" || disposition === "hand_over") {
      return { text: `「${action.title}」不能作为快速动作执行：${DISPOSITION_INFO[disposition].label}。${DISPOSITION_INFO[disposition].explain?.nextStep ?? ""}`, isError: true };
    }

    const actionId = `qa-${randomUUID()}`;
    const cardId = newCardId();
    const context: QuickActionContext = {
      actionId,
      cardId,
      conversation: request.conversation,
      ...(request.inputMessageId === undefined ? {} : { inputMessageId: request.inputMessageId }),
      ...(explicit === undefined ? {} : { explicit }),
      // 直接执行的：点明的，或者推断出来、处置会直接执行（在已有授权内）；要先问的出卡，确认时另取情境
      basis: explicit === undefined ? "within_grant" : "explicit",
    };
    const payload: QuickActionCardPayload = {
      actionId,
      conversation: request.conversation,
      ...(request.inputMessageId === undefined ? {} : { inputMessageId: request.inputMessageId }),
      action: { type: executor.type, params: action.params },
      name: executor.title,
      title: action.title,
      ...(action.target === undefined ? {} : { target: action.target }),
      ...(action.content === undefined ? {} : { content: action.content }),
      explicit: explicit !== undefined,
      categories: judged.categories,
      disposition: FRONTEND_DISPOSITION[disposition],
      ...(request.toolCallId === undefined ? {} : { toolCallId: request.toolCallId }),
    };

    if (executes(disposition) && executor.confirm !== "always") {
      // 直接执行：卡片出来就是"已执行"，和执行器的事件、操作记录同一事务
      let outcome: QuickActionOutcome;
      try {
        outcome = execute(executor, action.params, context, action.title);
      } catch (err) {
        if (!(err instanceof RequestRejected)) throw err;
        return { text: `「${action.title}」没执行：${err.message}`, isError: true };
      }
      const { event } = cards.buildCreate({ id: cardId, type: "quick_action", payload: { ...payload, result: outcome.summary }, status: "handled", outcome: { action: "execute" } });
      store.appendBatch([event, ...outcome.events], outcome.purge === undefined ? undefined : { purge: outcome.purge });
      outcome.afterCommit?.();
      return { text: `已执行：${action.title}。${outcome.summary}`, cardIds: [cardId] };
    }

    // 先问：出卡（记忆删除出记忆删除卡），同时进待我处理
    const proposal = executor.proposalCard?.(action, { actionId, conversation: request.conversation, ...(request.inputMessageId === undefined ? {} : { inputMessageId: request.inputMessageId }) });
    const created = cards.buildCreate({ id: cardId, type: proposal?.type ?? "quick_action", payload: proposal?.payload ?? payload });
    // 待我处理的标题只写动作的名字：内容在卡片里（彻底删除时只要改卡片）
    const item = inbox.buildAdd({ kind: "card", cardId, title: proposal?.inboxTitle ?? `确认快速动作：${executor.title}`, source: sourceLabel(request.conversation), urgency: "non_blocking" });
    store.appendBatch([created.event, item.event]);
    const why = explicit ? "" : judged.categories.length > 0 ? `（推断出来的动作，命中「${judged.categories.join("」「")}」，对话里先问用户）` : "（推断出来的动作，先问用户）";
    return { text: `等用户确认：${action.title}${why}。卡片已经放进聊天和待我处理，用户确认后由运行时执行。`, cardIds: [cardId] };
  };

  return { registry, propose, execute };
}

/** 待我处理里事项的来源 */
function sourceLabel(conversation: string): string {
  return conversation === CHANNELS.secretary ? "秘书对话" : `会话 ${conversation}`;
}

/** 彻底删除后的标题：动作的名字加删除标记 */
const purgedTitle = (name: string) => `${name}：${PURGED_TEXT}`;

/**
 * 快速动作卡：推断出来、要先问的动作在卡上确认（执行）或取消；用户点明了的出来就是"已执行"。
 * 执行时按卡上存的规范化动作找执行器，结果和操作记录随卡片更新同一事务追加。
 */
export function quickActionCardType(service: QuickActionService) {
  return defineCardType({
    type: "quick_action",
    version: 1,
    payload: QuickActionCardPayloadSchema,
    actions: {
      execute: {
        input: undefined,
        run: ({ card, payload }): CardActionEffect<QuickActionCardPayload> => {
          const executor = service.registry.get(payload.action.type);
          if (!executor) throw new RequestRejected("not_allowed", `这种快速动作（${payload.action.type}）这个版本不认识了，没法执行`);
          const outcome = service.execute(executor, payload.action.params, actionContext(card, payload), payload.title);
          return {
            status: "handled",
            payload: { ...payload, result: outcome.summary },
            events: outcome.events,
            ...(outcome.purge === undefined ? {} : { purge: outcome.purge }),
            ...(outcome.afterCommit === undefined ? {} : { afterCommit: outcome.afterCommit }),
          };
        },
      },
      cancel: { input: undefined, run: () => ({ status: "dismissed" }) },
    },
    toText: (p) => `快速动作：${p.title}${p.result === undefined ? "" : ` · 已执行：${p.result}`}`,
    // 彻底删除：只留动作的名字和状态，对象、内容、参数、结果都换掉
    purge: ({ target: _target, content: _content, ...p }) => ({
      ...p,
      title: purgedTitle(p.name),
      action: { type: p.action.type, params: null },
      ...(p.result === undefined ? {} : { result: PURGED_TEXT }),
    }),
  });
}

/** 彻底删除时操作记录的改写：动作类型、卡片、点没点明不变，标题里的内容、参数、结果换成删除标记 */
export const operationRecordPurge: PurgeRewriter = {
  eventType: EVENT_TYPES.quickActionExecuted,
  rewrite(event) {
    const p = event.payload as QuickActionExecutedEventPayload;
    return { ...p, title: purgedTitle(p.name), action: { type: p.action.type, params: null }, result: { ...p.result, summary: PURGED_TEXT } } satisfies QuickActionExecutedEventPayload;
  },
};
