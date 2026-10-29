// 测试用的 Claude Code 插件（287 号票，只在测试里）：和真的同名（claude-code）、同一个运行时（id、名字、能力清单都是真的），
// 只是子进程入口换成 fixtures/fake-claude-child.ts——适配子进程是真的，SDK 是按 faux 剧本吐事件的假的。
// 主切面经 startTestDaemon 的 extraPlugins 交给守护进程：同名的换掉插件清单里的那个（daemon.ts 的 withExtraPlugins），走同一条装配路径。
import { fileURLToPath } from "node:url";
import { createClaudeCodePlugin } from "../../src/claude-code/plugin.ts";

/** 接假 SDK 的 Claude Code 子进程入口 */
export const FAKE_CLAUDE_CHILD = fileURLToPath(new URL("../fixtures/fake-claude-child.ts", import.meta.url));

/** 子进程接假 SDK 的 Claude Code 插件 */
export const fakeSdkClaudeCodePlugin = createClaudeCodePlugin({ entry: FAKE_CLAUDE_CHILD });
