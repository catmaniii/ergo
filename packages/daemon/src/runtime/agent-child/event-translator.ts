// pi 会话事件 → 宿主协议消息（只管消息、工具调用和用量；回合的开始和结束由 AgentSessionRunner 管）。
// pi 的词汇（stopReason 等）在这里换成二狗自己的。
// 用量（24 号票）：每条模型回复定稿时报一条；压缩会话（手动或自动）生成摘要的那次模型调用，在压缩结束时报一条（purpose: compaction）。
// 压缩结束（114 号票）：每次都报一条 compacted（压好了、没什么可压的、被中止、没压成），pi 的说法在这里换成二狗的。
import type { AssistantMessage, StopReason as PiStopReason, Usage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ToolResultMedia } from "@ergou/protocol";
import type { AgentReport, CompactedReport, FinalPart, StopReason, UsagePurpose } from "../host-protocol.ts";

export class EventTranslator {
  private messageSeq = 0;
  private compactionSeq = 0;
  /** 最近一条回复是哪个模型的（压缩那次的用量报告沿用它） */
  private provider: string;
  private modelId: string;
  private currentMessageId: string | undefined;
  private readonly emit: (report: AgentReport) => void;
  /** 最近一条定稿的模型回复为什么停下（回合结束时据此判断结局） */
  lastStopReason: StopReason | undefined;
  lastErrorMessage: string | undefined;

  /** model 是会话的模型（压缩那次的用量报告用它；之后以每条回复上写的为准） */
  constructor(emit: (report: AgentReport) => void, model?: { provider: string; id: string }) {
    this.emit = emit;
    this.provider = model?.provider ?? "";
    this.modelId = model?.id ?? "";
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
      case "compaction_end":
        // 压缩生成摘要的那次模型调用（pi 给了用量才报；中止、出错没有结果的不报）
        if (event.result?.usage) this.emitUsage(`compaction-${++this.compactionSeq}`, event.result.usage, "compaction");
        this.emit(compactedReport(event));
        return;
      case "tool_execution_end": {
        const media = resultMedia(event.result);
        this.emit({
          type: "tool_call_end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.isError,
          resultText: resultText(event.result),
          ...(media.length > 0 ? { media } : {}),
        });
        return;
      }
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
    this.provider = message.provider;
    this.modelId = message.model;
    this.emitUsage(messageId, message.usage);
  }

  private emitUsage(messageId: string, usage: Usage, purpose?: UsagePurpose): void {
    this.emit(usageReport(messageId, usage, { provider: this.provider, modelId: this.modelId }, purpose));
  }

  private messageId(): string {
    this.currentMessageId ??= `msg-${++this.messageSeq}`;
    return this.currentMessageId;
  }
}

/**
 * pi 的用量 → 宿主协议的 usage（三块输入原样：cacheRead 命中，input 和 cacheWrite 没命中）。
 * 会话里的回复、压缩那次在这里报；范围审视在会话之外另开的那一次（scope-review.ts）也用它
 */
export function usageReport(messageId: string, usage: Usage, model: { provider: string; modelId: string }, purpose?: UsagePurpose): AgentReport {
  return {
    type: "usage",
    messageId,
    provider: model.provider,
    modelId: model.modelId,
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    ...(purpose === undefined ? {} : { purpose }),
  };
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

/** pi 工具结果里的内容块 */
type ResultBlock = { type?: string; text?: string; data?: unknown; mimeType?: unknown };

function resultBlocks(result: unknown): ResultBlock[] {
  const content = (result as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? (content as ResultBlock[]) : [];
}

/** 结果里的文字；非文字的块（图片）换成 [image] 这样的占位，内容不往外送 */
function resultText(result: unknown): string {
  return resultBlocks(result)
    .map((block) => (block.type === "text" ? (block.text ?? "") : `[${block.type}]`))
    .join("\n");
}

/** 结果里非文字的块是什么、多大（图片的 data 是 base64：按解出来的字节数算）（53 号票） */
function resultMedia(result: unknown): ToolResultMedia[] {
  return resultBlocks(result)
    .filter((block) => block.type !== "text")
    .map((block) => ({
      type: String(block.type),
      ...(typeof block.mimeType === "string" ? { mimeType: block.mimeType } : {}),
      ...(typeof block.data === "string" ? { bytes: Buffer.byteLength(block.data, "base64") } : {}),
    }));
}

/** pi 说"没什么可压的"的两种（会话太短、刚压过）：不算没压成 */
const NOTHING_TO_COMPACT = /Nothing to compact|Already compacted/;

/** pi 的压缩结束事件 → 宿主协议的 compacted（114 号票） */
function compactedReport(event: Extract<AgentSessionEvent, { type: "compaction_end" }>): CompactedReport {
  const reason = event.reason;
  if (event.result) return { type: "compacted", reason, outcome: "done", tokensBefore: event.result.tokensBefore };
  if (event.aborted) return { type: "compacted", reason, outcome: "aborted" };
  const error = event.errorMessage ?? "压缩出错了";
  if (NOTHING_TO_COMPACT.test(error)) return { type: "compacted", reason, outcome: "nothing" };
  return { type: "compacted", reason, outcome: "failed", error: error.replace(/^Compaction failed: /, "") };
}
