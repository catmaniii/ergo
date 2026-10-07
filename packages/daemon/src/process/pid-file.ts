// 守护进程的 pid 文件（数据目录根下的 daemon.pid）：守护进程启动后写下自己的 pid、进程启动时间和本机端口，
// LSM 的 stop 钩子（src/stop.ts）先核对"监听这个端口的就是文件里这个进程、而且启动时间对得上"才结束它，
// pid 被别的进程复用时不会误杀。
//
// 进程的启动时间用 kernel32 的 GetProcessTimes 取（Windows 上；koffi 调用，和 Job 对象一样不需要本机编译）。
import fs from "node:fs";
import koffi from "koffi";

export interface PidRecord {
  pid: number;
  /** 进程启动时间（ISO，UTC） */
  startedAt: string;
  /** 本机端口 */
  port: number;
}

/** 写 pid 文件（当前进程） */
export function writePidFile(file: string, port: number): PidRecord {
  const record: PidRecord = { pid: process.pid, startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(), port };
  fs.writeFileSync(file, `${JSON.stringify(record)}\n`);
  return record;
}

/** 读 pid 文件；没有或读不懂时是 undefined */
export function readPidFile(file: string): PidRecord | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<PidRecord>;
    if (typeof value.pid === "number" && typeof value.startedAt === "string" && typeof value.port === "number") {
      return { pid: value.pid, startedAt: value.startedAt, port: value.port };
    }
  } catch {
    // 没有文件或内容坏了
  }
  return undefined;
}

/** 删 pid 文件，只删自己写的那份（文件里是别的 pid 就不动） */
export function removePidFile(file: string, pid = process.pid): void {
  if (readPidFile(file)?.pid === pid) fs.rmSync(file, { force: true });
}

/** pid 文件里记的启动时间和那个进程实际的启动时间相差不超过这么多，就算同一个进程 */
const START_TIME_TOLERANCE_MS = 2_000;

/** pid 文件记的是不是这个正在运行的进程（pid 相同、启动时间对得上） */
export function matchesRunningProcess(record: PidRecord, pid: number): boolean {
  if (record.pid !== pid) return false;
  const actual = processStartTime(pid);
  return actual !== undefined && Math.abs(actual.getTime() - Date.parse(record.startedAt)) <= START_TIME_TOLERANCE_MS;
}

/**
 * pid 文件里记的进程现在还在运行：进程没退出，Windows 上启动时间也对得上（pid 可能被别的进程复用）。
 * 恢复命令据此判断守护进程停了没有。
 */
export function processRunning(record: PidRecord): boolean {
  try {
    // 只问在不在（Windows 上也会看进程是不是已经退出）
    process.kill(record.pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  return process.platform === "win32" ? matchesRunningProcess(record, record.pid) : true;
}

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
/** FILETIME（1601-01-01 起的 100 纳秒数）和 Unix 毫秒之间的差 */
const FILETIME_EPOCH_OFFSET_MS = 11_644_473_600_000n;

interface ProcessTimesApi {
  OpenProcess(access: number, inherit: boolean, pid: number): unknown;
  GetProcessTimes(process: unknown, creation: [unknown], exit: [unknown], kernel: [unknown], user: [unknown]): boolean;
  CloseHandle(handle: unknown): boolean;
}

let api: ProcessTimesApi | undefined;

function loadApi(): ProcessTimesApi {
  if (api) return api;
  const lib = koffi.load("kernel32.dll");
  const filetime = koffi.out(koffi.pointer("uint64"));
  api = {
    OpenProcess: lib.func("__stdcall", "OpenProcess", "void *", ["uint32", "bool", "uint32"]),
    GetProcessTimes: lib.func("__stdcall", "GetProcessTimes", "bool", ["void *", filetime, filetime, filetime, filetime]),
    CloseHandle: lib.func("__stdcall", "CloseHandle", "bool", ["void *"]),
  } as unknown as ProcessTimesApi;
  return api;
}

/** 某个进程的启动时间（Windows）；进程不在或查不到时是 undefined */
export function processStartTime(pid: number): Date | undefined {
  if (process.platform !== "win32") return undefined;
  const { OpenProcess, GetProcessTimes, CloseHandle } = loadApi();
  const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (!handle) return undefined;
  try {
    const creation: [unknown] = [null];
    if (!GetProcessTimes(handle, creation, [null], [null], [null])) return undefined;
    const ticks = BigInt(creation[0] as number | bigint);
    return new Date(Number(ticks / 10_000n - FILETIME_EPOCH_OFFSET_MS));
  } finally {
    CloseHandle(handle);
  }
}
