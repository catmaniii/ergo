// bge-m3 的推理后端：在工作线程里由 worker.ts 加载（主线程不引用 transformers.js）。
// 只读模型区里的本地文件，不联网、不写缓存；CPU 推理，CLS 池化加归一化（bge-m3 稠密向量的用法）。
import { env, pipeline } from "@huggingface/transformers";
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
    session_options: { intraOpNumThreads: options.threads, interOpNumThreads: 1 },
  });
  return async (texts) => {
    const output = await extractor(texts, { pooling: "cls", normalize: true });
    const [rows, dims] = output.dims as [number, number];
    const data = output.data as Float32Array;
    return Array.from({ length: rows }, (_, i) => data.slice(i * dims, (i + 1) * dims));
  };
}
