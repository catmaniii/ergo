// 正式运行的向量模型：量化版 bge-m3（规格第 15 节；记忆子地图「素材管理」Q6：用 CPU，不用显卡，数据不出本机）。
// - ONNX 模型来自 Hugging Face 的 Xenova/bge-m3（transformers.js 用的转换版），锁定版本，用 q8 量化（onnx/model_quantized.onnx，约 570 MB）；
// - 文件放在数据目录的模型区：<模型区>/Xenova/bge-m3/...（transformers.js 的本地模型目录结构）；
// - 不在时守护进程提示用户运行下载命令（npm run download-model），素材和关键词索引照常；就位后补算；
// - 推理在工作线程里（worker-host.ts + bge-m3-backend.ts），CLS 池化加归一化，1024 维。
import os from "node:os";
import path from "node:path";
import type { Embedder } from "./embedder.ts";
import { modelFilesPresent, type ModelFile } from "./model-files.ts";
import { createWorkerEmbedder } from "./worker-host.ts";

export const BGE_M3 = {
  repo: "Xenova/bge-m3",
  /** 锁定的版本（Hugging Face 上这个仓库的提交号） */
  revision: "4de13258303883538bd53b696b452bf8099f0858",
  dtype: "q8",
  /** transformers.js 加载 q8 的 feature-extraction 要的文件（2026-10-08 按仓库清单核对过大小和哈希） */
  files: [
    { path: "config.json", size: 770 },
    { path: "tokenizer_config.json", size: 1173 },
    { path: "tokenizer.json", size: 17082821, sha256: "6710678b12670bc442b99edc952c4d996ae309a7020c1fa0096dd245c2faf790" },
    { path: "onnx/model_quantized.onnx", size: 569694530, sha256: "0826f8c1ab9edf1801db86c61919d4d108e8bfc0b809ec823ad366882ff0b77d" },
  ] satisfies ModelFile[] as readonly ModelFile[],
} as const;

/** 记在每条向量旁边的模型名：仓库、量化方式、版本（任何一样变了都整批重算） */
export const BGE_M3_MODEL_NAME = `${BGE_M3.repo}:${BGE_M3.dtype}@${BGE_M3.revision.slice(0, 8)}`;

/** 模型文件所在的目录 */
export function bgeM3Dir(modelsDir: string): string {
  return path.join(modelsDir, ...BGE_M3.repo.split("/"));
}

export function bgeM3Present(modelsDir: string): boolean {
  return modelFilesPresent(bgeM3Dir(modelsDir), BGE_M3.files);
}

/** 下载命令（在二狗的仓库目录运行） */
export function downloadCommand(dataDir: string): string {
  return `npm run download-model -- --data-dir "${dataDir}"`;
}

/** 推理用几个线程：本机核数的四分之一，最多 4 个，不跟别的程序抢 CPU */
function inferenceThreads(): number {
  return Math.max(1, Math.min(4, Math.floor(os.availableParallelism() / 4)));
}

export function createBgeM3Embedder(options: { modelsDir: string; dataDir: string }): Embedder {
  return createWorkerEmbedder({
    model: BGE_M3_MODEL_NAME,
    backend: new URL("./bge-m3-backend.ts", import.meta.url),
    backendOptions: { modelsDir: options.modelsDir, repo: BGE_M3.repo, dtype: BGE_M3.dtype, threads: inferenceThreads() },
    available: () => bgeM3Present(options.modelsDir),
    unavailableHint: () =>
      `bge-m3 的模型文件要放在 ${bgeM3Dir(options.modelsDir)}。在二狗的仓库目录运行：${downloadCommand(options.dataDir)}（约 570 MB；` +
      `连不上 Hugging Face 时可以先设环境变量 HF_ENDPOINT 指向镜像）。下载完不用重启，守护进程几分钟内自己补算向量。`,
  });
}
