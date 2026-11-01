// Codex 运行时的子进程入口：守护进程按运行时的登记（runtime.ts 的 CODEX_CHILD_ENTRY）用 `node main.ts` 拉起，每个会话一个；
// stdin / stdout 上跑宿主协议（child.ts），里面拉起用户本机的 codex app-server。真的 codex 只在这里和 sessions-main.ts 里起。
// @i18n-ignore-file log：子进程的日志
import { findCodexEntry } from "../install.ts";
import { spawnCodexServer } from "./app-server.ts";
import { runCodexChild } from "./child.ts";

runCodexChild(
  {
    stdin: process.stdin,
    stdout: process.stdout,
    env: process.env,
    log: (line) => process.stderr.write(`${line}\n`),
    exit: (code) => process.exit(code),
  },
  {
    spawnFor: () => {
      const entry = findCodexEntry(process.env);
      return entry ? spawnCodexServer(entry) : undefined;
    },
  },
);
