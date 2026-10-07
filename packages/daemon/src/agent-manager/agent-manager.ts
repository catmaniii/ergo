// agent 管家：拉起 agent 子进程，替它装配会话参数、显式注入环境、放进 Job 对象。
// 数量上限、排队、闲置退出、超时、孤儿回收在 12 号票加。
import fs from "node:fs";
import path from "node:path";
import type { DataDirLayout } from "../config/data-dir.ts";
import { TOOL } from "../guard/index.ts";
import { buildChildEnv, OFFLINE_SHELL_ENV } from "../process/child-env.ts";
import type { JobObject } from "../process/job-object.ts";
import {
  runSessionRewrite,
  spawnAgentProcess,
  type AgentProcess,
  type HostToolSpec,
  type ModelSpec,
  type SessionRewriteRequest,
  type SessionRewriteResult,
} from "../runtime/index.ts";

export interface SpawnAgentRequest {
  /** agent 的标识，也是它在会话区里的子目录名 */
  agentId: string;
  model: ModelSpec;
  /** 工具白名单（pi 的内置工具）。联网开关关着时，装配会去掉首次使用要下载外部程序的（assembledPiTools） */
  tools: string[];
  /** 守护进程代为执行的工具（调用由拉起它的模块处理 host_tool_call、回 host_tool_result） */
  hostTools?: HostToolSpec[];
  /** 工作目录；不填时用临时区下的 agents/<agentId> */
  cwd?: string;
  /** provider id → API key */
  credentials?: Record<string, string>;
  skillPaths?: string[];
  /** 固定的系统提示（替换 pi 默认的编程助手提示） */
  systemPrompt?: string;
  /** 接着会话目录里最近的会话（秘书的长期主线会话）；默认每次新开 */
  continueSession?: boolean;
  /** 显式给子进程的额外环境变量 */
  env?: Record<string, string>;
  /**
   * 每次工具调用先送守护进程做守卫判定。正式的会话都要打开（07 号票起），并用 GuardRuntime.attach 接上守卫；
   * 默认关只为测试里直接拉起、自己回判定的 agent
   */
  forwardToolCalls?: boolean;
  /**
   * 工具包的联网开关。关着（默认；秘书一律关着）时，bash 起的进程环境里代理地址设成无效值（OFFLINE_SHELL_ENV），
   * 让常见的联网方式失败，也不给首次使用要下载外部程序的 pi 工具（grep、find）；守卫另按开关拒绝联网的工具和命令
   */
  network?: boolean;
  heartbeatIntervalMs?: number;
}

export interface AgentManager {
  spawn(request: SpawnAgentRequest): AgentProcess;
  /**
   * 改写某个 agent 会话目录里的会话文件（彻底删除，21 号票）：一次性子进程做，会话文件的形状只在子进程那一层认。
   * 这个 agent 的子进程还活着时拒绝（内存里还有原文，调用方先停掉它，改完再拉起）
   */
  rewriteSessions(agentId: string, request: Omit<SessionRewriteRequest, "sessionDir">): Promise<SessionRewriteResult>;
  /** 结束所有还活着的子进程，等它们退出 */
  shutdown(): Promise<void>;
}

export interface AgentManagerOptions {
  layout: DataDirLayout;
  /** 守护进程自己的环境：只从中挑系统变量给子进程 */
  parentEnv: Readonly<Record<string, string | undefined>>;
  job: JobObject | undefined;
  log?: (line: string) => void;
}

const DEFAULT_HEARTBEAT_MS = 10_000;

/**
 * pi 的内置工具里首次使用时会去网上下载外部程序的：grep 下载 rg、find 下载 fd。
 * 联网开关关着的会话（秘书、联网关着的维护者）装配时不给它们，要搜索就在 bash 里用 Git Bash 自带的 grep、find
 */
export const DOWNLOADS_ON_FIRST_USE: readonly string[] = [TOOL.grep, TOOL.find];

/** 装配给 pi 的内置工具：联网开关关着时去掉首次使用要下载外部程序的。守卫眼里的工具包也照这个算 */
export function assembledPiTools(tools: readonly string[], network: boolean): string[] {
  return network ? [...tools] : tools.filter((t) => !DOWNLOADS_ON_FIRST_USE.includes(t));
}

/** agent 的会话目录（pi 的会话文件放在这里）：会话区下的 <agentId> */
export function agentSessionDir(layout: DataDirLayout, agentId: string): string {
  return path.join(layout.sessions, agentId);
}

/** agent 没指定工作目录时用的：临时区下的 agents/<agentId>（秘书的工作目录是草稿区 DataDirLayout.scratch，不用它） */
export function defaultAgentCwd(layout: DataDirLayout, agentId: string): string {
  return path.join(layout.tmp, "agents", agentId);
}
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function createAgentManager(options: AgentManagerOptions): AgentManager {
  const { layout } = options;
  const log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
  // 交给 pi 当"全局配置目录"的空目录：pi 不再去读 ~/.pi/agent
  const piAgentDir = path.join(layout.tmp, "pi-agent");
  const live = new Set<AgentProcess>();

  return {
    spawn(request) {
      if (!AGENT_ID.test(request.agentId)) throw new Error(`agent 标识不合法：${request.agentId}`);
      const sessionDir = agentSessionDir(layout, request.agentId);
      const cwd = request.cwd ?? defaultAgentCwd(layout, request.agentId);
      for (const dir of [sessionDir, cwd, piAgentDir]) fs.mkdirSync(dir, { recursive: true });

      const agent = spawnAgentProcess({
        session: {
          agentId: request.agentId,
          cwd,
          sessionDir,
          piAgentDir,
          model: request.model,
          credentials: request.credentials ?? {},
          tools: assembledPiTools(request.tools, request.network === true),
          hostTools: request.hostTools ?? [],
          skillPaths: request.skillPaths ?? [],
          ...(request.systemPrompt === undefined ? {} : { systemPrompt: request.systemPrompt }),
          continueSession: request.continueSession ?? false,
          forwardToolCalls: request.forwardToolCalls ?? false,
          shellEnv: request.network === true ? {} : { ...OFFLINE_SHELL_ENV },
          heartbeatIntervalMs: request.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS,
        },
        env: buildChildEnv(options.parentEnv, request.env),
        job: options.job,
        onLog: (line) => log(`[agent ${request.agentId}] ${line}`),
      });
      live.add(agent);
      void agent.exited.then(() => live.delete(agent));
      return agent;
    },
    rewriteSessions(agentId, request) {
      if (!AGENT_ID.test(agentId)) return Promise.reject(new Error(`agent 标识不合法：${agentId}`));
      if ([...live].some((a) => a.agentId === agentId)) return Promise.reject(new Error(`agent ${agentId} 还在运行：先停掉它再改写会话文件`));
      return runSessionRewrite(
        { ...request, sessionDir: agentSessionDir(layout, agentId) },
        { env: buildChildEnv(options.parentEnv, {}), job: options.job, onLog: (line) => log(`[改写会话 ${agentId}] ${line}`) },
      );
    },
    async shutdown() {
      const exits = [...live].map((agent) => {
        agent.kill();
        return agent.exited;
      });
      await Promise.all(exits);
    },
  };
}
