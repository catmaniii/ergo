// 按键节流（规格第 5 节"进度事件节流"）：同一个键两次推送之间至少隔 intervalMs。
// 流式增量（每个会话，conversation/stream-hub.ts）和活动状态的进度（每个 agent，activity/activity.ts）共用这一套：
// 调用方自己攒着要推的东西，有新的就 schedule；离上一次推送够久了马上 flush，不够就排一个计时器，到点再 flush 一次
// （推那时攒下的）。flush 返回推没推出去：推了才算一次，下一次要和它隔开。钟可以注入（测试换成假的）。
export interface KeyedThrottle<K> {
  /** 这个键有新东西要推 */
  schedule(key: K): void;
  /** 这个键还没推出去的不推了（撤掉计时器）；上一次推送的时刻留着，下一次照样要和它隔开 */
  cancel(key: K): void;
  /** 撤掉所有计时器，忘掉所有键 */
  close(): void;
}

export interface KeyedThrottleOptions<K> {
  intervalMs: number;
  /** 推一次：返回推没推出去（没有可推的就是 false） */
  flush(key: K): boolean;
  now?: () => number;
}

export function createKeyedThrottle<K>(options: KeyedThrottleOptions<K>): KeyedThrottle<K> {
  const now = options.now ?? Date.now;
  const states = new Map<K, { lastAt: number; timer: NodeJS.Timeout | undefined }>();

  const run = (key: K, state: { lastAt: number; timer: NodeJS.Timeout | undefined }) => {
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
    if (options.flush(key)) state.lastAt = now();
  };

  return {
    schedule(key) {
      let state = states.get(key);
      if (!state) {
        state = { lastAt: Number.NEGATIVE_INFINITY, timer: undefined };
        states.set(key, state);
      }
      const wait = state.lastAt + options.intervalMs - now();
      if (wait <= 0) run(key, state);
      else {
        const pending = state;
        pending.timer ??= setTimeout(() => run(key, pending), wait);
      }
    },
    cancel(key) {
      const state = states.get(key);
      if (state?.timer) clearTimeout(state.timer);
      if (state) state.timer = undefined;
    },
    close() {
      for (const state of states.values()) if (state.timer) clearTimeout(state.timer);
      states.clear();
    },
  };
}
