// 进程相关的测试辅助：判断进程是否还活着、等条件成立、兜底强杀。
import { type ChildProcess, spawnSync } from "node:child_process";
import { hasGitBash, NO_GIT_BASH } from "./git-bash.ts";

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

/** 等的前 250 毫秒每 10 毫秒查一次（见 waitUntil） */
const FAST_WAIT_WINDOW_MS = 250;
const FAST_WAIT_INTERVAL_MS = 10;

/** 轮询直到 predicate 为真（默认等 10 秒）；超时抛错，错误里带上 describe() 的描述 */
export async function waitUntil(
  predicate: () => boolean,
  options: { timeoutMs?: number; intervalMs?: number; describe?: () => string } = {},
): Promise<void> {
  const { timeoutMs = 10_000, intervalMs = 50 } = options;
  const deadline = Date.now() + timeoutMs;
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() > deadline) {
      // 238 号票：这台机器上没有 Git Bash 时，一批依赖 bash 的用例会一路等到超时。超时本身说不清原因，
      // 看起来像产品坏了；在这里补一句，省得对着"等待超时"猜
      const hint = hasGitBash ? "" : `\n${NO_GIT_BASH}`;
      throw new Error(`等待超时${options.describe ? `：${options.describe()}` : ""}${hint}`);
    }
    // 245 号票：前 250 毫秒查得勤一点。子进程起来、事件落盘通常只要几十到几百毫秒，一上来就按 50 毫秒的间隔查，
    // 每条等待都会多等十几毫秒；一条用例里要等好几处，几百条用例加起来就是几十秒。超过 250 毫秒的等待（真的在等
    // 子进程干活）回到 intervalMs，免得轮询把 CPU 吃掉
    await new Promise((resolve) => setTimeout(resolve, Date.now() - started < FAST_WAIT_WINDOW_MS ? FAST_WAIT_INTERVAL_MS : intervalMs));
  }
}

/**
 * 兜底：强杀一个进程（连同它的子进程树）。测试失败时清理残留用，进程已不在则什么也不做。
 * 只对还没确认结束的进程用：pid 被复用以后 taskkill /T 会把别的测试正在用的进程树（agent 子进程、bash……）一起杀掉
 * （92 号票查到的 child-env 偶发失败）。自己拉起的子进程用 killIfRunning
 */
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

/**
 * 测试自己拉起的子进程还没退出就连同它的子进程树强杀（测试结束时的兜底）。
 * 看的是 ChildProcess 自己的退出状态而不是 pid：还没报退出时 node 握着它的进程句柄，pid 不会被复用；
 * 报了退出以后 pid 随时可能分给别的进程（满负载时几秒内就会），再按 pid 杀就会误杀别的测试的进程
 */
export function killIfRunning(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  forceKill(child.pid);
}
