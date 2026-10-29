// 真向量：transformers.js 跑本地 ONNX 模型，照守护进程 materials/embedding/ 的做法——
// 只读模型目录里的本地文件，不联网、不写缓存，CPU 推理，线程数取本机核数的四分之一（最多 4 个）。
// 和守护进程不同的是：在当前线程里加载（PoC 是命令行脚本，不用顾着事件循环），第一次要算时才 import transformers.js，
// 测试里不会加载它。模型目录：参数 > ERGO_MODELS_DIR > ERGO_DATA_DIR/models > ~/.ergo/models（同守护进程的模型区，
// 用户已经 npm run download-model 下过 bge-m3 就能直接用）。312 号票起两个环境变量的旧名字也认（新的优先），~/.ergo 不在而旧的目录在时用旧的。
// 池化方式、查询和文档的前缀是配置（TransformersModelSpec）：现在只有 bge-m3（两种角色一样、CLS 池化）；
// 以后换 Qwen3-Embedding 这类只要加一份配置（末位池化、查询带指令前缀），不下载别的模型。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { envValue, pathOrOld } from "../old-names.ts";
import type { Embedder, EmbedRole } from "./embedder.ts";

export interface ModelFile {
  /** 相对模型目录的路径（用 / 分隔） */
  path: string;
  size: number;
}

export interface TransformersModelSpec {
  /** Hugging Face 上的仓库名，也是模型目录下的子目录 */
  repo: string;
  /** 锁定的版本（提交号） */
  revision: string;
  dtype: "fp32" | "fp16" | "q8" | "q4";
  /** 加载要的文件（大小对得上才算在） */
  files: readonly ModelFile[];
  pooling: "cls" | "mean" | "last_token" | "eos" | "first_token";
  normalize: boolean;
  /** 查询前面加的指令（bge-m3 不加） */
  queryPrefix: string;
  /** 文档前面加的（一般不加） */
  documentPrefix: string;
  /** 记在每条向量旁边的模型名；不给 = 仓库:量化@版本前 8 位/池化 */
  model?: string;
}

/** 正式用的 bge-m3 q8（同守护进程 materials/embedding/bge-m3.ts 的锁定版本和文件清单；模型名也一样，以后接素材库的向量能对上） */
export const BGE_M3: TransformersModelSpec & { model: string } = {
  repo: "Xenova/bge-m3",
  revision: "4de13258303883538bd53b696b452bf8099f0858",
  dtype: "q8",
  files: [
    { path: "config.json", size: 770 },
    { path: "tokenizer_config.json", size: 1173 },
    { path: "tokenizer.json", size: 17082821 },
    { path: "onnx/model_quantized.onnx", size: 569694530 },
  ],
  pooling: "cls",
  normalize: true,
  queryPrefix: "",
  documentPrefix: "",
  model: "Xenova/bge-m3:q8@4de13258",
};

/** 模型目录：参数 > ERGO_MODELS_DIR > ERGO_DATA_DIR/models > ~/.ergo/models（312 号票：变量的旧名字、~/.ergo 不在时旧的目录也认） */
export function resolveModelsDir(dir?: string, env: Record<string, string | undefined> = process.env, homeDir: string = os.homedir()): string {
  if (dir) return path.resolve(dir);
  const models = envValue(env, "ERGO_MODELS_DIR");
  if (models) return path.resolve(models);
  const data = envValue(env, "ERGO_DATA_DIR");
  if (data) return path.resolve(data, "models");
  return path.join(pathOrOld(path.join(homeDir, ".ergo")), "models");
}

export interface TransformersEmbedderOptions {
  spec: TransformersModelSpec;
  /** 不给按 resolveModelsDir 的顺序找 */
  modelsDir?: string;
  /** 推理线程数；不给 = 本机核数的四分之一，最多 4 个 */
  threads?: number;
}

type ExtractFn = (texts: string[]) => Promise<Float32Array[]>;

export class TransformersEmbedder implements Embedder {
  readonly model: string;
  private readonly spec: TransformersModelSpec;
  private readonly modelsDir: string;
  private readonly threads: number;
  private loading: Promise<ExtractFn> | undefined;
  private dispose: (() => Promise<void>) | undefined;

  constructor(options: TransformersEmbedderOptions) {
    this.spec = options.spec;
    this.modelsDir = resolveModelsDir(options.modelsDir);
    this.threads = options.threads ?? Math.max(1, Math.min(4, Math.floor(os.availableParallelism() / 4)));
    this.model = options.spec.model ?? `${options.spec.repo}:${options.spec.dtype}@${options.spec.revision.slice(0, 8)}/${options.spec.pooling}`;
  }

  /** 这个模型的文件所在的目录 */
  get modelDir(): string {
    return path.join(this.modelsDir, ...this.spec.repo.split("/"));
  }

  available(): boolean {
    return this.spec.files.every((file) => {
      try {
        return fs.statSync(path.join(this.modelDir, ...file.path.split("/"))).size === file.size;
      } catch {
        return false;
      }
    });
  }

  unavailableHint(): string {
    return `向量模型 ${this.spec.repo} 不在 ${this.modelDir}；bge-m3 可以在二狗仓库里运行 npm run download-model 下载到 ~/.ergo/models，或者用 ERGO_MODELS_DIR 指到已有的模型目录`;
  }

  /** 按角色加前缀（实际送进模型的文字） */
  prepare(role: EmbedRole, texts: readonly string[]): string[] {
    const prefix = role === "query" ? this.spec.queryPrefix : this.spec.documentPrefix;
    return texts.map((t) => prefix + t);
  }

  embedDocuments(texts: readonly string[]): Promise<Float32Array[]> {
    return this.run(this.prepare("document", texts));
  }

  embedQueries(texts: readonly string[]): Promise<Float32Array[]> {
    return this.run(this.prepare("query", texts));
  }

  async close(): Promise<void> {
    const dispose = this.dispose;
    this.loading = undefined;
    this.dispose = undefined;
    await dispose?.();
  }

  private async run(texts: string[]): Promise<Float32Array[]> {
    if (!this.available()) throw new Error(this.unavailableHint());
    if (texts.length === 0) return [];
    this.loading ??= this.load();
    const extract = await this.loading;
    return extract(texts);
  }

  private async load(): Promise<ExtractFn> {
    const { env, pipeline } = await import("@huggingface/transformers");
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = this.modelsDir;
    env.useFSCache = false;
    const extractor = await pipeline("feature-extraction", this.spec.repo, {
      dtype: this.spec.dtype,
      device: "cpu",
      local_files_only: true,
      session_options: { intraOpNumThreads: this.threads, interOpNumThreads: 1 },
    });
    this.dispose = () => extractor.dispose();
    return async (texts) => {
      const output = await extractor(texts, { pooling: this.spec.pooling, normalize: this.spec.normalize });
      const [rows, dims] = output.dims as [number, number];
      const data = output.data as Float32Array;
      return Array.from({ length: rows }, (_, i) => data.slice(i * dims, (i + 1) * dims));
    };
  }
}

/** 模型目录里的 bge-m3 */
export function createBgeM3Embedder(options: Omit<TransformersEmbedderOptions, "spec"> = {}): TransformersEmbedder {
  return new TransformersEmbedder({ ...options, spec: BGE_M3 });
}
