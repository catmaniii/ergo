// 模型 key：由 LSM 从数据目录的密钥区注入守护进程的环境（条目里写 env.from: file），
// 守护进程从环境里取，再经 stdin 的"启动"命令显式交给 agent 子进程（不进子进程的环境变量，见 ADR-0004）。
// 密钥区只由 LSM 读，agent 读不到；仓库里永远没有 key。
// 哪个服务商的 key 在哪个环境变量里，照服务商登记表（model-settings/providers.ts 的 MODEL_PROVIDERS，73 号票：只有这一张表）。
import { MODEL_PROVIDERS } from "../model-settings/providers.ts";

/**
 * Tavily 的 key（70 号票：联网搜索的 tavily 选项）：和模型 key 一样由 LSM 从数据目录的密钥区注入守护进程的环境，
 * 只在守护进程里用（调 Tavily 的接口），不进 agent 子进程和它们的 bash 的环境；代码、配置、仓库里都没有 key
 */
export const TAVILY_KEY_ENV = "TAVILY_API_KEY";

/** 从守护进程的环境里取 Tavily 的 key（没设是 undefined） */
export function tavilyKey(env: Readonly<Record<string, string | undefined>>): string | undefined {
  return env[TAVILY_KEY_ENV]?.trim() || undefined;
}

/** 从守护进程的环境里取出各 provider 的 key（没设的不带） */
export function modelCredentials(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const credentials: Record<string, string> = {};
  for (const provider of MODEL_PROVIDERS) {
    const value = env[provider.keyEnv]?.trim();
    if (value) credentials[provider.id] = value;
  }
  return credentials;
}
