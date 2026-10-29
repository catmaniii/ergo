// 主切面：Claude Code 插件（287 号票）。真的守护进程走组合根和插件清单；清单里的 Claude Code 插件经 extraPlugins 换成同名的、
// 子进程接假 SDK 的那个（helpers/fake-claude-code.ts：运行时的 id、名字、能力清单、适配子进程都是真的，只有 SDK 是按 faux 剧本吐事件的假的，
// 不启动真的 claude、不花额度）：
// - GET /api/runtimes 里有 Claude Code：插件名、能力清单照实写（插话、压缩、思考档位、斜杠命令转交、接管、撤回和切分支、Remote Control 能做）；
// - 运行时是 Claude Code 的任务：维护者经 Claude Code 的子进程跑完一轮、任务自动完成；会话频道里的事件（网页显示的就是它们）和
//   同一个剧本由 pi 跑出来的一样；
// - 插件在配置里停用着：这个任务转等我，写明"Claude Code插件没启用"。
import { EVENT_TYPES, maintainerChannel, type MessageEventPayload, type Task } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { CLAUDE_CODE_PLUGIN, CLAUDE_CODE_RUNTIME_ID } from "../../src/claude-code/api.ts";
import { CLAUDE_CODE_CAPABILITIES } from "../../src/claude-code/runtime.ts";
import { CLAUDE_FALLBACK_MODELS, claudeCodeSettings } from "../../src/claude-code/settings.ts";
import { LEDGER_CHANNEL, TOKEN_USAGE_EVENT, type TokenUsagePayload } from "../../src/ledger/entry.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { fakeSdkClaudeCodePlugin } from "../helpers/fake-claude-code.ts";
import { runtimesApi } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";

const taskNow = (td: TestDaemon, taskId: string): Task => td.daemon.tasks.get(taskId)!;
const waitState = (td: TestDaemon, taskId: string, state: Task["state"]) =>
  waitUntil(() => taskNow(td, taskId).state === state, { timeoutMs: 30_000, describe: () => `等 ${taskId} ${state}，现在：${JSON.stringify(taskNow(td, taskId))}` });

/** 从现在起拉起了哪些 agent、各用哪个运行时（测试接缝，同 agent-runtimes.test.ts） */
function runtimeSpawns(td: TestDaemon): () => Array<{ agentId: string; runtime: string }> {
  const seen: Array<{ agentId: string; runtime: string }> = [];
  const spawn = td.daemon.agents.spawn.bind(td.daemon.agents);
  td.daemon.agents.spawn = (request) => {
    seen.push({ agentId: request.agentId, runtime: request.runtime ?? "pi" });
    return spawn(request);
  };
  return () => [...seen];
}

/**
 * 会话频道里的事件，去掉 id、时间这些每次都不一样的：网页显示的就是这些（消息按说话的一方和每个 part 的种类、文字，别的事件按种类）
 */
function channelShape(td: TestDaemon, task: Task): string[] {
  return td.daemon.store.read(maintainerChannel(task.maintainerId), 0).map((event) => {
    if (event.type !== EVENT_TYPES.message) return event.type;
    const { message } = event.payload as MessageEventPayload;
    const parts = message.parts.map((part) => `${part.type}=${"text" in part ? part.text : ""}`).join(" | ");
    // 任务书（发给维护者的那条）里有任务 id，不比文字
    return message.speaker === "agent" ? `message:agent:${parts}` : `message:${message.speaker}`;
  });
}

const SCRIPT: FauxStep[] = [{ kind: "reply", thinking: "先看看下载目录里都有什么。", text: "下载目录按月份整理好了。", usage: { cacheHit: 0, cacheMiss: 300, output: 40 } }];

describe("Claude Code 插件（假 SDK）", () => {
  it("GET /api/runtimes 里有 Claude Code：插件登记的，能力清单照实写", async () => {
    const td = await startTestDaemon();
    const view = (await runtimesApi.view(td.url)).body;
    expect(view.runtimes.map((r) => r.id)).toEqual(["pi", CLAUDE_CODE_RUNTIME_ID]);
    // 289 号票起带上可选的模型（还没有子进程报回时是三个别名）和设置项（权限模式、思考档位）
    expect(view.runtimes[1]).toEqual({
      id: CLAUDE_CODE_RUNTIME_ID,
      title: "Claude Code",
      plugin: CLAUDE_CODE_PLUGIN,
      available: true,
      capabilities: { ...CLAUDE_CODE_CAPABILITIES },
      models: CLAUDE_FALLBACK_MODELS,
      settings: claudeCodeSettings(),
      // 305 号票：新建时能选工作文件夹（还没设默认文件夹）
      workFolder: {},
    });
    // 293 号票：撤回、切分支能做（分支摘要由二狗写、撤回时恢复文件）；292 号票：Remote Control 能做
    expect(CLAUDE_CODE_CAPABILITIES).toMatchObject({
      interject: true,
      compact: true,
      thinking_levels: true,
      slash_passthrough: true,
      rollback: true,
      branch_switch: true,
      branch_summary: false,
      rewind_files: true,
      take_over: true,
      remote_control: true,
    });
  });

  it("运行时是 Claude Code 的任务：维护者经 Claude Code 的子进程跑完一轮、任务自动完成；会话里的事件和 pi 跑同一个剧本时一样", async () => {
    const claude = await startTestDaemon({ extraPlugins: [fakeSdkClaudeCodePlugin], maintainer: SCRIPT });
    const spawns = runtimeSpawns(claude);
    const task = claude.daemon.tasks.delegate({ title: "整理下载目录", instructions: "把下载目录按月份分好", runtime: CLAUDE_CODE_RUNTIME_ID });
    expect(task.runtime).toBe(CLAUDE_CODE_RUNTIME_ID);
    await waitState(claude, task.id, "done");
    expect(spawns()).toEqual([{ agentId: task.maintainerId, runtime: CLAUDE_CODE_RUNTIME_ID }]);

    const pi = await startTestDaemon({ maintainer: SCRIPT });
    const piTask = pi.daemon.tasks.delegate({ title: "整理下载目录", instructions: "把下载目录按月份分好" });
    await waitState(pi, piTask.id, "done");

    const shape = channelShape(claude, task);
    expect(shape).toContain("message:agent:reasoning=先看看下载目录里都有什么。 | text=下载目录按月份整理好了。");
    expect(shape).toEqual(channelShape(pi, piTask));
    // 这次模型调用的用量记进了 token 账本
    const usage = claude.daemon.store.read(LEDGER_CHANNEL, 0, TOKEN_USAGE_EVENT).map((e) => e.payload as TokenUsagePayload);
    expect(usage.filter((u) => u.agentId === task.maintainerId)).toHaveLength(1);
  }, 90_000);

  it("插件在配置里停用着：运行时是 Claude Code 的任务转等我，写明 Claude Code插件没启用", async () => {
    const td = await startTestDaemon({ extraPlugins: [fakeSdkClaudeCodePlugin], config: { plugins: { disabled: [CLAUDE_CODE_PLUGIN] } } });
    const task = td.daemon.tasks.delegate({ title: "整理下载目录", instructions: "把下载目录按月份分好", runtime: CLAUDE_CODE_RUNTIME_ID });
    await waitState(td, task.id, "waiting_for_user");
    expect(taskNow(td, task.id)).toMatchObject({ waitReason: "runtime_off", waitNote: "Claude Code插件没启用" });
  }, 60_000);
});
