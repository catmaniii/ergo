// 在临时数据目录里起一个守护进程实例（测试的一部分，用完即销毁，不算服务，不在 LSM 登记），
// 秘书接 faux provider 按剧本回话；也能另外拉起接 faux provider 的 agent。
import fs from "node:fs";
import path from "node:path";
import { onTestFinished } from "vitest";
import type { SpawnAgentRequest } from "../../src/agent-manager/agent-manager.ts";
import type { CardTypeDefinition } from "../../src/cards/registry.ts";
import { startDaemon, type Daemon } from "../../src/daemon.ts";
import type { Embedder } from "../../src/materials/embedding/embedder.ts";
import type { AgentProcess, FauxModelSpec, FauxStep, ModelSpec } from "../../src/runtime/index.ts";
import type { Clock } from "../../src/scheduler/clock.ts";
import { FakeEmbedder } from "./embedder.ts";
import { ReportLog } from "./report-log.ts";
import { makeTempDir } from "./temp-dir.ts";
import { tempUserProfileEnv, withEnv } from "./user-profile.ts";

export interface TestDaemon {
  daemon: Daemon;
  dataDir: string;
  /** 守护进程和它的 agent 子进程眼里的用户主目录（临时目录） */
  homeDir: string;
  /** 本机端口的地址，如 http://127.0.0.1:54321（端口由系统挑，不占配置里的 8810） */
  url: string;
  /** 外网端口的地址（隧道的目标；端口由系统挑，不占配置里的 8811） */
  externalUrl: string;
  /** 网关提供的 Web UI 静态文件所在的目录（临时目录，里面是一个测试页） */
  webRoot: string;
}

export interface StartTestDaemonOptions {
  /** 秘书的 faux 剧本：每一步对应一次模型调用；不填则秘书一被调用就得到错误回复 */
  secretary?: FauxStep[];
  /** 秘书流式输出的速度（token/秒）；不填则尽快吐完 */
  secretaryTokensPerSecond?: number;
  /** 直接指定秘书的模型（比如一个装配不起来的模型，测秘书起不来）；给了就不看 secretary 剧本 */
  secretaryModel?: ModelSpec;
  /** 秘书不在运行超过这么久 /healthz 报不健康（默认 30 秒） */
  secretaryDownThresholdMs?: number;
  /** 覆盖在守护进程环境上的变量（比如哨兵变量、模型 key） */
  env?: Record<string, string | undefined>;
  /** 沿用已有的数据目录和主目录（测"停掉再起"）；不填就新建临时目录 */
  reuse?: { dataDir: string; homeDir: string };
  /** Web UI 静态文件目录；不填就建一个临时目录，放一个测试页 */
  webRoot?: string;
  /** 两个端口照配置文件来（测"端口号从配置读"）；默认都由系统挑空闲端口，免得占用真正的 8810、8811 */
  portFromConfig?: boolean;
  /** WebSocket 心跳的间隔（毫秒）；默认 30 秒 */
  heartbeatIntervalMs?: number;
  /** 时钟（比如 ManualClock，到点不靠真等）；不填用系统时钟 */
  clock?: Clock;
  /** 额外登记（或替换）的卡片类型（比如 card-fixtures.ts 里的替身） */
  cardTypes?: readonly CardTypeDefinition[];
  /**
   * 素材的向量函数：默认是假的（embedder.ts 的 FakeEmbedder，不下载、不跑真模型）；
   * 写 "bge-m3" 用正式的（数据目录是临时的，模型区是空的，所以总是"模型不在"）
   */
  embedder?: Embedder | "bge-m3";
}

/** 测试页的内容：网关应当原样提供它 */
export const TEST_PAGE = "<!doctype html><html><head><title>二狗测试页</title></head><body><div id=\"root\"></div></body></html>\n";

/**
 * 起一个守护进程实例：
 * - 数据目录是临时目录；本机端口和外网端口都由系统挑空闲端口（都只听 127.0.0.1）；
 * - 秘书的模型换成 faux provider（按 options.secretary 的剧本回话），子进程真的拉起；
 * - 守护进程的环境取当前进程的环境，但 HOME、USERPROFILE、APPDATA、LOCALAPPDATA、HOMEDRIVE、HOMEPATH
 *   都换成临时主目录下的路径。守护进程按白名单把它们传给 agent 子进程，所以子进程看不到真实的用户主目录；
 * - options.env 再覆盖在上面（用来放哨兵变量之类）；
 * - 测试结束时停掉守护进程（关闭端口、关闭 Job 对象，残留的子进程一并清掉），再删目录。
 */
export async function startTestDaemon(options: StartTestDaemonOptions = {}): Promise<TestDaemon> {
  const dataDir = options.reuse?.dataDir ?? makeTempDir("ergou-data-");
  const homeDir = options.reuse?.homeDir ?? makeTempDir("ergou-home-");
  const webRoot = options.webRoot ?? makeTestWebRoot();
  const daemon = await startDaemon({
    env: withEnv(process.env, tempUserProfileEnv(homeDir), options.env ?? {}, { ERGOU_DATA_DIR: dataDir }),
    homeDir,
    ...(options.portFromConfig ? {} : { localPort: 0, externalPort: 0 }),
    webRoot,
    secretaryModel:
      options.secretaryModel ??
      fauxModel(options.secretary ?? [], options.secretaryTokensPerSecond === undefined ? {} : { tokensPerSecond: options.secretaryTokensPerSecond }),
    ...(options.secretaryDownThresholdMs === undefined ? {} : { secretaryDownThresholdMs: options.secretaryDownThresholdMs }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.cardTypes === undefined ? {} : { extraCardTypes: options.cardTypes }),
    ...(options.embedder === "bge-m3" ? {} : { embedder: options.embedder ?? new FakeEmbedder() }),
    ...(options.heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
    log: () => {},
  });
  onTestFinished(() => daemon.stop());
  return { daemon, dataDir, homeDir, url: daemon.localUrl, externalUrl: daemon.externalUrl, webRoot };
}

function makeTestWebRoot(): string {
  const dir = makeTempDir("ergou-web-");
  fs.writeFileSync(path.join(dir, "index.html"), TEST_PAGE);
  return dir;
}

/** faux 模型：按剧本回话，不连网 */
export function fauxModel(script: FauxStep[], options: { tokensPerSecond?: number } = {}): FauxModelSpec {
  return { kind: "faux", thinkingLevel: "off", script, ...options };
}

/**
 * 从现在起数守护进程拉起了几个 agent 子进程（测"到点的提醒不拉起任何 agent"这类）。
 * 测试接缝：包一层 agent 管家的 spawn（秘书和别的模块拿的是同一个管家对象），不放进正式接口。
 */
export function countAgentSpawns(daemon: Daemon): () => number {
  let count = 0;
  const spawn = daemon.agents.spawn.bind(daemon.agents);
  daemon.agents.spawn = (request) => {
    count += 1;
    return spawn(request);
  };
  return () => count;
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
