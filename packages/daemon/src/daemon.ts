// 守护进程的组装：读配置、找到数据目录、建 Job 对象、立起 agent 管家。
// 网关（两个监听端口）在 04 号票加；本票不开任何端口。
import fs from "node:fs";
import { createAgentManager, type AgentManager } from "./agent-manager/agent-manager.ts";
import { loadConfig, type ErgouConfig } from "./config/config.ts";
import { dataDirLayout, type DataDirLayout } from "./config/data-dir.ts";
import { createJobObject, type JobObject } from "./process/job-object.ts";

export interface StartDaemonOptions {
  /** 守护进程自己的环境（通常是 process.env） */
  env: Readonly<Record<string, string | undefined>>;
  /** 用户主目录（通常是 os.homedir()），用来算默认的数据目录 */
  homeDir: string;
}

export interface Daemon {
  readonly config: ErgouConfig;
  readonly layout: DataDirLayout;
  readonly agents: AgentManager;
  /** 二狗自建的 Job 对象（只在 Windows 上有） */
  readonly job: JobObject | undefined;
  /** 停止：关闭 Job 对象，还活着的子进程和孙进程全部结束 */
  stop(): Promise<void>;
}

export async function startDaemon(options: StartDaemonOptions): Promise<Daemon> {
  const config = loadConfig({ env: options.env, homeDir: options.homeDir });
  const layout = dataDirLayout(config.dataDir);
  for (const dir of [layout.config, layout.sessions, layout.tmp, layout.logs]) fs.mkdirSync(dir, { recursive: true });

  const job = process.platform === "win32" ? createJobObject() : undefined;
  const agents = createAgentManager({ layout, parentEnv: options.env, job });

  return {
    config,
    layout,
    agents,
    job,
    async stop() {
      // 先关 Job：子进程连同它们起的孙进程一起结束；再等子进程的句柄收尾
      job?.close();
      await agents.shutdown();
    },
  };
}
