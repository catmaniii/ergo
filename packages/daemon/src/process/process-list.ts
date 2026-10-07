// 本机进程的父子关系（只在 Windows 上有，孤儿回收用）：CreateToolhelp32Snapshot 拍一张进程快照，
// 读出每个进程的父进程 id。用 koffi 直接调 kernel32（和 job-object.ts 一样）。
import koffi from "koffi";

const TH32CS_SNAPPROCESS = 0x2;
const INVALID_HANDLE_VALUE = -1;
/**
 * PROCESSENTRY32W 在 64 位进程里的布局：dwSize(0)、cntUsage(4)、th32ProcessID(8)、th32DefaultHeapID(16，8 字节)、
 * th32ModuleID(24)、cntThreads(28)、th32ParentProcessID(32)、pcPriClassBase(36)、dwFlags(40)、szExeFile[260](44)，共 568 字节。
 * 只读进程 id 和父进程 id，按偏移读，不声明整个结构
 */
const ENTRY_SIZE = 568;
const PID_OFFSET = 8;
const PARENT_OFFSET = 32;

interface Toolhelp {
  CreateToolhelp32Snapshot(flags: number, pid: number): number;
  Process32FirstW(snapshot: number, entry: Buffer): boolean;
  Process32NextW(snapshot: number, entry: Buffer): boolean;
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
    CloseHandle: lib.func("__stdcall", "CloseHandle", "bool", ["intptr_t"]),
    GetLastError: lib.func("__stdcall", "GetLastError", "uint32", []),
  } as unknown as Toolhelp;
  return toolhelp;
}

/** 本机全部进程：进程 id → 父进程 id（父进程可能早已退出，它的 id 甚至可能被别的进程复用了） */
export function parentProcessIds(): Map<number, number> {
  const api = load();
  const snapshot = Number(api.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  if (snapshot === INVALID_HANDLE_VALUE || snapshot === 0) throw new Error(`CreateToolhelp32Snapshot 失败，错误码 ${api.GetLastError()}`);
  try {
    const parents = new Map<number, number>();
    const entry = Buffer.alloc(ENTRY_SIZE);
    entry.writeUInt32LE(ENTRY_SIZE, 0);
    for (let ok = api.Process32FirstW(snapshot, entry); ok; ok = api.Process32NextW(snapshot, entry)) {
      parents.set(entry.readUInt32LE(PID_OFFSET), entry.readUInt32LE(PARENT_OFFSET));
    }
    return parents;
  } finally {
    api.CloseHandle(snapshot);
  }
}
