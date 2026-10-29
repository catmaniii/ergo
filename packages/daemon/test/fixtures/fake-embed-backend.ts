// 假的向量后端：在工作线程里由 worker.ts 加载（Node 直接跑，不经 vitest），测工作线程这条路本身。
// 向量是 [字数, 第一个字的码点]；busyMs 让每次计算占住 CPU 一段时间（测"不阻塞主线程"）；failLoad 测模型加载失败。
export async function createEmbedFunction(options: { busyMs?: number; failLoad?: string }): Promise<(texts: string[]) => Promise<Float32Array[]>> {
  if (options.failLoad !== undefined) throw new Error(options.failLoad);
  return async (texts) => {
    const until = Date.now() + (options.busyMs ?? 0);
    // 故意空转：模拟模型推理占满 CPU
    while (Date.now() < until) {
      // busy
    }
    return texts.map((t) => Float32Array.from([Array.from(t).length, t.codePointAt(0) ?? 0]));
  };
}
