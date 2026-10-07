// 配置：只读。
// - 数据目录：环境变量 ERGOU_DATA_DIR 指定；没指定时取用户主目录下的 .ergou（主目录由调用方传入，不写死）。
// - 其余配置：数据目录里的 config/ergou.json，缺省的项取默认值。仓库里只有示例 config/ergou.example.json。
import fs from "node:fs";
import path from "node:path";
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
  return { dataDir, ports };
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
