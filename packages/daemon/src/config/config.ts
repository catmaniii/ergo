// 配置：只读。
// - 数据目录：环境变量 ERGO_DATA_DIR 指定；没指定时取用户主目录下的 .ergo（主目录由调用方传入，不写死）。
//   312 号票起旧名字也认：ERGO_DATA_DIR 没设看旧的变量名，.ergo 不在而旧的目录在时用旧的（config/old-names.ts），守护进程启动时提示一次。
// - 其余配置：数据目录里的 config/ergo.json，缺省的项取默认值。仓库里只有示例 config/ergo.example.json。
import fs from "node:fs";
import path from "node:path";
import { BACKUP_SCHEDULES, type BackupSchedule, ClockTime, DEFAULT_MAX_UPLOAD_BYTES, MEMORY_PROVIDER_ID, schemaChecker, SETUP_STEPS, type SetupStepId, type TokenPrice } from "@ergo/protocol";
import { type AgentLimits, DEFAULT_AGENT_LIMITS } from "../agent-manager/agent-manager.ts";
import { CONVERSATION_APPROVALS, type ConversationApprovals } from "../guard/types.ts";
import { DEFAULT_REMINDER_THRESHOLDS, type ReminderThresholds } from "../reminders/thresholds.ts";
import { DEFAULT_SCHEDULED_JOB_THRESHOLDS, type ScheduledJobThresholds } from "../scheduled-jobs/index.ts";
import { DEFAULT_EVENT_SOURCE_THRESHOLDS, type EventSourceThresholds } from "../event-sources/thresholds.ts";
import { DEFAULT_TASK_THRESHOLDS, type TaskThresholds } from "../tasks/thresholds.ts";
import type { SpokenPace } from "../voice/spoken-text.ts";
import { writeJsonAtomic } from "../util/json-file.ts";
import { dataDirLayout, DEFAULT_MEMORY_PROVIDER_ID } from "./data-dir.ts";
import { DATA_DIR_ENV, type DataDirSource, resolveDataDir } from "./old-names.ts";

export { modelConfigKey } from "./model-key.ts";

export interface Ports {
  /** 本机端口：只监听 127.0.0.1，自动信任（规格第 6 节） */
  local: number;
  /** 外网端口：隧道的唯一目标，每个请求都要带设备凭证 */
  external: number;
}

/** 素材（08 号票） */
export interface MaterialsConfig {
  /** 建议卡、提问卡多少天没处理算回避信号 */
  staleCardDays: number;
}

/**
 * 记忆（225 号票）：每晚 03:00 的推理库整理。配置里写 memory: { maxModelCalls, extractor, sensitiveCategories, enabled, nightlyTimeoutMinutes,
 * curator: { maxModelCalls } }，缺省 200 次调用、模型版抽事实（照评测的设置：约 ¥0.3–0.8/天）；用完就停，下一次整理接着做没跑完的。
 * 236 号票起抽事实默认也是模型版（`LlmFactExtractor`，和推理用同一个模型、同一份预算），规则版只当兜底/省钱。
 * 235 号票加 enabled（默认 true）：这台机器上跑不跑整理。**和"插件停用"是两回事**：插件停用（plugins.disabled 里写 memory）
 * 是整个记忆插件不在——不采不整理、素材检索和问记忆也没有；enabled: false 只是不整理（不登记 03:00 的内部作业、不建 rg.db、
 * 不花模型的调用），素材采集、素材检索、每轮简报和 ask_memory 照旧用已有的推理库。
 * 237 号票起每一夜有墙钟上限（nightlyTimeoutMinutes，默认 60）：到点中止、记一条失败（整理超时）、下一夜照常。
 * 中止只能在能回到事件循环的点生效（等模型、等 IO、等推后）；卡在本地同步死循环里时它停不下来。
 * 242 号票加 curator：记忆管理员（03:00 被唤醒去整理、平时能找它说话的那个按需拉起的 agent）自己每夜额外最多调几次模型
 * （默认 8，只做叙述和判断；引擎那 200 次照旧是硬上限）。跑满就停、下一夜照常；次数记进那一夜的整理记录。
 */
export interface MemoryConfig {
  /** 一次整理最多调几次模型（正整数）：抽事实和整理一起算在这份预算里 */
  maxModelCalls: number;
  /** 抽事实用哪个：model（默认，和评测一致）| rule（规则版，不调模型） */
  extractor: MemoryExtractor;
  /**
   * 敏感类别（234 号票）：健康、情绪、财务、关系、位置（295 号票加的）。**默认是空 = 都允许记录、不用于推断**；列表里写的是
   * "允许用来推断的"类别（设置里逐类打开）。v1 只有健康按场景标签 domain=health 生效；
   * 情绪、财务、关系、位置是开关占位（现在没有对应的场景标签，写进来也不改变行为），见 docs/developer-guide.md 的"记忆系统"一节
   */
  sensitiveCategories: readonly SensitiveCategory[];
  /** 这台机器上跑不跑整理（默认 true）：false = 不排 03:00 的作业、不建库，手动整理也回"关着"；采集、检索、简报、ask_memory 照常 */
  enabled: boolean;
  /** 237 号票：一次整理最多跑多少分钟（默认 60）；到点中止、记一条"整理超时"，下一夜照常。0 = 不限 */
  nightlyTimeoutMinutes: number;
  /** 242 号票：记忆管理员自己每夜的预算（只做叙述和判断；引擎那 200 次照旧是硬上限） */
  curator: MemoryCuratorConfig;
  /**
   * 337 号票：用哪一套记忆系统（记忆插件的 id）。**同一时间只用一套**：换的那套自己一个数据目录（memory/<id>/），
   * 旧的数据和设置留着、能切回来。这一版生产里只有会意（subtext）一个；不写、写坏了都当默认（会意），不拦启动
   */
  provider?: string;
}

/** 记忆管理员每夜的预算（242 号票）：每夜额外最多调几次模型，默认 8 */
export interface MemoryCuratorConfig {
  /** 每夜管理员自己最多调几次模型（正整数，默认 8）：跑满就停下这一夜，下一夜照常 */
  maxModelCalls: number;
}

/** 抽事实的实现（236 号票）：模型版和评测一致；规则版只当兜底、省钱 */
export type MemoryExtractor = "model" | "rule";

/**
 * 敏感类别（234 号票，接入设计第 7 节）：顺序就是文档和配置里的顺序。295 号票加了位置（数据源用到的敏感类别要对上这里：
 * 健康、财务、位置、关系；位置和情绪、财务、关系一样还是开关占位，现在没有对应的场景标签）
 */
export const SENSITIVE_CATEGORIES = ["health", "emotion", "finance", "relationship", "location"] as const;
export type SensitiveCategory = (typeof SENSITIVE_CATEGORIES)[number];
/** 敏感类别的中文名：存进推理库的删除原因（随被删的数据走，以后设置页要显示的话按 id 另查 t()） */
export const SENSITIVE_CATEGORY_LABELS: Readonly<Record<SensitiveCategory, string>> = {
  health: "健康", // @i18n-ignore data：写进删除原因、随数据走
  emotion: "情绪", // @i18n-ignore data
  finance: "财务", // @i18n-ignore data
  relationship: "关系", // @i18n-ignore data
  location: "位置", // @i18n-ignore data
};

/** 备份（规格第 18 节） */
export interface BackupConfig {
  /** 每晚做快照的时刻，本地时间 HH:mm（默认 03:30） */
  time: string;
  /**
   * 同步目录：快照复制到它下面的日期子目录（较大的文件放进它下面的公共池），由同步客户端去同步到别处。
   * 不配就只做本机备份。示例配置里是占位符（`<…>`），原样用时每次备份都报"没写进同步目录"。
   */
  syncDir?: string;
  /**
   * 谁来定时（335 号票）：internal（默认）守护进程每天 time 到点自己备份；external 交给外部定时器调 npm run backup
   * （守护进程不再自己到点备份，连着两天没人备份时提醒一条；每周校验、临时区清理照旧由守护进程做）
   */
  schedule: BackupSchedule;
}

/**
 * 节假日数据的检查（29 号票）：内部作业每月 dayOfMonth 那天 time 跑一次；到了 fromMonth 及以后查下一年，之前的月份查今年。
 * 默认 12 月起、每月 1 日 09:00（也就是每年 12 月 1 日开始查下一年）
 */
export interface HolidayCheckConfig {
  /** 从几月起查下一年（1–12） */
  fromMonth: number;
  /** 每月几号查（1–28：每个月都有这一天） */
  dayOfMonth: number;
  /** 几点，本地时间 HH:mm */
  time: string;
}

export const DEFAULT_HOLIDAY_CHECK: Readonly<HolidayCheckConfig> = Object.freeze({ fromMonth: 12, dayOfMonth: 1, time: "09:00" });

export interface ErgoConfig {
  dataDir: string;
  /** 数据目录怎么定下来的（312 号票：用了旧的环境变量名、旧的目录时启动日志里提示一次） */
  dataDirFrom: DataDirSource;
  ports: Ports;
  media: MediaConfig;
  /**
   * 模型能力，键是「provider/模型 id」（测试里的 faux provider 是 faux）：看图能力写了的以它为准，没写的按模型目录（79 号票）；
   * 73 号票起设置页改的看图能力（数据目录的 config/model-settings.json）又盖过这里的。键也算"登记过的模型"（设置页列出来）
   */
  models: Record<string, ModelCapabilities>;
  /** 时区（IANA 名字）：发给模型的每条消息前面的本地时间标记按它换算；默认是本机时区 */
  timeZone: string;
  materials: MaterialsConfig;
  /** 记忆（225 号票）：每晚整理推理库的预算、抽事实的实现、这台机器上跑不跑和墙钟上限。配置里写 memory: { maxModelCalls, extractor, enabled, nightlyTimeoutMinutes }，不写是 200 / 模型版 / 开着 / 60 分钟 */
  memory: MemoryConfig;
  backup: BackupConfig;
  /** 守卫判定"先问我"时，子进程里这次调用最多等多久（毫秒），超时以"已提交审批，等待用户"拦下。配置里写 approvals.waitMinutes */
  approvalWaitMs: number;
  /**
   * agent 子进程的资源限制（规格第 3 节）。配置里写 agents：maxLive（同时存活的子进程上限，默认 8）、idleMinutes（维护者闲置多久退出，
   * 默认 10）、modelCallMinutes（单次模型调用超时，默认 5）、toolCallMinutes（单次工具调用的默认超时，默认 10）、
   * orphanSweepSeconds（多久回收一次孤儿进程，默认 60）、browserIdleMinutes（agent 开的 agent-browser 闲置多久回收，默认 30，178 号票）
   */
  agentLimits: AgentLimits;
  /** 节假日数据的检查。配置里写 holidayCheck: { fromMonth, dayOfMonth, time }，不写的取默认 */
  holidayCheck: HolidayCheckConfig;
  /** 带类型的 bash 工具（28 号票）。配置里写 shellTools：longCallMinutes（跑测试、启动构建、装依赖的单次调用超时，默认 30） */
  shellTools: ShellToolsConfig;
  /**
   * 任务执行（13 号票）。配置里写 tasks: { maxRunning }：全局最多几个任务同时处于执行中（默认 3），多出的排队；
   * 14 号票的阈值写 tasks.thresholds：pullBacks、nudges、stallMinutes、acceptanceReturns、budgetExplainTimes、budgetAskTimes、rejections、renewalLeadHours；
   * 19 号票加了 archiveAfterDays（结束超过几天的任务进每周的归档清单）；93 号票加了 budgetControl（管不管预算，默认 false：
   * 超了预算不说明进展、不停下，用量照旧记）
   */
  tasks: { maxRunning: number; thresholds: TaskThresholds };
  /** 简单提醒（reminders/thresholds.ts）。配置里写 reminders：lateLimitMinutes（晚了多少分钟以内的提醒照发，更晚的改放"错过的提醒"，默认 60） */
  reminders: ReminderThresholds;
  /** 定时作业（scheduled-jobs/thresholds.ts，19 号票）。配置里写 scheduledJobs：jobFailures（连续失败几次自动暂停，默认 3） */
  scheduledJobs: ScheduledJobThresholds;
  /**
   * 事件来源（event-sources/thresholds.ts，77 号票）。配置里写 eventSources：folderSettleMs（本机文件夹的同一个文件安静多久才算一次变化，
   * 默认 2000 毫秒）、folderRetryMs（文件夹不在、监视出错时隔多久再看，默认 30000 毫秒）、maxRunSteps（事件触发的任务一次运行最多照多少步，
   * 一批事件数 × 步骤数，默认 100）
   */
  eventSources: EventSourceThresholds;
  /**
   * token 单价（24 号票）：消耗页的粗估成本 = 用量 × 单价。这里是启动时读到的（启动时校验）；
   * 账本算成本时每次现读配置文件（readTokenPrices），改了单价不用重启
   */
  tokenPrices: TokenPriceTable;
  /** 语音消息的识别（31 号票）、语音合成和语音回复（32 号票）。配置里写 voice: { recognizer, speech, reply }，见 VoiceConfig */
  voice: VoiceConfig;
  /** 工具调用的完整内容的保留期和总量上限（65 号票）。配置里写 toolCallDetails: { retentionDays, maxSizeGB }，见 ToolCallDetailLimits */
  toolCallDetails: ToolCallDetailLimits;
  /** 守卫（70 号票）。配置里写 guard: { conversationApprovals }，见 GuardConfig */
  guard: GuardConfig;
  /**
   * 首次设置向导（319 号票）：用户在哪几步点了"以后再说"、哪几步做完了。配置里写 setup: { format: 1, skipped, done }，
   * 不写、写坏了都当"什么都没做"（见 parseSetup）
   */
  setup: SetupConfig;
  /** 联网搜索、读网页和 agent-browser 用的浏览器（70 号票）。配置里写 web: { browserPath }，见 WebConfig */
  web: WebConfig;
  /**
   * 插件（126 号票，ADR-0027）。配置里写 plugins: { disabled: ["reminders"] } 停用某个插件，默认全开，见 PluginsConfig；
   * 211 号票起设置 · 插件里停用、启用、移除也写这里（writePluginsConfig）
   */
  plugins: PluginsConfig;
}

/**
 * 插件（126 号票）：disabled 里写插件名（插件清单 plugins/manifest.ts 里的 name，比如 reminders），这些插件不装。
 * 211 号票：removed 是移除了的（设置里收进"已移除"那一组；也不装，两边都写了的算移除）。设置 · 插件里运行中停用、启用、移除马上生效，
 * 同时写进这两项（writePluginsConfig），重启后保持；手改配置文件的照旧重启生效。
 * 不认得的名字不报错（插件清单在这里看不到），守护进程启动时记一条日志
 */
export interface PluginsConfig {
  disabled: string[];
  removed: string[];
}

/**
 * 守卫的开关（70 号票）。conversationApprovals："先问我"出不出审批卡——off（默认，用户 2026-10-10 定"先把功能跑通，安全机制后接"，
 * 2026-10-12 101 号票改了范围）时秘书除了特别敏感的（写删草稿区外、对外发送、账户与安全、不可逆的提交）都按"直接做"，
 * 任务的 agent（秘书以外的 agent）超出授权的一律按"直接做"，都照常记录、照常标关注类别；on 恢复原样（全部先问、按计划授权核对）。
 * 时序规则、流程的逐步核对不受它影响。见守卫的 GuardInput.conversationApprovals
 */
export interface GuardConfig {
  conversationApprovals: ConversationApprovals;
}

export const DEFAULT_GUARD_CONFIG: Readonly<GuardConfig> = Object.freeze({ conversationApprovals: "off" });

/**
 * 首次设置向导打过的标记（319 号票）：用户在哪几步点了"以后再说"（skipped）、哪几步看过了/做完了（done），
 * 一步只待在一处（标了这边就从那边去掉，见 config/setup-state.ts）。各步的条件满没满足不写在这里——那是现算的。
 * format 留着以后改形状用；现在只有 1
 */
export interface SetupConfig {
  format: 1;
  /** 用户点了"以后再说"的步骤 */
  skipped: SetupStepId[];
  /** 用户看过了/做完了的步骤 */
  done: SetupStepId[];
}

/** 没有 setup 节时就是"什么都没做" */
export const DEFAULT_SETUP_CONFIG: Readonly<SetupConfig> = Object.freeze({ format: 1, skipped: [], done: [] });

/**
 * 浏览器（70 号票）：联网搜索、读网页用 playwright-core 驱动它（不下载浏览器），agent 的 bash 里的 AGENT_BROWSER_EXECUTABLE_PATH
 * 也是它。browserPath 是 Chrome / Edge 的可执行文件的绝对路径，写了就排最前；不写就按固定的候选顺序找（web/browser-path.ts：
 * 环境变量 AGENT_BROWSER_EXECUTABLE_PATH、agent-browser 自带的那份签名的 Chrome、系统 Chrome）。示例配置里是占位符（`<…>`），原样用时当没写
 */
export interface WebConfig {
  browserPath?: string;
}

/**
 * 工具调用的完整参数和返回（53 号票另存的那份）留多久、最多占多大（65 号票）。配置里的写法：
 * toolCallDetails.retentionDays（保留多少天，默认 90，可以带小数）、toolCallDetails.maxSizeGB（总量上限多少 GB，默认 2，可以带小数；
 * 到了就从最旧的清）。清掉的只是完整内容，只剩摘要；还被用着的（没结束的任务里的、还在待办里的卡片引用到的）不清
 */
export interface ToolCallDetailLimits {
  retentionDays: number;
  /** 总量上限（字节） */
  maxBytes: number;
}

/** 用户 2026-10-09 定：保留 90 天、总量上限 2 GB */
export const DEFAULT_TOOL_CALL_DETAIL_LIMITS: Readonly<ToolCallDetailLimits> = Object.freeze({ retentionDays: 90, maxBytes: 2 * 1024 ** 3 });

/**
 * token 单价表（账本算成本只用这一个类型）。配置里写 tokenPrices: { currency, models: { "provider/模型 id": { cacheHit, cacheMiss, output } } }，
 * 单价（协议包的 TokenPrice）是每百万 token 多少钱（输入命中缓存、没命中、输出各一个）；没写单价的模型不算进成本（消耗页列出来）
 */
export interface TokenPriceTable {
  /** 货币代码（CNY、USD……），默认 CNY */
  currency: string;
  /** 模型在配置里的键（modelConfigKey：「provider/模型 id」，测试里的 faux provider 是 faux）→ 单价（每百万 token） */
  models: Record<string, TokenPrice>;
}

export const DEFAULT_TOKEN_PRICE_CURRENCY = "CNY";

/** 识别进程用的模型：设备（cuda / cpu）、模型（faster-whisper 的模型名，或者本机的模型目录）、计算精度 */
export interface VoiceModelConfig {
  device: string;
  model: string;
  computeType: string;
}

/**
 * 一次识别最多等多久（超时就结束识别进程，这条记成失败，后面的输入不再等它）：
 * baseSeconds（每次都有的余量，默认 30）+ coldStartSeconds（识别进程刚拉起、还没加载模型时多留的，默认 60）
 * + 语音时长 × 每秒语音最多等几秒（显卡上 gpuPerAudioSecond，默认 1；CPU 上 cpuPerAudioSecond，默认 3）。
 * 还没加载模型时不知道会落在显卡还是 CPU 上（可能退回），按两者里宽的算
 */
export interface RecognizeTimeoutConfig {
  baseMs: number;
  coldStartMs: number;
  gpuPerAudioSecond: number;
  cpuPerAudioSecond: number;
}

/**
 * 一次合成最多等多久（超时就不等了，这条语音回复记成失败，退回只发文字）：baseSeconds（每次都有的余量，默认 15）
 * + coldStartSeconds（audio.cpp 第一次用到时才加载模型，冷启动要几十秒，默认 90）+ 估出的语音时长 × perSpeechSecond
 * （每秒语音最多等几秒，默认 2；已加载时一句 4 秒的话约 3.3 秒）。不知道服务那边模型加载了没有，所以总把冷启动算上
 */
export interface SpeechTimeoutConfig {
  baseMs: number;
  coldStartMs: number;
  perSpeechSecond: number;
}

/** 识别怎么接入（250 号票）：守护进程自己拉起 Python 子进程（spawn），或者经 HTTP 调 LSM 托管的一条（lsm） */
export type RecognizeMode = "spawn" | "lsm";

export const RECOGNIZE_MODES: readonly RecognizeMode[] = Object.freeze(["spawn", "lsm"]);

/** 默认还是自己拉起 Python（250 号票：LSM 托管的那条要显式写 mode: "lsm"） */
export const DEFAULT_RECOGNIZE_MODE: RecognizeMode = "spawn";

/**
 * 语音消息（31 号票，规格第 21、22 节）。配置里的写法：
 * voice.recognizer：mode（250 号票：spawn 是守护进程自己拉起 Python 子进程，默认，行为不变；lsm 是调 LSM 托管的
 * ergo-asr 服务，见 deploy/lsm/ergo-asr.example.yaml）、url（lsm 模式下那个服务的地址，默认 http://127.0.0.1:8091；
 * spawn 模式不用它）、python（装了 faster-whisper 的 Python，默认 PATH 上的 python；示例配置里是占位符，原样用时识别不可用；只在 spawn 模式用）、
 * device / model / computeType（默认显卡上的 large-v3、int8_float16）、fallback（显卡不可用或显存不够时退回的，默认 CPU 上的 small、
 * int8；写 null 不退回）、idleMinutes（闲置多久退出、释放显存；默认 0：常驻，不因闲置退出，45 号票；只在 spawn 模式有意义，
 * lsm 模式下忽略——卸载交给那个服务自己和 LSM）、timeout（一次识别最多等多久，按语音时长和设备算，
 * 见 RecognizeTimeoutConfig）、language（默认 zh）、initialPrompt（给模型的提示，默认"以下是普通话的句子。"）、
 * stripPatterns（180 号票：识别结果里要剔掉的模型自带串词，一组正则，命中就整句删掉，不分大小写、不计空格和标点；
 * 默认是 DEFAULT_STRIP_PATTERNS 那 5 条，写了就整组换成写的，写 [] 不剔；写错的正则启动时跳过、写日志，见 voice/transcript-filter.ts）、
 * autoRetrySeconds（208 号票：识别没做成——识别进程出错、超时、退出、不可用——时隔几秒自动重试，第几项是第几次重试前等多久，
 * 有几项就最多重试几次；默认 [15, 60, 180]，写 [] 不自动重试，见 voice/voice.ts）。
 * 第一阶段不用大模型修正识别结果（用户 2026-10-08 定）。
 * voice.speech（32 号票）：url（本机 LSM 托管的 audio.cpp 服务，可以和别的程序共用，二狗不自己启动它；默认 http://127.0.0.1:8090）、
 * model（服务上的 TTS 模型 id，默认 tts）、timeout（一次合成最多等多久，见 SpeechTimeoutConfig）、
 * probeSeconds（多久看一次服务的 /health，默认 60：服务从连不上变成连得上时再预热一次合成模型，45 号票）。
 * voice.reply（32 号票）：maxSeconds（口语稿估出来念多久算长，默认 60 秒：长的不全文合成，合成口语总结）、
 * charsPerSecond（估时长用的语速：每秒几个汉字，默认 4.5；一个英文单词按两个汉字算）
 */
export interface VoiceConfig {
  recognizer: {
    /** 怎么接入（250 号票）：默认 spawn，行为与 250 之前逐字节一样 */
    mode: RecognizeMode;
    /** lsm 模式下识别服务的地址（不带末尾斜杠）；spawn 模式不用 */
    url: string;
    python: string;
    primary: VoiceModelConfig;
    fallback: VoiceModelConfig | null;
    /** 闲置多久让识别进程退出；0 是常驻。只在 spawn 模式有意义（lsm 模式下忽略） */
    idleMs: number;
    timeout: RecognizeTimeoutConfig;
    language: string;
    initialPrompt: string;
    /** 识别结果里要剔掉的模型自带串词（正则的原文，180 号票） */
    stripPatterns: string[];
    /** 识别没做成时第几次自动重试前等多久（毫秒，208 号票）；几项就最多重试几次，空的不自动重试 */
    autoRetryMs: number[];
  };
  speech: {
    url: string;
    model: string;
    timeout: SpeechTimeoutConfig;
    /** 多久看一次服务的 /health（毫秒） */
    probeMs: number;
  };
  /** 念多快、多长算长（语音回复定口语稿用） */
  reply: SpokenPace;
}

/**
 * 识别结果里默认剔掉的模型自带串词（180 号票，用户 2026-10-19 给的 5 条）：FasterWhisper 偶尔编进转写的
 * "请不吝点赞 订阅 转发 打赏支持明镜与点点栏目"，和同类的"字幕由……提供"（预防）。
 * 这句的原版常是繁体（"請不吝點贊 訂閱 轉發 打賞支持明鏡與點點欄目"），所以 5 条里的字都写成简繁两种都认的（主会话 2026-10-19 定）
 */
export const DEFAULT_STRIP_PATTERNS: readonly string[] = Object.freeze([
  "[请請]不吝?[点點][赞贊讚]", // @i18n-ignore data：识别结果里要剔掉的串词（正则）
  "[订訂][阅閱].{0,6}[转轉][发發]", // @i18n-ignore data
  "打[赏賞].{0,10}(明[镜鏡]|[点點][点點])", // @i18n-ignore data
  "支持(明[镜鏡]|[点點][点點]).{0,6}[栏欄]目", // @i18n-ignore data
  "字幕由.{0,10}提供", // @i18n-ignore data
]);

/**
 * 语音的默认值（2026-10-08 主会话实测后用户定：显卡上 large-v3 int8_float16 显存约 2.1 GB、15 秒中文约 1.2 秒）。
 * 2026-10-09 用户定（45 号票）：识别模型常驻、不因闲置卸掉（显卡 12 GB，合成约 7.3 GB 加识别约 2 GB 放得下）
 */
export const DEFAULT_VOICE_CONFIG: Readonly<VoiceConfig> = Object.freeze({
  recognizer: {
    // 250 号票：默认仍是守护进程自己拉起 Python，LSM 托管的那条要显式写 mode: "lsm"
    mode: DEFAULT_RECOGNIZE_MODE,
    url: "http://127.0.0.1:8091",
    python: "python",
    primary: { device: "cuda", model: "large-v3", computeType: "int8_float16" },
    fallback: { device: "cpu", model: "small", computeType: "int8" },
    idleMs: 0,
    timeout: { baseMs: 30_000, coldStartMs: 60_000, gpuPerAudioSecond: 1, cpuPerAudioSecond: 3 },
    language: "zh",
    initialPrompt: "以下是普通话的句子。", // @i18n-ignore data：交给语音识别模型的提示（认中文）
    stripPatterns: [...DEFAULT_STRIP_PATTERNS],
    // 208 号票（用户 2026-10-20：识别失败了过一段时间重试，看服务是不是正常了，试三次）
    autoRetryMs: [15_000, 60_000, 180_000],
  },
  // 语音合成（32 号票）：用本机 LSM 托管的 audio.cpp（第三方开源的语音合成服务，可选；模型 id 常见的是 tts）
  speech: {
    url: "http://127.0.0.1:8090",
    model: "tts",
    timeout: { baseMs: 15_000, coldStartMs: 90_000, perSpeechSecond: 2 },
    probeMs: 60_000,
  },
  reply: { maxSeconds: 60, charsPerSecond: 4.5 },
});

export interface ShellToolsConfig {
  /** 跑测试、启动构建、装依赖的单次调用超时（毫秒）：比工具调用的默认超时长，由这三个工具声明给 agent 管家 */
  longCallMs: number;
}

export const DEFAULT_SHELL_TOOLS_LONG_CALL_MINUTES = 30;

export interface ModelCapabilities {
  /**
   * 能不能看图（支不支持图片输入，79 号票）：写了以它为准（可以关掉）；没写按模型目录（pi 的模型目录里模型的输入有图片就算能看）。
   * 看不了图时，消息里的图片只投影成一行带附件引用的占位（见模型投影）
   */
  vision?: boolean;
}

export interface MediaConfig {
  /** 单个上传文件的上限（字节），默认 200 MB */
  maxUploadBytes: number;
}

export const DEFAULT_MATERIALS_CONFIG: Readonly<MaterialsConfig> = Object.freeze({ staleCardDays: 7 });

/** 记忆插件默认用哪个（337 号票）：会意 / Subtext（生产里只有这一个；认不出的 id 由宿主报错，不在这里猜）。
 * 名字和它也是数据目录名这一点写在 data-dir.ts 的 DEFAULT_MEMORY_PROVIDER_ID（那里算 rgDb 要用） */
export const DEFAULT_MEMORY_PROVIDER = DEFAULT_MEMORY_PROVIDER_ID;

/** 每晚整理默认最多调 200 次模型、最多跑 60 分钟（225 号票照评测的设置；235 号票默认开着；237 号票加墙钟上限）。
 * 242 号票起记忆管理员每夜额外最多 8 次（叙述、判断；引擎那 200 次照旧是硬上限） */
export const DEFAULT_MEMORY_CONFIG: Readonly<MemoryConfig> = Object.freeze({
  maxModelCalls: 200,
  extractor: "model",
  sensitiveCategories: Object.freeze<SensitiveCategory[]>([]),
  enabled: true,
  nightlyTimeoutMinutes: 60,
  curator: Object.freeze({ maxModelCalls: 8 }),
  provider: DEFAULT_MEMORY_PROVIDER,
});

/** 默认端口（可在配置文件里改） */
export const DEFAULT_PORTS: Readonly<Ports> = Object.freeze({ local: 8810, external: 8811 });

export const DEFAULT_BACKUP_TIME = "03:30";

/** 示例配置里的占位符（如 `<同步目录的绝对路径>`）：还没换成本机的值 */
export function isPlaceholder(value: string): boolean {
  return /<[^<>]*>/.test(value);
}

/** 审批默认等 5 分钟（规格第 9 节） */
export const DEFAULT_APPROVAL_WAIT_MINUTES = 5;

export { DATA_DIR_ENV };

export interface LoadConfigOptions {
  env: Readonly<Record<string, string | undefined>>;
  homeDir: string;
}

export function loadConfig({ env, homeDir }: LoadConfigOptions): ErgoConfig {
  const { dir: dataDir, from: dataDirFrom } = resolveDataDir(env, homeDir);
  const file = dataDirLayout(dataDir).configFile;
  const raw = readConfigFile(file);
  const ports = parsePorts(raw.ports, file);
  const media = parseMedia(raw.media, file);
  const models = parseModels(raw.models, file);
  const timeZone = parseTimeZone(raw.timeZone, file);
  const materials = parseMaterials(raw.materials, file);
  const memory = parseMemory(raw.memory, file);
  const backup = parseBackup(raw.backup, file, dataDir);
  const approvalWaitMs = parseApprovalWait(raw.approvals, file);
  const agentLimits = parseAgentLimits(raw.agents, file);
  const holidayCheck = parseHolidayCheck(raw.holidayCheck, file);
  const shellTools = parseShellTools(raw.shellTools, file);
  const tasks = parseTasks(raw.tasks, file);
  const reminders = parseReminders(raw.reminders, file);
  const scheduledJobs = parseScheduledJobs(raw.scheduledJobs, file);
  const eventSources = parseEventSources(raw.eventSources, raw.scheduledJobs, file);
  const tokenPrices = parseTokenPrices(raw.tokenPrices, file);
  const voice = parseVoice(raw.voice, file);
  const toolCallDetails = parseToolCallDetails(raw.toolCallDetails, file);
  const guard = parseGuard(raw.guard, file);
  const setup = parseSetup(raw.setup);
  const web = parseWeb(raw.web, file);
  const plugins = parsePlugins(raw.plugins, file);
  return { dataDir, dataDirFrom, ports, media, models, timeZone, materials, memory, backup, approvalWaitMs, agentLimits, holidayCheck, shellTools, tasks, reminders, scheduledJobs, eventSources, tokenPrices, voice, toolCallDetails, guard, setup, web, plugins };
}

/**
 * 设置 · 插件（211 号票）把停用、移除了的插件写进配置文件的 plugins（别的内容原样留着，先写临时文件再改名）。
 * 两项都空时去掉 plugins；配置文件不在就新建一个只有 plugins 的
 */
export function writePluginsConfig(configFile: string, plugins: PluginsConfig): void {
  const raw = readConfigFile(configFile);
  const { disabled: _d, removed: _r, ...rest } = isRecord(raw.plugins) ? raw.plugins : {};
  const next = { ...rest, ...(plugins.disabled.length > 0 ? { disabled: plugins.disabled } : {}), ...(plugins.removed.length > 0 ? { removed: plugins.removed } : {}) };
  const { plugins: _p, ...others } = raw;
  writeJsonAtomic(configFile, Object.keys(next).length > 0 ? { ...others, plugins: next } : others);
}

/** 设置里能自己开关的两项（315 号票）：对话里的"先问我"出不出审批卡（guard.conversationApprovals）、任务管不管预算（tasks.thresholds.budgetControl） */
export interface SafetyConfig {
  conversationApprovals: ConversationApprovals;
  budgetControl: boolean;
}

/**
 * 新装时这两项收紧（315 号票，用户 2026-10-27 定："风险和任务预算的事情，做成一个设置吧。默认收紧，如果用户觉得比较难受，它可以自己关掉"）：
 * 对话审批开着、预算控制开着。代码里的默认值（DEFAULT_GUARD_CONFIG、DEFAULT_TASK_THRESHOLDS）不动——已有的数据目录里没写这两项的照旧是关着；
 * 只有新装（守护进程起来时数据目录里还没有事件库）时由 writeFreshInstallDefaults 明着写进配置文件，之后就是普通配置，设置里能关
 */
export const FRESH_INSTALL_SAFETY: Readonly<SafetyConfig> = Object.freeze({ conversationApprovals: "on", budgetControl: true });

/**
 * 新装（315 号票）：把收紧的两项写进配置文件——里面已经写了的键不碰（安装时、用户先写好的照旧），别的内容原样留着，文件不在就新建。
 * 交回这次写了哪几项（配置里的写法，如 guard.conversationApprovals）；都写过了是空的、不动文件
 */
export function writeFreshInstallDefaults(configFile: string): string[] {
  const raw = readConfigFile(configFile);
  const guard = isRecord(raw.guard) ? raw.guard : {};
  const tasks = isRecord(raw.tasks) ? raw.tasks : {};
  const thresholds = isRecord(tasks.thresholds) ? tasks.thresholds : {};
  const next: Record<string, unknown> = { ...raw };
  const written: string[] = [];
  if (guard.conversationApprovals === undefined) {
    next.guard = { ...guard, conversationApprovals: FRESH_INSTALL_SAFETY.conversationApprovals };
    written.push("guard.conversationApprovals");
  }
  if (thresholds.budgetControl === undefined) {
    next.tasks = { ...tasks, thresholds: { ...thresholds, budgetControl: FRESH_INSTALL_SAFETY.budgetControl } };
    written.push("tasks.thresholds.budgetControl");
  }
  if (written.length > 0) writeJsonAtomic(configFile, next);
  return written;
}

/** 设置里的两个开关改了（315 号票）：写进配置文件的 guard.conversationApprovals、tasks.thresholds.budgetControl（别的内容原样留着，先写临时文件再改名） */
export function writeSafetyConfig(configFile: string, safety: SafetyConfig): void {
  const raw = readConfigFile(configFile);
  const guard = isRecord(raw.guard) ? raw.guard : {};
  const tasks = isRecord(raw.tasks) ? raw.tasks : {};
  const thresholds = isRecord(tasks.thresholds) ? tasks.thresholds : {};
  writeJsonAtomic(configFile, { ...raw, guard: { ...guard, conversationApprovals: safety.conversationApprovals }, tasks: { ...tasks, thresholds: { ...thresholds, budgetControl: safety.budgetControl } } });
}

/**
 * 首次设置向导打了标记（319 号票）：写进配置文件的 setup 节（别的字段原样留着，这一节里不认识的键也留着，
 * 照 writeSafetyConfig 的做法；先写临时文件再改名）。空的也明着写上（[ ]）：那表示"哪一步都没做"，
 * 和"没有这一节"是一个意思，但看得出来写到过
 */
export function writeSetupConfig(configFile: string, setup: SetupConfig): void {
  const raw = readConfigFile(configFile);
  const section = isRecord(raw.setup) ? raw.setup : {};
  writeJsonAtomic(configFile, { ...raw, setup: { ...section, format: setup.format, skipped: setup.skipped, done: setup.done } });
}

// @i18n-ignore-start log：配置文件写错时启动就停下，原因只进日志（LSM 里看）
/** plugins：disabled、removed 是插件名的数组，不写是空的（全开） */
function parsePlugins(value: unknown, file: string): PluginsConfig {
  if (value !== undefined && !isRecord(value)) throw new Error(`配置文件 ${file}：plugins 必须是一个对象（{ disabled, removed }）`);
  const names = (key: "disabled" | "removed"): string[] => {
    const list = value?.[key] ?? [];
    if (!Array.isArray(list) || list.some((name) => typeof name !== "string" || name.trim() === "")) {
      throw new Error(`配置文件 ${file}：plugins.${key} 必须是插件名的数组（比如 ["reminders"]），实际是 ${JSON.stringify(list)}`);
    }
    return (list as string[]).map((name) => name.trim());
  };
  return { disabled: names("disabled"), removed: names("removed") };
}

/** guard：conversationApprovals 是 "off" 或 "on"，不写是 off */
function parseGuard(value: unknown, file: string): GuardConfig {
  if (value !== undefined && !isRecord(value)) throw new Error(`配置文件 ${file}：guard 必须是一个对象（{ conversationApprovals }）`);
  const approvals = value?.conversationApprovals ?? DEFAULT_GUARD_CONFIG.conversationApprovals;
  if (typeof approvals !== "string" || !(CONVERSATION_APPROVALS as readonly string[]).includes(approvals)) {
    throw new Error(`配置文件 ${file}：guard.conversationApprovals 必须是 "off" 或 "on"（对话里的"先问我"出不出审批卡），实际是 ${JSON.stringify(approvals)}`);
  }
  return { conversationApprovals: approvals as ConversationApprovals };
}

/**
 * 首次设置向导的标记（319 号票）：skipped、done 是五步里的哪几步，不写是空的。
 * 手改配置文件坏了不报错（别的配置项写错时会拒绝启动，这一节不该拦着人用二狗）：不是对象、不是数组、
 * 不认识的名字、写重了都只当那一步没打标记，认得的照样算数
 */
function parseSetup(value: unknown): SetupConfig {
  const format = DEFAULT_SETUP_CONFIG.format;
  if (!isRecord(value)) return { format, skipped: [], done: [] };
  const steps = (key: "skipped" | "done"): SetupStepId[] => {
    const list = value[key];
    if (!Array.isArray(list)) return [];
    return [...new Set(list.filter((id): id is SetupStepId => typeof id === "string" && (SETUP_STEPS as readonly string[]).includes(id)))];
  };
  return { format, skipped: steps("skipped"), done: steps("done") };
}

/** web：browserPath 是绝对路径；不写、写空、写占位符都当没写（按默认的顺序找） */
function parseWeb(value: unknown, file: string): WebConfig {
  if (value !== undefined && !isRecord(value)) throw new Error(`配置文件 ${file}：web 必须是一个对象（{ browserPath }）`);
  const browserPath = value?.browserPath;
  if (browserPath === undefined || browserPath === null || browserPath === "") return {};
  if (typeof browserPath !== "string") throw new Error(`配置文件 ${file}：web.browserPath 必须是 Chrome 或 Edge 的可执行文件的绝对路径`);
  if (isPlaceholder(browserPath)) return {};
  if (!path.isAbsolute(browserPath)) throw new Error(`配置文件 ${file}：web.browserPath 必须是绝对路径，实际是 ${JSON.stringify(browserPath)}`);
  return { browserPath: path.resolve(browserPath) };
}

/** toolCallDetails：保留天数、总量上限（GB）都是正数，可以带小数 */
function parseToolCallDetails(value: unknown, file: string): ToolCallDetailLimits {
  if (value !== undefined && !isRecord(value)) throw new Error(`配置文件 ${file}：toolCallDetails 必须是一个对象（{ retentionDays, maxSizeGB }）`);
  const d = DEFAULT_TOOL_CALL_DETAIL_LIMITS;
  const retentionDays = amountOf(value?.retentionDays, 1, d.retentionDays, (actual) => {
    throw new Error(`配置文件 ${file}：toolCallDetails.retentionDays 必须是正数（保留多少天，可以带小数），实际是 ${JSON.stringify(actual)}`);
  });
  const maxBytes = amountOf(value?.maxSizeGB, 1024 ** 3, d.maxBytes, (actual) => {
    throw new Error(`配置文件 ${file}：toolCallDetails.maxSizeGB 必须是正数（总量上限多少 GB，可以带小数），实际是 ${JSON.stringify(actual)}`);
  });
  if (maxBytes < 1) throw new Error(`配置文件 ${file}：toolCallDetails.maxSizeGB 太小了（不到 1 字节），实际是 ${JSON.stringify(value?.maxSizeGB)}`);
  return { retentionDays, maxBytes };
}

/** 现读配置文件里的 token 单价（账本每次算成本时调；文件不对时抛错，说明原因） */
export function readTokenPrices(configFile: string): TokenPriceTable {
  return parseTokenPrices(readConfigFile(configFile).tokenPrices, configFile);
}

function parseTokenPrices(value: unknown, file: string): TokenPriceTable {
  if (value === undefined) return { currency: DEFAULT_TOKEN_PRICE_CURRENCY, models: {} };
  if (!isRecord(value)) throw new Error(`配置文件 ${file}：tokenPrices 必须是一个对象（{ currency, models }）`);
  const currency = value.currency ?? DEFAULT_TOKEN_PRICE_CURRENCY;
  if (typeof currency !== "string" || !/^[A-Za-z]{3}$/.test(currency)) throw new Error(`配置文件 ${file}：tokenPrices.currency 必须是三个字母的货币代码（比如 CNY），实际是 ${JSON.stringify(currency)}`);
  const models = value.models ?? {};
  if (!isRecord(models)) throw new Error(`配置文件 ${file}：tokenPrices.models 必须是一个对象（键是「provider/模型 id」）`);
  const out: Record<string, TokenPrice> = {};
  for (const [key, price] of Object.entries(models)) {
    if (!isRecord(price)) throw new Error(`配置文件 ${file}：tokenPrices.models[${JSON.stringify(key)}] 必须是一个对象（{ cacheHit, cacheMiss, output }）`);
    const amount = (k: keyof TokenPrice): number => {
      const v = price[k];
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`配置文件 ${file}：tokenPrices.models[${JSON.stringify(key)}].${k} 必须是不小于 0 的数（每百万 token 的单价），实际是 ${JSON.stringify(v)}`);
      return v;
    };
    out[key] = { cacheHit: amount("cacheHit"), cacheMiss: amount("cacheMiss"), output: amount("output") };
  }
  return { currency: currency.toUpperCase(), models: out };
}

function parseVoice(value: unknown, file: string): VoiceConfig {
  const fail = (key: string, what: string, actual: unknown): never => {
    throw new Error(`配置文件 ${file}：voice${key ? `.${key}` : ""} ${what}，实际是 ${JSON.stringify(actual)}`);
  };
  if (value !== undefined && !isRecord(value)) fail("", "必须是一个对象（{ recognizer, speech, reply }）", value);
  const section = (key: string): Record<string, unknown> => {
    const raw: unknown = (value as Record<string, unknown> | undefined)?.[key];
    if (raw !== undefined && !isRecord(raw)) fail(key, "必须是一个对象", raw);
    return (raw ?? {}) as Record<string, unknown>;
  };
  const recognizer = section("recognizer");
  const speech = section("speech");
  const reply = section("reply");
  const d = DEFAULT_VOICE_CONFIG;
  const text = (where: Record<string, unknown>, prefix: string, key: string, fallback: string, allowEmpty = false): string => {
    const v = where[key] ?? fallback;
    if (typeof v !== "string" || (!allowEmpty && v.trim() === "")) return fail(`${prefix}.${key}`, "必须是不空的字符串", v);
    return v;
  };
  const positive = (where: Record<string, unknown>, prefix: string, key: string, unit: number, fallback: number): number =>
    amountOf(where[key], unit, fallback, (actual) => fail(`${prefix}.${key}`, "必须是正数", actual));
  const model = (where: Record<string, unknown>, prefix: string, fallback: VoiceModelConfig): VoiceModelConfig => ({
    device: text(where, prefix, "device", fallback.device),
    model: text(where, prefix, "model", fallback.model),
    computeType: text(where, prefix, "computeType", fallback.computeType),
  });
  let fallback: VoiceModelConfig | null;
  const rawFallback = recognizer.fallback;
  if (rawFallback === null) fallback = null;
  else if (rawFallback === undefined) fallback = d.recognizer.fallback;
  else if (!isRecord(rawFallback)) return fail("recognizer.fallback", "必须是一个对象（{ device, model, computeType }）或者 null", rawFallback);
  else fallback = model(rawFallback, "recognizer.fallback", d.recognizer.fallback ?? d.recognizer.primary);
  const rawTimeout = recognizer.timeout;
  if (rawTimeout !== undefined && !isRecord(rawTimeout)) fail("recognizer.timeout", "必须是一个对象（{ baseSeconds, coldStartSeconds, gpuPerAudioSecond, cpuPerAudioSecond }）", rawTimeout);
  const timeout = (rawTimeout ?? {}) as Record<string, unknown>;
  const dt = d.recognizer.timeout;
  const rawSpeechTimeout = speech.timeout;
  if (rawSpeechTimeout !== undefined && !isRecord(rawSpeechTimeout)) fail("speech.timeout", "必须是一个对象（{ baseSeconds, coldStartSeconds, perSpeechSecond }）", rawSpeechTimeout);
  const speechTimeout = (rawSpeechTimeout ?? {}) as Record<string, unknown>;
  // 250 号票：认得的只有两种；写别的直接报错，说清能写什么（免得拼错一个字母就悄悄退回 spawn）
  const rawMode: unknown = recognizer.mode ?? d.recognizer.mode;
  if (typeof rawMode !== "string" || !(RECOGNIZE_MODES as readonly string[]).includes(rawMode)) {
    fail("recognizer.mode", '必须是 "spawn"（守护进程自己拉起 Python 子进程）或 "lsm"（LSM 托管的识别服务）', rawMode);
  }
  return {
    recognizer: {
      mode: rawMode as RecognizeMode,
      // 只有 lsm 模式用；spawn 模式写错了也不管（照 serviceUrl 校验，写错照样报错，免得切过去才发现）
      url: serviceUrl(text(recognizer, "recognizer", "url", d.recognizer.url), (actual) => fail("recognizer.url", "必须是 http:// 或 https:// 开头的地址", actual)),
      // 占位符原样放行：配置照常能用，识别时报"语音识别不可用"
      python: text(recognizer, "recognizer", "python", d.recognizer.python),
      primary: model(recognizer, "recognizer", d.recognizer.primary),
      fallback,
      // 0 是常驻（不因闲置退出）
      idleMs: amountOf(recognizer.idleMinutes, 60_000, d.recognizer.idleMs, (actual) => fail("recognizer.idleMinutes", "必须是不小于 0 的数（0 是常驻，不因闲置退出）", actual), { allowZero: true }),
      timeout: {
        baseMs: positive(timeout, "recognizer.timeout", "baseSeconds", 1000, dt.baseMs),
        coldStartMs: positive(timeout, "recognizer.timeout", "coldStartSeconds", 1000, dt.coldStartMs),
        gpuPerAudioSecond: positive(timeout, "recognizer.timeout", "gpuPerAudioSecond", 1, dt.gpuPerAudioSecond),
        cpuPerAudioSecond: positive(timeout, "recognizer.timeout", "cpuPerAudioSecond", 1, dt.cpuPerAudioSecond),
      },
      language: text(recognizer, "recognizer", "language", d.recognizer.language, true),
      initialPrompt: text(recognizer, "recognizer", "initialPrompt", d.recognizer.initialPrompt, true),
      // 只核对是一组字符串；正则写错的由识别那边启动时跳过、写日志（transcript-filter.ts），不让守护进程起不来
      stripPatterns: stringList(recognizer.stripPatterns, d.recognizer.stripPatterns, (actual) => fail("recognizer.stripPatterns", "必须是一组字符串（正则）", actual)),
      autoRetryMs: amountList(recognizer.autoRetrySeconds, 1000, d.recognizer.autoRetryMs, (actual) => fail("recognizer.autoRetrySeconds", "必须是一组正数（秒），写 [] 不自动重试", actual)),
    },
    speech: {
      url: serviceUrl(text(speech, "speech", "url", d.speech.url), (actual) => fail("speech.url", "必须是 http:// 或 https:// 开头的地址", actual)),
      model: text(speech, "speech", "model", d.speech.model),
      timeout: {
        baseMs: positive(speechTimeout, "speech.timeout", "baseSeconds", 1000, d.speech.timeout.baseMs),
        coldStartMs: positive(speechTimeout, "speech.timeout", "coldStartSeconds", 1000, d.speech.timeout.coldStartMs),
        perSpeechSecond: positive(speechTimeout, "speech.timeout", "perSpeechSecond", 1, d.speech.timeout.perSpeechSecond),
      },
      probeMs: positive(speech, "speech", "probeSeconds", 1000, d.speech.probeMs),
    },
    reply: {
      maxSeconds: positive(reply, "reply", "maxSeconds", 1, d.reply.maxSeconds),
      charsPerSecond: positive(reply, "reply", "charsPerSecond", 1, d.reply.charsPerSecond),
    },
  };
}

/** 服务的地址：http(s) 开头，去掉末尾的斜杠 */
function serviceUrl(value: string, bad: (actual: unknown) => never): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return bad(value);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return bad(value);
  return value.replace(/\/+$/, "");
}

function parseHolidayCheck(value: unknown, file: string): HolidayCheckConfig {
  if (value !== undefined && !isRecord(value)) throw new Error(`配置文件 ${file}：holidayCheck 必须是一个对象（{ fromMonth, dayOfMonth, time }）`);
  const int = (key: "fromMonth" | "dayOfMonth", max: number): number => {
    const v: unknown = value?.[key] ?? DEFAULT_HOLIDAY_CHECK[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > max) throw new Error(`配置文件 ${file}：holidayCheck.${key} 必须是 1–${max} 之间的整数，实际是 ${JSON.stringify(v)}`);
    return v;
  };
  const time: unknown = value?.time ?? DEFAULT_HOLIDAY_CHECK.time;
  if (!clockTime.check(time)) throw new Error(`配置文件 ${file}：holidayCheck.time 必须是 HH:mm 形式的本地时间（比如 "09:00"），实际是 ${JSON.stringify(time)}`);
  return { fromMonth: int("fromMonth", 12), dayOfMonth: int("dayOfMonth", 28), time };
}

function parseTimeZone(value: unknown, file: string): string {
  if (value === undefined) return Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (typeof value !== "string") throw new Error(`配置文件 ${file}：timeZone 必须是 IANA 时区名（比如 Asia/Shanghai）`);
  try {
    // 不认识的时区名在这里抛 RangeError
    Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions();
  } catch {
    throw new Error(`配置文件 ${file}：timeZone 不认识：${value}（要写 IANA 时区名，比如 Asia/Shanghai）`);
  }
  return value;
}


function parseModels(value: unknown, file: string): Record<string, ModelCapabilities> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`配置文件 ${file}：models 必须是一个对象（键是「provider/模型 id」）`);
  const out: Record<string, ModelCapabilities> = {};
  for (const [key, caps] of Object.entries(value)) {
    if (!isRecord(caps)) throw new Error(`配置文件 ${file}：models[${JSON.stringify(key)}] 必须是一个对象`);
    if (caps.vision !== undefined && typeof caps.vision !== "boolean") {
      throw new Error(`配置文件 ${file}：models[${JSON.stringify(key)}].vision 必须是 true 或 false`);
    }
    out[key] = caps.vision === undefined ? {} : { vision: caps.vision };
  }
  return out;
}

function parseMedia(value: unknown, file: string): MediaConfig {
  if (value !== undefined && !isRecord(value)) throw new Error(`配置文件 ${file}：media 必须是一个对象`);
  const max = value?.maxUploadBytes;
  if (max === undefined) return { maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES };
  if (typeof max !== "number" || !Number.isSafeInteger(max) || max < 1) {
    throw new Error(`配置文件 ${file}：media.maxUploadBytes 必须是正整数（字节），实际是 ${JSON.stringify(max)}`);
  }
  return { maxUploadBytes: max };
}

function parseMaterials(value: unknown, file: string): MaterialsConfig {
  if (value !== undefined && !isRecord(value)) throw new Error(`配置文件 ${file}：materials 必须是一个对象`);
  const days = value?.staleCardDays;
  if (days === undefined) return { ...DEFAULT_MATERIALS_CONFIG };
  if (typeof days !== "number" || !(days > 0) || days > 365) {
    throw new Error(`配置文件 ${file}：materials.staleCardDays 必须是 0 到 365 之间的天数（可以带小数），实际是 ${JSON.stringify(days)}`);
  }
  return { staleCardDays: days };
}

/**
 * memory：maxModelCalls 是正整数（一次整理最多调几次模型，默认 200）；extractor 是 model（默认）或 rule（236）；
 * sensitiveCategories 是敏感类别里允许推断的那几类（默认空，234）；
 * enabled 是 true（默认，这台机器上跑整理）/ false（不排作业、不建库，见 MemoryConfig，235）；
 * nightlyTimeoutMinutes 是这次整理最多跑几分钟（默认 60，0 = 不限，237）；
 * curator.maxModelCalls 是记忆管理员每夜额外最多调几次模型（默认 8，242）；
 * provider 用哪一套记忆系统（337，默认会意 subtext；不写、写坏了都不出这个键，不拦启动）
 */
function parseMemory(value: unknown, file: string): MemoryConfig {
  if (value !== undefined && !isRecord(value)) throw new Error(`配置文件 ${file}：memory 必须是一个对象（{ maxModelCalls, extractor, sensitiveCategories, enabled, nightlyTimeoutMinutes, curator }）`);
  const calls = value?.maxModelCalls;
  if (calls !== undefined && (typeof calls !== "number" || !Number.isSafeInteger(calls) || calls < 1)) {
    throw new Error(`配置文件 ${file}：memory.maxModelCalls 必须是正整数（一次整理最多调几次模型），实际是 ${JSON.stringify(calls)}`);
  }
  const extractor = value?.extractor;
  if (extractor !== undefined && extractor !== "model" && extractor !== "rule") {
    throw new Error(`配置文件 ${file}：memory.extractor 只能是 "model"（模型版，默认）或 "rule"（规则版），实际是 ${JSON.stringify(extractor)}`);
  }
  const enabled = value?.enabled;
  if (enabled !== undefined && typeof enabled !== "boolean") {
    throw new Error(`配置文件 ${file}：memory.enabled 只能是 true 或 false（这台机器上跑不跑整理），实际是 ${JSON.stringify(enabled)}`);
  }
  const timeout = value?.nightlyTimeoutMinutes;
  if (timeout !== undefined && (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 0)) {
    throw new Error(`配置文件 ${file}：memory.nightlyTimeoutMinutes 必须是不小于 0 的分钟数（0 = 不限），实际是 ${JSON.stringify(timeout)}`);
  }
  // 337 号票：不写、写坏了都不出这个键（读的人用 DEFAULT_MEMORY_PROVIDER）
  const provider = parseMemoryProvider(value?.provider);
  return {
    maxModelCalls: calls ?? DEFAULT_MEMORY_CONFIG.maxModelCalls,
    extractor: extractor ?? DEFAULT_MEMORY_CONFIG.extractor,
    sensitiveCategories: parseSensitiveCategories(value?.sensitiveCategories, file),
    enabled: enabled ?? DEFAULT_MEMORY_CONFIG.enabled,
    nightlyTimeoutMinutes: timeout ?? DEFAULT_MEMORY_CONFIG.nightlyTimeoutMinutes,
    curator: parseMemoryCurator(value?.curator, file),
    ...(provider === undefined ? {} : { provider }),
  };
}

/**
 * memory.provider（337 号票）：记忆插件的 id（会意是 subtext）。**不写、写坏了（不是字符串、空的、不像 id 的）都当默认**，
 * 不拦启动：配置写坏不该让守护进程起不来；真认不出的 id 由宿主 activate 时报 not_found。
 * 写坏了也不明着填默认值，这样"什么都没写"和"写了但不认得"在配置里都没出现，读的人一律用 DEFAULT_MEMORY_PROVIDER
 */
function parseMemoryProvider(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  return MEMORY_PROVIDER_ID.test(id) ? id : undefined;
}

/**
 * memory.curator（242 号票）：maxModelCalls 是记忆管理员每夜额外最多调几次模型（正整数，默认 8）；
 * 不写整节就是默认；写了就必须是对象（写别的（比如旧版的数字）报错，不悄悄忽略）
 */
function parseMemoryCurator(value: unknown, file: string): MemoryCuratorConfig {
  if (value === undefined) return { maxModelCalls: DEFAULT_MEMORY_CONFIG.curator.maxModelCalls };
  if (!isRecord(value)) throw new Error(`配置文件 ${file}：memory.curator 必须是一个对象（{ maxModelCalls }），实际是 ${JSON.stringify(value)}`);
  const calls = value.maxModelCalls;
  if (calls !== undefined && (typeof calls !== "number" || !Number.isSafeInteger(calls) || calls < 1)) {
    throw new Error(`配置文件 ${file}：memory.curator.maxModelCalls 必须是正整数（记忆管理员每夜最多调几次模型），实际是 ${JSON.stringify(calls)}`);
  }
  return { maxModelCalls: calls ?? DEFAULT_MEMORY_CONFIG.curator.maxModelCalls };
}

/** memory.sensitiveCategories：健康、情绪、财务、关系、位置里的哪几类允许用来推断（写别的、写重了都报错） */
function parseSensitiveCategories(value: unknown, file: string): readonly SensitiveCategory[] {
  if (value === undefined) return [...DEFAULT_MEMORY_CONFIG.sensitiveCategories];
  if (!Array.isArray(value)) throw new Error(`配置文件 ${file}：memory.sensitiveCategories 必须是数组，元素是 ${SENSITIVE_CATEGORIES.join("、")}，实际是 ${JSON.stringify(value)}`);
  const categories: SensitiveCategory[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !(SENSITIVE_CATEGORIES as readonly string[]).includes(item)) {
      throw new Error(`配置文件 ${file}：memory.sensitiveCategories 里只能写 ${SENSITIVE_CATEGORIES.join("、")}，实际有一项是 ${JSON.stringify(item)}`);
    }
    if (categories.includes(item as SensitiveCategory)) throw new Error(`配置文件 ${file}：memory.sensitiveCategories 里 ${item} 写重了`);
    categories.push(item as SensitiveCategory);
  }
  return categories;
}

/** 一天里的几点几分：和简单提醒的钟点同一个 schema（共享协议包 reminder-schedule.ts） */
const clockTime = schemaChecker(ClockTime);

function parseBackup(value: unknown, file: string, dataDir: string): BackupConfig {
  if (value !== undefined && !isRecord(value)) throw new Error(`配置文件 ${file}：backup 必须是一个对象`);
  const time: unknown = value?.time ?? DEFAULT_BACKUP_TIME;
  if (!clockTime.check(time)) {
    throw new Error(`配置文件 ${file}：backup.time 必须是 HH:mm 形式的本地时间（比如 "03:30"），实际是 ${JSON.stringify(time)}`);
  }
  const schedule: unknown = value?.schedule ?? "internal";
  if (!(BACKUP_SCHEDULES as readonly unknown[]).includes(schedule)) {
    throw new Error(`配置文件 ${file}：backup.schedule 只能是 "internal"（守护进程每天到点自己备份）或 "external"（交给外部定时器调 npm run backup），实际是 ${JSON.stringify(schedule)}`);
  }
  const base = { time, schedule: schedule as BackupSchedule };
  const syncDir = value?.syncDir;
  if (syncDir === undefined || syncDir === null || syncDir === "") return base;
  if (typeof syncDir !== "string") throw new Error(`配置文件 ${file}：backup.syncDir 必须是一个目录的路径`);
  // 占位符原样放行：配置照常能用，备份时在待我处理里提醒换成本机的同步目录
  if (isPlaceholder(syncDir)) return { ...base, syncDir };
  if (!path.isAbsolute(syncDir)) throw new Error(`配置文件 ${file}：backup.syncDir 必须是绝对路径，实际是 ${JSON.stringify(syncDir)}`);
  const resolved = path.resolve(syncDir);
  const rel = path.relative(dataDir, resolved);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    throw new Error(`配置文件 ${file}：backup.syncDir 不能放在数据目录里（${resolved}）`);
  }
  return { ...base, syncDir: resolved };
}

function parseApprovalWait(value: unknown, file: string): number {
  if (value !== undefined && !isRecord(value)) throw new Error(`配置文件 ${file}：approvals 必须是一个对象`);
  const minutes = value?.waitMinutes ?? DEFAULT_APPROVAL_WAIT_MINUTES;
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(`配置文件 ${file}：approvals.waitMinutes 必须是正数（分钟），实际是 ${JSON.stringify(minutes)}`);
  }
  return Math.round(minutes * 60_000);
}

/** 任务执行时全局最多几个任务同时处于执行中（13 号票，规格第 8 节"并发"） */
export const DEFAULT_MAX_RUNNING_TASKS = 3;

/** tasks：执行名额是正整数；阈值（14 号票）里次数是正整数，停滞的分钟数、预算的倍数、续期的提前小时数是正数，找用户的倍数不小于说明进展的倍数，管不管预算是布尔 */
function parseTasks(value: unknown, file: string): { maxRunning: number; thresholds: TaskThresholds } {
  if (value !== undefined && !isRecord(value)) throw new Error(`配置文件 ${file}：tasks 必须是一个对象（{ maxRunning, thresholds }）`);
  const maxRunning = value?.maxRunning ?? DEFAULT_MAX_RUNNING_TASKS;
  if (typeof maxRunning !== "number" || !Number.isInteger(maxRunning) || maxRunning < 1) {
    throw new Error(`配置文件 ${file}：tasks.maxRunning 必须是正整数，实际是 ${JSON.stringify(maxRunning)}`);
  }
  const raw = value?.thresholds;
  if (raw !== undefined && !isRecord(raw)) throw new Error(`配置文件 ${file}：tasks.thresholds 必须是一个对象`);
  const d = DEFAULT_TASK_THRESHOLDS;
  const count = (key: string, fallback: number): number => {
    const v = raw?.[key] ?? fallback;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new Error(`配置文件 ${file}：tasks.thresholds.${key} 必须是正整数，实际是 ${JSON.stringify(v)}`);
    return v;
  };
  const positive = (key: string, fallback: number): number => {
    const v = raw?.[key] ?? fallback;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new Error(`配置文件 ${file}：tasks.thresholds.${key} 必须是正数，实际是 ${JSON.stringify(v)}`);
    return v;
  };
  const flag = (key: string, fallback: boolean): boolean => {
    const v = raw?.[key] ?? fallback;
    if (typeof v !== "boolean") throw new Error(`配置文件 ${file}：tasks.thresholds.${key} 必须是 true 或 false，实际是 ${JSON.stringify(v)}`);
    return v;
  };
  const thresholds: TaskThresholds = {
    pullBacks: count("pullBacks", d.pullBacks),
    nudges: count("nudges", d.nudges),
    stallMs: Math.round(positive("stallMinutes", d.stallMs / 60_000) * 60_000),
    acceptanceReturns: count("acceptanceReturns", d.acceptanceReturns),
    budgetExplainTimes: positive("budgetExplainTimes", d.budgetExplainTimes),
    budgetAskTimes: positive("budgetAskTimes", d.budgetAskTimes),
    budgetControl: flag("budgetControl", d.budgetControl),
    rejections: count("rejections", d.rejections),
    renewalLeadMs: Math.round(positive("renewalLeadHours", d.renewalLeadMs / 3_600_000) * 3_600_000),
    archiveAfterDays: count("archiveAfterDays", d.archiveAfterDays),
  };
  if (thresholds.budgetAskTimes < thresholds.budgetExplainTimes) throw new Error(`配置文件 ${file}：tasks.thresholds.budgetAskTimes 不能小于 budgetExplainTimes`);
  return { maxRunning, thresholds };
}

/** 配置里一组阈值中的一项正整数：没写取默认，写错了报错（写明是哪一项） */
function positiveCount(section: string, value: Record<string, unknown> | undefined, key: string, fallback: number, file: string): number {
  const v = value?.[key] ?? fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new Error(`配置文件 ${file}：${section}.${key} 必须是正整数，实际是 ${JSON.stringify(v)}`);
  return v;
}

/** reminders：晚了多少分钟以内的提醒照发，正整数 */
function parseReminders(value: unknown, file: string): ReminderThresholds {
  if (value !== undefined && !isRecord(value)) throw new Error(`配置文件 ${file}：reminders 必须是一个对象（{ lateLimitMinutes }）`);
  return { lateLimitMinutes: positiveCount("reminders", value, "lateLimitMinutes", DEFAULT_REMINDER_THRESHOLDS.lateLimitMinutes, file) };
}

/** scheduledJobs（19 号票）：连续失败几次自动暂停，正整数 */
function parseScheduledJobs(value: unknown, file: string): ScheduledJobThresholds {
  if (value !== undefined && !isRecord(value)) throw new Error(`配置文件 ${file}：scheduledJobs 必须是一个对象（{ jobFailures }）`);
  return { jobFailures: positiveCount("scheduledJobs", value, "jobFailures", DEFAULT_SCHEDULED_JOB_THRESHOLDS.jobFailures, file) };
}

/**
 * eventSources（77 号票）：folderSettleMs、folderRetryMs、maxRunSteps，都是正整数。77 号票开发时 folderSettleMs 一度写在 scheduledJobs 里：
 * eventSources 里没写、scheduledJobs 里写了的照旧认
 */
function parseEventSources(value: unknown, legacy: unknown, file: string): EventSourceThresholds {
  if (value !== undefined && !isRecord(value)) throw new Error(`配置文件 ${file}：eventSources 必须是一个对象（{ folderSettleMs, folderRetryMs, maxRunSteps }）`);
  const old = isRecord(legacy) && legacy.folderSettleMs !== undefined && value?.folderSettleMs === undefined ? positiveCount("scheduledJobs", legacy, "folderSettleMs", DEFAULT_EVENT_SOURCE_THRESHOLDS.folderSettleMs, file) : undefined;
  return {
    folderSettleMs: old ?? positiveCount("eventSources", value, "folderSettleMs", DEFAULT_EVENT_SOURCE_THRESHOLDS.folderSettleMs, file),
    folderRetryMs: positiveCount("eventSources", value, "folderRetryMs", DEFAULT_EVENT_SOURCE_THRESHOLDS.folderRetryMs, file),
    maxRunSteps: positiveCount("eventSources", value, "maxRunSteps", DEFAULT_EVENT_SOURCE_THRESHOLDS.maxRunSteps, file),
  };
}

/** agents：子进程上限是正整数，几个时长是正数（可以带小数） */
function parseAgentLimits(value: unknown, file: string): AgentLimits {
  if (value !== undefined && !isRecord(value)) throw new Error(`配置文件 ${file}：agents 必须是一个对象`);
  const d = DEFAULT_AGENT_LIMITS;
  const maxLive = value?.maxLive ?? d.maxLive;
  if (typeof maxLive !== "number" || !Number.isInteger(maxLive) || maxLive < 2) {
    throw new Error(`配置文件 ${file}：agents.maxLive 必须是不小于 2 的整数（秘书占一个），实际是 ${JSON.stringify(maxLive)}`);
  }
  const duration = (key: string, unitMs: number, fallbackMs: number): number =>
    amountOf(value?.[key], unitMs, fallbackMs, (raw) => {
      throw new Error(`配置文件 ${file}：agents.${key} 必须是正数，实际是 ${JSON.stringify(raw)}`);
    });
  return {
    maxLive,
    idleMs: duration("idleMinutes", 60_000, d.idleMs),
    modelCallMs: duration("modelCallMinutes", 60_000, d.modelCallMs),
    toolCallMs: duration("toolCallMinutes", 60_000, d.toolCallMs),
    orphanSweepMs: duration("orphanSweepSeconds", 1000, d.orphanSweepMs),
    browserIdleMs: duration("browserIdleMinutes", 60_000, d.browserIdleMs),
  };
}

function parseShellTools(value: unknown, file: string): ShellToolsConfig {
  if (value !== undefined && !isRecord(value)) throw new Error(`配置文件 ${file}：shellTools 必须是一个对象`);
  const minutes = value?.longCallMinutes ?? DEFAULT_SHELL_TOOLS_LONG_CALL_MINUTES;
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(`配置文件 ${file}：shellTools.longCallMinutes 必须是正数（分钟），实际是 ${JSON.stringify(minutes)}`);
  }
  return { longCallMs: Math.round(minutes * 60_000) };
}

function readConfigFile(file: string): Record<string, unknown> {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error(`配置文件 ${file} 的顶层必须是一个对象`);
  return parsed;
}

function parsePorts(value: unknown, file: string): Ports {
  if (value !== undefined && !isRecord(value)) throw new Error(`配置文件 ${file}：ports 必须是一个对象`);
  const local = parsePort(value?.local, DEFAULT_PORTS.local, "ports.local", file);
  const external = parsePort(value?.external, DEFAULT_PORTS.external, "ports.external", file);
  if (local === external) throw new Error(`配置文件 ${file}：ports.local 和 ports.external 不能相同（${local}）`);
  return { local, external };
}

function parsePort(value: unknown, fallback: number, key: string, file: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`配置文件 ${file}：${key} 必须是 1–65535 之间的整数，实际是 ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * 配置里的一个正数（可以带小数）乘上单位（时长按毫秒：分钟是 60000，秒是 1000；比例是 1）。没写是 fallback；
 * 不是正数时交给 bad 抛出（说清是哪一项）
 */
/** 配置里的一个量：没写取默认；写了要是正数（allowZero 时也可以是 0），乘上单位（比如分钟 → 毫秒） */
function amountOf(raw: unknown, unit: number, fallback: number, bad: (actual: unknown) => never, { allowZero = false }: { allowZero?: boolean } = {}): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || (raw === 0 && !allowZero)) return bad(raw);
  return unit === 1 ? raw : Math.round(raw * unit);
}

/** 配置里的一组正数（208 号票的自动重试间隔）：没写取默认（复制一份）；写了要是数组、每一项都是正数，乘上 unit 取整 */
function amountList(raw: unknown, unit: number, fallback: readonly number[], bad: (actual: unknown) => never): number[] {
  if (raw === undefined) return [...fallback];
  if (!Array.isArray(raw)) return bad(raw);
  return raw.map((item: unknown) => amountOf(item, unit, 0, () => bad(raw)));
}

/** 配置里的一组字符串：没写取默认（复制一份）；写了要是数组、每一项都是字符串 */
function stringList(raw: unknown, fallback: readonly string[], bad: (actual: unknown) => never): string[] {
  if (raw === undefined) return [...fallback];
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) return bad(raw);
  return [...(raw as string[])];
}

// @i18n-ignore-end

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
