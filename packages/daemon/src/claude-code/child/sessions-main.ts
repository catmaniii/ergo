// 一次性子进程的入口：列本机的 Claude Code 会话、查哪些正开着、读前情、分叉（290 号票，sessions.ts）。守护进程这一侧的 Claude Code 插件
// 经内核的一次性子进程（KERNEL.oneShot：Job 对象、白名单环境）用 `node sessions-main.ts` 拉起（../sessions.ts）：stdin 读一行请求，
// stdout 写一行结果（{ ok: true, result } 或 { ok: false, error }），然后退出。
// SDK 的列、读、分叉函数只在这里用真的（test/claude-code/boundary.test.ts 检查；318 号票起经 load-sdk.ts 加载，仓库里没有时到组件区找）；`claude agents --json` 用本机的 claude（env.ts 找；
// 不是 Windows 的按 PATH 里的 claude），只读、不起会话。
// @i18n-ignore-file log：出错说明交回守护进程记日志、给开发者看
import { execFile } from "node:child_process";
import { encodeLine, readJsonLines } from "../../runtime/line-channel.ts";
import type { ClaudeSessionsRequest } from "../sessions-protocol.ts";
import { claudeProcessEnv, findClaudeExecutable } from "./env.ts";
import { loadClaudeSdk } from "./load-sdk.ts";
import { handleSessionsRequest } from "./sessions.ts";

const { forkSession, getSessionMessages, listSessions } = await loadClaudeSdk();

/** claude agents --json 最多等多久 */
const AGENTS_TIMEOUT_MS = 20_000;

let handled = false;

function finish(reply: unknown, code: number): void {
  process.stdout.write(encodeLine(reply), () => process.exit(code));
}

/** 跑 `claude agents --json`（只读）：交回标准输出 */
function runAgents(): Promise<string> {
  const executable = findClaudeExecutable(process.env) ?? (process.platform === "win32" ? undefined : "claude");
  if (executable === undefined) return Promise.reject(new Error("没找到本机的 claude.exe（PATH 里、%USERPROFILE%\\.local\\bin 里都没有）"));
  return new Promise((resolve, reject) => {
    execFile(executable, ["agents", "--json"], { env: claudeProcessEnv(process.env), timeout: AGENTS_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`claude agents --json 出错：${err.message}${stderr ? `；${String(stderr).trim()}` : ""}`));
      else resolve(String(stdout));
    });
  });
}

readJsonLines<ClaudeSessionsRequest>(
  process.stdin,
  (request) => {
    if (handled) return;
    handled = true;
    handleSessionsRequest(request, { sdk: { listSessions, getSessionMessages, forkSession }, runAgents }).then(
      (result) => finish({ ok: true, result }, 0),
      (err: unknown) => finish({ ok: false, error: err instanceof Error ? err.message : String(err) }, 1),
    );
  },
  {
    onInvalid: () => {
      handled = true;
      finish({ ok: false, error: "无法解析的请求" }, 1);
    },
    onEnd: () => {
      if (!handled) process.exit(1);
    },
  },
);
