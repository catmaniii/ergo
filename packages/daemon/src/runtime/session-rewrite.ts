// 守护进程这一侧调用"改写会话文件"（彻底删除，21 号票）：拉起一次性子进程 agent-child/rewrite-main.ts，
// stdin 送一行请求、stdout 读一行结果，等它退出。会话文件的形状只在子进程那一层认（ADR-0004、ADR-0008），这里只转手。
// 子进程和 agent 子进程一样放进 Job 对象、只给显式的环境；超时就结束它（one-shot-child.ts）。
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionRewriteRequest, SessionRewriteResult } from "./host-protocol.ts";
import { type RunOneShotOptions, runOneShotChild } from "./one-shot-child.ts";

const ownExt = path.extname(fileURLToPath(import.meta.url));
const REWRITE_ENTRY = fileURLToPath(new URL(`./agent-child/rewrite-main${ownExt}`, import.meta.url));

/** 改写最多等这么久（会话文件再大也就几十 MB） */
const REWRITE_TIMEOUT_MS = 60_000;

export type RunSessionRewriteOptions = RunOneShotOptions;

/** 改写一个会话目录里的会话文件；子进程出错、超时都抛错 */
export function runSessionRewrite(request: SessionRewriteRequest, options: RunSessionRewriteOptions): Promise<SessionRewriteResult> {
  return runOneShotChild<SessionRewriteResult>(REWRITE_ENTRY, request, "改写会话文件", REWRITE_TIMEOUT_MS, options);
}
