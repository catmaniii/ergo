// 子进程里加载 Claude Code 的 Agent SDK（318 号票）：先按 Node 的解析规则找（开发时在仓库的 node_modules）；找不到再到组件区找
// （守护进程给子进程带的 ERGO_COMPONENTS_DIR，<数据目录>\components\claude-code\node_modules：安装包、源码装的 SDK 从 npm 官方下到这里）。
// ESM 不认 NODE_PATH，所以组件区的按文件路径 import。SDK 的 sdk.mjs 只引 Node 自带的模块，它的原生程序包（-win32-x64）和它装在一起、它自己找。
// 两个入口（main.ts、sessions-main.ts）都从这里拿真的 SDK 函数（test/claude-code/boundary.test.ts 检查）。
// @i18n-ignore-file log：出错说明进子进程的日志、给开发者看
import { pathToFileURL } from "node:url";
import { COMPONENTS_DIR_ENV } from "../../process/child-env.ts";
import { claudeSdkEntryIn } from "../sdk-installed.ts";

/** SDK 模块（只要类型） */
export type ClaudeSdk = typeof import("@anthropic-ai/claude-agent-sdk");

export interface LoadSdkDeps {
  /** 按包名加载（正式的是 import 包名；测试换成"找不到"） */
  importPackage?: () => Promise<ClaudeSdk>;
  /** 按文件加载（正式的是 import 文件的 URL） */
  importFile?: (url: string) => Promise<ClaudeSdk>;
}

const isNotFound = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
};

/** 加载 SDK：包名找得到用它；找不到而组件区里有，用组件区的；都没有抛"找不到"的那个错 */
export async function loadClaudeSdk(env: NodeJS.ProcessEnv = process.env, deps: LoadSdkDeps = {}): Promise<ClaudeSdk> {
  const importPackage = deps.importPackage ?? (() => import("@anthropic-ai/claude-agent-sdk"));
  try {
    return await importPackage();
  } catch (err) {
    const componentsDir = env[COMPONENTS_DIR_ENV];
    if (!isNotFound(err) || !componentsDir) throw err;
    const entry = claudeSdkEntryIn(componentsDir);
    if (entry === undefined) throw err;
    const importFile = deps.importFile ?? ((url: string) => import(url) as Promise<ClaudeSdk>);
    return await importFile(pathToFileURL(entry).href);
  }
}
