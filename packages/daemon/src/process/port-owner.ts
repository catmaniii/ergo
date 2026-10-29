// 端口被谁占着（315 号票，给第一次装的人：8810 / 8811 被占时说清是谁、怎么改）。
// - 占没占：试着在 127.0.0.1 上绑一下（绑上就关），再看 netstat 里有没有进程在 127.0.0.1 / 0.0.0.0 的这个端口上听。
//   绑不了、又没人在听的多半是 Windows 给 Hyper-V 等保留的端口段。
// - 谁占着：Windows 上 netstat -ano 找在这个端口上 LISTENING 的进程号（和 LSM 的 stop 钩子 stop.ts 同一个找法；那边命令跑不了要报错，
//   这里跑不了只是不写是谁），tasklist 查进程名。查不到（不是 Windows、命令跑不了、端口是被系统保留的）时不写是谁。
// @i18n-ignore-file log：起动失败的说明进日志（LSM 里看），这时用户选的语言还没加载
import { execFileSync } from "node:child_process";
import net from "node:net";

/** 端口的问题：被哪个进程占着（in_use），或者绑不了、又没人在听（reserved：多半是系统保留的端口段） */
export interface PortProblem {
  kind: "in_use" | "reserved";
  /** 占着它的进程（Windows 上查得到时才有） */
  owners: Array<{ pid: number; name?: string }>;
}

/** 在 127.0.0.1 上试着绑一下：绑得上（马上关掉）是 undefined，绑不了是错误码（EADDRINUSE、EACCES……） */
function bindError(port: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (err: NodeJS.ErrnoException) => resolve(err.code ?? err.message));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(undefined)));
  });
}

/**
 * 这个端口能不能给二狗用：能用是 undefined；不能用时说是被占着还是绑不了，查得到的话带上占着它的进程。
 * 不用"连一下看有没有人听"：Windows 上连一个没人听的本机端口要等一秒多才失败；有人在听 0.0.0.0 而这边绑得上 127.0.0.1 的，靠 netstat 看出来
 */
export async function portProblem(port: number): Promise<PortProblem | undefined> {
  const error = await bindError(port);
  const owners = listeningPids(port).map((pid) => {
    const name = processName(pid);
    return name === undefined ? { pid } : { pid, name };
  });
  if (error === undefined && owners.length === 0) return undefined;
  return { kind: error === undefined || error === "EADDRINUSE" || owners.length > 0 ? "in_use" : "reserved", owners };
}

/** Windows 上在这个端口上 LISTENING 的进程号（netstat -ano -p tcp）；不是 Windows、跑不了时是空的 */
export function listeningPids(port: number): number[] {
  if (process.platform !== "win32") return [];
  let out: string;
  try {
    out = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8", windowsHide: true });
  } catch {
    return [];
  }
  const pids = new Set<number>();
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    // 只算听 IPv4 本机地址、全部地址的（-p tcp 只列 IPv4）：二狗在 127.0.0.1 上听，和它们冲突
    if (cols[3] === "LISTENING" && (cols[1] === `127.0.0.1:${port}` || cols[1] === `0.0.0.0:${port}`)) pids.add(Number(cols[4]));
  }
  return [...pids].filter((pid) => Number.isInteger(pid) && pid > 0);
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
