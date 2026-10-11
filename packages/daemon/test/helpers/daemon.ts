// 在临时数据目录里起一个守护进程实例（测试的一部分，用完即销毁，不算服务，不在 LSM 登记），
// 秘书接 faux provider 按剧本回话；也能另外拉起接 faux provider 的 agent。
import fs from "node:fs";
import path from "node:path";
import { onTestFinished } from "vitest";
import type { ManagedAgent, SpawnAgentRequest } from "../../src/agent-manager/agent-manager.ts";
import type { HostTool } from "../../src/agent-manager/host-tools.ts";
import type { SnapshotFiles } from "../../src/backup/files.ts";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import type { CardTypeDefinition } from "../../src/cards/registry.ts";
import { startDaemon, type Daemon } from "../../src/daemon.ts";
import type { Embedder } from "../../src/materials/embedding/embedder.ts";
import type { QuickActionExecutor } from "../../src/quick-actions/index.ts";
import type { FauxModelSpec, FauxStep, ModelSpec } from "../../src/runtime/index.ts";
import type { Clock } from "../../src/scheduler/clock.ts";
import type { ShellToolkit } from "../../src/typed-shell/index.ts";
import { FakeEmbedder } from "./embedder.ts";
import { ReportLog } from "./report-log.ts";
import { makeTempDir } from "./temp-dir.ts";
import { NO_LSM_ENV, tempUserProfileEnv, withEnv } from "./user-profile.ts";
import { NO_SPEECH_SERVICE_URL } from "./tts.ts";
import { fakeWebAccess } from "./web.ts";
import type { WebAccess } from "../../src/web/index.ts";
import { type FakeLoad, fakeRecognizerCommand, setFakeLoad } from "./voice.ts";

export interface TestDaemon {
  daemon: Daemon;
  dataDir: string;
  /** 守护进程和它的 agent 子进程眼里的用户主目录（临时目录） */
  homeDir: string;
  /** 本机端口的地址，如 http://127.0.0.1:54321（端口由系统挑，不占配置里的 8810） */
  url: string;
  /** 外网端口的地址（隧道的目标；端口由系统挑，不占配置里的 8811） */
  externalUrl: string;
  /** 网关提供的 Web UI 静态文件所在的目录（临时目录，里面是一个测试页） */
  webRoot: string;
  /** 守卫眼里的二狗程序目录（受保护区域之一） */
  programDir: string;
  /** 假的语音识别进程的记录文件（voice.ts 的 recognizerLog 读它；换了识别进程的命令时没人写它） */
  recognizerLog: string;
}

export interface StartTestDaemonOptions {
  /** 秘书的 faux 剧本：每一步对应一次模型调用；不填则秘书一被调用就得到错误回复 */
  secretary?: FauxStep[];
  /** 秘书流式输出的速度（token/秒）；不填则尽快吐完 */
  secretaryTokensPerSecond?: number;
  /** 维护者的 faux 模型每秒吐多少 token（不填是 pi 的默认，很快）：要维护者"正说着"的时候做点什么时用 */
  maintainerTokensPerSecond?: number;
  /**
   * 维护者的 faux 剧本：每一步对应一次模型调用。给函数时按维护者 id 和这是它第几次被唤起（1 起）给剧本
   * （闲置退出后再唤起是新的子进程，剧本从头开始，会话接着原来的）；不填则维护者一被调用就得到错误回复
   */
  maintainer?: FauxStep[] | ((maintainerId: string, spawn: number) => FauxStep[]);
  /**
   * 范围审视用的模型（faux 扮演便宜模型，18 号票）的剧本：按维护者 id 和它第几次被唤起（和 maintainer 一起数）给，每次审视取一步，
   * 回复要是约定的 JSON（{"records":[…]}）。不填（或者给的剧本用完了）是 NO_SCOPE_FINDINGS：每次审视都"在范围之内"
   */
  scopeReviewer?: (maintainerId: string, spawn: number) => FauxStep[];
  /** 范围审视用的 faux 模型每秒吐多少 token（不填是 pi 的默认，很快）：要审视"正做着"的时候发生点什么（比如到了闲置退出的时间）时用 */
  scopeReviewerTokensPerSecond?: number;
  /** 工单结束时的范围审视最多等多久（毫秒；不填是配置的单次模型调用超时再加半分钟）：测审视超时时用 */
  scopeReviewTimeoutMs?: number;
  /**
   * 评审子 agent 的 faux 剧本（13 号票）：每次评审一个新的子进程，按它的 agent id（review-<任务>-<阶段>-<第几次>）给剧本；
   * 不填则评审一被调用就得到错误回复（评审出错，验收不通过）
   */
  reviewer?: (reviewId: string) => FauxStep[];
  /**
   * 并行派出的子 agent 的 faux 剧本（20 号票）：每个子 agent 一个新的子进程，按它的 id（sa-<n>）和这是它第几次被拉起（1 起；
   * 工具包变了重新装配时再拉起，会话接着原来的）给剧本；不填则子 agent 一被调用就得到错误回复（交回维护者的是"出错了"）
   */
  subAgent?: (agentId: string, spawn: number) => FauxStep[];
  /** 直接指定秘书的模型（比如一个装配不起来的模型，测秘书起不来）；给了就不看 secretary 剧本 */
  secretaryModel?: ModelSpec;
  /** 秘书不在运行超过这么久 /healthz 报不健康（默认 30 秒） */
  secretaryDownThresholdMs?: number;
  /** 覆盖在守护进程环境上的变量（比如哨兵变量、模型 key） */
  env?: Record<string, string | undefined>;
  /** 沿用已有的数据目录和主目录（测"停掉再起"）；不填就新建临时目录 */
  reuse?: { dataDir: string; homeDir: string };
  /** Web UI 静态文件目录；不填就建一个临时目录，放一个测试页 */
  webRoot?: string;
  /** 守卫眼里的二狗程序目录；不填就建一个空的临时目录（测试不碰真实仓库） */
  programDir?: string;
  /** 两个端口照配置文件来（测"端口号从配置读"）；默认都由系统挑空闲端口，免得占用真正的 8810、8811 */
  portFromConfig?: boolean;
  /** WebSocket 心跳的间隔（毫秒）；默认 30 秒 */
  heartbeatIntervalMs?: number;
  /** 时钟（比如 ManualClock，到点不靠真等）；不填用系统时钟 */
  clock?: Clock;
  /** 额外登记（或替换）的卡片类型（比如 card-fixtures.ts 里的替身） */
  cardTypes?: readonly CardTypeDefinition[];
  /**
   * 素材的向量函数：默认是假的（embedder.ts 的 FakeEmbedder，不下载、不跑真模型）；
   * 写 "bge-m3" 用正式的（数据目录是临时的，模型区是空的，所以总是"模型不在"）
   */
  embedder?: Embedder | "bge-m3";
  /** 秘书额外的代为执行的工具（比如带"花钱"类别的，测"交给我做"） */
  secretaryTools?: readonly HostTool[];
  /** 起来之前写进数据目录 config/ergou.json 的配置（和已有的按顶层键合并），比如 { backup: { syncDir } }、{ approvals: { waitMinutes: 1 } } */
  config?: Record<string, unknown>;
  /** 备份往备份区写文件的实现（模拟空间不够、复制出错） */
  backupFiles?: SnapshotFiles;
  /** 守护进程的日志；不填就丢掉 */
  log?: (line: string) => void;
  /** 额外登记（或替换）的快速动作（比如 quick-action-fixtures.ts 里的替身） */
  quickActions?: readonly QuickActionExecutor[];
  /** 维护者会话的工具包（bash、联网开关）；不填是起草计划时的（没有 bash，70 号票起联网开着）。测带类型的 bash 工具时给开了 bash 的（28 号票） */
  maintainerToolkit?: (maintainerId: string) => ShellToolkit;
  /** GitHub 命令行换成假的（程序和它前面的固定参数，见 fixtures/fake-gh.mjs）；不填时是 PATH 上的 gh，测试里别让它真跑 */
  ghCommand?: readonly string[];
  /**
   * 语音识别进程的命令（31 号票）；不填是假的识别进程（fixtures/fake-recognizer.mjs，记录写进 recognizerLog），
   * 永远不跑真的 faster-whisper
   */
  recognizerCommand?: readonly string[];
  /** 假的识别进程加载模型时怎么回（45 号票：守护进程一起来就预热；见 voice.ts 的 FakeLoad、setFakeLoad）；不填照常加载 */
  recognizerLoad?: FakeLoad;
  /** 识别模型没加载起来、加载好很快又退出时，第几次之后隔多久再试（毫秒，45 号票）；不填是正式的（5 秒起） */
  recognizerRetryMs?: readonly number[];
  /** 识别进程加载好之后多久没崩算稳定（毫秒，45 号票）；不填是正式的 60 秒 */
  recognizerStableMs?: number;
  /** 发语音工具最多等合成多久就先交回"还在合成"（毫秒，86 号票）；不填是正式的 */
  sendVoiceWaitMs?: number;
  /**
   * 语音合成服务的地址（32 号票，代替本机 LSM 托管的 audio.cpp）：给 tts.ts 的假服务的地址；
   * 不填是本机 1 号端口（连不上），永远不打到本机 8090 上真的 audio.cpp
   */
  speechUrl?: string;
  /** 联网搜索、读网页（70 号票）：不填是假的、一律回"测试里不联网"（web.ts 的 fakeWebAccess），永远不起浏览器、不连真网络 */
  webAccess?: WebAccess;
  /** 浏览器的路径（70 号票：注入 agent 的 bash 环境的 AGENT_BROWSER_EXECUTABLE_PATH）：给假的路径；不填是没找到（不注入），不探测本机 */
  browserPath?: string;
  /**
   * 按设置里的"模型"拉起的几类 agent（73 号票）：列出的不给 faux 剧本，守护进程按设置取目录模型（DeepSeek），请求都发到
   * catalogBaseUrl（本机的假 DeepSeek，fake-deepseek.ts）；maintainer 是任务、项目、定时作业的维护者。不列的照旧是 faux
   */
  modelsFromSettings?: ReadonlyArray<"secretary" | "maintainer" | "reviewer" | "sub_agent" | "scope_review">;
  /**
   * 只有这些维护者按设置里的"模型"取目录模型（83 号票：定时作业的维护者用目录模型，建作业的任务的维护者照旧按 faux 剧本交计划）；
   * 项目维护者（pm-）按项目维护者的设置，别的按任务维护者的。modelsFromSettings 里有 maintainer 时不看它
   */
  maintainersFromSettings?: (maintainerId: string) => boolean;
  /** 目录模型（设置里的"模型"）的请求和连通测试发到哪（73 号票）；不填是本机 1 号端口（连不上），永远不连真的 DeepSeek */
  catalogBaseUrl?: string;
}

/** 目录模型（设置里的"模型"）默认的请求地址：本机 1 号端口，连不上（73 号票：测试里永远不连真的 DeepSeek） */
export const NO_CATALOG_URL = "http://127.0.0.1:1";

/** 范围审视的默认剧本（18 号票）：每次审视都回"这段工作都在范围之内"（够一个子进程审视很多次） */
export const NO_SCOPE_FINDINGS: readonly FauxStep[] = Array.from({ length: 30 }, () => ({ kind: "reply", text: '{"records":[]}' }) as const);

/** 测试页的内容：网关应当原样提供它 */
export const TEST_PAGE = "<!doctype html><html><head><title>二狗测试页</title></head><body><div id=\"root\"></div></body></html>\n";

/**
 * 起一个守护进程实例：
 * - 数据目录是临时目录；本机端口和外网端口都由系统挑空闲端口（都只听 127.0.0.1）；
 * - 秘书的模型换成 faux provider（按 options.secretary 的剧本回话），子进程真的拉起；
 * - 守护进程的环境取当前进程的环境，但 HOME、USERPROFILE、APPDATA、LOCALAPPDATA、HOMEDRIVE、HOMEPATH
 *   都换成临时主目录下的路径。守护进程按白名单把它们传给 agent 子进程，所以子进程看不到真实的用户主目录；
 * - options.env 再覆盖在上面（用来放哨兵变量之类）；
 * - 测试结束时停掉守护进程（关闭端口、关闭 Job 对象，残留的子进程一并清掉），再删目录。
 */
export async function startTestDaemon(options: StartTestDaemonOptions = {}): Promise<TestDaemon> {
  const dataDir = options.reuse?.dataDir ?? makeTempDir("ergou-data-");
  const homeDir = options.reuse?.homeDir ?? makeTempDir("ergou-home-");
  const webRoot = options.webRoot ?? makeTestWebRoot();
  const programDir = options.programDir ?? makeTempDir("ergou-program-");
  writeTestConfig(dataDir, options.config);
  // 每个子 agent 被拉起过几次（工具包变了重新装配时再拉起）
  const subAgentSpawns = new Map<string, number>();
  const recognizerLog = path.join(makeTempDir("ergou-asr-"), "recognizer.jsonl");
  if (options.recognizerLoad) setFakeLoad(recognizerLog, options.recognizerLoad);
  const fromSettings = new Set(options.modelsFromSettings ?? []);
  /** 按设置取模型的维护者要现取设置（守护进程起来之后才有） */
  let started: Daemon | undefined;
  const daemon = await startDaemon({
    env: withEnv(process.env, NO_LSM_ENV, tempUserProfileEnv(homeDir), options.env ?? {}, { ERGOU_DATA_DIR: dataDir }),
    homeDir,
    ...(options.portFromConfig ? {} : { localPort: 0, externalPort: 0 }),
    webRoot,
    programDir,
    ...(options.secretaryModel === undefined && fromSettings.has("secretary")
      ? {}
      : {
          secretaryModel:
            options.secretaryModel ??
            fauxModel(options.secretary ?? [], options.secretaryTokensPerSecond === undefined ? {} : { tokensPerSecond: options.secretaryTokensPerSecond }),
        }),
    ...(options.secretaryDownThresholdMs === undefined ? {} : { secretaryDownThresholdMs: options.secretaryDownThresholdMs }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.cardTypes === undefined ? {} : { extraCardTypes: options.cardTypes }),
    ...(options.embedder === "bge-m3" ? {} : { embedder: options.embedder ?? new FakeEmbedder() }),
    ...(options.heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
    ...(options.backupFiles === undefined ? {} : { backupFiles: options.backupFiles }),
    ...(options.secretaryTools === undefined ? {} : { extraSecretaryTools: options.secretaryTools }),
    ...(options.quickActions === undefined ? {} : { extraQuickActions: options.quickActions }),
    ...(options.maintainerToolkit === undefined ? {} : { maintainerToolkit: options.maintainerToolkit }),
    ...(options.ghCommand === undefined ? {} : { ghCommand: options.ghCommand }),
    ...(options.scopeReviewTimeoutMs === undefined ? {} : { scopeReviewTimeoutMs: options.scopeReviewTimeoutMs }),
    ...(fromSettings.has("maintainer")
      ? {}
      : {
          maintainerModel: (maintainerId: string, spawn: number) => {
            if (started && options.maintainersFromSettings?.(maintainerId)) return started.modelSettings.modelFor(maintainerId.startsWith("pm-") ? "project_maintainer" : "task_maintainer");
            const script = options.maintainer;
            return fauxModel(
              typeof script === "function" ? script(maintainerId, spawn) : (script ?? []),
              options.maintainerTokensPerSecond === undefined ? {} : { tokensPerSecond: options.maintainerTokensPerSecond },
            );
          },
        }),
    // 范围审视：给的剧本之后接上默认的"在范围之内"，不让别的用例因为工单结束时的审视而多出说明
    ...(fromSettings.has("scope_review")
      ? {}
      : {
          scopeReviewModel: (maintainerId: string, spawn: number) =>
            fauxModel(
              [...(options.scopeReviewer?.(maintainerId, spawn) ?? []), ...NO_SCOPE_FINDINGS],
              options.scopeReviewerTokensPerSecond === undefined ? {} : { tokensPerSecond: options.scopeReviewerTokensPerSecond },
            ),
        }),
    ...(fromSettings.has("reviewer") ? {} : { reviewerModel: (reviewId: string) => fauxModel(options.reviewer?.(reviewId) ?? []) }),
    ...(fromSettings.has("sub_agent")
      ? {}
      : {
          subAgentModel: (agentId: string) => {
            const spawn = (subAgentSpawns.get(agentId) ?? 0) + 1;
            subAgentSpawns.set(agentId, spawn);
            return fauxModel(options.subAgent?.(agentId, spawn) ?? []);
          },
        }),
    catalogBaseUrl: options.catalogBaseUrl ?? NO_CATALOG_URL,
    recognizerCommand: options.recognizerCommand ?? fakeRecognizerCommand(recognizerLog),
    ...(options.recognizerRetryMs === undefined ? {} : { recognizerRetryMs: options.recognizerRetryMs }),
    ...(options.recognizerStableMs === undefined ? {} : { recognizerStableMs: options.recognizerStableMs }),
    ...(options.sendVoiceWaitMs === undefined ? {} : { sendVoiceWaitMs: options.sendVoiceWaitMs }),
    speechUrl: options.speechUrl ?? NO_SPEECH_SERVICE_URL,
    webAccess: options.webAccess ?? fakeWebAccess(),
    browserPath: () => options.browserPath,
    log: options.log ?? (() => {}),
  });
  started = daemon;
  onTestFinished(() => daemon.stop());
  return { daemon, dataDir, homeDir, url: daemon.localUrl, externalUrl: daemon.externalUrl, webRoot, programDir, recognizerLog };
}

/**
 * 对话审批（70 号票）在测试底座里默认打开：已有的审批、"等你"、被杀后恢复这些用例测的就是这套机制（代码保留，配置一开就恢复）；
 * 测关掉的（正式的默认 off）显式写 config: { guard: { conversationApprovals: "off" } }。数据目录里已经写过 guard 的（停掉再起）不动
 */
export const TEST_GUARD_CONFIG = { guard: { conversationApprovals: "on" } } as const;

/** 起来之前写测试的配置：给的配置，加上底座默认的对话审批（给的、已经写过的 guard 优先） */
export function writeTestConfig(dataDir: string, config: Record<string, unknown> | undefined): void {
  const { configFile } = dataDirLayout(dataDir);
  const existing = fs.existsSync(configFile) ? (JSON.parse(fs.readFileSync(configFile, "utf8")) as Record<string, unknown>) : {};
  writeConfig(dataDir, { ...(existing.guard === undefined ? TEST_GUARD_CONFIG : {}), ...config });
}

/** 写数据目录里的配置文件：和已有的内容按顶层键合并 */
export function writeConfig(dataDir: string, config: Record<string, unknown>): void {
  const { config: dir, configFile } = dataDirLayout(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const existing = fs.existsSync(configFile) ? (JSON.parse(fs.readFileSync(configFile, "utf8")) as Record<string, unknown>) : {};
  fs.writeFileSync(configFile, JSON.stringify({ ...existing, ...config }, null, 2));
}

function makeTestWebRoot(): string {
  const dir = makeTempDir("ergou-web-");
  fs.writeFileSync(path.join(dir, "index.html"), TEST_PAGE);
  return dir;
}

/** faux 模型：按剧本回话，不连网 */
export function fauxModel(script: FauxStep[], options: { tokensPerSecond?: number } = {}): FauxModelSpec {
  return { kind: "faux", thinkingLevel: "off", script, ...options };
}

/**
 * 从现在起数守护进程拉起了几个 agent 子进程（测"到点的提醒不拉起任何 agent"这类）。
 * 测试接缝：包一层 agent 管家的 spawn（秘书和别的模块拿的是同一个管家对象），不放进正式接口。
 */
export function countAgentSpawns(daemon: Daemon): () => number {
  let count = 0;
  const spawn = daemon.agents.spawn.bind(daemon.agents);
  daemon.agents.spawn = (request) => {
    count += 1;
    return spawn(request);
  };
  return () => count;
}

/**
 * 从现在起守护进程拉起（或排队）了哪些 agent，按先后（测"确认前不拉起子 agent"这类）。测试接缝，同 countAgentSpawns
 */
export function agentSpawns(daemon: Daemon): () => string[] {
  const ids: string[] = [];
  const spawn = daemon.agents.spawn.bind(daemon.agents);
  daemon.agents.spawn = (request) => {
    ids.push(request.agentId);
    return spawn(request);
  };
  return () => [...ids];
}

/**
 * 拉起一个 agent 并开始记录它发来的消息。测试结束时先结束这个子进程
 * （它的工作目录可能是测试里建的临时目录，进程不退出目录删不掉）。
 */
export function spawnTestAgent(daemon: Daemon, request: SpawnAgentRequest): { agent: ManagedAgent; log: ReportLog } {
  const agent = daemon.agents.spawn(request);
  const log = new ReportLog(agent);
  onTestFinished(async () => {
    agent.kill();
    await agent.exited;
  });
  return { agent, log };
}
