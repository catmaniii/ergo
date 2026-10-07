// 数据目录的各区（规格第 18 节）。每类东西有固定归宿，任何模块都从这里取路径，不自己拼。
import path from "node:path";

export interface DataDirLayout {
  root: string;
  /** 配置（含 MCP 登记、关注类别注册表） */
  config: string;
  configFile: string;
  /** 密钥：只由 LSM 注入，agent 读不到 */
  secrets: string;
  /** 数据库：ergou.db、memory.db */
  db: string;
  /** pi 会话 JSONL，每个 agent 一个子目录 */
  sessions: string;
  projects: string;
  /** 不属于任何项目的任务的产出 */
  outputs: string;
  materials: string;
  /** 用户自己加的 skill */
  skills: string;
  /** 临时区（含秘书草稿区）；不进备份 */
  tmp: string;
  backups: string;
  logs: string;
}

export function dataDirLayout(dataDir: string): DataDirLayout {
  const root = path.resolve(dataDir);
  const config = path.join(root, "config");
  return {
    root,
    config,
    configFile: path.join(config, "ergou.json"),
    secrets: path.join(root, "secrets"),
    db: path.join(root, "db"),
    sessions: path.join(root, "sessions"),
    projects: path.join(root, "projects"),
    outputs: path.join(root, "outputs"),
    materials: path.join(root, "materials"),
    skills: path.join(root, "skills"),
    tmp: path.join(root, "tmp"),
    backups: path.join(root, "backups"),
    logs: path.join(root, "logs"),
  };
}
