// agent 子进程入口：由守护进程用 `node main.ts` 拉起，stdin / stdout 上跑 agent 宿主协议。
// 收到"启动"之前什么都不做（守护进程先把本进程放进 Job 对象，再送"启动"）。
import { HOST_PROTOCOL_VERSION, type AgentReport, type HostCommand } from "../host-protocol.ts";
import { encodeLine, LineDecoder } from "../line-channel.ts";
import { openAgentSession, type AgentSessionHost } from "./session.ts";

let host: AgentSessionHost | undefined;
let heartbeat: NodeJS.Timeout | undefined;
let shuttingDown = false;
// 命令按到达顺序逐条处理（"启动"是异步的，后面的输入要排在它后面）
let queue: Promise<void> = Promise.resolve();

function emit(report: AgentReport): void {
  process.stdout.write(encodeLine(report));
}

function reportError(code: Extract<AgentReport, { type: "error" }>["code"], message: string, fatal = false): void {
  emit({ type: "error", code, message, fatal });
}

async function handle(command: HostCommand): Promise<void> {
  switch (command.type) {
    case "start": {
      if (host) return reportError("bad_command", "已经启动过了");
      if (command.protocolVersion !== HOST_PROTOCOL_VERSION) {
        reportError("start_failed", `宿主协议版本不符：守护进程 ${command.protocolVersion}，子进程 ${HOST_PROTOCOL_VERSION}`, true);
        return shutdown(1);
      }
      try {
        host = await openAgentSession(command.session, emit);
      } catch (err) {
        reportError("start_failed", err instanceof Error ? (err.stack ?? err.message) : String(err), true);
        return shutdown(1);
      }
      heartbeat = setInterval(() => emit({ type: "heartbeat", at: Date.now() }), command.session.heartbeatIntervalMs);
      emit({ type: "ready", pid: process.pid, sessionId: host.sessionId, sessionFile: host.sessionFile, loaded: host.loaded });
      return;
    }
    case "user_input":
      if (!host) return reportError("bad_command", "还没启动就送了输入");
      host.prompt(command.text);
      return;
    case "abort":
      await host?.abort();
      return;
    case "exit":
      return shutdown(0);
    case "work_order":
    case "interject":
    case "guard_reply":
      return reportError("unsupported", `这个版本还没实现 ${command.type}`);
    default:
      return reportError("bad_command", `不认识的命令：${JSON.stringify(command)}`);
  }
}

async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (heartbeat) clearInterval(heartbeat);
  try {
    host?.dispose();
  } catch (err) {
    process.stderr.write(`关闭会话出错：${String(err)}\n`);
  }
  // 等 stdout 写完再退出，免得最后几条消息丢掉
  process.stdout.write("", () => process.exit(code));
}

const decoder = new LineDecoder();
const onLine = (line: string) => {
  let command: HostCommand;
  try {
    command = JSON.parse(line) as HostCommand;
  } catch {
    reportError("bad_command", `无法解析的命令：${line}`);
    return;
  }
  queue = queue.then(() => handle(command)).catch((err: unknown) => reportError("internal", String(err)));
};
process.stdin.on("data", (chunk: Buffer) => decoder.push(chunk).forEach(onLine));
// 守护进程关掉 stdin（或者守护进程没了）就正常退出
process.stdin.on("end", () => {
  decoder.end().forEach(onLine);
  queue = queue.then(() => shutdown(0));
});
