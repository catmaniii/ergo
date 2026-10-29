// @i18n-ignore-file log：底层出错的说明只进日志（给开发者看）
// 本机进程的父子关系和创建时间（只在 Windows 上有，孤儿回收用）：CreateToolhelp32Snapshot 拍一张进程快照，
// 读出每个进程的父进程 id 和可执行文件名；创建时间按需用 GetProcessTimes 取。用 koffi 直接调 kernel32（和 job-object.ts 一样）。
import koffi from "koffi";

const TH32CS_SNAPPROCESS = 0x2;
const INVALID_HANDLE_VALUE = -1;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
/**
 * PROCESSENTRY32W 在 64 位进程里的布局：dwSize(0)、cntUsage(4)、th32ProcessID(8)、th32DefaultHeapID(16，8 字节)、
 * th32ModuleID(24)、cntThreads(28)、th32ParentProcessID(32)、pcPriClassBase(36)、dwFlags(40)、szExeFile[260](44)，共 568 字节。
 * 只读进程 id、父进程 id 和可执行文件名，按偏移读，不声明整个结构
 */
const ENTRY_SIZE = 568;
const PID_OFFSET = 8;
const PARENT_OFFSET = 32;
const EXE_OFFSET = 44;
const EXE_BYTES = 260 * 2;
/** FILETIME（1601 年起的 100 纳秒数）换成 Unix 毫秒：两个纪元差 11644473600 秒 */
const FILETIME_UNIX_EPOCH_MS = 11_644_473_600_000n;

interface Toolhelp {
  CreateToolhelp32Snapshot(flags: number, pid: number): number;
  Process32FirstW(snapshot: number, entry: Buffer): boolean;
  Process32NextW(snapshot: number, entry: Buffer): boolean;
  OpenProcess(access: number, inherit: boolean, pid: number): number;
  /** 四个 FILETIME（各 8 字节）：创建、退出、内核态、用户态时间 */
  GetProcessTimes(process: number, creation: Buffer, exit: Buffer, kernel: Buffer, user: Buffer): boolean;
  CloseHandle(handle: number): boolean;
  GetLastError(): number;
}

let toolhelp: Toolhelp | undefined;

function load(): Toolhelp {
  if (toolhelp) return toolhelp;
  if (process.platform !== "win32") throw new Error("进程快照只在 Windows 上可用");
  const lib = koffi.load("kernel32.dll");
  // 句柄按指针宽度的整数传（只在这几个函数之间来回传，不解引用）
  toolhelp = {
    CreateToolhelp32Snapshot: lib.func("__stdcall", "CreateToolhelp32Snapshot", "intptr_t", ["uint32", "uint32"]),
    Process32FirstW: lib.func("__stdcall", "Process32FirstW", "bool", ["intptr_t", "void *"]),
    Process32NextW: lib.func("__stdcall", "Process32NextW", "bool", ["intptr_t", "void *"]),
    OpenProcess: lib.func("__stdcall", "OpenProcess", "intptr_t", ["uint32", "bool", "uint32"]),
    GetProcessTimes: lib.func("__stdcall", "GetProcessTimes", "bool", ["intptr_t", "void *", "void *", "void *", "void *"]),
    CloseHandle: lib.func("__stdcall", "CloseHandle", "bool", ["intptr_t"]),
    GetLastError: lib.func("__stdcall", "GetLastError", "uint32", []),
  } as unknown as Toolhelp;
  return toolhelp;
}

/** 快照里的一个进程 */
export interface ProcessEntry {
  /** 父进程 id（父进程可能早已退出，它的 id 甚至可能被别的进程复用了） */
  parent: number;
  /** 可执行文件名（不带目录，比如 bash.exe） */
  exe: string;
}

/** 本机全部进程：进程 id → 父进程 id、可执行文件名 */
export function processSnapshot(): Map<number, ProcessEntry> {
  const api = load();
  const snapshot = Number(api.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  if (snapshot === INVALID_HANDLE_VALUE || snapshot === 0) throw new Error(`CreateToolhelp32Snapshot 失败，错误码 ${api.GetLastError()}`);
  try {
    const processes = new Map<number, ProcessEntry>();
    const entry = Buffer.alloc(ENTRY_SIZE);
    entry.writeUInt32LE(ENTRY_SIZE, 0);
    for (let ok = api.Process32FirstW(snapshot, entry); ok; ok = api.Process32NextW(snapshot, entry)) {
      const name = entry.subarray(EXE_OFFSET, EXE_OFFSET + EXE_BYTES).toString("utf16le");
      const end = name.indexOf("\0");
      processes.set(entry.readUInt32LE(PID_OFFSET), { parent: entry.readUInt32LE(PARENT_OFFSET), exe: end < 0 ? name : name.slice(0, end) });
    }
    return processes;
  } finally {
    api.CloseHandle(snapshot);
  }
}

/** 本机全部进程：进程 id → 父进程 id（父进程可能早已退出，它的 id 甚至可能被别的进程复用了） */
export function parentProcessIds(): Map<number, number> {
  return new Map([...processSnapshot()].map(([pid, { parent }]) => [pid, parent]));
}

/**
 * 这些进程的创建时间（Unix 毫秒，和 Date.now() 同一个系统时钟）。打不开的（已经退出、没权限）不在结果里
 */
export function processCreationTimes(pids: readonly number[]): Map<number, number> {
  const api = load();
  const times = new Map<number, number>();
  const creation = Buffer.alloc(8);
  const other = Buffer.alloc(8);
  for (const pid of pids) {
    const handle = Number(api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid));
    if (!handle) continue;
    try {
      if (api.GetProcessTimes(handle, creation, other, other, other)) {
        times.set(pid, Number(creation.readBigUInt64LE(0) / 10_000n - FILETIME_UNIX_EPOCH_MS));
      }
    } finally {
      api.CloseHandle(handle);
    }
  }
  return times;
}
