// 选另存的文件夹时校验一个路径（356 号票，设置 · 备份）：选的时候先问一声（POST /api/backup/check-folder），真改配置时再查一遍（PATCH /api/backup/config）。
// 规矩：完整路径、不在数据目录里（经目录联接绕进去的也不行）、是文件夹、写得进去（真写一个临时文件试，试完删掉）。
// 不存在的回 missing（页面问要不要新建）；给了 create 才新建，新建了又写不进去的撤掉。
// 这些都不挡事件循环：文件夹可能在 NAS 上，查一次可能很慢。
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type BackupFolderCheck, t } from "@ergo/protocol";
import { isInsideDataDir, isPlaceholder } from "../config/config.ts";
import { describeWriteError, nodeSnapshotFiles, type SnapshotFiles } from "./files.ts";

export interface BackupFolderCheckOptions {
  dataDir: string;
  /** 不存在就新建（页面问过用户了） */
  create?: boolean;
  /** 试写走备份写文件的同一个接口；测试换成会出错的实现 */
  files?: SnapshotFiles;
}

/** 完整路径：Windows 上要带盘符或者是 \\服务器\共享；\foo 这种（当前盘的根）算不上 */
function isFullPath(text: string): boolean {
  if (!path.isAbsolute(text)) return false;
  return process.platform !== "win32" || !/^[\\/](?![\\/])/.test(text);
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

const invalid = (dir: string, reason: string): BackupFolderCheck => ({ kind: "invalid", dir, reason });

/** 真实路径（目录联接解开、短文件名展开）；取不到用原来的 */
const realOf = (dir: string) => fs.promises.realpath(dir).catch(() => dir);

export async function checkBackupFolder(text: string, options: BackupFolderCheckOptions): Promise<BackupFolderCheck> {
  const { dataDir } = options;
  const files = options.files ?? nodeSnapshotFiles;
  const raw = text.trim();
  if (raw === "") return invalid(raw, t("backup.folder.empty"));
  if (isPlaceholder(raw)) return invalid(raw, t("backup.folder.placeholder", { dir: raw }));
  if (!isFullPath(raw)) return invalid(raw, t("backup.folder.notAbsolute", { dir: raw }));
  const dir = path.resolve(raw);
  const insideData = () => invalid(dir, t("backup.folder.insideData", { dir, dataDir }));
  if (isInsideDataDir(dir, dataDir)) return insideData();

  /** 这次新建的最上面一层：要撤掉时删它 */
  let created: string | undefined;
  const undoCreate = async () => {
    if (created !== undefined) await fs.promises.rm(created, { recursive: true, force: true }).catch(() => {});
  };

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") return invalid(dir, t("backup.folder.unreadable", { dir, reason: messageOf(err) }));
    if (!options.create) return { kind: "missing", dir };
    try {
      created = await fs.promises.mkdir(dir, { recursive: true });
      stat = await fs.promises.stat(dir);
    } catch (mkdirErr) {
      await undoCreate();
      return invalid(dir, t("backup.folder.createFailed", { dir, reason: describeWriteError(mkdirErr) }));
    }
  }
  if (!stat.isDirectory()) return invalid(dir, t("backup.folder.notFolder", { dir }));
  if (isInsideDataDir(await realOf(dir), await realOf(dataDir))) {
    await undoCreate();
    return insideData();
  }

  const probe = path.join(dir, `.ergo-write-test-${process.pid}-${randomUUID().slice(0, 8)}.tmp`);
  try {
    await files.writeFile(probe, "ergo");
    await files.remove(probe);
  } catch (err) {
    await files.remove(probe).catch(() => {});
    await undoCreate();
    return invalid(dir, t("backup.folder.notWritable", { dir, reason: describeWriteError(err) }));
  }
  return { kind: "ok", dir };
}
