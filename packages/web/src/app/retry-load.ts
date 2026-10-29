// 记忆页取数据时多试两次（233 号票的页面 + 235 起的运维动作）：这份数据是只读的、随时可以再取，
// 而守护进程会因为它自己的运维动作停几秒（写整理记录、重启、夜里整理时推理库被占着）。
// 第一次 502 / 连接断掉时别立刻在页面上留一句"读不出来"——1.5 秒、3 秒各再试一次，三次都不行才把原因报上去。
//
// 放在 app/ 而不是 state/：state 层只收纯函数（不给 DOM / Node 的类型，见 tsconfig.state.json），
// 定时器不是纯的。
export interface RetryLoadOptions {
  /** 最多试几次（默认 3：第一次 + 两次重试） */
  attempts?: number;
  /** 第一次重试等多久，之后每次多等这么多（默认 1500 毫秒） */
  delayMs?: number;
}

/** 试几次；都失败时抛最后一次的错误（调用方照原来的方式报原因） */
export async function retryLoad<T>(load: () => Promise<T>, options: RetryLoadOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 3;
  const delayMs = options.delayMs ?? 1500;
  let last: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await load();
    } catch (err) {
      last = err;
      if (i + 1 < attempts) await new Promise<void>((resolve) => setTimeout(resolve, delayMs * (i + 1)));
    }
  }
  throw last;
}
