// @i18n-ignore-file log：stderr 上的日志、宿主协议上报回去的出错说明（守护进程记日志）
// 子进程里的 pi 会话：按装配参数建会话，接上事件翻译和通用桥接扩展（bridge.ts：守卫转发、上下文块、钩子订阅、范围审视），
// 管回合的开始与结束。
// 这里和 agent-child/ 下的其他文件是全仓库仅有的直接用 pi SDK 的地方（ADR-0001、ADR-0004）。
import fs from "node:fs";
import path from "node:path";
import { clampThinkingLevel, InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
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
import { modelKeyOf } from "@ergo/protocol";
import {
  type CatalogModelSpec,
  errorReport,
  failedScopeReview,
  type HandoffReport,
  INPUT_CONTEXT_TYPE,
  type AgentReport,
  type GuardVerdict,
  type HostCommand,
  type HostToolResult,
  type InputImage,
  type LoadedResources,
  type ModelRef,
  type ModelSpec,
  SESSION_INPUT_TAG,
  SESSION_MODEL_ENTRY,
  isSessionType,
  type SessionAssembly,
  type SessionContextInfo,
  type SessionModel,
  type ThinkingLevel,
  type TurnOutcome,
} from "../host-protocol.ts";
import { ContributionBridge } from "./bridge.ts";
import { EventTranslator, usageReport } from "./event-translator.ts";
import { FAUX_REVIEW_PROVIDER_ID, registerFauxModel } from "./faux.ts";
import { GuardForwarder } from "./guard-forwarding.ts";
import { handoffMessage, handoffSessionManager, writeHandoffSummary } from "./handoff.ts";
import { HostToolBridge, imageContents } from "./host-tools.ts";
import { ScopeReviewer } from "./scope-review.ts";
import { userInvokedSkillsBlock } from "./user-invoked-skills.ts";
import { dropPartialTail, fillInterruptedToolResults } from "./session-recovery.ts";
import { installToolOrder } from "./tool-order.ts";
import { navigateSession, type NavigationDeps } from "./session-navigation.ts";

/** 子进程里驱动一个 pi 会话的对象；main.ts 把宿主协议的命令转给它 */
export interface AgentSessionRunner {
  readonly sessionId: string;
  readonly sessionFile: string;
  /** 会话的名字（宿主协议的 session：会话文件名去掉扩展名） */
  readonly session: string;
  readonly loaded: LoadedResources;
  /** 会话的模型实际能不能看图（79 号票：装配参数给了 vision 按它，没给按模型目录；73 号票起接着的会话照它开始时的） */
  readonly vision: boolean;
  /** 会话实际用的模型（73 号票：接着已有的会话时是它开始时的） */
  readonly model: SessionModel;
  /** 会话的上下文窗口和 pi 的压缩设置（114 号票） */
  readonly contextInfo: SessionContextInfo;
  /** 换模型（83 号票）：这次拉起换了（或者想换没换成）时才有，在 ready 里报回 */
  readonly handoff: HandoffReport | undefined;
  /** ready 之后再报的（写交接摘要那次调用的用量：agent 管家在 ready 时才知道会话 id）；取一次就清空 */
  takeAfterReady(): AgentReport[];
  /**
   * 开始一个回合（支持视觉的模型另外带图片；context 是跟在这条用户消息后面的一条上下文消息，22 号票）；
   * 上一回合没结束时回 busy
   */
  prompt(inputId: string, text: string, images: readonly InputImage[], context?: string): void;
  /** 插话：回合进行中排进去，下一次模型调用之前进入上下文；没有进行中的回合时回带 inputId 的错误。看得了图的模型另外带图片 */
  interject(inputId: string, text: string, images: readonly InputImage[]): void;
  /** 做完手头这一步就停下（当前这一批工具调用结束、下一次模型调用之前，回合以 yielded 结束）；没有进行中的回合时什么都不做 */
  yieldTurn(): void;
  /** 换掉通用贡献清单里一项（上下文块、钩子订阅）的文字（下一条输入之前、下次压缩之后按新的）；清单里没有这个 id 的当成一块新的上下文块 */
  updateContribution(id: string, text: string): void;
  /** 手动压缩会话（先中止进行中的回合） */
  compact(): Promise<void>;
  /** 换成最新的范围审视对照物和近期范围记录（18 号票）；没装配范围审视时回 bad_command */
  setScopeContext(reference: string, recentRecords: string | undefined, model?: ModelSpec): void;
  /** 守护进程要的范围审视：审视会话里还没审视过的部分（model 是这次用的），结果以 scope_review_result 报回；做完才兑现 */
  reviewScope(requestId: string, reference: string, model?: ModelSpec): Promise<void>;
  /**
   * 会话树上挪（150 号票：会话回退；151 号票：切换分支）：回到某条输入之前或者某一条，回退时写分支摘要，叶子落盘；
   * 结果以 session_navigated 报回，做完才兑现
   */
  navigate(command: Extract<HostCommand, { type: "navigate_session" }>): Promise<void>;
  /**
   * 换运行时之前写交接摘要（289 号票）：用这个会话的模型照 pi 的压缩摘要写法写一份（handoff.ts，同换模型），不改会话；
   * 结果以 handoff_written 报回、那次调用的用量另报（purpose: handoff），做完才兑现
   */
  writeHandoff(command: Extract<HostCommand, { type: "write_handoff" }>): Promise<void>;
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
  // 先打开会话：一个会话固定一个模型（73 号票），接着已有的会话时照它开始时的模型、思考档位和看图能力
  let sessionManager = sessionManagerFor(assembly);
  let setup = sessionSetup(assembly, sessionManager, modelRuntime);
  // 换模型就新开会话（83 号票）：接着的会话开始时的模型和这次的不一样、装配参数又给了 handoff，先用原来的模型写交接摘要，
  // 写成了就换到新会话（第一条是这份摘要，会话建好之后加进去）；没写成照旧接着原来的会话
  const switched = await switchModel(assembly, sessionManager, setup, modelRuntime);
  try {
    if (switched?.next) {
      sessionManager = switched.next;
      setup = sessionSetup(assembly, sessionManager, modelRuntime);
    }
    return await startPiSession(assembly, emit, { modelRuntime, sessionManager, setup, switched });
  } catch (err) {
    // 换到的新会话没建起来（装配出错）：删掉它的文件，下次拉起照旧接着原来的会话，下一轮再试换
    const file = switched?.next?.getSessionFile();
    if (file) fs.rmSync(file, { force: true });
    throw err;
  }
}

/** 按打开好的会话（和换模型的结果）建 pi 会话，接上扩展、守卫转发、代为执行的工具 */
async function startPiSession(
  assembly: SessionAssembly,
  emit: (report: AgentReport) => void,
  opened: { modelRuntime: ModelRuntime; sessionManager: SessionManager; setup: SessionSetup; switched: ModelSwitch | undefined },
): Promise<AgentSessionRunner> {
  const { modelRuntime, sessionManager, setup, switched } = opened;
  // 看图能力（79 号票）：配置里写明的为准，没写的按模型目录；会话用的模型按实际生效的改写，pi 对历史里、工具结果里的图片也照它处理
  const model = withVision(setup.model, setup.vision);

  const guard = new GuardForwarder(emit);
  const hostTools = new HostToolBridge(emit);
  // 范围审视（18 号票，维护者的会话才有）：审视用的模型是 faux 时注册成另一个 provider，和会话的各按各的剧本
  const reviewer = assembly.scopeReview
    ? new ScopeReviewer(assembly.scopeReview, resolveModel(assembly.scopeReview.model, modelRuntime, FAUX_REVIEW_PROVIDER_ID), {
        modelRuntime,
        // 73 号票：守护进程每次审视时现取审视用的模型，换了模型时子进程照这里解析
        resolve: (spec) => resolveModel(spec, modelRuntime, FAUX_REVIEW_PROVIDER_ID),
        emit,
      })
    : undefined;
  // 设置只放内存，不读 ~/.pi/agent/settings.json 和工作目录里的 .pi/settings.json
  const settingsManager = SettingsManager.inMemory({});
  /** 建好的 pi 会话（按压缩指令写摘要要它的模型调用函数；会话建好之后才会压缩） */
  let piSession: AgentSession | undefined;
  // 通用桥接扩展（128 号票）：守卫转发（打开了才接）、上下文块、钩子订阅、范围审视（维护者，18 号票）都经它翻译给 pi；
  // 一样都没有就不挂（和 128 号票之前一个内联扩展都不挂时一样）
  const bridge = new ContributionBridge(assembly.contributions, {
    guard: assembly.forwardToolCalls ? guard : undefined,
    reviewer,
    compaction: { modelRuntime, settingsManager, session: () => piSession },
  });
  const extensionFactories: InlineExtension[] = bridge.needed ? [{ name: "ergo-bridge", factory: bridge.extension }] : [];

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
    // 只在用户点名时才用的 skill（72 号票）：pi 不放进 skill 清单，另起一段追加在系统提示后面（见 user-invoked-skills.ts）。
    // reload 时先加载 skill、后取追加段，这里取到的就是这次加载的
    appendSystemPromptOverride: (base) => {
      const block = userInvokedSkillsBlock(resourceLoader.getSkills().skills);
      return block === undefined ? base : [...base, block];
    },
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: assembly.cwd,
    agentDir: assembly.piAgentDir,
    modelRuntime,
    model,
    thinkingLevel: setup.thinkingLevel,
    resourceLoader,
    settingsManager,
    sessionManager,
    // 白名单里加上守护进程代为执行的工具（通用贡献清单里的；白名单之外的工具都不启用，自定义工具也一样）
    tools: [...assembly.tools, ...assembly.contributions.tools.map((t) => t.name)],
    customTools: [...hostTools.tools(assembly.contributions.tools), ...shellOverrides(assembly)],
  });
  piSession = session;
  // 接着会话时工具清单以这次交的为准（273 号票）：发给模型的工具按这次交的先后、开头一份，不按 pi 重放会话里增减的结果
  installToolOrder(session);
  const vision = model.input.includes(IMAGE_INPUT);
  // 会话开始时（和第一次接着 73 号票之前开的会话时）记下看图能力：之后接着这个会话都照它（新会话在第一条消息时随之写盘）
  if (setup.recordVision) session.sessionManager.appendCustomEntry(SESSION_MODEL_ENTRY, { vision });
  // 换到的新会话：第一条是交接摘要（83 号票；新会话一开始就在盘上，这一条马上落盘）
  if (switched?.summary !== undefined) await session.sendCustomMessage(handoffMessage(switched.summary, switched.report.from, switched.report.to));

  const loaded: LoadedResources = {
    tools: session.getActiveToolNames(),
    skills: resourceLoader.getSkills().skills.map((s) => s.name),
    contextFiles: resourceLoader.getAgentsFiles().agentsFiles.map((f) => f.path),
    extensions: resourceLoader.getExtensions().extensions.map((e) => e.path),
    credentialProviders: (await modelRuntime.listCredentials()).map((c) => c.providerId),
  };

  const sessionModel: SessionModel = {
    provider: model.provider,
    modelId: model.id,
    thinkingLevel: setup.thinkingLevel,
    pinned: setup.pinned,
    // 照旧接着和装配参数不一样的会话（没给 handoff、交接摘要没写成）：守护进程下一条能换的输入之前带上 handoff 重新拉起
    ...(setup.differs ? { differs: true as const } : {}),
  };
  // 上下文窗口和压缩设置（114 号票）：⚙ 里的上下文用量、离自动压缩还有多少按它算（pi 的设置只在内存里，是 pi 默认的）
  const compaction = settingsManager.getCompactionSettings(model);
  const contextInfo: SessionContextInfo = { window: model.contextWindow, reserveTokens: compaction.reserveTokens, keepRecentTokens: compaction.keepRecentTokens };
  return new PiSessionRunner(
    session,
    loaded,
    sessionModel,
    contextInfo,
    emit,
    guard,
    hostTools,
    bridge,
    reviewer,
    switched ? { report: switched.report, afterReady: switched.afterReady } : undefined,
    { modelRuntime, settingsManager },
    assembly.credentials,
  );
}

/** 换模型的结果：报给守护进程的、换到的新会话（写成了才有）和要放进去的摘要、ready 之后再报的用量 */
interface ModelSwitch {
  report: HandoffReport;
  next?: SessionManager;
  summary?: string;
  afterReady: AgentReport[];
}

/**
 * 换模型就新开会话（83 号票）：接着的会话开始时的模型和装配参数里的不一样（sessionSetup 的 differs）、装配参数给了 handoff 才换。
 * 先用原来的模型写交接摘要（handoff.ts），写成了建好新会话（空文件交给 pi 打开，马上在盘上）；没写成报原因，照旧接着原来的
 */
async function switchModel(assembly: SessionAssembly, sessionManager: SessionManager, setup: SessionSetup, modelRuntime: ModelRuntime): Promise<ModelSwitch | undefined> {
  if (!assembly.handoff || !setup.differs) return undefined;
  const from = { session: sessionNameOf(sessionManager.getSessionFile() ?? ""), model: setup.differs.from };
  const to = setup.differs.to;
  const label = `${modelKeyOf(from.model.provider, from.model.modelId)}（思考 ${from.model.thinkingLevel}）→ ${modelKeyOf(to.provider, to.modelId)}（思考 ${to.thinkingLevel}）`;
  try {
    const written = await writeHandoffSummary(sessionManager, setup.model, from.model.thinkingLevel, assembly.handoff, { modelRuntime, credentials: assembly.credentials });
    const next = handoffSessionManager(assembly);
    process.stderr.write(`换模型：${label}，原来的会话 ${from.session} 写了交接摘要，新开会话 ${sessionNameOf(next.getSessionFile() ?? "")}\n`);
    return {
      report: { from, to },
      next,
      summary: written.text,
      afterReady: [usageReport(`handoff-${from.session}`, written.usage, { provider: from.model.provider, modelId: from.model.modelId }, "handoff")],
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    process.stderr.write(`换模型没成：${label}，交接摘要没写成，照旧接着会话 ${from.session}：${error}\n`);
    return { report: { from, to, error }, afterReady: [] };
  }
}

/** 这次拉起的会话用什么：模型（pi 的）、思考档位、配置写明的或会话记下的看图能力（undefined 按模型目录） */
interface SessionSetup {
  model: ReturnType<typeof resolveModel>;
  thinkingLevel: ThinkingLevel;
  vision: boolean | undefined;
  /** 接着已有的会话、照它开始时的 */
  pinned: boolean;
  /** 要把看图能力记进会话文件（目录里的模型、会话里还没记过） */
  recordVision: boolean;
  /**
   * 接着的会话开始时的模型（或按模型支持的档换算后的思考档位）和装配参数里的不一样（83 号票）：原来的和装配参数要的。
   * 一样的、新开的会话、faux、装配参数里的模型目录里没有的，都不写
   */
  differs?: { from: ModelRef; to: ModelRef };
}

/**
 * 一个会话固定一个模型（73 号票，规格第 1 节）：
 * - 新开的会话（会话里还没有消息）用装配参数里的模型和思考档位，看图能力按配置写明的（装配参数 vision 表）、没写按模型目录；
 * - 接着已有的会话（目录里的模型）照会话开始时的：模型和思考档位取 pi 在会话文件里记的（model_change、thinking_level_change），
 *   看图能力取子进程记的（SESSION_MODEL_ENTRY；73 号票之前开的会话没有，按配置和目录定下、这次记上）。设置里改了只对新会话生效；
 *   记下的模型目录里已经没有了（pi 升级去掉了）才用装配参数里的，写一行日志；
 *   和装配参数里的不一样（思考档位按模型支持的档换算之后比）时记下 differs：装配参数给了 handoff 就换（83 号票，switchModel）；
 * - faux（测试）一律照装配参数：剧本按每次拉起给，接着会话也换成这次的剧本
 */
function sessionSetup(assembly: SessionAssembly, sessionManager: SessionManager, modelRuntime: ModelRuntime): SessionSetup {
  const spec = assembly.model;
  const configured = (provider: string, modelId: string) => assembly.vision?.[spec.kind === "faux" ? "faux" : modelKeyOf(provider, modelId)];
  const fresh = (): SessionSetup => {
    const model = resolveModel(spec, modelRuntime);
    return { model, thinkingLevel: spec.thinkingLevel, vision: configured(model.provider, model.id), pinned: false, recordVision: spec.kind === "catalog" };
  };
  if (spec.kind === "faux") return fresh();
  const context = sessionManager.buildSessionContext();
  if (context.messages.length === 0 || !context.model) return fresh();
  const recorded = modelRuntime.getModel(context.model.provider, context.model.modelId);
  if (!recorded) {
    process.stderr.write(`接着的会话开始时用的模型 ${modelKeyOf(context.model.provider, context.model.modelId)} 模型目录里没有了，改用 ${modelKeyOf(spec.provider, spec.modelId)}\n`);
    return fresh();
  }
  const recordedVision = lastCustomData(sessionManager, SESSION_MODEL_ENTRY)?.vision;
  const thinkingLevel = context.thinkingLevel as ThinkingLevel;
  const differs = differsFrom(spec, { model: recorded, thinkingLevel }, modelRuntime);
  return {
    // 请求地址照装配参数（契约测试、主切面测试发到本机的假服务）
    model: spec.baseUrl === undefined ? recorded : { ...recorded, baseUrl: spec.baseUrl },
    thinkingLevel,
    vision: typeof recordedVision === "boolean" ? recordedVision : configured(recorded.provider, recorded.id),
    pinned: true,
    recordVision: typeof recordedVision !== "boolean",
    ...(differs ? { differs } : {}),
  };
}

/**
 * 接着的会话开始时的模型和装配参数里的比（83 号票）：模型不一样，或者思考档位按装配参数的模型支持的档换算之后（pi 新开会话时
 * 也这样换算、记下换算后的）不一样，就是不一样。装配参数里的模型目录里没有：比不了，当一样（照旧接着，写一行日志）
 */
function differsFrom(
  spec: CatalogModelSpec,
  recorded: { model: Model<string>; thinkingLevel: ThinkingLevel },
  modelRuntime: ModelRuntime,
): { from: ModelRef; to: ModelRef } | undefined {
  const target = modelRuntime.getModel(spec.provider, spec.modelId);
  if (!target) {
    process.stderr.write(`装配参数里的模型 ${modelKeyOf(spec.provider, spec.modelId)} 模型目录里没有，照旧接着会话开始时的模型\n`);
    return undefined;
  }
  const level = clampThinkingLevel(target, spec.thinkingLevel) as ThinkingLevel;
  if (target.provider === recorded.model.provider && target.id === recorded.model.id && level === recorded.thinkingLevel) return undefined;
  return {
    from: { provider: recorded.model.provider, modelId: recorded.model.id, name: recorded.model.name, thinkingLevel: recorded.thinkingLevel },
    to: { provider: target.provider, modelId: target.id, name: target.name, thinkingLevel: level },
  };
}

/** 会话（当前这一支）里最后一条这个类型的自定义条目的数据（没有是 undefined） */
function lastCustomData(sessionManager: SessionManager, customType: string): Record<string, unknown> | undefined {
  const entries = sessionManager.getBranch();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.type === "custom" && isSessionType(entry.customType, customType)) return typeof entry.data === "object" && entry.data !== null ? (entry.data as Record<string, unknown>) : undefined;
  }
  return undefined;
}

/** 模型的输入里有没有图片（pi 的模型目录这样标能不能看图） */
const IMAGE_INPUT = "image";

/**
 * 按配置写明的看图能力改写模型能收的输入（79 号票）：写了能看的补上图片，写了不能看的去掉图片，没写的按模型目录原样。
 * pi 发请求前按它处理会话里的图片（看不了的，用户消息、工具结果里的图片都换成一句占位），pi 的 read 工具读图也按它
 */
function withVision<M extends { input: readonly string[] }>(model: M, vision: boolean | undefined): M {
  if (vision === undefined || model.input.includes(IMAGE_INPUT) === vision) return model;
  return { ...model, input: vision ? [...model.input, IMAGE_INPUT] : model.input.filter((i) => i !== IMAGE_INPUT) };
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
  const fresh = freshSessionManager(assembly);
  if (fresh) return fresh;
  const named = assembly.session === undefined ? undefined : path.join(assembly.sessionDir, `${assembly.session}${SESSION_EXT}`);
  if (named !== undefined && fs.existsSync(named)) return reopen(assembly, named);
  const recent = assembly.continueSession ? mostRecentSessionFile(assembly.sessionDir) : undefined;
  if (recent !== undefined) return reopen(assembly, recent);
  return named !== undefined ? SessionManager.open(named, assembly.sessionDir, assembly.cwd) : SessionManager.create(assembly.cwd, assembly.sessionDir);
}

/**
 * 清空当前对话之后的那一段（114 号票，装配参数 freshSession）：会话目录里还没有这个名字的会话，就先建一个空文件再交给 pi 打开
 * （和换模型的新会话一样：pi 对空文件写好会话头、之后每条马上落盘，所以这一刻它就是最近的会话，之后接最近的都接得上它）；
 * 已经有了返回 undefined，照常接
 */
function freshSessionManager(assembly: SessionAssembly): SessionManager | undefined {
  if (assembly.freshSession === undefined) return undefined;
  const file = path.join(assembly.sessionDir, `${assembly.freshSession}${SESSION_EXT}`);
  if (fs.existsSync(file)) return undefined;
  fs.mkdirSync(assembly.sessionDir, { recursive: true });
  fs.writeFileSync(file, "", { flag: "wx" });
  process.stderr.write(`清空了对话：新开会话 ${assembly.freshSession}\n`);
  return SessionManager.open(file, assembly.sessionDir, assembly.cwd);
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

const BASH = "bash";

/**
 * 要给 bash 起的进程加环境变量（联网开关关着时的无效代理）或临时目录（177 号票）：用同名的自定义工具换掉 pi 自带的 bash，
 * 行为和自带的一样（同一个实现），只在起进程前把 shellEnv 覆盖上去、在命令前面 export 临时目录（commandPrefix）。
 * 自定义工具和内置工具同名时 pi 用自定义的。
 */
function shellOverrides(assembly: SessionAssembly): ToolDefinition[] {
  const extra = assembly.shellEnv;
  const tempDir = assembly.shellTempDir;
  if (!assembly.tools.includes(BASH) || (Object.keys(extra).length === 0 && tempDir === undefined)) return [];
  const bash = createBashToolDefinition(assembly.cwd, {
    ...(tempDir === undefined ? {} : { commandPrefix: shellTempPrefix(tempDir) }),
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

/**
 * 命令前面那一行：把 TMPDIR、TEMP、TMP 指到临时目录（177 号票）。只 export 给这条命令起的进程，bash 进程本身的 TMP / TEMP 不动
 * （Git Bash 的 /tmp 挂到哪由第一个起来的 Git Bash 进程的 TMP / TEMP 定，见 agent-manager/work-temp.ts）
 */
export function shellTempPrefix(dir: string): string {
  const quoted = `'${dir.replaceAll("'", "'\\''")}'`;
  return `export TMPDIR=${quoted} TEMP=${quoted} TMP=${quoted}`;
}

function resolveModel(spec: ModelSpec, modelRuntime: ModelRuntime, fauxProviderId?: string) {
  if (spec.kind === "faux") return registerFauxModel(spec, modelRuntime, fauxProviderId);
  const model = modelRuntime.getModel(spec.provider, spec.modelId);
  if (!model) throw new Error(`模型目录里没有 ${modelKeyOf(spec.provider, spec.modelId)}`);
  // 契约测试：请求发到本机录好的响应（正式的会话不给 baseUrl）
  return spec.baseUrl === undefined ? model : { ...model, baseUrl: spec.baseUrl };
}

class PiSessionRunner implements AgentSessionRunner {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly session: string;
  readonly loaded: LoadedResources;
  readonly vision: boolean;
  readonly model: SessionModel;
  readonly contextInfo: SessionContextInfo;
  readonly handoff: HandoffReport | undefined;
  private afterReady: AgentReport[];
  private readonly piSession: AgentSession;
  private readonly emit: (report: AgentReport) => void;
  private readonly guard: GuardForwarder;
  private readonly hostTools: HostToolBridge;
  private readonly translator: EventTranslator;
  private readonly bridge: ContributionBridge;
  private readonly reviewer: ScopeReviewer | undefined;
  /** 已经开始、还没发 turn_end 的回合 */
  private turnOpen = false;
  /** 这一轮里收下的插话（输入 id），回合结束时报给守护进程 */
  private interjected: string[] = [];
  /**
   * 这一轮里已经排进 pi 的插话队列的（输入 id，按先后；86 号票）：pi 在下一次模型调用之前把队里的按先后放进上下文，
   * 还排着的是它的 getSteeringMessages()，所以前面那几条就是已经进了上下文的
   */
  private queuedInterjections: string[] = [];
  /** 这一轮被要求中止过：工具执行到一半被中止时 pi 报的是出错（"This operation was aborted"），照样算中止 */
  private abortRequested = false;
  /** 这一轮被要求做完手头这一步就停下（27 号票） */
  private yieldRequested = false;
  /** 这一轮按要求停在了两次模型调用之间 */
  private yielded = false;
  /** 停下时还排着、没进上下文的插话有几条（排在最后的那几条） */
  private undelivered = 0;
  /** 写分支摘要要的（150 号票） */
  private readonly navigation: NavigationDeps;
  /** 凭据（289 号票：写交接摘要没写成时，原因里去掉它们的内容） */
  private readonly credentials: Readonly<Record<string, string>>;

  constructor(
    session: AgentSession,
    loaded: LoadedResources,
    model: SessionModel,
    contextInfo: SessionContextInfo,
    emit: (report: AgentReport) => void,
    guard: GuardForwarder,
    hostTools: HostToolBridge,
    bridge: ContributionBridge,
    reviewer: ScopeReviewer | undefined,
    handoff: { report: HandoffReport; afterReady: AgentReport[] } | undefined,
    navigation: NavigationDeps,
    credentials: Readonly<Record<string, string>> = {},
  ) {
    this.navigation = navigation;
    this.credentials = credentials;
    this.handoff = handoff?.report;
    this.afterReady = handoff?.afterReady ?? [];
    this.piSession = session;
    this.bridge = bridge;
    this.reviewer = reviewer;
    this.sessionId = session.sessionId;
    this.sessionFile = session.sessionFile ?? "";
    this.session = sessionNameOf(this.sessionFile);
    this.loaded = loaded;
    this.vision = session.model?.input.includes(IMAGE_INPUT) ?? false;
    this.model = model;
    this.contextInfo = contextInfo;
    this.emit = emit;
    this.guard = guard;
    this.hostTools = hostTools;
    // 86 号票：宿主工具调用时报这一轮已经进了上下文的插话
    hostTools.setInterjections(() => this.deliveredInterjections());
    this.translator = new EventTranslator(emit, session.model);
    session.subscribe((event) => {
      this.translator.handle(event);
      if (event.type === "agent_settled") this.onSettled();
    });
    // 做完手头这一步就停下（27 号票）：pi 在一批工具调用的结果都进了会话之后、决定要不要接着下一次模型调用之前问 finishTurn，
    // 这时说"结束"，回合就停在两次模型调用之间。包在 pi 自己的 finishTurn（扩展的 turn_end 边界）外面，不替换它
    const agent = session.agent;
    const previous = agent.finishTurn;
    agent.finishTurn = async (turn, signal) => {
      const decision = await previous?.(turn, signal);
      if (this.yieldRequested && turn.toolResults.length > 0) {
        this.yielded = true;
        // 还排着的插话不再送进这一轮（不然 pi 会为它们接着跑下一次模型调用）：清掉，回合结束时不算收下
        this.undelivered = session.clearQueue().steering.length;
        return { action: "end" };
      }
      return decision ?? undefined;
    };
  }

  takeAfterReady(): AgentReport[] {
    return this.afterReady.splice(0);
  }

  prompt(inputId: string, text: string, images: readonly InputImage[], context?: string): void {
    if (this.turnOpen || this.piSession.isStreaming) {
      this.emit(errorReport("busy", "上一回合还没结束"));
      return;
    }
    this.turnOpen = true;
    this.interjected = [];
    this.queuedInterjections = [];
    this.abortRequested = false;
    this.yieldRequested = false;
    this.yielded = false;
    this.undelivered = 0;
    this.translator.lastStopReason = undefined;
    const options = images.length > 0 ? { images: imageContents(images) } : undefined;
    // 每条输入之前（被唤起：刚拉起，或者闲着时来了新输入）按先后注入最新的各上下文块（重注入块是其中一块；不在回合里：直接追加进会话）
    // （第一块马上送，和 128 号票之前只有重注入块时同一个时机）
    const [first, ...rest] = this.bridge.contextMessages();
    rest
      .reduce((sent, message) => sent.then(() => this.piSession.sendCustomMessage(message)), first ? this.piSession.sendCustomMessage(first) : Promise.resolve())
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

  interject(inputId: string, text: string, images: readonly InputImage[]): void {
    if (!this.turnOpen) {
      this.emit(errorReport("bad_command", "没有进行中的回合，插话应当作为用户输入送", false, inputId));
      return;
    }
    this.interjected.push(inputId);
    // 同样记下输入标记：插话在下一次模型调用之前进会话，是标记之后的第一条用户消息（彻底删除据此找到它）
    this.piSession.sessionManager.appendCustomEntry(SESSION_INPUT_TAG, { inputId });
    this.piSession.steer(text, images.length > 0 ? imageContents(images) : undefined).then(
      () => {
        if (this.turnOpen) this.queuedInterjections.push(inputId);
      },
      (err: unknown) => this.emit(errorReport("internal", String(err))),
    );
  }

  /** 这一轮已经进了上下文的插话（86 号票）：排进队的减去还排着的、停下时清掉的 */
  private deliveredInterjections(): string[] {
    const pending = this.piSession.getSteeringMessages().length + this.undelivered;
    return this.queuedInterjections.slice(0, Math.max(0, this.queuedInterjections.length - pending));
  }

  yieldTurn(): void {
    if (this.turnOpen) this.yieldRequested = true;
  }

  updateContribution(id: string, text: string): void {
    this.bridge.update(id, text);
  }

  async compact(): Promise<void> {
    await this.piSession.compact();
  }

  setScopeContext(reference: string, recentRecords: string | undefined, model?: ModelSpec): void {
    if (!this.reviewer) return this.emit(errorReport("bad_command", "这个会话没有装配范围审视"));
    this.reviewer.setContext(reference, recentRecords, model);
  }

  async reviewScope(requestId: string, reference: string, model?: ModelSpec): Promise<void> {
    if (!this.reviewer) {
      this.emit(failedScopeReview(requestId, "这个会话没有装配范围审视"));
      return;
    }
    await this.reviewer.reviewSession(this.piSession, requestId, reference, model);
  }

  async navigate(command: Extract<HostCommand, { type: "navigate_session" }>): Promise<void> {
    // 守护进程已经停稳回合；还在跑的（不该有）navigateSession 先中止、等它停下，这一轮照常以 turn_end 结束
    if (this.turnOpen) this.abortRequested = true;
    this.emit(await navigateSession(this.piSession, command, this.navigation, this.emit));
  }

  async writeHandoff(command: Extract<HostCommand, { type: "write_handoff" }>): Promise<void> {
    const model = this.piSession.model;
    if (!model) {
      this.emit({ type: "handoff_written", requestId: command.requestId, error: "会话还没有模型，写不了交接摘要" });
      return;
    }
    try {
      const written = await writeHandoffSummary(
        this.piSession.sessionManager,
        model,
        this.model.thinkingLevel,
        { instructions: command.instructions, timeoutMs: command.timeoutMs },
        { modelRuntime: this.navigation.modelRuntime, credentials: this.credentials },
      );
      this.emit(usageReport(`handoff-${this.session}`, written.usage, { provider: model.provider, modelId: model.id }, "handoff"));
      this.emit({ type: "handoff_written", requestId: command.requestId, text: written.text });
    } catch (err) {
      this.emit({ type: "handoff_written", requestId: command.requestId, error: err instanceof Error ? err.message : String(err) });
    }
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
    const outcome: TurnOutcome =
      stop === "aborted" || (stop === "error" && this.abortRequested) ? "aborted" : stop === "error" ? "error" : this.yielded ? "yielded" : "completed";
    this.endTurn(outcome, outcome === "error" ? this.translator.lastErrorMessage : undefined);
  }

  private endTurn(outcome: TurnOutcome, errorMessage: string | undefined): void {
    if (!this.turnOpen) return;
    this.turnOpen = false;
    // 停在两次模型调用之间时，还排着、没进上下文的插话不算收下（守护进程留着它们）：收下的是按先后进了上下文的那几条
    const interjected = this.interjected.slice(0, this.interjected.length - this.undelivered);
    this.interjected = [];
    this.emit({ type: "turn_end", outcome, ...(errorMessage === undefined ? {} : { errorMessage }), ...(interjected.length > 0 ? { interjected } : {}) });
  }
}
