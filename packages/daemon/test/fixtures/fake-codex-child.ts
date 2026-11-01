// 测试用的 Codex 子进程入口（只在测试里）：和真的入口（src/codex/child/main.ts）一样跑适配子进程（child.ts），只是 app-server 换成
// 按装配参数里的 faux 剧本走的假的（helpers/fake-codex-app-server.ts），不启动真的 codex、不花额度。线程记录存在会话目录里（子进程重启后还在，测试也读它）。
// 主切面经 helpers/fake-codex.ts 的插件（同名，换掉清单里的 Codex 插件）让守护进程拉起它。
import path from "node:path";
import { runCodexChild } from "../../src/codex/child/child.ts";
import { FAKE_CODEX_STORE, FakeCodexServer, FakeCodexStore, turnsOfFaux } from "../helpers/fake-codex-app-server.ts";

process.stderr.write("假 app-server 的 Codex 子进程起来了\n");

runCodexChild(
  {
    stdin: process.stdin,
    stdout: process.stdout,
    env: process.env,
    log: (line) => process.stderr.write(`${line}\n`),
    exit: (code) => process.exit(code),
  },
  {
    spawnFor: (session) => {
      const server = new FakeCodexServer({
        store: new FakeCodexStore(path.join(session.sessionDir, FAKE_CODEX_STORE)),
        turns: turnsOfFaux(session.model.kind === "faux" ? session.model.script : []),
        lenientThreads: true,
      });
      return server.spawn;
    },
  },
);
