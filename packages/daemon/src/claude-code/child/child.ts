// Claude Code 适配子进程的宿主协议这一层（287 号票）：stdin 一行一条命令、stdout 一行一条上报（line-channel.ts），结构照 pi 的
// runtime/agent-child/main.ts——收到"启动"之前什么都不做（守护进程先把本进程放进 Job 对象再送"启动"，claude 是它的孙进程）；
// 命令按到达的先后逐条处理。用哪个 SDK 由入口给（deps.queryFor）：真的入口 main.ts 给 @anthropic-ai/claude-agent-sdk 的 query，
// 契约测试和主切面给按剧本吐事件的假 SDK（test/helpers/fake-claude-sdk.ts），不启动真的 claude、不花额度。
// 291 号票接上的：host_tool_result（二狗的工具经进程内 MCP 服务交给 Claude，结果交给在等的那次调用；被取消了的收下扔掉）、contribution
// （上下文块、钩子订阅的文字换成新的，经钩子注入）、scope_context（近期范围记录换成新的，经钩子注入）、toolkit（工具包当场换，做完才处理后面的命令）。
// guard_reply、ask_user_reply（288 号票）：交给在等的那次调用，没有在等的回 bad_command。
// navigate_session（293 号票）：撤回、切分支（navigation.ts，要入口给的 SDK 会话函数 deps.sessionsFor），做完才处理后面的命令。
// 没做的命令（见 runtime.ts 的能力清单）：
// - scope_review 回一个没做成的结果（范围审视不在 Claude 的会话里做：309 号票起由守护进程按自己记下的事件另起，不再送它；收到了也不让守护进程干等）；
//   yield 不需要（工具包变了当场换，守护进程对 live_toolkit 的运行时送 toolkit），收下不管；
// - work_order：同 pi，没实现，回 unsupported。
// @i18n-ignore-file log：宿主协议上报回去的出错说明、子进程的日志（守护进程记日志）
import { installBuiltinLocales } from "../../i18n/builtin.ts";
import { type AgentReport, CHILD_LANGUAGE_ENV, errorReport, failedScopeReview, HOST_PROTOCOL_VERSION, type HostCommand, type SessionAssembly } from "../../runtime/host-protocol.ts";
import { encodeLine, readJsonLines } from "../../runtime/line-channel.ts";
import { findClaudeExecutable } from "./env.ts";
import type { ClaudeSessionOps } from "./navigation.ts";
import { type ClaudeQueryFunction, ClaudeSessionRunner } from "./session.ts";

export interface ClaudeChildIo {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  /** 子进程自己的环境（守护进程按白名单给的） */
  env: Readonly<Record<string, string | undefined>>;
  /** 日志（stderr） */
  log: (line: string) => void;
  /** 结束子进程（stdout 写完之后才叫） */
  exit: (code: number) => void;
}

export interface ClaudeChildDeps {
  /** 这个会话用哪个 SDK 的 query：真的入口不看装配参数；假 SDK 按装配参数里的 faux 剧本吐事件 */
  queryFor: (session: SessionAssembly) => ClaudeQueryFunction;
  /** 本机的 claude.exe；不给按环境找（env.ts）。测试给 null：用 SDK 自带的 */
  executable?: string | null;
  /** 撤回要用的 SDK 会话函数（293 号票）：真的入口给 forkSession、getSessionMessages，测试按装配参数给假的；不给的撤回回原因 */
  sessionsFor?: (session: SessionAssembly) => ClaudeSessionOps;
}

/** 接上 stdin / stdout 跑宿主协议；返回收尾的函数（测试用） */
export function runClaudeChild(io: ClaudeChildIo, deps: ClaudeChildDeps): { shutdown(code: number): Promise<void> } {
  installBuiltinLocales(io.env[CHILD_LANGUAGE_ENV]);
  let runner: ClaudeSessionRunner | undefined;
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
    // 等 stdout 写完再退出，免得最后几条消息丢掉
    io.stdout.write("", () => io.exit(code));
  };

  const handle = async (command: HostCommand): Promise<void> => {
    switch (command.type) {
      case "start": {
        if (runner) return emit(errorReport("bad_command", "已经启动过了"));
        if (command.protocolVersion !== HOST_PROTOCOL_VERSION) {
          emit(errorReport("start_failed", `宿主协议版本不符：守护进程 ${command.protocolVersion}，Claude Code 子进程 ${HOST_PROTOCOL_VERSION}`, true));
          return shutdown(1);
        }
        try {
          const executable = deps.executable === null ? undefined : (deps.executable ?? findClaudeExecutable(io.env));
          runner = ClaudeSessionRunner.open(command.session, emit, {
            query: deps.queryFor(command.session),
            env: io.env,
            ...(executable === undefined ? {} : { executable }),
            ...(deps.sessionsFor === undefined ? {} : { sessions: deps.sessionsFor(command.session) }),
            log: io.log,
          });
        } catch (err) {
          emit(errorReport("start_failed", err instanceof Error ? (err.stack ?? err.message) : String(err), true));
          return shutdown(1);
        }
        heartbeat = setInterval(() => emit({ type: "heartbeat", at: Date.now() }), command.session.heartbeatIntervalMs);
        heartbeat.unref();
        emit({
          type: "ready",
          pid: process.pid,
          sessionId: runner.sessionId,
          sessionFile: runner.sessionFile,
          session: runner.session,
          loaded: runner.loaded,
          vision: true,
          model: runner.model,
          context: runner.contextInfo,
        });
        return;
      }
      case "user_input":
        if (!runner) return emit(errorReport("bad_command", "还没启动就送了输入"));
        return runner.prompt(command.inputId, command.text, command.images ?? [], command.context);
      case "interject":
        if (!runner) return emit(errorReport("bad_command", "还没启动就送了插话", false, command.inputId));
        return runner.interject(command.inputId, command.text, command.images ?? []);
      case "abort":
        // 不等打断做完：后面的命令（插话、exit）照常处理，这一轮的结局由 result 报
        void runner?.abort();
        return;
      case "compact":
        if (!runner) return emit(errorReport("bad_command", "还没启动就要压缩"));
        // 压完（或没压成）才处理排在后面的命令；结局以 compacted 报
        return runner.compact();
      case "scope_review":
        return emit(failedScopeReview(command.requestId, "Claude Code 运行时不在会话里做范围审视"));
      case "navigate_session":
        if (!runner) return emit({ type: "session_navigated", requestId: command.requestId, ok: false, error: "还没启动就要在会话之间挪" });
        // 挪完（分叉、恢复文件、换会话）才处理排在后面的命令；结果以 session_navigated 报
        return runner.navigate(command);
      case "write_handoff":
        if (!runner) return emit({ type: "handoff_written", requestId: command.requestId, error: "还没启动就要写交接摘要" });
        // 写完才处理排在后面的命令（含 exit）：结果先交给守护进程
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
      case "toolkit":
        if (!runner) return emit(errorReport("bad_command", "还没启动就要换工具包"));
        // 换完（MCP 服务、插件重新加载）才处理排在后面的命令
        return runner.changeToolkit(command.tools, command.skillPaths, command.notice);
      case "yield":
        return;
      case "exit":
        return shutdown(0);
      case "work_order":
        return emit(errorReport("unsupported", `这个版本还没实现 ${command.type}`));
      default:
        return emit(errorReport("bad_command", `不认识的命令：${JSON.stringify(command)}`));
    }
  };

  readJsonLines<HostCommand>(
    io.stdin,
    (command) => {
      queue = queue.then(() => handle(command)).catch((err: unknown) => emit(errorReport("internal", String(err))));
    },
    {
      onInvalid: (line) => emit(errorReport("bad_command", `无法解析的命令：${line}`)),
      // 守护进程关掉 stdin（或者守护进程没了）就正常退出
      onEnd: () => {
        queue = queue.then(() => shutdown(0));
      },
    },
  );
  return { shutdown };
}
