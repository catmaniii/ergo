// 备份命令（335 号票）：npm run backup —— 自己把备份做完，和守护进程每晚那次是同一套代码（backup/backup.ts 的 backupWithLock：
// 本机快照、写进同步目录、保留、回收公共池），不经守护进程。
//   npm run backup                    立即备份：重做今天的快照（已有的换掉），再写进同步目录
//   npm run backup -- --scheduled     给定时器用：只补齐今天缺的（本机、同步目录里都有了就什么也不动）
//
// - 守护进程在不在跑都能用，不用停二狗：数据库用 VACUUM INTO 另开只读连接在线复制（WAL 模式下另一个进程开着库照样一致，
//   守护进程照常写），会话 JSONL 只取到最后一个完整的行。
// - 和守护进程拿同一把锁（本机备份区的 backup.lock）：另一份正在做时**等**它做完（打一行在等谁），最多等 2 小时；锁的主人
//   已经不在了（进程没了）锁作废，接着做。
// - 一步一行打到标准输出，同样的几行（带时刻）追加到数据目录的 logs/backup.log（超过 1 MB 时旧的挪成 backup.log.1）。
//   最后一行是结论："备份完成：<日期>，……" 或 "备份失败：<原因>"。
// - 退出码：0 做成了（本机快照有了，配了同步目录的也写进去了）；1 没做成；2 用法不对。
// - 失败不进守护进程的待处理事项（命令行写不了守护进程的事件）：看退出码和最后一行。外部定时器连着两天没跑，守护进程会提醒。
//
// 和守护进程读同一份配置：数据目录取 ERGO_DATA_DIR（不设是用户主目录下的 .ergo），同步目录取配置里的 backup.syncDir。
// @i18n-ignore-file log：命令行工具的输出（失败原因走 t()，先装上自带的中文）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BackupMode, BackupResult } from "@ergo/protocol";
import { backupWithLock } from "./backup/backup.ts";
import { nodeSnapshotFiles } from "./backup/files.ts";
import { localDateTime } from "./backup/snapshot.ts";
import { syncDirOf } from "./backup/sync-dir.ts";
import { loadConfig } from "./config/config.ts";
import { dataDirLayout } from "./config/data-dir.ts";
import { installBuiltinLocales } from "./i18n/index.ts";
import { systemClock } from "./scheduler/clock.ts";

installBuiltinLocales();

const USAGE = [
  "用法：",
  "  npm run backup                  立即备份：重做今天的快照（已有的换掉），再写进同步目录",
  "  npm run backup -- --scheduled   给定时器用：只补齐今天缺的（本机、同步目录里都有了就什么也不动）",
  "守护进程在不在跑都能用；另一份备份正在做时等它做完。退出码：0 做成了，1 没做成。",
].join("\n");

/** 日志文件超过这么大，旧的挪成 backup.log.1 */
const LOG_ROTATE_BYTES = 1024 * 1024;

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
const unknown = args.filter((a) => a !== "--scheduled");
if (unknown.length > 0) {
  console.error(`不认得的参数：${unknown.join(" ")}\n${USAGE}`);
  process.exit(2);
}
const mode: BackupMode = args.includes("--scheduled") ? "auto" : "manual";

/** 带时刻的一行（写进日志文件） */
const stamp = () => {
  const d = new Date();
  return `${localDateTime(d.getTime())}:${String(d.getSeconds()).padStart(2, "0")}`;
};

let logFile: string | undefined;
function out(line: string): void {
  console.log(line);
  if (logFile === undefined) return;
  try {
    fs.appendFileSync(logFile, `${stamp()} ${line}\n`);
  } catch {
    // 日志写不进去不影响备份
  }
}

function finish(code: number, conclusion: string): never {
  out(conclusion);
  process.exit(code);
}

/** 最后一行：做成了还是没做成，一眼看得出 */
function conclusionOf(result: BackupResult): { ok: boolean; line: string } {
  if (result.local === "failed") return { ok: false, line: `备份失败：本机快照没做成：${result.error ?? "原因不明"}` };
  if (result.sync === "failed") return { ok: false, line: `备份失败：本机快照做好了（${result.date}），但没写进同步目录：${result.error ?? "原因不明"}` };
  if (result.sync === "not_configured") return { ok: true, line: `备份完成：${result.date}，只在本机（没配同步目录 backup.syncDir）` };
  if (result.local === "kept" && result.sync === "kept") return { ok: true, line: `备份完成：${result.date} 的快照本机和同步目录里都已经有了，没重做` };
  return { ok: true, line: `备份完成：${result.date}，已写进同步目录` };
}

const config = (() => {
  try {
    return loadConfig({ env: process.env, homeDir: os.homedir() });
  } catch (err) {
    return finish(1, `备份失败：读不了配置：${err instanceof Error ? err.message : String(err)}`);
  }
})();
const layout = dataDirLayout(config.dataDir);
try {
  fs.mkdirSync(layout.logs, { recursive: true });
  logFile = path.join(layout.logs, "backup.log");
  if (fs.existsSync(logFile) && fs.statSync(logFile).size > LOG_ROTATE_BYTES) fs.renameSync(logFile, `${logFile}.1`);
} catch {
  // 日志目录建不了：只打到屏幕上
}

out(`── npm run backup${mode === "auto" ? " -- --scheduled" : ""}（PID ${process.pid}）──`);
out(`数据目录：${layout.root}`);
const sync = syncDirOf(config.backup);
out(sync.kind === "ready" ? `同步目录：${sync.dir}` : sync.kind === "none" ? "同步目录：没配（backup.syncDir），只备份在本机" : `同步目录：用不了——${sync.reason}`);
out(mode === "auto" ? "方式：只补齐今天缺的（--scheduled）" : "方式：立即备份，重做今天的快照");

const controller = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => controller.abort());

try {
  const result = await backupWithLock({
    layout,
    config: config.backup,
    clock: systemClock,
    files: nodeSnapshotFiles,
    mode,
    signal: controller.signal,
    by: "script",
    log: out,
    // 失败的说明 runBackup 已经一步一行打过了；最后一行再总结
    report: () => {},
  });
  const { ok, line } = conclusionOf(result);
  finish(ok ? 0 : 1, line);
} catch (err) {
  if (controller.signal.aborted) finish(1, "备份失败：被中断了（做到一半的已经删掉）");
  finish(1, `备份失败：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
}
