// 把宿主协议里的 faux 剧本变成 pi 的 faux provider（只在测试和契约测试里用，不连网）。
import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  contentText,
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  getSystemMessageText,
  type FauxContentBlock,
  type FauxResponseStep,
  type ImageContent,
  type Model,
  type Provider,
  type TextContent,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { FauxModelSpec, FauxStep, FauxUsage } from "../host-protocol.ts";

export const FAUX_PROVIDER_ID = "faux";
const FAUX_MODEL_ID = "faux-1";

/** 范围审视用的模型是 faux 时（18 号票）注册成另一个 provider：和会话的 faux 各按各的剧本 */
export const FAUX_REVIEW_PROVIDER_ID = "faux-review";

/** 在这个 ModelRuntime 上注册一个按剧本回话的 faux provider（provider id 默认 faux），返回它的模型 */
export function registerFauxModel(spec: FauxModelSpec, modelRuntime: ModelRuntime, providerId = FAUX_PROVIDER_ID): Model<string> {
  const faux = fauxProvider({
    provider: providerId,
    models: [{ id: FAUX_MODEL_ID, name: "Faux" }],
    ...(spec.tokensPerSecond === undefined ? {} : { tokensPerSecond: spec.tokensPerSecond }),
  });
  faux.setResponses(spec.script.map(toResponseStep));
  const usages = spec.script.map((step) => (step.kind === "reply" ? step.usage : undefined));
  modelRuntime.registerNativeProvider(usages.some((u) => u !== undefined) ? withScriptedUsage(faux.provider, usages) : faux.provider);
  return faux.getModel();
}

/**
 * faux provider 总是按上下文估算用量（覆盖掉回复里写的）；剧本给了用量的那几次调用，在流的出口换成剧本的：
 * 第 n 次调用对应剧本的第 n 步（faux 自己也是一次调用取一步）。命中缓存的记 cacheRead，没命中的记 input
 */
function withScriptedUsage(provider: Provider, usages: ReadonlyArray<FauxUsage | undefined>): Provider {
  let calls = 0;
  return {
    ...provider,
    stream: (model, context, options) => wrap(provider.stream(model, context, options), usages[calls++]),
    streamSimple: (model, context, options) => wrap(provider.streamSimple(model, context, options), usages[calls++]),
  };
}

function toResponseStep(step: FauxStep): FauxResponseStep {
  switch (step.kind) {
    case "reply": {
      const content: FauxContentBlock[] = [];
      if (step.thinking !== undefined) content.push(fauxThinking(step.thinking));
      if (step.text !== undefined) content.push(fauxText(step.text));
      for (const call of step.toolCalls ?? []) content.push(fauxToolCall(call.name, call.arguments));
      return fauxAssistantMessage(content, { stopReason: step.toolCalls?.length ? "toolUse" : "stop" });
    }
    case "echo_context":
      return (context: TranscriptContext) => fauxAssistantMessage(renderContext(context));
    case "reply_with_context":
      // {{context}} 换成看到的上下文，按 JSON 字符串转义（回复本身是一段 JSON 时照样能解析）
      return (context: TranscriptContext) => fauxAssistantMessage(step.text.replaceAll("{{context}}", JSON.stringify(renderContext(context)).slice(1, -1)));
    case "context_overflow":
      // pi 按出错信息认上下文溢出（"prompt is too long" 是它认的写法之一）
      return fauxAssistantMessage([], { stopReason: "error", errorMessage: "prompt is too long: context window exceeded (faux)" });
    case "call_with_matches":
      return (context: TranscriptContext) => {
        const last = context.messages.findLast((m) => m.role === "toolResult");
        const text = last?.role === "toolResult" ? contentText(last.content) : "";
        const matches = [...new Set(Array.from(text.matchAll(new RegExp(step.pattern, "g")), (m) => m[0]))];
        const args = withPath(step.toolCall.arguments, step.argument.split("."), matches) as Parameters<typeof fauxToolCall>[1];
        return fauxAssistantMessage([fauxToolCall(step.toolCall.name, args)], { stopReason: "toolUse" });
      };
  }
}

/** 在参数里按路径（"params.materialIds"）放进一个值（不改原来的对象） */
function withPath(target: Record<string, unknown>, keys: readonly string[], value: unknown): Record<string, unknown> {
  const [head, ...rest] = keys;
  if (head === undefined) return target;
  const inner = target[head];
  const next = rest.length === 0 ? value : withPath(typeof inner === "object" && inner !== null ? (inner as Record<string, unknown>) : {}, rest, value);
  return { ...target, [head]: next };
}

/** 这次调用的流：剧本给了用量就在出口换上，没给原样 */
function wrap(inner: AssistantMessageEventStream, usage: FauxUsage | undefined): AssistantMessageEventStream {
  if (!usage) return inner;
  const outer = createAssistantMessageEventStream();
  void (async () => {
    for await (const event of inner) outer.push(patchEvent(event, usage));
    outer.end(patched(await inner.result(), usage));
  })();
  return outer;
}

/** 定稿消息的用量换成剧本给的 */
function patched(message: AssistantMessage, usage: FauxUsage): AssistantMessage {
  return {
    ...message,
    usage: {
      ...message.usage,
      input: usage.cacheMiss,
      cacheRead: usage.cacheHit,
      cacheWrite: 0,
      output: usage.output,
      totalTokens: usage.cacheHit + usage.cacheMiss + usage.output,
    },
  };
}

/** 流里带定稿消息的事件（done、error）换上剧本给的用量 */
function patchEvent(event: AssistantMessageEvent, usage: FauxUsage): AssistantMessageEvent {
  if (event.type === "done") return { ...event, message: patched(event.message, usage) };
  if (event.type === "error") return { ...event, error: patched(event.error, usage) };
  return event;
}

/** 用户消息的内容：文字原样，图片写成 [image 类型] */
function userContent(content: string | readonly (TextContent | ImageContent)[]): string {
  if (typeof content === "string") return content;
  return content.map((block) => (block.type === "text" ? block.text : `[image ${block.mimeType}]`)).join("\n");
}

/** 这次模型调用看到的上下文：系统提示、工具，以及按顺序排列的每条消息 */
function renderContext(context: TranscriptContext): string {
  const lines: string[] = [];
  for (const message of context.messages) {
    switch (message.role) {
      case "system":
        lines.push(`[system] ${getSystemMessageText(message)}`);
        for (const tool of message.toolsAdded ?? []) lines.push(`[tool] ${tool.name}`);
        // 换了一套工具包接着会话时（27 号票），pi 记一条系统消息写明加了、去掉了哪些工具；faux 认会话中途的系统消息，照原样列出
        // （不认的模型，pi 把更新后的系统提示放回开头、工具整份重发）
        for (const tool of message.toolsRemoved ?? []) lines.push(`[tool-removed] ${tool.name}`);
        break;
      case "user":
        lines.push(`[user] ${userContent(message.content)}`);
        break;
      case "assistant":
        lines.push(`[assistant] ${message.content.map((b) => (b.type === "text" ? b.text : `<${b.type}>`)).join(" ")}`);
        break;
      case "toolResult": {
        // 结果里的图片（79 号票：读取附件读图）跟在文字后面，写成 [image 类型]
        const images = message.content.flatMap((block) => (block.type === "image" ? [`[image ${block.mimeType}]`] : []));
        lines.push(`[toolResult] ${message.toolName}: ${[contentText(message.content), ...images].join("\n")}`);
        break;
      }
    }
  }
  return lines.join("\n");
}
