// 测试用的 Claude Code 子进程入口（287 号票，只在测试里）：和真的入口（src/claude-code/child/main.ts）一样跑适配子进程（child.ts），
// 只是 query 换成按装配参数里的 faux 剧本吐事件的假 SDK（helpers/fake-claude-sdk.ts），不启动真的 claude、不花额度。
// 主切面经 helpers/fake-claude-code.ts 的插件（同名，换掉清单里的 Claude Code 插件）让守护进程拉起它；契约测试直接拉起它核对环境。
import path from "node:path";
import { runClaudeChild } from "../../src/claude-code/child/child.ts";
import { FAKE_CLAUDE_STORE, FakeClaudeStore, scriptedClaudeSdk } from "../helpers/fake-claude-sdk.ts";

process.stderr.write("假 SDK 的 Claude Code 子进程起来了\n");

const stores = new Map<string, FakeClaudeStore>();

runClaudeChild(
  {
    stdin: process.stdin,
    stdout: process.stdout,
    env: process.env,
    log: (line) => process.stderr.write(`${line}\n`),
    exit: (code) => process.exit(code),
  },
  // 不找本机的 claude.exe（假 SDK 用不着，也不让测试的输出里带本机路径）。293 号票：会话记录存在会话目录里（子进程重启后还在，测试也读它），
  // 撤回用的分叉、读主线照它
  {
    queryFor: (session) => scriptedClaudeSdk(session.model.kind === "faux" ? session.model.script : [], storeFor(session.sessionDir)),
    sessionsFor: (session) => storeFor(session.sessionDir).ops(),
    executable: null,
  },
);

/** 会话目录里的会话记录（同一个文件只建一份：query 和撤回用的会话函数共用） */
function storeFor(sessionDir: string): FakeClaudeStore {
  const file = path.join(sessionDir, FAKE_CLAUDE_STORE);
  let store = stores.get(file);
  if (!store) {
    store = new FakeClaudeStore(file);
    stores.set(file, store);
  }
  return store;
}
