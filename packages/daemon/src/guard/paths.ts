// 路径：把 agent 写的路径解析成绝对路径，判断落在哪一区。纯字符串运算，不碰文件系统。
//
// - 二狗只跑在 Windows 上、bash 只认 Git Bash，所以一律按 Windows 语义（path.win32），在哪个系统上跑测试结果都一样；
// - 解析方式和 pi 的文件工具一致（pi 1.0.4 utils/paths.js）：去掉开头的 `@`、Unicode 空格换成普通空格、
//   Git Bash / MSYS / Cygwin / WSL 的盘符路径（`/d/x`、`/mnt/d/x`、`/cygdrive/d/x`）换成 `D:\x`、展开 `~`、`file://`，
//   再相对 agent 的工作目录解析；
// - 比较时不分大小写、不分 `/` 和 `\`；
// - Git Bash 的 `/tmp`：知道它挂到哪（ShellEnv.tmpMount，177 号票）就按那个目录解析；
// - 别的不认得的 POSIX 绝对路径（`/usr`、`/etc` 这类 Git Bash 挂载点，不知道挂到哪时的 `/tmp`）算"项目外的未知位置"；
//   `/dev/null` 这类伪设备不算路径。
//
// 判定函数自己不展开符号链接、目录联接和 8.3 短名：调用方可以在环境事实里给出真实路径，判定时一并检查。
import { t } from "@ergo/protocol";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";
import type { GuardAgent } from "./types.ts";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
/** Git Bash / MSYS / Cygwin / WSL 的盘符写法的开头（`/d`、`/mnt/d`、`/cygdrive/d`），盘符是第一个分组 */
const SHELL_DRIVE_PREFIX = String.raw`\/(?:mnt\/|cygdrive\/)?([a-z])`;
const SHELL_DRIVE = new RegExp(String.raw`^${SHELL_DRIVE_PREFIX}(?:\/(.*))?$`, "i");
const WINDOWS_ABSOLUTE = /^(?:[a-z]:[\\/]|\\\\)/i;
/** Git Bash 的 /tmp 和它下面的 */
const GIT_BASH_TMP = /^\/tmp(?:\/|$)/;
const PSEUDO_DEVICES = /^\/dev\/(?:null|zero|stdin|stdout|stderr|tty|fd\/\d+|u?random)$/i;

/** 解析结果：绝对路径，或者没法确定的位置 */
export type ResolvedPath =
  | { kind: "absolute"; path: string }
  /** 路径里有变量或命令替换、或在不认得的 POSIX 挂载点下：位置不确定，按项目外算 */
  | { kind: "unknown"; raw: string; why: string }
  /** /dev/null 这类伪设备：不是文件 */
  | { kind: "device"; raw: string };

/** 解析路径要用的环境：相对路径的基准和用户主目录 */
export interface ShellEnv {
  /** 工作目录：相对路径的基准 */
  cwd: string;
  /** 用户主目录：展开 `~`、`$HOME` 用 */
  homeDir: string;
  /**
   * 这个 agent 的 bash 起的进程带着的、值已知的环境变量（77 号票：事件触发的流程把事件的值放进环境变量，命令里只引用变量）：
   * 拆 bash 命令时 `$X`、`${X}` 按这里的值静态展开，守卫看到的路径和真正跑的一样
   */
  vars?: Readonly<Record<string, string>> | undefined;
  /**
   * Git Bash 里 `/tmp` 挂到的 Windows 目录（177 号票，见 GuardAgent 的 bashTmp）：`/tmp`、`/tmp/…` 按它解析。
   * 不给时 `/tmp` 和别的挂载点一样算没法确定
   */
  tmpMount?: string | undefined;
}

/** 按 agent 解析路径的环境：它的工作目录、用户主目录，它的 bash 带着的环境变量和 /tmp 挂到哪（有的话） */
export function agentShellEnv(
  agent: { cwd: string; shellVars?: Readonly<Record<string, string>> | undefined; bashTmp?: string | undefined },
  homeDir: string,
): ShellEnv {
  return { cwd: agent.cwd, homeDir, ...(agent.shellVars ? { vars: agent.shellVars } : {}), ...(agent.bashTmp ? { tmpMount: agent.bashTmp } : {}) };
}

const UNRESOLVED_PREFIX = "<unresolved:";

/**
 * 从 bash 拆出来、但没法静态确定的路径（含变量、命令替换、花括号展开，或者 cd 到了没法确定的目录之后的相对路径），
 * 在伪工具调用的参数里写成 `<unresolved:原文>`。Windows 文件名里不能有 `<`，不会和真路径混淆。
 */
export function unresolvedPath(text: string): string {
  return `${UNRESOLVED_PREFIX}${text}>`;
}

/** 是不是 unresolvedPath() 写出来的"没法确定的路径" */
export function isUnresolvedPath(raw: string): boolean {
  return raw.startsWith(UNRESOLVED_PREFIX);
}

/** 相对路径（要靠工作目录才能解析） */
export function isRelativePath(raw: string): boolean {
  const p = raw.replace(UNICODE_SPACES, " ").replace(/^@/, "");
  return !(/^[a-z]:/i.test(p) || p.startsWith("/") || p.startsWith("\\") || p.startsWith("~") || /^file:/i.test(p) || isUnresolvedPath(p));
}

/**
 * Git Bash / MSYS / Cygwin / WSL 的盘符写法（`/d/x`、`/mnt/d/x`、`/cygdrive/d/x`）换成 Windows 路径（`D:\x`）；
 * 不是这种写法（或者里面已经有反斜杠）返回 undefined
 */
export function fromShellDrivePath(p: string): string | undefined {
  const drive = SHELL_DRIVE.exec(p);
  if (!drive || p.includes("\\")) return undefined;
  return `${drive[1]!.toUpperCase()}:\\${(drive[2] ?? "").replaceAll("/", "\\")}`;
}

/** 完整的 Windows 绝对路径：盘符加分隔符（`D:\x`、`D:/x`），或者网络路径（`\\server\share`） */
export function isWindowsAbsolutePath(p: string): boolean {
  return WINDOWS_ABSOLUTE.test(p);
}

/** 把 agent 写的路径解析成绝对路径（Windows 语义） */
export function resolveAgentPath(raw: string, env: ShellEnv): ResolvedPath {
  const { cwd, homeDir } = env;
  if (isUnresolvedPath(raw)) return { kind: "unknown", raw: raw.slice(UNRESOLVED_PREFIX.length, -1), why: t("guard.paths.variable") };
  if (isUnresolvedPath(cwd) && isRelativePath(raw)) return { kind: "unknown", raw, why: t("guard.paths.cdUnknown") };
  let p = raw.replace(UNICODE_SPACES, " ");
  if (p.startsWith("@")) p = p.slice(1);
  if (PSEUDO_DEVICES.test(p)) return { kind: "device", raw };
  if (/^file:\/\//i.test(p)) {
    try {
      p = fileURLToPath(p, { windows: true });
    } catch {
      return { kind: "unknown", raw, why: t("guard.paths.fileUrl") };
    }
  }
  const homeRelative = p === "~" || p.startsWith("~/") || p.startsWith("~\\");
  // 主目录没法确定（事后从参数里认路径、不知道调用时的主目录，66 号票）：~ 开头的同样没法确定
  if (homeRelative && isUnresolvedPath(homeDir)) return { kind: "unknown", raw, why: t("guard.paths.homeUnknown") };
  if (p === "~") p = homeDir;
  else if (homeRelative) p = win32.join(homeDir, p.slice(2));
  else if (p.startsWith("~")) return { kind: "unknown", raw, why: t("guard.paths.otherHome") };
  const shellDrive = fromShellDrivePath(p);
  if (shellDrive !== undefined) p = shellDrive;
  // Git Bash 的 /tmp（挂载点区分大小写，只认小写）
  else if (env.tmpMount !== undefined && GIT_BASH_TMP.test(p)) p = win32.join(env.tmpMount, p.slice("/tmp".length));
  else if ((p.startsWith("/") && !p.startsWith("//")) || (p.startsWith("\\") && !p.startsWith("\\\\"))) {
    return { kind: "unknown", raw, why: t("guard.paths.driveRoot") };
  }
  // `D:foo` 这种盘符相对路径取决于进程环境里那个盘的当前目录，判定函数不看环境
  if (/^[a-z]:(?![\\/])/i.test(p)) return { kind: "unknown", raw, why: t("guard.paths.driveRelative") };
  return { kind: "absolute", path: win32.resolve(cwd, p) };
}

/** 规范化成可比较的形式：Windows 语义、去掉末尾分隔符、小写 */
export function comparable(p: string): string {
  let n = win32.normalize(p);
  if (n.length > 3 && (n.endsWith("\\") || n.endsWith("/"))) n = n.slice(0, -1);
  return n.toLowerCase();
}

/** target 是不是 dir 本身或在它里面 */
export function isWithin(target: string, dir: string): boolean {
  const target2 = comparable(target);
  const d = comparable(dir);
  if (target2 === d) return true;
  return target2.startsWith(d.endsWith("\\") ? d : `${d}\\`);
}

export function isWithinAny(target: string, dirs: readonly string[]): boolean {
  return dirs.some((d) => isWithin(target, d));
}

/**
 * git 会照着执行命令的控制文件：仓库配置（`.git/config`、`config.worktree`，worktree 和子模块在 `.git/worktrees/<名字>/`、
 * `.git/modules/<名字>/` 下的同样算）和钩子目录 `.git/hooks/`。它们在工作目录里，但写它们等于让之后的 git 调用
 * （包括带类型的 bash 工具的提交、状态）执行任意命令，所以写入按"越出项目目录"判（28 号票）
 */
export function isGitControlPath(p: string): boolean {
  return /\\\.git(?:\\(?:worktrees|modules)\\[^\\]+)*\\(?:config(?:\.worktree)?|hooks(?:\\.*)?)$/i.test(win32.normalize(p));
}

/** 路径里不会有的字符（到这里算路径结束）：空白、引号、重定向和管道、括号、逗号分号 */
const PATH_END = String.raw`[^\s'"\x60<>|,;()\[\]{}]*`;
const WINDOWS_PATH_IN_TEXT = new RegExp(String.raw`(?<![\w])[a-z]:[\\/]${PATH_END}`, "gi");
const SHELL_PATH_IN_TEXT = new RegExp(String.raw`(?<![\w.:\\/~-])${SHELL_DRIVE_PREFIX}\/${PATH_END}`, "gi");

/**
 * 一段文字（内联脚本、脚本文件的内容）里写着的绝对路径，解析成 Windows 路径（尽力而为：只认写死的盘符路径和 Git Bash 的盘符写法，
 * 字符串里转义过的反斜杠 `\\` 也认；拼出来的、用变量的认不出）。守卫据此判断脚本会不会碰受保护区域（26 号票）
 */
export function absolutePathsIn(text: string): string[] {
  const unescaped = text.replaceAll("\\\\", "\\");
  const found = new Set<string>();
  for (const m of unescaped.matchAll(WINDOWS_PATH_IN_TEXT)) found.add(win32.normalize(m[0]));
  // 文字里的 Git Bash 写法后面可能混着反斜杠（`/d/app\\x`）：统一成正斜杠再换
  for (const m of unescaped.matchAll(SHELL_PATH_IN_TEXT)) found.add(win32.normalize(fromShellDrivePath(m[0].replaceAll("\\", "/"))!));
  return [...found];
}

/**
 * 项目档案的历史区（15 号票）：项目区里每个项目一格（<项目区>\<项目>），被整体重写或删除前的旧版本由运行时留在
 * 格子里的这个目录。它只由运行时写：任何 agent 用任何方式写入或删除都是永不（受保护区域）
 */
export const PROJECT_HISTORY_DIR = ".history";

/** target 落在哪个项目的历史区里（历史区本身或里面）；不在任何项目的历史区里时返回 undefined */
export function projectHistoryOf(target: string, projectsDir: string): string | undefined {
  if (!isWithin(target, projectsDir)) return undefined;
  const base = comparable(projectsDir);
  const rest = win32.normalize(target).slice(base.length).split(/[\\/]/).filter((s) => s !== "");
  if (rest.length < 2 || rest[1]!.toLowerCase() !== PROJECT_HISTORY_DIR) return undefined;
  return historyDirOf(win32.join(projectsDir, rest[0]!));
}

/** 一个项目档案（<项目区>\<项目>）的历史区 */
export function historyDirOf(recordsRoot: string): string {
  return win32.join(recordsRoot, PROJECT_HISTORY_DIR);
}

/** agent 能碰的范围：维护者和子 agent 是项目档案和工作目录，秘书是草稿区 */
export function agentScope(agent: GuardAgent): string[] {
  return agent.kind === "secretary" ? [agent.scratchDir] : [...agent.projectRecords, ...agent.workingDirs];
}
