// ergo 命令的上下文：装在哪、数据在哪、服务管家的数据在哪、怎么输出、怎么联网。各条命令只经它拿这些，测试换成假的。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { componentTransport } from "../components/index.ts";
import type { Transport } from "../components/transport.ts";
import { DEFAULT_PORTS } from "../config/config.ts";
import { defaultInstallRoot, type InstallLayout } from "../release/layout.ts";
import { DEFAULT_SERVICE_ID, InstanceMarkerError, resolveInstance, type ResolvedInstance } from "./instances.ts";

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  /** 问一句、读一行回答（没有终端时回空串） */
  ask(question: string): Promise<string>;
}

export interface CliContext {
  layout: InstallLayout;
  env: NodeJS.ProcessEnv;
  io: CliIo;
  homeDir: string;
  /** 在哪个文件夹里跑的这条命令（认实例标记文件从这里往上找） */
  cwd: string;
  /** 这条命令管的那一份二狗的数据目录（认法见 instances.ts：--dir > ERGO_DATA_DIR > 实例标记文件 > ~/.ergo） */
  dataDir: string;
  /** 这一份在服务管家里的登记 id（默认那份是 ergo-daemon，别的是 ergo-<名字>） */
  serviceId: string;
  /** 这一份的名字（默认那份没有） */
  instanceName?: string;
  /** 这一份是怎么认出来的 */
  instanceSource: ResolvedInstance["source"];
  /** 认出来的文件夹里的实例标记文件读不了、内容不对：除了 help、version，命令一律不做（免得认错一份去停、改别的） */
  instanceError?: { file: string; reason: string };
  /** 服务管家的数据目录（LSM_DATA_DIR，没设是 %LOCALAPPDATA%\ergo\supervisor） */
  svcDataDir: string;
  /** 安装目录：装好的是它所在的那个；别的布局是默认位置（ERGO_INSTALL_DIR 可以换） */
  installRoot: string;
  transport(): Transport;
}

/** 服务管家的默认数据目录（和 packages/supervisor/src/paths.mjs 的 defaultDataDir 一样） */
export function defaultSvcDataDir(env: NodeJS.ProcessEnv): string {
  const local = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(local, "ergo", "supervisor");
}

/** 认是哪一份：dir 是 --dir 给的，cwd 没给是这个进程的当前目录 */
export interface ContextWhere {
  dir?: string;
  cwd?: string;
}

/** 认出这条命令管的那一份；标记文件不对时数据目录照认出的文件夹（语言等照它读），记下错 */
function instanceOf(env: NodeJS.ProcessEnv, homeDir: string, where: ContextWhere): Pick<CliContext, "cwd" | "dataDir" | "serviceId" | "instanceName" | "instanceSource" | "instanceError"> {
  const cwd = path.resolve(where.cwd ?? process.cwd());
  try {
    const found = resolveInstance({ ...(where.dir === undefined ? {} : { dir: where.dir }), env, cwd, homeDir });
    return { cwd, dataDir: found.dataDir, serviceId: found.serviceId, ...(found.name === undefined ? {} : { instanceName: found.name }), instanceSource: found.source };
  } catch (err) {
    if (!(err instanceof InstanceMarkerError)) throw err;
    return { cwd, dataDir: path.dirname(err.file), serviceId: DEFAULT_SERVICE_ID, instanceSource: "marker", instanceError: { file: err.file, reason: err.reason } };
  }
}

export function createContext(layout: InstallLayout, env: NodeJS.ProcessEnv, io: CliIo, homeDir: string = os.homedir(), where: ContextWhere = {}): CliContext {
  return {
    layout,
    env,
    io,
    homeDir,
    ...instanceOf(env, homeDir, where),
    svcDataDir: env.LSM_DATA_DIR?.trim() ? path.resolve(env.LSM_DATA_DIR.trim()) : defaultSvcDataDir(env),
    installRoot: layout.root ?? defaultInstallRoot(env),
    transport: () => componentTransport(env, "ergo-cli"),
  };
}

/** 换成另一份（--dir 给的、ergo update 重起各份时）的上下文：别的照旧 */
export function contextForInstance(ctx: CliContext, where: ContextWhere): CliContext {
  const { instanceError: _old, instanceName: _name, ...rest } = ctx;
  return { ...rest, ...instanceOf(ctx.env, ctx.homeDir, { cwd: ctx.cwd, ...where }) };
}

/** 二狗的本机端口（数据目录的 config/ergo.json 的 ports.local，没写是 8810） */
export function daemonPort(ctx: Pick<CliContext, "dataDir">): number {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ctx.dataDir, "config", "ergo.json"), "utf8").replace(/^\uFEFF/, "")) as { ports?: { local?: unknown } };
    const port = raw.ports?.local;
    if (typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65536) return port;
  } catch {
    // 没有配置文件：默认端口
  }
  return DEFAULT_PORTS.local;
}

export function daemonUrl(ctx: Pick<CliContext, "dataDir">): string {
  return `http://127.0.0.1:${daemonPort(ctx)}/`;
}
