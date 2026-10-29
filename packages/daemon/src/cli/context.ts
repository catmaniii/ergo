// ergo 命令的上下文（318 号票）：装在哪、数据在哪、服务管家的数据在哪、怎么输出、怎么联网。各条命令只经它拿这些，测试换成假的。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { componentTransport } from "../components/index.ts";
import type { Transport } from "../components/transport.ts";
import { DEFAULT_PORTS } from "../config/config.ts";
import { resolveDataDir } from "../config/old-names.ts";
import { defaultInstallRoot, type InstallLayout } from "../release/layout.ts";

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
  /** 二狗的数据目录（ERGO_DATA_DIR，没设是 ~/.ergo） */
  dataDir: string;
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

export function createContext(layout: InstallLayout, env: NodeJS.ProcessEnv, io: CliIo, homeDir: string = os.homedir()): CliContext {
  return {
    layout,
    env,
    io,
    homeDir,
    dataDir: resolveDataDir(env, homeDir).dir,
    svcDataDir: env.LSM_DATA_DIR?.trim() ? path.resolve(env.LSM_DATA_DIR.trim()) : defaultSvcDataDir(env),
    installRoot: layout.root ?? defaultInstallRoot(env),
    transport: () => componentTransport(env, "ergo-cli"),
  };
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
