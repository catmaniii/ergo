// 配置：只读。
// - 数据目录：环境变量 ERGOU_DATA_DIR 指定；没指定时取用户主目录下的 .ergou（主目录由调用方传入，不写死）。
// - 其余配置：数据目录里的 config/ergou.json，缺省的项取默认值。仓库里只有示例 config/ergou.example.json。
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_MAX_UPLOAD_BYTES } from "@ergou/protocol";
import type { ModelSpec } from "../runtime/index.ts";
import { dataDirLayout } from "./data-dir.ts";

export interface Ports {
  /** 本机端口：只监听 127.0.0.1，自动信任（规格第 6 节） */
  local: number;
  /** 外网端口：隧道的唯一目标，每个请求都要带设备凭证 */
  external: number;
}

export interface ErgouConfig {
  dataDir: string;
  ports: Ports;
  media: MediaConfig;
  /** 模型能力，键是「provider/模型 id」（测试里的 faux provider 是 faux）；没配的模型一律当不支持图片输入 */
  models: Record<string, ModelCapabilities>;
  /** 时区（IANA 名字）：发给模型的每条消息前面的本地时间标记按它换算；默认是本机时区 */
  timeZone: string;
}

export interface ModelCapabilities {
  /** 支不支持图片输入：不支持时，消息里的图片只投影成一行占位文字（见模型投影） */
  vision: boolean;
}

export interface MediaConfig {
  /** 单个上传文件的上限（字节），默认 200 MB */
  maxUploadBytes: number;
}

/** 默认端口（可在配置文件里改） */
export const DEFAULT_PORTS: Readonly<Ports> = Object.freeze({ local: 8810, external: 8811 });

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
  return { dataDir, ports, media, models, timeZone };
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
