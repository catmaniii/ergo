// 把宿主协议里的 faux 剧本变成 pi 的 faux provider（只在测试和契约测试里用，不连网）。
import {
  contentText,
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
  type TextContent,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { FauxModelSpec, FauxStep } from "../host-protocol.ts";

export const FAUX_PROVIDER_ID = "faux";
const FAUX_MODEL_ID = "faux-1";

/** 在这个 ModelRuntime 上注册一个按剧本回话的 faux provider，返回它的模型 */
export function registerFauxModel(spec: FauxModelSpec, modelRuntime: ModelRuntime): Model<string> {
  const faux = fauxProvider({
    provider: FAUX_PROVIDER_ID,
    models: [{ id: FAUX_MODEL_ID, name: "Faux" }],
    ...(spec.tokensPerSecond === undefined ? {} : { tokensPerSecond: spec.tokensPerSecond }),
  });
  faux.setResponses(spec.script.map(toResponseStep));
  modelRuntime.registerNativeProvider(faux.provider);
  return faux.getModel();
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
  }
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
        break;
      case "user":
        lines.push(`[user] ${userContent(message.content)}`);
        break;
      case "assistant":
        lines.push(`[assistant] ${message.content.map((b) => (b.type === "text" ? b.text : `<${b.type}>`)).join(" ")}`);
        break;
      case "toolResult":
        lines.push(`[toolResult] ${message.toolName}: ${contentText(message.content)}`);
        break;
    }
  }
  return lines.join("\n");
}
