// 向量函数的接口：素材模块只认它。正式运行是守护进程里用 CPU 跑的量化版 bge-m3（bge-m3.ts，在工作线程里算）；
// 测试注入一个假的（test/helpers/embedder.ts），不下载、不跑真模型。
export interface Embedder {
  /** 模型名：记在每条向量旁边；换了模型（名字变了）就整批重算 */
  readonly model: string;
  /** 模型文件在不在。不在时不算向量（素材入库和关键词索引照常），就位后补算 */
  available(): boolean;
  /** 模型不在时给用户的提示：在哪、运行哪条命令下载 */
  unavailableHint(): string;
  /** 算一批文字的向量（顺序和输入一致） */
  embed(texts: readonly string[]): Promise<Float32Array[]>;
  /** 释放资源（结束工作线程） */
  close(): Promise<void>;
}

/** 模型文件不在时检索向量抛这个 */
export class EmbeddingUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingUnavailable";
  }
}
