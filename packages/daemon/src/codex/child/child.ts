// Codex 适配子进程的宿主协议这一层：stdin 一行一条命令、stdout 一行一条上报（line-channel.ts），结构照 claude-code/child/child.ts——收到"启动"之前什么都不做
// （守护进程先把本进程放进 Job 对象再送"启动"，codex 是它的孙进程）；命令按到达的先后逐条处理。怎么起 app-server 由入口给（deps.spawn）：
// 真的入口 main.ts 起用户本机的 codex，契约测试和主切面给假的（test/helpers/fake-codex-app-server.ts）。
// 没做的命令（见 runtime.ts 的能力清单）：
// - toolkit：live_toolkit 是 false，守护进程不送，收到回 unsupported；yield：Codex 没有这个口子，收下不管，这一轮照常做完（守护进程按新的装配重新拉起）；
// - scope_review：由守护进程按自己记下的事件另起（recordedScopeReview），不再送；收到了回没做成，不让它干等；work_order：同 pi，回 unsupported。
// @i18n-ignore-file log：宿主协议上报回去的出错说明、子进程的日志（守护进程记日志）
import { t } from "@ergo/protocol";
import { installBuiltinLocales } from "../../i18n/builtin.ts";
import { type AgentReport, CHILD_LANGUAGE_ENV, errorReport, failedScopeReview, HOST_PROTOCOL_VERSION, type HostCommand, type SessionAssembly } from "../../runtime/host-protocol.ts";
import { encodeLine, readJsonLines } from "../../runtime/line-channel.ts";
import type { CodexServerSpawn } from "./app-server.ts";
import { CodexSessionRunner } from "./session.ts";

export interface CodexChildIo {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  /** 子进程自己的环境（守护进程按白名单给的） */
  env: Readonly<Record<string, string | undefined>>;
  log: (line: string) => void;
  exit: (code: number) => void;
}

export interface CodexChildDeps {
  /** 这个会话怎么起 app-server；找不到本机的 codex 交回 undefined */
  spawnFor: (session: SessionAssembly) => CodexServerSpawn | undefined;
}

/** 接上 stdin / stdout 跑宿主协议；返回收尾的函数（测试用） */
export function runCodexChild(io: CodexChildIo, deps: CodexChildDeps): { shutdown(code: number): Promise<void> } {
  installBuiltinLocales(io.env[CHILD_LANGUAGE_ENV]);
  let runner: CodexSessionRunner | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let shuttingDown = false;
  let queue: Promise<void> = Promise.resolve();

  const emit = (report: AgentReport) => {
    io.stdout.write(encodeLine(report));
  };

  const shutdown = async (code: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (heartbeat) clearInterval(heartbeat);
    try {
      await runner?.dispose();
    } catch (err) {
      io.log(`关闭会话出错：${String(err)}`);
    }
    io.stdout.write("", () => io.exit(code));
  };

  const start = async (command: Extract<HostCommand, { type: "start" }>): Promise<void> => {
    if (runner) return emit(errorReport("bad_command", "已经启动过了"));
    if (command.protocolVersion !== HOST_PROTOCOL_VERSION) {
      emit(errorReport("start_failed", `宿主协议版本不符：守护进程 ${command.protocolVersion}，Codex 子进程 ${HOST_PROTOCOL_VERSION}`, true));
      return shutdown(1);
    }
    // 起 app-server 要一会儿（第一次还要重起一次信任钩子）：心跳先跳着
    heartbeat = setInterval(() => emit({ type: "heartbeat", at: Date.now() }), command.session.heartbeatIntervalMs);
    heartbeat.unref();
    try {
      const spawn = deps.spawnFor(command.session);
      if (!spawn) throw new Error(t("codex.plugin.notInstalled"));
      runner = await CodexSessionRunner.open(command.session, emit, { spawn, env: io.env, log: io.log });
    } catch (err) {
      emit(errorReport("start_failed", err instanceof Error ? err.message : String(err), true));
      return shutdown(1);
    }
    emit({
      type: "ready",
      pid: process.pid,
      sessionId: runner.sessionId,
      sessionFile: runner.sessionFile,
      session: runner.session,
      loaded: runner.loadedResources,
      vision: true,
      model: runner.model,
      context: runner.contextInfo,
      ...(runner.handoff ? { handoff: runner.handoff } : {}),
    });
    runner.afterReady();
  };

  const handle = async (command: HostCommand): Promise<void> => {
    switch (command.type) {
      case "start":
        return start(command);
      case "user_input":
        if (!runner) return emit(errorReport("bad_command", "还没启动就送了输入"));
        return runner.prompt(command.inputId, command.text, command.images ?? [], command.context);
      case "interject":
        if (!runner) return emit(errorReport("bad_command", "还没启动就送了插话", false, command.inputId));
        return runner.interject(command.inputId, command.text, command.images ?? []);
      case "abort":
        // 不等打断做完：后面的命令照常处理，这一轮的结局由 turn/completed 报
        void runner?.abort();
        return;
      case "compact":
        if (!runner) return emit(errorReport("bad_command", "还没启动就要压缩"));
        return runner.compact();
      case "scope_review":
        return emit(failedScopeReview(command.requestId, "Codex 运行时不在会话里做范围审视"));
      case "navigate_session":
        if (!runner) return emit({ type: "session_navigated", requestId: command.requestId, ok: false, error: "还没启动就要在会话之间挪" });
        return runner.navigate(command);
      case "write_handoff":
        if (!runner) return emit({ type: "handoff_written", requestId: command.requestId, error: "还没启动就要写交接摘要" });
        return runner.writeHandoff(command.requestId, command.instructions, command.timeoutMs);
      case "guard_reply":
        if (runner?.replyGuard(command.requestId, command.verdict)) return;
        return emit(errorReport("bad_command", `没有在等的守卫判定：${command.requestId}`));
      case "ask_user_reply":
        if (runner?.replyAsk(command.requestId, command.reply)) return;
        return emit(errorReport("bad_command", `没有在等的回答：${command.requestId}`));
      case "host_tool_result":
        if (runner?.replyHostTool(command.requestId, command.result)) return;
        return emit(errorReport("bad_command", `没有在等的工具结果：${command.requestId}`));
      case "contribution":
        return runner?.updateContribution(command.id, command.text);
      case "scope_context":
        return runner?.setScopeContext(command.recentRecords);
      case "yield":
        return;
      case "exit":
        return shutdown(0);
      case "toolkit":
      case "work_order":
        return emit(errorReport("unsupported", `这个运行时没有 ${command.type}`));
      default:
        return emit(errorReport("bad_command", `不认识的命令：${JSON.stringify(command)}`));
    }
  };

  // 判定、提问的回答、工具结果不排队：它们等着的调用可能正让排在前面的命令（压缩、撤回）等着；顺序只对"开始做一件事"的命令有意义
  const immediate = (command: HostCommand) => command.type === "guard_reply" || command.type === "ask_user_reply" || command.type === "host_tool_result" || command.type === "abort";

  readJsonLines<HostCommand>(
    io.stdin,
    (command) => {
      if (immediate(command) && runner) {
        void handle(command).catch((err: unknown) => emit(errorReport("internal", String(err))));
        return;
      }
      queue = queue.then(() => handle(command)).catch((err: unknown) => emit(errorReport("internal", String(err))));
    },
    {
      onInvalid: (line) => emit(errorReport("bad_command", `无法解析的命令：${line}`)),
      onEnd: () => {
        queue = queue.then(() => shutdown(0));
      },
    },
  );
  return { shutdown };
}
