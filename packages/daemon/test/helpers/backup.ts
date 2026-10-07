// 备份相关的主切面测试底座：起一个守护进程（手动拨的时钟、临时的同步目录），按到点的计时器一个个往后拨。
// 同步目录一律是测试建的临时目录，绝不碰真实的同步目录。
import fs from "node:fs";
import path from "node:path";
import type { SnapshotFiles } from "../../src/backup/files.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { ManualClock } from "./clock.ts";
import { startTestDaemon, type TestDaemon } from "./daemon.ts";
import { makeTempDir } from "./temp-dir.ts";

export interface BackupDaemonOptions {
  /** 时钟停在哪一刻 */
  start: Date;
  /** 同步目录；不给就建一个临时目录 */
  syncDir?: string;
  /** 往备份区写文件的实现（拿到同步目录，模拟写同步目录出错） */
  backupFiles?: (syncDir: string) => SnapshotFiles;
  /** 沿用已有的数据目录和主目录 */
  reuse?: { dataDir: string; homeDir: string };
  /** 秘书的 faux 剧本 */
  secretary?: FauxStep[];
  /** 额外的配置（和 backup.syncDir 一起写进数据目录的配置文件） */
  config?: Record<string, unknown>;
  /** 本机端口照配置文件来 */
  portFromConfig?: boolean;
  /** 守护进程的日志 */
  log?: (line: string) => void;
}

export interface BackupDaemon extends TestDaemon {
  clock: ManualClock;
  syncDir: string;
  layout: TestDaemon["daemon"]["layout"];
  /**
   * 拨到某个时刻：途中到点的计时器一个一个来，每到一个点等内部作业（备份、校验、清理）做完再往后拨
   * （作业是异步的，跑完才登记下一次；一下子拨过好几天就只会跑一次，像电脑睡着了）
   */
  advanceTo(time: Date): Promise<void>;
}

/** 起一个守护进程；启动时补做的内部作业做完才返回 */
export async function startBackupDaemon(options: BackupDaemonOptions): Promise<BackupDaemon> {
  const clock = new ManualClock(options.start);
  const syncDir = options.syncDir ?? makeTempDir("ergou-sync-");
  const test = await startTestDaemon({
    clock,
    config: { ...options.config, backup: { syncDir } },
    ...(options.backupFiles ? { backupFiles: options.backupFiles(syncDir) } : {}),
    ...(options.reuse ? { reuse: options.reuse } : {}),
    ...(options.secretary ? { secretary: options.secretary } : {}),
    ...(options.portFromConfig ? { portFromConfig: true } : {}),
    ...(options.log ? { log: options.log } : {}),
  });
  const { daemon } = test;
  const advanceTo = async (time: Date) => {
    for (let due = daemon.scheduler.pending()[0]; due && due.at <= time.getTime(); due = daemon.scheduler.pending()[0]) {
      clock.advanceTo(due.at);
      await daemon.internalJobs.whenIdle();
    }
    clock.advanceTo(time);
    await daemon.internalJobs.whenIdle();
  };
  await daemon.internalJobs.whenIdle();
  return { ...test, clock, syncDir, layout: daemon.layout, advanceTo };
}

/** 停掉守护进程，换一个停在 time 的时钟，用同一个数据目录和同步目录再起来 */
export async function restartBackupDaemon(previous: BackupDaemon, time: Date, options: Partial<BackupDaemonOptions> = {}): Promise<BackupDaemon> {
  await previous.daemon.stop();
  return startBackupDaemon({ ...options, start: time, syncDir: previous.syncDir, reuse: { dataDir: previous.dataDir, homeDir: previous.homeDir } });
}

/** 文件（或目录）的修改时间改成 time */
export function touch(file: string, time: Date): void {
  fs.utimesSync(file, time, time);
}

/** 在某个目录下放一个文件（目录不存在就建），返回它的绝对路径 */
export function put(root: string, rel: string, content: string | Buffer): string {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}
