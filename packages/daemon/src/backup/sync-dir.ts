// 配置里的同步目录（backup.syncDir）现在能不能用：备份、校验和恢复命令都从这里取，说法一致。
import fs from "node:fs";
import { t } from "@ergo/protocol";
import { type BackupConfig, isPlaceholder } from "../config/config.ts";

export type SyncDir =
  /** 没配：只做本机备份 */
  | { kind: "none" }
  | { kind: "ready"; dir: string }
  /** 配了但用不了（还是示例里的占位符、目录不在、不是目录），reason 给人看 */
  | { kind: "unusable"; dir: string; reason: string };

export function syncDirOf(config: BackupConfig): SyncDir {
  const dir = config.syncDir;
  if (dir === undefined) return { kind: "none" };
  if (isPlaceholder(dir)) return { kind: "unusable", dir, reason: t("backup.syncDir.placeholder", { dir }) };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    return { kind: "unusable", dir, reason: t("backup.syncDir.missing", { dir }) };
  }
  if (!stat.isDirectory()) return { kind: "unusable", dir, reason: t("backup.syncDir.notDir", { dir }) };
  return { kind: "ready", dir };
}
