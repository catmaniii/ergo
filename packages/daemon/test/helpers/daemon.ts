// 在临时数据目录里起一个守护进程实例（测试的一部分，用完即销毁，不算服务），并拉起接 faux provider 的 agent。
import { onTestFinished } from "vitest";
import type { SpawnAgentRequest } from "../../src/agent-manager/agent-manager.ts";
import { startDaemon, type Daemon } from "../../src/daemon.ts";
import type { AgentProcess, FauxModelSpec, FauxStep } from "../../src/runtime/index.ts";
import { ReportLog } from "./report-log.ts";
import { makeTempDir } from "./temp-dir.ts";
import { tempUserProfileEnv, withEnv } from "./user-profile.ts";

export interface TestDaemon {
  daemon: Daemon;
  dataDir: string;
  /** 守护进程和它的 agent 子进程眼里的用户主目录（临时目录） */
  homeDir: string;
}

/**
 * 起一个守护进程实例：
 * - 数据目录是临时目录；
 * - 守护进程的环境取当前进程的环境，但 HOME、USERPROFILE、APPDATA、LOCALAPPDATA、HOMEDRIVE、HOMEPATH
 *   都换成临时主目录下的路径。守护进程按白名单把它们传给 agent 子进程，所以子进程看不到真实的用户主目录；
 * - options.env 再覆盖在上面（用来放哨兵变量之类）；
 * - 测试结束时停掉守护进程（关闭 Job 对象，残留的子进程一并清掉），再删目录。
 */
export async function startTestDaemon(options: { env?: Record<string, string | undefined> } = {}): Promise<TestDaemon> {
  const dataDir = makeTempDir("ergou-data-");
  const homeDir = makeTempDir("ergou-home-");
  const daemon = await startDaemon({
    env: withEnv(process.env, tempUserProfileEnv(homeDir), options.env ?? {}, { ERGOU_DATA_DIR: dataDir }),
    homeDir,
  });
  onTestFinished(() => daemon.stop());
  return { daemon, dataDir, homeDir };
}

/** faux 模型：按剧本回话，不连网 */
export function fauxModel(script: FauxStep[], options: { tokensPerSecond?: number } = {}): FauxModelSpec {
  return { kind: "faux", thinkingLevel: "off", script, ...options };
}

/**
 * 拉起一个 agent 并开始记录它发来的消息。测试结束时先结束这个子进程
 * （它的工作目录可能是测试里建的临时目录，进程不退出目录删不掉）。
 */
export function spawnTestAgent(daemon: Daemon, request: SpawnAgentRequest): { agent: AgentProcess; log: ReportLog } {
  const agent = daemon.agents.spawn(request);
  const log = new ReportLog(agent);
  onTestFinished(async () => {
    agent.kill();
    await agent.exited;
  });
  return { agent, log };
}
