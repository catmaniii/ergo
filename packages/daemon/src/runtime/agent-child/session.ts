// 子进程里的 pi 会话：按装配参数建会话，接上事件翻译和守卫转发，管回合的开始与结束。
// 这里和 agent-child/ 下的其他文件是全仓库仅有的直接用 pi SDK 的地方（ADR-0001、ADR-0004）。
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import {
  errorReport,
  type AgentReport,
  type GuardVerdict,
  type HostToolResult,
  type LoadedResources,
  type ModelSpec,
  type SessionAssembly,
  type TurnOutcome,
} from "../host-protocol.ts";
import { EventTranslator } from "./event-translator.ts";
import { registerFauxModel } from "./faux.ts";
import { GuardForwarder } from "./guard-forwarding.ts";
import { HostToolBridge } from "./host-tools.ts";

/** 子进程里驱动一个 pi 会话的对象；main.ts 把宿主协议的命令转给它 */
export interface AgentSessionRunner {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly loaded: LoadedResources;
  /** 开始一个回合；上一回合没结束时回 busy */
  prompt(text: string): void;
  /** 插话：回合进行中排进去，下一次模型调用之前进入上下文 */
  interject(text: string): void;
  /** 守护进程的守卫判定 */
  replyGuard(requestId: string, verdict: GuardVerdict): void;
  /** 守护进程代为执行的工具的结果 */
  replyHostTool(requestId: string, result: HostToolResult): void;
  abort(): Promise<void>;
  dispose(): void;
}

export async function openAgentSession(
  assembly: SessionAssembly,
  emit: (report: AgentReport) => void,
): Promise<AgentSessionRunner> {
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

  const guard = new GuardForwarder(emit);
  const hostTools = new HostToolBridge(emit);
  const extensionFactories: InlineExtension[] = assembly.forwardToolCalls
    ? [{ name: "ergou-guard-forwarding", factory: guard.extension }]
    : [];

  // 设置只放内存，不读 ~/.pi/agent/settings.json 和工作目录里的 .pi/settings.json
  const settingsManager = SettingsManager.inMemory({});
  // 资源全部关掉，只加载装配参数里列出的 skill 和二狗自己的扩展；agentDir 指向二狗自己的空目录
  const resourceLoader = new DefaultResourceLoader({
    cwd: assembly.cwd,
    agentDir: assembly.piAgentDir,
    settingsManager,
    noExtensions: true,
    extensionFactories,
    noSkills: true,
    additionalSkillPaths: assembly.skillPaths,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    ...(assembly.systemPrompt === undefined ? {} : { systemPrompt: assembly.systemPrompt }),
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
    sessionManager: assembly.continueSession
      ? SessionManager.continueRecent(assembly.cwd, assembly.sessionDir)
      : SessionManager.create(assembly.cwd, assembly.sessionDir),
    // 白名单里加上守护进程代为执行的工具（白名单之外的工具都不启用，自定义工具也一样）
    tools: [...assembly.tools, ...assembly.hostTools.map((t) => t.name)],
    customTools: hostTools.tools(assembly.hostTools),
  });

  const loaded: LoadedResources = {
    tools: session.getActiveToolNames(),
    skills: resourceLoader.getSkills().skills.map((s) => s.name),
    contextFiles: resourceLoader.getAgentsFiles().agentsFiles.map((f) => f.path),
    extensions: resourceLoader.getExtensions().extensions.map((e) => e.path),
    credentialProviders: (await modelRuntime.listCredentials()).map((c) => c.providerId),
  };

  return new PiSessionRunner(session, loaded, emit, guard, hostTools);
}

function resolveModel(spec: ModelSpec, modelRuntime: ModelRuntime) {
  if (spec.kind === "faux") return registerFauxModel(spec, modelRuntime);
  const model = modelRuntime.getModel(spec.provider, spec.modelId);
  if (!model) throw new Error(`模型目录里没有 ${spec.provider}/${spec.modelId}`);
  return model;
}

class PiSessionRunner implements AgentSessionRunner {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly loaded: LoadedResources;
  private readonly session: AgentSession;
  private readonly emit: (report: AgentReport) => void;
  private readonly guard: GuardForwarder;
  private readonly hostTools: HostToolBridge;
  private readonly translator: EventTranslator;
  /** 已经开始、还没发 turn_end 的回合 */
  private turnOpen = false;

  constructor(session: AgentSession, loaded: LoadedResources, emit: (report: AgentReport) => void, guard: GuardForwarder, hostTools: HostToolBridge) {
    this.session = session;
    this.sessionId = session.sessionId;
    this.sessionFile = session.sessionFile ?? "";
    this.loaded = loaded;
    this.emit = emit;
    this.guard = guard;
    this.hostTools = hostTools;
    this.translator = new EventTranslator(emit);
    session.subscribe((event) => {
      this.translator.handle(event);
      if (event.type === "agent_settled") this.onSettled();
    });
  }

  prompt(text: string): void {
    if (this.turnOpen || this.session.isStreaming) {
      this.emit(errorReport("busy", "上一回合还没结束"));
      return;
    }
    this.turnOpen = true;
    this.translator.lastStopReason = undefined;
    this.session.prompt(text).catch((err: unknown) => {
      // 没能开始的回合不会有 agent_settled，这里补上回合结束
      const message = err instanceof Error ? err.message : String(err);
      this.emit(errorReport("internal", message));
      this.endTurn("error", message);
    });
  }

  interject(text: string): void {
    if (!this.turnOpen) {
      this.emit(errorReport("bad_command", "没有进行中的回合，插话应当作为用户输入送"));
      return;
    }
    this.session.steer(text).catch((err: unknown) => this.emit(errorReport("internal", String(err))));
  }

  replyGuard(requestId: string, verdict: GuardVerdict): void {
    if (!this.guard.reply(requestId, verdict)) {
      this.emit(errorReport("bad_command", `没有在等判定的守卫请求 ${requestId}`));
    }
  }

  replyHostTool(requestId: string, result: HostToolResult): void {
    if (!this.hostTools.reply(requestId, result)) {
      this.emit(errorReport("bad_command", `没有在等结果的工具调用 ${requestId}`));
    }
  }

  abort(): Promise<void> {
    return this.session.abort();
  }

  dispose(): void {
    this.session.dispose();
  }

  private onSettled(): void {
    const stop = this.translator.lastStopReason;
    const outcome: TurnOutcome = stop === "aborted" ? "aborted" : stop === "error" ? "error" : "completed";
    this.endTurn(outcome, outcome === "error" ? this.translator.lastErrorMessage : undefined);
  }

  private endTurn(outcome: TurnOutcome, errorMessage: string | undefined): void {
    if (!this.turnOpen) return;
    this.turnOpen = false;
    this.emit({ type: "turn_end", outcome, ...(errorMessage === undefined ? {} : { errorMessage }) });
  }
}
