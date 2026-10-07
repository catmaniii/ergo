// 配置：只读。
// - 数据目录：环境变量 ERGOU_DATA_DIR 指定；没指定时取用户主目录下的 .ergou（主目录由调用方传入，不写死）。
// - 其余配置：数据目录里的 config/ergou.json，缺省的项取默认值。仓库里只有示例 config/ergou.example.json。
import fs from "node:fs";
import path from "node:path";
import { ClockTime, DEFAULT_MAX_UPLOAD_BYTES, schemaChecker } from "@ergou/protocol";
import { type AgentLimits, DEFAULT_AGENT_LIMITS } from "../agent-manager/agent-manager.ts";
import type { ModelSpec } from "../runtime/index.ts";
import { dataDirLayout } from "./data-dir.ts";

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
}

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
  return { dataDir, ports, media, models, timeZone, materials, backup, approvalWaitMs, agentLimits };
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

/** 某个模型在配置里的名字：目录里的模型是「provider/模型 id」，测试用的 faux provider 是 faux */
export function modelConfigKey(model: ModelSpec): string {
  return model.kind === "catalog" ? `${model.provider}/${model.modelId}` : "faux";
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

/** agents：子进程上限是正整数，几个时长是正数（可以带小数） */
function parseAgentLimits(value: unknown, file: string): AgentLimits {
  if (value !== undefined && !isRecord(value)) throw new Error(`配置文件 ${file}：agents 必须是一个对象`);
  const d = DEFAULT_AGENT_LIMITS;
  const maxLive = value?.maxLive ?? d.maxLive;
  if (typeof maxLive !== "number" || !Number.isInteger(maxLive) || maxLive < 2) {
    throw new Error(`配置文件 ${file}：agents.maxLive 必须是不小于 2 的整数（秘书占一个），实际是 ${JSON.stringify(maxLive)}`);
  }
  const duration = (key: string, unitMs: number, fallbackMs: number): number => {
    const raw = value?.[key];
    if (raw === undefined) return fallbackMs;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) throw new Error(`配置文件 ${file}：agents.${key} 必须是正数，实际是 ${JSON.stringify(raw)}`);
    return Math.round(raw * unitMs);
  };
  return {
    maxLive,
    idleMs: duration("idleMinutes", 60_000, d.idleMs),
    modelCallMs: duration("modelCallMinutes", 60_000, d.modelCallMs),
    toolCallMs: duration("toolCallMinutes", 60_000, d.toolCallMs),
    orphanSweepMs: duration("orphanSweepSeconds", 1000, d.orphanSweepMs),
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
