// 子进程里的 pi 会话：按装配参数建会话，接上事件翻译和守卫转发，管回合的开始与结束。
// 这里和 agent-child/ 下的其他文件是全仓库仅有的直接用 pi SDK 的地方（ADR-0001、ADR-0004）。
import fs from "node:fs";
import path from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createBashToolDefinition,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type InlineExtension,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  errorReport,
  type AgentReport,
  type GuardVerdict,
  type HostToolResult,
  type InputImage,
  type LoadedResources,
  type ModelSpec,
  SESSION_INPUT_TAG,
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
  /** 开始一个回合（支持视觉的模型另外带图片）；上一回合没结束时回 busy */
  prompt(inputId: string, text: string, images: readonly InputImage[]): void;
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
    sessionManager: assembly.continueSession ? continueRecent(assembly) : SessionManager.create(assembly.cwd, assembly.sessionDir),
    // 白名单里加上守护进程代为执行的工具（白名单之外的工具都不启用，自定义工具也一样）
    tools: [...assembly.tools, ...assembly.hostTools.map((t) => t.name)],
    customTools: [...hostTools.tools(assembly.hostTools), ...shellOverrides(assembly)],
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

/**
 * 接着会话目录里最近的会话（按修改时间；没有就新开）。pi 的 continueRecent 在指定了会话目录时只挑工作目录相同的会话，
 * 二狗一个 agent 一个会话目录，工作目录变了（任务转为项目、绑定外部工作目录，15 号票）也要接着同一个会话，
 * 所以自己挑最近的那个、用新的工作目录打开（工具按新的工作目录）
 */
function continueRecent(assembly: SessionAssembly): SessionManager {
  const recent = mostRecentSessionFile(assembly.sessionDir);
  return recent ? SessionManager.open(recent, assembly.sessionDir, assembly.cwd) : SessionManager.create(assembly.cwd, assembly.sessionDir);
}

/** 会话目录里修改时间最近的会话文件；目录还没有（第一次拉起）或是空的时为 undefined */
function mostRecentSessionFile(sessionDir: string): string | undefined {
  try {
    return fs
      .readdirSync(sessionDir)
      .filter((file) => file.endsWith(".jsonl"))
      .map((file) => path.join(sessionDir, file))
      .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
      .toSorted((a, b) => b.mtime - a.mtime)[0]?.file;
  } catch {
    // 会话目录还没有（第一次拉起）
    return undefined;
  }
}

const BASH = "bash";

/**
 * 要给 bash 起的进程加环境变量（联网开关关着时的无效代理）：用同名的自定义工具换掉 pi 自带的 bash，
 * 行为和自带的一样（同一个实现），只在起进程前把 shellEnv 覆盖上去。自定义工具和内置工具同名时 pi 用自定义的。
 */
function shellOverrides(assembly: SessionAssembly): ToolDefinition[] {
  const extra = assembly.shellEnv;
  if (!assembly.tools.includes(BASH) || Object.keys(extra).length === 0) return [];
  const bash = createBashToolDefinition(assembly.cwd, {
    spawnHook: (context) => {
      const env = { ...context.env };
      // Windows 上变量名不分大小写：先去掉同名（不同大小写）的旧值
      for (const name of Object.keys(extra)) {
        for (const existing of Object.keys(env)) if (existing.toUpperCase() === name.toUpperCase()) delete env[existing];
      }
      return { ...context, env: { ...env, ...extra } };
    },
  });
  // defineTool 按 pi 的说明保住参数类型、放进 customTools 数组（不用强转：pi 改了工具的形状 tsc 会报错）
  return [defineTool(bash)];
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

  prompt(inputId: string, text: string, images: readonly InputImage[]): void {
    if (this.turnOpen || this.session.isStreaming) {
      this.emit(errorReport("busy", "上一回合还没结束"));
      return;
    }
    this.turnOpen = true;
    // 会话文件里先记下这条用户消息是哪条输入：彻底删除时据此找到原文（不进模型的上下文）
    this.session.sessionManager.appendCustomEntry(SESSION_INPUT_TAG, { inputId });
    this.translator.lastStopReason = undefined;
    const options = images.length > 0 ? { images: images.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mime })) } : undefined;
    this.session.prompt(text, options).catch((err: unknown) => {
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
