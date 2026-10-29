// 内核的向量函数 → @ergo/memory 的向量函数（224 号票）：素材库的 Embedder 只有 embed(texts)（bge-m3，工作线程里算），
// @ergo/memory 的 Embedder 要分开 embedDocuments / embedQueries（调研 22：以后可能换查询要加指令前缀的模型）。
// bge-m3 两种角色一样，两个方法都直接走 embed；模型名、可用状态、不在时的提示照搬。
// 不下载模型、不打包模型：模型是内核的（kernel 的 createBgeM3Embedder），这里只是转接。
import type { Embedder as MemoryLabEmbedder } from "@ergo/memory";
import type { Embedder as KernelEmbedder } from "../materials/index.ts";

export interface KernelEmbedderAdapterOptions {
  /**
   * 适配器被关掉时要不要顺手关掉内核的向量函数。默认不关：模型是内核的（素材库的向量索引也在用它同一个），
   * 谁把它拉起来的谁释放；只有确定这个模型只给记忆引擎用时才打开。
   */
  closeKernel?: boolean;
}

/**
 * 把内核的 Embedder 转成 @ergo/memory 的 Embedder。
 * 模型文件不在时 available() 是 false：记忆引擎跳过算向量、照常按关键词检索（indexVectors / Retriever 都先看 available）。
 */
export function kernelEmbedderAdapter(embedder: KernelEmbedder, options: KernelEmbedderAdapterOptions = {}): MemoryLabEmbedder {
  return {
    model: embedder.model,
    available: () => embedder.available(),
    unavailableHint: () => embedder.unavailableHint(),
    // bge-m3 文档和查询同义：两个角色都走内核的 embed
    embedDocuments: (texts) => embedder.embed(texts),
    embedQueries: (texts) => embedder.embed(texts),
    close: () => (options.closeKernel === true ? embedder.close() : Promise.resolve()),
  };
}
