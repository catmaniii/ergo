// 工单的等澄清（规格第 12、21 节，16 号票）：一次往返都在这里——
// - 维护者做工单时遇到要问派单方的（ask_clarification）：提问卡（记着是谁为哪张工单问的）进待我处理，工单转等澄清，
//   执行中的这一支停下（都在等时任务转等我，原因"澄清"）。用户发起的单项目任务就问用户；
// - 用户回答：提问卡（tasks/cards.ts）把回答交给这里（replyEvents），作为一条通知交回提问的维护者（不交给秘书），
//   和卡片的处理同一事务；之后工单回到进行中，这一支接着走（名额满了回到排队中）；
// - 用户关掉提问卡：算"按你自己的理解接着做"，工单同样回到进行中，通知维护者，时间线上记一笔。
// 等澄清的工单仍占着维护者（一段会话只属于一张工单）。卡片处理了、工单还在等澄清（守护进程在两步之间被杀）的，启动时补上。
// 17 号票：涉及多个项目的任务的维护者派来的工单，派单方是任务维护者——
// - 项目维护者提问：工单转等澄清，问题作为一条消息进任务维护者的会话，不直接出给用户（不出提问卡、不停这一支）；
// - 任务维护者答得了就直接答（answer_work_order）：回答交回项目维护者，工单回到进行中；
// - 答不了就转问用户（forward_to_user，指明工单）：提问卡进待我处理，这一支（工单所属的阶段）停下；用户回答后回答交给任务维护者
//   （工单仍在等澄清），由它经 answer_work_order 交回项目维护者；用户关掉提问卡，任务维护者按自己的理解回答。
// 说法在 multi-project-texts.ts（17 号票的）和 texts.ts（16 号票的）。
import {
  type CardDismissedEventPayload,
  CHANNELS,
  EVENT_TYPES,
  isJobRunWorkOrder,
  maintainerChannel,
  type QuestionDraft,
  taskInboxOrigin,
  type QuestionsAnsweredPayload,
  type QuestionsCardPayload,
  type TaskMaintainerWorkOrder,
  type WorkOrder,
} from "@ergou/protocol";
import type { CardService } from "../cards/cards.ts";
import { buildAgentNotice, buildTimelineRecord } from "../conversation/messages.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import type { InboxService } from "../inbox/inbox.ts";
import type { ProjectService } from "../projects/projects.ts";
import type { MaintainerScope, TaskExecution } from "../tasks/execution.ts";
import { taskMessageScope } from "../tasks/stages.ts";
import type { TaskService } from "../tasks/tasks.ts";
import { oneLine } from "../util/text.ts";
import { workOrderEvent } from "./events.ts";
import {
  answerText,
  FORWARD_WAIT,
  forwardDismissedRecord,
  forwardDismissedText,
  forwardedAnswerText,
  forwardInboxTitle,
  forwardIntro,
  type OrderRef,
  questionLines,
  questionText,
  refusal,
  taskSource,
} from "./multi-project-texts.ts";
import type { Segments } from "./segments.ts";
import { ASK_NOT_IN_JOB_RUN, ASK_ONLY_IN_WORK_ORDER, answeredText, DISMISSED_TEXT, ownJudgementRecord } from "./texts.ts";
import { getWorkOrder, workOrdersOf } from "./views.ts";

export interface ClarificationsOptions {
  store: EventStore;
  cards: CardService;
  inbox: InboxService;
  projects: ProjectService;
  tasks: TaskService;
  segments: Segments;
  /** 执行中的项目维护者在等回答：它所在的这一支停下；回答来了接着走 */
  execution: Pick<TaskExecution, "awaitAnswer" | "answered">;
  now: () => string;
}

export interface Clarifications {
  /** 接上卡片事件；启动时补上卡片处理了、工单还在等澄清的 */
  start(): void;
  stop(): void;
  /**
   * 维护者向派单方提问（ask_clarification）：工单转等澄清。用户发起的单项目任务，提问卡进待我处理（to: user）；
   * 任务维护者派来的工单，问题交给任务维护者（to: task_maintainer，没有卡）
   */
  ask(maintainerId: string, input: { intro?: string; questions: QuestionDraft[] }): { cardId?: string; workOrderId: string; to: "user" | "task_maintainer" };
  /** 任务维护者回答项目维护者在工单里问的（answer_work_order，17 号票）：交回项目维护者，工单回到进行中 */
  answerFromTask(scope: MaintainerScope, workOrderId: string, answer: string): TaskMaintainerWorkOrder;
  /** 任务维护者答不了、转问用户（forward_to_user，17 号票）：提问卡进待我处理，工单所属阶段这一支停下 */
  forward(scope: MaintainerScope, input: { workOrderId: string; intro?: string; questions: QuestionDraft[] }): { cardId: string; workOrderId: string };
  /** 提问卡上用户回答了项目维护者为工单问的：交回它的通知（和卡片的处理同一事务追加） */
  replyEvents(payload: QuestionsCardPayload, answer: { lines: readonly string[]; allRecommended: boolean }, key: string): NewEvent[];
}


export function createClarifications(options: ClarificationsOptions): Clarifications {
  const { store, cards, inbox, projects, tasks, segments, now } = options;
  let unsubscribe: (() => void) | undefined;
  const refOf = (wo: TaskMaintainerWorkOrder): OrderRef => ({ wo, projectName: projects.get(wo.projectId)?.name ?? wo.projectId });

  /** 任务维护者派来、在等澄清的工单（这个任务的）；不是的抛出原因 */
  const clarifyingOf = (scope: MaintainerScope, workOrderId: string): TaskMaintainerWorkOrder => {
    const wo = getWorkOrder(store.reader, workOrderId);
    if (!wo || wo.source !== "task_maintainer" || wo.taskId !== scope.taskId) throw new RequestRejected("not_found", refusal.notYours(workOrderId));
    if (wo.state !== "clarifying") throw new RequestRejected("not_allowed", refusal.notClarifying(wo));
    return wo;
  };

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
    if (wo.source === "task_maintainer") {
      // 任务维护者转问用户的（17 号票）：回答交给了任务维护者（提问卡给的通知），工单仍在等澄清，等它交回项目维护者；
      // 关掉提问卡就让任务维护者按自己的理解回答
      const { questionsCardId: _card, ...rest } = wo;
      const events: NewEvent[] = [workOrderEvent({ ...rest, updatedAt: now() }, "updated", wo.state, "user")];
      const task = tasks.get(wo.taskId);
      if (dismissed && task) {
        const scope = taskMessageScope(task, wo.stageId);
        events.push(
          buildAgentNotice(maintainerChannel(task.maintainerId), forwardDismissedText(wo), `questions-dismissed:${cardId}`, scope).event,
          buildTimelineRecord(maintainerChannel(task.maintainerId), { kind: "own_judgement", ...forwardDismissedRecord(wo), workOrderId: wo.id }, scope).event,
        );
      }
      store.appendBatch(events);
      options.execution.answered(cardId);
      return;
    }
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
      // 定时作业的一次运行（19 号票）没人等着回答：自己拿主意，做不了就报失败
      if (isJobRunWorkOrder(wo)) throw new RequestRejected("not_allowed", ASK_NOT_IN_JOB_RUN);
      if (wo.state !== "in_progress") throw new RequestRejected("not_allowed", `工单 ${wo.id} 现在${wo.state === "clarifying" ? "已经在等回答了" : "不在进行中"}`);
      const project = projects.maintainedBy(maintainerId);
      if (!project) throw new RequestRejected("not_found", "找不到这个维护者的项目");
      const task = tasks.get(wo.taskId);
      if (wo.source === "task_maintainer" && task) {
        // 任务维护者派来的工单（17 号票）：问题交给派单的任务维护者，不直接出给用户
        const question = questionLines(input.intro, input.questions);
        const next: TaskMaintainerWorkOrder = { ...wo, state: "clarifying", question, updatedAt: now() };
        store.appendBatch([
          workOrderEvent(next, "clarifying", wo.state, "maintainer"),
          buildAgentNotice(maintainerChannel(task.maintainerId), questionText({ wo, projectName: project.name }, question), `work-order-question:${wo.id}:${next.updatedAt}`, taskMessageScope(task, wo.stageId)).event,
        ]);
        return { workOrderId: wo.id, to: "task_maintainer" };
      }
      const questions = input.questions.map((q, i) => ({ id: `q${i + 1}`, ...q }));
      const payload: QuestionsCardPayload = {
        taskId: wo.taskId,
        askedBy: { maintainerId, projectId: project.id, workOrderId: wo.id },
        ...(input.intro ? { intro: input.intro } : {}),
        questions,
      };
      const card = cards.buildCreate({ type: "questions", urgency: "blocking", payload });
      const item = inbox.buildAdd({ kind: "card", cardId: card.card.id, title: oneLine(`维护者在问：${wo.taskTitle}`, 60), ...(task?.internal ? taskInboxOrigin(task) : { source: `项目「${project.name}」` }), urgency: "blocking" });
      store.appendBatch([card.event, item.event, workOrderEvent({ ...wo, state: "clarifying", questionsCardId: card.card.id, updatedAt: now() }, "clarifying", wo.state, "maintainer")]);
      inbox.alert(item.item);
      if (wo.kind === "execute") options.execution.awaitAnswer(wo.taskId, card.card.id);
      return { cardId: card.card.id, workOrderId: wo.id, to: "user" };
    },
    answerFromTask(scope, workOrderId, answer) {
      const wo = clarifyingOf(scope, workOrderId);
      const text = answer.trim();
      if (!text) throw new RequestRejected("bad_params", refusal.emptyAnswer);
      const { questionsCardId, question: _q, ...rest } = wo;
      const next: TaskMaintainerWorkOrder = { ...rest, state: "in_progress", updatedAt: now() };
      const events: NewEvent[] = [
        workOrderEvent(next, "answered", wo.state, "maintainer"),
        buildAgentNotice(maintainerChannel(wo.maintainerId), answerText(wo, text), `work-order-answer:${wo.id}:${next.updatedAt}`, segments.scopeIn(wo)).event,
      ];
      // 转问用户的卡还没回答：任务维护者自己答了，那张卡不用再答
      const card = questionsCardId === undefined ? undefined : cards.get(questionsCardId);
      const pending = card?.status === "pending";
      if (card && pending) events.push(cards.buildUpdate(card.id, { status: "expired" }).event);
      store.appendBatch(events);
      if (card && pending) options.execution.answered(card.id);
      return next;
    },
    forward(scope, input) {
      const wo = clarifyingOf(scope, input.workOrderId);
      if (wo.questionsCardId !== undefined && cards.get(wo.questionsCardId)?.status === "pending") throw new RequestRejected("not_allowed", refusal.alreadyForwarded(wo));
      const task = tasks.get(wo.taskId);
      if (!task) throw new RequestRejected("not_found", refusal.noTask(wo.taskId));
      const questions = input.questions.map((q, i) => ({ id: `q${i + 1}`, ...q }));
      const payload: QuestionsCardPayload = {
        taskId: wo.taskId,
        askedBy: { maintainerId: scope.maintainerId, projectId: wo.projectId, workOrderId: wo.id },
        intro: input.intro ?? forwardIntro(refOf(wo)),
        questions,
      };
      const card = cards.buildCreate({ type: "questions", urgency: "blocking", payload });
      const item = inbox.buildAdd({ kind: "card", cardId: card.card.id, title: oneLine(forwardInboxTitle(task), 60), source: taskSource(task), urgency: "blocking" });
      store.appendBatch([card.event, item.event, workOrderEvent({ ...wo, questionsCardId: card.card.id, updatedAt: now() }, "updated", wo.state, "maintainer")]);
      inbox.alert(item.item);
      // 工单所属阶段这一支等用户回答（都在等时任务转等我，原因"澄清"）
      options.execution.awaitAnswer(wo.taskId, card.card.id, { stageId: wo.stageId, what: FORWARD_WAIT });
      return { cardId: card.card.id, workOrderId: wo.id };
    },
    replyEvents(payload, answer, key) {
      const askedBy = payload.askedBy;
      if (!askedBy) return [];
      const wo = getWorkOrder(store.reader, askedBy.workOrderId);
      const task = payload.taskId === undefined ? undefined : tasks.get(payload.taskId);
      if (wo?.source === "task_maintainer" && task) {
        // 任务维护者转问用户的（17 号票）：回答交给任务维护者，由它交回项目维护者
        const text = forwardedAnswerText(refOf(wo), answer.lines, answer.allRecommended);
        return [buildAgentNotice(maintainerChannel(askedBy.maintainerId), text, `${key}#notice`, taskMessageScope(task, wo.stageId)).event];
      }
      const text = answeredText(askedBy.workOrderId, payload.taskId, answer.lines, answer.allRecommended);
      return [buildAgentNotice(maintainerChannel(askedBy.maintainerId), text, `${key}#notice`, segments.scopeIn({ projectId: askedBy.projectId, taskId: payload.taskId })).event];
    },
  };
}
