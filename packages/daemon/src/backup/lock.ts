// 备份锁（335 号票）：守护进程自己的备份（到点的、"立即备份"）、每周校验，和命令行脚本（npm run backup）共用本机备份区里的
// 一把锁 backup.lock，同一时刻只有一份在写（读）本机备份区和同步目录。
//
// - 锁文件里写着谁拿着：进程号、进程启动时间（进程号被别的进程复用时认得出来）、守护进程还是命令行、从什么时候起。
// - 后来的**等**，不跳过：每秒看一眼，锁放开了再拿，然后做自己那一次——"立即备份"照样重做当天的；到点的、--scheduled 的
//   只补齐当天缺的，等到了发现都已经有了就什么也不动。最多等 BACKUP_LOCK_WAIT_MS，等不到算这次没做成（BackupBusy）。
// - 锁的主人已经不在了（进程退出了、被杀了，或者进程号被别的进程复用了）：锁作废。先把锁文件改名成只有自己知道的名字，
//   再看改走的是不是确实没人要的那把：是就删；是别人刚换上的新锁（主人活着），原样放回去——不会把别人的新锁当旧的删掉。
// - 拿锁是独占创建（wx），同一时刻只有一个拿得到。放锁只删自己那把。
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { BackupRunner } from "@ergo/protocol";
import type { DataDirLayout } from "../config/data-dir.ts";
import { processRunning } from "../process/pid-file.ts";

export const BACKUP_LOCK_FILE = "backup.lock";
/** 后来的最多等这么久（第一次往同步目录写全部大文件可能要很久） */
export const BACKUP_LOCK_WAIT_MS = 2 * 60 * 60_000;
/** 等的时候多久看一眼 */
export const BACKUP_LOCK_POLL_MS = 1_000;
/** 锁文件读不懂（刚建出来还没写完）超过这么久，算写到一半进程没了：作废 */
const UNREADABLE_STALE_MS = 10_000;

/** 拿着锁的是谁 */
export interface BackupLockOwner {
  pid: number;
  /** 那个进程的启动时间（ISO）：进程号被复用时对不上 */
  processStartedAt: string;
  by: BackupRunner;
  /** 从什么时候起拿着（协议时间） */
  since: string;
}

export const backupLockFile = (layout: Pick<DataDirLayout, "backups">): string => path.join(layout.backups, BACKUP_LOCK_FILE);

/** 这个进程的启动时间（和 pid 文件同一种算法：现在减去已经运行了多久） */
const PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1000).toISOString();

/** 读锁文件；没有、读不懂是 undefined */
export function readLockOwner(file: string): BackupLockOwner | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<BackupLockOwner>;
    if (typeof value.pid === "number" && typeof value.processStartedAt === "string" && (value.by === "daemon" || value.by === "script") && typeof value.since === "string") {
      return { pid: value.pid, processStartedAt: value.processStartedAt, by: value.by, since: value.since };
    }
  } catch {
    // 没有锁，或者刚建出来还没写完
  }
  return undefined;
}

/** 锁的主人还活着（自己这个进程也算） */
function ownerAlive(owner: BackupLockOwner): boolean {
  if (owner.pid === process.pid) return owner.processStartedAt === PROCESS_STARTED_AT;
  return processRunning({ pid: owner.pid, startedAt: owner.processStartedAt });
}

/** 现在拿着锁、而且还活着的那一份；没有锁、主人已经不在了是 undefined */
export function liveLockOwner(file: string): BackupLockOwner | undefined {
  const owner = readLockOwner(file);
  return owner && ownerAlive(owner) ? owner : undefined;
}

const sameOwner = (a: BackupLockOwner, b: BackupLockOwner) => a.pid === b.pid && a.processStartedAt === b.processStartedAt && a.since === b.since;

/** 等了 BACKUP_LOCK_WAIT_MS 还没等到：另一份一直没做完 */
export class BackupBusy extends Error {
  readonly owner: BackupLockOwner | undefined;
  constructor(owner: BackupLockOwner | undefined) {
    super("backup lock busy");
    this.owner = owner;
  }
}

export interface HeldBackupLock {
  readonly owner: BackupLockOwner;
  /** 放开（只删自己那把；已经不是自己的就不动） */
  release(): void;
}

type Attempt = { kind: "held" } | { kind: "busy"; owner?: BackupLockOwner } | { kind: "stale"; owner?: BackupLockOwner };

/** 试一次：拿到了、有人拿着、拿着的人已经不在了 */
function tryAcquire(file: string, mine: BackupLockOwner): Attempt {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, `${JSON.stringify(mine)}\n`, { flag: "wx" });
    return { kind: "held" };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Windows 上刚被删、还有人开着的文件，再建会是 EPERM：当成有人拿着，下一轮再试；文件真不在的才是写不进去
    if (code !== "EEXIST" && !((code === "EPERM" || code === "EACCES" || code === "EBUSY") && fs.existsSync(file))) throw err;
  }
  const current = readLockOwner(file);
  if (current) return ownerAlive(current) ? { kind: "busy", owner: current } : { kind: "stale", owner: current };
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return { kind: "busy" }; // 刚被放开：下一轮再拿
  }
  return Date.now() - mtimeMs > UNREADABLE_STALE_MS ? { kind: "stale" } : { kind: "busy" };
}

/** 作废没人要的锁：改名、核对、删掉；改走的其实是别人刚拿到的新锁就放回去。做不成（别人正开着它）返回 false */
function clearStale(file: string): boolean {
  const aside = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.stale`;
  try {
    fs.renameSync(file, aside);
  } catch {
    return false;
  }
  const moved = readLockOwner(aside);
  if (moved && ownerAlive(moved)) {
    try {
      fs.linkSync(aside, file); // 原样放回去；那个位置又有了锁（几乎不会）就留着那一把
    } catch {
      // 放不回去：那个位置已经有锁了
    }
  }
  fs.rmSync(aside, { force: true });
  return true;
}

export interface AcquireBackupLockOptions {
  file: string;
  by: BackupRunner;
  /** 现在（协议时间），写进锁的 since */
  nowIso: () => string;
  /** 中止等待（守护进程停止、命令行被中断） */
  signal?: AbortSignal;
  waitMs?: number;
  pollMs?: number;
  /** 开始等（等的人换了也再说一次）：在等谁；锁文件还没写完时是 undefined */
  onWait?: (owner: BackupLockOwner | undefined) => void;
  /** 锁的主人已经不在了，把锁作废了 */
  onStale?: (owner: BackupLockOwner | undefined) => void;
}

/** 拿备份锁：有人拿着就等它放开（最多 waitMs，超了抛 BackupBusy），主人不在了的锁作废 */
export async function acquireBackupLock(options: AcquireBackupLockOptions): Promise<HeldBackupLock> {
  const { file, signal } = options;
  const waitMs = options.waitMs ?? BACKUP_LOCK_WAIT_MS;
  const pollMs = options.pollMs ?? BACKUP_LOCK_POLL_MS;
  const deadline = Date.now() + waitMs;
  let waitingFor: string | undefined;
  for (;;) {
    signal?.throwIfAborted();
    const mine: BackupLockOwner = { pid: process.pid, processStartedAt: PROCESS_STARTED_AT, by: options.by, since: options.nowIso() };
    const attempt = tryAcquire(file, mine);
    if (attempt.kind === "held") {
      return {
        owner: mine,
        release() {
          const current = readLockOwner(file);
          if (current && sameOwner(current, mine)) fs.rmSync(file, { force: true });
        },
      };
    }
    if (attempt.kind === "stale") {
      if (clearStale(file)) {
        options.onStale?.(attempt.owner);
        continue;
      }
    } else {
      const key = attempt.owner ? `${attempt.owner.pid}@${attempt.owner.since}` : "?";
      if (key !== waitingFor) {
        waitingFor = key;
        options.onWait?.(attempt.owner);
      }
      if (Date.now() >= deadline) throw new BackupBusy(attempt.owner);
    }
    await delay(pollMs, undefined, signal ? { signal } : {});
  }
}
