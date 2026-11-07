// 最近一次备份的记录：本机备份区的 last-backup.json。守护进程（到点的、"立即备份"）和命令行脚本（npm run backup）
// 做完一次都写它（拿着备份锁的时候写，不会两份同时写），设置里的"备份"、外部定时器连着两天没跑的提醒、体检都读它。
// 最近一次校验（手动的、每周的）记在旁边的 last-verify.json（411 起：以前只在守护进程内存里，重启就没了，体检看不到）；
// 只有守护进程校验（命令行不校验），拿着备份锁时写。和 last-backup.json 分开放：每次备份整份重写那一份，校验的不该跟着丢。
// 本机备份区不进快照、恢复时也不动（nonBackupEntries），所以记录说的总是这台电脑上真正的最近一次。
import fs from "node:fs";
import path from "node:path";
import { BackupRunRecord, BackupVerifyRecord, schemaChecker } from "@ergo/protocol";
import type { DataDirLayout } from "../config/data-dir.ts";
import { writeFileAtomic } from "../util/atomic-file.ts";

export const BACKUP_RECORD_FILE = "last-backup.json";
export const VERIFY_RECORD_FILE = "last-verify.json";

const checkRecord = schemaChecker(BackupRunRecord);
const checkVerify = schemaChecker(BackupVerifyRecord);

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

export const verifyRecordFile = (layout: Pick<DataDirLayout, "backups">): string => path.join(layout.backups, VERIFY_RECORD_FILE);

/** 读最近一次校验；没有、读坏了是 undefined */
export function readVerifyRecord(layout: Pick<DataDirLayout, "backups">): BackupVerifyRecord | undefined {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(verifyRecordFile(layout), "utf8"));
    return checkVerify.check(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** 写最近一次校验（先写临时文件再改名） */
export function writeVerifyRecord(layout: Pick<DataDirLayout, "backups">, record: BackupVerifyRecord): void {
  writeFileAtomic(verifyRecordFile(layout), `${JSON.stringify(record, null, 1)}\n`);
}
