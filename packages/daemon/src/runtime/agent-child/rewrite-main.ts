// 一次性子进程的入口：改写一个 agent 会话目录里的会话文件（彻底删除，21 号票）。
// 由守护进程用 `node rewrite-main.ts` 拉起（runtime/session-rewrite.ts）：stdin 读一行请求（SessionRewriteRequest），
// 改完在 stdout 写一行结果（{ ok: true, result } 或 { ok: false, error }），然后退出。不碰模型、不开会话。
import { encodeLine, readJsonLines } from "../line-channel.ts";
import type { SessionRewriteRequest } from "../host-protocol.ts";
import { rewriteSessionDir } from "./session-rewrite.ts";

let handled = false;

function finish(reply: unknown, code: number): void {
  process.stdout.write(encodeLine(reply), () => process.exit(code));
}

readJsonLines<SessionRewriteRequest>(
  process.stdin,
  (request) => {
    if (handled) return;
    handled = true;
    try {
      finish({ ok: true, result: rewriteSessionDir(request) }, 0);
    } catch (err) {
      finish({ ok: false, error: err instanceof Error ? (err.stack ?? err.message) : String(err) }, 1);
    }
  },
  {
    onInvalid: (line) => {
      handled = true;
      finish({ ok: false, error: `无法解析的请求：${line}` }, 1);
    },
    onEnd: () => {
      if (!handled) process.exit(1);
    },
  },
);
