// @i18n-ignore-file log：底层出错的说明只进日志（给开发者看）
// 本机进程的父子关系和创建时间（只在 Windows 上有，孤儿回收用）：CreateToolhelp32Snapshot 拍一张进程快照，
// 读出每个进程的父进程 id 和可执行文件名；创建时间按需用 GetProcessTimes 取，占的内存按需用 K32GetProcessMemoryInfo 取（439 体检"二狗占的内存"）。
// 用 koffi 直接调 kernel32（和 job-object.ts 一样）。
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
/**
 * PROCESS_MEMORY_COUNTERS_EX 在 64 位进程里的布局：cb(0)、PageFaultCount(4)、PeakWorkingSetSize(8)、WorkingSetSize(16)、四个池用量(24–48)、
 * PagefileUsage(56)、PeakPagefileUsage(64)、PrivateUsage(72)，共 80 字节。只读这几样，按偏移读
 */
const MEMORY_COUNTERS_SIZE = 80;
const WORKING_SET_OFFSET = 16;
const PEAK_PAGEFILE_OFFSET = 64;
const PRIVATE_OFFSET = 72;
/** FILETIME（1601 年起的 100 纳秒数）换成 Unix 毫秒：两个纪元差 11644473600 秒 */
const FILETIME_UNIX_EPOCH_MS = 11_644_473_600_000n;

interface Toolhelp {
  CreateToolhelp32Snapshot(flags: number, pid: number): number;
  Process32FirstW(snapshot: number, entry: Buffer): boolean;
  Process32NextW(snapshot: number, entry: Buffer): boolean;
  OpenProcess(access: number, inherit: boolean, pid: number): number;
  /** 四个 FILETIME（各 8 字节）：创建、退出、内核态、用户态时间 */
  GetProcessTimes(process: number, creation: Buffer, exit: Buffer, kernel: Buffer, user: Buffer): boolean;
  /** 进程占的内存（PROCESS_MEMORY_COUNTERS_EX，cb 是结构的大小） */
  K32GetProcessMemoryInfo(process: number, counters: Buffer, cb: number): boolean;
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
    K32GetProcessMemoryInfo: lib.func("__stdcall", "K32GetProcessMemoryInfo", "bool", ["intptr_t", "void *", "uint32"]),
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

/** 一个进程占的内存（字节） */
export interface ProcessMemory {
  /** 工作集：此刻在物理内存里的（系统内存紧时会被挤到页面文件，比真用的少） */
  workingSet: number;
  /** 私有提交：这个进程自己要下的内存（挤到页面文件里的也算），"占了多少"以它为准 */
  private: number;
  /** 私有提交从进程起来以后的最高值 */
  peakPrivate: number;
}

/** 这些进程各占多少内存。打不开的（已经退出、没权限）不在结果里 */
export function processMemory(pids: readonly number[]): Map<number, ProcessMemory> {
  const api = load();
  const result = new Map<number, ProcessMemory>();
  const counters = Buffer.alloc(MEMORY_COUNTERS_SIZE);
  for (const pid of pids) {
    const handle = Number(api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid));
    if (!handle) continue;
    try {
      counters.fill(0);
      counters.writeUInt32LE(MEMORY_COUNTERS_SIZE, 0);
      if (api.K32GetProcessMemoryInfo(handle, counters, MEMORY_COUNTERS_SIZE)) {
        result.set(pid, {
          workingSet: Number(counters.readBigUInt64LE(WORKING_SET_OFFSET)),
          private: Number(counters.readBigUInt64LE(PRIVATE_OFFSET)),
          peakPrivate: Number(counters.readBigUInt64LE(PEAK_PAGEFILE_OFFSET)),
        });
      }
    } finally {
      api.CloseHandle(handle);
    }
  }
  return result;
}

/**
 * 快照里 root 的子孙进程（不含它自己），按层次先后。给了创建时间（processCreationTimes）时，比父进程先创建的不算：
 * 那是父进程 id 被复用了（它真正的父进程早就退出了）
 */
export function descendantsOf(root: number, snapshot: ReadonlyMap<number, ProcessEntry>, created?: ReadonlyMap<number, number>): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, { parent }] of snapshot) {
    if (pid === parent) continue;
    const list = children.get(parent);
    if (list) list.push(pid);
    else children.set(parent, [pid]);
  }
  const found: number[] = [];
  const seen = new Set<number>([root]);
  const queue = [root];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const child of children.get(parent) ?? []) {
      if (seen.has(child)) continue;
      const born = created?.get(child);
      const parentBorn = created?.get(parent);
      if (born !== undefined && parentBorn !== undefined && born < parentBorn) continue;
      seen.add(child);
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}
