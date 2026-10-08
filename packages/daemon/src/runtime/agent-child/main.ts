// agent 子进程入口：由守护进程用 `node main.ts` 拉起，stdin / stdout 上跑 agent 宿主协议。
// 收到"启动"之前什么都不做（守护进程先把本进程放进 Job 对象，再送"启动"）。
import { errorReport, HOST_PROTOCOL_VERSION, type AgentReport, type HostCommand } from "../host-protocol.ts";
import { encodeLine, readJsonLines } from "../line-channel.ts";
import { openAgentSession, type AgentSessionRunner } from "./session.ts";

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
      emit({ type: "ready", pid: process.pid, sessionId: runner.sessionId, sessionFile: runner.sessionFile, session: runner.session, loaded: runner.loaded });
      return;
    }
    case "user_input":
      if (!runner) return emit(errorReport("bad_command", "还没启动就送了输入"));
      return runner.prompt(command.inputId, command.text, command.images ?? [], command.context);
    case "interject":
      if (!runner) return emit(errorReport("bad_command", "还没启动就送了插话", false, command.inputId));
      return runner.interject(command.inputId, command.text);
    case "context_block":
      if (!runner) return emit(errorReport("bad_command", "还没启动就送了重注入块"));
      return runner.setContextBlock(command.text);
    case "compact":
      if (!runner) return emit(errorReport("bad_command", "还没启动就要压缩"));
      try {
        await runner.compact();
      } catch (err) {
        emit(errorReport("internal", `压缩没做成：${err instanceof Error ? err.message : String(err)}`));
      }
      return;
    case "guard_reply":
      if (!runner) return emit(errorReport("bad_command", "还没启动就送了守卫判定"));
      return runner.replyGuard(command.requestId, command.verdict);
    case "host_tool_result":
      if (!runner) return emit(errorReport("bad_command", "还没启动就送了工具结果"));
      return runner.replyHostTool(command.requestId, command.result);
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
