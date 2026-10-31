// 鸿蒙 App 的构建辅助（62 号票）：找 DevEco Studio 自带的工具、从模板生成本机的 build-profile.json5、
// 认出签名材料。`build-harmony.ts` 用它构建，`frontend/test/harmony.test.ts` 用它检查仓库里没有签名材料。
import { copyFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 鸿蒙工程的目录 */
export const HARMONY_DIR = fileURLToPath(new URL("../harmony/", import.meta.url));

/** 不含签名、进仓库的模板 */
export const BUILD_PROFILE_TEMPLATE = "build-profile.template.json5";
/** hvigor 和 DevEco 用的那份：照模板生成，DevEco 的"自动生成签名"写进它；在 .gitignore 里 */
export const BUILD_PROFILE = "build-profile.json5";

/** 没设 DEVECO_HOME 时依次找这几个默认安装位置 */
export const DEFAULT_DEVECO_HOMES: Readonly<Record<string, readonly string[]>> = {
  win32: ["D:\\Program Files\\Huawei\\DevEco Studio", "C:\\Program Files\\Huawei\\DevEco Studio"],
  darwin: ["/Applications/DevEco-Studio.app/Contents"],
};

/** 构建要用到的 DevEco 自带的工具 */
export interface DevEcoTools {
  home: string;
  /** DevEco 自带的 Node（hvigor 认它的版本） */
  node: string;
  /** hvigor 的入口脚本（hvigorw.bat 也只是用 node 跑它） */
  hvigorw: string;
  /** SDK 根目录，交给 hvigor 的 DEVECO_SDK_HOME */
  sdk: string;
  /** DevEco 自带的 JBR（javac 之外还有 hap-sign-tool 要的模块）：交给 hvigor 的 JAVA_HOME */
  javaHome: string;
  /** 要放进 PATH 的目录：Node 和 ohpm */
  pathDirs: string[];
}

/** DevEco 装在 home 时各个工具的位置（Windows 和 macOS 的布局只差 Node 的位置） */
export function devEcoToolsAt(home: string, platform: NodeJS.Platform): DevEcoTools {
  const p = platform === "win32" ? path.win32 : path.posix;
  const nodeDir = platform === "win32" ? p.join(home, "tools", "node") : p.join(home, "tools", "node", "bin");
  return {
    home,
    node: p.join(nodeDir, platform === "win32" ? "node.exe" : "node"),
    hvigorw: p.join(home, "tools", "hvigor", "bin", "hvigorw.js"),
    sdk: p.join(home, "sdk"),
    javaHome: platform === "win32" ? p.join(home, "jbr") : p.join(home, "jbr", "Contents", "Home"),
    pathDirs: [nodeDir, p.join(home, "tools", "ohpm", "bin")],
  };
}

/**
 * 找 DevEco：先看环境变量 DEVECO_HOME，再看默认安装位置；工具（Node、hvigor）都在才算找到。
 * 找不到返回原因，里面写清楚看过哪些位置。
 */
export function findDevEco(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, exists: (file: string) => boolean = existsSync): DevEcoTools | { error: string } {
  const candidates = env.DEVECO_HOME ? [env.DEVECO_HOME] : [...(DEFAULT_DEVECO_HOMES[platform] ?? [])];
  for (const home of candidates) {
    const tools = devEcoToolsAt(home, platform);
    if (exists(tools.node) && exists(tools.hvigorw)) return tools;
  }
  const looked = candidates.length > 0 ? candidates.join("、") : "（这个系统没有默认位置）";
  return {
    error: `找不到 DevEco Studio（看过：${looked}）。装好 DevEco Studio，或者把环境变量 DEVECO_HOME 设成它的安装目录${platform === "darwin" ? "（macOS 上是 DevEco-Studio.app/Contents）" : ""}。`,
  };
}

/** `npm run build:harmony -- <参数>` 认的参数 */
export interface HarmonyBuildOptions {
  /** 打开 WebView 调试（默认关：开着的 App 接上 USB 就能被 hdc 经 DevTools 取走设备凭证 cookie） */
  webviewDebug: boolean;
}

/** 拆命令行参数：只认 --webview-debug；别的报错，免得拼错了以为开了 */
export function parseBuildArgs(argv: readonly string[]): HarmonyBuildOptions | { error: string } {
  const options: HarmonyBuildOptions = { webviewDebug: false };
  for (const arg of argv) {
    if (arg === "--webview-debug") options.webviewDebug = true;
    else return { error: `不认识的参数：${arg}（只有 --webview-debug）` };
  }
  return options;
}

/** 交给 DevEco 自带的 Node 跑的 hvigor 命令行（调试版的 assembleHap；webviewDebug 经 -p 传给 entry/hvigorfile.ts） */
export function hvigorArgs(tools: DevEcoTools, options: HarmonyBuildOptions): string[] {
  return [
    tools.hvigorw,
    "--mode",
    "module",
    "-p",
    "product=default",
    "-p",
    "module=entry@default",
    "-p",
    "buildMode=debug",
    "-p",
    `webviewDebug=${options.webviewDebug}`,
    "assembleHap",
    "--no-daemon",
  ];
}

/** 本机还没有 build-profile.json5 就照模板生成一份；已经有了（可能带着 DevEco 写进去的签名）就不动 */
export function ensureBuildProfile(harmonyDir: string): "created" | "kept" {
  const target = path.join(harmonyDir, BUILD_PROFILE);
  if (existsSync(target)) return "kept";
  copyFileSync(path.join(harmonyDir, BUILD_PROFILE_TEMPLATE), target);
  return "created";
}

/** hvigor 产出的 HAP（product default、module entry、target default） */
export function hapOutputs(harmonyDir: string): { signed: string; unsigned: string } {
  const dir = path.join(harmonyDir, "entry", "build", "default", "outputs", "default");
  return { signed: path.join(dir, "entry-default-signed.hap"), unsigned: path.join(dir, "entry-default-unsigned.hap") };
}

/** App 原生的字（175 号票）：自带语言的 harmony.json 收成一份，打包进 rawfile（App 的 common/AppTexts.ets 读它） */
export const HARMONY_TEXTS_FILE = "harmony-texts.json";

/** 共享协议包的自带语言 */
export const LOCALES_DIR = fileURLToPath(new URL("../../packages/protocol/locales/", import.meta.url));

/**
 * 自带的每种语言（locales/<语言代码>/harmony.json）收成 { 语言代码: { key: 句子 } }：只收 harmony.* 的 key、是字符串的句子；
 * 没有 harmony.json 的语言跳过
 */
export function harmonyTexts(localesDir: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const entry of readdirSync(localesDir, { withFileTypes: true }).toSorted((a, b) => (a.name < b.name ? -1 : 1))) {
    const file = path.join(localesDir, entry.name, "harmony.json");
    if (!entry.isDirectory() || !existsSync(file)) continue;
    const parsed = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as Record<string, unknown>;
    out[entry.name] = Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => e[0].startsWith("harmony.") && typeof e[1] === "string"));
  }
  return out;
}

/** 签名材料本身的文件：证书、描述文件、密钥库、证书请求 */
export const SIGNING_FILE_EXTENSIONS = [".p12", ".p7b", ".cer", ".csr"] as const;

/**
 * 一份文本里有没有签名材料：DevEco 的"自动生成签名"往 build-profile.json5 的 signingConfigs 里写证书和描述文件的路径、
 * 密钥库路径、加密过的口令。认这几样：非空的 signingConfigs、口令和材料路径的字段、指向证书/描述文件/密钥库的路径。
 * 返回找到的每一处（空数组就是干净的）。
 */
export function signingMaterialIn(text: string): string[] {
  const found: string[] = [];
  // 去掉 // 注释，免得模板里讲签名的说明被当成材料
  const code = text.replace(/(^|[^:"'])\/\/[^\n]*/g, "$1");
  const configs = /"?signingConfigs"?\s*:\s*\[([\s\S]*?)\]/.exec(code);
  if (configs && configs[1]?.trim()) found.push("signingConfigs 不是空的");
  for (const field of ["storePassword", "keyPassword", "storeFile", "certpath", "keyAlias"]) {
    if (new RegExp(`"?${field}"?\\s*:`).test(code)) found.push(`有 ${field} 字段`);
  }
  for (const ext of SIGNING_FILE_EXTENSIONS) {
    if (new RegExp(`["'][^"'\\n]*\\${ext}["']`, "i").test(code)) found.push(`有指向 ${ext} 文件的路径`);
  }
  return found;
}
