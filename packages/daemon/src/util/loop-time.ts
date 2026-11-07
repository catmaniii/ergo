// 只数事件循环真给了的时间的限时（437）：体检里探端口、探 /health、每项的超时，语音合成预热探活的 /health 都用它，
// 不用墙上的时间直接算。等的是本机上很快就该回来的东西时用它；等远处、等慢活（模型、下载）照旧用墙上的时间。
//
// 为什么：守护进程的事件循环会被同步的活卡住——2026-11-08 真机上点一次体检，同时取的 /healthz 等了 1.9 秒（各项检查里同步读文件、
// 跑子进程的那些一起压上来）；刚启动的头几十秒更忙。卡住的这段里连接其实早就连上、回应早就到了，只是还没轮到处理；
// 等事件循环缓过来，定时器那一段排在收 I/O 之前，setTimeout 的 500 毫秒、AbortSignal.timeout 的 1.5 秒先到点——
// 于是"本机端口 8810：没人在听"（可 curl 次次 200）、"连不上 127.0.0.1:8090（1.5 秒没回应）"（/health 1 毫秒就回）。
//
// 做法：每 tickMs 看一眼墙上的时间，一眼最多算 2 个 tickMs——事件循环被卡住的那一大段只算一小下；到点了也不马上判，
// 先让这一轮把已经到了的 I/O 收完（setImmediate 排在收 I/O 之后），还没回来才算超时。
// 事件循环一直被卡着时也得有个头：墙上的时间过了限时的 LOOP_HARD_FACTOR 倍照样到点。

/** 多久看一眼（毫秒）；限时比它短的按限时看 */
export const LOOP_TICK_MS = 100;

/** 墙上的时间过了限时的这么多倍，不管事件循环给没给够都算到点 */
export const LOOP_HARD_FACTOR = 4;

/**
 * 事件循环给够了 ms 毫秒（被卡住的那段只算一小下）还没取消，就叫 onTimeout（一次）。返回取消函数（叫过了、叫多次都不要紧）
 */
export function afterLoopTime(ms: number, onTimeout: () => void, tickMs = LOOP_TICK_MS): () => void {
  const tick = Math.max(1, Math.min(tickMs, ms));
  const started = Date.now();
  let last = started;
  let spent = 0;
  let pending: NodeJS.Immediate | undefined;
  const timer = setInterval(() => {
    const now = Date.now();
    // 墙上的时间往回拨了算 0；卡了一大段只算两下
    spent += Math.min(Math.max(now - last, 0), tick * 2);
    last = now;
    if (spent < ms && now - started < ms * LOOP_HARD_FACTOR) return;
    clearInterval(timer);
    // 先让这一轮收完已经到了的 I/O（连上了、回应到了的在这之前处理），再算超时
    pending = setImmediate(onTimeout);
  }, tick);
  return () => {
    clearInterval(timer);
    if (pending !== undefined) clearImmediate(pending);
  };
}

/** 同上，写成一个中止信号（给 fetch 用）：到点置位；clear 取消 */
export function loopTimeoutSignal(ms: number, tickMs = LOOP_TICK_MS): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const clear = afterLoopTime(ms, () => controller.abort(new DOMException(`${ms} ms`, "TimeoutError")), tickMs);
  return { signal: controller.signal, clear };
}
