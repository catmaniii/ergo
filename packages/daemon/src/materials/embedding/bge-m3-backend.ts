// bge-m3 的推理后端：在工作线程里由 worker.ts 加载（主线程不引用 transformers.js）。
// 只读模型区里的本地文件，不联网、不写缓存；CPU 推理，CLS 池化加归一化（bge-m3 稠密向量的用法）。
// 内存（439，守护进程曾经因为这里占到 8.7 GB）：
// - 一批怎么切见 batching.ts：每条最多 EMBED_MAX_TOKENS 个 token，按 token 数切成注意力中间结果有上限的小批，算完按原顺序交回；
// - 关掉 onnxruntime 的 CPU 内存池（enableCpuMemArena: false）：开着时算过一批长的，池子按那一批的峰值留着、线程闲 10 分钟卸掉之前
//   都不还；关掉后每次算完就还。实测（11-08 那一夜的 49 条证据）：算完留着的从约 2 GB 降到约 0.85 GB，长的那几批慢一倍（十几秒的事），
//   一句查询从约 13 毫秒到约 20 毫秒。
import { env, pipeline, type Tensor } from "@huggingface/transformers";
import { EMBED_MAX_TOKENS, embedInBatches } from "./batching.ts";
import type { BgeM3BackendOptions, EmbedFunction } from "./worker-types.ts";

export async function createEmbedFunction(options: BgeM3BackendOptions): Promise<EmbedFunction> {
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = options.modelsDir;
  env.useFSCache = false;
  const extractor = await pipeline("feature-extraction", options.repo, {
    dtype: options.dtype,
    device: "cpu",
    local_files_only: true,
    session_options: { intraOpNumThreads: options.threads, interOpNumThreads: 1, enableCpuMemArena: false },
  });
  const { tokenizer, model } = extractor;
  /** 这一条截到 EMBED_MAX_TOKENS 后有几个 token（带开头结尾的特殊 token） */
  const count = (text: string) => (tokenizer(text, { truncation: true, max_length: EMBED_MAX_TOKENS, return_tensor: false }).input_ids as number[]).length;
  /** 一小批：截断、补齐到这一批最长的，跑模型，取 CLS 归一化（和 feature-extraction 流水线的 pooling: "cls", normalize: true 一样） */
  const run = async (texts: string[]): Promise<Float32Array[]> => {
    const inputs = tokenizer(texts, { padding: true, truncation: true, max_length: EMBED_MAX_TOKENS });
    const outputs = (await model(inputs)) as { last_hidden_state: Tensor };
    const pooled = outputs.last_hidden_state.slice(null, 0).normalize(2, -1);
    const [rows, dims] = pooled.dims as [number, number];
    const data = pooled.data as Float32Array;
    return Array.from({ length: rows }, (_, i) => data.slice(i * dims, (i + 1) * dims));
  };
  return (texts) => embedInBatches(texts, count, run);
}
