// 守护进程这一侧调用"改写会话文件"（彻底删除，21 号票）：拉起一次性子进程 agent-child/rewrite-main.ts，
// stdin 送一行请求、stdout 读一行结果，等它退出。会话文件的形状只在子进程那一层认（ADR-0004、ADR-0008），这里只转手。
// 子进程和 agent 子进程一样放进 Job 对象、只给显式的环境；超时就结束它。
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionRewriteRequest, SessionRewriteResult } from "./host-protocol.ts";
import { encodeLine, readJsonLines, readLines } from "./line-channel.ts";

const ownExt = path.extname(fileURLToPath(import.meta.url));
const REWRITE_ENTRY = fileURLToPath(new URL(`./agent-child/rewrite-main${ownExt}`, import.meta.url));

/** 改写最多等这么久（会话文件再大也就几十 MB） */
const REWRITE_TIMEOUT_MS = 60_000;

export interface RunSessionRewriteOptions {
  /** 子进程的完整环境变量（显式给出，不继承守护进程的环境） */
  env: Record<string, string>;
  job?: { assign(pid: number): void };
  onLog?: (line: string) => void;
  timeoutMs?: number;
}

/** 改写一个会话目录里的会话文件；子进程出错、超时都抛错 */
export function runSessionRewrite(request: SessionRewriteRequest, options: RunSessionRewriteOptions): Promise<SessionRewriteResult> {
  const child = spawn(process.execPath, [REWRITE_ENTRY], { env: options.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const log = options.onLog ?? (() => {});
  return new Promise<SessionRewriteResult>((resolve, reject) => {
    let reply: { ok: true; result: SessionRewriteResult } | { ok: false; error: string } | undefined;
    const timer = setTimeout(() => {
      log("改写会话文件超时，结束子进程");
      child.kill();
    }, options.timeoutMs ?? REWRITE_TIMEOUT_MS);
    child.on("error", (err) => log(`改写会话文件的子进程出错：${err.message}`));
    child.once("close", (code) => {
      clearTimeout(timer);
      if (reply?.ok) resolve(reply.result);
      else reject(new Error(reply && !reply.ok ? reply.error : `改写会话文件的子进程退出了（code ${code}），没有结果`));
    });
    if (child.pid === undefined) return;
    try {
      options.job?.assign(child.pid);
    } catch (err) {
      child.kill();
      log(`改写会话文件的子进程放不进 Job 对象：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    readJsonLines<NonNullable<typeof reply>>(child.stdout, (line) => (reply ??= line), { onInvalid: (line) => log(`无法解析的子进程输出：${line}`) });
    readLines(child.stderr, log);
    child.stdin.on("error", () => {});
    child.stdin.end(encodeLine(request));
  });
}
