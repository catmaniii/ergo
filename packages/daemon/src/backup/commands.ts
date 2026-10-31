// 设置 · 备份页上写的恢复、定时命令（356 号票）：按这台电脑上二狗的装法现算，复制了就能跑（PowerShell）。
// - 一行命令装的（版本目录里跑）、npm 装的：有 ergo 命令，用 ergo stop / restore / start / backup。版本目录里没有 npm run（程序的 package.json 没有 scripts），
//   也不写版本目录的路径：ergo update 之后路径就变了，定时任务会悄悄断；ergo 命令在 PATH 上、升级后还是它。
// - 自己 git clone 的（仓库里跑）：没有 ergo 命令，服务管家在 packages\supervisor 里，恢复跑 .ts 源文件，用跑守护进程的同一份 Node。
// 数据目录不是默认的（经 ERGO_DATA_DIR 换过的）时，用户开的窗口里没有这个环境变量，要先设上。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type BackupCommandsView, type BackupRestoreStep, t } from "@ergo/protocol";
import { detectLayout, type InstallLayout } from "../release/layout.ts";

export interface BackupCommandsOptions {
  layout: Pick<InstallLayout, "kind" | "appDir" | "node">;
  dataDir: string;
  /** 数据目录不是默认的那个 */
  customDataDir: boolean;
  /** 恢复命令里举例的日期（最新的快照）；不给写 YYYY-MM-DD */
  date?: string;
  /** 配了另存的文件夹（多写一条从那里恢复） */
  hasSync: boolean;
}

/** PowerShell 里一个单引号的字符串 */
const quoted = (text: string) => `'${text.replaceAll("'", "''")}'`;

export function backupCommands(options: BackupCommandsOptions): BackupCommandsView {
  const { layout, dataDir, customDataDir, hasSync } = options;
  const date = options.date ?? "YYYY-MM-DD";
  const setDataDir = `$env:ERGO_DATA_DIR = ${quoted(dataDir)}`;
  const withDataDir = (command: string) => (customDataDir ? `${setDataDir}; ${command}` : command);
  const source = layout.kind === "dev";
  const node = quoted(layout.node);
  const lsm = (verb: string) => `& ${node} ${quoted(path.join(layout.appDir, "packages", "supervisor", "bin", "lsm.mjs"))} ${verb} ergo-daemon`;
  const restoreCommand = source ? `& ${node} ${quoted(path.join(layout.appDir, "packages", "daemon", "src", "restore.ts"))}` : "ergo restore";
  const steps: BackupRestoreStep[] = [
    ...(customDataDir ? [{ note: t("backup.restore.setDataDir"), command: setDataDir }] : []),
    { note: t("backup.restore.stop"), command: source ? lsm("stop") : "ergo stop" },
    { note: t("backup.restore.list"), command: `${restoreCommand} --list` },
    { note: t("backup.restore.one"), command: `${restoreCommand} ${date}` },
    ...(hasSync ? [{ note: t("backup.restore.fromSync"), command: `${restoreCommand} ${date} --from sync` }] : []),
    { note: t("backup.restore.start"), command: source ? lsm("start") : "ergo start" },
  ];
  return {
    install: source ? "source" : "ergo",
    scheduled: withDataDir(source ? `cd ${quoted(layout.appDir)}; npm run backup -- --scheduled` : "ergo backup --scheduled"),
    restore: steps,
  };
}

/** 这份守护进程程序是怎么装的：只看代码在哪（ERGO_HOME 是启动器给 ergo 命令的，可能被带进子进程，不算数） */
export function installLayoutOfDaemon(): InstallLayout {
  return detectLayout({ cliFile: fileURLToPath(new URL("../cli/main.js", import.meta.url)), env: {} });
}
