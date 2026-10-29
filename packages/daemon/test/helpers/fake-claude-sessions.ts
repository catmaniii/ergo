// 测试用的本机 Claude Code 会话（290 号票，只在测试里）：Claude Code 插件接管已有会话时的会话来源换成它——不读用户真实的 ~/.claude、
// 不跑 `claude agents --json`。测试扮演本机：sessions 是本机有哪些会话（编的标题、工作目录在测试的临时目录里），open 是 agents 里
// 正开着的（给一个 Error 就是查不到），histories 是每个会话主线最近一段（已经翻成二狗的样子，翻法另有契约测试），forks 记下分叉了谁。
// 配上 helpers/fake-claude-code.ts 的假 SDK 子进程入口：守护进程走真的插件、真的运行时登记和接管服务。
// 292 号票：transcripts 是只读跟随读的会话主线（SDK 的 SessionMessage 样子，编的），翻法用真的（child/sessions.ts 的 followOf）；
// 交给官方 App 的命令行配 helpers/fake-claude-cli.ts。
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { followOf } from "../../src/claude-code/child/sessions.ts";
import type { ClaudeCli } from "../../src/claude-code/cli.ts";
import { createClaudeCodePlugin } from "../../src/claude-code/plugin.ts";
import type { ClaudeSessionSource } from "../../src/claude-code/sessions.ts";
import { type ClaudeRunningSession, type ClaudeSessionInfo, FOLLOW_MESSAGES } from "../../src/claude-code/sessions-protocol.ts";
import type { PluginDefinition } from "../../src/plugins/host.ts";
import type { RuntimeFollow, RuntimeHistory } from "../../src/runtime/index.ts";
import { FAKE_CLAUDE_CHILD } from "./fake-claude-code.ts";

export class FakeClaudeSessions implements ClaudeSessionSource {
  sessions: ClaudeSessionInfo[] = [];
  /** agents --json 里正开着的；Error 是查不到 */
  open: ClaudeRunningSession[] | Error = [];
  readonly histories = new Map<string, RuntimeHistory | Error>();
  /** 分叉过的：原会话 → 新会话 */
  readonly forks: Array<{ from: string; to: string }> = [];
  /** 只读跟随读的会话主线（292 号票）：会话 id → SDK 读出的消息（按先后） */
  readonly transcripts = new Map<string, SessionMessage[]>();
  /** 每样被叫了几次 */
  readonly calls = { list: 0, running: 0, history: 0, fork: 0, follow: 0 };

  list(): Promise<ClaudeSessionInfo[]> {
    this.calls.list += 1;
    return Promise.resolve(this.sessions.map((s) => ({ ...s })));
  }

  running(): Promise<ClaudeRunningSession[]> {
    this.calls.running += 1;
    if (this.open instanceof Error) return Promise.reject(this.open);
    return Promise.resolve(this.open.map((r) => ({ ...r })));
  }

  history(sessionId: string): Promise<RuntimeHistory> {
    this.calls.history += 1;
    const found = this.histories.get(sessionId);
    if (found instanceof Error) return Promise.reject(found);
    return Promise.resolve(found ?? { items: [], truncated: false });
  }

  fork(sessionId: string): Promise<string> {
    this.calls.fork += 1;
    const to = `${sessionId}-fork-${this.forks.length + 1}`;
    this.forks.push({ from: sessionId, to });
    const source = this.sessions.find((s) => s.sessionId === sessionId);
    if (source) this.sessions.push({ ...source, sessionId: to, title: `${source.title} (fork)` });
    const history = this.histories.get(sessionId);
    if (history) this.histories.set(to, history);
    return Promise.resolve(to);
  }

  follow(sessionId: string, options: { after?: string; final: boolean; tail?: boolean }): Promise<RuntimeFollow> {
    this.calls.follow += 1;
    const messages = this.transcripts.get(sessionId) ?? [];
    if (options.tail === true) {
      const last = messages.at(-1)?.uuid;
      return Promise.resolve({ items: [], ...(last === undefined ? {} : { cursor: last }) });
    }
    return Promise.resolve(followOf(messages, options.after, options.final, FOLLOW_MESSAGES));
  }
}

/** 子进程接假 SDK、会话来源是这一份假本机的 Claude Code 插件（同名，换掉清单里的那个）；给了 cli 的交给官方 App 时跑它（等待调短） */
export function fakeTakeoverClaudeCodePlugin(sessions: FakeClaudeSessions, cli?: ClaudeCli): PluginDefinition {
  return createClaudeCodePlugin({ entry: FAKE_CLAUDE_CHILD, sessions, ...(cli ? { cli, remoteTiming: { pollMs: 20, exitWaitMs: 600, startWaitMs: 600, linkWaitMs: 300, stopWaitMs: 600 } } : {}) });
}
