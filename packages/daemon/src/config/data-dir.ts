// 数据目录的各区（规格第 18 节）。每类东西有固定归宿，任何模块都从这里取路径，不自己拼。
import path from "node:path";

export interface DataDirLayout {
  root: string;
  /** 守护进程的 pid 文件（pid、进程启动时间、端口），LSM 的 stop 钩子据此核对要结束的进程 */
  pidFile: string;
  /** 配置（含 MCP 登记、关注类别注册表） */
  config: string;
  configFile: string;
  /** 关注类别注册表里用户的部分：内置类别的调整和自定义类别（守卫，03 号票） */
  watchCategoriesFile: string;
  /** 密钥：只由 LSM 注入，agent 读不到 */
  secrets: string;
  /** 数据库：ergou.db、memory.db */
  db: string;
  /** pi 会话 JSONL，每个 agent 一个子目录 */
  sessions: string;
  projects: string;
  /** 不属于任何项目的任务的产出 */
  outputs: string;
  /** 素材区：原文副本（originals/）、按内容哈希存的媒体 */
  materials: string;
  /** 素材区里按内容哈希存的媒体（图片、文件附件）：文件名就是入库版本的 sha256，同样的内容只存一份 */
  media: string;
  /** 模型区：语义检索用的向量模型文件（bge-m3，用户运行下载命令放进来；不随仓库分发，可以重新下载） */
  models: string;
  /** 用户自己加的 skill */
  skills: string;
  /** 临时区（含秘书草稿区）；不进备份 */
  tmp: string;
  /** 临时区里还没收尾的分片上传 */
  uploads: string;
  backups: string;
  logs: string;
}

export function dataDirLayout(dataDir: string): DataDirLayout {
  const root = path.resolve(dataDir);
  const config = path.join(root, "config");
  const materials = path.join(root, "materials");
  const tmp = path.join(root, "tmp");
  return {
    root,
    pidFile: path.join(root, "daemon.pid"),
    config,
    configFile: path.join(config, "ergou.json"),
    watchCategoriesFile: path.join(config, "watch-categories.json"),
    secrets: path.join(root, "secrets"),
    db: path.join(root, "db"),
    sessions: path.join(root, "sessions"),
    projects: path.join(root, "projects"),
    outputs: path.join(root, "outputs"),
    materials,
    media: path.join(materials, "media"),
    models: path.join(root, "models"),
    skills: path.join(root, "skills"),
    tmp,
    uploads: path.join(tmp, "uploads"),
    backups: path.join(root, "backups"),
    logs: path.join(root, "logs"),
  };
}
