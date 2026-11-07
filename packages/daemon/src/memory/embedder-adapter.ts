// 内核的向量函数 → @ergo/memory 的向量函数：素材库的 Embedder 只有 embed(texts)（bge-m3，工作线程里算），
// @ergo/memory 的 Embedder 要分开 embedDocuments / embedQueries（调研 22：以后可能换查询要加指令前缀的模型）。
// bge-m3 两种角色一样，两个方法都直接走 embed；模型名、可用状态、不在时的提示照搬。
// 不下载模型、不打包模型：模型是内核的（kernel 的 createBgeM3Embedder），这里只是转接。
//
// 秘书那一侧（ask_memory、每条消息的记忆简报）共用一份 secretaryEmbedder（427）：
// - 查询向量记住最近几句（queryMemoEmbedder）：一份简报里检索、往上走的起点、结论索引、两道向量门槛都要算同一句话的查询向量，
//   不记住就是同一句话交给 bge-m3 算四到六遍（一遍几十到几百毫秒，话越长越慢）；
// - 同一个内核向量函数只有这一份（按内核的那个记住）：简报和 ask_memory 两份引擎用的是同一个实例，
//   相关门槛的背景语料向量（@ergo/memory 按向量函数实例缓存）只算一次、起来时预热的就是简报真用的那一份；
// - 模型冷启动：工作线程闲置十分钟会卸掉模型，再加载要好几秒。ready / warm 看模型加载好没有、先拉起来；
//   withoutVectors 让一次调用（只在它自己的异步调用链里）当向量模型不在、只走关键词——简报等不起模型时用，不影响同时在跑的别的查询。
import { AsyncLocalStorage } from "node:async_hooks";
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

/**
 * 查询向量记住最近几句（一份简报里几处检索、相关门槛都要算同一句话的查询向量，bge-m3 每次几十到几百毫秒）：
 * 同一句话只算一次。文档向量照常算。向量是确定的，记住不影响结果
 */
export function queryMemoEmbedder(inner: MemoryLabEmbedder, size = 16): MemoryLabEmbedder {
  const memo = new Map<string, Promise<Float32Array>>();
  return {
    model: inner.model,
    available: () => inner.available(),
    unavailableHint: () => inner.unavailableHint(),
    embedDocuments: (texts) => inner.embedDocuments(texts),
    embedQueries(texts) {
      // 记的是"算出来的那个承诺"：同一句话同时来两处（两条消息一起算）也只交给模型一次；算失败的不留
      const missing = [...new Set(texts.filter((t) => !memo.has(t)))];
      if (missing.length > 0) {
        const computed = inner.embedQueries(missing);
        missing.forEach((t, i) => {
          const one = computed.then((vectors) => vectors[i]!);
          memo.set(t, one);
          one.catch(() => {
            if (memo.get(t) === one) memo.delete(t);
          });
        });
        while (memo.size > size) memo.delete(memo.keys().next().value!);
      }
      return Promise.all(texts.map((t) => memo.get(t) ?? inner.embedQueries([t]).then((vectors) => vectors[0]!)));
    },
    close: () => inner.close(),
  };
}

/** 模型这会儿什么情况：warm 是本来就好了（或者用不着加载）；loaded 是这一下等着加载好了；cold 是等到头还没好 */
export type ModelReadiness = "warm" | "loaded" | "cold";

/** 秘书那一侧共用的一份向量函数（见文件开头） */
export interface SecretaryEmbedder extends MemoryLabEmbedder {
  /** 模型这会儿能不能马上算：加载好了、模型文件不在（反正不算向量）、内核的向量函数没有冷启动这回事，都是 true */
  ready(): boolean;
  /** 还没加载好就拉起来加载，最多等 waitMs；回这会儿什么情况。0 就是只拉起来、不等 */
  warm(waitMs: number): Promise<ModelReadiness>;
  /** 在 fn 这条异步调用链里当向量模型不在（只走关键词）；同时在跑的别的调用照常算向量 */
  withoutVectors<T>(fn: () => Promise<T>): Promise<T>;
}

/** 当前这条调用链要不要不算向量（withoutVectors 里是 true） */
const keywordOnly = new AsyncLocalStorage<boolean>();

/** 一个内核向量函数一份：简报和 ask_memory 两份引擎拿到同一个实例 */
const shared = new WeakMap<KernelEmbedder, SecretaryEmbedder>();

/** 秘书那一侧共用的向量函数（见文件开头）；同一个内核向量函数回同一个实例 */
export function secretaryEmbedder(kernel: KernelEmbedder): SecretaryEmbedder {
  const existing = shared.get(kernel);
  if (existing !== undefined) return existing;
  const memo = queryMemoEmbedder(kernelEmbedderAdapter(kernel));
  const ready = () => !kernel.available() || kernel.loaded === undefined || kernel.loaded();
  const made: SecretaryEmbedder = {
    ...memo,
    available: () => kernel.available() && keywordOnly.getStore() !== true,
    ready,
    async warm(waitMs) {
      if (ready()) return "warm";
      const loading = (kernel.warm?.() ?? Promise.resolve()).then(
        () => true,
        () => false,
      );
      if (waitMs <= 0) return "cold";
      let timer: NodeJS.Timeout | undefined;
      const waited = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), waitMs);
        // 只是等着看，不拦着守护进程退出
        timer.unref();
      });
      const done = await Promise.race([loading, waited]);
      clearTimeout(timer);
      return done && ready() ? "loaded" : "cold";
    },
    withoutVectors: (fn) => keywordOnly.run(true, fn),
  };
  shared.set(kernel, made);
  return made;
}
