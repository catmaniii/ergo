// 本机的 Codex 在哪、版本够不够、交给它的环境（ADR-0046）。Codex 不随二狗分发、不是 npm 依赖：用用户自己装的 codex（npm i -g @openai/codex），
// 用它自己的登录和配置。守护进程这一侧（插件的 missing）和子进程（拉起 app-server）都用这一份，这里不 import 子进程的模块。
// - 找入口：Node 在 Windows 上起进程不搜 PATHEXT、起不了 .cmd（照 claude-env.ts 的 findClaudeExecutable）。按 PATH 里的目录找：
//   codex.exe 直接起；npm 装的是 codex.cmd 这类包装脚本，旁边 node_modules/@openai/codex/bin/codex.js 才是真的入口，用二狗自己的 Node 起它
//   （它再拉起平台包里的原生程序，带上官方要的环境）；
// - 版本：npm 装的读包里的 package.json，不起进程；codex.exe 跑一次 --version（不联网）。低于 CODEX_MIN_VERSION 不装配：
//   app-server 的协议就是按这一版核对的（test/fixtures/codex-app-server.schema.json）。读到的按"入口文件 + 修改时间"缓存，
//   体检（414，codexVersionChecked）读同一份，没缓存时异步跑一次 --version；
// - 环境：从子进程自己的环境（守护进程按白名单给的）拷一份，去掉会改计费方式、改账号的变量和从别的 Codex 会话继承来的变量。
//   Codex 自己认哪些是从 0.166 的程序里核对的。本机登录的凭据在 auth.json 里，二狗不读。
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { t } from "@ergo/protocol";

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
}

const NPM_ENTRY = ["node_modules", "@openai", "codex", "bin", "codex.js"] as const;

/**
 * 本机的 codex（见文件开头）：按 PATH 里的目录先后找；都没有是 undefined。node 是起 codex.js 用的 Node（守护进程、子进程自己的）
 */
export function findCodexEntry(
  env: Readonly<Record<string, string | undefined>>,
  options: { platform?: NodeJS.Platform; exists?: (file: string) => boolean; node?: string } = {},
): CodexEntry | undefined {
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

/** 没装、版本太低时给人看的一句（没装什么、怎么装、怎么登录）；能用是 undefined（插件定义的 missing）。登录没登录这里不查：要起 app-server，第一轮才知道 */
export function codexMissing(env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  const entry = findCodexEntry(env);
  if (!entry) return t("codex.plugin.notInstalled");
  const version = codexVersion(entry);
  if (version === undefined) return t("codex.plugin.unknownVersion", { min: CODEX_MIN_VERSION });
  return versionOlder(version, CODEX_MIN_VERSION) ? t("codex.plugin.tooOld", { version, min: CODEX_MIN_VERSION }) : undefined;
}
