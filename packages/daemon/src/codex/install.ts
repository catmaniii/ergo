// 本机的 Codex 在哪、版本够不够、交给它的环境（ADR-0046）。Codex 不随二狗分发、不是 npm 依赖：用设置 · 组件装的那份（454，从 npm 官方下
// @openai/codex 和它的 win32-x64 平台包，装到 <组件区>\codex），或者用户自己装的 codex（npm i -g @openai/codex），都用 Codex 自己的登录和配置。
// 守护进程这一侧（插件的 missing、体检）和子进程（拉起 app-server）都用这一份，这里不 import 子进程的模块。
// - 找入口：先找组件区（组件装的版本钉在核对过 app-server 协议的那一版，用户是在二狗里点了装的；不想用它就在组件页删掉），
//   再按 PATH 里的目录找。组件区在哪：守护进程这一侧传进来，子进程从守护进程带的 ERGO_COMPONENTS_DIR 取。
//   Node 在 Windows 上起进程不搜 PATHEXT、起不了 .cmd（照 claude-env.ts 的 findClaudeExecutable）：codex.exe 直接起；
//   npm 装的是 codex.cmd 这类包装脚本，旁边 node_modules/@openai/codex/bin/codex.js 才是真的入口，用二狗自己的 Node 起它
//   （它再按 require.resolve 找平台包 @openai/codex-win32-x64、拉起里面 vendor/<目标>/bin/codex.exe，带上官方要的环境）；
//   组件区里也是同样的 node_modules 结构，一样用二狗自己的 Node 起 codex.js；
// - 登录：二狗不登录、不读凭据（Codex 自己存在它的配置目录或系统的凭据管理器里）。组件装的不在 PATH 上，告诉用户登录时要写出
//   完整的命令（codexLoginCommand：PowerShell 的写法）；
// - 版本：npm 装的读包里的 package.json，不起进程；codex.exe 跑一次 --version（不联网）。低于 CODEX_MIN_VERSION 不装配：
//   app-server 的协议就是按这一版核对的（test/fixtures/codex-app-server.schema.json）。读到的按"入口文件 + 修改时间"缓存，
//   体检（414，codexVersionChecked）读同一份，没缓存时异步跑一次 --version；
// - 环境：从子进程自己的环境（守护进程按白名单给的）拷一份，去掉会改计费方式、改账号的变量和从别的 Codex 会话继承来的变量。
//   Codex 自己认哪些是从 0.166 的程序里核对的。本机登录的凭据在 auth.json 里，二狗不读。
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { t } from "@ergo/protocol";
import { COMPONENTS_DIR_ENV } from "../process/child-env.ts";

/** 最低版本：app-server 的协议按这一版核对 */
export const CODEX_MIN_VERSION = "0.166.0";

/** codex.exe 跑 --version 最多等多久（毫秒；不联网，正常一两秒） */
export const CODEX_VERSION_TIMEOUT_MS = 15_000;

/** 交给 codex 之前去掉的环境变量（Windows 上名字不分大小写，按大写比） */
export const STRIPPED_CODEX_ENV = [
  // 改计费方式、改账号：有这些 Codex 就不走本机登录
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "CODEX_CONNECTORS_TOKEN",
  "CODEX_GUARDIAN_DECISIONS_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "OPENAI_ORGANIZATION",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT",
  "OPENAI_PROJECT_ID",
  // 改请求发到哪
  "OPENAI_BASE_URL",
  "CODEX_APP_SERVER_CHATGPT_BASE_URL",
  // 从别的 Codex 会话继承来的
  "CODEX_SESSION_ID",
  "CODEX_THREAD_ID",
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
  "CODEX_EXEC_SERVER_URL",
] as const;

const stripped = new Set<string>(STRIPPED_CODEX_ENV);

/** codex 进程的环境：子进程自己的环境去掉上面那些 */
export function codexProcessEnv(parent: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value !== undefined && !stripped.has(name.toUpperCase())) env[name] = value;
  }
  return env;
}

/** 怎么起 codex：程序和它前面的参数 */
export interface CodexEntry {
  command: string;
  args: string[];
  /** 设置 · 组件装的那份（不在 PATH 上：登录要写完整的命令） */
  component?: true;
}

/** 组件区里装 Codex 的那个组件（组件清单里 codex 的 target 是 components/codex） */
export const CODEX_COMPONENT = "codex";

const NPM_ENTRY = ["node_modules", "@openai", "codex", "bin", "codex.js"] as const;

export interface FindCodexOptions {
  platform?: NodeJS.Platform;
  exists?: (file: string) => boolean;
  /** 起 codex.js 用的 Node（不给是本进程的：守护进程、子进程自己的） */
  node?: string;
  /** 组件区（数据目录的 components\）；不给按 env 里的 ERGO_COMPONENTS_DIR（守护进程给子进程带的），都没有就只找 PATH */
  componentsDir?: string | undefined;
}

/** 环境变量按名字取（Windows 上不分大小写） */
function envValue(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  const value = key === undefined ? undefined : env[key];
  return value === undefined || value.trim() === "" ? undefined : value;
}

/** 组件区里 codex 的入口文件（不管在不在）：<组件区>\codex\node_modules\@openai\codex\bin\codex.js */
export function codexComponentScript(componentsDir: string, platform: NodeJS.Platform = process.platform): string {
  return (platform === "win32" ? path.win32 : path.posix).join(componentsDir, CODEX_COMPONENT, ...NPM_ENTRY);
}

/**
 * 本机的 codex（见文件开头）：先找组件区里装的，再按 PATH 里的目录先后找；都没有是 undefined
 */
export function findCodexEntry(env: Readonly<Record<string, string | undefined>>, options: FindCodexOptions = {}): CodexEntry | undefined {
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? fs.existsSync;
  const componentsDir = options.componentsDir ?? envValue(env, COMPONENTS_DIR_ENV);
  if (componentsDir !== undefined) {
    const script = codexComponentScript(componentsDir, platform);
    if (exists(script)) return { command: options.node ?? process.execPath, args: [script], component: true };
  }
  return findCodexOnPath(env, options);
}

/** 只按 PATH 找（用户自己装的那份；组件区不算）：都没有是 undefined */
export function findCodexOnPath(env: Readonly<Record<string, string | undefined>>, options: Omit<FindCodexOptions, "componentsDir"> = {}): CodexEntry | undefined {
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? fs.existsSync;
  const node = options.node ?? process.execPath;
  const lib = platform === "win32" ? path.win32 : path.posix;
  const pathKey = Object.keys(env).find((name) => name.toUpperCase() === "PATH");
  const dirs = (pathKey === undefined ? "" : (env[pathKey] ?? "")).split(platform === "win32" ? ";" : ":").map((dir) => dir.trim().replace(/^"(.*)"$/, "$1"));
  for (const dir of dirs) {
    if (!dir) continue;
    const script = lib.join(dir, ...NPM_ENTRY);
    if (platform === "win32") {
      const exe = lib.join(dir, "codex.exe");
      if (exists(exe)) return { command: exe, args: [] };
      if (exists(lib.join(dir, "codex.cmd")) && exists(script)) return { command: node, args: [script] };
    } else if (exists(lib.join(dir, "codex"))) {
      return exists(script) ? { command: node, args: [script] } : { command: lib.join(dir, "codex"), args: [] };
    }
  }
  return undefined;
}

/** 这个入口是什么版本；读不出来是 undefined（文件变了才重新读） */
const versions = new Map<string, { mtime: number; version: string | undefined }>();
export function codexVersion(entry: CodexEntry): string | undefined {
  const script = entry.args[0];
  const file = script ?? entry.command;
  let mtime: number;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
  const known = versions.get(file);
  if (known?.mtime === mtime) return known.version;
  const version = script === undefined ? versionFromProgram(entry.command) : versionFromPackage(script);
  versions.set(file, { mtime, version });
  return version;
}

/** 跑一次 `codex --version`，交回它打印的（起不来、超时、退出码不是 0 是 undefined）：体检用的不卡住守护进程的那种 */
export type CodexVersionRunner = (program: string) => Promise<string | undefined>;

const runVersion: CodexVersionRunner = (program) =>
  new Promise((resolve) => {
    execFile(program, ["--version"], { encoding: "utf8", timeout: CODEX_VERSION_TIMEOUT_MS, windowsHide: true }, (err, stdout) => resolve(err ? undefined : stdout));
  });

/**
 * 体检读版本（414）：和 codexVersion 同一份缓存（插件装配前的 missing 已经读过一次，文件没变直接用）；没缓存、文件变了才现读——
 * npm 装的读包里的 package.json，codex.exe 异步跑一次 --version（最多 CODEX_VERSION_TIMEOUT_MS，不卡住守护进程），读到的记进缓存。
 * 入口没了（文件不在）是 undefined
 */
export async function codexVersionChecked(entry: CodexEntry, run: CodexVersionRunner = runVersion): Promise<string | undefined> {
  const script = entry.args[0];
  const file = script ?? entry.command;
  let mtime: number;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
  const known = versions.get(file);
  if (known?.mtime === mtime) return known.version;
  const version = script === undefined ? /(\d+\.\d+\.\d+)/.exec((await run(entry.command)) ?? "")?.[1] : versionFromPackage(script);
  versions.set(file, { mtime, version });
  return version;
}

function versionFromPackage(script: string): string | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(script), "..", "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

function versionFromProgram(program: string): string | undefined {
  try {
    const out = execFileSync(program, ["--version"], { encoding: "utf8", timeout: CODEX_VERSION_TIMEOUT_MS, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    return /(\d+\.\d+\.\d+)/.exec(out)?.[1];
  } catch {
    return undefined;
  }
}

/** a 比 b 旧（只比前三段数字） */
export function versionOlder(a: string, b: string): boolean {
  const parts = (v: string) => v.split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  }
  return false;
}

/**
 * 没装、版本太低时给人看的一句（没装什么、怎么装：设置 · 组件里装「Codex 接入」，或者自己 npm i -g）；能用是 undefined（插件定义的 missing）。
 * 登录没登录这里不查：要起 app-server，第一轮才知道
 */
export function codexMissing(env: Readonly<Record<string, string | undefined>> = process.env, componentsDir?: string): string | undefined {
  const entry = findCodexEntry(env, { componentsDir });
  if (!entry) return t("codex.plugin.notInstalled", { component: CODEX_COMPONENT });
  const version = codexVersion(entry);
  if (version === undefined) return t("codex.plugin.unknownVersion", { min: CODEX_MIN_VERSION, component: CODEX_COMPONENT });
  return versionOlder(version, CODEX_MIN_VERSION) ? t("codex.plugin.tooOld", { version, min: CODEX_MIN_VERSION, component: CODEX_COMPONENT }) : undefined;
}

/**
 * PATH 上用户自己装的、版本够的 codex（组件页的 provided：codex-cli——有了它就不用从组件页装）：在哪（npm 装的是 codex.js，别的是程序本身）、
 * 什么版本；没有、版本读不出、太旧都是 undefined
 */
export function codexOnPath(env: Readonly<Record<string, string | undefined>>): { where: string; version: string } | undefined {
  const entry = findCodexOnPath(env);
  if (!entry) return undefined;
  const version = codexVersion(entry);
  if (version === undefined || versionOlder(version, CODEX_MIN_VERSION)) return undefined;
  return { where: entry.args[0] ?? entry.command, version };
}

/** PowerShell 里一个参数的写法：单引号包起来（里面的单引号写两个），不展开 $ 和反引号 */
const psQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/**
 * 登录要在终端里运行的命令：PATH 上的就是 codex login；组件装的不在 PATH 上，写完整的——用二狗自己的 Node 起组件里的 codex.js
 * （PowerShell 的写法：& '<node.exe>' '<codex.js>' login）。没找到 codex 也写 codex login
 */
export function codexLoginCommand(entry: CodexEntry | undefined): string {
  if (!entry?.component) return "codex login";
  return `& ${[entry.command, ...entry.args].map(psQuote).join(" ")} login`;
}
