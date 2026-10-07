// 进程相关的测试辅助：判断进程是否还活着、等条件成立、兜底强杀。
import { spawnSync } from "node:child_process";

/** pid 对应的进程是否还活着（Windows 上已结束、只剩句柄的进程算不活着） */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * 等秘书拉起来（加上它回第一轮）的等待：整套测试并行跑、机器忙的时候，子进程起来要十几秒（单跑一条只要一两秒）。
 * 只用在等秘书启动的那一处；同一个用例里几次等待加起来超过用例超时（30 秒）的，用例自己写明更长的超时，
 * 真超时时报的是 waitUntil 的说明，而不是笼统的"用例超时"
 */
export const SECRETARY_START_TIMEOUT_MS = 20_000;

/** 轮询直到 predicate 为真（默认等 10 秒）；超时抛错，错误里带上 describe() 的描述 */
export async function waitUntil(
  predicate: () => boolean,
  options: { timeoutMs?: number; intervalMs?: number; describe?: () => string } = {},
): Promise<void> {
  const { timeoutMs = 10_000, intervalMs = 50 } = options;
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`等待超时${options.describe ? `：${options.describe()}` : ""}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** 兜底：强杀一个进程（连同它的子进程树）。测试失败时清理残留用，进程已不在则什么也不做。 */
export function forceKill(pid: number): void {
  if (!isProcessAlive(pid)) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 已经不在了
    }
  }
}
