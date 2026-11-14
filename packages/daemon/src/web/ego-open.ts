// 替 agent 打开 ego lite（466 返修，用户定的"甲"）：agent 一要用 ego-browser、ego lite 又没开着，二狗替它打开，
// 而且要像用户自己打开的一样——不在二狗（守护进程、服务管家）的 Job 里，二狗重启、停止、崩溃都带不走它，清残留进程也碰不到它。
//
// 为什么要二狗来开：ego-browser 连不上 ego lite 时会自己起 ego.exe（程序里有 "Failed to start ego lite"、
// "startup-ego-browser-service"），起来的进程是 agent 的 bash 的子孙，在二狗的 Job 里（KILL_ON_JOB_CLOSE、不许脱离），
// 二狗一停就被一起关掉——用户的浏览器连同登录着的网站一起没了。所以抢在它前面，用不在 Job 里的方式先把 ego lite 开起来。
//
// 怎么开：交给已经在跑的桌面外壳。`explorer.exe "<ego.exe>"` 起来的那个 explorer 只是把"打开它"转给用户登录时就在的那个
// explorer（桌面外壳），自己马上退出；ego.exe 是桌面外壳的子进程，和用户双击图标打开的一模一样，不在调用方的 Job 里
// （测试 ego-open-job.test.ts 在一个 KILL_ON_JOB_CLOSE 的 Job 里这样起一个假程序、关掉 Job 核对它还活着）。
// 不建计划任务、服务，不改注册表和系统设置，不留任何常驻的东西。桌面外壳不在同一个会话里（没有桌面、explorer 崩了）时不开：
// 那样起的 explorer 自己就成了外壳、留在 Job 里。
//
// 怎么等它好：ego-browser 经命名管道 \\.\pipe\mojo.CitroLabs.ego.<版本>（ego lite 的 ego_cli 引导服务）连 ego lite，
// 管道出现就是好了。没等到管道、但 ego lite 的主进程起来了 EGO_OPEN_SETTLE_MS 也算好：这时 ego lite 已经占住了自己的
// "单实例"，ego-browser 就算再起一个 ego.exe，那个也只会把命令转给开着的这个、自己退出，不会有留在 Job 里的浏览器。
// 一直没见 ego lite 起来就不往下跑（不让 ego-browser 自己去起），告诉 agent 请用户自己打开。
//
// 几个 agent 同时要用时只开一次：先开的在 shim 目录里占一个 opening 目录（mkdir 是原子的），别的只等。
// 只在 Windows 上做；macOS 上二狗不托管（只支持 Windows），ego-browser 照旧，见 466 的 Comments。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { processSessionIds, processSnapshot } from "../process/process-list.ts";
import { type EgoBrowserFound, egoLiteRunning, egoProgramDirs } from "./ego-browser.ts";

/** ego lite 的 ego_cli 引导服务的命名管道的名字开头（后面是版本号，实测 mojo.CitroLabs.ego.0.6.3.14） */
export const EGO_BOOTSTRAP_PIPE_PREFIX = "mojo.CitroLabs.ego.";
/** 开了之后最多等多久（毫秒） */
export const EGO_OPEN_TIMEOUT_MS = 20_000;
/** 没等到管道时，ego lite 的主进程起来多久就算好了（毫秒） */
export const EGO_OPEN_SETTLE_MS = 5_000;
/** 隔多久看一次（毫秒） */
export const EGO_OPEN_POLL_MS = 250;
/** 别人占着"正在开"超过这么久就当他死了、自己接着开（毫秒） */
export const EGO_OPEN_STALE_MS = EGO_OPEN_TIMEOUT_MS + 10_000;

/**
 * 这条 ego-browser 命令要不要 ego lite 开着：只看帮助、版本的不用（`--help`、`-h`、`--version`、`-v`、`help …`，
 * 什么都不带的也是打帮助），别的（nodejs、skill、import、upgrade、认不得的）都要——它们要连 ego lite，连不上就会自己去起
 */
export function egoCommandNeedsApp(args: readonly string[]): boolean {
  const words = args.filter((a) => !a.startsWith("--ego-server-name"));
  if (words.length === 0) return false;
  if (words.some((a) => a === "--help" || a === "-h" || a === "--version" || a === "-v")) return false;
  return words[0] !== "help";
}

/** 找 ego lite 主程序要用的外部东西（测试换成假的） */
export interface EgoAppProbe {
  env: Readonly<Record<string, string | undefined>>;
  isFile(file: string): boolean;
  /** 解开链接后的真实路径（active_version_dir 是指向 Program Files 里当前版本的链接）；解不开抛错 */
  realpath(p: string): string;
}

/**
 * ego lite 的主程序 ego.exe 在哪（Windows）：ego-browser 在 …\ego lite\Application\<版本>\ 里（经 active_version_dir 链过去），
 * 主程序在上一层 …\ego lite\Application\ego.exe；找不到再看几处固定的安装位置（Program Files、Program Files (x86)、LocalAppData
 * 下的 Citro Labs\ego lite\Application）。都没有是 undefined
 */
export function egoAppPath(found: Pick<EgoBrowserFound, "path" | "dir">, probe: EgoAppProbe): string | undefined {
  const p = path.win32;
  const candidates: string[] = [];
  try {
    const real = probe.realpath(found.dir);
    candidates.push(p.join(p.dirname(real), "ego.exe"));
  } catch {
    // 解不开链接：只看固定的位置
  }
  const value = (name: string) => probe.env[Object.keys(probe.env).find((k) => k.toUpperCase() === name.toUpperCase()) ?? name];
  for (const root of [value("ProgramFiles"), value("ProgramFiles(x86)"), value("LOCALAPPDATA")]) {
    if (root) candidates.push(p.join(root, "Citro Labs", "ego lite", "Application", "ego.exe"));
  }
  return candidates.find((file) => probe.isFile(file));
}

/** 命名管道的列表（Windows；`//./pipe/` 就是 `\\.\pipe\`，列目录不会去连哪个管道）；列不了是空的 */
export function listNamedPipes(): string[] {
  try {
    return fs.readdirSync("//./pipe/");
  } catch {
    return [];
  }
}

/** ego lite 的引导服务在不在（ego-browser 连的就是它）：有一个名字以 EGO_BOOTSTRAP_PIPE_PREFIX 开头的命名管道 */
export function egoBootstrapListening(pipes: readonly string[]): boolean {
  const prefix = EGO_BOOTSTRAP_PIPE_PREFIX.toLowerCase();
  return pipes.some((name) => name.toLowerCase().startsWith(prefix));
}

/** 打开结果 */
export type EgoOpenResult =
  /** 本来就开着（或者引导服务在） */
  | { kind: "open" }
  /** 二狗替用户打开了：等到了引导服务（bootstrap），或者主进程起来够久了（settled） */
  | { kind: "opened"; ready: "bootstrap" | "settled" }
  /**
   * 没开成，不往下跑：找不到主程序（no-app）、没有同一个会话里的桌面外壳（no-shell）、
   * 起 explorer 出错（launch-error）、等到点了没见 ego lite 起来（not-started）
   */
  | { kind: "failed"; reason: "no-app" | "no-shell" | "launch-error" | "not-started"; detail?: string };

/** ensureEgoOpen 要用的外部东西（测试换成假的） */
export interface EgoOpenDeps {
  /** ego lite 的主进程在不在（可执行文件在 ego lite 的程序目录下的 ego.exe） */
  running(): boolean;
  /** ego lite 的引导服务在不在（命名管道） */
  bootstrapListening(): boolean;
  /** 同一个会话里有没有桌面外壳（explorer.exe） */
  shellRunning(): boolean;
  /** ego lite 的主程序；找不到是 undefined */
  appPath: string | undefined;
  /** 像用户自己打开那样打开它（交给桌面外壳）；出错抛 */
  launch(app: string): Promise<void>;
  /** 占"正在开"：占到了回一个放手的函数；别人正在开回 undefined（那就只等） */
  claim(): (() => void) | undefined;
  now(): number;
  sleep(ms: number): Promise<void>;
  timeoutMs?: number;
  settleMs?: number;
  pollMs?: number;
}

/** ego lite 开着就直接回；没开就替用户打开、等它好（见文件开头） */
export async function ensureEgoOpen(deps: EgoOpenDeps): Promise<EgoOpenResult> {
  if (deps.bootstrapListening() || deps.running()) return { kind: "open" };
  if (deps.appPath === undefined) return { kind: "failed", reason: "no-app" };
  if (!deps.shellRunning()) return { kind: "failed", reason: "no-shell" };
  const timeout = deps.timeoutMs ?? EGO_OPEN_TIMEOUT_MS;
  const settle = deps.settleMs ?? EGO_OPEN_SETTLE_MS;
  const poll = deps.pollMs ?? EGO_OPEN_POLL_MS;
  const release = deps.claim();
  try {
    if (release) {
      try {
        await deps.launch(deps.appPath);
      } catch (err) {
        return { kind: "failed", reason: "launch-error", detail: err instanceof Error ? err.message : String(err) };
      }
    }
    const start = deps.now();
    let seenAt: number | undefined;
    for (;;) {
      if (deps.bootstrapListening()) return { kind: "opened", ready: "bootstrap" };
      const now = deps.now();
      if (deps.running()) {
        seenAt ??= now;
        if (now - seenAt >= settle) return { kind: "opened", ready: "settled" };
      } else {
        seenAt = undefined;
      }
      if (now - start >= timeout) return seenAt === undefined ? { kind: "failed", reason: "not-started" } : { kind: "opened", ready: "settled" };
      await deps.sleep(poll);
    }
  } finally {
    release?.();
  }
}

/** 桌面外壳：Windows 目录下的 explorer.exe */
export function explorerPath(env: Readonly<Record<string, string | undefined>>): string {
  const root = env[Object.keys(env).find((k) => k.toUpperCase() === "SYSTEMROOT") ?? "SystemRoot"] ?? "C:\\Windows";
  return path.win32.join(root, "explorer.exe");
}

/**
 * 像用户自己打开那样打开一个程序（Windows）：`explorer.exe "<程序>"`，新起的 explorer 把它转给已经在跑的桌面外壳、自己退出，
 * 程序是桌面外壳的子进程，不在调用方的 Job 里。只能打开、不能带参数（explorer 不往下传）。explorer 的退出码不看（成功了也常是 1），
 * 等它退出（最多 waitMs，不退也不管）；起不来抛错
 */
export function openLikeUser(file: string, options: { env?: Readonly<Record<string, string | undefined>>; waitMs?: number } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    // 不设 windowsHide：设了的话"隐藏"会被一路带给打开的程序
    const child = spawn(explorerPath(options.env ?? process.env), [file], { stdio: "ignore" });
    const timer = setTimeout(resolve, options.waitMs ?? 10_000);
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** 同一个会话里有没有桌面外壳 explorer.exe（Windows）；看不了算没有 */
export function desktopShellRunning(): boolean {
  try {
    const shells = [...processSnapshot()].filter(([, entry]) => /^explorer\.exe$/i.test(entry.exe)).map(([pid]) => pid);
    if (shells.length === 0) return false;
    const sessions = processSessionIds([process.pid, ...shells]);
    const mine = sessions.get(process.pid);
    return mine !== undefined && shells.some((pid) => sessions.get(pid) === mine);
  } catch {
    return false;
  }
}

/**
 * "正在开"的占位：lockDir 下的 opening 目录（mkdir 原子）。占到了回放手的函数；别人占着回 undefined；
 * 占着超过 staleMs 的当作那边已经死了，删掉自己占
 */
export function claimOpening(lockDir: string, options: { staleMs?: number; now?: () => number } = {}): (() => void) | undefined {
  const mark = path.join(lockDir, "opening");
  const now = options.now ?? Date.now;
  const tryClaim = () => {
    try {
      fs.mkdirSync(lockDir, { recursive: true });
      fs.mkdirSync(mark);
      return true;
    } catch {
      return false;
    }
  };
  const release = () => {
    try {
      fs.rmdirSync(mark);
    } catch {
      // 已经没了
    }
  };
  if (tryClaim()) return release;
  try {
    if (now() - fs.statSync(mark).mtimeMs < (options.staleMs ?? EGO_OPEN_STALE_MS)) return undefined;
  } catch {
    // 刚被放掉：再占一次
  }
  release();
  return tryClaim() ? release : undefined;
}

/** 真的：本机进程、命名管道、桌面外壳 */
export function realEgoOpenDeps(input: { found: EgoBrowserFound; env: Readonly<Record<string, string | undefined>>; homeDir: string; lockDir: string }): EgoOpenDeps {
  const dirs = egoProgramDirs({ found: input.found, env: input.env, homeDir: input.homeDir, platform: "win32" });
  return {
    running: () => egoLiteRunning(dirs, "win32") === true,
    bootstrapListening: () => egoBootstrapListening(listNamedPipes()),
    shellRunning: desktopShellRunning,
    appPath: egoAppPath(input.found, {
      env: input.env,
      isFile: (file) => {
        try {
          return fs.statSync(file).isFile();
        } catch {
          return false;
        }
      },
      realpath: (p) => fs.realpathSync.native(p),
    }),
    launch: (app) => openLikeUser(app, { env: input.env }),
    claim: () => claimOpening(input.lockDir),
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
