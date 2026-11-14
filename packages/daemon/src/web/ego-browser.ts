// ego 浏览器在哪（466）：ego lite（Citro Labs 出的 Chromium 浏览器，人和 agent 共用，用的是用户已登录的网站）带一个命令 ego-browser，
// agent 在 bash 里用它跑脚本操作浏览器。拉起 agent 时把它的目录放到 PATH 最前面、联网工具的说明里写不写它、体检、
// 孤儿回收不碰的目录，都从这里取——找法全仓库只有这一份（照 browser-path.ts）。
//
// 找的顺序：① 配置里显式写的 web.egoBrowserPath → ② 守护进程自己的 PATH → ③ 用户 PATH（Windows 注册表 HKCU\Environment 的 Path：
// ego lite 走完首次引导时把命令加在这里，只对之后启动的进程生效，守护进程多半比它先起来）→ ④ 默认位置（Windows：
// %USERPROFILE%\.local\share\ego\active_version_dir\ego-browser.exe，active_version_dir 是指向 Program Files 里当前版本的链接；
// macOS 照 ego 的 install-macos.md：~/.local/bin/ego-browser，再是 /Applications、~/Applications 里 ego lite.app 的 Helpers）。
// 配置写了但文件不在：记一条日志，接着按后面的找。
//
// 没找到不一直记着：用户后来装上的，下次拉起 agent 时要找得到。探测要便宜：找到了记住，下次只看那个文件还在不在（stat 一次）；
// 没找到的结果只记 MISS_TTL_MS（这期间连着拉起几个 agent 不重复读注册表）；读注册表是进程内调 RegGetValueW，不起子进程。
//
// ego 自己的东西二狗只读不碰：不关 ego lite，不在里面开 TaskSpace（那是 agent 经 ego-browser 做的事）。唯一的例外是 agent 要用、它又没开着时，
// 像用户自己打开那样替他打开（466 返修，web/ego-open.ts、ego-shim.ts）。
import fs from "node:fs";
import path from "node:path";
import { processImagePaths, processSnapshot } from "../process/process-list.ts";
import { readUserEnvironmentVariable } from "../process/user-env.ts";

/** 命令名（agent 在 bash 里敲的） */
export const EGO_BROWSER_COMMAND = "ego-browser";
/** ego lite 的网站：没装时让用户去这里装 */
export const EGO_LITE_URL = "https://lite.ego.app/";
/** 没找到的结果记多久（毫秒）：这期间不重复探测 */
export const EGO_MISS_TTL_MS = 30_000;

/** 从哪找到的：配置、守护进程的 PATH、用户 PATH（注册表）、默认位置 */
export type EgoBrowserSource = "config" | "path" | "user-path" | "default";

export interface EgoBrowserFound {
  /** ego-browser 的可执行文件（找到时的写法，不解链接：active_version_dir 跟着 ego 升级换版本，PATH 里放它不会过期） */
  path: string;
  /** 它所在的目录（放到 agent 的 PATH 最前面的就是它） */
  dir: string;
  source: EgoBrowserSource;
}

/** 探测要用的外部东西（测试换成假的文件系统、假的注册表） */
export interface EgoBrowserProbe {
  platform: NodeJS.Platform;
  /** 守护进程自己的环境（PATH，展开用户 PATH 里的 %变量%） */
  env: Readonly<Record<string, string | undefined>>;
  homeDir: string;
  /** 配置里写的 web.egoBrowserPath */
  configured?: string | undefined;
  /** 是不是一个文件（不在、是目录都算不是） */
  isFile(file: string): boolean;
  /** 列一个目录（macOS 找 ego lite.app 里的 Helpers 用）；读不了是空的 */
  readDir(dir: string): string[];
  /** 用户 PATH 的原样值（Windows 注册表 HKCU\Environment 的 Path，%变量% 没展开）；没有、读不了是 undefined */
  userPath(): string | undefined;
}

/** 真的：本机文件系统和注册表 */
export function realEgoProbe(input: { env: Readonly<Record<string, string | undefined>>; homeDir: string; configured?: string | undefined; platform?: NodeJS.Platform }): EgoBrowserProbe {
  return {
    platform: input.platform ?? process.platform,
    env: input.env,
    homeDir: input.homeDir,
    configured: input.configured,
    isFile: (file) => {
      try {
        return fs.statSync(file).isFile();
      } catch {
        return false;
      }
    },
    readDir: (dir) => {
      try {
        return fs.readdirSync(dir);
      } catch {
        return [];
      }
    },
    userPath: () => readUserEnvironmentVariable("Path"),
  };
}

const pathOf = (platform: NodeJS.Platform) => (platform === "win32" ? path.win32 : path.posix);

/** 可执行文件的名字：Windows 上带 .exe */
export function egoExeName(platform: NodeJS.Platform): string {
  return platform === "win32" ? `${EGO_BROWSER_COMMAND}.exe` : EGO_BROWSER_COMMAND;
}

/** 环境变量按名字取（Windows 上不分大小写） */
function envValue(env: Readonly<Record<string, string | undefined>>, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/** 展开 Windows 写法的 %变量%（认不得的原样留着） */
export function expandWindowsVars(text: string, env: Readonly<Record<string, string | undefined>>): string {
  return text.replace(/%([^%;]+)%/g, (whole, name: string) => envValue(env, name, "win32") ?? whole);
}

/** PATH 那样的一串拆成目录：Windows 用 ; 分、去掉两头的引号，别的系统用 :；空的去掉 */
export function pathDirs(value: string | undefined, platform: NodeJS.Platform): string[] {
  if (!value) return [];
  return value
    .split(platform === "win32" ? ";" : ":")
    .map((d) => d.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
}

/** 默认位置（按 ego 的安装说明）：Windows 一处；macOS 是 ~/.local/bin，再是两处 ego lite.app 里的 Helpers；别的系统没有 */
export function egoDefaultCandidates(probe: Pick<EgoBrowserProbe, "platform" | "homeDir" | "readDir">): string[] {
  const p = pathOf(probe.platform);
  if (probe.platform === "win32") return [p.join(probe.homeDir, ".local", "share", "ego", "active_version_dir", egoExeName("win32"))];
  if (probe.platform !== "darwin") return [];
  const helpers = (app: string) => {
    const frameworks = p.join(app, "Contents", "Frameworks");
    return probe
      .readDir(frameworks)
      .filter((name) => name.endsWith(".framework"))
      .toSorted()
      .map((name) => p.join(frameworks, name, "Versions", "Current", "Helpers", EGO_BROWSER_COMMAND));
  };
  return [p.join(probe.homeDir, ".local", "bin", EGO_BROWSER_COMMAND), ...helpers("/Applications/ego lite.app"), ...helpers(p.join(probe.homeDir, "Applications", "ego lite.app"))];
}

/**
 * 找一次（不记结果）：配置 → 守护进程的 PATH → 用户 PATH → 默认位置，第一个存在的。log 记"配置写了但文件不在"
 */
export function findEgoBrowser(probe: EgoBrowserProbe, log?: (line: string) => void): EgoBrowserFound | undefined {
  const p = pathOf(probe.platform);
  const found = (file: string, source: EgoBrowserSource): EgoBrowserFound => ({ path: file, dir: p.dirname(file), source });
  if (probe.configured) {
    if (probe.isFile(probe.configured)) return found(probe.configured, "config");
    log?.(`配置里写的 web.egoBrowserPath 不在：${probe.configured}，接着按 PATH、默认位置找`); // @i18n-ignore log
  }
  const exe = egoExeName(probe.platform);
  const inDirs = (dirs: readonly string[]) => dirs.map((d) => p.join(d, exe)).find((file) => probe.isFile(file));
  const fromPath = inDirs(pathDirs(envValue(probe.env, "PATH", probe.platform), probe.platform));
  if (fromPath) return found(fromPath, "path");
  const user = probe.userPath();
  const fromUser = user === undefined ? undefined : inDirs(pathDirs(expandWindowsVars(user, probe.env), probe.platform));
  if (fromUser) return found(fromUser, "user-path");
  const fallback = egoDefaultCandidates(probe).find((file) => probe.isFile(file));
  return fallback ? found(fallback, "default") : undefined;
}

/** 找 ego-browser：每次拉起 agent、装配联网工具、体检时问它 */
export interface EgoBrowserLocator {
  /** 现在找得到的；没装是 undefined。找到的记住（只看文件还在不在），没找到的只记 EGO_MISS_TTL_MS */
  find(): EgoBrowserFound | undefined;
}

export function createEgoBrowserLocator(probe: EgoBrowserProbe, options: { log: (line: string) => void; now?: () => number; missTtlMs?: number }): EgoBrowserLocator {
  const now = options.now ?? Date.now;
  const ttl = options.missTtlMs ?? EGO_MISS_TTL_MS;
  let hit: EgoBrowserFound | undefined;
  let missedAt: number | undefined;
  /** 上一次记日志时的样子（找到的路径，没找到是 ""）：变了才再记 */
  let logged: string | undefined;
  const note = (result: EgoBrowserFound | undefined) => {
    const key = result?.path ?? "";
    if (key === logged) return;
    logged = key;
    // @i18n-ignore-start log
    options.log(
      result
        ? `ego 浏览器用 ${result.path}（${{ config: "配置的 web.egoBrowserPath", path: "守护进程的 PATH", "user-path": "用户 PATH", default: "默认位置" }[result.source]}）：拉起 agent 时把这个目录放到 PATH 最前面`
        : `没找到 ego 浏览器（${EGO_BROWSER_COMMAND}）：agent 用不了它，联网工具的说明里写"没装"；装上之后下次拉起 agent 会重新找`,
    );
    // @i18n-ignore-end
  };
  return {
    find() {
      if (hit && probe.isFile(hit.path)) return hit;
      if (hit === undefined && missedAt !== undefined && now() - missedAt < ttl) return undefined;
      hit = findEgoBrowser(probe, options.log);
      missedAt = hit ? undefined : now();
      note(hit);
      return hit;
    },
  };
}

/**
 * ego lite 的程序目录（孤儿回收不碰这些目录下的可执行文件，体检认"ego lite 在跑"也按它）：找到的 ego-browser 所在目录、
 * 解开链接后的真实目录和它往上的安装目录（…\ego lite\Application\<版本> → …\ego lite），加上 Windows 上几处固定的安装位置
 * （Program Files、Program Files (x86)、LocalAppData 下的 Citro Labs\ego lite）和 active_version_dir 那一层（~\.local\share\ego）。
 * 没找到 ego-browser 时只有固定的那几处
 */
export function egoProgramDirs(input: { found: EgoBrowserFound | undefined; env: Readonly<Record<string, string | undefined>>; homeDir: string; platform?: NodeJS.Platform; realpath?: (p: string) => string }): string[] {
  const platform = input.platform ?? process.platform;
  const p = pathOf(platform);
  const realpath = input.realpath ?? ((dir: string) => fs.realpathSync.native(dir));
  const dirs: string[] = [];
  if (input.found) {
    dirs.push(input.found.dir);
    let real: string | undefined;
    try {
      real = realpath(input.found.dir);
    } catch {
      real = undefined;
    }
    if (real !== undefined) {
      dirs.push(real);
      // …\ego lite\Application\<版本>：主程序 ego.exe 在 Application 那一层，整个 ego lite 目录都算
      const parent = p.dirname(real);
      if (p.basename(parent).toLowerCase() === "application") dirs.push(p.dirname(parent));
    }
  }
  if (platform === "win32") {
    for (const root of [envValue(input.env, "ProgramFiles", platform), envValue(input.env, "ProgramFiles(x86)", platform), envValue(input.env, "LOCALAPPDATA", platform)]) {
      if (root) dirs.push(p.join(root, "Citro Labs", "ego lite"));
    }
    dirs.push(p.join(input.homeDir, ".local", "share", "ego"));
  } else if (platform === "darwin") {
    dirs.push("/Applications/ego lite.app", p.join(input.homeDir, "Applications", "ego lite.app"));
  }
  const seen = new Set<string>();
  return dirs.filter((d) => {
    const key = platform === "win32" ? p.resolve(d).toLowerCase() : p.resolve(d);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 可执行文件是不是在这些目录（或它们的子目录）里；Windows 上不分大小写（纯函数） */
export function isUnderDirs(file: string, dirs: readonly string[], platform: NodeJS.Platform = process.platform): boolean {
  const p = pathOf(platform);
  const norm = (x: string) => (platform === "win32" ? p.resolve(x).toLowerCase() : p.resolve(x));
  const target = norm(file);
  return dirs.some((d) => {
    const dir = norm(d);
    return target === dir || target.startsWith(dir.endsWith(p.sep) ? dir : dir + p.sep);
  });
}

/** ego lite 自己的进程叫什么（主程序 ego.exe；ego-browser 本身也算）：认不出路径时按名字兜底 */
export function isEgoProgramName(exe: string): boolean {
  return /^ego(-browser)?(\.exe)?$/i.test(exe);
}

/**
 * ego lite 的版本号，从路径上看（不起任何进程）：找到的 ego-browser 所在目录解开链接后的最后一段——active_version_dir 是指向
 * `…\ego lite\Application\<版本>` 的链接，像版本号（数字加点，0.6.3.14）就是它；不像（装在别处、没有链接）是 undefined，只报"装了"。
 * 不跑 `ego-browser --version`：ego lite 没开着时它会不会去拉起 ego 没实测过，拉起来的就在二狗的 Job 里（466）；
 * ego-browser.exe 的 FileVersion、ProductVersion 都是空的，读 PE 版本信息也没用
 */
export function egoVersionFromPath(found: Pick<EgoBrowserFound, "dir">, realpath: (p: string) => string = (p) => fs.realpathSync.native(p)): string | undefined {
  let real: string;
  try {
    real = realpath(found.dir);
  } catch {
    return undefined;
  }
  // Windows 和 POSIX 的分隔符都认（macOS 上解出来是 /Applications/…）
  const last = real.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  return /^\d+(?:\.\d+)+$/.test(last) ? last : undefined;
}

/**
 * ego lite 现在开没开（体检用）：进程快照里有 ego.exe，而且它的可执行文件在 ego lite 的程序目录下（取不到路径的按名字算）。
 * 只在 Windows 上看得了，别的系统、快照出错是 undefined
 */
export function egoLiteRunning(dirs: readonly string[], platform: NodeJS.Platform = process.platform): boolean | undefined {
  if (platform !== "win32") return undefined;
  try {
    const ego = [...processSnapshot()].filter(([, entry]) => /^ego\.exe$/i.test(entry.exe)).map(([pid]) => pid);
    if (ego.length === 0) return false;
    const images = processImagePaths(ego);
    return ego.some((pid) => {
      const image = images.get(pid);
      return image === undefined || isUnderDirs(image, dirs, platform);
    });
  } catch {
    return undefined;
  }
}
