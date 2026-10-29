// 最近一次备份的记录（335 号票）：本机备份区的 last-backup.json。守护进程（到点的、"立即备份"）和命令行脚本（npm run backup）
// 做完一次都写它（拿着备份锁的时候写，不会两份同时写），设置里的"备份"、外部定时器连着两天没跑的提醒都读它。
// 本机备份区不进快照、恢复时也不动（nonBackupEntries），所以记录说的总是这台电脑上真正的最近一次。
import fs from "node:fs";
import path from "node:path";
import { BackupRunRecord, schemaChecker } from "@ergo/protocol";
import type { DataDirLayout } from "../config/data-dir.ts";
import { writeFileAtomic } from "../util/atomic-file.ts";

export const BACKUP_RECORD_FILE = "last-backup.json";

const checkRecord = schemaChecker(BackupRunRecord);

export const backupRecordFile = (layout: Pick<DataDirLayout, "backups">): string => path.join(layout.backups, BACKUP_RECORD_FILE);

/** 读最近一次的记录；没有、读坏了是 undefined */
export function readBackupRecord(layout: Pick<DataDirLayout, "backups">): BackupRunRecord | undefined {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(backupRecordFile(layout), "utf8"));
    return checkRecord.check(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** 写最近一次的记录（先写临时文件再改名） */
export function writeBackupRecord(layout: Pick<DataDirLayout, "backups">, record: BackupRunRecord): void {
  writeFileAtomic(backupRecordFile(layout), `${JSON.stringify(record, null, 1)}\n`);
}
