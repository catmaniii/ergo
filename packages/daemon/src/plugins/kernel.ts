// 内核给插件的服务（ADR-0027）：插件在 needs 里声明、装配时 ctx.use 取。组合根在插件宿主 setup 时一个不少地交来。
// 插件要的内核的东西多了再往这里加；只放插件真要的，不把内核整个摊开。为记忆插件加了素材库、素材引着的记录、
// 快速动作、彻底删除的改写函数表、向量函数；为日历插件加了定时作业在日历上的展开；为语音插件加了媒体库、
// 数据目录、临时事件的推送、语音用的外部程序；为浏览插件（内置浏览器和网页工具）加了授权的文件夹、看图的缩小、
// 联网搜索给浏览那一轮的一句（媒体库、数据目录两个插件共用）；为记忆插件加了守护进程的环境（记忆整理读 DEEPSEEK_API_KEY）
// 和记忆整理用的模型工厂（测试注入假的，永远不连真的 DeepSeek）；为记忆插件加了账本记上下文用量（记忆简报）；
// 为记忆插件加了个人档案给记忆的那几样（档案在内核，记忆插件只经它取）；为日历插件加了外部日历（数据源交来的日程），
// "手机"插件也用个人档案的收候选。为 Claude Code 插件加了一次性子进程（列本机会话、读前情、分叉）。
// 为记忆插件加了记忆插件槽（按原话记一条、每条消息的简报，转给在跑的那个记忆插件）。
// 为记忆插件加了整理前同步一遍（数据源的服务把能由电脑拉的各同步一次）。
// 为语音插件的体检项加了语音在这台电脑上是怎么配的（组件页的功能门、服务管家里登记在某端口的服务、服务管家的网页、有没有 N 卡）。
// 为地图插件加了数据源密钥区里自己那一格（转发高德的请求时拼安全密钥）。
import type { ChatModel } from "@ergo/memory";
import type { CalendarExternalEntry, MemoryBriefInput, MemoryBriefResult, MemoryHealth, MemoryItem, MemoryProviderInfo, MemoryRememberInput } from "@ergo/protocol";
import type { HostToolCall } from "../agent-manager/host-tools.ts";
import type { AgentRoles } from "../agent-roles/index.ts";
import type { ElementToRemember } from "../browsing/api.ts";
import type { CardService } from "../cards/cards.ts";
import type { DataDirLayout } from "../config/data-dir.ts";
import type { ErgoConfig } from "../config/config.ts";
import type { CalendarFetchProblem, DataSourceSecretStore, PullableSync } from "../data-sources/index.ts";
import type { EphemeralBus } from "../events/ephemeral.ts";
import type { EventTriggers } from "../event-sources/index.ts";
import type { EventStore } from "../events/event-store.ts";
import type { InboxService } from "../inbox/inbox.ts";
import type { LocalFolders } from "../folders/local-folders.ts";
import type { RegisteredService } from "../lsm/registered.ts";
import type { MediaStore } from "../media/media-store.ts";
import type { Embedder, Materials } from "../materials/index.ts";
import type { MaterialOwners, MemorySettingsService, PurgeRewriters } from "../memory/index.ts";
import type { QuickActionService } from "../quick-actions/index.ts";
import type { ThumbnailRequest, ThumbnailResult } from "../runtime/index.ts";
import type { ScheduledJobs } from "../scheduled-jobs/index.ts";
import type { Clock } from "../scheduler/clock.ts";
import type { Scheduler } from "../scheduler/scheduler.ts";
import type { TokenLedger } from "../ledger/index.ts";
import type { PersonalFilesForMemory } from "../personal-files/index.ts";
import type { WorkdayCalendarService } from "../workday/index.ts";
import { serviceKey, type ServiceKey } from "./host.ts";

/**
 * 语音插件拉起、连接的外部程序：识别进程的环境照 agent 子进程的白名单从守护进程的环境取（env）；
 * 测试换成假的识别进程（命令）、假的合成服务（地址），识别模型加载的退避、算稳定的时长、发语音工具等多久也调短。正式运行只给 env
 */
export interface VoiceEngines {
  /** 守护进程自己的环境（通常是 process.env） */
  env: Readonly<Record<string, string | undefined>>;
  /** 识别进程（程序和参数）；不给用配置里的 Python 跑 recognizer.py */
  recognizerCommand?: readonly string[] | undefined;
  /** 参考音色导入时把常见音频转成 WAV 的 ffmpeg（程序和它前面的固定参数）；不给用 PATH 上的 ffmpeg */
  ffmpegCommand?: readonly string[] | undefined;
  /** 合成服务（audio.cpp）的地址；不给用配置里的 voice.speech.url */
  speechUrl?: string | undefined;
  /** 识别模型没加载起来、加载好很快又退出时的退避（毫秒）；不给用 warmup.ts 的 */
  recognizerRetryMs?: readonly number[] | undefined;
  /** 识别进程加载好之后多久没崩算稳定（毫秒）；不给用 warmup.ts 的 */
  recognizerStableMs?: number | undefined;
  /** 发语音工具最多等合成多久就先交回"还在合成"（毫秒）；不给用 send-voice.ts 的 */
  sendVoiceWaitMs?: number | undefined;
}

/**
 * 语音在这台电脑上是怎么配的（413，语音插件的体检项要）：这几样在组件页、服务管家那边，语音插件自己看不到。
 * 组件、服务管家的接入层建在插件装配之后，组合根现转给它（体检时才问）；测试换成假的
 */
export interface VoiceSetup {
  /**
   * 组件页的功能门现在能不能用（COMPONENT_FEATURES 的 voice.input "按住说话"、voice.reply "用语音回复"）：组件装在这儿，
   * 或者别处已经有了（用户自己配的识别、合成）。用户自己的合成服务停着时这里认不出来，要再看 registeredOn
   */
  featureReady(feature: string): boolean;
  /** 服务管家里探活端口是这个的那条服务（读它的注册表文件，不连服务管家）；没有、读不到是 undefined */
  registeredOn(port: number): RegisteredService | undefined;
  /** 服务管家的网页（体检的"去看看"跳这里）；不知道是 undefined */
  managerUrl(): string | undefined;
  /** 这台电脑有没有 N 卡（组件那边问 nvidia-smi 一次记住的） */
  gpu(): "nvidia" | "none";
}

/** 插件的一次性子进程（见 KERNEL.oneShot）：入口、请求、出错时写的名字、最多等多久（毫秒） */
export type OneShotRunner = <T>(entry: string, request: unknown, label: string, timeoutMs: number) => Promise<T>;

/** 联网搜索（内核的）给浏览插件的：浏览那一轮交给秘书的输入后面加的一句（联网搜索算上鸿蒙 App 的内置浏览器） */
export interface WebSearchNotes {
  /** 按此刻的联网搜索队列；队列里停用了 App 的内置浏览器是 undefined */
  appBrowserNote(): string | undefined;
}

/**
 * 记忆插件槽：按原话记一条（`remember`）和每条消息的简报（`brief`），都转给此刻在跑的那个记忆插件
 * （宿主的 `MemoryHost.remember` / `MemoryHost.brief`——有 brief 能力用插件的，没有宿主拿 search 拼）。
 * 记忆插件的"记一句"工具和记忆简报（message-brief.ts）经它走，插件停用时工具跟着没了、简报不带；
 * 宿主建在插件装配之后，组合根现转给它。
 * 体检（412）也经它看在跑的是哪一套（`info`，没有在跑是 undefined）、它自己报的健康（`health`，协议里给体检页的那个接口；没有在跑时抛错）
 */
export interface MemorySlot {
  remember(input: MemoryRememberInput): Promise<MemoryItem>;
  brief(input: MemoryBriefInput): Promise<MemoryBriefResult | undefined>;
  info(): MemoryProviderInfo | undefined;
  health(): Promise<MemoryHealth>;
}

/**
 * 用户说"这张图记下来"时能带上的文件。记忆插件的"记一句"问它，组合根现转给浏览插件（BROWSING，插件没在运行是 undefined）。
 * 不让记忆插件直接 wants 浏览插件：wants 会改装配顺序，秘书拿到的工具先后、别的插件的先后都跟着变
 */
export interface ElementFiles {
  toRemember(ref: string | undefined, call: HostToolCall): ElementToRemember | undefined;
}

/**
 * 外部日历：数据源（手机日历；Google 日历同样）交给日历插件显示的日程，只读、不进素材。内核替插件在运行的数据源
 * 现取（data-sources/service.ts 的 calendarEvents），日历插件按月取时叫
 */
export interface ExternalCalendars {
  /** [from, to) 里的日程（跨这段的也算），带着数据源和它给人看的名字 */
  events(from: Date, to: Date): CalendarExternalEntry[];
  /**
   * 外部日程现在的版本：数据源交来的日程变了就往上加（守护进程内存里只增不减，毫秒时间起步）；日历按月给的 asOf.external
   * 带着它，工作日历频道上的临时事件 external_calendar 推新的版本，网页比一比就知道手里那份旧了
   */
  version(): number;
  /** 交给日历的日程拿不到过的数据源：连着几次、一共几次、最近一次的原因（日历插件的体检项读，414；只在内存里） */
  problems(): readonly CalendarFetchProblem[];
}

/**
 * 记忆整理之前同步一遍（data-sources/service.ts 的 syncPullable）：能由电脑拉的、插件在运行、导入开着、连着的数据源各同步一次
 * （触发方式是定期的那种），交回每一个的那一次；freshMs 以内成功同步过的不再同步，连接出错的不试。
 * 数据源的服务建在插件装配之后，组合根现转给它：开机补跑的那一夜可能在它起来之前就开始了，就等它起来（signal 置位时不再等、交回空的）
 */
export interface DataSourcePreSync {
  syncPullable(options: { freshMs: number; signal: AbortSignal }): Promise<readonly PullableSync[]>;
}

/**
 * 记忆整理用的模型工厂：正式运行不给（记忆插件按 DEEPSEEK_API_KEY 建 DeepSeekChat）；
 * 测试给假的，守护进程里永远不连真的 DeepSeek。每次整理现叫一次，拿到的模型只给这一次用
 */
export type MemoryModelFactory = () => ChatModel;

export const KERNEL = {
  /** 读好的配置 */
  config: serviceKey<ErgoConfig>("config"),
  /** 事件存储 */
  store: serviceKey<EventStore>("store"),
  /** 时钟（测试换成手动拨的） */
  clock: serviceKey<Clock>("clock"),
  /** 调度器 */
  scheduler: serviceKey<Scheduler>("scheduler"),
  /** 卡片 */
  cards: serviceKey<CardService>("cards"),
  /** 待我处理 */
  inbox: serviceKey<InboxService>("inbox"),
  /** 个人工作日历（"按我的工作日"按它算；变了 onChange） */
  workdayCalendar: serviceKey<WorkdayCalendarService>("workdayCalendar"),
  /** 事件触发方式对不对（事件来源的分发在插件之后才建，这里现转给它） */
  eventTriggers: serviceKey<Pick<EventTriggers, "check">>("eventTriggers"),
  /**
   * 素材库：materials.db 和原文副本的保管、读、检索；记忆插件装配时经它开始采成素材（collect，要在素材库启动之前）。
   * 素材来源不经它声明：内核的在组合根里，插件的在数据契约里（ctx.materialSources）
   */
  materials: serviceKey<Materials>("materials"),
  /** 素材引着的任务、审批、卡片和待我处理的事项：认出项目内部的记录（秘书检索不到） */
  materialOwners: serviceKey<MaterialOwners>("materialOwners"),
  /** 快速动作（执行器经 ctx.quickActions 登记；这里是提议和执行，卡片上确认后执行用它） */
  quickActions: serviceKey<QuickActionService>("quickActions"),
  /** 彻底删除的改写函数表（算一次删除要改写哪些事件；插件自己的改写函数经数据契约登记） */
  purgeRewriters: serviceKey<PurgeRewriters>("purgeRewriters"),
  /** 向量函数（正式运行是数据目录模型区里的 bge-m3，测试换成假的） */
  embedder: serviceKey<Embedder>("embedder"),
  /**
   * 定时作业在日历上的展开（日历插件要）：时间表展开、这段时间的运行记录、作业的状态。定时作业本身是内核的，
   * 建在插件装配之后，组合根现转给它
   */
  scheduledJobs: serviceKey<Pick<ScheduledJobs, "calendar">>("scheduledJobs"),
  /** 媒体库（语音插件的录音、合成出的音频入库、读文件；浏览插件替上传框找文件时从素材里的附件找） */
  media: serviceKey<MediaStore>("media"),
  /** 数据目录的各区（语音插件的参考音色区、临时区；浏览插件的候选缩略图放在缓存区） */
  layout: serviceKey<DataDirLayout>("layout"),
  /** 临时事件的推送（不落盘：语音插件推两个模型的状态） */
  notifications: serviceKey<Pick<EphemeralBus, "publish">>("notifications"),
  /** 语音用的外部程序（见 VoiceEngines；测试换成假的） */
  voiceEngines: serviceKey<VoiceEngines>("voiceEngines"),
  /** 语音在这台电脑上是怎么配的（见 VoiceSetup；语音插件的体检项用；测试换成假的） */
  voiceSetup: serviceKey<VoiceSetup>("voiceSetup"),
  /**
   * 角色（是每个 agent 自己的名字和音色）：语音插件按"说话的是哪个 agent"取它用的角色指定的音色
   * （没指定、被删了跟全局默认）。转述负责人的进展时还要角色名（转文字时写"小张："）
   */
  agentRoles: serviceKey<Pick<AgentRoles, "voiceIdOf" | "roleOf">>("agentRoles"),
  /** 授权的文件夹（内核的：秘书在聊天里和浏览插件的找文件共用一份） */
  localFolders: serviceKey<LocalFolders>("localFolders"),
  /** 把几张图缩成小图（agent 管家拉起的一次性子进程；浏览插件的看图、候选缩略图） */
  thumbnails: serviceKey<(request: ThumbnailRequest) => Promise<ThumbnailResult>>("thumbnails"),
  /**
   * 插件的一次性子进程（Claude Code 插件列本机会话、读前情、分叉，它的 SDK 只在子进程里）：agent 管家拉起，
   * 放进 Job 对象、只给白名单里的环境；送一行请求、等一行结果，出错、超时抛错
   */
  oneShot: serviceKey<OneShotRunner>("oneShot"),
  /** 联网搜索给浏览那一轮的一句，见 WebSearchNotes */
  webSearch: serviceKey<WebSearchNotes>("webSearch"),
  /**
   * 守护进程自己的环境：记忆整理从这里读 DEEPSEEK_API_KEY（只读、不打印）。
   * 正式运行是 process.env（LSM 注入的 key 在这里），测试里由测试底座换成临时的一份
   */
  env: serviceKey<Readonly<Record<string, string | undefined>>>("env"),
  /**
   * 记忆整理用的模型工厂：组合根把测试注入的现转给记忆插件；不给是 undefined，
   * 记忆插件按 DEEPSEEK_API_KEY 建 DeepSeekChat。测试给假的，永远不连真的 DeepSeek
   */
  memoryModel: serviceKey<MemoryModelFactory | undefined>("memoryModel"),
  /**
   * 记忆的设置（memory/settings.ts）：秘书回话时顺口问开不开。组合根建一份，网关的设置接口和记忆插件共用；
   * 配置区里的 memory-settings.json，没有就是默认（开着）。记忆插件也改它：约访卡上点"不想做了"关掉约访
   */
  memorySettings: serviceKey<Pick<MemorySettingsService, "current" | "change">>("memorySettings"),
  /**
   * 账本记插件追加在输入后面的上下文估了多少 token（每条消息的记忆简报，用量页单列"记忆简报"）。账本建在插件装配之后，
   * 组合根现转给它
   */
  usage: serviceKey<Pick<TokenLedger, "recordContextUsage">>("usage"),
  /**
   * 个人档案给记忆插件的（personal-files/memory-link.ts）：档案里的人（对齐人物实体）、档案摘要（整理的情境）、
   * 不进整理提示的值（号码类、住址）、字段换了新值（旧事实到期）、收候选和合成候选核对卡。档案建在插件装配之后，组合根现转给它
   */
  personalFiles: serviceKey<PersonalFilesForMemory>("personalFiles"),
  /**
   * 外部日历：数据源交给日历插件显示的日程（见 ExternalCalendars）。数据源的服务建在插件装配之后，组合根现转给它
   */
  externalCalendars: serviceKey<ExternalCalendars>("externalCalendars"),
  /**
   * 记忆插件槽（见 MemorySlot）：用户让秘书记一句时转给在跑的那个记忆插件（宿主的 remember）。
   * 宿主建在插件装配之后，组合根现转给它；没接上时记忆插件不给"记一句"这个工具
   */
  memorySlot: serviceKey<MemorySlot>("memorySlot"),
  /** 用户说"这张图记下来"时能带上的文件（见 ElementFiles） */
  elementFiles: serviceKey<ElementFiles>("elementFiles"),
  /** 记忆整理之前把能由电脑拉的数据源各同步一次（见 DataSourcePreSync）。数据源的服务建在插件装配之后，组合根现转给它 */
  dataSourceSync: serviceKey<DataSourcePreSync>("dataSourceSync"),
  /**
   * 数据源密钥区里某一格（data-sources/secrets.ts 的 forSource）：插件在数据源的函数之外现取自己登记的那个数据源的密钥——
   * 地图插件转发高德的请求时拼安全密钥。只取自己的；取到的是现读的（填设置、断开之后马上跟着变），不打印、不交给页面
   */
  dataSourceSecrets: serviceKey<Pick<DataSourceSecretStore, "forSource">>("dataSourceSecrets"),
} as const;

/** 内核提供的全部服务（建插件宿主时交给它，排依赖用） */
export const KERNEL_SERVICES: readonly ServiceKey<unknown>[] = Object.values(KERNEL);
