// 模型 key：由 LSM 从数据目录的密钥区注入守护进程的环境（条目里写 env.from: file），
// 守护进程从环境里取，再经 stdin 的"启动"命令显式交给 agent 子进程（不进子进程的环境变量，见 ADR-0004）。
// 密钥区只由 LSM 读，agent 读不到；仓库里永远没有 key。
// 319 号票：网页上也能填（设置 · 模型、首次设置向导），守护进程把 key 写进密钥区的同一个文件（这个写入是从网页发起的一次显式操作），
// 同时换进内存里的那一份，下一次模型调用就用新的——启动时注入的环境变量还是 LSM 那一份，子进程照旧经 stdin 拿 key。
// 哪个服务商的 key 在哪个环境变量里，照服务商登记表（model-settings/providers.ts 的 MODEL_PROVIDERS）：DeepSeek 是 DEEPSEEK_API_KEY，
// 自定义（OpenAI 兼容）服务商是 CUSTOM_MODEL_API_KEY（都按表里的 secretFile 由 LSM 注入，网页上填的写进同一个文件）。
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

/**
 * DeepSeek 的联网搜索、读网页接口（154 号票）用的 key：和模型共用同一份（服务商登记表里 deepseek 的 keyEnv，LSM 从密钥区注入），
 * 只在守护进程里用（代为执行联网工具），每次现取；没设是 undefined
 */
export function deepseekKey(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const provider = MODEL_PROVIDERS.find((p) => p.id === "deepseek");
  return (provider && env[provider.keyEnv]?.trim()) || undefined;
}

/**
 * 从守护进程的环境里取出各 provider 的 key（没设的不带）：键是服务商登记表里的 id——DeepSeek 收在 deepseek 名下，
 * 自定义（OpenAI 兼容）服务商的 CUSTOM_MODEL_API_KEY 收在 custom 名下（和 pi 里注册的 provider id 对齐）
 */
export function modelCredentials(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const credentials: Record<string, string> = {};
  for (const provider of MODEL_PROVIDERS) {
    const value = env[provider.keyEnv]?.trim();
    if (value) credentials[provider.id] = value;
  }
  return credentials;
}
