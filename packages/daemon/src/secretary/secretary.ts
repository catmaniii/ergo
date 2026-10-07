// 秘书（规格第 7 节）：守护进程启动时拉起秘书的子进程，跑一条长期主线会话（重启后接着同一个会话）；
// 子进程意外退出就重新拉起。
//
// 输入队列放在事件日志里：秘书会话里用户发来的消息就是队列（派生视图 agent_inputs）。秘书一次处理一条：
// 交给子进程时追加 turn_start，处理完追加 turn_end 出队，再取下一条。内存里只记"正在处理哪一条"。
//
// 处理到一半被打断（子进程崩溃、守护进程重启）的那条输入不再自动重送：标成"中断"出队，
// 会话里追加一条系统说明请用户需要时重发。从会话文件最后一个完整回合续上的恢复规则在 23 号票。
//
// 回复：流式增量交给 StreamHub 节流推送（不落盘）；定稿后只把文本和推理 part 写进事件日志。
//
// 交给模型的是用户消息的投影（conversation/model-projection.ts，带版本号的纯函数）：附件按规则内联或只给名字，
// 支持视觉的模型另外收到图片。
//
// 工具：秘书的工具都由守护进程代为执行（agent-manager/host-tools.ts）：读取附件、把草稿区里的文件作为附件发出（09），
// 以及拉起它的模块交进来的（06 的建、改、取消简单提醒）。工具产生的卡片以一条只有卡片引用的消息出现在聊天里
// （消息里只放引用，卡片本身在卡片频道）。
//
// 草稿区（07 号票）：临时区里秘书专用的一格，也是秘书的工作目录。秘书有 pi 的文件工具（读、写、改、列目录）和 bash
// （Git Bash，能用本机已有的 Node 和 Python），不能联网（bash 起的进程设无效代理；首次使用要下载外部程序的 grep、find
// 按通用的装配规则不给，见 agent-manager.ts 的 assembledPiTools）。每次工具调用（包括守护进程代为执行的）
// 都先经守卫判定（guard-runtime/）：草稿区里的写、改、删直接做只记录；草稿区外、联网、受保护区域按守卫判。
// 运行时给秘书的通知（"某某已获批准，可以重试"、"交给我做"的事用户已完成）是会话里的系统消息，和用户消息一样排队交给秘书。
import fs from "node:fs";
import { CHANNELS, EVENT_TYPES, type MessageEnvelope, type MessagePart, partLabel, type TurnEndEventPayload, type TurnStartEventPayload } from "@ergou/protocol";
import { type AgentManager, assembledPiTools } from "../agent-manager/agent-manager.ts";
import { type HostTool, serveHostTools } from "../agent-manager/host-tools.ts";
import { getCard } from "../cards/views.ts";
import { appendMessage, newMessageId, SYSTEM_NOTICE_TAG } from "../conversation/messages.ts";
import { MODEL_PROJECTION_VERSION, projectForModel } from "../conversation/model-projection.ts";
import type { StreamHub } from "../conversation/stream-hub.ts";
import { getMessage, pendingInputs, startedInputs } from "../conversation/views.ts";
import type { EventStore } from "../events/event-store.ts";
import { BUILTIN_TOOL_REGISTRY, type GuardAgent, registerTools, TOOL } from "../guard/index.ts";
import type { GuardRuntime } from "../guard-runtime/guard-runtime.ts";
import { loadAttachmentContents } from "../media/attachment-content.ts";
import { readAttachmentTool, sendAttachmentTool } from "../media/attachment-tools.ts";
import type { MediaStore } from "../media/media-store.ts";
import type { AgentExit, AgentProcess, AgentReport, FinalPart, InputImage, ModelSpec } from "../runtime/index.ts";
import { SECRETARY_SYSTEM_PROMPT } from "./system-prompt.ts";

export const SECRETARY_AGENT_ID = "secretary";

/** 秘书只有一条长期主线会话：整条会话是一段（效果日志、时序规则按它划范围） */
export const SECRETARY_SEGMENT_ID = "secretary-main";

/**
 * 秘书的 pi 内置工具：文件工具和 bash。秘书不能联网，装配时按通用规则去掉首次使用要下载外部程序的 grep、find
 * （assembledPiTools），实际拿到的是读、写、改、列目录和 bash
 */
export const SECRETARY_PI_TOOLS: readonly string[] = [TOOL.read, TOOL.write, TOOL.edit, TOOL.ls, TOOL.grep, TOOL.find, TOOL.bash];

/** 审批卡、"交给我做"事项上秘书对话的来源 */
export const SECRETARY_SOURCE = "秘书对话";

/** 秘书此刻的状态：拉起中、闲着、在处理一条输入、意外退出后等着重新拉起、已停止 */
export type SecretaryStatus = "starting" | "idle" | "busy" | "restarting" | "stopped";

export interface SecretaryHealth {
  /** 秘书在运行（闲着或在干活），或者不在运行还没超过阈值 */
  ok: boolean;
  status: SecretaryStatus;
  /** 不健康的原因 */
  reason?: string;
}

export interface Secretary {
  readonly status: SecretaryStatus;
  /** 当前子进程的 pid（还没拉起或已退出时没有） */
  readonly pid: number | undefined;
  health(): SecretaryHealth;
  stop(): Promise<void>;
}

export interface SecretaryOptions {
  agents: AgentManager;
  store: EventStore;
  streams: StreamHub;
  model: ModelSpec;
  /** provider id → API key，经 stdin 交给子进程（不进子进程的环境变量） */
  credentials: Record<string, string>;
  /** 媒体库：用户消息里的附件在这里（发给模型前按投影读内容） */
  media: MediaStore;
  /** 秘书的模型支不支持图片输入（从配置读）：不支持时图片只投影成一行占位文字 */
  vision: boolean;
  /** 秘书的草稿区（它的工作目录）：send_attachment 只能发这里面的文件 */
  scratchDir: string;
  /** 时区：发给模型的每条消息前面的本地时间标记按它换算（配置里的 timeZone） */
  timeZone: string;
  /** 秘书不在运行（拉起中、重新拉起中）超过这么久就算不健康，默认 30 秒 */
  downThresholdMs?: number;
  /** 拉起它的模块交进来的工具（守护进程代为执行；06 的简单提醒） */
  tools?: readonly HostTool[];
  /** 守卫：秘书的每次工具调用都先经它判定 */
  guards: GuardRuntime;
  log: (line: string) => void;
}

const CONVERSATION = CHANNELS.secretary;
/** 子进程意外退出后重新拉起的等待时间：1 秒起，每次翻倍，最多 30 秒 */
const RESTART_BASE_MS = 1_000;
const RESTART_MAX_MS = 30_000;
const DEFAULT_DOWN_THRESHOLD_MS = 30_000;
/** 系统说明里引用被打断的那条消息时，最多引这么多字 */
const QUOTE_MAX = 30;

export function startSecretary(options: SecretaryOptions): Secretary {
  const { store, streams, log } = options;
  const downThresholdMs = options.downThresholdMs ?? DEFAULT_DOWN_THRESHOLD_MS;
  let status: SecretaryStatus = "starting";
  /** 从什么时候起不在运行（闲着或干活时为 undefined） */
  let downSince: number | undefined = Date.now();
  let agent: AgentProcess | undefined;
  /** 正在处理的那条输入 */
  let current: { inputMessageId: string } | undefined;
  /** 正在生成的回复：子进程里的消息 id → 定稿后的消息 id（流式增量和定稿消息共用它） */
  let reply: { agentMessageId: string; messageId: string } | undefined;
  let crashes = 0;
  let restartTimer: NodeJS.Timeout | undefined;
  let stopped = false;
  /** 秘书的工具（守护进程代为执行）：读取附件、把草稿区里的文件作为附件发出，加上交进来的 */
  const hostTools: HostTool[] = [
    readAttachmentTool({ store, media: options.media, conversation: CONVERSATION }),
    sendAttachmentTool({ store, media: options.media, conversation: CONVERSATION, scratchDir: options.scratchDir }),
    ...(options.tools ?? []),
  ];
  // 守卫看到的秘书：工作目录和围栏都是草稿区；联网一律按关着判。工具注册表加上秘书的代为执行的工具
  const toolRegistry = registerTools(BUILTIN_TOOL_REGISTRY, ...hostTools.map((t) => t.descriptor));
  const guardAgent: GuardAgent = {
    kind: "secretary",
    agentId: SECRETARY_AGENT_ID,
    cwd: options.scratchDir,
    toolkit: { bash: true, network: false, tools: [...assembledPiTools(SECRETARY_PI_TOOLS, false), ...hostTools.map((t) => t.spec.name)] },
    scratchDir: options.scratchDir,
  };

  const setStatus = (next: SecretaryStatus) => {
    status = next;
    const running = next === "idle" || next === "busy";
    if (running) downSince = undefined;
    else downSince ??= Date.now();
  };

  const spawn = () => {
    restartTimer = undefined;
    setStatus("starting");
    const proc = options.agents.spawn({
      agentId: SECRETARY_AGENT_ID,
      model: options.model,
      // pi 的内置工具：文件工具和 bash，工作目录是草稿区（联网关着，装配时去掉 grep、find）
      tools: [...SECRETARY_PI_TOOLS],
      // 守护进程代为执行的工具：附件（09）、简单提醒（06）；12、15、21 的卡片工具照这个加
      hostTools: hostTools.map((t) => t.spec),
      cwd: options.scratchDir,
      systemPrompt: SECRETARY_SYSTEM_PROMPT,
      continueSession: true,
      credentials: options.credentials,
      forwardToolCalls: true,
      network: false,
    });
    options.guards.attach(proc, {
      agent: guardAgent,
      tools: toolRegistry,
      conversation: CONVERSATION,
      source: SECRETARY_SOURCE,
      segmentId: SECRETARY_SEGMENT_ID,
    });
    agent = proc;
    serveHostTools(proc, hostTools, {
      log,
      // 工具产生的卡片以一条只有卡片引用的消息出现在聊天里
      onCards: (cardIds) => appendMessage(store, { conversation: CONVERSATION, speaker: "agent", parts: cardIds.map((cardId) => ({ type: "card_ref", cardId })) }),
    });
    proc.onReport((report) => {
      if (proc === agent) onReport(report);
    });
    void proc.exited.then((exit) => onExit(proc, exit));
  };

  /** 结束正在生成的回复的流式推送（定稿、回合结束、子进程退出时） */
  const endReply = () => {
    if (reply) streams.end(CONVERSATION, reply.messageId);
    reply = undefined;
  };

  const replyIdFor = (agentMessageId: string): string => {
    if (reply?.agentMessageId !== agentMessageId) {
      endReply();
      reply = { agentMessageId, messageId: newMessageId() };
    }
    return reply.messageId;
  };

  const onReport = (report: AgentReport) => {
    switch (report.type) {
      case "ready":
        setStatus("idle");
        crashes = 0;
        pump();
        return;
      case "stream_delta":
        if (!current) return;
        streams.delta(CONVERSATION, replyIdFor(report.messageId), report.part === "thinking" ? "reasoning" : "text", report.delta);
        return;
      case "message_final": {
        if (!current) return;
        const messageId = replyIdFor(report.messageId);
        endReply();
        const parts = finalParts(report.message.parts);
        if (parts.length > 0) appendMessage(store, { id: messageId, conversation: CONVERSATION, speaker: "agent", parts });
        return;
      }
      case "turn_end":
        if (!current) return;
        endReply();
        if (report.outcome === "error") systemNote(`秘书这次没能回复：${report.errorMessage ?? "未知错误"}`);
        finishTurn(current.inputMessageId, report.outcome, report.errorMessage);
        current = undefined;
        setStatus("idle");
        pump();
        return;
      case "error":
        log(`秘书子进程报错（${report.code}${report.fatal ? "，致命" : ""}）：${report.message}`);
        return;
      default:
        // 心跳、用量（24 号票记账）不处理；守护进程代为执行的工具由 serveHostTools 处理，守卫判定和工具调用的记录由守卫接入处理
        return;
    }
  };

  const systemNote = (text: string) => appendMessage(store, { conversation: CONVERSATION, speaker: "system", parts: [{ type: "text", text }] });

  const finishTurn = (inputMessageId: string, outcome: TurnEndEventPayload["outcome"], error?: string) => {
    const payload: TurnEndEventPayload = { inputMessageId, outcome, ...(error === undefined ? {} : { error }) };
    store.append({ channel: CONVERSATION, type: EVENT_TYPES.turnEnd, payload });
  };

  /**
   * 处理到一半被打断的输入（已有 turn_start、还没有 turn_end）：标成中断出队，追加系统说明，不重送。
   * 守护进程启动时（上次被杀时正在处理的）和子进程意外退出时调用。
   */
  const interruptStartedInputs = () => {
    for (const input of startedInputs(store.reader, CONVERSATION)) {
      const quoted = quote(getMessage(store.reader, input.messageId)?.parts ?? []);
      systemNote(`上一条消息${quoted ? `「${quoted}」` : ""}处理时中断了，秘书没有接着处理；需要的话请重发。`);
      finishTurn(input.messageId, "interrupted");
    }
  };

  /** 闲着就从队列里取下一条输入交给秘书 */
  const pump = () => {
    if (status !== "idle" || current || !agent) return;
    const next = pendingInputs(store.reader, CONVERSATION)[0];
    if (!next) return;
    const message = getMessage(store.reader, next.messageId);
    if (!message) {
      finishTurn(next.messageId, "error", `找不到消息 ${next.messageId}`);
      return pump();
    }
    current = { inputMessageId: message.id };
    setStatus("busy");
    const payload: TurnStartEventPayload = { inputMessageId: message.id };
    store.append({ channel: CONVERSATION, type: EVENT_TYPES.turnStart, payload });
    // 附件的内容要读文件（PDF 还要抽文本），是异步的；准备好时秘书还是同一个子进程、还在处理这一条，才交过去
    const proc = agent;
    const stillCurrent = () => agent === proc && current?.inputMessageId === message.id;
    prepareInput(message).then(
      (input) => {
        // 运行时的通知（系统消息）标明来源，免得模型当成用户说的
        const text = message.speaker === "system" ? `${SYSTEM_NOTICE_TAG}\n${input.text}` : input.text;
        if (stillCurrent()) proc.send({ type: "user_input", inputId: message.id, text, ...(input.images.length > 0 ? { images: input.images } : {}) });
      },
      (err: unknown) => {
        if (!stillCurrent()) return;
        const reason = err instanceof Error ? err.message : String(err);
        log(`准备秘书的输入出错：${reason}`);
        systemNote(`秘书这次没能回复：读取附件出错（${reason}）`);
        finishTurn(message.id, "error", reason);
        current = undefined;
        setStatus("idle");
        pump();
      },
    );
  };

  /** 消息里引用的卡片的一行摘要：卡片的纯文本降级版本（卡片类型注册表的 toText 生成、存在卡片里的 text） */
  const cardSummaries = (parts: readonly MessagePart[]): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const part of parts) {
      if (part.type !== "card_ref") continue;
      const card = getCard(store.reader, part.cardId);
      if (card) out[part.cardId] = card.text;
    }
    return out;
  };

  /** 一条用户消息发给模型前的样子：带版本号的投影（附件按规则内联或只给名字），支持视觉时附上图片 */
  const prepareInput = async (message: MessageEnvelope): Promise<{ text: string; images: InputImage[] }> => {
    const attachments = await loadAttachmentContents(options.media, message.parts, MODEL_PROJECTION_VERSION);
    const projected = projectForModel({
      version: MODEL_PROJECTION_VERSION,
      parts: message.parts,
      sentAt: message.time,
      timeZone: options.timeZone,
      vision: options.vision,
      attachments,
      cards: cardSummaries(message.parts),
    });
    const images: InputImage[] = [];
    for (const image of projected.images) {
      if (!options.media.info(image.mediaId)) continue;
      images.push({ mime: image.mime, data: fs.readFileSync(options.media.filePath(image.mediaId)).toString("base64") });
    }
    return { text: projected.text, images };
  };

  const onExit = (proc: AgentProcess, exit: AgentExit) => {
    if (proc !== agent) return;
    agent = undefined;
    endReply();
    current = undefined;
    if (stopped) {
      setStatus("stopped");
      return;
    }
    // 正在处理的那条不再交给秘书
    interruptStartedInputs();
    crashes += 1;
    const delay = Math.min(RESTART_BASE_MS * 2 ** (crashes - 1), RESTART_MAX_MS);
    log(`秘书子进程意外退出（code ${exit.code}，signal ${exit.signal}），${delay} 毫秒后重新拉起`);
    setStatus("restarting");
    restartTimer = setTimeout(spawn, delay);
  };

  // 有新的用户消息进了秘书会话：闲着就开始处理
  const unsubscribe = store.onAppend((event) => {
    if (event.channel === CONVERSATION && event.type === EVENT_TYPES.message) pump();
  });

  // 上次守护进程被杀时正在处理的输入：不重送
  interruptStartedInputs();
  spawn();

  return {
    get status() {
      return status;
    },
    get pid() {
      return agent?.pid;
    },
    health() {
      if (downSince === undefined || status === "stopped") return { ok: status !== "stopped", status };
      const downMs = Date.now() - downSince;
      if (downMs <= downThresholdMs) return { ok: true, status };
      return { ok: false, status, reason: `秘书子进程已经 ${Math.round(downMs / 1000)} 秒没在运行（${status === "restarting" ? "意外退出后等着重新拉起" : "拉起中"}）` };
    },
    async stop() {
      stopped = true;
      unsubscribe();
      if (restartTimer) clearTimeout(restartTimer);
      const proc = agent;
      if (proc) {
        proc.kill();
        await proc.exited;
      }
      setStatus("stopped");
    },
  };
}

/**
 * 定稿消息里落盘的 part：正文和推理。工具调用 part 要等守卫判定、执行完才知道结果，
 * 由守卫接入在调用结束时另追加一条（guard-runtime/guard-runtime.ts）
 */
function finalParts(parts: readonly FinalPart[]): MessagePart[] {
  const out: MessagePart[] = [];
  for (const part of parts) {
    if (part.type === "thinking" && part.text.length > 0) out.push({ type: "reasoning", text: part.text });
    else if (part.type === "text" && part.text.length > 0) out.push({ type: "text", text: part.text });
  }
  return out;
}

/** 引用一条消息的开头（系统说明里用）：文字原样，附件写成文件名 */
function quote(parts: readonly MessagePart[]): string {
  const text = parts.map(partLabel).join(" ").replace(/\s+/g, " ").trim();
  return text.length > QUOTE_MAX ? `${text.slice(0, QUOTE_MAX)}…` : text;
}
