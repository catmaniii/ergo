// 把事件循环卡住（437）：像体检里同步读文件、跑子进程的那些检查，或者刚启动时的守护进程。
// 测"限时只数事件循环给了的时间"（src/util/loop-time.ts）用：连接、回应早就到了、只是还没轮到处理时，不能先判超时。
import http from "node:http";
import type { AddressInfo } from "node:net";

/** 同步地把事件循环卡住这么久（毫秒） */
export function stall(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // 卡着
  }
}

/**
 * 像守护进程的 GET /api/doctor 那样：在一个 HTTP 请求的处理函数里起头（start 同步地发出连接、请求），马上把事件循环卡住 stallMs，
 * 再等它的结果。在请求处理函数里起头时，墙上的定时器排在收 I/O 前面（2026-11-08 真机就是这样："没人在听""1.5 秒没回应"）；
 * 在别处起头不一定，所以这类回归测试都从这里起头。服务只听 127.0.0.1 上系统挑的端口，用完就关
 */
export async function startedInRequest<T>(start: () => Promise<T>, stallMs: number): Promise<T> {
  let pending: Promise<T> | undefined;
  const server = http.createServer((_req, res) => {
    pending = start();
    stall(stallMs);
    void pending.then(
      () => res.end(),
      () => res.end(),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    await res.text();
    return await pending!;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
