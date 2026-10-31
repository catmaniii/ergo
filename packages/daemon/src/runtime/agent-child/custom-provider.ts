// 自定义（OpenAI 兼容）服务商在子进程里的登记（自定义服务商这一步）：pi 的模型目录里没有它，不登记的话
// getModel("custom", 模型 id) 一律是 undefined（会话起不来、连通测试回"模型目录里没有"）。登记之后 pi 按普通 provider 那样
// 把请求发到 baseUrl 下面（openai-completions 是 POST {baseUrl}/chat/completions），key 由 setRuntimeApiKey 放进内存凭据。
//
// 这里登记的模型元数据用户填不了（pi 的 ProviderConfigInput 要求 contextWindow / maxTokens / cost 这些），都按下面的估算：
// 上下文窗口和一次最多几个 token 用 pi 常见的默认数，单价记 0（不知道就按 0 算，消耗页上这种模型的成本是粗估的）。
// 思考按不支持登记（reasoning: false）：不知道那家服务商认不认 OpenAI 的思考参数，塞过去可能整个请求 400。
import type { ModelRuntime, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { CUSTOM_PROVIDER_ID, DEFAULT_CUSTOM_PROVIDER_API, type ModelCustomProvider } from "@ergo/protocol";

/** 用户没填、我们也问不到上下文窗口时按这个估算（128k，够大多数 OpenAI 兼容的服务） */
export const CUSTOM_MODEL_CONTEXT_WINDOW = 128_000;

/** 一次最多生成这么多 token 的估算（8192） */
export const CUSTOM_MODEL_MAX_TOKENS = 8192;

/** 自定义服务商在 pi 里的登记内容（模型就一个：用户填的那个 id） */
export function customProviderConfig(custom: ModelCustomProvider): ProviderConfig {
  const api = custom.api ?? DEFAULT_CUSTOM_PROVIDER_API;
  const baseUrl = custom.baseUrl.replace(/\/+$/, "");
  return {
    name: CUSTOM_PROVIDER_ID,
    baseUrl,
    api,
    models: [
      {
        id: custom.modelId,
        name: custom.modelId,
        api,
        baseUrl,
        // 只看文字：不知道那家服务商收不收图片（图片要 base64，各有各的限制）
        input: ["text"],
        // 单价不知道：按 0 记（账本照实际用量记，成本是粗估）
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        reasoning: false,
        contextWindow: CUSTOM_MODEL_CONTEXT_WINDOW,
        maxTokens: CUSTOM_MODEL_MAX_TOKENS,
      },
    ],
  };
}

/**
 * 装配里带了自定义服务商就登记它（registerProvider），返回登记了没有。要在 setRuntimeApiKey 之前调：
 * 登记之后 getModel(CUSTOM_PROVIDER_ID, …) 才认得，key 由随后的 setRuntimeApiKey 放进去
 */
export function registerCustomProvider(modelRuntime: ModelRuntime, custom: ModelCustomProvider | undefined): boolean {
  if (custom === undefined) return false;
  modelRuntime.registerProvider(CUSTOM_PROVIDER_ID, customProviderConfig(custom));
  return true;
}
