// 模型服务商的登记表（73 号票）：模型都在服务端（守护进程这台电脑）调用。两项：DeepSeek（默认），和一个自定义的 OpenAI 兼容服务商
// （自定义服务商这一步：账号不是 DeepSeek 的人填接口地址、模型 id、key 也能用）。加一个服务商只改这一张表（id、名字、key 从哪个环境变量取、
// LSM 从哪个文件注入、默认模型）：守护进程从环境里取 key（config/secrets.ts 的 modelCredentials）、设置页、连通测试都照它。
// 自定义那一项没有默认模型（defaultModelId 是空串：模型 id 是用户填的，谁都不许拿它当默认用）。
import { CUSTOM_PROVIDER_ID, type ModelSettings, t } from "@ergo/protocol";

export interface ModelProvider {
  /** pi 模型目录里的 provider id，也是配置里模型键「provider/模型 id」的前半；自定义服务商是 CUSTOM_PROVIDER_ID */
  id: string;
  /** 设置页上的名字（按当前语言；写成取值函数，模块顶层不去取句子） */
  readonly label: string;
  /** 守护进程从哪个环境变量取 key（LSM 从 secretFile 注入；config/secrets.ts 的 modelCredentials 照它取） */
  keyEnv: string;
  /** LSM 从数据目录里的哪个文件注入 key（相对数据目录；只由 LSM 读、319 号票起网页上填的 key 也写进这个文件，守护进程不读它） */
  secretFile: string;
  /** 设置文件没有时的默认模型；自定义服务商是空串（模型 id 是用户填的） */
  defaultModelId: string;
}

export const MODEL_PROVIDERS: readonly ModelProvider[] = [
  { id: "deepseek", label: "DeepSeek", keyEnv: "DEEPSEEK_API_KEY", secretFile: "secrets/deepseek-api-key.txt", defaultModelId: "deepseek-flash" },
  {
    id: CUSTOM_PROVIDER_ID,
    get label() {
      return t("modelSettings.provider.custom");
    },
    keyEnv: "CUSTOM_MODEL_API_KEY",
    secretFile: "secrets/custom-model-api-key.txt",
    defaultModelId: "",
  },
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
