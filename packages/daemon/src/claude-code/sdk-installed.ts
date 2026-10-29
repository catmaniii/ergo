// Claude Code 的 Agent SDK 装没装（315 号票）：SDK（@anthropic-ai/claude-agent-sdk）是 Anthropic 自己的许可、不是开源，二狗不随它分发——
// 它在 packages/daemon/package.json 里是可选依赖（optionalDependencies：照常 npm install 会装上，打包发布时去掉，用的人自己装、用自己的订阅）。
// 没装时 Claude Code 插件不装配（插件宿主的 PluginDefinition.missing）：设置 · 插件里写"没装"和怎么装，新建任务、项目时 Claude Code 那一项
// 写同一句，别的功能不受影响。
// 两个地方找（318 号票）：按 Node 的解析规则从程序目录往上找 node_modules（开发、npm 装的）；找不到再看组件区
// （<数据目录>\components\claude-code\node_modules，设置 · 组件或 ergo components add claude-code 从 npm 官方下的，安装包、源码装都是这样）。
// 只找、不加载它：SDK 只在子进程里引（child/load-sdk.ts；test/claude-code/boundary.test.ts：src 里引用 SDK 的只有 claude-code/child/ 和
// 这个文件，这个文件里没有 import）。
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { t } from "@ergo/protocol";

/** SDK 的包名 */
export const CLAUDE_SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

/** 组件区里装 SDK 的那个组件（组件清单里 claude-code 的 target 是 components/claude-code） */
export const CLAUDE_SDK_COMPONENT = "claude-code";

/** 二狗程序目录（仓库的检出目录，或者装好的版本目录里的 app）：开发时在这里装 SDK */
const PROGRAM_DIR = path.resolve(fileURLToPath(new URL("../../../../", import.meta.url)));

/** 是不是在仓库里直接跑 .ts（开发）：装好的程序是转好的 .js，没有 npm，SDK 走组件 */
const RUNNING_SOURCES = import.meta.url.endsWith(".ts");

/** 二狗认的 SDK 版本（packages/daemon/package.json 的 optionalDependencies 里写的那一版） */
export function claudeSdkVersion(): string | undefined {
  const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { optionalDependencies?: Record<string, string> };
  return pkg.optionalDependencies?.[CLAUDE_SDK_PACKAGE];
}

/** 组件区里 SDK 那个组件的目录 */
export function claudeSdkComponentDir(componentsDir: string): string {
  return path.join(componentsDir, CLAUDE_SDK_COMPONENT);
}

/** 组件区里 SDK 的入口文件（没装是 undefined）：只在那个组件自己的 node_modules 里找，不往上找 */
export function claudeSdkEntryIn(componentsDir: string): string | undefined {
  const pkgDir = path.join(claudeSdkComponentDir(componentsDir), "node_modules", ...CLAUDE_SDK_PACKAGE.split("/"));
  if (!fs.existsSync(path.join(pkgDir, "package.json"))) return undefined;
  try {
    return createRequire(path.join(claudeSdkComponentDir(componentsDir), "index.js")).resolve(CLAUDE_SDK_PACKAGE);
  } catch {
    return undefined;
  }
}

/** SDK 在不在：程序目录往上的 node_modules，或者组件区（给了的话）；不加载它 */
export function claudeSdkInstalled(componentsDir?: string): boolean {
  try {
    createRequire(import.meta.url).resolve(CLAUDE_SDK_PACKAGE);
    return true;
  } catch {
    return componentsDir !== undefined && claudeSdkEntryIn(componentsDir) !== undefined;
  }
}

/** 没装时给人看的一句：没装什么、怎么装（开发时在程序目录 npm 装；装好的程序在组件里装）；装着是 undefined（插件定义的 missing） */
export function claudeSdkMissing(installed: () => boolean = claudeSdkInstalled, runningSources: boolean = RUNNING_SOURCES): string | undefined {
  if (installed()) return undefined;
  if (!runningSources) return t("claudeCode.plugin.sdkMissingComponent", { package: CLAUDE_SDK_PACKAGE, component: CLAUDE_SDK_COMPONENT });
  const version = claudeSdkVersion();
  const command = `npm install --no-save ${CLAUDE_SDK_PACKAGE}${version ? `@${version}` : ""}`;
  return t("claudeCode.plugin.sdkMissing", { package: CLAUDE_SDK_PACKAGE, dir: PROGRAM_DIR, command });
}
