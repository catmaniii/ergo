// Agent SDK 的消息 → 宿主协议的上报（287 号票，issue 24 方案 2.4）：只管回复、工具调用和用量；轮次的开始和结束、压缩由 session.ts 管。
// SDK 的词汇在这里换成二狗自己的，宿主协议里不出现 SDK 的类型。
// - 逐字输出：stream_event（includePartialMessages）里主线的 text_delta / thinking_delta → stream_delta；
// - 一条回复：SDK 每完成一个内容块发一条 assistant（同一次模型调用的几条 message.id 相同），这里按 message.id 攒齐，
//   到 message_stop（或者下一条回复、工具结果、这一轮结束先到了）发一条 message_final——再给其中的每次工具调用发 tool_call_start
//   （和 pi 一样：定稿在前、工具调用开始在后），再报这次模型调用的用量；
// - 工具结果：user 消息里的 tool_result 块 → tool_call_end（非文字的块换成 [image] 这样的占位，media 列出是什么、多大；守卫要在结果前面
//   加的话加在 resultText 开头，288 号票）。守卫的钩子比回复先到时由钩子先报 tool_call_start（ensureStarted），定稿时不再重复报；
// - 子代理（parent_tool_use_id 不是空的）：只转工具调用（tool_call_start / tool_call_end 带 parentToolCallId，挂在调用它的 Agent 工具下面），
//   它的正文和逐字输出不转（SDK 默认也不转发子代理的正文，forwardSubagentText 没开）；
// - 用量：每次模型调用一条（和 pi 一样，⚙ 的上下文用量按"最近一次调用"算）——message_start 带输入的三段，message_delta 带最终的输出；
//   没有逐字输出（流里没有 message_start）时用 assistant 消息上的 usage。provider 记成 claude-code（订阅额度，不按价目表算钱）；
// - 斜杠命令在本地执行的输出（system/local_command_output）→ 一条回复（slash_passthrough：/context、/usage 这类的结果给人看得到）。
// - 291 号票：二狗交给 Claude 的工具（进程内 MCP 服务 ergo，host-tools.ts）在 Claude 那边叫 mcp__ergo__<工具名>，报给守护进程时换回二狗的名字
//   （定稿里的工具调用、tool_call_start / tool_call_end）：网页照 pi 的画、守护进程按名字找超时和中文名；工具包里的 MCP 两边同名，不用换。
// 压缩那一轮（suppress）的输出不当成回复。别的消息不认得的一律不管（官方建议，SDK 的消息种类还在加）。
import type { SDKAssistantMessage, SDKPartialAssistantMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ToolResultMedia } from "@ergo/protocol";
import type { AgentReport, FinalPart, StopReason } from "../../runtime/host-protocol.ts";
import { hostToolNameOf } from "./host-tools.ts";

/** 用量报告里的 provider：Claude Code 运行时（本机登录的订阅额度） */
export const CLAUDE_USAGE_PROVIDER = "claude-code";

/** 内容块（只看用到的几个字段；SDK 的块种类还在加，不认得的不管） */
interface LooseBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
  source?: { media_type?: unknown; data?: unknown };
}

/** API 的用量（message_start、message_delta、assistant 消息上的） */
interface LooseUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** 正在攒的一条回复（一次模型调用） */
interface Draft {
  messageId: string;
  parts: FinalPart[];
  /** API 的 stop_reason（message_delta、assistant 消息上的） */
  stopReason?: string | null;
  /** 工具调用 id → Claude 的工具名（定稿里的是换成二狗的名字之后的） */
  natives: Map<string, string>;
  aborted: boolean;
  /** 出错的回复（SDK 的 error：rate_limit、authentication_failed……） */
  error?: string;
  model?: string;
  usage?: Usage;
}

/** 工具调用要调的工具都是这几种块 */
const TOOL_USE_BLOCKS = new Set(["tool_use", "server_tool_use", "mcp_tool_use"]);

export class ClaudeTranslator {
  private seq = 0;
  private readonly drafts = new Map<string, Draft>();
  /** 主线正在攒的那条（Claude 的 message.id） */
  private current: string | undefined;
  /**
   * 报过 tool_call_start、还没结束的工具调用：id → 报的工具名（tool_call_end 要带）、Claude 的工具名、二狗的工具认领过没有
   * （进程内 MCP 服务的调用没带 id 时按 Claude 的工具名认领，openCallId）
   */
  private readonly toolNames = new Map<string, { name: string; native: string; claimed: boolean }>();
  /**
   * 工具调用结束时结果前面要加的话（288 号票：守卫按计划改了参数时写明实际执行的是哪一版，child/guard.ts 的 takePrefix）；
   * 记录里的 resultText 和 pi 的一样以它开头
   */
  takePrefix: ((toolCallId: string) => string | undefined) | undefined;
  /** 这一轮里报过用量没有（没有的话这一轮结束时按 result 的用量兜底） */
  usageReported = false;
  /** 这一轮最近一条定稿的回复（二狗这边的 id）、它的模型 */
  lastMessageId: string | undefined;
  lastModel: string | undefined;
  /** 压缩那一轮：输出不当成回复 */
  suppress = false;

  private readonly emit: (report: AgentReport) => void;

  constructor(emit: (report: AgentReport) => void) {
    this.emit = emit;
  }

  /** 一轮开始（这一轮的用量、最近一条回复从头算） */
  beginTurn(): void {
    this.usageReported = false;
    this.lastMessageId = undefined;
  }

  assistant(msg: SDKAssistantMessage): void {
    const blocks = asBlocks(msg.message?.content);
    if (msg.parent_tool_use_id) {
      // 子代理：只转工具调用（守卫的钩子先到、已经报过开始的不再报）
      for (const block of blocks) {
        if (block.type && TOOL_USE_BLOCKS.has(block.type) && block.id && !this.toolNames.has(block.id)) this.toolStart(block.id, block.name ?? "", block.input ?? {}, msg.parent_tool_use_id);
      }
      return;
    }
    if (this.suppress) return;
    // 定稿之后同一条回复又来了块（按说不会：块都在 message_stop 之前）：定稿的已经拿掉了，另起一条，别丢内容
    const claudeId = typeof msg.message?.id === "string" && msg.message.id ? msg.message.id : `anon-${msg.uuid}`;
    const draft = this.draftFor(claudeId);
    for (const block of blocks) {
      if (block.type === "text" && typeof block.text === "string") draft.parts.push({ type: "text", text: block.text });
      else if (block.type === "thinking" && typeof block.thinking === "string") draft.parts.push({ type: "thinking", text: block.thinking });
      else if (block.type && TOOL_USE_BLOCKS.has(block.type) && block.id) {
        draft.parts.push({ type: "tool_call", toolCallId: block.id, toolName: hostToolNameOf(block.name ?? ""), args: block.input ?? {} });
        draft.natives.set(block.id, block.name ?? "");
      }
    }
    const message = msg.message as { stop_reason?: string | null; model?: string; usage?: LooseUsage } | undefined;
    if (message?.stop_reason) draft.stopReason = message.stop_reason;
    if (typeof message?.model === "string" && message.model) draft.model = message.model;
    if (!draft.usage && message?.usage) draft.usage = usageOf(message.usage);
    if (msg.aborted) draft.aborted = true;
    if (msg.error) draft.error = msg.error;
  }

  stream(msg: SDKPartialAssistantMessage): void {
    if (msg.parent_tool_use_id || this.suppress) return;
    const event = msg.event as { type?: string; message?: { id?: string; model?: string; usage?: LooseUsage }; delta?: { type?: string; text?: string; thinking?: string; stop_reason?: string | null }; usage?: LooseUsage };
    switch (event.type) {
      case "message_start": {
        const claudeId = event.message?.id;
        if (!claudeId) return;
        const draft = this.draftFor(claudeId);
        if (typeof event.message?.model === "string" && event.message.model) draft.model = event.message.model;
        if (event.message?.usage) draft.usage = usageOf(event.message.usage);
        return;
      }
      case "content_block_delta": {
        const draft = this.current === undefined ? undefined : this.drafts.get(this.current);
        if (!draft) return;
        if (event.delta?.type === "text_delta" && event.delta.text) this.emit({ type: "stream_delta", messageId: draft.messageId, part: "text", delta: event.delta.text });
        else if (event.delta?.type === "thinking_delta" && event.delta.thinking) this.emit({ type: "stream_delta", messageId: draft.messageId, part: "thinking", delta: event.delta.thinking });
        return;
      }
      case "message_delta": {
        const draft = this.current === undefined ? undefined : this.drafts.get(this.current);
        if (!draft) return;
        if (event.delta?.stop_reason) draft.stopReason = event.delta.stop_reason;
        if (event.usage) draft.usage = mergeUsage(draft.usage, event.usage);
        return;
      }
      case "message_stop":
        if (this.current !== undefined) this.flush(this.current);
        return;
      default:
        return;
    }
  }

  user(msg: SDKUserMessage): void {
    if ((msg as { isReplay?: boolean }).isReplay) return;
    const content = msg.message?.content;
    if (!Array.isArray(content)) return;
    const results = (content as LooseBlock[]).filter((block) => block.type === "tool_result" && typeof block.tool_use_id === "string");
    if (results.length === 0) return;
    // 主线的工具结果回来了：这次模型调用的回复早就完了
    if (!msg.parent_tool_use_id) this.flushAll();
    for (const block of results) {
      const toolCallId = block.tool_use_id!;
      const media = resultMedia(block.content);
      const prefix = this.takePrefix?.(toolCallId);
      const text = resultText(block.content);
      this.emit({
        type: "tool_call_end",
        toolCallId,
        toolName: this.toolNames.get(toolCallId)?.name ?? "",
        isError: block.is_error === true,
        resultText: prefix === undefined ? text : [prefix, text].join("\n"),
        ...(media.length > 0 ? { media } : {}),
        ...(msg.parent_tool_use_id ? { parentToolCallId: msg.parent_tool_use_id } : {}),
      });
      this.toolNames.delete(toolCallId);
    }
  }

  /** 斜杠命令在本地执行的输出：当成一条回复 */
  localOutput(text: string): void {
    if (this.suppress || !text) return;
    this.flushAll();
    const messageId = this.nextId();
    this.emit({ type: "message_final", messageId, message: { role: "assistant", parts: [{ type: "text", text }], stopReason: "done" } });
    this.lastMessageId = messageId;
  }

  /**
   * 守卫的钩子要发判定请求了（288 号票）：这次调用还没报过开始的现在报——Claude Code 一块工具调用写完就可能开始执行，钩子会比那条回复的
   * message_stop 先到；之后那条回复定稿时不再重复报
   */
  ensureStarted(toolCallId: string, toolName: string, args: unknown): void {
    if (!this.toolNames.has(toolCallId)) this.toolStart(toolCallId, toolName, args);
  }

  /**
   * 进程内 MCP 服务的调用没带调用 id 时（291 号票，老版本的 Claude Code）：Claude 的工具名是这个、报过开始还没结束、没被认领过的最早那次的 id
   */
  openCallId(claudeName: string): string | undefined {
    for (const [id, call] of this.toolNames) {
      if (call.native !== claudeName || call.claimed) continue;
      call.claimed = true;
      return id;
    }
    return undefined;
  }

  /** 攒着的都定稿（这一轮结束、压缩边界、工具结果之前） */
  flushAll(): void {
    // flush 只拿掉自己这一条：Map 边遍历边删当前这条是安全的
    for (const claudeId of this.drafts.keys()) this.flush(claudeId);
  }

  /** 压缩那一轮开始、子进程收尾：没定稿的扔掉 */
  discard(): void {
    this.drafts.clear();
    this.current = undefined;
  }

  private draftFor(claudeId: string): Draft {
    let draft = this.drafts.get(claudeId);
    if (!draft) {
      // 主线换了一条回复：上一条完了
      if (this.current !== undefined && this.current !== claudeId) this.flush(this.current);
      draft = { messageId: this.nextId(), parts: [], natives: new Map(), aborted: false };
      this.drafts.set(claudeId, draft);
    }
    this.current = claudeId;
    return draft;
  }

  private flush(claudeId: string): void {
    const draft = this.drafts.get(claudeId);
    if (this.current === claudeId) this.current = undefined;
    if (!draft) return;
    this.drafts.delete(claudeId);
    const calls = draft.parts.filter((p): p is Extract<FinalPart, { type: "tool_call" }> => p.type === "tool_call");
    // 出错的回复：SDK 把出错的说明放在正文里，挪进 errorMessage（不当成 agent 说的话）
    const errorText = draft.error === undefined ? undefined : draft.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n") || draft.error;
    const parts = draft.error === undefined ? draft.parts : draft.parts.filter((p) => p.type !== "text");
    this.emit({
      type: "message_final",
      messageId: draft.messageId,
      message: { role: "assistant", parts, stopReason: stopReasonOf(draft, calls.length > 0), ...(errorText === undefined ? {} : { errorMessage: errorText }) },
    });
    // 守卫的钩子先到、已经报过开始的（ensureStarted）不再报
    for (const call of calls) if (!this.toolNames.has(call.toolCallId)) this.toolStart(call.toolCallId, draft.natives.get(call.toolCallId) ?? call.toolName, call.args);
    if (draft.model) this.lastModel = draft.model;
    this.lastMessageId = draft.messageId;
    if (draft.usage && totalOf(draft.usage) > 0) {
      this.usageReported = true;
      this.emit(usageReport(draft.messageId, draft.model ?? this.lastModel ?? "", draft.usage));
    }
  }

  /** 报一次工具调用开始：native 是 Claude 的工具名，报的是二狗的（mcp__ergo__<名字> 换回 <名字>） */
  private toolStart(toolCallId: string, native: string, args: unknown, parentToolCallId?: string): void {
    const toolName = hostToolNameOf(native);
    this.toolNames.set(toolCallId, { name: toolName, native, claimed: false });
    this.emit({ type: "tool_call_start", toolCallId, toolName, args, ...(parentToolCallId ? { parentToolCallId } : {}) });
  }

  private nextId(): string {
    return `msg-${++this.seq}`;
  }
}

/** API 的用量 → 宿主协议的四段（input 是没命中缓存、也没写进缓存的部分，和 pi 的一样三块互不重叠） */
export function usageOf(usage: LooseUsage): Usage {
  return {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
  };
}

/** message_delta 的用量盖过 message_start 的（输出是最终的；有输入的几段也以它为准） */
function mergeUsage(base: Usage | undefined, delta: LooseUsage): Usage {
  const from = base ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return {
    input: delta.input_tokens ?? from.input,
    output: delta.output_tokens ?? from.output,
    cacheRead: delta.cache_read_input_tokens ?? from.cacheRead,
    cacheWrite: delta.cache_creation_input_tokens ?? from.cacheWrite,
  };
}

const totalOf = (u: Usage) => u.input + u.output + u.cacheRead + u.cacheWrite;

export function usageReport(messageId: string, modelId: string, usage: Usage, purpose?: "compaction" | "handoff"): AgentReport {
  return {
    type: "usage",
    messageId,
    provider: CLAUDE_USAGE_PROVIDER,
    modelId,
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: totalOf(usage),
    ...(purpose === undefined ? {} : { purpose }),
  };
}

/** 一条回复为什么停下：被打断的、出错的先看；再看 API 的 stop_reason；都没有时按有没有工具调用 */
function stopReasonOf(draft: Draft, hasCalls: boolean): StopReason {
  if (draft.aborted) return "aborted";
  if (draft.error !== undefined) return "error";
  switch (draft.stopReason) {
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "max_tokens";
    default:
      // end_turn、stop_sequence、pause_turn、refusal，或者还不知道（流里没有 message_delta）
      return hasCalls ? "tool_calls" : "done";
  }
}

function asBlocks(content: unknown): LooseBlock[] {
  return Array.isArray(content) ? (content as LooseBlock[]) : [];
}

/** 工具结果里的文字；非文字的块（图片）换成 [image] 这样的占位，内容不往外送 */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  return asBlocks(content)
    .map((block) => (block.type === "text" ? (block.text ?? "") : `[${block.type ?? "unknown"}]`))
    .join("\n");
}

/** 结果里非文字的块是什么、多大（base64 按解出来的字节数算），同 pi 那边（53 号票） */
function resultMedia(content: unknown): ToolResultMedia[] {
  return asBlocks(content)
    .filter((block) => block.type !== "text")
    .map((block) => ({
      type: String(block.type),
      ...(typeof block.source?.media_type === "string" ? { mimeType: block.source.media_type } : {}),
      ...(typeof block.source?.data === "string" ? { bytes: Buffer.byteLength(block.source.data, "base64") } : {}),
    }));
}
