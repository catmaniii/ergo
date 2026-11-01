// 在本进程里跑一个 Codex 适配子进程（stdin / stdout 是内存里的流），app-server 是假的（fake-codex-app-server.ts）：契约测试用。
// 适配子进程、钩子脚本、MCP 中转都是真的；环境用测试进程自己的（钩子要 cmd、node）。每个测试结束核对假 app-server 没发现协议对不上。
import { PassThrough } from "node:stream";
import { expect, onTestFinished } from "vitest";
import { runCodexChild } from "../../src/codex/child/child.ts";
import { type AgentReport, HOST_PROTOCOL_VERSION, type HostCommand, type HostToolResult, type GuardVerdict, type SessionAssembly } from "../../src/runtime/index.ts";
import { encodeLine, readJsonLines } from "../../src/runtime/line-channel.ts";
import { fauxModel } from "./daemon.ts";
import { type FakeCodexOptions, FakeCodexServer } from "./fake-codex-app-server.ts";
import { ReportLog, type ReportOf } from "./report-log.ts";
import { makeTempDir } from "./temp-dir.ts";

export function codexAssembly(overrides: Partial<SessionAssembly> = {}): SessionAssembly {
  return {
    agentId: "codex-test",
    cwd: overrides.cwd ?? makeTempDir("ergo-codex-cwd-"),
    sessionDir: overrides.sessionDir ?? makeTempDir("ergo-codex-sessions-"),
    runtimeDir: overrides.runtimeDir ?? makeTempDir("ergo-codex-runtime-"),
    piAgentDir: "",
    model: fauxModel([]),
    credentials: {},
    tools: [],
    contributions: { tools: [], contextBlocks: [], hooks: [] },
    skillPaths: [],
    systemPrompt: "你是二狗的负责人。MARKER_ERGO_APPEND",
    continueSession: true,
    forwardToolCalls: true,
    shellEnv: {},
    heartbeatIntervalMs: 60_000,
    ...overrides,
  };
}

export interface CodexChildOptions {
  session?: Partial<SessionAssembly>;
  server?: FakeCodexOptions | FakeCodexServer;
  env?: Record<string, string | undefined>;
  /** 版本号（测版本对不上） */
  protocolVersion?: number;
}

export function startCodexChild(options: CodexChildOptions = {}) {
  const server = options.server instanceof FakeCodexServer ? options.server : new FakeCodexServer(options.server);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const listeners = new Set<(report: AgentReport) => void>();
  readJsonLines<AgentReport>(stdout, (report) => listeners.forEach((l) => l(report)), { onInvalid: () => {} });
  const log = new ReportLog({
    onReport: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const logs: string[] = [];
  let exitCode: number | undefined;
  const child = runCodexChild(
    {
      stdin,
      stdout,
      env: options.env ?? process.env,
      log: (line) => logs.push(line),
      exit: (code) => {
        exitCode = code;
      },
    },
    { spawnFor: () => server.spawn },
  );
  const assembly = codexAssembly(options.session);
  const send = (command: HostCommand) => stdin.write(encodeLine(command));
  send({ type: "start", protocolVersion: options.protocolVersion ?? HOST_PROTOCOL_VERSION, session: assembly });
  onTestFinished(async () => {
    await child.shutdown(0);
    expect(server.violations).toEqual([]);
  });

  /** 守卫的判定按这个函数回（不给就全放行） */
  const answerGuard = (decide: (request: ReportOf<"guard_request">) => GuardVerdict = () => ({ allow: true })) => {
    listeners.add((report) => {
      if (report.type === "guard_request") send({ type: "guard_reply", requestId: report.requestId, verdict: decide(report) });
    });
  };
  /** 二狗工具的结果按这个函数回 */
  const answerHostTool = (run: (call: ReportOf<"host_tool_call">) => HostToolResult) => {
    listeners.add((report) => {
      if (report.type === "host_tool_call") send({ type: "host_tool_result", requestId: report.requestId, result: run(report) });
    });
  };
  /** 送一条输入，等这一轮结束 */
  const turn = async (inputId: string, text: string, extra: Partial<Extract<HostCommand, { type: "user_input" }>> = {}) => {
    send({ type: "user_input", inputId, text, ...extra });
    return log.next("turn_end");
  };
  return { server, send, log, logs, assembly, answerGuard, answerHostTool, turn, shutdown: child.shutdown, exitCode: () => exitCode };
}

export type CodexChild = ReturnType<typeof startCodexChild>;
