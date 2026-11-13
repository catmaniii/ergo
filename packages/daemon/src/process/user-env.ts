// @i18n-ignore-file log：底层出错的说明只进日志（给开发者看）
// 用户级的环境变量（Windows 注册表 HKCU\Environment）：装好一个程序、它把自己加进"用户 PATH"之后，只有之后启动的进程看得到；
// 守护进程比它先启动，自己的 PATH 里没有。要找这类程序（466：ego lite 走完首次引导后加进用户 PATH 的 ego-browser）时现读注册表。
// 用 koffi 直接调 advapi32 的 RegGetValueW（和 job-object.ts、process-list.ts 一样）：不起 reg.exe 子进程（快，也不经控制台代码页，
// 中文路径不乱码）。读出来的是原样（REG_EXPAND_SZ 不展开），由调用方按自己的环境展开 %变量%。
import koffi from "koffi";

/** HKEY_CURRENT_USER（((LONG)0x80000001) 按指针宽度符号扩展） */
const HKEY_CURRENT_USER = -2147483647;
const RRF_RT_REG_SZ = 0x00000002;
const RRF_RT_REG_EXPAND_SZ = 0x00000004;
/** REG_EXPAND_SZ 不自动展开（要和 RRF_RT_REG_EXPAND_SZ 一起给，否则 RegGetValueW 报参数不对） */
const RRF_NOEXPAND = 0x10000000;
const ERROR_SUCCESS = 0;
const ERROR_MORE_DATA = 234;

interface Advapi32 {
  /** 值的大小（字节）经 size 进出；buffer 给 null 时只回大小 */
  RegGetValueW(key: number, subKey: string, value: string, flags: number, type: null, data: Buffer | null, size: [number]): number;
}

let advapi: Advapi32 | undefined;

function load(): Advapi32 {
  if (advapi) return advapi;
  if (process.platform !== "win32") throw new Error("注册表只在 Windows 上有");
  const lib = koffi.load("advapi32.dll");
  advapi = {
    RegGetValueW: lib.func("__stdcall", "RegGetValueW", "int32", ["intptr_t", "str16", "str16", "uint32", "void *", "void *", "_Inout_ uint32 *"]),
  } as unknown as Advapi32;
  return advapi;
}

/**
 * 用户级环境变量的原样值（HKCU\Environment 里的 name，%变量% 不展开）。不是 Windows、没有这个值、读不了都是 undefined（不抛）
 */
export function readUserEnvironmentVariable(name: string): string | undefined {
  if (process.platform !== "win32") return undefined;
  try {
    const api = load();
    const flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ | RRF_NOEXPAND;
    // 先问大小，再读；读的那一刻值又变长了（ERROR_MORE_DATA）就按新的大小再读一次
    for (let attempt = 0; attempt < 3; attempt++) {
      const size: [number] = [0];
      const first = api.RegGetValueW(HKEY_CURRENT_USER, "Environment", name, flags, null, null, size);
      if (first !== ERROR_SUCCESS) return undefined;
      const buffer = Buffer.alloc(size[0] + 2);
      const got: [number] = [buffer.length];
      const code = api.RegGetValueW(HKEY_CURRENT_USER, "Environment", name, flags, null, buffer, got);
      if (code === ERROR_MORE_DATA) continue;
      if (code !== ERROR_SUCCESS) return undefined;
      const text = buffer.subarray(0, got[0]).toString("utf16le");
      const end = text.indexOf("\0");
      return end < 0 ? text : text.slice(0, end);
    }
    return undefined;
  } catch {
    return undefined;
  }
}
