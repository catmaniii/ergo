// stop 钩子（stop.ts）结束进程前的核对：不误杀。只有"在听这个端口的就是 pid 文件里那个进程（pid 相同、启动时间对得上）"才结束它。
// 查不到是谁（353 号票：netstat 靠不住）时不结束，也不说已经停了；端口空没空由调用方真绑、真连得来，不看 netstat。
// @i18n-ignore-file log：命令行工具的输出（LSM 显示给看日志的人）
import type { PidRecord } from "./pid-file.ts";

export type StopVerdict = { action: "stopped"; message: string } | { action: "refuse"; reason: string } | { action: "kill"; pid: number };

export interface StopFacts {
  port: number;
  pidFile: string;
  /** 这个端口上确实有人在听（绑不上或连得上） */
  occupied: boolean;
  /** 查到的在听这个端口的进程 */
  listeners: number[];
  record: PidRecord | undefined;
  /** pid 文件记的是不是正在运行的这个进程（pid 相同、启动时间对得上） */
  matches: (record: PidRecord) => boolean;
}

export function stopVerdict({ port, pidFile, occupied, listeners, record, matches }: StopFacts): StopVerdict {
  if (listeners.length === 0) {
    if (!occupied) return { action: "stopped", message: `端口 ${port} 没人在听，守护进程已经停了` };
    return { action: "refuse", reason: `端口 ${port} 有人占着，但查不到是谁（netstat 看了几眼、系统的连接表里都没有），确认不了是二狗的守护进程` };
  }
  if (!record) return { action: "refuse", reason: `没有 pid 文件 ${pidFile}，确认不了端口 ${port} 上的进程（PID ${listeners.join("、")}）是二狗的守护进程` };
  if (record.port !== port) return { action: "refuse", reason: `pid 文件记的端口是 ${record.port}，配置里是 ${port}` };
  if (listeners.length !== 1 || listeners[0] !== record.pid) {
    return { action: "refuse", reason: `端口 ${port} 上的进程（PID ${listeners.join("、")}）不是 pid 文件里的守护进程（PID ${record.pid}）` };
  }
  if (!matches(record)) return { action: "refuse", reason: `PID ${record.pid} 的启动时间和 pid 文件记的（${record.startedAt}）对不上，可能是 pid 被别的进程复用了` };
  return { action: "kill", pid: record.pid };
}
