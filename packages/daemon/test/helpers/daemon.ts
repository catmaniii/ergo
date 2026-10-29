// 在临时数据目录里起一个守护进程实例（测试的一部分，用完即销毁，不算服务，不在 LSM 登记），
// 秘书接 faux provider 按剧本回话；也能另外拉起接 faux provider 的 agent。
import fs from "node:fs";
import path from "node:path";
import { type ChatModel, FakeChatModel } from "@ergo/memory";
import { afterAll, beforeAll, onTestFinished } from "vitest";
import type { ManagedAgent, SpawnAgentRequest } from "../../src/agent-manager/agent-manager.ts";
import type { HostTool } from "../../src/agent-manager/host-tools.ts";
import type { SnapshotFiles } from "../../src/backup/files.ts";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import type { CardTypeDefinition } from "../../src/cards/registry.ts";
import type { SessionRollbackHook } from "../../src/conversation/rollback.ts";
import { startDaemon, type Daemon, type StartDaemonOptions } from "../../src/daemon.ts";
import type { Embedder } from "../../src/materials/embedding/embedder.ts";
import type { PluginDefinition } from "../../src/plugins/host.ts";
import { PLUGIN_MANIFEST } from "../../src/plugins/manifest.ts";
import type { QuickActionExecutor } from "../../src/quick-actions/index.ts";
import { REMINDERS, type ReminderService } from "../../src/reminders/api.ts";
import { VOICE } from "../../src/voice/api.ts";
import type { FauxModelSpec, FauxStep, ModelSpec } from "../../src/runtime/index.ts";
import type { Clock } from "../../src/scheduler/clock.ts";
import type { ShellToolkit } from "../../src/typed-shell/index.ts";
import { FakeEmbedder } from "./embedder.ts";
import { TestFrontend } from "./frontend.ts";
import { ReportLog } from "./report-log.ts";
import { makeTempDir, removeDir } from "./temp-dir.ts";
import { NO_LSM_ENV, tempUserProfileEnv, withEnv } from "./user-profile.ts";
import { NO_SPEECH_SERVICE_URL } from "./tts.ts";
import { fakeWebAccess } from "./web.ts";
import { fakeFfmpegCommand } from "./audio.ts";
import { fakeProbes, NO_DOWNLOADS } from "./fake-downloads.ts";
import type { WebAccess } from "../../src/web/index.ts";
import { type FakeLoad, fakeRecognizerCommand, setFakeLoad } from "./voice.ts";

/**
 * 测试里的守护进程：多一个 voiceReplies（214 号票起语音回复是语音插件的，守护进程不再直接带它；这里经插件的服务现取，
 * 测试照旧写 daemon.voiceReplies.whenIdle() 等识别、合成的队列空了。语音插件没在运行时马上回）
 */
export type TestDaemonHandle = Daemon & { readonly voiceReplies: { whenIdle(): Promise<void> } };

export interface TestDaemon {
  daemon: TestDaemonHandle;
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
  /** 假 ffmpeg 的记录文件（audio.ts 的 ffmpegLog 读它；换了 ffmpeg 的命令时没人写它） */
  ffmpegLog: string;
  /**
   * 共用守护进程（suiteDaemon）时它建的临时目录：不在用例结束时删（beforeAll 里没有当前用例），
   * 由 suiteDaemon 的 afterAll 删掉。每例一个的守护进程是空的（那些目录挂在当前用例的 onTestFinished 上）
   */
  tempDirs?: readonly string[];
}

export interface StartTestDaemonOptions {
  /** 秘书的 faux 剧本：每一步对应一次模型调用；不填则秘书一被调用就得到错误回复 */
  secretary?: FauxStep[];
  /** 秘书流式输出的速度（token/秒）；不填则尽快吐完 */
  secretaryTokensPerSecond?: number;
  /**
   * 记忆管理员的 faux 剧本（242 号票）：每一步对应一次模型调用。不填则它一被调用就得到错误回复
   * （03:00 那一夜照旧整理，失败也照旧记，不崩守护进程）
   */
  curator?: FauxStep[];
  /** 直接指定记忆管理员的模型（比如一个装配不起来的模型）；给了就不看 curator 剧本 */
  curatorModel?: ModelSpec;
  /**
   * 维护者的 faux 模型每秒吐多少 token（不填是 pi 的默认，很快）：要维护者"正说着"的时候做点什么时用。给函数时按维护者 id 和
   * 它第几次被唤起给（同 maintainer 的剧本；返回 undefined 是默认的快），只让某一次说得慢
   */
  maintainerTokensPerSecond?: number | ((maintainerId: string, spawn: number) => number | undefined);
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
  /** 从某个阶段重做之前停稳维护者最多等多久（毫秒；不填是 10 秒）：测到点没停下的那一轮作废时用（84 号票） */
  reworkStopTimeoutMs?: number;
  /**
   * 评审子 agent 的 faux 剧本（13 号票）：每次评审一个新的子进程，按它的 agent id（review-<任务>-<阶段>-<第几次>）给剧本；
   * 不填则评审一被调用就得到错误回复（评审出错，验收不通过）
   */
  reviewer?: (reviewId: string) => FauxStep[];
  /** 评审子 agent 的 faux 模型每秒吐多少 token（不填是 pi 的默认，很快）：要评审"正评着"的时候做点什么（比如删任务）时用 */
  reviewerTokensPerSecond?: number;
  /** 设置页选文件夹的框列的各个盘（138 号票）；不给是一个盘也没有（测试不去看本机的盘） */
  folderDrives?: () => Promise<string[]>;
  /** 设置 · 数据源的"在电脑上打开"导入文件夹（295 号票）；不给是打不开（测试永远不拉起资源管理器） */
  openFolder?: (dir: string) => Promise<void>;
  /**
   * 设置 · 组件（323 号票）：清单、检测、下载那一层……换成测试的（helpers/fake-downloads.ts）。不给的几样：检测是固定的
   * （没有 N 卡、什么都没检测到），下载那一层什么都不下（测试永远不连真的下载地址），清单是随程序发布的那份
   */
  components?: StartDaemonOptions["components"];
  /**
   * 并行派出的子 agent 的 faux 剧本（20 号票）：每个子 agent 一个新的子进程，按它的 id（sa-<n>）和这是它第几次被拉起（1 起；
   * 工具包变了重新装配时再拉起，会话接着原来的）给剧本；不填则子 agent 一被调用就得到错误回复（交回维护者的是"出错了"）
   */
  subAgent?: (agentId: string, spawn: number) => FauxStep[];
  /** 直接指定秘书的模型（比如一个装配不起来的模型，测秘书起不来）；给了就不看 secretary 剧本 */
  secretaryModel?: ModelSpec;
  /**
   * 翻斜杠命令的说明用的 faux 剧本（310 号票）：每批一个新的子进程，剧本从头开始，每条说明取一步。不填是不翻（显示原文）——
   * 免得跟随秘书时秘书的剧本被翻译吃掉
   */
  translator?: FauxStep[];
  /** 秘书不在运行超过这么久 /healthz 报不健康（默认 30 秒） */
  secretaryDownThresholdMs?: number;
  /**
   * 任务做完告诉秘书（99 号票）：做完一件之后安静多久（毫秒，按 clock 算）才交给秘书。不填是 TASK_DONE_TEST_SETTLE_MS（200 毫秒，
   * 免得每个做完的任务都多等正式的 2 秒）；测"几件差不多同时做完的并成一条"时给大一点，配手动拨的时钟
   */
  taskDoneSettleMs?: number;
  /** 覆盖在守护进程环境上的变量（比如哨兵变量、模型 key） */
  env?: Record<string, string | undefined>;
  /** 沿用已有的数据目录和主目录（测"停掉再起"）；不填就新建临时目录 */
  reuse?: { dataDir: string; homeDir: string };
  /**
   * 第一次装（315 号票）：数据目录是一个还不存在的新目录（临时目录下面的一层），也不写测试的配置文件（守卫、语音的测试设置都不写，
   * 照正式的默认）——看守护进程自己把数据目录建好。和 reuse、config、plugins 不一起用
   */
  fresh?: boolean;
  /**
   * 不写测试的配置文件（315 号票）：数据目录里的配置文件原样（测试自己先写好的、上一次留下的），守卫、语音、预算的测试设置都不加——
   * 看新装 / 已有的数据目录各按什么默认起来。fresh 隐含它
   */
  keepConfig?: boolean;
  /** Web UI 静态文件目录；不填就建一个临时目录，放一个测试页 */
  webRoot?: string;
  /** 守卫眼里的二狗程序目录；不填就建一个空的临时目录（测试不碰真实仓库） */
  programDir?: string;
  /** 两个端口照配置文件来（测"端口号从配置读"）；默认都由系统挑空闲端口，免得占用真正的 8810、8811 */
  portFromConfig?: boolean;
  /** WebSocket 心跳的间隔（毫秒）；默认 30 秒 */
  heartbeatIntervalMs?: number;
  /** 多久看一眼 index.html 换没换（毫秒，116 号票）；默认 2 秒 */
  webVersionPollMs?: number;
  /** 交给官方 App 的会话多久只读跟随一次（292 号票）；不填 60 秒 */
  remoteFollowMs?: number;
  /** 多久看一眼数据目录的 locales/ 变没变（毫秒，168 号票）；不填 200 毫秒（测试里放了语言文件很快就看得到） */
  localesPollMs?: number;
  /**
   * 时钟（比如 ManualClock，到点不靠真等）；不填用系统时钟。
   * 265 号票：给了时钟时默认停掉记忆插件（见 memoryPlugin）——拨时钟跨过 03:00 会在后台唤醒记忆管理员、多拉一个子进程调一次模型
   */
  clock?: Clock;
  /**
   * 记忆插件开不开（265 号票）。不填：给了 clock 就停掉（记忆插件 03:00 的作业会在后台唤醒记忆管理员，拉起一个 pi 子进程调一次模型、
   * 记一笔系统开销，赶没赶在断言之前全看机器忙不忙——255 号票查出的竞态；拨时钟的用例大多跨过 03:00），没给 clock 照清单全装。
   * 测记忆的（素材采集、素材检索、问记忆、推理库、每晚整理、记忆管理员）又给了 clock 的写 true。
   * 给了 plugins、config.plugins，或者沿用的数据目录已经起过守护进程（停掉再起）时，不填就照它们的（不再按 clock 默认停）
   */
  memoryPlugin?: boolean;
  /** 额外登记（或替换）的卡片类型（比如 card-fixtures.ts 里的替身） */
  cardTypes?: readonly CardTypeDefinition[];
  /**
   * 素材的向量函数：默认是假的（embedder.ts 的 FakeEmbedder，不下载、不跑真模型）；
   * 写 "bge-m3" 用正式的（数据目录是临时的，模型区是空的，所以总是"模型不在"）
   */
  embedder?: Embedder | "bge-m3";
  /**
   * 记忆整理用的模型（225 号票）：不填给假模型（每次整理新建一个，回空对象，永远不连真的 DeepSeek——测试环境里
   * 可能带着真的 DEEPSEEK_API_KEY）；要观察它被问了几次就给自己的工厂
   */
  memoryModel?: () => ChatModel;
  /** 秘书额外的代为执行的工具（比如带"花钱"类别的，测"交给我做"） */
  secretaryTools?: readonly HostTool[];
  /** 起来之前写进数据目录 config/ergo.json 的配置（和已有的按顶层键合并），比如 { backup: { syncDir } }、{ approvals: { waitMinutes: 1 } } */
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
  /**
   * 参考音色导入时把常见音频转成 WAV 的 ffmpeg 命令（230 号票）；不填是假的 ffmpeg（fixtures/fake-ffmpeg.mjs，
   * 记录写进 ffmpegLog），永远不跑本机的 ffmpeg
   */
  ffmpegCommand?: readonly string[];
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
  /**
   * DeepSeek 的联网搜索、读网页接口的地址（154 号票）：给本机假服务的地址（fake-deepseek-tools.ts）；不填是本机 1 号端口（连不上），
   * 永远不连真的 DeepSeek（测试环境里可能带着真的 DEEPSEEK_API_KEY）
   */
  webDeepseekBaseUrl?: string;
  /** 项目的服务首页怎么截（140 号票）：不填是一律截不成（"测试里不截图"），永远不起浏览器 */
  serviceThumbnail?: (url: string, signal: AbortSignal) => Promise<Buffer>;
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
  /**
   * 只装这些插件（126 号票，插件清单 plugins/manifest.ts 里的名字）；不填是全装。走真实的装配路径：清单里别的插件写进数据目录配置的
   * plugins.disabled（和 config 里给的 plugins.disabled 合起来），守护进程照常按组合根和插件清单起来，不手挂插件
   */
  plugins?: readonly string[];
  /** 接在插件清单后面的插件（126 号票：比如装不上的，测降级），和清单里的走同一条装配路径 */
  extraPlugins?: readonly PluginDefinition[];
  /** 会话回退之后的撤销接口（150 号票）：测"回退之后调到了它"；不填是守护进程默认的什么都不做 */
  sessionRollbackHook?: SessionRollbackHook;
  /**
   * 用例结束就停掉（默认）。一个 describe 共用一个守护进程时写 false（用 suiteDaemon 起它，由 afterAll 停，
   * 或者在测试文件里自己 afterAll(() => td.daemon.stop())）——245 号票
   */
  stopOnTestFinished?: boolean;
}

/** 测试里任务做完告诉秘书默认安静多久（毫秒，99 号票）：比正式的 2 秒短，做完的通知马上就到 */
export const TASK_DONE_TEST_SETTLE_MS = 200;

/** 目录模型（设置里的"模型"）默认的请求地址：本机 1 号端口，连不上（73 号票：测试里永远不连真的 DeepSeek） */
export const NO_CATALOG_URL = "http://127.0.0.1:1";

/** DeepSeek 的联网搜索、读网页接口默认的地址：本机 1 号端口，连不上（154 号票：测试里永远不连真的 DeepSeek） */
export const NO_DEEPSEEK_TOOLS_URL = "http://127.0.0.1:1";

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
  // 每例一个的（默认）临时目录挂在当前用例的 onTestFinished 上；共用的（suiteDaemon 在 beforeAll 里调）不能那样，
  // onTestFinished 在用例外面会抛错——改成记下来，收回在 suiteDaemon 的 afterAll（245 号票）
  const deferCleanup = options.stopOnTestFinished === false;
  const tempDirs: string[] = [];
  const tempDir = (prefix: string): string => {
    const dir = makeTempDir(prefix, deferCleanup);
    if (deferCleanup) tempDirs.push(dir);
    return dir;
  };
  const dataDir = options.reuse?.dataDir ?? (options.fresh ? path.join(tempDir("ergo-fresh-"), "ergo-data") : tempDir("ergo-data-"));
  const homeDir = options.reuse?.homeDir ?? tempDir("ergo-home-");
  const webRoot = options.webRoot ?? makeTestWebRoot(tempDir);
  const programDir = options.programDir ?? tempDir("ergo-program-");
  if (!options.fresh && !options.keepConfig) writeTestConfig(dataDir, withMemoryPlugin(withOnlyPlugins(options.config, options.plugins), options, dataDir));
  // 每个子 agent 被拉起过几次（工具包变了重新装配时再拉起）
  const subAgentSpawns = new Map<string, number>();
  const recognizerLog = path.join(tempDir("ergo-asr-"), "recognizer.jsonl");
  if (options.recognizerLoad) setFakeLoad(recognizerLog, options.recognizerLoad);
  const ffmpegLog = path.join(tempDir("ergo-ffmpeg-"), "ffmpeg.jsonl");
  const fromSettings = new Set(options.modelsFromSettings ?? []);
  /** 按设置取模型的维护者要现取设置（守护进程起来之后才有） */
  let started: Daemon | undefined;
  const daemon = await startDaemon({
    env: withEnv(process.env, NO_LSM_ENV, tempUserProfileEnv(homeDir), options.env ?? {}, { ERGO_DATA_DIR: dataDir }),
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
    // 310 号票：翻斜杠命令的说明（不填是不翻）
    slashTranslationModel: options.translator === undefined ? null : fauxModel(options.translator),
    // 242 号票：记忆管理员的模型（不填是空的 faux 剧本：一被调用就出错，和秘书的默认一样）
    curatorModel: options.curatorModel ?? fauxModel(options.curator ?? []),
    taskDoneSettleMs: options.taskDoneSettleMs ?? TASK_DONE_TEST_SETTLE_MS,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.cardTypes === undefined ? {} : { extraCardTypes: options.cardTypes }),
    ...(options.extraPlugins === undefined ? {} : { extraPlugins: options.extraPlugins }),
    ...(options.sessionRollbackHook === undefined ? {} : { sessionRollbackHook: options.sessionRollbackHook }),
    ...(options.embedder === "bge-m3" ? {} : { embedder: options.embedder ?? new FakeEmbedder() }),
    // 记忆整理用的模型：没给就是假的（假模型立即回空对象，作业照常跑、永远不连真的 DeepSeek）
    memoryModel: options.memoryModel ?? (() => new FakeChatModel(() => ({}))),
    ...(options.heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
    ...(options.webVersionPollMs === undefined ? {} : { webVersionPollMs: options.webVersionPollMs }),
    ...(options.remoteFollowMs === undefined ? {} : { remoteFollowMs: options.remoteFollowMs }),
    localesPollMs: options.localesPollMs ?? 200,
    ...(options.backupFiles === undefined ? {} : { backupFiles: options.backupFiles }),
    ...(options.secretaryTools === undefined ? {} : { extraSecretaryTools: options.secretaryTools }),
    ...(options.quickActions === undefined ? {} : { extraQuickActions: options.quickActions }),
    ...(options.maintainerToolkit === undefined ? {} : { maintainerToolkit: options.maintainerToolkit }),
    ...(options.ghCommand === undefined ? {} : { ghCommand: options.ghCommand }),
    ...(options.scopeReviewTimeoutMs === undefined ? {} : { scopeReviewTimeoutMs: options.scopeReviewTimeoutMs }),
    ...(options.reworkStopTimeoutMs === undefined ? {} : { reworkStopTimeoutMs: options.reworkStopTimeoutMs }),
    ...(fromSettings.has("maintainer")
      ? {}
      : {
          maintainerModel: (maintainerId: string, spawn: number) => {
            if (started && options.maintainersFromSettings?.(maintainerId)) return started.modelSettings.modelFor(maintainerId.startsWith("pm-") ? "project_maintainer" : "task_maintainer", maintainerId);
            const script = options.maintainer;
            const speed = options.maintainerTokensPerSecond;
            const tokensPerSecond = typeof speed === "function" ? speed(maintainerId, spawn) : speed;
            return fauxModel(typeof script === "function" ? script(maintainerId, spawn) : (script ?? []), tokensPerSecond === undefined ? {} : { tokensPerSecond });
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
    ...(fromSettings.has("reviewer")
      ? {}
      : {
          reviewerModel: (reviewId: string) =>
            fauxModel(options.reviewer?.(reviewId) ?? [], options.reviewerTokensPerSecond === undefined ? {} : { tokensPerSecond: options.reviewerTokensPerSecond }),
        }),
    folderDrives: options.folderDrives ?? (() => Promise.resolve([])),
    openFolder: options.openFolder ?? (() => Promise.reject(new Error("测试里不打开文件夹"))),
    components: { probes: fakeProbes(), transport: NO_DOWNLOADS, ...options.components },
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
    ffmpegCommand: options.ffmpegCommand ?? fakeFfmpegCommand(ffmpegLog),
    ...(options.recognizerRetryMs === undefined ? {} : { recognizerRetryMs: options.recognizerRetryMs }),
    ...(options.recognizerStableMs === undefined ? {} : { recognizerStableMs: options.recognizerStableMs }),
    ...(options.sendVoiceWaitMs === undefined ? {} : { sendVoiceWaitMs: options.sendVoiceWaitMs }),
    speechUrl: options.speechUrl ?? NO_SPEECH_SERVICE_URL,
    webAccess: options.webAccess ?? fakeWebAccess(),
    webDeepseekBaseUrl: options.webDeepseekBaseUrl ?? NO_DEEPSEEK_TOOLS_URL,
    serviceThumbnail: options.serviceThumbnail ?? (() => Promise.reject(new Error("测试里不截图"))),
    browserPath: () => options.browserPath,
    log: options.log ?? (() => {}),
  });
  started = daemon;
  if (options.stopOnTestFinished !== false) onTestFinished(() => daemon.stop());
  return {
    daemon: withVoiceReplies(daemon),
    dataDir,
    homeDir,
    url: daemon.localUrl,
    externalUrl: daemon.externalUrl,
    webRoot,
    programDir,
    recognizerLog,
    ffmpegLog,
    ...(deferCleanup ? { tempDirs } : {}),
  };
}

/*
 * 245 号票试过、撤掉了：`waitForJobProcesses(td)`——等 Windows Job 里比此刻多出进程（bash 和它跑的命令都在 Job 里），
 * 用来把"触发之后真等 1.5 秒猜命令跑起来了"换成事件驱动。单独跑的时候能省 1–1.5 秒/处，但并行跑（2 workers、
 * 机器上还有别的活）时子进程起来要十几秒，等待会超时；而且如果命令在我们取基线之前就已经起来了，进程数不会再涨，
 * 只能干等。固定 1.5 秒虽然糙，但对"它大概已经在跑了"这件事更稳，所以调用点全部还原了。
 * 以后要做对，得让命令自己留个记号（比如 `touch started; sleep 20` 然后等那个文件），别数进程。
 */

/**
 * 一个 describe 里共用一个守护进程（245 号票）：在 describe 体里调用（收集用例的时候），它自己注册 beforeAll / afterAll，
 * 返回取这个守护进程的函数——用例里写 `const td = shared();`。
 *
 * 共用时用例之间必须互不相干，照这几条写：
 * - **事件**：用 `connectFrontend(td, 频道)` 连前端。它订阅的是"这一刻往后"，前面用例的事件不会补发进来；
 *   前端上收到的东西只算这一例的（`frontend.next(...)` 照旧按先后断言）。
 * - **数据**：每例自己新建任务 / 项目 / 定时作业，断言只看自己建出来的那些（按 id、标题、卡片 id 找）；
 *   不要数"待我处理里一共有几条"这种全局数量——那是别的用例也会动的。
 * - **收尾**：在 beforeAll 里调一次 `cleanSharedState(td)`；用例自己建的东西不用收（下一个用例不看你留下的）。
 * - **并发**：前一个用例的 agent 还可能在跑（比如它没等 turn 结束就结束了）。会被别的 agent 影响断言的地方，
 *   必须等到自己要的事件（`frontend.next(...)`、`waitUntil`）再断言，不能靠 `setTimeout` 猜。
 *
 * **不能共用的**（老老实实每例 startTestDaemon）：验重启 / 崩溃 / 被杀、改配置再起、闲置退出、看"数据目录从零开始"的；
 * 还有每例的 faux 剧本不一样、而剧本是随守护进程一次给死的（秘书的剧本就是这样：共用就只能按顺序接下去，
 * 用例会变得顺序敏感）。维护者 / 评审 / 子 agent 的剧本是按 agent id 和拉起次数现给函数，可以共用，但也是各用例各自算次数。
 */
export function suiteDaemon(options: StartTestDaemonOptions = {}): () => TestDaemon {
  let shared: TestDaemon | undefined;
  beforeAll(async () => {
    shared = await startTestDaemon({ ...options, stopOnTestFinished: false });
  });
  afterAll(async () => {
    const stopped = shared;
    shared = undefined;
    await stopped?.daemon.stop();
    for (const dir of stopped?.tempDirs ?? []) removeDir(dir);
  });
  return () => {
    if (shared === undefined) throw new Error("suiteDaemon 的守护进程还没起来：只能在它的 describe 的用例或 beforeAll 里取");
    return shared;
  };
}

/**
 * 连上一个（通常是共用的）守护进程的测试前端：带每个频道此刻的最后序号订阅，只收这以后的事件。
 * 共用守护进程时用它代替 TestFrontend.connect + subscribe({[频道]: 0})，前面用例的事件不会补发进来。测试结束时自动断开
 */
export async function connectFrontend(td: TestDaemon, channels: readonly string[]): Promise<TestFrontend> {
  const frontend = await TestFrontend.connect(td.url);
  await frontend.subscribe(Object.fromEntries(channels.map((channel) => [channel, td.daemon.store.lastSeq(channel)])));
  return frontend;
}

/**
 * 共用守护进程的"净底"（245 号票）：在 beforeAll 里调一次，把上一个用例留下的收掉——
 * 待我处理里没处理完的归档（它们的状态、计数会干扰"待我处理里有几条"这类断言），没结束的任务取消
 * （不然它一直占着全局执行名额，还会往待我处理里塞新事项）。用例自己建的东西不在这里收：下一个用例不看它。
 */
export async function cleanSharedState(td: TestDaemon): Promise<void> {
  const pending = td.daemon.inbox.list().filter((item) => !td.daemon.inbox.isProcessed(item));
  if (pending.length > 0) td.daemon.inbox.act({ itemIds: pending.map((item) => item.id), action: "archive", idempotencyKey: `clean-shared-state-${Date.now()}` });
  const open = td.daemon.tasks.list().filter((task) => task.state !== "done" && task.state !== "cancelled" && task.state !== "archived");
  if (open.length === 0) return;
  const frontend = await TestFrontend.connect(td.url);
  try {
    for (const task of open) await frontend.taskAction({ taskId: task.id, action: "cancel" });
  } finally {
    await frontend.close();
  }
}

/**
 * 对话审批（70 号票）在测试底座里默认打开：已有的审批、"等你"、被杀后恢复这些用例测的就是这套机制（代码保留，配置一开就恢复）；
 * 测关掉的（正式的默认 off）显式写 config: { guard: { conversationApprovals: "off" } }。数据目录里已经写过 guard 的（停掉再起）不动
 */
export const TEST_GUARD_CONFIG = { guard: { conversationApprovals: "on" } } as const;

/**
 * 只装给的插件（126 号票）：清单里别的写进配置的 plugins.disabled（和给的合起来）。不给 only 时配置原样。
 * 沿用数据目录（reuse）时也照写：这次给了 only 就以这次的为准，没给就保留数据目录配置里原来的
 */
function withOnlyPlugins(config: Record<string, unknown> | undefined, only: readonly string[] | undefined): Record<string, unknown> | undefined {
  if (only === undefined) return config;
  const given = ((config?.plugins as { disabled?: string[] } | undefined)?.disabled ?? []).filter((name) => !only.includes(name));
  const disabled = [...new Set([...given, ...PLUGIN_MANIFEST.map((p) => p.name).filter((name) => !only.includes(name))])];
  return { ...config, plugins: { ...(config?.plugins as Record<string, unknown> | undefined), disabled } };
}

/** 插件清单里记忆插件的名字 */
const MEMORY_PLUGIN = "memory";

/**
 * 记忆插件开不开（265 号票，见 StartTestDaemonOptions.memoryPlugin）：给了 memoryPlugin 照它；没给、给了 clock、
 * 用例和数据目录都还没定过插件时停掉。停掉写进配置的 plugins.disabled（走真实的装配路径，和 plugins 一样）；
 * 打开只在配置里本来停着它时拿掉（默认就是开着的，不多写一个空的 plugins）
 */
function withMemoryPlugin(config: Record<string, unknown> | undefined, options: StartTestDaemonOptions, dataDir: string): Record<string, unknown> | undefined {
  const on = options.memoryPlugin ?? (options.clock !== undefined && !pluginsChosen(config, options, dataDir) ? false : undefined);
  if (on === undefined) return config;
  const { configFile } = dataDirLayout(dataDir);
  const existing = fs.existsSync(configFile) ? (JSON.parse(fs.readFileSync(configFile, "utf8")) as { plugins?: { disabled?: string[] } }).plugins : undefined;
  const plugins = (config?.plugins as { disabled?: string[] } | undefined) ?? existing;
  const disabled = plugins?.disabled ?? [];
  if (on === disabled.every((name) => name !== MEMORY_PLUGIN)) return config;
  const others = disabled.filter((name) => name !== MEMORY_PLUGIN);
  return { ...config, plugins: { ...plugins, disabled: on ? others : [...others, MEMORY_PLUGIN] } };
}

/** 插件已经定过了：用例给了 plugins / config.plugins，或者沿用的数据目录里写过插件、起过守护进程（停掉再起照上次的） */
function pluginsChosen(config: Record<string, unknown> | undefined, options: StartTestDaemonOptions, dataDir: string): boolean {
  if (options.plugins !== undefined || config?.plugins !== undefined) return true;
  const { configFile, db } = dataDirLayout(dataDir);
  if (fs.existsSync(path.join(db, "ergo.db"))) return true;
  return fs.existsSync(configFile) && (JSON.parse(fs.readFileSync(configFile, "utf8")) as { plugins?: unknown }).plugins !== undefined;
}

/** 守护进程加上 voiceReplies（见 TestDaemonHandle） */
function withVoiceReplies(daemon: Daemon): TestDaemonHandle {
  return Object.defineProperty(daemon, "voiceReplies", {
    get: () => ({ whenIdle: () => daemon.plugins.service(VOICE)?.whenIdle() ?? Promise.resolve() }),
  }) as TestDaemonHandle;
}

/**
 * 起来之前写测试的配置：给的配置，加上底座默认的对话审批（给的、已经写过的 guard 优先）、不自动重试识别（withTestVoice）
 * 和预算控制关着（withTestTasks）
 */
export function writeTestConfig(dataDir: string, config: Record<string, unknown> | undefined): void {
  const { configFile } = dataDirLayout(dataDir);
  const existing = fs.existsSync(configFile) ? (JSON.parse(fs.readFileSync(configFile, "utf8")) as Record<string, unknown>) : {};
  writeConfig(dataDir, { ...(existing.guard === undefined ? TEST_GUARD_CONFIG : {}), ...withTestTasks(withTestVoice(config, existing), existing) });
}

/**
 * 预算控制（93 号票）在测试底座里照旧关着（tasks.thresholds.budgetControl: false）：315 号票起新装的数据目录（还没有事件库）起来时
 * 守护进程把它打开、写进配置文件，而测试的临时数据目录都是"新装"——明着写上关着，用例照原来的行为。测预算的显式写 true；
 * 数据目录里已经写过的（停掉再起）不动
 */
function withTestTasks(config: Record<string, unknown> | undefined, existing: Record<string, unknown>): Record<string, unknown> | undefined {
  const tasks = (config?.tasks ?? existing.tasks) as { thresholds?: Record<string, unknown> } | undefined;
  // 故意写错的（测配置报错的）原样留着
  if ((tasks !== undefined && !isObject(tasks)) || (tasks?.thresholds !== undefined && !isObject(tasks.thresholds))) return config;
  if (tasks?.thresholds?.budgetControl !== undefined) return config;
  return { ...config, tasks: { ...tasks, thresholds: { ...tasks?.thresholds, budgetControl: false } } };
}

/** 是个对象（不是数组、null） */
const isObject = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * 语音识别没做成时的自动重试（208 号票，正式的隔 15 秒、60 秒、3 分钟）在测试底座里默认关掉（voice.recognizer.autoRetrySeconds: []）：
 * 识别失败马上有结局，别的用例不用等。测自动重试的显式写 config: { voice: { recognizer: { autoRetrySeconds: [...] } } }；
 * 数据目录里已经写过的（停掉再起）不动
 */
function withTestVoice(config: Record<string, unknown> | undefined, existing: Record<string, unknown>): Record<string, unknown> | undefined {
  const voice = (config?.voice ?? existing.voice) as { recognizer?: Record<string, unknown> } | undefined;
  // 故意写错的（测配置报错的）原样留着
  if ((voice !== undefined && !isObject(voice)) || (voice?.recognizer !== undefined && !isObject(voice.recognizer))) return config;
  if (voice?.recognizer?.autoRetrySeconds !== undefined) return config;
  return { ...config, voice: { ...voice, recognizer: { ...voice?.recognizer, autoRetrySeconds: [] } } };
}

/** 写数据目录里的配置文件：和已有的内容按顶层键合并 */
export function writeConfig(dataDir: string, config: Record<string, unknown>): void {
  const { config: dir, configFile } = dataDirLayout(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const existing = fs.existsSync(configFile) ? (JSON.parse(fs.readFileSync(configFile, "utf8")) as Record<string, unknown>) : {};
  fs.writeFileSync(configFile, JSON.stringify({ ...existing, ...config }, null, 2));
}

function makeTestWebRoot(tempDir: (prefix: string) => string): string {
  const dir = tempDir("ergo-web-");
  fs.writeFileSync(path.join(dir, "index.html"), TEST_PAGE);
  return dir;
}

/** faux 模型：按剧本回话，不连网 */
export function fauxModel(script: FauxStep[], options: { tokensPerSecond?: number } = {}): FauxModelSpec {
  return { kind: "faux", thinkingLevel: "off", script, ...options };
}

/** 提醒插件提供的服务（126 号票：提醒是插件，经插件宿主按名字取）；提醒插件没在运行时报错 */
export function reminderService(daemon: Daemon): ReminderService {
  const service = daemon.plugins.service(REMINDERS);
  if (!service) throw new Error("提醒插件没在运行");
  return service;
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
