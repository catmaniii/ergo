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
  /** 个人工作日历：用户的额外上班规则和手动标记（个人数据，29 号票） */
  workdayCalendarFile: string;
  /** 更新任务交付、运行时校验后导入的节假日数据（<地区>-<年>.json，和框架自带的同一格式，29 号票） */
  holidaysDir: string;
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
  /** 秘书的草稿区：临时区里秘书专用的一格，也是秘书的工作目录（和其他临时文件一样 7 天后清理，11 号票） */
  scratch: string;
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
    workdayCalendarFile: path.join(config, "workday-calendar.json"),
    holidaysDir: path.join(config, "holidays"),
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
    scratch: path.join(tmp, "scratch"),
    backups: path.join(root, "backups"),
    logs: path.join(root, "logs"),
  };
}

/**
 * 不进备份的东西：数据目录第一层的这几项（名字小写）——密钥区、临时区、本机备份区、pid 文件（规格第 18 节），
 * 还有模型区（向量模型几百 MB，能用 `npm run download-model` 重新下载）。
 * 快照不收它们；从快照恢复时它们也原地不动（不挪走、不覆盖）。两边用同一份，免得一边改了另一边没跟上。
 */
export function nonBackupEntries(layout: DataDirLayout): ReadonlySet<string> {
  return new Set([layout.secrets, layout.tmp, layout.backups, layout.pidFile, layout.models].map((p) => path.relative(layout.root, p).toLowerCase()));
}
