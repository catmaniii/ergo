// bge-m3 的推理后端：在工作线程里由 worker.ts 加载（不在主线程里引用 transformers.js）。
// 只读模型区里的本地文件，不联网、不写缓存；CPU 推理，CLS 池化加归一化（bge-m3 稠密向量的用法）。
import { env, pipeline } from "@huggingface/transformers";

export interface BgeM3BackendOptions {
  /** 模型区（transformers.js 的本地模型目录：<模型区>/<仓库>/...） */
  modelsDir: string;
  repo: string;
  dtype: "q8";
  threads: number;
}

export async function createEmbedFunction(options: BgeM3BackendOptions): Promise<(texts: string[]) => Promise<Float32Array[]>> {
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
