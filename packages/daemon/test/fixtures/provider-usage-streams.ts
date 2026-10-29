// 真实 provider（OpenAI 兼容的 chat completions，流式）的响应样本，给 pi 契约测试锁住用量字段的换算（24 号票）。
// 不联网：契约测试在本机起一个只回放这些样本的服务，子进程里的 pi 把请求发到那里（CatalogModelSpec.baseUrl）。
// - DEEPSEEK_STREAM：按 DeepSeek 官方文档的流式响应格式写的（最后一个分片带 usage：prompt_cache_hit_tokens /
//   prompt_cache_miss_tokens，同时有 OpenAI 写法的 prompt_tokens_details.cached_tokens）；
// - OPENROUTER_STREAM：OpenAI 写法加 OpenRouter 兼容服务报的 cache_write_tokens（这次写进缓存的，也是没命中的输入）。
// 每个样本带着它在账本里应当换成的数（命中、未命中、输出），由响应里 provider 自己报的字段直接得出，不经 pi 算。

const chunk = (body: Record<string, unknown>) => `data: ${JSON.stringify({ id: "chatcmpl-sample", object: "chat.completion.chunk", created: 1_760_000_000, model: "deepseek-flash", ...body })}\n\n`;

function stream(text: string, usage: Record<string, unknown>): string {
  return [
    chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }),
    chunk({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }),
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage }),
    "data: [DONE]\n\n",
  ].join("");
}

export interface ProviderUsageSample {
  name: string;
  /** SSE 响应体 */
  body: string;
  text: string;
  /** 账本里应当记成的：命中 = provider 报的缓存命中；未命中 = 输入总数减命中（含这次写进缓存的）；输出 */
  ledger: { cacheHit: number; cacheMiss: number; output: number };
}

export const DEEPSEEK_STREAM: ProviderUsageSample = {
  name: "DeepSeek",
  text: "好的，看过了。",
  body: stream("好的，看过了。", {
    prompt_tokens: 1500,
    completion_tokens: 42,
    total_tokens: 1542,
    prompt_tokens_details: { cached_tokens: 1280 },
    prompt_cache_hit_tokens: 1280,
    prompt_cache_miss_tokens: 220,
  }),
  ledger: { cacheHit: 1280, cacheMiss: 220, output: 42 },
};

export const OPENROUTER_STREAM: ProviderUsageSample = {
  name: "OpenRouter 兼容（报 cache_write_tokens）",
  text: "收到。",
  body: stream("收到。", {
    prompt_tokens: 1000,
    completion_tokens: 30,
    total_tokens: 1030,
    prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 150 },
  }),
  ledger: { cacheHit: 600, cacheMiss: 400, output: 30 },
};
