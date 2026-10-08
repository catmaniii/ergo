// 子进程里的 pi 会话：按装配参数建会话，接上事件翻译和守卫转发，管回合的开始与结束。
// 这里和 agent-child/ 下的其他文件是全仓库仅有的直接用 pi SDK 的地方（ADR-0001、ADR-0004）。
import fs from "node:fs";
import path from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  compact,
  createAgentSession,
  createBashToolDefinition,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionFactory,
  type InlineExtension,
  type SessionEntry,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  CONTEXT_BLOCK_TYPE,
  errorReport,
  INPUT_CONTEXT_TYPE,
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
import { dropPartialTail, fillInterruptedToolResults } from "./session-recovery.ts";

/** 子进程里驱动一个 pi 会话的对象；main.ts 把宿主协议的命令转给它 */
export interface AgentSessionRunner {
  readonly sessionId: string;
  readonly sessionFile: string;
  /** 会话的名字（宿主协议的 session：会话文件名去掉扩展名） */
  readonly session: string;
  readonly loaded: LoadedResources;
  /**
   * 开始一个回合（支持视觉的模型另外带图片；context 是跟在这条用户消息后面的一条上下文消息，22 号票）；
   * 上一回合没结束时回 busy
   */
  prompt(inputId: string, text: string, images: readonly InputImage[], context?: string): void;
  /** 插话：回合进行中排进去，下一次模型调用之前进入上下文；没有进行中的回合时回带 inputId 的错误 */
  interject(inputId: string, text: string): void;
  /** 换成最新的重注入块（下一条输入之前、下次压缩之后注入它） */
  setContextBlock(text: string): void;
  /** 手动压缩会话（先中止进行中的回合） */
  compact(): Promise<void>;
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
  const context = new ContextBlock(assembly.contextBlock);
  // 设置只放内存，不读 ~/.pi/agent/settings.json 和工作目录里的 .pi/settings.json
  const settingsManager = SettingsManager.inMemory({});
  /** 建好的 pi 会话（压缩的扩展要它的模型调用函数；会话建好之后才会压缩） */
  let piSession: AgentSession | undefined;
  const extensionFactories: InlineExtension[] = [
    ...(assembly.forwardToolCalls ? [{ name: "ergou-guard-forwarding", factory: guard.extension }] : []),
    // 给了重注入块的会话才挂（压缩之后再注入）
    ...(assembly.contextBlock === undefined ? [] : [{ name: "ergou-context-block", factory: context.extension }]),
    // 给了压缩指令的会话才挂（秘书，22 号票）
    ...(assembly.compactionInstructions === undefined
      ? []
      : [{ name: "ergou-compaction", factory: compactionExtension(assembly.compactionInstructions, { modelRuntime, settingsManager, session: () => piSession }) }]),
  ];

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
    sessionManager: sessionManagerFor(assembly),
    // 白名单里加上守护进程代为执行的工具（白名单之外的工具都不启用，自定义工具也一样）
    tools: [...assembly.tools, ...assembly.hostTools.map((t) => t.name)],
    customTools: [...hostTools.tools(assembly.hostTools), ...shellOverrides(assembly)],
  });
  piSession = session;

  const loaded: LoadedResources = {
    tools: session.getActiveToolNames(),
    skills: resourceLoader.getSkills().skills.map((s) => s.name),
    contextFiles: resourceLoader.getAgentsFiles().agentsFiles.map((f) => f.path),
    extensions: resourceLoader.getExtensions().extensions.map((e) => e.path),
    credentialProviders: (await modelRuntime.listCredentials()).map((c) => c.providerId),
  };

  return new PiSessionRunner(session, loaded, emit, guard, hostTools, context);
}

/**
 * 重注入块（13 号票，规格第 8 节"重注入块"）：每次唤起（拉起后、或者闲着时来了新输入，每条输入之前）和每次压缩之后，
 * 把守护进程给的最新一块作为一条上下文消息（custom message，模型看到的是用户角色的一条）加进会话，不改系统提示。
 * 插话不算唤起（回合进行中，不注入）
 */
class ContextBlock {
  /** 守护进程最近给的一块 */
  text: string | undefined;

  constructor(initial: string | undefined) {
    this.text = initial;
  }

  message(): { customType: string; content: string; display: boolean } | undefined {
    return this.text === undefined ? undefined : { customType: CONTEXT_BLOCK_TYPE, content: this.text, display: false };
  }

  /** 压缩之后注入最新的一块（回合进行中时 pi 把它排到下一次模型调用之前） */
  readonly extension: ExtensionFactory = (pi) => {
    pi.on("session_compact", () => {
      const message = this.message();
      if (message) pi.sendMessage(message);
    });
  };
}

/**
 * 自定义的压缩指令（22 号票：秘书专用的那一份，规格第 7 节）。pi 的自动压缩（到了阈值、上下文溢出）不带自定义指令，
 * 手动压缩也只在调用时带：所以在 session_before_compact 里自己按这份指令写摘要（pi 导出的 compact，和 pi 默认的写法
 * 同一个函数、同一个模型调用函数和凭据，只是多了这份指令），把结果交回 pi，由 pi 照常记进会话文件、之后照常注入重注入块。
 * 指令接在 pi 的摘要提示后面（"Additional focus: …"）。被当成"切在一轮中间"、其实没切开的，整段按这份指令写（wholeTurns）。
 */
function compactionExtension(
  instructions: string,
  deps: { modelRuntime: ModelRuntime; settingsManager: SettingsManager; session: () => AgentSession | undefined },
): ExtensionFactory {
  return (pi) => {
    pi.on("session_before_compact", async (event, ctx) => {
      const session = deps.session();
      const model = ctx.model;
      // 还没有会话、没有模型：交给 pi 默认的写法
      if (!session || !model) return undefined;
      const auth = await deps.modelRuntime.getAuth(model, { signal: event.signal });
      const requestModel = auth?.auth.baseUrl ? { ...model, baseUrl: auth.auth.baseUrl } : model;
      const compaction = await compact(
        wholeTurns(event.preparation, event.branchEntries),
        requestModel,
        auth?.auth.apiKey,
        withoutDeletedHeaders(auth?.auth.headers),
        instructions,
        event.signal,
        session.thinkingLevel,
        session.agent.streamFunction,
        auth?.env,
        deps.settingsManager.getRetrySettings(),
      );
      return { compaction };
    });
  };
}

/**
 * pi 留下的第一条之前紧挨着的非消息条目（二狗在每条输入前记的输入标记）也一起留下，切点就落在标记上，被当成切在一轮中间：
 * 那一轮另用 pi 自己的"半轮"提示写一段摘要（不带自定义指令）。切点之后的第一条消息就是一轮的开头（用户消息、上下文消息）时
 * 其实没切开哪一轮：把那"半轮"并回要压缩的历史，整段按自定义指令写。真切在一轮中间的（留下的从助手消息、工具结果开始）照旧
 */
function wholeTurns(preparation: CompactionPreparation, entries: readonly SessionEntry[]): CompactionPreparation {
  if (!preparation.isSplitTurn || preparation.turnPrefixMessages.length === 0) return preparation;
  const at = entries.findIndex((e) => e.id === preparation.firstKeptEntryId);
  if (at < 0) return preparation;
  const first = entries.slice(at).find((e) => e.type === "message" || e.type === "custom_message");
  const startsTurn = first?.type === "custom_message" || (first?.type === "message" && first.message.role === "user");
  if (!startsTurn) return preparation;
  return { ...preparation, messagesToSummarize: [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages], turnPrefixMessages: [], isSplitTurn: false };
}

/** provider 的请求头里值为 null 的表示删掉这个头（pi 自己的摘要请求也这样去掉） */
function withoutDeletedHeaders(headers: Record<string, string | null> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  return Object.fromEntries(Object.entries(headers).flatMap(([name, value]) => (value === null ? [] : [[name, value]])));
}

/** 会话文件的扩展名：会话的名字（宿主协议的 session）加上它就是文件名，只有子进程认它 */
const SESSION_EXT = ".jsonl";

/** 会话文件对应的名字 */
export function sessionNameOf(file: string): string {
  return path.basename(file, SESSION_EXT);
}

/**
 * 会话从哪来：
 * - 指定了名字（16 号票：维护者会话分段）：有这个会话就接着它；还没有时选了 continueSession 就接着最近的那个
 *   （项目维护者的第一段对话段接着任务转来的、16 号票之前的会话），目录里没有会话就新开一个、用这个名字存
 *   （pi 在第一条消息之后才真正写盘）；
 * - 没指定：选了 continueSession 接着最近的，都没有就新开。
 * 工作目录变了（任务转为项目、绑定外部工作目录，15 号票）也接着同一个会话：pi 的 continueRecent 在指定了会话目录时只挑
 * 工作目录相同的会话，所以自己挑、用新的工作目录打开（工具按新的工作目录）
 */
function sessionManagerFor(assembly: SessionAssembly): SessionManager {
  const named = assembly.session === undefined ? undefined : path.join(assembly.sessionDir, `${assembly.session}${SESSION_EXT}`);
  if (named !== undefined && fs.existsSync(named)) return reopen(assembly, named);
  const recent = assembly.continueSession ? mostRecentSessionFile(assembly.sessionDir) : undefined;
  if (recent !== undefined) return reopen(assembly, recent);
  return named !== undefined ? SessionManager.open(named, assembly.sessionDir, assembly.cwd) : SessionManager.create(assembly.cwd, assembly.sessionDir);
}

/**
 * 接着一个已有的会话：打开之前去掉末尾写到一半的一行，打开之后给最后一个回合里被中断的工具调用补上结果（被杀后的恢复，23 号票；
 * 指定名字接着的分段会话一样修补）
 */
function reopen(assembly: SessionAssembly, recent: string): SessionManager {
  const dropped = dropPartialTail(recent);
  const sessionManager = SessionManager.open(recent, assembly.sessionDir, assembly.cwd);
  const filled = fillInterruptedToolResults(sessionManager, assembly.interruptedToolResults ?? {});
  if (dropped > 0 || filled.length > 0) {
    process.stderr.write(`接着会话 ${path.basename(recent)}：去掉末尾写到一半的 ${dropped} 字节，给 ${filled.length} 个被中断的工具调用补上结果
`);
  }
  return sessionManager;
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

/** pi 压缩前准备好的东西（要压缩的消息、留下的第一条……；pi 没导出这个类型的名字） */
type CompactionPreparation = Parameters<typeof compact>[0];

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
  // 契约测试：请求发到本机录好的响应（正式的会话不给 baseUrl）
  return spec.baseUrl === undefined ? model : { ...model, baseUrl: spec.baseUrl };
}

class PiSessionRunner implements AgentSessionRunner {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly session: string;
  readonly loaded: LoadedResources;
  private readonly piSession: AgentSession;
  private readonly emit: (report: AgentReport) => void;
  private readonly guard: GuardForwarder;
  private readonly hostTools: HostToolBridge;
  private readonly translator: EventTranslator;
  private readonly context: ContextBlock;
  /** 已经开始、还没发 turn_end 的回合 */
  private turnOpen = false;
  /** 这一轮里收下的插话（输入 id），回合结束时报给守护进程 */
  private interjected: string[] = [];
  /** 这一轮被要求中止过：工具执行到一半被中止时 pi 报的是出错（"This operation was aborted"），照样算中止 */
  private abortRequested = false;

  constructor(session: AgentSession, loaded: LoadedResources, emit: (report: AgentReport) => void, guard: GuardForwarder, hostTools: HostToolBridge, context: ContextBlock) {
    this.piSession = session;
    this.context = context;
    this.sessionId = session.sessionId;
    this.sessionFile = session.sessionFile ?? "";
    this.session = sessionNameOf(this.sessionFile);
    this.loaded = loaded;
    this.emit = emit;
    this.guard = guard;
    this.hostTools = hostTools;
    this.translator = new EventTranslator(emit, session.model);
    session.subscribe((event) => {
      this.translator.handle(event);
      if (event.type === "agent_settled") this.onSettled();
    });
  }

  prompt(inputId: string, text: string, images: readonly InputImage[], context?: string): void {
    if (this.turnOpen || this.piSession.isStreaming) {
      this.emit(errorReport("busy", "上一回合还没结束"));
      return;
    }
    this.turnOpen = true;
    this.interjected = [];
    this.abortRequested = false;
    this.translator.lastStopReason = undefined;
    const options = images.length > 0 ? { images: images.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mime })) } : undefined;
    // 每条输入之前（被唤起：刚拉起，或者闲着时来了新输入）注入最新的重注入块（不在回合里：直接追加进会话）
    const wake = this.context.message();
    (wake ? this.piSession.sendCustomMessage(wake) : Promise.resolve())
      .then(() => {
        // 会话文件里先记下这条用户消息是哪条输入：彻底删除时据此找到原文（不进模型的上下文）
        this.piSession.sessionManager.appendCustomEntry(SESSION_INPUT_TAG, { inputId });
        // 跟在这条用户消息后面的上下文消息（秘书的看板变化，22 号票）：pi 的 nextTurn 把它排在下一次 prompt 的用户消息之后
        if (context !== undefined) void this.piSession.sendCustomMessage({ customType: INPUT_CONTEXT_TYPE, content: context, display: false }, { deliverAs: "nextTurn" });
        return this.piSession.prompt(text, options);
      })
      .catch((err: unknown) => {
      // 没能开始的回合不会有 agent_settled，这里补上回合结束
      const message = err instanceof Error ? err.message : String(err);
      this.emit(errorReport("internal", message));
      this.endTurn("error", message);
    });
  }

  interject(inputId: string, text: string): void {
    if (!this.turnOpen) {
      this.emit(errorReport("bad_command", "没有进行中的回合，插话应当作为用户输入送", false, inputId));
      return;
    }
    this.interjected.push(inputId);
    // 同样记下输入标记：插话在下一次模型调用之前进会话，是标记之后的第一条用户消息（彻底删除据此找到它）
    this.piSession.sessionManager.appendCustomEntry(SESSION_INPUT_TAG, { inputId });
    this.piSession.steer(text).catch((err: unknown) => this.emit(errorReport("internal", String(err))));
  }

  setContextBlock(text: string): void {
    this.context.text = text;
  }

  async compact(): Promise<void> {
    await this.piSession.compact();
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
    if (this.turnOpen) this.abortRequested = true;
    return this.piSession.abort();
  }

  dispose(): void {
    this.piSession.dispose();
  }

  private onSettled(): void {
    const stop = this.translator.lastStopReason;
    const outcome: TurnOutcome = stop === "aborted" || (stop === "error" && this.abortRequested) ? "aborted" : stop === "error" ? "error" : "completed";
    this.endTurn(outcome, outcome === "error" ? this.translator.lastErrorMessage : undefined);
  }

  private endTurn(outcome: TurnOutcome, errorMessage: string | undefined): void {
    if (!this.turnOpen) return;
    this.turnOpen = false;
    const interjected = this.interjected;
    this.interjected = [];
    this.emit({ type: "turn_end", outcome, ...(errorMessage === undefined ? {} : { errorMessage }), ...(interjected.length > 0 ? { interjected } : {}) });
  }
}
