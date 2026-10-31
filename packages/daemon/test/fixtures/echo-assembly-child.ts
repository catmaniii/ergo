// 测试用的"把装配参数交回来"的子进程（自定义服务商这一步）：不跑任何模型。收到"启动"就把这次收到的装配参数
// （HostCommand.start.session）原样写进环境变量 ERGO_TEST_ASSEMBLY_FILE 指的那个文件，报一条最小的 ready，然后退出。
// 主切面不用它；模块层的测试借它看"agent 管家拉起的装配里到底带了什么"（模板照 fixtures/fake-runtime-child.ts）。
import fs from "node:fs";
import { type AgentReport, errorReport, HOST_PROTOCOL_VERSION, type HostCommand } from "../../src/runtime/host-protocol.ts";
import { encodeLine, readJsonLines } from "../../src/runtime/line-channel.ts";

const emit = (report: AgentReport) => {
  process.stdout.write(encodeLine(report));
};

function handle(command: HostCommand): void {
  if (command.type !== "start") {
    emit(errorReport("unsupported", `只认"启动"，收到的是 ${command.type}`));
    return;
  }
  if (command.protocolVersion !== HOST_PROTOCOL_VERSION) {
    emit(errorReport("start_failed", `宿主协议版本不符：守护进程 ${command.protocolVersion}，回声子进程 ${HOST_PROTOCOL_VERSION}`, true));
    process.exit(1);
  }
  const file = process.env.ERGO_TEST_ASSEMBLY_FILE;
  if (file !== undefined) fs.writeFileSync(file, JSON.stringify(command.session), "utf8");
  emit({
    type: "ready",
    pid: process.pid,
    sessionId: `echo-${command.session.agentId}`,
    sessionFile: "",
    session: command.session.session ?? "echo",
    loaded: { tools: [], skills: [], contextFiles: [], extensions: [], credentialProviders: [] },
    vision: false,
    model: { provider: "echo", modelId: "echo", thinkingLevel: "off", pinned: false },
    context: { window: 100_000, reserveTokens: 0, keepRecentTokens: 0 },
  });
  // 交回装配参数就够了，不留这个进程
  process.exit(0);
}

readJsonLines<HostCommand>(process.stdin, handle, { onInvalid: () => {}, onEnd: () => process.exit(0) });
