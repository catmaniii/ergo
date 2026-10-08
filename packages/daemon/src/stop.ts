// ergou-daemon 的 stop 钩子（LSM 条目里的 hooks.stop）：结束本机端口上的守护进程。
//   <专用 Node 22 LTS 的绝对路径> packages/daemon/src/stop.ts
// 和守护进程读同一份配置：数据目录取 ERGOU_DATA_DIR（LSM 给钩子注入同样的环境），端口取配置里的 ports.local。
//
// 不误杀：只有"监听这个端口的进程就是 pid 文件里那个进程（pid 相同、启动时间对得上）"时才结束它；
// 否则什么也不做，说明原因，以非零退出码结束（LSM 会把原因显示出来）。
// 守护进程按"随时可能被杀"设计：事件日志在 SQLite（WAL）里，输入队列在事件日志里，进程一结束 Job 对象就把
// agent 子进程和孙进程一起清掉（重新起来后按被杀恢复，23 号票，见 recovery/），所以停止就是结束这个进程。
// LSM 的接入层连着时，停机走 link 协议（lsm/link.ts），用不到这个钩子。
// 只在 Windows 上用（LSM 只在 Windows 上）。
import { execFileSync } from "node:child_process";
import os from "node:os";
import { loadConfig } from "./config/config.ts";
import { dataDirLayout } from "./config/data-dir.ts";
import { matchesRunningProcess, readPidFile, removePidFile } from "./process/pid-file.ts";

const config = loadConfig({ env: process.env, homeDir: os.homedir() });
const { pidFile } = dataDirLayout(config.dataDir);
const port = config.ports.local;

function listeningPids(): number[] {
  const out = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8", windowsHide: true });
  const pids = new Set<number>();
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols[3] === "LISTENING" && cols[1]?.endsWith(`:${port}`)) pids.add(Number(cols[4]));
  }
  return [...pids];
}

function refuse(reason: string): never {
  console.error(`没有结束任何进程：${reason}`);
  process.exit(1);
}

const listeners = listeningPids();
if (listeners.length === 0) {
  console.log(`端口 ${port} 没人在听，守护进程已经停了`);
  process.exit(0);
}
const record = readPidFile(pidFile);
if (!record) refuse(`没有 pid 文件 ${pidFile}，确认不了端口 ${port} 上的进程（PID ${listeners.join("、")}）是二狗的守护进程`);
if (record.port !== port) refuse(`pid 文件记的端口是 ${record.port}，配置里是 ${port}`);
if (listeners.length !== 1 || listeners[0] !== record.pid) {
  refuse(`端口 ${port} 上的进程（PID ${listeners.join("、")}）不是 pid 文件里的守护进程（PID ${record.pid}）`);
}
if (!matchesRunningProcess(record, record.pid)) {
  refuse(`PID ${record.pid} 的启动时间和 pid 文件记的（${record.startedAt}）对不上，可能是 pid 被别的进程复用了`);
}

execFileSync("taskkill", ["/PID", String(record.pid), "/T", "/F"], { stdio: "inherit", windowsHide: true });
// 等端口真的放出来
for (let i = 0; i < 50 && listeningPids().length > 0; i++) await new Promise((r) => setTimeout(r, 100));
if (listeningPids().length > 0) {
  console.error(`端口 ${port} 还有人在听`);
  process.exit(1);
}
removePidFile(pidFile, record.pid);
console.log(`守护进程已停止（PID ${record.pid}，端口 ${port}）`);
