// 备份相关的主切面测试底座：起一个守护进程（手动拨的时钟、临时的同步目录），按到点的计时器一个个往后拨。
// 同步目录一律是测试建的临时目录，绝不碰真实的同步目录。
import fs from "node:fs";
import path from "node:path";
import type { SnapshotFiles } from "../../src/backup/files.ts";
import { BACKUP_RECORD_FILE } from "../../src/backup/record.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { ManualClock } from "./clock.ts";
import { startTestDaemon, type TestDaemon } from "./daemon.ts";
import { freePorts } from "./ports.ts";
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
  /** 额外的配置（和 backup.syncDir、ports 一起写进数据目录的配置文件）；写了 ports 就用它，不另挑；backup 里的别的项（schedule）和 syncDir 合在一起 */
  config?: Record<string, unknown>;
  /** 守护进程的日志 */
  log?: (line: string) => void;
  /** 记忆插件开不开（265 号票：底座给了时钟默认停掉它，要 rg.db 的写 true；见 startTestDaemon 的 memoryPlugin） */
  memoryPlugin?: boolean;
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

/**
 * 起一个守护进程；启动时补做的内部作业做完才返回。
 * 恢复命令按配置里的 ports.local 判断守护进程在不在，配置还会随快照一起被恢复：所以数据目录的配置里总写上
 * 一组临时挑的空闲端口，守护进程也用这组端口（每次起来重新挑）——不依赖默认的 8810 空着（那是 LSM 托管的正式服务）
 */
export async function startBackupDaemon(options: BackupDaemonOptions): Promise<BackupDaemon> {
  const clock = new ManualClock(options.start);
  const syncDir = options.syncDir ?? makeTempDir("ergo-sync-");
  const ports = options.config?.ports ?? (await freePorts());
  const test = await startTestDaemon({
    clock,
    config: { ...options.config, ports, backup: { ...(options.config?.backup as Record<string, unknown> | undefined), syncDir } },
    portFromConfig: true,
    ...(options.backupFiles ? { backupFiles: options.backupFiles(syncDir) } : {}),
    ...(options.reuse ? { reuse: options.reuse } : {}),
    ...(options.secretary ? { secretary: options.secretary } : {}),
    ...(options.log ? { log: options.log } : {}),
    ...(options.memoryPlugin === undefined ? {} : { memoryPlugin: options.memoryPlugin }),
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

/** 本机备份区里有什么（不算最近一次备份的记录 last-backup.json，335 号票）：日期目录和别的东西 */
export function backupArea(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => name !== BACKUP_RECORD_FILE);
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
