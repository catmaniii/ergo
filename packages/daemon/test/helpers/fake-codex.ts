// 测试用的 Codex 插件（只在测试里）：和真的同名（codex）、同一个运行时（id、名字、能力清单都是真的），只是子进程入口换成 fixtures/fake-codex-child.ts——
// 适配子进程是真的，app-server 是按 faux 剧本走的假的；会话来源是假本机（FakeCodexSessions：编的会话、编的状况、编的前情，不起 codex、不读 ~/.codex）；
// "装没装"不看这台机器。主切面经 startTestDaemon 交给守护进程：同名的换掉插件清单里的那个（daemon.ts 的 withExtraPlugins），走同一条装配路径。
import { fileURLToPath } from "node:url";
import { createCodexPlugin } from "../../src/codex/plugin.ts";
import type { CodexSessionSource } from "../../src/codex/sessions.ts";
import type { CodexSessionInfo } from "../../src/codex/sessions-protocol.ts";
import type { PluginDefinition } from "../../src/plugins/host.ts";
import type { RuntimeHistory } from "../../src/runtime/index.ts";

/** 接假 app-server 的 Codex 子进程入口 */
export const FAKE_CODEX_CHILD = fileURLToPath(new URL("../fixtures/fake-codex-child.ts", import.meta.url));

export class FakeCodexSessions implements CodexSessionSource {
  sessions: CodexSessionInfo[] = [];
  readonly histories = new Map<string, RuntimeHistory | Error>();
  /** 分叉过的：原会话 → 新会话 */
  readonly forks: Array<{ from: string; to: string; cwd: string }> = [];

  list(): Promise<CodexSessionInfo[]> {
    return Promise.resolve(this.sessions.map((s) => ({ ...s })));
  }

  state(sessionId: string): Promise<{ updatedAt: number; loaded: boolean }> {
    const found = this.sessions.find((s) => s.sessionId === sessionId);
    // @i18n-ignore-next 测试
    if (!found) return Promise.reject(new Error(`no rollout found for thread id ${sessionId}`));
    return Promise.resolve({ updatedAt: found.updatedAt, loaded: found.loaded });
  }

  history(sessionId: string): Promise<RuntimeHistory> {
    const found = this.histories.get(sessionId);
    if (found instanceof Error) return Promise.reject(found);
    return Promise.resolve(found ?? { items: [], truncated: false });
  }

  fork(sessionId: string, cwd: string): Promise<string> {
    const to = `${sessionId}-fork-${this.forks.length + 1}`;
    this.forks.push({ from: sessionId, to, cwd });
    const source = this.sessions.find((s) => s.sessionId === sessionId);
    if (source) this.sessions.push({ ...source, sessionId: to, title: `${source.title} (fork)` });
    const history = this.histories.get(sessionId);
    if (history) this.histories.set(to, history);
    return Promise.resolve(to);
  }
}

/** 子进程接假 app-server、会话来源是这一份假本机的 Codex 插件（同名，换掉清单里的那个）；不给 sessions 是空的本机 */
export function fakeCodexPluginWith(sessions: CodexSessionSource = new FakeCodexSessions()): PluginDefinition {
  // 深度体检的"登录"（415）也换成假的：绝不跑真的 codex login status
  return createCodexPlugin({ entry: FAKE_CODEX_CHILD, sessions, missing: () => undefined, loginStatus: () => Promise.resolve({ code: 0, stdout: "", stderr: "Logged in using ChatGPT\n" }) });
}

/** 子进程接假 app-server 的 Codex 插件 */
export const fakeCodexPlugin: PluginDefinition = fakeCodexPluginWith();
