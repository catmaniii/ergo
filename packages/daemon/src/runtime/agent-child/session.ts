// 子进程里的 pi 会话：按装配参数建会话，把 pi 的会话事件翻译成宿主协议消息。
// 这是全仓库唯一直接用 pi SDK 的地方（ADR-0001、ADR-0004）。
import { InMemoryCredentialStore, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { AgentReport, FinalPart, LoadedResources, ModelSpec, SessionAssembly, TurnOutcome } from "../host-protocol.ts";
import { registerFauxModel } from "./faux.ts";

export interface AgentSessionHost {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly loaded: LoadedResources;
  /** 送一条用户输入；上一回合没结束时报 busy */
  prompt(text: string): void;
  abort(): Promise<void>;
  dispose(): void;
}

export async function openAgentSession(
  assembly: SessionAssembly,
  emit: (report: AgentReport) => void,
): Promise<AgentSessionHost> {
  // 凭据只放内存：不读 ~/.pi/agent/auth.json，也不读 models.json，不连网刷新模型目录
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  for (const [provider, apiKey] of Object.entries(assembly.credentials)) {
    await modelRuntime.setRuntimeApiKey(provider, apiKey);
  }
  const model = resolveModel(assembly.model, modelRuntime);

  // 设置只放内存，不读 ~/.pi/agent/settings.json 和项目里的 .pi/settings.json
  const settingsManager = SettingsManager.inMemory({});
  // 资源全部关掉，只加载装配参数里列出的 skill；agentDir 指向二狗自己的空目录
  const resourceLoader = new DefaultResourceLoader({
    cwd: assembly.cwd,
    agentDir: assembly.piAgentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    additionalSkillPaths: assembly.skillPaths,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: assembly.cwd,
    agentDir: assembly.piAgentDir,
    modelRuntime,
    model,
    thinkingLevel: assembly.model.thinkingLevel,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.create(assembly.cwd, assembly.sessionDir),
    tools: assembly.tools,
  });

  const loaded: LoadedResources = {
    tools: session.getActiveToolNames(),
    skills: resourceLoader.getSkills().skills.map((s) => s.name),
    contextFiles: resourceLoader.getAgentsFiles().agentsFiles.map((f) => f.path),
    extensions: resourceLoader.getExtensions().extensions.map((e) => e.path),
    credentialProviders: (await modelRuntime.listCredentials()).map((c) => c.providerId),
  };

  const translator = new EventTranslator(emit);
  session.subscribe((event) => translator.handle(event));

  return {
    sessionId: session.sessionId,
    sessionFile: session.sessionFile ?? "",
    loaded,
    prompt: (text) => translator.prompt(session, text),
    abort: () => session.abort(),
    dispose: () => session.dispose(),
  };
}

function resolveModel(spec: ModelSpec, modelRuntime: ModelRuntime) {
  if (spec.kind === "faux") return registerFauxModel(spec, modelRuntime);
  const model = modelRuntime.getModel(spec.provider, spec.modelId);
  if (!model) throw new Error(`模型目录里没有 ${spec.provider}/${spec.modelId}`);
  return model;
}

/** pi 会话事件 → 宿主协议消息 */
class EventTranslator {
  private messageSeq = 0;
  private currentMessageId: string | undefined;
  private lastAssistant: AssistantMessage | undefined;
  /** 已送出用户输入、还没发 turn_end */
  private turnOpen = false;
  private readonly emit: (report: AgentReport) => void;

  constructor(emit: (report: AgentReport) => void) {
    this.emit = emit;
  }

  prompt(session: AgentSession, text: string): void {
    if (this.turnOpen || session.isStreaming) {
      this.emit({ type: "error", code: "busy", message: "上一回合还没结束", fatal: false });
      return;
    }
    this.turnOpen = true;
    this.lastAssistant = undefined;
    session.prompt(text).catch((err: unknown) => {
      // 没能开始的回合不会有 agent_settled，这里补上回合结束
      const message = err instanceof Error ? err.message : String(err);
      this.emit({ type: "error", code: "internal", message, fatal: false });
      this.endTurn("error", message);
    });
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
      case "agent_settled": {
        const stop = this.lastAssistant?.stopReason;
        const outcome: TurnOutcome = stop === "aborted" ? "aborted" : stop === "error" ? "error" : "completed";
        this.endTurn(outcome, outcome === "error" ? this.lastAssistant?.errorMessage : undefined);
        return;
      }
      default:
        return;
    }
  }

  private finalize(message: AssistantMessage): void {
    const messageId = this.messageId();
    this.currentMessageId = undefined;
    this.lastAssistant = message;
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
        stopReason: message.stopReason,
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

  private endTurn(outcome: TurnOutcome, errorMessage: string | undefined): void {
    if (!this.turnOpen) return;
    this.turnOpen = false;
    this.emit({ type: "turn_end", outcome, ...(errorMessage === undefined ? {} : { errorMessage }) });
  }

  private messageId(): string {
    this.currentMessageId ??= `msg-${++this.messageSeq}`;
    return this.currentMessageId;
  }
}

function resultText(result: unknown): string {
  const content = (result as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: { type?: string; text?: string }) => (block.type === "text" ? (block.text ?? "") : `[${block.type}]`))
    .join("\n");
}
