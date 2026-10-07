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
import { CHANNELS, EVENT_TYPES, type MessagePart, type TurnEndEventPayload, type TurnStartEventPayload } from "@ergou/protocol";
import type { AgentManager } from "../agent-manager/agent-manager.ts";
import { appendMessage, newMessageId } from "../conversation/messages.ts";
import type { StreamHub } from "../conversation/stream-hub.ts";
import { getMessage, pendingInputs, startedInputs } from "../conversation/views.ts";
import type { EventStore } from "../events/event-store.ts";
import type { AgentExit, AgentProcess, AgentReport, FinalPart, ModelSpec } from "../runtime/index.ts";
import { SECRETARY_SYSTEM_PROMPT } from "./system-prompt.ts";

export const SECRETARY_AGENT_ID = "secretary";

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
  /** 秘书不在运行（拉起中、重新拉起中）超过这么久就算不健康，默认 30 秒 */
  downThresholdMs?: number;
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
      // 本票的秘书没有工具：草稿区和文件、bash 工具在 07，卡片工具在 06、12、15、21
      tools: [],
      systemPrompt: SECRETARY_SYSTEM_PROMPT,
      continueSession: true,
      credentials: options.credentials,
    });
    agent = proc;
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
        // 心跳、用量（24 号票记账）、工具调用（07）本票不处理
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
    agent.send({ type: "user_input", inputId: message.id, text: inputText(message.parts) });
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

/** 定稿消息里落盘的 part：正文和推理（工具调用 part 由 07 号票接上守卫后再落） */
function finalParts(parts: readonly FinalPart[]): MessagePart[] {
  const out: MessagePart[] = [];
  for (const part of parts) {
    if (part.type === "thinking" && part.text.length > 0) out.push({ type: "reasoning", text: part.text });
    else if (part.type === "text" && part.text.length > 0) out.push({ type: "text", text: part.text });
  }
  return out;
}

function textParts(parts: readonly MessagePart[]): string[] {
  return parts.filter((p): p is Extract<MessagePart, { type: "text" }> => p.type === "text").map((p) => p.text);
}

/** 交给模型的输入文字（本票只有文本 part；09 号票换成带版本号的投影） */
function inputText(parts: readonly MessagePart[]): string {
  return textParts(parts).join("\n\n");
}

/** 引用一条消息的开头（系统说明里用） */
function quote(parts: readonly MessagePart[]): string {
  const text = textParts(parts).join(" ").replace(/\s+/g, " ").trim();
  return text.length > QUOTE_MAX ? `${text.slice(0, QUOTE_MAX)}…` : text;
}
