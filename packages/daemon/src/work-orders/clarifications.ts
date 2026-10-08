// 工单的等澄清（规格第 12、21 节，16 号票）：一次往返都在这里——
// - 维护者做工单时遇到要问派单方的（ask_clarification）：提问卡（记着是谁为哪张工单问的）进待我处理，工单转等澄清，
//   执行中的这一支停下（都在等时任务转等我，原因"澄清"）。用户发起的单项目任务就问用户；
// - 用户回答：提问卡（tasks/cards.ts）把回答交给这里（replyEvents），作为一条通知交回提问的维护者（不交给秘书），
//   和卡片的处理同一事务；之后工单回到进行中，这一支接着走（名额满了回到排队中）；
// - 用户关掉提问卡：算"按你自己的理解接着做"，工单同样回到进行中，通知维护者，时间线上记一笔。
// 等澄清的工单仍占着维护者（一段会话只属于一张工单）。卡片处理了、工单还在等澄清（守护进程在两步之间被杀）的，启动时补上。
import {
  type CardDismissedEventPayload,
  CHANNELS,
  EVENT_TYPES,
  maintainerChannel,
  type QuestionDraft,
  type QuestionsAnsweredPayload,
  type QuestionsCardPayload,
  type WorkOrder,
} from "@ergou/protocol";
import type { CardService } from "../cards/cards.ts";
import { buildAgentNotice, buildTimelineRecord } from "../conversation/messages.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import type { InboxService } from "../inbox/inbox.ts";
import type { ProjectService } from "../projects/projects.ts";
import type { TaskExecution } from "../tasks/execution.ts";
import { oneLine } from "../util/text.ts";
import { workOrderEvent } from "./events.ts";
import type { Segments } from "./segments.ts";
import { ASK_ONLY_IN_WORK_ORDER, answeredText, DISMISSED_TEXT, ownJudgementRecord } from "./texts.ts";
import { getWorkOrder, workOrdersOf } from "./views.ts";

export interface ClarificationsOptions {
  store: EventStore;
  cards: CardService;
  inbox: InboxService;
  projects: ProjectService;
  segments: Segments;
  /** 执行中的项目维护者在等回答：它所在的这一支停下；回答来了接着走 */
  execution: Pick<TaskExecution, "awaitAnswer" | "answered">;
  now: () => string;
}

export interface Clarifications {
  /** 接上卡片事件；启动时补上卡片处理了、工单还在等澄清的 */
  start(): void;
  stop(): void;
  /** 维护者向派单方提问（ask_clarification）：工单转等澄清，提问卡进待我处理 */
  ask(maintainerId: string, input: { intro?: string; questions: QuestionDraft[] }): { cardId: string; workOrderId: string };
  /** 提问卡上用户回答了项目维护者为工单问的：交回它的通知（和卡片的处理同一事务追加） */
  replyEvents(payload: QuestionsCardPayload, answer: { lines: readonly string[]; allRecommended: boolean }, key: string): NewEvent[];
}

export function createClarifications(options: ClarificationsOptions): Clarifications {
  const { store, cards, inbox, projects, segments, now } = options;
  let unsubscribe: (() => void) | undefined;

  /** 在等这张提问卡的回答的工单 */
  const clarifyingOn = (cardId: string): WorkOrder | undefined => {
    const askedBy = (cards.get(cardId)?.payload as QuestionsCardPayload | undefined)?.askedBy;
    if (!askedBy) return undefined;
    const wo = getWorkOrder(store.reader, askedBy.workOrderId);
    return wo?.state === "clarifying" && wo.questionsCardId === cardId ? wo : undefined;
  };

  /** 等澄清的工单有了回答（或者用户关掉了提问卡）：回到进行中，执行中的这一支接着走 */
  const answered = (cardId: string, dismissed: boolean) => {
    const wo = clarifyingOn(cardId);
    if (!wo) return;
    const { questionsCardId: _card, ...rest } = wo;
    const events: NewEvent[] = [workOrderEvent({ ...rest, state: "in_progress", updatedAt: now() }, "answered", wo.state, "user")];
    if (dismissed) {
      // 关掉提问卡算"按你自己的理解接着做"：告诉维护者，时间线上记一笔
      const scope = segments.scopeIn(wo);
      events.push(
        buildAgentNotice(maintainerChannel(wo.maintainerId), DISMISSED_TEXT, `questions-dismissed:${cardId}`, scope).event,
        buildTimelineRecord(maintainerChannel(wo.maintainerId), { kind: "own_judgement", ...ownJudgementRecord(wo), workOrderId: wo.id }, scope).event,
      );
    }
    store.appendBatch(events);
    if (wo.kind === "execute") options.execution.answered(cardId);
  };

  return {
    start() {
      unsubscribe = store.onAppend((event) => {
        if (event.channel !== CHANNELS.cards) return;
        if (event.type === EVENT_TYPES.questionsAnswered) answered((event.payload as QuestionsAnsweredPayload).cardId, false);
        else if (event.type === EVENT_TYPES.cardDismissed) answered((event.payload as CardDismissedEventPayload).cardId, true);
      });
      // 卡片处理了、工单还在等澄清（守护进程在两步之间被杀）：补上
      for (const project of projects.list()) {
        for (const wo of workOrdersOf(store.reader, project.maintainerId, ["clarifying"])) {
          const status = wo.questionsCardId === undefined ? undefined : cards.get(wo.questionsCardId)?.status;
          if (wo.questionsCardId !== undefined && status !== undefined && status !== "pending") answered(wo.questionsCardId, status === "dismissed");
        }
      }
    },
    stop() {
      unsubscribe?.();
    },
    ask(maintainerId, input) {
      const segment = segments.current(maintainerId);
      const wo = segments.currentWorkOrder(maintainerId);
      if (!segment || !wo || segment.state !== "open") throw new RequestRejected("not_allowed", ASK_ONLY_IN_WORK_ORDER);
      if (wo.state !== "in_progress") throw new RequestRejected("not_allowed", `工单 ${wo.id} 现在${wo.state === "clarifying" ? "已经在等回答了" : "不在进行中"}`);
      const project = projects.maintainedBy(maintainerId);
      if (!project) throw new RequestRejected("not_found", "找不到这个维护者的项目");
      const questions = input.questions.map((q, i) => ({ id: `q${i + 1}`, ...q }));
      const payload: QuestionsCardPayload = {
        taskId: wo.taskId,
        askedBy: { maintainerId, projectId: project.id, workOrderId: wo.id },
        ...(input.intro ? { intro: input.intro } : {}),
        questions,
      };
      const card = cards.buildCreate({ type: "questions", urgency: "blocking", payload });
      const item = inbox.buildAdd({ kind: "card", cardId: card.card.id, title: oneLine(`维护者在问：${wo.taskTitle}`, 60), source: `项目「${project.name}」`, urgency: "blocking" });
      store.appendBatch([card.event, item.event, workOrderEvent({ ...wo, state: "clarifying", questionsCardId: card.card.id, updatedAt: now() }, "clarifying", wo.state, "maintainer")]);
      inbox.alert(item.item);
      if (wo.kind === "execute") options.execution.awaitAnswer(wo.taskId, card.card.id);
      return { cardId: card.card.id, workOrderId: wo.id };
    },
    replyEvents(payload, answer, key) {
      const askedBy = payload.askedBy;
      if (!askedBy) return [];
      const text = answeredText(askedBy.workOrderId, payload.taskId, answer.lines, answer.allRecommended);
      return [buildAgentNotice(maintainerChannel(askedBy.maintainerId), text, `${key}#notice`, segments.scopeIn({ projectId: askedBy.projectId, taskId: payload.taskId })).event];
    },
  };
}
