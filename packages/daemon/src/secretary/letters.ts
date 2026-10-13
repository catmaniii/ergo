// 给秘书发消息（102 号票，规格第 12 节"星形通信"、第 7 节）：除了秘书，所有 agent（任务的维护者、项目的维护者——起草计划、工单里、
// 项目内部任务里、定时 / 事件触发的运行里——维护者派的子 agent、阶段验收的评审子 agent，用户 2026-10-12 定）默认都有 tell_secretary，
// 给秘书写一条要转告用户的话。不做 agent 之间的互发、群聊：agent 之间只有工单，外加这一条到秘书的单向消息，经运行时转交，
// 两边都有记录（发的那边是一条工具调用，秘书主线里是它转告的那条回复）。
// - 收件人写成可扩展的形式（letter-texts.ts 的 LETTER_RECIPIENTS，现在只有秘书）；
// - 工具包里的一项能力开关（"给秘书发消息"，PlanToolkit.tellSecretary，默认开）：关掉了装配里就没有这个工具（维护者的装配只在
//   canTellSecretary 时给；子 agent 的工具包不超过派它的维护者，维护者关了它也没有；评审跟着任务的工具包）；
// - 发出去 = 守护进程内部的 secretary_letters 频道上记一条 maintainer_letter（谁发的、在做什么、原话；同一次工具调用只记一次），
//   交给秘书由 task-done.ts 照任务做完的那一套交：秘书闲着才交、忙时排在这一轮后面、没起来的起来后补、处理到一半被打断起来后重交、
//   幂等（重启不重复），几条差不多同时到的并成一条（和差不多同时到的任务做完通知一起交，各自一条）；
// - 一句话总结（115 号票）：工具的必填参数 summary（30 字以内），记在信上；交给秘书的通知上存着它（几封并在一起的连起来），
//   秘书会话里这条通知折成一行时显示它，点开看全文。交给秘书的照旧是全文；
// - 防刷屏：每个发信人各算（按稳定身份：维护者、子 agent 是 agent id，评审是这个任务这个阶段的评审，重启后重新验收不换人），
//   10 分钟里最多 3 条，超了工具回"发得太频繁，攒一攒一起说"；和它上一条一字不差的不再发；
// - 不加新的拦截（用户 2026-10-10 定"功能先跑通"）：调用照现有守卫照常判、照常记录。
import { type ConversationId, firstSentence, internalScopeLabel, LETTER_SUMMARY_MAX, type ProjectInternal, TASK_KIND_LABEL, type TaskKind, Type } from "@ergou/protocol";
import { defineHostTool, type HostTool } from "../agent-manager/host-tools.ts";
import type { EventStore, StoredEvent } from "../events/event-store.ts";
import type { Clock } from "../scheduler/clock.ts";
import {
  doingAcceptance,
  DOING_INTERNAL,
  doingRun,
  doingStage,
  jobMaintainerName,
  LETTER_ALREADY_SENT,
  LETTER_DUPLICATE,
  LETTER_EMPTY,
  LETTER_LIMIT,
  LETTER_MAX_CHARS,
  LETTER_SENT,
  LETTER_SUMMARY_EMPTY,
  LETTER_WINDOW_MS,
  letterItemText,
  letterTooFrequent,
  projectMaintainerName,
  TELL_SECRETARY_PARAM,
  TELL_SECRETARY_SUMMARY_PARAM,
  TELL_SECRETARY_TITLE,
  TELL_SECRETARY_TOOL,
  taskMaintainerName,
  tellSecretaryDescription,
  type LetterRecipient,
} from "./letter-texts.ts";

export { TELL_SECRETARY_TOOL };

/** 守护进程内部的 secretary_letters 频道（前端不订阅）：agent 发出的每一条 */
export const LETTERS_CHANNEL = "secretary_letters";
/** agent 发出的一条（秘书收到的是 task-done.ts 交的通知） */
export const LETTER_EVENT = "maintainer_letter";

/** maintainer_letter 的负载 */
export interface LetterPayload {
  to: LetterRecipient;
  /** 谁发的（agent id：维护者 tm-1 / pm-1、子 agent sa-1、评审 review-…） */
  agentId: string;
  /**
   * 发信人的稳定身份（防刷屏、查重按它各算）：维护者、子 agent 就是 agent id；评审是"这个任务这个阶段的评审"
   * （review:<任务>:<阶段>）——验收做到一半守护进程重启，重新验收的评审 id 跟着次数变，同一句话不再发一遍
   */
  senderKey: string;
  /** 它那边的工具调用记在哪个会话里（评审的调用不进会话，没有） */
  conversation?: ConversationId;
  toolCallId: string;
  /** 谁发的（发的那一刻的说法）："长程任务 t-3「整理发票」的维护者"、"项目「家庭相册」的维护者"、"……的子 agent sa-1" */
  from: string;
  /** 那时在做什么："在做任务 t-5「…」的工单 wo-2 时"、"第 3 次运行时"、"在做阶段 s2「…」时"；没有就不写 */
  doing?: string;
  /** 原话 */
  text: string;
  /** 一句话总结（115 号票：秘书会话里这封信折成一行时显示的那句）；之前记下的信没有，交的时候取原话的第一句 */
  summary?: string;
}

/** 同一次工具调用只记一次（被打断后恢复时重做也不重发） */
const letterKey = (agentId: string, toolCallId: string) => `tell-secretary:${agentId}:${toolCallId}`;

/** 是不是一条给秘书的信（彻底删除改写过的不算） */
export function isLetterToSecretary(e: StoredEvent): boolean {
  if (e.channel !== LETTERS_CHANNEL || e.type !== LETTER_EVENT) return false;
  const p = e.payload as Partial<LetterPayload>;
  return p.to === "secretary" && typeof p.text === "string";
}

/** 通知里的一条（交的时候写：谁、在做什么时说的、原话）和它的一句话总结（115 号票；之前记下的信没有，取原话的第一句） */
export function describeLetter(e: StoredEvent): { text: string; summary: string } {
  const p = e.payload as LetterPayload;
  return { text: letterItemText(p.from, p.doing, p.text), summary: p.summary ?? firstSentence(p.text) };
}

/**
 * 发信的 agent 此刻是谁、在做什么。装配时（每次唤起、每次拉起）按那时的情况算好：换了一次运行、换了一张工单都会重新装配，说法跟着变
 */
export interface LetterSender {
  agentId: string;
  /** 发信人的稳定身份（防刷屏、查重按它算）；不给就是 agent id */
  senderKey?: string | undefined;
  conversation?: ConversationId | undefined;
  from: string;
  doing?: string | undefined;
}

/** 任务自己的维护者（定时触发的任务写第几次运行：runLabel 由调用方给） */
export function taskSender(task: { id: string; title: string; maintainerId: string }, kind: TaskKind, conversation: ConversationId, runLabel?: string): LetterSender {
  return { agentId: task.maintainerId, conversation, from: taskMaintainerName(task, kind), doing: runLabel === undefined ? undefined : doingRun(runLabel) };
}

/** 项目的维护者：doing 是这一段在做什么（letter-texts.ts 里的几种说法） */
export function projectSender(project: { name: string; maintainerId: string }, conversation: ConversationId, doing: string | undefined): LetterSender {
  return { agentId: project.maintainerId, conversation, from: projectMaintainerName(project.name), doing };
}

/** 定时作业自己的维护者（76 号票之前的定时作业） */
export function jobSender(job: { id: string; title: string; maintainerId: string }, conversation: ConversationId, runLabel?: string): LetterSender {
  return { agentId: job.maintainerId, conversation, from: jobMaintainerName(job), doing: runLabel === undefined ? undefined : doingRun(runLabel) };
}

/** 任务的称呼：项目内部的只写在哪个项目内部（64、66 号票：秘书看不到项目内部的细节） */
const taskOf = (task: { id: string; title: string; internal?: ProjectInternal | undefined }, kind: TaskKind) =>
  task.internal ? `${internalScopeLabel(task.internal.projectName)}一个任务` : `${TASK_KIND_LABEL[kind]} ${task.id}「${task.title}」`;

/** 维护者派的子 agent（20 号票）："长程任务 t-3「…」的子 agent sa-1"，在做哪个阶段；项目内部的不写是哪个任务、哪个阶段 */
export function subAgentSender(
  task: { id: string; title: string; internal?: ProjectInternal | undefined },
  kind: TaskKind,
  agentId: string,
  conversation: ConversationId,
  stage: { stageId: string; title: string },
): LetterSender {
  return { agentId, conversation, from: `${taskOf(task, kind)}的子 agent ${agentId}`, doing: task.internal ? DOING_INTERNAL : doingStage(stage) };
}

/** 阶段验收的评审子 agent（13 号票）："长程任务 t-3「…」的评审子 agent"，在验收哪个阶段；它的调用不进会话 */
export function reviewerSender(task: { id: string; title: string; internal?: ProjectInternal | undefined }, kind: TaskKind, agentId: string, stage: { stageId: string; title: string }): LetterSender {
  return { agentId, senderKey: `review:${task.id}:${stage.stageId}`, from: `${taskOf(task, kind)}的评审子 agent`, doing: task.internal ? DOING_INTERNAL : doingAcceptance(stage) };
}

export interface SecretaryLettersOptions {
  store: EventStore;
  /** 防刷屏的 10 分钟按它算（事件时间也按它记） */
  clock: Clock;
}

export interface SecretaryLetters {
  /** 这个 agent 的 tell_secretary（装配的地方先看工具包里开着没有：canTellSecretary） */
  tool(sender: LetterSender): HostTool;
}

export function createSecretaryLetters(options: SecretaryLettersOptions): SecretaryLetters {
  const { store, clock } = options;

  /** 这个发信人发出过的（按先后；按稳定身份认） */
  const sentBy = (senderKey: string) => store.read(LETTERS_CHANNEL, 0, LETTER_EVENT).filter((e) => isLetterToSecretary(e) && (e.payload as LetterPayload).senderKey === senderKey);

  const tool = (sender: LetterSender): HostTool =>
    defineHostTool({
      name: TELL_SECRETARY_TOOL,
      title: TELL_SECRETARY_TITLE,
      description: tellSecretaryDescription,
      // 一句话总结写在原话前面（115 号票：模型多半按这个顺序给参数，工具调用的参数摘要截短时总结还在）
      parameters: Type.Object(
        {
          summary: Type.String({ minLength: 1, maxLength: LETTER_SUMMARY_MAX, description: TELL_SECRETARY_SUMMARY_PARAM }),
          text: Type.String({ minLength: 1, maxLength: LETTER_MAX_CHARS, description: TELL_SECRETARY_PARAM }),
        },
        { additionalProperties: false },
      ),
      // 同一次调用只记一次（幂等键带着工具调用的 id）：被打断后重做没有额外效果
      readOnlyOrIdempotent: true,
      run: ({ summary, text }, call) => {
        const key = letterKey(sender.agentId, call.toolCallId);
        if (store.eventByIdempotencyKey(key)) return { text: LETTER_ALREADY_SENT };
        const said = text.trim();
        if (said === "") return { text: LETTER_EMPTY, isError: true };
        const gist = summary.trim();
        if (gist === "") return { text: LETTER_SUMMARY_EMPTY, isError: true };
        const senderKey = sender.senderKey ?? sender.agentId;
        const sent = sentBy(senderKey);
        const last = sent.at(-1);
        if (last && (last.payload as LetterPayload).text === said) return { text: LETTER_DUPLICATE, isError: true };
        const now = clock.now();
        const recent = sent.filter((e) => now - Date.parse(e.time) < LETTER_WINDOW_MS);
        if (recent.length >= LETTER_LIMIT) return { text: letterTooFrequent(Date.parse(recent[0]!.time) + LETTER_WINDOW_MS - now), isError: true };
        const payload: LetterPayload = {
          to: "secretary",
          agentId: sender.agentId,
          senderKey,
          ...(sender.conversation ? { conversation: sender.conversation } : {}),
          toolCallId: call.toolCallId,
          from: sender.from,
          ...(sender.doing ? { doing: sender.doing } : {}),
          text: said,
          summary: gist,
        };
        store.append({ channel: LETTERS_CHANNEL, type: LETTER_EVENT, payload, idempotencyKey: key });
        return { text: LETTER_SENT };
      },
    });

  return { tool };
}
