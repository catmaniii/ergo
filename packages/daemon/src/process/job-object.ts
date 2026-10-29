// @i18n-ignore-file log：底层出错的说明只进日志（给开发者看）
// Windows Job 对象：守护进程拉起的所有子进程（及其孙进程）都放进二狗自建的这一个 Job（规格第 3 节、第 17 节）。
//
// - JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE：Job 的最后一个句柄关闭时，里面的进程全部结束。句柄只在
//   守护进程手里（不可继承），所以守护进程无论怎么死（包括被强杀），子进程和孙进程都跟着消失。
// - 不设 BREAKAWAY_OK / SILENT_BREAKAWAY_OK：Job 里的进程起的进程一律留在 Job 里，不能脱离。
// - 嵌套：守护进程自己可能已经在一个 Job 里（LSM、终端都会这么做），子进程拉起时先继承那个 Job；
//   Windows 8 起支持嵌套 Job，这里再 Assign 进二狗的 Job，它就成了外层 Job 的子 Job。
//   外层 Job 被关掉时同样会连带清掉二狗的 Job。
// - 和 Node 自己的 Job 的关系（2026-10-07 实测）：libuv 在 Windows 上会把每个非 detached 的子进程
//   放进父进程私有的一个 Job（KILL_ON_JOB_CLOSE + SILENT_BREAKAWAY_OK），所以 agent 子进程先在
//   守护进程的 libuv Job 里，二狗的 Job 嵌在它下面。libuv 的 Job 允许"悄悄脱离"，孙进程（比如 bash
//   起的程序）本来会一路脱离到外面、守护进程死了也活着；二狗的 Job 不允许脱离，脱离到它这一层就停下，
//   所以孙进程、以及父进程已退出的孤儿进程，都留在会随守护进程一起被清掉的范围里。
//
// Node 没有现成的 API，这里用 koffi（预编译的 FFI，不需要本机编译）直接调 kernel32。
import koffi from "koffi";

export interface JobObject {
  /** 把一个进程放进 Job；它之后起的进程自动在 Job 里 */
  assign(pid: number): void;
  /** 这个进程是否在本 Job 里 */
  contains(pid: number): boolean;
  /** Job 里现在的全部进程（孤儿回收用） */
  processIds(): number[];
  /** 当前的限制设置 */
  limits(): JobLimits;
  /** 关闭 Job：里面还活着的进程全部结束 */
  close(): void;
}

export interface JobLimits {
  killOnClose: boolean;
  breakawayAllowed: boolean;
}

const JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x0800;
const JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK = 0x1000;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const JobObjectBasicProcessIdList = 3;
const JobObjectExtendedLimitInformation = 9;
/** 缓冲区不够大（Job 里的进程比预留的多） */
const ERROR_MORE_DATA = 234;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

interface Kernel32 {
  CreateJobObjectW(attributes: null, name: null): unknown;
  SetInformationJobObject(job: unknown, infoClass: number, info: ExtendedLimitInformation, length: number): boolean;
  QueryInformationJobObject(job: unknown, infoClass: number, info: [ExtendedLimitInformation | null], length: number, returned: null): boolean;
  /** 同一个函数，缓冲区按字节给（进程 id 列表的长度不定） */
  QueryJobProcessIdList(job: unknown, infoClass: number, buffer: Buffer, length: number, returned: null): boolean;
  AssignProcessToJobObject(job: unknown, process: unknown): boolean;
  IsProcessInJob(process: unknown, job: unknown, result: [boolean | null]): boolean;
  OpenProcess(access: number, inherit: boolean, pid: number): unknown;
  CloseHandle(handle: unknown): boolean;
  GetLastError(): number;
}

interface ExtendedLimitInformation {
  BasicLimitInformation: { LimitFlags: number } & Record<string, unknown>;
  [key: string]: unknown;
}

let kernel32: { api: Kernel32; extendedLimitSize: number } | undefined;

function loadKernel32(): NonNullable<typeof kernel32> {
  if (kernel32) return kernel32;
  if (process.platform !== "win32") throw new Error("Job 对象只在 Windows 上可用");
  const lib = koffi.load("kernel32.dll");
  const HANDLE = koffi.pointer("HANDLE", koffi.opaque());
  const BASIC = koffi.struct("JOBOBJECT_BASIC_LIMIT_INFORMATION", {
    PerProcessUserTimeLimit: "int64",
    PerJobUserTimeLimit: "int64",
    LimitFlags: "uint32",
    MinimumWorkingSetSize: "size_t",
    MaximumWorkingSetSize: "size_t",
    ActiveProcessLimit: "uint32",
    Affinity: "uintptr_t",
    PriorityClass: "uint32",
    SchedulingClass: "uint32",
  });
  const IO_COUNTERS = koffi.struct("IO_COUNTERS", {
    ReadOperationCount: "uint64",
    WriteOperationCount: "uint64",
    OtherOperationCount: "uint64",
    ReadTransferCount: "uint64",
    WriteTransferCount: "uint64",
    OtherTransferCount: "uint64",
  });
  const EXTENDED = koffi.struct("JOBOBJECT_EXTENDED_LIMIT_INFORMATION", {
    BasicLimitInformation: BASIC,
    IoInfo: IO_COUNTERS,
    ProcessMemoryLimit: "size_t",
    JobMemoryLimit: "size_t",
    PeakProcessMemoryUsed: "size_t",
    PeakJobMemoryUsed: "size_t",
  });
  const api = {
    CreateJobObjectW: lib.func("__stdcall", "CreateJobObjectW", HANDLE, ["void *", "void *"]),
    SetInformationJobObject: lib.func("__stdcall", "SetInformationJobObject", "bool", [HANDLE, "int", koffi.pointer(EXTENDED), "uint32"]),
    QueryInformationJobObject: lib.func("__stdcall", "QueryInformationJobObject", "bool", [
      HANDLE,
      "int",
      koffi.out(koffi.pointer(EXTENDED)),
      "uint32",
      "void *",
    ]),
    QueryJobProcessIdList: lib.func("__stdcall", "QueryInformationJobObject", "bool", [HANDLE, "int", "void *", "uint32", "void *"]),
    AssignProcessToJobObject: lib.func("__stdcall", "AssignProcessToJobObject", "bool", [HANDLE, HANDLE]),
    IsProcessInJob: lib.func("__stdcall", "IsProcessInJob", "bool", [HANDLE, HANDLE, koffi.out(koffi.pointer("bool"))]),
    OpenProcess: lib.func("__stdcall", "OpenProcess", HANDLE, ["uint32", "bool", "uint32"]),
    CloseHandle: lib.func("__stdcall", "CloseHandle", "bool", [HANDLE]),
    GetLastError: lib.func("__stdcall", "GetLastError", "uint32", []),
  } as unknown as Kernel32;
  kernel32 = { api, extendedLimitSize: koffi.sizeof(EXTENDED) };
  return kernel32;
}

/** 建一个 KILL_ON_JOB_CLOSE、不允许脱离的 Job 对象（只在 Windows 上可用） */
export function createJobObject(): JobObject {
  const { api, extendedLimitSize } = loadKernel32();
  const job = api.CreateJobObjectW(null, null);
  if (!job) throw new Error(`CreateJobObjectW 失败，错误码 ${api.GetLastError()}`);

  const info: ExtendedLimitInformation = {
    BasicLimitInformation: { LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE },
  };
  if (!api.SetInformationJobObject(job, JobObjectExtendedLimitInformation, info, extendedLimitSize)) {
    const code = api.GetLastError();
    api.CloseHandle(job);
    throw new Error(`SetInformationJobObject 失败，错误码 ${code}`);
  }

  let closed = false;
  const ensureOpen = () => {
    if (closed) throw new Error("Job 对象已关闭");
  };
  const withProcess = <T>(pid: number, access: number, fn: (process: unknown) => T): T => {
    const handle = api.OpenProcess(access, false, pid);
    if (!handle) throw new Error(`OpenProcess(${pid}) 失败，错误码 ${api.GetLastError()}`);
    try {
      return fn(handle);
    } finally {
      api.CloseHandle(handle);
    }
  };

  return {
    assign(pid) {
      ensureOpen();
      withProcess(pid, PROCESS_SET_QUOTA | PROCESS_TERMINATE, (process) => {
        if (!api.AssignProcessToJobObject(job, process)) {
          throw new Error(`AssignProcessToJobObject(${pid}) 失败，错误码 ${api.GetLastError()}`);
        }
      });
    },
    contains(pid) {
      ensureOpen();
      return withProcess(pid, PROCESS_QUERY_LIMITED_INFORMATION, (process) => {
        const result: [boolean | null] = [null];
        if (!api.IsProcessInJob(process, job, result)) {
          throw new Error(`IsProcessInJob(${pid}) 失败，错误码 ${api.GetLastError()}`);
        }
        return result[0] === true;
      });
    },
    processIds() {
      ensureOpen();
      // JOBOBJECT_BASIC_PROCESS_ID_LIST：两个 DWORD（分到的进程数、列表里的个数），之后是 ULONG_PTR 数组（64 位进程里 8 字节一个）
      for (let capacity = 256; ; capacity *= 4) {
        const buffer = Buffer.alloc(8 + 8 * capacity);
        if (!api.QueryJobProcessIdList(job, JobObjectBasicProcessIdList, buffer, buffer.length, null)) {
          const code = api.GetLastError();
          if (code === ERROR_MORE_DATA && capacity < 65_536) continue;
          throw new Error(`QueryInformationJobObject（进程列表）失败，错误码 ${code}`);
        }
        const count = buffer.readUInt32LE(4);
        return Array.from({ length: count }, (_, i) => Number(buffer.readBigUInt64LE(8 + 8 * i)));
      }
    },
    limits() {
      ensureOpen();
      const out: [ExtendedLimitInformation | null] = [null];
      if (!api.QueryInformationJobObject(job, JobObjectExtendedLimitInformation, out, extendedLimitSize, null)) {
        throw new Error(`QueryInformationJobObject 失败，错误码 ${api.GetLastError()}`);
      }
      const flags = out[0]!.BasicLimitInformation.LimitFlags;
      return {
        killOnClose: (flags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) !== 0,
        breakawayAllowed: (flags & (JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK)) !== 0,
      };
    },
    close() {
      if (closed) return;
      closed = true;
      api.CloseHandle(job);
    },
  };
}
