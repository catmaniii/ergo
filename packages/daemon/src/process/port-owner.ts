// 端口被谁占着（给第一次装的人：8810 / 8811 被占时说清是谁、怎么改）。
// - 占没占：真绑一下（127.0.0.1，绑上就关）、绑得上再真连一下（有人听 0.0.0.0 时 127.0.0.1 照样绑得上）。这才是事实，netstat 说什么都不作数。
//   绑不了、又没人在听的多半是 Windows 给 Hyper-V 等保留的端口段。
// - 谁占着：Windows 上看 netstat -ano（和 LSM 的 stop 钩子 stop.ts 共用这里的 listeningPids），tasklist 查进程名。
//   查不到（不是 Windows、命令跑不了、端口是被系统保留的、netstat 里一直没有）时不写是谁，不瞎认进程。
//
// netstat 靠不住。这台机器开机后：
// - 2026-10-29（服务管家 packages/supervisor 的 winproc.mjs、probe.mjs 有同样的修复）：一直在听的端口，这一行 30%~70% 的时候不在表里，
//   在的时候状态乱报（CLOSED、FIN_WAIT_1），外部地址还是通配；真连接次次成功。
// - 2026-11-01 更糟：自己握着的端口连看 136 眼（20 秒）一眼都没有，全机没有一行外部地址是 0.0.0.0:0。系统的连接表（GetExtendedTcpTable）
//   300 次次次都有这一行，只是状态报成 0（不存在的值），netstat 大概就是因此把它丢了。反过来，看样子是连接的行也会被报成 LISTENING（外部地址 127.0.0.1:0），好在大多 PID 是 0。
// 所以判定是：状态 LISTENING 的直接算；外部地址是通配、状态不对的算可疑的监听行，已知有人在听（绑不上或连得上）才认；
// 这一眼没有就隔一小会儿多看几眼（有上限），还没有就问系统的连接表（同一个判定）。都没有就交回空的。
// @i18n-ignore-file log：起动失败的说明进日志（LSM 里看），这时用户选的语言还没加载
import { execFile, execFileSync } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";
import koffi from "koffi";
import { portInUse } from "./pid-file.ts";

const execFileAsync = promisify(execFile);

/** 端口的问题：被哪个进程占着（in_use），或者绑不了、又没人在听（reserved：多半是系统保留的端口段） */
export interface PortProblem {
  kind: "in_use" | "reserved";
  /** 占着它的进程（Windows 上查得到时才有） */
  owners: Array<{ pid: number; name?: string }>;
}

/** 一条监听行：哪个端口、绑的地址、哪个进程；suspect 是状态不是 LISTENING、只凭外部地址是通配认出来的 */
export interface ListenRow {
  port: number;
  addr: string;
  pid: number;
  suspect: boolean;
}

/** 监听 socket 的外部地址是通配；真连接永远有具体的对端 */
const WILDCARD_FOREIGN = /^(0\.0\.0\.0:0|\[::\]:0|\*:\*)$/;

/**
 * 解析 netstat -ano -p tcp 的输出，判定和服务管家的 parseNetstat 一致。只认 TCP 开头的行，不看表头
 * （中文 Windows 上表头是 GBK，这边按 UTF-8 读出来是乱码；状态列和地址都是英文）。PID 0 的不是谁在听（TIME_WAIT 之类）
 */
export function parseNetstat(stdout: string): ListenRow[] {
  const rows: ListenRow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    const [protocol = "", local = "", foreign = "", state = ""] = cols;
    if (cols.length < 5 || !/^TCP$/i.test(protocol)) continue;
    const port = /:(\d+)$/.exec(local)?.[1];
    const pid = Number(cols[cols.length - 1]);
    if (port === undefined || !Number.isInteger(pid) || pid <= 0) continue;
    const listening = /^LISTENING$/i.test(state);
    if (!listening && !WILDCARD_FOREIGN.test(foreign)) continue;
    rows.push({ port: Number(port), addr: local.slice(0, local.lastIndexOf(":")), pid, suspect: !listening });
  }
  return rows;
}

/** 看一眼 netstat -ano -p tcp；跑不了时是空的（当这一眼没看到） */
async function netstatOutput(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch {
    return "";
  }
}

const AF_INET = 2;
const TCP_TABLE_OWNER_PID_LISTENER = 3;
/** MIB_TCPROW_OWNER_PID：状态、本地地址、本地端口、对端地址、对端端口、PID，各 4 字节 */
const TCP_ROW_BYTES = 24;
const MIB_TCP_STATE_LISTEN = 2;

type GetExtendedTcpTable = (table: Buffer | null, size: [number], order: boolean, family: number, tableClass: number, reserved: number) => number;
let getExtendedTcpTable: GetExtendedTcpTable | undefined;

/** 系统的连接表里在听的行（只有 IPv4，和 netstat -p tcp 一样）：netstat 几眼都没有时问它。不是 Windows、读不了时是空的 */
export function systemListenRows(): ListenRow[] {
  if (process.platform !== "win32") return [];
  try {
    getExtendedTcpTable ??= koffi
      .load("iphlpapi.dll")
      .func("__stdcall", "GetExtendedTcpTable", "uint32", ["void *", koffi.inout(koffi.pointer("uint32")), "bool", "uint32", "int", "uint32"]) as unknown as GetExtendedTcpTable;
    const needed: [number] = [0];
    getExtendedTcpTable(null, needed, false, AF_INET, TCP_TABLE_OWNER_PID_LISTENER, 0);
    // 两次调用之间可能多出几行，多留点地方
    const table = Buffer.alloc(needed[0] + 16 * TCP_ROW_BYTES);
    if (getExtendedTcpTable(table, [table.length], false, AF_INET, TCP_TABLE_OWNER_PID_LISTENER, 0) !== 0) return [];
    const rows: ListenRow[] = [];
    const count = Math.min(table.readUInt32LE(0), Math.floor((table.length - 4) / TCP_ROW_BYTES));
    for (let i = 0; i < count; i++) {
      const at = 4 + i * TCP_ROW_BYTES;
      const pid = table.readUInt32LE(at + 20);
      // 和解析 netstat 同一个判定：对端是通配、PID 不是 0
      if (pid === 0 || table.readUInt32LE(at + 12) !== 0 || table.readUInt16BE(at + 16) !== 0) continue;
      rows.push({ port: table.readUInt16BE(at + 8), addr: [...table.subarray(at + 4, at + 8)].join("."), pid, suspect: table.readUInt32LE(at) !== MIB_TCP_STATE_LISTEN });
    }
    return rows;
  } catch {
    return [];
  }
}

/** netstat 最多看几眼、隔多久（毫秒）：一眼约几十毫秒，加起来一秒上下，只有已知有人在听、前面的眼又没看到才走到后面的 */
const NETSTAT_LOOKS = 7;
const LOOK_INTERVAL_MS = 100;

/** 找谁在听端口的办法；测试里换成假的 */
export interface ListenerLookup {
  /** 已知有人在听（绑不上或连得上）：可疑的行也认；这一眼没有就多看几眼，再问系统的连接表 */
  known?: boolean;
  /** 所有本地地址都算（stop 钩子）；默认只算 127.0.0.1 和 0.0.0.0，二狗在 127.0.0.1 上听，和它们冲突 */
  anyAddress?: boolean;
  /** 看一眼 netstat 的输出 */
  look?: () => string | Promise<string>;
  /** 系统的连接表 */
  table?: () => ListenRow[];
  /** 最多看几眼 */
  looks?: number;
  intervalMs?: number;
}

/**
 * 在这个端口上听的进程号。不是 Windows（又没给假的 netstat）时是空的。
 * 空的不等于没人在听：有人听却查不到是谁时也是空的，占没占以 portOccupied 为准；据此不写是谁，不瞎认进程
 */
export async function listeningPids(port: number, lookup: ListenerLookup = {}): Promise<number[]> {
  if (process.platform !== "win32" && lookup.look === undefined) return [];
  const { known = false, anyAddress = false, look = netstatOutput, table = systemListenRows, looks = NETSTAT_LOOKS, intervalMs = LOOK_INTERVAL_MS } = lookup;
  const pidsIn = (rows: ListenRow[]) => [
    ...new Set(rows.filter((r) => r.port === port && (known || !r.suspect) && (anyAddress || r.addr === "127.0.0.1" || r.addr === "0.0.0.0")).map((r) => r.pid)),
  ];
  const first = pidsIn(parseNetstat(await look()));
  if (first.length > 0 || !known) return first;
  for (let i = 1; i < looks; i++) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const pids = pidsIn(parseNetstat(await look()));
    if (pids.length > 0) return pids;
  }
  return pidsIn(table());
}

/** 在 127.0.0.1 上试着绑一下：绑得上（马上关掉）是 undefined，绑不了是错误码（EADDRINUSE、EACCES……） */
function bindError(port: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (err: NodeJS.ErrnoException) => resolve(err.code ?? err.message));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(undefined)));
  });
}

/** 绑不上（有人占着）或连得上：确实有人在听。绑不上的不用再连，EACCES 那种（系统保留）要连一下才知道 */
async function occupiedGiven(bind: string | undefined, port: number): Promise<boolean> {
  return bind === "EADDRINUSE" || (await portInUse(port));
}

/** 这个端口上确实有人在听：真绑、真连，不看 netstat */
export async function portOccupied(port: number): Promise<boolean> {
  return occupiedGiven(await bindError(port), port);
}

/**
 * 这个端口能不能给二狗用：能用是 undefined；不能用时说是被占着还是绑不了，查得到的话带上占着它的进程。
 * 绑得上的还要真连一下：有人在听 0.0.0.0 时 127.0.0.1 照样绑得上，而 netstat 靠不住，不能靠它看出来
 */
export async function portProblem(port: number, lookup: Omit<ListenerLookup, "known" | "anyAddress"> = {}): Promise<PortProblem | undefined> {
  const error = await bindError(port);
  const occupied = await occupiedGiven(error, port);
  const pids = await listeningPids(port, { ...lookup, known: occupied });
  const owners = pids.map((pid) => {
    const name = processName(pid);
    return name === undefined ? { pid } : { pid, name };
  });
  if (error === undefined && !occupied && owners.length === 0) return undefined;
  return { kind: occupied || owners.length > 0 ? "in_use" : "reserved", owners };
}

/** Windows 上进程号对应的程序名（tasklist，如 node.exe）；查不到是 undefined */
export function processName(pid: number): string | undefined {
  if (process.platform !== "win32") return undefined;
  try {
    const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
    // 查到的是一行 CSV（"node.exe","1234",…）；查不到时是一句不带引号的说明
    return /^"([^"]+)"/.exec(out.trim())?.[1];
  } catch {
    return undefined;
  }
}

/** 占着端口的进程写成给人看的："node.exe（PID 1234）"，几个用顿号隔开；一个都查不到是 undefined */
export function ownersText(owners: PortProblem["owners"]): string | undefined {
  if (owners.length === 0) return undefined;
  return owners.map((o) => (o.name ? `${o.name}（PID ${o.pid}）` : `PID ${o.pid}`)).join("、");
}
