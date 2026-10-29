// agent 子进程入口：由守护进程用 `node main.ts` 拉起，stdin / stdout 上跑 agent 宿主协议。
// 收到"启动"之前什么都不做（守护进程先把本进程放进 Job 对象，再送"启动"）。
// @i18n-ignore-file log：宿主协议上报回去的出错说明（守护进程记日志）
import { installBuiltinLocales } from "../../i18n/builtin.ts";
import { CHILD_LANGUAGE_ENV, errorReport, failedScopeReview, HOST_PROTOCOL_VERSION, type AgentReport, type HostCommand } from "../host-protocol.ts";
import { encodeLine, readJsonLines } from "../line-channel.ts";
import { openAgentSession, type AgentSessionRunner } from "./session.ts";

// 给用户看的几句（在会话树上挪不成的原因、压缩没成的原因）按拉起时的语言写（174 号票，ADR-0029）
installBuiltinLocales(process.env[CHILD_LANGUAGE_ENV]);

let runner: AgentSessionRunner | undefined;
let heartbeat: NodeJS.Timeout | undefined;
let shuttingDown = false;
// 命令按到达顺序逐条处理（"启动"是异步的，后面的输入要排在它后面）
let queue: Promise<void> = Promise.resolve();

function emit(report: AgentReport): void {
  process.stdout.write(encodeLine(report));
}

async function handle(command: HostCommand): Promise<void> {
  switch (command.type) {
    case "start": {
      if (runner) return emit(errorReport("bad_command", "已经启动过了"));
      if (command.protocolVersion !== HOST_PROTOCOL_VERSION) {
        emit(errorReport("start_failed", `宿主协议版本不符：守护进程 ${command.protocolVersion}，子进程 ${HOST_PROTOCOL_VERSION}`, true));
        return shutdown(1);
      }
      try {
        runner = await openAgentSession(command.session, emit);
      } catch (err) {
        emit(errorReport("start_failed", err instanceof Error ? (err.stack ?? err.message) : String(err), true));
        return shutdown(1);
      }
      heartbeat = setInterval(() => emit({ type: "heartbeat", at: Date.now() }), command.session.heartbeatIntervalMs);
      emit({
        type: "ready",
        pid: process.pid,
        sessionId: runner.sessionId,
        sessionFile: runner.sessionFile,
        session: runner.session,
        loaded: runner.loaded,
        vision: runner.vision,
        model: runner.model,
        context: runner.contextInfo,
        ...(runner.handoff ? { handoff: runner.handoff } : {}),
      });
      // 写交接摘要那次调用的用量（83 号票）：agent 管家在 ready 时才知道会话 id，所以放在 ready 之后
      for (const report of runner.takeAfterReady()) emit(report);
      return;
    }
    case "user_input":
      if (!runner) return emit(errorReport("bad_command", "还没启动就送了输入"));
      return runner.prompt(command.inputId, command.text, command.images ?? [], command.context);
    case "interject":
      if (!runner) return emit(errorReport("bad_command", "还没启动就送了插话", false, command.inputId));
      return runner.interject(command.inputId, command.text, command.images ?? []);
    case "yield":
      return runner?.yieldTurn();
    case "toolkit":
      // 当场换工具包（291 号票）只给能力清单 live_toolkit 的运行时：pi 的工具包变了按 yield 停下、重新装配
      return emit(errorReport("unsupported", "pi 的工具包变了要重新装配（yield），不当场换"));
    case "contribution":
      if (!runner) return emit(errorReport("bad_command", "还没启动就送了贡献清单的更新"));
      return runner.updateContribution(command.id, command.text);
    case "scope_context":
      if (!runner) return emit(errorReport("bad_command", "还没启动就送了范围审视的对照物"));
      return runner.setScopeContext(command.reference, command.recentRecords, command.model);
    case "scope_review":
      if (!runner) return emit(failedScopeReview(command.requestId, "还没启动就要范围审视"));
      // 等审视做完：排在后面的命令（含 exit，闲置退出）等它，结果先交给守护进程
      return runner.reviewScope(command.requestId, command.reference, command.model);
    case "compact":
      if (!runner) return emit(errorReport("bad_command", "还没启动就要压缩"));
      try {
        await runner.compact();
      } catch (err) {
        // 结局（没什么可压、没压成）已经在压缩结束时以 compacted 报了（114 号票），这里只记一行日志
        process.stderr.write(`手动压缩没做成：${err instanceof Error ? err.message : String(err)}\n`);
      }
      return;
    case "navigate_session":
      if (!runner) return emit({ type: "session_navigated", requestId: command.requestId, ok: false, error: "还没启动就要在会话树上挪" });
      // 挪完才处理排在后面的命令（含 exit）：结果先交给守护进程
      return runner.navigate(command);
    case "write_handoff":
      if (!runner) return emit({ type: "handoff_written", requestId: command.requestId, error: "还没启动就要写交接摘要" });
      // 写完才处理排在后面的命令（含 exit）：结果先交给守护进程
      return runner.writeHandoff(command);
    case "guard_reply":
      if (!runner) return emit(errorReport("bad_command", "还没启动就送了守卫判定"));
      return runner.replyGuard(command.requestId, command.verdict);
    case "host_tool_result":
      if (!runner) return emit(errorReport("bad_command", "还没启动就送了工具结果"));
      return runner.replyHostTool(command.requestId, command.result);
    case "ask_user_reply":
      // pi 自己不问用户（宿主协议 23 的 ask_user 只有 Claude Code 这类运行时报）：没有在等的
      return emit(errorReport("bad_command", `没有在等的回答：${command.requestId}`));
    case "abort":
      await runner?.abort();
      return;
    case "exit":
      return shutdown(0);
    case "work_order":
      return emit(errorReport("unsupported", `这个版本还没实现 ${command.type}`));
    default:
      return emit(errorReport("bad_command", `不认识的命令：${JSON.stringify(command)}`));
  }
}

async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (heartbeat) clearInterval(heartbeat);
  try {
    runner?.dispose();
  } catch (err) {
    process.stderr.write(`关闭会话出错：${String(err)}\n`);
  }
  // 等 stdout 写完再退出，免得最后几条消息丢掉
  process.stdout.write("", () => process.exit(code));
}

readJsonLines<HostCommand>(
  process.stdin,
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
