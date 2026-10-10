// 模型服务商的登记表（73 号票）：模型都在服务端（守护进程这台电脑）调用，目前只有 DeepSeek 一项。
// 加一个服务商只改这一张表（id、名字、key 从哪个环境变量取、LSM 从哪个文件注入、默认模型）：守护进程从环境里取 key
// （config/secrets.ts 的 modelCredentials）、设置页、连通测试都照它；这次不实现别家（规格 Out of Scope："别的模型服务商"）。
import type { ModelSettings } from "@ergou/protocol";

export interface ModelProvider {
  /** pi 模型目录里的 provider id，也是配置里模型键「provider/模型 id」的前半 */
  id: string;
  /** 设置页上的名字 */
  label: string;
  /** 守护进程从哪个环境变量取 key（LSM 从 secretFile 注入；config/secrets.ts 的 modelCredentials 照它取） */
  keyEnv: string;
  /** LSM 从数据目录里的哪个文件注入 key（相对数据目录；只由 LSM 读，守护进程不读） */
  secretFile: string;
  /** 设置文件没有时的默认模型 */
  defaultModelId: string;
}

export const MODEL_PROVIDERS: readonly ModelProvider[] = [
  { id: "deepseek", label: "DeepSeek", keyEnv: "DEEPSEEK_API_KEY", secretFile: "secrets/deepseek-api-key.txt", defaultModelId: "deepseek-flash" },
];

export function providerOf(id: string): ModelProvider | undefined {
  return MODEL_PROVIDERS.find((p) => p.id === id);
}

/**
 * 没有设置文件时的设置：DeepSeek V4.1 Flash，思考档位高，各个 agent 都跟随默认——和 73 号票之前写死在代码里的一样
 * （秘书、维护者、评审、子 agent、范围审视都是 deepseek-flash、high）
 */
export const DEFAULT_MODEL_SETTINGS: Readonly<ModelSettings> = Object.freeze<ModelSettings>({
  provider: MODEL_PROVIDERS[0]!.id,
  default: { modelId: MODEL_PROVIDERS[0]!.defaultModelId, thinkingLevel: "high" },
  agents: {},
  vision: {},
});
