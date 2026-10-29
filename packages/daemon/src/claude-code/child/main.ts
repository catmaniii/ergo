// Claude Code 运行时的子进程入口（287 号票）：守护进程按运行时的登记（runtime.ts 的 CLAUDE_CODE_CHILD_ENTRY）用 `node main.ts` 拉起，
// 每个会话一个；stdin / stdout 上跑宿主协议（child.ts），里面用 Agent SDK 的 query() 驱动本机的 claude。
// SDK（@anthropic-ai/claude-agent-sdk）只在这里用真的 query（293 号票起还有撤回用的 forkSession、getSessionMessages），别处只引类型
// （test/claude-code/boundary.test.ts 检查）；318 号票起经 load-sdk.ts 加载（仓库的 node_modules 里没有时到组件区找）。
// @i18n-ignore-file log：子进程的日志
import { runClaudeChild } from "./child.ts";
import { loadClaudeSdk } from "./load-sdk.ts";

const { forkSession, getSessionMessages, query } = await loadClaudeSdk();

runClaudeChild(
  {
    stdin: process.stdin,
    stdout: process.stdout,
    env: process.env,
    log: (line) => process.stderr.write(`${line}\n`),
    exit: (code) => process.exit(code),
  },
  {
    queryFor: () => query,
    // 293 号票：撤回时分叉（复制成新会话、截到撤回点之前那一条）、读主线找撤回点（会话 id 全局唯一，不传 dir，同 290 号票）
    sessionsFor: () => ({
      fork: async (sessionId, upToMessageId) => (await forkSession(sessionId, { upToMessageId })).sessionId,
      messages: (sessionId) => getSessionMessages(sessionId, { includeSystemMessages: true }),
    }),
  },
);
