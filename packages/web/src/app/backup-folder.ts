// 设置 · 备份里选定一个文件夹之后（356 号票）：先校验（绝对路径、不在数据目录里、写得进去），不存在的问一下要不要新建，都过了才写配置。
// 不能用的抛错（message 是原因，选文件夹的框写在框里、框不关）。不碰 DOM（测试把守护进程换成假的）。
import { type BackupConfigBody, type BackupFolderCheck, type BackupStatusView, t } from "../state/index.ts";

/** 要的守护进程接口（DaemonHttp 里的这两个；不引 daemon-http.ts，测试在 Node 里跑、没有 DOM 的 fetch 类型） */
export interface BackupFolderHttp {
  backupCheckFolder(dir: string): Promise<BackupFolderCheck>;
  backupConfig(body: BackupConfigBody): Promise<BackupStatusView>;
}

export async function chooseBackupFolder(http: BackupFolderHttp, dir: string, askCreate: (dir: string) => Promise<boolean>): Promise<BackupStatusView> {
  const check = await http.backupCheckFolder(dir);
  if (check.kind === "invalid") throw new Error(check.reason);
  if (check.kind === "ok") return http.backupConfig({ syncDir: check.dir });
  if (!(await askCreate(check.dir))) throw new Error(t("pages.backup.create.declined"));
  return http.backupConfig({ syncDir: check.dir, createSyncDir: true });
}
