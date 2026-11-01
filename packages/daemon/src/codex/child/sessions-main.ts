// 一次性子进程的入口：列本机的 Codex 会话、读状况、读前情、分叉（sessions.ts）。守护进程这一侧的 Codex 插件经内核的一次性子进程（KERNEL.oneShot：Job 对象、白名单环境）
// 用 `node sessions-main.ts` 拉起（../sessions.ts）：stdin 读一行请求，起一个 codex app-server（CODEX_HOME 照用户自己的，不配钩子、不配中转），问完关掉，
// stdout 写一行结果（{ ok: true, result } 或 { ok: false, error }），然后退出。不发轮次，不花额度。
// @i18n-ignore-file log：出错说明交回守护进程记日志
import { t } from "@ergo/protocol";
import { installBuiltinLocales } from "../../i18n/builtin.ts";
import { CHILD_LANGUAGE_ENV } from "../../runtime/host-protocol.ts";
import { encodeLine, readJsonLines } from "../../runtime/line-channel.ts";
import { codexProcessEnv, findCodexEntry } from "../install.ts";
import type { CodexSessionsRequest } from "../sessions-protocol.ts";
import { CodexRpc, spawnCodexServer } from "./app-server.ts";
import { handleSessionsRequest } from "./sessions.ts";

installBuiltinLocales(process.env[CHILD_LANGUAGE_ENV]);

let handled = false;

function finish(reply: unknown, code: number): void {
  process.stdout.write(encodeLine(reply), () => process.exit(code));
}

async function run(request: CodexSessionsRequest): Promise<unknown> {
  const entry = findCodexEntry(process.env);
  if (!entry) throw new Error(t("codex.plugin.notInstalled"));
  const log = (line: string) => process.stderr.write(`${line}\n`);
  const proc = spawnCodexServer(entry)(["app-server"], { env: codexProcessEnv(process.env), cwd: process.cwd(), log });
  const rpc = new CodexRpc(proc, {
    onNotification: () => {},
    onRequest: () => Promise.reject(new Error("这个一次性进程不接请求")),
    onExit: () => {},
  });
  try {
    await rpc.initialize();
    return await handleSessionsRequest(request, rpc);
  } finally {
    await rpc.close();
  }
}

readJsonLines<CodexSessionsRequest>(
  process.stdin,
  (request) => {
    if (handled) return;
    handled = true;
    run(request).then(
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
