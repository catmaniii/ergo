// 配置：只读。
// - 数据目录：环境变量 ERGOU_DATA_DIR 指定；没指定时取用户主目录下的 .ergou（主目录由调用方传入，不写死）。
// - 其余配置：数据目录里的 config/ergou.json，缺省的项取默认值。仓库里只有示例 config/ergou.example.json。
import fs from "node:fs";
import path from "node:path";
import { ClockTime, DEFAULT_MAX_UPLOAD_BYTES, schemaChecker, type TokenPrice } from "@ergou/protocol";
import { type AgentLimits, DEFAULT_AGENT_LIMITS } from "../agent-manager/agent-manager.ts";
import type { ModelSpec } from "../runtime/index.ts";
import { DEFAULT_TASK_THRESHOLDS, type TaskThresholds } from "../tasks/thresholds.ts";
import type { SpokenPace } from "../voice/spoken-text.ts";
import { dataDirLayout } from "./data-dir.ts";
import { modelConfigKey } from "./model-key.ts";

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

/** 备份（规格第 18 节） */
export interface BackupConfig {
  /** 每晚做快照的时刻，本地时间 HH:mm（默认 03:30） */
  time: string;
  /**
   * 同步目录：快照复制到它下面的日期子目录（较大的文件放进它下面的公共池），由同步客户端去同步到别处。
   * 不配就只做本机备份。示例配置里是占位符（`<…>`），原样用时每次备份都报"没写进同步目录"。
   */
  syncDir?: string;
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

export interface ErgouConfig {
  dataDir: string;
  ports: Ports;
  media: MediaConfig;
  /** 模型能力，键是「provider/模型 id」（测试里的 faux provider 是 faux）；没配的模型一律当不支持图片输入 */
  models: Record<string, ModelCapabilities>;
  /** 时区（IANA 名字）：发给模型的每条消息前面的本地时间标记按它换算；默认是本机时区 */
  timeZone: string;
  materials: MaterialsConfig;
  backup: BackupConfig;
  /** 守卫判定"先问我"时，子进程里这次调用最多等多久（毫秒），超时以"已提交审批，等待用户"拦下。配置里写 approvals.waitMinutes */
  approvalWaitMs: number;
  /**
   * agent 子进程的资源限制（规格第 3 节）。配置里写 agents：maxLive（同时存活的子进程上限，默认 8）、idleMinutes（维护者闲置多久退出，
   * 默认 10）、modelCallMinutes（单次模型调用超时，默认 5）、toolCallMinutes（单次工具调用的默认超时，默认 10）、
   * orphanSweepSeconds（多久回收一次孤儿进程，默认 60）
   */
  agentLimits: AgentLimits;
  /** 节假日数据的检查。配置里写 holidayCheck: { fromMonth, dayOfMonth, time }，不写的取默认 */
  holidayCheck: HolidayCheckConfig;
  /** 带类型的 bash 工具（28 号票）。配置里写 shellTools：longCallMinutes（跑测试、启动构建、装依赖的单次调用超时，默认 30） */
  shellTools: ShellToolsConfig;
  /**
   * 任务执行（13 号票）。配置里写 tasks: { maxRunning }：全局最多几个任务同时处于执行中（默认 3），多出的排队；
   * 14 号票的阈值写 tasks.thresholds：pullBacks、nudges、stallMinutes、acceptanceReturns、budgetExplainTimes、budgetAskTimes、rejections、renewalLeadHours
   */
  tasks: { maxRunning: number; thresholds: TaskThresholds };
  /**
   * token 单价（24 号票）：消耗页的粗估成本 = 用量 × 单价。这里是启动时读到的（启动时校验）；
   * 账本算成本时每次现读配置文件（readTokenPrices），改了单价不用重启
   */
  tokenPrices: TokenPriceTable;
  /** 语音消息的识别（31 号票）、语音合成和语音回复（32 号票）。配置里写 voice: { recognizer, speech, reply }，见 VoiceConfig */
  voice: VoiceConfig;
}

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

/**
 * 语音消息（31 号票，规格第 21、22 节）。配置里的写法：
 * voice.recognizer：python（装了 faster-whisper 的 Python，默认 PATH 上的 python；示例配置里是占位符，原样用时识别不可用）、
 * device / model / computeType（默认显卡上的 large-v3、int8_float16）、fallback（显卡不可用或显存不够时退回的，默认 CPU 上的 small、
 * int8；写 null 不退回）、idleMinutes（闲置多久退出、释放显存，默认 5）、timeout（一次识别最多等多久，按语音时长和设备算，
 * 见 RecognizeTimeoutConfig）、language（默认 zh）、initialPrompt（给模型的提示，默认"以下是普通话的句子。"）。
 * 第一阶段不用大模型修正识别结果（用户 2026-10-08 定）。
 * voice.speech（32 号票）：url（本机 LSM 托管的 audio.cpp 服务，和 drama 共用，二狗不自己启动它；默认 http://127.0.0.1:8090）、
 * model（服务上的 TTS 模型 id，默认 tts）、timeout（一次合成最多等多久，见 SpeechTimeoutConfig）。
 * voice.reply（32 号票）：maxSeconds（口语稿估出来念多久算长，默认 60 秒：长的不全文合成，合成口语总结）、
 * charsPerSecond（估时长用的语速：每秒几个汉字，默认 4.5；一个英文单词按两个汉字算）
 */
export interface VoiceConfig {
  recognizer: {
    python: string;
    primary: VoiceModelConfig;
    fallback: VoiceModelConfig | null;
    idleMs: number;
    timeout: RecognizeTimeoutConfig;
    language: string;
    initialPrompt: string;
  };
  speech: {
    url: string;
    model: string;
    timeout: SpeechTimeoutConfig;
  };
  /** 念多快、多长算长（语音回复定口语稿用） */
  reply: SpokenPace;
}

/** 语音的默认值（2026-10-08 主会话实测后用户定：显卡上 large-v3 int8_float16 显存约 2.1 GB、15 秒中文约 1.2 秒） */
export const DEFAULT_VOICE_CONFIG: Readonly<VoiceConfig> = Object.freeze({
  recognizer: {
    python: "python",
    primary: { device: "cuda", model: "large-v3", computeType: "int8_float16" },
    fallback: { device: "cpu", model: "small", computeType: "int8" },
    idleMs: 5 * 60_000,
    timeout: { baseMs: 30_000, coldStartMs: 60_000, gpuPerAudioSecond: 1, cpuPerAudioSecond: 3 },
    language: "zh",
    initialPrompt: "以下是普通话的句子。",
  },
  // 语音合成（32 号票）：共用本机 LSM 托管的 audio.cpp（drama 的 TTS 引擎，模型 id 是 tts）
  speech: {
    url: "http://127.0.0.1:8090",
    model: "tts",
    timeout: { baseMs: 15_000, coldStartMs: 90_000, perSpeechSecond: 2 },
  },
  reply: { maxSeconds: 60, charsPerSecond: 4.5 },
});

export interface ShellToolsConfig {
  /** 跑测试、启动构建、装依赖的单次调用超时（毫秒）：比工具调用的默认超时长，由这三个工具声明给 agent 管家 */
  longCallMs: number;
}

export const DEFAULT_SHELL_TOOLS_LONG_CALL_MINUTES = 30;

export interface ModelCapabilities {
  /** 支不支持图片输入：不支持时，消息里的图片只投影成一行占位文字（见模型投影） */
  vision: boolean;
}

export interface MediaConfig {
  /** 单个上传文件的上限（字节），默认 200 MB */
  maxUploadBytes: number;
}

export const DEFAULT_MATERIALS_CONFIG: Readonly<MaterialsConfig> = Object.freeze({ staleCardDays: 7 });

/** 默认端口（可在配置文件里改） */
export const DEFAULT_PORTS: Readonly<Ports> = Object.freeze({ local: 8810, external: 8811 });

export const DEFAULT_BACKUP_TIME = "03:30";

/** 示例配置里的占位符（如 `<同步目录的绝对路径>`）：还没换成本机的值 */
export function isPlaceholder(value: string): boolean {
  return /<[^<>]*>/.test(value);
}

/** 审批默认等 5 分钟（规格第 9 节） */
export const DEFAULT_APPROVAL_WAIT_MINUTES = 5;

export const DATA_DIR_ENV = "ERGOU_DATA_DIR";

export interface LoadConfigOptions {
  env: Readonly<Record<string, string | undefined>>;
  homeDir: string;
}

export function loadConfig({ env, homeDir }: LoadConfigOptions): ErgouConfig {
  const dataDir = resolveDataDir(env, homeDir);
  const file = dataDirLayout(dataDir).configFile;
  const raw = readConfigFile(file);
  const ports = parsePorts(raw.ports, file);
  const media = parseMedia(raw.media, file);
  const models = parseModels(raw.models, file);
  const timeZone = parseTimeZone(raw.timeZone, file);
  const materials = parseMaterials(raw.materials, file);
  const backup = parseBackup(raw.backup, file, dataDir);
  const approvalWaitMs = parseApprovalWait(raw.approvals, file);
  const agentLimits = parseAgentLimits(raw.agents, file);
  const holidayCheck = parseHolidayCheck(raw.holidayCheck, file);
  const shellTools = parseShellTools(raw.shellTools, file);
  const tasks = parseTasks(raw.tasks, file);
  const tokenPrices = parseTokenPrices(raw.tokenPrices, file);
  const voice = parseVoice(raw.voice, file);
  return { dataDir, ports, media, models, timeZone, materials, backup, approvalWaitMs, agentLimits, holidayCheck, shellTools, tasks, tokenPrices, voice };
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
    positiveAmount(where[key], unit, fallback, (actual) => fail(`${prefix}.${key}`, "必须是正数", actual));
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
  return {
    recognizer: {
      // 占位符原样放行：配置照常能用，识别时报"语音识别不可用"
      python: text(recognizer, "recognizer", "python", d.recognizer.python),
      primary: model(recognizer, "recognizer", d.recognizer.primary),
      fallback,
      idleMs: positive(recognizer, "recognizer", "idleMinutes", 60_000, d.recognizer.idleMs),
      timeout: {
        baseMs: positive(timeout, "recognizer.timeout", "baseSeconds", 1000, dt.baseMs),
        coldStartMs: positive(timeout, "recognizer.timeout", "coldStartSeconds", 1000, dt.coldStartMs),
        gpuPerAudioSecond: positive(timeout, "recognizer.timeout", "gpuPerAudioSecond", 1, dt.gpuPerAudioSecond),
        cpuPerAudioSecond: positive(timeout, "recognizer.timeout", "cpuPerAudioSecond", 1, dt.cpuPerAudioSecond),
      },
      language: text(recognizer, "recognizer", "language", d.recognizer.language, true),
      initialPrompt: text(recognizer, "recognizer", "initialPrompt", d.recognizer.initialPrompt, true),
    },
    speech: {
      url: serviceUrl(text(speech, "speech", "url", d.speech.url), (actual) => fail("speech.url", "必须是 http:// 或 https:// 开头的地址", actual)),
      model: text(speech, "speech", "model", d.speech.model),
      timeout: {
        baseMs: positive(speechTimeout, "speech.timeout", "baseSeconds", 1000, d.speech.timeout.baseMs),
        coldStartMs: positive(speechTimeout, "speech.timeout", "coldStartSeconds", 1000, d.speech.timeout.coldStartMs),
        perSpeechSecond: positive(speechTimeout, "speech.timeout", "perSpeechSecond", 1, d.speech.timeout.perSpeechSecond),
      },
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


/** 这个模型支不支持图片输入（配置里没写的一律不支持） */
export function modelVision(config: ErgouConfig, model: ModelSpec): boolean {
  return config.models[modelConfigKey(model)]?.vision ?? false;
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
    out[key] = { vision: caps.vision === true };
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

/** 一天里的几点几分：和简单提醒的钟点同一个 schema（共享协议包 reminder-schedule.ts） */
const clockTime = schemaChecker(ClockTime);

function parseBackup(value: unknown, file: string, dataDir: string): BackupConfig {
  if (value !== undefined && !isRecord(value)) throw new Error(`配置文件 ${file}：backup 必须是一个对象`);
  const time: unknown = value?.time ?? DEFAULT_BACKUP_TIME;
  if (!clockTime.check(time)) {
    throw new Error(`配置文件 ${file}：backup.time 必须是 HH:mm 形式的本地时间（比如 "03:30"），实际是 ${JSON.stringify(time)}`);
  }
  const syncDir = value?.syncDir;
  if (syncDir === undefined || syncDir === null || syncDir === "") return { time };
  if (typeof syncDir !== "string") throw new Error(`配置文件 ${file}：backup.syncDir 必须是一个目录的路径`);
  // 占位符原样放行：配置照常能用，备份时在待我处理里提醒换成本机的同步目录
  if (isPlaceholder(syncDir)) return { time, syncDir };
  if (!path.isAbsolute(syncDir)) throw new Error(`配置文件 ${file}：backup.syncDir 必须是绝对路径，实际是 ${JSON.stringify(syncDir)}`);
  const resolved = path.resolve(syncDir);
  const rel = path.relative(dataDir, resolved);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    throw new Error(`配置文件 ${file}：backup.syncDir 不能放在数据目录里（${resolved}）`);
  }
  return { time, syncDir: resolved };
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

/** tasks：执行名额是正整数；阈值（14 号票）里次数是正整数，停滞的分钟数、预算的倍数、续期的提前小时数是正数，找用户的倍数不小于说明进展的倍数 */
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
  const thresholds: TaskThresholds = {
    pullBacks: count("pullBacks", d.pullBacks),
    nudges: count("nudges", d.nudges),
    stallMs: Math.round(positive("stallMinutes", d.stallMs / 60_000) * 60_000),
    acceptanceReturns: count("acceptanceReturns", d.acceptanceReturns),
    budgetExplainTimes: positive("budgetExplainTimes", d.budgetExplainTimes),
    budgetAskTimes: positive("budgetAskTimes", d.budgetAskTimes),
    rejections: count("rejections", d.rejections),
    renewalLeadMs: Math.round(positive("renewalLeadHours", d.renewalLeadMs / 3_600_000) * 3_600_000),
  };
  if (thresholds.budgetAskTimes < thresholds.budgetExplainTimes) throw new Error(`配置文件 ${file}：tasks.thresholds.budgetAskTimes 不能小于 budgetExplainTimes`);
  return { maxRunning, thresholds };
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
    positiveAmount(value?.[key], unitMs, fallbackMs, (raw) => {
      throw new Error(`配置文件 ${file}：agents.${key} 必须是正数，实际是 ${JSON.stringify(raw)}`);
    });
  return {
    maxLive,
    idleMs: duration("idleMinutes", 60_000, d.idleMs),
    modelCallMs: duration("modelCallMinutes", 60_000, d.modelCallMs),
    toolCallMs: duration("toolCallMinutes", 60_000, d.toolCallMs),
    orphanSweepMs: duration("orphanSweepSeconds", 1000, d.orphanSweepMs),
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

function resolveDataDir(env: LoadConfigOptions["env"], homeDir: string): string {
  const fromEnv = env[DATA_DIR_ENV]?.trim();
  return path.resolve(fromEnv ? fromEnv : path.join(homeDir, ".ergou"));
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
function positiveAmount(raw: unknown, unit: number, fallback: number, bad: (actual: unknown) => never): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return bad(raw);
  return unit === 1 ? raw : Math.round(raw * unit);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
