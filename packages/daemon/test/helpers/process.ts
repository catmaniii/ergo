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

/** 轮询直到 predicate 为真；超时抛错，错误里带上 describe() 的描述 */
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
