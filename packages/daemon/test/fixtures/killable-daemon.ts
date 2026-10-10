// 测试用的守护进程（被杀后的恢复，23 号票）：在独立进程里起一个守护进程实例（临时数据目录、系统挑的端口、faux 模型），
// 好让测试像 LSM 重启时那样直接杀掉它（连带 Job 对象里的 agent 子进程和孙进程）。测试本身扮演前端，经 WebSocket 连它。
//
// 用法：node killable-daemon.ts '<JSON 参数>'（KillableDaemonArgs）。起来后往 stdout 报一行 { ready: { url, externalUrl, pid } }，之后：
// - guard 频道每追加一条事件报一行 { guard: { type, payload } }（审批、开始执行、结束……）；
// - 守护进程拉起之后唤起的 agent（维护者、评审、子 agent）报 { agent: { agentId, pid } }，守卫放行它的一次调用时报
//   { allowed: { agentId, toolCallId, toolName } }（之后这次调用就在执行了）；
// - stdin 每收到一行 "pids"，报一行 { pids: { job, agents } }：Job 对象里的全部进程、活着的 agent 子进程。
// 然后一直挂着，等测试来杀。
import { startDaemon } from "../../src/daemon.ts";
import { GUARD_CHANNEL } from "../../src/guard-runtime/events.ts";
import type { AgentReport, FauxStep, HostCommand } from "../../src/runtime/index.ts";
import { readLines } from "../../src/runtime/line-channel.ts";
import { NO_LSM_ENV, tempUserProfileEnv, withEnv } from "../helpers/user-profile.ts";
import { FAKE_RECOGNIZER } from "../helpers/voice.ts";
import { fakeWebAccess } from "../helpers/web.ts";

export interface KillableDaemonArgs {
  dataDir: string;
  homeDir: string;
  webRoot: string;
  programDir: string;
  /** 秘书的 faux 剧本 */
  secretary: FauxStep[];
  secretaryTokensPerSecond?: number;
  /** 维护者的 faux 剧本：维护者 id → 第几次唤起（从 1 起）的剧本；没给的唤起得到空剧本（一调用就出错） */
  maintainer: Record<string, FauxStep[][]>;
  /** 并行派出的子 agent（20 号票）的 faux 剧本：子 agent id（sa-<n>）→ 剧本；没给的得到空剧本 */
  subAgent?: Record<string, FauxStep[]>;
}

const args = JSON.parse(process.argv[2] ?? "{}") as KillableDaemonArgs;

function out(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const faux = (script: FauxStep[], tokensPerSecond?: number) => ({ kind: "faux" as const, thinkingLevel: "off" as const, script, ...(tokensPerSecond === undefined ? {} : { tokensPerSecond }) });

// 和 startTestDaemon 一样：用户目录类变量换成临时主目录，两个端口都由系统挑（不占 8810、8811）
const daemon = await startDaemon({
  env: withEnv(process.env, NO_LSM_ENV, tempUserProfileEnv(args.homeDir), { ERGOU_DATA_DIR: args.dataDir }),
  homeDir: args.homeDir,
  localPort: 0,
  externalPort: 0,
  webRoot: args.webRoot,
  programDir: args.programDir,
  secretaryModel: faux(args.secretary, args.secretaryTokensPerSecond),
  maintainerModel: (maintainerId, spawn) => faux(args.maintainer[maintainerId]?.[spawn - 1] ?? []),
  reviewerModel: () => faux([]),
  subAgentModel: (agentId) => faux(args.subAgent?.[agentId] ?? []),
  // 和 startTestDaemon 一样：识别进程是假的、合成服务连不上（45 号票起守护进程一起来就预热，不能拉真的 Python、碰本机 8090）
  recognizerCommand: [process.execPath, FAKE_RECOGNIZER],
  speechUrl: "http://127.0.0.1:1",
  // 和 startTestDaemon 一样：联网搜索、读网页是假的（不起浏览器、不连真网络），不探测本机的浏览器（70 号票）
  webAccess: fakeWebAccess(),
  browserPath: () => undefined,
  // 和 startTestDaemon 一样：按设置里的"模型"拉起的目录模型的请求发到连不上的地址，永远不连真的 DeepSeek（73 号票）
  catalogBaseUrl: "http://127.0.0.1:1",
  log:(line) => process.stderr.write(`${line}\n`),
});

daemon.store.onAppend((event) => {
  if (event.channel === GUARD_CHANNEL) out({ guard: { type: event.type, payload: event.payload } });
});

// 之后唤起的 agent：报 pid，守卫放行一次调用时报出来（测试据此知道它正在执行）
const spawn = daemon.agents.spawn.bind(daemon.agents);
daemon.agents.spawn = (request) => {
  const agent = spawn(request);
  const pending = new Map<string, { toolCallId: string; toolName: string }>();
  agent.onReport((report: AgentReport) => {
    if (report.type === "ready") out({ agent: { agentId: agent.agentId, pid: report.pid } });
    if (report.type === "guard_request") pending.set(report.requestId, { toolCallId: report.toolCallId, toolName: report.toolName });
  });
  const send = agent.send.bind(agent);
  agent.send = (command: Exclude<HostCommand, { type: "start" }>) => {
    send(command);
    if (command.type === "guard_reply" && command.verdict.allow) {
      const call = pending.get(command.requestId);
      if (call) out({ allowed: { agentId: agent.agentId, ...call } });
    }
  };
  return agent;
};

readLines(process.stdin, (line) => {
  if (line.trim() === "pids") out({ pids: { job: daemon.job?.processIds() ?? [], agents: daemon.agents.live() } });
});

out({ ready: { url: daemon.localUrl, externalUrl: daemon.externalUrl, pid: process.pid, secretaryPid: daemon.secretary.pid ?? null } });

// 一直挂着，等测试来杀
setInterval(() => {}, 60_000);
