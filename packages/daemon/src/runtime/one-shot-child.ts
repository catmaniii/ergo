// 守护进程这一侧拉起一次性子进程（agent-child/ 里的入口：改写会话文件 rewrite-main.ts、模型探查 model-probe-main.ts）：
// stdin 送一行请求、stdout 读一行结果（{ ok: true, result } 或 { ok: false, error }），等它退出。
// 子进程和 agent 子进程一样放进 Job 对象、只给显式的环境；超时就结束它。stderr 只是日志。
import { spawn } from "node:child_process";
import { encodeLine, readJsonLines, readLines } from "./line-channel.ts";

export interface RunOneShotOptions {
  /** 子进程的完整环境变量（显式给出，不继承守护进程的环境） */
  env: Record<string, string>;
  job?: { assign(pid: number): void };
  onLog?: (line: string) => void;
  timeoutMs?: number;
}

/**
 * 拉起 entry 这个入口，送一行请求，等一行结果；子进程出错、超时、没有结果都抛错（message 前面是 label）。
 * 超时的写明等了多久："<label>超时（60 秒），结束了子进程"
 */
export function runOneShotChild<T>(entry: string, request: unknown, label: string, defaultTimeoutMs: number, options: RunOneShotOptions): Promise<T> {
  const child = spawn(process.execPath, [entry], { env: options.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const log = options.onLog ?? (() => {});
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  return new Promise<T>((resolve, reject) => {
    let reply: { ok: true; result: T } | { ok: false; error: string } | undefined;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      log(`${label}超时（${timeoutMs / 1000} 秒），结束子进程`);
      child.kill();
    }, timeoutMs);
    child.on("error", (err) => log(`${label}的子进程出错：${err.message}`));
    child.once("close", (code) => {
      clearTimeout(timer);
      if (reply?.ok) resolve(reply.result);
      else if (reply) reject(new Error(reply.error));
      else reject(new Error(timedOut ? `${label}超时（${timeoutMs / 1000} 秒），结束了子进程` : `${label}的子进程退出了（code ${code}），没有结果`));
    });
    if (child.pid === undefined) return;
    try {
      options.job?.assign(child.pid);
    } catch (err) {
      child.kill();
      log(`${label}的子进程放不进 Job 对象：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    readJsonLines<NonNullable<typeof reply>>(child.stdout, (line) => (reply ??= line), { onInvalid: (line) => log(`无法解析的子进程输出：${line}`) });
    readLines(child.stderr, log);
    child.stdin.on("error", () => {});
    child.stdin.end(encodeLine(request));
  });
}
