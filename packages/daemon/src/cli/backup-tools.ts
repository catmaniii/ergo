// ergo backup / ergo restore：一行命令装的程序目录里没有 npm run，备份、恢复的命令行工具（src/run-backup、src/restore）接到 ergo 命令上：
// 用这份程序的 Node 跑，参数原样转，输出直接打到终端，退出码原样带回。ergo 在 PATH 上、升级后还是它，定时任务调 ergo backup --scheduled 不会因为升级断掉。
// 数据目录明着传过去（ergo 认的和工具认的是同一个）。
import { spawnSync } from "node:child_process";
import path from "node:path";
import { t } from "@ergo/protocol";
import type { CliContext } from "./context.ts";

export type BackupTool = "run-backup" | "restore";

export function cmdBackupTool(ctx: CliContext, tool: BackupTool, args: readonly string[]): number {
  // 装好的是转好的 .js，仓库里（开发）是 .ts：和这个文件自己一样
  const script = path.join(ctx.layout.appDir, "packages", "daemon", "src", `${tool}${path.extname(import.meta.filename)}`);
  const r = spawnSync(ctx.layout.node, [script, ...args], { env: { ...ctx.env, ERGO_DATA_DIR: ctx.dataDir }, stdio: "inherit", windowsHide: true });
  if (r.error) {
    ctx.io.err(t("cli.backupTool.failed", { detail: r.error.message }));
    return 1;
  }
  return r.status ?? 1;
}
