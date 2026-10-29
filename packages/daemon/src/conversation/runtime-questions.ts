// 运行时的提问（288 号票，宿主协议 23 的 ask_user / ask_user_reply）：维护者的运行时自己要问用户的——Claude Code 的 AskUserQuestion
// （选择题，可多选、可自己写）、退出计划模式时的批准——子进程报 ask_user，这里建一张提问卡（runtime_question）放进它的会话（一条只有卡片
// 引用的消息）和待我处理，活动状态是"等你"（等你回答 / 等你批准）；你在卡上答了（卡片动作落盘之后），回答经 ask_user_reply 交回那次调用。
// - 这一轮结束了（turn_end：做完、被打断）、子进程退出了，还没答的卡作废（expired，再点回"这一轮已经结束"）：子进程那边已经按没答收尾
//   （打断时 SDK 的中止信号先到，canUseTool 按没答回）；
// - 卡片类型（动作、纯文本、彻底删除）也在这里：选择题"提交回答"（answer）、"不答"（dismiss），计划"批准"（approve）、"打回"（reject，附一句
//   让它怎么改）；动作先核对还有调用在等（卡作废之前子进程刚好退出的，回"这一轮已经结束"）。
// 内核的（不是 Claude Code 插件的）：宿主协议是内核的接缝，以后 Codex 这类运行时问用户也走它。pi 不报 ask_user。
import {
  type ConversationId,
  internalMark,
  type MessageScope,
  type ProjectInternal,
  PURGED_TEXT,
  type RuntimeQuestion,
  RuntimeQuestionAnswerInput,
  RuntimeQuestionCardPayload,
  type RuntimeQuestionReply,
  runtimeAnswerProblem,
  t,
  type Urgency,
} from "@ergo/protocol";
import type { AgentLink, UserWaits } from "../agent-manager/agent-manager.ts";
import type { CardService } from "../cards/cards.ts";
import { defineCardType } from "../cards/registry.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore } from "../events/event-store.ts";
import type { InboxService } from "../inbox/inbox.ts";
import type { AgentReport } from "../runtime/index.ts";
import { oneLine } from "../util/text.ts";
import { buildMessage } from "./messages.ts";

/** 一个接上提问的会话：谁、在哪个会话、卡上的来源、归属 */
export interface QuestionSession {
  agentId: string;
  conversation: ConversationId;
  /** 卡上、待我处理里的来源（和审批卡一样：守卫接入的 source） */
  source: string;
  /** 项目内部的会话（64 号票）：待我处理的事项带上它 */
  internal?: ProjectInternal;
  /** 会话里的消息带上的归属（任务、项目、阶段）：问的那一刻取 */
  scope: () => MessageScope;
  /** 运行时给人看的名字（"Claude Code"）：问的那一刻取 */
  runtimeTitle: () => string;
}

export interface RuntimeQuestions {
  /** 接上一个子进程（拉起后）：它的 ask_user 建卡、等回答；回合结束、子进程退出时还没答的卡作废。返回撤销的函数 */
  attach(proc: AgentLink, session: QuestionSession): () => void;
  /** 卡上答了（卡片动作落盘之后）：交回那次调用；没有调用在等的不管 */
  replied(cardId: string, reply: RuntimeQuestionReply): void;
  /** 这张卡还有没有调用在等 */
  waiting(cardId: string): boolean;
}

export interface RuntimeQuestionsOptions {
  store: EventStore;
  cards: CardService;
  inbox: InboxService;
  /** 在等用户回答：这个 agent 的活动状态是"等你"（25 号票） */
  userWaits?: UserWaits;
  log: (line: string) => void;
}

interface Pending {
  cardId: string;
  requestId: string;
  agentId: string;
  proc: AgentLink;
  owner: object;
}

/** 待我处理里事项的标题最多多长 */
const TITLE_MAX = 60;

export function createRuntimeQuestions(options: RuntimeQuestionsOptions): RuntimeQuestions {
  const { store, cards, inbox, log } = options;
  const pending = new Map<string, Pending>();

  const finish = (p: Pending) => {
    pending.delete(p.cardId);
    options.userWaits?.userWaitEnded(p.agentId, p.cardId);
  };

  /** 不再等这张卡：还待处理的作废（再点回 note） */
  const expire = (p: Pending, note: string) => {
    finish(p);
    try {
      if (cards.get(p.cardId)?.status !== "pending") return;
      store.append(cards.buildUpdate(p.cardId, { status: "expired", expiredNote: note }).event);
    } catch (err) {
      log(`作废 ${p.agentId} 的提问卡 ${p.cardId} 出错：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const send = (proc: AgentLink, requestId: string, reply: RuntimeQuestionReply) => {
    try {
      proc.send({ type: "ask_user_reply", requestId, reply });
    } catch (err) {
      // 子进程已经退出：没人要了
      log(`提问的回答送不回 ${proc.agentId}：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return {
    attach(proc, session) {
      const owner = {};
      const mine = () => [...pending.values()].filter((p) => p.owner === owner);

      const ask = (report: Extract<AgentReport, { type: "ask_user" }>) => {
        try {
          const scope = session.scope();
          const payload: RuntimeQuestionCardPayload = {
            agentId: session.agentId,
            runtimeTitle: session.runtimeTitle(),
            source: session.source,
            ...(report.subAgent ? { subAgent: true as const } : {}),
            question: report.question,
          };
          // 任务里问的卡住任务；对话里的不卡（同审批卡）
          const urgency: Urgency = scope.taskId === undefined ? "non_blocking" : "blocking";
          const card = cards.buildCreate({ type: "runtime_question", payload, urgency });
          const item = inbox.buildAdd({
            kind: "card",
            cardId: card.card.id,
            title: oneLine(inboxTitle(payload.runtimeTitle, report.question), TITLE_MAX),
            source: session.source,
            ...internalMark(session.internal),
            origin: {
              ...(scope.taskId === undefined ? {} : { taskId: scope.taskId }),
              ...(scope.projectId === undefined ? {} : { projectId: scope.projectId }),
              ...(scope.stageId === undefined ? {} : { stageId: scope.stageId }),
              conversation: session.conversation,
            },
            urgency,
          });
          const message = buildMessage({ conversation: session.conversation, speaker: "agent", parts: [{ type: "card_ref", cardId: card.card.id }] }, scope);
          store.appendBatch([card.event, item.event, message.event]);
          inbox.alert(item.item);
          pending.set(card.card.id, { cardId: card.card.id, requestId: report.requestId, agentId: session.agentId, proc, owner });
          options.userWaits?.userWaitStarted(session.agentId, card.card.id, report.question.kind === "plan" ? { kind: "approval", tool: t("conversation.runtimeQuestion.planTool") } : { kind: "clarification" });
        } catch (err) {
          log(`给 ${session.agentId} 的提问建卡出错：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
          send(proc, report.requestId, { kind: "declined", note: "二狗没能把这些问题交给用户（建卡出错）" }); // @i18n-ignore model：交回运行时、给模型看的
        }
      };

      const unsubscribe = proc.onReport((report) => {
        if (report.type === "ask_user") ask(report);
        else if (report.type === "turn_end") for (const p of mine()) expire(p, t("conversation.runtimeQuestion.turnEnded"));
      });
      void proc.exited.then(() => {
        for (const p of mine()) expire(p, t("conversation.runtimeQuestion.turnEnded"));
        unsubscribe();
      });
      return () => {
        unsubscribe();
        for (const p of mine()) expire(p, t("conversation.runtimeQuestion.turnEnded"));
      };
    },
    replied(cardId, reply) {
      const p = pending.get(cardId);
      if (!p) return;
      finish(p);
      send(p.proc, p.requestId, reply);
    },
    waiting: (cardId) => pending.has(cardId),
  };
}

/** 待我处理里的标题："Claude Code 问你：问题" / "Claude Code 的计划等你批准" */
function inboxTitle(runtime: string, question: RuntimeQuestion): string {
  return question.kind === "plan"
    ? t("conversation.runtimeQuestion.inbox.plan", { runtime })
    : t("conversation.runtimeQuestion.inbox.choices", { runtime, question: question.questions[0]!.question });
}

/** 卡上的动作都要先确认这次调用还在等（卡作废之前子进程刚好退出了的：回这一轮已经结束） */
function stillWaiting(questions: RuntimeQuestions, cardId: string): void {
  if (!questions.waiting(cardId)) throw new RequestRejected("conflict", t("conversation.runtimeQuestion.turnEnded"));
}

/** 卡上附的话（空的当没写） */
const said = (note: string | undefined) => (note === undefined || note.trim() === "" ? undefined : note.trim());

/** 动作和卡上问的对不上（选择题点了批准、计划点了提交回答） */
function wrongKind(): never {
  throw new RequestRejected("bad_params", t("conversation.runtimeQuestion.wrongAction"));
}

/** 提问卡（288 号票）：选择题提交回答、不答；计划批准、打回（附一句让它怎么改）。动作落盘之后把回答交回那次调用 */
export function runtimeQuestionCardType(questions: RuntimeQuestions) {
  const replied = (cardId: string, reply: RuntimeQuestionReply) => () => questions.replied(cardId, reply);
  return defineCardType({
    type: "runtime_question",
    version: 1,
    payload: RuntimeQuestionCardPayload,
    actions: {
      answer: {
        input: RuntimeQuestionAnswerInput,
        run: ({ card, payload, input }) => {
          if (payload.question.kind !== "choices") wrongKind();
          const answers = input.answers.map((a) => ({ question: a.question, selected: [...a.selected], ...(a.other?.trim() ? { other: a.other.trim() } : {}) }));
          const problem = runtimeAnswerProblem(payload.question.questions, answers);
          if (problem) throw new RequestRejected("bad_params", t(`conversation.runtimeQuestion.problem.${problem.problem}`, { n: problem.index + 1 }));
          stillWaiting(questions, card.id);
          const reply: RuntimeQuestionReply = { kind: "choices", answers };
          return { status: "handled", payload: { ...payload, reply }, note: t("conversation.runtimeQuestion.answered", { n: answers.length, count: answers.length }), afterCommit: replied(card.id, reply) };
        },
      },
      approve: {
        input: undefined,
        run: ({ card, payload, note }) => {
          if (payload.question.kind !== "plan") wrongKind();
          stillWaiting(questions, card.id);
          const words = said(note);
          const reply: RuntimeQuestionReply = { kind: "plan", approved: true, ...(words ? { note: words } : {}) };
          return { status: "handled", payload: { ...payload, reply }, afterCommit: replied(card.id, reply) };
        },
      },
      reject: {
        input: undefined,
        run: ({ card, payload, note }) => {
          if (payload.question.kind !== "plan") wrongKind();
          stillWaiting(questions, card.id);
          const words = said(note);
          const reply: RuntimeQuestionReply = { kind: "plan", approved: false, ...(words ? { note: words } : {}) };
          return { status: "handled", payload: { ...payload, reply }, afterCommit: replied(card.id, reply) };
        },
      },
      dismiss: {
        input: undefined,
        run: ({ card, payload, note }) => {
          stillWaiting(questions, card.id);
          const words = said(note);
          const reply: RuntimeQuestionReply = { kind: "declined", ...(words ? { note: words } : {}) };
          return { status: "dismissed", payload: { ...payload, reply }, afterCommit: replied(card.id, reply) };
        },
      },
    },
    toText: (p) =>
      p.question.kind === "plan"
        ? t("conversation.runtimeQuestion.text.plan", { runtime: p.runtimeTitle, source: p.source })
        : t("conversation.runtimeQuestion.text.choices", {
            runtime: p.runtimeTitle,
            source: p.source,
            n: p.question.questions.length,
            count: p.question.questions.length,
            questions: p.question.questions.map((q) => q.question).join(t("conversation.runtimeQuestion.text.sep")),
          }),
    // 彻底删除：你自己写的回答、附的话换成删除标记；问的、选了哪几个（卡上现成的选项）不变
    purge: (p) => (p.reply === undefined ? p : { ...p, reply: purgedReply(p.reply) }),
  });
}

function purgedReply(reply: RuntimeQuestionReply): RuntimeQuestionReply {
  if (reply.kind === "choices") return { ...reply, answers: reply.answers.map((a) => (a.other === undefined ? a : { ...a, other: PURGED_TEXT })) };
  return reply.note === undefined ? reply : { ...reply, note: PURGED_TEXT };
}
