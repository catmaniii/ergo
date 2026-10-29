// 安装布局（318 号票）：装在哪、在用哪个版本、上一个版本是哪个。安装脚本（installer/install.ps1）、npm run ergo:install、ergo 命令都按这一份。
//
//   <安装目录>（默认 %LOCALAPPDATA%\Programs\ergo，环境变量 ERGO_INSTALL_DIR 可以换）
//     versions\<版本>\          一个版本一个目录：ergo.json（版本信息）、node\node.exe（自带的 Node）或 node.path（用系统 Node 时）、
//                               app\（packages\daemon、protocol、memory、supervisor、web\dist 和 node_modules）、ergo.exe / ergo.cmd、许可证
//     current                   一个文本文件，里面一行写着在用的版本目录的名字（切版本 = 改这个文件）。
//                               老安装里它是目录联接，照样认：经启动器（ergo.exe）跑时建联接会被杀毒软件
//                               按进程链拦（EPERM），2026-10-27 改成写文件的。
//     bin\ergo.exe、ergo.cmd    加进用户 PATH 的只有这一个目录；启动器读 current 找到 node 和命令行
//     downloads\<版本>\         ergo update 下了一半的、校验用的文件（装好后删）
//     install.json              在用的、上一个版本，从哪儿更新
// 数据不在这里：二狗的数据照旧在 ~/.ergo（ERGO_DATA_DIR），服务管家的在 %LOCALAPPDATA%\ergo\supervisor（LSM_DATA_DIR）。升级、重装、卸载程序都不碰数据。
// @i18n-ignore-file log：出错原因给开发者看（命令行另有给人看的一句）
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renameRetrying } from "../util/atomic-file.ts";

/** 版本目录里的版本信息文件 */
export const VERSION_INFO_FILE = "ergo.json";
/** 用系统 Node 装的（-UseSystemNode）：版本目录里写 node.exe 的路径 */
export const NODE_POINTER_FILE = "node.path";

export type VersionKind = "release" | "source" | "link";

/** 版本目录里的 ergo.json */
export interface VersionInfo {
  format: 1;
  /** 二狗的版本（根 package.json 的 version） */
  version: string;
  /** release：发布包；source：从源码构建装的；link：开发模式（版本目录联接到工作目录的构建产物） */
  kind: VersionKind;
  /** 自带的 Node 的版本（不带 v）；用系统 Node 的没有 */
  node?: string;
  /** 构建时的提交号 */
  commit?: string;
  /** 构建时间（ISO） */
  builtAt?: string;
  /** 源码装的：标签或分支 */
  ref?: string;
}

/** 安装目录下的 install.json */
export interface InstallState {
  format: 1;
  /** 上一个版本（ergo rollback 切回它）：版本目录的名字 */
  previous?: string;
  /** 发布从哪儿来：url 是自己指定的地址（latest.json 所在的目录）；不写是 GitHub / npmmirror 挑快的 */
  source?: { mirror?: "github" | "cn"; url?: string };
  /** 谁装的 */
  installedBy?: string;
  /** 服务管家是 ergo 起的（不是开机自启的计划任务）：它的 pid，更新时据此重启它 */
  managerPid?: number;
}

export interface InstallPaths {
  root: string;
  versions: string;
  current: string;
  bin: string;
  downloads: string;
  state: string;
}

/** 默认的安装目录 */
export function defaultInstallRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ERGO_INSTALL_DIR?.trim()) return path.resolve(env.ERGO_INSTALL_DIR.trim());
  const local = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(local, "Programs", "ergo");
}

export function installPaths(root: string): InstallPaths {
  return {
    root,
    versions: path.join(root, "versions"),
    current: path.join(root, "current"),
    bin: path.join(root, "bin"),
    downloads: path.join(root, "downloads"),
    state: path.join(root, "install.json"),
  };
}

export function readVersionInfo(dir: string): VersionInfo | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, VERSION_INFO_FILE), "utf8").replace(/^\uFEFF/, "")) as Partial<VersionInfo>;
    if (typeof raw.version !== "string" || !raw.version) return undefined;
    const kind: VersionKind = raw.kind === "source" || raw.kind === "link" ? raw.kind : "release";
    return { ...raw, format: 1, version: raw.version, kind };
  } catch {
    return undefined;
  }
}

export function writeVersionInfo(dir: string, info: VersionInfo): void {
  fs.writeFileSync(path.join(dir, VERSION_INFO_FILE), `${JSON.stringify(info, null, 2)}\n`);
}

export function readInstallState(root: string): InstallState {
  try {
    const raw = JSON.parse(fs.readFileSync(installPaths(root).state, "utf8").replace(/^\uFEFF/, "")) as InstallState;
    return { ...raw, format: 1 };
  } catch {
    return { format: 1 };
  }
}

export function writeInstallState(root: string, state: InstallState): void {
  fs.mkdirSync(root, { recursive: true });
  const file = installPaths(root).state;
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(`${file}.tmp`, file);
}

/** 版本目录里 node.exe 在哪：自带的 node\node.exe，或者 node.path 写的；都没有是 undefined */
export function nodeOf(home: string): string | undefined {
  const bundled = path.join(home, "node", "node.exe");
  if (fs.existsSync(bundled)) return bundled;
  try {
    const pointed = fs.readFileSync(path.join(home, NODE_POINTER_FILE), "utf8").trim();
    if (pointed && fs.existsSync(pointed)) return pointed;
  } catch {
    // 没有 node.path
  }
  return undefined;
}

export type LayoutKind = "installed" | "dev" | "npm";

export interface InstallLayout {
  /** installed：装在安装目录里；dev：在仓库里直接跑（npm run ergo）；npm：npm i -g ergo-ai 装的 */
  kind: LayoutKind;
  /** 安装目录（installed 才有） */
  root?: string;
  /** 版本目录（installed）；dev、npm 是程序目录 */
  home: string;
  /** packages\ 所在的目录 */
  appDir: string;
  /** 跑守护进程、服务管家用的 node.exe */
  node: string;
  /** 版本信息（installed 才有） */
  info?: VersionInfo;
}

/** 版本目录 → 安装目录：<root>\current 或 <root>\versions\<版本> */
function rootOf(home: string): string | undefined {
  const parent = path.dirname(home);
  if (path.basename(home).toLowerCase() === "current") return parent;
  if (path.basename(parent).toLowerCase() === "versions") return path.dirname(parent);
  return undefined;
}

/**
 * 命令行自己在哪种布局里：启动器（ergo.exe / ergo.cmd）给了 ERGO_HOME 的按它；不然按命令行文件的位置
 * （<程序目录>\packages\daemon\src\cli\main.js，程序目录的上一层有 ergo.json 的是装好的）
 */
export function detectLayout(options: { cliFile: string; env?: NodeJS.ProcessEnv; execPath?: string }): InstallLayout {
  const env = options.env ?? process.env;
  const execPath = options.execPath ?? process.execPath;
  const appFromCli = path.resolve(path.dirname(options.cliFile), "..", "..", "..", "..");
  const candidates = [env.ERGO_HOME?.trim() ? path.resolve(env.ERGO_HOME.trim()) : undefined, path.dirname(appFromCli)].filter((d): d is string => d !== undefined);
  for (const home of candidates) {
    const info = readVersionInfo(home);
    if (!info) continue;
    const root = rootOf(home);
    return { kind: "installed", ...(root ? { root } : {}), home, appDir: path.join(home, "app"), node: nodeOf(home) ?? execPath, info };
  }
  let kind: LayoutKind = "dev";
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(appFromCli, "package.json"), "utf8")) as { name?: string };
    if (pkg.name === "ergo-ai") kind = "npm";
  } catch {
    // 没有 package.json：当开发布局
  }
  return { kind, home: appFromCli, appDir: appFromCli, node: execPath };
}

/** 安装目录里的版本（按名字排；只认有 ergo.json 的） */
export function listVersions(root: string): Array<{ name: string; dir: string; info: VersionInfo }> {
  const dir = installPaths(root).versions;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => !n.endsWith(".partial") && !n.startsWith("."))
    .map((name) => ({ name, dir: path.join(dir, name), info: readVersionInfo(path.join(dir, name)) }))
    .filter((v): v is { name: string; dir: string; info: VersionInfo } => v.info !== undefined)
    .sort((a, b) => compareVersions(a.info.version, b.info.version) || a.name.localeCompare(b.name));
}

/** current 指向哪个版本目录的名字：current 是个一行文本的文件；老安装的目录联接也认 */
export function currentVersionName(root: string): string | undefined {
  const { current } = installPaths(root);
  try {
    const raw = fs.readFileSync(current, "utf8").trim();
    // 只认一行、只认最后一段（有人手写成路径也不至于乱走）
    const name = raw.split(/[\r\n]+/)[0]!.split(/[\\/]/).filter(Boolean).pop();
    if (name) return name;
  } catch {
    // 不是文本文件（老安装是目录联接）
  }
  try {
    return path.basename(path.resolve(path.dirname(current), fs.readlinkSync(current)));
  } catch {
    return undefined;
  }
}

/** 在用的版本目录（current 写的那个，且里面真有 ergo.json）；没有就是 undefined */
export function currentHome(root: string): string | undefined {
  const name = currentVersionName(root);
  if (!name) return undefined;
  const dir = path.join(installPaths(root).versions, name);
  return readVersionInfo(dir) ? dir : undefined;
}

/**
 * 建一个目录联接；杀毒软件扫着刚建的目录时会被拒（EPERM / EBUSY），等一会儿再试（318 号票在本机碰到：刚解开的新版本目录正被扫）
 */
export function createJunction(target: string, link: string, retries = 50): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.symlinkSync(target, link, "junction");
      return;
    } catch (err) {
      // 318 号票在本机碰到：刚下载、解开新版本的那个进程自己建联接被拒（EPERM，等多久都一样，像是安全软件按行为拦的），
      // 换系统自带的 cmd 的 mklink /J 建就行
      if (process.platform === "win32" && (err as NodeJS.ErrnoException).code === "EPERM" && attempt === 0) {
        const r = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", "mklink", "/J", link, target], { windowsHide: true, encoding: "utf8", windowsVerbatimArguments: false });
        if (r.status === 0 && isLink(link)) return;
      }
      const code = (err as NodeJS.ErrnoException).code ?? "";
      // 建到一半留下的空目录先删掉
      try {
        if (!isLink(link)) fs.rmdirSync(link);
      } catch {
        // 没留下
      }
      if (attempt >= retries || !["EPERM", "EBUSY", "EACCES"].includes(code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

/**
 * 把 current 改指到 versions\<name>：写一行文本，不建目录联接。
 * 以前是目录联接，但经启动器（PowerShell → ergo.exe → node）跑 `ergo update` 时建联接会被杀毒软件按进程链拦（EPERM），
 * 2026-10-27 改成写文件——切换不碰联接，谁的机器上都不会被拦。
 */
export function switchCurrent(root: string, name: string): void {
  const { current, versions } = installPaths(root);
  const target = path.join(versions, name);
  if (!readVersionInfo(target)) throw new Error(`版本目录 ${target} 不对（没有 ergo.json）`);
  const tmp = `${current}.tmp`;
  removeFileOrLink(tmp);
  fs.writeFileSync(tmp, `${name}\n`);
  // 老安装的目录联接先摘掉（rename 到目录上会失败）；这里只摘 current 本身，不能用 removeCurrent（它会把刚写的 tmp 也清掉）
  removeFileOrLink(current);
  try {
    renameRetrying(tmp, current);
  } catch (err) {
    removeFileOrLink(tmp);
    throw err;
  }
}

/** 摘掉 current 本身（切版本、卸载）：老安装的目录联接、新装的一行文本、上次失败留下的半成品都认；不在就算了 */
export function removeCurrent(root: string): void {
  const { current } = installPaths(root);
  removeFileOrLink(current);
  removeFileOrLink(`${current}.tmp`);
  removeFileOrLink(`${current}.new`);
  removeFileOrLink(`${current}.old`);
}

function removeFileOrLink(p: string): void {
  if (isLink(p)) {
    try {
      fs.rmdirSync(p);
    } catch {
      fs.unlinkSync(p);
    }
    return;
  }
  fs.rmSync(p, { force: true });
}

function isLink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** 删一个目录联接本身（不碰它指向的目录）；不在就算了 */
export function removeLink(p: string): void {
  if (!isLink(p)) return;
  try {
    fs.rmdirSync(p);
  } catch {
    fs.unlinkSync(p);
  }
}

/** 版本号比大小（1.2.10 > 1.2.9；带 -后缀的比不带的小） */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [main = "", pre] = v.replace(/^v/, "").split("-", 2);
    return { nums: main.split(".").map((x) => Number.parseInt(x, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre.localeCompare(y.pre);
}

/**
 * 只留 keep 里的版本目录，别的删掉（"旧版本留一份"）；正被占用删不掉的留着、记下来，下次再删。
 * 联接到工作目录的（开发模式）只删联接本身
 */
export function pruneVersions(root: string, keep: readonly string[]): { removed: string[]; busy: string[] } {
  const { versions } = installPaths(root);
  const removed: string[] = [];
  const busy: string[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(versions);
  } catch {
    return { removed, busy };
  }
  const keepSet = new Set(keep.map((k) => k.toLowerCase()));
  for (const name of names) {
    if (keepSet.has(name.toLowerCase())) continue;
    const dir = path.join(versions, name);
    try {
      if (isLink(dir)) removeLink(dir);
      else fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
      removed.push(name);
    } catch {
      busy.push(name);
    }
  }
  return { removed, busy };
}
