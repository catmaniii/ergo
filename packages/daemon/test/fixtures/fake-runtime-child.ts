// 测试用的假运行时的子进程（286 号票，只在测试里）：不跑任何模型，只实现宿主协议里维护者跑一轮要的那几条——
// start → ready；user_input → 一条回复（"假运行时收到了（第 n 条）"）、turn_end；abort 中止手头这一轮；exit 退出；别的回 unsupported。
// 输入里有"【慢】"时等 SLOW_MS 才回（测插件停用时手头那一轮做完再停）。起来时在 stderr 写一行，守护进程的日志里认得出是它。
// 和 pi 的子进程（runtime/agent-child/main.ts）收同一条"启动"、说同一套消息：宿主协议就是运行时的接缝。
import { type AgentReport, errorReport, HOST_PROTOCOL_VERSION, type HostCommand } from "../../src/runtime/host-protocol.ts";
import { encodeLine, readJsonLines } from "../../src/runtime/line-channel.ts";

/** 带"【慢】"的输入等多久才回（毫秒） */
const SLOW_MS = 3000;

let started = false;
/** 手头这一轮（慢的那种）：到点回复 */
let turn: { timer: NodeJS.Timeout } | undefined;
let replies = 0;

const emit = (report: AgentReport) => {
  process.stdout.write(encodeLine(report));
};

process.stderr.write("假运行时的子进程起来了\n");

function reply(): void {
  replies += 1;
  const messageId = `fake-reply-${replies}`;
  const text = `假运行时收到了（第 ${replies} 条）`;
  emit({ type: "stream_delta", messageId, part: "text", delta: text });
  emit({ type: "message_final", messageId, message: { role: "assistant", parts: [{ type: "text", text }], stopReason: "done" } });
  emit({ type: "turn_end", outcome: "completed" });
}

function handle(command: HostCommand): void {
  switch (command.type) {
    case "start": {
      if (command.protocolVersion !== HOST_PROTOCOL_VERSION) {
        emit(errorReport("start_failed", `宿主协议版本不符：守护进程 ${command.protocolVersion}，假运行时 ${HOST_PROTOCOL_VERSION}`, true));
        process.exit(1);
      }
      started = true;
      setInterval(() => emit({ type: "heartbeat", at: Date.now() }), command.session.heartbeatIntervalMs).unref();
      emit({
        type: "ready",
        pid: process.pid,
        sessionId: `fake-${command.session.agentId}`,
        sessionFile: "",
        session: command.session.session ?? "fake",
        loaded: { tools: [], skills: [], contextFiles: [], extensions: [], credentialProviders: [] },
        vision: false,
        model: { provider: "fake", modelId: "fake", thinkingLevel: "off", pinned: false },
        context: { window: 100_000, reserveTokens: 0, keepRecentTokens: 0 },
      });
      return;
    }
    case "user_input":
      if (!started) return emit(errorReport("bad_command", "还没启动就送了输入"));
      if (turn) return emit(errorReport("busy", "上一轮还没完"));
      if (!command.text.includes("【慢】")) return reply();
      turn = {
        timer: setTimeout(() => {
          turn = undefined;
          reply();
        }, SLOW_MS),
      };
      return;
    case "abort":
      if (!turn) return;
      clearTimeout(turn.timer);
      turn = undefined;
      emit({ type: "turn_end", outcome: "aborted" });
      return;
    case "exit":
      process.exit(0);
      return;
    case "interject":
      return emit(errorReport("bad_command", "没有进行中的回合", false, command.inputId));
    default:
      return emit(errorReport("unsupported", `假运行时不做 ${command.type}`));
  }
}

readJsonLines<HostCommand>(process.stdin, handle, { onInvalid: () => {}, onEnd: () => process.exit(0) });
