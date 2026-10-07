// pi 会话事件 → 宿主协议消息（只管消息和工具调用；回合的开始和结束由 AgentSessionRunner 管）。
// pi 的词汇（stopReason 等）在这里换成二狗自己的。
import type { AssistantMessage, StopReason as PiStopReason } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentReport, FinalPart, StopReason } from "../host-protocol.ts";

export class EventTranslator {
  private messageSeq = 0;
  private currentMessageId: string | undefined;
  private readonly emit: (report: AgentReport) => void;
  /** 最近一条定稿的模型回复为什么停下（回合结束时据此判断结局） */
  lastStopReason: StopReason | undefined;
  lastErrorMessage: string | undefined;

  constructor(emit: (report: AgentReport) => void) {
    this.emit = emit;
  }

  handle(event: AgentSessionEvent): void {
    switch (event.type) {
      case "message_start":
        if (event.message.role === "assistant") this.currentMessageId = `msg-${++this.messageSeq}`;
        return;
      case "message_update": {
        const update = event.assistantMessageEvent;
        if (update.type === "text_delta" || update.type === "thinking_delta") {
          this.emit({
            type: "stream_delta",
            messageId: this.messageId(),
            part: update.type === "text_delta" ? "text" : "thinking",
            delta: update.delta,
          });
        }
        return;
      }
      case "message_end":
        if (event.message.role === "assistant") this.finalize(event.message);
        return;
      case "tool_execution_start":
        this.emit({ type: "tool_call_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
        return;
      case "tool_execution_end":
        this.emit({
          type: "tool_call_end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.isError,
          resultText: resultText(event.result),
        });
        return;
      default:
        return;
    }
  }

  private finalize(message: AssistantMessage): void {
    const messageId = this.messageId();
    this.currentMessageId = undefined;
    const stopReason = translateStopReason(message.stopReason);
    this.lastStopReason = stopReason;
    this.lastErrorMessage = message.errorMessage;
    const parts: FinalPart[] = message.content.map((block) => {
      switch (block.type) {
        case "text":
          return { type: "text", text: block.text };
        case "thinking":
          return { type: "thinking", text: block.thinking };
        case "toolCall":
          return { type: "tool_call", toolCallId: block.id, toolName: block.name, args: block.arguments };
      }
    });
    this.emit({
      type: "message_final",
      messageId,
      message: {
        role: "assistant",
        parts,
        stopReason,
        ...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
      },
    });
    const usage = message.usage;
    this.emit({
      type: "usage",
      messageId,
      provider: message.provider,
      modelId: message.model,
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      totalTokens: usage.totalTokens,
    });
  }

  private messageId(): string {
    this.currentMessageId ??= `msg-${++this.messageSeq}`;
    return this.currentMessageId;
  }
}

function translateStopReason(reason: PiStopReason): StopReason {
  switch (reason) {
    case "stop":
      return "done";
    case "toolUse":
      return "tool_calls";
    case "length":
      return "max_tokens";
    case "aborted":
      return "aborted";
    case "error":
    case "pending":
    case "deferred":
      // pending / deferred 不该出现在定稿消息上，出现了就当出错
      return "error";
  }
}

function resultText(result: unknown): string {
  const content = (result as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: { type?: string; text?: string }) => (block.type === "text" ? (block.text ?? "") : `[${block.type}]`))
    .join("\n");
}
