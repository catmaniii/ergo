// agent 的 PATH 上那个薄的 ego-browser（466 返修，"甲"）：拉起 agent 时，PATH 最前面放的不是 ego 的目录，而是二狗在缓存区写的
// 一个小目录，里面一个同名的 ego-browser——先确保 ego lite 开着（没开就像用户自己打开那样替他打开，见 ego-open.ts），
// 再把参数原样交给真的 ego-browser（标准输入、输出、退出码都照旧）。
//
// 为什么放在 PATH 上、不走守卫：三种运行时（pi 的 bash、Claude Code 的 Bash / PowerShell、Codex 的 PowerShell）起命令都按 PATH
// 找 ego-browser，脚本里、子 shell 里再调的也一样；守卫只看得见 agent 直接写的那一句，而且守卫是判"能不能做"的地方，不该顺手开程序。
// 为什么 shim 自己开、不回头请守护进程开：agent 的进程到守护进程没有现成的通道（要新开一个给 agent 调的接口），
// 而"交给桌面外壳打开"谁来做都一样不在 Job 里；逻辑和守护进程共用 ego-open.ts 这一份。
//
// 目录里三个文件（只在 Windows 上；别的系统照旧把 ego 的目录放到 PATH 上）：
// - ego-browser：Git Bash 用的 sh 脚本（pi 的 bash、Claude Code 的 Bash）；
// - ego-browser.cmd：PowerShell、cmd 用的（Codex、Claude Code 的 PowerShell；同一个目录里 PowerShell 认 .cmd、不认没扩展名的）；
// - target.json：真的 ego-browser 在哪。
// 两个脚本都是 `<node> <ego-browser-shim-main> <这个目录> 参数…`。.cmd 文件按控制台的代码页读，中文路径写进去会读错，
// 所以 .cmd 先用环境变量 ERGO_EGO_SHIM_NODE、ERGO_EGO_SHIM_ENTRY（拉起 agent 时和 PATH 一起给），没有时才用写在里面的路径
// （只在路径全是 ASCII 时写进去）。内容没变不重写。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "../util/atomic-file.ts";
import { EGO_BROWSER_COMMAND, EGO_LITE_URL } from "./ego-browser.ts";
import { EGO_OPEN_TIMEOUT_MS, egoCommandNeedsApp, type EgoOpenDeps, type EgoOpenResult, ensureEgoOpen, realEgoOpenDeps } from "./ego-open.ts";

const ownExt = path.extname(fileURLToPath(import.meta.url));
/** shim 的入口（和守护进程同一种扩展名） */
export const EGO_SHIM_ENTRY = fileURLToPath(new URL(`./ego-browser-shim-main${ownExt}`, import.meta.url));
/** .cmd 用的：跑 shim 的 Node、shim 的入口 */
export const EGO_SHIM_NODE_ENV = "ERGO_EGO_SHIM_NODE";
export const EGO_SHIM_ENTRY_ENV = "ERGO_EGO_SHIM_ENTRY";
/** 真的 ego-browser 在哪（shim 目录里） */
export const EGO_SHIM_TARGET_FILE = "target.json";

/** target.json 的内容 */
export interface EgoShimTarget {
  format: 1;
  /** 真的 ego-browser.exe */
  egoBrowser: string;
}

/** 交给 agent 的：放到 PATH 最前面的目录，和一起给的环境变量 */
export interface EgoAgentPath {
  dir: string;
  env: Readonly<Record<string, string>>;
}

/** sh 里的一个参数：单引号包起来（里面的单引号写成 '\''）；Windows 路径换成正斜杠（Git Bash 认） */
function shArg(text: string): string {
  return `'${text.replaceAll("\\", "/").replaceAll("'", `'\\''`)}'`;
}

const isAscii = (text: string) => /^[\x20-\x7e]*$/.test(text);

/** shim 目录里的文件（名字 → 内容）：纯函数 */
export function egoShimFiles(input: { dir: string; egoBrowser: string; node: string; entry: string }): Record<string, string> {
  const target: EgoShimTarget = { format: 1, egoBrowser: input.egoBrowser };
  const sh = [
    "#!/bin/sh",
    // @i18n-ignore-start log：写进 shim 脚本里的注释（给看这个文件的开发者）
    "# 二狗（466）：agent 的 PATH 上的 ego-browser。先确保 ego lite 开着（没开就像用户自己打开那样替他打开，不在二狗的 Job 里），",
    "# 再把参数原样交给真的 ego-browser（在哪写在 target.json 里）。二狗拉起 agent 时写的，改了也会被写回去。",
    // @i18n-ignore-end
    `exec ${shArg(input.node)} ${shArg(input.entry)} ${shArg(input.dir)} "$@"`,
    "",
  ].join("\n");
  // .cmd 只写 ASCII（按控制台的代码页读）；路径里有别的字时不写兜底，只认环境变量
  const fallback = isAscii(input.node) && isAscii(input.entry);
  const cmd = [
    "@echo off",
    "rem ergo (466): the ego-browser on agents' PATH. Makes sure ego lite is open first (opened the way the user opens it,",
    "rem outside ergo's Job), then hands every argument to the real ego-browser (see target.json). Written by ergo.",
    "setlocal",
    ...(fallback
      ? [`if not defined ${EGO_SHIM_NODE_ENV} set "${EGO_SHIM_NODE_ENV}=${input.node}"`, `if not defined ${EGO_SHIM_ENTRY_ENV} set "${EGO_SHIM_ENTRY_ENV}=${input.entry}"`]
      : [`if not defined ${EGO_SHIM_NODE_ENV} (echo ego-browser: ${EGO_SHIM_NODE_ENV} is not set 1>&2 & exit /b 1)`]),
    `"%${EGO_SHIM_NODE_ENV}%" "%${EGO_SHIM_ENTRY_ENV}%" "%~dp0." %*`,
    "",
  ].join("\r\n");
  return { [EGO_BROWSER_COMMAND]: sh, [`${EGO_BROWSER_COMMAND}.cmd`]: cmd, [EGO_SHIM_TARGET_FILE]: `${JSON.stringify(target, null, 2)}\n` };
}

/**
 * 写好 shim 目录（内容变了才写），回放到 PATH 最前面的目录和要一起给的环境变量。不是 Windows 回 undefined（调用方照旧放 ego 的目录）；
 * 写不了记日志、回 undefined
 */
export function prepareEgoShim(input: {
  dir: string;
  egoBrowser: string;
  node?: string;
  entry?: string;
  platform?: NodeJS.Platform;
  log: (line: string) => void;
}): EgoAgentPath | undefined {
  if ((input.platform ?? process.platform) !== "win32") return undefined;
  const node = input.node ?? process.execPath;
  const entry = input.entry ?? EGO_SHIM_ENTRY;
  try {
    fs.mkdirSync(input.dir, { recursive: true });
    for (const [name, content] of Object.entries(egoShimFiles({ dir: input.dir, egoBrowser: input.egoBrowser, node, entry }))) {
      const file = path.join(input.dir, name);
      let current: string | undefined;
      try {
        current = fs.readFileSync(file, "utf8");
      } catch {
        current = undefined;
      }
      if (current !== content) writeFileAtomic(file, content);
    }
  } catch (err) {
    input.log(`写不了 ego-browser 的 shim（${input.dir}）：${err instanceof Error ? err.message : String(err)}；这次直接把 ego 的目录放到 PATH 上`); // @i18n-ignore log
    return undefined;
  }
  return { dir: input.dir, env: { [EGO_SHIM_NODE_ENV]: node, [EGO_SHIM_ENTRY_ENV]: entry } };
}

/** 开不成时给 agent 的话（都请用户自己打开 ego lite；给模型看的，照旧用中文） */
// @i18n-ignore-start model：agent 在命令输出里看到的提示
function failedNote(result: Extract<EgoOpenResult, { kind: "failed" }>): string {
  const ask = "请用户自己打开电脑上的 ego lite，好了回你一句，再跑一次这条命令。";
  switch (result.reason) {
    case "no-app":
      return `ego lite 没开着，二狗也没找到它的主程序 ego.exe，替用户打开不了。${ask}`;
    case "no-shell":
      return `ego lite 没开着；用户的桌面（资源管理器）没在运行，二狗没法像用户自己打开那样替他打开。${ask}`;
    case "launch-error":
      return `ego lite 没开着，二狗替用户打开时出错（${result.detail ?? "原因不明"}）。${ask}`;
    case "not-started":
      return `ego lite 没开着，二狗替用户打开了，但 ${EGO_OPEN_TIMEOUT_MS / 1000} 秒内没见它起来。${ask}`;
  }
}

/** 找不到真的 ego-browser 时给 agent 的话 */
function missingNote(target: EgoShimTarget | undefined): string {
  return `找不到 ego-browser${target ? `（${target.egoBrowser} 不在了）` : ""}：ego lite 可能刚卸载或者正在升级。请用户打开 ego lite 看看，没装的去 ${EGO_LITE_URL} 装、走完首次引导；好了再跑一次。`;
}

/** 替用户打开了时给 agent 的话 */
function openedNote(ready: "bootstrap" | "settled"): string {
  return `ego lite 没开着，二狗已经替用户打开了（和用户自己打开的一样，二狗重启也不会关掉它）${ready === "bootstrap" ? "。" : "；还没确认它准备好接命令，要是这条失败了，等几秒再跑一次。"}`;
}
// @i18n-ignore-end

/**
 * shim 做的事（ego-browser-shim-main.ts 调）：
 * 1. 读 shim 目录里的 target.json，找到真的 ego-browser；不在了说一句、回 127（不乱找别的）；
 * 2. 这条命令要连 ego lite 的（egoCommandNeedsApp：nodejs、skill、import、upgrade……，只看帮助、版本的不用），在 Windows 上先确保
 *    ego lite 开着——没开就替用户打开（交给桌面外壳，不在二狗的 Job 里），等它好了再往下（ego-open.ts）。开不成就说明原因、请用户自己
 *    打开，回 1、不往下跑（往下跑的话 ego-browser 会自己去起 ego lite，起来的就在二狗的 Job 里，二狗一停就被带走）；
 * 3. 把参数原样交给真的 ego-browser：标准输入、输出、错误输出继承同一份（heredoc、管道照旧），回它的退出码。
 * 给 agent 的话写在错误输出上，前面带"[二狗] "。openDeps、say 测试换成假的
 */
export async function runEgoShim(input: {
  dir: string;
  args: readonly string[];
  platform?: NodeJS.Platform;
  openDeps?: (found: { path: string; dir: string }, lockDir: string) => EgoOpenDeps;
  say?: (line: string) => void;
}): Promise<number> {
  const say = input.say ?? ((line: string) => process.stderr.write(`[二狗] ${line}\n`)); // @i18n-ignore model
  const dir = path.resolve(input.dir);
  const target = readEgoShimTarget(dir);
  let exists = false;
  try {
    exists = target !== undefined && fs.statSync(target.egoBrowser).isFile();
  } catch {
    exists = false;
  }
  if (!target || !exists) {
    say(missingNote(target));
    return 127;
  }
  if ((input.platform ?? process.platform) === "win32" && egoCommandNeedsApp(input.args)) {
    const found = { path: target.egoBrowser, dir: path.dirname(target.egoBrowser) };
    const deps = input.openDeps ? input.openDeps(found, dir) : realEgoOpenDeps({ found: { ...found, source: "config" }, env: process.env, homeDir: os.homedir(), lockDir: dir });
    const result = await ensureEgoOpen(deps);
    if (result.kind === "failed") {
      say(failedNote(result));
      return 1;
    }
    if (result.kind === "opened") say(openedNote(result.ready));
  }
  return await new Promise<number>((resolve) => {
    const child = spawn(target.egoBrowser, [...input.args], { stdio: "inherit" });
    child.once("error", (err) => {
      say(`起不来 ego-browser（${target.egoBrowser}）：${err.message}`); // @i18n-ignore model
      resolve(1);
    });
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

/** 读 shim 目录里的 target.json；没有、坏了是 undefined */
export function readEgoShimTarget(dir: string): EgoShimTarget | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, EGO_SHIM_TARGET_FILE), "utf8")) as Partial<EgoShimTarget>;
    return parsed.format === 1 && typeof parsed.egoBrowser === "string" && parsed.egoBrowser !== "" ? { format: 1, egoBrowser: parsed.egoBrowser } : undefined;
  } catch {
    return undefined;
  }
}
