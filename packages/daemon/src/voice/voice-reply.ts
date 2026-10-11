// agent 用语音回复（规格第 22 节，32 号票）。用户发的是语音，agent 这一轮的回复就由运行时合成语音（秘书和维护者的会话都一样）：
//
// - 是否用语音：运行时按"用户上一条是不是语音"判定，不只靠提示词。看的是这一轮处理的用户消息（交给 agent 的那条输入，
//   和这一轮里收下的插话）里最后一条：它是语音就用语音回复。用户重新识别了之前没识别出来的语音、运行时交给 agent 的那条通知
//   （31 号票，isVoiceRetryNotice）也算用户的语音。别的运行时通知引起的一轮不用语音（比如任务执行中的阶段通知）。
// - 交给 agent 的这条语音输入后面跟一条说明（输入后面的上下文消息，有参考音色时才带）：这次的回复会合成语音，
//   回复长或有念不出来的内容时用"口语总结"工具另写一段适合听的。口语总结工具由各处的装配放进代为执行的工具
//   （秘书、维护者起草和执行、项目维护者的各段都有；守卫照常判定，不落入任何关注类别）。
// - 这一轮开始（turn_start）时输入是语音、有参考音色：建出 agent 语音对象（replying，记下这一轮开始的序号）。
//   用户 2026-10-08 定：这一轮前端不流式显示回复的文字，只显示"正在回复…"。
// - 一轮结束（完成）时定口语稿：回复的文字去掉 Markdown 标记后估出来念得完（maxSeconds 内）、又没有代码表格链接这类
//   念不出来的，整段合成（合成好只出语音气泡，文字收进语音，长按"转文字"才看）；否则合成口语总结，详细内容照常是这一轮的
//   文字和附件——agent 用工具写了就用它（太长的截到念得完）；没写的先追问它一次（followUp：会话在处理下一条输入之前交给它，
//   这次不算新回复，它说的不进会话，用量照常记账），追问了还没写才由运行时兜底（回复开头念得完的几句，加一句
//   "详细内容我发在聊天里了"）。口语稿定了就排队合成。
// - 口语稿定了之后的那一半（86 号票抽进 voice-synthesis.ts，和发语音工具共用）：排队（一次一条：显卡和 drama 共用）、
//   分段合成和推送（38 号票）、入库、同一事务追加新版本和载着它的 tts_audio 消息、失败说明（这一轮退回只发文字；
//   分段合成到一半失败的记成"只合成了一部分"，回复的文字照常显示）、重启后重做。
// - 这一轮最后没用语音（没回复完、最后一句不是语音、没有要念的文字、没有参考音色）的记成 skipped，文字照常显示。
//   没有任何参考音色时不建语音对象，待我处理里放一条"去导入参考音色"（开着的只有一条），导入之后自动归档。
// - 守护进程在途中停了（被杀了），重启后：还在回复的记成 skipped（那条输入由会话标成中断，不重送）；在追问口语总结的
//   直接由运行时兜底；还在合成的重做一遍（合成只是几次 HTTP 调用，不算"中断不确定"）：推过的段先收回，从第一段重新合成。
// - 86 号票：用户打字的那一轮 agent 也能用"发语音"工具发语音，它的行为都在 send-voice.ts。这里只把跟着回合记下的交给它：
//   正在进行的一轮（开始的序号、回复的归属，openTurn）、一轮结束（closeTurn：这一轮回复了哪些消息、结局），启动时先让它收尾（start）。
import { randomUUID } from "node:crypto";
import {
  type AgentVoiceEventPayload,
  type AgentVoiceRecord,
  type ConversationId,
  EVENT_TYPES,
  type MessageEnvelope,
  type MessageEventPayload,
  type MessagePart,
  type MessageScope,
  nowIso,
  pickMessageScope,
  type TurnEndEventPayload,
  type TurnStartEventPayload,
  Type,
} from "@ergou/protocol";
import { defineHostTool } from "../agent-manager/host-tools.ts";
import type { AgentVoiceReplies } from "../conversation/agent-session.ts";
import { getMessage, startedInputs } from "../conversation/views.ts";
import type { EventStore, StoredEvent } from "../events/event-store.ts";
import type { InboxService } from "../inbox/inbox.ts";
import type { MediaStore } from "../media/media-store.ts";
import type { Clock } from "../scheduler/clock.ts";
import { getAgentVoice, unsettledAgentVoices } from "./agent-voice-views.ts";
import type { ReferenceVoices } from "./reference-voices.ts";
import { createSendVoice, sendVoiceInterruptedResults } from "./send-voice.ts";
import { standingNotice } from "./shared.ts";
import type { SpeechSynthesizer } from "./speech.ts";
import { fitsPace, leadingSentences, runtimeSummary, type SpokenPace, speakable } from "./spoken-text.ts";
import {
  MISSING_REFERENCE_NOTICE,
  SKIPPED,
  SPOKEN_SUMMARY_NOT_NEEDED,
  SPOKEN_SUMMARY_PARAM,
  SPOKEN_SUMMARY_TAKEN,
  SPOKEN_SUMMARY_TITLE,
  SPOKEN_SUMMARY_TOOL,
  spokenSummaryToolDescription,
  summaryFollowUpText,
  voiceInputContext,
} from "./texts.ts";
import { isVoiceRetryNotice } from "./voice.ts";
import { createVoiceSynthesis } from "./voice-synthesis.ts";

export interface VoiceRepliesOptions {
  store: EventStore;
  media: MediaStore;
  inbox: InboxService;
  references: ReferenceVoices;
  speech: SpeechSynthesizer;
  /** 念多快、多长算长（配置里的 voice.reply） */
  pace: SpokenPace;
  /** 段的文件什么时候删按它算（测试里换成手动拨的） */
  clock: Clock;
  /** 合成出的 WAV 先写在这里再入库，分段合成的段也放在这里（数据目录的临时区） */
  tmpDir: string;
  /** 发语音工具最多等合成多久就先交回"还在合成"（毫秒，86 号票）；不给是 send-voice.ts 的 SEND_VOICE_WAIT_MS */
  sendVoiceWaitMs?: number;
  log: (line: string) => void;
}

/** 语音回复：给 agent 的（口语总结和发语音工具、输入后面的说明、追问）加上自己的启停 */
export interface VoiceReplies extends AgentVoiceReplies {
  /** 开始跟着会话频道上的回合走；上次没处理完的接着处理 */
  start(): void;
  /** 分段合成里合成好的一段的文件（HTTP 接口发给前端）；没有是 undefined */
  segmentFile(voiceId: string, index: number): string | undefined;
  /** 合成队列空了（测试用） */
  whenIdle(): Promise<void>;
  stop(): Promise<void>;
}

/** 一个会话里正在进行的一轮 */
interface OpenTurn {
  inputMessageId: string;
  /** 这一轮开始（turn_start）在会话频道上的序号 */
  seq: number;
  /** 这一轮处理的输入：交给 agent 的那条，和这一轮里收下的插话（按先后） */
  handled: string[];
  /** agent 这一轮发出的、有内容的消息（文字、图片、文件、卡片……） */
  replies: string[];
  /** 这一轮的回复带着的归属（最后一条回复的；还没有回复时是输入的） */
  scope: MessageScope;
  /** 这一轮开始时就建出的 agent 语音对象（输入是语音、有参考音色时） */
  voiceId?: string;
}

/** 回复里算"内容"的 part：工具调用记录、推理不算 */
const CONTENT_PARTS: ReadonlySet<MessagePart["type"]> = new Set(["text", "image", "file", "video", "card_ref"]);

/** 一轮只回一条语音：agent 语音对象由这条输入的幂等键建出 */
const createdKey = (inputMessageId: string) => `agent-voice:${inputMessageId}`;

/** 口语稿怎么定：整段合成、用 agent 写的口语总结，或者还得追问它 */
type SpokenPlan = { mode: "whole"; summaryBy?: undefined; text: string } | { mode: "summary"; summaryBy: "agent"; text: string } | { mode: "summary"; summaryBy?: undefined; text?: undefined };

export function createVoiceReplies(options: VoiceRepliesOptions): VoiceReplies {
  const { store, inbox, references, pace, log } = options;
  /** 会话 → 正在进行的一轮 */
  const turns = new Map<string, OpenTurn>();
  /** 输入的消息 id → agent 写的口语总结（最后一次为准） */
  const summaries = new Map<string, string>();
  /** 在追问口语总结的：输入的消息 id → agent 语音 id，会话接了追问没有 */
  const asking = new Map<string, { voiceId: string; asked: boolean }>();
  let stopped = false;
  let unsubscribe: (() => void) | undefined;
  let unwatchReferences: (() => void) | undefined;
  // 口语稿定了之后的那一半（排队、分段合成、入库、追加消息、失败说明、重启重做），和发语音工具共用
  const synthesis = createVoiceSynthesis({ store, media: options.media, references, speech: options.speech, pace, clock: options.clock, tmpDir: options.tmpDir, log });
  const { advance } = synthesis;
  const missing = standingNotice({ store, inbox, notice: "voice_reference_missing" });

  /** 这条输入是用户的语音吗 */
  const isVoiceInput = (message: MessageEnvelope) => (message.speaker === "user" && message.parts.some((p) => p.type === "voice")) || isVoiceRetryNotice(store, message);

  /** 这一轮要不要用语音回复：处理的用户消息里最后一条是语音 */
  const voiceTurn = (turn: OpenTurn): boolean => {
    for (const id of turn.handled.toReversed()) {
      const message = getMessage(store.reader, id);
      if (!message) continue;
      if (isVoiceInput(message)) return true;
      if (message.speaker === "user") return false;
    }
    return false;
  };

  const tool = defineHostTool({
    name: SPOKEN_SUMMARY_TOOL,
    title: SPOKEN_SUMMARY_TITLE,
    description: spokenSummaryToolDescription(pace),
    parameters: Type.Object({ text: Type.String({ minLength: 1, description: SPOKEN_SUMMARY_PARAM }) }, { additionalProperties: false }),
    readOnlyOrIdempotent: true,
    run({ text }, call) {
      const inputMessageId = call.inputMessageId;
      const message = inputMessageId === undefined ? undefined : getMessage(store.reader, inputMessageId);
      const turn = message && turns.get(message.conversation);
      const replying = turn !== undefined && turn.inputMessageId === inputMessageId && voiceTurn(turn);
      if (!message || (!replying && !asking.has(message.id))) return { text: SPOKEN_SUMMARY_NOT_NEEDED };
      summaries.set(message.id, text.trim());
      return { text: SPOKEN_SUMMARY_TAKEN };
    },
  });

  // 用户打字的那一轮也能发语音（86 号票，行为都在 send-voice.ts）：这一轮的情况从这里取，回合结束时告诉它
  const sendVoice = createSendVoice({
    store,
    references,
    pace,
    synthesis,
    isVoiceInput,
    openTurn: (conversation) => {
      const turn = turns.get(conversation);
      return turn && { seq: turn.seq, scope: turn.scope };
    },
    announceMissing: () => raiseMissing(),
    ...(options.sendVoiceWaitMs === undefined ? {} : { waitMs: options.sendVoiceWaitMs }),
    log,
  });

  // ───────────── agent 语音对象的变化 ─────────────

  /** 建出一条 agent 语音（一条输入只建一次） */
  const create = (conversation: ConversationId, inputMessageId: string, fields: Omit<AgentVoiceRecord, "id" | "conversation" | "inputMessageId" | "createdAt" | "updatedAt" | "version">): AgentVoiceRecord | undefined => {
    const time = nowIso();
    const voice: AgentVoiceRecord = { id: `av-${randomUUID()}`, conversation, inputMessageId, ...fields, createdAt: time, updatedAt: time, version: 1 };
    const payload: AgentVoiceEventPayload = { voice };
    const result = store.append({ channel: conversation, type: EVENT_TYPES.agentVoice, payload, idempotencyKey: createdKey(inputMessageId) });
    return result.duplicate ? undefined : voice;
  };

  /** 这一轮最后没用语音回复 */
  const skip = (voice: AgentVoiceRecord | undefined, reason: string) => {
    if (voice) advance(voice, { status: "skipped", error: reason });
  };

  /** 口语稿定了：排队合成 */
  const toSynthesis = (voice: AgentVoiceRecord, change: Partial<AgentVoiceRecord>) => {
    const next = advance(voice, { ...change, status: "synthesizing" });
    if (next) synthesis.enqueue(next.id);
  };

  // ───────────── 跟着会话频道上的回合走 ─────────────

  const onEvent = (event: StoredEvent) => {
    switch (event.type) {
      case EVENT_TYPES.turnStart: {
        const { inputMessageId } = event.payload as TurnStartEventPayload;
        const open = turns.get(event.channel);
        // 一轮里收下的插话：回合结束前补上它们的 turn_start、turn_end
        if (open && open.inputMessageId !== inputMessageId) {
          open.handled.push(inputMessageId);
          return;
        }
        // 这一轮回复的归属先取输入的（agent 发了消息就换成它的）
        const conversation = event.channel as ConversationId;
        const input = startedInputs(store.reader, conversation).find((q) => q.messageId === inputMessageId);
        const turn: OpenTurn = { inputMessageId, seq: event.seq, handled: [inputMessageId], replies: [], scope: input?.scope ?? {} };
        turns.set(event.channel, turn);
        // 输入是语音、有参考音色：这一轮用语音回复，回复的文字不流式显示
        const message = getMessage(store.reader, inputMessageId);
        if (message && isVoiceInput(message) && references.current()) {
          turn.voiceId = create(conversation, inputMessageId, { scope: turn.scope, turnSeq: event.seq, replyMessageIds: [], status: "replying" })?.id;
        }
        return;
      }
      case EVENT_TYPES.message: {
        const turn = turns.get(event.channel);
        const payload = event.payload as Partial<MessageEventPayload>;
        const message = payload.message;
        // 会话里别的 agent（子 agent，带 agentId）发的不算这一轮的回复
        if (!turn || message?.speaker !== "agent" || payload.agentId !== undefined || !message.parts.some((p) => CONTENT_PARTS.has(p.type))) return;
        turn.replies.push(message.id);
        turn.scope = pickMessageScope(payload as MessageEventPayload);
        return;
      }
      case EVENT_TYPES.turnEnd: {
        const { inputMessageId, outcome } = event.payload as TurnEndEventPayload;
        const turn = turns.get(event.channel);
        if (turn?.inputMessageId === inputMessageId) endTurn(event.channel as ConversationId, turn, outcome);
        return;
      }
      default:
        return;
    }
  };

  /** 这一轮的回复里的文字（按先后，空行隔开） */
  const replyTextOf = (messageIds: readonly string[]) =>
    messageIds
      .flatMap((id) => getMessage(store.reader, id)?.parts ?? [])
      .flatMap((p) => (p.type === "text" && p.text.trim() ? [p.text] : []))
      .join("\n\n");

  /** agent 写的口语总结念出来的样子（太长的截到念得完；念不出东西的是 undefined） */
  const agentSummary = (summary: string | undefined): string | undefined => {
    const spoken = summary === undefined ? "" : speakable(summary).text;
    if (!spoken) return undefined;
    return fitsPace(spoken, pace) ? spoken : leadingSentences(spoken, pace);
  };

  /** 定口语稿：短的、念得出来的整段合成；不然用 agent 写的口语总结；它没写就得追问 */
  const planSpoken = (replyText: string, summary: string | undefined): SpokenPlan => {
    const plain = speakable(replyText);
    if (plain.text && !plain.unspeakable && fitsPace(plain.text, pace)) return { mode: "whole", text: plain.text };
    const written = agentSummary(summary);
    return written ? { mode: "summary", summaryBy: "agent", text: written } : { mode: "summary" };
  };

  /** 一轮结束：定这一轮用不用语音、口语稿是什么；回复长又没写口语总结的，等会话追问 agent（followUp） */
  const endTurn = (conversation: ConversationId, turn: OpenTurn, outcome: TurnEndEventPayload["outcome"]) => {
    turns.delete(conversation);
    // 这一轮里发语音工具发的语音：定这一轮另写的文字收不收进气泡（86 号票）
    sendVoice.closeTurn(conversation, { seq: turn.seq, replies: turn.replies, outcome });
    const summary = summaries.get(turn.inputMessageId);
    summaries.delete(turn.inputMessageId);
    const replying = turn.voiceId === undefined ? undefined : getAgentVoice(store.reader, turn.voiceId);
    if (outcome !== "completed") return skip(replying, SKIPPED.turnNotCompleted(outcome));
    if (!voiceTurn(turn)) return skip(replying, SKIPPED.lastInputNotVoice);
    const replyText = replyTextOf(turn.replies);
    if (!replyText.trim() && !summary) return skip(replying, SKIPPED.nothingToSay);
    const reference = references.current();
    if (!reference) {
      announceMissing();
      return skip(replying, SKIPPED.noReference);
    }
    const plan = planSpoken(replyText, summary);
    const decided = {
      scope: turn.scope,
      replyMessageIds: [...turn.replies],
      mode: plan.mode,
      ...(plan.summaryBy === undefined ? {} : { summaryBy: plan.summaryBy }),
      ...(plan.text === undefined ? {} : { text: plan.text }),
      referenceVoice: { id: reference.id, name: reference.name },
    } satisfies Partial<AgentVoiceRecord>;
    const status = plan.text === undefined ? "summarizing" : "synthesizing";
    // 插话里的语音让这一轮用了语音：回合结束时才建出
    const voice = replying ? advance(replying, { ...decided, status }) : create(conversation, turn.inputMessageId, { ...decided, status });
    if (!voice) return;
    if (status === "synthesizing") return synthesis.enqueue(voice.id);
    // 回复长、agent 没写口语总结：等会话追问它一次（会话在追加 turn_end 之后同一刻接过去）；没有会话接（不该发生）就直接兜底
    asking.set(turn.inputMessageId, { voiceId: voice.id, asked: false });
    setImmediate(() => {
      if (asking.get(turn.inputMessageId)?.asked === false) afterFollowUp(turn.inputMessageId);
    });
  };

  /** 追问结束（或者没法追问）：agent 补写了口语总结就用它，还是没写由运行时从回复开头截 */
  const afterFollowUp = (inputMessageId: string) => {
    const pending = asking.get(inputMessageId);
    asking.delete(inputMessageId);
    const summary = summaries.get(inputMessageId);
    summaries.delete(inputMessageId);
    const voice = pending && getAgentVoice(store.reader, pending.voiceId);
    if (!voice || voice.status !== "summarizing" || stopped) return;
    settleSummary(voice, summary);
  };

  /** 定下口语总结（agent 写的，或者运行时截的）去合成 */
  const settleSummary = (voice: AgentVoiceRecord, summary: string | undefined) => {
    const written = agentSummary(summary);
    if (written) return toSynthesis(voice, { summaryBy: "agent", text: written });
    toSynthesis(voice, { summaryBy: "runtime", text: runtimeSummary(speakable(replyTextOf(voice.replyMessageIds)).text, pace) });
  };

  // ───────────── 没有参考音色 ─────────────

  /** 待我处理里提示去导入参考音色（语音回复和发语音工具共用一条，开着的只有一条） */
  function raiseMissing() {
    missing.raise({ ...MISSING_REFERENCE_NOTICE, urgency: "non_blocking", actions: [...MISSING_REFERENCE_NOTICE.actions] });
  }

  const announceMissing = () => {
    log("用户发了语音，但还没有导入任何参考音色：这次只发文字");
    raiseMissing();
  };

  return {
    tools: [tool, sendVoice.tool],
    interruptedResults: (conversation) => sendVoiceInterruptedResults(store.reader, conversation),
    inputContext(message) {
      if (!isVoiceInput(message) || !references.current()) return undefined;
      return voiceInputContext(pace);
    },
    followUp(conversation, inputMessageId) {
      // 会话在追加 turn_end 之后同一刻来接；这一轮的结束还没经订阅处理到（嵌套追加时）就现在处理
      const turn = turns.get(conversation);
      if (turn?.inputMessageId === inputMessageId) endTurn(conversation, turn, "completed");
      const pending = asking.get(inputMessageId);
      if (!pending || pending.asked) return undefined;
      pending.asked = true;
      return { text: summaryFollowUpText(pace), done: () => afterFollowUp(inputMessageId) };
    },
    start() {
      unsubscribe = store.onAppend((event) => {
        if (stopped) return;
        try {
          onEvent(event);
        } catch (err) {
          log(`语音回复跟回合出错：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        }
      });
      unwatchReferences = references.onChange(() => {
        if (references.current()) missing.retire();
      });
      // 工具发的语音、回合还没结束就停了的（86 号票）：那一轮已经被打断，另写的文字照常显示
      sendVoice.start();
      // 上次没处理完的：还在回复的那一轮已经被打断（会话把那条输入标成中断，不重送）；在追问口语总结的直接兜底；
      // 还在合成的重做一遍（合成只是几次 HTTP 调用）。分段合成的段都是临时的：全删，重做的从头再推
      synthesis.start();
      for (const voice of unsettledAgentVoices(store.reader)) {
        if (voice.status === "replying") skip(voice, SKIPPED.restarted);
        else if (voice.status === "summarizing") settleSummary(voice, undefined);
        else synthesis.enqueue(voice.id);
      }
    },
    segmentFile: (voiceId, index) => synthesis.segmentFile(voiceId, index),
    whenIdle: () => synthesis.whenIdle(),
    async stop() {
      stopped = true;
      unsubscribe?.();
      unwatchReferences?.();
      await synthesis.stop();
    },
  };
}
