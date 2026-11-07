// 测试用的"停在一个工具调用上"的子进程（411 体检：agent 管家报每个 agent 停在哪一步）：不跑任何模型。
// start → ready（留着不退）；user_input → 报一条 tool_call_start（工具名就是输入的文字），然后一直不结束；
// abort → 这次调用结束、turn_end(aborted)；exit 退出。模板照 fixtures/fake-runtime-child.ts。
import { type AgentReport, errorReport, HOST_PROTOCOL_VERSION, type HostCommand } from "../../src/runtime/host-protocol.ts";
import { encodeLine, readJsonLines } from "../../src/runtime/line-channel.ts";

const emit = (report: AgentReport) => {
  process.stdout.write(encodeLine(report));
};

/** 正停着的那次调用 */
let calling: { id: string; tool: string } | undefined;

function handle(command: HostCommand): void {
  switch (command.type) {
    case "start":
      if (command.protocolVersion !== HOST_PROTOCOL_VERSION) {
        emit(errorReport("start_failed", `宿主协议版本不符：守护进程 ${command.protocolVersion}，测试子进程 ${HOST_PROTOCOL_VERSION}`, true));
        process.exit(1);
      }
      emit({
        type: "ready",
        pid: process.pid,
        sessionId: `stuck-${command.session.agentId}`,
        sessionFile: "",
        session: command.session.session ?? "stuck",
        loaded: { tools: [], skills: [], contextFiles: [], extensions: [], credentialProviders: [] },
        vision: false,
        model: { provider: "stuck", modelId: "stuck", thinkingLevel: "off", pinned: false },
        context: { window: 100_000, reserveTokens: 0, keepRecentTokens: 0 },
      });
      return;
    case "user_input":
      calling = { id: `call-${command.inputId}`, tool: command.text };
      emit({ type: "tool_call_start", toolCallId: calling.id, toolName: calling.tool, args: {} });
      return;
    case "abort":
      if (calling) emit({ type: "tool_call_end", toolCallId: calling.id, toolName: calling.tool, isError: true, resultText: "aborted" });
      calling = undefined;
      emit({ type: "turn_end", outcome: "aborted" });
      return;
    case "exit":
      process.exit(0);
      return;
    default:
      emit(errorReport("unsupported", `测试子进程不做 ${command.type}`));
  }
}

readJsonLines<HostCommand>(process.stdin, handle, { onInvalid: () => {}, onEnd: () => process.exit(0) });
