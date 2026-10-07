// 算向量的工作线程两边共用的类型（只有类型，工作线程和推理后端都能引用，不带进别的代码）。

/** 一批文字 → 一批向量（顺序和输入一致） */
export type EmbedFunction = (texts: string[]) => Promise<Float32Array[]>;

/** 推理后端模块（工作线程按 URL 加载）：导出 createEmbedFunction，模型在里面加载一次 */
export interface EmbedBackend<Options> {
  createEmbedFunction(options: Options): Promise<EmbedFunction>;
}

/** 拉起工作线程时交给它的数据 */
export interface WorkerData<Options> {
  /** 推理后端模块的 URL */
  backend: string;
  options: Options;
}

/** 主线程 → 工作线程：算一批 */
export interface EmbedRequest {
  id: number;
  texts: string[];
}

/** 工作线程 → 主线程：算出来的向量，或者出错（fatal：模型没加载起来，这个线程不能再用） */
export type EmbedResponse = { id: number; vectors: Float32Array[] } | { id: number; error: string; fatal?: boolean };

/** bge-m3 推理后端（bge-m3-backend.ts）的参数 */
export interface BgeM3BackendOptions {
  /** 模型区（transformers.js 的本地模型目录：<模型区>/<仓库>/...） */
  modelsDir: string;
  repo: string;
  dtype: "q8";
  /** 推理用几个线程 */
  threads: number;
}
