// 把宿主协议里的 faux 剧本变成 pi 的 faux provider（只在测试和契约测试里用，不连网）。
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  getSystemMessageText,
  type FauxContentBlock,
  type FauxResponseStep,
  type Model,
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

/** 这次模型调用看到的系统提示和工具 */
function renderContext(context: TranscriptContext): string {
  const lines: string[] = [];
  for (const message of context.messages) {
    if (message.role !== "system") continue;
    lines.push(getSystemMessageText(message));
    for (const tool of message.toolsAdded ?? []) lines.push(`[tool] ${tool.name}`);
  }
  return lines.join("\n");
}
