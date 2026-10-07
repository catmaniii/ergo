// agent 管家：拉起 agent 子进程，替它装配会话参数、显式注入环境、放进 Job 对象。
// 数量上限、排队、闲置退出、超时、孤儿回收在 12 号票加。
import fs from "node:fs";
import path from "node:path";
import type { DataDirLayout } from "../config/data-dir.ts";
import { buildChildEnv } from "../process/child-env.ts";
import type { JobObject } from "../process/job-object.ts";
import { spawnAgentProcess, type AgentProcess, type ModelSpec } from "../runtime/index.ts";

export interface SpawnAgentRequest {
  /** agent 的标识，也是它在会话区里的子目录名 */
  agentId: string;
  model: ModelSpec;
  /** 工具白名单 */
  tools: string[];
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
  /** 每次工具调用先送守护进程做守卫判定（默认关；07 号票起所有会话都开） */
  forwardToolCalls?: boolean;
  heartbeatIntervalMs?: number;
}

export interface AgentManager {
  spawn(request: SpawnAgentRequest): AgentProcess;
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
      const sessionDir = path.join(layout.sessions, request.agentId);
      const cwd = request.cwd ?? path.join(layout.tmp, "agents", request.agentId);
      for (const dir of [sessionDir, cwd, piAgentDir]) fs.mkdirSync(dir, { recursive: true });

      const agent = spawnAgentProcess({
        session: {
          agentId: request.agentId,
          cwd,
          sessionDir,
          piAgentDir,
          model: request.model,
          credentials: request.credentials ?? {},
          tools: request.tools,
          skillPaths: request.skillPaths ?? [],
          ...(request.systemPrompt === undefined ? {} : { systemPrompt: request.systemPrompt }),
          continueSession: request.continueSession ?? false,
          forwardToolCalls: request.forwardToolCalls ?? false,
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
    async shutdown() {
      const exits = [...live].map((agent) => {
        agent.kill();
        return agent.exited;
      });
      await Promise.all(exits);
    },
  };
}
