// 一次模型调用"太久一个字都没回来"的计时（421），不依赖 pi：子进程包 pi 发调用的函数时用它（agent-child/silence.ts），
// 测试换上假的钟直接测它。
// 调用开始就计时；每回来一段内容（正文、思考、工具调用参数的增量、它们的开始和结束）重新计时——正在慢慢输出的不会被砍；
// "开始"不算回了字（有的服务商发请求之前就报它）。到点还没回来一个字就叫 onSilent 一次；调用结束了（stop）不再计。

/** 计时用的钟（测试换成假的） */
export interface SilenceTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const REAL_TIMERS: SilenceTimers = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface SilenceWatch {
  /** 流里来了一个事件（事件的种类：pi 的 start、text_delta、thinking_delta……）：除了开始，都算回了字，重新计时 */
  heard(eventType: string): void;
  /** 这次调用结束了（成了、出错、被中止）：不再计时 */
  stop(): void;
  /** 已经因为太久没回应叫过 onSilent 了 */
  readonly fired: boolean;
}

/** 开始计时：silenceMs 内没听到一个字就叫 onSilent（只叫一次） */
export function watchForSilence(silenceMs: number, onSilent: () => void, timers: SilenceTimers = REAL_TIMERS): SilenceWatch {
  let handle: unknown;
  let done = false;
  let fired = false;
  const arm = () => {
    timers.clearTimeout(handle);
    handle = timers.setTimeout(() => {
      if (done) return;
      done = true;
      fired = true;
      onSilent();
    }, silenceMs);
  };
  arm();
  return {
    heard(eventType) {
      if (done || eventType === "start") return;
      arm();
    },
    stop() {
      done = true;
      timers.clearTimeout(handle);
    },
    get fired() {
      return fired;
    },
  };
}
